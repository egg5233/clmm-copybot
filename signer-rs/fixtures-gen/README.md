# fixtures-gen

Generates the golden-vector fixtures that the Rust signer port (`signer-rs/`) is tested
against. The vectors are produced by the **live TypeScript implementation** — `signer/crypto.ts`,
`signer/alt-resolver.ts`, and `@solana/web3.js` — so a Rust implementation that reproduces them
is byte-compatible with the signer running in production, including keyfiles already on disk.

Everything here runs **offline**: no RPC, no network, no reading of any real keyfile. The address
lookup table is constructed and serialized locally rather than fetched from a cluster.

## Regenerating

```bash
cd signer-rs/fixtures-gen
npm run generate            # all three, in order
```

Or individually:

```bash
npx ts-node --project tsconfig.json gen-crypto-vectors.ts
npx ts-node --project tsconfig.json gen-tx-vectors.ts     # writes tx_vectors.json + alt_vectors.json
npx ts-node --project tsconfig.json gen-sim-log-vectors.ts
```

There is no `npm install` step: this package declares no dependencies and resolves
`@solana/web3.js`, `@solana/spl-token`, `bs58`, and `ts-node` from the repository root's
`node_modules` by normal Node module resolution. Run `npm install` at the repo root first if it
has not been done.

Type-check with `npm run typecheck` (`tsc --noEmit -p tsconfig.json`), which also covers the two
signer modules imported here.

## Generated files are committed

All four JSON files under `signer-rs/crates/signer-core/tests/fixtures/` are **committed to the
repository**. `cargo test` reads them directly and must never need Node, npm, or this generator.
Regenerate only when the TypeScript implementation's behaviour intentionally changes; a diff in
`tx_vectors.json`, `alt_vectors.json`, or `sim_log_vectors.json` that you did not intend is a
signal that the TS side changed underneath you.

| File                   | Generator                | Deterministic  |
| ---------------------- | ------------------------ | -------------- |
| `crypto_vectors.json`  | `gen-crypto-vectors.ts`  | no — see below |
| `tx_vectors.json`      | `gen-tx-vectors.ts`      | yes            |
| `alt_vectors.json`     | `gen-tx-vectors.ts`      | yes            |
| `sim_log_vectors.json` | `gen-sim-log-vectors.ts` | yes            |

`crypto_vectors.json` is **not** byte-stable across runs: `encryptKey` draws a fresh random
32-byte salt and 16-byte IV on every call, so the salt, IV, tag, and ciphertext all change. Each
regenerated file is equally valid — the Rust tests assert against the values recorded in the file
they read, not against a fixed ciphertext. Re-running the generator therefore produces a real diff
in git; that is expected and not a regression. The other three files must be byte-identical
between runs, and a diff there means something genuinely changed.

## Fixed inputs

All key material is derived from fixed 32-byte seeds of a single repeated byte
(`Keypair.fromSeed(new Uint8Array(32).fill(b))`). These are throwaway keypairs that have never
been used on-chain and hold no funds.

| Seed                        | Role                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[0x42; 32]`                | signer / bot wallet — **shared** between `crypto_vectors.json` and `tx_vectors.json`, so daemon-level tests can unlock the keyfile and then sign the transaction vectors with the same key |
| `[0x43; 32]`                | extra local signer (the DAMMv2 position-keypair shape)                                                                                                                                     |
| `[0x44; 32]`                | transfer recipient                                                                                                                                                                         |
| `[0x45; 32]`                | SPL mint                                                                                                                                                                                   |
| `[0x50; 32]`                | address lookup table account key                                                                                                                                                           |
| `[0x51; 32]`                | address lookup table authority                                                                                                                                                             |
| `[0x60; 32]` … `[0x67; 32]` | the 8 addresses stored in the lookup table                                                                                                                                                 |

Other fixed inputs:

- **Blockhash**: 32 bytes of `0x01`, base58-encoded (`4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi`).
- **Password**: `test-password-123` (`wrong` for the negative vector).
- **Token accounts**: real ATAs derived with `getAssociatedTokenAddressSync`, so the derivation
  is reproducible offline.

## What each file covers

### `crypto_vectors.json`

AES-256-GCM + scrypt keyfile format from `signer/crypto.ts`. Carries the scrypt parameters
(N=16384, r=8, p=1, 32-byte key) plus three vectors: `valid` (correct password → the original
base58 secret key and its pubkey), `wrong_password`, and `tampered_tag` (first auth-tag byte
XORed with `0xFF`, correct password — a port that ignores the GCM tag will wrongly accept this).
The generator asserts the round trip `decryptKey(encryptKey(k, pw), pw) === k` before writing, and
asserts that both negative vectors actually throw.

### `tx_vectors.json`

Four transactions, each with `unsigned_b64` (exactly what the bot sends over the Unix socket),
`ts_signed_b64` (the same transaction after the TypeScript signer signs it), and an `expected`
block:

| Vector                        | Kind      | Covers                                                                                                                                                            |
| ----------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy_spl_transfer`         | legacy    | single SPL `Transfer` (discriminator 3), destination extraction                                                                                                   |
| `legacy_two_signer_presigned` | legacy    | the `signLegacyWithExtra` shape (`src/utils/wallet.ts:144`): the extra key has already signed, slot 0 is zero-filled and must be filled without disturbing slot 1 |
| `v0_no_alt`                   | versioned | `MessageV0` with a System transfer and an SPL transfer, no lookup tables                                                                                          |
| `v0_with_alt`                 | versioned | `MessageV0` with one lookup table producing both writable and readonly lookups; `program_ids` and `account_keys` are post-expansion                               |

