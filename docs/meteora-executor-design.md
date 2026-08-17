# MeteoraPositionExecutor Architecture Design

## Overview

`MeteoraPositionExecutor` mirrors target wallet DLMM positions on Meteora, following the same patterns as `OrcaPositionExecutor` with all known bug countermeasures built in from day one.

**SDK**: `@meteora-ag/dlmm` (TypeScript, @solana/web3.js v1, no Anchor dependency)
**Program ID**: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
**Model**: Bin-based (discrete price bins, not continuous ticks like Orca/Byreal CLMM)

---

## Class Structure

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import DLMM from '@meteora-ag/dlmm';
import { PositionMap } from '../state/position-map';

const MODULE = 'MeteoraPos';

export class MeteoraPositionExecutor {
  // --- Connections ---
  private connection: Connection;       // Helius — TX execution
  private readConnection: Connection;   // Alchemy — all reads (SDK, balance, TX parse)
  private positionMap: PositionMap;
  private busy = false;
  private freeRpcIdx = 0;

  // --- Public state (same as Orca/Byreal) ---
  public solPaused = false;
  public solPausedAt: number | null = null;
  public drawdownPaused = false;
  public drawdownPausedAt: number | null = null;
  public lastSkipReason: string | null = null;
  public cachedSolBalance: number | null = null;
  public rentPerPosition: number = 0.0079; // fallback, queried from RPC at startup

  constructor(connection: Connection, positionMap: PositionMap) { ... }

  // --- Lock ---
  private acquire(caller: string): boolean;
  private release(): void;

  // --- Helpers ---
  private getSolBalance(): Promise<number>;
  private getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<BN>;
  private isTransientError(err: any): boolean;
  private isRetryableSimError(err: any): boolean;
  private getTokenSymbol(mint: string): string;
  private verifyTxSuccess(txSig: string): Promise<boolean>;
  private parseTxTokenChanges(txSig: string, owner: PublicKey): Promise<{mint: PublicKey, amount: BN}[]>;
  private addPendingSwap(mint: PublicKey, amount: BN): void;

  // --- Core Operations ---
  async copyOpenPosition(targetPositionAddress: string, poolAddress: string, targetWallet: string): Promise<string | null>;
  async copyClosePosition(targetPositionAddress: string): Promise<string | null>;
  async copyAddLiquidity(targetPositionAddress: string, targetWallet: string): Promise<string | null>;
  async copyRemoveLiquidity(targetPositionAddress: string): Promise<string | null>;
  async collectFees(ourPositionAddress: string): Promise<string | null>;

  // --- Dashboard/Reconcile ---
  async initRentPerPosition(): Promise<void>;
  backfillLockedSol(): void;
  hasMapping(targetNft: string): boolean;
  async manualClosePosition(ourPositionAddress: string): Promise<string | null>;
  async reconcileMeteoraPositions(queue: OperationQueue): Promise<void>;
  async getMeteoraLpValueUsd(): Promise<{lpUsd: number, feeUsd: number, count: number}>;
  async getPositionAssets(): Promise<Array<{mint: string, balance: number, ...}>>;
  updateConnection(newConn: Connection): void;
}
```

---

## Meteora DLMM SDK Key Differences from Orca

| Aspect | Orca Whirlpool | Meteora DLMM |
|--------|---------------|--------------|
| Price model | Tick-based (continuous) | Bin-based (discrete) |
| Position ID | NFT mint (PDA from nft) | Position PDA (from pool + owner + index) |
| SDK init | `WhirlpoolContext.from(conn, wallet)` | `DLMM.create(conn, poolPubkey)` — no wallet needed for reads |
| Open position | `pool.openPosition(tickLower, tickUpper, params)` | `dlmmPool.initializePositionAndAddLiquidityByWeight(params)` |
| Close position | `pool.closePosition(positionPda, slippage)` | `removeLiquidity` + `closePosition` (separate TXs) |
| Add liquidity | `position.increaseLiquidity(params)` | `dlmmPool.addLiquidityByWeight(params)` |
| Remove liquidity | `position.decreaseLiquidity(params)` | `dlmmPool.removeLiquidity(params)` |
| Fee collection | `position.collectFees()` | `dlmmPool.claimAllFees(params)` |
| TX building | `buildAndExecute()` returns sig | Returns `Transaction` — must sign + send ourselves |

### Critical: Bin Model Mirroring Strategy

Meteora uses **discrete bin IDs** instead of tick indices. When copying a target's position:

1. Read target position's `lowerBinId` and `upperBinId` from on-chain data
2. Copy exact same bin range (bins are absolute, not relative to current price)
3. Scale the liquidity amounts by `AMOUNT_RATIO` (per-wallet)

This is actually **simpler** than Orca ticks because bins are integer IDs with direct 1:1 correspondence.

---

## Method Designs

### constructor(connection, positionMap)

```
1. Store connection (Helius) as this.connection
2. Create readConnection from config.readRpcUrl (Alchemy) or fallback to connection
3. Store positionMap reference
4. Fetch initial SOL balance → cachedSolBalance
5. Log initialization
```

**No SDK context needed** — Meteora DLMM SDK creates per-pool instances via `DLMM.create(connection, poolPubkey)`, unlike Orca which needs a persistent WhirlpoolContext.

---

### copyOpenPosition(targetPositionAddress, poolAddress, targetWallet)

**Flow:**

```
PHASE 0: Pre-checks
├─ Check duplicate mapping → skip if exists
├─ Check solPaused / drawdownPaused → skip
├─ Check closeOnlyWallets → skip
├─ Check dryRun → return early
├─ Acquire lock

