#!/bin/bash
# deploy-fleet.sh — Sync engine dist/ to all fleet Pis and restart their engines
#
# Usage: ./script/deploy-fleet.sh
# Run from the engine repo root on wizardly-hugle after `pnpm build`.
#
# Fleet Pis run the engine from /home/pi/projects/engine/ (not a git repo).
# We rsync dist/ and pm2.config.cjs, then restart pm2.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FLEET=(
  "pi@192.168.0.138"   # idea01
  "pi@192.168.0.180"   # idea02
  "pi@192.168.0.228"   # idea03
)

REMOTE_ENGINE_PATH="/home/pi/projects/engine"

echo "=== IDEA Engine Fleet Deploy ==="
echo "Source: $REPO_ROOT/dist/"
echo "Targets: ${FLEET[*]}"
echo ""

for host in "${FLEET[@]}"; do
  echo "--- Deploying to $host ---"

  # Sync dist/
  rsync -az --delete \
    "$REPO_ROOT/dist/" \
    "$host:$REMOTE_ENGINE_PATH/dist/"

  # Sync pm2.config.cjs (may have changed)
  rsync -az \
    "$REPO_ROOT/pm2.config.cjs" \
    "$host:$REMOTE_ENGINE_PATH/pm2.config.cjs"

  # Restart engine
  ssh "$host" "pm2 restart engine && echo 'Engine restarted on $host'"

  echo "✓ $host done"
  echo ""
done

echo "=== Fleet deploy complete ==="
