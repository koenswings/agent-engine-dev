#!/usr/bin/env bash
# test-preflight.sh — refuse to run Engine tests on a machine with a live Engine (idea#105).
#
# Tests must share nothing with a live Engine. Until the isolation measures of
# idea#105 are proven in practice, the test scripts also refuse to run at all
# when any sign of a live Engine is found:
#
#   1. pm2 process 'engine' is online (or any Engine process running dist/src/index.js)
#   2. live (non-test) Docker containers are running — test containers carry the
#      label org.idea.test=true; every other running container counts as live
#   3. /instances/* exist (system-disk app instances)
#   4. real App Disks are present (<name>/META.yaml or <name>/apps under /disks,
#      or sd* sentinels under /dev/engine)
#
# Override (at your own risk): IDEA_TEST_ALLOW_LIVE=1
#
# Exit codes: 0 = safe to run (or overridden), 1 = live Engine detected.
# Called by script/test-run.sh; can also be run standalone.

set -uo pipefail

LIVE_DISKS_ROOT=/disks
LIVE_WATCH_DIR=/dev/engine
TEST_LABEL=org.idea.test

findings=()

# ── 1. Engine process ──────────────────────────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
    # Only query pm2 when its daemon is already running: `pm2 jlist` would
    # otherwise spawn a new daemon as a side effect.
    pm2_home="${PM2_HOME:-$HOME/.pm2}"
    if [ -f "$pm2_home/pm2.pid" ] && kill -0 "$(cat "$pm2_home/pm2.pid" 2>/dev/null)" 2>/dev/null; then
        if pm2 jlist 2>/dev/null | node -e '
            let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
                let list = []; try { list = JSON.parse(s) } catch { process.exit(1) }
                process.exit(list.some(p => p.name === "engine" && p.pm2_env && p.pm2_env.status === "online") ? 0 : 1)
            })'; then
            findings+=("pm2 process 'engine' is online")
        fi
    fi
fi
# Also catch an Engine started under another user's pm2 or by hand: a node
# process whose command line runs .../dist/src/index.js.
engine_re='^(\S*/)?node(\s|$).*dist/src/index\.js'
if pgrep -f "$engine_re" >/dev/null 2>&1; then
    findings+=("an Engine process (node .../dist/src/index.js) is running: $(pgrep -af "$engine_re" | head -3 | tr '\n' ';')")
fi

# ── 2. Live (non-test) containers ──────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
    if ps_out=$(docker ps --format "{{.Names}}|{{.Label \"$TEST_LABEL\"}}" 2>/dev/null); then
        live_containers=$(printf '%s\n' "$ps_out" | awk -F'|' 'NF && $2 != "true" { print $1 }' | tr '\n' ' ')
        if [ -n "${live_containers// /}" ]; then
            findings+=("live (non-test) containers are running: ${live_containers% }")
        fi
    fi
fi

# ── 3. System-disk instances ───────────────────────────────────────────────
if compgen -G '/instances/*' >/dev/null 2>&1; then
    findings+=("/instances/* exist: $(ls /instances | head -5 | tr '\n' ' ')")
fi

# ── 4. Real App Disks ──────────────────────────────────────────────────────
real_disks=()
if [ -d "$LIVE_DISKS_ROOT" ]; then
    for d in "$LIVE_DISKS_ROOT"/*/; do
        [ -d "$d" ] || continue
        name=$(basename "$d")
        [ "$name" = "old" ] && continue
        if [ -e "$d/META.yaml" ] || [ -d "$d/apps" ]; then
            real_disks+=("$LIVE_DISKS_ROOT/$name")
        fi
    done
fi
if [ -d "$LIVE_WATCH_DIR" ]; then
    for s in "$LIVE_WATCH_DIR"/sd*; do
        [ -e "$s" ] && real_disks+=("$s")
    done
fi
if [ ${#real_disks[@]} -gt 0 ]; then
    findings+=("App Disks are present: ${real_disks[*]}")
fi

# ── Verdict ────────────────────────────────────────────────────────────────
if [ ${#findings[@]} -eq 0 ]; then
    echo "Test pre-flight: no live Engine detected — OK"
    exit 0
fi

if [ "${IDEA_TEST_ALLOW_LIVE:-}" = "1" ]; then
    echo "Test pre-flight: live Engine detected, continuing because IDEA_TEST_ALLOW_LIVE=1:" >&2
    for f in "${findings[@]}"; do echo "  - $f" >&2; done
    exit 0
fi

echo "Test pre-flight: REFUSING to run tests — this machine looks like it runs a live Engine:" >&2
for f in "${findings[@]}"; do echo "  - $f" >&2; done
echo "" >&2
echo "Engine tests must share nothing with a live Engine (idea#105)." >&2
echo "Stop the live Engine / undock its disks, or run on a machine without one." >&2
echo "Override at your own risk with IDEA_TEST_ALLOW_LIVE=1." >&2
exit 1
