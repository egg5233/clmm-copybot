//! Golden tests for `signer_core::alt` against the same vectors the TypeScript
//! signer was measured on.
//!
//! `fixtures/alt_vectors.json` holds one real lookup table: the addresses it
//! contains and `raw_account_data_b64`, the exact bytes
//! `getMultipleAccountsInfo` would return for it, round-tripped through
//! `AddressLookupTableAccount.deserialize` by the generator. Feeding those bytes
//! to a [`MockRpc`] makes the expansion testable without a validator, and the
//! `v0_with_alt` vector in `fixtures/tx_vectors.json` records what web3.js
//! produced for the same input: `expected.account_keys` and `expected.program_ids`
//! there are *post*-expansion, which is why `tx_golden.rs` has to skip them.
//!
//! What these tests pin down is the ordering. A lookup table expansion that
//! returns the right *set* of accounts in the wrong order silently repoints every
//! account index in the message, so the policy engine would inspect the wrong
//! destination — a failure mode with no symptom short of comparing against the
//! encoder that produced the indexes.

use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use signer_core::{
    alt::{self, ResolvedTx},
    config::{TOKEN_2022, TOKEN_PROGRAM},
    rpc::MockRpc,
    tx::{ParsedTx, TxKind},
};
use solana_sdk::{
    hash::Hash,
    instruction::CompiledInstruction,
    message::{v0, MessageHeader, VersionedMessage},
    pubkey::{self, Pubkey},
    signature::Signature,
    transaction::VersionedTransaction,
};

// ── Fixtures ────────────────────────────────────────────────────────────────

/// The address lookup table program, which owns every table account on chain.
const ALT_PROGRAM: Pubkey =
    pubkey::Pubkey::from_str_const("AddressLookupTab1e1111111111111111111111111");

#[derive(Deserialize)]
struct AltFixture {
    alt_account_key: String,
    addresses: Vec<String>,
    raw_account_data_b64: String,
    raw_account_data_len: usize,
}

#[derive(Deserialize)]
struct TxFixture {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    kind: String,
    unsigned_b64: String,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    num_instructions: usize,
    program_ids: Vec<String>,
    account_keys: Vec<String>,
    address_table_lookups: Vec<Lookup>,
}

#[derive(Deserialize)]
struct Lookup {
    account_key: String,
}

impl Vector {
    fn parse(&self) -> ParsedTx {
        let kind: TxKind = self
            .kind
            .parse()
            .unwrap_or_else(|err| panic!("{}: bad kind in fixture: {err}", self.name));
        let bytes = BASE64
            .decode(&self.unsigned_b64)
            .unwrap_or_else(|err| panic!("{}: bad base64 in fixture: {err}", self.name));
        ParsedTx::parse(kind, &bytes)
            .unwrap_or_else(|err| panic!("{}: parse failed: {err}", self.name))
    }
}

fn alt_fixture() -> &'static AltFixture {
    static FIXTURE: OnceLock<AltFixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/alt_vectors.json"))
            .expect("alt_vectors.json is not valid JSON for this schema")
    })
}

fn vector(name: &str) -> &'static Vector {
    static FIXTURE: OnceLock<TxFixture> = OnceLock::new();
    FIXTURE
        .get_or_init(|| {
            serde_json::from_str(include_str!("fixtures/tx_vectors.json"))
                .expect("tx_vectors.json is not valid JSON for this schema")
        })
        .vectors
        .iter()
        .find(|v| v.name == name)
        .unwrap_or_else(|| panic!("fixture has no vector named {name}"))
}

fn key(base58: &str) -> Pubkey {
    base58
        .parse()
        .unwrap_or_else(|err| panic!("fixture holds a bad pubkey {base58}: {err}"))
}

/// The on-chain bytes of the fixture's lookup table.
fn table_data() -> Vec<u8> {
    let fixture = alt_fixture();
    let data = BASE64
        .decode(&fixture.raw_account_data_b64)
        .expect("fixture holds valid base64");
    assert_eq!(
        data.len(),
        fixture.raw_account_data_len,
        "fixture disagrees with itself about the account data length"
    );
    data
}

/// A chain holding the fixture's lookup table and nothing else.
fn chain_with_table() -> MockRpc {
    MockRpc::new().with_data(
        key(&alt_fixture().alt_account_key),
        ALT_PROGRAM,
        table_data(),
    )
}

fn resolve(vector_name: &str, rpc: &MockRpc) -> ResolvedTx {
    alt::resolve(&vector(vector_name).parse(), rpc)
        .unwrap_or_else(|err| panic!("{vector_name}: resolve failed: {err}"))
}

