#!/bin/bash
# check-fleet.sh — Quick status check for all IDEA Pi fleet nodes
#
# Usage: ./script/check-fleet.sh
#
# Reads fleet config from docs/PI_FLEET.md (name.local entries in /etc/hosts)
# and checks SSH reachability + Engine status on each.

set -uo pipefail

SSH_KEY="${HOME}/.ssh/id_ed25519"
SSH_USER="pi"
ENGINE_PATH="/home/pi/projects/engine"

# Read fleet nodes from /etc/hosts (lines added by provision-fleet.sh)
NODES=$(grep "idea0[0-9]\.local" /etc/hosts | awk '{print $2}' | sort -u)

if [[ -z "$NODES" ]]; then
  echo "No fleet nodes found in /etc/hosts. Run provision-fleet.sh first."
  exit 1
fi

echo ""
echo "=== IDEA Fleet Status Check ==="
printf "%-15s %-18s %-10s %-12s %s\n" "Node" "IP" "SSH" "Engine" "Version"
echo "──────────────────────────────────────────────────────────────"

for NODE in $NODES; do
  IP=$(grep "$NODE" /etc/hosts | awk '{print $1}')
  
  # Check SSH
  SSH_OK="✗"
  ENGINE_STATUS="unknown"
  VERSION="-"
  
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
       "${SSH_USER}@${NODE}" echo "" 2>/dev/null; then
    SSH_OK="✓"
    
    # Check pm2 engine status
    PM2_OUT=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
      "${SSH_USER}@${NODE}" "pm2 show engine 2>/dev/null | grep -E 'status|version' | head -2" 2>/dev/null || echo "")
    
    if echo "$PM2_OUT" | grep -qi "online"; then
      ENGINE_STATUS="online"
    elif echo "$PM2_OUT" | grep -qi "stopped"; then
      ENGINE_STATUS="stopped"
    elif echo "$PM2_OUT" | grep -qi "errored"; then
      ENGINE_STATUS="errored"
    else
      ENGINE_STATUS="not running"
    fi
    
    # Get engine version from package.json
    VERSION=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
      "${SSH_USER}@${NODE}" "cat ${ENGINE_PATH}/package.json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"version\"])' 2>/dev/null" || echo "-")
  fi

  printf "%-15s %-18s %-10s %-12s %s\n" "$NODE" "$IP" "$SSH_OK" "$ENGINE_STATUS" "$VERSION"
done

echo ""
