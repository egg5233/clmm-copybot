//! The RPC boundary the policy engine reads the chain through.
//!
//! `signer/policy.ts` and `signer/alt-resolver.ts` both take a web3.js
//! `Connection` and call three methods on it: `getMultipleAccountsInfo` to fetch
//! address lookup tables, `getAccountInfo` to classify a token transfer's
//! destination, and `simulateTransaction` to check what a transaction really
//! invokes. [`SolanaRpc`] is that surface, expressed as a trait so the decision
//! logic can be tested without a network.
//!
//! The trait is deliberately **synchronous**. Every caller in this crate is a
//! straight-line policy check with no concurrency of its own, and keeping the
//! core free of an async runtime is the whole point of the crate split — the
//! daemon owns the reactor and can bridge to a blocking client or park a future
//! on its own executor.
//!
//! Each method hands back plain data rather than an RPC response type, and the
//! caller does the deciding: [`SimResult`] is the two fields
//! `checkPolicy` reads off `SimulatedTransactionResponse`, not a re-export of
//! it. That keeps [`crate::policy`] free of the RPC client's types and makes
//! [`MockRpc`] a complete implementation rather than a stub.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use solana_account::Account;
use solana_sdk::{pubkey::Pubkey, transaction::VersionedTransaction};

use crate::error::RpcError;

/// What simulation reports back, narrowed to what the policy engine reads.
///
/// `simulateTransaction` returns a dozen fields; `checkPolicy` looks at two.
/// `err` is only ever tested for presence — a failing simulation is logged and
/// signed anyway (`policy.ts:165-168`) — so it is carried as rendered text
/// rather than a decoded `TransactionError`, which would put the RPC client's
/// type system in the middle of a string nothing parses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SimResult {
    /// The transaction would fail on chain, rendered for a log line.
    ///
    /// `None` means it would succeed. Either way the signer signs — see
    /// [`crate::policy::simulation`].
    pub err: Option<String>,
    /// Program logs, in emission order.
    ///
    /// Empty covers both "no logs" and web3.js's `logs: null`: neither can name
    /// a program, so both yield nothing to check.
    pub logs: Vec<String>,
}

/// Read-only chain access, as much of it as the policy engine needs.
///
/// `Send + Sync` because the daemon shares one implementation across connection
/// handlers; nothing here mutates observable state, so that costs nothing.
pub trait SolanaRpc: Send + Sync {
    /// Fetches several accounts in one round trip.
    ///
    /// The returned vector is parallel to `keys`: entry `i` describes `keys[i]`,
    /// and `None` means the account does not exist on chain. Implementors must
    /// preserve that pairing — callers index into the result rather than
    /// matching on address. A vector shorter than `keys` is treated by
    /// [`crate::alt`] as "not found" for the missing tail, so a truncating
    /// implementation fails closed rather than silently skipping a lookup table.
    ///
    /// # Errors
    ///
    /// [`RpcError`] if the endpoint is unreachable or its reply is unreadable.
    /// A *missing* account is `Ok(None)`, not an error.
    fn get_multiple_accounts(&self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, RpcError>;

    /// Fetches a single account, or `None` if it does not exist on chain.
    ///
    /// # Errors
    ///
    /// [`RpcError`] if the endpoint is unreachable or its reply is unreadable.
    fn get_account(&self, key: &Pubkey) -> Result<Option<Account>, RpcError>;

    /// Simulates `tx` without executing it, returning its logs.
    ///
    /// The transaction is unsigned at this point, so implementors must disable
    /// signature verification and let the node substitute a recent blockhash —
    /// `{ sigVerify: false, replaceRecentBlockhash: true }` in `policy.ts:157-160`.
    /// Both are properties of *how* the call is made, which is why they live in
    /// the implementation rather than in this signature.
    ///
    /// # Errors
    ///
    /// [`RpcError`] if the endpoint is unreachable or its reply is unreadable. A
    /// transaction that *would fail on chain* is not an error but `Ok` with `err`
    /// set: the simulation succeeded, and what it reports is a failing
    /// transaction. [`crate::policy::simulation`] treats both as non-fatal, but
    /// only the second comes with logs worth checking.
    fn simulate(&self, tx: &VersionedTransaction) -> Result<SimResult, RpcError>;
}

/// An in-memory [`SolanaRpc`] backed by a map, for tests.
///
/// Compiled unconditionally rather than behind a `testutil` feature: the ALT and
/// policy suites live in `tests/`, which can only reach the crate's public API,
/// and a feature a package has to enable on itself is more machinery than the
/// two hundred lines it would gate.
///
/// Every lookup is counted, so a test can assert not just *what* was fetched but
/// *how* — [`MockRpc::batch_calls`] is what pins "one `get_multiple_accounts`
/// for all lookup tables" rather than one round trip per table.
#[derive(Debug, Default)]
pub struct MockRpc {
    accounts: HashMap<Pubkey, Account>,
    error: Option<String>,
    sim: Option<Result<SimResult, RpcError>>,
    batch_calls: AtomicUsize,
    single_calls: AtomicUsize,
    sim_calls: AtomicUsize,
}

impl MockRpc {
    /// An empty chain: every account is missing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// An endpoint that fails every request with `message`.
    #[must_use]
    pub fn failing(message: &str) -> Self {
        Self {
            error: Some(message.to_owned()),
            ..Self::default()
        }
    }

