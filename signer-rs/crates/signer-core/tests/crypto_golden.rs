//! Golden vectors for the keyfile format, produced by the real TypeScript
//! implementation (`signer/crypto.ts`) via `fixtures-gen/gen-crypto-vectors.ts`.
//!
//! Decrypting these byte-for-byte is the proof that the Rust signer can open
//! keyfiles already sitting on disk in production. The reverse direction —
//! TypeScript reading a Rust-written keyfile — is covered by
//! `typescript_decrypts_rust_keyfile`, which needs Node and is `#[ignore]`d.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use secrecy::SecretString;
use serde::Deserialize;
use signer_core::crypto::{
    self, EncryptedKeyfile, IV_LEN, KEY_LEN, SALT_LEN, SCRYPT_N, SCRYPT_P, SCRYPT_R, TAG_LEN,
};
use signer_core::error::CryptoError;
use solana_sdk::signer::keypair::Keypair;
use solana_sdk::signer::Signer;
use zeroize::Zeroizing;

const VECTORS_JSON: &str = include_str!("fixtures/crypto_vectors.json");

#[derive(Deserialize)]
struct Fixture {
    params: FixtureParams,
    vectors: Vec<Vector>,
}

/// The constants `signer/crypto.ts` was built with, recorded by the generator.
#[derive(Deserialize)]
struct FixtureParams {
    algorithm: String,
    kdf: String,
    scrypt_n: u32,
    scrypt_r: u32,
    scrypt_p: u32,
    key_len: usize,
    salt_len: usize,
    iv_len: usize,
    tag_len: usize,
    plaintext_encoding: String,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    keyfile: EncryptedKeyfile,
    password: String,
    expect: String,
    #[serde(default)]
    expected_plaintext_base58: Option<String>,
    #[serde(default)]
    expected_pubkey: Option<String>,
}

fn fixture() -> Fixture {
    serde_json::from_str(VECTORS_JSON).expect("crypto_vectors.json parses")
}

fn vector(name: &str) -> Vector {
    fixture()
        .vectors
        .into_iter()
        .find(|vector| vector.name == name)
        .unwrap_or_else(|| panic!("fixture has no vector named {name}"))
}

fn secret(password: &str) -> SecretString {
    SecretString::from(password.to_owned())
}

/// The base58 secret key the fixtures encrypt — a throwaway seed-`0x42` keypair.
fn fixture_plaintext() -> Zeroizing<String> {
    Zeroizing::new(
        vector("valid")
            .expected_plaintext_base58
            .expect("the valid vector records its plaintext"),
    )
}

/// The parameters baked into `crypto.rs` must be the ones the TypeScript signer
/// used, or the vectors below would only prove self-consistency.
#[test]
fn implementation_parameters_match_the_typescript_signer() {
    let params = fixture().params;

    assert_eq!(params.algorithm, "aes-256-gcm");
    assert_eq!(params.kdf, "scrypt");
    assert_eq!(params.plaintext_encoding, "utf-8");
    assert_eq!(params.scrypt_n, SCRYPT_N);
    assert_eq!(params.scrypt_r, SCRYPT_R);
    assert_eq!(params.scrypt_p, SCRYPT_P);
    assert_eq!(params.key_len, KEY_LEN);
    assert_eq!(params.salt_len, SALT_LEN);
    assert_eq!(params.iv_len, IV_LEN);
    assert_eq!(params.tag_len, TAG_LEN);
}

#[test]
fn valid_vector_decrypts_to_the_expected_key_and_pubkey() {
    let vector = vector("valid");
    assert_eq!(vector.expect, "ok");
    let expected_plaintext = vector
        .expected_plaintext_base58
        .expect("the valid vector records its plaintext");
    let expected_pubkey = vector
        .expected_pubkey
        .expect("the valid vector records its pubkey");

    let plaintext = crypto::decrypt_key(&vector.keyfile, &secret(&vector.password))
        .expect("the correct password opens the keyfile");
    assert_eq!(*plaintext, expected_plaintext);

    // Independently of `crypto::pubkey_of`, the plaintext must be a usable key.
    let bytes = bs58::decode(plaintext.as_str())
        .into_vec()
        .expect("plaintext is base58");
    let keypair = Keypair::try_from(&bytes[..]).expect("plaintext is an ed25519 keypair");
    assert_eq!(keypair.pubkey().to_string(), expected_pubkey);

    let derived = crypto::pubkey_of(&plaintext).expect("pubkey_of accepts the plaintext");
    assert_eq!(derived.to_string(), expected_pubkey);
}

