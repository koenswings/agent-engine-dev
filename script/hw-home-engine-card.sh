#!/bin/bash
# hw-home-engine-card.sh: on-Pi hardware test for idea-write-home-engine (#213,
# idea#203 §2). Run on a POOL Pi (never golden idea02) against a client card that
# was just flashed and verified, sitting in a card reader. It proves:
#   1. refusals: BAD_ARGS (-part link, bad name), MEDIUM_SWAPPED (wrong device,
#      wrong size), MOUNTED (card partition 1 mounted), and that the system disk is
#      refused (SYSTEM_DISK / BOOT_DEVICE / NOT_REMOVABLE / BAD_ARGS). Every refusal
#      exits 2 and leaves the card unmounted and unchanged.
#   2. the write: idea-home.txt = "<name>.local\n" (exact bytes) in the ROOT of FAT
#      partition 1, no temp file left, every other file on partition 1 unchanged,
#      the other partitions' identity (UUID/LABEL/TYPE/size) unchanged, card unmounted.
#   3. the system disk is untouched: same lsblk/blkid facts, same /boot(/firmware)
#      file checksums, no idea-home.txt on / or /boot/firmware.
#
# Usage:
#   bash script/hw-home-engine-card.sh --card /dev/disk/by-id/<whole-card-link> \
#        [--name <engine-name>] [--helper <path>] [--evidence <dir>] [--dry-run]
#   --name     default: this Pi's hostname (lowercased)
#   --helper   default: /usr/local/sbin/idea-write-home-engine if installed, else this
#              checkout's script/build_image_assets/idea-write-home-engine
#   --dry-run  read-only: resolve and safety-check the card, print every step that
#              would run, run nothing as root, mount nothing, write nothing.
# Needs passwordless sudo (sudo -n) for mount/umount and the helper (not in dry-run).
# Exit: 0 PASS, 1 FAIL, 2 refused to start (bad args / unsafe target).
#
# Tool and path overrides (unit tests only): IDEA_HW_DEV_DIR, IDEA_HW_SYS_BLOCK,
# IDEA_HW_LSBLK, IDEA_HW_FINDMNT, IDEA_HW_BLKID, IDEA_HW_SUDO, IDEA_HW_BOOT_DIRS.
set -u
export LC_ALL=C

DEV_DIR=${IDEA_HW_DEV_DIR:-/dev}
BYID_DIR="$DEV_DIR/disk/by-id"
SYS_BLOCK=${IDEA_HW_SYS_BLOCK:-/sys/class/block}
LSBLK=${IDEA_HW_LSBLK:-lsblk}
FINDMNT=${IDEA_HW_FINDMNT:-findmnt}
BLKID=${IDEA_HW_BLKID:-blkid}
SUDO=${IDEA_HW_SUDO:-sudo -n}
BOOT_DIRS=${IDEA_HW_BOOT_DIRS:-/boot/firmware /boot}
HOME_FILE=idea-home.txt
ROOT=$(cd "$(dirname "$0")/.." && pwd)

CARD=""; NAME=""; HELPER=""; DRY=0; EVID=""
while [ $# -gt 0 ]; do
    case "$1" in
        --card) CARD=${2:-}; shift 2 ;;
        --name) NAME=${2:-}; shift 2 ;;
        --helper) HELPER=${2:-}; shift 2 ;;
        --evidence) EVID=${2:-}; shift 2 ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
die() { echo "REFUSE-START: $*" >&2; exit 2; }
[ -n "$CARD" ] || die "--card /dev/disk/by-id/<link> is required"
[ -n "$NAME" ] || NAME=$(hostname | tr 'A-Z' 'a-z')
if [ -z "$HELPER" ]; then
    if [ -x /usr/local/sbin/idea-write-home-engine ] && [ "$DRY" = 0 ]; then HELPER=/usr/local/sbin/idea-write-home-engine
    else HELPER="$ROOT/script/build_image_assets/idea-write-home-engine"; fi
