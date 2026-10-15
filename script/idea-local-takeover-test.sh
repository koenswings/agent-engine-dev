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
# Which Engine is cut (--holder): with the lowest-IPv4 rule the lowest pool address (idea03)
# always holds idea.local at the start, so a plain run only ever cuts idea03. --holder <host>
# first PRODUCES that Engine as the holder, honestly, through the same mechanism a school would
# hit: avahi-daemon on the current holder is frozen (SIGSTOP, SIGCONT scheduled with systemd-run
# after --prep s as a safety net) until <host> answers alone on the wire, then continued; the old
# holder's Engine (idea#203 #211 D-Bus timeout) has freed its record meanwhile and rejoins as a
# waiter. <host> must then be the only responder on 2 consecutive raw queries within --converge s
# and avahi must be running again on the old holder, or the run stops (exit 3) before any cut.
# --prepare-only stops there (exit 0), e.g. to hand a higher-IP holder to another test.
#
# Usage:
#   script/idea-local-takeover-test.sh --claim <steve-claim-id> [--mode netcut|avahi-freeze]
#       [--pool idea01,idea03,idea04] [--client idea02] [--lan-if eth0] [--ports 80,8080]
#       [--cut 150] [--ttl 120] [--converge 60] [--holder idea04] [--prep 30] [--prepare-only]
#       [--out DIR] [--dry-run] [--print-netcut]
#
# One holder is checked ON THE WIRE, not with getaddrinfo (which returns only the first answer
# and hid a second holder on 2026-10-15): script/idea-local-mdns-responders.py sends a raw mDNS
# query from the client and collects every responder. Before the cut exactly one pool Engine
# must answer; after the restore exactly one must answer on 2 consecutive queries within
# --converge seconds, or the run FAILs.
# Hosts are ssh aliases (see ~/.ssh/config); SSH can be overridden (env SSH).
# After the restore every rule tagged idea203-takeover must be gone (iptables, ip6tables, nft),
# else the run FAILs.
# Exit: 0 PASS, 1 FAIL (no takeover within --ttl, not one holder, or a rule left), 2 refused/precondition, 3 infra error.

set -uo pipefail

SSH=${SSH:-"ssh -o BatchMode=yes -o ConnectTimeout=15"}
# Binaries on the holder (overridable only so the test can run the generated commands against a fake).
IPT=${IPT:-/usr/sbin/iptables}; IP6T=${IP6T:-/usr/sbin/ip6tables}; NFT=${NFT:-nft}
CLAIM=""; MODE=netcut; POOL="idea01,idea03,idea04"; CLIENT=idea02; LAN_IF=eth0; PORTS=80,8080
CUT=150; TTL=120; CONVERGE=60; OUT=""; DRY=0; PRINT=0; WANT_HOLDER=""; PREP=30; PREP_ONLY=0
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
    --holder) WANT_HOLDER="${2:-}"; shift 2 ;;
    --prep) PREP="${2:-}"; shift 2 ;;
    --prepare-only) PREP_ONLY=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --print-netcut) PRINT=1; shift ;;
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
[[ "$PREP" =~ ^[0-9]+$ ]] && [ "$PREP" -ge 5 ] && [ "$PREP" -le 120 ] || refuse "--prep must be 5-120 s"
if [ -n "$WANT_HOLDER" ]; then
  [[ " ${POOL_HOSTS[*]} " == *" $WANT_HOLDER "* ]] || refuse "--holder $WANT_HOLDER is not in --pool $POOL"
fi
[ "$PREP_ONLY" = 0 ] || [ -n "$WANT_HOLDER" ] || refuse "--prepare-only needs --holder <host>"

