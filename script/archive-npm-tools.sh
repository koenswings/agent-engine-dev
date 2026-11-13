#!/usr/bin/env bash
# Archive pnpm, pm2 and pm2-logrotate WITH their whole dependency trees for an offline install (idea#322).
# Each tool's tree is pinned by a committed lockfile (script/build_image_assets/npm-tools/<tool>/package-lock.json,
# integrity per package, nested "shallow" layout, linux/arm64). `npm ci` installs exactly that tree into a staging
# folder, then the tool is packed with bundleDependencies, so `npm install -g --offline <tgz>` (build-engine --root)
# and `pm2 install <tgz>` (first boot) need no registry. All packages are pure JS: any host works.
# Usage: script/archive-npm-tools.sh <tools-dir> <out-dir>
# Writes: <out>/<tool>-<version>.tgz and <out>/NPM-TOOLS.tsv (tool, version, tgz, sha256, lockfile sha256).
set -euo pipefail
tools=$(cd "${1:?tools dir}" && pwd); out=${2:?out dir}
mkdir -p "$out"; out=$(cd "$out" && pwd)
printf '# tool\tversion\ttgz\tsha256\tlockfile_sha256\n' > "$out/NPM-TOOLS.tsv"
for d in "$tools"/*/; do
  name=$(basename "$d")
  ver=$(node -p "require('$d/package.json').dependencies['$name']")
  stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
  cp "$d/package.json" "$d/package-lock.json" "$stage/"
  ( cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os linux --cpu arm64 --libc glibc >/dev/null )
  test "$(node -p "require('$stage/node_modules/$name/package.json').version")" = "$ver"
  # everything under the tool's own node_modules ships inside its tarball
  ( cd "$stage/node_modules/$name" && node -e '
      const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json"))
      const top = fs.existsSync("node_modules") ? fs.readdirSync("node_modules").filter(d => !d.startsWith(".")) : []
      p.bundleDependencies = top.flatMap(d => d.startsWith("@") ? fs.readdirSync("node_modules/" + d).map(x => d + "/" + x) : [d]).sort()
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n")' \
    && npm pack --ignore-scripts --loglevel=warn --pack-destination "$out" >/dev/null )
  tgz="$name-$ver.tgz"
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$ver" "$tgz" "$(sha256sum "$out/$tgz" | cut -d' ' -f1)" "$(sha256sum "$d/package-lock.json" | cut -d' ' -f1)" >> "$out/NPM-TOOLS.tsv"
  rm -rf "$stage"; trap - EXIT
done
