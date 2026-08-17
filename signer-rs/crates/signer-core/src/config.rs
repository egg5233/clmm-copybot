//! Signer configuration, ported from `signer/config.ts`.
//!
//! [`SignerConfig::from_env`] reads the same environment variables as the
//! TypeScript signer and applies the same defaults. The program allowlist is
//! compiled in; only `BYREAL_PROGRAM_ID` is overridable, matching the TS
//! behaviour where that single entry is read from the environment.
//!
//! Environment reads go through [`SignerConfig::from_env_with`], which takes a
//! lookup closure. Tests inject a map instead of mutating the process
//! environment, so they stay race-free under Rust's parallel test runner.

use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;

use solana_sdk::pubkey;
use solana_sdk::pubkey::Pubkey;

use crate::error::ConfigError;

// ── Environment variable names ──────────────────────────────────────────────

/// RPC endpoint the signer uses for simulation. Required.
pub const ENV_RPC_URL: &str = "SIGNER_RPC_URL";
/// Path of the Unix socket the daemon listens on.
pub const ENV_SOCKET_PATH: &str = "SIGNER_SOCKET_PATH";
/// Port of the localhost unlock page; `0` disables it (stdin unlock only).
pub const ENV_UNLOCK_PORT: &str = "SIGNER_UNLOCK_PORT";
/// Comma-separated pubkeys allowed to receive standalone SPL transfers.
pub const ENV_DEST_WHITELIST: &str = "SIGNER_DEST_WHITELIST";
/// Log verbosity: `debug`, `info`, `warn` or `error`.
pub const ENV_LOG_LEVEL: &str = "SIGNER_LOG_LEVEL";
/// Refuse socket connections from a process running as another user. Off unless set.
pub const ENV_REQUIRE_PEER_UID: &str = "SIGNER_REQUIRE_PEER_UID";
/// Override for the Byreal program ID — the one allowlist entry that is not fixed.
pub const ENV_BYREAL_PROGRAM_ID: &str = "BYREAL_PROGRAM_ID";

// ── Defaults ────────────────────────────────────────────────────────────────

/// Default Unix socket path (`signer/config.ts:29`).
pub const DEFAULT_SOCKET_PATH: &str = "/tmp/byreal-signer.sock";
/// Default unlock page port (`signer/config.ts:87`).
pub const DEFAULT_UNLOCK_PORT: u16 = 3848;

// ── DEX programs ────────────────────────────────────────────────────────────
//
// The TypeScript signer spells this set out twice: once inside the allowlist
// (`signer/config.ts:36-42`) and again inline in the policy engine
// (`signer/policy.ts:92-99`) for the `hasDexInstruction` check. The two copies
// have to be kept in sync by hand. Here there is one definition — the allowlist
// is built from it, and `PolicyConfig::dex_programs` hands the same set to the
// policy engine.

/// Byreal CLMM — the default when `BYREAL_PROGRAM_ID` is unset.
pub const BYREAL_CLMM: Pubkey = pubkey!("REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2");
/// Orca Whirlpool.
pub const ORCA_WHIRLPOOL: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
/// Meteora DLMM.
pub const METEORA_DLMM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
/// Meteora DAMM v2.
pub const METEORA_DAMM_V2: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// PancakeSwap CLMM.
pub const PANCAKESWAP_CLMM: Pubkey = pubkey!("HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq");
/// Jupiter v6 aggregator.
pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// The five DEX programs whose IDs are fixed at compile time.
///
/// Byreal is the sixth; it is env-overridable, so the complete six-program set
/// is assembled at construction time by [`dex_programs`].
const STATIC_DEX_PROGRAMS: [Pubkey; 5] = [
    ORCA_WHIRLPOOL,
    METEORA_DLMM,
    METEORA_DAMM_V2,
    PANCAKESWAP_CLMM,
    JUPITER_V6,
];

/// Number of DEX programs: the five fixed ones plus Byreal.
pub const DEX_PROGRAM_COUNT: usize = STATIC_DEX_PROGRAMS.len() + 1;

