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

    /// An instruction's program id index points outside the resolved account list.
    ///
    /// No TypeScript counterpart: `extractProgramIds` guards the lookup with
    /// `if (programId)` and the SPL loop with `?.`, so an out-of-range index makes
    /// the instruction vanish from *both* the allowlist check and the transfer
    /// check. The transaction could never execute — the runtime rejects such a
    /// message during sanitization — so refusing to sign it costs nothing and is
    /// the safer default for the one process holding the key.
    #[error("Instruction {instruction} references program id index {index}, which is outside the transaction's account list")]
    UnresolvableProgramId {
        /// Position of the offending instruction in the message.
        instruction: usize,
        /// The account index the instruction named.
        index: u16,
    },

    /// SPL `SetAuthority` is never allowed — it can hand the wallet away.
    #[error("SPL SetAuthority is blocked — potential authority hijack")]
    SetAuthorityBlocked,

    /// SPL `Approve` hands a delegate standing authority to move the account's
    /// tokens, so it is held to the same bar as a transfer to that address.
    ///
    /// New enforcement: `policy.ts:130-135` only logs the delegate and comments
    /// that unknown ones "should" be blocked. Nothing acts on it, which makes an
    /// approve a strictly cheaper way to drain the wallet than the transfer the
    /// same file does block.
    #[error("SPL Approve to non-whitelisted delegate: {0}")]
    ApproveToNonWhitelistedDelegate(Pubkey),

    /// Simulation logs revealed a CPI into a program outside the allowlist.
    ///
    /// Carries text rather than a [`Pubkey`] because that is what the log line
    /// held. The pattern that finds these ids is looser than base58
    /// ([`crate::policy::simulation`]), so a capture that is not a valid pubkey
    /// is possible — and it is refused for the same reason a valid one off the
    /// allowlist is. Reporting the characters that were actually in the log is
    /// what makes the rejection something an operator can search for.
    #[error("Simulation revealed unknown invoked program: {0}")]
    UnknownInvokedProgram(String),

    /// A bare SPL transfer (no DEX instruction alongside it) to an unknown address.
    #[error("Standalone SPL transfer to non-whitelisted address: {0}")]
    NonWhitelistedTransfer(Pubkey),

    /// A bare native-SOL transfer (no DEX instruction alongside it) to an unknown
    /// address.
    ///
    /// New enforcement with no TypeScript counterpart: `signer/policy.ts` inspects
    /// only SPL token instructions, and the System Program is on the allowlist, so
    /// a `SystemProgram.transfer` to any address was signed unchecked — a strictly
    /// cheaper drain than the SPL transfer the same file blocks, needing no token
    /// account at all. See [`crate::policy::system`].
    #[error("Standalone SOL transfer to non-whitelisted address: {0}")]
    StandaloneSolTransfer(Pubkey),
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

    /// A lookup table account exists but its data is not a lookup table.
    #[error("ALT account is not a valid lookup table: {key} ({reason})")]
    AltAccountMalformed {
        /// Address of the account that was fetched.
        key: Pubkey,
        /// Why the lookup table layout could not be read.
        reason: String,
    },

    /// A message indexed past the end of a lookup table's address list.
    ///
    /// Wording matches the `MessageV0.resolveAddressTableLookups` throw, which is
    /// what surfaces from the TypeScript signer for the same input.
    #[error("Failed to find address for index {index} in address lookup table {table}")]
    AltIndexOutOfRange {
        /// Address of the lookup table.
        table: Pubkey,
        /// The index the message asked for.
        index: u8,
    },
}

/// Failures reaching the RPC endpoint (`signer/policy.ts` via web3.js `Connection`).
///
/// A *missing* account is not an error — [`crate::rpc::SolanaRpc`] reports that as
/// `Ok(None)`, because "this address holds nothing" is an answer the policy engine
/// acts on rather than a failure to get one.
#[derive(Debug, Clone, thiserror::Error)]
pub enum RpcError {
    /// The endpoint could not be reached, or refused the request.
    #[error("RPC request failed: {0}")]
    Transport(String),

    /// The endpoint replied, but the payload could not be decoded.
    #[error("RPC returned an unreadable response: {0}")]
    Malformed(String),
}
