#!/usr/bin/env bash
# Walker-side detached launch. Usage: launch.sh RUN_ID [extra cli args...]
# Runs from idea02 only, on the pushed harness checkout; absolute paths throughout.
# Gate: store-check (store=3, queues=0, idea02 absent) must PASS before launch (READY gate, Atlas).
# Deviation: DURATION_DOC_WAIT_MS=45000 (idea02 Pi 4 doc load ~24-27 s; see DEVIATIONS.md).
# Deviation r86c: idea04 (Pi 4) store-ready wait 120 s (DURATION_DOC_WAIT_MS_IDEA04) and staggered walk-start connects (DURATION_CONNECT_STAGGER_MS, default 3 s); still fail-loud.
set -euo pipefail
RUN="${1:?run id}"; shift || true
REPO=/home/walker/agent-engine-stage2
EVID=/home/walker/duration-evidence/$RUN
[ "$(hostname)" = idea02 ] || { echo "REFUSE: walker host must be idea02"; exit 2; }
git -C "$REPO" diff --quiet || { echo "REFUSE: dirty harness tree"; exit 3; }
SHA=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" branch -r --contains "$SHA" | grep -q origin/ || { echo "REFUSE: $SHA not pushed"; exit 3; }
CONSOLE_PIN=a6b34449c84713094164e1ee11b40dd405b0e855  # Console PR #148 head (main merged in): e2e/intents == 4788cc4, src == pool fc8cf78 (index-Cy43iuhk.js) — idea#168 r87a store-growth proof
[ "$(git -C /home/walker/agent-console-dev rev-parse HEAD)" = "$CONSOLE_PIN" ] || { echo "REFUSE: console intents checkout is not $CONSOLE_PIN"; exit 3; }
git -C /home/walker/agent-console-dev diff --quiet || { echo "REFUSE: dirty console intents tree"; exit 3; }
mkdir -p "$EVID"; [ -f "$EVID/run.pid" ] && kill -0 "$(cat "$EVID/run.pid")" 2>/dev/null && { echo "REFUSE: already running"; exit 4; }
( cd "$REPO" && STORE_DOC="${STORE_DOC:-2VroEUvDkmYsDAwE5oG9YeFNadWH}" DURATION_DOC_WAIT_MS=45000 /usr/bin/env npx tsx script/idea02-walker/store-check.ts ) > "$EVID/store-check.txt" 2>&1 || { echo "REFUSE: store-check gate FAIL"; tail -8 "$EVID/store-check.txt"; exit 8; }
rm -f "$EVID/run.pid"
cat > "$EVID/run.sh" <<R
#!/usr/bin/env bash
cd $REPO
export DURATION_EVIDENCE_DIR=$EVID
export DURATION_FLEET_HOSTS=\${DURATION_FLEET_HOSTS:-idea01=10.99.0.11,idea03=10.99.0.13,idea04=10.99.0.14}
export DURATION_LAN_HOSTS=\${DURATION_LAN_HOSTS:-idea01=10.99.0.11,idea03=10.99.0.13,idea04=10.99.0.14}
export DURATION_CONSOLE_INTENTS=/home/walker/agent-console-dev/e2e/intents
export DURATION_STAGE=2
export DURATION_EXPECTED_CONSOLE_SHA=$CONSOLE_PIN
# Product pin = intents pin = a6b34449c84713094164e1ee11b40dd405b0e855 (#148 head); build byte-identical to pool fc8cf78.
export DURATION_CONSOLE_PRODUCT_SHA=a6b34449c84713094164e1ee11b40dd405b0e855
export DURATION_CONSOLE_PRODUCT_ASSET=index-Cy43iuhk.js
export DURATION_CONSOLE_PRODUCT_ASSET_MD5=17d2bcd596e66f0d8f7f63bce799eb81
export DURATION_EXPECTED_STORE_ID=2VroE
export DURATION_POST_OP_SETTLE_MS=\${DURATION_POST_OP_SETTLE_MS:-300000}
export DURATION_DOC_WAIT_MS=\${DURATION_DOC_WAIT_MS:-45000}
export DURATION_DOC_WAIT_MS_IDEA04=\${DURATION_DOC_WAIT_MS_IDEA04:-120000}
export DURATION_LOOP_STALL_MS=\${DURATION_LOOP_STALL_MS:-150000}
env | grep -E "^(DURATION|STAGE2)_" | sort > $EVID/ENV.txt
# r86j: no exec. If the walker dies without a verdict (SIGKILL, OOM, crash), write FAIL with the exit status.
/usr/local/bin/pnpm test:duration -- --live --ui --start-instances --scenario cover-all --fast --console-url http://idea01:8080 --record-walk $EVID/walk "\$@"
rc=\$?
if [ ! -s $EVID/RESULT.txt ]; then
  printf 'FAIL step=? source=run.sh\nwalker exited rc=%s without a verdict (SIGKILL/OOM/crash; see dmesg)\n' "\$rc" > $EVID/RESULT.txt
  echo "{\"event\":\"duration_verdict\",\"ts\":\"\$(date -u +%FT%TZ)\",\"status\":\"FAIL\",\"reason\":\"walker exited rc=\$rc without a verdict\",\"source\":\"run.sh\"}" >> $EVID/run.log
fi
exit \$rc
R
chmod +x "$EVID/run.sh"
echo "harness=$SHA console=$(git -C /home/walker/agent-console-dev rev-parse HEAD) start=$(date -Is)" > "$EVID/LAUNCH.txt"
setsid nohup "$EVID/run.sh" "$@" > "$EVID/run.log" 2>&1 < /dev/null &
echo $! > "$EVID/run.pid"; sleep 5
PID=$(cat "$EVID/run.pid")
kill -0 "$PID" 2>/dev/null || { echo "FAIL: pid $PID dead"; tail -20 "$EVID/run.log"; exit 5; }
grep -q "failed to run" "$EVID/run.log" && { echo "FAIL: failed to run"; exit 5; }
for i in $(seq 1 120); do compgen -G "$EVID/walk/step-0001-*" > /dev/null && { echo "OK pid=$PID walk/step-0001 present"; exit 0; }; kill -0 "$PID" 2>/dev/null || { echo "FAIL: died before step 1"; tail -30 "$EVID/run.log"; exit 6; }; sleep 5; done
echo "WARN: pid $PID alive but no walk/step-0001 after 10 min"; exit 7