fn strings(keys: &[Pubkey]) -> Vec<String> {
    keys.iter().map(ToString::to_string).collect()
}

/// Program ids deduplicated first-seen, which is what `extractProgramIds`
/// records in `expected.program_ids` for a versioned vector.
fn deduped_program_ids(resolved: &ResolvedTx) -> Vec<String> {
    let mut seen: Vec<Pubkey> = Vec::new();
    for ix in &resolved.instructions {
        if !seen.contains(&ix.program_id) {
            seen.push(ix.program_id);
        }
    }
    strings(&seen)
}

// ── 1. Expansion order ──────────────────────────────────────────────────────

#[test]
fn v0_with_alt_expands_to_the_account_keys_web3js_produced() {
    let resolved = resolve("v0_with_alt", &chain_with_table());
    assert_eq!(
        strings(&resolved.account_keys),
        vector("v0_with_alt").expected.account_keys,
        "expansion must be static ++ writable ++ readonly, in table order"
    );
}

#[test]
fn v0_with_alt_expansion_draws_from_the_table_in_index_order() {
    // Belt and braces on the vector above: the tail of the expanded list is the
    // fixture's own addresses picked out by the message's lookup indexes
    // (writable 0,1,4,5 then readonly 3), so a transposed group would show up
    // here even if the tx vector were regenerated wrong.
    let fixture = alt_fixture();
    let expected: Vec<String> = [0usize, 1, 4, 5, 3]
        .iter()
        .map(|i| fixture.addresses[*i].clone())
        .collect();

    let resolved = resolve("v0_with_alt", &chain_with_table());
    let statics = resolved.account_keys.len() - expected.len();
    assert_eq!(strings(&resolved.account_keys[statics..]), expected);
}

#[test]
fn v0_with_alt_program_ids_resolve_after_expansion() {
    let resolved = resolve("v0_with_alt", &chain_with_table());
    let expected = &vector("v0_with_alt").expected;
    assert_eq!(deduped_program_ids(&resolved), expected.program_ids);
    assert_eq!(resolved.instructions.len(), expected.num_instructions);
}

#[test]
fn v0_with_alt_instruction_operands_index_into_the_expanded_keys() {
    // The `transfers` block of the tx vector records the destination web3.js
    // resolves for each instruction; reproducing it through `operand` is what ties
    // the expansion to the policy engine's view of a transfer.
    let resolved = resolve("v0_with_alt", &chain_with_table());
    let transfer = &resolved.instructions[0];
    assert_eq!(transfer.data[0], 3, "instruction 0 is an SPL Transfer");
    assert_eq!(
        resolved.operand(transfer, 1).map(|k| k.to_string()),
        Some("CnEDk9HrMnmiHXEV1WFgbVCRteYnPqsJwrTdcZaNhFVW".to_owned())
    );

    let checked = &resolved.instructions[1];
    assert_eq!(checked.data[0], 12, "instruction 1 is a TransferChecked");
    assert_eq!(
        resolved.operand(checked, 1).map(|k| k.to_string()),
        Some("CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU".to_owned()),
        "TransferChecked operand 1 is the mint"
    );
    assert_eq!(
        resolved.operand(checked, 2).map(|k| k.to_string()),
        Some("FR5pWwinRBn35GNhg7bsvw8Q13kRept2pm561DwZCQzT".to_owned()),
        "TransferChecked operand 2 is the destination"
    );
}

#[test]
fn every_lookup_table_is_fetched_in_one_batched_call() {
    let rpc = chain_with_table();
    let _ = resolve("v0_with_alt", &rpc);
    assert_eq!(
        rpc.batch_calls(),
        1,
        "one getMultipleAccountsInfo, not one per table"
    );
    assert_eq!(
        rpc.single_calls(),
        0,
        "expansion never reads accounts one at a time"
    );
}

// ── 2. Transactions that need no table ──────────────────────────────────────

#[test]
fn a_v0_message_without_lookups_resolves_from_its_static_keys_alone() {
    let rpc = MockRpc::new();
    let resolved = resolve("v0_no_alt", &rpc);
    let expected = &vector("v0_no_alt").expected;

    assert!(expected.address_table_lookups.is_empty());
    assert_eq!(strings(&resolved.account_keys), expected.account_keys);
    assert_eq!(deduped_program_ids(&resolved), expected.program_ids);
    assert_eq!(
        (rpc.batch_calls(), rpc.single_calls()),
        (0, 0),
        "a message with no lookups must not touch the network"
    );
}

