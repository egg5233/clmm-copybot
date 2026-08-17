#!/bin/bash
# Start signer service.
# - Systemd mode: starts and waits for password via dashboard unlock page
# - Terminal mode: also accepts password on stdin
set -e

cd "$(dirname "$0")"

# Load NVM (needed for systemd which doesn't source .bashrc)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ ! -f "keyfile.enc.json" ]; then
  echo "ERROR: keyfile.enc.json not found. Run: bash update-wallet.sh" >&2
  exit 1
fi

exec npx ts-node index.ts
