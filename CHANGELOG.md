# Changelog

## v1.33.0 (2026-08-17)
- **[Infra] Test suite migrated to vitest**: replaced the 20-command `ts-node` chain with vitest (`npm test`); shared env stubs moved to `tests/setup.ts`; floating-promise bugs in async tests fixed by converting to awaited `it()` blocks.
- **[Infra] Source-grep tests retired**: 13 tests that asserted on source-code substrings were either rewritten as behavioral tests (audit queue, position cap, priority-fee strip, claim CLI parity, fee-payload audit, Jupiter headers, zero-priority builder) or deleted; every retired file's regression intent is recorded in `docs/testing-notes.md`.
- **[Tests] New unit coverage for pure logic**: `tests/ratio.test.ts` (22 tests — amount scaling, per-wallet overrides, bps truncation edge cases) and `tests/parser.test.ts` (25 tests — Byreal event classification, DEX routing precedence, swap detection from balance deltas).
- **[Infra] eslint (typescript-eslint) + prettier + GitHub Actions CI**: typecheck, lint, format check, and tests on every push/PR.
- **[Docs] English README** with architecture/sequence diagrams and signer threat model; original Chinese docs preserved as `README.zh-TW.md`.

## v1.32.1 (2026-06-25)
- **[修復] 資產總額走勢偶發顯示「尚無資料」**：圖表容器在資料未就緒時會被設為 `display:none`，導致 `getBoundingClientRect()` 量到 0×0 並提前 return，後續資料到位也無法復原。改為在量測 rect 之前先還原 chart 可見度，避免被卡在 empty 分支。

## v1.32.0 (2026-06-22)
- **[功能] Pool age whitelist**：新增 `POOL_AGE_WHITELIST`，白名單 token mint 僅免除 Byreal `MIN_POOL_AGE_DAYS` 池齡檢查；TVL 與其他風控仍會套用。

## v1.31.2 (2026-06-20)
- **[修復] 批次錢包代幣兌換等待關倉優先事件**：批次兌換遇到 CLOSE/DECREASE 高優先級工作時會持續等待 queue 清空，重新嘗試同一個勾選代幣，不再因等待時間把該筆算成失敗。
- **[修復] Dashboard 手動兌換排隊順序**：手動 force-swap 改走 NORMAL queue，保留關倉/減倉優先權，並在批次流程中刷新 high-priority 序號後續跑。
- **[修復] Jupiter API Key header 共用 helper**：新增 Jupiter fetch/header helper，讓 swap、price、Orca/PCS 相關 Jupiter 請求一致帶上 `JUP_API_KEY`。
- **[測試] 補強 queue 與 Jupiter header 回歸測試**：新增 queue priority、批次兌換等待續跑、Jupiter API key header 測試，並納入 `npm test`。

## v1.31.1 (2026-06-09)
- **[修復] Byreal Copy Bonus 自動領獎循環**：移除錯誤的 10 輪上限，改為持續領取直到 Byreal 回報沒有可領獎勵，並保留 duplicate batch 保護避免重複送同一批訂單。
- **[修復] Copy Bonus CLI parity 流程**：依 Byreal CLI 外部 signer 流程重查 `epoch-bonus`、呼叫 `encode-v2/order-v2`、簽署原始 backend payload，並對 504 等暫時性錯誤保留 retry。
- **[測試] 自動領獎回歸測試**：新增超過 10 輪仍繼續領取、成功後乾淨停止、duplicate batch 停止、retry 不重簽等測試。

## v1.31.0 (2026-06-08)
- **[功能] Byreal 倉位上限可由 Dashboard 設定**：新增 `BYREAL_MAX_OPEN_POSITIONS`，預設 `0` 關閉；設定 `415` 時會阻止開第 416 個 Byreal 倉位，關倉或 reconcile 降回上限以下後可再開倉。
- **[功能] Dashboard 設定寫回 `.env`**：設定頁新增 `Byreal max positions` 欄位，`/api/config` GET/PATCH 會讀寫 `byrealMaxOpenPositions`，無效值會正規化並持久化為 `BYREAL_MAX_OPEN_POSITIONS=0`。
- **[修正] Jupiter priority fee 清理回歸**：加入 Jupiter priority fee strip 測試，避免 swap 來源繼續帶入不需要的 priority fee 指令。

## v1.30.5 (2026-06-05)
- **[修復] Byreal reconcile stale mapping 清理**：target NFT 已消失時，先確認 mapped our NFT；若雙方倉位都已不存在，直接刪除 position mapping 與 referer，避免重複 enqueue 官倉 close 死循環。
- **[安全] lookup 錯誤分類收斂**：target/our 查詢只有明確 gone/not-found 才視為可清理；transient、parse、SDK 與未知錯誤會保留 mapping，等待下輪掃描。
- **[測試] 新增 orphan cleanup regression**：覆蓋 target gone + our gone、our active、transient retention、unknown retention 與 not-found cleanup，並納入 `npm test`。

## v1.30.4 (2026-06-03)
- **[修正] Byreal 跟單交易改為 0 priority fee**：本地 Byreal SDK 交易改用 zero-priority builder，保留/補上 `SetComputeUnitLimit`，移除 `SetComputeUnitPrice`，避免 SDK 預設 `computeUnitPrice=50000`。
- **[保護] Auto-Claim reward/order-v2 不改動**：維持 backend payload audit-only，避免 `user signed tx not match`。
- **[測試] 補強 priority fee regression test**：實際解碼 `VersionedTransaction` ComputeBudget 指令，確認 Byreal 無 price、有 limit，並保留 PCS/JUP 相容檢查。

## v1.30.3 (2026-06-02)
- **[修正] Byreal 複製獎勵 order-v2 簽名流程**：copy bonus / reward payload 現在只稽核 backend priority fee，並簽署 Byreal backend 原始 `txPayload`，避免 `user signed tx not match`。
- **[保留] LP fee 直接送鏈仍鎖最低 priority fee**：LP 手續費 claim 的 direct-send payload rewrite 維持不變，不影響 reward/order-v2。
- **[測試] 補強 fee payload 稽核測試**：覆蓋 reward/order-v2 不 rewrite、LP fee rewrite 保留，以及原始 backend payload 簽名行為。

## v1.30.2 (2026-06-01)
- **[修正] Byreal LP 手續費領取改走網頁流程**：claim-all 不再由本機 SDK/RPC 掃描全部 active positions，改為呼叫 `incentive/encode-fee` 並傳入 `positionAddresses=[]`，交由 Byreal backend 回傳可領取項目，避免 `[lp-fee-scan]` 造成 RPC 429。
- **[保護] LP fee 空白交易防護保留**：backend 回傳的 fee entry 若 `tokens` 缺失、空陣列或全 0，仍會在簽名送出前跳過，避免消耗 SOL 領空白交易。
- **[驗證] 補強 Byreal claim 測試**：測試鎖定 `encode-fee` 空陣列 request、empty fee entry skip，以及 backend payload priority fee rewrite 流程。

## v1.30.1 (2026-05-31)
- **[修正] 固定 Byreal/PCS SDK 與後端領取交易 priority fee**：SDK 交易與 Byreal backend payload 會重寫 `computeUnitPrice=1`，維持最低 priority fee；Jupiter 不變。
- **[修正] Byreal LP 手續費領取避免空白交易**：新增 backend fee entry 檢查，`tokens` 缺失、空陣列或全 0 時不簽名、不送出，避免成功但沒有 token balance diff 的空領取交易。
- **[測試] 補齊 priority fee 與 LP fee claim regression**：新增 SDK priority fee source guard、backend payload rewrite、legacy payload rewrite、claim parity 與 empty fee entry skip 測試。

## v1.30.0 (2026-05-31)
- **[設定] Byreal 同 tick 方向拆分**：保留 `BYREAL_ALLOW_SAME_TICK_WALLETS` 作為「別人可開他開過的」，新增 `BYREAL_ALLOW_OPEN_AFTER_OTHERS_WALLETS` 支援「他可開別人開過的」。

## v1.29.3 (2026-05-26)
- **[優化] 背景對帳預設間隔改為 360 分鐘**：降低定期 reconcile 對 RPC 的消耗，仍保留 `RECONCILE_INTERVAL_MINUTES` 可手動調整。
- **[測試] 新增背景對帳間隔回歸檢查**：防止孤兒倉位對帳 timer 被改回 30 分鐘硬編碼。

## v1.29.2 (2026-05-26)
- **[修復] Byreal 領取全部 LP 手續費流程改為 CLI 等價做法**：改用 `position/list` → `incentive/encode-fee` → 本地簽名 → 直接 RPC 送出，不再使用舊的 `liquidity/send` 後端送單路徑。
- **[修復] Byreal incentive rewards 領取流程改為 `encode-v2/order-v2`**：依官方 CLI v0.3.6 先查 `position/unclaimed-data`，只對真的有未領獎勵的 position 送出 type=1 reward claim。
- **[安全] 避免 fee claim 空跑燒 SOL**：每個 fee position 在一次「領取全部」中最多送出一次，不再循環重送同一批 position。
- **[測試] 新增 Byreal claim CLI parity 測試**：覆蓋非 JSON/HTML 錯誤、直接 RPC confirm、重複簽名去重、失敗不計 token、dashboard response shape。

## v1.29.1 (2026-05-10)
- **[修復] Byreal 背景對帳降回舊版鏈上讀取量**：背景 reconcile 只檢查 target NFT 是否仍存在，不再每輪額外掃描自己的 `ourNft`。
- **[修復] Byreal 對帳 log 降噪**：移除背景對帳每筆 `Reconcile scan ... checking` info log，避免大量刷屏。
- **[保留] 手動鏈上核對**：Dashboard「鏈上核對」仍會手動掃描自己的 Byreal NFT，供需要時補 mapping 使用。

## v1.29.0 (2026-05-07)
- **[新增] Byreal 鏈上核對**：Dashboard 新增「鏈上核對」按鈕，掃描錢包鏈上 Byreal NFT，將未在本地 mapping 內的 NFT 匯入倉位列表並標記 `ONCHAIN_AUDIT`，方便直接查看幣種與手動處理。
- **[修復] Byreal 對帳判斷**：對帳現在同時檢查 target 與 our position，target/our position 不存在或 liquidity 為 0 都會視為 orphan，避免手動關倉後 mapping 殘留。
- **[修復] 手動關倉 stale mapping**：手動關倉遇到 `Position not found` 時會清理本地 mapping，不再持續顯示失敗。
- **[改善] Byreal 對帳 log**：掃描時逐筆輸出 target/our NFT、DEX 與狀態，並在掃描結束輸出統計與 orphan queue。
- **[測試] 新增 position map、reconcile log/status、Byreal NFT audit 回歸測試。**

