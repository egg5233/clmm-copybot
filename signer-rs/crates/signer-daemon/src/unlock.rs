//! The localhost unlock page.
//!
//! Port of `askPasswordWeb` in `signer/index.ts:96-153`, plus the mode selection
//! from `init()` (`signer/index.ts:166-197`). The daemon starts locked: it has an
//! encrypted keyfile and no way to read it until an operator supplies the
//! password, either on stdin or through this page.
//!
//! Everything a client can observe is pinned to what the Node server sends,
//! because the dashboard proxies this page verbatim and its JavaScript branches
//! on the JSON:
//!
//! | request                    | status | `Content-Type`            | body                                          |
//! |----------------------------|--------|---------------------------|-----------------------------------------------|
//! | `GET /`, `GET /unlock`     | 200    | `text/html; charset=utf-8`| [`UNLOCK_PAGE`]                               |
//! | `POST /unlock`, correct    | 200    | `application/json`        | `{"ok":true}`                                 |
//! | `POST /unlock`, wrong      | 401    | `application/json`        | `{"ok":false,"error":"密碼錯誤 Wrong password"}` |
//! | `POST /unlock`, no password| 400    | `application/json`        | `{"ok":false,"error":"請輸入密碼"}`            |
//! | `POST /unlock`, not JSON   | 400    | `application/json`        | `{"ok":false,"error":"Invalid request"}`      |
//! | anything else              | 404    | —                         | empty                                         |
//!
//! Two differences from Node are unavoidable or deliberate:
//!
//! * `tiny_http` adds a `Server: tiny-http (Rust)` header, which Node does not
//!   send. Nothing keys on it; the page is reachable from loopback only.
//! * Wrong passwords are **rate limited** ([`backoff`]). The TypeScript signer
//!   answers them as fast as scrypt allows, which on a shared host is an offline
//!   guessing oracle with a network-speed interface.

use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use signer_core::crypto::{self, EncryptedKeyfile, SecretString, Zeroizing};
use tiny_http::{Header, Method, Request, Response, Server};

/// The unlock page itself, byte-identical to `UNLOCK_HTML`
/// (`signer/index.ts:36-94`).
///
/// Kept as a file rather than a Rust string literal so the two can be diffed:
/// the extraction is a copy of the template literal's contents, with no trailing
/// newline, and `.gitattributes` pins it to LF so a checkout cannot rewrite the
/// bytes this serves.
pub const UNLOCK_PAGE: &str = include_str!("unlock.html");

/// Where the unlock page listens. **Not configurable, by design.**
///
/// The page accepts the one secret that turns an encrypted keyfile into a live
/// signing key, and it is reached through the dashboard's authenticated proxy
/// (`src/dashboard/server.ts`) — never directly. A `SIGNER_UNLOCK_HOST` variable
/// would exist only to be set to `0.0.0.0` by someone who could not reach the
/// page from their laptop, which publishes an unauthenticated password endpoint
/// to the whole network. `SIGNER_UNLOCK_PORT` chooses the port; the address is
/// loopback or nothing. (`signer/index.ts:98` hard-codes it the same way.)
const BIND_ADDR: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// Largest `POST /unlock` body read, in bytes.
///
/// A password payload is a few dozen bytes; anything past this is not a browser
/// filling in the form. The excess is not buffered, so the JSON simply fails to
/// parse and the sender gets `Invalid request`. Node has no such cap.
const MAX_BODY_LEN: u64 = 8 * 1024;

/// Delay before the first wrong-password answer; doubles from there.
const BACKOFF_BASE: Duration = Duration::from_millis(250);

/// Ceiling on the wrong-password delay.
///
/// Long enough to make sustained guessing pointless, short enough that an
/// operator who fat-fingers the password twice is not locked out of their own
/// unlock page. There is no lockout: the count resets on success.
const BACKOFF_CAP: Duration = Duration::from_secs(5);

/// How the password will be collected (`signer/index.ts:166-197`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockMode {
    /// No unlock page: read one password from stdin, and fail if it is wrong.
    Stdin,
    /// Unlock page only — a background process with no terminal to prompt on.
    Web(u16),
    /// Both, racing: whichever route supplies a correct password first wins.
    Race(u16),
}

