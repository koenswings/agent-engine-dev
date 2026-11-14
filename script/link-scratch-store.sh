#!/usr/bin/env bash
# link-scratch-store.sh — safely symlink config/store paths into a scratch Engine
# checkout (engine#321).
#
#   script/link-scratch-store.sh --from <live-tree> --to <scratch-tree> [name ...]
#   script/link-scratch-store.sh <source> <dest>
#
# The default names in --from/--to mode are config.yaml, store-identity and
# store-data. Each destination is created or replaced with `ln -sfnT` (treat
# the dest as a symlink to replace, never as a directory to link into).
#
# If the destination already exists as a non-symlink directory, the script
# refuses and leaves it untouched. Plain `ln -sfn` into an existing
# store-identity/ directory would nest the link
# (store-identity/store-identity → <live>/store-identity) and the Engine
# could pair the checkout's own store-url with the shared store-data.
#
# Names in --from/--to mode must be basenames (no / or ..).
# Exit: 0 ok, 2 usage or refused.
set -euo pipefail

usage() {
    echo "usage: $0 --from <live-tree> --to <scratch-tree> [name ...]" >&2
    echo "       $0 <source> <dest>" >&2
    exit 2
}

link_one() {
    local src=$1 dest=$2
    if [[ -z "$src" || -z "$dest" ]]; then
        usage
    fi
    if [[ ! -e "$src" && ! -L "$src" ]]; then
        echo "link-scratch-store: source does not exist: $src" >&2
        return 2
    fi
    # Refuse a real directory: ln -sfnT would fail, and ln -sfn would nest.
    if [[ -e "$dest" && ! -L "$dest" && -d "$dest" ]]; then
        echo "link-scratch-store: refuse: destination exists as a non-symlink directory: $dest" >&2
        echo "link-scratch-store: using ln -sfn into a directory would nest the link (engine#321)." >&2
        return 2
    fi
    ln -sfnT -- "$src" "$dest"
}

from=""
to=""
positional=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --from)
            [[ $# -ge 2 ]] || usage
            from=$2
            shift 2
            ;;
        --to)
            [[ $# -ge 2 ]] || usage
            to=$2
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        --)
            shift
            positional+=("$@")
            break
            ;;
        -*)
            echo "link-scratch-store: unknown option: $1" >&2
            usage
            ;;
        *)
            positional+=("$1")
            shift
            ;;
    esac
done

if [[ -n "$from" || -n "$to" ]]; then
    [[ -n "$from" && -n "$to" ]] || usage
    [[ -d "$from" ]] || { echo "link-scratch-store: --from is not a directory: $from" >&2; exit 2; }
    [[ -d "$to" ]] || { echo "link-scratch-store: --to is not a directory: $to" >&2; exit 2; }
    names=("${positional[@]}")
    if [[ ${#names[@]} -eq 0 ]]; then
        names=(config.yaml store-identity store-data)
    fi
    # Validate every name and destination first, then link, so a refusal
    # cannot leave a half-linked scratch tree.
    for name in "${names[@]}"; do
        if [[ -z "$name" || "$name" == "." || "$name" == ".." || "$name" == *"/"* ]]; then
            echo "link-scratch-store: name must be a basename (no / or ..): $name" >&2
            exit 2
        fi
        src="$from/$name"
        dest="$to/$name"
        if [[ ! -e "$src" && ! -L "$src" ]]; then
            echo "link-scratch-store: source does not exist: $src" >&2
            exit 2
        fi
        if [[ -e "$dest" && ! -L "$dest" && -d "$dest" ]]; then
            echo "link-scratch-store: refuse: destination exists as a non-symlink directory: $dest" >&2
            echo "link-scratch-store: using ln -sfn into a directory would nest the link (engine#321)." >&2
            exit 2
        fi
    done
    for name in "${names[@]}"; do
        link_one "$from/$name" "$to/$name" || exit 2
    done
    exit 0
fi

if [[ ${#positional[@]} -ne 2 ]]; then
    usage
fi
link_one "${positional[0]}" "${positional[1]}" || exit 2
