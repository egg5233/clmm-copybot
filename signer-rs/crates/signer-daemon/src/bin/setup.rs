//! One-time setup: encrypt the signer's private key with a password.
//!
//! Port of `signer/setup.ts`. Prompts for a base58 private key and a password,
//! verifies the key really is an ed25519 keypair, and writes the encrypted
//! keyfile that the daemon later unlocks. The plaintext key is never written to
//! disk and never echoed to the terminal — `setup.ts` reads it through
//! `readline`, which leaves it visible on screen and in the scrollback.
//!
//! Run: `cargo run -p signer-daemon --bin setup`

use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, BufRead, IsTerminal, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::process::ExitCode;

use signer_core::crypto::{self, SecretString, Zeroizing};

/// Where the keyfile lands when `SIGNER_KEYFILE_PATH` is unset.
const DEFAULT_KEYFILE: &str = "keyfile.enc.json";

/// Overrides [`DEFAULT_KEYFILE`].
const ENV_KEYFILE_PATH: &str = "SIGNER_KEYFILE_PATH";

/// Owner-only, like every other secret this signer touches.
const KEYFILE_MODE: u32 = 0o600;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let keyfile_path = keyfile_path();

    if keyfile_path.exists() {
        let answer = prompt_line(&format!(
            "{} already exists. Overwrite? (y/N): ",
            keyfile_path.display()
        ))?;
        if !answer.trim().eq_ignore_ascii_case("y") {
            println!("Aborted.");
            return Ok(());
        }
    }

    let key = prompt_hidden("Enter private key (base58): ")?;
    if key.is_empty() {
        return Err("No key provided.".to_owned());
    }

    // Reject a mistyped key here rather than at unlock time, when the operator
    // no longer has the plaintext to compare against.
    let pubkey = crypto::pubkey_of(&key).map_err(|err| err.to_string())?;
    println!("Wallet: {pubkey}");

    let password = prompt_hidden("Set password: ")?;
    if password.is_empty() {
        return Err("No password provided.".to_owned());
    }
    let confirm = prompt_hidden("Confirm password: ")?;
    if *password != *confirm {
        return Err("Passwords do not match.".to_owned());
    }

    let keyfile = crypto::encrypt_key(&key, &SecretString::from(password.to_string()))
        .map_err(|err| err.to_string())?;
    let json = keyfile.to_json_pretty().map_err(|err| err.to_string())?;
    write_keyfile(&keyfile_path, &json)?;

    println!("Encrypted key saved to {}", keyfile_path.display());
    println!("You can now delete any plaintext key files.");
    Ok(())
}

fn keyfile_path() -> PathBuf {
    match std::env::var_os(ENV_KEYFILE_PATH) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(DEFAULT_KEYFILE),
    }
}

/// Write the keyfile so it is never briefly readable by anyone else: the mode is
/// set at creation, and reset afterwards in case the file already existed with
/// looser permissions.
fn write_keyfile(path: &PathBuf, json: &str) -> Result<(), String> {
    let mut file: File = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(KEYFILE_MODE)
        .open(path)
        .map_err(|err| format!("Could not write {}: {err}", path.display()))?;

    file.write_all(json.as_bytes())
        .map_err(|err| format!("Could not write {}: {err}", path.display()))?;

    fs::set_permissions(path, Permissions::from_mode(KEYFILE_MODE))
        .map_err(|err| format!("Could not set permissions on {}: {err}", path.display()))
}

/// Read a secret without echoing it.
///
/// Falls back to a plain read when stdin is not a terminal, so the tool stays
/// scriptable — `setup.ts` documents itself as reading from stdin, and hiding
/// input requires a TTY to switch off.
fn prompt_hidden(prompt: &str) -> Result<Zeroizing<String>, String> {
    let raw = if io::stdin().is_terminal() {
        Zeroizing::new(
            rpassword::prompt_password(prompt)
                .map_err(|err| format!("Could not read input: {err}"))?,
        )
    } else {
        Zeroizing::new(prompt_line(prompt)?)
    };
    Ok(Zeroizing::new(raw.trim().to_owned()))
}

/// Prompt on stderr — as `setup.ts` does — and read one echoed line.
fn prompt_line(prompt: &str) -> Result<String, String> {
    eprint!("{prompt}");
    io::stderr().flush().ok();

    let mut line = String::new();
    io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|err| format!("Could not read input: {err}"))?;
    Ok(line)
}
