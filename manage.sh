#!/bin/bash
# Byreal Copy Bot Manager — runs inside WSL
source ~/.nvm/nvm.sh 2>/dev/null

BOT_DIR="$HOME/byreal-copy-bot"
PID_FILE="/tmp/copybot.pid"
LOG_DIR="$BOT_DIR/data/logs"
LOG_FILE="$LOG_DIR/copybot-$(date +%Y-%m-%d).log"

# Rotate logs: delete files older than 7 days
rotate_logs() {
  mkdir -p "$LOG_DIR"
  find "$LOG_DIR" -name 'copybot-*.log' -mtime +7 -delete 2>/dev/null
}

get_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

do_start() {
  rotate_logs
  local existing
  existing=$(get_pid)
  if [ -n "$existing" ]; then
    echo "[WARN] Bot already running (PID: $existing). Stopping first..."
    do_stop
    sleep 1
  fi

  cd "$BOT_DIR" || { echo "[FAIL] Dir not found: $BOT_DIR"; exit 1; }
  rm -f data/bot.lock

  # setsid creates new session so process survives parent bash exit
  setsid bash -c "
    source ~/.nvm/nvm.sh 2>/dev/null
    cd $BOT_DIR
    exec npx ts-node src/index.ts
  " >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  disown "$pid" 2>/dev/null

  # Wait for startup
  sleep 3

  if kill -0 "$pid" 2>/dev/null; then
    echo "[OK] Bot started (PID: $pid)"
    echo "---"
    head -15 "$LOG_FILE" 2>/dev/null
  else
    echo "[FAIL] Bot crashed on startup:"
    echo "---"
    cat "$LOG_FILE" 2>/dev/null
    rm -f "$PID_FILE"
    exit 1
  fi
}

do_stop() {
  local pid
  pid=$(get_pid)
  if [ -n "$pid" ]; then
    # Kill process group (setsid created new group)
    kill -- -"$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
    sleep 1
    kill -9 "$pid" 2>/dev/null
  fi
  pkill -f 'ts-node.*src/index.ts' 2>/dev/null
  pkill -f 'node.*byreal-copy-bot' 2>/dev/null
  rm -f "$PID_FILE" "$BOT_DIR/data/bot.lock"
  # Backup data files with timestamp
  local bak_dir="$BOT_DIR/data/backup"
  mkdir -p "$bak_dir"
  local ts=$(date +%Y%m%d_%H%M%S)
  for f in "$BOT_DIR/data"/*.json; do
    [ -f "$f" ] && cp "$f" "$bak_dir/$(basename "$f").$ts.bak"
  done
  # Keep only last 10 backups per file
  for prefix in position-map pending-swaps; do
    ls -t "$bak_dir/$prefix".json.*.bak 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null
  done
  echo "[OK] Data backed up to $bak_dir"
  echo "[OK] Stopped"
}

do_logs() {
  local latest
  latest=$(ls -t "$LOG_DIR"/copybot-*.log 2>/dev/null | head -1)
  if [ -n "$latest" ] && [ -f "$latest" ]; then
    tail -f "$latest"
  else
    echo "No log files in $LOG_DIR"
  fi
}

do_status() {
  local pid
  pid=$(get_pid)
  if [ -n "$pid" ]; then
    echo "[RUNNING] PID: $pid"
    local latest
    latest=$(ls -t "$LOG_DIR"/copybot-*.log 2>/dev/null | head -1)
    [ -n "$latest" ] && tail -3 "$latest" 2>/dev/null
  else
    echo "[STOPPED]"
  fi
}

# ── Signer Service ────────────────────────────────────────────────────────

do_signer_start() {
  if systemctl is-active --quiet byreal-signer 2>/dev/null; then
    echo "[WARN] Signer already running"
    do_signer_status
    return
  fi
  sudo systemctl start byreal-signer
  sleep 2
  if systemctl is-active --quiet byreal-signer 2>/dev/null; then
    echo "[OK] Signer started — unlock via dashboard"
  else
    echo "[FAIL] Signer failed to start:"
    sudo journalctl -u byreal-signer -n 10 --no-pager
  fi
}

do_signer_stop() {
  sudo systemctl stop byreal-signer
  echo "[OK] Signer stopped"
}

do_signer_logs() {
  sudo journalctl -u byreal-signer -f --no-pager
}

do_signer_status() {
  if systemctl is-active --quiet byreal-signer 2>/dev/null; then
    echo "[RUNNING]"
    sudo journalctl -u byreal-signer -n 5 --no-pager
  else
    echo "[STOPPED]"
  fi
}

case "$1" in
  start)         do_start ;;
  stop)          do_stop ;;
  logs)          do_logs ;;
  status)        do_status ;;
  signer-start)  do_signer_start ;;
  signer-stop)   do_signer_stop ;;
  signer-logs)   do_signer_logs ;;
  signer-status) do_signer_status ;;
  *)             echo "Usage: $0 {start|stop|logs|status|signer-start|signer-stop|signer-logs|signer-status}" ;;
esac
