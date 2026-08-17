//! Tests for `signer_core::protocol` — the length-prefixed JSON framing and the
//! request/response shapes on the Unix socket.
//!
//! The wire format is the contract with a TypeScript client that is already in
//! production (`src/utils/wallet.ts` `sendToSigner`), so the assertions here are
//! deliberately about *bytes and exact strings* rather than about round-tripping
//! through this crate's own types: a response whose keys serialize in a different
//! order still parses in Node, but an `error` field with different wording shows
//! up verbatim in the bot's logs and in Discord alerts.
//!
//! The reader helpers below exist because a Unix socket delivers whatever the
//! kernel has, not whatever the parser wants. `read_frame` therefore has to cope
//! with a header split across two reads, a payload split across many, several
//! frames arriving in one chunk, and `EINTR` — none of which a `Cursor` ever
//! produces on its own.

use std::io::{self, Cursor, Read, Write};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use signer_core::error::ProtocolError;
use signer_core::protocol::{read_frame, write_frame, SignRequest, SignResponse, MAX_FRAME_LEN};
use signer_core::tx::TxKind;

// ── Readers and writers that misbehave in the ways a socket does ────────────

/// A reader that hands back at most `chunk` bytes per call.
///
/// With `chunk == 1` this is the worst case a socket can hand a parser: every
/// length byte and every payload byte arrives in its own `read`.
struct Dribble {
    data: Vec<u8>,
    position: usize,
    chunk: usize,
}

impl Dribble {
    fn new(data: Vec<u8>, chunk: usize) -> Self {
        Self {
            data,
            position: 0,
            chunk,
        }
    }
}

impl Read for Dribble {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = self.data.len() - self.position;
        let take = remaining.min(self.chunk).min(buf.len());
        buf[..take].copy_from_slice(&self.data[self.position..self.position + take]);
        self.position += take;
        Ok(take)
    }
}

/// A reader that yields `prefix`, then fails with `kind`.
struct FailAfter {
    prefix: Cursor<Vec<u8>>,
    kind: io::ErrorKind,
}

impl Read for FailAfter {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.prefix.read(buf)? {
            0 => Err(io::Error::new(self.kind, "boom")),
            n => Ok(n),
        }
    }
}

/// A reader that reports `Interrupted` before every successful read.
///
/// A signal delivered mid-`read` (the unlock path installs handlers, so this is
/// reachable) surfaces as `EINTR`, and dropping the frame for it would be a bug.
struct Interrupting {
    inner: Cursor<Vec<u8>>,
    armed: bool,
}

impl Read for Interrupting {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.armed {
            self.armed = false;
            return Err(io::Error::new(io::ErrorKind::Interrupted, "EINTR"));
        }
        self.armed = true;
        self.inner.read(buf)
    }
}

/// A writer that records the bytes written and how often it was flushed.
#[derive(Default)]
struct Recorder {
    written: Vec<u8>,
    flushes: usize,
}

