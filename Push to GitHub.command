#!/bin/bash
set -e
cd "$(dirname "$0")"

GH_BIN=$(which gh 2>/dev/null || echo "/opt/homebrew/bin/gh")
[ -x "$GH_BIN" ] || GH_BIN="/usr/local/bin/gh"

if git remote get-url origin >/dev/null 2>&1; then
  echo "Pushing latest FRACTURE updates to GitHub (Render will auto-deploy)..."
  git push origin main
else
  if ! "$GH_BIN" auth status >/dev/null 2>&1; then
    "$GH_BIN" auth login
  fi
  "$GH_BIN" repo create fracture-game --public --source=. --remote=origin --push
fi

echo ""
echo "Done! Render will auto-deploy your updated FRACTURE build in ~30 seconds."
echo ""
read -p "Press Enter to close..."
