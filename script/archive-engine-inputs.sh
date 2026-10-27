#!/usr/bin/env bash
# Archive the build inputs of one Engine commit so it can be rebuilt later (idea#322).
# Read-only towards the repo: it uses `git archive` of <commit> into a temp folder.
# Usage: script/archive-engine-inputs.sh <commit> <out-dir> [docker-image-ref ...]
# Env:   ARCHIVE_PACKAGES=<packages.tsv>  exact apt versions (an Engine record's packages.tsv) -> debs/
#        ARCHIVE_RPI_CURRENT="a b"       RPi-archive packages to keep at today's version   -> debs/
#        ARCHIVE_SNAPSHOT=<YYYYMMDDTHHMMSSZ> Debian snapshot (default: DEBIAN_SNAPSHOT of <commit>)
# Writes: <out>/source.tar, <out>/pnpm-store/ (pnpm fetch, linux/arm64),
#         <out>/node/node-v<ver>-linux-arm64.tar.xz (+ upstream SHASUMS256.txt),
#         <out>/npm-global/*.tgz (n, pnpm, pm2, pm2-logrotate),
#         <out>/docker/<name>.tar (linux/arm64, with RepoDigests), <out>/tailscale/ (pinned tarball),
#         <out>/debs/ (script/archive-debs.py), <out>/debs/docker/ (docker-pins.tsv),
#         <out>/SHA256SUMS and <out>/ARCHIVE.json.
set -euo pipefail
commit=${1:?commit}; out=${2:?out dir}; shift 2
repo=$(git rev-parse --show-toplevel)
full=$(git -C "$repo" rev-parse "$commit^{commit}")
mkdir -p "$out"/{node,npm-global,docker,src,tailscale}
git -C "$repo" archive --format=tar -o "$out/source.tar" "$full"
tar -xf "$out/source.tar" -C "$out/src"
node_ver=$(grep -oP "NODE_VERSION = '\K[0-9.]+" "$out/src/src/data/Engine.ts")
pnpm_ver=$(grep -oP "PNPM_VERSION = '\K[0-9.]+" "$out/src/src/data/Engine.ts" || true)
# 1. npm packages from the committed lockfile, for linux/arm64
( cd "$out/src" && printf 'supportedArchitectures:\n  os: [linux]\n  cpu: [arm64]\n  libc: [glibc]\n' >> pnpm-workspace.yaml
  npx -y "pnpm@${pnpm_ver:-10.33.0}" fetch --store-dir "$out/pnpm-store" )
# 2. Node arm64 tarball, checked against nodejs.org SHASUMS256
base="https://nodejs.org/dist/v${node_ver}"
curl -fsSL -o "$out/node/SHASUMS256.txt" "$base/SHASUMS256.txt"
curl -fsSL -o "$out/node/node-v${node_ver}-linux-arm64.tar.xz" "$base/node-v${node_ver}-linux-arm64.tar.xz"
( cd "$out/node" && grep " node-v${node_ver}-linux-arm64.tar.xz\$" SHASUMS256.txt | sha256sum -c - )
# 3. global npm tools (build-engine installs these unpinned at $commit; we record what we got)
( cd "$out/npm-global" && npm pack "pnpm@${pnpm_ver:-10.33.0}" n pm2 pm2-logrotate >/dev/null )
# 3b. Tailscale (pinned in Engine.ts since idea#322; older commits installed "latest")
ts_ver=$(grep -oP "TAILSCALE_VERSION = '\K[0-9.]+" "$out/src/src/data/Engine.ts" || true)
ts_sha=$(grep -oP "TAILSCALE_ARM64_SHA256 = '\K[0-9a-f]+" "$out/src/src/data/Engine.ts" || true)
if [ -n "$ts_ver" ]; then
  curl -fsSL -o "$out/tailscale/tailscale_${ts_ver}_arm64.tgz" "https://pkgs.tailscale.com/stable/tailscale_${ts_ver}_arm64.tgz"
  ( cd "$out/tailscale" && echo "$ts_sha  tailscale_${ts_ver}_arm64.tgz" | sha256sum -c - )