/// The six DEX programs, with `byreal` supplying the overridable entry.
///
/// Used both for allowlist membership and for the `has_dex_instruction` check
/// the policy engine performs when deciding whether a token transfer is part of
/// a swap/LP flow.
#[must_use]
pub fn dex_programs(byreal: Pubkey) -> HashSet<Pubkey> {
    let mut set: HashSet<Pubkey> = STATIC_DEX_PROGRAMS.iter().copied().collect();
    set.insert(byreal);
    set
}

// ── Non-DEX programs on the allowlist ───────────────────────────────────────

/// System Program — also the "unsafe transfer destination owner" sentinel in policy checks.
pub const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");
/// SPL Token program.
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// SPL Token-2022 program (Byreal position NFTs).
pub const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Associated Token Account program.
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Everything on the allowlist that is not a DEX program, in the order
/// `signer/config.ts:44-73` lists them.
const OTHER_ALLOWED_PROGRAMS: [Pubkey; 23] = [
    // System programs
    SYSTEM_PROGRAM,
    pubkey!("ComputeBudget111111111111111111111111111111"), // Compute Budget
    pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), // Memo
    TOKEN_PROGRAM,
    TOKEN_2022,
    ASSOCIATED_TOKEN_PROGRAM,
    pubkey!("AddressLookupTab1e1111111111111111111111111"), // Address Lookup Table (v0 TXs)
    // Metaplex (used by Orca for position NFT metadata)
    pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
    // Jupiter route programs (common intermediaries)
    pubkey!("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"), // Phoenix
    pubkey!("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX"), // Serum/OpenBook
    pubkey!("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EQMQvR"), // OpenBook v2
    pubkey!("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD"), // Marinade
    pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), // Raydium CLMM
    pubkey!("RVKd61ztZW9GUwhRbbLoYVRE5Xf1B2tVscKqwZqXgEr"), // Raydium CPMM
    pubkey!("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"), // Raydium AMM v4
    pubkey!("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"), // Meteora pools
    pubkey!("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1"), // Orca v1 token swap
    pubkey!("SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ"), // Saber
    pubkey!("DecZY86MU5Gj7kppfUCEmd4LbXXuyZH1yHaP2NTqdiZB"), // Saber Decimal Wrapper
    pubkey!("MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky"), // Mercurial
    pubkey!("SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr"), // Orca Token Swap v2
    pubkey!("So1endDq2YkqhipRh3WViPa8hFMqshtxtZTV7LJHZ1K"), // Solend
    pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"), // Pump.fun Fee (suspected) —
                                                            // CPI'd by pump AMM routes via Jupiter
];

/// Size of the allowlist after de-duplication.
///
/// The TS array has 31 entries but two of them (Orca Whirlpool and Meteora
/// DLMM) are listed twice — once as a DEX, once as a Jupiter route program —
/// and the `Set` collapses them. The `HashSet` here collapses them the same way.
pub const ALLOWLIST_SIZE: usize = DEX_PROGRAM_COUNT + OTHER_ALLOWED_PROGRAMS.len();

/// The full program allowlist: only these programs may appear in a transaction.
#[must_use]
pub fn program_allowlist(byreal: Pubkey) -> HashSet<Pubkey> {
    let mut set = dex_programs(byreal);
    set.extend(OTHER_ALLOWED_PROGRAMS.iter().copied());
    set
}

// ── Log level ───────────────────────────────────────────────────────────────

/// Log verbosity, ported from the `SIGNER_LOG_LEVEL` union type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub enum LogLevel {
    /// Everything, including per-transaction policy tracing.
    Debug,
    /// Default: lifecycle events and per-request outcomes.
    #[default]
    Info,
    /// Only warnings and errors.
    Warn,
    /// Only errors.
    Error,
}

impl LogLevel {
    /// Lowercase name, matching the env var spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for LogLevel {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            other => Err(format!(
                "expected one of debug|info|warn|error, got `{other}`"
            )),
        }
    }
}

// ── SignerConfig ────────────────────────────────────────────────────────────

