#!/usr/bin/env bash
# shellcheck disable=SC2317  # functions run from the EXIT trap and through poll()
# peer-verify.sh — cross-Pi verify of per-Pi Engine keys (rollout step 7, 46d4d57).
#
#   script/peer-verify.sh [options] <host> <host> [<host>]
#
# Hosts are pool Pis by name or Tailscale IP: idea01 100.99.231.94,
# idea03 100.126.117.80, idea04 100.108.39.45. idea02 (100.85.108.118) is
# refused by name, IP, reported hostname, Engine id and store entry name.
# Driven from the box over ssh as pi (~/.ssh/id_ed25519) and through each
# Engine's store (script/peer-verify-store.ts over HTTP + WebSocket).
#
# Checks (one PASS/FAIL/BLOCKED line each, then a summary):
#   1 install   helper v2, sshd -t, AuthorizedKeysFile, owners/modes, peerAccess: true
#   2 peers     each Pi authorizes/pins exactly the other given Pis; store matches
#   3 copy      real Engine copyApp both ways between Atlas-provided scratch disks
#   4 refusals  plain ssh → exit 2 + journal; peer delete → "did not create";
#               receive into an existing folder → "already exists"
#   5 stale     peerStaleHours 0.05 on host 1, stop host 2's Engine, drop-out,
#               start, return within one heartbeat, revert, original state
#
# Changes on the Pis, all recorded under ~pi/.peer-verify on the Pi and reverted
# by the EXIT trap (also on failure/^C) and by the start of the next run:
#   - config.yaml of host 1 (byte-exact backup, restored with its mtime) + pm2 restarts
#   - host 2's Engine stopped (pm2 stop) and started again
#   - an empty folder /instances/pv-verify-<run> on each target for check 4 (rmdir)
#   - check 3 only: the copied instance on the target scratch disk (removed with the
#     source Engine's own peer delete) and its store row (purged by exact id)
#
# Options:
#   --skip-install --skip-peers --skip-copy --skip-refusals --skip-stale
#   --scratch-slot <name>  slot holding the Atlas scratch disk (default idea-test-9)
#   --stale-timeout <s>    drop-out wait (default 480)
#   --guards-only          check arguments only, touch nothing, exit
#   --preflight-only       guards + read-only identity checks, exit
# Exit: 0 all PASS (BLOCKED allowed), 1 a FAIL, 2 refused/usage, 3 cannot reach,
#       4 revert incomplete (state left in ~pi/.peer-verify; re-run to finish it).
# Env: PV_EVIDENCE_ROOT (/workspace/duration-evidence), PV_SSH (ssh), PV_SSH_KEY,
#      PV_STORE (store tool command), PV_POLL (5).
set -uo pipefail

SELF=$(readlink -f "${BASH_SOURCE[0]}")
REPO_DIR=$(cd "$(dirname "$SELF")/.." && pwd)
REQUIRED_COMMIT=46d4d57b1191906ab8796c07e671d7feb50c34b2
ENGINE_DIR=/home/pi/idea/agents/agent-engine-dev
STATE=/home/pi/.peer-verify
HELPER=/usr/local/sbin/idea-app-data
GATE=/usr/local/sbin/idea-peer-gate
AUTH_FILE=/etc/ssh/idea_authorized_keys/pi
KH_FILE=/etc/idea/peer_known_hosts
ENGINE_KEY=/home/pi/.ssh/idea_engine_ed25519

declare -A POOL_IP=([idea01]=100.99.231.94 [idea03]=100.126.117.80 [idea04]=100.108.39.45)
FORBIDDEN_NAME=idea02
FORBIDDEN_IP=100.85.108.118

PV_SSH=${PV_SSH:-ssh}
PV_SSH_KEY=${PV_SSH_KEY:-$HOME/.ssh/id_ed25519}
PV_STORE=${PV_STORE:-"$REPO_DIR/node_modules/.bin/tsx $REPO_DIR/script/peer-verify-store.ts"}
PV_POLL=${PV_POLL:-5}
EVIDENCE_ROOT=${PV_EVIDENCE_ROOT:-/workspace/duration-evidence}

SKIP_INSTALL=0 SKIP_PEERS=0 SKIP_COPY=0 SKIP_REFUSALS=0 SKIP_STALE=0
GUARDS_ONLY=0 PREFLIGHT_ONLY=0
SCRATCH_SLOT=idea-test-9
STALE_TIMEOUT=480
RUN_ID=$(date +%Y%m%d-%H%M%S)

usage() { sed -n '3,/^set -uo/p' "$SELF" | sed '$d; s/^# \{0,1\}//'; }
refuse() { echo "REFUSED: $*" >&2; exit 2; }

# ── arguments ────────────────────────────────────────────────────────────────
ORIG_ARGS=("$@")
ARGS=()
while (( $# )); do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --skip-install) SKIP_INSTALL=1 ;;
        --skip-peers) SKIP_PEERS=1 ;;
        --skip-copy) SKIP_COPY=1 ;;
        --skip-refusals) SKIP_REFUSALS=1 ;;
        --skip-stale) SKIP_STALE=1 ;;
        --guards-only) GUARDS_ONLY=1 ;;
        --preflight-only) PREFLIGHT_ONLY=1 ;;
        --scratch-slot) [[ "${2:-}" =~ ^idea-test-[0-9]+$ ]] || refuse "--scratch-slot needs idea-test-N"; SCRATCH_SLOT=$2; shift ;;
        --stale-timeout) [[ "${2:-}" =~ ^[0-9]+$ ]] || refuse "--stale-timeout needs seconds"; STALE_TIMEOUT=$2; shift ;;
        --) shift; ARGS+=("$@"); break ;;
        -*) refuse "unknown option $1 (see --help)" ;;
        *) ARGS+=("$1") ;;
    esac
    shift
done

