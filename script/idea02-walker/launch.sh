#!/usr/bin/env bash
# Walker-side detached launch. Usage: launch.sh RUN_ID [extra cli args...]
# Runs from idea02 only, on the pushed harness checkout; absolute paths throughout.
# Gate: store-check (store=3, queues=0, idea02 absent) must PASS before launch (READY gate, Atlas).
# Deviation: DURATION_DOC_WAIT_MS=45000 (idea02 Pi 4 doc load ~24-27 s; see DEVIATIONS.md).
set -euo pipefail
RUN="${1:?run id}"; shift || true
REPO=/home/walker/agent-engine-stage2
EVID=/home/walker/duration-evidence/$RUN
[ "$(hostname)" = idea02 ] || { echo "REFUSE: walker host must be idea02"; exit 2; }
git -C "$REPO" diff --quiet || { echo "REFUSE: dirty harness tree"; exit 3; }
SHA=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" branch -r --contains "$SHA" | grep -q origin/ || { echo "REFUSE: $SHA not pushed"; exit 3; }
CONSOLE_PIN=49cf9085e063887cb162c8cbc6ed1dd1f79b1e93  # intents (e2e-only on 4fb5299): Text collision named loud (r77 FAIL@82)
[ "$(git -C /home/walker/agent-console-dev rev-parse HEAD)" = "$CONSOLE_PIN" ] || { echo "REFUSE: console intents checkout is not $CONSOLE_PIN"; exit 3; }
git -C /home/walker/agent-console-dev diff --quiet || { echo "REFUSE: dirty console intents tree"; exit 3; }
mkdir -p "$EVID"; [ -f "$EVID/run.pid" ] && kill -0 "$(cat "$EVID/run.pid")" 2>/dev/null && { echo "REFUSE: already running"; exit 4; }
( cd "$REPO" && STORE_DOC="${STORE_DOC:-3zoqdSVsEtj4ygNJPNcDyKWvdxo6}" DURATION_DOC_WAIT_MS=45000 /usr/bin/env npx tsx script/idea02-walker/store-check.ts ) > "$EVID/store-check.txt" 2>&1 || { echo "REFUSE: store-check gate FAIL"; tail -8 "$EVID/store-check.txt"; exit 8; }
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
# Product pin: unmerged Console PR #142 tip 1f97528 (incl. #138), Steve option (b) 10:33 CEST; intents stay 49cf908.
export DURATION_CONSOLE_PRODUCT_SHA=1f97528849e49a4cd75d2e26478618dc90a67be0
export DURATION_CONSOLE_PRODUCT_ASSET=index-Bnq0hP4N.js
export DURATION_CONSOLE_PRODUCT_ASSET_MD5=e4d525ad92d28b95555b0e4ac542287d
export DURATION_EXPECTED_STORE_ID=3zoqd
export DURATION_POST_OP_SETTLE_MS=\${DURATION_POST_OP_SETTLE_MS:-300000}
export DURATION_DOC_WAIT_MS=\${DURATION_DOC_WAIT_MS:-45000}
export DURATION_DOC_WAIT_MS_IDEA04=\${DURATION_DOC_WAIT_MS_IDEA04:-45000}
env | grep -E "^(DURATION|STAGE2)_" | sort > $EVID/ENV.txt
exec /usr/local/bin/pnpm test:duration -- --live --ui --start-instances --scenario cover-all --fast --console-url http://idea01:8080 --record-walk $EVID/walk "\$@"
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
