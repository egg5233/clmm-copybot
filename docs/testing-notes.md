# Testing notes

## Why source-grep tests were retired

A batch of tests under `tests/` did not exercise the bot at all. They called
`fs.readFileSync()` on `src/**/*.ts` (and on `public/index.html`, `.env.example`, `README.md`,
`CHANGELOG.md`) and asserted that specific substrings were present, absent, or appeared in a
particular order in the **source text**.

Each one was written to pin a real bugfix, so the intent was sound. The mechanism was not:

- **Formatting-fragile.** They matched on exact indentation and exact call spelling
  (`'  async auditByrealNftsOnChain()'`, `"return 'dry-run-open-position'"`). Running Prettier
  across the repo breaks them without any behaviour changing.
- **Rename-fragile in the wrong direction.** Renaming a symbol breaks the test even when the
  behaviour is preserved; conversely, gutting a function body keeps the test green as long as the
  grepped strings survive somewhere in the file.
- **No behavioural signal.** A passing run proved a string existed. It never proved the guard
  ran, the value was correct, or the regression stayed fixed.

The behaviour they cared about is now covered either by a real vitest test (see below) or by
nothing — recorded here so the reason each test existed survives the deletion.

## Deleted files

| Deleted file | Regression it guarded | Where that coverage went |
| --- | --- | --- |
| `tests/dashboard-audit-route.test.ts` | `POST /api/actions/audit-byreal-nfts` must call `auditByrealNftsOnChainAndQueueClose(ctx.opQueue)`, not the legacy non-closing `auditByrealNftsOnChain()` — otherwise the dashboard audit button reports orphans but never closes them. | Partly: `tests/byreal-audit-queue.test.ts` covers the queue-close step behaviourally. The route-to-method wiring itself is uncovered (needs an HTTP-level dashboard test). |
| `tests/dashboard-config-source.test.ts` | `GET`/`PATCH /api/config` and the dashboard UI must round-trip `byrealAllowSameTickWallets`, `byrealAllowOpenAfterOthersWallets`, `byrealMaxOpenPositions` and `poolAgeWhitelist`, persisting each to its env key through its normalize/serialize helper. Also pinned UI details: the two Chinese same-tick direction labels, the allow-open-after-others checkbox being disabled unless Byreal full-copy is selected, and state migration/cleanup on wallet row edit and removal. | Partly: `applyByrealMaxOpenPositionsConfig` is covered in `tests/byreal-position-cap.test.ts`; `tests/pool-age-whitelist-config.test.ts` and `tests/byreal-allow-same-tick.test.ts` cover the other helpers. The HTML/UI assertions are uncovered — they need a DOM test, not a grep. |
| `tests/dashboard-manual-swap-queue.test.ts` | v1.31.2 batch-swap queue resume: `/api/actions/force-swap` must go through `enqueueWithResult` at `NORMAL` priority (never `executeNow`), must return `paused: true` when HIGH-priority work is running or landed after the caller's `batchHighPrioritySeq` snapshot, and must invalidate asset caches before replying. Frontend side: a paused mint must be retried after waiting for the HIGH queue to drain (`i--` + `continue`), never counted as a failure, never time out, and never end the whole batch. | Nothing. This is genuinely valuable behaviour with no runtime test; `enqueueWithResult`/priority mechanics are partly covered by `tests/queue-priority.test.ts`. Re-covering the force-swap route needs an injectable dashboard handler. |
| `tests/pool-age-whitelist-source.test.ts` | v1.32.0 pool age whitelist: `POOL_AGE_WHITELIST` parsed via `parseMintSet`, persisted via `applyPoolAgeWhitelistConfig`, and the age guard (`config.minPoolAgeDays > 0 && !isPoolAgeWhitelisted(...)`) applied to exactly the OPEN and INCREASE paths in the Byreal executor — twice, never on the other four DEX executors, and never conflated with the separate TVL whitelist. | Partly: `tests/pool-age-whitelist.test.ts` and `tests/pool-age-whitelist-config.test.ts` cover `parseMintSet`, `isPoolAgeWhitelisted` and the config helper. The "guard is wired into OPEN and INCREASE only" claim is uncovered. |
| `tests/reconcile-background.test.ts` | Background reconcile must look up only the two mapped NFTs (target first, then ours) via `getPositionInfoByNftMint`, and must never fall back to a full `getParsedTokenAccountsByOwner` wallet scan, run the manual Byreal NFT audit, or emit per-position `status: 'checking'` logs — all of which were RPC-cost regressions. Also pinned the interval default moving to 360 minutes and the timer reading `config.reconcileIntervalMinutes` instead of a hardcoded 30 minutes. | Partly: `tests/reconcile-orphan-cleanup.test.ts`, `tests/reconcile-status.test.ts` and `tests/reconcile-log.test.ts` cover reconcile behaviour. The "must not scan all token accounts" cost guarantee is uncovered. |
| `tests/dashboard-byreal-cap-config.test.ts` | v1.31.0 dashboard cap PATCH: an invalid `byrealMaxOpenPositions` must persist as a normalized `0` rather than omitting `BYREAL_MAX_OPEN_POSITIONS` from the env update, and an absent field must leave both config and env untouched. | Fully preserved. This file was already behavioural (no source-grepping); its assertions were folded into `tests/byreal-position-cap.test.ts` so the whole cap feature lives in one suite. |

