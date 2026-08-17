//! Scenario matrix for `signer_core::policy` — the static half of `checkPolicy`.
//!
//! These are hand-built [`ResolvedTx`] values rather than fixture bytes on
//! purpose. `alt_golden.rs` already proves that real transactions resolve into
//! the right [`ResolvedTx`]; what is left to pin down is the decision table, and
//! a decision table wants one transaction per cell — a transfer whose destination
//! is a whitelisted owner's ATA, the same transfer without the mint, the same
//! transfer with a DEX instruction beside it. Recording those as encoder output
//! would bury the one varying detail under a base64 blob.
//!
//! Every rejection asserts the reason string verbatim. The strings are the
//! compatibility surface between this signer and the TypeScript one — the bot
//! logs them and an operator reads them — so a reworded message is a breaking
//! change and should fail here.

use signer_core::{
    alt::{IxView, ResolvedTx},
    config::{
        dex_programs, program_allowlist, PolicyConfig, ASSOCIATED_TOKEN_PROGRAM, BYREAL_CLMM,
        JUPITER_V6, ORCA_WHIRLPOOL, SYSTEM_PROGRAM, TOKEN_2022, TOKEN_PROGRAM,
    },
    policy::{PolicyEngine, Verdict},
    rpc::MockRpc,
};
use solana_sdk::pubkey::Pubkey;

// ── SPL instruction data ────────────────────────────────────────────────────
//
// Only byte 0 is read by the policy engine; the rest is shaped like the real
// instruction so the fixtures stay recognisable.

fn transfer_data() -> Vec<u8> {
    let mut data = vec![3u8];
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    data
}

fn approve_data() -> Vec<u8> {
    let mut data = vec![4u8];
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    data
}

fn set_authority_data() -> Vec<u8> {
    vec![6u8, 2, 1]
}

fn transfer_checked_data() -> Vec<u8> {
    let mut data = vec![12u8];
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    data.push(6);
    data
}

// ── Builders ────────────────────────────────────────────────────────────────

/// Assembles a [`ResolvedTx`], interning account keys as instructions name them.
#[derive(Default)]
struct Tx {
    keys: Vec<Pubkey>,
    instructions: Vec<IxView>,
}

impl Tx {
    fn new() -> Self {
        Self::default()
    }

    fn intern(&mut self, key: Pubkey) -> u16 {
        let position = self
            .keys
            .iter()
            .position(|existing| *existing == key)
            .unwrap_or_else(|| {
                self.keys.push(key);
                self.keys.len() - 1
            });
        u16::try_from(position).expect("test transactions stay small")
    }

    /// Appends an instruction, resolving `accounts` to indexes.
    fn ix(mut self, program: Pubkey, accounts: &[Pubkey], data: Vec<u8>) -> Self {
        self.intern(program);
        let mut account_indexes = Vec::with_capacity(accounts.len());
        for account in accounts {
            account_indexes.push(self.intern(*account));
        }
        self.instructions.push(IxView {
            program_id: program,
            account_indexes,
            data,
        });
        self
    }

    /// Appends an instruction with hand-written account indexes, for the
    /// out-of-range cases a well-formed transaction cannot express.
    fn raw_ix(mut self, program: Pubkey, account_indexes: &[u16], data: Vec<u8>) -> Self {
        self.intern(program);
        self.instructions.push(IxView {
            program_id: program,
            account_indexes: account_indexes.to_vec(),
            data,
        });
        self
    }

    fn build(self) -> ResolvedTx {
        ResolvedTx {
            account_keys: self.keys,
            instructions: self.instructions,
        }
    }
}

/// An engine whose destination whitelist holds exactly `whitelist`.
fn engine(whitelist: &[Pubkey]) -> PolicyEngine {
    PolicyEngine::new(PolicyConfig {
        program_allowlist: program_allowlist(BYREAL_CLMM),
        dex_programs: dex_programs(BYREAL_CLMM),
        destination_whitelist: whitelist.iter().copied().collect(),
        jupiter: JUPITER_V6,
    })
}

/// The associated token account web3.js would derive for this owner and mint.
fn ata(owner: Pubkey, mint: Pubkey, token_program: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    )
    .0
}

#[track_caller]
fn assert_allowed(verdict: &Verdict) {
    assert!(
        verdict.is_allowed(),
        "expected the transaction to be signed, got: {}",
        verdict.reason().unwrap_or_default()
    );
}

#[track_caller]
fn assert_denied(verdict: &Verdict, reason: &str) {
    assert_eq!(verdict.reason(), Some(reason));
}

// ── 1. Program allowlist ────────────────────────────────────────────────────

