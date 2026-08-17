# signer-rs

A Rust rewrite of the [TypeScript transaction signer](../signer/) — the
process that holds the bot's encrypted key and enforces signing policy. It is a
**drop-in replacement**: same Unix-socket wire protocol, same
`keyfile.enc.json` format, same env contract. The unmodified bot signs through
it with byte-identical results.

```
crates/
├── signer-core     # pure library: protocol framing, keyfile crypto, tx
│                   # parse/sign, ALT resolution, policy engine. No sockets,
│                   # no HTTP, no async runtime; all effects enter through
│                   # the SolanaRpc trait.
└── signer-daemon   # thin composition root: UnixListener accept loop,
                    # unlock flow (HTTP page + stdin race), real RPC client,
                    # `setup` bin for one-time key encryption.
fixtures-gen/       # TypeScript generators — golden vectors produced by the
                    # REAL TS implementation, committed under tests/fixtures/
e2e/                # harnesses that drive the daemon with the bot's actual
                    # client logic, including a differential run vs the TS signer
```

## Verification approach

The port is not verified against a human's reading of either codebase — it is
verified against the TypeScript implementation itself:

- **Byte-identical signing.** web3.js (tweetnacl) and solana-sdk
  (ed25519-dalek) both implement deterministic RFC-8032 Ed25519, so for the
  same key and message the signed bytes must match exactly. Golden vectors
  cover legacy, legacy-with-presigned-extra-keypair, v0, and v0-with-ALT
  transaction shapes.
- **Cross-implementation crypto.** Keyfiles encrypted by `signer/crypto.ts`
  decrypt here; keyfiles encrypted here decrypt in ts-node (an `--ignored`
  differential test shells out to Node to prove it).
- **Differential end-to-end.** `e2e/run-diff.ts` boots both signers with
  identical env and replays a request corpus — valid, malformed, and
  policy-violating — through the bot's real client code, diffing
  `{ok, tx, error}` field-by-field.
- **Error-string fidelity.** Rejection strings surface in bot logs, so the
  notable ones are reproduced verbatim (`Unknown program: <pid>`,
  `SPL SetAuthority is blocked — potential authority hijack`, the zh-TW unlock
  responses, …) and asserted byte-exact in tests.

## Design decisions

**Sync, thread-per-connection — no tokio.** The workload is one client, one
request per connection, a handful of requests per minute, each dominated by
1–3 sequential RPC round-trips. Async buys nothing here and would cost an
async-trait effect seam, harder mocking, and a large runtime dependency in a
security-critical binary. If this ever served many clients or multiplexed
requests per connection, `tokio` + `LengthDelimitedCodec` would be the shape.

**A single effect seam.** Everything the policy engine observes from the
outside world goes through `trait SolanaRpc` (accounts + simulation). Tests
inject `MockRpc`; the daemon injects `solana-client`. This is what keeps the
entire policy surface unit-testable offline.

**One policy path, not two.** The TS implementation duplicates its pipeline
for legacy vs v0 transactions. Here both normalize into `ResolvedTx`
(account keys + instruction views) before any check runs. For legacy
transactions the account list is the message's full key list — a strict
superset of the TS instruction-derived list, i.e. never more permissive.

**The 16-byte GCM IV stays.** `signer/crypto.ts` uses a non-standard 16-byte
IV (GCM's nominal nonce is 12 bytes). Node/OpenSSL handle this via the GHASH
derivation path of NIST SP 800-38D §7.1, and so does the `aes-gcm` crate with
a `U16` nonce parameter — that shared path is what makes the two sides
interoperate. Compatibility wins over cleanliness; migrating the keyfile
format to a 12-byte IV with a version field is future work.

**No `spl-token` crates.** The policy needs four hardcoded instruction
discriminator bytes and one ATA PDA derivation. Pulling the SPL crates for
that adds version-pinning pain with zero benefit.

## Fidelity vs deliberate change

Preserved verbatim (a drop-in replacement must not silently change policy):

| Behavior                                                | Note                                             |
| ------------------------------------------------------- | ------------------------------------------------ |
| Wire protocol, response shapes, error strings           | 4-byte BE length prefix + JSON                   |
| Simulation failures are non-fatal                       | only the CPI-allowlist finding blocks signing    |
| The Jupiter-v6 simulation exemption                     | preserved policy decision of the existing system |
| Socket perms 0660, server never closes after a response | client closes                                    |
| Unlock page, routes, and response bodies                | byte-exact, incl. zh-TW text                     |

Deliberately changed (each was a real gap in the TS implementation):

| Change                                                          | Why                                               |
| --------------------------------------------------------------- | ------------------------------------------------- |
| 64 KiB max frame length, reject + close                         | TS read an unbounded `Buffer.concat` — OOM vector |
| `while`-loop frame parsing                                      | TS used `if` — pipelined frames stalled           |
| SPL `Approve` enforced (whitelisted delegate or DEX tx)         | TS logged a warning but signed anyway             |
| Key material zeroized (`secrecy`/`zeroize`)                     | TS kept the key in a module-level string          |
| Exponential backoff on failed unlock attempts                   | TS had no rate limit on `POST /unlock`            |
| `versioned` request carrying legacy bytes is rejected           | web3.js silently fell back to the legacy decoder  |
| Opt-in `SO_PEERCRED` same-UID check (`SIGNER_REQUIRE_PEER_UID`) | socket was guarded by file perms only             |

## Threat model

The signer defends against a **compromised bot process**: the key never enters
the bot, and a hijacked bot can only submit transactions the policy engine
would sign anyway (allowlisted programs, checked SPL destinations, simulated
CPI discovery). It does **not** defend against a compromised host, a malicious
allowlisted program, or someone with the unlock password. The unlock HTTP
server is hardcoded to 127.0.0.1 and reached only through the dashboard's
authenticated proxy.

## Running

```bash
cargo run -p signer-daemon --bin setup    # one-time: encrypt your key
cargo run -p signer-daemon                # start (unlock via stdin or browser)
cargo test                                # offline suite (golden vectors committed)
cargo test -p signer-core -- --ignored    # differential tests (need node_modules at repo root)
npx ts-node e2e/run-diff.ts               # full differential run vs the TS signer
```
