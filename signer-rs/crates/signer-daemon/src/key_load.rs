//! Finding the encrypted keyfile and unlocking it into an in-memory keypair.
//!
//! Port of `init()` in `signer/index.ts:156-204`. All three unlock routes are
//! here — stdin only, the browser page only (systemd, where there is no TTY), or
//! a race between the two — with the page itself living in [`crate::unlock`].
//!
//! The password and the decrypted key never leave [`Zeroizing`] buffers, and the
//! only thing that outlives this module is the [`Keypair`] itself.

use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::thread;

use signer_core::crypto::{self, EncryptedKeyfile, SecretString, Zeroizing};
use solana_sdk::signer::keypair::Keypair;
use solana_sdk::signer::Signer as _;

use crate::unlock::{UnlockMode, UnlockServer};

/// Keyfile location when `SIGNER_KEYFILE_PATH` is unset.
///
/// Resolved against the working directory, which is what `bin/setup.rs` writes
/// to — the two have to agree or the operator encrypts a key the daemon cannot
/// find. (`signer/index.ts:19` resolves it against `__dirname` instead; the
/// systemd unit and `manage.sh` both start the signer from its own directory, so
/// the two spellings pick the same file in the deployment that exists.)
pub const DEFAULT_KEYFILE: &str = "keyfile.enc.json";

/// Overrides [`DEFAULT_KEYFILE`]. Kept identical to `bin/setup.rs`.
pub const ENV_KEYFILE_PATH: &str = "SIGNER_KEYFILE_PATH";

/// The keyfile this process should unlock.
#[must_use]
pub fn keyfile_path() -> PathBuf {
    match std::env::var_os(ENV_KEYFILE_PATH) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(DEFAULT_KEYFILE),
    }
}

/// What the terminal prompt says (`signer/index.ts:24`).
const PROMPT: &str = "Enter password to unlock signer: ";

/// Reads the keyfile, collects the password by `mode`, and returns the keypair.
///
/// # Errors
///
/// A human-readable message, already phrased for an operator staring at a
/// terminal: a missing keyfile names the path and the tool that creates one, and
/// a wrong password says only "Wrong password" — the same single failure mode
/// [`crypto::decrypt_key`] reports for a tampered file, so neither the operator
/// nor anyone reading the logs learns which it was.
pub fn unlock(path: &Path, mode: UnlockMode) -> Result<Arc<Keypair>, String> {
    let keyfile = read_keyfile(path)?;

    let key_b58 = match mode {
        UnlockMode::Stdin => unlock_via_stdin(&keyfile)?,
        UnlockMode::Web(port) => unlock_via_web(&keyfile, port)?,
        UnlockMode::Race(port) => unlock_via_race(&keyfile, port)?,
    };

    keypair_from_base58(&key_b58).map(Arc::new)
}

/// Loads and parses `keyfile.enc.json`.
fn read_keyfile(path: &Path) -> Result<EncryptedKeyfile, String> {
    // `exists()` is false for a dangling symlink, which is exactly the case an
    // operator wants named rather than reported as a parse failure later.
    if path.symlink_metadata().is_err() {
        return Err(format!(
            "Encrypted keyfile not found: {}\nRun: cargo run -p signer-daemon --bin setup",
            path.display()
        ));
    }

    let json = fs::read_to_string(path)
        .map_err(|err| format!("Could not read {}: {err}", path.display()))?;
    EncryptedKeyfile::from_json(&json).map_err(|err| err.to_string())
}

/// One password from stdin; a wrong one is fatal (`signer/index.ts:188-197`).
fn unlock_via_stdin(keyfile: &EncryptedKeyfile) -> Result<Zeroizing<String>, String> {
    let password = prompt_password(PROMPT)?;
    decrypt(keyfile, &password)
}

/// The unlock page alone: a background process with no terminal to prompt on.
fn unlock_via_web(keyfile: &EncryptedKeyfile, port: u16) -> Result<Zeroizing<String>, String> {
    let server = UnlockServer::bind(port)?;
    announce(server.port());

    server
        .serve(keyfile)
        .ok_or_else(|| "The unlock page stopped before a password arrived.".to_owned())
}

