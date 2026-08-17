//! Address lookup table expansion — a port of `signer/alt-resolver.ts`.
//!
//! A v0 message stores most of its accounts as `(table, index)` pairs. Until
//! those are resolved the signer cannot see which programs a transaction calls
//! or where its token transfers go, so [`resolve`] is the first thing
//! `checkPolicy` does and every later check reads its output.
//!
//! [`resolve`] turns either transaction kind into one flat [`ResolvedTx`], which
//! is what makes the policy engine indifferent to the encoding: `signer/policy.ts`
//! carries two nearly identical copies of every check, one per branch, and they
//! have already drifted (the legacy branch never looks at SPL `Approve`).
//!
//! # Ordering
//!
//! Expansion has to reproduce `MessageAccountKeys` from web3.js exactly, because
//! every account index in the message is an offset into it:
//!
//! ```text
//! static keys ++ writable from every lookup ++ readonly from every lookup
//! ```
//!
//! The two lookup groups are each concatenated in message order — *all* writable
//! addresses across all tables come before the first readonly one, which is also
//! how the Solana runtime builds `LoadedAddresses`. With a single lookup table
//! (the only shape the bot produces today) the distinction is invisible; with two
//! it is the difference between a correct account list and a scrambled one.
//!
//! # Divergences from `signer/alt-resolver.ts`
//!
//! * **Legacy account keys come from the message, not the instructions.** The TS
//!   legacy branch builds its key list by flattening `[programId, ...keys]` over
//!   the instructions and deduplicating. That is a subset of `message.account_keys`
//!   — it drops the fee payer when no instruction names it, and reorders the rest.
//!   Using the message's own list here is a strict superset in the same coordinate
//!   space the instruction indexes already use, and nothing downstream reads the
//!   list positionally in a way the TS order would change: the TS legacy branch
//!   resolves transfer operands from the parsed instruction's own key array, never
//!   through the flattened list, and never indexes into it at all.
//! * **An unresolvable program id is rejected.** See
//!   [`PolicyError::UnresolvableProgramId`].
//! * **A deactivated lookup table still resolves.** `AddressLookupTable::lookup`
//!   would filter addresses by slot; web3.js does not, and neither does this —
//!   the signer decides *what* a transaction does, and the runtime decides
//!   whether the table is still usable.

use solana_address_lookup_table_interface::state::AddressLookupTable;
use solana_sdk::{message::VersionedMessage, pubkey::Pubkey};

use crate::error::{PolicyError, TxError};
use crate::rpc::SolanaRpc;
use crate::tx::ParsedTx;

/// A transaction with every account key materialised, ready for policy checks.
///
/// The two transaction encodings collapse into this one shape — see the module
/// docs for the ordering [`ResolvedTx::account_keys`] guarantees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTx {
    /// Every account the transaction touches, in message index order.
    pub account_keys: Vec<Pubkey>,
    /// The top-level instructions, in message order.
    pub instructions: Vec<IxView>,
}

impl ResolvedTx {
    /// The account at `position` in an instruction's account list.
    ///
    /// `None` if the instruction has no such operand or the index it holds is out
    /// of range — the two cases where `allKeys[ix.accountKeyIndexes[n]]?.toBase58()`
    /// yields `undefined` in `signer/policy.ts`. Callers treat that as "this
    /// instruction has no destination to check": the message would fail runtime
    /// sanitization long before it moved a lamport, so there is nothing to defend
    /// against, and inventing a rejection here would diverge from the TypeScript
    /// for input neither implementation can be handed by the bot.
    #[must_use]
    pub fn operand(&self, ix: &IxView, position: usize) -> Option<Pubkey> {
        let index = *ix.account_indexes.get(position)?;
        self.account_keys.get(usize::from(index)).copied()
    }
}

/// One top-level instruction with its program id already resolved.
///
/// `account_indexes` are offsets into [`ResolvedTx::account_keys`], widened from
/// the wire's `u8` so a future message format with more than 256 accounts does
/// not silently truncate. Resolve them with [`ResolvedTx::operand`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IxView {
    /// The program this instruction invokes.
    pub program_id: Pubkey,
    /// Indexes into [`ResolvedTx::account_keys`], in instruction order.
    pub account_indexes: Vec<u16>,
    /// Raw instruction data; byte 0 is the SPL discriminator when this is a
    /// token program instruction.
    pub data: Vec<u8>,
}

