#!/usr/bin/env bash
# idea-engine-firewall.sh — limit who may reach the Engine's ports (engine#582 step 5).
#
# For Ops, run as root on an Engine Pi. Only the Engine's TCP ports are filtered
# (default 80, 8080, 4321: Console/HTTP API, the HTTP API on 8080, the store WebSocket);
# everything else (ssh, mDNS, apps) is left as it is.
#
#   idea-engine-firewall.sh --dry-run [options]   print the ruleset, change nothing (no root needed)
#   idea-engine-firewall.sh apply [options]       load it; rolls back after 120 s unless confirmed
#   idea-engine-firewall.sh confirm               keep it: write the boot file and enable its unit
#   idea-engine-firewall.sh status                loaded / pending rollback / kept at boot
#   idea-engine-firewall.sh remove                unload, disable the unit, move the boot file aside
#
# Options:
#   --allow <cidr>           also accept this IPv4/IPv6 range (repeatable); added to
#                            /etc/idea/firewall-allow (one CIDR per line, # comments)
#   --ports <p,p,...>        Engine ports to filter (default 80,8080,4321)
#   --rollback-seconds <n>   apply: seconds before the automatic rollback (default 120)
#
# Accepted on the Engine ports: loopback; established/related; 10.42.0.0/16 (the Engine
# hotspot) plus the allow list; IPv6 link-local fe80::/10; Docker bridges (docker0, br-*);
# Tailscale (tailscale0) — only the ranges in /etc/idea/firewall-admins when that file
# exists. Everything else on those ports is dropped.
#
# nftables table: inet idea_engine_fw (its own table; other rules are never touched).
# Boot file: /etc/nftables.d/idea-engine-fw.nft, loaded by idea-engine-fw.service.
# Exit: 0 ok, 1 failed, 2 usage or bad input.
set -euo pipefail

TABLE=idea_engine_fw
ETC=${IDEA_FW_ETC:-/etc/idea}
NFT_DIR=${IDEA_FW_NFT_DIR:-/etc/nftables.d}
RUN_DIR=${IDEA_FW_RUN:-/run}
UNIT_DIR=${IDEA_FW_UNIT_DIR:-/etc/systemd/system}
BOOT_FILE=$NFT_DIR/idea-engine-fw.nft
UNIT=idea-engine-fw.service
PENDING=$RUN_DIR/idea-engine-fw.pending
PREVIOUS=$RUN_DIR/idea-engine-fw.previous.nft
HOTSPOT=10.42.0.0/16

die() { echo "idea-engine-firewall: $1" >&2; exit "${2:-1}"; }
usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

