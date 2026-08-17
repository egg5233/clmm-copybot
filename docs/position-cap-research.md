# 單倉 USD 上限機制 — 研究總結報告

> 日期：2026-02-28
> 研究團隊：三輪研究（共 7 研究員 + 6 質疑者 + 3 獨立質疑者）
> 狀態：研究完成，待實作

---

## 一、背景

目前 Bot 跟單時只有 `AMOUNT_RATIO`（倍率）和錢包餘額限制，**沒有任何單倉金額上限**。當目標開大倉時，Bot 會按倍率全額跟進，可能導致單一倉位風險過高。

**需求**：設定單倉 USD 上限（如 $500），超過時自動等比縮小兩側，限制單倉風險。

**範例**（MAX_POSITION_USD = 500，ratio = 2x）：
- 目標開 200u → 200 × 2 = 400u 總值 < 500 → 照舊開 400u
- 目標開 300u → 300 × 2 = 600u 總值 > 500 → 等比縮小至 500u
- 目標加倉 100u → 加倉後總值 > 500 cap → 等比縮小（獨立 cap）

---

## 二、三輪研究歷程

### 第一輪：scaleFactor 方案（已棄用）

最初提案是在 position-map 中儲存 `scaleFactor`（開倉時的縮放因子），後續加倉/減倉/關倉/swap 都按此比例調整。

**質疑者發現的問題**：
1. 加倉讀的是目標「當前持倉總額」不是增量，scaleFactor 需要動態更新
2. 增加 position-map 複雜度，需要 getter/setter
3. DECREASE/CLOSE/SWAP 不用 amountRatio，scaleFactor 對這些操作無意義

### 第二輪：簡化方案（每次操作獨立 cap，零存儲）

用戶提出簡化思路：既然 DECREASE/CLOSE/SWAP 不需要 scaleFactor，那根本不用存。每次 OPEN/INCREASE 獨立檢查 cap 就好。

**質疑者發現的問題**：
1. 只檢查 stablecoin 側金額，沒算 token 側的 USD 價值
2. 如果 tick range 在當前價格上方，倉位 100% 是 token / 0% stablecoin → cap 永不觸發
3. 只支援 USDC，未涵蓋 USDT / USDT-T22

### 第三輪：完整 USD 估算（最終方案）

加入 token 側的 USD 估算，使用池子的 `currentPrice` 換算，支援所有 stablecoin。

**最終結論：採用第三輪方案。**

---

## 三、技術可行性

### USD 總值計算

```
totalUsd = stablecoin側金額 + token側金額 × 池子當前價格
```

- **stablecoin 側**：`amount / 10^6 = USD`（USDC/USDT/USDT-T22 皆 6 decimals）
- **token 側**：`amount / 10^decimals × currentPrice = USD`
- **`rawPoolInfo.currentPrice`**：SDK 已預先從 `sqrtPriceX64` 算好的 JS number，零額外計算
- **零額外 API / RPC 呼叫**

### 支援的穩定幣（已定義於 `byreal-position.ts` 的 `STABLE_MINTS`）

| 穩定幣 | Mint 地址 | Decimals |
|--------|----------|----------|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| USDT | `Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5` | 6 |
| USDT (Token2022) | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 |

### 價格方向

`rawPoolInfo.currentPrice` = "多少 tokenB 換 1 個 tokenA"（SDK 已做 decimal 調整）

| 池子類型 | currentPrice 含義 | token USD 價格 |
|---------|------------------|---------------|
| TOKEN/USDC（常見） | USDC per TOKEN | `currentPrice` 直接使用 |
| USDC/TOKEN（少見） | TOKEN per USDC | `1 / currentPrice` |

---

## 四、現有操作的金額邏輯

