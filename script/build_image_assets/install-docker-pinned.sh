#!/bin/bash
# install-docker-pinned.sh — install the exact Docker Engine debs in docker-pins.tsv (idea#322).
#
# Usage (root): install-docker-pinned.sh <engine-dir>
# For each pinned package: use <engine-dir>/deb-cache/docker/<file> if present, else download the
# exact file from download.docker.com (no snapshots exist there). Every .deb is checked against
# its sha256 in docker-pins.tsv before anything is installed; any mismatch aborts.
# Other dependencies come from the (snapshot-pinned) Debian sources.
set -euo pipefail
engine=${1:?engine dir}
pins="$engine/script/build_image_assets/docker-pins.tsv"
cache="$engine/deb-cache/docker"
base=https://download.docker.com/linux/debian
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
debs=()
while IFS=$'\t' read -r pkg ver pool sha; do
  case "$pkg" in ''|'#'*) continue;; esac
  f=$(basename "$pool")
  if [ -f "$cache/$f" ]; then src="$cache/$f"; echo "docker: $pkg $ver from cache"
  else src="$work/$f"; echo "docker: $pkg $ver from $base/$pool"; curl -fsSL -o "$src" "$base/$pool"; fi
  echo "$sha  $src" | sha256sum -c --quiet - || { echo "sha256 mismatch for $f" >&2; exit 1; }
  debs+=("$src")
done < "$pins"
[ ${#debs[@]} -eq 5 ] || { echo "expected 5 Docker pins, got ${#debs[@]}" >&2; exit 1; }
DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "${debs[@]}"
apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
command -v systemctl >/dev/null && systemctl enable --now docker.service || true
docker version --format '{{.Server.Version}}' || true