else
  echo "tailscale: $commit has no TAILSCALE_VERSION pin; not archived" > "$out/tailscale/NOT-PINNED.txt"
fi
# 3c. apt .debs: Debian from the snapshot, Raspberry Pi archive from upstream
snap=${ARCHIVE_SNAPSHOT:-$(grep -oP "DEBIAN_SNAPSHOT = '\K[0-9TZ]+" "$out/src/src/data/Engine.ts" || echo 20261026T000000Z)}
deb_args=()
[ -n "${ARCHIVE_PACKAGES:-}" ] && deb_args+=(--packages "$ARCHIVE_PACKAGES")
rpi_pins="$out/src/script/build_image_assets/apt-rpi-pins.tsv"
[ -z "${ARCHIVE_PACKAGES:-}" ] && [ -f "$rpi_pins" ] && grep -qv '^#' "$rpi_pins" && deb_args+=(--packages "$rpi_pins")
[ -n "${ARCHIVE_RPI_CURRENT:-}" ] && deb_args+=(--rpi-current $ARCHIVE_RPI_CURRENT)
python3 "$repo/script/archive-debs.py" --out "$out/debs" --snapshot "$snap" "${deb_args[@]}"
# 3d. Docker Engine debs (download.docker.com has no snapshots): exact files from docker-pins.tsv
dpins="$out/src/script/build_image_assets/docker-pins.tsv"
mkdir -p "$out/debs/docker"
if [ ! -f "$dpins" ]; then
  dpins="$repo/script/build_image_assets/docker-pins.tsv"
  echo "$commit has no docker-pins.tsv (Docker was installed unpinned); these are the pins of $(git -C "$repo" rev-parse --short HEAD)" > "$out/debs/docker/NOTE.txt"
fi
cp "$dpins" "$out/debs/docker/docker-pins.tsv"
grep -v '^#' "$dpins" | while IFS=$'\t' read -r pkg ver pool sha; do
  [ -n "$pkg" ] || continue
  f=$(basename "$pool")
  curl -fsSL -o "$out/debs/docker/$f" "https://download.docker.com/linux/debian/$pool"
  ( cd "$out/debs/docker" && echo "$sha  $f" | sha256sum -c - )
done
( cd "$out/debs/docker" && sha256sum *.deb > SHA256SUMS )
# 4. Docker images, linux/arm64
imgs=()
for ref in "$@"; do
  f="$out/docker/$(echo "$ref" | tr '/:@' '___').tar"
  if command -v docker >/dev/null; then
    docker pull -q --platform linux/arm64 "$ref" >/dev/null
    docker save -o "$f" "$ref"
    imgs+=("$ref $(docker image inspect --format '{{json .RepoDigests}}' "$ref")")
  else
    # no Docker on this host: crane (go-containerregistry) pulls the arm64 image as a docker-loadable tar
    idx=$(crane digest "$ref"); arm=$(crane digest --platform linux/arm64 "$ref")
    crane pull --platform linux/arm64 --format tarball "$ref" "$f"
    imgs+=("$ref index=$idx linux/arm64=$arm")
  fi
done
rm -rf "$out/src"
( cd "$out" && find . -type f ! -name SHA256SUMS ! -name ARCHIVE.json -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
node -e '
const [full,nv,pv,out,...imgs]=process.argv.slice(1);
const fs=require("fs");
const tg=fs.readdirSync(out+"/npm-global");
fs.writeFileSync(out+"/ARCHIVE.json",JSON.stringify({engineCommit:full,nodeVersion:nv,pnpmVersion:pv,npmGlobal:tg,dockerImages:imgs,createdUtc:new Date().toISOString()},null,2)+"\n")
' "$full" "$node_ver" "${pnpm_ver:-}" "$out" "${imgs[@]}"
du -sh "$out"