## v1.28.1 (2026-04-30)
- **[修復] DAC 設定頁文案**：移除 xBTC mint 提示文字，設定頁只保留 xBTC / cbBTC 幣種選單。

## v1.28.0 (2026-04-30)
- **[新功能] DAC 定投幣種選擇**：設定頁 DAC 標題改為「每日自動定投 BTC」，新增 xBTC / cbBTC 選項，並支援 `DAC_TARGET_TOKEN` 寫入 `.env`。
- **[新功能] DAC xBTC 支援**：新增 xBTC mint `CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn`，DAC 會依選定幣種透過 Jupiter 買入並記錄幣種與數量。
- **[修復] Signer DAC 轉帳白名單**：signer 現在可用收款錢包地址推導並放行對應 ATA，避免 xBTC / cbBTC DAC 轉帳因 ATA 不同被拒簽。

## v1.27.0 (2026-04-25)
- **[新增] 領取全部手續費 dashboard 按鈕** — 倉位映射區塊新增「領取全部手續費」按鈕，一鍵透過 Byreal API 領取所有未領取 LP 手續費 + offchain 獎勵（同網頁版「領取全部」流程）
  - Phase 1: `incentive/encode-v3` (type=1) → 簽名 → `incentive/order-v3`（後端 co-sign authority + 廣播）
  - Phase 2: `incentive/encode-fee` → 簽名 → `liquidity/send`（後端廣播）
  - 每輪 10 筆，自動循環直到清空，最多 100 輪；總交易數、token 統計、失敗數即時顯示在 modal
  - 完整鏈上落帳，與網頁版收同樣手續費（每筆 ~0.000035 SOL；首次領取會多花 ATA 租金）
- **[修復] WebSocket zombie-subscription 守護** — `monitor/websocket.ts` 偵測到 20 分鐘無事件主動 force reconnect（Helius WS 偶發假死，無 close event 但通知停止）；檢查週期由 30min 縮為 5min
- **[修復] referer_position memo 加 signer attribution** — `byreal-position.ts` 的 memo instruction 改用 `createMemoInstruction(..., [userAddress])`，對齊 `@byreal-io/byreal-clmm-sdk@0.2.2` 官方格式，讓 indexer 可從 memo 直接驗證來源錢包
- **[新增] `ByrealPositionExecutor.collectAllFees()`** — 透過 SDK `collectAllPositionFeesInstructions` 鏈上掃描全部 Byreal 倉位（不依賴 PositionMap），保留作為緊急備援
- **[新增] `PositionMap.getByrealNfts()`** — 篩選 Byreal-only NFT mint
- **[新增] `ecosystem.config.js`** — pm2 啟動範本（`pm2 start ecosystem.config.js`），自動重啟、2GB 記憶體上限、輸出 `/tmp/copybot.log`

## v1.26.11 (2026-04-18)
- **[新增] 超懶人一鍵安裝腳本** — 重寫 `install.sh`，自動裝 Node 20、clone repo、修 CRLF 行尾、裝套件、編譯、建 .env 骨架、加密私鑰、建立 systemd 服務
- **[修復] Windows checkout CRLF 行尾問題** — 新增 `.gitattributes` 強制 `.sh` / `.service` 用 LF，避免 Windows scp 上 Linux VPS 後 bash 無法執行；`signer/start-signer.sh` 正規化為 LF

## v1.26.10 (2026-04-18)
- **[修復] Signer allowlist 加入 Pump.fun Fee 程式** — `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`（Jupiter 路由經 Pump AMM 時會 CPI），修復 Metis swap 被 signer 拒絕的問題；**客戶需 SSH 重啟 byreal-signer 並重新 unlock 密碼後生效**
- **[修復] 錢包代幣餘額常空白** — `getWalletTokenBalances()` 改用 Jupiter Holdings（`/ultra/v1/holdings`）當 primary，RPC 當 fallback；失敗時回 stale cache 不寫入空結果，修掉 free RPC 一次 fail 就 cache 5min 空白的 bug
- **[修復] LPAssets null base64 guard** — Byreal API indexer 對已關倉 position 仍回報 `liquidityUsd > 0` 但 `positionAccountBase64: null`，加 decode 前 guard 避免 `Buffer.from` TypeError；新增 3 個 skipped counter（null-position-base64 / null-pool-base64 / missing-poolMap）

## v1.26.9 (2026-04-08)
- **[修復] 資產總額走勢歷史遺失** — `asset-trend.json` 寫入不再是 non-atomic，防止 bot 被中斷寫入時檔案被截斷
  - 原子寫入：寫到 `.tmp` → 複製舊檔為 `.bak` → rename 取代，過程中斷也不會壞主檔
  - 讀取失敗時優先從 `.bak` 還原，最壞情況保留記憶體內狀態而非清空
- **[優化] 資產走勢載入可靠度** — `/api/trend` 支援 gzip 壓縮（584KB JSON → ~60KB），前端載入失敗自動重試一次
  - 切換到「資產走勢」tab 時如資料為空會自動重新拉取

## v1.26.8 (2026-04-07)
- **[修復] Jupiter TVL 批量查詢** — 用逗號分隔 mint 在單次 search API 查最多 30 個 token，並發請求合併為 batch，消除 429

## v1.26.7 (2026-04-07)
- **[修復] Auto-Claim 領到乾淨** — 每輪 encode→sign→order 完成後等 5s 再觸發下一輪，直到 encode-v2 回傳空為止

## v1.26.6 (2026-04-07)
- **[重寫] Auto-Claim 按 CLI 流程重寫** — 單次 encode-v2 → 全部簽名 → 單次 order-v2，不 loop 不 batch
  - 移除 MAX_BATCHES / submittedPools / dupeRetries 等複雜邏輯
  - 流程與 byreal-cli `positions claim-bonus --confirm` 完全一致

## v1.26.5 (2026-04-07)
- **[修復] Auto-Claim 重複 pool 重試** — 遇到全重複時等 10s 讓 server 更新再查，最多重試 3 次，不再直接停止

## v1.26.4 (2026-04-07)
- **[修復] Auto-Claim API endpoint 修正** — encode-v3/order-v3 改為 encode-v2/order-v2（與官方 CLI 一致）

## v1.26.3 (2026-04-07)
- **[修復] Auto-Claim 完整 debug logging** — 每個步驟 (encode/filter/sign/order) 加 debug log
  - order-v3 完整 response JSON dump
  - 409 Conflict 容錯不 crash，繼續下一 batch
  - apiPost 回應 body log
- **[修復] Jupiter TVL 批量查詢** — 並發請求合併為單次 POST /tokens/v2/mints，fallback 到串行查詢

## v1.26.2 (2026-04-07)
- **[修復] Auto-Claim 領獎不完全** — 移除 MAX_BATCHES=10 硬上限，改為無限迴圈直到 encode-v3 回傳空或全部 pool 已提交
  - 新增 submittedPools 追蹤已提交的 pool，避免重複簽名
  - 新增 encode-v3 / order-v3 業務層錯誤 (ret_code) 日誌，不再靜默吞錯
  - order-v3 response 結構 log（txList/claimTokenList 數量）
- **[修復] Jupiter TVL API 429** — 加入 200ms 請求間隔 + 429 指數退避重試（最多 3 次）

## v1.26.1 (2026-04-07)
- **[修復] Jupiter swap 被 signer policy 拒絕** — Jupiter 透過 CPI 路由到各種 AMM 程式，無法預先列入白名單
  - 當交易包含 Jupiter 指令時，跳過模擬階段的 invoked-program 檢查
  - 非 Jupiter 交易仍維持完整的 invoked-program 白名單驗證

## v1.26.0 (2026-03-25)
- **[新功能] 簽名服務 (Signer Service)** — 私鑰不再存於 Bot 進程，防禦 npm 供應鏈攻擊
  - 獨立簽名進程透過 Unix socket 通訊，每筆交易經 policy engine 驗證後才簽名
  - Policy engine：程式白名單 (28 programs)、SPL Transfer 目標檢查、模擬驗證
  - AES-256-GCM 加密私鑰存儲 (scrypt KDF)，啟動時輸入密碼解鎖
  - Signer 擁有獨立 node_modules（僅 3 個依賴，無 DEX SDK）
- **[新功能] Dashboard 一鍵升級** — Legacy 模式下顯示紅色警示 banner，點擊「升級」自動完成：
  - 加密私鑰 → 建立 signer/.env → 安裝 signer node_modules → 設定 systemd → 啟動服務 → 重啟 Bot
  - 從 .env 移除明文 PRIVATE_KEY
- **[新功能] Dashboard 解鎖介面** — Signer 模式下顯示橘色 banner，直接在 Dashboard 輸入密碼解鎖
  - Signer unlock HTTP 僅監聽 127.0.0.1，Dashboard 內部代理轉發
- **[新功能] manage.sh signer 指令** — `signer-start|signer-stop|signer-logs|signer-status`
- **[架構] Bot 端簽名抽象層** — wallet.ts 新增 signVersioned/signLegacy/RemoteSignerWallet
  - 8 個 executor 檔案共 ~15 處簽名呼叫改用新 API，零業務邏輯變更
  - 向下相容：未設定 SIGNER_SOCKET_PATH 時自動使用舊模式

## v1.25.4 (2026-03-24)
- **[修復] 未領 B 改用 `unclaimed-v2` API** — Dashboard「未領 B」從 `providerOverview` 改為 `position/unclaimed-v2`（與 Byreal 官網一致），失敗時自動 fallback 舊方法

## v1.25.3 (2026-03-22)
- **[新功能] 全 5 DEX partial decrease 跟隨** — 目標做 partial decrease（減少部分流動性但不關倉）時，bot 按比例跟隨減倉，取代舊邏輯的僅收手續費
  - Byreal/PCS：使用 `chain.decreaseLiquidityInstructions({ liquidity })` SDK 方法
  - Meteora DLMM：使用 `removeLiquidity({ bps })` 按 BPS 比例移除
  - DAMM v2：使用 `removeLiquidity({ liquidityDelta })` 精確量移除
  - Orca：使用 `decreaseLiquidity({ liquidityAmount })` 精確量移除（v1.25.2 已實作）
