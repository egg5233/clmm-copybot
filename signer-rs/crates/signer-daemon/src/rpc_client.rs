//! The real chain access behind [`SolanaRpc`], for the daemon.
//!
//! `signer-core` decides; this dials. Everything network-shaped lives on this
//! side of the crate split — the blocking [`RpcClient`] spins up a tokio runtime
//! internally, which is exactly the dependency the core is kept free of.
//!
//! The translation is deliberately thin. Nothing here inspects a transaction or
//! decides anything about one: it fetches accounts, runs a simulation, and turns
//! three `solana-client` result types into the two the policy engine
//! understands. Every judgement call about what those results *mean* belongs to
//! [`signer_core::policy`], where it is unit-testable against [`signer_core::rpc::MockRpc`].

use std::time::Duration;

use signer_core::error::RpcError;
use signer_core::rpc::{SimResult, SolanaRpc};
use solana_client::client_error::{ClientError, ClientErrorKind};
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::RpcSimulateTransactionConfig;
use solana_sdk::account::Account;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::VersionedTransaction;

/// How long any one RPC call may take.
///
/// The bot gives up on the whole signing round trip after 30 seconds
/// (`src/utils/wallet.ts:71`), and a request can spend up to three calls here —
/// lookup tables, a transfer destination, a simulation. A signer still waiting
/// on an RPC when its caller has already timed out is doing no good, so each
/// call is held well inside that budget; a slow endpoint fails fast and the
/// transaction is signed on the non-fatal path rather than stalling.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// `confirmed`, matching `new Connection(rpcUrl, { commitment: 'confirmed' })`
/// in `signer/index.ts:208`.
///
/// It decides which slot the account reads and the simulation see. `processed`
/// would let an unconfirmed account state answer "who owns this token account",
/// and `finalized` would answer it from up to a minute ago — a token account the
/// bot created earlier in the same block would look like it does not exist.
const COMMITMENT: CommitmentConfig = CommitmentConfig::confirmed();

/// A [`SolanaRpc`] backed by an HTTP JSON-RPC endpoint.
pub struct HttpRpc {
    client: RpcClient,
}

impl HttpRpc {
    /// Connects to `url`. No request is made until a policy check needs one.
    #[must_use]
    pub fn new(url: &str) -> Self {
        Self {
            client: RpcClient::new_with_timeout_and_commitment(url, CALL_TIMEOUT, COMMITMENT),
        }
    }
}

impl SolanaRpc for HttpRpc {
    fn get_multiple_accounts(&self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, RpcError> {
        self.client
            .get_multiple_accounts_with_commitment(keys, COMMITMENT)
            .map(|response| response.value)
            .map_err(map_error)
    }

    fn get_account(&self, key: &Pubkey) -> Result<Option<Account>, RpcError> {
        // `get_account` treats a missing account as an error; the policy engine
        // treats it as an answer ("nothing vouches for this destination"), so
        // the `_with_commitment` form is the one that matches the trait.
        self.client
            .get_account_with_commitment(key, COMMITMENT)
            .map(|response| response.value)
            .map_err(map_error)
    }

    fn simulate(&self, tx: &VersionedTransaction) -> Result<SimResult, RpcError> {
        let config = RpcSimulateTransactionConfig {
            // The transaction has not been signed yet — this check is what
            // decides whether it ever will be — so its signature slots are
            // still zeroed and verification would reject it out of hand.
            sig_verify: false,
            // And its blockhash came from the bot, which may have been holding
            // it for a while. Letting the node substitute its own keeps a stale
            // blockhash from failing the simulation for a reason that has
            // nothing to do with what the transaction does.
            replace_recent_blockhash: true,
            ..RpcSimulateTransactionConfig::default()
        };

        self.client
            .simulate_transaction_with_config(tx, config)
            .map(|response| SimResult {
                // Rendered here rather than carried: nothing downstream branches
                // on which error it was, and keeping `TransactionError` out of
                // `signer-core` is what lets the policy engine build without an
                // RPC client.
                err: response.value.err.map(|err| format!("{err:?}")),
                logs: response.value.logs.unwrap_or_default(),
            })
            .map_err(map_error)
    }
}

/// Collapses `solana-client`'s error taxonomy into the two cases the policy
/// engine distinguishes: a reply that could not be understood, and everything
/// else. Both are non-fatal for simulation and fatal for lookup tables, so the
/// split exists for the operator reading the message, not for the code.
fn map_error(err: ClientError) -> RpcError {
    match err.kind {
        ClientErrorKind::SerdeJson(err) => RpcError::Malformed(scrub(&err.to_string())),
        kind => RpcError::Transport(scrub(&kind.to_string())),
    }
}

/// Strips credentials from any URL inside an error message.
///
/// `reqwest` puts the request URL in its `Display` — `error sending request for
/// url (…helius-rpc.com/?api-key=…)` — and this message does not
/// stay local: a failed lookup table fetch becomes the `ALT resolution failed:`
/// rejection reason, which the bot re-throws into its log and its Discord
/// alerts. That is the same reason `redact_url` exists for the startup banner,
/// applied to text that has a URL somewhere inside it rather than being one.
///
/// A divergence from `signer/policy.ts`, which interpolates `err.message`
/// unredacted. The wording of an RPC failure is not part of the compatibility
/// surface the ported reason strings are — no caller matches on it — and leaking
/// an API key is not a behaviour worth reproducing.
fn scrub(message: &str) -> String {
    /// Where a URL stops: the punctuation an error message wraps one in.
    fn is_boundary(character: char) -> bool {
        character.is_whitespace() || matches!(character, ')' | '(' | '"' | '\'' | ',' | '>' | '<')
    }

    let mut scrubbed = String::with_capacity(message.len());
    let mut rest = message;

    loop {
        let start = match (rest.find("http://"), rest.find("https://")) {
            (Some(plain), Some(secure)) => plain.min(secure),
            (Some(only), None) | (None, Some(only)) => only,
            (None, None) => break,
        };

        let url = &rest[start..];
        let end = url.find(is_boundary).unwrap_or(url.len());

        scrubbed.push_str(&rest[..start]);
        scrubbed.push_str(&crate::redact_url(&url[..end]));
        rest = &url[end..];
    }

    scrubbed.push_str(rest);
    scrubbed
}

#[cfg(test)]
mod tests {
    use super::scrub;

    #[test]
    fn scrub_removes_the_api_key_from_a_transport_error() {
        assert_eq!(
            scrub("error sending request for url (https://mainnet.helius-rpc.com/?api-key=secret)"),
            "error sending request for url (https://mainnet.helius-rpc.com)"
        );
    }

    #[test]
    fn scrub_handles_a_key_in_the_path_and_more_than_one_url() {
        assert_eq!(
            scrub("https://rpc.example.com/v1/token failed, retrying http://localhost:8899"),
            "https://rpc.example.com/… failed, retrying http://localhost:8899"
        );
    }

    #[test]
    fn scrub_leaves_a_message_with_no_url_alone() {
        let message = "RPC response error -32602: invalid transaction encoding";
        assert_eq!(scrub(message), message);
    }
}
