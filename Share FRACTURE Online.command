#!/bin/bash
set -e
cd "$(dirname "$0")"

# Locate Node.js
NODE_BIN=$(which node 2>/dev/null || true)
[ -x "$NODE_BIN" ] || NODE_BIN="/opt/homebrew/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="/usr/local/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "Error: Node.js not found. Install it with: brew install node"
  exit 1
fi

# Locate or auto-install cloudflared via Homebrew
CF_BIN=$(which cloudflared 2>/dev/null || true)
[ -x "$CF_BIN" ] || CF_BIN="/opt/homebrew/bin/cloudflared"
[ -x "$CF_BIN" ] || CF_BIN="/usr/local/bin/cloudflared"
if [ ! -x "$CF_BIN" ]; then
  BREW_BIN=$(which brew 2>/dev/null || echo "/opt/homebrew/bin/brew")
  if [ -x "$BREW_BIN" ]; then
    echo "Installing cloudflared (one-time setup)..."
    "$BREW_BIN" install cloudflared
    CF_BIN=$(which cloudflared 2>/dev/null || echo "/opt/homebrew/bin/cloudflared")
  else
    echo "Error: cloudflared not found. Install Homebrew and run: brew install cloudflared"
    exit 1
  fi
fi

# Cleanly stop server.js when Terminal closes or Ctrl+C is pressed
SERVER_PID=""
cleanup() {
  echo ""
  echo "Shutting down FRACTURE server..."
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting FRACTURE server on http://localhost:3000 ..."
"$NODE_BIN" server.js &
SERVER_PID=$!
sleep 1

open "http://localhost:3000"

echo ""
echo "Opening free Cloudflare Quick Tunnel (no account needed)..."
echo "Keep this window open while playing. Press Ctrl+C to stop."
echo ""

# Stream tunnel logs, detect the public trycloudflare.com URL, and copy it to clipboard
"$CF_BIN" tunnel --url http://localhost:3000 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ "$line" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]]; then
    URL="${BASH_REMATCH[1]}"
    printf "%s" "$URL" | pbcopy
    echo ""
    echo "============================================================"
    echo "  FRACTURE PUBLIC LINK (COPIED TO CLIPBOARD!):"
    echo "  $URL"
    echo "  Text or paste this link to a friend to duel live!"
    echo "============================================================"
    echo ""
  fi
done
