#!/usr/bin/env bash
# provision-fleet.sh — Provision IDEA fleet Pis over key-only SSH (idea#146)
#
# Usage:
#   ./script/provision-fleet.sh [options] <name>=<ip>[,model=pi4|pi5] ...
#
# Examples:
#   # Pi 5 reached through idea03 as a jump host, fleet Tailscale key from a local file
#   ./script/provision-fleet.sh --jump pi@100.126.117.80 --authkey-file ~/fleet-authkey.txt \
#       idea01=192.168.0.138,model=pi5
#   # Two Pis on the same LAN as this machine, Pi already holds the key
#   ./script/provision-fleet.sh idea04=192.168.0.113,model=pi4 idea05=192.168.0.120,model=pi5
#
# Options:
#   --jump <user@host>       SSH jump host (ProxyJump), e.g. pi@100.126.117.80
#   --user <name>            SSH user on the Pi (default: pi)
#   --authkey-file <path>    Tailscale fleet auth key on THIS machine. It is sent over
#                            stdin into /etc/tailscale/debug-authkey (0600 root) on the
#                            Pi, never as an argument. Omit it when the Pi already
#                            holds the key; the build stops if neither is true.
#   --engine-ref <ref>       agent-engine-dev branch/tag/commit to install (default: main)
#   --console-ref <ref>      agent-console-dev branch/tag/commit to install (default: main)
#   --timezone <tz>          (default: Europe/Brussels)
#   --keyboard <layout>      (default: us)
#   --argon                  install the Argon One fan script (default: off)
#   --gadget                 enable USB gadget mode; Pi 4 only, refused for pi5 (default: off)
#   --no-wait                do not wait for the reboot and the health check
#   -h, --help               show this help
#
# What it does (per node), all over key-based SSH (no password auth):
#   1. Checks key auth (BatchMode) and passwordless sudo on the Pi
#   2. Bootstraps the Pi: apt prerequisites, Node (n) and the pinned pnpm from
#      package.json "packageManager", the canonical checkout under
#      /home/pi/idea/agents/<repo> at the requested refs, Console build
#   3. Stores the Tailscale fleet key (if --authkey-file) over stdin
#   4. Runs build-engine in LOCAL mode on the Pi, with explicit on/off flags
#      (--no-argon/--no-gadget unless asked; --model passes the Pi model)
#   5. Waits for the reboot, then checks pm2 and the Console HTTP port
#
# It changes nothing on the machine running it: no /etc/hosts, no ~/.ssh/config.
# New host keys are accepted on first contact (accept-new); a changed key stops it.
#
# Requirements on this machine: bash, ssh with a key the Pi accepts. No repo build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

usage() { sed -n '2,/^# Requirements/p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "ERROR: $*" >&2; exit 2; }

# Single source of truth for the pnpm pin: package.json "packageManager" (idea#146)
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
[[ -n "$PNPM_VERSION" ]] || die "could not read the pnpm version from $REPO_ROOT/package.json (packageManager)"
NODE_VERSION="22.20.0"   # keep in sync with NODE_VERSION in src/data/Engine.ts

SSH_USER="pi"
JUMP=""
AUTHKEY_FILE=""
ENGINE_REF="main"
CONSOLE_REF="main"
TIMEZONE="Europe/Brussels"
KEYBOARD="us"
ARGON=0
GADGET=0
WAIT=1
NODES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --jump)          JUMP="${2:?--jump needs user@host}"; shift 2 ;;
    --user)          SSH_USER="${2:?--user needs a name}"; shift 2 ;;
    --authkey-file)  AUTHKEY_FILE="${2:?--authkey-file needs a path}"; shift 2 ;;
    --engine-ref)    ENGINE_REF="${2:?--engine-ref needs a ref}"; shift 2 ;;
    --console-ref)   CONSOLE_REF="${2:?--console-ref needs a ref}"; shift 2 ;;
    --timezone)      TIMEZONE="${2:?--timezone needs a value}"; shift 2 ;;
    --keyboard)      KEYBOARD="${2:?--keyboard needs a value}"; shift 2 ;;
    --argon)         ARGON=1; shift ;;
    --gadget)        GADGET=1; shift ;;
    --no-wait)       WAIT=0; shift ;;
    -h|--help)       usage; exit 0 ;;
    --)              shift; NODES+=("$@"); break ;;
    -*)              die "unknown option: $1 (see --help)" ;;
    *)               NODES+=("$1"); shift ;;
  esac
done

