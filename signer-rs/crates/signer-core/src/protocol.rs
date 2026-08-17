//! The Unix-socket wire protocol: length-prefixed JSON frames.
//!
//! One frame is a 4-byte big-endian length followed by exactly that many bytes
//! of UTF-8 JSON. The bot writes a request frame and reads a response frame
//! (`src/utils/wallet.ts` `sendToSigner`); the signer does the mirror image
//! (`signer/index.ts:275-313`).
//!
//! ```text
//! →  {"type":"versioned"|"legacy","tx":"<base64 unsigned tx>"}
//! ←  {"ok":true,"tx":"<base64 signed tx>"}   or   {"ok":false,"error":"<reason>"}
//! ```
//!
//! Everything here is synchronous and generic over [`Read`]/[`Write`], with no
//! socket type in sight, so the framing can be unit-tested against a reader that
//! hands back one byte at a time — which is the case the TypeScript
//! implementation gets wrong twice (see below).
//!
//! # Divergences from `signer/index.ts`
//!
//! * **A frame length is capped at [`MAX_FRAME_LEN`].** The TypeScript reader
//!   takes the declared length on faith and keeps concatenating chunks until it
//!   is satisfied, so a client that writes `FFFFFFFF` and then dribbles bytes
//!   makes the signer buffer without bound. A signing transaction is ~1.2 kB, so
//!   64 KiB is three orders of magnitude of headroom and still bounded.
//! * **Base64 is decoded strictly.** `Buffer.from(s, 'base64')` in Node silently
//!   drops characters outside the alphabet; [`SignRequest::decode_tx`] rejects
//!   them. Both sides refuse to sign such a payload — the difference is only
//!   which error the caller sees, and a decoder that quietly reinterprets the
//!   bytes it was asked to sign is the wrong default for a signer.
//! * **`type` and `tx` must be JSON strings.** The TypeScript checks are
//!   `!request.type` and a `!==` comparison, so a number or `null` reaches the
//!   error message and gets stringified there. Here a non-string field is a JSON
//!   error instead. No client the bot ships produces one.

use std::io::{self, Read, Write};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::ser::SerializeMap as _;
use serde::{Deserialize, Serialize, Serializer};

use crate::error::ProtocolError;
use crate::tx::TxKind;

/// Largest frame payload the signer will read, in bytes.
///
/// A Solana transaction is capped at 1232 bytes on the wire; base64 and the JSON
/// envelope bring a request to roughly 1.7 kB. 64 KiB leaves room for a future
/// request shape without letting a length prefix drive an allocation.
pub const MAX_FRAME_LEN: u32 = 64 * 1024;

/// Bytes in the big-endian length prefix.
const HEADER_LEN: usize = 4;

// ── Framing ─────────────────────────────────────────────────────────────────

/// Reads one frame, blocking until it is complete.
///
/// Returns `Ok(None)` when the stream ends cleanly at a frame boundary — the
/// normal way a connection finishes, since the bot closes after each response.
///
/// # Errors
///
/// * [`ProtocolError::FrameTooLarge`] if the header declares more than
///   [`MAX_FRAME_LEN`] bytes. Nothing is read past the header, so the caller
///   still holds a socket full of unread bytes and should close it rather than
///   try to resynchronise.
/// * [`ProtocolError::Truncated`] if the stream ends mid-header or mid-payload.
/// * [`ProtocolError::Io`] for any other read failure.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, ProtocolError> {
    let mut header = [0u8; HEADER_LEN];
    match fill(reader, &mut header)? {
        Filled::Eof { read: 0 } => return Ok(None),
        Filled::Eof { read } => {
            return Err(ProtocolError::Truncated {
                expected: HEADER_LEN,
                actual: read,
            })
        }
        Filled::Complete => {}
    }

    let declared = u32::from_be_bytes(header);
    if declared > MAX_FRAME_LEN {
        return Err(ProtocolError::FrameTooLarge {
            len: declared,
            limit: MAX_FRAME_LEN,
        });
    }
    // Always succeeds on a 32- or 64-bit target, where `MAX_FRAME_LEN` fits in a
    // `usize` with room to spare. On one where it does not, "too large" is the
    // honest answer rather than a panic.
    let Ok(expected) = usize::try_from(declared) else {
        return Err(ProtocolError::FrameTooLarge {
            len: declared,
            limit: MAX_FRAME_LEN,
        });
    };

    let mut payload = vec![0u8; expected];
    match fill(reader, &mut payload)? {
        Filled::Complete => Ok(Some(payload)),
        Filled::Eof { read } => Err(ProtocolError::Truncated {
            expected,
            actual: read,
        }),
    }
}

/// Writes one frame: the big-endian length, then the payload.
///
/// Flushes before returning, so a buffered writer does not leave a response
/// sitting in memory while the client waits for it.
///
/// # Errors
///
/// Whatever the underlying writer returns, plus
/// [`io::ErrorKind::InvalidInput`] for a payload too large to describe in a
/// `u32` — unreachable for the responses this signer produces.
pub fn write_frame(writer: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "frame payload of {} bytes does not fit in a u32 length prefix",
                payload.len()
            ),
        )
    })?;

    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