fi
[ -f "$HELPER" ] || die "helper not found: $HELPER"
EVID=${EVID:-/tmp/hw-home-engine-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$EVID"
LOG="$EVID/run.log"
say() { echo "$*" | tee -a "$LOG"; }
FAILS=0
check() { if [ "$1" = 0 ]; then say "  PASS $2"; else say "  FAIL $2${3:+ ($3)}"; FAILS=$((FAILS+1)); fi; }

# ── Resolve and safety-check the target (read-only, also in dry-run) ────────
case "$CARD" in "$BYID_DIR"/*) ;; *) die "--card must be under $BYID_DIR" ;; esac
case "$CARD" in *-part[0-9]*) die "--card must be the whole-card link, not a -partN link" ;; esac
[ -L "$CARD" ] || die "$CARD is not a symlink"
DEV=$(readlink -f -- "$CARD")
DEVNAME=${DEV##*/}
case "$DEVNAME" in sd[a-z]|sd[a-z][a-z]|mmcblk[0-9]|mmcblk[0-9][0-9]) ;; *) die "$CARD resolves to $DEV, not a whole sdX/mmcblkN disk" ;; esac
[ ! -e "$SYS_BLOCK/$DEVNAME/partition" ] || die "$DEV is a partition"
SECTORS=$(cat "$SYS_BLOCK/$DEVNAME/size" 2>/dev/null) || die "no size for $DEV"
SIZE=$((SECTORS * 512))
case "$DEVNAME" in mmcblk*) P1="${DEV}p1" ;; *) P1="${DEV}1" ;; esac

parent_of() { local s pk; s=$(readlink -f -- "$1" 2>/dev/null || echo "$1"); pk=$($LSBLK -no PKNAME "$s" 2>/dev/null | head -n1 | tr -d ' '); [ -n "$pk" ] && echo "$pk" || echo "${s##*/}"; }
ROOTSRC=$($FINDMNT -n -o SOURCE --mountpoint / 2>/dev/null)
SYSDISK=$(parent_of "$ROOTSRC")
[ -n "$SYSDISK" ] || die "cannot find the system disk (findmnt /)"
[ "$SYSDISK" != "$DEVNAME" ] || die "$DEV holds / (system disk); refusing to test against it"
for b in $BOOT_DIRS; do
    s=$($FINDMNT -n -o SOURCE --mountpoint "$b" 2>/dev/null) || continue
    [ "$(parent_of "$s")" != "$DEVNAME" ] || die "$DEV holds $b (boot device)"
done
for part in $($LSBLK -lno NAME "$DEV" 2>/dev/null); do
    ! $FINDMNT -n --source "$DEV_DIR/$part" >/dev/null 2>&1 || die "$DEV_DIR/$part is mounted; unmount it first"
