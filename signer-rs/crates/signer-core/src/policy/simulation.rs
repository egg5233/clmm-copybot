//! The post-simulation CPI check — `policy.ts:174-216` and `extractInvokedPrograms`.
//!
//! The static passes only see a transaction's *top-level* instructions. A
//! program on the allowlist is free to CPI into anything, and nothing in the
//! message reveals where: the account list of a Byreal `increaseLiquidity` looks
//! the same whether the vaults belong to Byreal or to a program that forwards
//! them elsewhere. Simulating the transaction and reading back the log lines the
//! runtime emits on every `invoke` is the only way to see the programs that will
//! actually run, so this pass is what closes the gap between "calls an
//! allowlisted program" and "reaches only allowlisted programs".
//!
//! # What is fatal here, and what is not
//!
//! Only one finding refuses a transaction: a log line naming a program outside
//! [`PolicyConfig::program_allowlist`]. Everything else about simulation is
//! advisory, and deliberately so ([`check`] documents each case):
//!
//! * The endpoint is unreachable, rate-limiting, or returns nonsense → sign.
//! * The transaction would fail on chain (`simResult.err`) → sign, *and still
//!   check the logs it produced*.
//!
//! That is `policy.ts:165-188` verbatim, and it is a considered position rather
//! than an oversight: simulation runs against a slightly stale slot, and
//! `closePosition` in particular fails simulation and succeeds on chain. Turning
//! either case into a rejection would mean an RPC hiccup can stop the bot from
//! closing a position, which is a worse failure than the one it would prevent —
//! the transaction still has to clear the allowlist and the SPL rules before it
//! ever reaches here.
//!
//! # Divergences from `signer/policy.ts`
//!
//! * **One simulation path, not two.** The TypeScript simulates a legacy
//!   transaction through a different `Connection` overload than a versioned one.
//!   Both end in the same `simulateTransaction` RPC and both read the same two
//!   fields off the result, so a legacy transaction is lifted with
//!   [`VersionedTransaction::from`] and there is a single call site here. The
//!   overloads differ only in which options they set, and those (`sigVerify:
//!   false`, `replaceRecentBlockhash: true`) belong to the RPC implementation —
//!   see [`SolanaRpc::simulate`].
//! * **A Jupiter transaction is not simulated at all.** The TypeScript simulates
//!   it and then throws the result away (`!hasJupiter` guards the *check*, not
//!   the call). Skipping the round trip reaches the same verdict one request
//!   sooner, and keeps a transaction the signer will not inspect from being
//!   shipped to the RPC provider.

use std::borrow::Cow;
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::LazyLock;

use regex::Regex;
use solana_sdk::{pubkey::Pubkey, transaction::VersionedTransaction};

use crate::alt::ResolvedTx;
use crate::config::PolicyConfig;
use crate::error::PolicyError;
use crate::rpc::SolanaRpc;
use crate::tx::ParsedTx;

/// The invoke-line pattern, character for character from `policy.ts:286`.
///
/// Kept as a bare string so it can be compared against the `_regex` field the
/// fixture generator records — the two implementations agreeing on the *pattern*
/// is what makes the extraction vectors meaningful.
///
/// It is looser than base58 (`\w` admits `_`, which base58 never produces) and
/// its lower bound of 32 characters skips a pubkey whose base58 form is shorter,
/// which happens when the address begins with zero bytes. Both are reproduced
/// rather than fixed: a stricter pattern here would refuse a transaction the
/// TypeScript signer accepts, and a looser one the reverse.
const INVOKE_PATTERN: &str = r"Program (\w{32,44}) invoke";

/// [`INVOKE_PATTERN`] compiled with Unicode mode off.
///
/// `(?-u)` is not a change to the pattern, it is what makes `\w` mean the same
/// thing in both languages: JavaScript's `\w` is `[A-Za-z0-9_]`, while the
/// `regex` crate's is Unicode-aware by default and would match word characters
/// no base58 encoder emits.
static INVOKE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?-u){INVOKE_PATTERN}")).expect("the invoke pattern is a valid regex")
});

/// Simulates `tx` and refuses it if the logs name a program off the allowlist.
///
/// `resolved` supplies the top-level program ids; `tx` is what gets simulated,
/// since simulation needs the signatures and header the resolved view drops.
///
/// Returns `None` — nothing to object to — in four distinct situations, which
/// the module docs argue for and which are listed here in the order they are
/// reached:
///
/// 1. The transaction calls Jupiter, whose routes CPI into dozens of AMMs that
///    cannot be pre-listed. Jupiter itself is on the allowlist and vouches for
///    the rest.
/// 2. The simulation call failed. No logs, nothing to check.
/// 3. The simulation returned no logs.
/// 4. Every program in the logs is allowlisted.
#[must_use]
pub fn check(
    config: &PolicyConfig,
    tx: &ParsedTx,
    resolved: &ResolvedTx,
    rpc: &dyn SolanaRpc,
) -> Option<PolicyError> {
    if resolved
        .instructions
        .iter()
        .any(|ix| ix.program_id == config.jupiter)
    {
        return None;
    }

    let result = rpc.simulate(&as_versioned(tx)).ok()?;

    // `result.err` is read by nobody on purpose. A transaction that would fail
    // on chain still produced logs up to the point it failed, and a CPI into an
    // unknown program in those logs is exactly as disqualifying as one in a
    // transaction that would have succeeded.
    for program in extract_invoked_programs(&result.logs) {
        if !is_allowlisted(config, program) {
            return Some(PolicyError::UnknownInvokedProgram(program.to_owned()));
        }
    }

    None
}

