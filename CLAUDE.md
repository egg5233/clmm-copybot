# CLAUDE.md — agent conventions for this repository

This repo is developed and maintained with Claude Code. Conventions an agent
(or a human) should follow here:

## Ground rules

- **Never touch real credentials.** `.env` is gitignored and must stay that way;
  `.env.example` carries placeholders only. The sanitization sweep in
  `docs/agentic-workflow.md` lists what counts as sensitive.
- **Every bugfix ships with a regression test.** Most files in `tests/` exist
  because something went wrong in production with real funds. Do not delete a
  test without recording its regression intent in `docs/testing-notes.md`.
- **Behavioral tests only.** Tests assert on runtime behavior through public
  entry points or prototype-level mocks — never on source-code text. The last
  batch of source-grep tests was retired in v1.33.0; do not reintroduce the
  pattern.
- **The signer is the trust boundary.** Bot-side code may be refactored freely;
  changes to `signer/` or `signer-rs/` policy semantics need an explicit
  decision recorded in the commit message. A drop-in signer replacement must
  not silently tighten or loosen policy.

## Commands

- `npm test` — vitest suite (fast, offline)
- `npm run typecheck && npm run lint && npm run format:check` — what CI runs
- `cd signer-rs && cargo test` — Rust signer suite (offline; golden vectors are
  committed, regenerate with `signer-rs/fixtures-gen/` only when the TS signer
  changes)
- `cargo test -p signer-core -- --ignored` — differential tests that shell out
  to ts-node (need `npm ci` done at the repo root)

## Compatibility invariants (checked by golden vectors)

- Signer wire protocol: 4-byte big-endian length prefix + JSON, request
  `{type: "versioned"|"legacy", tx: <base64>}`, response `{ok, tx?, error?}`.
- Keyfile format: AES-256-GCM with a 16-byte IV, scrypt N=16384/r=8/p=1,
  hex fields `{salt, iv, tag, data}`. Both implementations must read files the
  other wrote.
- Signed transactions are byte-identical between web3.js and solana-sdk for the
  same key and message (deterministic ed25519) — treat any divergence as a bug,
  not noise.
