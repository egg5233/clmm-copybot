//! The Unix socket server: accept, read frames, sign, write frames.
//!
//! Port of `startServer` in `signer/index.ts:207-343`. The socket lifecycle is
//! identical — remove a stale socket or refuse to start, bind, `chmod 0660` —
//! and so is the rule that the *client* decides when a connection is over. The
//! request loop differs in two ways that are fixes rather than choices:
//!
//! * **Frames are drained in a loop.** `sock.on('data')` in the TypeScript
//!   server parses at most one frame per event and keeps the remainder in a
//!   buffer it only revisits when more bytes arrive, so a client that pipelines
//!   two requests into one write gets one response and then waits forever. The
//!   loop here answers every frame it can already see, in arrival order.
//! * **Oversize frames are refused.** See [`signer_core::protocol::MAX_FRAME_LEN`].
//!
//! Concurrency is one thread per connection, capped — Node serves every
//! connection on one event loop, which cannot be reproduced without an async
//! runtime and is not worth one for a workload of a few signatures a minute.

use std::fs;
use std::io::{self, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use nix::unistd::Uid;
use signer_core::error::ProtocolError;
use signer_core::protocol::{read_frame, write_frame, SignRequest, SignResponse};
use signer_core::rpc::SolanaRpc;
use signer_core::tx::ParsedTx;
use signer_core::{PolicyEngine, Verdict};
use solana_sdk::signer::keypair::Keypair;

/// Socket permissions: owner and group only (`signer/index.ts:317`).
///
/// The bot and the signer run as the same user in the default install and as
/// two users in the same group in the hardened one; nobody else has any business
/// connecting. On Linux, `connect(2)` to a Unix socket needs write permission on
/// the path, so this is a real access control and not decoration.
const SOCKET_MODE: u32 = 0o660;

/// How many connections may be in flight at once.
///
/// `sendToSigner` opens a connection, writes one request, waits, and destroys
/// it, so the steady state is one. Concurrency only appears where the bot signs
/// a batch — `signAllTransactions` fans out over `Promise.all` — and those
/// batches are a handful of transactions. Eight leaves room for that while
/// keeping a misbehaving local process from turning connection spam into
/// unbounded threads. Connections past the cap wait in the listen backlog, so a
/// legitimate burst is delayed rather than refused.
const MAX_CONNECTIONS: usize = 8;

/// How long a connection may sit without producing bytes before it is dropped.
///
/// This exists because [`MAX_CONNECTIONS`] does: without it, eight connections
/// that open and never write would hold every permit forever and lock out the
/// bot — a cap with no timeout is worse than no cap. Nothing legitimate idles
/// here, since the client writes its request immediately on connect and hangs up
/// after the response.
const IDLE_TIMEOUT: Duration = Duration::from_mins(1);

// ── Peer credentials ────────────────────────────────────────────────────────

/// Whether the server holds connecting processes to its own uid.
///
/// [`PeerCheck::Off`] is the default and has to stay the default: `signer/index.ts`
/// performs no such check, and [`SOCKET_MODE`] is `0660` precisely so the hardened
/// install can run the bot as a *second* user in the signer's group. Turning this
/// on narrows that to one user, which is right for the single-user install and
/// wrong for the two-user one — so it is the operator's call, not this file's.
///
/// What it buys where it applies: the socket's mode is a check on the filesystem
/// path, and a path can be reached by anything with the right group. `SO_PEERCRED`
/// is a check on the process, taken by the kernel at `connect(2)` time and not
/// forgeable by the peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerCheck {
    /// Serve anyone the socket's permissions let through.
    Off,
    /// Serve only processes whose uid matches this process's effective uid.
    SameUid,
}

impl From<bool> for PeerCheck {
    /// Maps `SignerConfig::require_peer_uid` onto the two states.
    fn from(require: bool) -> Self {
        if require {
            Self::SameUid
        } else {
            Self::Off
        }
    }
}

