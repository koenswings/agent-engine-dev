#!/usr/bin/env bash
# idea-local-takeover-test.sh — automated "power cut" takeover test for idea.local (idea#203 §3).
#
# Proves: when the Engine holding idea.local disappears WITHOUT an mDNS goodbye (power cut),
# another pool Engine takes over and a client resolves idea.local to it and gets the Console
# (HTTP 200) within the 120 s record TTL.
#
# DO NOT RUN without a Steve claim on the pool and Atlas standing by (it changes firewall
# state on a pool Pi for --cut seconds). It refuses to start without --claim.
#
# How the power cut is simulated (on the CURRENT holder only, which must be idea01/03/04):
#   --mode netcut (default): temporary iptables DROP of mDNS (udp 5353, in+out) and of the
#       Console ports (tcp, in) on the holder's LAN interface. Nothing else: tailscale/ssh keep
#       working, the Engine and avahi keep running and still believe they hold the name, and no
#       goodbye is sent, exactly as for a power cut seen from the LAN. A removal of the rules is
#       scheduled with systemd-run BEFORE the rules go in (self-healing even if this script or the
#       ssh link dies), and the trap removes them at exit.
#   --mode avahi-freeze: SIGSTOP avahi-daemon on the holder (no goodbye, no answers), auto SIGCONT
#       scheduled the same way. HTTP keeps answering on the old IP, so only the mDNS part is cut.
# The client (idea02 by default) is used read-only: getaddrinfo() lookups and HTTP GETs.
#
# Usage:
#   script/idea-local-takeover-test.sh --claim <steve-claim-id> [--mode netcut|avahi-freeze]
#       [--pool idea01,idea03,idea04] [--client idea02] [--lan-if eth0] [--ports 80,8080]
#       [--cut 150] [--ttl 120] [--converge 60] [--out DIR] [--dry-run]
#
# One holder is checked ON THE WIRE, not with getaddrinfo (which returns only the first answer
# and hid a second holder on 2026-10-15): script/idea-local-mdns-responders.py sends a raw mDNS
# query from the client and collects every responder. Before the cut exactly one pool Engine
# must answer; after the restore exactly one must answer on 2 consecutive queries within
# --converge seconds, or the run FAILs.
# Hosts are ssh aliases (see ~/.ssh/config); SSH can be overridden (env SSH).
# Exit: 0 PASS, 1 FAIL (no takeover within --ttl), 2 refused/precondition, 3 infra error.

set -uo pipefail

SSH=${SSH:-"ssh -o BatchMode=yes -o ConnectTimeout=15"}
CLAIM=""; MODE=netcut; POOL="idea01,idea03,idea04"; CLIENT=idea02; LAN_IF=eth0; PORTS=80,8080
CUT=150; TTL=120; CONVERGE=60; OUT=""; DRY=0
ALLOWED_POOL="idea01 idea03 idea04"          # never wh (wizardly-hugle) or idea02
while [ $# -gt 0 ]; do
  case "$1" in
    --claim) CLAIM="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --pool) POOL="${2:-}"; shift 2 ;;
    --client) CLIENT="${2:-}"; shift 2 ;;
    --lan-if) LAN_IF="${2:-}"; shift 2 ;;
    --ports) PORTS="${2:-}"; shift 2 ;;
    --cut) CUT="${2:-}"; shift 2 ;;
    --ttl) TTL="${2:-}"; shift 2 ;;
    --converge) CONVERGE="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "refused: unknown argument $1" >&2; exit 2 ;;
  esac
done

refuse() { echo "refused: $*" >&2; exit 2; }
[ -n "$CLAIM" ] || refuse "--claim <id> is required (Steve claims the pool; Atlas stands by)"
[[ "$CLAIM" =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || refuse "claim id is not a safe string"
case "$MODE" in netcut|avahi-freeze) ;; *) refuse "--mode must be netcut or avahi-freeze" ;; esac
[[ "$LAN_IF" =~ ^[a-z0-9]{1,15}$ ]] || refuse "--lan-if is not an interface name"
[[ "$PORTS" =~ ^[0-9]{1,5}(,[0-9]{1,5}){0,3}$ ]] || refuse "--ports must be 1-4 port numbers"
[[ "$CUT" =~ ^[0-9]+$ && "$TTL" =~ ^[0-9]+$ ]] || refuse "--cut/--ttl must be seconds"
[ "$CUT" -gt "$TTL" ] || refuse "--cut ($CUT) must be longer than --ttl ($TTL)"
[ "$CUT" -le 600 ] || refuse "--cut is at most 600 s"
[[ "$CONVERGE" =~ ^[0-9]+$ ]] && [ "$CONVERGE" -ge 10 ] && [ "$CONVERGE" -le 300 ] || refuse "--converge must be 10-300 s"
IFS=, read -r -a POOL_HOSTS <<< "$POOL"
[ "${#POOL_HOSTS[@]}" -ge 2 ] || refuse "need at least 2 pool Engines"
for h in "${POOL_HOSTS[@]}"; do
  [[ " $ALLOWED_POOL " == *" $h "* ]] || refuse "$h is not a pool Engine (allowed: $ALLOWED_POOL; never wh or idea02)"
