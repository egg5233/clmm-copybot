# Meteora DLMM 整合計劃書

> 版本: 1.0 | 日期: 2026-03-09
> 目標: 完整整合 Meteora DLMM 作為第三個 DEX，與 Byreal / Orca 並行運作

---

## 前置條件驗證

### 1. 安裝 SDK 與 Anchor 相容性測試

```bash
npm install @meteora-ag/dlmm@1.9.3
```

**風險**: `@meteora-ag/dlmm` 依賴 `@coral-xyz/anchor@0.31.0`，而 Orca SDK 依賴 `@coral-xyz/anchor`（可能不同版本）。

**驗證步驟**:
1. `npm install` 後檢查是否有 peer dependency 衝突
2. `npx tsc --noEmit` 確認編譯無錯誤
3. 如果 Anchor 版本衝突：
   - 嘗試 `npm install @coral-xyz/anchor@0.31.0 --legacy-peer-deps`
   - 如果 Orca SDK 不相容 0.31.0，使用 `npm install --force` 讓 npm 自動 dedupe
   - 最壞情況：Meteora SDK 內部使用自己的 Anchor 實例，不會衝突（因為 JS 模組隔離）

### 2. SDK 基本功能測試

用 devnet 或 mainnet readonly 測試 SDK 能否載入：

```typescript
import DLMM from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';

const conn = new Connection('https://api.mainnet-beta.solana.com');
// 找一個已知的 Meteora DLMM pool 測試
const dlmm = await DLMM.create(conn, new PublicKey('KNOWN_POOL_ADDRESS'));
console.log('binStep:', dlmm.lbPair.binStep);
```

---

## Phase 1: 基礎設施

### 1.1 package.json

新增依賴：

```json
{
  "dependencies": {
    "@meteora-ag/dlmm": "^1.9.3"
  }
}
```

### 1.2 config.ts

在 `config` 物件中加入以下欄位（參照 Orca 的模式）：

```typescript
// 在 parseTargetWallets 呼叫後加入：
const { wallets: parsedMeteoraTargetWallets, ratios: parsedMeteoraWalletRatios } = parseTargetWallets(
  process.env.METEORA_TARGET_WALLETS || '',
);

// 在 config 物件內加入：
export const config = {
  // ... existing fields ...

  // Meteora DLMM
  meteoraProgramId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  meteoraTargetWallets: parsedMeteoraTargetWallets,
  meteoraWalletAmountRatios: parsedMeteoraWalletRatios,
  meteoraEnabled: parsedMeteoraTargetWallets.length > 0,
  meteoraCloseOnlyWallets: new Set(
    (process.env.METEORA_CLOSE_ONLY_WALLETS || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  ),
};
```

**新 .env 變數**:
```
METEORA_TARGET_WALLETS=wallet1:0.5,wallet2,...
METEORA_CLOSE_ONLY_WALLETS=wallet3,...
```

> 注意: `METEORA_WALLET_AMOUNT_RATIOS` 不需要獨立變數 — 已包含在 `METEORA_TARGET_WALLETS` 的 `:ratio` 語法中，與 Byreal/Orca 一致。

### 1.3 position-map.ts

需要修改 3 處：

**1.3.1 `countByDex()` 加入 meteora**:

```typescript
countByDex(): { byreal: number; orca: number; meteora: number } {
  let byreal = 0, orca = 0, meteora = 0;
  for (const entry of this.map.values()) {
    if (entry.dex === 'orca') orca++;
    else if (entry.dex === 'meteora') meteora++;
    else byreal++;
  }
  return { byreal, orca, meteora };
}
```

**1.3.2 `getTotalLockedSolByDex()` 加入 meteora**:

```typescript
getTotalLockedSolByDex(
  byrealFallback: number,
  orcaFallback: number,
  meteoraFallback: number,
): { byreal: number; orca: number; meteora: number } {
  let byreal = 0, orca = 0, meteora = 0;
  for (const entry of this.map.values()) {
    if (entry.dex === 'orca') {
      orca += entry.lockedSol ?? orcaFallback;
    } else if (entry.dex === 'meteora') {
      meteora += entry.lockedSol ?? meteoraFallback;
    } else {
      byreal += entry.lockedSol ?? byrealFallback;
    }
  }
  return { byreal, orca, meteora };
}
```

**1.3.3 Dashboard 顯示格式**: `B:3 O:4 M:2 (9)`

---

## Phase 2: Parser

### 2.1 ParsedEvent Types

在 `src/monitor/parser.ts` 的 `ParsedEvent` union type 加入：

```typescript
| { type: 'METEORA_OPEN_POSITION'; poolAddress: string; lowerBinId: number; width: number; positionAddress: string }
| { type: 'METEORA_CLOSE_POSITION'; positionAddress: string; receivedTokens: { mint: string; amount: string }[] }
| { type: 'METEORA_ADD_LIQUIDITY'; positionAddress: string }
| { type: 'METEORA_REMOVE_LIQUIDITY'; positionAddress: string }
```

> **命名差異**: Meteora 用 `positionAddress`（PDA 位址）而非 `positionNftMint`（NFT mint），因為 Meteora position 是 Keypair PDA，不是 NFT。但在 `positionMap` 中同樣以此 PDA 地址作為 key。

### 2.2 Discriminator Table

完整的 23 個 MUST + 1 個 OPTIONAL (rebalance) 指令 discriminator：

```typescript
// 加在 parser.ts 頂部（與 ORCA_IX_DISC 並列）
const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

const METEORA_IX_DISC: Record<string, string> = {
  // Open Position (4)
  'dbc0ea47bebf6650': 'initialize_position',
  '8f13f291d50f6873': 'initialize_position2',
  '2e527d92558de499': 'initialize_position_pda',
  'fbbdbef475fe2394': 'initialize_position_by_operator',

  // Close Position (3)
  '7b86510031446262': 'close_position',     // ⚠️ 與 Orca 相同 discriminator！
  'ae5a2373ba2893e2': 'close_position2',
  '3b7cd4765b986e9d': 'close_position_if_empty',

  // Add Liquidity (9)
  'b59d59438fb63448': 'add_liquidity',
  'e4a24e1c46db7473': 'add_liquidity2',
  '0703967f94283dc8': 'add_liquidity_by_strategy',
  '03dd95da6f8d76d5': 'add_liquidity_by_strategy2',
  '2905eeaf64e106cd': 'add_liquidity_by_strategy_one_side',
  '1c8cee63e7a21595': 'add_liquidity_by_weight',
  '5e9b6797465fdca5': 'add_liquidity_one_side',
  'a1c26754ab47fa9a': 'add_liquidity_one_side_precise',
  '2133a3c975627de7': 'add_liquidity_one_side_precise2',

  // Remove Liquidity (5)
  '5055d14818ceb16c': 'remove_liquidity',
  'e6d7527ff165e392': 'remove_liquidity2',
  '1a526698f04a691a': 'remove_liquidity_by_range',
  'cc02c391359191cd': 'remove_liquidity_by_range2',
  '0a333d2370691855': 'remove_all_liquidity',

  // Claim Fees (2)
  'a9204f8988e84689': 'claim_fee',
  '70bf65ab1c907fbb': 'claim_fee2',

  // Optional: Rebalance (Phase 2, 目前忽略但需辨識以避免誤判)
  '5c04b0c177b95309': 'rebalance_liquidity',
};
```

### 2.3 Account Index 表（v1 vs v2 差異）

Meteora v1/v2 的 account 排列差異很大，這裡列出 parser 需要的關鍵 index：

| 指令 | sender index | position index | lb_pair (pool) index | 備註 |
|------|-------------|---------------|---------------------|------|
| `initialize_position` (v1) | 0 (payer) | 1 (position) | 2 (lb_pair) | 還有 bin_array 在後面 |
| `initialize_position2` (v2) | 0 (payer) | 1 (position) | 2 (lb_pair) | 無 bin_array，更簡潔 |
| `initialize_position_pda` | 0 (payer) | 2 (position) | 3 (lb_pair) | base=1 在 position 前 |
| `add_liquidity` (v1) | 2 (sender) | 0 (position) | 1 (lb_pair) | sender 在 index 2 |
| `add_liquidity2` (v2) | 2 (sender) | 0 (position) | 1 (lb_pair) | 同 v1 |
| `add_liquidity_by_strategy` (v1) | 2 (sender) | 0 (position) | 1 (lb_pair) | |
| `add_liquidity_by_strategy2` (v2) | 2 (sender) | 0 (position) | 1 (lb_pair) | |
| `remove_liquidity` (v1) | 2 (sender) | 0 (position) | 1 (lb_pair) | bin_array_lower=4, upper=5 |
| `remove_liquidity2` (v2) | 2 (sender) | 0 (position) | 1 (lb_pair) | 無 bin_array（v2 移除）|
| `remove_all_liquidity` | 2 (sender) | 0 (position) | 1 (lb_pair) | |
| `remove_liquidity_by_range` (v1) | 2 (sender) | 0 (position) | 1 (lb_pair) | |
| `remove_liquidity_by_range2` (v2) | 2 (sender) | 0 (position) | 1 (lb_pair) | |
| `close_position` (v1) | 1 (sender) | 0 (position) | 2 (lb_pair) | ⚠️ sender=1（不是 0）|
| `close_position2` (v2) | 1 (sender) | 0 (position) | 2 (lb_pair) | |
| `claim_fee` (v1) | 2 (sender) | 0 (position) | 1 (lb_pair) | |
| `claim_fee2` (v2) | 2 (sender) | 0 (lb_pair) | 0 (lb_pair) | ⚠️ 順序反轉! lb_pair=0, position=1 |

> **重要**: 大多數指令 position=0, lb_pair=1, sender=2。例外是 `close_position`（sender=1）和 `claim_fee2`（lb_pair=0, position=1）。

### 2.4 parseMeteoraOperations() 完整偽代碼

