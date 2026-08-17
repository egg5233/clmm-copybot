//! The RPC boundary the policy engine reads the chain through.
//!
//! `signer/policy.ts` and `signer/alt-resolver.ts` both take a web3.js
//! `Connection` and call three methods on it: `getMultipleAccountsInfo` to fetch
//! address lookup tables, `getAccountInfo` to classify a token transfer's
//! destination, and `simulateTransaction` to check what a transaction really
//! invokes. [`SolanaRpc`] is that surface, narrowed to the two account reads and
//! expressed as a trait so the decision logic can be tested without a network.
//!
//! The trait is deliberately **synchronous**. Every caller in this crate is a
//! straight-line policy check with no concurrency of its own, and keeping the
//! core free of an async runtime is the whole point of the crate split — the
//! daemon owns the reactor and can bridge to a blocking client or park a future
//! on its own executor.
//!
//! # Simulation boundary
//!
//! Simulation (`policy.ts:174-216`) is milestone M5 and is **not** part of this
//! trait yet. It lands as a third method:
//!
//! ```text
//! fn simulate(&self, tx: &ParsedTx) -> Result<SimulationOutcome, RpcError>;
//! ```
//!
//! returning the logs the invoked-program check parses, rather than a raw RPC
//! response type — the same shape as these two methods, where the trait hands
//! back plain data and the caller does the deciding. Adding it is additive for
//! [`MockRpc`]; implementors outside this crate will need to fill it in.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use solana_account::Account;
use solana_sdk::pubkey::Pubkey;

use crate::error::RpcError;

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
    batch_calls: AtomicUsize,
    single_calls: AtomicUsize,
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
}
