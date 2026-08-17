//! Error taxonomy for the signer.
//!
//! Variants and messages are ported from the strings the TypeScript signer
//! throws or returns on the wire, so a bot talking to either implementation
//! sees the same `error` field. These enums are intentionally small — later
//! milestones (socket protocol, policy engine, ALT resolution) add variants.

use solana_sdk::pubkey::Pubkey;

/// Startup configuration failures (`signer/config.ts`).
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// A required environment variable was unset or empty.
    #[error("Signer: missing required env var: {0}")]
    MissingEnv(&'static str),

    /// An environment variable was set but could not be parsed.
    #[error("Signer: invalid {var}: {value} ({reason})")]
    InvalidValue {
        /// Name of the offending environment variable.
        var: &'static str,
        /// The value as provided by the environment.
        value: String,
        /// Why parsing failed.
        reason: String,
    },
}

/// Request/response protocol errors on the Unix socket (`signer/index.ts`).
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// A frame's length prefix exceeded [`crate::protocol::MAX_FRAME_LEN`].
    ///
    /// The TypeScript signer has no such cap — it trusts the declared length and
    /// buffers until that many bytes arrive, so a single 4-byte write can pin
    /// gigabytes. The limit lives in the wire format here instead.
    #[error("Frame too large: {len} bytes exceeds the {limit}-byte limit")]
    FrameTooLarge {
        /// Length declared by the 4-byte big-endian header.
        len: u32,
        /// The cap that was exceeded.
        limit: u32,
    },

    /// The stream ended part-way through a length prefix or a payload.
    #[error("Truncated frame: expected {expected} bytes, got {actual} before end of stream")]
    Truncated {
        /// Bytes the header promised (or 4, for a partial header).
        expected: usize,
        /// Bytes actually read before EOF.
        actual: usize,
    },

    /// The socket failed while a frame was being read.
    #[error("Socket read failed: {0}")]
    Io(#[from] std::io::Error),

    /// The request body was not valid JSON.
    #[error("Invalid request: malformed JSON: {0}")]
    Json(String),

    /// The request was missing the `type` or `tx` field.
    #[error("Invalid request: missing type or tx")]
    MissingField,

    /// `type` was something other than `versioned` or `legacy`.
    #[error("Invalid type: {0}")]
    InvalidType(String),

    /// The `tx` field was not valid base64.
    #[error("Invalid request: tx is not valid base64")]
    InvalidBase64,

    /// Catch-all for a panic or unexpected failure while handling a request.
    #[error("Internal signer error")]
    Internal,
}

/// Keyfile encryption/decryption failures (`signer/crypto.ts`).
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    /// AES-GCM authentication failed — almost always a wrong password.
    #[error("Wrong password")]
    WrongPassword,

    /// The encrypted keyfile does not exist.
    #[error("Encrypted keyfile not found: {0}")]
    KeyfileNotFound(String),

    /// The keyfile exists but its JSON or hex fields are unreadable.
    #[error("Encrypted keyfile is malformed: {0}")]
    MalformedKeyfile(String),

    /// A base58 string is not a valid ed25519 secret key (`signer/setup.ts:44`).
    #[error("Invalid private key: {0}")]
    InvalidSecretKey(String),

    /// AES-GCM refused to encrypt the key material. Only reachable for a
    /// plaintext larger than GCM's 64 GiB message limit.
    #[error("Failed to encrypt private key")]
    EncryptFailed,

    /// The keyfile could not be rendered as JSON.
    #[error("Failed to serialize keyfile: {0}")]
    Serialize(String),
}

/// Policy rejections (`signer/policy.ts`). Every variant means "do not sign".
#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    /// A top-level instruction targets a program outside the allowlist.
    #[error("Unknown program: {0}")]
    UnknownProgram(Pubkey),

    /// Address lookup tables referenced by a v0 transaction could not be resolved.
    #[error("ALT resolution failed: {0}")]
    AltResolutionFailed(String),

    /// SPL `SetAuthority` is never allowed — it can hand the wallet away.
    #[error("SPL SetAuthority is blocked — potential authority hijack")]
    SetAuthorityBlocked,

    /// Simulation logs revealed a CPI into a program outside the allowlist.
    #[error("Simulation revealed unknown invoked program: {0}")]
    UnknownInvokedProgram(Pubkey),

    /// A bare SPL transfer (no DEX instruction alongside it) to an unknown address.
    #[error("Standalone SPL transfer to non-whitelisted address: {0}")]
    NonWhitelistedTransfer(Pubkey),
}

/// Transaction decoding failures (`signer/policy.ts`, `signer/alt-resolver.ts`).
#[derive(Debug, thiserror::Error)]
pub enum TxError {
    /// The bytes did not decode as a versioned (v0) transaction.
    #[error("Failed to deserialize versioned transaction: {0}")]
    DeserializeVersioned(String),

    /// The bytes did not decode as a legacy transaction.
    #[error("Failed to deserialize legacy transaction: {0}")]
    DeserializeLegacy(String),

    /// A lookup table referenced by the transaction is not on-chain.
    #[error("ALT account not found: {0}")]
    AltAccountNotFound(Pubkey),
}