impl Write for Recorder {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.written.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flushes += 1;
        Ok(())
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// A frame on the wire: 4-byte big-endian length, then the payload.
fn framed(payload: &[u8]) -> Vec<u8> {
    let mut bytes = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
    bytes.extend_from_slice(payload);
    bytes
}

/// A header claiming `len` bytes, with nothing behind it.
fn header(len: u32) -> Vec<u8> {
    len.to_be_bytes().to_vec()
}

fn read_one(bytes: Vec<u8>) -> Result<Option<Vec<u8>>, ProtocolError> {
    read_frame(&mut Cursor::new(bytes))
}

fn request(json: &str) -> Result<SignRequest, ProtocolError> {
    SignRequest::from_json(json.as_bytes())
}

// ── Framing: round trips ────────────────────────────────────────────────────

#[test]
fn write_frame_then_read_frame_round_trips_every_size() {
    for payload in [
        Vec::new(),
        b"x".to_vec(),
        br#"{"type":"legacy","tx":"AA=="}"#.to_vec(),
        vec![0xABu8; 4096],
        vec![0x7Fu8; MAX_FRAME_LEN as usize],
    ] {
        let mut wire = Vec::new();
        write_frame(&mut wire, &payload).expect("write should succeed");

        let read = read_one(wire).expect("read should succeed");
        assert_eq!(read.as_deref(), Some(payload.as_slice()));
    }
}

#[test]
fn write_frame_emits_a_big_endian_length_then_the_payload() {
    let mut recorder = Recorder::default();
    write_frame(&mut recorder, b"hello").expect("write should succeed");

    assert_eq!(recorder.written, b"\x00\x00\x00\x05hello");
    assert_eq!(
        recorder.flushes, 1,
        "a buffered writer must not hold the response back"
    );
}

#[test]
fn write_frame_of_an_empty_payload_still_emits_a_header() {
    let mut wire = Vec::new();
    write_frame(&mut wire, b"").expect("write should succeed");
    assert_eq!(wire, b"\x00\x00\x00\x00");
}

// ── Framing: end of stream ──────────────────────────────────────────────────

#[test]
fn clean_eof_before_a_header_is_end_of_stream_not_an_error() {
    // How every well-behaved connection ends: the bot sends one request, reads
    // one response, and destroys the socket.
    assert!(read_one(Vec::new())
        .expect("clean EOF is not an error")
        .is_none());
}

#[test]
fn eof_part_way_through_a_header_is_truncation() {
    let err = read_one(vec![0x00, 0x00]).expect_err("a partial header is a protocol violation");
    assert!(
        matches!(
            err,
            ProtocolError::Truncated {
                expected: 4,
                actual: 2
            }
        ),
        "got {err:?}"
    );
}

#[test]
fn eof_part_way_through_a_payload_is_truncation() {
    let mut wire = header(10);
    wire.extend_from_slice(b"only6b");

    let err = read_one(wire).expect_err("a partial payload is a protocol violation");
    assert!(
        matches!(
            err,
            ProtocolError::Truncated {
                expected: 10,
                actual: 6
            }
        ),
        "got {err:?}"
    );
}

#[test]
fn a_header_promising_bytes_that_never_arrive_is_truncation_not_a_hang() {
    let err = read_one(header(64)).expect_err("nothing follows the header");
    assert!(
        matches!(err, ProtocolError::Truncated { actual: 0, .. }),
        "got {err:?}"
    );
}

// ── Framing: the size cap ───────────────────────────────────────────────────

#[test]
fn a_frame_exactly_at_the_cap_is_accepted() {
    let payload = vec![0x5Au8; MAX_FRAME_LEN as usize];
    let read = read_one(framed(&payload)).expect("the cap is inclusive");
    assert_eq!(read.map(|frame| frame.len()), Some(MAX_FRAME_LEN as usize));
}

#[test]
fn one_byte_over_the_cap_is_rejected() {
    let err = read_one(header(MAX_FRAME_LEN + 1)).expect_err("the cap must be enforced");
    assert!(
        matches!(
            err,
            ProtocolError::FrameTooLarge {
                len,
                limit
            } if len == MAX_FRAME_LEN + 1 && limit == MAX_FRAME_LEN
        ),
        "got {err:?}"
    );
}

#[test]
fn an_absurd_length_is_rejected_without_allocating_for_it() {
    // The TypeScript reader would sit here holding a 4 GiB ambition open until
    // the client gave up. This must fail on the header alone.
    let err = read_one(header(u32::MAX)).expect_err("u32::MAX is way past the cap");
    assert_eq!(
        err.to_string(),
        format!(
            "Frame too large: {} bytes exceeds the 65536-byte limit",
            u32::MAX
        )
    );
}

#[test]
fn an_oversize_frame_leaves_its_payload_unread() {
    // The caller has to close the connection rather than resynchronise, and this
    // pins the reason: `read_frame` stops at the header and never drains the
    // bytes the attacker wanted it to buffer.
    let mut wire = header(MAX_FRAME_LEN + 1);
    wire.extend_from_slice(&vec![0u8; 1024]);
    let mut cursor = Cursor::new(wire);

    read_frame(&mut cursor).expect_err("oversize");
    assert_eq!(cursor.position(), 4, "only the header should be consumed");
}

// ── Framing: fragmentation, pipelining, interruption ────────────────────────

#[test]
fn a_frame_split_one_byte_per_read_is_reassembled() {
    let payload = br#"{"type":"versioned","tx":"AQID"}"#;
    let mut reader = Dribble::new(framed(payload), 1);

    let read = read_frame(&mut reader).expect("dribbled bytes are still a frame");
    assert_eq!(read.as_deref(), Some(payload.as_slice()));
    assert!(read_frame(&mut reader)
        .expect("stream ends cleanly")
        .is_none());
}

#[test]
fn a_header_split_across_two_reads_is_reassembled() {
    // The 3/1 split is the one a naive `if buffered >= 4` check gets wrong.
    let payload = b"abcdefgh";
    let mut reader = Dribble::new(framed(payload), 3);

    let read = read_frame(&mut reader).expect("split header is still a header");
    assert_eq!(read.as_deref(), Some(payload.as_slice()));
}

#[test]
fn frames_pipelined_into_one_chunk_are_delivered_in_order() {
    // `signer/index.ts:279-308` handles at most one frame per `data` event and
    // then waits for more bytes, so a client that writes two requests back to
    // back stalls until it writes a third. A loop over `read_frame` does not.
    let mut wire = framed(b"first");
    wire.extend_from_slice(&framed(b"second"));
    wire.extend_from_slice(&framed(b"third"));
    let mut cursor = Cursor::new(wire);

    let mut frames = Vec::new();
    while let Some(frame) = read_frame(&mut cursor).expect("each frame should parse") {
        frames.push(frame);
    }

    assert_eq!(
        frames,
        vec![b"first".to_vec(), b"second".to_vec(), b"third".to_vec()]
    );
}

#[test]
fn pipelined_frames_survive_arbitrary_chunk_boundaries() {
    let mut wire = framed(b"alpha");
    wire.extend_from_slice(&framed(b"bravo"));

    for chunk in 1..=wire.len() {
        let mut reader = Dribble::new(wire.clone(), chunk);
        let first = read_frame(&mut reader).expect("first").expect("present");
        let second = read_frame(&mut reader).expect("second").expect("present");
        assert_eq!(
            (first.as_slice(), second.as_slice()),
            (&b"alpha"[..], &b"bravo"[..]),
            "chunk size {chunk}"
        );
    }
}

#[test]
fn interrupted_reads_are_retried_rather_than_reported() {
    let mut reader = Interrupting {
        inner: Cursor::new(framed(b"payload")),
        armed: true,
    };

    let read = read_frame(&mut reader).expect("EINTR is not a protocol failure");
    assert_eq!(read.as_deref(), Some(&b"payload"[..]));
}

#[test]
fn a_read_error_is_wrapped_rather_than_swallowed() {
    let mut reader = FailAfter {
        prefix: Cursor::new(header(8)),
        kind: io::ErrorKind::ConnectionReset,
    };

    let err = read_frame(&mut reader).expect_err("a reset socket is an error");
    assert!(matches!(err, ProtocolError::Io(_)), "got {err:?}");
    assert_eq!(err.to_string(), "Socket read failed: boom");
}

// ── Request: validation semantics and exact error strings ───────────────────

#[test]
fn both_wire_types_are_accepted() {
    for (wire, expected) in [("versioned", TxKind::Versioned), ("legacy", TxKind::Legacy)] {
        let req = request(&format!(r#"{{"type":"{wire}","tx":"AQID"}}"#)).expect("valid JSON");
        assert_eq!(req.r#type, wire);
        assert_eq!(req.validate().expect("valid request"), expected);
    }
}

#[test]
fn unknown_fields_are_ignored_like_property_access() {
    let req = request(r#"{"type":"legacy","tx":"AQID","reqId":7,"future":{"a":1}}"#)
        .expect("extra fields must not break an older signer");
    assert_eq!(req.validate().expect("valid request"), TxKind::Legacy);
    assert_eq!(req.decode_tx().expect("valid base64"), vec![1, 2, 3]);
}

#[test]
fn missing_and_empty_fields_are_indistinguishable_and_worded_exactly() {
    for json in [
        r"{}",
        r#"{"tx":"AQID"}"#,
        r#"{"type":"legacy"}"#,
        r#"{"type":"","tx":"AQID"}"#,
        r#"{"type":"legacy","tx":""}"#,
        r#"{"type":"","tx":""}"#,
    ] {
        let err = request(json)
            .expect("well-formed JSON")
            .validate()
            .expect_err(json);
        assert!(
            matches!(err, ProtocolError::MissingField),
            "{json}: {err:?}"
        );
        assert_eq!(err.to_string(), "Invalid request: missing type or tx");
    }
}

#[test]
fn a_request_missing_everything_blames_the_fields_not_the_type() {
    // Order matters: `signer/index.ts` checks presence first, so `{}` must not
    // come back as `Invalid type: `.
    let err = request(r"{}")
        .unwrap()
        .validate()
        .expect_err("empty request");
    assert_eq!(err.to_string(), "Invalid request: missing type or tx");
}

#[test]
fn an_unknown_type_is_echoed_back_verbatim() {
    for bogus in [
        "bogus",
        "Versioned",
        "VERSIONED",
        "legacy ",
        " legacy",
        "v0",
    ] {
        let err = request(&format!(r#"{{"type":"{bogus}","tx":"AQID"}}"#))
            .expect("well-formed JSON")
            .validate()
            .expect_err(bogus);
        assert!(
            matches!(&err, ProtocolError::InvalidType(value) if value == bogus),
            "got {err:?}"
        );
        assert_eq!(err.to_string(), format!("Invalid type: {bogus}"));
    }
}

#[test]
fn malformed_json_is_a_json_error() {
    for json in ["", "not json", "{", r#"{"type":"legacy","#, "null", "7"] {
        let err = request(json).expect_err(json);
        assert!(matches!(err, ProtocolError::Json(_)), "{json}: {err:?}");
        assert!(
            err.to_string()
                .starts_with("Invalid request: malformed JSON: "),
            "{json}: {err}"
        );
    }
}

#[test]
fn a_json_array_lands_on_the_missing_field_error_just_as_it_does_in_node() {
    // serde reads a struct with all-defaulted fields out of a sequence, so `[]`
    // parses into an empty request. That is the same place TypeScript ends up:
    // `JSON.parse("[]").type` is `undefined`, which is falsy.
    let err = request("[]")
        .expect("a JSON array is well-formed")
        .validate()
        .expect_err("but it carries neither field");
    assert_eq!(err.to_string(), "Invalid request: missing type or tx");
}

#[test]
fn a_non_string_type_is_a_json_error_rather_than_a_coerced_message() {
    // Documented divergence: TypeScript stringifies whatever it was given into
    // `Invalid type: 5`. Nothing the bot ships sends a non-string here.
    let err = request(r#"{"type":5,"tx":"AQID"}"#).expect_err("type must be a string");
    assert!(matches!(err, ProtocolError::Json(_)), "got {err:?}");
}

#[test]
fn the_tx_field_decodes_as_standard_base64() {
    let bytes: Vec<u8> = (0u8..=255).collect();
    let json = format!(r#"{{"type":"legacy","tx":"{}"}}"#, BASE64.encode(&bytes));
    let decoded = request(&json).unwrap().decode_tx().expect("valid base64");
    assert_eq!(decoded, bytes);
}

#[test]
fn a_tx_field_that_is_not_base64_is_rejected() {
    for bad in ["not base64!", "AQI", "====", "AQID===="] {
        let err = request(&format!(r#"{{"type":"legacy","tx":"{bad}"}}"#))
            .expect("well-formed JSON")
            .decode_tx()
            .expect_err(bad);
        assert!(
            matches!(err, ProtocolError::InvalidBase64),
            "{bad}: {err:?}"
        );
        assert_eq!(err.to_string(), "Invalid request: tx is not valid base64");
    }
}

// ── Response: exact JSON on the wire ────────────────────────────────────────

#[test]
fn a_success_response_is_exactly_the_typescript_shape() {
    let response = SignResponse::signed(&[1, 2, 3]);
    assert_eq!(response, SignResponse::Ok("AQID".to_owned()));
    assert_eq!(
        String::from_utf8(response.to_json_bytes()).unwrap(),
        r#"{"ok":true,"tx":"AQID"}"#
    );
}

#[test]
fn a_failure_response_is_exactly_the_typescript_shape() {
    let response = SignResponse::rejected("Invalid type: bogus");
    assert_eq!(
        String::from_utf8(response.to_json_bytes()).unwrap(),
        r#"{"ok":false,"error":"Invalid type: bogus"}"#
    );
}

#[test]
fn a_failure_response_carries_no_tx_key() {
    // `remoteSign` reads `result.tx` only after checking `result.ok`, but a
    // stray empty `tx` on the failure path would be an easy thing to mis-handle.
    let json = String::from_utf8(SignResponse::rejected("nope").to_json_bytes()).unwrap();
    assert!(!json.contains("\"tx\""), "{json}");
}

#[test]
fn response_error_text_is_json_escaped() {
    let response = SignResponse::rejected("quote \" backslash \\ newline \n");
    let json = String::from_utf8(response.to_json_bytes()).unwrap();
    assert_eq!(
        json,
        r#"{"ok":false,"error":"quote \" backslash \\ newline \n"}"#
    );
}

#[test]
fn a_response_survives_the_round_trip_through_a_frame() {
    let response = SignResponse::signed(&vec![0x11; 1232]);
    let expected = response.to_json_bytes();

    let mut wire = Vec::new();
    write_frame(&mut wire, &expected).expect("write should succeed");

    // Dribbled, because the bot reassembles the response from `data` events.
    let mut reader = Dribble::new(wire, 7);
    let frame = read_frame(&mut reader)
        .expect("read should succeed")
        .expect("present");
    assert_eq!(frame, expected);
}

// ── The error strings a bot operator actually sees ──────────────────────────

#[test]
fn protocol_error_display_matches_the_typescript_wording() {
    let cases: Vec<(ProtocolError, &str)> = vec![
        (
            ProtocolError::MissingField,
            "Invalid request: missing type or tx",
        ),
        (
            ProtocolError::InvalidType("bogus".to_owned()),
            "Invalid type: bogus",
        ),
        (
            ProtocolError::InvalidBase64,
            "Invalid request: tx is not valid base64",
        ),
        (ProtocolError::Internal, "Internal signer error"),
        (
            ProtocolError::FrameTooLarge {
                len: 71_680,
                limit: MAX_FRAME_LEN,
            },
            "Frame too large: 71680 bytes exceeds the 65536-byte limit",
        ),
        (
            ProtocolError::Truncated {
                expected: 4,
                actual: 1,
            },
            "Truncated frame: expected 4 bytes, got 1 before end of stream",
        ),
    ];

    for (err, expected) in cases {
        assert_eq!(err.to_string(), expected);
    }
}
