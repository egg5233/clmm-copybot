# Byreal Copy Bot v1.32.0

Byreal DEX 跟單機器人 — 即時監控目標錢包的 LP 操作，自動鏡像複製開倉/關倉/加減流動性。

內建 Web 中控台，可遠端監控狀態、管理倉位、查看即時日誌。

---

## 目錄

- [概述](#概述)
- [運作原理](#運作原理)
- [系統需求](#系統需求)
- [安裝步驟](#安裝步驟)
- [設定說明](#設定說明)
- [使用方式](#使用方式)
- [Web 中控台](#web-中控台)
- [專案結構](#專案結構)
- [核心流程詳解](#核心流程詳解)
- [常見問題](#常見問題)

---

## 概述

本機器人監控 [Byreal DEX](https://byreal.io) 上指定錢包的 LP（流動性提供）操作，並自動以相同參數複製：

- **開倉 (Open Position)** — 相同池子、相同 tick 範圍、相同 referer
- **關倉 (Close Position)** — 偵測目標關倉後同步關閉我們的對應倉位
- **加倉 (Increase Liquidity)** — 追加流動性
- **減倉 (Decrease Liquidity)** — 移除流動性
- **手續費收取 (Collect Fees)** — 跟隨目標收取 LP 手續費
- **Jupiter Swap** — 偵測目標的後續代幣兌換，按比例執行相同操作

**Byreal** 是 Bybit 孵化的 Solana DEX，程式為 Raydium CLMM 的 100% fork。
Program ID: `REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2`

### 為什麼要跟單？

Byreal 提供「跟單獎勵 (followsBonus)」機制 — 當你的倉位帶有 `referer_position` 標記，平台會額外發放獎勵。頂級農夫每日可獲得 $89+ 的獎勵，其中跟單獎勵佔大部分收入。

---

## 運作原理

```
目標錢包 TX
    │
    ▼
┌─────────────────────┐
│  WebSocket onLogs    │  即時監聽鏈上事件
│  (Helius RPC)        │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  交易解析器 (Parser) │  解析 TX → OPEN / CLOSE / INCREASE / DECREASE / COLLECT_FEE / JUP_SWAP
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  事件佇列 (Queue)    │  串行處理，避免並發衝突
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  執行器 (Executor)   │  依事件類型執行對應操作
│  ┌─────────────────┐ │
│  │ 開倉：讀取目標倉  │ │
│  │ 位→換幣→開倉     │ │
│  ├─────────────────┤ │
│  │ 關倉：關閉對應倉  │ │
│  │ 位→記錄待兌換    │ │
│  ├─────────────────┤ │
│  │ 收費：跟隨收取   │ │
│  │ LP 手續費        │ │
│  ├─────────────────┤ │
│  │ JUP Swap：按比例 │ │
│  │ 兌換回 USDC     │ │
│  └─────────────────┘ │
└──────────────────────┘
```

---

## 系統需求

- **作業系統**: Windows 10/11 + WSL2 (Ubuntu)，或 Linux (VPS 部署)
- **Node.js**: v20+ (透過 nvm 安裝)
- **npm**: v10+
- **RPC**: [Helius](https://helius.dev) 免費方案（需 WebSocket 支援）+ [Alchemy](https://alchemy.com) 免費方案（讀取用，建議）
- **資金**: SOL（手續費）+ USDC（開倉資金），建議至少 1.7 SOL + 600 USDC + 200 USDT

---

## 安裝步驟

### 1. 安裝 WSL2 (如尚未安裝)

以**系統管理員**開啟 PowerShell：

```powershell
wsl --install
```

安裝完成後重新啟動電腦，開啟 Ubuntu 設定使用者名稱和密碼。

### 2. WSL 環境準備

開啟 WSL (Ubuntu) 終端機：

```bash
# 安裝 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc

# 安裝 Node.js 20
nvm install 20
nvm use 20

# 確認版本
node -v   # v20.x.x
npm -v    # 10.x.x
```

### 3. 放置專案

將整個 `copy-bot/` 目錄放到你的工作目錄，例如：

```
F:\AI\byreal\copy-bot\
```

路徑可以自訂，但 **`bot.bat` 內部會自動偵測自身位置**。

### 4. 設定環境變數

在 `copy-bot/` 目錄下：

```bash
# 複製範例設定
cp .env.example .env
```

用文字編輯器（記事本、VS Code 等）編輯 `.env`，填入你的設定（見[設定說明](#設定說明)）。

### 5. 安裝依賴 (首次)

開啟 WSL 終端：

```bash
cd /mnt/f/AI/byreal/copy-bot   # 改成你的路徑
npm install
```

之後每次啟動 `bot.bat` 會自動安裝依賴，不需手動。

---

## 設定說明

編輯 `.env` 檔案：

```env
# ===== 必填 =====
PRIVATE_KEY=<你的 base58 私鑰>
WALLET_PUBLIC_KEY=                 # signer mode 使用；未提供 PRIVATE_KEY 時必填
SIGNER_SOCKET_PATH=                # signer service Unix socket path，留空=停用
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>
WS_URL=wss://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>
TARGET_WALLETS=<目標錢包1>,<目標錢包2>          # 可附加 :倍率，例如 Wallet1:0.5,Wallet2:1.5

# ===== 選填 =====
ALCHEMY_RPC_URL=               # Alchemy RPC（讀取餘額/交易用，避免 Helius 延遲）
CLOSE_ONLY_WALLETS=            # 僅關倉錢包（逗號分隔）
AMOUNT_RATIO=1.0               # 金額倍率（全域預設，可被個別錢包覆蓋）
SLIPPAGE_BPS=50                # 滑點容忍（50 = 0.5%）
MAX_RETRY=3                    # 重試次數
PRIORITY_FEE_LAMPORTS=50000    # Priority fee (microLamports)
DRY_RUN=false                  # 模擬模式

# ===== 中控台 =====
ALLOW_SAME_WALLET_REOPEN=false # 允許同錢包重複開相同 referer 倉位
SKIP_SAME_TICK_RANGE=false     # 跳過相同 tick 範圍重複開倉（同錢包 + 同池子 + 同範圍 = 跳過）
BYREAL_ALLOW_SAME_TICK_WALLETS= # Byreal 允許同 tick 來源錢包；這些錢包開出的 referer 不阻止其他錢包跟同倉
BYREAL_ALLOW_OPEN_AFTER_OTHERS_WALLETS= # Byreal 允許同 tick 跟隨錢包；這些錢包可以開別人已開過的 referer
RECONCILE_INTERVAL_MINUTES=360 # 背景對帳/孤兒倉位檢查間隔（分鐘）
DASHBOARD_PASSWORD=<設定密碼>   # 設定後啟用 Web 中控台
DASHBOARD_PORT=3847            # 中控台 Port
DASHBOARD_IP=127.0.0.1         # Dashboard 監聽 IP（預設 127.0.0.1）
JUP_API_KEY=                   # Jupiter API Key（資產趨勢 + 代幣估值）
JUP_SWAP_MODE=ultra            # Jupiter Swap 模式：ultra（代送交易）或 metis（自送交易）

# ===== 風險管理 =====
DRAWDOWN_THRESHOLD_PCT=20      # 資產跌幅暫停門檻（%），0=停用
TOKEN_LOSS_STREAK_LIMIT=3      # 單代幣連續虧損次數門檻
TOKEN_COOLDOWN_MINUTES=60      # 觸發冷靜期後的冷卻時間（分鐘）
TOKEN_BLACKLIST=               # 黑名單代幣 mint（逗號分隔，永不交易）
TOKEN_WHITELIST=               # 白名單代幣 mint（逗號分隔，免受冷靜期封禁）

# ===== 自動領取 =====
AUTO_CLAIM_ENABLED=false       # 自動領取複製獎勵（每週二 16:30 台灣時間）

# ===== DAC (Daily Auto-Convert) =====
DAC_ENABLED=false              # DAC 開關
DAC_AMOUNT_USD=10              # 每次購買金額（USDC）
DAC_THRESHOLD_MULTIPLIER=1     # 門檻倍數（獲利 >= 金額 x 倍數 才執行）
DAC_EXECUTE_HOUR=0             # 執行時間（時，0-23，台灣時間）
DAC_EXECUTE_MINUTE=0           # 執行時間（分，0-59）
DAC_TARGET_TOKEN=cbbtc         # 定投幣種：cbbtc 或 xbtc
DAC_TRANSFER_TO=               # BTC 代幣轉帳目標地址（留空則不轉帳）

# ===== Pool TVL 篩選 =====
MIN_POOL_AGE_DAYS=0                 # Pool minimum age in days, 0 disables
POOL_AGE_WHITELIST=                 # Token mint whitelist for bypassing only the pool age check
MIN_POOL_TVL=0                     # Pool TVL 門檻（USD），低於此值跳過開倉/加倉，0=停用
TVL_SOURCE=dex                     # TVL 查詢來源：dex=各 DEX API | jupiter=Jupiter 全市場流動性
POOL_TVL_WHITELIST=                # TVL 白名單代幣 mint（逗號分隔），免 TVL 檢查
POOL_TVL_REFRESH_MINUTES=60        # TVL 快取刷新間隔（分鐘，最小 15）

# ===== Pump 代幣過濾 =====
PUMP_FILTER_MODE=off               # off=不過濾, full=完全過濾, discord=Discord 通知過濾

# ===== Meteora DLMM =====
METEORA_TARGET_WALLETS=            # Meteora DLMM 跟單目標錢包（逗號分隔），留空=停用
METEORA_CLOSE_ONLY_WALLETS=        # Meteora 僅關倉錢包（逗號分隔）
METEORA_SKIP_SOL=true              # 跳過含 SOL 的 Meteora DLMM 池子

# ===== PancakeSwap CLMM =====
PCS_TARGET_WALLETS=                # PancakeSwap CLMM 跟單目標錢包（逗號分隔），留空=停用
PCS_CLOSE_ONLY_WALLETS=            # PancakeSwap 僅關倉錢包（逗號分隔）
PCS_SKIP_SOL=true                  # 跳過含 SOL 的 PancakeSwap 池子

# ===== Meteora DAMM v2 =====
DAMMV2_TARGET_WALLETS=             # DAMM v2 跟單目標錢包（逗號分隔），留空=停用
DAMMV2_CLOSE_ONLY_WALLETS=         # DAMM v2 僅關倉錢包（逗號分隔）
DAMMV2_SKIP_SOL=true               # 跳過含 SOL 的 DAMM v2 池子

# ===== Discord 通知 =====
DISCORD_NOTIFY_URL=<你的通知 Worker URL>  # 自架 Cloudflare Worker 通知代理（未設定則停用通知）
DISCORD_API_KEY=<你的通知 API Key>  # 通知 API Key
```

### 如何取得 Helius API Key

1. 前往 [helius.dev](https://helius.dev)，用 GitHub 或 Google 登入
2. 建立新的 API Key（免費方案 = 1M credits/月，足夠使用）
3. 複製 API Key，填入 `.env` 的 `RPC_URL` 和 `WS_URL`

### 如何取得 Alchemy API Key（建議）

1. 前往 [alchemy.com](https://alchemy.com)，註冊免費帳號
2. 建立 Solana Mainnet App
3. 複製 HTTPS 端點，填入 `.env` 的 `ALCHEMY_RPC_URL`

**為什麼需要兩個 RPC？**
Helius 送完交易後立即查詢，可能因 indexing 延遲讀到舊資料。使用獨立的 Alchemy 節點讀取，可大幅降低這類問題。

### 參數說明

| 參數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| `PRIVATE_KEY` | 否* | 空 | 機器人錢包的 base58 私鑰；signer mode 可留空 |
| `WALLET_PUBLIC_KEY` | 否* | 空 | signer mode 使用的機器人錢包公鑰；未提供 `PRIVATE_KEY` 時必填 |
| `SIGNER_SOCKET_PATH` | 否 | 空 | signer service Unix socket path，留空=停用 |
| `RPC_URL` | 是 | — | Solana RPC HTTP 端點（送交易 + WebSocket） |
| `WS_URL` | 是 | — | Solana RPC WebSocket 端點 |
| `ALCHEMY_RPC_URL` | 否 | 空 | Alchemy RPC 端點（讀取餘額/查詢交易），未設則用 RPC_URL |
| `RPC_URL_FREE` | 否 | `(內建代理)` | 免費 RPC 端點（LP 倉位資產明細查詢），未設則用內建 Cloudflare Worker 代理 |
| `TARGET_WALLETS` | 是 | — | 要跟單的目標錢包地址，逗號分隔。可在每個地址後附加 `:<倍率>` 設定個別金額倍率，例如 `WalletA:0.5,WalletB,WalletC:1.5`（未附加者使用 `AMOUNT_RATIO`） |
| `BOT2_WALLET` | 否 | 空 | 舊版相容 fallback；未設定 `TARGET_WALLETS` 時使用 |
| `CLOSE_ONLY_WALLETS` | 否 | 空 | 僅處理關倉的錢包（不須在 TARGET_WALLETS 中，會自動合併監控） |
| `AMOUNT_RATIO` | 否 | `1.0` | 全域金額倍率（1.0=相同，0.5=一半）。可被 `TARGET_WALLETS` 的個別 `:<倍率>` 設定覆蓋 |
| `SLIPPAGE_BPS` | 否 | `200` | 滑點容忍度（50=0.5%, 100=1%, 200=2%） |
| `MAX_RETRY` | 否 | `3` | 交易失敗重試次數 |
| `PRIORITY_FEE_LAMPORTS` | 否 | `50000` | Priority fee (microLamports) |
| `ALLOW_SAME_WALLET_REOPEN` | 否 | `false` | 允許同錢包重複開相同 referer 倉位 |
| `SKIP_SAME_TICK_RANGE` | 否 | `false` | 同一目標錢包在相同池子、相同 tick 範圍已有開倉時跳過（即使 referer 不同）。防止目標同時開兩個完全相同的 LP 倉位時重複跟單 |
| `BYREAL_ALLOW_SAME_TICK_WALLETS` | 否 | 空 | Byreal 來源錢包白名單，逗號分隔。清單內錢包開出的 referer 不會阻止其他錢包跟同倉；同錢包 tick 重複保護仍照 `SKIP_SAME_TICK_RANGE` 和 `ALLOW_SAME_WALLET_REOPEN` 規則 |
| `BYREAL_ALLOW_OPEN_AFTER_OTHERS_WALLETS` | 否 | 空 | Byreal 跟隨錢包白名單，逗號分隔。清單內錢包可以開別人已開過的 referer；同錢包 tick 重複保護仍照 `SKIP_SAME_TICK_RANGE` 和 `ALLOW_SAME_WALLET_REOPEN` 規則 |
| `RECONCILE_INTERVAL_MINUTES` | 否 | `360` | 背景對帳/孤兒倉位檢查間隔（分鐘），降低 RPC 消耗 |
| `SKIP_PREFLIGHT` | 否 | `false` | 跳過 preflight 模擬（`true` = 所有交易不做 preflight），適用於 RPC preflight 誤報導致交易被拒的情況 |
| `DRY_RUN` | 否 | `false` | 模擬模式（true = 不發交易） |
| `DASHBOARD_PASSWORD` | 否 | 空 | 中控台密碼（不設 = 停用中控台） |
| `DASHBOARD_PORT` | 否 | `3847` | 中控台埠號 |
| `DASHBOARD_IP` | 否 | `127.0.0.1` | Dashboard 監聽 IP，一般用戶無需修改 |
| `JUP_API_KEY` | 否 | 空 | Jupiter API Key（資產趨勢圖 + 代幣 USDC 估值） |
| `JUP_SWAP_MODE` | 否 | `ultra` | Jupiter Swap 模式：`ultra`（Jupiter 代送，較高落地率）或 `metis`（自送交易） |
| `DRAWDOWN_THRESHOLD_PCT` | 否 | `20` | 資產跌幅暫停門檻（%）。總資產低於啟動時的 N% 時暫停開倉，0=停用 |
| `TOKEN_LOSS_STREAK_LIMIT` | 否 | `3` | 單代幣連續虧損次數門檻，超過後該代幣進入冷靜期 |
| `TOKEN_COOLDOWN_MINUTES` | 否 | `60` | 代幣冷靜期時間（分鐘），冷靜期內不對該代幣開倉 |
| `TOKEN_BLACKLIST` | 否 | 空 | 黑名單代幣 mint 地址（逗號分隔），這些代幣永不開倉/加倉 |
| `TOKEN_WHITELIST` | 否 | 空 | 白名單代幣 mint 地址（逗號分隔），這些代幣免受冷靜期封禁 |
| `AUTO_CLAIM_ENABLED` | 否 | `false` | 自動領取複製獎勵（每週二 16:30 台灣時間），true=啟用 |
| `BYREAL_SKIP_SOL` | 否 | `true` | 跳過含 SOL 的 Byreal 池子 |
| `BYREAL_PROGRAM_ID` | 否 | `REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2` | Byreal CLMM Program ID |
| `DAC_ENABLED` | 否 | `false` | DAC 每日自動定投 BTC 開關 |
| `DAC_AMOUNT_USD` | 否 | `10` | 每次用多少 USDC 買入選定 BTC 代幣 |
| `DAC_THRESHOLD_MULTIPLIER` | 否 | `1` | 門檻倍數，獲利 >= 金額 x 倍數 才執行 DAC |
| `DAC_EXECUTE_HOUR` | 否 | `0` | DAC 執行時間（時，0-23，台灣時間） |
| `DAC_EXECUTE_MINUTE` | 否 | `0` | DAC 執行時間（分，0-59） |
| `DAC_TARGET_TOKEN` | 否 | `cbbtc` | 定投幣種：`cbbtc` 或 `xbtc`（xBTC mint: `CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn`） |
| `DAC_TRANSFER_TO` | 否 | 空 | BTC 代幣轉帳目標 Solana 地址，留空則不轉帳 |
| `MIN_POOL_AGE_DAYS` | 否 | `0` | Pool 最小上線天數門檻，低於此值跳過開倉，0=停用 |
| `POOL_AGE_WHITELIST` | 否 | 空 | Token mint 白名單，僅免除 `MIN_POOL_AGE_DAYS` 池齡檢查；TVL 與其他風控仍會套用 |
| `MIN_POOL_TVL` | 否 | `0` | Pool TVL 門檻（USD），低於此值跳過開倉/加倉，0=停用 |
| `TVL_SOURCE` | 否 | `dex` | TVL 查詢來源：`dex`=各 DEX API，`jupiter`=Jupiter 全市場流動性 |
| `POOL_TVL_WHITELIST` | 否 | 空 | TVL 白名單代幣 mint 地址（逗號分隔），這些代幣免受 TVL 門檻限制 |
| `POOL_TVL_REFRESH_MINUTES` | 否 | `60` | TVL 快取刷新間隔（分鐘），最小 15 分鐘 |
| `MAX_COIN_CONCENTRATION_USD` | 否 | `0` | 單一非穩定幣代幣 LP 倉位 USD 上限，超過則跳過開倉/加倉，0=停用 |
| `MAX_COIN_CONCENTRATION_PCT` | 否 | `0` | 單一非穩定幣代幣佔 LP 總倉位百分比上限（0-100），超過則跳過開倉/加倉，0=停用 |
| `PUMP_FILTER_MODE` | 否 | `off` | Pump 代幣過濾模式：`off`=不過濾、`full`=完全過濾、`discord`=Discord 通知過濾（偵測到 pump 代幣時發送 Discord DM 等待批准/拒絕） |
| `IGNORE_PUMP_TOKENS` | 否 | 空 | 舊版相容；未設定 `PUMP_FILTER_MODE` 時，`true` 等同 `PUMP_FILTER_MODE=full` |
| `DISCORD_NOTIFY_URL` | 否 | `(內建)` | Discord 通知 Worker URL |
| `DISCORD_API_KEY` | 否 | `(內建)` | Discord 通知 API Key |
| `ORCA_TARGET_WALLETS` | 否 | 空 | Orca Whirlpool 跟單目標錢包（逗號分隔，可附加 `:<倍率>`），留空=停用 Orca 跟單 |
| `ORCA_CLOSE_ONLY_WALLETS` | 否 | 空 | Orca 僅處理關倉的錢包 |
| `ORCA_SKIP_SOL` | 否 | `true` | 跳過含 SOL 的 Orca Whirlpool 池子 |
| `METEORA_TARGET_WALLETS` | 否 | 空 | Meteora DLMM 跟單目標錢包（逗號分隔，可附加 `:<倍率>`），留空=停用 Meteora 跟單 |
| `METEORA_CLOSE_ONLY_WALLETS` | 否 | 空 | Meteora 僅處理關倉的錢包 |
| `METEORA_SKIP_SOL` | 否 | `true` | 跳過含 SOL 的 Meteora DLMM 池子 |
| `PCS_TARGET_WALLETS` | 否 | 空 | PancakeSwap CLMM 跟單目標錢包（逗號分隔，可附加 `:<倍率>`），留空=停用 PCS 跟單 |
| `PCS_CLOSE_ONLY_WALLETS` | 否 | 空 | PancakeSwap 僅處理關倉的錢包 |
| `PCS_SKIP_SOL` | 否 | `true` | 跳過含 SOL 的 PancakeSwap 池子 |
| `DAMMV2_TARGET_WALLETS` | 否 | 空 | Meteora DAMM v2 跟單目標錢包（逗號分隔，可附加 `:<倍率>`），留空=停用 |
| `DAMMV2_CLOSE_ONLY_WALLETS` | 否 | 空 | DAMM v2 僅處理關倉的錢包 |
| `DAMMV2_SKIP_SOL` | 否 | `true` | 跳過含 SOL 的 DAMM v2 池子 |
| `POSITION_MAP_FILE` | 否 | `./data/position-map.json` | 倉位映射檔路徑 |

---

## 使用方式

### Windows 快速啟動（推薦）

**雙擊 `bot.bat`** 即可操作：

```
========================
 Byreal Copy Bot v1.30.5
========================
 1. Start    — 編譯 → 同步到 WSL → 啟動
 2. Stop     — 停止機器人
 3. Logs     — 查看即時日誌
 4. Status   — 查看運行狀態
========================
```

**Start 流程：**
1. TypeScript 編譯檢查（如有語法錯誤會中斷）
2. 使用 rsync 將程式碼同步到 WSL 的 `~/byreal-copy-bot/`
3. 在 WSL 背景以 daemon 方式啟動（透過 `setsid`）

啟動後可關閉 cmd 視窗，bot 在 WSL 背景持續運行。

### VPS 部署（首次安裝）

```bash
# 解壓到目標目錄
mkdir -p /root/byreal-copy-bot
cd /root/byreal-copy-bot
# 解壓 ZIP 或 tar

# 設定環境變數
cp .env.example .env
nano .env

# 一鍵安裝（含 Git 設定、依賴、編譯）
bash install.sh
```

安裝完成後，後續更新可直接在 Dashboard → 設定 →「系統更新」一鍵完成。

### VPS 更新（Dashboard 一鍵更新）

Dashboard → 設定 → 系統更新 → 檢查更新 → 立即更新

更新流程自動執行：`git pull` → `npm install` → `tsc` → 重啟

### 手動操作（WSL 內）

```bash
# 前台啟動（可看即時日誌）
cd ~/byreal-copy-bot
npx ts-node src/index.ts

# 查看日誌
tail -f /tmp/copybot.log

# 停止
pkill -f 'ts-node.*src/index.ts'
```

---

## Web 中控台

設定 `DASHBOARD_PASSWORD` 後，bot 啟動時會開啟 Web 中控台。

### 本機存取

瀏覽器開啟：`http://127.0.0.1:3847`（預設 Port）

### 功能

中控台有 6 個頁面：

| 頁面 | 功能 |
|------|------|
| **狀態總覽** | 運行狀態、倉位數、鎖倉 SOL、排隊數、監控目標、錢包餘額、最近事件 |
| **資產趨勢** | 資產總額走勢圖（TradingView Lightweight Charts），支援 1H/4H/1D/7D/30D/ALL 切換、縮放拖曳、Crosshair tooltip |
| **倉位管理** | 倉位映射表（含代幣對、來源錢包）、待交換代幣、交換歷史、手動關倉/交換、代幣餘額 USDC 估值、批量兌換 |
| **日誌** | 即時日誌串流（WebSocket 推播），支援等級/模組篩選和搜尋 |
| **設定** | 目標錢包/僅關倉錢包管理、參數調整、風險管理設定、系統更新（即時生效） |
| **連線紀錄** | Dashboard 登入/登出/封鎖事件記錄 |

### 主要操作

- **手動關倉** — 在倉位管理頁面點擊「關倉」，立即撤回流動性並關閉倉位
- **強制交換** — 將待交換代幣立即透過 Jupiter 換回 USDC
- **對帳** — 手動觸發對帳，檢查目標是否已關倉而我們未同步
- **更新目標** — 在設定頁面直接修改目標錢包，儲存後自動重新訂閱

### 事件日誌

事件日誌顯示所有操作記錄，包含代幣對資訊：
- **OPEN / CLOSE** — 顯示池子代幣對（如 SOL / USDC）
- **SWAP** — 顯示兌換代幣對（如 BONK / USDC）
- **SKIP / INCREASE / DECREASE** — 不顯示代幣

### 安全性

- 中控台預設只綁定 `127.0.0.1`（本機），外部無法直接存取
- 密碼錯誤 5 次後封鎖 IP 1 小時
- 連線紀錄保存於 `data/auth-log.json`（最多 200 筆）
- 建議使用 Cloudflare Tunnel 等方式安全暴露到外網

---

## 專案結構

```
copy-bot/
├── bot.bat                    # Windows 管理腳本（雙擊使用）
├── install.sh                 # VPS 一鍵安裝（Git + npm + tsc）
├── manage.sh                  # WSL 端管理腳本（bot.bat 呼叫）
├── package.json               # 專案設定與依賴
├── tsconfig.json              # TypeScript 編譯設定
├── .env                       # 環境變數（不含在打包中）
├── .env.example               # 環境變數範例
├── .gitignore
│
├── public/                    # 中控台前端
│   └── index.html             # 單檔 Dashboard（HTML + CSS + JS）
│
├── src/                       # 原始碼
│   ├── index.ts               # 主程式入口 — 事件佇列、事件分發、pool backfill
│   ├── config.ts              # 環境變數載入與驗證
│   │
│   ├── monitor/               # 鏈上監控
│   │   ├── websocket.ts       # WebSocket 訂閱目標錢包事件
│   │   ├── parser.ts          # 交易日誌解析（→ 結構化事件）
│   │   └── pool-tvl.ts        # Pool TVL 快取收集器（定時抓取 Byreal API）
│   │
│   ├── executor/              # 操作執行
│   │   ├── byreal-position.ts # 核心：開倉/關倉/加減倉/收費/待兌換管理
│   │   ├── jupiter-swap.ts    # Jupiter 換幣 + Byreal 池內換幣
│   │   ├── orca-position.ts    # Orca Whirlpool 跟單執行器
│   │   ├── meteora-position.ts # Meteora DLMM 跟單執行器
│   │   └── auto-claim.ts      # 自動領取複製獎勵（Type=2 Copy Bonus）
│   │
│   ├── state/                 # 狀態管理
│   │   └── position-map.ts    # 目標 NFT ↔ 我們 NFT 映射（持久化）
│   │
│   ├── dashboard/             # Web 中控台
│   │   ├── server.ts          # HTTP + WebSocket 伺服器
│   │   ├── asset-trend.ts     # 資產趨勢收集（Jupiter + Byreal API）
│   │   └── context.ts         # 中控台共享狀態介面
│   │
│   └── utils/                 # 工具函式
│       ├── wallet.ts          # 錢包金鑰管理
│       ├── logger.ts          # 結構化日誌（含 WebSocket 廣播）
│       └── ratio.ts           # 金額比例計算
│
└── data/                      # 運行時資料（自動建立，不含在打包中）
    ├── position-map.json      # NFT 映射持久化
    ├── pending-swaps.json     # 待兌換狀態持久化
    ├── opened-referers.json   # Referer 去重記錄
    ├── event-log.json         # 事件日誌（含 poolMap，最多 1000 筆）
    ├── swap-history.json      # 交換歷史（最多 40 筆）
    ├── token-names.json       # Token 資訊快取（symbol、decimals、logoURI）
    ├── auth-log.json          # Dashboard 連線紀錄（最多 200 筆）
    ├── asset-trend.json       # 資產趨勢快照（每 5 分鐘，最多 4320 筆）
    ├── token-pnl.json         # 代幣 PNL 記錄（累計損益、交易次數）
    ├── claim-history.json     # 自動領取歷史（每週一筆，最多 52 筆）
    └── backup/                # 停機自動備份（保留最近 10 份）
        └── *.bak
```

---

## 核心流程詳解

### 事件偵測

1. **WebSocket 訂閱** — 對每個目標錢包呼叫 `connection.onLogs()` 監聽
2. **交易解析** — 分析 TX 日誌和代幣餘額變化，辨識事件類型
3. **串行處理** — 所有事件放入佇列逐一處理，避免錢包操作衝突

### 開倉流程

1. 偵測目標開倉 → 讀取目標倉位的 tick range 和代幣數量
2. 換幣（先 Jupiter → 若無路由則 Byreal 池內 swap → USDC fallback）
3. 使用 SDK 建立相同參數的倉位，附加 `referer_position` memo
4. 儲存「目標 NFT → 我們的 NFT」映射

### 關倉流程

1. 偵測目標關倉 → 關閉對應倉位
2. 記錄收到的非 USDC 代幣到 pending
3. 偵測目標 Jupiter Swap → 按比例換回 USDC

### 手續費收取

偵測目標收取 LP 手續費 → 對我們的對應倉位執行 `chain.collectFees()`

### 定期維護

- **每 10 分鐘** — 記錄待兌換狀態、同步實際錢包餘額（更新 pending swap 金額）
- **每 360 分鐘** — 對帳（reconcile）— 關閉孤兒倉位（可用 `RECONCILE_INTERVAL_MINUTES` 調整）

### 防重複機制

- **Lock 檔案** — 防止多個實例同時運行
- **Signature Dedup** — 防止 WebSocket 重複推送
- **Position Map 檢查** — 開倉前檢查是否已有映射
- **Referer 去重** — 多個目標複製同一 provider 時只開一次倉

---

## 常見問題

### Bot 無法啟動，顯示 "Another instance is running"

刪除 lock 檔案後重試：
```bash
rm -f data/bot.lock
```

### Jupiter 回傳 NO_ROUTES_FOUND

該代幣在 Jupiter 沒有路由，Bot 會自動回退到 Byreal 池內 swap。正常行為。

### 如何更換目標錢包？

**方法 1（推薦）**：在 Web 中控台 → 設定頁面 → 修改 → 儲存（即時生效）

**方法 2**：修改 `.env` 中的 `TARGET_WALLETS`，然後重啟 bot

### 如何只模擬不實際交易？

設定 `DRY_RUN=true`，bot 會正常偵測事件並記錄，但不發送鏈上交易。

---

## 技術細節

- **SDK**: `byreal-clmm-sdk-alpha@0.1.4`（Byreal 官方 CLMM SDK）
- **語言**: TypeScript，目標 ES2022
- **Runtime**: Node.js v20 + TypeScript 編譯
- **鏈**: Solana Mainnet
- **RPC**: Helius（WebSocket + 送交易）+ Alchemy（讀取，建議）
- **Position NFT**: Token2022 program
- **中控台**: 內建 HTTP + WebSocket 伺服器，單檔前端（含 token icons）

## 授權

私人專案，僅供授權使用。
## Byreal Position Cap

`BYREAL_MAX_OPEN_POSITIONS=0` disables the cap. Set `BYREAL_MAX_OPEN_POSITIONS=415` to prevent opening position 416; after close or reconcile drops the Byreal count below 415, opening is allowed again.