/// Everything the signer needs to start, read once at boot.
///
/// The private key is deliberately absent: it only exists in memory after the
/// operator unlocks the encrypted keyfile, never in config.
#[derive(Debug, Clone)]
pub struct SignerConfig {
    /// Unix socket the daemon listens on.
    pub socket_path: PathBuf,
    /// RPC endpoint used for simulation (separate from the bot's RPC).
    pub rpc_url: String,
    /// Byreal program ID — the one allowlist entry read from the environment.
    pub byreal_program_id: Pubkey,
    /// Addresses that may receive a standalone SPL transfer.
    pub destination_whitelist: HashSet<Pubkey>,
    /// Unlock page port; `0` means the page is disabled and unlock is stdin-only.
    pub unlock_port: u16,
    /// Log verbosity.
    pub log_level: LogLevel,
    /// Whether to serve only processes running as this daemon's own user.
    ///
    /// Off unless `SIGNER_REQUIRE_PEER_UID` says otherwise, because off is what
    /// keeps the daemon a drop-in replacement: `signer/index.ts` performs no such
    /// check, and the 0660 socket mode exists precisely so a bot running as a
    /// second user in the same group can connect.
    pub require_peer_uid: bool,
}

impl SignerConfig {
    /// Read configuration from the process environment.
    ///
    /// # Errors
    /// Returns [`ConfigError::MissingEnv`] if `SIGNER_RPC_URL` is unset or
    /// empty, and [`ConfigError::InvalidValue`] if a variable is set but
    /// unparseable.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_env_with(&|key| std::env::var(key).ok())
    }

    /// Read configuration through an arbitrary lookup function.
    ///
    /// Tests pass a map-backed closure so they never mutate the process
    /// environment — `std::env::set_var` is global state and Rust runs tests in
    /// parallel threads.
    ///
    /// # Errors
    /// Same as [`SignerConfig::from_env`].
    pub fn from_env_with(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // An empty string counts as unset, matching JS falsiness on `process.env`.
        let get = |key: &str| lookup(key).filter(|value| !value.is_empty());

        let rpc_url = get(ENV_RPC_URL).ok_or(ConfigError::MissingEnv(ENV_RPC_URL))?;

        let socket_path = get(ENV_SOCKET_PATH)
            .unwrap_or_else(|| DEFAULT_SOCKET_PATH.to_owned())
            .into();

        let byreal_program_id = match get(ENV_BYREAL_PROGRAM_ID) {
            None => BYREAL_CLMM,
            Some(raw) => Pubkey::from_str(&raw).map_err(|err| ConfigError::InvalidValue {
                var: ENV_BYREAL_PROGRAM_ID,
                value: raw.clone(),
                reason: err.to_string(),
            })?,
        };

        let destination_whitelist =
            parse_destination_whitelist(get(ENV_DEST_WHITELIST).as_deref().unwrap_or_default())?;

        let unlock_port = match get(ENV_UNLOCK_PORT) {
            None => DEFAULT_UNLOCK_PORT,
            Some(raw) => raw.trim().parse().map_err(|err: std::num::ParseIntError| {
                ConfigError::InvalidValue {
                    var: ENV_UNLOCK_PORT,
                    value: raw.clone(),
                    reason: err.to_string(),
                }
            })?,
        };

        let log_level = match get(ENV_LOG_LEVEL) {
            None => LogLevel::default(),
            Some(raw) => raw.parse().map_err(|reason| ConfigError::InvalidValue {
                var: ENV_LOG_LEVEL,
                value: raw.clone(),
                reason,
            })?,
        };

        let require_peer_uid = match get(ENV_REQUIRE_PEER_UID) {
            None => false,
            Some(raw) => parse_flag(&raw).ok_or_else(|| ConfigError::InvalidValue {
                var: ENV_REQUIRE_PEER_UID,
                value: raw.clone(),
                reason: "expected one of 1|0|true|false|yes|no|on|off".to_owned(),
            })?,
        };

        Ok(Self {
            socket_path,
            rpc_url,
            byreal_program_id,
            destination_whitelist,
            unlock_port,
            log_level,
            require_peer_uid,
        })
    }

    /// Whether the localhost unlock page should be served.
    #[must_use]
    pub fn web_unlock_enabled(&self) -> bool {
        self.unlock_port > 0
    }
}

