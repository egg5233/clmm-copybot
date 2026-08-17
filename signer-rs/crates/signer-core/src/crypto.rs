//! Keyfile encryption, byte-compatible with `signer/crypto.ts`.
//!
//! Keyfiles written by the TypeScript signer must decrypt here and vice versa,
//! so every parameter below is pinned to what Node's `crypto` module does in
//! `signer/crypto.ts`:
//!
//! * `scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })` — the password
//!   is hashed as raw UTF-8 bytes, the salt is the 32 random bytes stored in the
//!   keyfile, and `N = 16384` is `log_n = 14` in the `scrypt` crate's [`Params`].
//! * `aes-256-gcm` with a **16-byte IV**. Node allows any IV length for GCM;
//!   the TypeScript signer picked 16, so this port cannot use the stock
//!   [`aes_gcm::Aes256Gcm`] alias (12-byte nonce) and instantiates
//!   [`Aes256Gcm16`] instead. For a nonce that is not 96 bits, GCM derives its
//!   initial counter block by running the IV through GHASH (NIST SP 800-38D
//!   §7.1); both OpenSSL — hence Node — and the `aes-gcm` crate implement that
//!   path, which is what makes the two sides interoperate.
//! * The 16-byte auth tag is stored separately from the ciphertext (Node's
//!   `cipher.getAuthTag()`), so the detached AEAD API is the exact match.
//!
//! [`decrypt_key`] collapses every authentication failure into
//! [`CryptoError::WrongPassword`]. A caller — and anyone watching the unlock
//! endpoint — cannot tell a mistyped password from a tampered keyfile.
//!
//! One caveat on hygiene: derived keys live in [`Zeroizing`] buffers and the
//! plaintext is wiped on drop, but the AES key schedule inside the `aes` crate
//! is not zeroized (its `zeroize` feature is off), so the expanded round keys
//! outlive a cipher value.

use aes_gcm::aead::consts::U16;
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{AeadInPlace, KeyInit, OsRng};
use aes_gcm::aes::Aes256;
use aes_gcm::{AesGcm, Nonce, Tag};
use scrypt::Params;
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::keypair::Keypair;
use solana_sdk::signer::Signer;

use crate::error::CryptoError;

// Re-exported because they appear in the signatures below: callers (the setup
// tool, the daemon's unlock path) then cannot accidentally pass the types from
// a mismatched version of either crate.
pub use secrecy::SecretString;
pub use zeroize::Zeroizing;

/// AES-256-GCM with the 16-byte IV the TypeScript signer writes.
type Aes256Gcm16 = AesGcm<Aes256, U16>;

/// scrypt cost parameter as the `scrypt` crate wants it: `N = 2^14 = 16384`.
pub const SCRYPT_LOG_N: u8 = 14;
/// scrypt cost parameter as `signer/crypto.ts` spells it (`SCRYPT_N`).
pub const SCRYPT_N: u32 = 1 << SCRYPT_LOG_N;
/// scrypt block-size parameter.
pub const SCRYPT_R: u32 = 8;
/// scrypt parallelism parameter.
pub const SCRYPT_P: u32 = 1;
/// Derived-key length in bytes (AES-256).
pub const KEY_LEN: usize = 32;
/// Length of the random per-keyfile scrypt salt, in bytes.
pub const SALT_LEN: usize = 32;
/// Length of the random per-keyfile GCM IV, in bytes.
pub const IV_LEN: usize = 16;
/// Length of the GCM authentication tag, in bytes.
pub const TAG_LEN: usize = 16;

/// The on-disk `keyfile.enc.json`, field for field.
///
/// Every field is lowercase hex, matching `Buffer.toString('hex')`. Serializing
/// this struct reproduces the key order `signer/setup.ts` writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedKeyfile {
    /// scrypt salt, [`SALT_LEN`] bytes as hex.
    pub salt: String,
    /// AES-GCM IV, [`IV_LEN`] bytes as hex.
    pub iv: String,
    /// AES-GCM authentication tag, [`TAG_LEN`] bytes as hex.
    pub tag: String,
    /// Ciphertext of the base58 private key, as hex.
    pub data: String,
}

impl EncryptedKeyfile {
    /// Parse the JSON written by `signer/setup.ts`.
    ///
    /// # Errors
    /// [`CryptoError::MalformedKeyfile`] if the text is not JSON or is missing a
    /// field.
    pub fn from_json(json: &str) -> Result<Self, CryptoError> {
        serde_json::from_str(json).map_err(|err| CryptoError::MalformedKeyfile(err.to_string()))
    }

    /// Render the keyfile the way `setup.ts` writes it:
    /// `JSON.stringify(encrypted, null, 2)`, i.e. two-space indentation.
    ///
    /// # Errors
    /// [`CryptoError::Serialize`] if `serde_json` fails, which four owned
    /// `String`s cannot provoke in practice.
    pub fn to_json_pretty(&self) -> Result<String, CryptoError> {
        serde_json::to_string_pretty(self).map_err(|err| CryptoError::Serialize(err.to_string()))
    }
}