PHASE 1: Read target position (with RPC lag retry)
├─ Create DLMM instance: dlmmPool = await DLMM.create(readConnection, poolPubkey)
├─ Read target position data from on-chain account
│   └─ RETRY: 3 attempts with 2s/4s/6s backoff (bug fix: v1.20.8 RPC lag)
├─ Extract: lowerBinId, upperBinId, liquidity per bin
├─ Get pool info: mintX, mintY, binStep, activeId

PHASE 2: Filters
├─ Token blacklist check (SOL pairs blocked)
├─ Pump token filter (off/full/discord tri-state)
├─ Pool TVL filter via Meteora API:
│   GET https://dlmm-api.meteora.ag/pair/all_by_groups?search_term={poolAddress}
│   Cache 10min, same pattern as Orca getOrcaPoolTvl()
├─ Duplicate tick range check (same wallet + pool + bin range)

PHASE 3: Calculate deposit amounts
├─ Scale target amounts by getAmountRatio(targetWallet)
├─ If both scaled amounts are zero → skip

PHASE 4: Pre-swap (acquire tokens if insufficient)
├─ Read balanceX, balanceY via getTokenBalance()
├─ For tokenX deficit:
│   Try 1: tokenY → tokenX (if balance > 0)
│   Try 2: USDC → tokenX
│   After swap: invalidateHoldingsCache() + re-read balance
│   Re-read tokenY balance (swap may have consumed it)
├─ For tokenY deficit:
│   Try 1: USDC → tokenY
│   Try 2: tokenX → tokenY (ONLY if surplus — v1.20.1 fix)
│   After swap: re-read balance
├─ If both balances zero after swaps → abort

PHASE 5: Open position with retry
├─ MAX_OPEN_ATTEMPTS = 2
├─ For each attempt:
│   ├─ If retry: wait 2s, re-read balances
│   ├─ Cap tokenMax: BN.min(target, balance)
│   │   └─ LiquidityZero fix (v1.20.8): if one token is 0 but other isn't,
│   │     use wallet balance as max instead of 0
│   ├─ Build TX: dlmmPool.initializePositionAndAddLiquidityByWeight({
│   │     positionPubKey: Keypair.generate(),  // new position keypair
│   │     lowerBinId: targetLowerBinId,
│   │     upperBinId: targetUpperBinId,
│   │     totalXAmount: tokenMaxX,
│   │     totalYAmount: tokenMaxY,
│   │     user: userAddress,
│   │   })
│   ├─ Sign + send TX via sendWithRetry()
│   ├─ IMMEDIATELY save mapping BEFORE verifying (orphan recovery — v1.20.4)
│   │   positionMap.set(targetPos, ourPos, pool, targetWallet,
│   │                   lowerBinId, upperBinId, 'meteora')
│   │   positionMap.setLockedSol(targetPos, rentPerPosition)
│   ├─ Verify TX success → if failed, delete mapping + continue retry
│   └─ On buildAndExecute error:
│       ├─ Check if position exists on-chain despite error (orphan recovery)
│       ├─ If retryable (sim/transient): continue
│       └─ Otherwise: throw