/// Every program id the logs show being invoked, deduplicated, first seen first.
///
/// One match per line, as `String.match` without `/g` gives: a log line names at
/// most one program, and taking only the first is what keeps a program that
/// prints `"Program <pubkey> invoke"` *inside* its own message from being read
/// as a real invocation.
///
/// The ids come back as text rather than [`Pubkey`] because the pattern is
/// looser than base58 — see [`INVOKE_PATTERN`]. A capture that is not a valid
/// pubkey cannot be on the allowlist and so is refused, carrying the characters
/// that were actually in the log rather than a lossy re-encoding of them.
#[must_use]
pub fn extract_invoked_programs(logs: &[String]) -> Vec<&str> {
    let mut seen = HashSet::new();
    let mut programs = Vec::new();

    for line in logs {
        let Some(program) = INVOKE_LINE
            .captures(line)
            .and_then(|captures| captures.get(1))
        else {
            continue;
        };

        let program = program.as_str();
        if seen.insert(program) {
            programs.push(program);
        }
    }

    programs
}

/// Whether `program` — raw text from a log line — is an allowlisted pubkey.
fn is_allowlisted(config: &PolicyConfig, program: &str) -> bool {
    Pubkey::from_str(program).is_ok_and(|program| config.program_allowlist.contains(&program))
}

/// The transaction as simulation wants it: v0 borrowed, legacy lifted.
///
/// A legacy transaction is wrapped rather than converted — [`VersionedTransaction::from`]
/// keeps the signatures and re-labels the message as `Legacy`, so what reaches
/// the RPC is the same bytes the bot handed over.
fn as_versioned(tx: &ParsedTx) -> Cow<'_, VersionedTransaction> {
    match tx {
        ParsedTx::Versioned(tx) => Cow::Borrowed(tx),
        ParsedTx::Legacy(tx) => Cow::Owned(VersionedTransaction::from(tx.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extracts from `lines`, owning them for as long as the result borrows.
    fn extract(lines: &[&str]) -> Vec<String> {
        let logs: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
        extract_invoked_programs(&logs)
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn only_invoke_lines_are_read() {
        let extracted = extract(&[
            "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]",
            "Program log: Instruction: Transfer",
            "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4645 of 200000 compute units",
            "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
        ]);
        assert_eq!(extracted, ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    }

    #[test]
    fn a_repeated_program_is_reported_once_at_its_first_position() {
        let extracted = extract(&[
            "Program 11111111111111111111111111111111 invoke [1]",
            "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]",
            "Program 11111111111111111111111111111111 invoke [1]",
        ]);
        assert_eq!(
            extracted,
            [
                "11111111111111111111111111111111",
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            ]
        );
    }

    #[test]
    fn a_second_invoke_on_one_line_is_not_captured() {
        // `String.match` without /g stops at the first match, and so does
        // `Regex::captures`. A line like this cannot come from the runtime; what
        // it models is a program logging attacker-chosen text.
        let extracted = extract(&[
            "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1] Program \
             M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K invoke [2]",
        ]);
        assert_eq!(extracted, ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    }

    #[test]
    fn an_id_shorter_than_the_lower_bound_is_skipped() {
        // 31 characters: a real pubkey whose base58 form is this short exists
        // (leading zero bytes), and neither implementation captures it.
        let extracted = extract(&["Program 1111111111111111111111111111111 invoke [1]"]);
        assert!(extracted.is_empty(), "{extracted:?}");
    }

    #[test]
    fn a_non_base58_capture_is_returned_verbatim() {
        // `\w` admits `_`. The caller refuses it — it cannot parse as a pubkey,
        // so it cannot be on the allowlist — and the log's own text is what ends
        // up in the rejection.
        let extracted =
            extract(&["Program Tokenkeg_feZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]"]);
        assert_eq!(extracted, ["Tokenkeg_feZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    }

    #[test]
    fn a_unicode_word_character_does_not_extend_a_match() {
        // The ASCII `\w` of JavaScript stops at `é`, leaving 31 usable
        // characters before " invoke" — too few. Unicode mode would count it and
        // capture a 32-character id the TypeScript signer never sees.
        let extracted = extract(&["Program 1111111111111111111111111111111é invoke [1]"]);
        assert!(extracted.is_empty(), "{extracted:?}");
    }
}