done
FST=$($BLKID -o value -s TYPE "$P1" 2>/dev/null)
[ "$FST" = vfat ] || die "partition 1 ($P1) is '${FST:-none}', not vfat: is this a freshly flashed client card?"
# a system-disk by-id link for the SYSTEM_DISK refusal (whole disk, first match)
SYSLINK=""
for l in "$BYID_DIR"/*; do
    [ -L "$l" ] || continue; case "$l" in *-part[0-9]*) continue ;; esac
    [ "$(readlink -f -- "$l")" = "$DEV_DIR/$SYSDISK" ] && { SYSLINK=$l; break; }
done
SYSSIZE=$(( $(cat "$SYS_BLOCK/$SYSDISK/size" 2>/dev/null || echo 0) * 512 ))
OTHER=sdz; [ "$DEVNAME" = sdz ] && OTHER=sdy

say "hw-home-engine-card on $(hostname) $(date -Iseconds)"
say "card=$CARD dev=$DEV size=$SIZE p1=$P1 ($FST) name=$NAME helper=$HELPER"
say "system disk=$SYSDISK (/ from $ROOTSRC) sysLink=${SYSLINK:-none} evidence=$EVID"

H() { $SUDO bash "$HELPER" "$@"; }
plan() {
    cat <<P
plan:
  snapshot system disk: lsblk -J -b -o NAME,SIZE,UUID,LABEL,FSTYPE,MOUNTPOINTS /dev/$SYSDISK; sha256 of files under: $BOOT_DIRS
  snapshot card: blkid of every partition; ro mount $P1, sha256 of every file
  refuse BAD_ARGS:       helper ${CARD}-part1 $DEV $SIZE $NAME
  refuse BAD_ARGS:       helper $CARD $DEV $SIZE Bad_Name
  refuse MEDIUM_SWAPPED: helper $CARD $DEV_DIR/$OTHER $SIZE $NAME
  refuse MEDIUM_SWAPPED: helper $CARD $DEV $((SIZE + 512)) $NAME
  refuse MOUNTED:        (ro mount $P1) helper $CARD $DEV $SIZE $NAME
  refuse system disk:    helper ${SYSLINK:-<none: skipped>} $DEV_DIR/$SYSDISK $SYSSIZE $NAME
  write:                 $SUDO bash $HELPER $CARD $DEV $SIZE $NAME
  verify: $HOME_FILE == "$NAME.local\\n" in root of $P1, no temp file, other files and partitions unchanged, card unmounted
  verify: system disk snapshot identical, no $HOME_FILE on / or $BOOT_DIRS
P
}
if [ "$DRY" = 1 ]; then plan | tee -a "$LOG"; say "DRY-RUN OK (nothing mounted, nothing written)"; exit 0; fi

# ── Real run ─────────────────────────────────────────────────────────────────
$SUDO true 2>/dev/null || die "needs passwordless sudo (sudo -n)"
MP=$(mktemp -d /tmp/hw-home-ro.XXXXXX)
cleanup() { mountpoint -q "$MP" && $SUDO umount "$MP"; rmdir "$MP" 2>/dev/null; true; }
trap cleanup EXIT
sys_snap() {
    lsblk -J -b -o NAME,SIZE,UUID,LABEL,FSTYPE,MOUNTPOINTS "/dev/$SYSDISK"
    for b in $BOOT_DIRS; do [ -d "$b" ] && $SUDO find "$b" -xdev -type f -exec sha256sum {} + 2>/dev/null | sort -k2; done
    true
}
card_parts() { for p in $(lsblk -lno NAME "$DEV" | tail -n +2); do echo "$p $($SUDO blkid -o export "/dev/$p" | grep -E '^(UUID|LABEL|TYPE|PARTUUID)=' | tr '\n' ' ') $(cat $SYS_BLOCK/$p/size)"; done; }
p1_files() { $SUDO mount -o ro "$P1" "$MP" && (cd "$MP" && $SUDO find . -type f -exec sha256sum {} + | sort -k2); $SUDO umount "$MP"; }
card_unmounted() { for p in $(lsblk -lno NAME "$DEV"); do findmnt -n --source "/dev/$p" >/dev/null && return 1; done; return 0; }

sys_snap > "$EVID/sys-before.txt"
card_parts > "$EVID/parts-before.txt"
p1_files > "$EVID/p1-before.txt" || die "cannot mount $P1 read-only"
grep -q " ./$HOME_FILE\$" "$EVID/p1-before.txt" && say "  note: $HOME_FILE already on the card before the write (not a fresh flash?)"

say "== refusals"
refusal() { # <expected-code-regex> <label> <helper args...>
    local want=$1 label=$2; shift 2
    local out rc; out=$(H "$@" 2>&1); rc=$?
    echo "\$ helper $* -> rc=$rc: $out" >> "$LOG"
    [ $rc = 2 ] && echo "$out" | grep -Eq "refused: ($want):"; check $? "$label refused ($want)" "rc=$rc $out"
}
refusal BAD_ARGS "partition link" "${CARD}-part1" "$DEV" "$SIZE" "$NAME"
refusal BAD_ARGS "bad name" "$CARD" "$DEV" "$SIZE" "Bad_Name"
refusal MEDIUM_SWAPPED "wrong device" "$CARD" "$DEV_DIR/$OTHER" "$SIZE" "$NAME"
refusal MEDIUM_SWAPPED "wrong size" "$CARD" "$DEV" "$((SIZE + 512))" "$NAME"
$SUDO mount -o ro "$P1" "$MP" && { refusal MOUNTED "card mounted" "$CARD" "$DEV" "$SIZE" "$NAME"; $SUDO umount "$MP"; } || check 1 "MOUNTED setup" "ro mount of $P1 failed"
if [ -n "$SYSLINK" ]; then refusal "SYSTEM_DISK|BOOT_DEVICE|NOT_REMOVABLE|BAD_ARGS" "system disk" "$SYSLINK" "$DEV_DIR/$SYSDISK" "$SYSSIZE" "$NAME"
else say "  SKIP system-disk refusal: no by-id link for /dev/$SYSDISK (e.g. NVMe); covered by the unit tests"; fi
p1_files > "$EVID/p1-after-refusals.txt"
cmp -s "$EVID/p1-before.txt" "$EVID/p1-after-refusals.txt"; check $? "refusals left partition 1 unchanged"
card_unmounted; check $? "card unmounted after refusals"

say "== write"
out=$(H "$CARD" "$DEV" "$SIZE" "$NAME" 2>&1); rc=$?
say "  helper rc=$rc: $out"
[ $rc = 0 ] && echo "$out" | grep -q "^ok: $HOME_FILE = $NAME.local"; check $? "helper wrote $HOME_FILE"
card_unmounted; check $? "card unmounted after the write"

say "== verify card"
$SUDO mount -o ro "$P1" "$MP" || die "cannot re-mount $P1"
printf '%s.local\n' "$NAME" > "$EVID/expected-home.txt"
$SUDO cat "$MP/$HOME_FILE" > "$EVID/got-home.txt" 2>/dev/null
cmp -s "$EVID/expected-home.txt" "$EVID/got-home.txt"; check $? "$HOME_FILE is exactly '$NAME.local\\n'" "got: $(od -c "$EVID/got-home.txt" | head -2 | tr -s ' ')"
[ "$($SUDO find "$MP" -name "$HOME_FILE" | wc -l)" = 1 ] && [ -f "$MP/$HOME_FILE" ]; check $? "$HOME_FILE only in the root of partition 1"
[ -z "$($SUDO find "$MP" -name ".$HOME_FILE.tmp")" ]; check $? "no temp file left"
$SUDO umount "$MP"
p1_files > "$EVID/p1-after.txt"
diff <(grep -v " ./$HOME_FILE\$" "$EVID/p1-before.txt") <(grep -v " ./$HOME_FILE\$" "$EVID/p1-after.txt") > "$EVID/p1-diff.txt"; check $? "every other file on partition 1 unchanged"
card_parts > "$EVID/parts-after.txt"
cmp -s "$EVID/parts-before.txt" "$EVID/parts-after.txt"; check $? "card partitions' UUID/LABEL/TYPE/size unchanged"

say "== verify system disk"
sys_snap > "$EVID/sys-after.txt"
diff "$EVID/sys-before.txt" "$EVID/sys-after.txt" > "$EVID/sys-diff.txt"; check $? "system disk lsblk + boot file checksums unchanged"
found=0; for d in / $BOOT_DIRS; do [ -e "$d/$HOME_FILE" ] && found=1; done
[ $found = 0 ]; check $? "no $HOME_FILE on / or $BOOT_DIRS"

if [ $FAILS = 0 ]; then say "RESULT: PASS (evidence $EVID)"; exit 0; fi
say "RESULT: FAIL ($FAILS checks, evidence $EVID)"; exit 1
