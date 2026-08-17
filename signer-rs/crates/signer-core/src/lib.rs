//! Pure-logic core of the Byreal transaction signer.
//!
//! This crate is a port of the TypeScript signer in `../../signer`. It holds
//! everything that can be decided without touching the network, the filesystem,
//! or an async runtime: configuration, the program allowlist, and the error
//! taxonomy. The daemon crate wires this up to a Unix socket and an RPC client.
//!
//! Deliberately free of `tokio`, sockets and HTTP so the security-relevant
//! decisions stay unit-testable in isolation.

pub mod alt;
pub mod config;
pub mod crypto;
pub mod error;
pub mod policy;
pub mod protocol;
pub mod rpc;
pub mod tx;

pub use config::{PolicyConfig, SignerConfig};
pub use policy::{PolicyEngine, Verdict};
