//! Byreal signer daemon.
//!
//! M0 skeleton: loads the environment, builds [`SignerConfig`], prints a
//! startup summary and exits. The Unix socket server, keyfile unlock and policy
//! engine arrive in later milestones.

use std::process::ExitCode;

use signer_core::config::{PolicyConfig, SignerConfig};

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
            eprintln!("[Signer:ERROR] {err}");
            return ExitCode::FAILURE;
        }
    };

    print_startup_summary(&config);
    ExitCode::SUCCESS
}

/// Load each `.env` file if present; a missing file is not an error.
fn load_env_files() {
    for path in ENV_FILES {
        match dotenvy::from_filename(path) {
            Ok(_) => println!("[Signer:INFO] Loaded env file: {path}"),
            Err(err) if err.not_found() => {}
            Err(err) => eprintln!("[Signer:WARN] Could not read {path}: {err}"),
        }
    }
}

fn print_startup_summary(config: &SignerConfig) {
    let policy = PolicyConfig::from(config);

    println!(
        "[Signer:INFO] Byreal signer (Rust) v{}",
        env!("CARGO_PKG_VERSION")
    );
    println!("[Signer:INFO] RPC: {}", redact_url(&config.rpc_url));
    println!(
        "[Signer:INFO] Socket path: {}",
        config.socket_path.display()
    );
    if config.web_unlock_enabled() {
        println!(
            "[Signer:INFO] Unlock page: http://127.0.0.1:{}",
            config.unlock_port
        );
    } else {
        println!("[Signer:INFO] Unlock page: disabled (stdin only)");
    }
    println!("[Signer:INFO] Log level: {}", config.log_level);
    println!("[Signer:INFO] Byreal program: {}", config.byreal_program_id);
    println!(
        "[Signer:INFO] Program allowlist: {} programs ({} DEX)",
        policy.program_allowlist.len(),
        policy.dex_programs.len()
    );
    println!(
        "[Signer:INFO] Destination whitelist: {} addresses",
        policy.destination_whitelist.len()
    );
    println!("[Signer:INFO] M0 skeleton — no socket server yet, exiting.");
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