# Map each argument to a pool name; refuse idea02 and anything outside idea01/03/04.
NAMES=() IPS=()
guard_args() {
    (( ${#ARGS[@]} >= 2 && ${#ARGS[@]} <= 3 )) || refuse "give 2 or 3 pool hosts (idea01, idea03, idea04), got ${#ARGS[@]}"
    local a low name n
    for a in "${ARGS[@]}"; do
        low=${a,,}
        [[ "$low" != *"$FORBIDDEN_NAME"* && "$low" != "$FORBIDDEN_IP" ]] || refuse "'$a' is idea02: never touched by this script"
        low=${low%.local}; low=${low%%.*.ts.net}
        name=""
        for n in "${!POOL_IP[@]}"; do
            [[ "$low" == "$n" || "$low" == "${POOL_IP[$n]}" ]] && name=$n
        done
        [[ -n "$name" ]] || refuse "'$a' is not one of the pool Pis idea01 (${POOL_IP[idea01]}), idea03 (${POOL_IP[idea03]}), idea04 (${POOL_IP[idea04]})"
        for n in "${NAMES[@]}"; do [[ "$n" != "$name" ]] || refuse "'$a' is given twice ($name)"; done
        NAMES+=("$name"); IPS+=("${POOL_IP[$name]}")
    done
}
guard_args
if (( GUARDS_ONLY )); then
    for i in "${!NAMES[@]}"; do echo "GUARDS OK: ${NAMES[$i]} ${IPS[$i]}"; done
    exit 0
fi

# ── evidence, logging, results ───────────────────────────────────────────────
EVID="$EVIDENCE_ROOT/peer-verify-$RUN_ID"
mkdir -p "$EVID" || { echo "cannot create $EVID" >&2; exit 2; }
exec > >(tee -a "$EVID/run.log") 2>&1
RESULTS="$EVID/results.tsv"; : > "$RESULTS"
FAILS=0
ts() { date '+%H:%M:%S'; }
log() { echo "[$(ts)] $*"; }
step() { echo; echo "[$(ts)] ===== $* ====="; }
result() {  # result <check> PASS|FAIL|BLOCKED <detail>
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS"
    printf '%-7s %-28s %s\n' "$2" "$1" "$3"
    [[ "$2" != FAIL ]] || FAILS=$((FAILS + 1))
}
now_s() { date +%s; }

# ── ssh and store ────────────────────────────────────────────────────────────
# rsh <idx> <command>      run as pi on host <idx>; stdin passes through
rsh() {
    local i=$1; shift
    # shellcheck disable=SC2086
    $PV_SSH -i "$PV_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "pi@${IPS[$i]}" -- "$@"
}
declare -a HTTP_PORT ENGINE_ID LOG_PATH
# store <idx> <args…>     the store tool against host <idx>
store() {
    local i=$1; shift
    # shellcheck disable=SC2086
    PV_HTTP_PORT="${HTTP_PORT[$i]:-80}" $PV_STORE "${IPS[$i]}" "$@"
}
# poll <timeout-s> <function> [args]   true once the function succeeds
poll() {
    local end=$(( $(now_s) + $1 )); shift
    while :; do
        "$@" && return 0
        (( $(now_s) < end )) || return 1
        sleep "$PV_POLL"
    done
}

# ── revert (EXIT trap and start-of-run recovery) ─────────────────────────────
# Every change leaves a marker in ~pi/.peer-verify on the Pi first, so this
# finds and undoes exactly what is outstanding, whoever left it.
REVERT_RC=0
REMOTE_REVERT=$(cat <<'RS'
set -u
S=/home/pi/.peer-verify
[ -d "$S" ] || { echo "nothing-to-revert"; exit 0; }
rc=0
if [ -f "$S/engine-stopped" ]; then
    pm2 start engine >/dev/null 2>&1 && rm -f "$S/engine-stopped" && echo "started-engine" || { echo "ERR cannot start engine"; rc=1; }
fi
if [ -f "$S/config.orig" ]; then
    CFG=$(cat "$S/config.path")
    if ! cmp -s "$S/config.orig" "$CFG"; then
        cat "$S/config.orig" > "$CFG" && touch -r "$S/config.orig" "$CFG" && echo "restored-config" || { echo "ERR cannot restore $CFG"; rc=1; }
        pm2 restart engine >/dev/null 2>&1 && echo "restarted-engine" || { echo "ERR pm2 restart failed"; rc=1; }
    else
        touch -r "$S/config.orig" "$CFG"
    fi
    if cmp -s "$S/config.orig" "$CFG"; then rm -f "$S/config.orig" "$S/config.path"; echo "config-identical"; else echo "ERR config differs from backup"; rc=1; fi
fi
for f in "$S"/tempdir.*; do
    [ -e "$f" ] || continue
    d=$(cat "$f")
    case "$d" in /instances/pv-verify-*) ;; *) echo "ERR bad tempdir marker $d"; rc=1; continue ;; esac
    if [ -e "$d" ]; then sudo -n rmdir -- "$d" && echo "removed $d" || { echo "ERR cannot rmdir $d"; rc=1; continue; }; fi
    rm -f "$f"
done
[ "$rc" = 0 ] && ls "$S"/copied.* >/dev/null 2>&1 || { [ "$rc" = 0 ] && rmdir "$S" 2>/dev/null; }
exit "$rc"
RS
)

revert_host() {  # revert_host <idx>: undo outstanding changes, wait for a restarted Engine
    local i=$1 out before
    before=$(engine_field "$i" lastBooted 2>/dev/null)
    out=$(rsh "$i" bash -s <<<"$REMOTE_REVERT" 2>&1); local rc=$?
    if [[ -n "$out" ]]; then while IFS= read -r l; do echo "    ${NAMES[$i]}: $l"; done <<<"$out"; fi
    (( rc == 0 )) || REVERT_RC=1
    if grep -q 'started-engine\|restarted-engine' <<<"$out"; then
        wait_engine_up "$i" "$before" 240 || { log "${NAMES[$i]}: Engine did not come back after revert"; REVERT_RC=1; }
    fi
}

revert_copies() {  # copied instances (check 3): source Engine's peer delete, then purge rows
    local i j f line src tgt slot id markers
    for i in "${!NAMES[@]}"; do
        mapfile -t markers < <(rsh "$i" "ls $STATE/copied.* 2>/dev/null" </dev/null)
        for f in "${markers[@]}"; do
            [[ -n "$f" ]] || continue
            line=$(rsh "$i" cat "$f" 2>/dev/null) || continue
            read -r src tgt slot id <<<"$line"
            j=$(idx_of_engine "$src") || { log "copy marker $f names unknown Engine $src"; REVERT_RC=1; continue; }
            log "removing copied instance $id on ${NAMES[$i]} ($slot) with ${NAMES[$j]}'s peer delete"
            store "$i" push-command "$tgt" "stopInstance $id" >/dev/null 2>&1
            sleep 3
            if peer_ssh "$j" "$i" "sudo -n $HELPER delete $slot $id" >/dev/null 2>"$EVID/revert-delete-$id.err" \
               && ! rsh "$i" test -e "$(slot_dir "$i")/instances/$id"; then
                if store "$i" purge --instances "$id" >/dev/null 2>&1; then rsh "$i" rm -f "$f"
                else log "purge of store row $id failed"; REVERT_RC=1; fi
            else
                log "peer delete of $id failed (see revert-delete-$id.err)"; REVERT_RC=1
            fi
        done
        rsh "$i" "rmdir $STATE 2>/dev/null; true"
    done
}

REVERTED=0
revert_all() {
    (( REVERTED )) && return; REVERTED=1
    step "revert"
    local i
    for (( i = ${#NAMES[@]} - 1; i >= 0; i-- )); do revert_host "$i"; done
    revert_copies
    for i in "${!NAMES[@]}"; do
        if rsh "$i" test -d "$STATE"; then log "${NAMES[$i]}: $STATE still holds markers"; REVERT_RC=1; fi
    done
}

on_exit() {
    local rc=$?
    trap - EXIT INT TERM
    if (( ${STARTED_CHANGES:-0} )); then revert_all; post_state; fi
    summary "$rc"
}
trap on_exit EXIT
trap 'log "interrupted"; exit 130' INT TERM

# ── store helpers ────────────────────────────────────────────────────────────
DUMP=""
dump() {  # dump <idx> [args]: refresh $DUMP from host <idx>
    local i=$1; shift
    DUMP=$(store "$i" dump "$@" 2>>"$EVID/store-errors.log")
}
engine_field() {  # engine_field <idx> <field>  (fresh dump through host idx, of idx's Engine)
    dump "$1" || return 1
    jq -r --arg id "${ENGINE_ID[$1]}" '.engineDB[$id][$f] // empty' --arg f "$2" <<<"$DUMP"
}
store_authorized() {  # store_authorized <viaIdx> <ofIdx> → sorted authorized lines
    dump "$1" || return 1
    jq -r --arg id "${ENGINE_ID[$2]}" '(.engineDB[$id].peerAccess.authorized // [])[]' <<<"$DUMP" | LC_ALL=C sort
}
idx_of_engine() { local i; for i in "${!NAMES[@]}"; do [[ "${ENGINE_ID[$i]}" == "$1" ]] && { echo "$i"; return 0; }; done; return 1; }
wait_engine_up() {  # wait_engine_up <idx> <previous lastBooted> <timeout>
    local i=$1 prev=$2
    _up() { local lb; lb=$(engine_field "$i" lastBooted) && [[ -n "$lb" && "$lb" != "$prev" ]] \
        && [[ "$(rsh "$i" "pm2 jlist" | jq -r '.[]|select(.name=="engine")|.pm2_env.status')" == online ]]; }
    poll "$3" _up
}
slot_dir() { echo "${DISKS_ROOT[$1]}/$SCRATCH_SLOT"; }
# peer_ssh <fromIdx> <toIdx> <command>: from <from>, the way its Engine reaches <to>
peer_ssh() {
    rsh "$1" ssh -i "$ENGINE_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
        -o UserKnownHostsFile="$KH_FILE" -o HostKeyAlias="${ENGINE_ID[$2]}" -o ConnectTimeout=10 \
        "pi@${IPS[$2]}" "$3" </dev/null
}

# ── post-state and summary ───────────────────────────────────────────────────
post_state() {
    step "6 post-state"
    local i j bad out pre_auth now_auth failed
    for i in "${!NAMES[@]}"; do
        bad=()
        _settled() {
            out=$(rsh "$i" bash -s <<<"$ENGPROBE" 2>&1) || return 1
            [[ "$(sed -n 's/^AUTHSHA=//p' <<<"$out")" == "${AUTH_SHA[$i]}" && "$(sed -n 's/^KHSHA=//p' <<<"$out")" == "${KH_SHA[$i]}" ]]
        }
        poll 150 _settled || bad+=("peer files differ from the start of the run")
        echo "$out" > "$EVID/engine-post-${NAMES[$i]}.txt"
        [[ "$(sed -n 's/^PM2=//p' <<<"$out")" == online ]] || bad+=("pm2 engine is $(sed -n 's/^PM2=//p' <<<"$out")")
        [[ "$(sed -n 's/^CFGSHA=//p' <<<"$out")" == "${CFG_SHA[$i]}" ]] || bad+=("config.yaml differs from the start of the run")
        [[ "$(sed -n 's/^PEERACCESS=//p' <<<"$out")" == true ]] || bad+=("settings.peerAccess is not true")
        [[ -z "$(sed -n 's/^STALEH=//p' <<<"$out")" ]] || bad+=("peerStaleHours still set")
        [[ "$(sed -n 's/^LEFTOVER=//p' <<<"$out")" == no ]] || bad+=("$STATE still exists")
        [[ -z "$(rsh "$i" "ls -d /instances/pv-verify-* 2>/dev/null")" ]] || bad+=("a /instances/pv-verify-* folder is left")
        if dump "$i" --ops-since 0; then
            echo "$DUMP" > "$EVID/store-post-${NAMES[$i]}.json"
            pre_auth=$(jq -r --arg id "${ENGINE_ID[$i]}" '(.engineDB[$id].peerAccess.authorized // [])[]' "$EVID/store-pre-${NAMES[$i]}.json" | LC_ALL=C sort)
            now_auth=$(jq -r --arg id "${ENGINE_ID[$i]}" '(.engineDB[$id].peerAccess.authorized // [])[]' <<<"$DUMP" | LC_ALL=C sort)
            [[ "$pre_auth" == "$now_auth" ]] || bad+=("store peerAccess.authorized differs from the start")
            failed=$(jq '[.operations[]|select(.status=="Failed")]|length' <<<"$DUMP")
            (( failed <= ${OPS_FAILED_PRE[$i]:-0} )) || bad+=("Failed operations went from ${OPS_FAILED_PRE[$i]} to $failed")
            for j in "${!NAMES[@]}"; do
                [[ -n "$(jq -r --arg id "${ENGINE_ID[$j]}" '.engineDB[$id].lastRun // empty' <<<"$DUMP")" ]] || bad+=("no ${NAMES[$j]} entry")
            done
        else
            bad+=("cannot read the store")
        fi
        if (( ${#bad[@]} )); then result "6 post-state ${NAMES[$i]}" FAIL "$(IFS=';'; echo "${bad[*]}")"
        else result "6 post-state ${NAMES[$i]}" PASS "Engine online, config.yaml byte-identical (sha ${CFG_SHA[$i]:0:12}), peer files and store authorized as at start, no new Failed ops, no markers"; fi
    done
}

summary() {
    local rc=$1
    {
        echo
        echo "===== peer-verify summary ($RUN_ID) ====="
        echo "hosts: $(for i in "${!NAMES[@]}"; do printf '%s=%s(%s) ' "${NAMES[$i]}" "${IPS[$i]}" "${ENGINE_ID[$i]:-?}"; done)"
        awk -F'\t' '{ printf "%-7s %-28s %s\n", $2, $1, $3 }' "$RESULTS"
        printf 'PASS %s  FAIL %s  BLOCKED %s\n' "$(grep -c $'\tPASS\t' "$RESULTS")" "$(grep -c $'\tFAIL\t' "$RESULTS")" "$(grep -c $'\tBLOCKED\t' "$RESULTS")"
        (( REVERT_RC == 0 )) || echo "REVERT INCOMPLETE: markers left in $STATE on a Pi; re-run the same command to finish the revert"
        echo "evidence: $EVID"
    } | tee "$EVID/summary.txt"
    if (( REVERT_RC )); then exit 4; fi
    if (( rc == 2 || rc == 3 )); then exit "$rc"; fi
    if (( FAILS )); then exit 1; fi
    (( rc == 0 )) || exit 1
    exit 0
}

# ── preflight: identity (read-only) ──────────────────────────────────────────
declare -a DISKS_ROOT CFG_SHA AUTH_SHA KH_SHA OPS_FAILED_PRE
step "preflight: identity of ${NAMES[*]}"
# shellcheck disable=SC2016  # expands on the Pi
IDPROBE='echo "HOST=$(hostname)"; echo "TSIP=$(tailscale ip -4 2>/dev/null | head -1)"; echo "META=$(sudo -n sed -n "s/^diskId: *\"\{0,1\}\([^\"]*\)\"\{0,1\} *$/\1/p" /META.yaml 2>/dev/null | head -1)"; grep -E "^ *httpPort:" '"$ENGINE_DIR"'/config.yaml | head -1 | sed "s/^ *httpPort: *\([0-9]*\).*/HTTP=\1/"'
for i in "${!NAMES[@]}"; do
    probe=$(rsh "$i" "$IDPROBE" 2>"$EVID/ssh-${NAMES[$i]}.err") || { echo "cannot ssh to ${NAMES[$i]} (${IPS[$i]}): $(cat "$EVID/ssh-${NAMES[$i]}.err")" >&2; exit 3; }
    echo "$probe" > "$EVID/identity-${NAMES[$i]}.txt"
    host=$(sed -n 's/^HOST=//p' <<<"$probe"); tsip=$(sed -n 's/^TSIP=//p' <<<"$probe")
    meta=$(sed -n 's/^META=//p' <<<"$probe"); hp=$(sed -n 's/^HTTP=//p' <<<"$probe")
    [[ "${host,,}" != *"$FORBIDDEN_NAME"* ]] || refuse "${IPS[$i]} reports hostname '$host' (idea02)"
    [[ "$tsip" != "$FORBIDDEN_IP" ]] || refuse "${IPS[$i]} reports Tailscale IP $tsip (idea02)"
    [[ "$host" == "${NAMES[$i]}" ]] || refuse "${IPS[$i]} reports hostname '$host', expected ${NAMES[$i]}"
    [[ -z "$tsip" || "$tsip" == "${IPS[$i]}" ]] || refuse "${NAMES[$i]} reports Tailscale IP $tsip, expected ${IPS[$i]}"
    HTTP_PORT[i]=${hp:-80}
    dump "$i" --ops-since 0 || { echo "cannot read the store of ${NAMES[$i]} (http://${IPS[$i]}:${HTTP_PORT[$i]}/api/store-url)" >&2; exit 3; }
    echo "$DUMP" > "$EVID/store-pre-${NAMES[$i]}.json"
    badids=$(jq -r --arg f "$FORBIDDEN_NAME" '.engineDB|to_entries[]|select((.value.hostname//"")|ascii_downcase|contains($f))|.key' <<<"$DUMP")
    ids=$(jq -r --arg h "$host" '.engineDB|to_entries|map(select(.value.hostname==$h))|sort_by(.value.lastRun // 0)|reverse|.[].key' <<<"$DUMP")
    id=$(head -1 <<<"$ids")
    [[ -n "$id" ]] || refuse "no Engine entry with hostname $host in the store of ${NAMES[$i]}"
    [[ -z "$meta" || "ENGINE_$meta" == "$id" ]] || refuse "${NAMES[$i]}: /META.yaml says ENGINE_$meta but the store entry for $host is $id"
    if [[ "${id,,}" == *"$FORBIDDEN_NAME"* ]] || grep -qxF "$id" <<<"$badids"; then refuse "${NAMES[$i]} resolves to Engine $id, an idea02 entry"; fi
    ENGINE_ID[i]=$id
    log "${NAMES[$i]} ${IPS[$i]}: hostname $host, Engine $id${meta:+ (/META.yaml agrees)}, store $(jq -r .docId <<<"$DUMP"), http ${HTTP_PORT[$i]}"
    [[ $(wc -l <<<"$ids") -le 1 ]] || log "  note: older store entries also claim hostname $host: $(tail -n +2 <<<"$ids" | tr '\n' ' ')"
    [[ -z "$badids" ]] || log "  note: idea02 store entries (forbidden ids): $(tr '\n' ' ' <<<"$badids")"
done
for i in "${!NAMES[@]}"; do
    for j in "${!NAMES[@]}"; do
        (( i == j )) || [[ "${ENGINE_ID[$i]}" != "${ENGINE_ID[$j]}" ]] || refuse "${NAMES[$i]} and ${NAMES[$j]} resolve to the same Engine ${ENGINE_ID[$i]}"
    done
done

# Engine state (read-only)
ENGPROBE=$(cat <<RS
cd $ENGINE_DIR || exit 1
echo "HEAD=\$(git rev-parse HEAD)"
git merge-base --is-ancestor $REQUIRED_COMMIT HEAD 2>/dev/null && echo HAS_COMMIT=yes || echo HAS_COMMIT=no
echo "STOREURL=\$(cat store-identity/store-url.txt 2>/dev/null)"
[ -e store-identity/store-url.restored ] && echo RESTORED=yes || echo RESTORED=no
echo "CFGSHA=\$(sha256sum config.yaml | cut -c1-64)"
echo "PEERACCESS=\$(sed -n 's/^  peerAccess: *\([a-z]*\).*/\1/p' config.yaml | head -1)"
echo "STALEH=\$(sed -n 's/^  peerStaleHours: *\([0-9.]*\).*/\1/p' config.yaml | head -1)"
echo "HB=\$(sed -n 's/^  heartbeatIntervalMs: *\([0-9]*\).*/\1/p' config.yaml | head -1)"
echo "AUTHSHA=\$(sha256sum $AUTH_FILE 2>/dev/null | cut -c1-64)"
echo "KHSHA=\$(sha256sum $KH_FILE 2>/dev/null | cut -c1-64)"
[ -d $STATE ] && echo LEFTOVER=yes || echo LEFTOVER=no
pm2 jlist | python3 -c '
import json,sys
for p in json.load(sys.stdin):
    if p["name"]=="engine":
        e=p["pm2_env"]; env=e.get("env",{})
        print("PM2=%s" % e["status"]); print("CWD=%s" % e["pm_cwd"]); print("LOG=%s" % e["pm_out_log_path"])
        print("DISKSROOT=%s" % env.get("IDEA_DISKS_ROOT","/disks"))'
RS
)
declare -a HB_MS
for i in "${!NAMES[@]}"; do
    out=$(rsh "$i" bash -s <<<"$ENGPROBE" 2>&1) || { echo "engine probe failed on ${NAMES[$i]}: $out" >&2; exit 3; }
    echo "$out" > "$EVID/engine-pre-${NAMES[$i]}.txt"
    g() { sed -n "s/^$1=//p" <<<"$out"; }
    [[ "$(g PM2)" == online && "$(g CWD)" == "$ENGINE_DIR" ]] || { echo "${NAMES[$i]}: pm2 'engine' is not online in $ENGINE_DIR (status $(g PM2), cwd $(g CWD))" >&2; exit 3; }
    LOG_PATH[i]=$(g LOG); DISKS_ROOT[i]=$(g DISKSROOT); CFG_SHA[i]=$(g CFGSHA); AUTH_SHA[i]=$(g AUTHSHA); KH_SHA[i]=$(g KHSHA)
    HB_MS[i]=$(g HB); HB_MS[i]=${HB_MS[$i]:-50000}
    eval "PRE_${i}_HEAD=\$(g HEAD) PRE_${i}_HAS=\$(g HAS_COMMIT) PRE_${i}_URL=\$(g STOREURL) PRE_${i}_RESTORED=\$(g RESTORED) PRE_${i}_PA=\$(g PEERACCESS) PRE_${i}_STALE=\$(g STALEH) PRE_${i}_LEFT=\$(g LEFTOVER)"
    OPS_FAILED_PRE[i]=$(jq '[.operations[]|select(.status=="Failed")]|length' "$EVID/store-pre-${NAMES[$i]}.json")
    log "${NAMES[$i]}: HEAD $(g HEAD | cut -c1-12), pm2 online, disks root ${DISKS_ROOT[$i]}, peerAccess '$(g PEERACCESS)', heartbeat ${HB_MS[$i]} ms, Failed ops in store ${OPS_FAILED_PRE[$i]}"
done
(( PREFLIGHT_ONLY )) && { log "preflight only: nothing changed"; exit 0; }

# leftovers from an aborted run are reverted first
STARTED_CHANGES=0
for i in "${!NAMES[@]}"; do
    v="PRE_${i}_LEFT"
    if [[ "${!v}" == yes ]]; then
        step "leftover $STATE on ${NAMES[$i]}: reverting the previous run first"
        STARTED_CHANGES=1; REVERTED=0; revert_all; REVERTED=0
        (( REVERT_RC == 0 )) || { echo "could not revert the previous run's leftovers; fix by hand" >&2; exit 4; }
        log "leftovers reverted; starting this run afresh"; sleep 1
        trap - EXIT; exec "$SELF" "${ORIG_ARGS[@]}"
    fi
done

STARTED_CHANGES=1   # from here on the EXIT trap reverts and checks the post-state

# ── 1 install ────────────────────────────────────────────────────────────────
if (( SKIP_INSTALL )); then result "1 install" BLOCKED "skipped (--skip-install)"; else
step "1 install"
INSTALL_PROBE=$(cat <<RS
set -u
v=\$(sudo -n $HELPER version 2>&1); echo "VERSION=\$v"
sudo -n /usr/sbin/sshd -t >/dev/null 2>&1 && echo SSHD_T=ok || echo "SSHD_T=\$(sudo -n /usr/sbin/sshd -t 2>&1 | head -3 | tr '\n' ' ')"
echo "AKF=\$(sudo -n /usr/sbin/sshd -T -C user=pi,host=localhost,addr=127.0.0.1 2>/dev/null | sed -n 's/^authorizedkeysfile //p')"
for p in $HELPER $GATE /etc/ssh/sshd_config.d/10-idea-peer.conf /etc/ssh/idea_authorized_keys $AUTH_FILE /etc/idea $KH_FILE /var/lib/idea-app-data /home/pi/.ssh $ENGINE_KEY $ENGINE_KEY.pub; do
    echo "STAT=\$(sudo -n stat -c '%U:%G %a %F' "\$p" 2>&1) \$p"
done
echo "SHA_HELPER=\$(sha256sum $HELPER | cut -c1-64)"
echo "SHA_GATE=\$(sha256sum $GATE | cut -c1-64)"
echo "SHA_DROPIN=\$(sha256sum /etc/ssh/sshd_config.d/10-idea-peer.conf | cut -c1-64)"
RS
)
want_sha() { git -C "$REPO_DIR" show "$REQUIRED_COMMIT:script/build_image_assets/$1" | sha256sum | cut -c1-64; }
W_HELPER=$(want_sha idea-app-data); W_GATE=$(want_sha idea-peer-gate); W_DROPIN=$(want_sha 10-idea-peer.conf)
declare -A WANT_STAT=(
    [$HELPER]="root:root 755 regular file" [$GATE]="root:root 755 regular file"
    [/etc/ssh/sshd_config.d/10-idea-peer.conf]="root:root 644 regular file"
    [/etc/ssh/idea_authorized_keys]="root:root 755 directory" [$AUTH_FILE]="root:root 644 regular file"
    [/etc/idea]="root:root 755 directory" [$KH_FILE]="root:root 644 regular file"
    [/var/lib/idea-app-data]="root:root 700 directory" [/home/pi/.ssh]="pi:pi 700 directory"
    [$ENGINE_KEY]="pi:pi 600 regular file" [$ENGINE_KEY.pub]="pi:pi 644 regular file")
for i in "${!NAMES[@]}"; do
    out=$(rsh "$i" bash -s <<<"$INSTALL_PROBE" 2>&1); echo "$out" > "$EVID/1-install-${NAMES[$i]}.txt"
    bad=()
    [[ "$(sed -n 's/^VERSION=//p' <<<"$out")" == "idea-app-data 2" ]] || bad+=("helper version: $(sed -n 's/^VERSION=//p' <<<"$out")")
    [[ "$(sed -n 's/^SSHD_T=//p' <<<"$out")" == ok ]] || bad+=("sshd -t: $(sed -n 's/^SSHD_T=//p' <<<"$out")")
    grep -q '/etc/ssh/idea_authorized_keys/%u' <<<"$(sed -n 's/^AKF=//p' <<<"$out")" || bad+=("AuthorizedKeysFile is '$(sed -n 's/^AKF=//p' <<<"$out")'")
    for p in "${!WANT_STAT[@]}"; do
        got=$(sed -n "s|^STAT=\(.*\) $p\$|\1|p" <<<"$out")
        [[ "$got" == "${WANT_STAT[$p]}" ]] || bad+=("$p is '$got', want '${WANT_STAT[$p]}'")
    done
    [[ "$(sed -n 's/^SHA_HELPER=//p' <<<"$out")" == "$W_HELPER" ]] || bad+=("installed helper differs from ${REQUIRED_COMMIT:0:7}")
    [[ "$(sed -n 's/^SHA_GATE=//p' <<<"$out")" == "$W_GATE" ]] || bad+=("installed gate differs from ${REQUIRED_COMMIT:0:7}")
    [[ "$(sed -n 's/^SHA_DROPIN=//p' <<<"$out")" == "$W_DROPIN" ]] || bad+=("installed sshd drop-in differs from ${REQUIRED_COMMIT:0:7}")
    v="PRE_${i}_HAS"; [[ "${!v}" == yes ]] || bad+=("Engine checkout does not contain ${REQUIRED_COMMIT:0:7}")
    v="PRE_${i}_PA"; [[ "${!v}" == true ]] || bad+=("config.yaml has no 'peerAccess: true' under settings (testMode turns key exchange off)")
    v="PRE_${i}_RESTORED"; [[ "${!v}" == no ]] || bad+=("store-identity/store-url.restored exists (peer access fails closed)")
    v="PRE_${i}_URL"; v0="PRE_0_URL"; [[ -n "${!v}" && "${!v}" == "${!v0}" ]] || bad+=("store-url.txt '${!v}' differs from ${NAMES[0]}'s '${!v0}'")
    [[ -n "$(jq -r --arg id "${ENGINE_ID[$i]}" '.engineDB[$id].peerAccess.sshKey // empty' "$EVID/store-pre-${NAMES[$i]}.json")" ]] || bad+=("Engine has not published peerAccess in the store")
    if (( ${#bad[@]} )); then result "1 install ${NAMES[$i]}" FAIL "$(IFS=';'; echo "${bad[*]}")"
    else result "1 install ${NAMES[$i]}" PASS "helper 2, sshd -t ok, AuthorizedKeysFile has idea_authorized_keys/%u, 11 owners/modes ok, files = ${REQUIRED_COMMIT:0:7}, peerAccess: true, shared store"; fi
done
fi

# ── 2 peers ──────────────────────────────────────────────────────────────────
PEER_PROBE="sed -n '/^[^#]/p' $AUTH_FILE; echo '=====KH'; sed -n '/^[^#]/p' $KH_FILE; echo '=====PUB'; cat $ENGINE_KEY.pub; echo '=====HOST'; cat /etc/ssh/ssh_host_ed25519_key.pub"
declare -a P_AUTH P_KH P_PUB P_HOST
collect_peers() {  # collect_peers <idx> → P_* for that host
    local out
    out=$(rsh "$1" "$PEER_PROBE" 2>&1) || return 1
    P_AUTH[$1]=$(sed -n '1,/^=====KH$/p' <<<"$out" | sed '$d')
    P_KH[$1]=$(sed -n '/^=====KH$/,/^=====PUB$/p' <<<"$out" | sed '1d;$d')
    P_PUB[$1]=$(sed -n '/^=====PUB$/,/^=====HOST$/p' <<<"$out" | sed '1d;$d' | awk '{print $1" "$2}')
    P_HOST[$1]=$(sed -n '/^=====HOST$/,$p' <<<"$out" | sed '1d' | awk '{print $1" "$2}')
}
fp() { python3 -c 'import sys,base64,hashlib; print("SHA256:"+base64.b64encode(hashlib.sha256(base64.b64decode(sys.argv[1])).digest()).decode().rstrip("="))' "$1"; }
# peer_ids <idx> auth|kh|store → sorted Engine ids host idx lists
peer_ids() {
    case "$2" in
        auth) sed -n 's/.* idea-peer:\([^ ]*\)$/\1/p' <<<"${P_AUTH[$1]}" | LC_ALL=C sort ;;
        kh) awk 'NF {print $1}' <<<"${P_KH[$1]}" | LC_ALL=C sort ;;
        store) store_authorized "$1" "$1" | awk '{print $1}' ;;
    esac
}
if (( SKIP_PEERS )); then result "2 peers" BLOCKED "skipped (--skip-peers)"; else
step "2 peers"
for i in "${!NAMES[@]}"; do collect_peers "$i" || { result "2 peers ${NAMES[$i]}" FAIL "cannot read the peer files"; continue; }; done
for i in "${!NAMES[@]}"; do
    { echo "# authorized_keys"; echo "${P_AUTH[$i]}"; echo "# peer_known_hosts"; echo "${P_KH[$i]}"; echo "# engine key"; echo "${P_PUB[$i]}"; echo "# host key"; echo "${P_HOST[$i]}"; } > "$EVID/2-peers-${NAMES[$i]}.txt"
    bad=(); want_ids=(); want_auth=()
    for j in "${!NAMES[@]}"; do
        (( i == j )) && continue
        want_ids+=("${ENGINE_ID[$j]}")
        want_auth+=("${ENGINE_ID[$j]} $(fp "$(awk '{print $2}' <<<"${P_PUB[$j]}")") $(fp "$(awk '{print $2}' <<<"${P_HOST[$j]}")")")
        aline="restrict,command=\"$GATE ${ENGINE_ID[$j]}\" ${P_PUB[$j]} idea-peer:${ENGINE_ID[$j]}"
        grep -qxF "$aline" <<<"${P_AUTH[$i]}" || bad+=("authorized_keys lacks the exact gate line for ${NAMES[$j]} (${ENGINE_ID[$j]}) with its ${ENGINE_KEY##*/}.pub")
        grep -qxF "${ENGINE_ID[$j]} ${P_HOST[$j]}" <<<"${P_KH[$i]}" || bad+=("peer_known_hosts lacks ${NAMES[$j]}'s host key under ${ENGINE_ID[$j]}")
    done
    want=$(printf '%s\n' "${want_ids[@]}" | LC_ALL=C sort)
    for src in auth kh store; do
        got=$(peer_ids "$i" "$src")
        [[ "$got" == "$want" ]] || bad+=("$src lists [$(tr '\n' ' ' <<<"$got")] not exactly [$(tr '\n' ' ' <<<"$want")]")
        grep -qi "$FORBIDDEN_NAME" <<<"$got" && bad+=("$src names idea02")
    done
    [[ $(grep -c . <<<"${P_AUTH[$i]}") == "${#want_ids[@]}" ]] || bad+=("authorized_keys has $(grep -c . <<<"${P_AUTH[$i]}") key lines, want ${#want_ids[@]}")
    [[ $(grep -c . <<<"${P_KH[$i]}") == "${#want_ids[@]}" ]] || bad+=("peer_known_hosts has $(grep -c . <<<"${P_KH[$i]}") lines, want ${#want_ids[@]}")
    got_auth=$(store_authorized "$i" "$i"); want_auth_s=$(printf '%s\n' "${want_auth[@]}" | LC_ALL=C sort)
    echo "# store authorized"$'\n'"$got_auth"$'\n'"# expected"$'\n'"$want_auth_s" >> "$EVID/2-peers-${NAMES[$i]}.txt"
    [[ "$got_auth" == "$want_auth_s" ]] || bad+=("store peerAccess.authorized does not match the fingerprints of the peers' real keys")
    pub_store=$(jq -r --arg id "${ENGINE_ID[$i]}" '.engineDB[$id].peerAccess.sshKey // ""' <<<"$DUMP" | awk '{print $1" "$2}')
    [[ "$pub_store" == "${P_PUB[$i]}" ]] || bad+=("published sshKey differs from ${ENGINE_KEY##*/}.pub")
    if (( ${#bad[@]} )); then result "2 peers ${NAMES[$i]}" FAIL "$(IFS=';'; echo "${bad[*]}")"
    else result "2 peers ${NAMES[$i]}" PASS "exactly [$(tr '\n' ' ' <<<"$want" | sed 's/ $//')] in authorized_keys, peer_known_hosts and store; keys and fingerprints match"; fi
done
fi

# ── 3 copy ───────────────────────────────────────────────────────────────────
# Needs an Atlas-provided scratch App Disk on every host (nothing is created ad hoc):
# <disksRoot>/<scratch-slot>/ listed in /etc/idea/app-data-roots, META.yaml and a
# .peer-verify-scratch marker at its root, docked to that host's Engine, holding
# exactly one small instance (no pool fixture) whose app also exists on the others.
copy_blocked_reason() {
    local i reasons=() d n
    for i in "${!NAMES[@]}"; do
        d=$(slot_dir "$i")
        if ! rsh "$i" "grep -qxF '$d' /etc/idea/app-data-roots && test -f '$d/META.yaml' -a -f '$d/.peer-verify-scratch'" 2>/dev/null; then
            reasons+=("${NAMES[$i]}: no scratch disk at $d (bridged, META.yaml, .peer-verify-scratch)"); continue
        fi
        dump "$i" || { reasons+=("${NAMES[$i]}: store unreadable"); continue; }
        SCRATCH_DISK[i]=$(rsh "$i" "sed -n 's/^diskId: *\"\\{0,1\\}\\([^\"]*\\)\"\\{0,1\\} *\$/\\1/p' '$d/META.yaml'")
        dump "$i" --disks "${SCRATCH_DISK[$i]}" || { reasons+=("${NAMES[$i]}: store unreadable"); continue; }
        [[ "$(jq -r --arg d "${SCRATCH_DISK[$i]}" '.diskDB[$d].dockedTo // ""' <<<"$DUMP")" == "${ENGINE_ID[$i]}" ]] \
            || { reasons+=("${NAMES[$i]}: scratch disk ${SCRATCH_DISK[$i]} is not docked to ${ENGINE_ID[$i]}"); continue; }
        n=$(jq '.instanceDB|length' <<<"$DUMP")
        [[ "$n" == 1 ]] || { reasons+=("${NAMES[$i]}: scratch disk holds $n instance rows, want exactly 1"); continue; }
        SCRATCH_INST[i]=$(jq -r '.instanceDB|keys[0]' <<<"$DUMP")
    done
    (( ${#reasons[@]} == 0 )) || { (IFS=';'; echo "${reasons[*]}"); return 0; }
    return 1
}
declare -a SCRATCH_DISK SCRATCH_INST
LISTING='sudo -n find . \( -path ./compose.yaml -o -path ./.env \) -prune -o -printf "%U:%G %m %y %s %n %P -> %l\n" | LC_ALL=C sort; echo =====SHA; sudo -n find . -type f ! -path ./compose.yaml ! -path ./.env -printf "%P\0" | LC_ALL=C sort -z | sudo -n xargs -0 -r sha256sum'
copy_one() {  # copy_one <srcIdx> <tgtIdx>
    local a=$1 b=$2 tag="3 copy ${NAMES[$1]}->${NAMES[$2]}" pre_ops pre_inst op st new t0 marker
    dump "$a" --disks "${SCRATCH_DISK[$b]}" || { result "$tag" FAIL "store unreadable"; return; }
    [[ "$(jq -r --arg d "${SCRATCH_DISK[$b]}" '.diskDB[$d].dockedTo // ""' <<<"$DUMP")" == "${ENGINE_ID[$b]}" ]] \
        || { result "$tag" FAIL "${NAMES[$a]}'s store does not see ${SCRATCH_DISK[$b]} docked to ${NAMES[$b]}"; return; }
    pre_inst=$(jq -r '.instanceDB|keys[]' <<<"$DUMP")
    dump "$a" --ops-since $(( ($(now_s) - 900) * 1000 )); pre_ops=$(jq -r '.operations[].id' <<<"$DUMP")
    t0=$(now_s)
    store "$a" push-command "${ENGINE_ID[$a]}" "copyApp ${SCRATCH_INST[$a]} ${SCRATCH_DISK[$a]} ${SCRATCH_DISK[$b]}" >/dev/null \
        || { result "$tag" FAIL "cannot push copyApp"; return; }
    log "$tag: pushed copyApp ${SCRATCH_INST[$a]} ${SCRATCH_DISK[$a]} ${SCRATCH_DISK[$b]}"
    _op() {
        dump "$a" --ops-since $(( (t0 - 900) * 1000 )) --disks "${SCRATCH_DISK[$b]}" || return 1
        op=$(jq -c --arg i "${SCRATCH_INST[$a]}" --argjson pre "$(jq -R . <<<"$pre_ops" | jq -s .)" \
            '[.operations[]|select(.kind=="copyApp" and .args.instanceId==$i and ((.id|IN($pre[]))|not))][0] // empty' <<<"$DUMP")
        new=$(jq -r --argjson pre "$(jq -R . <<<"$pre_inst" | jq -s .)" '[.instanceDB|keys[]|select(IN($pre[])|not)]|.[]' <<<"$DUMP")
        if [[ -n "$new" ]]; then
            for n in $new; do rsh "$b" "mkdir -p $STATE && echo '${ENGINE_ID[$a]} ${ENGINE_ID[$b]} $SCRATCH_SLOT $n' > $STATE/copied.$n"; done
        fi
        st=$(jq -r '.status // empty' <<<"${op:-{\}}")
        [[ "$st" == Done || "$st" == Failed || "$st" == Cancelled ]]
    }
    if ! poll 300 _op; then result "$tag" FAIL "no finished copyApp operation within 300 s (op: ${op:-none}); see the Engine log"; return; fi
    echo "$op" > "$EVID/3-copy-${NAMES[$a]}-${NAMES[$b]}-op.json"
    [[ "$st" == Done ]] || { result "$tag" FAIL "copyApp $st: $(jq -r '.error // ""' <<<"$op")"; return; }
    [[ $(wc -w <<<"$new") == 1 ]] || { result "$tag" FAIL "expected one new instance on ${SCRATCH_DISK[$b]}, got [$new]"; return; }
    marker=$(slot_dir "$a")/instances/${SCRATCH_INST[$a]}
    rsh "$a" "cd '$marker' && { $LISTING; }" > "$EVID/3-copy-src-${NAMES[$a]}.txt" 2>&1
    rsh "$b" "cd '$(slot_dir "$b")/instances/$new' && { $LISTING; }" > "$EVID/3-copy-dst-${NAMES[$b]}-$new.txt" 2>&1
    if ! diff -u "$EVID/3-copy-src-${NAMES[$a]}.txt" "$EVID/3-copy-dst-${NAMES[$b]}-$new.txt" > "$EVID/3-copy-${NAMES[$a]}-${NAMES[$b]}.diff"; then
        result "$tag" FAIL "tree/owners/modes/sha256 differ (see 3-copy-${NAMES[$a]}-${NAMES[$b]}.diff)"; return
    fi
    rsh "$b" "test -f '$(slot_dir "$b")/instances/$new/compose.yaml'" || { result "$tag" FAIL "copy has no compose.yaml"; return; }
    result "$tag" PASS "op Done in $(( $(now_s) - t0 )) s, new instance $new; tree, owners, modes, links and sha256 equal ($(grep -c . "$EVID/3-copy-src-${NAMES[$a]}.txt") entries)"
    revert_copies
}
if (( SKIP_COPY )); then result "3 copy" BLOCKED "skipped (--skip-copy)"
else
    step "3 copy"
    if reason=$(copy_blocked_reason); then
        result "3 copy" BLOCKED "Atlas scratch disk missing: $reason"
    else
        for a in "${!NAMES[@]}"; do for b in "${!NAMES[@]}"; do (( a == b )) || copy_one "$a" "$b"; done; done
    fi
fi

# ── 4 refusals ───────────────────────────────────────────────────────────────
# Targets on the system root only (/instances, empty on the pool): a non-existent
# id for the ledger refusal, and a short-lived empty folder /instances/pv-verify-<run>
# for "existing folder" (marker written first; rmdir right after and in the trap).
refusals() {  # refusals <fromIdx> <toIdx>
    local a=$1 b=$2 tag="4 refusals ${NAMES[$1]}->${NAMES[$2]}" bad=() out rc since tmpid tmp
    tmpid="pv-verify-${RUN_ID//[^0-9]/}-$a$b"; tmp=/instances/$tmpid
    since=$(rsh "$b" "date '+%Y-%m-%d %H:%M:%S'")
    # control: the key works and the gate passes an allowed call
    out=$(peer_ssh "$a" "$b" "sudo -n $HELPER version" 2>&1); rc=$?
    echo "== version rc=$rc"$'\n'"$out" > "$EVID/4-refusals-${NAMES[$a]}-${NAMES[$b]}.txt"
    [[ $rc == 0 && "$out" == *"idea-app-data 2"* ]] || bad+=("control 'version' through the gate failed (rc $rc: ${out:0:120})")
    # a) plain command → gate refusal, exit 2, journal
    out=$(peer_ssh "$a" "$b" "id" 2>&1); rc=$?
    echo "== id rc=$rc"$'\n'"$out" >> "$EVID/4-refusals-${NAMES[$a]}-${NAMES[$b]}.txt"
    [[ $rc == 2 && "$out" == *"refused:"* ]] || bad+=("plain 'id' gave rc $rc: ${out:0:120}")
    [[ "$out" != *"uid="* ]] || bad+=("plain 'id' RAN on ${NAMES[$b]}")
    sleep 1
    out=$(rsh "$b" "journalctl -t idea-peer-gate --since '$since' --no-pager -o short-iso 2>/dev/null || sudo -n journalctl -t idea-peer-gate --since '$since' --no-pager -o short-iso")
    echo "== journal on ${NAMES[$b]} since $since"$'\n'"$out" >> "$EVID/4-refusals-${NAMES[$a]}-${NAMES[$b]}.txt"
    grep -q "refused peer=${ENGINE_ID[$a]} .*cmd=id " <<<"$out" || bad+=("no 'refused peer=${ENGINE_ID[$a]} … cmd=id' in journalctl -t idea-peer-gate on ${NAMES[$b]}")
    # b) remote delete of something this peer did not create (ledger refusal; nothing exists to lose)
    out=$(peer_ssh "$a" "$b" "sudo -n $HELPER delete system ${tmpid}x" 2>&1); rc=$?
    echo "== delete system ${tmpid}x (absent) rc=$rc"$'\n'"$out" >> "$EVID/4-refusals-${NAMES[$a]}-${NAMES[$b]}.txt"
    [[ $rc == 2 && "$out" == *"did not create"* ]] || bad+=("delete of a non-received id gave rc $rc: ${out:0:160}")
    # c) existing folder: marker, mkdir, refused delete + refused receive, rmdir
    if rsh "$b" "mkdir -p $STATE && echo $tmp > $STATE/tempdir.$tmpid && sudo -n mkdir -m 0755 -- $tmp && sudo -n chown pi:pi -- $tmp"; then
        out=$(peer_ssh "$a" "$b" "sudo -n $HELPER delete system $tmpid" 2>&1); rc=$?
        echo "== delete system $tmpid (exists) rc=$rc"$'\n'"$out" >> "$EVID/4-refusals-${NAMES[$a]}-${NAMES[$b]}.txt"
        [[ $rc == 2 && "$out" == *"did not create"* ]] || bad+=("delete of an existing non-received folder gave rc $rc: ${out:0:160}")
        rsh "$b" "test -d $tmp" || bad+=("the existing folder $tmp is GONE after a refused delete")
        out=$(peer_ssh "$a" "$b" "sudo -n $HELPER receive system $tmpid --server -logDtpre.iLsfxCIvu . ." 2>&1 </dev/null); rc=$?
        echo "== receive system $tmpid (exists) rc=$rc"$'\n'"$out" >> "$EVID/4-refusals-${NAMES[$a]}-${NAMES[$b]}.txt"
        [[ $rc == 2 && "$out" == *"already exists"* ]] || bad+=("receive into an existing folder gave rc $rc: ${out:0:160}")
        [[ -z "$(rsh "$b" "ls -A $tmp")" ]] || bad+=("$tmp is no longer empty")
        rsh "$b" "sudo -n rmdir -- $tmp && rm -f $STATE/tempdir.$tmpid && rmdir $STATE 2>/dev/null; true"
        rsh "$b" "test ! -e $tmp" || bad+=("cannot remove $tmp")
    else
        bad+=("cannot create the scratch folder $tmp on ${NAMES[$b]}")
    fi
    if (( ${#bad[@]} )); then result "$tag" FAIL "$(IFS=';'; echo "${bad[*]}")"
    else result "$tag" PASS "version ok; 'id' exit 2 + journal; delete → 'did not create' (absent and existing); receive into existing → 'already exists'"; fi
}
if (( SKIP_REFUSALS )); then result "4 refusals" BLOCKED "skipped (--skip-refusals)"
else
    step "4 refusals"
    for a in "${!NAMES[@]}"; do for b in "${!NAMES[@]}"; do (( a == b )) || refusals "$a" "$b"; done; done
fi

# ── 5 stale drop-out and return ──────────────────────────────────────────────
# present <i> <j>: "auth kh store log" flags (1 = host i still lists j)
present() {
    local i=$1 j=$2 a k s
    collect_peers "$i" || return 1
    a=$(peer_ids "$i" auth | grep -cxF "${ENGINE_ID[$j]}"); k=$(peer_ids "$i" kh | grep -cxF "${ENGINE_ID[$j]}")
    s=$(store_authorized "$i" "$i" | awk '{print $1}' | grep -cxF "${ENGINE_ID[$j]}")
    echo "$a $k $s"
}
LOG_OFF=0
log_since() { rsh "$1" "f='${LOG_PATH[$1]}'; s=\$(stat -c %s \"\$f\"); if [ \"\$s\" -ge $LOG_OFF ]; then tail -c +$((LOG_OFF + 1)) \"\$f\"; else cat \"\$f\"; fi"; }
stale() {
    local h1=0 h2=1 tag="5 stale" bad=() cfg="$ENGINE_DIR/config.yaml" lb t_stop t_drop t_start t_seen t_back lr p limit
    lb=$(engine_field "$h1" lastBooted)
    p=$(present "$h1" "$h2"); [[ "$p" == "1 1 1" ]] || { result "$tag" FAIL "precondition: ${NAMES[$h1]} does not list ${NAMES[$h2]} (auth kh store = $p)"; return; }
    # back up byte-exact, then set peerStaleHours: 0.05 under settings
    rsh "$h1" bash -s <<RS || { result "$tag" FAIL "cannot set peerStaleHours on ${NAMES[$h1]}"; return; }
set -e
mkdir -p $STATE
[ -f $STATE/config.orig ] || cp -p $cfg $STATE/config.orig
echo $cfg > $STATE/config.path
python3 - $cfg <<'PY'
import re, sys
p = sys.argv[1]
lines = open(p).read().split('\n')
i = next(k for k, l in enumerate(lines) if re.match(r'^settings:\s*(#.*)?$', l))
j = i + 1
while j < len(lines) and (lines[j].startswith((' ', '\t')) or not lines[j].strip()):
    j += 1
body = [k for k in range(i + 1, j) if lines[k].strip() and not lines[k].lstrip().startswith('#')]
indent = re.match(r'^(\s+)', lines[body[0]]).group(1) if body else '  '
new = indent + 'peerStaleHours: 0.05   # peer-verify (temporary; restored from ~/.peer-verify/config.orig)'
hit = [k for k in body if re.match(r'^\s+peerStaleHours\s*:', lines[k])]
if hit: lines[hit[0]] = new
else: lines.insert(i + 1, new)
open(p, 'w').write('\n'.join(lines))
PY
grep -n 'peerStaleHours' $cfg
LOGSIZE=\$(stat -c %s '${LOG_PATH[$h1]}'); echo "LOGSIZE=\$LOGSIZE" > $STATE/logsize
pm2 restart engine >/dev/null
RS
    LOG_OFF=$(rsh "$h1" "sed -n 's/^LOGSIZE=//p' $STATE/logsize; rm -f $STATE/logsize")
    log "${NAMES[$h1]}: peerStaleHours 0.05 set, pm2 restart engine"
    wait_engine_up "$h1" "$lb" 240 || { result "$tag" FAIL "${NAMES[$h1]}'s Engine did not come back after the restart"; return; }
    # stop host 2's Engine (marker first)
    lr=$(dump "$h1" && jq -r --arg id "${ENGINE_ID[$h2]}" '.engineDB[$id].lastRun' <<<"$DUMP")
    rsh "$h2" "mkdir -p $STATE && touch $STATE/engine-stopped && pm2 stop engine >/dev/null" || { result "$tag" FAIL "cannot stop ${NAMES[$h2]}'s Engine"; return; }
    t_stop=$(now_s); log "${NAMES[$h2]}: pm2 stop engine; waiting up to ${STALE_TIMEOUT}s for ${NAMES[$h1]} to drop it (stale after 180 s)"
    _dropped() { p=$(present "$h1" "$h2") && [[ "$p" == "0 0 0" ]] && log_since "$h1" | grep -q "peer key removed: Engine ${ENGINE_ID[$h2]} .*stale"; }
    if poll "$STALE_TIMEOUT" _dropped; then
        t_drop=$(now_s); log "${NAMES[$h1]} dropped ${NAMES[$h2]} $(( t_drop - t_stop )) s after the stop"
        log_since "$h1" | grep -E "peer access|peer key|sync-peers" > "$EVID/5-stale-${NAMES[$h1]}-dropout.log"
        cp "$EVID/2-peers-${NAMES[$h1]}.txt" "$EVID/5-stale-${NAMES[$h1]}-before.txt" 2>/dev/null
        { echo "${P_AUTH[$h1]}"; echo "# kh"; echo "${P_KH[$h1]}"; } > "$EVID/5-stale-${NAMES[$h1]}-dropped-files.txt"
    else
        bad+=("${NAMES[$h1]} did not drop ${NAMES[$h2]} within ${STALE_TIMEOUT}s (auth kh store = $p; log line $(log_since "$h1" | grep -c "peer key removed: Engine ${ENGINE_ID[$h2]}"))")
    fi
    # start host 2 again; it must return within one heartbeat of being seen
    rsh "$h2" "pm2 start engine >/dev/null && rm -f $STATE/engine-stopped && rmdir $STATE 2>/dev/null; true"
    t_start=$(now_s); log "${NAMES[$h2]}: pm2 start engine"
    _seen() { local l; l=$(dump "$h1" && jq -r --arg id "${ENGINE_ID[$h2]}" '.engineDB[$id].lastRun' <<<"$DUMP") && [[ -n "$l" && "$l" != "$lr" && "$l" != null ]]; }
    _back() { p=$(present "$h1" "$h2") && [[ "$p" == "1 1 1" ]]; }
    PV_POLL_SAVE=$PV_POLL; PV_POLL=2
    if poll 240 _seen; then
        t_seen=$(now_s)
        if poll 180 _back; then
            t_back=$(now_s); limit=$(( HB_MS[h1] / 1000 + 5 + 15 ))
            log "${NAMES[$h2]} seen in ${NAMES[$h1]}'s store $(( t_seen - t_start )) s after the start; peer key back $(( t_back - t_seen )) s later (limit $limit s)"
            (( t_back - t_seen <= limit )) || bad+=("return took $(( t_back - t_seen )) s after ${NAMES[$h2]} was seen, more than one heartbeat ($limit s)")
        else bad+=("${NAMES[$h1]} did not re-add ${NAMES[$h2]} within 180 s of seeing it (auth kh store = $p)"); fi
    else bad+=("${NAMES[$h2]}'s heartbeat never reached ${NAMES[$h1]}'s store within 240 s"); fi
    PV_POLL=$PV_POLL_SAVE
    log_since "$h1" | grep -E "peer access|peer key|sync-peers" > "$EVID/5-stale-${NAMES[$h1]}-peer-log.txt"
    # revert the setting and restart; the original state must come back
    lb=$(engine_field "$h1" lastBooted)
    revert_host "$h1"
    rsh "$h1" "grep -c peerStaleHours $cfg" >/dev/null 2>&1 && bad+=("peerStaleHours still in config.yaml after the revert")
    [[ "$(rsh "$h1" "sha256sum $cfg | cut -c1-64")" == "${CFG_SHA[$h1]}" ]] || bad+=("config.yaml not byte-identical after the revert")
    _orig() { local o; o=$(rsh "$h1" "sha256sum $AUTH_FILE $KH_FILE | cut -c1-64 | tr '\n' ' '") && [[ "$o" == "${AUTH_SHA[$h1]} ${KH_SHA[$h1]} " ]] && _back; }
    poll 120 _orig || bad+=("${NAMES[$h1]}'s peer files did not return to their start content within 120 s after the revert")
    if (( ${#bad[@]} )); then result "$tag" FAIL "$(IFS=';'; echo "${bad[*]}")"
    else result "$tag" PASS "${NAMES[$h1]} (peerStaleHours 0.05) dropped stopped ${NAMES[$h2]} after $(( t_drop - t_stop )) s (files, store, log); back $(( t_back - t_seen )) s after its heartbeat; config byte-identical and peer files as at start after the revert"; fi
}
if (( SKIP_STALE )); then result "5 stale" BLOCKED "skipped (--skip-stale)"
else
    step "5 stale: ${NAMES[0]} drops a stopped ${NAMES[1]}"
    stale
fi

exit 0