The `expected` values are not hand-written. They are derived by re-parsing the serialized unsigned
bytes and running the signer's own logic over them: `extractProgramIds` is imported directly from
`signer/alt-resolver.ts`, and the account-key ordering and SPL-transfer field offsets mirror
`signer/policy.ts`.

Two orderings matter and they are **not** the same, so each vector records which one applies in
`account_keys_source`:

- **Legacy** — `flatMap([programId, ...keys])` over instructions, deduplicated, in instruction
  order. This is what `policy.ts` builds, and it is _not_ the compiled message's key order.
- **Versioned** — static keys ++ writable lookups ++ readonly lookups, matching `resolveALTs`.

Likewise `program_ids` keeps duplicates on the legacy path (`policy.ts` maps instructions directly)
but is deduplicated first-seen on the versioned path (`extractProgramIds` uses a `Set`).

### `alt_vectors.json`

The lookup table used by `v0_with_alt`, including `raw_account_data_b64` — the on-chain account
data the signer would receive from `getMultipleAccountsInfo`, so the Rust ALT parser can be tested
without RPC. The layout is 56 bytes of header followed by packed 32-byte addresses:

```
0..4    type_index                   u32 LE (1 = LookupTable)
4..12   deactivation_slot            u64 LE (u64::MAX = active)
12..20  last_extended_slot           u64 LE
20..21  last_extended_slot_start_idx u8
21..22  authority Option tag         u8 (1 = Some)
22..54  authority                    Pubkey
54..56  padding                      u16
56..    addresses                    Pubkey[] packed, 32 bytes each
```

The leading `u32` type discriminator is easy to miss — `AddressLookupTableAccount.deserialize`
rejects the account outright if it is not `1`. The generator verifies its own serialization by
round-tripping the bytes through `AddressLookupTableAccount.deserialize()` and comparing the
address list, authority, and all three slot fields, throwing on any mismatch.

### `sim_log_vectors.json`

Three hand-written `simulateTransaction` log arrays with the program ids that
`extractInvokedPrograms` extracts from them: a simple two-program transaction, a Jupiter-routed
swap with nested CPIs, and one where an allowlisted DEX program CPIs into an off-allowlist program
(the case the check exists to catch).

The expected ids are produced by running the actual regex from `signer/policy.ts:321`,
`/Program (\w{32,44}) invoke/`, over the logs — the generator copies the literal rather than
importing it, because importing `policy.ts` pulls in `signer/config.ts`, which reads the signer
`.env` at import time. Each vector also declares its expected ids by hand and the generator throws
if the regex disagrees, so a typo in a log line cannot silently shrink a fixture.

Two behaviours the Rust port must reproduce rather than improve on:

- `policy.ts` **skips the invoked-program check entirely** when Jupiter is among the static program
  ids, since a route can touch dozens of AMMs. The `jupiter_routed_swap` vector records what the
  extractor would return, not a set that gets enforced; `jupiter_present` flags it.
- `\w{32,44}` will not match a pubkey whose base58 form is shorter than 32 characters (leading
  zero bytes). Reproducing this bound keeps the two implementations in agreement; fixing it in
  Rust only would make them disagree on such a transaction.