PHASE 6: Cleanup (finally block)
├─ release() lock
├─ Update cachedSolBalance
├─ On insufficient lamports: set solPaused, notify Discord
```

**Bug countermeasures built in:**
- RPC lag (v1.20.8): 3x retry with progressive backoff reading target position
- LiquidityZero (v1.20.8): tokenMax=balance when one token is 0
- Simulation failed: 2x retry with balance re-read
- Orphan recovery (v1.20.4): write mapping immediately, delete on confirmed failure
- dex='meteora' field (v1.20.3): prevents Byreal reconcile from deleting our mappings
- Stale balance (v1.20.1): re-read balance after each swap
- Balance precheck (v1.20.2): Jupiter Holdings API before swap

---

### copyClosePosition(targetPositionAddress)

**Flow:**

```
PHASE 0: Pre-checks
├─ Lookup myPositionAddress from positionMap
├─ If no mapping → return null
├─ dryRun check
├─ Acquire lock

PHASE 1: Close with retry
├─ MAX_CLOSE_ATTEMPTS = 3
├─ For each attempt:
│   ├─ If retry: wait 2s
│   ├─ Create DLMM instance for the pool
│   ├─ Read our position data
│   │   └─ If position not found: delete mapping, return null
│   ├─ Step 1: Remove all liquidity
│   │   dlmmPool.removeLiquidity({
│   │     position: ourPosition,
│   │     user: userAddress,
│   │     binIds: allBinIds,
│   │     bps: new BN(10000),  // 100% = full removal
│   │   })
│   │   → Sign + send TX
│   ├─ Step 2: Close position account (reclaim rent)
│   │   dlmmPool.closePosition({
│   │     position: ourPosition,
│   │     owner: userAddress,
│   │   })
│   │   → Sign + send TX
│   ├─ Verify LAST TX success on-chain (v1.20.2 fix)
│   │   └─ If failed: retry loop continues
│   └─ On error: if retryable → continue, else → throw

PHASE 2: Post-close
├─ Delete mapping from positionMap
├─ Parse TX token changes → queue as pending swaps (v1.20.2 fix)
│   for (const {mint, amount} of received) addPendingSwap(mint, amount)