/// A wrong password and a flipped auth-tag byte must be one indistinguishable
/// failure. Anything else turns the unlock endpoint into a password oracle.
#[test]
fn wrong_password_and_tampered_tag_fail_identically() {
    let wrong_password = vector("wrong_password");
    let tampered_tag = vector("tampered_tag");
    assert_eq!(wrong_password.expect, "error");
    assert_eq!(tampered_tag.expect, "error");
    // The tampered vector uses the *correct* password, so only the tag differs.
    assert_eq!(tampered_tag.password, vector("valid").password);

    let wrong_password_err =
        crypto::decrypt_key(&wrong_password.keyfile, &secret(&wrong_password.password))
            .expect_err("a wrong password must not decrypt");
    let tampered_tag_err =
        crypto::decrypt_key(&tampered_tag.keyfile, &secret(&tampered_tag.password))
            .expect_err("a tampered tag must not decrypt");

    assert!(matches!(wrong_password_err, CryptoError::WrongPassword));
    assert!(matches!(tampered_tag_err, CryptoError::WrongPassword));
    assert_eq!(
        std::mem::discriminant(&wrong_password_err),
        std::mem::discriminant(&tampered_tag_err)
    );
    assert_eq!(wrong_password_err.to_string(), tampered_tag_err.to_string());
    // The TypeScript signer throws `new Error('Wrong password')` for both.
    assert_eq!(wrong_password_err.to_string(), "Wrong password");
}

#[test]
fn encrypt_key_round_trips() {
    let key = Zeroizing::new(bs58::encode(Keypair::new().to_bytes()).into_string());
    let password = secret("hunter2 with spaces and ünicöde");

    let keyfile = crypto::encrypt_key(&key, &password).expect("encryption succeeds");
    assert_eq!(
        hex::decode(&keyfile.salt).expect("hex salt").len(),
        SALT_LEN
    );
    assert_eq!(hex::decode(&keyfile.iv).expect("hex iv").len(), IV_LEN);
    assert_eq!(hex::decode(&keyfile.tag).expect("hex tag").len(), TAG_LEN);

    let plaintext = crypto::decrypt_key(&keyfile, &password).expect("round trip decrypts");
    assert_eq!(*plaintext, *key);

    let wrong = crypto::decrypt_key(&keyfile, &secret("hunter3"))
        .expect_err("a wrong password must not decrypt");
    assert!(matches!(wrong, CryptoError::WrongPassword));
}

/// Salt and IV are drawn per call, so two keyfiles for the same key and password
/// must never collide — reusing an IV under one derived key would break GCM.
#[test]
fn each_encryption_draws_fresh_salt_and_iv() {
    let key = fixture_plaintext();
    let password = secret("same-password");

    let first = crypto::encrypt_key(&key, &password).expect("first encryption");
    let second = crypto::encrypt_key(&key, &password).expect("second encryption");

    assert_ne!(first.salt, second.salt);
    assert_ne!(first.iv, second.iv);
    assert_ne!(first.data, second.data);
}

/// Structural damage is reported as malformed rather than as a wrong password:
/// it is independent of the password, so distinguishing it leaks nothing.
#[test]
fn structural_damage_is_reported_as_malformed() {
    let valid = vector("valid");

    let bad_hex = EncryptedKeyfile {
        data: "not hex".to_owned(),
        ..valid.keyfile.clone()
    };
    let short_iv = EncryptedKeyfile {
        iv: "abcd".to_owned(),
        ..valid.keyfile.clone()
    };

    for keyfile in [&bad_hex, &short_iv] {
        let err = crypto::decrypt_key(keyfile, &secret(&valid.password))
            .expect_err("a malformed keyfile must not decrypt");
        assert!(matches!(err, CryptoError::MalformedKeyfile(_)), "{err}");
    }
}

