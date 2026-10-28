#!/usr/bin/env bash
# test-preflight-lib.sh — App Disk detection helpers for script/test-preflight.sh (idea#105).
#
# Sourced by test-preflight.sh and by test/automated/test-isolation.test.ts.
# Only defines functions; running it has no side effects.
#
# The Pi's own boot/root disk (e.g. sda with sda1=boot, sda2=root) also shows up
# in /dev/engine. Like the Engine (usbDeviceMonitor: `findmnt -n -o SOURCE /`),
# we identify the root device and exclude its whole disk and all its partitions,
# so a fleet Pi with the Engine stopped is not mistaken for one with App Disks.

# parent_disk_of <device-name> — pure name parsing, no system calls.
#   sda2 → sda, sda → sda, mmcblk0p2 → mmcblk0, nvme0n1p2 → nvme0n1, nvme0n1 → nvme0n1
#   Prints nothing for names it does not recognise.
parent_disk_of() {
    local name="${1##*/}"
    if [[ "$name" =~ ^(sd[a-z]+)[0-9]*$ ]]; then
        echo "${BASH_REMATCH[1]}"
    elif [[ "$name" =~ ^(mmcblk[0-9]+)(p[0-9]+)?$ ]]; then
        echo "${BASH_REMATCH[1]}"
    elif [[ "$name" =~ ^(nvme[0-9]+n[0-9]+)(p[0-9]+)?$ ]]; then
        echo "${BASH_REMATCH[1]}"
    fi
}

# root_disk_from_source <findmnt-source> — the disk holding / (e.g. /dev/sda2 → sda).
#   Resolves symlinks (e.g. /dev/disk/by-uuid/…), asks lsblk for the parent disk
#   and falls back to name parsing. Prints nothing for non-/dev sources
#   (overlay, tmpfs, …: containers/VMs) or when nothing can be resolved.
root_disk_from_source() {
    local src="${1%%\[*}"   # strip a btrfs "[/subvol]" suffix
    [[ "$src" == /dev/* ]] || return 0
    local dev
    dev=$(readlink -f "$src" 2>/dev/null) || dev="$src"
    [ -n "$dev" ] || dev="$src"
    local pk=""
    if [ -b "$dev" ] && command -v lsblk >/dev/null 2>&1; then
        pk=$(lsblk -no PKNAME "$dev" 2>/dev/null | head -n1 | tr -d '[:space:]')
        if [ -z "$pk" ] && [ "$(lsblk -dno TYPE "$dev" 2>/dev/null | tr -d '[:space:]')" = "disk" ]; then
            pk="${dev##*/}"
        fi
    fi
    [ -n "$pk" ] || pk=$(parent_disk_of "$dev")
    [ -n "$pk" ] && echo "$pk"
    return 0
}

# detect_root_disk — the disk holding / on this machine, or nothing if unknown.
detect_root_disk() {
    local src
    src=$(findmnt -n -o SOURCE / 2>/dev/null | head -n1) || src=""
    root_disk_from_source "$src"
}

# is_on_disk <device-name> <disk> — true if device is <disk> or one of its partitions.
is_on_disk() {
    local name="${1##*/}" disk="$2"
    [ -n "$disk" ] || return 1
    [ "$name" = "$disk" ] && return 0
    [[ "$name" =~ ^${disk}p?[0-9]+$ ]]
}

# preflight_is_block <path> — true if <path> is a block device. A function so tests can fake it.
preflight_is_block() { [ -b "$1" ]; }

# is_live_app_disk_link <link> <disks-root> — true when <link> resolves to a present block
#   device and that device, or one of its partitions, is mounted under <disks-root>
#   (mount table: $PREFLIGHT_MOUNTS, default /proc/mounts; \040 in mount points = space).
is_live_app_disk_link() {
    local link="$1" disks_root="${2%/}" dev name src mnt _rest
    dev=$(readlink -f "$link" 2>/dev/null) || return 1
    [ -n "$dev" ] && preflight_is_block "$dev" || return 1
    name="${dev##*/}"
    while read -r src mnt _rest; do
        [[ "$src" == /dev/* ]] || continue
        src=$(readlink -f "$src" 2>/dev/null || echo "$src")
        is_on_disk "${src##*/}" "$name" || continue
        mnt="${mnt//\\040/ }"
        [[ "$mnt" == "$disks_root" || "$mnt" == "$disks_root"/* ]] && return 0
    done < "${PREFLIGHT_MOUNTS:-/proc/mounts}"
    return 1
}

# find_app_disks <disks-root> <watch-dir> <root-disk>
#   Prints one line per App Disk found:
#     <disks-root>/<name>   folders with META.yaml or apps/ (except old/)
#     <watch-dir>/sd*       links that resolve to a present block device mounted
#                           under <disks-root> (agent-engine-dev#223: udev keeps stale
#                           links of an ejected, unmounted disk; those are not counted)
#   Devices on <root-disk> (the Pi's own disk) are skipped. An empty <root-disk>
#   excludes nothing.
find_app_disks() {
    local disks_root="$1" watch_dir="$2" root_disk="$3" d name s
    if [ -d "$disks_root" ]; then
        for d in "$disks_root"/*/; do
            [ -d "$d" ] || continue
            name=$(basename "$d")
            [ "$name" = "old" ] && continue
            is_on_disk "$name" "$root_disk" && continue
            if [ -e "$d/META.yaml" ] || [ -d "$d/apps" ]; then
                echo "$disks_root/$name"
            fi
        done
    fi
    if [ -d "$watch_dir" ]; then
        for s in "$watch_dir"/sd*; do
            [ -e "$s" ] || [ -L "$s" ] || continue
            is_on_disk "$(basename "$s")" "$root_disk" && continue
            is_live_app_disk_link "$s" "$disks_root" || continue
            echo "$s"
        done
    fi
}