PHASE 3: Cleanup (finally block)
├─ release() lock
├─ On failure: notifyCloseFailed(), keep mapping (don't delete on TX failure)
```

**Bug countermeasures:**
- verifyTxSuccess (v1.20.2): always verify close TX on-chain before deleting mapping
- Pending swap tracking (v1.20.2): parse TX for received tokens, add to pending queue
- Dashboard close routing (v1.20.4): mapping has dex='meteora', dashboard routes to correct executor
- 3 retry attempts for transient errors

---

### copyAddLiquidity(targetPositionAddress, targetWallet)

**Flow:**

```
PHASE 0: Pre-checks
├─ Lookup myPositionAddress from positionMap
├─ Check solPaused / drawdownPaused / closeOnlyWallets
├─ dryRun check
├─ Acquire lock

PHASE 1: Read target with RPC lag protection (v1.20.9 fix)
├─ Wait 2s initial delay (freshly detected increase TX may not be on-chain yet)
├─ Read target position liquidity per bin
├─ Read our position liquidity per bin
├─ Calculate delta per bin
├─ RETRY (v1.20.9): if delta ≤ 0 on all bins:
│   wait 3s → re-read target → recalculate delta
│   Up to 2 retries with 3s backoff
├─ If delta still ≤ 0 → "already matches", return null

PHASE 2: Pre-swap (same as copyOpenPosition)
├─ Calculate total deltaX, deltaY across all bins
├─ Scale by getAmountRatio(targetWallet)
├─ Swap for deficits (same multi-path fallback)
├─ Re-read balances after swaps

PHASE 3: Add liquidity with retry
├─ MAX_INCREASE_ATTEMPTS = 2
├─ For each attempt:
│   ├─ If retry: wait 2s, re-read balances
│   ├─ Cap tokenMax: BN.min(delta, balance) (v1.20.2 fix)
│   │   └─ LiquidityZero fix: if one delta is 0, use balance
│   ├─ Build TX: dlmmPool.addLiquidityByWeight({
│   │     position: ourPosition,
│   │     user: userAddress,
│   │     totalXAmount: tokenMaxX,
│   │     totalYAmount: tokenMaxY,
│   │   })
│   ├─ Sign + send TX
│   └─ On error: if retryable → continue, else → throw

PHASE 4: Cleanup (finally block)
├─ release() lock
```

**Bug countermeasures:**
- RPC lag (v1.20.9): 2s initial delay + 3s backoff retry for delta calculation
- tokenMax cap (v1.20.2): BN.min(target, balance)
- LiquidityZero (v1.20.8): balance fallback when one token delta is 0
- Surplus-only last-resort swap (v1.20.1)

---

### copyRemoveLiquidity(targetPositionAddress)

**Flow:**

```
PHASE 0: Pre-checks
├─ Lookup myPositionAddress from positionMap
├─ If no mapping → return null

PHASE 1: Determine type (fee collection vs actual decrease)
├─ Read target position
│   ├─ If target still has liquidity → this is a partial decrease
│   │   → Bot collects fees only (same as Orca v1.20.0 known limitation)
│   │   → Return { txSig, type: 'COLLECT_FEE' }
│   └─ If target liquidity is zero → full remove
│       → Proceed with full removeLiquidity

PHASE 2: Fee collection path
├─ MAX_FEE_ATTEMPTS = 2
├─ dlmmPool.claimAllFees({ owner: userAddress, positions: [ourPosition] })
├─ Sign + send TX
├─ Return { txSig, type: 'COLLECT_FEE' }

PHASE 3: Full decrease path
├─ MAX_DECREASE_ATTEMPTS = 2
├─ dlmmPool.removeLiquidity({
│     position: ourPosition,
│     user: userAddress,
│     binIds: allBinIds,
│     bps: new BN(10000),  // 100%
│   })
├─ Sign + send TX
├─ Return { txSig, type: 'DECREASE' }

PHASE 4: Cleanup (finally block)
├─ release() lock
```

**Note**: Partial decrease (target removes some but not all liquidity) is handled as fee-collection-only, same limitation as Orca. Full mirroring of partial decreases would require tracking per-bin liquidity deltas — deferred to v2.

---

### collectFees(ourPositionAddress)

**Flow:**

```
PHASE 0: Pre-checks
├─ dryRun check
├─ Acquire lock

PHASE 1: Collect fees
├─ Create DLMM instance for pool (from position data)
├─ dlmmPool.claimAllFees({ owner: userAddress, positions: [ourPosition] })
├─ Sign + send TX
├─ Return txSig

PHASE 2: Fee overflow guard (v1.20.6 fix)
├─ When calculating fee quotes for dashboard display:
│   if (feeAmount > 1e15) clamp to 0
│   (Meteora may have similar overflow issue as Orca's subUnderflowU128)

PHASE 3: Cleanup (finally block)
├─ release() lock
```

---

### reconcileMeteoraPositions(queue)

**Flow:**

```
1. Filter positionMap entries where dex === 'meteora'
2. For each entry:
   ├─ Check if target position still exists on-chain
   │   └─ Use readConnection.getAccountInfo(targetPosition)
   ├─ If target gone → orphan detected
   ├─ If RPC transient error → skip (don't false-positive)
   └─ Rate limit: 500ms between checks
3. For each orphan:
   └─ queue.enqueue('meteora-orphan-close', 'NORMAL', () => copyClosePosition(targetNft))
```

---

### initRentPerPosition()

```
1. Query RPC for minimum rent-exempt balance for Meteora position accounts:
   - Position state account: ~8,976 bytes (DLMM position with bin arrays)
   - The exact size depends on number of bins — use a typical size
2. rentPerPosition = totalLamports / 1e9
3. Fallback to 0.0079 SOL if query fails
```

---

## Position Map Integration

### Mapping Structure

```typescript
positionMap.set(
  targetPositionAddress,  // target's position PDA
  ourPositionAddress,     // our position PDA
  `${mintX}/${mintY}`,    // pool label
  targetWallet,           // which target wallet
  lowerBinId,             // stored as tickLower field
  upperBinId,             // stored as tickUpper field
  'meteora',              // dex field — CRITICAL for reconcile isolation
);
```

**Key**: The `dex='meteora'` field ensures:
- Byreal reconcile skips meteora entries (v1.20.3 fix)
- Orca reconcile skips meteora entries
- Dashboard routes close requests to correct executor (v1.20.4 fix)
- `countByDex()` returns `{ byreal, orca, meteora }`

### Required PositionMap Changes

1. Add `'meteora'` to `countByDex()` return type
2. Add `getTotalLockedSolByDex()` to include meteora
3. Dashboard display: `B:3 O:4 M:2 (9)` format

---

## Meteora-Specific Concerns

### Bin Model Mirroring

- Bins are discrete price levels identified by integer `binId`
- A position spans `[lowerBinId, upperBinId]` — direct copy of these IDs
- The SDK's `initializePositionAndAddLiquidityByWeight` takes bin range + amounts
- **Advantage over Orca**: No need to initialize tick arrays — bins are implicit

### Rebalance Handling

When target does a rebalance (remove from old range + add to new range):
1. Parser detects `removeLiquidity` → bot follows with `copyRemoveLiquidity`
2. Parser detects `addLiquidity` to new range → bot needs to handle:
   - **Case A**: Same position, new bins → `copyAddLiquidity` handles it
   - **Case B**: New position entirely → `copyOpenPosition` handles it (old one was closed)
3. The WebSocket event ordering ensures remove happens before add

### TVL Query

```typescript
async function getMeteoraPairTvl(poolAddress: string): Promise<number | null> {
  // Cache: 10 min, same pattern as Orca
  const url = `https://dlmm-api.meteora.ag/pair/all_by_groups?search_term=${poolAddress}`;
  const res = await fetch(url);
  const data = await res.json();
  // Find matching group → pair → tvl
  return data?.groups?.[0]?.pairs?.[0]?.tvl ?? null;
}
```

### TX Building Pattern

Unlike Orca (which has `buildAndExecute()`), Meteora SDK returns raw `Transaction` objects. We need our own send helper:

```typescript
async function signAndSend(connection: Connection, tx: Transaction): Promise<string> {
  tx.feePayer = getUserAddress();
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(getKeypair());
  return sendWithRetry(connection, tx);  // reuse existing sendWithRetry from jupiter-swap.ts
}
```

**Important**: Check if SDK returns `Transaction` (legacy) or `VersionedTransaction`. Adjust signing accordingly.

---

## Config Changes Required

### New .env Variables

```
METEORA_TARGET_WALLETS=wallet1,wallet2,...
METEORA_CLOSE_ONLY_WALLETS=wallet3,...
METEORA_WALLET_AMOUNT_RATIOS=addr1:0.5,addr2:0.3
```

### config.ts Additions

```typescript
meteoraTargetWallets: Set<string>;
meteoraCloseOnlyWallets: Set<string>;
meteoraWalletAmountRatios: Map<string, number>;
```

---

## Error Handling Summary (All Orca Bug Fixes Applied)

| Bug | Version | Root Cause | Meteora Countermeasure |
|-----|---------|------------|----------------------|
| LiquidityZero | v1.20.8 | tokenMax=0 when one side is 0 | tokenMax=balance when opposite token is non-zero |
| RPC lag (open) | v1.20.8 | Position not on-chain yet | 3x retry with 2s/4s/6s backoff |
| RPC lag (increase) | v1.20.9 | Delta=0 false positive | 2s initial delay + 2x retry with 3s backoff |
| Simulation failed | - | Intermittent RPC error | 2x retry, re-read balance between attempts |
| verifyTxSuccess | v1.20.2 | TX "confirmed" but meta.err | Always verify on-chain before deleting mapping |
| Pending swap miss | v1.20.2 | Close leftover tokens untracked | parseTxTokenChanges → addPendingSwap |
| Dashboard route | v1.20.4 | Wrong executor for close | dex='meteora' in mapping |
| Stale balance | v1.20.1 | Balance not refreshed after swap | invalidateHoldingsCache + re-read after swap |
| Balance precheck | v1.20.2 | Fake slippage error | Jupiter Holdings API precheck |
| Surplus-only swap | v1.20.1 | Unnecessary tokenA→tokenB | Only swap if surplus exists |
| Fee overflow | v1.20.6 | BN > 1e15 overflow | Sanity guard: clamp to 0 if > 1e15 |
| tokenMax too large | v1.20.2 | Using target amount > balance | BN.min(target, balance) |
| Reconcile deletion | v1.20.3 | Byreal reconcile deletes others | dex='meteora' field isolation |
| Auto-migrate | v1.20.4 | Old entries missing dex field | Migration on load: if pool matches meteora → set dex |
| Orphan recovery | v1.20.4 | buildAndExecute fails after TX lands | Write mapping before TX, delete on confirmed failure |

---

## File Structure

```
src/executor/meteora-position.ts    — Main executor class
src/monitor/meteora-parser.ts       — TX parser (Task #5)
src/monitor/meteora-tvl.ts          — TVL cache (optional, could be inline)
```

---

## Integration Points

1. **index.ts**: Import MeteoraPositionExecutor, create instance alongside Byreal/Orca executors
2. **WebSocket handler**: Route parsed Meteora events to executor methods
3. **Dashboard API**: Add meteora routes for close/positions/stats
4. **Asset trend**: Include meteora LP + fees in snapshot
5. **Drawdown**: Shared drawdown callback (same as Orca)
6. **Discord**: Reuse existing notify functions (notifyOpenFailed, etc.)
7. **Reconcile**: Add 30min reconcile interval (same as Orca)