#[test]
fn an_unknown_program_is_denied_by_name() {
    let stranger = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(stranger, &[Pubkey::new_unique()], vec![0])
        .build();

    let verdict = engine(&[]).check_static(&tx, &MockRpc::new());
    assert_denied(&verdict, &format!("Unknown program: {stranger}"));
}

#[test]
fn allowlisted_programs_pass_the_first_gate() {
    let tx = Tx::new()
        .ix(SYSTEM_PROGRAM, &[Pubkey::new_unique()], vec![2, 0, 0, 0])
        .ix(BYREAL_CLMM, &[Pubkey::new_unique()], vec![0xaa])
        .build();

    assert_allowed(&engine(&[]).check_static(&tx, &MockRpc::new()));
}

#[test]
fn the_allowlist_pass_outranks_the_spl_pass() {
    // A SetAuthority sitting *before* the unknown program still loses: the
    // TypeScript walks every program id before it looks at a single instruction's
    // data, and an operator debugging a rejection needs the same reason from both.
    let stranger = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), Pubkey::new_unique()],
            set_authority_data(),
        )
        .ix(stranger, &[], vec![0])
        .build();

    let verdict = engine(&[]).check_static(&tx, &MockRpc::new());
    assert_denied(&verdict, &format!("Unknown program: {stranger}"));
}

#[test]
fn the_verdict_reports_whether_a_dex_program_was_involved() {
    let plain = Tx::new()
        .ix(SYSTEM_PROGRAM, &[Pubkey::new_unique()], vec![2])
        .build();
    assert_eq!(
        engine(&[]).check_static(&plain, &MockRpc::new()),
        Verdict::Allow {
            has_dex_instruction: false
        }
    );

    let swap = Tx::new()
        .ix(JUPITER_V6, &[Pubkey::new_unique()], vec![0xe5])
        .build();
    assert_eq!(
        engine(&[]).check_static(&swap, &MockRpc::new()),
        Verdict::Allow {
            has_dex_instruction: true
        }
    );
}

// ── 2. SetAuthority ─────────────────────────────────────────────────────────

#[test]
fn set_authority_is_denied_under_both_token_programs() {
    for program in [TOKEN_PROGRAM, TOKEN_2022] {
        let tx = Tx::new()
            .ix(
                program,
                &[Pubkey::new_unique(), Pubkey::new_unique()],
                set_authority_data(),
            )
            .build();

        let verdict = engine(&[]).check_static(&tx, &MockRpc::new());
        assert_denied(
            &verdict,
            "SPL SetAuthority is blocked — potential authority hijack",
        );
    }
}

#[test]
fn set_authority_is_denied_even_alongside_a_dex_instruction() {
    // Unlike a transfer, there is no swap-flow exemption: nothing legitimate the
    // bot does hands the token account's authority to someone else.
    let tx = Tx::new()
        .ix(BYREAL_CLMM, &[Pubkey::new_unique()], vec![0xaa])
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), Pubkey::new_unique()],
            set_authority_data(),
        )
        .build();

    let verdict = engine(&[]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        "SPL SetAuthority is blocked — potential authority hijack",
    );
}

// ── 3. Approve ──────────────────────────────────────────────────────────────

#[test]
fn approve_to_a_whitelisted_delegate_is_allowed() {
    let delegate = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), delegate, Pubkey::new_unique()],
            approve_data(),
        )
        .build();

    assert_allowed(&engine(&[delegate]).check_static(&tx, &MockRpc::new()));
}

#[test]
fn approve_to_an_unknown_delegate_is_denied() {
    let delegate = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), delegate, Pubkey::new_unique()],
            approve_data(),
        )
        .build();

    let verdict = engine(&[Pubkey::new_unique()]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("SPL Approve to non-whitelisted delegate: {delegate}"),
    );
}

#[test]
fn approve_reads_the_delegate_from_the_second_account() {
    // Approve is [source, delegate, owner]. Whitelisting the *source* must not
    // launder the approval — this fails if the operand index slips to 0.
    let source = Pubkey::new_unique();
    let delegate = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[source, delegate, Pubkey::new_unique()],
            approve_data(),
        )
        .build();

    let verdict = engine(&[source]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("SPL Approve to non-whitelisted delegate: {delegate}"),
    );
}

#[test]
fn approve_to_an_unknown_delegate_is_allowed_alongside_a_dex_instruction() {
    let delegate = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(ORCA_WHIRLPOOL, &[Pubkey::new_unique()], vec![0x0b])
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), delegate, Pubkey::new_unique()],
            approve_data(),
        )
        .build();

    assert_allowed(&engine(&[]).check_static(&tx, &MockRpc::new()));
}

