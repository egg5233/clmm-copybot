//! Byreal signer daemon.
//!
//! Reads its configuration, unlocks the encrypted keyfile, and serves signing
//! requests on a Unix socket — the runnable half of `signer/index.ts`.
//!
//! **M6 status: the policy engine is wired and the daemon unlocks the way the
//! TypeScript signer does.** Every request is resolved, checked against the
//! program allowlist and the SPL rules, and simulated before a signature is
//! produced; the password arrives on stdin, through the localhost unlock page
//! (`SIGNER_UNLOCK_PORT`), or through whichever of the two answers first.
//!
//! All logging goes to stderr. `signer/index.ts` splits it across stdout and
//! stderr the way `console.log`/`console.error` do, but this process emits no
//! data on stdout at all, and keeping the log on one stream is what makes the
//! password prompt — also stderr — appear in the right place relative to it.

use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;
use std::{fs, path::PathBuf, thread};

use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use signer_core::config::{PolicyConfig, SignerConfig};
use signer_core::PolicyEngine;

/// Logs a lifecycle or per-request event.
macro_rules! info {
    ($($arg:tt)*) => { eprintln!("[Signer:INFO] {}", format_args!($($arg)*)) };
}

/// Logs something recoverable: a rejected request, a dropped connection.
macro_rules! warn {
    ($($arg:tt)*) => { eprintln!("[Signer:WARN] {}", format_args!($($arg)*)) };
}

/// Logs a failure that stops the daemon.
macro_rules! error {
    ($($arg:tt)*) => { eprintln!("[Signer:ERROR] {}", format_args!($($arg)*)) };
}

mod key_load;
mod rpc_client;
mod server;
mod unlock;

/// `.env` files to load, in the order the TypeScript signer loads them
/// (`signer/config.ts:5-6`): the signer's own file first, project root second.
///
/// `dotenvy` never overwrites a variable that is already set, so the first file
/// to define a key wins — same precedence as `dotenv` in Node.
const ENV_FILES: [&str; 2] = [".env", "../.env"];

fn main() -> ExitCode {
    load_env_files();

    let config = match SignerConfig::from_env() {
        Ok(config) => config,
        Err(err) => {
            error!("{err}");
            return ExitCode::FAILURE;
        }
    };

    let keyfile = key_load::keyfile_path();
    info!("Keyfile: {}", keyfile.display());

    // Read here rather than inside the unlock routes so the decision is made
    // once, before any of them can consume stdin. Under systemd stdin is
    // `/dev/null` or a socket, never a terminal, which is exactly the signal
    // `signer/index.ts:167` uses to decide there is nobody to prompt.
    let mode = unlock::UnlockMode::select(config.unlock_port, std::io::stdin().is_terminal());
    match mode {
        unlock::UnlockMode::Web(_) => info!("Unlock mode: browser only (no TTY)"),
        unlock::UnlockMode::Race(_) => info!("Unlock mode: browser + stdin"),
        unlock::UnlockMode::Stdin => {}
    }

    let keypair = match key_load::unlock(&keyfile, mode) {
        Ok(keypair) => keypair,
        Err(err) => {
            error!("{err}");
            return ExitCode::FAILURE;
        }
    };

    let listener = match server::bind(&config.socket_path) {
        Ok(listener) => listener,
        Err(err) => {
            error!("{err}");
            return ExitCode::FAILURE;
        }
    };

    install_signal_handlers(config.socket_path.clone());
    print_banner(&config, &keypair);

    // Built here rather than inside `serve` so the RPC endpoint and the
    // allowlists are read from configuration exactly once, at startup, and a
    // connection thread has no way to reach the environment.
    let signer = Arc::new(server::Signer::new(
        keypair,
        PolicyEngine::new(PolicyConfig::from(&config)),
        Box::new(rpc_client::HttpRpc::new(&config.rpc_url)),
    ));

    server::serve(&listener, &signer);
    ExitCode::SUCCESS
}

/// Load each `.env` file if present; a missing file is not an error.
fn load_env_files() {
    for path in ENV_FILES {
        match dotenvy::from_filename(path) {
            Ok(_) => info!("Loaded env file: {path}"),
            Err(err) if err.not_found() => {}
            Err(err) => warn!("Could not read {path}: {err}"),
        }
    }
}

/// Unlink the socket and exit cleanly on `SIGINT` or `SIGTERM`.
///
/// `signal_hook`'s iterator hands the signal to an ordinary thread rather than
/// running this inside the handler, which matters: `remove_file` and `exit` are
/// both things a real signal handler is not allowed to do. Leaving the socket
/// behind would not be fatal — the next start unlinks it — but it would make
/// `manage.sh signer-status` report a signer that is not there.
fn install_signal_handlers(socket_path: PathBuf) {
    let mut signals = match Signals::new([SIGINT, SIGTERM]) {
        Ok(signals) => signals,
        Err(err) => {
            warn!("Could not install signal handlers: {err}");
            return;
        }
    };

    thread::spawn(move || {
        if let Some(signal) = signals.forever().next() {
            info!("Received signal {signal}, shutting down...");
            if let Err(err) = fs::remove_file(&socket_path) {
                warn!("Could not remove {}: {err}", socket_path.display());
            }
            std::process::exit(0);
        }
    });
}

fn print_banner(config: &SignerConfig, keypair: &Arc<solana_sdk::signer::keypair::Keypair>) {
    let policy = PolicyConfig::from(config);

    info!("Byreal signer (Rust) v{}", env!("CARGO_PKG_VERSION"));
    info!("Wallet: {}", key_load::address(keypair));
    info!("Listening on {}", config.socket_path.display());
    info!("RPC: {}", redact_url(&config.rpc_url));
    info!("Log level: {}", config.log_level);
    info!("Byreal program: {}", config.byreal_program_id);
    info!(
        "Program allowlist: {} programs ({} DEX)",
        policy.program_allowlist.len(),
        policy.dex_programs.len()
    );
    info!(
        "Destination whitelist: {} addresses",
        policy.destination_whitelist.len()
    );
    if policy.destination_whitelist.is_empty() {
        // Not a misconfiguration: with no whitelist the only standalone SPL
        // transfers that clear the policy are the ones whose destination the
        // chain vouches for. Worth saying out loud, because an operator who
        // meant to configure the daily auto-convert target and did not will
        // otherwise find out when the transfer is refused.
        warn!("No destination whitelist — standalone SPL transfers will be refused.");
    }
}

/// Strip credentials from an RPC URL before logging it.
///
/// Helius and friends carry the API key in the query string or path, so the
/// full URL must never reach a log file. Everything from the first `?` is
/// dropped and the path is replaced with `/…` when non-empty.
fn redact_url(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    match without_query.split_once("://") {
        None => without_query.to_owned(),
        Some((scheme, rest)) => {
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            let host = host.rsplit('@').next().unwrap_or(host);
            if path.is_empty() {
                format!("{scheme}://{host}")
            } else {
                format!("{scheme}://{host}/…")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::redact_url;

    #[test]
    fn redact_url_drops_api_keys_and_paths() {
        assert_eq!(
            redact_url("https://mainnet.helius-rpc.com/?api-key=secret"),
            "https://mainnet.helius-rpc.com"
        );
        assert_eq!(
            redact_url("https://rpc.example.com/v1/secret-token"),
            "https://rpc.example.com/…"
        );
        assert_eq!(redact_url("http://localhost:8899"), "http://localhost:8899");
        assert_eq!(
            redact_url("https://user:pass@rpc.example.com/path"),
            "https://rpc.example.com/…"
        );
        assert_eq!(redact_url("not-a-url"), "not-a-url");
    }
}
