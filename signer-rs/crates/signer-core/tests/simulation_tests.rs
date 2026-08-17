//! The post-simulation CPI check, end to end through [`PolicyEngine::check`].
//!
//! `fixtures/sim_log_vectors.json` holds the log transcripts the generator
//! recorded, each with the program ids `extractInvokedPrograms` returns for it.
//! Those recorded ids are the parity oracle: the extraction here has to agree
//! with the TypeScript on the same input, down to order and deduplication, or
//! the two signers can disagree about what a transaction invoked.
//!
//! The rest of the file is the decision table around that extraction, and most
//! of it is about what does *not* stop a signature. Simulation is the one check
//! in the policy that depends on an external service answering, so every way
//! that service can let the signer down — unreachable, rate-limited, reporting a
//! transaction that would fail — has a test saying "sign it anyway". They are
//! the tests most likely to be "fixed" into a rejection by someone reading
//! `simulation failed` as a problem, so each one records why it is not.
//!
//! Reason strings are asserted verbatim, for the reason `policy_scenarios.rs`
//! gives: they cross the socket to the bot and end up in an operator's logs.

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::OnceLock;

use serde::Deserialize;
use signer_core::{
    config::{
        dex_programs, program_allowlist, PolicyConfig, BYREAL_CLMM, JUPITER_V6, ORCA_WHIRLPOOL,
        TOKEN_PROGRAM,
    },
    error::RpcError,
    policy::{simulation, PolicyEngine, Verdict},
    rpc::{MockRpc, SimResult},
    tx::ParsedTx,
};
use solana_sdk::{
    hash::Hash,
    instruction::{CompiledInstruction, Instruction},
    message::{v0, Message, MessageHeader, VersionedMessage},
    pubkey::Pubkey,
    signature::Signature,
    transaction::{Transaction, VersionedTransaction},
};

// ── Fixtures ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SimFixture {
    vectors: Vec<SimVector>,
}

#[derive(Deserialize)]
struct SimVector {
    name: String,
    logs: Vec<String>,
    /// What `extractInvokedPrograms` returned, in first-seen order.
    expected_invoked_program_ids: Vec<String>,
    contains_off_allowlist_program: bool,
    /// Present exactly when `contains_off_allowlist_program` is set.
    #[serde(default)]
    off_allowlist_program_id: Option<String>,
    jupiter_present: bool,
}

fn fixture() -> &'static SimFixture {
    static FIXTURE: OnceLock<SimFixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let raw = include_str!("fixtures/sim_log_vectors.json");
        serde_json::from_str(raw).expect("sim_log_vectors.json should parse")
    })
}

fn vector(name: &str) -> &'static SimVector {
    fixture()
        .vectors
        .iter()
        .find(|vector| vector.name == name)
        .unwrap_or_else(|| panic!("fixture vector {name} is missing"))
}

/// A log transcript with one extra line, for the cases the fixtures do not cover.
fn plus_invoke(logs: &[String], program: &str) -> Vec<String> {
    let mut logs = logs.to_vec();
    logs.push(format!("Program {program} invoke [2]"));
    logs
}

// ── Builders ────────────────────────────────────────────────────────────────

/// The engine the daemon builds, with an empty destination whitelist.
fn engine() -> PolicyEngine {
    PolicyEngine::new(PolicyConfig {
        program_allowlist: program_allowlist(BYREAL_CLMM),
        dex_programs: dex_programs(BYREAL_CLMM),
        destination_whitelist: HashSet::new(),
        jupiter: JUPITER_V6,
    })
}

