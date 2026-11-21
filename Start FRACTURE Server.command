#!/bin/bash
cd "$(dirname "$0")"
NODE_BIN=$(which node 2>/dev/null || echo "/opt/homebrew/bin/node")
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="/usr/local/bin/node"
fi
echo "Starting FRACTURE Online Server..."
(sleep 1 && open "http://localhost:3000") &
"$NODE_BIN" server.js
