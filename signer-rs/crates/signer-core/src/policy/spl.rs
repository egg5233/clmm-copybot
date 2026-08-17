//! SPL token rules — `policy.ts:102-172` and `checkTransferDestination`.
//!
//! Three instructions in the two token programs can move value out of the wallet
//! without a DEX program's involvement, and each gets its own rule:
//!
//! | Discriminator | Instruction | Rule |
//! |---|---|---|
//! | 3 | `Transfer` | destination must clear [`check_transfer`]'s chain |
//! | 4 | `Approve` | delegate must clear the same bar as a destination |
//! | 6 | `SetAuthority` | always refused |
//! | 12 | `TransferChecked` | as `Transfer`, plus the mint enables the ATA rule |
//!
//! Anything else — `MintTo`, `Burn`, `CloseAccount`, `SyncNative`, an instruction
//! with empty data — is ignored, matching the TypeScript's `else if` chain.
//!
//! # Divergences from `signer/policy.ts`
//!
//! * **`Approve` is enforced, not logged.** See
//!   [`PolicyError::ApproveToNonWhitelistedDelegate`].
//! * **Both transaction kinds get every rule.** The TypeScript keeps two copies of
//!   this pass, one per branch, and the legacy copy has no `Approve` case at all
//!   (`policy.ts:146-171`) — a legacy transaction could approve any delegate
//!   without so much as a log line. There is one copy here, reading the
//!   [`ResolvedTx`] both encodings collapse into.

use solana_sdk::pubkey::Pubkey;

use crate::alt::{IxView, ResolvedTx};
use crate::config::{
    PolicyConfig, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022, TOKEN_PROGRAM,
};
use crate::error::PolicyError;
use crate::rpc::SolanaRpc;

/// `Transfer` — accounts are `[source, destination, authority]`.
pub const TRANSFER: u8 = 3;
/// `Approve` — accounts are `[source, delegate, owner]`.
pub const APPROVE: u8 = 4;
/// `SetAuthority` — accounts are `[account_or_mint, current_authority]`.
pub const SET_AUTHORITY: u8 = 6;
/// `TransferChecked` — accounts are `[source, mint, destination, authority]`.
pub const TRANSFER_CHECKED: u8 = 12;

/// Whether `program` is one of the two SPL token programs the rules apply to.
///
/// Both are checked in every branch of the TypeScript, and both matter here:
/// Byreal position NFTs are Token-2022, so a Token-2022-only rule set would leave
/// the newer program unguarded.
#[must_use]
pub fn is_token_program(program: Pubkey) -> bool {
    program == TOKEN_PROGRAM || program == TOKEN_2022
}

/// Applies the SPL rules to one instruction, returning the rejection if any.
///
/// Instructions outside the token programs, and token instructions whose
/// discriminator is not one of the four above, are `None` without further work.
#[must_use]
pub fn check(
    config: &PolicyConfig,
    resolved: &ResolvedTx,
    ix: &IxView,
    has_dex_instruction: bool,
    rpc: &dyn SolanaRpc,
) -> Option<PolicyError> {
    if !is_token_program(ix.program_id) {
        return None;
    }

    // `ix.data[0]` on an empty buffer is `undefined` in JS, which matches no
    // discriminator and falls through the chain.
    match *ix.data.first()? {
        SET_AUTHORITY => Some(PolicyError::SetAuthorityBlocked),
        APPROVE => check_approve(config, resolved, ix, has_dex_instruction),
        disc @ (TRANSFER | TRANSFER_CHECKED) => {
            check_transfer(config, resolved, ix, disc, has_dex_instruction, rpc)
        }
        _ => None,
    }
}

/// `Approve` grants a delegate standing authority to move the source account's
/// tokens, with no amount limit the signer can see once the transaction lands.
///
/// So it is held to the same bar as sending the tokens there directly, minus the
/// two rules that need something an approve does not carry: there is no mint in
/// the instruction (so no ATA derivation) and no destination account to classify
/// by owner (a delegate is a wallet or a program, and the RPC check exists to
/// recognise *token* accounts owned by a DEX).
fn check_approve(
    config: &PolicyConfig,
    resolved: &ResolvedTx,
    ix: &IxView,
    has_dex_instruction: bool,
) -> Option<PolicyError> {
    let delegate = resolved.operand(ix, 1)?;
    if config.destination_whitelist.contains(&delegate) || has_dex_instruction {
        return None;
    }
    Some(PolicyError::ApproveToNonWhitelistedDelegate(delegate))
}

/// The destination chain from `checkTransferDestination`, in its original order.
///
/// Order is load bearing — each step is cheaper than the next, and the last one
/// costs an RPC round trip:
///
/// 1. The destination is explicitly whitelisted (the daily auto-convert's target).
/// 2. `TransferChecked` only: it is the associated token account of a whitelisted
///    *owner*. The dashboard takes a wallet address, but the transfer targets that
///    wallet's ATA, so the whitelist is matched both ways.
/// 3. The transaction also calls a DEX program, so the transfer is part of a swap
///    or LP flow (a WSOL wrap, an intermediate account) rather than an exfiltration.
/// 4. The destination exists on chain and is owned by an allowlisted program that
///    is not the System Program — a pool vault. A system-owned account is somebody's
///    wallet and is never a safe destination.
///
/// Falling off the end is a standalone transfer to an address nothing vouches for.
fn check_transfer(
    config: &PolicyConfig,
    resolved: &ResolvedTx,
    ix: &IxView,
    discriminator: u8,
    has_dex_instruction: bool,
    rpc: &dyn SolanaRpc,
) -> Option<PolicyError> {
    let (dest_position, mint_position) = if discriminator == TRANSFER {
        (1, None)
    } else {
        (2, Some(1))
    };

    let dest = resolved.operand(ix, dest_position)?;
    let mint = mint_position.and_then(|position| resolved.operand(ix, position));

    if config.destination_whitelist.contains(&dest) {
        return None;
    }

    if let Some(mint) = mint {
        if is_ata_for_whitelisted_owner(config, dest, mint, ix.program_id) {
            return None;
        }
    }

    if has_dex_instruction {
        return None;
    }

    // An RPC failure is not an exemption: the TypeScript logs and falls through to
    // the rejection, and so does this. Being unable to classify a destination is a
    // reason to refuse, not a reason to proceed.
    if let Ok(Some(account)) = rpc.get_account(&dest) {
        if account.owner != SYSTEM_PROGRAM && config.program_allowlist.contains(&account.owner) {
            return None;
        }
    }

    Some(PolicyError::NonWhitelistedTransfer(dest))
}

/// Whether `dest` is `ATA(owner, token_program, mint)` for any whitelisted owner.
///
/// `token_program` comes from the instruction rather than a constant, so a
/// Token-2022 transfer derives against Token-2022 — the ATA seeds include the
/// token program, and using the wrong one silently produces a different address.
fn is_ata_for_whitelisted_owner(
    config: &PolicyConfig,
    dest: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
) -> bool {
    config.destination_whitelist.iter().any(|owner| {
        let (ata, _bump) = Pubkey::find_program_address(
            &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
            &ASSOCIATED_TOKEN_PROGRAM,
        );
        ata == dest
    })
}