/// Both routes at once, first correct password wins (`signer/index.ts:173-187`).
///
/// The two threads race to *decrypt*, not merely to submit: each runs scrypt
/// itself and only a success is sent, so a wrong password on one route cannot
/// beat a right one on the other. The channel therefore carries the decrypted
/// key, and this thread — which owns nothing else — is the coordinator.
///
/// Losing routes are torn down as far as they can be. The page is stopped and
/// joined, which closes its port before the daemon starts signing — at worst
/// after the wrong-password delay its thread happened to be sleeping through,
/// which is a few seconds once and never on the path an operator waits on.
/// The stdin read cannot be cancelled at all: `read_line` blocks in the kernel,
/// and nothing in `std` interrupts it. That thread is left where it is, holding
/// a terminal nobody is going to type into again, and the process moves on — the
/// same thing the TypeScript does with a `readline` interface it never closes.
fn unlock_via_race(keyfile: &EncryptedKeyfile, port: u16) -> Result<Zeroizing<String>, String> {
    let server = UnlockServer::bind(port)?;
    announce(server.port());

    let (sender, unlocked) = mpsc::channel();
    let stopper = server.stopper();

    let web_keyfile = keyfile.clone();
    let web_sender = sender.clone();
    let web = thread::Builder::new()
        .name("signer-unlock-web".to_owned())
        .spawn(move || {
            if let Some(key) = server.serve(&web_keyfile) {
                // A closed receiver means stdin won and the coordinator has
                // already moved on; there is nobody to hand this key to.
                let _ = web_sender.send(key);
            }
        })
        .map_err(|err| format!("Could not start the unlock page thread: {err}"))?;

    let stdin_keyfile = keyfile.clone();
    thread::Builder::new()
        .name("signer-unlock-stdin".to_owned())
        .spawn(move || {
            // Only the decrypt failure is relabelled, so "Wrong password
            // (stdin)." reads exactly as `signer/index.ts:183` prints it while a
            // closed stdin still reports itself as a closed stdin.
            match prompt_password(PROMPT).and_then(|password| {
                decrypt(&stdin_keyfile, &password).map_err(|err| format!("{err} (stdin)."))
            }) {
                Ok(key) => {
                    let _ = sender.send(key);
                }
                // `signer/index.ts:183-185` logs this and returns a promise that
                // never resolves, leaving the page as the only way in. Ending the
                // thread here has the same effect and leaks nothing: stdin is not
                // read again either way.
                Err(message) => error!("{message}"),
            }
        })
        .map_err(|err| format!("Could not start the stdin unlock thread: {err}"))?;

    let key = unlocked
        .recv()
        .map_err(|_| "Both unlock routes ended without a password.".to_owned())?;

    stopper.stop();
    let _ = web.join();
    Ok(key)
}

/// Says where the page is, in the words `signer/index.ts:149-150` uses.
fn announce(port: u16) {
    info!("Unlock page: http://127.0.0.1:{port}");
    info!("Waiting for password...");
}

/// Turns a typed password into the base58 private key the keyfile holds.
fn decrypt(
    keyfile: &EncryptedKeyfile,
    password: &Zeroizing<String>,
) -> Result<Zeroizing<String>, String> {
    crypto::decrypt_key(keyfile, &SecretString::from(password.to_string()))
        .map_err(|err| err.to_string())
}

/// The wallet address a keypair signs for, for the startup banner.
#[must_use]
pub fn address(keypair: &Keypair) -> String {
    keypair.pubkey().to_string()
}

/// Decodes the base58 secret key the keyfile holds.
///
/// Mirrors `Keypair.fromSecretKey(bs58.decode(privateKey))` in
/// `signer/index.ts:200`. The intermediate bytes are wiped on the way out;
/// `Keypair` itself zeroizes on drop.
fn keypair_from_base58(key_b58: &Zeroizing<String>) -> Result<Keypair, String> {
    let bytes = Zeroizing::new(
        bs58::decode(key_b58.as_str())
            .into_vec()
            .map_err(|err| format!("Invalid private key: {err}"))?,
    );
    Keypair::try_from(&bytes[..]).map_err(|err| format!("Invalid private key: {err}"))
}

/// Reads one password from stdin without echoing it.
///
/// Same shape as `bin/setup.rs`: `rpassword` needs a terminal to switch echo
/// off, so a piped stdin — systemd, `manage.sh`, the e2e harness — falls back to
/// a plain line read. `askPasswordStdin` in `signer/index.ts:22-33` trims the
/// line, so a trailing newline or stray whitespace is not part of the password;
/// this trims too.
fn prompt_password(prompt: &str) -> Result<Zeroizing<String>, String> {
    let raw = if io::stdin().is_terminal() {
        Zeroizing::new(
            rpassword::prompt_password(prompt)
                .map_err(|err| format!("Could not read password: {err}"))?,
        )
    } else {
        eprint!("{prompt}");
        io::stderr().flush().ok();

        let mut line = String::new();
        let read = io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|err| format!("Could not read password: {err}"))?;
        if read == 0 {
            return Err("No password provided (stdin closed).".to_owned());
        }
        Zeroizing::new(line)
    };

    Ok(Zeroizing::new(raw.trim().to_owned()))
}