```typescript
function parseMeteoraOperations(
  tx: ParsedTransactionWithMeta,
  _logs: string[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const meteoraIxs = findAllMeteoraInstructions(tx); // 同 findAllOrcaInstructions 模式

  // Step 1: 用 discriminator 分類所有 Meteora 指令
  let hasInitPosition = false;
  let hasClosePosition = false;
  let hasAddLiquidity = false;
  let hasRemoveLiquidity = false;
  let hasClaimFee = false;
  let hasRebalance = false;

  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name) continue;

    if (name.startsWith('initialize_position')) hasInitPosition = true;
    else if (name.startsWith('close_position')) hasClosePosition = true;
    else if (name.startsWith('add_liquidity')) hasAddLiquidity = true;
    else if (name.startsWith('remove_liquidity') || name === 'remove_all_liquidity') hasRemoveLiquidity = true;
    else if (name.startsWith('claim_fee')) hasClaimFee = true;
    else if (name === 'rebalance_liquidity') hasRebalance = true;
  }

  // Step 2: 解析 events（優先順序跟 Orca 一致）

  if (hasInitPosition) {
    // Meteora 不使用 NFT，而是 PDA 作為 position
    // 無法用 findNewNftMintsFromTx —— 改為從指令 accounts 直接讀取
    events.push(...parseMeteoraOpenPositions(tx, meteoraIxs, targetWallet));
  }

  if (hasAddLiquidity && !hasInitPosition) {
    events.push(...parseMeteoraAddLiquidity(tx, meteoraIxs, targetWallet));
  }

  if ((hasRemoveLiquidity && !hasInitPosition) || hasClosePosition) {
    events.push(...parseMeteoraRemoveOrClose(tx, meteoraIxs, hasClosePosition, targetWallet));
  }

  // claimFee alone（無 remove/close）→ 當作 remove event 處理（同 Orca collect_fees 邏輯）
  if (hasClaimFee && !hasRemoveLiquidity && !hasClosePosition && !hasInitPosition && !hasAddLiquidity) {
    events.push(...parseMeteoraRemoveOrClose(tx, meteoraIxs, false, targetWallet));
  }

  // rebalance = 單一指令（remove + add 合一）→ Phase 2 再支援
  // Phase 1 忽略，因為 rebalance 不會產生兩個 WS 事件
  if (hasRebalance) {
    logger.debug(MODULE, 'Meteora rebalance detected — Phase 2 feature, ignoring');
  }

  return events;
}
```

### parseMeteoraOpenPositions() 偽代碼

```typescript
function parseMeteoraOpenPositions(
  tx: ParsedTransactionWithMeta,
  meteoraIxs: PartiallyDecodedInstruction[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const targetStr = targetWallet.toBase58();

  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name || !name.startsWith('initialize_position')) continue;

    const accounts = ix.accounts || [];

    // 根據指令類型確定 account index
    let positionIdx: number;
    let poolIdx: number;
    let payerIdx: number;

    if (name === 'initialize_position_pda') {
      // initialize_position_pda: [0]payer [1]base [2]position [3]lb_pair ...
      payerIdx = 0;
      positionIdx = 2;
      poolIdx = 3;
    } else {
      // initialize_position / initialize_position2 / initialize_position_by_operator:
      // [0]payer [1]position [2]lb_pair ...
      payerIdx = 0;
      positionIdx = 1;
      poolIdx = 2;
    }

    if (accounts.length <= Math.max(positionIdx, poolIdx)) continue;

    // 驗證 payer 是 target wallet
    if (accounts[payerIdx].toBase58() !== targetStr) continue;

    const positionAddress = accounts[positionIdx].toBase58();
    const poolAddress = accounts[poolIdx].toBase58();

    // 解析指令 data 取得 lower_bin_id 和 width
    // discriminator(8 bytes) + lower_bin_id(i32, 4 bytes) + width(i32, 4 bytes)
    let lowerBinId = 0;
    let width = 0;
    try {
      const dataBytes = bs58.decode(ix.data);
      if (dataBytes.length >= 16) {
        // i32 little-endian at offset 8 and 12
        const buf = Buffer.from(dataBytes);
        lowerBinId = buf.readInt32LE(8);
        width = buf.readInt32LE(12);
      }
    } catch { /* use defaults */ }

    events.push({
      type: 'METEORA_OPEN_POSITION',
      poolAddress,
      lowerBinId,
      width,
      positionAddress,
    });
  }

  return events;
}
```

### parseMeteoraAddLiquidity() 偽代碼

```typescript
function parseMeteoraAddLiquidity(
  tx: ParsedTransactionWithMeta,
  meteoraIxs: PartiallyDecodedInstruction[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const targetStr = targetWallet.toBase58();
  const seen = new Set<string>(); // dedup same position in multi-instruction TX

  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name || !name.startsWith('add_liquidity')) continue;

    const accounts = ix.accounts || [];
    if (accounts.length < 3) continue;

    // add_liquidity 系列: [0]position [1]lb_pair [2]sender ...
    const positionAddress = accounts[0].toBase58();
    const sender = accounts[2].toBase58();

    if (sender !== targetStr) continue;
    if (seen.has(positionAddress)) continue;
    seen.add(positionAddress);

    events.push({
      type: 'METEORA_ADD_LIQUIDITY',
      positionAddress,
    });
  }

  return events;
}
```

### parseMeteoraRemoveOrClose() 偽代碼

```typescript
function parseMeteoraRemoveOrClose(
  tx: ParsedTransactionWithMeta,
  meteoraIxs: PartiallyDecodedInstruction[],
  hasClosePosition: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const targetStr = targetWallet.toBase58();
  const closedPositions = new Set<string>();
  const removedPositions = new Set<string>();

  // 先找所有 close_position 指令的 position address
  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name || !name.startsWith('close_position')) continue;

    const accounts = ix.accounts || [];
    if (accounts.length < 3) continue;

    // close_position: [0]position [1]sender [2]lb_pair ...
    const positionAddress = accounts[0].toBase58();
    const sender = accounts[1].toBase58();

    if (sender !== targetStr) continue;
    closedPositions.add(positionAddress);
  }

  // close_position detected → emit METEORA_CLOSE_POSITION
  if (closedPositions.size > 0) {
    const receivedTokens = parseBotReceivedTokens(tx, targetWallet);
    for (const posAddr of closedPositions) {
      events.push({
        type: 'METEORA_CLOSE_POSITION',
        positionAddress: posAddr,
        receivedTokens,
      });
    }
    return events; // close 優先，不再解析 remove
  }

  // 沒有 close → 找 remove_liquidity 作為 partial decrease
  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name) continue;
    if (!name.startsWith('remove_liquidity') && name !== 'remove_all_liquidity') continue;

    const accounts = ix.accounts || [];
    if (accounts.length < 3) continue;

    // remove_liquidity: [0]position [1]lb_pair [2]sender ...
    const positionAddress = accounts[0].toBase58();
    const sender = accounts[2].toBase58();

    if (sender !== targetStr) continue;
    if (removedPositions.has(positionAddress)) continue;
    removedPositions.add(positionAddress);

    events.push({
      type: 'METEORA_REMOVE_LIQUIDITY',
      positionAddress,
    });
  }

  // claimFee alone → 找 sender 持有的 position
  if (events.length === 0) {
    for (const ix of meteoraIxs) {
      const disc = getIxDiscriminator(ix.data);
      const name = METEORA_IX_DISC[disc];
      if (!name || !name.startsWith('claim_fee')) continue;

      const accounts = ix.accounts || [];
      // claim_fee: [0]position [1]lb_pair [2]sender ...
      // claim_fee2: [0]lb_pair [1]position [2]sender ... ⚠️ 順序不同!
      let positionAddress: string;
      let sender: string;

      if (name === 'claim_fee2') {
        if (accounts.length < 3) continue;
        positionAddress = accounts[1].toBase58(); // claim_fee2 position at index 1
        sender = accounts[2].toBase58();
      } else {
        if (accounts.length < 3) continue;
        positionAddress = accounts[0].toBase58();
        sender = accounts[2].toBase58();
      }

      if (sender !== targetStr) continue;

      events.push({
        type: 'METEORA_REMOVE_LIQUIDITY', // 當作 decrease 處理（fee collection path）
        positionAddress,
      });
      break; // 只取第一個
    }
  }

  return events;
}
```

### 2.5 Spam Filter 修正

在 `parseTransaction()` 的 spam filter 區域加入 Meteora：

```typescript
// 現有代碼：
const involvesByreal = logs.some(l => l.includes(config.byrealProgramId.toBase58()));
const involvesOrca = logs.some(l => l.includes(config.orcaProgramId.toBase58()));

// 加入：
const involvesMeteora = logs.some(l => l.includes(config.meteoraProgramId.toBase58()));

// Spam filter 修改：加入 !involvesMeteora
if (!involvesByreal && !involvesOrca && !involvesMeteora) {
  // existing spam filter logic...
}

// Jupiter swap 判斷：排除 Meteora
if (!involvesByreal && !involvesOrca && !involvesMeteora) {
  const jupEvent = parseJupiterSwap(tx, logs, targetWallet);
  if (jupEvent) events.push(jupEvent);
}

// Meteora 解析：在 Orca 之後
if (involvesMeteora && !involvesByreal && !involvesOrca) {
  const meteoraEvents = parseMeteoraOperations(tx, logs, targetWallet);
  events.push(...meteoraEvents);
}
```

> **重要**: `close_position` discriminator `7b86510031446262` 同時存在於 Orca 和 Meteora。spam filter 中先用 `logs.some()` 檢查 program ID 即可區分，因為 Orca program (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`) 和 Meteora program (`LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`) 是不同地址。若同一筆 TX 同時包含 Orca + Meteora 指令（極罕見），以 `!involvesOrca` gate 確保不會重複解析。

### 2.6 index.ts Event Routing

在 `handleEvent()` 的 switch 中加入 Meteora 分支（放在 Orca 之後）：

```typescript
// ===== Meteora DLMM Events =====

case 'METEORA_OPEN_POSITION': {
  if (!meteoraExecutor) {
    logger.debug(MODULE, `[${botLabel}][METEORA OPEN] Meteora not enabled, ignoring`);
    break;
  }
  if (meteoraExecutor.drawdownPaused || meteoraExecutor.solPaused) {
    const reason = meteoraExecutor.solPaused ? 'SOL 不足' : '資產跌幅暫停';
    logger.warn(MODULE, `[${botLabel}][METEORA OPEN] Skipped (${reason})`);
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: `Meteora: ${reason}`,
    });
    break;
  }
  if (config.meteoraCloseOnlyWallets.has(targetWallet.toBase58())) {
    logger.info(MODULE, `[${botLabel}][METEORA OPEN] Skipped (close-only target)`);
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: 'Meteora close-only',
    });
    break;
  }

  logger.info(MODULE, `[${botLabel}][METEORA OPEN] pool=${event.poolAddress.slice(0, 8)} bins=[${event.lowerBinId},${event.lowerBinId + event.width}] pos=${event.positionAddress.slice(0, 8)}`);

  if (meteoraExecutor.hasMapping(event.positionAddress)) {
    logger.info(MODULE, `[${botLabel}][METEORA OPEN] Already mapped, skipping`);
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: 'Meteora 重複目標',
    });
    break;
  }

  const ourSig = await meteoraExecutor.copyOpenPosition(
    event.positionAddress,
    event.poolAddress,
    targetWallet.toBase58(),
  );

  const skipReason = meteoraExecutor.lastSkipReason;
  meteoraExecutor.lastSkipReason = null;

  if (ourSig === null && skipReason) {
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: `Meteora: ${skipReason}`,
    });
    break;
  }

  pushEvent(eventLog, {
    ts: Date.now(), type: 'OPEN', targetWallet: targetWallet.toBase58(),
    targetNft: event.positionAddress, txSig: ourSig || undefined, success: !!ourSig,
    pool: positionMap.getPool(event.positionAddress),
  });
  if (ourSig) {
    logger.info(MODULE, `[${botLabel}][METEORA OPEN] Our TX: ${ourSig}`);
    refreshSolPrice().catch(() => {});
    byrealExecutor.invalidateAssetCaches();
  }
  break;
}