    /// Adds an account verbatim.
    #[must_use]
    pub fn with_account(mut self, key: Pubkey, account: Account) -> Self {
        self.accounts.insert(key, account);
        self
    }

    /// Adds an account with the given owner and data, and no lamports of note.
    #[must_use]
    pub fn with_data(self, key: Pubkey, owner: Pubkey, data: Vec<u8>) -> Self {
        self.with_account(
            key,
            Account {
                lamports: 1,
                data,
                owner,
                executable: false,
                rent_epoch: 0,
            },
        )
    }

    /// Adds an empty account owned by `owner` — enough for the transfer
    /// destination check, which only reads `owner`.
    #[must_use]
    pub fn owned_by(self, key: Pubkey, owner: Pubkey) -> Self {
        self.with_data(key, owner, Vec::new())
    }

    /// Answers [`SolanaRpc::simulate`] with `logs` and no transaction error.
    #[must_use]
    pub fn with_sim_logs<I, S>(self, logs: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.with_sim(Ok(SimResult {
            err: None,
            logs: logs.into_iter().map(Into::into).collect(),
        }))
    }

    /// Answers [`SolanaRpc::simulate`] verbatim.
    ///
    /// Takes the whole `Result` so a test can set up the two failure shapes that
    /// are *not* interchangeable in the policy: `Err` (the endpoint never
    /// answered, so there are no logs to check) and `Ok` with `err` set (the
    /// node answered, the transaction would fail, and its logs are still checked).
    #[must_use]
    pub fn with_sim(mut self, response: Result<SimResult, RpcError>) -> Self {
        self.sim = Some(response);
        self
    }

    /// How many times [`SolanaRpc::get_multiple_accounts`] has been called.
    #[must_use]
    pub fn batch_calls(&self) -> usize {
        self.batch_calls.load(Ordering::Relaxed)
    }

    /// How many times [`SolanaRpc::get_account`] has been called.
    #[must_use]
    pub fn single_calls(&self) -> usize {
        self.single_calls.load(Ordering::Relaxed)
    }

    /// How many times [`SolanaRpc::simulate`] has been called.
    ///
    /// Zero is the assertion that pins the Jupiter exemption: the check is
    /// skipped before the round trip, not after it.
    #[must_use]
    pub fn sim_calls(&self) -> usize {
        self.sim_calls.load(Ordering::Relaxed)
    }

    fn fail(&self) -> Option<RpcError> {
        self.error.clone().map(RpcError::Transport)
    }
}

impl SolanaRpc for MockRpc {
    fn get_multiple_accounts(&self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, RpcError> {
        self.batch_calls.fetch_add(1, Ordering::Relaxed);
        if let Some(err) = self.fail() {
            return Err(err);
        }
        Ok(keys
            .iter()
            .map(|key| self.accounts.get(key).cloned())
            .collect())
    }

    fn get_account(&self, key: &Pubkey) -> Result<Option<Account>, RpcError> {
        self.single_calls.fetch_add(1, Ordering::Relaxed);
        if let Some(err) = self.fail() {
            return Err(err);
        }
        Ok(self.accounts.get(key).cloned())
    }

    /// A configured response wins over [`MockRpc::failing`], so a test can make
    /// the account reads fail while simulation still answers, or the reverse.
    /// With neither configured, simulation succeeds and reports nothing.
    fn simulate(&self, _tx: &VersionedTransaction) -> Result<SimResult, RpcError> {
        self.sim_calls.fetch_add(1, Ordering::Relaxed);
        match &self.sim {
            Some(response) => response.clone(),
            None => match self.fail() {
                Some(err) => Err(err),
                None => Ok(SimResult::default()),
            },
        }
    }
}