- **[新功能] targetLiquidity 追蹤** — position-map 新增 `targetLiquidity` 欄位，開倉時記錄目標流動性
  - 後續 decrease 事件比較目標當前 vs 存儲值，計算比例
  - increase 後同步更新 targetLiquidity，確保後續 decrease 計算正確
  - 舊倉位（無存儲值）安全降級為收手續費
- **[改善] 減倉代幣自動回充** — partial decrease 收到的代幣加入 pending swap 佇列，自動換回 USDC

## v1.25.2 (2026-03-22)
- **[新功能] Orca partial decrease 跟隨** — Orca 目標做 partial decrease 時按比例減倉（先行版，v1.25.3 擴展到全 5 DEX）

## v1.25.1 (2026-03-22)
- **[新功能] Orca 開倉 USDC 預檢** — swap 前先用 Jupiter 報價估算總 USDC 成本，餘額不足直接跳過，避免無謂 swap
  - 含 5% slippage buffer，預檢失敗不阻擋（fallback 到原流程）

## v1.25.0 (2026-03-22)
- **[修復] Orca out-of-range 開倉/加倉 LiquidityZero (0x177c) 錯誤** — 還原 tokenMax 邏輯回 v1.24.8，zero 側傳 walletBalance（鏈上已驗證不會多存）
  - v1.24.9 錯誤地把 zero 側 tokenMax 改為 0，導致鏈上算出 liquidity=0
  - 鏈上 TX 證實：即使 tokenMaxB=29.59B，out-of-range 實際存入 tokenB=0
- **[新功能] 開倉失敗代幣回充機制** — pre-swap 後開倉失敗時，自動將已 swap 的代幣換回 USDC
  - 追蹤 pre-swap 實際獲得量（`swappedTokens`），失敗時呼叫 `swapBackOnFailure`
  - 跳過穩定幣和 SOL，回充失敗只 log 不 crash
  - 僅回充本次 pre-swap 獲得的代幣，不動原有餘額

## v1.24.9 (2026-03-22)
- **[修復] Orca out-of-range tokenMax 過量暴露** — out-of-range 倉位（一側為 0）不再把整個錢包餘額傳給 Whirlpool program，改為 `BN.min(target, balance)`，zero 側正確傳 0
  - 影響 `openPosition` 和 `increaseLiquidity` 兩處
  - 之前案例：目標 tokenB=0 時，tokenMaxB=29.59B（整個餘額），導致代幣被大量鎖入倉位
- **[修復] Byreal/PCS increase 購買過多** — increase 流程改用 delta（目標全倉量 - bot 現有倉位量）取代全倉量
  - 之前 deficit = 目標全倉量 - 錢包餘額，完全沒扣除 bot 倉位已鎖的代幣，導致 pre-swap 購買遠超需要
  - 修復後先讀取 bot 現有倉位（`retryGetPosition`），算出真正的增量差額
  - Orca/Meteora 已正確使用 delta，不受影響

## v1.24.8 (2026-03-16)
- **[修復] Block height exceeded 重試** — 全 5 個 DEX executor 加入 `isTransientError` 判斷，signature expiration 錯誤歸類為 transient error 並重試
- **[修復] 平倉錯誤 [object Object] 修復** — 所有 5 個 DEX executor 的平倉失敗通知改傳完整 error 物件 + `parseOnChainError` 深層提取
- **[修復] PCS 補缺 `isTransientError` 方法**
- **[修復] Byreal/PCS close 外層加 `isTransientError` 判斷**
- **[修復] Orca reconcile 加 liquidity=0 孤兒檢測**

## v1.24.7 (2026-03-16)
- **[修復] Orca openPositionWithMetadata 開倉漏判** — 缺少 discriminator `f21d86303a6e0e3c`，導致開倉被誤判為 INCREASE → SKIP 無映射

## v1.24.6 (2026-03-14)
- **[優化] DLMM pool cache** — 30min TTL，每個 pool 省約 14 RPC calls
- **[修復] Close 流程 429 不再誤刪 mapping** — 用 `getPosition` 取代 `getPositionsByUserAndLbPair`，加入 transient error 區分

## v1.24.5 (2026-03-13)
- **[修復] Meteora DLMM Alchemy 429 rate limit 全面修復**
  - **錯開 reconcile 排程**：5 個 DEX reconciler 不再同時觸發，各間隔 15 秒（Byreal +60s, Orca +75s, Meteora +90s, PCS +105s, DAMM v2 +120s），避免與 asset-trend snapshot 碰撞
  - **輕量 Meteora reconcile**：用單一 `getAccountInfo` 取代 `DLMM.create + getPositionsByUserAndLbPair`（11-16 RPC calls → 1），降 90% Alchemy 讀取
  - **Meteora RPC connection 修復**：DECREASE/claimFee/close path 的 `DLMM.create` 改用 `readConnection`
  - **Reconciler cross-DEX filter**：`reconcilePositions` 和 `enqueueReconcile` 只處理自己 DEX 的 entries
  - **INC slippage parameter**、**CLOSE event logging**、**isMeteoraPosition checker**
- **[新功能] DLMM multi-TX open** — 大 bin range（>70 bins）自動拆分多筆 TX
  - `initializePosition2` + `increasePositionLength2` + `addLiquidityByStrategyChunkable`
  - `getPosition` 修復（single RPC），`signAndSend` 支援 additionalSigners

## v1.24.4 (2026-03-13)
- **[UI] 錢包矩陣表格重新設計** — 機器人設定頁面的 5 個平台錢包 textarea 整合為 2 個矩陣表格
  - 錢包 × 平台啟用矩陣：一次管理所有錢包在各平台的複製/僅關倉狀態，checkbox 互斥
  - 錢包 × 平台倍率矩陣：只顯示啟用複製的組合，可設定個別倍率
  - 自動新增空白列（在最後一列輸入時自動追加）
  - 重設/套用按鈕：可獨立還原或立即儲存錢包設定
  - 支援窄螢幕水平捲動，第一欄 sticky

## v1.24.3 (2026-03-11)
- **[修復] Pre-queue spam TX 過濾** — WebSocket 收到 TX 時，在 enqueue 前就過濾 spam TX（≥5x system-program + 無 ComputeBudget），避免 spam TX 佔據 queue 導致 open position blockhash 過期（block height exceeded）

## v1.24.2 (2026-03-11)
- **[新功能] 手動開倉 API** — `/api/actions/manual-open` 可手動觸發跟單開倉，用於重建失敗的倉位
  - 支援全部 5 個 DEX（Byreal/Orca/Meteora/PCS/DAMM v2）
  - 參數：targetNft, poolAddress, targetWallet, dex

## v1.24.1 (2026-03-11)
- **[修復] Dashboard 低 TVL 顯示跟隨 TVL_SOURCE 設定** — 切換到 Jupiter 模式後，倉位資產 TVL 值和「低 TVL 持倉」警告現在正確使用 Jupiter 流動性數據
  - `/api/asset-breakdown` 改用 `checkTokenLiquidity()` 取代硬編碼 `getTokenTvl()`
  - `/api/tvl-query` 也跟隨 tvlSource 路由

## v1.24.0 (2026-03-11)
- **[新功能] Jupiter 全市場 TVL / 流動性過濾** — 新增 `TVL_SOURCE` 設定（`dex` 或 `jupiter`）
  - `jupiter` 模式：用 Jupiter Tokens V2 API 查詢 token 全市場流動性，通用於全部 5 個 DEX
  - `dex` 模式：維持原有各 DEX 獨立查詢（Byreal API / Orca API / Meteora API）
  - DAMM v2 新增 TVL 檢查（之前完全沒有，Nami 事件的根因）
  - Jupiter 查詢結果快取 10 分鐘，查不到的 token 快取 5 分鐘
  - Dashboard 新增 TVL 來源切換（各 DEX API / Jupiter 全市場）
  - 新增 `src/monitor/jupiter-tvl.ts` 模組

## v1.23.3 (2026-03-11)
- **[新功能] 批量關倉** — Dashboard 倉位表新增 checkbox 多選 + 「批量關倉」按鈕
  - 勾選多個倉位後一鍵逐一關倉，支援全部 5 個 DEX（Byreal/Orca/Meteora/PCS/DAMM v2）
  - 即時進度顯示（正在關倉 1/N...），完成後統計成功/失敗數
  - 全選/取消全選 checkbox，搜尋篩選後只選可見倉位
  - 新增 `/api/actions/batch-close` API（上限 50 個倉位）

## v1.23.2 (2026-03-11)
- **[修復] Dashboard per-DEX 統計** — 同一錢包跨多個 DEX 時，現在正確顯示各 DEX 獨立的 open/skip 計數
  - 新增 `byDexWallet` / `byDexWalletType` 統計維度（key: `dex:wallet`）
  - EventLogEntry 新增 `dex` 欄位，handleEvent 自動從 event.type 推導 DEX 標籤
  - Dashboard renderTargets 改用 `dexStats()` helper 讀取 per-DEX 數據，fallback 到全域統計

## v1.23.1 (2026-03-11)
- **[修復] SOL 池 pre-swap 支援** — 全部 5 個 DEX executor（Byreal/Orca/Meteora/PCS/DAMM v2）的 open + increase 流動性
  - 原本完全跳過 SOL 代幣的 pre-swap（`!mint.equals(NATIVE_MINT)` 排除），導致 SOL 池無法自動補倉
  - 修改為：SOL 不足時只嘗試 `USDC→SOL`（不花其他代幣換 SOL），安全保留 gas 餘額
  - `getTokenBalance` 已內建 50M lamports (0.05 SOL) gas 預留，確保不會把 gas 全部投入 LP

## v1.23.0 (2026-03-11)
- **[新功能] Meteora DAMM v2 LP 跟單** — 第 5 個 DEX（Constant Product AMM，Program: `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`）
  - SDK: `@meteora-ag/cp-amm-sdk`，完整支援 createPosition / addLiquidity / removeLiquidity / closePosition / claimFee
  - 獨立目標錢包設定：`DAMMV2_TARGET_WALLETS`、`DAMMV2_CLOSE_ONLY_WALLETS`、`DAMMV2_WALLET_AMOUNT_RATIOS`、`DAMMV2_SKIP_SOL`
  - TX Parser：Anchor discriminator 偵測 7 種 instruction（create/add/remove/removeAll/close/claimFee/claimReward）
  - DammV2PositionExecutor：pre-swap、pump filter、drawdown 保護、retry、reconcile、pending swap
  - Dashboard 完整整合：狀態卡片（'D' 徽章）、設定面板、倉位列表、asset trend、手動關倉
  - WebSocket 訂閱 DAMMV2 target wallets
  - Position map countByDex / lockedSol 含 dammv2

