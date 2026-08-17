#!/bin/bash
# Byreal Copy Bot — 一鍵安裝腳本（超懶人版）
# 用法：bash install.sh
# 假設：全新的 Ubuntu/Debian VPS，已 SSH 登入為 root

set -e

# ── 顏色 ─────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}[i]${NC} $*"; }
ok()    { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
step()  { echo; echo -e "${BOLD}${BLUE}━━━ $* ━━━${NC}"; }

# ── 前置檢查 ─────────────────────────────────────────
step "檢查環境"

if [ "$EUID" -ne 0 ]; then
  fail "請用 root 執行：sudo bash install.sh"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  fail "此腳本只支援 Ubuntu / Debian"
fi

ok "系統：$(lsb_release -ds 2>/dev/null || echo Ubuntu/Debian)"

# ── 安裝相依套件 ─────────────────────────────────────
step "[1/7] 安裝必要工具"

apt-get update -qq
apt-get install -y -qq curl git build-essential dos2unix >/dev/null
ok "git / curl / build-essential / dos2unix 已裝"

# Node.js 20
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  info "安裝 Node.js 20 ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node.js $(node -v)"
ok "npm $(npm -v)"

# ── 下載 bot 原始碼 ───────────────────────────────────
step "[2/7] 下載 Byreal Copy Bot"

BOT_DIR="/root/byreal-copy-bot"
REPO_URL="https://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@github.com/zxcnny930/byreal-copy-bot.git"

if [ -d "$BOT_DIR/.git" ]; then
  info "bot 已存在於 $BOT_DIR — 更新到最新"
  cd "$BOT_DIR"
  git config --global --add safe.directory "$BOT_DIR"
  git fetch origin main --quiet
  git reset --hard origin/main --quiet
else
  info "clone 到 $BOT_DIR ..."
  git clone --quiet "$REPO_URL" "$BOT_DIR"
  cd "$BOT_DIR"
  git config --global --add safe.directory "$BOT_DIR"
fi
ok "原始碼下載完成（版本 v$(node -p "require('./package.json').version")）"

# ── 修 Windows 行尾（CRLF → LF） ───────────────────
info "修正 shell script 行尾（防 Windows 上傳造成 CRLF 問題）..."
find . -name "*.sh" -type f -not -path "./node_modules/*" -exec dos2unix -q {} \; 2>/dev/null || true
ok "行尾修正完成"

# ── 安裝 npm 套件 ────────────────────────────────────
step "[3/7] 安裝 npm 套件（約需 2-5 分鐘）"

info "安裝 bot 套件 ..."
npm install --silent --no-fund --no-audit
ok "bot 套件裝好"

info "安裝 signer 套件 ..."
cd signer
npm install --silent --no-fund --no-audit
cd ..
ok "signer 套件裝好"

# ── 編譯 TypeScript ──────────────────────────────────
step "[4/7] 編譯原始碼"

npx tsc
ok "bot 編譯完成"

# ── 產生 .env 骨架（細節之後在 Dashboard 設定） ──────
step "[5/7] 建立基本設定檔"

if [ ! -f .env ]; then
  cat > .env <<'EOF'
# Byreal Copy Bot — 基本設定
# 細節請於 Dashboard 設定頁填寫後儲存

# ── Wallet（signer 模式，私鑰由 signer 保管） ──
WALLET_PUBLIC_KEY=
SIGNER_SOCKET_PATH=/tmp/byreal-signer.sock

# ── RPC（請在 Dashboard 填入） ──
RPC_URL=
WS_URL=
ALCHEMY_RPC_URL=

# ── 跟單設定 ──
TARGET_WALLETS=
AMOUNT_RATIO=1.0
SLIPPAGE_BPS=200
MAX_RETRY=3
PRIORITY_FEE_LAMPORTS=100000
DRY_RUN=false

# ── Jupiter ──
JUP_API_KEY=
JUP_SWAP_MODE=ultra

# ── Dashboard ──
DASHBOARD_PORT=3847
DASHBOARD_PASSWORD=

# ── 其他可選 ──
AUTO_CLAIM_ENABLED=true
EOF
  ok ".env 骨架建立完成（位於 $BOT_DIR/.env）"
else
  warn ".env 已存在，保留不動"
fi

if [ ! -f signer/.env ]; then
  cat > signer/.env <<'EOF'
# Signer 服務設定
# RPC URL 用於模擬交易（policy 檢查用）— 請在 Dashboard 填
SIGNER_RPC_URL=
SIGNER_SOCKET_PATH=/tmp/byreal-signer.sock
SIGNER_UNLOCK_PORT=3848
SIGNER_LOG_LEVEL=info
EOF
  ok "signer/.env 骨架建立完成"
else
  warn "signer/.env 已存在，保留不動"
fi

# ── 加密私鑰 ─────────────────────────────────────────
step "[6/7] 加密錢包私鑰"

if [ -f signer/keyfile.enc.json ]; then
  warn "keyfile.enc.json 已存在，跳過加密步驟"
  warn "若需重設請手動執行：cd $BOT_DIR/signer && npx ts-node setup.ts"
else
  echo
  echo -e "${BOLD}接下來需要你的錢包私鑰（base58 格式，通常是 88 字元）${NC}"
  echo -e "${YELLOW}注意：私鑰會被加密儲存在本機，不會傳給任何人${NC}"
  echo -e "${YELLOW}你也需要設定一個「解鎖密碼」，每次 bot 重啟都會問你這個密碼${NC}"
  echo
  cd signer
  npx ts-node setup.ts
  cd ..
  if [ -f signer/keyfile.enc.json ]; then
    ok "私鑰加密成功，寫入 signer/keyfile.enc.json"
  else
    fail "私鑰加密失敗，請重新執行：cd $BOT_DIR/signer && npx ts-node setup.ts"
  fi
fi

# ── 取得 WALLET_PUBLIC_KEY 寫入 .env ─────────────────
if ! grep -q '^WALLET_PUBLIC_KEY=[1-9A-HJ-NP-Za-km-z]' .env 2>/dev/null; then
  PUBKEY=$(cd signer && node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync('keyfile.enc.json')); console.log(d.publicKey || '');" 2>/dev/null)
  if [ -n "$PUBKEY" ] && [ "$PUBKEY" != "undefined" ]; then
    sed -i "s|^WALLET_PUBLIC_KEY=.*|WALLET_PUBLIC_KEY=$PUBKEY|" .env
    ok "錢包公鑰已寫入 .env：$PUBKEY"
  fi
fi

# ── 建立 systemd 服務 ────────────────────────────────
step "[7/7] 建立開機自動啟動服務"

cat > /etc/systemd/system/byreal-signer.service <<EOF
[Unit]
Description=Byreal Signer Service
After=network.target
Before=copybot.service

[Service]
Type=simple
User=root
WorkingDirectory=$BOT_DIR/signer
ExecStart=/bin/bash $BOT_DIR/signer/start-signer.sh
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/copybot.service <<EOF
[Unit]
Description=Byreal Copy Bot
After=network.target byreal-signer.service

[Service]
Type=simple
User=root
WorkingDirectory=$BOT_DIR
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable byreal-signer copybot >/dev/null 2>&1
ok "systemd 服務建立完成（開機自動啟動）"

# ── 啟動 signer ──────────────────────────────────────
systemctl start byreal-signer
sleep 3
if systemctl is-active --quiet byreal-signer; then
  ok "signer 服務已啟動（等待解鎖中）"
else
  warn "signer 啟動異常，請查看：journalctl -u byreal-signer -n 30"
fi

# ── 完成訊息 ─────────────────────────────────────────
echo
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  ✓ 安裝完成！${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo -e "${BOLD}接下來 3 步：${NC}"
echo
echo -e "${BOLD}1. 解鎖 signer${NC}"
echo -e "   在 VPS 上跑這行指令（會吐出一個網址）："
echo -e "   ${BLUE}curl -s http://127.0.0.1:3848 | head -1${NC}"
echo -e "   或直接用 SSH port-forward 到本地瀏覽器："
echo -e "   ${BLUE}ssh -L 3848:127.0.0.1:3848 root@<VPS_IP>${NC}"
echo -e "   然後瀏覽器開 http://localhost:3848 → 輸入剛才設的解鎖密碼"
echo
echo -e "${BOLD}2. 啟動 bot${NC}"
echo -e "   ${BLUE}systemctl start copybot${NC}"
echo
echo -e "${BOLD}3. 打開 Dashboard 完成設定${NC}"
echo -e "   Dashboard 預設跑在 port 3847（127.0.0.1 only，需要 tunnel）"
echo -e "   簡易方式：SSH port-forward"
echo -e "   ${BLUE}ssh -L 3847:127.0.0.1:3847 root@<VPS_IP>${NC}"
echo -e "   瀏覽器開 http://localhost:3847 → Settings 填 RPC / 跟單錢包 / Dashboard 密碼"
echo
echo -e "${YELLOW}常用指令${NC}"
echo -e "   systemctl status copybot        # 看 bot 狀態"
echo -e "   journalctl -u copybot -f        # 看 bot 即時 log"
echo -e "   journalctl -u byreal-signer -f  # 看 signer 即時 log"
echo -e "   systemctl restart copybot       # 重啟 bot"
echo
echo -e "${GREEN}錢包公鑰：$(grep '^WALLET_PUBLIC_KEY=' .env | cut -d= -f2)${NC}"
echo -e "${GREEN}安裝路徑：$BOT_DIR${NC}"
echo