case 'METEORA_ADD_LIQUIDITY': {
  if (!meteoraExecutor) break;
  if (meteoraExecutor.solPaused || meteoraExecutor.drawdownPaused) {
    logger.warn(MODULE, `[${botLabel}][METEORA ADD] Skipped (paused)`);
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: 'Meteora paused',
    });
    break;
  }
  if (config.meteoraCloseOnlyWallets.has(targetWallet.toBase58())) {
    logger.info(MODULE, `[${botLabel}][METEORA ADD] Skipped (close-only)`);
    break;
  }
  logger.info(MODULE, `[${botLabel}][METEORA ADD] pos=${event.positionAddress.slice(0, 8)}`);

  if (!meteoraExecutor.hasMapping(event.positionAddress)) {
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: 'Meteora 無映射',
    });
    break;
  }

  const ourSig = await meteoraExecutor.copyAddLiquidity(event.positionAddress, targetWallet.toBase58());
  pushEvent(eventLog, {
    ts: Date.now(), type: 'INCREASE', targetWallet: targetWallet.toBase58(),
    targetNft: event.positionAddress, txSig: ourSig || undefined, success: !!ourSig,
  });
  if (ourSig) {
    logger.info(MODULE, `[${botLabel}][METEORA ADD] Our TX: ${ourSig}`);
    byrealExecutor.invalidateAssetCaches();
  }
  break;
}

case 'METEORA_REMOVE_LIQUIDITY': {
  if (!meteoraExecutor) break;
  logger.info(MODULE, `[${botLabel}][METEORA REMOVE] pos=${event.positionAddress.slice(0, 8)}`);

  if (!meteoraExecutor.hasMapping(event.positionAddress)) {
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: 'Meteora 無映射',
    });
    break;
  }

  const result = await meteoraExecutor.copyRemoveLiquidity(event.positionAddress);
  const evtType = result?.type || 'DECREASE';
  pushEvent(eventLog, {
    ts: Date.now(), type: evtType, targetWallet: targetWallet.toBase58(),
    targetNft: event.positionAddress, txSig: result?.txSig || undefined, success: !!result,
  });
  if (result) {
    logger.info(MODULE, `[${botLabel}][METEORA ${evtType}] Our TX: ${result.txSig}`);
    byrealExecutor.invalidateAssetCaches();
  }
  break;
}

case 'METEORA_CLOSE_POSITION': {
  if (!meteoraExecutor) break;
  logger.info(MODULE, `[${botLabel}][METEORA CLOSE] pos=${event.positionAddress.slice(0, 8)}`);

  byrealExecutor.recordBotCloseReceived(event.receivedTokens);

  if (!meteoraExecutor.hasMapping(event.positionAddress)) {
    pushEvent(eventLog, {
      ts: Date.now(), type: 'SKIP', targetWallet: targetWallet.toBase58(),
      targetNft: event.positionAddress, success: true, error: 'Meteora 無映射',
    });
    break;
  }

  const closePool = positionMap.getPool(event.positionAddress);
  const ourSig = await meteoraExecutor.copyClosePosition(event.positionAddress);
  pushEvent(eventLog, {
    ts: Date.now(), type: 'CLOSE', targetWallet: targetWallet.toBase58(),
    targetNft: event.positionAddress, txSig: ourSig || undefined, success: !!ourSig,
    pool: closePool,
  });
  if (ourSig) {
    logger.info(MODULE, `[${botLabel}][METEORA CLOSE] Our TX: ${ourSig}`);
    refreshSolPrice().catch(() => {});
    byrealExecutor.invalidateAssetCaches();
  }
  break;
}
```

在 `main()` 中初始化 Meteora executor：

```typescript
// 在 orcaExecutor 初始化之後：
const meteoraExecutor = config.meteoraEnabled
  ? new MeteoraPositionExecutor(connection, positionMap)
  : null;

if (meteoraExecutor) {
  logger.info(MODULE, `Meteora DLMM enabled: ${config.meteoraTargetWallets.length} target wallets`);
}

// onConnectionChange 加入 meteora
monitor.onConnectionChange((newConn) => {
  connection = newConn;
  byrealExecutor.updateConnection(newConn);
  if (orcaExecutor) orcaExecutor.updateConnection(newConn);
  if (meteoraExecutor) meteoraExecutor.updateConnection(newConn);
  logger.info(MODULE, 'All components updated with new connection');
});

// drawdown 加入 meteora
if (meteoraExecutor) {
  meteoraExecutor.drawdownPaused = true;
  meteoraExecutor.drawdownPausedAt = Date.now();
}

// reconcile 加入 meteora (30min)
if (meteoraExecutor) {
  meteoraExecutor.reconcileMeteoraPositions(opQueue).catch(err => {
    logger.error(MODULE, `Meteora reconcile error: ${err.message}`);
  });
}

// rent init 加入 meteora
if (meteoraExecutor) {
  meteoraExecutor.initRentPerPosition().then(() => {
    setMeteoraRentPerPosition(meteoraExecutor!.rentPerPosition);
    meteoraExecutor!.backfillLockedSol();
  }).catch(err => {
    logger.warn(MODULE, `Meteora rent init error (using fallback): ${err.message}`);
  });
  setMeteoraLpFetcher(() => meteoraExecutor!.getMeteoraLpValueUsd());
}
```

WebSocket 的 `getAllMonitoredWallets()` 也需要加入 Meteora wallets：

```typescript
// 在 getAllMonitoredWallets() 中加入：
for (const w of config.meteoraTargetWallets) {
  const addr = w.toBase58();
  if (!seen.has(addr)) { seen.add(addr); wallets.push(w); }
}
for (const addr of config.meteoraCloseOnlyWallets) {
  if (!seen.has(addr)) { seen.add(addr); wallets.push(new PublicKey(addr)); }
}
```

`handleEvent()` 的函數簽名需要加入 `meteoraExecutor`:

```typescript
async function handleEvent(
  byrealExecutor: ByrealPositionExecutor,
  orcaExecutor: OrcaPositionExecutor | null,
  meteoraExecutor: MeteoraPositionExecutor | null,  // 新增
  event: ParsedEvent,
  ...
)
```

BotContext 也需要加入：

```typescript
interface BotContext {
  // ... existing ...
  meteoraExecutor: MeteoraPositionExecutor | null;
}
```

---

## Phase 3: Executor

### 3.1 Class 結構（完整 interface）

檔案: `src/executor/meteora-position.ts`

```typescript
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import DLMM from '@meteora-ag/dlmm';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, getKeypair } from '../utils/wallet';
import { scaleAmount, getAmountRatio } from '../utils/ratio';
import { PositionMap } from '../state/position-map';
import { notifyOpenFailed, notifyCloseFailed, notifySolInsufficient, notifyPumpApproval, notifySwapFailed } from '../discord/notify';
import { isPumpPending, isPumpApproved, isPumpRejected, addPumpPending } from '../state/pump-pending';
import { swapForToken, getActualSwapOutput, lastSwapError, invalidateHoldingsCache } from './jupiter-swap';
import { OperationQueue } from './queue';
import * as fs from 'fs';
import * as path from 'path';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5';
const USDT_T22 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const STABLE_MINTS = new Set([USDC, USDT_MINT, USDT_T22]);

const MODULE = 'MeteoraPos';
const PENDING_FILE = './data/pending-swaps.json';

export class MeteoraPositionExecutor {
  private connection: Connection;       // Helius — TX execution + SDK 操作
  private readConnection: Connection;   // Alchemy — balance/position reads
  private positionMap: PositionMap;
  private busy = false;

  public solPaused = false;
  public solPausedAt: number | null = null;
  public drawdownPaused = false;
  public drawdownPausedAt: number | null = null;
  public lastSkipReason: string | null = null;
  public cachedSolBalance: number | null = null;
  public rentPerPosition: number = 0.0079; // fallback, queried from RPC

  constructor(connection: Connection, positionMap: PositionMap);
  updateConnection(newConn: Connection): void;
  get isBusy(): boolean;

  // --- Lock ---
  private acquire(caller: string): boolean;
  private release(): void;

  // --- Helpers ---
  private getSolBalance(): Promise<number>;
  private getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<BN>;
  private isTransientError(err: any): boolean;
  private isRetryableSimError(err: any): boolean;
  private getTokenSymbol(mint: string): string;
  private isTokenBlacklisted(mintX: string, mintY: string): boolean;
  private verifyTxSuccess(txSig: string): Promise<boolean>;
  private parseTxTokenChanges(txSig: string, owner: PublicKey): Promise<{ mint: PublicKey; amount: BN }[]>;
  private addPendingSwap(mint: PublicKey, amount: BN): void;
  private signAndSend(txOrTxs: Transaction | Transaction[]): Promise<string>;

  // --- Core Operations ---
  async copyOpenPosition(targetPositionAddress: string, poolAddress: string, targetWallet: string): Promise<string | null>;
  async copyClosePosition(targetPositionAddress: string): Promise<string | null>;
  async copyAddLiquidity(targetPositionAddress: string, targetWallet: string): Promise<string | null>;
  async copyRemoveLiquidity(targetPositionAddress: string): Promise<{ txSig: string; type: string } | null>;
  async collectFees(ourPositionAddress: string): Promise<string | null>;

