//! Native SOL transfer rules — a gap `signer/policy.ts` never closed.
//!
//! `checkPolicy` inspects instructions belonging to the two SPL token programs
//! and nothing else. The System Program is on the allowlist (it has to be —
//! `CreateAccount`, `Assign` and the nonce instructions are load-bearing inside
//! the DEX SDK flows), so a bare `SystemProgram.transfer` moving lamports to an
//! arbitrary address cleared every check and was signed. That is a cheaper drain
//! than the SPL `Transfer` the same file blocks: it needs no token account, no
//! mint, nothing but the wallet's own lamports.
//!
//! This pass closes it, mirroring [`crate::policy::spl`]'s transfer chain minus
//! the steps that only make sense for tokens:
//!
//! | Discriminator | Instruction | Rule |
//! |---|---|---|
//! | 2 | `Transfer` | recipient (accounts[1]) must clear the chain below |
//! | 11 | `TransferWithSeed` | recipient (accounts[2]) must clear the same chain |
//!
//! The chain: the recipient is explicitly whitelisted, or the transaction also
//! calls a DEX program (a WSOL wrap or an SDK position-funding transfer rides
//! inside a swap/LP transaction). Falling off the end is a standalone SOL move to
//! an address nothing vouches for. There is no on-chain owner exemption as in the
//! SPL chain: an SPL transfer can legitimately target a pool vault owned by an
//! allowlisted program, but a lamport transfer to a program-owned account is not
//! part of any flow the bot performs, so the cheaper whitelist/DEX check is the
//! whole rule and no RPC round trip is spent here.
//!
//! Every other System instruction — `CreateAccount`, `Assign`, `Allocate`, the
//! nonce family — stays allowed exactly as the TypeScript left it: none of them
//! hands existing lamports to a third party the way a `Transfer` does.

use crate::alt::{IxView, ResolvedTx};
use crate::config::{PolicyConfig, SYSTEM_PROGRAM};
use crate::error::PolicyError;

/// `Transfer` — accounts are `[funding, recipient]`.
///
/// Verified against `solana_system_interface::instruction::SystemInstruction`:
/// the enum is `CreateAccount, Assign, Transfer, …`, so `Transfer` is variant 2,
/// and `#[account references]` names the recipient as account 1. The data is a
/// 4-byte little-endian bincode discriminator followed by `lamports: u64`; the
/// amount is never read here — the recipient comes from the account list, so the
/// policy needs only the discriminator to classify the instruction.
pub const TRANSFER: u32 = 2;
/// `TransferWithSeed` — accounts are `[funding, base, recipient]`.
///
/// Variant 11 of the same enum (`…, Allocate, AllocateWithSeed, AssignWithSeed,
/// TransferWithSeed, UpgradeNonceAccount`), whose account references list the
/// recipient at index 2 — the base signer sits between the funding account and
/// the recipient.
pub const TRANSFER_WITH_SEED: u32 = 11;

/// Applies the native-SOL rules to one instruction, returning the rejection if
/// any.
///
/// Instructions outside the System Program, and System instructions that are not
/// one of the two lamport-moving transfers, are `None` without further work. No
/// `rpc` argument: unlike the SPL chain, nothing here reaches the network.
#[must_use]
pub fn check(
    config: &PolicyConfig,
    resolved: &ResolvedTx,
    ix: &IxView,
    has_dex_instruction: bool,
) -> Option<PolicyError> {
    if ix.program_id != SYSTEM_PROGRAM {
        return None;
    }

    // Data too short to hold the 4-byte discriminator matches no variant and
    // falls through, the same no-match-is-allowed default `spl::check` takes for
    // an empty data buffer: such an instruction cannot execute, so refusing it
    // would guard nothing the bot can produce.
    let discriminator = u32::from_le_bytes(ix.data.get(0..4)?.try_into().ok()?);

    let recipient_position = match discriminator {
        TRANSFER => 1,
        TRANSFER_WITH_SEED => 2,
        _ => return None,
    };

    // A recipient index that is missing or out of range means the message would
    // fail runtime sanitization before it moved a lamport — nothing to police,
    // matching `ResolvedTx::operand` yielding `undefined` in the SPL chain.
    let recipient = resolved.operand(ix, recipient_position)?;

    if config.destination_whitelist.contains(&recipient) || has_dex_instruction {
        return None;
    }

    Some(PolicyError::StandaloneSolTransfer(recipient))
}