/// Parse an on/off environment variable, or `None` for a spelling not on the list.
///
/// Deliberately not JavaScript truthiness. Every other variable here follows
/// `process.env` semantics because the TypeScript signer reads it that way, but
/// this one has no TypeScript counterpart to match, and under those rules
/// `SIGNER_REQUIRE_PEER_UID=0` and `=false` are non-empty strings and would
/// therefore *enable* the check. For a security control that reads backwards.
/// An unrecognised value is a boot failure rather than a guess, for the same
/// reason a malformed whitelist entry is: silently doing the opposite of what an
/// operator wrote is the failure mode worth ruling out.
fn parse_flag(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Parse `SIGNER_DEST_WHITELIST`: comma-separated, whitespace-trimmed, blanks dropped.
///
/// # Errors
/// Returns [`ConfigError::InvalidValue`] if an entry is not a valid pubkey. The
/// TS signer stores raw strings and silently ignores malformed ones; storing
/// `Pubkey`s means a typo has to surface, and failing at boot is better than a
/// whitelist entry that quietly never matches.
fn parse_destination_whitelist(raw: &str) -> Result<HashSet<Pubkey>, ConfigError> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            Pubkey::from_str(entry).map_err(|err| ConfigError::InvalidValue {
                var: ENV_DEST_WHITELIST,
                value: entry.to_owned(),
                reason: err.to_string(),
            })
        })
        .collect()
}

// ── PolicyConfig ────────────────────────────────────────────────────────────

/// The subset of configuration the policy engine consults on every request.
///
/// Split out from [`SignerConfig`] so policy checks can be unit-tested without
/// constructing a socket path or an RPC URL.
#[derive(Debug, Clone)]
pub struct PolicyConfig {
    /// Programs that may appear as an instruction's program ID.
    pub program_allowlist: HashSet<Pubkey>,
    /// The six DEX programs; presence of one relaxes the transfer-destination rule.
    pub dex_programs: HashSet<Pubkey>,
    /// Addresses that may receive a standalone SPL transfer.
    pub destination_whitelist: HashSet<Pubkey>,
    /// Jupiter v6 — its CPI fan-out is exempt from the post-simulation check.
    pub jupiter: Pubkey,
}

impl From<&SignerConfig> for PolicyConfig {
    fn from(config: &SignerConfig) -> Self {
        Self {
            program_allowlist: program_allowlist(config.byreal_program_id),
            dex_programs: dex_programs(config.byreal_program_id),
            destination_whitelist: config.destination_whitelist.clone(),
            jupiter: JUPITER_V6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Build an env lookup backed by a map, so tests never touch process env.
    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    fn config_from(pairs: &[(&str, &str)]) -> SignerConfig {
        SignerConfig::from_env_with(&env(pairs)).expect("config should build")
    }

    fn minimal() -> SignerConfig {
        config_from(&[(ENV_RPC_URL, "http://localhost:8899")])
    }

    // ── Allowlist ───────────────────────────────────────────────────────────

    #[test]
    fn allowlist_dedupes_the_two_duplicated_entries() {
        // 31 literals in signer/config.ts, two of which repeat.
        let allowlist = program_allowlist(BYREAL_CLMM);
        assert_eq!(allowlist.len(), 29);
        assert_eq!(allowlist.len(), ALLOWLIST_SIZE);
    }

    #[test]
    fn allowlist_contains_every_dex_and_the_system_programs() {
        let allowlist = program_allowlist(BYREAL_CLMM);
        for program in [
            BYREAL_CLMM,
            ORCA_WHIRLPOOL,
            METEORA_DLMM,
            METEORA_DAMM_V2,
            PANCAKESWAP_CLMM,
            JUPITER_V6,
            SYSTEM_PROGRAM,
            TOKEN_PROGRAM,
            TOKEN_2022,
            ASSOCIATED_TOKEN_PROGRAM,
        ] {
            assert!(allowlist.contains(&program), "missing {program}");
        }
    }

    #[test]
    fn dex_programs_are_a_subset_of_the_allowlist() {
        let allowlist = program_allowlist(BYREAL_CLMM);
        let dexes = dex_programs(BYREAL_CLMM);
        assert_eq!(dexes.len(), DEX_PROGRAM_COUNT);
        assert!(dexes.is_subset(&allowlist));
    }

    #[test]
    fn byreal_override_replaces_the_default_entry_in_both_sets() {
        let custom = Pubkey::new_unique();
        let config = config_from(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_BYREAL_PROGRAM_ID, &custom.to_string()),
        ]);
        assert_eq!(config.byreal_program_id, custom);

        let policy = PolicyConfig::from(&config);
        assert!(policy.program_allowlist.contains(&custom));
        assert!(!policy.program_allowlist.contains(&BYREAL_CLMM));
        assert!(policy.dex_programs.contains(&custom));
        assert!(!policy.dex_programs.contains(&BYREAL_CLMM));
        // Overriding swaps one entry; it does not grow the set.
        assert_eq!(policy.program_allowlist.len(), ALLOWLIST_SIZE);
    }