/// Whether a freshly accepted connection may be served.
///
/// # Errors
///
/// A reason to log, for a connection that must be closed rather than answered.
fn admit(stream: &UnixStream, peers: PeerCheck) -> Result<(), String> {
    if peers == PeerCheck::Off {
        return Ok(());
    }

    let peer = peer_uid(stream).map_err(|err| format!("could not read peer credentials: {err}"))?;
    check_peer_uid(peer, Uid::effective())
}

/// Compares a peer's uid against this process's own.
///
/// Split from [`peer_uid`] so that both outcomes are testable. A test can only
/// connect to itself, so the refusal branch has no in-process route to a real
/// socket — see the note on [`tests::the_peer_check_lets_this_process_through`].
fn check_peer_uid(peer: Uid, ours: Uid) -> Result<(), String> {
    if peer == ours {
        Ok(())
    } else {
        Err(format!("peer uid {peer} is not {ours}"))
    }
}

/// The uid of the process on the other end of `stream`, from `SO_PEERCRED`.
///
/// The kernel fills these credentials in at `connect(2)`, so they describe the
/// process that actually opened the connection and cannot be set by it.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(stream: &UnixStream) -> io::Result<Uid> {
    let credentials =
        nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
            .map_err(io::Error::from)?;
    Ok(Uid::from_raw(credentials.uid()))
}

/// `SO_PEERCRED` is a Linux socket option; other platforms spell this differently.
///
/// Fails closed on purpose. With [`PeerCheck::SameUid`] asked for and no way to
/// honour it, every connection is refused and every refusal is logged — an
/// operator who asked for the guarantee gets it or gets a daemon that plainly
/// does not work, never a flag that quietly does nothing.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn peer_uid(_stream: &UnixStream) -> io::Result<Uid> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "SO_PEERCRED is a Linux socket option; SIGNER_REQUIRE_PEER_UID cannot be honoured here",
    ))
}

/// Everything a request needs answering: the key, the policy, and the chain.
///
/// Bundled rather than passed as three arguments because every connection thread
/// needs all three for the lifetime of the connection, and one `Arc` to clone per
/// thread is cheaper and harder to get wrong than three. Shared immutably — the
/// engine holds only configuration and the RPC client is internally
/// synchronised — so nothing here needs a lock.
pub struct Signer {
    keypair: Arc<Keypair>,
    policy: PolicyEngine,
    rpc: Box<dyn SolanaRpc>,
}

impl Signer {
    /// Assembles the three pieces of a signing service.
    #[must_use]
    pub fn new(keypair: Arc<Keypair>, policy: PolicyEngine, rpc: Box<dyn SolanaRpc>) -> Self {
        Self {
            keypair,
            policy,
            rpc,
        }
    }
}

/// Prepares the listening socket: clear a stale path, bind, restrict the mode.
///
/// # Errors
///
/// A message ready to print, for a socket path that cannot be cleared or bound.
/// Refusing to start on a stale socket that will not unlink is deliberate
/// (`signer/index.ts:265-273`): the alternative is two signers disagreeing about
/// who owns the path.
pub fn bind(socket_path: &Path) -> Result<UnixListener, String> {
    // `symlink_metadata` rather than `exists` so a dangling symlink — which
    // `bind` would reject with a confusing EADDRINUSE — is cleared too.
    if socket_path.symlink_metadata().is_ok() {
        fs::remove_file(socket_path).map_err(|err| {
            format!(
                "Cannot remove stale socket {}: {err}",
                socket_path.display()
            )
        })?;
        info!("Removed stale socket: {}", socket_path.display());
    }

    let listener = UnixListener::bind(socket_path)
        .map_err(|err| format!("Cannot bind {}: {err}", socket_path.display()))?;

    // A failed chmod is not fatal, matching the TypeScript. The default mode a
    // socket inherits from the umask is *narrower* than 0660, not wider, so the
    // failure mode is the bot being unable to connect — visible immediately, and
    // never a socket that is open to more of the machine than intended.
    if let Err(err) = fs::set_permissions(socket_path, fs::Permissions::from_mode(SOCKET_MODE)) {
        warn!(
            "Could not chmod {} to {SOCKET_MODE:o}: {err}",
            socket_path.display()
        );
    }

    Ok(listener)
}