/// A legacy transaction whose top-level instructions call `programs`, in order.
///
/// The instruction data is a single zero byte: enough to be a real instruction,
/// and — for the token programs, which none of these tests use as a top-level
/// program — not one of the four discriminators the SPL pass acts on. What every
/// test here varies is the *logs*, so the transaction only has to clear the
/// static passes and reach simulation.
fn tx_calling(programs: &[Pubkey]) -> ParsedTx {
    let payer = Pubkey::new_unique();
    let instructions: Vec<Instruction> = programs
        .iter()
        .map(|program| Instruction::new_with_bytes(*program, &[0], Vec::new()))
        .collect();

    let mut tx = Transaction::new_unsigned(Message::new(&instructions, Some(&payer)));
    tx.message.recent_blockhash = Hash::new_from_array([1u8; 32]);
    ParsedTx::Legacy(tx)
}

/// A v0 transaction that names a lookup table, for the resolution-failure case.
fn tx_needing_lookup_table(table: Pubkey) -> ParsedTx {
    let payer = Pubkey::new_unique();
    ParsedTx::Versioned(VersionedTransaction {
        signatures: vec![Signature::default()],
        message: VersionedMessage::V0(v0::Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: vec![payer, TOKEN_PROGRAM],
            recent_blockhash: Hash::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 1,
                accounts: vec![2],
                data: vec![0],
            }],
            address_table_lookups: vec![v0::MessageAddressTableLookup {
                account_key: table,
                writable_indexes: vec![0],
                readonly_indexes: Vec::new(),
            }],
        }),
    })
}

fn expect_denied(verdict: &Verdict, reason: &str) {
    assert_eq!(verdict.reason(), Some(reason), "{verdict:?}");
}

// ── Extraction parity ───────────────────────────────────────────────────────

#[test]
fn every_vector_extracts_the_ids_the_typescript_recorded() {
    for vector in &fixture().vectors {
        let extracted = simulation::extract_invoked_programs(&vector.logs);
        assert_eq!(
            extracted, vector.expected_invoked_program_ids,
            "vector {}: extraction must match `extractInvokedPrograms`, in order",
            vector.name
        );
    }
}

#[test]
fn the_fixtures_and_the_allowlist_agree_on_which_ids_are_unknown() {
    // Guards the direction the vectors cannot check themselves: a fixture that
    // calls a program "off-allowlist" stops meaning anything the day that
    // program is added to `signer/config.ts`.
    let allowlist = program_allowlist(BYREAL_CLMM);
    let known = |id: &str| Pubkey::from_str(id).is_ok_and(|program| allowlist.contains(&program));

    for vector in &fixture().vectors {
        let unknown: Vec<&String> = vector
            .expected_invoked_program_ids
            .iter()
            .filter(|id| !known(id))
            .collect();

        assert_eq!(
            !unknown.is_empty(),
            vector.contains_off_allowlist_program,
            "vector {}: `contains_off_allowlist_program` disagrees with the allowlist ({unknown:?})",
            vector.name
        );
        if let Some(expected) = &vector.off_allowlist_program_id {
            assert_eq!(unknown, vec![expected], "vector {}", vector.name);
        }
    }
}

// ── The one fatal finding ───────────────────────────────────────────────────

#[test]
fn an_off_allowlist_cpi_is_refused() {
    let vector = vector("off_allowlist_cpi");
    let unknown = vector
        .off_allowlist_program_id
        .as_ref()
        .expect("the vector names the offending program");

    let rpc = MockRpc::new().with_sim_logs(vector.logs.clone());
    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    expect_denied(
        &verdict,
        &format!("Simulation revealed unknown invoked program: {unknown}"),
    );
}