## v1.22.7 (2026-03-10)
- **[修復] Dashboard token 名稱不顯示（Token2022）** — 三層修復：
  - Jupiter Token API 加 `x-api-key` header，修復 VPS 上 401 Unauthorized
  - Helius fallback 從舊的 `v0/token-metadata` 改用 **DAS API `getAssetBatch`**，支援 Token2022 metadata
  - `ensureTokenNames` 所有 catch 加 `logger.warn`，不再靜默吞錯

## v1.22.6 (2026-03-10)
- **[修復] Auto-claim 獎勵金額顯示 0 USD** — `epoch-bonus` 快照改為領取前查詢，避免平台重置後才查到 0
  - 移除多餘的 pre-snapshot 排程機制，簡化為：查 epoch-bonus → 領取，一次流程
  - 新增 `snapshotTs` 欄位記錄實際快照時間

## v1.22.5 (2026-03-10)
- **[修復] Jupiter swap 比例計算改用 `targetAmountRaw × walletRatio`** — 取代失敗的百分比方案
  - v1.22.4 的百分比方案在 fee swap 場景失敗（target wallet 只有 fee tokens → 100% → bot 全賣）
  - 新方案：bot swap = `min(targetSwapAmount × walletRatio, botBalance)`
  - 支援跨 DEX ratio 查找（Orca → Meteora → PCS → Byreal → global）
  - Fee swap、partial close、分批 swap 等場景全部正確

## v1.22.4 (2026-03-09)
- **[修復] Jupiter swap 全賣問題** — target 部分賣出 token 時，bot 不再賣掉全部庫存
  - 改為按比例操作：計算 target 賣出佔其持倉的百分比，bot 賣同比例
  - Parser 新增 `inputPreBalanceRaw` 欄位，追蹤 target swap 前的 token 餘額
  - `swapTokenToUSDC` 改接受 `swapPctBps` 百分比參數（basis points），預設 10000 = 全部

## v1.22.3 (2026-03-09)
- **[修復] Jupiter swap 偵測遺漏** — 移除 Orca/Meteora/PCS 的互斥排除條件，改為 fallback 模式（先跑 DEX parser，`events.length === 0` 才跑 Jupiter swap parser）
  - 修復 target 的 Jupiter swap 路由經過 Orca/Meteora AMM 時不被偵測的問題
  - 修復關倉後 token 無法自動換回 USDC 的 pending swap 殘留問題
- **[修復] Dashboard token 名稱顯示** — 改用 Jupiter Token API 批次預解析，取代逐次同步讀取 token-names.json
  - `/api/positions` 和 `/api/events` 回傳前先 `ensureTokenNames()` 批次查詢
  - Helius DAS REST API fallback（Jupiter 查不到的 token）
- **Dashboard token 名稱快取改進** — 移除低效的同步檔案讀取，改為記憶體快取 + 非同步 API 查詢

## v1.22.0 (2026-03-09)
- **[新功能] PancakeSwap Solana CLMM LP 跟單** — 第 4 個 DEX，Raydium CLMM fork（Program: `HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq`）
  - 獨立目標錢包設定：`PCS_TARGET_WALLETS`、`PCS_CLOSE_ONLY_WALLETS`、`PCS_WALLET_AMOUNT_RATIOS`、`PCS_SKIP_SOL`
  - SDK monkey-patch：runtime 建立 modified IDL 繞過 `getAmmV3Program()` 白名單限制
  - PcsPositionExecutor 完整支援 Open/Close/Increase/Decrease/CollectFees
  - Anchor log 偵測（與 Byreal 相同模式，非 discriminator）
  - 4-DEX position-map（byreal/orca/meteora/pancakeswap），Byreal reconcile 保護 PCS 映射
- **Dashboard PancakeSwap 完整整合**
  - 狀態總覽：PCS 倉位數、鎖倉 SOL（B:x O:y M:z P:w 格式）
  - 設定頁：PCS 目標錢包、僅關倉錢包、個別錢包倍率、Skip SOL 開關
  - 資產趨勢快照包含 `pcsLpUsd`、`pcsFeesUsd`、`pcsLockedUsd`
  - 倉位管理：PCS 倉位手動關倉、LP 明細 P badge
  - renderTargets 顯示 PCS 錢包（粉紫色 badge）
- **Dashboard Bug 修復** — Meteora 倉位 badge 原本錯誤顯示為 'B'，現已修正為 'M'（紫色）
  - renderTargets 補上缺失的 Meteora 錢包列表
  - LP 明細表 Meteora badge 修正

## v1.21.0 (2026-03-09)
- **[新功能] Meteora DLMM LP 跟單** — 支援 Open/Close/AddLiquidity/RemoveLiquidity/ClaimFee 五種操作鏡像
  - 獨立目標錢包設定：`METEORA_TARGET_WALLETS`、`METEORA_CLOSE_ONLY_WALLETS`
  - Discriminator-based TX 解析器（24 條 DLMM 指令全覆蓋，含 V1/V2 變體）
  - MeteoraPositionExecutor 內建所有 Orca bug fixes（RPC lag retry、pre-swap、orphan recovery、tokenMax cap）
  - 3-DEX position-map（byreal/orca/meteora），Byreal reconcile 保護 Meteora 映射
- **Dashboard Meteora 完整整合**
  - 狀態總覽：Meteora 倉位數、鎖倉 SOL、目標錢包數（B:x O:y M:z 格式）
  - 設定頁：Meteora 目標錢包、僅關倉錢包、個別錢包倍率管理
  - 資產趨勢：快照包含 `meteoraLpUsd`、`meteoraFeesUsd`、`meteoraLockedUsd`
  - 倉位管理：Meteora 倉位手動關倉支援
- **資產趨勢 Meteora LP 修復** — `MeteoraLpFetcher` 改回傳 `{ lpUsd, feeUsd, count }`，修復 fetcher 從未被呼叫的 bug

## v1.20.1 (2026-03-09)
- **Orca Pool TVL 過濾** — 開倉/加倉前查詢 Orca REST API `tvlUsdc`，共用 `MIN_POOL_TVL` 門檻（10 分鐘 cache）
- Dashboard LP 倉位明細顯示 Orca pool TVL
- 修復 VPS 缺失代幣名稱：AOR、UGOR

## v1.20.0 (2026-03-08)
- **[新功能] Orca Whirlpool LP 跟單** — 支援 Open/Close/Increase/Decrease/CollectFees 五種操作鏡像
  - 獨立目標錢包設定：`ORCA_TARGET_WALLETS`、`ORCA_CLOSE_ONLY_WALLETS`、`ORCA_WALLET_AMOUNT_RATIOS`
  - 開倉前自動預換幣（USDC→token / tokenB→tokenA / surplus-only fallback）
  - Pump 代幣過濾（同 Byreal 三態模式）、共用回撤暫停
  - 指令偵測改用 instruction data discriminator（相容 Pinocchio 遷移後無 Anchor log 的 V1/V2 指令）
  - RPC 延遲防護：開倉 retry 3 次、加倉 2s 初始延遲 + delta ≤ 0 retry、tokenMax=0 改用錢包餘額避免 LiquidityZero
- **Dashboard Byreal/Orca 分離顯示** — 倉位數量、鎖倉 SOL、LP 價值、未領費用、LP 倉位明細全部標註 B/O 分開計算
  - 鎖倉 rent 從 RPC 動態查詢（Byreal: 9,013,200 / Orca: 5,895,120 lamports）
  - 倉位映射表前綴 B/O badge、LP 明細表前綴 dex badge
  - Orca 代幣名稱啟動時從 Jupiter API 自動補齊
- **Orca 讀取改用免費 RPC** — LP 價值/倉位明細查詢走 round-robin 免費 RPC，不消耗 Alchemy 額度
- 修復 collectFeesQuote overflow — freshly-opened position 的 `subUnderflowU128` 產生天文數字 BN，加入 1e15 sanity guard

## v1.19.4 (2026-03-06)
- 修復 DAC 利潤計算三個問題：
  1. **基準日錯誤**（CRITICAL）— `daily` 最後一筆可能是今天早上的 snapshot，24h cutoff 會跳到前天。改用台北時間日曆日判斷，取今天午夜前最近的 daily snapshot
  2. **排除 SOL 公式不完整** — 只扣 `solBalanceUsd`，未扣 `lockedSolUsd`（position rent ~$103）。已對齊 Dashboard 公式 `totalUsd - solBalanceUsd - lockedSolUsd`
  3. **同日可重複執行** — 排程 + 手動觸發可在同一天跑兩次 DAC。新增同日防護：檢查 dacHistory 今天是否已有 success 紀錄
- `forceSnapshot()` 靜默失敗偵測 — 比較 snapshot 前後 raw 陣列長度，未產生新 snapshot 時 log 警告

## v1.19.3 (2026-03-06)
- 修復一鍵換幣誤報成功 — `sendWithRetry` 的 `confirmTransaction` 只確認交易上鏈，未檢查執行結果。滑點超限等鏈上失敗會被當作成功回報。新增 `getTransaction` 驗證 `meta.err`，失敗時正確 throw error
- 修復資產走勢圖表 Y 軸不自動縮放 — 切換時間範圍後 Y 軸固定不動，新增 `priceScale('right').applyOptions({ autoScale: true })`

## v1.19.2 (2026-03-05)
- Pump 代幣審批過期時間從 24 小時縮短為 1 小時 — 降低 Cloudflare Workers KV 輪詢消耗
- Worker KV TTL 同步調整為 1 小時
- Discord 過期通知文字更新

## v1.19.1 (2026-03-04)
- DAC Dashboard 紀錄改為月份篩選 — 新增月份下拉選單，依月份顯示歷史紀錄（取代只顯示最後 10 筆）
- DAC 狀態符號改為 ✓/–/✗（取代易混淆的 O/X），紀錄列表加上綠/灰/紅顏色
- Discord 通知全面中文化 — DAC 與所有通知類型（SOL 不足、回撤暫停、開倉/平倉/兌換失敗、Pump 審批、崩潰）的欄位名稱改為中文，時間改為台灣時間