impl UnlockMode {
    /// Picks the route the way `init()` does.
    ///
    /// `unlock_port` is [`signer_core::config::SignerConfig::unlock_port`], where
    /// `0` disables the page. The TTY check is what separates the two web modes:
    /// under systemd there is no terminal, so stdin would block forever on a
    /// prompt nobody can answer, and racing it would only add a thread that never
    /// finishes.
    #[must_use]
    pub fn select(unlock_port: u16, stdin_is_terminal: bool) -> Self {
        match (unlock_port, stdin_is_terminal) {
            (0, _) => Self::Stdin,
            (port, false) => Self::Web(port),
            (port, true) => Self::Race(port),
        }
    }
}

// ── Wire replies ────────────────────────────────────────────────────────────

/// One fully decided HTTP reply.
///
/// The bodies are `&'static str` literals rather than anything serialized: these
/// exact bytes — including the zh-TW error text, unescaped UTF-8, in this field
/// order — are what `signer/index.ts` puts on the wire, and what the unlock
/// page's own JavaScript reads back.
struct Reply {
    status: u16,
    /// `None` sends no `Content-Type` at all, as `res.writeHead(404)` does.
    content_type: Option<&'static str>,
    body: &'static str,
}

const HTML: &str = "text/html; charset=utf-8";
const JSON: &str = "application/json";

const PAGE: Reply = Reply {
    status: 200,
    content_type: Some(HTML),
    body: UNLOCK_PAGE,
};

const UNLOCKED: Reply = Reply {
    status: 200,
    content_type: Some(JSON),
    body: r#"{"ok":true}"#,
};

const WRONG_PASSWORD: Reply = Reply {
    status: 401,
    content_type: Some(JSON),
    body: r#"{"ok":false,"error":"密碼錯誤 Wrong password"}"#,
};

const EMPTY_PASSWORD: Reply = Reply {
    status: 400,
    content_type: Some(JSON),
    body: r#"{"ok":false,"error":"請輸入密碼"}"#,
};

const INVALID_REQUEST: Reply = Reply {
    status: 400,
    content_type: Some(JSON),
    body: r#"{"ok":false,"error":"Invalid request"}"#,
};

const NOT_FOUND: Reply = Reply {
    status: 404,
    content_type: None,
    body: "",
};

// ── Server ──────────────────────────────────────────────────────────────────

/// A bound, not-yet-serving unlock page.
///
/// Binding is separate from serving so a port already in use is reported at
/// startup, on the thread that can still turn it into an exit code, rather than
/// from inside a worker after the daemon has announced it is waiting.
pub struct UnlockServer {
    server: Arc<Server>,
    port: u16,
}

impl UnlockServer {
    /// Binds the unlock page to `127.0.0.1:port`.
    ///
    /// # Errors
    ///
    /// A message ready to print if the port cannot be bound — in practice a
    /// second signer already running, or a port under 1024 without the
    /// capability to bind it.
    pub fn bind(port: u16) -> Result<Self, String> {
        let addr = SocketAddr::from((BIND_ADDR, port));
        let server = Server::http(addr)
            .map_err(|err| format!("Cannot serve the unlock page on {addr}: {err}"))?;

        // Port 0 asks the OS to choose, which only the tests do; reading it back
        // means the logged URL is always the one that works.
        let port = server.server_addr().to_ip().map_or(port, |ip| ip.port());

        Ok(Self {
            server: Arc::new(server),
            port,
        })
    }

    /// The port actually bound.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// A handle that stops [`UnlockServer::serve`] from another thread.
    #[must_use]
    pub fn stopper(&self) -> Stopper {
        Stopper(Arc::clone(&self.server))
    }