# Cut commands on the holder (built once the arguments are checked).
build_cut() {
# Every rule carries this comment so the undo and the leftover check can find it in any table.
TAG="idea203-takeover"
M="-m comment --comment $TAG"
RULES=("INPUT -i $LAN_IF -p udp --dport 5353 $M -j DROP" "OUTPUT -o $LAN_IF -p udp --sport 5353 $M -j DROP" "OUTPUT -o $LAN_IF -p udp --dport 5353 $M -j DROP")
for p in ${PORTS//,/ }; do RULES+=("INPUT -i $LAN_IF -p tcp --dport $p $M -j DROP"); done
UNIT="idea203-takeover-restore-$(date +%s)"
if [ "$MODE" = netcut ]; then
  # Undo deletes every copy of every rule (a rule inserted twice by a retried cut would survive
  # a single -D). Only IPv4 iptables rules are added; on the Pis iptables is iptables-nft, so
  # they live in nft table ip filter, which the leftover check also reads.
  UNDO=""; for r in "${RULES[@]}"; do UNDO+="while $IPT -w -C $r 2>/dev/null; do $IPT -w -D $r || break; done; "; done
  DO="";   for r in "${RULES[@]}"; do DO+="$IPT -w -I $r && "; done; DO+="true"
else
  # The first undo to run (the timer, or the script's restore) records when avahi got SIGCONT,
  # so the analysis can place the resume on the client's poll (see RESUME_GRACE).
  RESUMED="/run/$UNIT.resumed"
  UNDO="pkill -CONT -x avahi-daemon; test -e $RESUMED || date +%s.%N > $RESUMED; "
  DO="pkill -STOP -x avahi-daemon"
fi
# What was cut, for the log lines (avahi-freeze changes no firewall rule).
if [ "$MODE" = netcut ]; then WHAT="mDNS and Console ports dropped on $LAN_IF"; UNDONE="firewall rules removed"
else WHAT="avahi-daemon frozen (SIGSTOP)"; UNDONE="avahi-daemon continued (SIGCONT)"; fi
# avahi-freeze: prints the stopped avahi-daemon if it is still stopped (state T), nothing when running.
AVAHI_STOPPED="ps -o pid=,stat=,comm= -C avahi-daemon 2>/dev/null | awk '\$2 ~ /T/'; true"
# Prints every firewall rule of ours still present (iptables + ip6tables, all tables, and the
# raw nft ruleset), nothing when clean.
LEFTOVER="for t in filter nat mangle raw; do sudo $IPT -w -t \$t -S 2>/dev/null; sudo $IP6T -w -t \$t -S 2>/dev/null; done | grep -F -- '$TAG'; sudo $NFT list ruleset 2>/dev/null | grep -F -- '$TAG'; true"
# systemd-run passes the command line as is (no %-specifier expansion; checked on idea03 20:08).
# AccuracySec: a timer's default 1 min accuracy fired the undo up to a minute late (idea03 20:08),
# i.e. after the client poll ended, so the avahi-freeze resume would not be observed.
SCHEDULE="sudo systemd-run --unit=$UNIT --on-active=${CUT} --timer-property=AccuracySec=100ms /bin/sh -c '$UNDO true'"
CUTCMD="$SCHEDULE && sudo sh -c '$DO'"
RESTORE="sudo sh -c '$UNDO true'; sudo systemctl stop $UNIT.timer 2>/dev/null; true"

}

if [ "$PRINT" = 1 ]; then
  # Contacts nothing: prints the cut, undo and leftover-check commands (one per line) for review/tests.
  build_cut; printf 'DO=%s\nUNDO=%s\nLEFTOVER=%s\n' "$DO" "$UNDO" "$LEFTOVER"; exit 0
fi
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
one_holder() { local j; j=$(responders) || return 3; python3 "$RESPONDERS_PY" --judge-json "$j" --pool "$POOL_IPS"; }
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

build_cut   # defines AVAHI_STOPPED for the preparation (rebuilt before the cut)
# ── --holder: produce the requested holder first (freeze avahi on the current one) ──
if [ -n "$WANT_HOLDER" ] && [ "$WANT_HOLDER" != "$HOLDER" ]; then
  PUNIT="idea203-takeover-prep-$(date +%s)"
  PREP_CMD="sudo systemd-run --unit=$PUNIT --on-active=${PREP} /bin/sh -c 'pkill -CONT -x avahi-daemon; true' && sudo pkill -STOP -x avahi-daemon"
  PREP_UNDO="sudo pkill -CONT -x avahi-daemon; sudo systemctl stop $PUNIT.timer 2>/dev/null; true"
  if [ "$DRY" = 1 ]; then
    log "DRY RUN: would first make $WANT_HOLDER the holder: on $HOLDER run: $PREP_CMD; wait for ONE ${LANIP[$WANT_HOLDER]}; then: $PREP_UNDO"
  else
    PREV=$HOLDER
    trap 'rsh "$PREV" "$PREP_UNDO" >/dev/null 2>&1' EXIT
    log "preparing: $WANT_HOLDER must hold idea.local; freezing avahi-daemon on the current holder $PREV (SIGCONT scheduled after ${PREP} s)"
    rsh "$PREV" "$PREP_CMD" > "$OUT/prep.txt" 2>&1 || { log "infra: could not freeze avahi on $PREV: $(cat "$OUT/prep.txt")"; exit 3; }
    T0=$(date +%s); GOT=""
    while [ $(( $(date +%s) - T0 )) -lt "$PREP" ]; do
      GOT=$(one_holder) && [ "$GOT" = "ONE ${LANIP[$WANT_HOLDER]}" ] && break
      sleep 2
    done
    rsh "$PREV" "$PREP_UNDO" >/dev/null 2>&1; trap - EXIT
    log "preparing: after $(( $(date +%s) - T0 )) s of the freeze, raw mDNS: $GOT; avahi-daemon continued on $PREV"
    [ "$GOT" = "ONE ${LANIP[$WANT_HOLDER]}" ] || { log "infra: $WANT_HOLDER did not take idea.local while $PREV was frozen; not cutting anything"; exit 3; }
    STOPPED=$(rsh "$PREV" "$AVAHI_STOPPED" 2>&1)
    [ -z "$STOPPED" ] || { log "infra: avahi-daemon still stopped on $PREV after SIGCONT ($STOPPED)"; exit 3; }
    T0=$(date +%s); STREAK=0
    while [ $(( $(date +%s) - T0 )) -lt "$CONVERGE" ] && [ "$STREAK" -lt 2 ]; do
      GOT=$(one_holder)
      log "preparing: $PREV back, +$(( $(date +%s) - T0 )) s, raw mDNS: $GOT"
      if [ "$GOT" = "ONE ${LANIP[$WANT_HOLDER]}" ]; then STREAK=$((STREAK + 1)); else STREAK=0; fi
      [ "$STREAK" -ge 2 ] || sleep 3
    done
    [ "$STREAK" -ge 2 ] || { log "infra: $WANT_HOLDER is not the only holder within ${CONVERGE} s after $PREV came back (last: $GOT); not cutting anything"; exit 3; }
    HOLDER=$WANT_HOLDER
    sleep 2
    GAI=$(resolve_once)
    [ "$GAI" = "${LANIP[$HOLDER]}" ] || { log "infra: getaddrinfo on $CLIENT gives '$GAI', expected ${LANIP[$HOLDER]}"; exit 3; }
    code=$(rsh "$CLIENT" "curl -s -o /dev/null -m 5 -w '%{http_code}' http://idea.local:$FIRST_PORT/") || code=000
    [ "$code" = 200 ] || { log "infra: http://idea.local:$FIRST_PORT/ answered $code with $HOLDER as holder"; exit 3; }
    log "prepared: $HOLDER (${LANIP[$HOLDER]}) is the only holder, Console HTTP $code"
  fi
fi
if [ "$PREP_ONLY" = 1 ]; then log "prepare-only: done, nothing cut"; exit 0; fi
log "holder before cut: $HOLDER (${LANIP[$HOLDER]}), Console HTTP $code"
OTHERS=(); for h in "${POOL_HOSTS[@]}"; do [ "$h" != "$HOLDER" ] && OTHERS+=("$h"); done

# ── Cut commands on the holder ──────────────────────────────────────────────
build_cut

if [ "$DRY" = 1 ]; then
  log "DRY RUN: would run on $HOLDER: $CUTCMD"
  log "DRY RUN: would restore with: $RESTORE"
  log "DRY RUN: would check for leftovers with: $LEFTOVER"
  exit 0
fi

restore() { rsh "$HOLDER" "$RESTORE" >/dev/null 2>&1; log "restored $HOLDER ($UNDONE)"; }
trap restore EXIT

# ── Poll on the client (read-only), 2 Hz, for CUT+10 s ─────────────────────
rsh "$CLIENT" "python3 - $((CUT + 10)) $FIRST_PORT" > "$OUT/poll.csv" <<'PY' &
import socket, sys, time, urllib.request
dur, port = float(sys.argv[1]), int(sys.argv[2]); t0 = time.time()
print('# t0 %.3f' % t0, flush=True)
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
log "CUT on $HOLDER at $(date +%T) (+5 s into the poll): $WHAT"
wait $POLLPID
restore; trap - EXIT
T_RESTORE=$(date +%s)
# ── Every rule we added must be gone (iptables/ip6tables, INPUT/OUTPUT, nft) ──
LEFT=$(rsh "$HOLDER" "$LEFTOVER" 2>&1) || { log "infra: leftover-rule check failed on $HOLDER"; LEFT="check-failed"; }
if [ -n "$LEFT" ]; then
  printf '%s\n' "$LEFT" > "$OUT/leftover-rules.txt"
  log "FAIL: firewall rules tagged $TAG are still on $HOLDER after the restore (see leftover-rules.txt); retrying the undo once"
  rsh "$HOLDER" "$RESTORE" >/dev/null 2>&1
  LEFT2=$(rsh "$HOLDER" "$LEFTOVER" 2>&1)
  log "after the second undo: ${LEFT2:-no rules left}"
  LEFTOVER_FAIL=1
else
  if [ "$MODE" = netcut ]; then log "netcut undo: no rule tagged $TAG left on $HOLDER (iptables, ip6tables, nft)"
  else log "avahi-freeze: no firewall rule tagged $TAG on $HOLDER (none is added in this mode)"; fi
  LEFTOVER_FAIL=0
fi
if [ "$MODE" = avahi-freeze ]; then
  STOPPED=$(rsh "$HOLDER" "$AVAHI_STOPPED" 2>&1)
  if [ -n "$STOPPED" ]; then log "FAIL: avahi-daemon still stopped on $HOLDER after the restore ($STOPPED)"; LEFTOVER_FAIL=1
  else log "avahi-freeze undo: avahi-daemon running on $HOLDER"; fi
fi
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
# avahi-freeze ONLY (Steve, idea#203, 2026-10-15): the dead IP may appear for at most
# RESUME_GRACE (3) s right after the SIGCONT, never later. A SIGSTOPped avahi-daemon answers the
# queries that piled up while it was frozen from memory as soon as it runs again, and sends the
# goodbye for idea.local within ~10 ms; nothing the Engine does can stop that first burst, and a
# real power cut cannot cause it. netcut (both directions) passes no resume and stays strict.
# 3 s, not 2 s (Steve, 2026-10-15): on pool 856589f the resume burst lasted 2.5 s and 2.7 s.
RESUME_GRACE=3
RESUME_ARGS=()
if [ "$MODE" = avahi-freeze ]; then
  T0=$(awk '$1 == "#" && $2 == "t0" { print $3; exit }' "$OUT/poll.csv")
  TR=$(rsh "$HOLDER" "cat $RESUMED 2>/dev/null; sudo rm -f $RESUMED" 2>/dev/null | head -1)
  if [ -n "$T0" ] && [ -n "$TR" ]; then
    RS=$(python3 -c "print('%.2f' % ($TR - $T0))")
    log "avahi-freeze: SIGCONT on $HOLDER at +$RS s into the poll (holder clock vs $CLIENT clock); dead IP allowed for ${RESUME_GRACE} s after it, never later"
    RESUME_ARGS=("$RS" "$RESUME_GRACE")
  else
    log "FAIL: avahi-freeze resume time unknown (poll t0='${T0}', holder resume='${TR}'); cannot apply the ${RESUME_GRACE} s grace, judging strictly"
    RESUME_FAIL=1
  fi
fi
python3 "$(dirname "$0")/idea-local-takeover-analyse.py" "$OUT/poll.csv" 5 "${LANIP[$HOLDER]}" "$TTL" \
  "$(for h in "${OTHERS[@]}"; do printf '%s,' "${LANIP[$h]}"; done)" "${RESUME_ARGS[@]}" | tee -a "$OUT/summary.txt"
RES=${PIPESTATUS[0]}
if [ "$CONV" = PASS ]; then
  log "PASS: exactly one responder for idea.local on the wire ($LAST) within ${CONV_S} s of the restore (limit ${CONVERGE} s)"
else
  log "FAIL: not exactly one responder for idea.local within ${CONVERGE} s of the restore (last: $LAST)"
  RES=1
fi
[ "$LEFTOVER_FAIL" = 0 ] || RES=1
[ "${RESUME_FAIL:-0}" = 0 ] || RES=1
log "results in $OUT"
exit "$RES"