#[test]
fn approve_is_enforced_for_token_2022_too() {
    let delegate = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_2022,
            &[Pubkey::new_unique(), delegate, Pubkey::new_unique()],
            approve_data(),
        )
        .build();

    let verdict = engine(&[]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("SPL Approve to non-whitelisted delegate: {delegate}"),
    );
}

// ── 4. Transfer destination chain ───────────────────────────────────────────

#[test]
fn a_transfer_to_a_whitelisted_destination_is_allowed_without_an_rpc_call() {
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let rpc = MockRpc::new();
    assert_allowed(&engine(&[dest]).check_static(&tx, &rpc));
    assert_eq!(
        rpc.single_calls(),
        0,
        "the cheap exemptions must short-circuit before the network"
    );
}

#[test]
fn a_transfer_checked_to_the_ata_of_a_whitelisted_owner_is_allowed() {
    // The dashboard whitelists a *wallet*; the transfer targets that wallet's ATA.
    let owner = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let dest = ata(owner, mint, TOKEN_PROGRAM);

    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), mint, dest, Pubkey::new_unique()],
            transfer_checked_data(),
        )
        .build();

    assert_allowed(&engine(&[owner]).check_static(&tx, &MockRpc::new()));
}

#[test]
fn the_ata_rule_derives_against_the_instructions_own_token_program() {
    let owner = Pubkey::new_unique();
    let mint = Pubkey::new_unique();

    // Token-2022 transfer to the Token-2022 ATA: allowed.
    let dest_2022 = ata(owner, mint, TOKEN_2022);
    let matching = Tx::new()
        .ix(
            TOKEN_2022,
            &[Pubkey::new_unique(), mint, dest_2022, Pubkey::new_unique()],
            transfer_checked_data(),
        )
        .build();
    assert_allowed(&engine(&[owner]).check_static(&matching, &MockRpc::new()));

    // Token-2022 transfer to the *legacy* ATA of the same owner and mint: a
    // different address, and not one the whitelist vouches for.
    let dest_legacy = ata(owner, mint, TOKEN_PROGRAM);
    assert_ne!(dest_2022, dest_legacy);
    let mismatched = Tx::new()
        .ix(
            TOKEN_2022,
            &[
                Pubkey::new_unique(),
                mint,
                dest_legacy,
                Pubkey::new_unique(),
            ],
            transfer_checked_data(),
        )
        .build();
    let verdict = engine(&[owner]).check_static(&mismatched, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest_legacy}"),
    );
}

#[test]
fn a_transfer_checked_to_the_ata_of_an_unlisted_owner_is_denied() {
    let mint = Pubkey::new_unique();
    let dest = ata(Pubkey::new_unique(), mint, TOKEN_PROGRAM);

    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), mint, dest, Pubkey::new_unique()],
            transfer_checked_data(),
        )
        .build();

    let verdict = engine(&[Pubkey::new_unique()]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest}"),
    );
}

#[test]
fn a_plain_transfer_cannot_use_the_ata_rule() {
    // `Transfer` carries no mint, so the derivation is unavailable even when the
    // destination happens to be a whitelisted owner's ATA. Matches the TypeScript,
    // where `mintAddress` is `undefined` outside `TransferChecked`.
    let owner = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let dest = ata(owner, mint, TOKEN_PROGRAM);

    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let verdict = engine(&[owner]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest}"),
    );
}

#[test]
fn a_transfer_alongside_a_dex_instruction_is_allowed() {
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(BYREAL_CLMM, &[Pubkey::new_unique()], vec![0xaa])
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let rpc = MockRpc::new();
    assert_allowed(&engine(&[]).check_static(&tx, &rpc));
    assert_eq!(
        rpc.single_calls(),
        0,
        "the DEX exemption comes before the RPC"
    );
}

#[test]
fn a_transfer_to_a_program_owned_account_is_allowed() {
    // A pool vault: owned by an allowlisted program rather than by System.
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let rpc = MockRpc::new().owned_by(dest, ORCA_WHIRLPOOL);
    assert_allowed(&engine(&[]).check_static(&tx, &rpc));
    assert_eq!(rpc.single_calls(), 1);
}

#[test]
fn a_transfer_to_a_system_owned_account_is_denied() {
    // The System Program is on the allowlist, so this is the one owner that has to
    // be excluded by name — a system-owned account is somebody's wallet.
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let rpc = MockRpc::new().owned_by(dest, SYSTEM_PROGRAM);
    let verdict = engine(&[]).check_static(&tx, &rpc);
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest}"),
    );
}

