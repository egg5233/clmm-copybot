//! Finding the encrypted keyfile and unlocking it into an in-memory keypair.
//!
//! Port of `init()` in `signer/index.ts:156-204`, minus the browser unlock page.
//! The TypeScript signer offers three unlock routes — stdin only, browser only
//! (systemd, where there is no TTY), or a race between the two — and this
//! milestone implements the first. The localhost unlock page is M6; until it
//! lands the daemon always reads the password from stdin, whatever
//! `SIGNER_UNLOCK_PORT` says.
//!
//! The password and the decrypted key never leave [`Zeroizing`] buffers, and the
//! only thing that outlives this module is the [`Keypair`] itself.

use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use signer_core::crypto::{self, EncryptedKeyfile, SecretString, Zeroizing};
use solana_sdk::signer::keypair::Keypair;
use solana_sdk::signer::Signer as _;

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

/// Reads the keyfile, prompts for the password, and returns the signing keypair.
///
/// # Errors
///
/// A human-readable message, already phrased for an operator staring at a
/// terminal: a missing keyfile names the path and the tool that creates one, and
/// a wrong password says only "Wrong password" — the same single failure mode
/// [`crypto::decrypt_key`] reports for a tampered file, so neither the operator
/// nor anyone reading the logs learns which it was.
pub fn unlock(path: &Path) -> Result<Arc<Keypair>, String> {
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
    let keyfile = EncryptedKeyfile::from_json(&json).map_err(|err| err.to_string())?;

    let password = prompt_password("Enter password to unlock signer: ")?;
    let key_b58 = crypto::decrypt_key(&keyfile, &SecretString::from(password.to_string()))
        .map_err(|err| err.to_string())?;

    keypair_from_base58(&key_b58).map(Arc::new)
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