#[test]
fn a_capture_that_is_not_a_pubkey_is_refused_verbatim() {
    // `\w{32,44}` admits characters base58 does not, so the id in the rejection
    // is the log's own text rather than a re-encoded pubkey.
    let rpc = MockRpc::new()
        .with_sim_logs(["Program Tokenkeg_feZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]"]);
    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    expect_denied(
        &verdict,
        "Simulation revealed unknown invoked program: Tokenkeg_feZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
}

#[test]
fn a_transcript_of_allowlisted_programs_is_signed() {
    let vector = vector("simple_two_programs");
    let rpc = MockRpc::new().with_sim_logs(vector.logs.clone());

    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    assert!(verdict.is_allowed(), "{verdict:?}");
    assert_eq!(rpc.sim_calls(), 1, "simulation should run exactly once");
}

// ── The Jupiter exemption ───────────────────────────────────────────────────

#[test]
fn a_jupiter_transaction_is_not_simulated_at_all() {
    let vector = vector("jupiter_routed_swap");
    assert!(
        vector.jupiter_present,
        "the vector must route through Jupiter"
    );

    let rpc = MockRpc::new().with_sim_logs(vector.logs.clone());
    let verdict = engine().check(&tx_calling(&[JUPITER_V6]), &rpc);

    assert!(verdict.is_allowed(), "{verdict:?}");
    assert_eq!(
        rpc.sim_calls(),
        0,
        "the exemption should skip the round trip, not just its result"
    );
}

#[test]
fn a_jupiter_transaction_is_allowed_even_when_the_logs_name_an_unknown_program() {
    // The exemption is unconditional by design: a route CPIs into whatever AMMs
    // the router picked, and they cannot be pre-listed. Jupiter is on the
    // allowlist and vouches for its own callees. Without the skip this exact
    // input is the rejection `an_off_allowlist_cpi_is_refused` asserts.
    let vector = vector("off_allowlist_cpi");
    let rpc = MockRpc::new().with_sim_logs(vector.logs.clone());

    let verdict = engine().check(&tx_calling(&[JUPITER_V6, TOKEN_PROGRAM]), &rpc);

    assert!(verdict.is_allowed(), "{verdict:?}");
}

#[test]
fn another_dex_does_not_inherit_the_exemption() {
    // `has_dex_instruction` is true for all six DEX programs; the exemption is
    // Jupiter alone. Using the coarser flag here would leave every Orca, Meteora
    // and Byreal transaction unchecked.
    let vector = vector("off_allowlist_cpi");
    let unknown = vector.off_allowlist_program_id.clone().expect("named");
    let rpc = MockRpc::new().with_sim_logs(vector.logs.clone());

    let verdict = engine().check(&tx_calling(&[ORCA_WHIRLPOOL]), &rpc);

    expect_denied(
        &verdict,
        &format!("Simulation revealed unknown invoked program: {unknown}"),
    );
}

// ── Everything else about simulation is advisory ────────────────────────────

#[test]
fn a_transaction_that_would_fail_on_chain_is_still_signed() {
    // `policy.ts:165-168`. Simulation runs a slot behind and `closePosition` in
    // particular fails it and succeeds on chain; the bot handles the real error.
    let vector = vector("simple_two_programs");
    let rpc = MockRpc::new().with_sim(Ok(SimResult {
        err: Some("InstructionError(0, Custom(6003))".to_owned()),
        logs: vector.logs.clone(),
    }));

    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    assert!(verdict.is_allowed(), "{verdict:?}");
}

#[test]
fn a_failing_simulation_still_has_its_logs_checked() {
    // The half of the previous test that is easy to lose: `simResult.err` is
    // non-fatal, but it does not excuse the transcript. A transaction that
    // reached an unknown program and *then* failed is still a transaction that
    // reached an unknown program.
    let vector = vector("off_allowlist_cpi");
    let unknown = vector.off_allowlist_program_id.clone().expect("named");
    let rpc = MockRpc::new().with_sim(Ok(SimResult {
        err: Some("InstructionError(1, Custom(1))".to_owned()),
        logs: vector.logs.clone(),
    }));

    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    expect_denied(
        &verdict,
        &format!("Simulation revealed unknown invoked program: {unknown}"),
    );
}

#[test]
fn an_unreachable_rpc_does_not_block_signing() {
    // A rejection here would mean an RPC outage stops the bot from closing
    // positions — a worse failure than the one it would prevent, and the reason
    // `policy.ts` catches around the whole block.
    let rpc = MockRpc::new().with_sim(Err(RpcError::Transport(
        "error sending request for url (http://127.0.0.1:1/)".to_owned(),
    )));

    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    assert!(verdict.is_allowed(), "{verdict:?}");
    assert_eq!(rpc.sim_calls(), 1, "the call should have been attempted");
}

#[test]
fn an_unreadable_reply_does_not_block_signing() {
    let rpc = MockRpc::new().with_sim(Err(RpcError::Malformed("expected value".to_owned())));

    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    assert!(verdict.is_allowed(), "{verdict:?}");
}

#[test]
fn a_reply_with_no_logs_leaves_nothing_to_check() {
    // web3.js reports this as `logs: null`, which fails the `simResult.logs`
    // guard in the TypeScript and skips the loop.
    let rpc = MockRpc::new().with_sim(Ok(SimResult::default()));

    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    assert!(verdict.is_allowed(), "{verdict:?}");
}

// ── Ordering against the static passes ──────────────────────────────────────

#[test]
fn a_transaction_the_static_pass_refuses_is_never_simulated() {
    let unknown_program = Pubkey::new_unique();
    let rpc = MockRpc::new().with_sim_logs(vector("off_allowlist_cpi").logs.clone());

    let verdict = engine().check(&tx_calling(&[unknown_program]), &rpc);

    expect_denied(&verdict, &format!("Unknown program: {unknown_program}"));
    assert_eq!(
        rpc.sim_calls(),
        0,
        "the cheap pass decides before the expensive one runs"
    );
}

#[test]
fn an_unresolvable_lookup_table_is_refused_before_simulation() {
    // Nothing downstream can read a transaction whose accounts are unknown, so
    // resolution failure is the one RPC problem that *is* fatal.
    let table = Pubkey::new_unique();
    let rpc = MockRpc::new();

    let verdict = engine().check(&tx_needing_lookup_table(table), &rpc);

    expect_denied(
        &verdict,
        &format!("ALT resolution failed: ALT account not found: {table}"),
    );
    assert_eq!(rpc.sim_calls(), 0);
}

// ── Both transaction encodings reach simulation ─────────────────────────────

#[test]
fn a_versioned_transaction_is_simulated_like_a_legacy_one() {
    // The TypeScript has two `simulateTransaction` overloads; the port lifts a
    // legacy transaction into a `VersionedTransaction` so there is one path.
    // What matters is that the verdict does not depend on which door it came in.
    let vector = vector("off_allowlist_cpi");
    let unknown = vector.off_allowlist_program_id.clone().expect("named");

    let versioned = ParsedTx::Versioned(VersionedTransaction {
        signatures: vec![Signature::default()],
        message: VersionedMessage::V0(v0::Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: vec![Pubkey::new_unique(), BYREAL_CLMM],
            recent_blockhash: Hash::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 1,
                accounts: Vec::new(),
                data: vec![0],
            }],
            address_table_lookups: Vec::new(),
        }),
    });

    let rpc = MockRpc::new().with_sim_logs(vector.logs.clone());
    let verdict = engine().check(&versioned, &rpc);

    expect_denied(
        &verdict,
        &format!("Simulation revealed unknown invoked program: {unknown}"),
    );
}

#[test]
fn an_unknown_program_anywhere_in_the_transcript_is_found() {
    // Depth is not read: the pattern ignores the `[N]` suffix, so a program
    // reached four levels down is held to the same allowlist as a top-level one.
    let deep = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
    let logs = plus_invoke(&vector("simple_two_programs").logs, deep);
    let rpc = MockRpc::new().with_sim_logs(logs);

    let verdict = engine().check(&tx_calling(&[BYREAL_CLMM]), &rpc);

    expect_denied(
        &verdict,
        &format!("Simulation revealed unknown invoked program: {deep}"),
    );
}
