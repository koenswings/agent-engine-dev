#!/usr/bin/env bash
# capture-engine-record.sh — READ-ONLY capture of an Engine install (idea#322).
#
# Writes a deployment record (see src/install/deploymentRecord.ts) into its own
# output folder under /tmp and nothing else. It installs nothing, restarts
# nothing, needs no sudo, and never reads secret files (/etc/tailscale,
# ~/.ssh, store-identity keys, .env). Safe to run on a field / kit Engine.
#
# Usage: capture-engine-record.sh [--engine-dir DIR] [--console-dir DIR] [--out /tmp/DIR] [--label LABEL]
set -uo pipefail
engine_dir=/home/pi/idea/agents/agent-engine-dev
console_dir=/home/pi/idea/agents/agent-console-dev
label=$(date -u +%Y%m%dT%H%M%SZ)
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --engine-dir) engine_dir=$2; shift 2;;
    --console-dir) console_dir=$2; shift 2;;
    --out) out=$2; shift 2;;
    --label) label=$2; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
[ -n "$out" ] || out="/tmp/idea-record-$(hostname)-$label"
case "$(realpath -m "$out")" in /tmp/*) ;; *) echo "refusing: --out must be under /tmp" >&2; exit 2;; esac
[ -e "$out" ] && { echo "refusing: $out exists" >&2; exit 2; }
mkdir -p "$out"
v() { "$@" 2>/dev/null | head -1 | tr -d '\r' || true; }
g() { git -C "$1" "${@:2}" 2>/dev/null || true; }
{
  echo "schema=idea-deployment-record/1"
  echo "recordLabel=$label"
  echo "capturedUtc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "hostname=$(hostname)"
  echo "stickerName=$(cat /etc/idea/sticker-name 2>/dev/null || echo UNKNOWN)"
  echo "arch=$(uname -m)"
  echo "kernel=$(uname -r)"
  echo "osRelease=$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-UNKNOWN}")"
  echo "engineCommit=$(g "$engine_dir" rev-parse HEAD)"
  echo "engineBranch=$(g "$engine_dir" rev-parse --abbrev-ref HEAD)"
  echo "engineTag=$(g "$engine_dir" tag --points-at HEAD | sort | head -1)"
  echo "engineDirtyFiles=$(g "$engine_dir" status --porcelain --untracked-files=no | wc -l)"
  echo "engineSkipWorktree=$(g "$engine_dir" ls-files -v | grep -c '^S ' || true)"
  echo "consoleCommit=$(g "$console_dir" rev-parse HEAD)"
  echo "consoleDistSha256=$( [ -d "$console_dir/dist" ] && (cd "$console_dir/dist" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1) || echo UNKNOWN)"
  echo "lockfileSha256=$(sha256sum "$engine_dir/pnpm-lock.yaml" 2>/dev/null | cut -d' ' -f1)"
  echo "nodeVersion=$(v node --version)"
  echo "npmVersion=$(v npm --version)"
  echo "pnpmVersion=$(v pnpm --version)"
  echo "pm2Version=$(v pm2 --version)"
  echo "dockerVersion=$(v docker version --format '{{.Server.Version}}')"
  echo "tailscaleVersion=$(v tailscale version)"
  for h in idea-app-data idea-erase-disk idea-flash-card idea-write-card-timezone idea-write-home-engine idea-dhcp-vendor-class; do
    [ -f "/usr/local/sbin/$h" ] && echo "helper.$h=$(sha256sum "/usr/local/sbin/$h" | cut -d' ' -f1)"
  done
} > "$out/record.txt"
dpkg-query -W -f '${Package}\t${Version}\t${Architecture}\n' 2>/dev/null | sort > "$out/apt.txt"
: > "$out/images.txt"
if docker info >/dev/null 2>&1; then
  docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '<none>' | sort -u | while read -r ref; do
    docker image inspect --format "$ref"$'\t''{{.Id}}'$'\t''{{join .RepoDigests ","}}' "$ref" 2>/dev/null
  done | sort > "$out/images.txt"
fi
( cd "$engine_dir" 2>/dev/null && git ls-files -z | grep -zv '^store-identity/' | xargs -0 -r sha256sum 2>/dev/null | sort -k2 ) > "$out/files.sha256"
( cd "$engine_dir/dist" 2>/dev/null && find . -type f ! -name '*.map' -print0 | sort -z | xargs -0 -r sha256sum | sed 's#  \./#  #' ) > "$out/dist.sha256"
echo "$out"