  // --- Dashboard/Reconcile ---
  async initRentPerPosition(): Promise<void>;
  backfillLockedSol(): void;
  hasMapping(targetPos: string): boolean;
  async manualClosePosition(ourPositionAddress: string): Promise<string | null>;
  async reconcileMeteoraPositions(queue: OperationQueue): Promise<void>;
  async getMeteoraLpValueUsd(): Promise<{ lpUsd: number; feeUsd: number; count: number }>;
  isMeteoraPosition(positionAddress: string): Promise<boolean>;
}
```

### 3.2 OPEN — copyOpenPosition()

完整 step-by-step 偽代碼：

```typescript
async copyOpenPosition(
  targetPositionAddress: string,
  poolAddress: string,
  targetWallet: string,
): Promise<string | null> {
  const userAddress = getUserAddress();
  const userKp = getKeypair();

  // === PHASE 0: Pre-checks ===
  if (this.positionMap.get(targetPositionAddress)) {
    logger.warn(MODULE, `Already have mapping for target position ${targetPositionAddress.slice(0, 8)}, skipping`);
    return null;
  }
  if (this.solPaused) { this.lastSkipReason = 'SOL 不足暫停'; return null; }
  if (this.drawdownPaused) { this.lastSkipReason = '回撤保護暫停'; return null; }
  if (config.meteoraCloseOnlyWallets.has(targetWallet)) {
    this.lastSkipReason = 'Close-only 錢包';
    return null;
  }
  if (config.dryRun) {
    logger.info(MODULE, '[DRY RUN] Would copy open position', { poolAddress, targetPositionAddress });
    return 'dry-run-meteora-open';
  }
  if (!this.acquire('copyOpenPosition')) return null;

  try {
    // === PHASE 1: Read target position with RPC lag retry ===
    // BUG FIX: v1.20.8 — freshly opened positions may not be on-chain yet
    let dlmmPool: DLMM | null = null;
    let targetPosData: any = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        logger.info(MODULE, `Target position not found yet, waiting ${(attempt + 1) * 2}s (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
      }
      try {
        dlmmPool = await DLMM.create(this.readConnection, new PublicKey(poolAddress));
        const positions = await dlmmPool.getPositionsByUserAndLbPair(new PublicKey(targetWallet));
        // 找到匹配的 position
        targetPosData = positions.userPositions.find(
          p => p.publicKey.toBase58() === targetPositionAddress
        );
        if (targetPosData) break;
      } catch (err: any) {
        if (attempt < 2 && this.isTransientError(err)) continue;
        if (attempt === 2) throw err;
      }
    }

    if (!targetPosData || !dlmmPool) {
      logger.error(MODULE, `Cannot read target position after retries: ${targetPositionAddress.slice(0, 8)}`);
      return null;
    }

    // 取得 pool 和 position 資訊
    const mintX = dlmmPool.tokenX.publicKey;
    const mintY = dlmmPool.tokenY.publicKey;
    const mintXStr = mintX.toBase58();
    const mintYStr = mintY.toBase58();
    const poolLabel = `${mintXStr}/${mintYStr}`;
    const lowerBinId = targetPosData.positionData.lowerBinId;
    const upperBinId = targetPosData.positionData.upperBinId;

    // === PHASE 2: Filters ===

    // 2a. Token blacklist
    if (this.isTokenBlacklisted(mintXStr, mintYStr)) {
      this.lastSkipReason = '代幣黑名單';
      return null;
    }

    // 2b. Pump token filter (same tri-state as Orca)
    if (config.pumpFilterMode !== 'off') {
      const pumpMint = mintXStr.toLowerCase().includes('pump') ? mintXStr
        : mintYStr.toLowerCase().includes('pump') ? mintYStr : null;
      if (pumpMint) {
        if (!isPumpApproved(pumpMint)) {
          if (config.pumpFilterMode === 'full') {
            this.lastSkipReason = 'Pump 代幣過濾';
            return null;
          }
          // discord mode
          if (isPumpRejected(pumpMint)) { this.lastSkipReason = 'Pump 代幣已拒絕'; return null; }
          if (!isPumpPending(pumpMint)) {
            const symbol = this.getTokenSymbol(pumpMint);
            addPumpPending({ mint: pumpMint, symbol, pool: poolLabel, targetWallet, detectedAt: Date.now() });
            notifyPumpApproval(pumpMint, symbol, poolLabel).catch(() => {});
          }
          this.lastSkipReason = 'Pump 代幣等待確認';
          return null;
        }
      }
    }

    // 2c. Pool TVL filter (Meteora API)
    if (config.minPoolTvl > 0) {
      const tvl = await getMeteoraPairTvl(poolAddress);
      if (tvl === null || tvl < config.minPoolTvl) {
        this.lastSkipReason = `TVL 不足 ($${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl})`;
        return null;
      }
    }

    // 2d. Duplicate bin range check
    if (this.positionMap.hasDuplicateTickRange(targetWallet, poolLabel, lowerBinId, upperBinId)) {
      this.lastSkipReason = '重複 bin range';
      return null;
    }

    // === PHASE 3: Calculate deposit amounts ===
    const ratio = getAmountRatio(targetWallet); // 使用 meteora wallet ratios

    // 從 target position 的 bin 分佈計算 tokenX/tokenY 總量
    const targetAmountX = targetPosData.positionData.totalXAmount; // BN
    const targetAmountY = targetPosData.positionData.totalYAmount; // BN

    const ourTokenX = scaleAmount(targetAmountX, targetWallet);
    const ourTokenY = scaleAmount(targetAmountY, targetWallet);

    if (ourTokenX.isZero() && ourTokenY.isZero()) {
      this.lastSkipReason = '存款金額為零';
      return null;
    }

    logger.info(MODULE, `Target amounts: X=${targetAmountX.toString()}, Y=${targetAmountY.toString()}, ratio=${ratio}`);
    logger.info(MODULE, `Our deposit target: X=${ourTokenX.toString()}, Y=${ourTokenY.toString()}`);

    // === PHASE 4: Pre-swap (acquire tokens if insufficient) ===
    // BUG FIX: v1.20.1 — invalidateHoldingsCache + re-read balance after swap
    let balanceX = await this.getTokenBalance(userAddress, mintX);
    let balanceY = await this.getTokenBalance(userAddress, mintY);
    logger.info(MODULE, `Balances before swap: X=${balanceX.toString()}, Y=${balanceY.toString()}`);

    // Swap for tokenX if deficit
    if (balanceX.lt(ourTokenX) && !ourTokenX.isZero() && !mintX.equals(NATIVE_MINT) && mintXStr !== USDC) {
      const deficit = ourTokenX.sub(balanceX);
      logger.info(MODULE, `Need ${deficit.toString()} more of tokenX (${mintXStr})`);
      let txSig: string | null = null;

      // Try 1: tokenY → tokenX (if have tokenY surplus)
      if (!balanceY.isZero()) {
        txSig = await swapForToken(this.connection, mintYStr, mintXStr, deficit.toString());
      }
      // Try 2: USDC → tokenX
      if (!txSig) {
        txSig = await swapForToken(this.connection, USDC, mintXStr, deficit.toString());
      }
      if (!txSig) {
        notifySwapFailed(mintXStr, lastSwapError || 'all methods failed');
        return null;
      }
      // BUG FIX: v1.20.1 — stale balance after swap
      invalidateHoldingsCache();
      const addedX = await getActualSwapOutput(this.readConnection, txSig, mintXStr, userAddress.toBase58());
      if (addedX) {
        balanceX = balanceX.add(new BN(addedX));
      } else {
        await new Promise(r => setTimeout(r, 5000));
        balanceX = await this.getTokenBalance(userAddress, mintX);
      }
      // Re-read tokenY (swap may have consumed it)
      balanceY = await this.getTokenBalance(userAddress, mintY);
    }

    // Swap for tokenY if deficit
    if (balanceY.lt(ourTokenY) && !ourTokenY.isZero() && !mintY.equals(NATIVE_MINT) && mintYStr !== USDC) {
      const deficit = ourTokenY.sub(balanceY);
      logger.info(MODULE, `Need ${deficit.toString()} more of tokenY (${mintYStr})`);
      let txSig: string | null = null;

      // Try 1: USDC → tokenY
      txSig = await swapForToken(this.connection, USDC, mintYStr, deficit.toString());
      // Try 2: tokenX → tokenY (last resort, only if surplus — BUG FIX: v1.20.1)
      if (!txSig && balanceX.gt(ourTokenX)) {
        txSig = await swapForToken(this.connection, mintXStr, mintYStr, deficit.toString());
      }
      if (!txSig) {
        notifySwapFailed(mintYStr, lastSwapError || 'all methods failed');
        return null;
      }
      invalidateHoldingsCache();
      const addedY = await getActualSwapOutput(this.readConnection, txSig, mintYStr, userAddress.toBase58());
      if (addedY) {
        balanceY = balanceY.add(new BN(addedY));
      } else {
        await new Promise(r => setTimeout(r, 5000));
        balanceY = await this.getTokenBalance(userAddress, mintY);
      }
    }

    if (balanceX.isZero() && balanceY.isZero()) {
      logger.error(MODULE, 'No token balance for either side after swaps, cannot open position');
      return null;
    }

    // === PHASE 5: Open position with retry ===
    const MAX_OPEN_ATTEMPTS = 2;
    for (let openAttempt = 0; openAttempt < MAX_OPEN_ATTEMPTS; openAttempt++) {
      if (openAttempt > 0) {
        logger.info(MODULE, `Retrying open (attempt ${openAttempt + 1}/${MAX_OPEN_ATTEMPTS}), re-reading balances...`);
        await new Promise(r => setTimeout(r, 2000));
        balanceX = await this.getTokenBalance(userAddress, mintX);
        balanceY = await this.getTokenBalance(userAddress, mintY);
      }

      // BUG FIX: v1.20.2 — cap tokenMax: BN.min(target, balance)
      // BUG FIX: v1.20.8 — LiquidityZero: when one token is 0, use wallet balance
      const tokenMaxX = ourTokenX.isZero() && !ourTokenY.isZero()
        ? balanceX : BN.min(ourTokenX, balanceX);
      const tokenMaxY = ourTokenY.isZero() && !ourTokenX.isZero()
        ? balanceY : BN.min(ourTokenY, balanceY);

      logger.info(MODULE, `Position params: bins=[${lowerBinId}, ${upperBinId}]`, {
        tokenMaxX: tokenMaxX.toString(),
        tokenMaxY: tokenMaxY.toString(),
      });

      try {
        // SDK: initializePositionAndAddLiquidityByStrategy
        // ❌ 不使用 deprecated initializePositionAndAddLiquidityByWeight
        // ✅ 使用 initializePositionAndAddLiquidityByStrategy
        const newPositionKp = Keypair.generate();

        const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: newPositionKp.publicKey,
          user: userAddress,
          totalXAmount: tokenMaxX,
          totalYAmount: tokenMaxY,
          strategy: {
            maxBinId: upperBinId,
            minBinId: lowerBinId,
            strategyType: 0, // Spot strategy (均勻分佈)
          },
        });

        // SDK 返回 Transaction — 需自行 sign + send
        // SDK 內部已設 feePayer 和 blockhash
        // BUG FIX: v1.20.4 — write mapping BEFORE verifying (orphan recovery)
        const txSig = await this.signAndSend(createPositionTx);

        // 立即寫入 mapping（orphan recovery pattern）
        this.positionMap.set(
          targetPositionAddress,
          newPositionKp.publicKey.toBase58(),
          poolLabel,
          targetWallet,
          lowerBinId,
          upperBinId,
          'meteora',   // BUG FIX: v1.20.3 — dex field isolation
        );
        this.positionMap.setLockedSol(targetPositionAddress, this.rentPerPosition);

        // Verify TX success on-chain
        // BUG FIX: v1.20.2 — verify before declaring success
        const success = await this.verifyTxSuccess(txSig);
        if (!success) {
          logger.error(MODULE, `Open TX failed on-chain: ${txSig.slice(0, 8)}, deleting mapping`);
          this.positionMap.delete(targetPositionAddress);
          if (openAttempt < MAX_OPEN_ATTEMPTS - 1) continue;
          return null;
        }

        logger.info(MODULE, `Position opened: ${txSig} (pos=${newPositionKp.publicKey.toBase58().slice(0, 8)})`);
        return txSig;

      } catch (openErr: any) {
        // Orphan recovery: check if position exists on-chain despite error
        // (TX may have landed but confirmation timed out)
        // 注意: Meteora position 是 Keypair PDA，不像 Orca 有 positionMint 可查
        // 這裡只能 re-read positions from pool
        if (openAttempt < MAX_OPEN_ATTEMPTS - 1 && (this.isRetryableSimError(openErr) || this.isTransientError(openErr))) {
          logger.warn(MODULE, `Open attempt ${openAttempt + 1} failed (${(openErr.message || '').slice(0, 100)}), will retry...`);
          continue;
        }
        throw openErr;
      }
    }
    return null;

  } catch (err: any) {
    logger.error(MODULE, `Open position failed: ${err.message}`);
    notifyOpenFailed(err, targetPositionAddress);
    if (/insufficient lamports/i.test(err.message)) {
      this.solPaused = true;
      this.solPausedAt = Date.now();
      logger.error(MODULE, 'SOL 不足，已暫停開倉/加倉');
      notifySolInsufficient(this.cachedSolBalance ?? 0);
    }
    return null;
  } finally {
    // === PHASE 6: Cleanup ===
    this.release();
    this.getSolBalance().then(b => { this.cachedSolBalance = b; }).catch(() => {});
  }
}
```

> **Meteora vs Orca/Byreal 關鍵差異**:
> - Position 是 `Keypair.generate()` 產生的 PDA，不是 NFT mint
> - `DLMM.create()` 不需要 wallet context（只需 connection + pool pubkey）
> - SDK 返回 `Transaction` 物件，不是 `buildAndExecute()`
> - `getPosition()` 在 position 不存在時 **throw**（不是 return null）→ 需要 try-catch
> - `initializePositionAndAddLiquidityByWeight` 已 deprecated → 使用 `initializePositionAndAddLiquidityByStrategy`

### 3.3 CLOSE — copyClosePosition()

完整偽代碼：

```typescript
async copyClosePosition(targetPositionAddress: string): Promise<string | null> {
  const myPositionAddress = this.positionMap.get(targetPositionAddress);
  if (!myPositionAddress) {
    logger.warn(MODULE, `No mapped position for target: ${targetPositionAddress.slice(0, 8)}`);
    return null;
  }

  logger.info(MODULE, `Closing position: ${myPositionAddress.slice(0, 8)}...`);
  if (config.dryRun) {
    logger.info(MODULE, '[DRY RUN] Would close position', { myPositionAddress });
    return 'dry-run-meteora-close';
  }
  if (!this.acquire('copyClosePosition')) return null;

  try {
    const userAddress = getUserAddress();
    let lastTxSig: string | null = null;

    const MAX_CLOSE_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        logger.info(MODULE, `Retrying close (attempt ${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`);
        await new Promise(r => setTimeout(r, 2000));
      }

      try {
        // 讀取 pool 資訊（從 positionMap 的 pool label 解析 pool address）
        const poolAddress = await this.getPoolAddressForPosition(targetPositionAddress);
        if (!poolAddress) {
          logger.error(MODULE, 'Cannot determine pool address for position');
          this.positionMap.delete(targetPositionAddress);
          return null;
        }

        const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));

        // 讀取我們的 position
        let ourPosData: any;
        try {
          const positions = await dlmmPool.getPositionsByUserAndLbPair(userAddress);
          ourPosData = positions.userPositions.find(
            p => p.publicKey.toBase58() === myPositionAddress
          );
        } catch {
          // BUG FIX: Meteora SDK getPosition() throws on missing position
          ourPosData = null;
        }

        if (!ourPosData) {
          logger.warn(MODULE, `Position not found on-chain: ${myPositionAddress.slice(0, 8)}, deleting mapping`);
          this.positionMap.delete(targetPositionAddress);
          return null;
        }

        // Step 1: Remove ALL liquidity
        // SDK: removeLiquidity({ position, fromBinId, toBinId, bps, user })
        // ⚠️ removeLiquidity 參數是 fromBinId/toBinId（不是 binIds 陣列）
        // ⚠️ position 參數是 PublicKey（不是 LbPosition object）
        // ⚠️ removeLiquidity 可能返回 Transaction[]（多筆 TX，bin 數量超過上限時）
        const removeTxs = await dlmmPool.removeLiquidity({
          position: new PublicKey(myPositionAddress),
          user: userAddress,
          fromBinId: ourPosData.positionData.lowerBinId,
          toBinId: ourPosData.positionData.upperBinId,
          bps: new BN(10000), // 100% = full removal
        });

        // removeTxs 可能是 Transaction 或 Transaction[]
        const removeTxArray = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
        for (const tx of removeTxArray) {
          const sig = await this.signAndSend(tx);
          logger.info(MODULE, `Remove liquidity TX: ${sig}`);
          lastTxSig = sig;
        }

        // Step 2: Close position account (reclaim rent)
        // ⚠️ closePosition 參數是 LbPosition object（不是 PublicKey）
        // 但 SDK 內部可能只需要 publicKey — 需要傳入正確的格式
        const closeTx = await dlmmPool.closePosition({
          owner: userAddress,
          position: ourPosData, // SDK 需要完整的 position object
        });
        const closeSig = await this.signAndSend(closeTx);
        logger.info(MODULE, `Close position TX: ${closeSig}`);
        lastTxSig = closeSig;

      } catch (closeErr: any) {
        // 如果 removeLiquidity 成功但 closePosition 失敗：
        // 下次 retry 時 removeLiquidity 會發現 liquidity=0，直接跳到 closePosition
        if (attempt < MAX_CLOSE_ATTEMPTS - 1 && (this.isRetryableSimError(closeErr) || this.isTransientError(closeErr))) {
          logger.warn(MODULE, `Close attempt ${attempt + 1} failed (${(closeErr.message || '').slice(0, 100)}), will retry...`);
          continue;
        }
        throw closeErr;
      }

      if (!lastTxSig) return null;

      // BUG FIX: v1.20.2 — verify TX actually succeeded on-chain
      const success = await this.verifyTxSuccess(lastTxSig);
      if (success) break;

      if (attempt < MAX_CLOSE_ATTEMPTS - 1) {
        logger.warn(MODULE, `Close TX failed on-chain: ${lastTxSig.slice(0, 8)}, retrying...`);
        lastTxSig = null;
        continue;
      }
      logger.error(MODULE, `Close TX failed after ${MAX_CLOSE_ATTEMPTS} attempts, keeping mapping`);
      notifyCloseFailed(myPositionAddress, 'on-chain failure after max attempts', MAX_CLOSE_ATTEMPTS);
      return null;
    }

    if (!lastTxSig) return null;

    // Post-close: delete mapping
    logger.info(MODULE, `Position closed: ${myPositionAddress.slice(0, 8)} TX: ${lastTxSig}`);
    this.positionMap.delete(targetPositionAddress);

    // BUG FIX: v1.20.2 — parse TX for received tokens → queue as pending swaps
    const received = await this.parseTxTokenChanges(lastTxSig, userAddress);
    for (const { mint, amount } of received) {
      logger.info(MODULE, `Received from close: ${mint.toBase58().slice(0, 8)}... = ${amount.toString()}`);
      this.addPendingSwap(mint, amount);
    }

    return lastTxSig;

  } catch (err: any) {
    logger.error(MODULE, `Close position failed: ${err.message}`);
    notifyCloseFailed(myPositionAddress, err.message, 0);
    return null;
  } finally {
    this.release();
  }
}
```

> **Close 特殊注意事項**:
> 1. `removeLiquidity` 可能返回 `Transaction[]`（多筆 TX，當 position 跨越太多 bins）— 必須逐一 sign + send
> 2. `removeLiquidity` 參數是 `fromBinId/toBinId`（不是 binIds array）
> 3. `closePosition` 需要的 `position` 參數是 LbPosition object（不是 PublicKey）
> 4. **未來簡化路徑**: `removeLiquidity({ shouldClaimAndClose: true })` 可一步完成（Phase 2 穩定後再啟用）
> 5. removeLiquidity 成功但 closePosition 失敗時，retry 需先檢查 liquidity 狀態

### 3.4 SWAP — Pre-swap 流程

Pre-swap 邏輯已內嵌在 `copyOpenPosition()` 和 `copyAddLiquidity()` 中（Phase 4），這裡列出完整的 multi-path fallback 決策樹：

```
Pre-swap Decision Tree:
━━━━━━━━━━━━━━━━━━━━━━
For tokenX deficit (balanceX < ourTokenX):
  ├─ Skip if mintX is NATIVE_MINT or USDC (無需 swap)
  ├─ Try 1: balanceY > 0 → swapForToken(mintY → mintX, deficit)
  ├─ Try 2: swapForToken(USDC → mintX, deficit)
  ├─ After swap: invalidateHoldingsCache() → re-read balanceX
  │   ├─ Use getActualSwapOutput() for precise amount
  │   └─ Fallback: wait 5s → getTokenBalance() from RPC
  └─ Re-read balanceY (swap may have consumed tokenY)

For tokenY deficit (balanceY < ourTokenY):
  ├─ Skip if mintY is NATIVE_MINT or USDC
  ├─ Try 1: swapForToken(USDC → mintY, deficit)
  ├─ Try 2: balanceX > ourTokenX (surplus only!) → swapForToken(mintX → mintY, deficit)
  │   └─ BUG FIX: v1.20.1 — only swap if surplus exists, NOT unconditional
  └─ After swap: invalidateHoldingsCache() → re-read balanceY

Abort conditions:
  - All swap methods fail → notifySwapFailed() → return null
  - Both balances zero after swaps → return null
```

### 3.5 FEE — collectFees()

```typescript
async collectFees(ourPositionAddress: string): Promise<string | null> {
  if (config.dryRun) {
    logger.info(MODULE, '[DRY RUN] Would collect fees', { ourPositionAddress });
    return 'dry-run-meteora-fee';
  }
  if (!this.acquire('collectFees')) return null;

  try {
    const userAddress = getUserAddress();
    const poolAddress = await this.getPoolAddressForOurPosition(ourPositionAddress);
    if (!poolAddress) return null;

    const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));

    // SDK: claimAllSwapFee — 不是 claimAllFees!
    // ❌ claimAllFees 不存在
    // ✅ claimAllSwapFee
    const claimTxs = await dlmmPool.claimAllSwapFee({
      owner: userAddress,
      positions: [new PublicKey(ourPositionAddress)], // 可批量，但我們一個一個處理
    });

    // claimAllSwapFee 可能返回 Transaction[]
    const txArray = Array.isArray(claimTxs) ? claimTxs : [claimTxs];
    let lastSig = '';
    for (const tx of txArray) {
      lastSig = await this.signAndSend(tx);
      logger.info(MODULE, `Fee claim TX: ${lastSig}`);
    }

    return lastSig || null;

  } catch (err: any) {
    logger.error(MODULE, `Fee collection failed: ${err.message}`);
    return null;
  } finally {
    this.release();
  }
}
```

> **Fee overflow guard (BUG FIX: v1.20.6)**:
> 在 Dashboard 計算 fee value 時（`getMeteoraLpValueUsd`），若 fee BN > 1e15 則 clamp to 0。
> ```typescript
> const feeX = feeInfo.feeX; // BN
> const safeFeeX = feeX.gt(new BN('1000000000000000')) ? new BN(0) : feeX;
> ```

### 3.6 INCREASE — copyAddLiquidity()

```typescript
async copyAddLiquidity(
  targetPositionAddress: string,
  targetWallet: string,
): Promise<string | null> {
  const myPositionAddress = this.positionMap.get(targetPositionAddress);
  if (!myPositionAddress) {
    logger.warn(MODULE, `No mapped position for target: ${targetPositionAddress.slice(0, 8)}`);
    return null;
  }
  if (this.solPaused || this.drawdownPaused) {
    logger.info(MODULE, `[ADD] Skipped — paused`);
    return null;
  }
  if (config.meteoraCloseOnlyWallets.has(targetWallet)) {
    logger.info(MODULE, `[ADD] Skipped — close-only wallet`);
    return null;
  }
  if (config.dryRun) {
    return 'dry-run-meteora-add';
  }
  if (!this.acquire('copyAddLiquidity')) return null;

  try {
    const userAddress = getUserAddress();

    // BUG FIX: v1.20.9 — 2s initial delay (freshly detected increase TX may not be on-chain)
    await new Promise(r => setTimeout(r, 2000));

    const poolAddress = await this.getPoolAddressForPosition(targetPositionAddress);
    if (!poolAddress) return null;

    const dlmmPool = await DLMM.create(this.readConnection, new PublicKey(poolAddress));
    const mintX = dlmmPool.tokenX.publicKey;
    const mintY = dlmmPool.tokenY.publicKey;
    const mintXStr = mintX.toBase58();
    const mintYStr = mintY.toBase58();

    // 讀取 target position 的當前 amounts
    let targetAmountX: BN;
    let targetAmountY: BN;
    let ourAmountX: BN;
    let ourAmountY: BN;
    let deltaX: BN;
    let deltaY: BN;

    // BUG FIX: v1.20.9 — retry if delta ≤ 0 (RPC lag: target not updated yet)
    for (let readAttempt = 0; readAttempt < 2; readAttempt++) {
      if (readAttempt > 0) {
        logger.info(MODULE, 'Delta ≤ 0 after detecting add TX, waiting 3s for RPC...');
        await new Promise(r => setTimeout(r, 3000));
      }

      // Read target position
      const targetPositions = await dlmmPool.getPositionsByUserAndLbPair(
        new PublicKey(/* target wallet from mapping */this.positionMap.toJSON()[targetPositionAddress]?.targetWallet || '')
      );
      const targetPos = targetPositions.userPositions.find(
        p => p.publicKey.toBase58() === targetPositionAddress
      );
      if (!targetPos) {
        logger.warn(MODULE, 'Cannot read target position for add');
        return null;
      }

      // Scale target amounts by ratio
      targetAmountX = scaleAmount(targetPos.positionData.totalXAmount, targetWallet);
      targetAmountY = scaleAmount(targetPos.positionData.totalYAmount, targetWallet);

      // Read our position
      const ourPositions = await dlmmPool.getPositionsByUserAndLbPair(userAddress);
      const ourPos = ourPositions.userPositions.find(
        p => p.publicKey.toBase58() === myPositionAddress
      );
      if (!ourPos) {
        logger.warn(MODULE, 'Cannot read our position for add');
        return null;
      }

      ourAmountX = ourPos.positionData.totalXAmount;
      ourAmountY = ourPos.positionData.totalYAmount;

      deltaX = targetAmountX.sub(ourAmountX);
      deltaY = targetAmountY.sub(ourAmountY);

      if (deltaX.gt(new BN(0)) || deltaY.gt(new BN(0))) break;
    }

    if (deltaX!.lte(new BN(0)) && deltaY!.lte(new BN(0))) {
      logger.info(MODULE, 'Our position already matches or exceeds target, no add needed');
      return null;
    }

    logger.info(MODULE, `Add: deltaX=${deltaX!.toString()}, deltaY=${deltaY!.toString()}`);

    // Pre-swap (same pattern as copyOpenPosition Phase 4)
    let balanceX = await this.getTokenBalance(userAddress, mintX);
    let balanceY = await this.getTokenBalance(userAddress, mintY);

    // [Pre-swap logic identical to copyOpenPosition — omitted for brevity]
    // Use deltaX/deltaY instead of ourTokenX/ourTokenY

    // Add liquidity with retry
    const MAX_ADD_ATTEMPTS = 2;
    for (let addAttempt = 0; addAttempt < MAX_ADD_ATTEMPTS; addAttempt++) {
      if (addAttempt > 0) {
        await new Promise(r => setTimeout(r, 2000));
        balanceX = await this.getTokenBalance(userAddress, mintX);
        balanceY = await this.getTokenBalance(userAddress, mintY);
      }

      // BUG FIX: v1.20.2 — cap tokenMax: BN.min(delta, balance)
      // BUG FIX: v1.20.8 — LiquidityZero: when one delta is 0, use balance
      const tokenMaxX = deltaX!.lte(new BN(0)) && deltaY!.gt(new BN(0))
        ? balanceX : BN.min(deltaX!, balanceX);
      const tokenMaxY = deltaY!.lte(new BN(0)) && deltaX!.gt(new BN(0))
        ? balanceY : BN.min(deltaY!, balanceY);

      try {
        // SDK: addLiquidityByStrategy
        const addTx = await dlmmPool.addLiquidityByStrategy({
          positionPubKey: new PublicKey(myPositionAddress),
          user: userAddress,
          totalXAmount: tokenMaxX,
          totalYAmount: tokenMaxY,
          strategy: {
            maxBinId: ourPos!.positionData.upperBinId,
            minBinId: ourPos!.positionData.lowerBinId,
            strategyType: 0, // Spot
          },
        });

        const txSig = await this.signAndSend(addTx);
        logger.info(MODULE, `Add liquidity TX: ${txSig}`);
        return txSig;

      } catch (addErr: any) {
        if (addAttempt < MAX_ADD_ATTEMPTS - 1 && (this.isRetryableSimError(addErr) || this.isTransientError(addErr))) {
          logger.warn(MODULE, `Add attempt ${addAttempt + 1} failed, retrying...`);
          continue;
        }
        throw addErr;
      }
    }
    return null;

  } catch (err: any) {
    logger.error(MODULE, `Add liquidity failed: ${err.message}`);
    return null;
  } finally {
    this.release();
  }
}
```

### 3.7 DECREASE — copyRemoveLiquidity()

```typescript
async copyRemoveLiquidity(
  targetPositionAddress: string,
): Promise<{ txSig: string; type: string } | null> {
  const myPositionAddress = this.positionMap.get(targetPositionAddress);
  if (!myPositionAddress) {
    logger.warn(MODULE, `No mapped position for target: ${targetPositionAddress.slice(0, 8)}`);
    return null;
  }
  if (!this.acquire('copyRemoveLiquidity')) return null;

  try {
    const userAddress = getUserAddress();
    const poolAddress = await this.getPoolAddressForPosition(targetPositionAddress);
    if (!poolAddress) return null;

    const dlmmPool = await DLMM.create(this.readConnection, new PublicKey(poolAddress));

    // Read target position to determine type
    const targetWalletAddr = this.positionMap.toJSON()[targetPositionAddress]?.targetWallet;
    let targetHasLiquidity = true;

    if (targetWalletAddr) {
      try {
        const targetPositions = await dlmmPool.getPositionsByUserAndLbPair(new PublicKey(targetWalletAddr));
        const targetPos = targetPositions.userPositions.find(
          p => p.publicKey.toBase58() === targetPositionAddress
        );
        if (targetPos) {
          const totalLiq = targetPos.positionData.totalXAmount.add(targetPos.positionData.totalYAmount);
          targetHasLiquidity = totalLiq.gt(new BN(0));
        }
      } catch { /* target position may be closed already */ }
    }

    // Partial decrease (target still has liquidity) → collect fees only
    // Same limitation as Orca (v1.20.0): partial decrease mirroring deferred to v2
    if (targetHasLiquidity) {
      logger.info(MODULE, 'Target has remaining liquidity → fee collection only (partial decrease = v2)');

      const MAX_FEE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_FEE_ATTEMPTS; attempt++) {
        try {
          // ✅ claimAllSwapFee（不是 claimAllFees）
          const feeTxs = await dlmmPool.claimAllSwapFee({
            owner: userAddress,
            positions: [new PublicKey(myPositionAddress)],
          });
          const txArray = Array.isArray(feeTxs) ? feeTxs : [feeTxs];
          let lastSig = '';
          for (const tx of txArray) {
            lastSig = await this.signAndSend(tx);
          }
          if (lastSig) return { txSig: lastSig, type: 'COLLECT_FEE' };
        } catch (err: any) {
          if (attempt < MAX_FEE_ATTEMPTS - 1 && this.isTransientError(err)) continue;
          throw err;
        }
      }
      return null;
    }

    // Full decrease (target liquidity zero) → remove all our liquidity
    const MAX_DECREASE_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_DECREASE_ATTEMPTS; attempt++) {
      try {
        const ourPositions = await dlmmPool.getPositionsByUserAndLbPair(userAddress);
        const ourPos = ourPositions.userPositions.find(
          p => p.publicKey.toBase58() === myPositionAddress
        );
        if (!ourPos) {
          logger.warn(MODULE, 'Our position not found for decrease');
          return null;
        }

        // ⚠️ removeLiquidity: position = PublicKey, fromBinId/toBinId (not binIds array)
        const removeTxs = await dlmmPool.removeLiquidity({
          position: new PublicKey(myPositionAddress),
          user: userAddress,
          fromBinId: ourPos.positionData.lowerBinId,
          toBinId: ourPos.positionData.upperBinId,
          bps: new BN(10000), // 100%
        });

        const txArray = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
        let lastSig = '';
        for (const tx of txArray) {
          lastSig = await this.signAndSend(tx);
        }
        if (lastSig) return { txSig: lastSig, type: 'DECREASE' };

      } catch (err: any) {
        if (attempt < MAX_DECREASE_ATTEMPTS - 1 && this.isTransientError(err)) continue;
        throw err;
      }
    }
    return null;

  } catch (err: any) {
    logger.error(MODULE, `Remove liquidity failed: ${err.message}`);
    return null;
  } finally {
    this.release();
  }
}
```

### 3.8 signAndSend Helper

```typescript
/**
 * Sign and send a Transaction (or Transaction array).
 * SDK 已設 feePayer 和 blockhash — 只需 sign + send。
 * 但如果 SDK 沒設（部分 SDK 版本行為不一致），我們 fallback 設置。
 *
 * ⚠️ SDK 可能返回 Transaction (legacy) 或 VersionedTransaction。
 * 目前 @meteora-ag/dlmm 返回 legacy Transaction。
 */
private async signAndSend(txOrTxs: Transaction | Transaction[]): Promise<string> {
  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const kp = getKeypair();
  const userAddress = getUserAddress();
  let lastSig = '';

  for (const tx of txs) {
    // Ensure feePayer and blockhash are set (SDK should set these, but fallback)
    if (!tx.feePayer) {
      tx.feePayer = userAddress;
    }
    if (!tx.recentBlockhash) {
      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
    }

    // Sign
    tx.sign(kp);

    // Send with retry (reuse existing pattern from jupiter-swap.ts)
    for (let i = 0; i < config.maxRetry; i++) {
      try {
        const sig = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: config.skipPreflight,
          maxRetries: 2,
        });
        const latestBlockhash = await this.connection.getLatestBlockhash();
        await this.connection.confirmTransaction({
          signature: sig,
          ...latestBlockhash,
        }, 'confirmed');

        // BUG FIX: v1.20.2 — verify meta.err after confirmTransaction
        const txResult = await this.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        if (txResult?.meta?.err) {
          throw new Error(`TX confirmed but failed on-chain: ${JSON.stringify(txResult.meta.err)}`);
        }

        lastSig = sig;
        break;
      } catch (err: any) {
        if (i === config.maxRetry - 1) throw err;
        logger.warn(MODULE, `Send attempt ${i + 1} failed: ${err.message}, retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  return lastSig;
}
```

> **VersionedTransaction 注意**: 如果未來 Meteora SDK 切換到 VersionedTransaction，需要改用 `VersionedTransaction.deserialize()` + `tx.sign([kp])` 而非 `tx.sign(kp)`。目前 v1.9.3 使用 legacy Transaction。

### 3.9 TVL Query

```typescript
// Meteora pool TVL cache
const meteoraTvlCache = new Map<string, { tvlUsdc: number; fetchedAt: number }>();
const METEORA_TVL_CACHE_MS = 10 * 60 * 1000; // 10 min

async function getMeteoraPairTvl(poolAddress: string): Promise<number | null> {
  const cached = meteoraTvlCache.get(poolAddress);
  if (cached && Date.now() - cached.fetchedAt < METEORA_TVL_CACHE_MS) return cached.tvlUsdc;

  try {
    const res = await fetch(
      `https://dlmm-api.meteora.ag/pair/all_by_groups?sort_key=tvl&order_by=desc&search_term=${poolAddress}`
    );
    if (!res.ok) return cached?.tvlUsdc ?? null;

    const data = (await res.json()) as any;
    // Response structure: { groups: [{ pairs: [{ address, tvl, ... }] }] }
    const pairs = data?.groups?.[0]?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return cached?.tvlUsdc ?? null;

    const match = pairs.find((p: any) => p.address === poolAddress);
    const tvl = parseFloat(match?.tvl ?? '0');

    meteoraTvlCache.set(poolAddress, { tvlUsdc: tvl, fetchedAt: Date.now() });
    return tvl;
  } catch {
    return cached?.tvlUsdc ?? null;
  }
}
```

---

## Phase 4: Dashboard + 完善

### 4.1 Dashboard API

**4.1.1 countByDex 擴展**:

在 `server.ts` 的 `/api/status` 端點中：

```typescript
const posByDex = ctx.positionMap.countByDex(); // 已改為返回 { byreal, orca, meteora }
const meteoraRent = ctx.meteoraExecutor?.rentPerPosition ?? 0.0079;
const lockedByDex = ctx.positionMap.getTotalLockedSolByDex(
  ctx.executor.rentPerPosition, orcaRent, meteoraRent
);
```

前端顯示：`B:${posByDex.byreal} O:${posByDex.orca} M:${posByDex.meteora} (${posCount})`

**4.1.2 Close routing**:

在 Dashboard 的 close API 中，根據 `positionMap.getDex(targetNft)` 路由到正確的 executor：

```typescript
// /api/close-position handler
const dex = ctx.positionMap.getDex(targetNft);
if (dex === 'meteora') {
  result = await ctx.meteoraExecutor!.copyClosePosition(targetNft);
} else if (dex === 'orca') {
  result = await ctx.orcaExecutor!.copyClosePosition(targetNft);
} else {
  result = await ctx.executor.copyClosePosition(targetNft);
}
```

### 4.2 Asset Trend（Meteora LP + fee value）

新增 `setMeteoraLpFetcher` 和 `setMeteoraRentPerPosition` 到 `asset-trend.ts`：

```typescript
// asset-trend.ts
let meteoraLpFetcher: (() => Promise<{ lpUsd: number; feeUsd: number; count: number }>) | null = null;
let meteoraRentPerPos = 0.0079;

export function setMeteoraLpFetcher(fn: () => Promise<{ lpUsd: number; feeUsd: number; count: number }>) {
  meteoraLpFetcher = fn;
}
export function setMeteoraRentPerPosition(rent: number) {
  meteoraRentPerPos = rent;
}

// 在 snapshot 計算中加入：
if (meteoraLpFetcher) {
  try {
    const meteoraLp = await meteoraLpFetcher();
    totalLpUsd += meteoraLp.lpUsd + meteoraLp.feeUsd;
    meteoraLockedSol = meteoraLp.count * meteoraRentPerPos;
  } catch { /* ignore */ }
}
```

Executor 中的 `getMeteoraLpValueUsd()` 實現：

```typescript
async getMeteoraLpValueUsd(): Promise<{ lpUsd: number; feeUsd: number; count: number }> {
  let totalLpUsd = 0;
  let totalFeeUsd = 0;
  let count = 0;

  const entries = this.positionMap.toJSON();
  for (const [targetPos, entry] of Object.entries(entries)) {
    if (entry.dex !== 'meteora') continue;
    count++;

    try {
      const poolAddress = /* derive from entry.pool or stored poolAddress */;
      const dlmmPool = await DLMM.create(this.readConnection, new PublicKey(poolAddress));
      const positions = await dlmmPool.getPositionsByUserAndLbPair(getUserAddress());
      const ourPos = positions.userPositions.find(
        p => p.publicKey.toBase58() === entry.ourNft
      );
      if (!ourPos) continue;

      // Calculate LP value using Jupiter price
      const xUsd = /* tokenX amount * price from Jupiter */;
      const yUsd = /* tokenY amount * price from Jupiter */;
      totalLpUsd += xUsd + yUsd;

      // Fee value
      // BUG FIX: v1.20.6 — overflow guard: clamp BN > 1e15 to 0
      const feeX = ourPos.positionData.feeX || new BN(0);
      const feeY = ourPos.positionData.feeY || new BN(0);
      const safeFeeX = feeX.gt(new BN('1000000000000000')) ? new BN(0) : feeX;
      const safeFeeY = feeY.gt(new BN('1000000000000000')) ? new BN(0) : feeY;
      totalFeeUsd += /* safeFeeX * priceX + safeFeeY * priceY */;
    } catch { /* skip failed positions */ }
  }

  return { lpUsd: totalLpUsd, feeUsd: totalFeeUsd, count };
}
```

### 4.3 Discord Notify

現有的 Discord notify 函數（`notifyOpenFailed`, `notifyCloseFailed` 等）已是通用的，只需在呼叫時傳入正確的標識符。Executor 中的 log 已使用 `MeteoraPos` MODULE 名稱，Discord 通知會自動帶上。

額外在 event log 中加入 `dex: 'meteora'` 標籤（可選，便於 Dashboard 篩選）。

### 4.4 Reconciler（30min interval）

```typescript
async reconcileMeteoraPositions(queue: OperationQueue): Promise<void> {
  const entries = this.positionMap.toJSON();
  const meteoraEntries = Object.entries(entries).filter(([_, e]) => e.dex === 'meteora');

  if (meteoraEntries.length === 0) return;
  logger.info(MODULE, `Reconciling ${meteoraEntries.length} Meteora positions...`);

  for (const [targetPos, entry] of meteoraEntries) {
    try {
      // Check if our position still exists on-chain
      const poolAddress = /* derive pool address */;
      const dlmmPool = await DLMM.create(this.readConnection, new PublicKey(poolAddress));
      const positions = await dlmmPool.getPositionsByUserAndLbPair(getUserAddress());
      const ourPos = positions.userPositions.find(
        p => p.publicKey.toBase58() === entry.ourNft
      );

      if (!ourPos) {
        // Orphan: target mapping exists but our position doesn't
        logger.warn(MODULE, `Orphan detected: target=${targetPos.slice(0, 8)}, our=${entry.ourNft.slice(0, 8)} — not found on-chain`);
        this.positionMap.delete(targetPos);
      }

      // Rate limit: 500ms between checks
      await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      // RPC transient error → skip (don't false-positive delete)
      if (this.isTransientError(err)) {
        logger.debug(MODULE, `Reconcile skipped ${targetPos.slice(0, 8)}: transient error`);
        continue;
      }
      logger.warn(MODULE, `Reconcile error for ${targetPos.slice(0, 8)}: ${err.message}`);
    }
  }
}
```

---

## Bug 防護矩陣

| 操作 | Bug | 版本 | 防護措施 | 偽代碼位置 |
|------|-----|------|---------|-----------|
| OPEN | RPC lag | v1.20.8 | 3x retry with 2s/4s/6s backoff 讀取 target position | Phase 5 Step 1 |
| OPEN | LiquidityZero | v1.20.8 | tokenMax=balance when opposite token is non-zero | Phase 5 tokenMaxX/Y calculation |
| OPEN | tokenMax > balance | v1.20.2 | BN.min(target, balance) | Phase 5 tokenMaxX/Y calculation |
| OPEN | Orphan recovery | v1.20.4 | Write mapping BEFORE verify, delete on confirmed failure | Phase 5 after signAndSend |
| OPEN | Stale balance | v1.20.1 | invalidateHoldingsCache() + re-read after swap | Phase 4 after each swap |
| OPEN | Balance precheck | v1.20.2 | Jupiter Holdings API in swapForToken() | jupiter-swap.ts getInputBalance() |
| OPEN | Surplus-only swap | v1.20.1 | tokenX→tokenY only if balanceX > ourTokenX | Phase 4 tokenY deficit Try 2 |
| OPEN | Reconcile deletion | v1.20.3 | dex='meteora' in positionMap.set() | Phase 5 positionMap.set() |
| CLOSE | verifyTxSuccess | v1.20.2 | Always verify on-chain before deleting mapping | After removeLiquidity + closePosition |
| CLOSE | Pending swap miss | v1.20.2 | parseTxTokenChanges → addPendingSwap | Post-close section |
| CLOSE | Dashboard route | v1.20.4 | dex='meteora' → route to MeteoraPositionExecutor | server.ts close handler |
| CLOSE | Multi-TX remove | N/A | removeLiquidity returns Transaction[] → iterate all | Step 1 removeTxArray loop |
| CLOSE | Remove OK + close fail | N/A | Retry loop re-reads position, liquidity=0 detected → skip to closePosition | Retry loop in MAX_CLOSE_ATTEMPTS |
| INCREASE | RPC lag | v1.20.9 | 2s initial delay + 2x retry with 3s backoff | Phase 1 readAttempt loop |
| INCREASE | LiquidityZero | v1.20.8 | tokenMax=balance when delta is 0 on one side | tokenMaxX/Y in add loop |
| INCREASE | tokenMax cap | v1.20.2 | BN.min(delta, balance) | tokenMaxX/Y in add loop |
| DECREASE | Partial decrease | v1.20.0 | Bot only collects fees (full mirror = v2) | targetHasLiquidity check |
| FEE | Fee overflow | v1.20.6 | BN > 1e15 → clamp to 0 | getMeteoraLpValueUsd() |
| ALL | Insufficient SOL | N/A | solPaused = true + notifySolInsufficient | catch block in open |

---

## Meteora vs Orca/Byreal 差異對照表

| 面向 | Byreal (Raydium CLMM) | Orca Whirlpool | Meteora DLMM |
|------|----------------------|----------------|--------------|
| **程式 ID** | `REALQqNE...` | `whirLbMi...` | `LBUZKhRx...` |
| **價格模型** | Tick-based (連續) | Tick-based (連續) | Bin-based (離散) |
| **Position 類型** | NFT mint (Token2022) | NFT mint (SPL Token) | Keypair PDA (無 NFT) |
| **後續操作 ID** | NFT mint address | NFT mint address | Position PDA address |
| **SDK 初始化** | `new Chain({ connection, programId })` | `WhirlpoolContext.from(conn, wallet)` | `DLMM.create(conn, poolPubkey)` — 無需 wallet |
| **開倉** | `chain.openPosition()` | `pool.openPosition()` | `dlmmPool.initializePositionAndAddLiquidityByStrategy()` |
| **關倉** | `chain.decreaseFullLiquidity({ closePosition: true })` | `pool.closePosition()` | `removeLiquidity()` + `closePosition()` (兩步) |
| **加注** | `chain.addLiquidity()` | `position.increaseLiquidity()` | `dlmmPool.addLiquidityByStrategy()` |
| **移除** | `chain.decreaseLiquidity()` | `position.decreaseLiquidity()` | `dlmmPool.removeLiquidity({ fromBinId, toBinId })` |
| **收費** | `chain.collectFees()` | `position.collectFees()` | `dlmmPool.claimAllSwapFee()` |
| **TX 建構** | `makeTransaction()` 內部簽名 | `buildAndExecute()` 返回 sig | 返回 `Transaction` — 自行 sign+send |
| **Position 不存在** | `getPositionInfoByNftMint()` → null | `getPosition()` → Position or null | `getPosition()` → **throw** |
| **removeLiquidity 返回** | N/A (decreaseLiquidity) | Single TX | `Transaction` 或 `Transaction[]` |
| **removeLiquidity 參數** | N/A | `liquidity, slippage` | `fromBinId, toBinId, bps` (PublicKey position) |
| **closePosition 參數** | N/A (bundled) | `positionPda, slippage` | `owner, position` (LbPosition object) |
| **close discriminator** | 不同 | `7b86510031446262` | `7b86510031446262` ⚠️ 相同! |
| **Rent 預估** | ~0.009 SOL (3 accounts) | ~0.0075 SOL (3 accounts) | ~0.0079 SOL (2 accounts，無 NFT) |
| **Rebalance** | Manual (close + open) | Manual (close + open) | `rebalance_liquidity` (原子操作，Phase 2) |

---

## 回滾計劃

### 方式 1: 停用 Meteora（不刪 code）

1. `.env` 中將 `METEORA_TARGET_WALLETS` 設為空字串
2. 重啟 bot → `config.meteoraEnabled = false` → executor 不會初始化
3. 既有 Meteora position mappings 保留在 `position-map.json`，不會被操作
4. Byreal/Orca 功能完全不受影響

### 方式 2: 完全移除

1. `git revert` 整合的 commit(s)
2. `npm uninstall @meteora-ag/dlmm`
3. 刪除 `data/position-map.json` 中 `dex: 'meteora'` 的 entries

### 方式 3: Dashboard 手動關倉

如果 bot 有開著的 Meteora position 但需要停用：
1. Dashboard → Positions tab → 找到 dex=meteora 的 positions
2. 逐一點擊 Close → 路由到 MeteoraPositionExecutor.copyClosePosition()
3. 確認所有 position closed 後再停用

---

## 版本規劃

| 版本 | 內容 | 預估檔案變更 |
|------|------|-------------|
| **v1.22.0** | Phase 1 + Phase 2: 基礎設施 + Parser | `config.ts`, `parser.ts`, `websocket.ts`, `position-map.ts`, `package.json` |
| **v1.23.0** | Phase 3: Executor 核心操作 (Open/Close/Add/Remove/Fee) | `meteora-position.ts` (新), `index.ts`, `jupiter-swap.ts` |
| **v1.24.0** | Phase 4: Dashboard + Asset Trend + Reconciler | `server.ts`, `asset-trend.ts`, `context.ts`, `index.html` |
| **v1.25.0** (Phase 2) | Rebalance 支援 + `shouldClaimAndClose` 簡化 close + partial decrease 鏡像 | `meteora-position.ts`, `parser.ts` |

每個版本遵循既有的版本 bump checklist:
1. `package.json` → `"version": "x.y.z"`
2. `bot.bat` → `vX.Y.Z` (title + menu)
3. `CHANGELOG.md` → 新 entry
4. `README.md` → 版本號 + .env 表更新

---

## 附錄 A: Meteora SDK 正確 API 名稱速查表

| 用途 | ❌ 錯誤名稱 | ✅ 正確名稱 |
|------|------------|------------|
| 收取手續費 | `claimAllFees` | `claimAllSwapFee` |
| 移除流動性 | `removeLiquidity({ binIds: [...] })` | `removeLiquidity({ fromBinId, toBinId })` |
| 開倉+加注 | `initializePositionAndAddLiquidityByWeight` (deprecated) | `initializePositionAndAddLiquidityByStrategy` |
| 讀取 position | `getPosition(pubkey)` (會 throw) | 用 `getPositionsByUserAndLbPair()` 再 find |
| 建立 pool instance | `DLMM.create(conn, wallet, pool)` | `DLMM.create(conn, poolPubkey)` — 無需 wallet |

## 附錄 B: 完整 findAllMeteoraInstructions 實現

```typescript
function findAllMeteoraInstructions(tx: ParsedTransactionWithMeta): PartiallyDecodedInstruction[] {
  const meteoraStr = config.meteoraProgramId.toBase58();
  const results: PartiallyDecodedInstruction[] = [];

  for (const ix of tx.transaction.message.instructions) {
    if ('programId' in ix && ix.programId.toBase58() === meteoraStr) {
      results.push(ix as PartiallyDecodedInstruction);
    }
  }

  for (const inner of (tx.meta?.innerInstructions || [])) {
    for (const ix of inner.instructions) {
      if ('programId' in ix && ix.programId.toBase58() === meteoraStr) {
        results.push(ix as PartiallyDecodedInstruction);
      }
    }
  }

  return results;
}
```

## 附錄 C: getPoolAddressForPosition Helper

```typescript
/**
 * Resolve pool address for a target position from positionMap metadata.
 * Since Meteora positions are PDA (not NFT), we need to store pool address
 * separately or derive it.
 *
 * Approach: Store pool address in positionMap.pool field as "mintX/mintY/poolAddr"
 * or store as a separate field. For now, we extend the pool label format to include
 * the pool address for Meteora entries.
 */
private async getPoolAddressForPosition(targetPos: string): Promise<string | null> {
  // Option 1: stored in positionMap metadata (requires extending PositionEntry)
  // Option 2: query all pools for our wallet (expensive)
  // Option 3: store pool address as part of the pool label: "mintX/mintY@poolAddr"

  // 建議方案: 在 positionMap.set() 時，對 meteora 用 "mintX/mintY@poolAddr" 格式
  // 這裡解析它：
  const poolLabel = this.positionMap.getPool(targetPos);
  if (!poolLabel) return null;

  const atIdx = poolLabel.indexOf('@');
  if (atIdx > 0) {
    return poolLabel.slice(atIdx + 1); // pool address after '@'
  }

  // Fallback: pool label 沒有 @ → 無法解析 pool address
  logger.warn(MODULE, `Cannot derive pool address from label: ${poolLabel}`);
  return null;
}
```

> **注意**: `positionMap.set()` 時，Meteora 的 `pool` 參數格式應為 `"mintX/mintY@poolAddress"`，例如：
> `"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/So11111111111111111111111111111111111111112@5FGMsAtiL7hF4..."`
>
> 這樣既保持了 Dashboard 顯示 mint pair 的功能，又能反向解析 pool address。Byreal/Orca 的 pool label 不含 `@`，所以不會受影響。