## v1.19.0 (2026-03-04)
- **[新功能] DAC (Daily Auto-Convert)** — 每日自動定投 cbBTC 功能
  - 每天在設定時間（Asia/Taipei）檢查昨日獲利（排除 SOL）
  - 獲利達門檻時，自動用 USDC 透過 Jupiter 買入 cbBTC 並轉帳到指定地址
  - 設定項：`DAC_ENABLED`、`DAC_AMOUNT_USD`、`DAC_THRESHOLD_MULTIPLIER`、`DAC_EXECUTE_HOUR`、`DAC_EXECUTE_MINUTE`、`DAC_TRANSFER_TO`
  - Dashboard API：`GET /api/dac/status`、`GET /api/dac/history`、`POST /api/dac/config`、`POST /api/dac/trigger`
  - Dashboard 設定頁面：開關、金額、門檻倍數、時間選擇器、轉帳地址、手動觸發、歷史紀錄
  - 並行鎖防止 double-swap、delta-only 轉帳、confirmTransaction 改用新版 API
  - 執行歷史記錄於 `./data/dac-history.json`（最多 365 筆）
  - Discord 通知支援

## v1.18.9 (2026-03-04)
- 自動領取結果顯示優化 — 領取前先查詢 epoch-bonus type=2 的 `totalBonusUsd`，Dashboard 顯示「領取成功，12.34 USD（快照 16:29）」取代舊的「84 pools, 0 tokens」
- 時間格式為台灣時間 (UTC+8) HH:MM

## v1.18.8 (2026-03-04)
- 資產走勢錢包餘額查詢改回 Jupiter Ultra Holdings API — v1.18.0 改用 RPC（`getWalletTokenBalances`）後查詢速度較慢且無明顯優勢，改回 Jupiter Holdings API（單一 HTTP 請求取得所有代幣餘額），降低延遲並減少 RPC 負擔
- 移除 `WalletBalanceFetcher` type 與 `walletBalanceFetcherRef`，`fetchSnapshotData()` 直接使用 `fetchJupiterHoldings()`

## v1.18.7 (2026-03-03)
- **[新功能] 排除 SOL 走勢切換** — 資產走勢新增「全部 | 排除 SOL」按鈕，扣除錢包 SOL 餘額與鎖倉 SOL，只看 LP + 非 SOL 代幣 + 費用 + 獎勵的淨損益
- Snapshot 新增 `solPrice`、`solBalanceUsd` 欄位供排除 SOL 計算
- 異常偵測重查前清除 wallet balance 快取，避免命中 RPC 壞資料
- 手機版 toolbar 換行修復（flex-wrap）

## v1.18.6 (2026-03-03)
- 網頁圖表新增去抖動功能(右上) 不修改資料來源

## v1.18.5 (2026-03-03)
- 異動偵測閾值從 5% 降至 1% — `totalUsd` 變動 ≥1% 即觸發 60 秒後重查，提高走勢精確度

## v1.18.4 (2026-03-03)
- 異動偵測改為百分比制 — 固定 $100 門檻改為 `totalUsd` 變動 ≥5% 時觸發重查（等 60 秒後重新查詢），適應不同資產規模

## v1.18.3 (2026-03-03)
- 資產走勢改為固定 5 分鐘間隔 — 不再跟隨開關倉/加減倉/swap 觸發快照；移除 `scheduleEarlySnapshot()`、`resetIdleTimer()`、`OperationQueue` 依賴
- 移除操作守衛（isExecuting / POST_OP_DELAY / MIN_GAP） — `setInterval` 純獨立運行，僅保留 `snapshotInProgress` 防止重疊
- 新增 $100 異動偵測 — `totalUsd` 與上一筆差距 ≥$100 時，等待 60 秒後重新查詢所有資料源，寫入重查結果（取代舊的 20% tokensUsd outlier 偵測）
- 程式碼重構 — 抽出 `fetchSnapshotData()` 與 `commitSnapshot()` 兩個 helper

## v1.18.2 (2026-03-03)
- **[新功能] 倉位集中度過濾器** — 防止單一非穩定幣代幣在 LP 總倉位中佔比過高；支援全域 USD 上限（`MAX_COIN_CONCENTRATION_USD`）與百分比上限（`MAX_COIN_CONCENTRATION_PCT`），觸發時跳過 `copyOpenPosition` / `copyIncreaseLiquidity`
- **[新功能] 個別代幣集中度覆寫** — 可針對特定代幣設定獨立的 USD / % 上限，儲存於 `data/coin-concentration-overrides.json`；Dashboard 新增「集中度」設定頁

## v1.18.1 (2026-03-03)
- 修復走勢 5 分鐘 idle timer 停止運作 — 移除 `scheduleRetry()` 共用 `pendingRetry` 變數造成的競爭條件，`setInterval` 不再依賴 promise chain 維持自身
- 修復操作後 early snapshot 被守衛靜默攔截 — `skipPostOpGuard` 跳過 `isExecuting`、`POST_OP_DELAY`、`MIN_GAP` 三道守衛，確保 OPEN/CLOSE/INCREASE/DECREASE/SWAP 後 60 秒一定拍照
- 新增 `snapshotInProgress` flag 防止重疊快照（掛起的網路請求不會阻塞下次 interval）
- `forceSnapshot()` 同樣跳過所有守衛（Dashboard 手動刷新不受限制）

## v1.18.0 (2026-03-02)
- 資產走勢「持倉」資料源改為 on-chain RPC — 從 Jupiter Holdings API 改為 `getWalletTokenBalances()`（getBalance + getParsedTokenAccountsByOwner），含 SOL/USDC/USDT 全部 token，Dashboard 顯示時過濾穩定幣
- 錢包餘額 5 分鐘快取 — 走勢收集與 Dashboard API 共用同一份快取，避免重複 RPC
- LP 倉位資產明細改用 Byreal REST API — `getPositionAssets()` 從 Alchemy RPC（126×getPositionInfoByNftMint → 429）改為 Byreal `position/list`（pageSize=100，2 次 API 呼叫）+ 本地 SDK `LiquidityMath` 解碼 base64 計算精確 token 數量，零 RPC
- LP 快取同步至 5 分鐘 — `LP_ASSETS_TTL` 從 30 分鐘改為 5 分鐘，與走勢收集間隔一致
- 倉位變動自動刷新 — OPEN/CLOSE/INCREASE/DECREASE/SWAP 後 `invalidateAssetCaches()` 清除所有快取 + `scheduleEarlySnapshot()` 60 秒後觸發走勢快照
- Dashboard 刷新同步 — 走勢重新整理觸發 `forceSnapshot()`，LP 明細重新整理同步刷新走勢
- `POST_OP_DELAY` 改為 60 秒 — 避免操作後立即快照觸發免費 RPC 429
- 走勢快照 debounce 計時器 — 操作後 60 秒快照 + 重置 5 分鐘計時器，連續操作只保留最後一次倒數
- 前端走勢自動 reload — `/api/status` 帶 `trendLatestTs`，前端每 30 秒偵測到新快照自動更新圖表，移除獨立輪詢
- 錢包餘額改用免費 RPC — `getWalletTokenBalances()` 從 Alchemy 改為 freechains round-robin，Alchemy 不再被 dashboard/走勢使用

## v1.17.9 (2026-03-02)
- TVL 快取格式擴充 — 由 `mint → tvl` 改為 `mint → { tvl, openTime }`，新增 `getPoolInfo()` 匯出以供後續過濾使用；舊格式快取檔自動相容轉換
- LP 倉位資產明細新增「配對穩定幣」欄 — 對每個非穩定幣代幣，顯示在 LP 倉位中實際配對的 USDC/USDT 總量（不重複計入穩定幣本身的餘額列）
- LP 倉位資產明細 USDC/USDT 置頂 — 穩定幣列固定顯示於表格最上方，其餘代幣依 USD 價值遞減排序

## v1.17.8 (2026-03-02)
- 修復資產走勢 7D 圖表無法顯示 — hourly 層有大量重複時間戳（bot 重啟時 aggregation 重複寫入），LightweightCharts 不允許重複 time 值導致圖表不渲染
- Server-side: `loadTrend()` 新增 hourly 去重（同 daily 做法，同一小時只保留最後一筆）
- Client-side: `chartData` 去重防護 + 新增 `mergeTiers()` 合併 hourly（>48hr 前）+ raw（近 48hr），確保 7 天完整連續覆蓋
- 30D 圖表及變化率面板同步使用合併資料源

## v1.17.7 (2026-03-01)
- 資產走勢 token 價格快取 — Jupiter Price API 未回傳某 token 價格時，fallback 到上次已知價格，防止 tokensUsd 掉到 $0
- 資產走勢 outlier detection — tokensUsd 變化 >20% 但 lpValueUsd <5% 時，第 1 次跳過（API 抖動），連續第 2 次放行（真實變動），避免假波動干擾走勢圖及 drawdown 暫停
- 修復 daily 層歷史重複寫入 bug — `loadTrend()` 時自動去重（同一天只保留最後一筆）

## v1.17.6 (2026-03-01)
- 修復 Dashboard pump-pending 輪詢在登入前就啟動的問題 — `setInterval(loadPumpPending, 5000)` 從 global scope 移至 `loadAll()`，避免未登入時每 5 秒觸發 API 認證失敗並觸發 rate limiter 封鎖

## v1.17.5 (2026-03-01)
- Discord 通知錯誤解析 — on-chain 錯誤（0x1785 PriceSlippageCheck、0x177d SqrtPriceLimitOverflow 等）顯示簡潔中文摘要，不再傾印整段 simulation log
- 套用至 `notifyOpenFailed`、`notifyCloseFailed`、`notifySwapFailed` 三個通知函式

## v1.17.4 (2026-02-28)
- 修復 SDK bug — Byreal pool swap `sqrtPriceLimitX64` 從 `executionPrice`（模擬後價格）改為安全邊界值（MIN/MAX_SQRT_PRICE），防止池子價格移動時觸發 `0x177d SqrtPriceLimitOverflow` 錯誤。金額滑點保護 `maxAmountIn` 不受影響

