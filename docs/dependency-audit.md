# Dependency audit triage

`npm audit --omit=dev` reports 23 findings (11 high, 12 moderate) as of 2026-08-18.
This page records the triage so the number is a known quantity rather than a surprise.

## Root causes

Every finding is **transitive** through the five DEX SDKs and `@solana/web3.js` v1,
which pin old versions of the vulnerable packages:

| Root advisory | Path | Exploitability here |
| --- | --- | --- |
| `bigint-buffer` buffer overflow via `toBigIntLE()` | all Solana SDKs → `@solana/buffer-layout-utils` | Parses on-chain account data the bot already treats as untrusted; no attacker-controlled length reaches the vulnerable call in our flows. |
| `bn.js` infinite loop | web3.js / SDK math | Requires attacker-supplied malformed bignum input; bot constructs its own BNs from parsed integers. |
| `body-parser` DoS | transitive server tooling | The dashboard uses the raw `node:http` API, not Express/body-parser; the package is present but not on our request path. |
| Old `@coral-xyz/anchor` chain | all five DEX SDKs | Advisory applies to Anchor's client IDL handling; inputs are the DEXes' own published IDLs. |

## Why they are not "fixed"

The DEX SDKs (`byreal-clmm-sdk-alpha`, `@orca-so/whirlpools-sdk`, `@meteora-ag/*`,
PancakeSwap) each pin the vulnerable majors. `npm audit fix --force` would
major-bump or remove the SDKs the bot exists to integrate — breaking the build to
silence advisories that our exploitability review does not reach. The honest
posture is documented residual risk, revisited when the SDKs publish releases on
web3.js v2 / current Anchor.

## Mitigations in place

- The signer boundary assumes the bot process (SDKs included) is compromisable:
  the key lives in a separate process behind a policy engine.
- `npm ci` from the committed lockfile — no floating resolution at deploy time.
- CI runs on every push, so a lockfile bump is exercised before it ships.