| 操作 | amountRatio 套用 | 需要 cap？ | 說明 |
|------|-----------------|-----------|------|
| **OPEN** | ✅ | ✅ | scaleAmount 後計算總 USD，超過則等比縮小 |
| **INCREASE** | ✅ | ✅ | scaleAmount 後獨立計算總 USD，超過則等比縮小 |
| **DECREASE** | ❌ | ❌ | 100% 減倉，不涉及金額計算 |
| **CLOSE** | ❌ | ❌ | 100% 關倉 |
| **SWAP（待兌換）** | ❌ | ❌ | 用 `pendingAmount × botSwap / botReceived` 比例，基於實際收到量 |

### 關鍵發現

1. **OPEN 和 INCREASE** 是唯一需要 cap 的操作
2. **DECREASE/CLOSE** 總是 100%，天然正確（bot 減的是自己的倉位）
3. **待兌換 SWAP** 基於實際收到的 token 量計算，自然按比例縮小
4. **Swap 量自動傳遞**：cap 縮小 targetA/B → deficit 自動變小 → swap 量自動變小
5. **INCREASE 讀的是目標當前持倉總額**（不是增量），每次獨立 cap 完全正確
6. **TOKEN/SOL 池已被 bot auto-block**（line 187-189），不會遇到非 stablecoin 池

---

## 五、實作方案（最終版 — 零存儲、完整 USD 估算）

### 5.1 核心函式 `applyPositionCap`

```typescript
/**
 * 如果 targetA + targetB 的總 USD 價值超過 cap，等比縮小兩側。
 * 若無法判定 USD（非 stablecoin 池），返回原值不限制。
 */
function applyPositionCap(
  targetA: BN,
  targetB: BN,
  rawPoolInfo: { mintA: PublicKey; mintB: PublicKey;
                 mintDecimalsA: number; mintDecimalsB: number;
                 currentPrice: number },
  capUsd: number,
): [BN, BN] {
  if (capUsd <= 0) return [targetA, targetB];
  if (targetA.isZero() && targetB.isZero()) return [targetA, targetB];

  const mintAStr = rawPoolInfo.mintA.toBase58();
  const mintBStr = rawPoolInfo.mintB.toBase58();
  const stableA = STABLE_MINTS.has(mintAStr);
  const stableB = STABLE_MINTS.has(mintBStr);

  let totalUsd: number;

  if (stableB) {
    // 常見：TOKEN/USDC — currentPrice = USD per tokenA
    const amountA = targetA.toNumber() / (10 ** rawPoolInfo.mintDecimalsA);
    const amountB = targetB.toNumber() / (10 ** rawPoolInfo.mintDecimalsB);
    totalUsd = amountA * rawPoolInfo.currentPrice + amountB;
  } else if (stableA) {
    // 少見：USDC/TOKEN — currentPrice = tokenB per USDC
    const amountA = targetA.toNumber() / (10 ** rawPoolInfo.mintDecimalsA);
    const amountB = targetB.toNumber() / (10 ** rawPoolInfo.mintDecimalsB);
    totalUsd = amountA + amountB * (1 / rawPoolInfo.currentPrice);
  } else {
    // 非 stablecoin 池 — 無法定價，跳過 cap
    return [targetA, targetB];
  }

  if (totalUsd <= capUsd) return [targetA, targetB];

  // 等比縮小（BPS 精度 0.01%）
  const ratioBps = Math.floor((capUsd / totalUsd) * 10000);
  const scaledA = targetA.mul(new BN(ratioBps)).div(new BN(10000));
  const scaledB = targetB.mul(new BN(ratioBps)).div(new BN(10000));

  logger.info(MODULE,
    `[CAP] $${totalUsd.toFixed(2)} > cap $${capUsd} — ` +
    `scaled to ${(ratioBps / 100).toFixed(1)}% ($${(totalUsd * ratioBps / 10000).toFixed(2)})`);

  return [scaledA, scaledB];
}
```

### 5.2 OPEN 流程（插入點：scaleAmount 之後、balance check 之前）