    /// Serves the page until a correct password arrives, or a [`Stopper`] fires.
    ///
    /// Returns the decrypted base58 private key, or `None` if the loop was
    /// stopped — the stdin route won the race, or the listener failed.
    ///
    /// Requests are handled one at a time, on this thread. That is not a
    /// simplification: it is what makes [`backoff`] a throttle on the endpoint
    /// rather than on a single connection, since a guesser cannot open ten
    /// sockets and pay the delay once.
    ///
    /// Taking `self` by value is deliberate too. The bound socket lives in the
    /// [`Server`], so returning the key drops it, and the port stops answering
    /// the moment the daemon is unlocked — no window in which a signer that is
    /// already serving still has a password endpoint open.
    #[must_use]
    pub fn serve(self, keyfile: &EncryptedKeyfile) -> Option<Zeroizing<String>> {
        // Consecutive wrong passwords, for [`backoff`]. It resets on success by
        // construction: a correct password returns, so the counter cannot
        // outlive the unlock it was throttling.
        let mut failures: u32 = 0;

        loop {
            // `Err` is either `unblock()` — the race is over — or a listener that
            // stopped accepting. Both mean this route is finished.
            let Ok(mut request) = self.server.recv() else {
                return None;
            };

            let target = route(request.method(), request.url());
            let reply = match target {
                Route::Page => &PAGE,
                Route::NotFound => &NOT_FOUND,
                Route::Attempt => {
                    let body = read_body(&mut request);
                    match evaluate(&body, keyfile) {
                        Attempt::Unlocked(key) => {
                            // Answer before anything else, exactly as
                            // `signer/index.ts:125-131` does: the browser is
                            // holding a fetch open, and dropping the server first
                            // would close its connection instead of telling it
                            // the password was right.
                            send(request, &UNLOCKED);
                            info!("Unlocked via browser");
                            return Some(key);
                        }
                        Attempt::Wrong => {
                            let delay = backoff(failures);
                            failures += 1;
                            warn!(
                                "Wrong password on the unlock page (attempt {failures}); \
                                 answering in {}ms",
                                delay.as_millis()
                            );
                            std::thread::sleep(delay);
                            &WRONG_PASSWORD
                        }
                        Attempt::Empty => &EMPTY_PASSWORD,
                        Attempt::Malformed => &INVALID_REQUEST,
                    }
                }
            };

            send(request, reply);
        }
    }
}

/// Stops a [`UnlockServer::serve`] loop running on another thread.
///
/// Consuming `self` in [`Stopper::stop`] is what closes the listening socket:
/// the loop's `recv` returns, its thread drops the last-but-one reference, and
/// dropping this handle drops the [`Server`] itself.
pub struct Stopper(Arc<Server>);

impl Stopper {
    /// Wakes the serving thread so it can finish.
    pub fn stop(self) {
        self.0.unblock();
    }
}

/// Delay before answering the wrong password that follows `prior_failures`.
///
/// 250ms, 500ms, 1s, 2s, 4s, then 5s forever. scrypt already costs the guesser
/// ~100ms per attempt (`N = 16384`), which is a real floor but a fixed one; the
/// doubling is what turns a sustained run into hours per thousand guesses. It
/// costs an operator who mistypes their password once a quarter of a second.
fn backoff(prior_failures: u32) -> Duration {
    let doubling = 1u32.checked_shl(prior_failures).unwrap_or(u32::MAX);
    BACKOFF_BASE.saturating_mul(doubling).min(BACKOFF_CAP)
}

/// Writes one reply and hangs up on the client, logging an I/O failure.
///
/// A browser that navigated away mid-request is the normal cause and is not
/// worth more than a line in the log.
fn send(request: Request, reply: &Reply) {
    let mut response = Response::from_data(reply.body.as_bytes()).with_status_code(reply.status);
    if let Some(content_type) = reply.content_type {
        response.add_header(
            Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
                .expect("the Content-Type constants are valid header values"),
        );
    }

    if let Err(err) = request.respond(response) {
        warn!("Could not answer an unlock request: {err}");
    }
}

/// Reads the request body, capped at [`MAX_BODY_LEN`].
///
/// [`Zeroizing`] because this is the password in the clear: the JSON arrives
/// unencrypted over loopback, and the buffer holding it is wiped as soon as the
/// attempt has been decided.
fn read_body(request: &mut Request) -> Zeroizing<Vec<u8>> {
    let mut body = Zeroizing::new(Vec::new());
    // A truncated read leaves unbalanced JSON, which `evaluate` reports as
    // `Invalid request` — the same answer an oversize body deserves.
    if let Err(err) = request
        .as_reader()
        .take(MAX_BODY_LEN)
        .read_to_end(&mut body)
    {
        warn!("Could not read an unlock request body: {err}");
    }
    body
}