/// Decrypt a keyfile into the base58 private key it holds.
///
/// # Errors
/// [`CryptoError::MalformedKeyfile`] if a hex field does not decode or the IV or
/// tag is the wrong length — neither depends on the password.
/// [`CryptoError::WrongPassword`] for every other failure, so a wrong password
/// and a tampered keyfile are indistinguishable to the caller.
pub fn decrypt_key(
    file: &EncryptedKeyfile,
    password: &SecretString,
) -> Result<Zeroizing<String>, CryptoError> {
    // Salt length is deliberately unchecked: Node's scrypt accepts any salt, so
    // rejecting a non-32-byte one here could lock an operator out of a keyfile
    // the TypeScript signer still reads.
    let salt = decode_hex(&file.salt, "salt")?;
    let iv = decode_hex_array::<IV_LEN>(&file.iv, "iv")?;
    let tag = decode_hex_array::<TAG_LEN>(&file.tag, "tag")?;
    let mut buffer = Zeroizing::new(decode_hex(&file.data, "data")?);

    // GCM is CTR mode underneath, so a failed decrypt still fills `buffer` with
    // unauthenticated garbage; `Zeroizing` wipes it on the way out.
    derive_cipher(password, &salt)
        .decrypt_in_place_detached(
            Nonce::<U16>::from_slice(&iv),
            &[],
            buffer.as_mut_slice(),
            Tag::<U16>::from_slice(&tag),
        )
        .map_err(|_| CryptoError::WrongPassword)?;

    // Authenticated bytes that are not UTF-8 mean a corrupt keyfile rather than
    // a bad password, but reporting that would confirm the password was right.
    let plaintext = std::str::from_utf8(&buffer).map_err(|_| CryptoError::WrongPassword)?;
    Ok(Zeroizing::new(plaintext.to_owned()))
}

/// Encrypt a base58 private key under `password`, drawing a fresh salt and IV.
///
/// # Errors
/// [`CryptoError::EncryptFailed`] if AES-GCM rejects the plaintext length.
pub fn encrypt_key(
    key_b58: &Zeroizing<String>,
    password: &SecretString,
) -> Result<EncryptedKeyfile, CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    let mut iv = [0u8; IV_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut iv);

    let mut buffer = Zeroizing::new(key_b58.as_bytes().to_vec());
    let tag = derive_cipher(password, &salt)
        .encrypt_in_place_detached(Nonce::<U16>::from_slice(&iv), &[], buffer.as_mut_slice())
        .map_err(|_| CryptoError::EncryptFailed)?;

    Ok(EncryptedKeyfile {
        salt: hex::encode(salt),
        iv: hex::encode(iv),
        tag: hex::encode(tag),
        data: hex::encode(&*buffer),
    })
}

/// The wallet address a base58 private key belongs to.
///
/// Mirrors the `Keypair.fromSecretKey(bs58.decode(key))` validation in
/// `signer/setup.ts`, which is how the setup tool rejects a mistyped key before
/// encrypting it.
///
/// # Errors
/// [`CryptoError::InvalidSecretKey`] if the string is not base58 or the bytes
/// are not a 64-byte ed25519 keypair.
pub fn pubkey_of(key_b58: &Zeroizing<String>) -> Result<Pubkey, CryptoError> {
    let bytes = Zeroizing::new(
        bs58::decode(key_b58.as_str())
            .into_vec()
            .map_err(|err| CryptoError::InvalidSecretKey(err.to_string()))?,
    );
    let keypair = Keypair::try_from(&bytes[..])
        .map_err(|err| CryptoError::InvalidSecretKey(err.to_string()))?;
    Ok(keypair.pubkey())
}

/// Build the AES-256-GCM cipher for `password` and `salt`.
///
/// Both `expect`s are unreachable: the parameters are compile-time constants and
/// scrypt is asked for exactly [`KEY_LEN`] bytes.
fn derive_cipher(password: &SecretString, salt: &[u8]) -> Aes256Gcm16 {
    let params = Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN)
        .expect("scrypt parameters are compile-time constants");

    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    scrypt::scrypt(
        password.expose_secret().as_bytes(),
        salt,
        &params,
        key.as_mut_slice(),
    )
    .expect("scrypt output length equals KEY_LEN");

    Aes256Gcm16::new_from_slice(key.as_slice()).expect("KEY_LEN is the AES-256 key length")
}

/// Decode a hex keyfile field, naming it in the error.
fn decode_hex(field: &str, name: &'static str) -> Result<Vec<u8>, CryptoError> {
    hex::decode(field).map_err(|err| CryptoError::MalformedKeyfile(format!("{name}: {err}")))
}

/// Decode a hex keyfile field that must be exactly `N` bytes.
fn decode_hex_array<const N: usize>(
    field: &str,
    name: &'static str,
) -> Result<[u8; N], CryptoError> {
    let bytes = decode_hex(field, name)?;
    <[u8; N]>::try_from(bytes.as_slice()).map_err(|_| {
        CryptoError::MalformedKeyfile(format!("{name}: expected {N} bytes, got {}", bytes.len()))
    })
}