```
1. scaleAmount(target.tokenA, wallet) → targetA_raw     ← 現有 line 679
2. scaleAmount(target.tokenB, wallet) → targetB_raw     ← 現有 line 680
3. [新增] const [targetA, targetB] = applyPositionCap(
     targetA_raw, targetB_raw, rawPoolInfo, config.maxPositionUsd);
4. 原有邏輯：check balances → swap → 決定 base → SDK 開倉
```

### 5.3 INCREASE 流程（插入點：scaleAmount 之後）

```
1. scaleAmount(target.tokenA, wallet) → targetA_raw     ← 現有 line 1101
2. scaleAmount(target.tokenB, wallet) → targetB_raw     ← 現有 line 1102
3. [新增] const [targetA, targetB] = applyPositionCap(
     targetA_raw, targetB_raw, rawPoolInfo, config.maxPositionUsd);
4. 原有邏輯：check balances → swap → SDK 加倉
```

### 5.4 Config 設定

```typescript
// config.ts
maxPositionUsd: Number(process.env.MAX_POSITION_USD || '0'),  // 0 = 停用
```

```env
# .env
MAX_POSITION_USD=0   # 0=停用, 例：500=最大單倉 $500
```

### 5.5 SDK 行為驗證

- `createPositionInstructions` 接收 `baseAmount` + `otherAmountMax`
- 根據 baseAmount 計算所需 liquidity，再算另一側實際需要量
- **otherAmountMax 是上限**，SDK 只用它需要的量，不會用多
- 兩側等比縮小後，tick range 隱含的 token 比例不變，SDK 計算正確
- Slippage 計算基於 `otherAmountMax`，也跟著等比縮小，安全

### 5.6 `rawPoolInfo` 資料來源

```
positionInfo (from getPositionInfoByNftMint)
├── rawPoolInfo (IPoolLayoutWithId)
│   ├── currentPrice: number       ← SDK 預先算好的價格（tokenB per tokenA）
│   ├── mintDecimalsA: number      ← tokenA decimals
│   ├── mintDecimalsB: number      ← tokenB decimals
│   ├── mintA: PublicKey           ← tokenA mint
│   └── mintB: PublicKey           ← tokenB mint
├── tokenA.amount: BN              ← position 中的 tokenA 原始量
└── tokenB.amount: BN              ← position 中的 tokenB 原始量
```

OPEN 和 INCREASE 流程中均已有 `rawPoolInfo`，不需額外讀取。

---

## 六、三輪質疑者發現的問題與解法

### 第一輪問題

| # | 問題 | 解法 |
|---|------|------|
| 1 | scaleFactor 需動態更新 | 棄用 scaleFactor，改為獨立 cap |
| 2 | position-map 複雜度 | 不改 position-map，零存儲 |
| 3 | DECREASE/CLOSE/SWAP 不需要 | 確認只有 OPEN/INCREASE 需要 cap |

### 第二輪問題

| # | 問題 | 解法 |
|---|------|------|
| 4 | 只看 stablecoin 側，忽略 token 價值 | 加入 `token × currentPrice` 計算總 USD |
| 5 | tick range 上方 → 100% token / 0% stablecoin | 總 USD 包含 token 側，正確觸發 cap |
| 6 | 只支援 USDC | 改用 `STABLE_MINTS`（USDC + USDT + USDT-T22） |

### 第三輪問題

| # | 問題 | 解法 |
|---|------|------|
| 7 | sqrtPriceX64 vs currentPrice | 用 `rawPoolInfo.currentPrice`（SDK 預算，JS number）|
| 8 | SqrtPriceMath + Decimal 太重 | 不需要 import，currentPrice 已是 number |
| 9 | BN.toNumber() overflow | 安全：9 decimals 最大 ~9B tokens，在 JS safe integer 內 |
| 10 | 應該等比縮小還是跳過 | **等比縮小**（cap 是限制風險，不是放棄信號）|
| 11 | USDC/USDT 池（雙 stablecoin）| price ≈ 1.0，totalUsd ≈ amountA + amountB，正確 |
| 12 | 非 stablecoin 池（TOKEN/SOL）| 已被 bot auto-block，且函式返回原值跳過 cap |
| 13 | STABLE_MINTS 重複定義 | 重用現有 line 39 的 `STABLE_MINTS`，不新建 |
| 14 | stablecoin 在 mintA 側（除法正確性）| `amountB / priceOfAInB` = 正確的 USD 換算 |
| 15 | 多次快速加倉 RPC 延遲 | OperationQueue 序列化，最小間隔 5-15 秒 |

