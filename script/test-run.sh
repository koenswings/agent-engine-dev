#!/usr/bin/env bash
# test-run.sh — run an Engine test suite fully isolated from any live Engine (idea#105).
#
# Usage: script/test-run.sh <suite> <test-subdir>
#   e.g. script/test-run.sh full automated
#        script/test-run.sh diagnostic diagnostic
#        script/test-run.sh cross-engine cross-engine
#
# What it does:
#   1. Forces IDEA_SYSTEM_DISK_SKIP=true (tests never register or restart the system disk)
#   2. Runs script/test-preflight.sh (refuses on a live Engine unless IDEA_TEST_ALLOW_LIVE=1)
#      — skipped for cross-engine, which talks to live fleet Engines by design
#   3. Compiles into dist-test/ (never dist/, which the live Engine runs from)
#   4. Creates a private per-run temp folder with its own watch folder
#      (IDEA_WATCH_DIR) and mount root (IDEA_DISKS_ROOT) — never /dev/engine or /disks
#   5. Runs vitest on dist-test/test/<test-subdir>/ and writes the log to
#      test/testresults/test-<suite>-<UTC timestamp>.log
#   6. Removes the private temp folder on exit

set -uo pipefail

SUITE="${1:?usage: script/test-run.sh <suite> <test-subdir>}"
SUBDIR="${2:?usage: script/test-run.sh <suite> <test-subdir>}"

cd "$(dirname "$0")/.."

export IDEA_SYSTEM_DISK_SKIP=true

TEST_MODE=true
PREFLIGHT=true
if [ "$SUITE" = "cross-engine" ]; then
    # Cross-engine tests drive live fleet Engines over SSH and connect to the
    # Engine on this machine; they run without testMode and without pre-flight.
    TEST_MODE=false
    PREFLIGHT=false
fi

if [ "$PREFLIGHT" = "true" ]; then
    bash script/test-preflight.sh || exit $?
fi

echo "Compiling into dist-test/ ..."
rm -rf dist-test
node_modules/.bin/tsc --outDir dist-test || { echo "Test build failed" >&2; exit 1; }

TEST_TMP=$(mktemp -d -t idea-test-XXXXXX) || { echo "mktemp failed" >&2; exit 1; }
export IDEA_WATCH_DIR="$TEST_TMP/watch"
export IDEA_DISKS_ROOT="$TEST_TMP/disks"
mkdir -p "$IDEA_WATCH_DIR" "$IDEA_DISKS_ROOT"
cleanup() { rm -rf "$TEST_TMP" 2>/dev/null || true; }
trap cleanup EXIT

if [ "$TEST_MODE" = "true" ]; then
    export IDEA_TEST_MODE=true
fi

mkdir -p test/testresults
OUT="test/testresults/test-$SUITE-$(date -u +%Y-%m-%d-%H%M).log"
{
    echo "Suite: test:$SUITE | $(date -u) | Branch: $(git branch --show-current) | Commit: $(git rev-parse --short HEAD)"
    echo "Isolation: IDEA_SYSTEM_DISK_SKIP=$IDEA_SYSTEM_DISK_SKIP IDEA_WATCH_DIR=$IDEA_WATCH_DIR IDEA_DISKS_ROOT=$IDEA_DISKS_ROOT build=dist-test"
    echo "---"
    node_modules/.bin/vitest run "dist-test/test/$SUBDIR/"
} 2>&1 | tee "$OUT"
RET=${PIPESTATUS[0]}
echo "Results written to $OUT"
exit "$RET"