## v1.17.3 (2026-02-28)
- 事件日誌結果篩選新增「等待審批」按鈕 — 可快速篩選 Pump 代幣等待確認的 SKIP 事件
- Dashboard 批准/拒絕 Pump 代幣時自動更新 Discord 通知 — 呼叫 Worker `/pump-resolve` 端點編輯原始訊息，標題改「Pump 代幣已審批」、移除按鈕、顯示批准/拒絕狀態及時間戳
- Discord 通知代幣名稱解析 — `notifyPumpApproval` 發送前先查 Jupiter API 取得真實代幣名稱，避免顯示截斷的 mint 地址
- 移除所有 `mint.slice(0, 8)` 截斷 fallback — `getTokenSymbol`、test endpoint、resolve endpoint 改為顯示完整 mint 或 Jupiter 解析名稱

## v1.17.2 (2026-02-28)
- Pump 代幣審批 24 小時過期機制 — 超過 24 小時未回應的 pending 條目自動拒絕並加入黑名單，發送 Discord「Pump 代幣審批已過期」通知
- 過期時自動編輯原始 Discord 審批訊息 — 移除 ✓/✗ 按鈕，改為灰色「已過期」狀態，避免用戶誤點
- Worker 儲存審批訊息 ID — 發送審批通知時存入 KV `msg:{wallet}:{mint}`，供過期時回溯編輯原訊息
- KV 自動過期 — 所有 PUMP KV 條目新增 `expirationTtl: 86400`（24 小時自動刪除）
- 修復 `getPositionAssets()` Alchemy 免費方案 403 錯誤 — `getTokenAccountsByOwner` 為 Index RPC method，Alchemy 免費方案不支援。新增 retry loop 遍歷所有 free RPC，全部失敗則 fallback 到 stale cache

## v1.17.1 (2026-02-27)
- 修復 SDK `getMultipleAccountsInfo` 未分批問題 — 當錢包 NFT 超過 100 個時，RPC 會回傳 "Too many inputs provided; max 100" 錯誤。新增 `patchConnectionChunking` 自動將請求分為每批 100 個帳戶，套用至所有 SDK 使用的 Connection

## v1.17.0 (2026-02-27)
- 新增 Pump 代幣 Discord 審批系統 — `PUMP_FILTER_MODE` 三態下拉選單（關閉 / 完全過濾 / Discord 通知過濾）
- Discord 通知過濾模式：偵測到 pump 代幣時先封鎖交易，發送帶有 ✓/✗ 按鈕的 Discord DM（含 Jupiter 代幣連結），用戶在 Discord 點批准/拒絕後自動放行或加入黑名單
- Cloudflare Worker 新增 PUMP KV namespace — 儲存 Discord 按鈕審批結果，Bot 同步輪詢取得結果
- 通知佇列機制 — 多筆 pump 代幣偵測時以 2 秒間隔依序發送 Discord 通知，避免 rate limit
- KV 自動清理 — 批准/拒絕後自動刪除 Worker KV 記錄，防止資料無限累積
- 同步輪詢 — Dashboard 刷新時同步呼叫 `pollApprovals()`，取代獨立 timer
- Dashboard 黑白名單面板新增「等待確認」與「已批准」區塊 — 顯示代幣圖片 + 名稱（Jupiter V2 API 後端代理），支援手動批准/拒絕/刪除
- 狀態總覽新增 pending pump 代幣 pill — 直接在首頁顯示待審批代幣及 ✓/✗ 按鈕
- 黑名單顯示代幣名稱 + 圖片 — 後端 `/api/config` 回傳 `{ mint, symbol, logoURI }` 物件，`token-names.json` 作為名稱 fallback
- 新增 `src/state/pump-pending.ts` 待審批狀態管理模組 — 持久化至 `data/pump-pending.json`
- 新增 `src/utils/env.ts` — 抽出 `updateEnvFile` 共用函式
- 新增 `/api/token-meta/:mint` 端點 — Jupiter V2 API 後端代理，解決 CORS 限制
- 向後相容：`IGNORE_PUMP_TOKENS=true` 自動 fallback 為 `PUMP_FILTER_MODE=full`
- RPC 職責分離明確化 — Helius 僅負責 WebSocket 監聽、sendTransaction、getLatestBlockhash + confirmTransaction；Alchemy 負責所有讀取操作（SDK getAccountInfo/getPositionInfo、getParsedTransaction、getBalance），Helius 不再被打任何 getAccountInfo

## v1.16.7 (2026-02-27)
- 新增「過濾 Pump 代幣」功能 — `IGNORE_PUMP_TOKENS=true` 時，若開倉池中任一代幣地址含有「pump」字串，則跳過開倉與加倉動作；可於 Dashboard 風險管理頁面即時開關
- 新增「最短池齡」過濾 — `MIN_POOL_AGE_DAYS` 設為大於 0 的天數時，池子開放未滿此天數則跳過開倉與加倉；池齡資料來自 TVL 快取的 `openTime` 欄位；可於 Dashboard 風險管理頁面設定，0 表示停用

## v1.16.6 (2026-02-27)
- LP 倉位更新改為30分鐘
- 新增幾個免費rpc

## v1.16.5 (2026-02-27)
- `RPC_URL_FREE` 改為逗號分隔陣列，支援多個免費 RPC — `getPositionAssets` 以 Round-Robin 輪流使用，單一 RPC 失敗自動嘗試下一個
- `getPositionAssets` 並行批次查詢 — 原先逐一序列呼叫 `getPositionInfoByNftMint`，改為每批 免費rpc數量*3 筆並行（`Promise.allSettled`），倉位查詢時間大幅縮短

## v1.16.4 (2026-02-27)
- 修正 TVL 篩選排除穩定幣 — USDC、USDT（standard + Token2022）在 TVL 快取中顯示為 0，導致所有含穩定幣的池子被誤判為低 TVL 而跳過開倉；新增 `STABLE_MINTS` 排除集合
- Discord 通知改善 — Swap Failed 通知改用英文標題避免編碼問題、顯示實際代幣名稱（如 WhiteWhale）取代 tokenMint、Error 欄位顯示 Jupiter/Byreal 實際錯誤訊息
- 新增 `lastSwapError` 追蹤 — `jupiter-swap.ts` 模組級變數記錄最後一次 swap 失敗的錯誤訊息，供通知模組引用

## v1.16.3 (2026-02-27)
- Discord 換幣失敗通知改善 — 標題改為「換幣失敗」、顯示代幣名稱（如 WhiteWhale）取代 tokenA/tokenB、原因欄位更清晰

## v1.16.2 (2026-02-27)
- Discord 通知附帶事件發生 UTC 時間 — Time 欄位改為記錄事件觸發時間，非發送時間，消除聚合延遲造成的時間差

## v1.16.1 (2026-02-27)
- 修正 Dashboard 更新失敗 JSON 解析錯誤 — 更新 API 回應改用 `res.text()` + safe JSON parse，避免非 JSON 回應導致 crash
- 更新時連線中斷自動重連 — bot 重啟導致的網路中斷不再顯示「更新失敗」，改為自動等待重新連線

## v1.16.0 (2026-02-27)
- Windows 日誌持久化與日期輪替 — 日誌從 `/tmp/copybot.log` 遷移至 `data/logs/copybot-YYYY-MM-DD.log`，每天一檔，啟動時自動清理超過 7 天的舊日誌

## v1.15.9 (2026-02-26)
- 垃圾交易過濾 — `parseTransaction` 在呼叫 `getParsedTransaction` 前，預先從 WebSocket 日誌篩除大量 SOL 分發垃圾交易：需同時滿足 5+ 次 System Program success 且不含 Compute Budget 指令，符合條件直接略過，節省 RPC 請求

## v1.15.8 (2026-02-26)
- 低 TVL 持倉警示表格自適應 — 縮小 padding 與間距，手機版不再溢出裁切；與監控目標錢包區塊之間新增間距

## v1.15.7 (2026-02-26)
- TVL 快取查詢 — Dashboard TVL 篩選面板新增代幣 Mint 查詢功能，可即時查詢快取中的 Pool TVL；顯示上次獲取時間與快取數量
- 立即重新獲取按鈕 — 手動觸發 TVL 快取刷新（`POST /api/actions/tvl-refresh`）
- LP 倉位資產明細新增 Pool TVL 欄 — 顏色分級：綠 ≥$100k、黃 ≥$10k、紅 <$10k
- 低 TVL 持倉警示 — 狀態總覽新增區塊，以表格列出所有 TVL <$10k 的持倉代幣（圖片、名稱、TVL、數量、價值），按 TVL 由低到高排序
- 低 TVL 一鍵加黑名單 — 警示表格內「黑名單」按鈕，確認後直接儲存設定（PATCH /api/config）
- 點擊代幣名稱跳轉倉位映射 — 自動切換至倉位管理分頁並篩選對應代幣
- 新增 API：`GET /api/tvl-query`（單一代幣 TVL 查詢）、`POST /api/actions/tvl-refresh`（強制刷新）
- `fetchAndCache` 改為 export，`getTvlCacheInfo` fallback 至檔案修改時間

## v1.15.6 (2026-02-26)
- 新增 Pool TVL 篩選 — 定期從 Byreal API 抓取所有 Pool 的 TVL，快取至記憶體；`copyOpenPosition` 與 `copyIncreaseLiquidity` 在執行前檢查池中代幣的 TVL，低於 `MIN_POOL_TVL` 則跳過
- TVL 快取持久化 — 每次成功抓取後寫入 `data/tvl-cache.json`；重啟時若快取仍在刷新間隔內則直接載入，免去啟動時的 API 請求
- 新增 `MIN_POOL_TVL` 環境變數（USD，預設 0 = 停用）
- 新增 `POOL_TVL_WHITELIST` 環境變數（逗號分隔代幣地址，白名單內代幣免 TVL 檢查）
- 新增 `POOL_TVL_REFRESH_MINUTES` 環境變數（刷新間隔分鐘，預設 60，最小 15）
- Dashboard 設定頁新增「TVL 篩選」子頁 — TVL 門檻、刷新間隔、白名單 Pill 介面，儲存後即時生效並寫回 `.env`