/// Accepts connections until the process is signalled, serving each on a thread.
///
/// Never returns: the only way out is the signal handler installed in `main`,
/// which unlinks the socket and exits. Taking the listener by reference is what
/// lets a test spawn this on a thread against a socket of its own.
pub fn serve(listener: &UnixListener, signer: &Arc<Signer>, peers: PeerCheck) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let requests = Arc::new(AtomicU64::new(0));

    loop {
        // Taken before `accept` so a connection is never accepted that there is
        // no capacity to serve; the kernel holds it in the backlog instead.
        let permit = permits.acquire();

        let stream = match listener.accept() {
            Ok((stream, _addr)) => stream,
            Err(err) => {
                warn!("Accept failed: {err}");
                // Some accept failures (EMFILE, ENFILE) persist for as long as
                // the resource is exhausted, and retrying flat out would spin a
                // core doing nothing useful.
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };

        // Refused before the connection reaches a thread and before a single
        // byte is read from it: dropping `stream` here closes it, and the peer
        // sees the connection go away without ever being asked for a request.
        if let Err(reason) = admit(&stream, peers) {
            warn!("Refusing connection: {reason}");
            continue;
        }

        let signer = Arc::clone(signer);
        let requests = Arc::clone(&requests);
        if let Err(err) = thread::Builder::new()
            .name("signer-conn".to_owned())
            .spawn(move || {
                let _permit = permit;
                handle_connection(&stream, &signer, &requests);
            })
        {
            warn!("Could not spawn connection thread: {err}");
        }
    }
}

/// Serves one connection until the client hangs up or breaks the protocol.
///
/// The server never closes first on the happy path — `sendToSigner` destroys the
/// socket once it has its response, and a server-side close would race that and
/// surface in the bot as `ECONNRESET` instead of a clean result.
fn handle_connection(stream: &UnixStream, signer: &Signer, requests: &AtomicU64) {
    if let Err(err) = stream.set_read_timeout(Some(IDLE_TIMEOUT)) {
        warn!("Could not set read timeout: {err}");
    }

    let Ok(read_half) = stream.try_clone() else {
        warn!("Could not split connection for reading");
        return;
    };
    let mut reader = BufReader::new(read_half);
    let mut writer = stream;

    loop {
        match read_frame(&mut reader) {
            // Clean hang-up at a frame boundary: the expected end of every
            // connection the bot opens.
            Ok(None) => return,

            Ok(Some(frame)) => {
                let response = handle_request(&frame, signer, requests);
                if let Err(err) = write_frame(&mut writer, &response.to_json_bytes()) {
                    warn!("Could not write response: {err}");
                    return;
                }
            }

            // The one case where the server hangs up. The rest of the oversize
            // payload is still unread on the socket, so there is no frame
            // boundary left to resynchronise to — answering and closing is the
            // only way to tell the client why. Divergence from the TypeScript
            // signer, which has no cap and would simply buffer.
            Err(err @ ProtocolError::FrameTooLarge { .. }) => {
                warn!("Closing connection: {err}");
                let response = SignResponse::rejected(err.to_string());
                let _ = write_frame(&mut writer, &response.to_json_bytes());
                return;
            }

            // A half-written frame or a dead socket. There is no request to
            // answer, so this only gets logged — as `sock.on('error')` does.
            Err(err) => {
                if is_idle_timeout(&err) {
                    warn!("Closing idle connection after {}s", IDLE_TIMEOUT.as_secs());
                } else {
                    warn!("Dropping connection: {err}");
                }
                return;
            }
        }
    }
}