/// `setup.ts` writes `JSON.stringify(encrypted, null, 2)`; the Rust setup tool
/// has to produce the same shape, field order included.
#[test]
fn keyfile_json_matches_the_setup_ts_layout() {
    let keyfile = vector("valid").keyfile;
    let json = keyfile.to_json_pretty().expect("keyfile serializes");

    let expected = format!(
        "{{\n  \"salt\": \"{}\",\n  \"iv\": \"{}\",\n  \"tag\": \"{}\",\n  \"data\": \"{}\"\n}}",
        keyfile.salt, keyfile.iv, keyfile.tag, keyfile.data
    );
    assert_eq!(json, expected);

    let reparsed = EncryptedKeyfile::from_json(&json).expect("round trips through JSON");
    assert_eq!(reparsed.salt, keyfile.salt);
    assert_eq!(reparsed.data, keyfile.data);
}

#[test]
fn pubkey_of_rejects_a_key_that_is_not_a_keypair() {
    let not_base58 = Zeroizing::new("0OIl-not-base58".to_owned());
    let too_short = Zeroizing::new(bs58::encode([7u8; 16]).into_string());

    for key in [&not_base58, &too_short] {
        let err = crypto::pubkey_of(key).expect_err("invalid key must be rejected");
        assert!(matches!(err, CryptoError::InvalidSecretKey(_)), "{err}");
    }
}

// ── Differential test ────────────────────────────────────────────────────────

/// The other direction: a keyfile written by [`crypto::encrypt_key`] must open
/// in `signer/crypto.ts`. Requires Node plus the repo's `node_modules`, so it is
/// `#[ignore]`d and CI runs only the vector-driven tests above.
///
/// Run with `cargo test -p signer-core -- --ignored`.
#[test]
#[ignore = "needs Node and the repo's node_modules"]
fn typescript_decrypts_rust_keyfile() {
    const PASSWORD: &str = "differential-test-password";

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let crypto_module = repo_root.join("signer/crypto.ts");
    assert!(
        crypto_module.exists(),
        "expected the TypeScript signer at {}",
        crypto_module.display()
    );

    let key = fixture_plaintext();
    let keyfile = crypto::encrypt_key(&key, &secret(PASSWORD)).expect("encryption succeeds");

    let dir = scratch_dir("ts-differential");
    fs::create_dir_all(&dir).expect("scratch dir is creatable");
    let keyfile_path = dir.join("keyfile.enc.json");
    fs::write(
        &keyfile_path,
        keyfile.to_json_pretty().expect("keyfile serializes"),
    )
    .expect("keyfile is writable");

    // Paths and the password travel in the environment so no shell quoting is
    // involved and the password never reaches a process listing.
    let script = "const fs = require('fs');\
         const { decryptKey } = require(process.env.CRYPTO_MODULE);\
         const keyfile = JSON.parse(fs.readFileSync(process.env.KEYFILE_PATH, 'utf-8'));\
         process.stdout.write(decryptKey(keyfile, process.env.KEYFILE_PASSWORD));";

    let output = Command::new("npx")
        .args(["ts-node", "-T", "-e", script])
        .current_dir(&repo_root)
        .env("CRYPTO_MODULE", &crypto_module)
        .env("KEYFILE_PATH", &keyfile_path)
        .env("KEYFILE_PASSWORD", PASSWORD)
        .output()
        .expect("npx ts-node runs");

    fs::remove_dir_all(&dir).ok();

    assert!(
        output.status.success(),
        "ts-node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        key.as_str(),
        "TypeScript decrypted a different key"
    );
}

/// A unique directory under the system temp dir. Avoids a `tempfile`
/// dev-dependency for the single test that needs a file on disk.
fn scratch_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    std::env::temp_dir().join(format!("signer-rs-{label}-{}-{nanos}", std::process::id()))
}
