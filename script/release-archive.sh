#!/usr/bin/env bash
# release-archive.sh — package an input archive as GitHub release assets (idea#322).
#
# Usage: script/release-archive.sh <name> <commit> <archive-dir> <release-dir> [--repo owner/name] [--tag T] [--prerelease]
#   <name> names the asset files; --tag is the existing git tag the release attaches to (default <name>).
# Writes into <release-dir> (must not exist):
#   <tag>.tar.part-NN   the archive as one tar split into <2 GB parts (GitHub's per-asset limit is 2 GiB)
#   SHA256SUMS          sha256 of every part (the joined tar sum is in RELEASE-NOTES.md)
#   RELEASE-NOTES.md    what is in it and how to restore it
#   gh-commands.sh      the exact tag + release + upload commands. NOT RUN: they need Koen's go.
#   record-keys.txt     archiveBoxPath / archiveSha256 lines for deployment records
# It never creates a tag or a release itself.
set -euo pipefail
tag=${1:?tag}; commit=${2:?commit}; src=${3:?archive dir}; out=${4:?release dir}; shift 4
repo=koenswings/agent-engine-dev; reltag=$tag; pre=""
while [ $# -gt 0 ]; do case "$1" in
  --repo) repo=$2; shift 2;; --tag) reltag=$2; shift 2;; --prerelease) pre=" --prerelease"; shift;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[ -d "$src" ] || { echo "no archive dir $src" >&2; exit 2; }
[ -e "$out" ] && { echo "refusing: $out exists" >&2; exit 2; }
mkdir -p "$out"
part_size=${PART_SIZE:-200m}  # <2 GB GitHub limit; 1 GB uploads failed from the box (unexpected EOF)
tar -C "$(dirname "$src")" -cf - "$(basename "$src")" | tee >(sha256sum | sed "s/-\$/$tag.tar/" > "$out/.whole") \
  | split -b "$part_size" -d -a 2 - "$out/$tag.tar.part-"
sleep 1
( cd "$out" && sha256sum "$tag".tar.part-* ) > "$out/SHA256SUMS"
whole=$(cut -d' ' -f1 "$out/.whole"); rm -f "$out/.whole"
{
  echo "# $tag"
  echo
  echo "Input archive for Engine commit \`$commit\` (idea#322). Built by \`script/release-archive.sh\`."
  echo
  echo "Git tag: \`$reltag\`. SHA256SUMS lists the parts; the joined tar \`$tag.tar\` has sha256 \`$whole\`."
  echo
  echo "Restore: download all parts and SHA256SUMS, then"
  echo
  echo '```'
  echo "sha256sum -c SHA256SUMS        # the parts"
  echo "cat $tag.tar.part-* > $tag.tar && echo \"$whole  $tag.tar\" | sha256sum -c - && tar -xf $tag.tar"
  echo '```'
  echo
  echo "Inside: \`$(basename "$src")/\` with its own SHA256SUMS files (see docs/REPRODUCIBLE_BUILDS.md)."
  echo
  echo "Contents (top level):"
  echo
  ( cd "$src" && du -sh -- * 2>/dev/null | sed 's/^/    /' )
} > "$out/RELEASE-NOTES.md"
parts=$(cd "$out" && ls "$tag".tar.part-* | tr '\n' ' ')
cat > "$out/gh-commands.sh" <<CMD
#!/usr/bin/env bash
# Publishes the prepared assets on the EXISTING tag $reltag (this script creates no tag). Needs Koen's go.
set -euo pipefail
cd "\$(dirname "\$0")"
gh release create $reltag --repo $repo --verify-tag$pre --title "$tag" --notes-file RELEASE-NOTES.md
gh release upload $reltag --repo $repo SHA256SUMS $parts
gh release view $reltag --repo $repo --json assets -q '.assets[] | [.name, .size, .digest] | @tsv'
CMD
chmod +x "$out/gh-commands.sh"
# record lines for idea deployments/ records of installs built from this archive
{
  echo "archiveBoxPath=$(cd "$out" && pwd)"
  echo "archiveSha256=$(cd "$out" && sha256sum "$tag".tar.part-* | awk '{printf "%s%s:%s", (NR>1?",":""), $2, $1}')"
} > "$out/record-keys.txt"
echo "$out"; ls -la "$out"