## v1.15.5 (2026-02-26)
- 移除鎖倉審計功能 — 前端按鈕、後端 `POST /api/actions/audit-locked-sol`、`GET /api/debug/locked-sol` 端點、`auditLockedSol()` 方法全部清除
- 倉位映射手機版可摺疊 — 預設收起，點擊標題展開/收合；桌面版維持展開不可摺疊
- 倉位映射排版重構 — 對帳/重新整理按鈕對齊右上角，搜尋框獨立滿版

## v1.15.4 (2026-02-26)
- 修正 free connection 連線問題

## v1.15.3 (2026-02-26)
- 重構 SDK 交易送出方式 — 所有操作（平倉、減倉、加倉、收費、孤兒清倉）改用 `xxxInstructions` 取得指令後自行呼叫 `sendTransaction`，確保 `SKIP_PREFLIGHT` 設定正確套用
- 受影響函式：`manualClosePosition`、`copyCollectFees`、`copyDecreaseLiquidity`、`copyIncreaseLiquidity`、`copyClosePosition`、`reconcileOrphans`、`closeOrphanPosition`
- 修復 `makeTransaction` options 誤帶 `skipPreflight` 欄位（非合法 `IMakeTransactionOptions` 欄位）

## v1.15.2 (2026-02-26)
- 修復 SOL 池自動封鎖失效 — 首次遇到新 pool 時 `poolIdToMints` cache miss 導致黑名單/冷靜期檢查被跳過
- Parser 從 TX instruction accountKeys 直接解析 mintA/mintB（零額外 RPC），支援 Token22（accounts[18]/[19]）及 V2（accounts[20]/[21]）指令格式

## v1.15.1 (2026-02-26)
- 新增 `SKIP_PREFLIGHT` 環境變數 — 設為 `true` 可讓所有交易跳過 preflight 模擬（預設 `false`），適用於 RPC preflight 誤報導致交易被拒的情況
- 套用範圍：`byreal-position.ts` 的 `sendTransaction` 及 `jupiter-swap.ts` 的重試送出

## v1.15.0 (2026-02-26)
- Dashboard 資產趨勢頁新增「LP 倉位資產明細」區塊 — 顯示所有 Byreal LP 倉位中各 Token 的總持有量及 USD 估值（含手動開倉，不受 position map 限制）
- 使用 `getRawPositionInfoListByUserAddress` 直接從鏈上抓取本錢包所有倉位（含手動開啟），再逐一呼叫 `getPositionInfoByNftMint` 取得 Token 金額並加總
- 結果依 USD 估值降序排列，底部顯示合計欄
- 支援 `?refresh=1` 強制繞過 600 秒快取，「重新整理」按鈕預設使用此模式
- 時區顯示改為依瀏覽器本地時區（預設 GMT+8），走勢圖時間軸一同修正

## v1.14.2 (2026-02-26)
- 新增 `SKIP_SAME_TICK_RANGE` 設定 — 同一目標錢包在相同池子 + 相同 tick 範圍已有開倉時自動跳過，防止目標以不同 referer 開兩個完全相同倉位時重複跟單
- position-map 新增儲存 tickLower/tickUpper 欄位，供重複偵測使用
- 跳過時在事件日誌記錄 SKIP（錯誤欄顯示「重複 tick 範圍」），不記為失敗的 OPEN
- Dashboard 設定頁新增「跳過相同 tick 範圍重複開倉」開關，儲存後寫回 .env

## v1.14.1 (2026-02-26)
- 資產走勢快照防交易干擾 — 交易執行中跳過快照，最後一筆交易完成後等 30 秒再拍，避免 API 不同步造成假波動
- Discord 通知預設寫入 config — 客戶不需手動加 .env 即可使用

## v1.14.0 (2026-02-26)
- 新增 OperationQueue 優先佇列 — 取代舊 busy lock + queue 陣列，HIGH/NORMAL 優先級，Dashboard 操作使用 executeNow 同步回應
- 新增動態鎖倉 rent 提取 — 從 TX innerInstructions 解析實際 createAccount + transfer lamports，不再用固定查詢值
- 新增 Discord 通知模組 — SOL 不足、開倉失敗、平倉失敗、Swap 失敗、回撤暫停、崩潰通知，10 秒去重合併，POST 至中央 Cloudflare Worker
- 新增 SOL 池自動封鎖 — 任何包含 SOL (WSOL) 的池子自動禁止開倉
- 新增鎖倉審計功能 — Dashboard 按鈕 + WebSocket 即時進度，查詢每個倉位的 on-chain 實際鎖倉量
- 新增 /api/health 端點（無 auth）
- 新增 enqueueReconcile — 對帳掃描不佔佇列，每個 orphan 個別 enqueue 為 NORMAL

## v1.13.0 (2026-02-25)
- 新增個別錢包金額倍率 — TARGET_WALLETS 支援 `地址:倍率` 語法（例如 `WalletA:0.5,WalletB,WalletC:1.5`），未附加者使用全域 AMOUNT_RATIO
- Dashboard 設定頁新增「個別錢包倍率」欄位 — 每個目標錢包可獨立設定倍率，即時預覽，儲存後寫回 .env
- 倍率設定即時生效（不需重啟），透過 PATCH /api/config 更新

## v1.12.0 (2026-02-25)
- 支援 Jupiter Ultra 全路由 swap 偵測 — 移除 JUP6 program ID 硬編碼，改用 token balance 變化模式偵測（一增一減 = swap）
- 新增支援 Iris、JupiterZ (RFQ)、DFlow、OKX DEX Router 四個 Ultra router
- 修復 SOL 餘額檢查 bug — 從寫死 index[0] 改為正確查找 target wallet 在 accountKeys 中的 index
- 新增安全過濾：WSOL wrap/unwrap 排除、NFT (decimals=0 且 amount≤1) 排除
- 新增失敗 TX 防禦檢查（tx.meta.err）
- 支援 DASHBOARD_IP 設定 — 可自訂 Dashboard 監聽 IP（預設 127.0.0.1，一般用戶無需修改，供開發人員使用）
- Dashboard 資產走勢圖表美化 — TradingView 風格：curved 曲線、spotlight crosshair、淡化 grid、隱藏軸線邊框、scaleMargins 留白
- 資產走勢 overlay — 圖表內左上角顯示總金額 + 1H/4H/1D/7D/30D heatmap 色塊（毛玻璃背景）

## v1.11.2 (2026-02-24)
- 修正資產走勢獎勵計算 — 改用 epoch-bonus API（type=1 + type=2 待發放）取代 providerOverview 累計未領取，避免領取後重複計算

## v1.11.1 (2026-02-24)
- 簡化 auto-claim 排程 — 移除 setInterval 輪詢 + retry 迴圈，改用 setTimeout 精確排程至下次週二 16:30

## v1.11.0 (2026-02-24)
- 新功能：自動領取複製獎勵（Type=2 Copy Bonus）— 每週二 16:30 台灣時間 setTimeout 精確觸發
- 支援多批次領取（因 TX size 限制，迴圈 encode→sign→order 直到 items 為空）
- API 節流 8 秒間隔，避免 WAF 封鎖
- 領取歷史持久化至 data/claim-history.json（保留最近 52 週）
- Dashboard 設定頁新增 Auto-Claim 開關 + 上次領取資訊 + 手動「立即領取」按鈕
- 新增 API: POST /api/actions/claim-now（手動觸發）、GET /api/claim-history
- 新增 .env 設定: AUTO_CLAIM_ENABLED

## v1.10.0 (2026-02-24)
- 新增代幣黑名單 — 黑名單代幣自動跳過開倉與加倉（OPEN + INCREASE），關倉和賣幣不受影響
- 新增代幣白名單 — 白名單代幣免受冷靜期封禁（虧損次數仍計算，但不觸發冷靜期）
- Dashboard 設定頁新增下拉選單 — 從最近虧損代幣中選擇（顯示圖片 + 名稱 + PNL）
- 支援手動輸入 Mint 地址加入黑/白名單
- 黑白名單互斥保護 — 加入一邊自動從另一邊移除
- PNL 持久化 — 每次關倉後記錄代幣 PNL 至 data/token-pnl.json（重啟不遺失）
- 新增 API: GET /api/token-pnl（代幣 PNL 資料含圖片名稱）
- 事件紀錄新增「黑名單」篩選按鈕
- 新增 .env 設定: TOKEN_BLACKLIST, TOKEN_WHITELIST

## v1.9.11 (2026-02-24)
- 關倉鏈上失敗自動重試 — TX confirmed 但 on-chain error 時重新送出（最多 3 次，原本只重試 simulation 失敗）

## v1.9.10 (2026-02-24)
- 修復設定頁「立即更新」按鈕無反應（改為直接觸發，移除 native confirm）
- 更新完成後自動重新整理頁面（偵測 bot 重啟 → 2 秒後 reload 載入新前端）
- 修復更新完成訊息 JS 語法錯誤導致整頁白屏

## v1.9.9 (2026-02-24)
- 冷靜期即時顯示 — WS 偵測冷靜/暫停事件後自動刷新狀態（不需 F5）
- 冷靜期代幣改用名稱顯示（取代截斷 mint 地址）
- 儲存設定改用懸浮確認窗（取代 alert/confirm）
- 重啟 Bot 改用懸浮確認窗 + 自動重新整理

## v1.9.8 (2026-02-23)
- 修復更新按鈕無反應 — `switchTab('settings')` 函式不存在導致 ReferenceError
- 新增懸浮更新進度條 — 右下角 fixed 面板，不管在哪個 tab 都能看到更新進度
- 移除設定頁內嵌進度條（改用懸浮面板）

## v1.9.7 (2026-02-23)
- 走勢圖支援往前拖曳查看歷史資料（返回整層所有資料，visible range 控制初始視窗）
- 修復走勢圖左邊緣藍色垂直線（CSS ::after 遮罩）

## v1.9.6 (2026-02-23)
- 自動更新通知 — 登入後 + 每 30 分鐘背景檢查，有新版本顯示頂部橫幅
- 點橫幅彈出懸浮窗確認更新（含 changelog + 警告）
- 按 × 關閉後該版本 24 小時內不再提醒，新版本號則立即通知

## v1.9.5 (2026-02-23)
- 交換歷史新增 USDC 金額欄位 — swap 後解析 TX 取得實際 USDC 收到金額

## v1.9.4 (2026-02-23)
- 所有操作加入失敗自動重試 — INCREASE / DECREASE / CLOSE / COLLECT_FEE / 手動關倉均支援（最多 2 次，排除 SOL 不足）
- 地址/TX 改為 `<a>` 連結 — 支援滑鼠中鍵開新分頁
- 倉位映射搜尋支援 NFT 地址（目標 NFT + 我們的 NFT）