## Rewritten files

Three files kept their regression intent and were rewritten as behavioural vitest suites:

| File | What it now tests |
| --- | --- |
| `tests/byreal-position-cap.test.ts` | `normalizeByrealMaxOpenPositions` coercion rules; `PositionMap.countByDex`/`getByrealOpenCount` counting untagged legacy entries as Byreal while excluding the other four DEXes; `getByrealPositionCapStatus` disabled/under/at-cap results including the skip reason string; and `applyByrealMaxOpenPositionsConfig` PATCH persistence (folded in from the deleted cap-config test). |
| `tests/jupiter-priority-fee-strip.test.ts` | `stripJupiterComputeUnitPrice` on real `VersionedTransaction`s: removes Jupiter's `setComputeUnitPrice` while keeping `setComputeUnitLimit`, removes every occurrence when Jupiter sends several, no-ops cleanly, leaves swap instructions untouched, does not misread a lookup-table-resolved program id, and leaves the transaction serializable with blockhash, static keys and lookups intact. |
| `tests/byreal-audit-queue.test.ts` | `queueImportedByrealAuditCloses` via `ByrealPositionExecutor.prototype` with literal-object mocks: queues one `NORMAL` close per imported NFT with an NFT-prefixed label, actually calls `manualClosePosition` when the queued task runs, queues nothing when the audit imported no NFTs (so a plain audit stays non-closing), and records `enqueueFailed` instead of throwing when the queue rejects. |

Coverage intentionally dropped in the rewrites: the old cap test also asserted that the cap guard
in `copyOpenPosition` appears before the dry-run branch, the lock acquire, `retryGetPosition`,
balance reads, swaps and `createPositionInstructions`. That ordering matters (the cap must
short-circuit before any RPC spend), but reaching it at runtime needs a constructed
`ByrealPositionExecutor` with a mocked chain and connection. The old jupiter test likewise asserted
that `buildAndSendMetis` and `ultraSwap` strip after deserializing and before signing, and that
`prioritizationFeeLamports` is never requested.

## Ported files

Four more files were originally grouped with the batch above but were **not** source-grep tests —
each had a substantial behavioural half wrapped in top-level `assert` calls plus a grep head or
tail. They were ported to vitest rather than deleted: the grep assertions were stripped and every
behavioural assertion was preserved.

| File | What it now tests | Grep assertions stripped from it |
| --- | --- | --- |
| `tests/byreal-claim-cli-parity.test.ts` | 26 dependency-injection tests over `claimCopyBonusWithDepsForTest`, `claimLpFeesCliParityForTest`, `sendSignedFeePayloadForTest` and `parseByrealJsonResponseForTest` — reward-then-fee ordering on v2 endpoints only, zero-unclaimed positions filtered out, duplicate signatures deduped, a failed fee send recorded without losing the good one, fees encoded once and never resent, non-JSON backend replies reported readably, confirmation against the payload's own blockhash, epoch-window gating, fail-closed on a malformed or unavailable epoch, 504 retry on encode, 504 retry on order without re-encoding or re-signing, retry exhaustion with backoff, and the claim loop running past ten rounds until the epoch bonus reaches zero. Guards v1.31.1 (copy bonus claim loop). | `testDashboardRouteShape`: that `POST /api/actions/claim-all-byreal-fees` calls `claimLpFeesOffchain(conn)` and returns `ok`, `totalItems`, `txCount`, `failures`, `claimedTokens`, `summary`. |
| `tests/auto-claim-fee-payload-audit.test.ts` | The v1.29.2 restore: both the copy-bonus and LP-fee paths sign and send the **original** backend `txPayload`, never a rewritten one; fee encoding is requested only for the positions the position list returned. | That `auditBackendPriorityFeePayload`, `rewriteBackendPriorityFeePayload` and `MIN_SDK_PRIORITY_FEE_MICROLAMPORTS` are absent from `auto-claim.ts`, and that four named function bodies contain (or do not contain) specific call expressions. |
| `tests/sdk-priority-fee-no-jup-source.test.ts` | `stripByrealComputeUnitPriceInstructions` drops the SDK priority fee while preserving order; `makeByrealZeroPriorityTransaction` strips the SDK's `setComputeUnitPrice`, preserves an existing compute unit limit without duplicating it, prepends exactly one estimated limit when none exists, honours an explicit limit, and never adds a price instruction. | The Byreal/Pancake helper-name and call-count assertions, the `config.priorityFeeLamports` occurrence counts, and the `.env.example` / README / CHANGELOG / dashboard-UI substring checks. |
| `tests/jupiter-api-key-headers.test.ts` | `jupiterHeaders` carries the configured key; `jupiterFetch` attaches `x-api-key` to a GET without altering the URL and merges it into POST headers without clobbering `Content-Type`, `x-other` or the body. Guards v1.31.2 (Jupiter API headers). | That `jupiter-swap.ts`, `orca-position.ts` and `pancakeswap-position.ts` all reference `jupiterFetch` and none call bare `fetch` against the Jupiter base URL, plus the `config.jupiterApiBase` host assertions. |

The stripped grep assertions above are not covered by anything now. The recurring theme — "this
call site uses the right helper" — is a lint/architecture concern rather than a test concern; an
ESLint `no-restricted-syntax` rule would enforce it far more robustly than substring matching.
