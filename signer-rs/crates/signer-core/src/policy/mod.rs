//! The policy engine — a port of `checkPolicy` in `signer/policy.ts`.
//!
//! This is the whole reason the signer is a separate process: it is the last
//! place a transaction can be refused before a key signs it. The bot builds
//! transactions and is the thing most likely to be compromised; the signer holds
//! the key and never trusts what it is handed.
//!
//! `checkPolicy` runs three passes. [`PolicyEngine::check`] runs all three in
//! order; the first two need no network beyond an account read and are
//! [`PolicyEngine::check_static`]:
//!
//! 1. **Program allowlist.** Every top-level instruction must invoke a program on
//!    the list ([`crate::config::program_allowlist`]). This is the coarse filter —
//!    a transaction calling an unknown program is refused outright.
//! 2. **SPL token rules.** Within the two token programs, `SetAuthority` is always
//!    refused, `Approve` and `Transfer`/`TransferChecked` are refused unless the
//!    delegate or destination clears [`spl`]'s chain of exemptions.
//! 3. **Post-simulation CPI check.** Simulate, then hold every program the logs
//!    show was actually invoked to the same allowlist — see [`simulation`], which
//!    is also where the reasons simulation is otherwise non-fatal are set out.
//!
//! # Ordering
//!
//! The allowlist runs to completion over every instruction before the first SPL
//! check, exactly as in the TypeScript, so an unknown program anywhere in a
//! transaction outranks a `SetAuthority` earlier in it. Within the SPL pass the
//! first offending instruction decides, and inside a transfer the exemptions are
//! tried in the TypeScript's order — see [`spl::check`]. Simulation runs last and
//! only for a transaction that already cleared both static passes, so the
//! expensive check never runs for a transaction that was going to be refused.

pub mod simulation;
pub mod spl;

use crate::alt::{self, ResolvedTx};
use crate::config::PolicyConfig;
use crate::error::PolicyError;
use crate::rpc::SolanaRpc;
use crate::tx::ParsedTx;

/// The outcome of a policy pass.
///
/// `Deny` carries the reason as a string because that is what crosses the wire —
/// `{"ok":false,"error":"<reason>"}` — and the strings are the compatibility
/// surface the bot's logs and the TypeScript signer's own output share. Build one
/// from a [`PolicyError`] rather than a literal, so every message stays defined in
/// [`crate::error`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing objectionable. Sign it.
    Allow {
        /// Whether a known DEX program appears among the top-level instructions.
        ///
        /// Relaxes the transfer-destination rule: a token move inside a swap or
        /// LP flow is expected. Reported even when no transfer was present, so
        /// the caller never has to re-derive it.
        ///
        /// Not what [`simulation`] tests for. Its exemption is Jupiter
        /// specifically (`policy.ts:200-204`), and Jupiter is one of the six DEX
        /// programs — reusing this flag there would skip the CPI check for every
        /// Orca, Meteora and Byreal transaction as well.
        has_dex_instruction: bool,
    },
    /// Refuse to sign.
    Deny {
        /// Verbatim `reason` for the response frame.
        reason: String,
    },
}

impl Verdict {
    /// Whether the transaction may be signed.
    #[must_use]
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow { .. })
    }

    /// The rejection reason, or `None` if allowed.
    #[must_use]
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Allow { .. } => None,
            Self::Deny { reason } => Some(reason),
        }
    }
}

impl From<PolicyError> for Verdict {
    fn from(err: PolicyError) -> Self {
        Self::Deny {
            reason: err.to_string(),
        }
    }
}

/// Applies the configured policy to resolved transactions.
///
/// Holds only configuration, so one engine serves every request. The chain access
/// a check needs is passed in per call rather than stored, keeping the engine
/// `Send + Sync` for free and making it obvious at each call site that a check may
/// reach the network.
#[derive(Debug, Clone)]
pub struct PolicyEngine {
    config: PolicyConfig,
}

impl PolicyEngine {
    /// Builds an engine from the allowlists and whitelists in `config`.
    #[must_use]
    pub fn new(config: PolicyConfig) -> Self {
        Self { config }
    }

    /// The configuration this engine enforces.
    #[must_use]
    pub fn config(&self) -> &PolicyConfig {
        &self.config
    }

    /// The whole of `checkPolicy`: resolve, check statically, simulate.
    ///
    /// This is the call the daemon makes, and the only one that sees a
    /// transaction as it arrived rather than as [`ResolvedTx`]. Address lookup
    /// tables are expanded first because every later check reads account keys
    /// through them; a table that cannot be fetched is a rejection, since a
    /// transaction whose accounts the signer cannot see is one it cannot vouch
    /// for.
    ///
    /// The passes run in the TypeScript's order and the first rejection wins.
    #[must_use]
    pub fn check(&self, tx: &ParsedTx, rpc: &dyn SolanaRpc) -> Verdict {
        let resolved = match alt::resolve(tx, rpc) {
            Ok(resolved) => resolved,
            Err(err) => return err.into(),
        };

        let verdict = self.check_static(&resolved, rpc);
        if !verdict.is_allowed() {
            return verdict;
        }

        match simulation::check(&self.config, tx, &resolved, rpc) {
            Some(err) => err.into(),
            None => verdict,
        }
    }

    /// Runs the allowlist and SPL passes.
    ///
    /// `rpc` is consulted only by the last exemption in the transfer chain, and
    /// only for a transfer that cleared none of the cheaper ones — a transaction
    /// with no standalone token transfer never touches the network.
    ///
    /// Returns the first rejection it finds; see the module docs for the order.
    #[must_use]
    pub fn check_static(&self, resolved: &ResolvedTx, rpc: &dyn SolanaRpc) -> Verdict {
        for ix in &resolved.instructions {
            if !self.config.program_allowlist.contains(&ix.program_id) {
                return PolicyError::UnknownProgram(ix.program_id).into();
            }
        }

        let has_dex_instruction = resolved
            .instructions
            .iter()
            .any(|ix| self.config.dex_programs.contains(&ix.program_id));

        for ix in &resolved.instructions {
            if let Some(err) = spl::check(&self.config, resolved, ix, has_dex_instruction, rpc) {
                return err.into();
            }
        }

        Verdict::Allow {
            has_dex_instruction,
        }
    }
}