// ── Routing and body handling ───────────────────────────────────────────────

/// What a request line asks for.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// Serve the unlock page.
    Page,
    /// A password to check.
    Attempt,
    /// Everything else, including `POST /` and `GET /unlock?x=1`.
    NotFound,
}

/// Matches the request line the way `signer/index.ts:102-144` does.
///
/// The comparison is against the raw target, so a query string makes the path
/// stop matching — `req.url` in Node carries the query too, and the page never
/// sends one.
fn route(method: &Method, url: &str) -> Route {
    match (method, url) {
        (Method::Get, "/" | "/unlock") => Route::Page,
        (Method::Post, "/unlock") => Route::Attempt,
        _ => Route::NotFound,
    }
}

/// What one `POST /unlock` body amounts to.
enum Attempt {
    /// Correct password; carries the decrypted base58 private key.
    Unlocked(Zeroizing<String>),
    /// A password that did not decrypt the keyfile.
    Wrong,
    /// No password in the payload.
    Empty,
    /// A body that is not usable JSON.
    Malformed,
}

/// Checks one submitted body against the keyfile.
///
/// The scrypt work happens here, on the thread that received the request, which
/// is what makes the race in `key_load.rs` a race to a *correct* password rather
/// than to a submitted one — the TypeScript signer decrypts per attempt for the
/// same reason.
fn evaluate(body: &[u8], keyfile: &EncryptedKeyfile) -> Attempt {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Attempt::Malformed;
    };

    match password_of(value) {
        Password::Unusable => Attempt::Malformed,
        Password::Falsy => Attempt::Empty,
        // A truthy non-string reaches `scryptSync` in Node, which throws
        // `ERR_INVALID_ARG_TYPE` inside the `try` that answers 401
        // (`signer/index.ts:123-135`). Same answer here, without pretending a
        // number could ever have been the password.
        Password::NotText => Attempt::Wrong,
        Password::Text(password) => match crypto::decrypt_key(keyfile, &password) {
            Ok(key) => Attempt::Unlocked(key),
            Err(_) => Attempt::Wrong,
        },
    }
}

/// The `password` field, classified by what JavaScript would have made of it.
enum Password {
    /// `const { password } = …` would have thrown: the body was `null`.
    Unusable,
    /// Absent, or present and falsy — `""`, `0`, `false`, `null`.
    Falsy,
    /// Truthy but not a string.
    NotText,
    /// A non-empty string.
    Text(SecretString),
}