## v1.9.3 (2026-02-23)
- 檢查更新自動安裝 Git + 初始化 repo — 客戶 VPS 不需手動設定
- 修復檢查更新顯示 `vundefined` — 錯誤回傳時帶上當前版本

## v1.9.2 (2026-02-23)
- 跌幅暫停改為連續兩次快照確認 — 避免 API 偶發偏差誤觸發（首次超門檻僅警告，連續確認才暫停）
- 表格地址自適應顯示 — 桌面版 CSS 截斷（clamp 寬度），手機版 4...4 縮寫
- 事件類型 badge 垂直置中、卡片副標不換行、表格 padding 收緊

## v1.9.1 (2026-02-23)
- Dashboard UI 全面整合 — preview.html CSS 完整移植至正式版（字體、動畫、陰影、focus 光暈、filter-bar、觸控目標、scroll-snap）

## v1.9.0 (2026-02-23)
- 交換歷史新增數量欄位 — 記錄每筆 swap 的輸入數量（後端 + 前端完整鏈路）
- Dashboard Header 改版 — 錢包地址改為 Solscan / Byreal 兩個快捷按鈕，header 兩行佈局
- 目標錢包手機版佈局重構 — 地址獨佔一行，tag+統計+按鈕第二行（解決截斷不一致問題）
- 日誌字體手機自適應 — `clamp(9px, 2.2vw, 12px)` 取代固定 11px
- 設定頁 input/textarea 字體自適應 — 手機上錢包地址不再換行
- Dashboard UI 全面升級 — IBM Plex Sans + JetBrains Mono 字體、卡片動畫與陰影、focus 光暈、事件篩選器改為獨立 filter-bar、登入頁背景紋理、44px 觸控目標、scroll-snap tabs

## v1.8.4 (2026-02-23)
- 開倉失敗自動重試 — simulation failed / insufficient funds 時等 2 秒重讀餘額後重試 1 次（SOL 不足不重試）

## v1.8.3 (2026-02-23)
- 修復批量兌換只發送第一個代幣 — force-swap 改為 await 等待完成再回應（避免鎖衝突）

## v1.8.2 (2026-02-23)
- 錢包代幣餘額按 USDC 估值排序（金額小到大）

## v1.8.1 (2026-02-23)
- 修復批量兌換 404 錯誤 — API 路由修正為 `/api/actions/force-swap`
- 批量兌換新增確認視窗（點「確定兌換」才執行，取代直接發送）
- `.gitignore` 加入 `.claude/`

## v1.8.0 (2026-02-23)
- 新功能：Jupiter Swap 模式切換 — 設定頁可選 Ultra（Jupiter 代送，較高落地率）或 Metis（自送交易）
- 重構：所有 Jupiter swap 統一使用 `jupSwapExactIn()` helper（消除 3 處重複 inline swap 代碼）
- 新增 `JUP_SWAP_MODE` 環境變數（預設 ultra）

## v1.7.2 (2026-02-23)
- 修復 VPS 自動更新 tsc 編譯失敗 — 將 @types/bn.js、typescript 等移至 dependencies

## v1.7.1 (2026-02-23)
- 錢包代幣餘額顯示 USDC 估值（Jupiter Price API v3）
- 代幣餘額勾選 + 一鍵批量兌換按鈕

## v1.7.0 (2026-02-23)
- 新功能：風險管理 — 資產跌幅暫停（總資產 -N% 自動停止開倉，需手動重啟）
- 新功能：單代幣連續虧損冷靜期（連續虧損 N 次後冷卻該代幣，其他代幣不受影響）
- 風控設定可在 Dashboard 設定頁自訂（跌幅門檻 %、連虧次數、冷靜期分鐘）
- 事件日誌 SKIP 子類型分開顯示（DRAWDOWN / COOLDOWN / SOL不足 / CLOSE-ONLY 等）
- 事件日誌新增結果篩選按鈕（成功 / 失敗 / 跌幅暫停 / 冷靜期）
- 系統更新新增視覺進度條 + 步驟指示器
- 關倉/交換改用懸浮視窗（取代 alert/confirm）
- CLOSE 後查詢 Byreal API PnL（含手續費 + Copy 獎勵）驅動冷靜期判斷

## v1.6.0 (2026-02-23)
- 新功能：Dashboard 一鍵更新 — 設定頁「系統更新」區塊，檢查 + 下載 + 編譯 + 重啟
- 新增 `install.sh` — 客戶 VPS 一鍵安裝（含 Git 設定、npm install、tsc）
- 建立 GitHub Private Repo，支援 PAT 認證拉取更新
- 新增 `.gitignore`

## v1.5.9 (2026-02-23)
- 倉位映射改為事件驅動刷新 — WS 收到 OPEN/CLOSE 日誌後 3 秒自動刷新（取代固定 30 秒輪詢）
- 資產走勢圖時間軸改 UTC+8（台灣時間）

## v1.5.7 (2026-02-23)
- 修復 `ALLOW_SAME_WALLET_REOPEN` 旁路 — `copyOpenPosition()` 內冗餘 referer 去重忽略了 toggle，改用統一的 `isRefererDuplicate()` 判斷

## v1.5.6 (2026-02-23)
- 資產趨勢圖改用 TradingView Lightweight Charts（CDN v4.1.7）— 取代手寫 Canvas
- 支援縮放、拖曳、Crosshair tooltip、ALL 時間範圍
- 三層降採樣：raw（5分鐘/48小時）→ hourly（1小時/30天）→ daily（永久）
- 移除 debug console.log
- Mobile 還原 table-wrap 排版（桌面版保持獨立方格滾動）

## v1.5.5 (2026-02-23)
- CLOSE 滑點自動重試 — `PriceSlippageCheck`（0x1785）加入 `isTransientError()`，最多重試 3 次
- 倉位映射排序改為日期最新在上
- Dashboard 登入閃爍修復（`html.authed` CSS class + fire-and-forget loadAll）
- `renderTargets` 改 `Promise.all` 並行呼叫

## v1.5.0 (2026-02-22)
- 新功能：資產總額走勢圖（Dashboard 新增「資產趨勢」tab）
- 每 5 分鐘自動記錄資產快照（Token 持倉 + LP 倉位 + 未領費用 + 獎勵 + 鎖倉 SOL）
- 時間範圍切換：1H / 4H / 1D / 7D / 30D
- 純 Canvas 折線圖（零外部依賴）+ 滑鼠懸停明細工具提示
- 資料來源：Jupiter Holdings API + Price v3 + Byreal providerOverview
- 最多保留 4320 筆（30 天），持久化至 `data/asset-trend.json`
- 新增 `JUP_API_KEY` 環境變數

## v1.4.19 (2026-02-22)
- 待交換日誌顯示代幣名稱（取代截斷的 mint 地址）

## v1.4.18 (2026-02-22)
- 連線紀錄新增清空按鈕（靠右對齊）
- 連線紀錄限制顯示最近 20 筆

## v1.4.17 (2026-02-22)
- 倉位「查看」按鈕改連結至 Byreal Portfolio（含 tokenAddress + positionAddress）
- SOL 餘額改為快取機制，僅在開倉時刷新（不再每次 API 輪詢）

## v1.4.16 (2026-02-22)
- 倉位映射新增搜尋功能（可搜尋 token、來源錢包）
- 搜尋結果顯示匹配數/總數 badge

## v1.4.15 (2026-02-22)
- 新增「允許同錢包重複開倉」設定 toggle
- 同一目標錢包再次開同 referer 倉位時不被 skip（跨錢包仍去重）
- Referer 資料結構新增 targetWallet 欄位（向後相容）

## v1.4.14 (2026-02-22)
- 修復手機版字體歪斜問題（CJK 字元不再套用 monospace）
- 使用 CSS clamp() 自適應字體大小
- Header 右側元素 flex-wrap 適配小螢幕

## v1.4.13 (2026-02-22)
- SOL 不足自動暫停開倉/加倉（偵測 insufficient lamports 錯誤）
- Dashboard 顯示 SOL 暫停狀態、餘額、預估可開倉數
- 需手動重啟 bot 恢復正常模式

## v1.4.12 (2026-02-22)
- Event log 顯示 token pair（OPEN/CLOSE/SWAP）
- event-log.json 新增 poolMap 結構
- Dashboard UTC↔UTC+8 時間切換
- robots.txt 防搜尋引擎索引

## v1.4.11 (2026-02-21)
- 跟隨目標收取手續費（chain.collectFees）
- Dashboard 顯示鎖定 SOL（CoinGecko 價格）
- 新增登入日誌（data/auth-log.json）
- Dashboard 標題安全化處理

## v1.4.10 (2026-02-21)
- Pending swap 每 10 分鐘同步實際餘額（更新數量而非僅清除）
- 還原自動重試 swap 功能

## v1.4.9 (2026-02-21)
- 修復 pending swap 在外部兌換後未清除的問題
- 每 10 分鐘檢查實際錢包餘額

## v1.4.8 (2026-02-20)
- 移除 Dashboard Referer 區塊

## v1.4.7 (2026-02-20)
- Config UX：close-only 錢包自動合併至目標列表
- 倉位映射新增「來源」欄位
- [CLOSE-ONLY] 標籤修復
- 部署排除 .env

## v1.4.6 (2026-02-20)
- 安全強化：登入鎖定 10min→1hr
- 移除登入頁 bot 名稱

## v1.4.5 (2026-02-20)
- 排除 Token2022 USDT 於 swapTokenToUSDC()

## v1.4.4 (2026-02-20)
- 修復 Dashboard header Byreal portfolio 連結

## v1.4.3 (2026-02-20)
- 啟動時僅在 token 缺少 logoURI 時才呼叫 API
- 排除 Token2022 USDT
- Logs tab 自動捲動
- 手機版排版修復

## v1.4.2 (2026-02-19)
- Token icons 修復 — 改用 Byreal API logoURI（CoinGecko CDN）
- Token 資訊快取至 data/token-names.json

## v1.4.1 (2026-02-19)
- Token icons（Jupiter CDN — 已失效）

## v1.4.0 (2026-02-19)
- Dashboard 大改版：磁碟持久化、SKIP vs FAIL 分類、錢包餘額、swap 歷史、分頁
