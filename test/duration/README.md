# Duration tests (unified Markov walker)

Canonical design: `proposals/duration-tests.md` (PR #144 docs — do not merge unless Koen asks).  
Parent: [idea#166](https://github.com/koenswings/idea/issues/166).

## Fixtures (Kid / agent-app-dev#10)

| Pack | diskId | instanceId |
|------|--------|------------|
| Kolibri Grade 5A | `duration-kolibri-grade5a-001` | `kolibri-grade5a-001` |
| Nextcloud Grade 5A | `duration-nextcloud-grade5a-001` | `nextcloud-grade5a-001` |
| Kiwix | — | deferred Phase 3 |

Paths live under `agent-app-dev/tests/duration-tests/fixtures/`. Scenario YAML `fixtures:` maps these IDs; do not invent others. See Kid `walker-ref.yaml`.

**Kid testMode dock** uses private roots on pool Pis (`IDEA_DISKS_ROOT=/home/pi/idea/duration-disks`,
`IDEA_WATCH_DIR=/home/pi/idea/duration-watch`) — never `/disks`, never idea03 `sdb1`, never golden idea02.
Live dock smoke: `minimal-dock`. Reboot-only: `minimal-live`. Never eject/erase the idea03 Intenso Files Disk.

Aligned (do not block): Atlas Ops [idea#167](https://github.com/koenswings/idea/pull/167); Pixel Console [agent-console-dev#134](https://github.com/koenswings/agent-console-dev/pull/134).

## Phase 1–4 (this tree)

- YAML loader + Markov walker + action dispatcher (**ONE** walker / schema)
- Infra dock / undock / move / reboot via `FleetOps` (**FakeFleetOps** default; **RealFleetOps** with `--live`)
- Settle gate (`waitForConvergence` + WS ready)
- Semantic invariants (instanceDB / diskDB / engineDB fields — not Automerge blobs)
- Return-to-start hygiene (undock when leaving `infra_docked`)
- Shared-store (`shared` + mDNS-on) vs unique-doc (`unique` + mDNS-off) mode switch
- Structured JSON logs on `pnpm test:duration`
- **Phase 3:** `test/duration/ui/` → StubUiDriver (CI) or PlaywrightUiDriver (`--ui`) calling Pixel `getIntent`
- **Phase 4:** dwell stability probes (~30s / `--fast` compressed) + `stress.yaml` CI on FakeFleetOps

**Deferred / blockers:** live Playwright claim (Axle→Atlas); shared-store live mode (Ops); instance-start after dock (Kolibri image); `keep_watching` / `open_wikipedia_*` (Pixel deferred).

**2-engine UI claims:** use `school-day-2engine` (idea01+idea03, `store_mode: unique`, hub/console/operator Intents only — no App-open; no deferred Intents). Full `school-day` still lists idea04 + shared store + deferred lesson Intents — not for current 2-host live claims. App-open (`open_kolibri_*` / `open_nextcloud_*` / `open_video` / `open_exercise`) needs Running Kid fixtures (not dock-only).

## Run (no Pis — FakeFleetOps)

```bash
pnpm test:duration                          # minimal scenario, 40 steps (Fake + Stub UI + probes)
pnpm test:duration -- --scenario school-day --iterations 80 --fast
pnpm test:duration -- --scenario school-day-2engine --iterations 80 --fast
pnpm test:duration -- --scenario stress --iterations 100 --seed 99
pnpm test:duration -- --ui --console-url http://idea01   # Playwright → Pixel (needs claim)
```

Unit tests (fakes, part of automated suite):

```bash
pnpm build:test && IDEA_SYSTEM_DISK_SKIP=true IDEA_TEST_MODE=true \
  IDEA_WATCH_DIR=/tmp/idea-dur-watch IDEA_DISKS_ROOT=/tmp/idea-dur-disks \
  mkdir -p /tmp/idea-dur-watch /tmp/idea-dur-disks && \
  node_modules/.bin/vitest run dist-test/test/automated/duration-walker.test.js
```

Or via the normal suite: `pnpm test:unit` / `pnpm test:full` (includes `duration-walker.test.ts`).

## Run live (RealFleetOps / `--live`)

Requires Tailscale reachability + SSH key `~/.ssh/id_ed25519` as `pi@<host>`.

**Host map flag is `--hosts`** (not `--engine-urls`). Same format via env `DURATION_FLEET_HOSTS`.

```bash
# Minimal dock smoke (Kid copy+sentinel; no instance start; --fast = pm2 restart)
pnpm test:duration -- --live --scenario minimal-dock --fast --iterations 20 \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80

# Dock-free reboot-only smoke
pnpm test:duration -- --live --scenario minimal-live --fast --iterations 30 \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80

# 2-engine UI school-day (no idea04; unique; hub/console/operator only — no App-open)
pnpm test:duration -- --live --ui --scenario school-day-2engine --fast --iterations 40 \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80 \
  --console-url http://idea01:8080

# Optional health wraps around reboot (Atlas PAUSED); {pis} → pool IPs
pnpm test:duration -- --live --scenario minimal-live --fast \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80 \
  --health-wrap-before 'echo pause {pis}' \
  --health-wrap-after 'echo resume {pis}'
```

`duration_start` JSON includes `live:true` and the resolved `hosts` map.

### Live caveats

- Claim **pool** Pis only (`idea01` / `idea03`). **Never golden idea02.**
- Tonight’s Pis use **unique** stores + `mdns:false`. `applyStoreMode('shared')` throws until Ops provisions shared store+mDNS.
- `dockFixture` = rsync Kid pack → `duration-disks/idea-test-N/` + touch sentinel under `duration-watch` (excludes `instances/` so Engine does not auto-start apps). `undock` = `ejectDisk` + remove sentinel. `moveDisk` = undock then dock.
- Engine on Pis must run with `testMode:true` and `IDEA_SYSTEM_DISK_SKIP=true` plus the private roots above (Atlas).
- Fixture disks must **never** be the idea03 hw-roundtrip Intenso
  (USB serial `26A1EE83197F` / disk serial `3813430-532011020` /
  UUID `a0bf8374-274e-4bef-b32e-cfbfd09d2884` / label `IDEA Disk`).
- Ask Atlas for health-wrap before intentional reboot churn.

## Intent keys

See [ACTIONS.md](./ACTIONS.md) — shared contract for Pixel Playwright stubs.