#[test]
fn legacy_transactions_resolve_without_touching_the_network() {
    for name in ["legacy_spl_transfer", "legacy_two_signer_presigned"] {
        let rpc = MockRpc::new();
        let resolved = resolve(name, &rpc);
        let expected = &vector(name).expected;

        assert_eq!(
            (rpc.batch_calls(), rpc.single_calls()),
            (0, 0),
            "{name}: a legacy message has no lookup tables"
        );
        assert_eq!(
            resolved.instructions.len(),
            expected.num_instructions,
            "{name}: instruction count"
        );

        // Legacy `program_ids` in the fixture keeps duplicates — one entry per
        // instruction, which is exactly what `instructions` yields.
        let program_ids: Vec<String> = resolved
            .instructions
            .iter()
            .map(|ix| ix.program_id.to_string())
            .collect();
        assert_eq!(program_ids, expected.program_ids, "{name}: program ids");
    }
}

#[test]
fn legacy_account_keys_are_a_superset_of_what_the_typescript_collects() {
    // The documented divergence: the TS legacy branch flattens keys off the
    // instructions, this reads `message.account_keys`. Every key the TS sees must
    // still be present — a different *order* is fine because nothing indexes into
    // the TS list, but a missing key would be a real hole.
    for name in ["legacy_spl_transfer", "legacy_two_signer_presigned"] {
        let resolved = resolve(name, &MockRpc::new());
        let resolved_keys = strings(&resolved.account_keys);
        for expected in &vector(name).expected.account_keys {
            assert!(
                resolved_keys.contains(expected),
                "{name}: {expected} is in the TypeScript key list but not the ported one"
            );
        }
    }
}

// ── 3. Failures ─────────────────────────────────────────────────────────────

#[test]
fn a_missing_lookup_table_is_reported_with_its_key() {
    // Named from the transaction's own lookup list rather than the table fixture,
    // so the error has to point at the table the *message* asked for.
    let table = &vector("v0_with_alt").expected.address_table_lookups[0].account_key;
    assert_eq!(
        table,
        &alt_fixture().alt_account_key,
        "the two fixtures pair up"
    );

    let err = alt::resolve(&vector("v0_with_alt").parse(), &MockRpc::new())
        .expect_err("the table is not on the mock chain");
    assert_eq!(
        err.to_string(),
        format!("ALT resolution failed: ALT account not found: {table}"),
        "the wrapped reason is what checkPolicy puts on the wire"
    );
}

#[test]
fn an_rpc_failure_during_expansion_is_reported_as_an_alt_failure() {
    let err = alt::resolve(
        &vector("v0_with_alt").parse(),
        &MockRpc::failing("connection reset"),
    )
    .expect_err("the endpoint is down");
    assert_eq!(
        err.to_string(),
        "ALT resolution failed: RPC request failed: connection reset"
    );
}

#[test]
fn an_account_that_is_not_a_lookup_table_is_rejected() {
    let table = key(&alt_fixture().alt_account_key);
    // Meta says "uninitialized" (type index 0) rather than "lookup table".
    let rpc = MockRpc::new().with_data(table, ALT_PROGRAM, vec![0u8; 56]);
    let err = alt::resolve(&vector("v0_with_alt").parse(), &rpc)
        .expect_err("uninitialized account data is not a table");
    let message = err.to_string();
    assert!(
        message.starts_with(&format!(
            "ALT resolution failed: ALT account is not a valid lookup table: {table} ("
        )),
        "unexpected reason: {message}"
    );
}

#[test]
fn a_lookup_index_past_the_end_of_the_table_is_rejected() {
    // Keep the meta but only the first two addresses, so the message's writable
    // index 4 has nothing to resolve against.
    let mut truncated = table_data();
    truncated.truncate(56 + 2 * 32);

    let table = key(&alt_fixture().alt_account_key);
    let rpc = MockRpc::new().with_data(table, ALT_PROGRAM, truncated);
    let err = alt::resolve(&vector("v0_with_alt").parse(), &rpc)
        .expect_err("index 4 is past the end of a two-address table");
    assert_eq!(
        err.to_string(),
        format!("ALT resolution failed: Failed to find address for index 4 in address lookup table {table}")
    );
}