#[test]
fn a_transfer_to_an_account_owned_by_an_unlisted_program_is_denied() {
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let rpc = MockRpc::new().owned_by(dest, Pubkey::new_unique());
    let verdict = engine(&[]).check_static(&tx, &rpc);
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest}"),
    );
}

#[test]
fn a_transfer_to_an_account_that_does_not_exist_is_denied() {
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let verdict = engine(&[]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest}"),
    );
}

#[test]
fn an_rpc_failure_denies_the_transfer_rather_than_waving_it_through() {
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), dest, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let verdict = engine(&[]).check_static(&tx, &MockRpc::failing("502 Bad Gateway"));
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest}"),
    );
}

#[test]
fn transfer_checked_reads_the_destination_from_the_third_account() {
    // TransferChecked is [source, mint, destination, authority]. Whitelisting the
    // mint must not launder the transfer — this fails if the operand index slips.
    let mint = Pubkey::new_unique();
    let dest = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), mint, dest, Pubkey::new_unique()],
            transfer_checked_data(),
        )
        .build();

    let verdict = engine(&[mint]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {dest}"),
    );
}

#[test]
fn the_first_offending_transfer_decides() {
    let first = Pubkey::new_unique();
    let second = Pubkey::new_unique();
    let tx = Tx::new()
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), first, Pubkey::new_unique()],
            transfer_data(),
        )
        .ix(
            TOKEN_PROGRAM,
            &[Pubkey::new_unique(), second, Pubkey::new_unique()],
            transfer_data(),
        )
        .build();

    let verdict = engine(&[]).check_static(&tx, &MockRpc::new());
    assert_denied(
        &verdict,
        &format!("Standalone SPL transfer to non-whitelisted address: {first}"),
    );
}

// ── 5. Instructions the rules do not reach ──────────────────────────────────

#[test]
fn the_spl_rules_do_not_apply_to_other_programs() {
    // Discriminator 6 means SetAuthority only inside a token program. Elsewhere it
    // is just a byte, and the Associated Token Account program is not a DEX either,
    // so nothing here is exempted for the wrong reason.
    let tx = Tx::new()
        .ix(
            ASSOCIATED_TOKEN_PROGRAM,
            &[Pubkey::new_unique(), Pubkey::new_unique()],
            set_authority_data(),
        )
        .build();

    assert_eq!(
        engine(&[]).check_static(&tx, &MockRpc::new()),
        Verdict::Allow {
            has_dex_instruction: false
        }
    );
}

#[test]
fn a_token_instruction_with_no_data_is_ignored() {
    let tx = Tx::new()
        .ix(TOKEN_PROGRAM, &[Pubkey::new_unique()], Vec::new())
        .build();

    assert_allowed(&engine(&[]).check_static(&tx, &MockRpc::new()));
}

#[test]
fn an_unhandled_token_discriminator_is_ignored() {
    // 7 is MintTo, 8 Burn, 9 CloseAccount, 17 SyncNative — none of them can move
    // the wallet's tokens to a third party, and the TypeScript ignores them all.
    for discriminator in [7u8, 8, 9, 17] {
        let tx = Tx::new()
            .ix(
                TOKEN_PROGRAM,
                &[Pubkey::new_unique(), Pubkey::new_unique()],
                vec![discriminator, 0, 0],
            )
            .build();

        assert_allowed(&engine(&[]).check_static(&tx, &MockRpc::new()));
    }
}

#[test]
fn a_transfer_missing_its_destination_operand_is_ignored() {
    // Too few accounts for the layout: the SPL Token program rejects the
    // instruction outright, so there is no destination to police. Mirrors
    // `allKeys[ix.accountKeyIndexes[1]]?.toBase58()` yielding `undefined`.
    let tx = Tx::new()
        .ix(TOKEN_PROGRAM, &[Pubkey::new_unique()], transfer_data())
        .build();

    assert_allowed(&engine(&[]).check_static(&tx, &MockRpc::new()));
}

#[test]
fn a_transfer_whose_destination_index_is_out_of_range_is_ignored() {
    // Same reasoning, reached the other way: the index exists but points past the
    // account list, so the message fails runtime sanitization before execution.
    let tx = Tx::new()
        .raw_ix(TOKEN_PROGRAM, &[0, 250, 0], transfer_data())
        .build();

    assert_allowed(&engine(&[]).check_static(&tx, &MockRpc::new()));
}

#[test]
fn an_empty_transaction_is_allowed_with_no_dex_flag() {
    let tx = Tx::new().build();
    assert_eq!(
        engine(&[]).check_static(&tx, &MockRpc::new()),
        Verdict::Allow {
            has_dex_instruction: false
        }
    );
}