CMD=""
PORTS="80,8080,4321"
ROLLBACK=120
EXTRA_ALLOW=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) CMD=dry-run ;;
        apply|confirm|status|remove) [[ -z "$CMD" ]] || usage; CMD=$1 ;;
        --allow) [[ $# -ge 2 ]] || usage; EXTRA_ALLOW+=("$2"); shift ;;
        --ports) [[ $# -ge 2 ]] || usage; PORTS=$2; shift ;;
        --rollback-seconds) [[ $# -ge 2 ]] || usage; ROLLBACK=$2; shift ;;
        -h|--help) usage ;;
        *) die "unknown argument '$1'" 2 ;;
    esac
    shift
done
[[ -n "$CMD" ]] || usage

is_v4() {
    local re='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(/([0-9]{1,2}))?$'
    [[ $1 =~ $re ]] || return 1
    local i; for i in 1 2 3 4; do (( BASH_REMATCH[i] <= 255 )) || return 1; done
    [[ -z "${BASH_REMATCH[6]}" ]] || (( BASH_REMATCH[6] <= 32 ))
}
is_v6() {
    local re='^[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(/([0-9]{1,3}))?$'
    [[ $1 =~ $re ]] || return 1
    [[ -z "${BASH_REMATCH[2]}" ]] || (( BASH_REMATCH[2] <= 128 ))
}

# CIDRs from a file (one per line, # comments, blank lines ignored)
read_list() {
    local f=$1 line
    [[ -f "$f" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        line=${line%%#*}; line=${line//[[:space:]]/}
        [[ -n "$line" ]] && printf '%s\n' "$line"
    done < "$f"
}

check_cidrs() {
    local what=$1; shift
    local c; for c in "$@"; do
        is_v4 "$c" || is_v6 "$c" || die "$what: '$c' is not an IPv4 or IPv6 address or range" 2
    done
}

[[ "$PORTS" =~ ^[0-9]{1,5}(,[0-9]{1,5})*$ ]] || die "--ports: '$PORTS' must be a comma-separated list of port numbers" 2
if ! [[ "$ROLLBACK" =~ ^[0-9]{1,4}$ ]] || (( ROLLBACK < 30 )); then die "--rollback-seconds: a number of seconds, at least 30" 2; fi
check_cidrs "--allow" "${EXTRA_ALLOW[@]+"${EXTRA_ALLOW[@]}"}"

mapfile -t FILE_ALLOW < <(read_list "$ETC/firewall-allow")
mapfile -t ADMINS < <(read_list "$ETC/firewall-admins")
check_cidrs "$ETC/firewall-allow" "${FILE_ALLOW[@]+"${FILE_ALLOW[@]}"}"
check_cidrs "$ETC/firewall-admins" "${ADMINS[@]+"${ADMINS[@]}"}"

split_family() {   # $1 = 4|6, rest = cidrs → comma list of that family
    local fam=$1; shift; local out=() c
    for c in "$@"; do
        if [[ $fam == 4 ]] && is_v4 "$c"; then out+=("$c"); fi
        if [[ $fam == 6 ]] && ! is_v4 "$c" && is_v6 "$c"; then out+=("$c"); fi
    done
    local IFS=,; printf '%s' "${out[*]-}" | sed 's/,/, /g'
}

ruleset() {
    local allow=("$HOTSPOT" "${FILE_ALLOW[@]+"${FILE_ALLOW[@]}"}" "${EXTRA_ALLOW[@]+"${EXTRA_ALLOW[@]}"}")
    local a4 a6 adm4 adm6 ports
    a4=$(split_family 4 "${allow[@]}")
    a6=$(split_family 6 fe80::/10 "${allow[@]}")
    ports=${PORTS//,/, }
    echo "# idea-engine-firewall (engine#582): Engine ports $PORTS"
    echo "table inet $TABLE {"
    echo "    set allow4 { type ipv4_addr; flags interval; elements = { $a4 } }"
    echo "    set allow6 { type ipv6_addr; flags interval; elements = { $a6 } }"
    if [[ ${#ADMINS[@]} -gt 0 ]]; then
        adm4=$(split_family 4 "${ADMINS[@]}")
        adm6=$(split_family 6 "${ADMINS[@]}")
        [[ -n "$adm4" ]] && echo "    set admins4 { type ipv4_addr; flags interval; elements = { $adm4 } }"
        [[ -n "$adm6" ]] && echo "    set admins6 { type ipv6_addr; flags interval; elements = { $adm6 } }"
    fi
    echo "    chain input {"
    echo "        type filter hook input priority 0; policy accept;"
    echo "        tcp dport { $ports } jump engine_ports"
    echo "    }"
    echo "    chain engine_ports {"
    echo "        iif \"lo\" accept"
    echo "        ct state established,related accept"
    echo "        iifname \"docker0\" accept"
    echo "        iifname \"br-*\" accept"
    if [[ ${#ADMINS[@]} -gt 0 ]]; then
        [[ -n "${adm4:-}" ]] && echo "        iifname \"tailscale0\" ip saddr @admins4 accept"
        [[ -n "${adm6:-}" ]] && echo "        iifname \"tailscale0\" ip6 saddr @admins6 accept"
    else
        echo "        iifname \"tailscale0\" accept"
    fi
    echo "        ip saddr @allow4 accept"
    echo "        ip6 saddr @allow6 accept"
    echo "        counter drop"
    echo "    }"
    echo "}"
}

need_root() { [[ $(id -u) -eq 0 ]] || die "$CMD needs root (sudo)"; command -v nft >/dev/null || die "nft is not installed (apt install nftables)"; }
table_loaded() { nft list table inet "$TABLE" >/dev/null 2>&1; }

remember_allow() {   # --allow ranges are kept in the allow file for the next run
    [[ ${#EXTRA_ALLOW[@]} -gt 0 ]] || return 0
    mkdir -p "$ETC"
    local c; for c in "${EXTRA_ALLOW[@]}"; do
        grep -qxF "$c" "$ETC/firewall-allow" 2>/dev/null || echo "$c" >> "$ETC/firewall-allow"
    done
}

case "$CMD" in
dry-run)
    ruleset
    ;;
apply)
    need_root
    [[ ! -f "$PENDING" ]] || die "an earlier apply is still waiting for confirm or rollback; run 'confirm' or wait"
    tmp=$(mktemp)
    ruleset > "$tmp"
    nft -c -f "$tmp" || die "nft refused the ruleset (nothing changed)"
    if table_loaded; then nft list table inet "$TABLE" > "$PREVIOUS"; else : > "$PREVIOUS"; fi
    if table_loaded; then nft delete table inet "$TABLE"; fi
    nft -f "$tmp"
    mv "$tmp" "$RUN_DIR/idea-engine-fw.applied.nft"
    date +%s > "$PENDING"
    remember_allow
    # Automatic rollback unless confirmed in time (runs detached from this shell)
    nohup bash -c "
        sleep $ROLLBACK
        if [ -f '$PENDING' ]; then
            nft delete table inet $TABLE 2>/dev/null || true
            if [ -s '$PREVIOUS' ]; then nft -f '$PREVIOUS'; fi
            mv '$PENDING' '$PENDING.rolled-back'
            logger -t idea-engine-firewall 'not confirmed within $ROLLBACK s: rolled back'
        fi" >/dev/null 2>&1 &
    echo "Loaded table inet $TABLE. Check you can still open the Console and ssh in, then run:"
    echo "  sudo $0 confirm"
    echo "Without confirm it is rolled back in $ROLLBACK s."
    ;;
confirm)
    need_root
    [[ -f "$PENDING" ]] || die "nothing to confirm (no apply waiting)"
    table_loaded || die "table inet $TABLE is not loaded (rolled back?)"
    mv "$PENDING" "$PENDING.confirmed"
    mkdir -p "$NFT_DIR"
    { echo "#!/usr/sbin/nft -f"; nft list table inet "$TABLE"; } > "$BOOT_FILE.tmp"
    mv "$BOOT_FILE.tmp" "$BOOT_FILE"
    cat > "$UNIT_DIR/$UNIT.tmp" <<UNITEOF
[Unit]
Description=IDEA Engine port firewall (engine#582)
Wants=network-pre.target
Before=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet $TABLE
ExecStart=/usr/sbin/nft -f $BOOT_FILE
ExecStop=/usr/sbin/nft delete table inet $TABLE

[Install]
WantedBy=multi-user.target
UNITEOF
    mv "$UNIT_DIR/$UNIT.tmp" "$UNIT_DIR/$UNIT"
    systemctl daemon-reload
    systemctl enable "$UNIT" >/dev/null
    echo "Kept: $BOOT_FILE, loaded at boot by $UNIT."
    ;;
status)
    command -v nft >/dev/null || die "nft is not installed"
    if table_loaded; then echo "loaded: yes (table inet $TABLE)"; else echo "loaded: no"; fi
    if [[ -f "$PENDING" ]]; then echo "pending rollback: yes (applied at $(date -d "@$(cat "$PENDING")" '+%F %T'))"; else echo "pending rollback: no"; fi
    if [[ -f "$BOOT_FILE" ]]; then echo "kept at boot: yes ($BOOT_FILE)"; else echo "kept at boot: no"; fi
    echo "allow list: $ETC/firewall-allow (${#FILE_ALLOW[@]} entries); admins: $ETC/firewall-admins (${#ADMINS[@]} entries)"
    ;;
remove)
    need_root
    if [[ -f "$PENDING" ]]; then mv "$PENDING" "$PENDING.removed"; fi
    if table_loaded; then nft delete table inet "$TABLE"; fi
    if [[ -f "$UNIT_DIR/$UNIT" ]]; then
        systemctl disable "$UNIT" >/dev/null 2>&1 || true
        mv "$UNIT_DIR/$UNIT" "$UNIT_DIR/$UNIT.removed-$(date +%Y%m%d%H%M%S)"
        systemctl daemon-reload
    fi
    if [[ -f "$BOOT_FILE" ]]; then mv "$BOOT_FILE" "$BOOT_FILE.removed-$(date +%Y%m%d%H%M%S)"; fi
    echo "Removed table inet $TABLE; the boot file and unit were moved aside."
    ;;
esac