/// Destructures `{ password }` with JavaScript's rules.
///
/// Taking the parsed tree by value is deliberate: the string is *moved* into a
/// [`SecretString`], which wipes it on drop, so the only copy of the password
/// left in memory after this returns is one that zeroizes itself.
///
/// Node reaches the same four outcomes because destructuring succeeds on any
/// value except `null`/`undefined` — an array or a number simply yields
/// `undefined` for `password`.
fn password_of(value: Value) -> Password {
    let mut fields = match value {
        Value::Object(fields) => fields,
        Value::Null => return Password::Unusable,
        _ => return Password::Falsy,
    };

    match fields.remove("password") {
        None | Some(Value::Null | Value::Bool(false)) => Password::Falsy,
        Some(Value::String(text)) if text.is_empty() => Password::Falsy,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => Password::Falsy,
        Some(Value::String(text)) => Password::Text(SecretString::from(text)),
        Some(_) => Password::NotText,
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::thread;

    use signer_core::crypto::encrypt_key;

    use super::*;

    const PASSWORD: &str = "test-password-123";
    /// Any base58 string decrypts back out; nothing here builds a keypair.
    const SECRET: &str = "4NMwxzmYj2uvHuq8xoqhY8RXg63KSVJM1DXkpbmkUY7Y";

    fn keyfile() -> EncryptedKeyfile {
        encrypt_key(
            &Zeroizing::new(SECRET.to_owned()),
            &SecretString::from(PASSWORD.to_owned()),
        )
        .expect("encrypting a base58 string succeeds")
    }

    #[test]
    fn mode_selection_matches_the_typescript_signer() {
        assert_eq!(UnlockMode::select(0, true), UnlockMode::Stdin);
        assert_eq!(UnlockMode::select(0, false), UnlockMode::Stdin);
        assert_eq!(UnlockMode::select(3848, false), UnlockMode::Web(3848));
        assert_eq!(UnlockMode::select(3848, true), UnlockMode::Race(3848));
    }

    #[test]
    fn only_two_paths_and_two_methods_are_served() {
        assert_eq!(route(&Method::Get, "/"), Route::Page);
        assert_eq!(route(&Method::Get, "/unlock"), Route::Page);
        assert_eq!(route(&Method::Post, "/unlock"), Route::Attempt);

        assert_eq!(route(&Method::Post, "/"), Route::NotFound);
        assert_eq!(route(&Method::Get, "/unlock/"), Route::NotFound);
        assert_eq!(route(&Method::Get, "/unlock?pw=x"), Route::NotFound);
        assert_eq!(route(&Method::Head, "/"), Route::NotFound);
        assert_eq!(
            route(&Method::Get, "/../signer/keyfile.enc.json"),
            Route::NotFound
        );
    }

    #[test]
    fn the_embedded_page_is_the_typescript_template_verbatim() {
        // The trailing newline is the one thing an editor is likely to "fix",
        // and it would put a byte on the wire that Node never sends.
        assert!(UNLOCK_PAGE.starts_with("<!DOCTYPE html>\n<html lang=\"zh-TW\">"));
        assert!(UNLOCK_PAGE.ends_with("</script></body></html>"));
        assert!(!UNLOCK_PAGE.contains('\r'), "the page must stay LF-only");
        assert!(UNLOCK_PAGE.contains("輸入密碼以解鎖簽名服務"));
        assert!(UNLOCK_PAGE.contains("解鎖 Unlock"));
        assert!(UNLOCK_PAGE.contains("fetch('/unlock',{method:'POST',"));
    }

    #[test]
    fn a_body_is_classified_the_way_javascript_would() {
        let keyfile = keyfile();
        let verdict = |body: &str| match evaluate(body.as_bytes(), &keyfile) {
            Attempt::Unlocked(key) => {
                assert_eq!(key.as_str(), SECRET);
                "unlocked"
            }
            Attempt::Wrong => "wrong",
            Attempt::Empty => "empty",
            Attempt::Malformed => "malformed",
        };

        assert_eq!(verdict(r#"{"password":"test-password-123"}"#), "unlocked");
        assert_eq!(verdict(r#"{"password":"nope"}"#), "wrong");

        // Falsy `password`, in every spelling JSON allows.
        assert_eq!(verdict(r#"{"password":""}"#), "empty");
        assert_eq!(verdict(r#"{"password":null}"#), "empty");
        assert_eq!(verdict(r#"{"password":false}"#), "empty");
        assert_eq!(verdict(r#"{"password":0}"#), "empty");
        assert_eq!(verdict("{}"), "empty");
        assert_eq!(verdict(r#"{"pw":"test-password-123"}"#), "empty");
        // Destructuring these yields `undefined`, not a throw.
        assert_eq!(verdict("[1,2]"), "empty");
        assert_eq!(verdict("42"), "empty");

        // Truthy but not a string: Node throws inside the 401 handler.
        assert_eq!(verdict(r#"{"password":1}"#), "wrong");
        assert_eq!(verdict(r#"{"password":true}"#), "wrong");
        assert_eq!(verdict(r#"{"password":{"a":1}}"#), "wrong");

        assert_eq!(verdict(""), "malformed");
        assert_eq!(verdict("not json at all"), "malformed");
        assert_eq!(verdict(r#"{"password":"unterminated"#), "malformed");
        // `const { password } = null` throws, so Node answers `Invalid request`.
        assert_eq!(verdict("null"), "malformed");
    }

    #[test]
    fn the_backoff_doubles_and_then_holds() {
        assert_eq!(backoff(0), Duration::from_millis(250));
        assert_eq!(backoff(1), Duration::from_millis(500));
        assert_eq!(backoff(2), Duration::from_secs(1));
        assert_eq!(backoff(4), Duration::from_secs(4));
        assert_eq!(backoff(5), BACKOFF_CAP);
        // No overflow panic once the shift runs off the end of a u32.
        assert_eq!(backoff(31), BACKOFF_CAP);
        assert_eq!(backoff(u32::MAX), BACKOFF_CAP);
    }

    // ── Over a real socket ──────────────────────────────────────────────────

    /// A parsed HTTP response. Named to stay out of `tiny_http::Response`'s way.
    struct HttpReply {
        status: String,
        headers: Vec<String>,
        body: String,
    }

    impl HttpReply {
        fn header(&self, name: &str) -> Option<&str> {
            let prefix = format!("{}: ", name.to_lowercase());
            self.headers
                .iter()
                .find(|line| line.to_lowercase().starts_with(&prefix))
                .map(|line| line[prefix.len()..].trim())
        }
    }

    /// One request/response exchange, hanging up afterwards.
    ///
    /// `Connection: close` is what lets this read to EOF instead of guessing when
    /// a keep-alive response has finished.
    fn request(port: u16, method: &str, path: &str, body: Option<&str>) -> HttpReply {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("page is up");
        let mut head =
            format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
        if let Some(body) = body {
            write!(
                head,
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            )
            .expect("writing to a String cannot fail");
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).expect("request head");
        if let Some(body) = body {
            stream.write_all(body.as_bytes()).expect("request body");
        }
        stream.flush().expect("flush");

        let mut reader = BufReader::new(stream);
        let mut status = String::new();
        reader.read_line(&mut status).expect("status line");

        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("header line");
            let line = line.trim_end().to_owned();
            if line.is_empty() {
                break;
            }
            headers.push(line);
        }

        let mut body = Vec::new();
        reader.read_to_end(&mut body).expect("body");

        HttpReply {
            status: status.trim_end().to_owned(),
            headers,
            body: String::from_utf8(body).expect("responses are UTF-8"),
        }
    }

    #[test]
    fn the_page_answers_every_case_with_the_typescript_bytes() {
        let server = UnlockServer::bind(0).expect("an ephemeral port is available");
        let port = server.port();
        let unlocked = thread::spawn(move || server.serve(&keyfile()));

        for path in ["/", "/unlock"] {
            let response = request(port, "GET", path, None);
            assert_eq!(response.status, "HTTP/1.1 200 OK");
            assert_eq!(response.header("Content-Type"), Some(HTML));
            assert_eq!(response.body, UNLOCK_PAGE, "GET {path}");
        }

        let wrong = request(port, "POST", "/unlock", Some(r#"{"password":"nope"}"#));
        assert_eq!(wrong.status, "HTTP/1.1 401 Unauthorized");
        assert_eq!(wrong.header("Content-Type"), Some(JSON));
        assert_eq!(wrong.body, WRONG_PASSWORD.body);

        let empty = request(port, "POST", "/unlock", Some(r#"{"password":""}"#));
        assert_eq!(empty.status, "HTTP/1.1 400 Bad Request");
        assert_eq!(empty.body, EMPTY_PASSWORD.body);

        let malformed = request(port, "POST", "/unlock", Some("{"));
        assert_eq!(malformed.status, "HTTP/1.1 400 Bad Request");
        assert_eq!(malformed.body, INVALID_REQUEST.body);

        let missing = request(port, "GET", "/nope", None);
        assert_eq!(missing.status, "HTTP/1.1 404 Not Found");
        assert_eq!(missing.header("Content-Type"), None);
        assert!(missing.body.is_empty());

        let ok = request(
            port,
            "POST",
            "/unlock",
            Some(r#"{"password":"test-password-123"}"#),
        );
        assert_eq!(ok.status, "HTTP/1.1 200 OK");
        assert_eq!(ok.header("Content-Type"), Some(JSON));
        assert_eq!(ok.body, UNLOCKED.body);

        let key = unlocked.join().expect("the serving thread finished");
        assert_eq!(key.expect("a correct password unlocks").as_str(), SECRET);
    }

    #[test]
    fn a_stopper_ends_the_loop_without_a_password() {
        let server = UnlockServer::bind(0).expect("an ephemeral port is available");
        let stopper = server.stopper();
        let loop_ended = thread::spawn(move || server.serve(&keyfile()));

        stopper.stop();
        assert!(
            loop_ended
                .join()
                .expect("the serving thread finished")
                .is_none(),
            "a stopped loop must not produce a key"
        );
    }
}