/// Whether a read failure is the [`IDLE_TIMEOUT`] firing rather than a real error.
fn is_idle_timeout(err: &ProtocolError) -> bool {
    matches!(
        err,
        ProtocolError::Io(io_err)
            if matches!(io_err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
    )
}

/// Turns one request frame into the response frame's payload.
///
/// Every failure becomes `{"ok":false,"error":…}` carrying the error's `Display`,
/// which is where the ported error strings pay off: the bot re-throws that text
/// verbatim (`src/utils/wallet.ts:113`), so it lands in the logs and the Discord
/// alerts exactly as the TypeScript signer would have written it.
fn handle_request(frame: &[u8], signer: &Signer, requests: &AtomicU64) -> SignResponse {
    let id = requests.fetch_add(1, Ordering::Relaxed) + 1;
    let started = Instant::now();

    match sign_frame(frame, signer, id) {
        Ok(response) => {
            info!("[#{id}] SIGNED ({}ms)", started.elapsed().as_millis());
            response
        }
        Err(err) => {
            warn!("[#{id}] REJECTED: {err}");
            SignResponse::rejected(err.to_string())
        }
    }
}

/// Parse → validate → decode → policy → sign → encode.
///
/// Errors are boxed rather than unified into one enum because nothing branches
/// on them: the caller only ever renders `Display` into the response. A policy
/// rejection joins them as its reason string, so it is logged and answered
/// exactly like a malformed request — `signer/index.ts:241-245` treats the two
/// the same way, and the difference that matters to the bot is `ok: false`.
fn sign_frame(
    frame: &[u8],
    signer: &Signer,
    id: u64,
) -> Result<SignResponse, Box<dyn std::error::Error>> {
    let request = SignRequest::from_json(frame)?;
    let kind = request.validate()?;
    let tx_bytes = request.decode_tx()?;
    info!("[#{id}] {kind} TX ({} bytes)", tx_bytes.len());

    let mut tx = ParsedTx::parse(kind, &tx_bytes)?;
    if let Verdict::Deny { reason } = signer.policy.check(&tx, signer.rpc.as_ref()) {
        return Err(reason.into());
    }

    tx.sign_with(&signer.keypair)?;
    Ok(SignResponse::signed(&tx.to_bytes()?))
}

// ── Connection cap ──────────────────────────────────────────────────────────

/// A counting semaphore over `std` primitives.
///
/// A dependency would do, but this is a mutex, a condvar and a counter, and the
/// permit's `Drop` is the part that has to be right: it releases even when a
/// connection thread panics, which is what keeps a panicking request from
/// permanently shrinking the pool.
struct Semaphore {
    available: Mutex<usize>,
    released: Condvar,
}

impl Semaphore {
    fn new(permits: usize) -> Self {
        Self {
            available: Mutex::new(permits),
            released: Condvar::new(),
        }
    }

    /// Blocks until a permit is free, then takes it.
    fn acquire(self: &Arc<Self>) -> Permit {
        let mut available = self
            .available
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        while *available == 0 {
            available = self
                .released
                .wait(available)
                .unwrap_or_else(PoisonError::into_inner);
        }
        *available -= 1;
        Permit(Arc::clone(self))
    }
}

/// Holds one permit for as long as it is alive.
struct Permit(Arc<Semaphore>);

impl Drop for Permit {
    fn drop(&mut self) {
        // `into_inner` on a poisoned lock: a panic while holding this mutex can
        // only have happened between the counter's decrement and increment, and
        // refusing to hand permits back would wedge the daemon for good.
        let mut available = self
            .0
            .available
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *available += 1;
        self.0.released.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use serde_json::Value;
    use signer_core::config::{
        dex_programs, program_allowlist, PolicyConfig, BYREAL_CLMM, JUPITER_V6, SYSTEM_PROGRAM,
    };
    use signer_core::rpc::MockRpc;
    use signer_core::tx::TxKind;
    use solana_sdk::hash::Hash;
    use solana_sdk::instruction::{AccountMeta, Instruction};
    use solana_sdk::message::Message;
    use solana_sdk::pubkey::Pubkey;
    use solana_sdk::signer::Signer as _;
    use solana_sdk::transaction::Transaction;

    use super::*;

    /// Removes the socket path when a test ends, panic or not.
    struct TempSocket(PathBuf);

    impl Drop for TempSocket {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn temp_socket() -> TempSocket {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let name = format!(
            "signer-rs-m3-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        TempSocket(std::env::temp_dir().join(name))
    }

    /// The daemon's own policy, against a chain where nothing exists.
    ///
    /// [`MockRpc`] answers every account read with "not found" and every
    /// simulation with an empty log, which is what keeps these tests about the
    /// socket: the transactions below are ones the policy clears without needing
    /// the network to vouch for anything. `simulation_tests.rs` is where the
    /// verdicts themselves are pinned down.
    fn signer(keypair: Arc<Keypair>) -> Arc<Signer> {
        let policy = PolicyEngine::new(PolicyConfig {
            program_allowlist: program_allowlist(BYREAL_CLMM),
            dex_programs: dex_programs(BYREAL_CLMM),
            destination_whitelist: std::collections::HashSet::new(),
            jupiter: JUPITER_V6,
        });
        Arc::new(Signer::new(keypair, policy, Box::new(MockRpc::new())))
    }

    /// Starts a server on a fresh socket and returns it with its signing key.
    fn start() -> (TempSocket, Arc<Keypair>) {
        start_with(PeerCheck::Off)
    }

    /// The same, with the peer check in a chosen state.
    fn start_with(peers: PeerCheck) -> (TempSocket, Arc<Keypair>) {
        let socket = temp_socket();
        let keypair = Arc::new(Keypair::new());

        let listener = bind(&socket.0).expect("bind should succeed");
        let served = signer(Arc::clone(&keypair));
        thread::spawn(move || serve(&listener, &served, peers));

        (socket, keypair)
    }

    /// An unsigned legacy transaction `payer` is the sole signer of.
    ///
    /// A System transfer: the smallest payload that is both signable and
    /// policy-clean, since the System program is on the allowlist and a lamport
    /// move is not an SPL token instruction. What is under test is the socket
    /// round trip, not the payload — but the payload has to survive the policy
    /// to get as far as a signature.
    fn unsigned_transfer(payer: &Keypair) -> Vec<u8> {
        // `System::Transfer { lamports: 1000 }`, hand-encoded: a u32
        // discriminator then a u64 amount. `solana_sdk::system_instruction` is
        // deprecated in favour of a crate the daemon has no other use for.
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend_from_slice(&1_000u64.to_le_bytes());

        let instruction = Instruction::new_with_bytes(
            SYSTEM_PROGRAM,
            &data,
            vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(Pubkey::new_unique(), false),
            ],
        );
        let message = Message::new(&[instruction], Some(&payer.pubkey()));
        let mut tx = Transaction::new_unsigned(message);
        tx.message.recent_blockhash = Hash::new_from_array([7u8; 32]);
        ParsedTx::Legacy(tx).to_bytes().expect("encodes")
    }

    /// The same shape, calling a program the allowlist has never heard of.
    fn unsigned_call_to(program: Pubkey, payer: &Keypair) -> Vec<u8> {
        let instruction = Instruction::new_with_bytes(program, &[1, 2, 3], Vec::new());
        let message = Message::new(&[instruction], Some(&payer.pubkey()));
        let mut tx = Transaction::new_unsigned(message);
        tx.message.recent_blockhash = Hash::new_from_array([7u8; 32]);
        ParsedTx::Legacy(tx).to_bytes().expect("encodes")
    }

    fn request_json(kind: &str, tx_bytes: &[u8]) -> Vec<u8> {
        format!(r#"{{"type":"{kind}","tx":"{}"}}"#, BASE64.encode(tx_bytes)).into_bytes()
    }

    fn connect(socket: &TempSocket) -> UnixStream {
        UnixStream::connect(&socket.0).expect("server should be accepting")
    }

    /// Reads one response frame and parses it as JSON.
    fn read_response(stream: &mut UnixStream) -> Value {
        let frame = read_frame(stream)
            .expect("response should arrive")
            .expect("response should not be an EOF");
        serde_json::from_slice(&frame).expect("response should be JSON")
    }

    fn send(stream: &mut UnixStream, payload: &[u8]) {
        write_frame(stream, payload).expect("request should be writable");
    }

    #[test]
    fn a_request_is_signed_and_the_connection_stays_open_for_another() {
        let (socket, keypair) = start();
        let mut client = connect(&socket);

        let unsigned = unsigned_transfer(&keypair);
        let expected = {
            let mut tx = ParsedTx::parse(TxKind::Legacy, &unsigned).expect("parses");
            tx.sign_with(&keypair).expect("signs");
            BASE64.encode(tx.to_bytes().expect("encodes"))
        };

        for _ in 0..2 {
            send(&mut client, &request_json("legacy", &unsigned));
            let response = read_response(&mut client);
            assert_eq!(response["ok"], Value::Bool(true), "{response}");
            assert_eq!(
                response["tx"].as_str(),
                Some(expected.as_str()),
                "signature bytes must match a local sign of the same transaction"
            );
        }
    }

    #[test]
    fn two_frames_written_at_once_are_answered_in_order() {
        // The TypeScript server answers the first and leaves the second sitting
        // in its buffer until more bytes happen to arrive.
        let (socket, keypair) = start();
        let mut client = connect(&socket);

        let mut both = Vec::new();
        write_frame(
            &mut both,
            &request_json("legacy", &unsigned_transfer(&keypair)),
        )
        .unwrap();
        write_frame(&mut both, br#"{"type":"bogus","tx":"AQID"}"#).unwrap();
        client.write_all(&both).expect("both frames in one write");

        let first = read_response(&mut client);
        assert_eq!(first["ok"], Value::Bool(true), "{first}");

        let second = read_response(&mut client);
        assert_eq!(second["ok"], Value::Bool(false), "{second}");
        assert_eq!(second["error"].as_str(), Some("Invalid type: bogus"));
    }

    #[test]
    fn a_rejected_request_does_not_end_the_connection() {
        let (socket, keypair) = start();
        let mut client = connect(&socket);

        send(&mut client, br#"{"tx":"AQID"}"#);
        let rejection = read_response(&mut client);
        assert_eq!(
            rejection["error"].as_str(),
            Some("Invalid request: missing type or tx")
        );

        send(
            &mut client,
            &request_json("legacy", &unsigned_transfer(&keypair)),
        );
        assert_eq!(read_response(&mut client)["ok"], Value::Bool(true));
    }

    #[test]
    fn a_transaction_the_policy_refuses_is_answered_with_its_reason() {
        // The seam this test guards is the wiring, not the rule: a rejection
        // from `PolicyEngine` has to reach the wire as `ok: false` carrying the
        // reason verbatim, rather than being logged and signed anyway.
        let (socket, keypair) = start();
        let mut client = connect(&socket);
        let program = Pubkey::new_unique();

        send(
            &mut client,
            &request_json("legacy", &unsigned_call_to(program, &keypair)),
        );

        let response = read_response(&mut client);
        assert_eq!(response["ok"], Value::Bool(false), "{response}");
        assert_eq!(
            response["error"].as_str(),
            Some(format!("Unknown program: {program}").as_str())
        );
        assert!(response["tx"].is_null(), "a refusal carries no transaction");
    }

    #[test]
    fn an_undecodable_transaction_is_reported_rather_than_signed() {
        let (socket, _keypair) = start();
        let mut client = connect(&socket);

        send(&mut client, &request_json("legacy", b"not a transaction"));
        let response = read_response(&mut client);
        assert_eq!(response["ok"], Value::Bool(false), "{response}");
        assert!(
            response["error"]
                .as_str()
                .expect("error text")
                .starts_with("Failed to deserialize legacy transaction:"),
            "{response}"
        );
    }

    #[test]
    fn an_oversize_frame_is_refused_and_the_server_hangs_up() {
        let (socket, _keypair) = start();
        let mut client = connect(&socket);

        // 70 KiB, past MAX_FRAME_LEN. Written as one buffer so the whole thing
        // lands in the socket before the server can close the other end.
        let payload = vec![b'x'; 70 * 1024];
        let mut wire = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
        wire.extend_from_slice(&payload);
        client
            .write_all(&wire)
            .expect("payload fits the socket buffer");

        let response = read_response(&mut client);
        assert_eq!(response["ok"], Value::Bool(false), "{response}");
        assert_eq!(
            response["error"].as_str(),
            Some("Frame too large: 71680 bytes exceeds the 65536-byte limit")
        );

        // The server closes without draining the 70 KiB it refused, so the
        // kernel aborts the connection rather than ending it politely: Linux
        // reports the leftover bytes as ECONNRESET on the next read instead of
        // EOF. Either is proof the server hung up; buffering the payload just to
        // earn a tidier EOF is the exact thing the cap exists to prevent.
        match read_frame(&mut client) {
            Ok(None) => {}
            Err(ProtocolError::Io(err)) if err.kind() == io::ErrorKind::ConnectionReset => {}
            other => panic!("expected the server to hang up, got {other:?}"),
        }
    }

    #[test]
    fn more_clients_than_permits_are_all_served() {
        let (socket, keypair) = start();
        let unsigned = Arc::new(unsigned_transfer(&keypair));

        let clients: Vec<_> = (0..MAX_CONNECTIONS * 3)
            .map(|_| {
                let path = socket.0.clone();
                let unsigned = Arc::clone(&unsigned);
                thread::spawn(move || {
                    let mut client =
                        UnixStream::connect(&path).expect("connections queue, never fail");
                    write_frame(&mut client, &request_json("legacy", &unsigned)).unwrap();
                    let frame = read_frame(&mut client).unwrap().unwrap();
                    serde_json::from_slice::<Value>(&frame).unwrap()["ok"] == Value::Bool(true)
                })
            })
            .collect();

        for (index, client) in clients.into_iter().enumerate() {
            assert!(client.join().expect("no client panicked"), "client {index}");
        }
    }

    // ── Peer credentials ────────────────────────────────────────────────────

    #[test]
    fn the_peer_check_lets_this_process_through() {
        // Every connection a test can make comes from this process, so the uid
        // always matches and the *accept* branch is all that can be reached from
        // a real socket. What this pins down is that the branch runs at all: the
        // request below is answered only if `admit` read the peer's credentials
        // off the socket and was satisfied by them. Refusal is covered by
        // `a_peer_uid_that_is_not_ours_is_refused`, against the decision function
        // rather than a socket, because a connection from another uid needs a
        // second user and the privilege to become it.
        let (socket, keypair) = start_with(PeerCheck::SameUid);
        let mut client = connect(&socket);

        send(
            &mut client,
            &request_json("legacy", &unsigned_transfer(&keypair)),
        );
        let response = read_response(&mut client);
        assert_eq!(response["ok"], Value::Bool(true), "{response}");
    }

    #[test]
    fn a_peer_uid_that_is_not_ours_is_refused() {
        let ours = Uid::from_raw(1000);
        assert!(check_peer_uid(ours, ours).is_ok());

        let err = check_peer_uid(Uid::from_raw(1001), ours)
            .expect_err("a different uid must not be served");
        assert_eq!(err, "peer uid 1001 is not 1000");
    }

    #[test]
    fn the_peer_check_is_off_unless_the_config_asks_for_it() {
        assert_eq!(PeerCheck::from(false), PeerCheck::Off);
        assert_eq!(PeerCheck::from(true), PeerCheck::SameUid);
    }

    #[test]
    fn admit_waves_every_connection_through_when_the_check_is_off() {
        let socket = temp_socket();
        let listener = bind(&socket.0).expect("bind should succeed");
        let accepted = thread::spawn(move || listener.accept().expect("a client is connecting").0);
        let _client = UnixStream::connect(&socket.0).expect("server should be accepting");

        let stream = accepted.join().expect("accept did not panic");
        assert!(admit(&stream, PeerCheck::Off).is_ok());
        assert!(
            admit(&stream, PeerCheck::SameUid).is_ok(),
            "and through the check too, since the peer is this process"
        );
    }

    #[test]
    fn binding_clears_a_stale_socket_file() {
        let socket = temp_socket();
        fs::write(&socket.0, b"left over from a crashed signer").expect("write stale file");

        let listener = bind(&socket.0).expect("a stale path must not block startup");
        drop(listener);
    }

    #[test]
    fn the_socket_is_owner_and_group_only() {
        let socket = temp_socket();
        let listener = bind(&socket.0).expect("bind should succeed");

        let mode = fs::metadata(&socket.0)
            .expect("socket exists")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, SOCKET_MODE, "mode was {:o}", mode & 0o777);
        drop(listener);
    }
}