/// Expands a transaction's account list, fetching any lookup tables it names.
///
/// A legacy transaction needs no network access and one is never attempted; so
/// does a v0 message compiled without tables. Otherwise every table is fetched in
/// a single [`SolanaRpc::get_multiple_accounts`] call, matching
/// `getMultipleAccountsInfo(altKeys)`.
///
/// # Errors
///
/// [`PolicyError::AltResolutionFailed`] wrapping the underlying reason if the RPC
/// call fails, a named table is missing or malformed, or the message indexes past
/// the end of one — the same `ALT resolution failed: ${err.message}` the
/// TypeScript signer returns as its rejection reason. [`PolicyError::UnresolvableProgramId`]
/// if an instruction's program id index is out of range once expansion is done.
pub fn resolve(tx: &ParsedTx, rpc: &dyn SolanaRpc) -> Result<ResolvedTx, PolicyError> {
    let (account_keys, instructions) = match tx {
        ParsedTx::Legacy(tx) => (
            tx.message.account_keys.clone(),
            compile(&tx.message.instructions),
        ),
        ParsedTx::Versioned(tx) => (
            expand(&tx.message, rpc)
                .map_err(|err| PolicyError::AltResolutionFailed(err.to_string()))?,
            compile(tx.message.instructions()),
        ),
    };

    let instructions = instructions
        .into_iter()
        .enumerate()
        .map(|(instruction, (program_index, account_indexes, data))| {
            let program_id = account_keys
                .get(usize::from(program_index))
                .copied()
                .ok_or(PolicyError::UnresolvableProgramId {
                    instruction,
                    index: program_index,
                })?;
            Ok(IxView {
                program_id,
                account_indexes,
                data,
            })
        })
        .collect::<Result<Vec<_>, PolicyError>>()?;

    Ok(ResolvedTx {
        account_keys,
        instructions,
    })
}

/// Lifts compiled instructions into `(program index, account indexes, data)`,
/// widening the wire's `u8` indexes. Both message types compile to the same
/// `CompiledInstruction`, so this is shared.
fn compile(
    instructions: &[solana_sdk::instruction::CompiledInstruction],
) -> Vec<(u16, Vec<u16>, Vec<u8>)> {
    instructions
        .iter()
        .map(|ix| {
            (
                u16::from(ix.program_id_index),
                ix.accounts.iter().copied().map(u16::from).collect(),
                ix.data.clone(),
            )
        })
        .collect()
}

/// Fetches and applies a v0 message's lookup tables.
///
/// Split out so every failure inside it can be wrapped with the single
/// `ALT resolution failed:` prefix at the call site, the way `checkPolicy` wraps
/// everything `resolveALTs` throws.
fn expand(message: &VersionedMessage, rpc: &dyn SolanaRpc) -> Result<Vec<Pubkey>, AltError> {
    let static_keys = message.static_account_keys();
    let lookups = message.address_table_lookups().unwrap_or_default();
    if lookups.is_empty() {
        return Ok(static_keys.to_vec());
    }

    let table_keys: Vec<Pubkey> = lookups.iter().map(|lookup| lookup.account_key).collect();
    let accounts = rpc
        .get_multiple_accounts(&table_keys)
        .map_err(AltError::Rpc)?;

    let mut keys = static_keys.to_vec();
    let mut writable = Vec::new();
    let mut readonly = Vec::new();

    for (position, lookup) in lookups.iter().enumerate() {
        // A short reply is treated as "missing", so an implementation that
        // truncates fails closed instead of dropping a table's accounts.
        let account = accounts
            .get(position)
            .and_then(Option::as_ref)
            .ok_or(TxError::AltAccountNotFound(lookup.account_key))?;

        let table = AddressLookupTable::deserialize(&account.data).map_err(|err| {
            TxError::AltAccountMalformed {
                key: lookup.account_key,
                reason: err.to_string(),
            }
        })?;

        for (indexes, out) in [
            (&lookup.writable_indexes, &mut writable),
            (&lookup.readonly_indexes, &mut readonly),
        ] {
            for index in indexes {
                let address = table.addresses.get(usize::from(*index)).ok_or(
                    TxError::AltIndexOutOfRange {
                        table: lookup.account_key,
                        index: *index,
                    },
                )?;
                out.push(*address);
            }
        }
    }

    keys.append(&mut writable);
    keys.append(&mut readonly);
    Ok(keys)
}

/// Internal failure of [`expand`], collapsed into one `Display` at the boundary.
#[derive(Debug, thiserror::Error)]
enum AltError {
    #[error(transparent)]
    Rpc(#[from] crate::error::RpcError),
    #[error(transparent)]
    Tx(#[from] TxError),
}