/// Outcome of trying to fill a buffer completely.
enum Filled {
    /// Every byte of the buffer was read.
    Complete,
    /// The stream ended after `read` bytes.
    Eof {
        /// How much of the buffer was filled before EOF.
        read: usize,
    },
}

/// Reads until `buf` is full, the stream ends, or the read fails.
///
/// [`Read::read_exact`] would do for the happy path, but it collapses "ended at
/// a frame boundary" and "ended half-way through a frame" into the same
/// `UnexpectedEof`, and those mean opposite things here: the first is a client
/// hanging up normally, the second is a protocol violation worth logging.
fn fill(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<Filled> {
    let mut read = 0;
    while read < buf.len() {
        match reader.read(&mut buf[read..]) {
            Ok(0) => return Ok(Filled::Eof { read }),
            Ok(n) => read += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Ok(Filled::Complete)
}

// ── Request ─────────────────────────────────────────────────────────────────

/// A signing request as it arrives on the socket.
///
/// Unknown fields are ignored, matching `JSON.parse` followed by property
/// access. Both fields default to the empty string so that a *missing* field and
/// an *empty* one land on the same [`ProtocolError::MissingField`] that
/// `!request.type || !request.tx` produces in `signer/index.ts:231`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SignRequest {
    /// Transaction encoding: `versioned` or `legacy`.
    #[serde(default, rename = "type")]
    pub r#type: String,
    /// Base64 of the unsigned transaction bytes.
    #[serde(default)]
    pub tx: String,
}

impl SignRequest {
    /// Parses a frame payload as request JSON.
    ///
    /// # Errors
    ///
    /// [`ProtocolError::Json`] if the payload is not JSON of this shape.
    pub fn from_json(payload: &[u8]) -> Result<Self, ProtocolError> {
        serde_json::from_slice(payload).map_err(|err| ProtocolError::Json(err.to_string()))
    }

    /// Checks the two fields and resolves `type` to a [`TxKind`].
    ///
    /// This is `signer/index.ts:231-236` line for line, error strings included:
    /// the presence check comes first, so a request missing both fields reports
    /// the missing field rather than an invalid type.
    ///
    /// # Errors
    ///
    /// [`ProtocolError::MissingField`] if either field is absent or empty,
    /// [`ProtocolError::InvalidType`] if `type` is neither wire string.
    pub fn validate(&self) -> Result<TxKind, ProtocolError> {
        if self.r#type.is_empty() || self.tx.is_empty() {
            return Err(ProtocolError::MissingField);
        }
        self.r#type.parse()
    }

    /// Decodes the `tx` field into the transaction bytes to be signed.
    ///
    /// # Errors
    ///
    /// [`ProtocolError::InvalidBase64`] if `tx` is not standard base64 — see the
    /// module docs for why this is stricter than Node's decoder.
    pub fn decode_tx(&self) -> Result<Vec<u8>, ProtocolError> {
        BASE64
            .decode(&self.tx)
            .map_err(|_| ProtocolError::InvalidBase64)
    }
}

// ── Response ────────────────────────────────────────────────────────────────

/// The reply the signer writes back, one per request.
///
/// Serializes to exactly what `toResponse` in `signer/index.ts:258` produces:
/// `{"ok":true,"tx":"…"}` or `{"ok":false,"error":"…"}`, `ok` first. The bot
/// branches on `result.ok` and puts `result.error` straight into the thrown
/// message (`src/utils/wallet.ts:112-114`), so the field names and the absence
/// of a `tx` key on the failure path are both load bearing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignResponse {
    /// Signed successfully; carries base64 of the signed transaction.
    Ok(String),
    /// Refused or failed; carries the reason shown to the operator.
    Error(String),
}

impl SignResponse {
    /// A success response for freshly signed transaction bytes.
    #[must_use]
    pub fn signed(tx_bytes: &[u8]) -> Self {
        Self::Ok(BASE64.encode(tx_bytes))
    }

    /// A failure response. `reason` is rendered verbatim into the `error` field.
    #[must_use]
    pub fn rejected(reason: impl Into<String>) -> Self {
        Self::Error(reason.into())
    }

    /// Renders the response as the JSON bytes of a frame payload.
    ///
    /// Infallible by construction — a bool and one owned string have no
    /// serialization failure mode — and infallible by design where that
    /// reasoning might one day stop holding: the client is blocked on a frame,
    /// so returning *some* valid response beats propagating an error nobody up
    /// the stack could act on.
    #[must_use]
    pub fn to_json_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self)
            .unwrap_or_else(|_| br#"{"ok":false,"error":"Internal signer error"}"#.to_vec())
    }
}

impl Serialize for SignResponse {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("ok", &matches!(self, Self::Ok(_)))?;
        match self {
            Self::Ok(tx) => map.serialize_entry("tx", tx)?,
            Self::Error(error) => map.serialize_entry("error", error)?,
        }
        map.end()
    }
}
