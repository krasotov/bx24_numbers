#!/usr/bin/env bash
# Deploy КриптоПодпись from the canonical app path.
set -euo pipefail

SIGN_APP_DIR="${SIGN_APP_DIR:-/Users/sergejkrasotov/vibecode-app}"
SERVER_ID="${1:-f8e7dc9c-1ed8-47d5-876c-4566710acb25}"

if [[ ! -d "$SIGN_APP_DIR" ]]; then
  echo "ERROR: Sign app not found at $SIGN_APP_DIR" >&2
  exit 1
fi

cd "$SIGN_APP_DIR"
echo "Deploying sign app from $SIGN_APP_DIR to server $SERVER_ID ..."
npm run deploy:server -- "$SERVER_ID"