---

## 七、需要修改的檔案

| 檔案 | 修改內容 |
|------|---------|
| `src/config.ts` | 新增 `maxPositionUsd: number`（預設 0 = 停用） |
| `src/executor/byreal-position.ts` | 新增 `applyPositionCap()` 函式 + OPEN/INCREASE 各一行呼叫 |
| `src/dashboard/server.ts` | GET/PATCH `/api/config` 新增 `maxPositionUsd` 欄位 |
| `public/index.html` | 風險管理面板新增「最大單倉 USD」input |

**不需要修改**：
- `position-map.ts` — 不存任何新欄位
- `ratio.ts` — 不改 scaleAmount
- `jupiter-swap.ts` — swap 量自動跟著 targetA/B 縮小

---

## 八、方案比較

| 方案 | 正確性 | 複雜度 | 存儲 | 額外 RPC | 新依賴 |
|------|--------|-------|------|---------|-------|
| A) scaleFactor 存 position-map | ✅ | 高 | 欄位 | 0 | 無 |
| B) 累計存入金額 counter | ✅ | 中 | 欄位 | 0 | 無 |
| C) 只看 stablecoin 側 | ⚠️ 不完整 | 低 | 無 | 0 | 無 |
| D) 讀取當前倉位 RPC | ⚠️ 有瑕疵 | 中 | 無 | 1/INCREASE | 無 |
| **E) 完整 USD 估算 + 獨立 cap** | ✅ | **最低** | **無** | **0** | **無** |

**選擇方案 E** — 最簡單、零存儲、零額外 RPC、完整 USD 估算（兩側都算）。

---

## 九、流程圖

```
                    OPEN / INCREASE 流程
                    ====================
目標操作（開倉或加倉）
         │
         ▼
scaleAmount × ratio → targetA, targetB
         │
         ▼
applyPositionCap(targetA, targetB, rawPoolInfo, maxCapUsd)
         │
         ├─ 判斷 stablecoin 側（STABLE_MINTS）
         │
         ├─ 計算總 USD：
         │    stableB → totalUsd = amountA × currentPrice + amountB
         │    stableA → totalUsd = amountA + amountB / currentPrice
         │    neither → 跳過 cap，返回原值
         │
         ├─ totalUsd ≤ cap?  ──── Yes ──→ 返回原值，照舊操作
         │
         └─ totalUsd > cap?
              │
              ▼
         ratioBps = floor(cap / totalUsd × 10000)
         scaledA = targetA × ratioBps / 10000
         scaledB = targetB × ratioBps / 10000
              │
              ▼
         返回縮小後的 [scaledA, scaledB]
              │
              ▼
         原有邏輯：check balances → swap → SDK 開倉/加倉


                   DECREASE / CLOSE / SWAP
                   =======================
100% 操作，不需要任何 cap 邏輯
直接跟隨目標減倉或關倉
SWAP 金額自動跟著縮小的存入量連動


                   範例（MAX = $500, ratio = 2x）
                   ==============================

TOKEN/USDC 池, token $2, 倉位 tick range 在價格範圍內

目標開倉：150 TOKEN + 200 USDC = $500
Bot scaleAmount (2x)：300 TOKEN + 400 USDC
totalUsd = 300 × $2 + 400 = $1000
$1000 > $500 cap → ratioBps = 5000 (50%)
scaledA = 150 TOKEN, scaledB = 200 USDC
totalUsd = $500 ✓
```