[[ ${#NODES[@]} -gt 0 ]] || { usage; die "no Pi given"; }
if [[ -n "$AUTHKEY_FILE" ]]; then
  [[ -s "$AUTHKEY_FILE" ]] || die "auth key file $AUTHKEY_FILE is missing or empty"
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
[[ -n "$JUMP" ]] && SSH_OPTS+=(-J "$JUMP")

# Parse and validate every node spec before touching any Pi
declare -a N_NAME N_IP N_MODEL
for spec in "${NODES[@]}"; do
  [[ "$spec" == *=* ]] || die "bad node spec '$spec' (expected <name>=<ip>[,model=pi4|pi5])"
  name="${spec%%=*}"; rest="${spec#*=}"; ip="${rest%%,*}"; model="pi4"
  [[ "$rest" == *model=pi5* ]] && model="pi5"
  [[ "$rest" == *model=* && "$rest" != *model=pi4* && "$rest" != *model=pi5* ]] && die "unknown model in '$spec'"
  [[ "$name" =~ ^[a-z0-9-]+$ ]] || die "bad hostname '$name'"
  [[ -n "$ip" ]] || die "no address in '$spec'"
  if [[ "$model" == "pi5" && $GADGET -eq 1 ]]; then
    die "--gadget is not supported on a Pi 5 ($name)"
  fi
  N_NAME+=("$name"); N_IP+=("$ip"); N_MODEL+=("$model")
done

echo ""
echo "=== IDEA Fleet Provisioner (key-only SSH) ==="
echo "Engine ref: $ENGINE_REF   Console ref: $CONSOLE_REF   pnpm: $PNPM_VERSION   node: $NODE_VERSION"
[[ -n "$JUMP" ]] && echo "Jump host: $JUMP"
echo ""

RESULTS=()
FAILED=0

for i in "${!N_NAME[@]}"; do
  NAME="${N_NAME[$i]}"; IP="${N_IP[$i]}"; MODEL="${N_MODEL[$i]}"
  TARGET="${SSH_USER}@${IP}"
  LOG="/tmp/provision-${NAME}.log"
  rssh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Node: $NAME  Address: $IP  Model: $MODEL  (log: $LOG)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # ── Step 1: key auth and passwordless sudo ─────────────────────────────
  echo "[1/5] Checking key-based SSH and sudo..."
  if ! rssh 'sudo -n true' >/dev/null 2>&1; then
    echo "ERROR: $TARGET does not accept this machine's SSH key, or sudo needs a password."
    RESULTS+=("$NAME: FAILED (ssh/sudo)"); FAILED=1; continue
  fi

  # ── Step 2: bootstrap prerequisites and the canonical checkout ─────────
  echo "[2/5] Bootstrapping node $NODE_VERSION, pnpm $PNPM_VERSION and the checkout..."
  if ! rssh "bash -s -- '$NODE_VERSION' '$PNPM_VERSION' '$ENGINE_REF' '$CONSOLE_REF'" >"$LOG" 2>&1 <<'REMOTE'
set -euo pipefail
NODE_VERSION="$1"; PNPM_VERSION="$2"; ENGINE_REF="$3"; CONSOLE_REF="$4"
sudo apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq npm git curl rsync jq >/dev/null
sudo npm install -g -s n "pnpm@${PNPM_VERSION}"
sudo n "$NODE_VERSION" >/dev/null
hash -r
[ "$(pnpm --version)" = "$PNPM_VERSION" ] || { echo "pnpm $(pnpm --version) on PATH, expected $PNPM_VERSION"; exit 1; }
cd /home/pi
[ -d idea ] || git clone -q https://github.com/koenswings/idea.git idea
mkdir -p idea/agents && cd idea/agents
for r in agent-engine-dev agent-console-dev agent-app-dev; do
  [ -d "$r" ] || git clone -q "https://github.com/koenswings/$r.git" "$r"
done
checkout() {  # <repo> <ref>: detached at the ref when it's a commit, else the branch
  git -C "$1" fetch -q origin
  if git -C "$1" rev-parse -q --verify "origin/$2" >/dev/null; then
    git -C "$1" checkout -q -B "$2" "origin/$2"
  else
    git -C "$1" checkout -q "$2"
  fi
  echo "$1 at $(git -C "$1" log -1 --format='%h %s')"
}
checkout agent-engine-dev "$ENGINE_REF"
checkout agent-console-dev "$CONSOLE_REF"
( cd agent-engine-dev && pnpm install --frozen-lockfile )
( cd agent-console-dev && pnpm install --frozen-lockfile && pnpm build )
# /META.yaml: Engine creates it on first start when missing (idea#145 / #131).
echo BOOTSTRAP-OK
REMOTE
  then
    echo "ERROR: bootstrap failed on $NAME; see $LOG"
    tail -5 "$LOG" | sed 's/^/  /'
    RESULTS+=("$NAME: FAILED (bootstrap)"); FAILED=1; continue
  fi
  grep -E ' at [0-9a-f]{7}' "$LOG" | sed 's/^/  /' || true

  # ── Step 3: Tailscale fleet key (stdin only, never an argument) ────────
  echo "[3/5] Tailscale fleet key..."
  if [[ -n "$AUTHKEY_FILE" ]]; then
    rssh 'sudo install -d -m 700 -o root -g root /etc/tailscale && umask 077 && sudo tee /etc/tailscale/debug-authkey >/dev/null && sudo chmod 600 /etc/tailscale/debug-authkey && sudo chown root:root /etc/tailscale/debug-authkey' < "$AUTHKEY_FILE"
    echo "  Key stored in /etc/tailscale/debug-authkey (0600 root)."
  elif rssh 'sudo test -s /etc/tailscale/debug-authkey'; then
    echo "  The Pi already holds a key; keeping it."
  else
    echo "ERROR: no Tailscale key on $NAME and no --authkey-file given."
    RESULTS+=("$NAME: FAILED (no Tailscale key)"); FAILED=1; continue
  fi

  # ── Step 4: build-engine in local mode on the Pi ───────────────────────
  echo "[4/5] Running build-engine on $NAME (local mode). This takes 10-20 minutes; the Pi reboots at the end."
  FLAGS="--model $MODEL --temperature"
  [[ $ARGON -eq 1 ]] && FLAGS+=" --argon" || FLAGS+=" --no-argon"
  [[ $GADGET -eq 1 ]] && FLAGS+=" --gadget" || FLAGS+=" --no-gadget"
  set +e
  # The key goes from the root-only file into the environment of build-engine on the
  # Pi ($(...) runs remotely); it is never in an argument on either machine.
  rssh "cd /home/pi/idea/agents/agent-engine-dev && TAILSCALE_AUTHKEY=\"\$(sudo cat /etc/tailscale/debug-authkey)\" ./build-engine --hostname '$NAME' --timezone '$TIMEZONE' --keyboard '$KEYBOARD' $FLAGS --prod" >>"$LOG" 2>&1
  BUILD_EXIT=$?
  set -e
  # build-engine ends with a reboot: the SSH connection drops (255) or returns 0.
  if [[ $BUILD_EXIT -ne 0 && $BUILD_EXIT -ne 255 ]]; then
    echo "ERROR: build-engine failed on $NAME (exit $BUILD_EXIT); see $LOG"
    tail -8 "$LOG" | sed 's/^/  /'
    RESULTS+=("$NAME: FAILED (build-engine exit $BUILD_EXIT)"); FAILED=1; continue
  fi
  grep -F 'Build options:' "$LOG" | tail -1 | sed 's/^/  /' || true

  if [[ $WAIT -eq 0 ]]; then
    RESULTS+=("$NAME: built, rebooting (not checked, --no-wait)"); continue
  fi

  # ── Step 5: wait for the reboot, then health check ─────────────────────
  echo "[5/5] Waiting for $NAME to come back..."
  sleep 60
  up=0
  for _ in $(seq 1 30); do
    if rssh true >/dev/null 2>&1; then up=1; break; fi
    sleep 10
  done
  if [[ $up -eq 0 ]]; then
    echo "ERROR: $NAME did not come back over SSH within 6 minutes."
    RESULTS+=("$NAME: FAILED (no SSH after reboot)"); FAILED=1; continue
  fi
  sleep 45   # pm2 + Engine; allow command-log 10 s timeout on a fresh Pi (idea#145)
  HEALTH=$(rssh 'cd /home/pi/idea/agents/agent-engine-dev
    port=$(sed -n "s/^  httpPort: *\([0-9]*\).*/\1/p" config.yaml | head -1); port=${port:-80}
    engine=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.name==\"engine\") | .pm2_env.status" | head -1)
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:$port/")
    echo "engine=${engine:-missing} http=$code port=$port"' 2>/dev/null || echo "engine=unknown http=000 port=?")
  echo "  $HEALTH"
  if [[ "$HEALTH" == *"engine=online"* && "$HEALTH" == *"http=200"* ]]; then
    RESULTS+=("$NAME: OK ($HEALTH)")
  else
    echo "  WARN: the Engine is not serving the Console yet; check 'pm2 logs engine'."
    echo "        Fresh starts can take ~10 s longer while the command-log load times out (idea#145)."
    RESULTS+=("$NAME: CHECK ($HEALTH)"); FAILED=1
  fi
done

echo ""
echo "=== Provisioning summary ==="
printf '  %s\n' "${RESULTS[@]}"
exit $FAILED