    #[test]
    fn invalid_byreal_override_is_rejected() {
        let err = SignerConfig::from_env_with(&env(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_BYREAL_PROGRAM_ID, "not-a-pubkey"),
        ]))
        .expect_err("invalid pubkey should fail");
        assert!(matches!(
            err,
            ConfigError::InvalidValue { var, .. } if var == ENV_BYREAL_PROGRAM_ID
        ));
    }

    // ── Destination whitelist ───────────────────────────────────────────────

    #[test]
    fn dest_whitelist_defaults_to_empty() {
        assert!(minimal().destination_whitelist.is_empty());
    }

    #[test]
    fn dest_whitelist_blank_and_comma_only_values_are_empty() {
        for raw in ["", "   ", ",", " , , "] {
            let config = config_from(&[
                (ENV_RPC_URL, "http://localhost:8899"),
                (ENV_DEST_WHITELIST, raw),
            ]);
            assert!(
                config.destination_whitelist.is_empty(),
                "expected empty for {raw:?}"
            );
        }
    }

    #[test]
    fn dest_whitelist_parses_a_single_entry() {
        let one = Pubkey::new_unique();
        let config = config_from(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_DEST_WHITELIST, &one.to_string()),
        ]);
        assert_eq!(config.destination_whitelist.len(), 1);
        assert!(config.destination_whitelist.contains(&one));
    }

    #[test]
    fn dest_whitelist_trims_whitespace_and_drops_blanks() {
        let (a, b, c) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let raw = format!("  {a} ,{b},, \t{c}  ,");
        let config = config_from(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_DEST_WHITELIST, &raw),
        ]);
        assert_eq!(config.destination_whitelist.len(), 3);
        for key in [a, b, c] {
            assert!(config.destination_whitelist.contains(&key));
        }
    }

    #[test]
    fn dest_whitelist_rejects_a_malformed_entry() {
        let raw = format!("{},0OIl", Pubkey::new_unique());
        let err = SignerConfig::from_env_with(&env(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_DEST_WHITELIST, &raw),
        ]))
        .expect_err("malformed pubkey should fail");
        assert!(matches!(
            err,
            ConfigError::InvalidValue { var, .. } if var == ENV_DEST_WHITELIST
        ));
    }

    // ── Required vars and defaults ──────────────────────────────────────────

    #[test]
    fn missing_rpc_url_is_an_error() {
        let err = SignerConfig::from_env_with(&env(&[])).expect_err("rpc url is required");
        assert!(matches!(err, ConfigError::MissingEnv(ENV_RPC_URL)));
        assert_eq!(
            err.to_string(),
            "Signer: missing required env var: SIGNER_RPC_URL"
        );
    }

    #[test]
    fn empty_rpc_url_counts_as_missing() {
        let err = SignerConfig::from_env_with(&env(&[(ENV_RPC_URL, "")]))
            .expect_err("empty is falsy in the TS signer too");
        assert!(matches!(err, ConfigError::MissingEnv(ENV_RPC_URL)));
    }

    #[test]
    fn defaults_match_the_typescript_signer() {
        let config = minimal();
        assert_eq!(config.socket_path, PathBuf::from(DEFAULT_SOCKET_PATH));
        assert_eq!(config.unlock_port, DEFAULT_UNLOCK_PORT);
        assert_eq!(config.log_level, LogLevel::Info);
        assert_eq!(config.byreal_program_id, BYREAL_CLMM);
        assert!(config.web_unlock_enabled());
    }

    #[test]
    fn overrides_are_applied() {
        let config = config_from(&[
            (ENV_RPC_URL, "https://rpc.example/?api-key=x"),
            (ENV_SOCKET_PATH, "/run/signer.sock"),
            (ENV_UNLOCK_PORT, "9999"),
            (ENV_LOG_LEVEL, "DEBUG"),
        ]);
        assert_eq!(config.rpc_url, "https://rpc.example/?api-key=x");
        assert_eq!(config.socket_path, PathBuf::from("/run/signer.sock"));
        assert_eq!(config.unlock_port, 9999);
        assert_eq!(config.log_level, LogLevel::Debug);
    }

    #[test]
    fn unlock_port_zero_disables_the_web_unlock_page() {
        let config = config_from(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_UNLOCK_PORT, "0"),
        ]);
        assert_eq!(config.unlock_port, 0);
        assert!(!config.web_unlock_enabled());
    }

    #[test]
    fn unparseable_unlock_port_is_rejected() {
        let err = SignerConfig::from_env_with(&env(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_UNLOCK_PORT, "not-a-port"),
        ]))
        .expect_err("port must parse");
        assert!(matches!(
            err,
            ConfigError::InvalidValue { var, .. } if var == ENV_UNLOCK_PORT
        ));
    }

    #[test]
    fn unknown_log_level_is_rejected() {
        let err = SignerConfig::from_env_with(&env(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_LOG_LEVEL, "verbose"),
        ]))
        .expect_err("log level must be one of the four");
        assert!(matches!(
            err,
            ConfigError::InvalidValue { var, .. } if var == ENV_LOG_LEVEL
        ));
    }

    // ── Peer uid check ──────────────────────────────────────────────────────

    #[test]
    fn peer_uid_check_is_off_unless_asked_for() {
        assert!(
            !minimal().require_peer_uid,
            "off is what keeps the daemon a drop-in replacement"
        );
    }

    #[test]
    fn peer_uid_check_accepts_the_usual_spellings() {
        for (raw, expected) in [
            ("1", true),
            ("true", true),
            ("TRUE", true),
            ("yes", true),
            ("on", true),
            (" on ", true),
            ("0", false),
            ("false", false),
            ("no", false),
            ("off", false),
        ] {
            let config = config_from(&[
                (ENV_RPC_URL, "http://localhost:8899"),
                (ENV_REQUIRE_PEER_UID, raw),
            ]);
            assert_eq!(config.require_peer_uid, expected, "for {raw:?}");
        }
    }

    #[test]
    fn peer_uid_check_rejects_a_value_it_cannot_read() {
        // The failure this guards: under JS truthiness "disabled" is a non-empty
        // string and would switch the check *on*. Refusing to boot is the only
        // answer that cannot be the opposite of what the operator meant.
        let err = SignerConfig::from_env_with(&env(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_REQUIRE_PEER_UID, "disabled"),
        ]))
        .expect_err("an unrecognised spelling must not be guessed at");
        assert!(matches!(
            err,
            ConfigError::InvalidValue { var, .. } if var == ENV_REQUIRE_PEER_UID
        ));
    }

    #[test]
    fn log_level_round_trips_through_its_name() {
        for level in [
            LogLevel::Debug,
            LogLevel::Info,
            LogLevel::Warn,
            LogLevel::Error,
        ] {
            assert_eq!(level.as_str().parse::<LogLevel>().unwrap(), level);
        }
    }

    // ── PolicyConfig ────────────────────────────────────────────────────────

    #[test]
    fn policy_config_carries_the_whitelist_and_jupiter() {
        let dest = Pubkey::new_unique();
        let config = config_from(&[
            (ENV_RPC_URL, "http://localhost:8899"),
            (ENV_DEST_WHITELIST, &dest.to_string()),
        ]);
        let policy = PolicyConfig::from(&config);
        assert_eq!(policy.jupiter, JUPITER_V6);
        assert!(policy.destination_whitelist.contains(&dest));
        assert!(policy.program_allowlist.contains(&policy.jupiter));
    }
}