#[test]
fn an_out_of_range_program_id_index_is_rejected() {
    // The documented fail-closed divergence: `extractProgramIds` guards this
    // lookup with `if (programId)`, so in the TypeScript the instruction drops out
    // of the allowlist check entirely. Such a message cannot execute — the runtime
    // rejects it during sanitization — so refusing is free.
    let tx = ParsedTx::Versioned(VersionedTransaction {
        signatures: vec![Signature::default()],
        message: VersionedMessage::V0(v0::Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 0,
            },
            account_keys: vec![Pubkey::new_unique()],
            recent_blockhash: Hash::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 9,
                accounts: Vec::new(),
                data: Vec::new(),
            }],
            address_table_lookups: Vec::new(),
        }),
    });

    let err = alt::resolve(&tx, &MockRpc::new()).expect_err("account index 9 does not exist");
    assert_eq!(
        err.to_string(),
        "Instruction 0 references program id index 9, which is outside the transaction's account list"
    );
}

#[test]
fn writable_addresses_from_every_table_precede_the_first_readonly_one() {
    // The single-table fixture cannot tell "static ++ writable ++ readonly" apart
    // from "static ++ per-table (writable ++ readonly)". Two tables can, and
    // getting it wrong repoints every account index past the static keys.
    //
    // The second table is the fixture's own, with its address block reversed, so
    // both tables are real lookup tables holding known addresses.
    let addresses = &alt_fixture().addresses;
    let table_a = key(&alt_fixture().alt_account_key);
    let table_b = Pubkey::new_unique();

    let data_a = table_data();
    let mut data_b = data_a[..56].to_vec();
    for chunk in data_a[56..].chunks(32).rev() {
        data_b.extend_from_slice(chunk);
    }

    let payer = Pubkey::new_unique();
    let tx = ParsedTx::Versioned(VersionedTransaction {
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
                accounts: vec![2, 3, 4, 5],
                data: vec![3],
            }],
            address_table_lookups: vec![
                v0::MessageAddressTableLookup {
                    account_key: table_a,
                    writable_indexes: vec![0],
                    readonly_indexes: vec![2],
                },
                v0::MessageAddressTableLookup {
                    account_key: table_b,
                    writable_indexes: vec![3],
                    readonly_indexes: vec![4],
                },
            ],
        }),
    });

    let rpc = MockRpc::new()
        .with_data(table_a, ALT_PROGRAM, data_a)
        .with_data(table_b, ALT_PROGRAM, data_b);
    let resolved = alt::resolve(&tx, &rpc).expect("both tables are on the mock chain");

    // Reversing the block maps table B's index `i` to address `7 - i`.
    assert_eq!(
        strings(&resolved.account_keys),
        vec![
            payer.to_string(),
            TOKEN_PROGRAM.to_string(),
            addresses[0].clone(), // table A, writable
            addresses[4].clone(), // table B, writable
            addresses[2].clone(), // table A, readonly
            addresses[3].clone(), // table B, readonly
        ]
    );
    assert_eq!(rpc.batch_calls(), 1, "both tables in one round trip");
}

// ── 4. Instruction view ─────────────────────────────────────────────────────

#[test]
fn instruction_data_survives_resolution_verbatim() {
    // The policy engine reads `data[0]` as the SPL discriminator, so a lossy copy
    // here would silently disable every token rule.
    let resolved = resolve("v0_with_alt", &chain_with_table());
    for (ix, expected_disc) in resolved.instructions.iter().zip([3u8, 12]) {
        assert!(
            ix.program_id == TOKEN_PROGRAM || ix.program_id == TOKEN_2022,
            "the vector's instructions are both SPL token calls"
        );
        assert_eq!(ix.data.first().copied(), Some(expected_disc));
        assert!(
            ix.data.len() > 1,
            "an SPL transfer carries an amount after the discriminator"
        );
    }
}

#[test]
fn account_indexes_stay_within_the_resolved_key_list() {
    for name in [
        "legacy_spl_transfer",
        "legacy_two_signer_presigned",
        "v0_no_alt",
    ] {
        let resolved = resolve(name, &MockRpc::new());
        for (position, ix) in resolved.instructions.iter().enumerate() {
            for index in &ix.account_indexes {
                assert!(
                    usize::from(*index) < resolved.account_keys.len(),
                    "{name}: instruction {position} indexes account {index} of {}",
                    resolved.account_keys.len()
                );
            }
        }
    }
    let resolved = resolve("v0_with_alt", &chain_with_table());
    for ix in &resolved.instructions {
        for index in &ix.account_indexes {
            assert!(usize::from(*index) < resolved.account_keys.len());
        }
    }
}