done
[[ " $ALLOWED_POOL " != *" $CLIENT "* ]] || refuse "the client must not be one of the pool Engines"
[[ "$CLIENT" != wh && "$CLIENT" != wizardly-hugle* ]] || refuse "wh is never used"

OUT=${OUT:-/workspace/idea203-takeover/run-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
rsh() { local h=$1; shift; $SSH "$h" "$@"; }

log "idea.local power-cut takeover test: claim=$CLAIM mode=$MODE pool=$POOL client=$CLIENT ttl=${TTL}s cut=${CUT}s"

# ── Preconditions (read-only) ───────────────────────────────────────────────
declare -A LANIP HOSTNAME_OF
for h in "${POOL_HOSTS[@]}"; do
  info=$(rsh "$h" "hostname; ip -4 -o addr show dev $LAN_IF | awk '{print \$4}' | cut -d/ -f1 | head -1; pgrep -x avahi-daemon >/dev/null && echo avahi-ok; pm2 jlist 2>/dev/null | grep -q '\"name\":\"engine\"' && echo engine-ok; grep -h '\\[idea.local\\]' ~/.pm2/logs/engine-out*.log 2>/dev/null | tail -1") \
    || { log "infra: cannot reach $h"; exit 3; }
  HOSTNAME_OF[$h]=$(sed -n 1p <<< "$info"); LANIP[$h]=$(sed -n 2p <<< "$info")
  [[ "${HOSTNAME_OF[$h]}" != wizardly-hugle* ]] || refuse "$h is wizardly-hugle"
  grep -q avahi-ok <<< "$info" || refuse "$h: avahi-daemon not running"
  grep -q engine-ok <<< "$info" || refuse "$h: pm2 Engine not running"
  log "pool $h: host=${HOSTNAME_OF[$h]} lan=${LANIP[$h]} publisher: $(sed -n '/\[idea.local\]/p' <<< "$info")"
  [ -n "${LANIP[$h]}" ] || refuse "$h has no IPv4 on $LAN_IF"
  grep -q '\[idea.local\]' <<< "$info" || refuse "$h: no idea.local publisher in the Engine log (Engine without idea#203 PR A?)"
done

resolve_once() { rsh "$CLIENT" "python3 -c \"import socket
try: print('+'.join(sorted({a[4][0] for a in socket.getaddrinfo('idea.local',80,socket.AF_INET,socket.SOCK_STREAM)})))
except Exception: print('FAIL')\""; }
RESPONDERS_PY="$(dirname "$0")/idea-local-mdns-responders.py"
POOL_IPS=$(for h in "${POOL_HOSTS[@]}"; do printf '%s,' "${LANIP[$h]}"; done)
# Raw mDNS query from the client; prints the JSON line and appends it to mdns-responders.txt.
responders() { rsh "$CLIENT" "python3 - --wait 2" < "$RESPONDERS_PY" | tee -a "$OUT/mdns-responders.txt"; }
# "ONE <ip>" (exit 0) or "NOT-ONE ..." (exit 1)
one_holder() { local j; j=$(responders) || return 3; python3 "$RESPONDERS_PY" --judge "$j" "$POOL_IPS"; }
PRE=$(one_holder); PRE_RC=$?
[ "$PRE_RC" -le 1 ] && [ -n "$PRE" ] || { log "infra: raw mDNS query on client $CLIENT failed"; exit 3; }
log "before cut, raw mDNS: $PRE"
[ "$PRE_RC" = 0 ] || refuse "idea.local is not answered by exactly one pool Engine on the wire ($PRE); fix before testing"
NOW=${PRE#ONE }
HOLDER=""
for h in "${POOL_HOSTS[@]}"; do [ "$NOW" = "${LANIP[$h]}" ] && HOLDER=$h; done
[ -n "$HOLDER" ] || refuse "idea.local is answered by $NOW, which is not a pool Engine"
GAI=$(resolve_once) || { log "infra: client $CLIENT unreachable"; exit 3; }
[ "$GAI" = "$NOW" ] || refuse "getaddrinfo on $CLIENT gives '$GAI' but the only responder is $NOW"
FIRST_PORT=${PORTS%%,*}
code=$(rsh "$CLIENT" "curl -s -o /dev/null -m 5 -w '%{http_code}' http://idea.local:$FIRST_PORT/") || code=000
[ "$code" = 200 ] || refuse "http://idea.local:$FIRST_PORT/ answered $code before the cut (Console must answer first)"
log "holder before cut: $HOLDER (${LANIP[$HOLDER]}), Console HTTP $code"
OTHERS=(); for h in "${POOL_HOSTS[@]}"; do [ "$h" != "$HOLDER" ] && OTHERS+=("$h"); done

# ── Cut commands on the holder ──────────────────────────────────────────────
RULES=("INPUT -i $LAN_IF -p udp --dport 5353 -j DROP" "OUTPUT -o $LAN_IF -p udp --sport 5353 -j DROP" "OUTPUT -o $LAN_IF -p udp --dport 5353 -j DROP")
for p in ${PORTS//,/ }; do RULES+=("INPUT -i $LAN_IF -p tcp --dport $p -j DROP"); done
UNIT="idea203-takeover-restore-$(date +%s)"
if [ "$MODE" = netcut ]; then
  UNDO=""; for r in "${RULES[@]}"; do UNDO+="/usr/sbin/iptables -w -D $r 2>/dev/null; "; done
  DO="";   for r in "${RULES[@]}"; do DO+="/usr/sbin/iptables -w -I $r && "; done; DO+="true"
else
  UNDO="pkill -CONT -x avahi-daemon; "
  DO="pkill -STOP -x avahi-daemon"
fi
SCHEDULE="sudo systemd-run --unit=$UNIT --on-active=${CUT} /bin/sh -c '$UNDO true'"
CUTCMD="$SCHEDULE && sudo sh -c '$DO'"
RESTORE="sudo sh -c '$UNDO true'; sudo systemctl stop $UNIT.timer 2>/dev/null; true"

if [ "$DRY" = 1 ]; then
  log "DRY RUN: would run on $HOLDER: $CUTCMD"
  log "DRY RUN: would restore with: $RESTORE"
  exit 0
fi

restore() { rsh "$HOLDER" "$RESTORE" >/dev/null 2>&1; log "restored $HOLDER (rules removed / avahi continued)"; }
trap restore EXIT

# ── Poll on the client (read-only), 2 Hz, for CUT+10 s ─────────────────────
rsh "$CLIENT" "python3 - $((CUT + 10)) $FIRST_PORT" > "$OUT/poll.csv" <<'PY' &
import socket, sys, time, urllib.request
dur, port = float(sys.argv[1]), int(sys.argv[2]); t0 = time.time()
while time.time() - t0 < dur:
    t = time.time()
    try: ip = '+'.join(sorted({a[4][0] for a in socket.getaddrinfo('idea.local', 80, socket.AF_INET, socket.SOCK_STREAM)}))
    except Exception: ip = 'FAIL'
    code = 0
    if ip != 'FAIL':
        try: code = urllib.request.urlopen('http://%s:%d/' % (ip.split('+')[0], port), timeout=1.5).status
        except Exception: code = 0
    print('%.2f,%s,%d' % (time.time() - t0, ip, code), flush=True)
    time.sleep(max(0, 0.5 - (time.time() - t)))
PY
POLLPID=$!
sleep 5
T_CUT=$(date +%s.%N)
rsh "$HOLDER" "$CUTCMD" > "$OUT/cut.txt" 2>&1 || { log "infra: cut failed on $HOLDER: $(cat "$OUT/cut.txt")"; exit 3; }
log "CUT on $HOLDER at $(date +%T) (+5 s into the poll)"
wait $POLLPID
restore; trap - EXIT
T_RESTORE=$(date +%s)
# ── After restore: exactly one responder on the wire, twice in a row, within --converge s ──
CONV=FAIL; STREAK=0; LAST=""
while [ $(( $(date +%s) - T_RESTORE )) -lt "$CONVERGE" ]; do
  LAST=$(one_holder); rc=$?
  [ "$rc" -le 1 ] || { log "infra: raw mDNS query failed after restore"; LAST="infra"; }
  log "after restore +$(( $(date +%s) - T_RESTORE )) s, raw mDNS: $LAST"
  if [ "$rc" = 0 ]; then STREAK=$((STREAK + 1)); else STREAK=0; fi
  if [ "$STREAK" -ge 2 ]; then CONV=PASS; break; fi
  sleep 3
done
CONV_S=$(( $(date +%s) - T_RESTORE ))
AFTER=$(resolve_once)
for h in "${OTHERS[@]}"; do rsh "$h" "grep -h '\\[idea.local\\]' ~/.pm2/logs/engine-out*.log 2>/dev/null | tail -3" | sed "s/^/$h publisher: /" | tee -a "$OUT/summary.txt"; done
rsh "$HOLDER" "grep -h '\\[idea.local\\]' ~/.pm2/logs/engine-out*.log 2>/dev/null | tail -3" | sed "s/^/$HOLDER publisher: /" | tee -a "$OUT/summary.txt"
log "after restore: idea.local -> $AFTER (expect exactly one pool address)"

# ── Analyse ─────────────────────────────────────────────────────────────────
python3 "$(dirname "$0")/idea-local-takeover-analyse.py" "$OUT/poll.csv" 5 "${LANIP[$HOLDER]}" "$TTL" \
  "$(for h in "${OTHERS[@]}"; do printf '%s,' "${LANIP[$h]}"; done)" | tee -a "$OUT/summary.txt"
RES=${PIPESTATUS[0]}
if [ "$CONV" = PASS ]; then
  log "PASS: exactly one responder for idea.local on the wire ($LAST) within ${CONV_S} s of the restore (limit ${CONVERGE} s)"
else
  log "FAIL: not exactly one responder for idea.local within ${CONVERGE} s of the restore (last: $LAST)"
  RES=1
fi
log "results in $OUT"
exit "$RES"
