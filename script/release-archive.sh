#!/usr/bin/env bash
# release-archive.sh — package an input archive as GitHub release assets (idea#322).
#
# Usage: script/release-archive.sh <tag> <commit> <archive-dir> <release-dir> [--repo owner/name]
# Writes into <release-dir> (must not exist):
#   <tag>.tar.part-NN   the archive as one tar split into <2 GB parts (GitHub's per-asset limit is 2 GiB)
#   SHA256SUMS          sha256 of every part and of the whole tar
#   RELEASE-NOTES.md    what is in it and how to restore it
#   gh-commands.sh      the exact tag + release + upload commands. NOT RUN: they need Koen's go.
# It never creates a tag or a release itself.
set -euo pipefail
tag=${1:?tag}; commit=${2:?commit}; src=${3:?archive dir}; out=${4:?release dir}; shift 4
repo=koenswings/agent-engine-dev
[ "${1:-}" = --repo ] && repo=$2
[ -d "$src" ] || { echo "no archive dir $src" >&2; exit 2; }
[ -e "$out" ] && { echo "refusing: $out exists" >&2; exit 2; }
mkdir -p "$out"
part_size=${PART_SIZE:-1900m}
tar -C "$(dirname "$src")" -cf - "$(basename "$src")" | tee >(sha256sum | sed "s/-\$/$tag.tar/" > "$out/.whole") \
  | split -b "$part_size" -d -a 2 - "$out/$tag.tar.part-"
sleep 1
( cd "$out" && sha256sum "$tag".tar.part-* && cat .whole ) > "$out/SHA256SUMS" && rm -f "$out/.whole"
{
  echo "# $tag"
  echo
  echo "Input archive for Engine commit \`$commit\` (idea#322). Built by \`script/release-archive.sh\`."
  echo
  echo "Restore: download all parts and SHA256SUMS, then"
  echo
  echo '```'
  echo "sha256sum -c --ignore-missing SHA256SUMS"
  echo "cat $tag.tar.part-* > $tag.tar && grep \" $tag.tar\$\" SHA256SUMS | sha256sum -c - && tar -xf $tag.tar"
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
# NOT RUN. Needs Koen's go (idea#322). Run from a checkout of $repo with gh authenticated.
set -euo pipefail
cd "\$(dirname "\$0")"
# 1. annotated tag on the existing commit, pushed on its own (no branch push)
git -C "\${REPO_DIR:?set REPO_DIR to a $repo checkout}" tag -a $tag $commit -m "$tag: input archive for $commit (idea#322)"
git -C "\$REPO_DIR" push origin refs/tags/$tag
# 2. release on that tag with the parts, sums and notes
gh release create $tag --repo $repo --verify-tag --title "$tag" --notes-file RELEASE-NOTES.md
gh release upload $tag --repo $repo SHA256SUMS $parts
# 3. check
gh release view $tag --repo $repo --json assets -q '.assets[].name'
CMD
chmod +x "$out/gh-commands.sh"
echo "$out"; ls -la "$out"
