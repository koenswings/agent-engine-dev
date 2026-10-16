#!/usr/bin/env bash
# r86j: verdict for a run whose walker vanished (host reboot / hard freeze leaves no process to write one).
# Usage: check-run.sh RUN_ID  → prints RESULT; writes FAIL if the pid is gone and no RESULT.txt exists.
set -uo pipefail
EVID=/home/walker/duration-evidence/${1:?run id}
[ -s "$EVID/RESULT.txt" ] && { cat "$EVID/RESULT.txt"; exit 0; }
PID=$(cat "$EVID/run.pid" 2>/dev/null || echo 0)
if [ "$PID" != 0 ] && kill -0 "$PID" 2>/dev/null; then echo "RUNNING pid=$PID"; exit 0; fi
LAST=$(stat -c %y "$EVID/run.log" 2>/dev/null | cut -c1-19)
BOOT=$(uptime -s 2>/dev/null)
REASON="walker pid $PID gone with no verdict; run.log last written $LAST; host up since $BOOT"
printf 'FAIL step=? source=check-run\n%s\n' "$REASON" > "$EVID/RESULT.txt"
echo "{\"event\":\"duration_verdict\",\"ts\":\"$(date -u +%FT%TZ)\",\"status\":\"FAIL\",\"reason\":\"$REASON\",\"source\":\"check-run\"}" >> "$EVID/run.log"
cat "$EVID/RESULT.txt"
