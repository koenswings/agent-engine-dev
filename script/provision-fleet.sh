#!/bin/bash
# provision-fleet.sh — Provision one or more IDEA Pi fleet nodes
#
# Usage:
#   PI_PASS=<password> ./script/provision-fleet.sh <name>=<ip>[,model=pi4|pi5] ...
#
# Examples:
#   PI_PASS=raspberry ./script/provision-fleet.sh idea01=192.168.1.101,model=pi5 idea02=192.168.1.102,model=pi4
#   PI_PASS=raspberry ./script/provision-fleet.sh idea03=192.168.1.103,model=pi5
#
# What it does (per node):
#   1. Pushes the agent SSH public key via sshpass (password auth)
#   2. Adds a /etc/hosts entry so <name>.local resolves to the IP
#   3. Adds an SSH config entry to use the right key
#   4. Runs build-engine in remote mode (full provisioning: Node, Docker, pm2, Engine)
#   5. Pi reboots when done; Engine starts automatically on boot
#
# Requirements:
#   - sshpass installed (already available in sandbox)
#   - rsync installed (already available in sandbox)
#   - pnpm build already run (dist/ exists)
#   - PI_PASS env var set to the Pi's SSH password

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
SSH_KEY="${HOME}/.ssh/id_ed25519"
SSH_PUB_KEY="${SSH_KEY}.pub"
SSH_USER="pi"

if [[ -z "${PI_PASS:-}" ]]; then
  echo "ERROR: PI_PASS environment variable not set."
  echo "Usage: PI_PASS=<password> $0 <name>=<ip>,model=<pi4|pi5> ..."
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "ERROR: No Pi specifications provided."
  echo "Usage: PI_PASS=<password> $0 idea01=192.168.1.101,model=pi5 idea02=192.168.1.102,model=pi4"
  exit 1
fi

if [[ ! -f "$SSH_PUB_KEY" ]]; then
  echo "ERROR: SSH public key not found at $SSH_PUB_KEY"
  exit 1
fi

if [[ ! -f "$REPO_ROOT/dist/script/build-engine.js" ]]; then
  echo "ERROR: dist/ not found. Run 'pnpm build' first."
  exit 1
fi

echo ""
echo "=== IDEA Fleet Provisioner ==="
echo "SSH key: $SSH_PUB_KEY"
echo "Nodes to provision: $*"
echo ""

# Parse each node spec
for spec in "$@"; do
  NAME="${spec%%=*}"           # idea01
  REST="${spec#*=}"            # 192.168.1.101,model=pi5
  IP="${REST%%,*}"             # 192.168.1.101
  MODEL="pi4"
  if echo "$REST" | grep -q "model=pi5"; then
    MODEL="pi5"
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Node: $NAME  IP: $IP  Model: $MODEL"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # ── Step 1: Push SSH key via sshpass ──────────────────────────────────
  echo "[1/4] Pushing SSH key to $IP via password auth..."
  SSHPASS="${PI_PASS}" sshpass -e ssh-copy-id \
    -i "${SSH_PUB_KEY}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    "${SSH_USER}@${IP}" 2>&1 | grep -v "^Warning" || true

  # Verify key auth works
  if ! ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
       "${SSH_USER}@${IP}" echo "key auth OK" 2>/dev/null; then
    echo "ERROR: Key auth failed for $IP. Check the password and try again."
    continue
  fi
  echo "  SSH key installed and verified."

  # ── Step 2: Add /etc/hosts entry so <name>.local resolves ─────────────
  echo "[2/4] Adding /etc/hosts entry: $IP -> $NAME.local"
  HOSTS_FILE="/etc/hosts"
  # Remove existing entry for this name if present
  grep -v "$NAME.local" "$HOSTS_FILE" > /tmp/hosts.new 2>/dev/null || cp "$HOSTS_FILE" /tmp/hosts.new
  echo "$IP $NAME.local" >> /tmp/hosts.new
  cp /tmp/hosts.new "$HOSTS_FILE"
  echo "  Added: $IP $NAME.local"

  # ── Step 3: Add SSH config entry ──────────────────────────────────────
  echo "[3/4] Configuring SSH client for $NAME.local..."
  SSH_CONFIG="${HOME}/.ssh/config"
  # Remove existing block for this host
  python3 - <<PYEOF
import re, os
path = "${SSH_CONFIG}"
content = open(path).read() if os.path.exists(path) else ""
# Remove existing Host block for this name
pattern = r'Host ${NAME}\.local\n(?:  [^\n]*\n)*'
content = re.sub(pattern, '', content)
open(path, 'w').write(content)
PYEOF
  cat >> "$SSH_CONFIG" << EOF

Host ${NAME}.local
  HostName ${IP}
  User ${SSH_USER}
  IdentityFile ${SSH_KEY}
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
EOF
  echo "  SSH config updated."

  # ── Step 4: Run build-engine in remote mode ───────────────────────────
  echo "[4/4] Running build-engine for $NAME (model: $MODEL)..."
  echo "      This will take 10-20 minutes. Pi reboots when done."
  echo ""

  # Build extra flags based on model
  EXTRA_FLAGS="--temperature"
  # --gadget: USB LAN gadget mode — Pi 4 only; Pi 5 has PCIe USB controller, not supported
  # --argon: Argon One fan script — not applicable for test fleet
  if [[ "$MODEL" == "pi4" ]]; then
    # gadget mode is available but not enabled by default for test fleet
    # add --gadget if you need USB LAN access (task I)
    :
  fi

  cd "$REPO_ROOT"
  # Use tsx-based wrapper (same as documented dev workflow)
  ./build-engine \
    --machine "${NAME}.local" \
    --user "$SSH_USER" \
    --hostname "$NAME" \
    --timezone "Europe/Brussels" \
    --keyboard "us" \
    $EXTRA_FLAGS \
    --prod \
    2>&1 | tee "/tmp/provision-${NAME}.log" || {
      echo "ERROR: build-engine failed for $NAME. Log: /tmp/provision-${NAME}.log"
      continue
    }

  echo ""
  echo "✓ $NAME provisioning complete. Pi will reboot and come up as $NAME.local"
  echo ""
done

echo "=== Provisioning complete ==="
echo ""
echo "After the Pis reboot (allow 2 minutes), verify with:"
echo "  ./script/check-fleet.sh"
