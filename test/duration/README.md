# Duration tests (unified Markov walker)

Canonical design: `proposals/duration-tests.md` (PR #144 docs — do not merge unless Koen asks).  
Parent: [idea#166](https://github.com/koenswings/idea/issues/166).  
**ONE canonical graph:** `test/duration/scenarios/unified.yaml` (28 states). Alternate scenario YAMLs are **demoted** — run modes are CLI flags only.

## Prefer real UI over stubs

**Policy:** once Pixel Intents harden and Atlas can claim the pool, prefer **`--live --ui`** for real Console walks (recording + cover-all / random).  
`StubUiDriver` / Fake is for **CI and missing-Intent dry-runs only**.

- With `--ui`, the runner always uses `PlaywrightUiDriver` (never silently forces Stub for registered Intents).
- Deferred / unregistered Intents soft-skip or clear-fail via existing `failLoud` — they do not fall back to Stub.
- Intended verification path when Pixel+Atlas are ready:  
  `--live --ui --scenario cover-all|random --record-walk <dir>`

## Fixtures (Kid / agent-app-dev#10)

| Pack | diskId | instanceId |
|------|--------|------------|
| Kolibri Grade 5A | `duration-kolibri-grade5a-001` | `kolibri-grade5a-001` |
| Nextcloud Grade 5A | `duration-nextcloud-grade5a-001` | `nextcloud-grade5a-001` |
| Kiwix | — | deferred (wiki_browse live later) |

Paths live under `agent-app-dev/tests/duration-tests/fixtures/`. Scenario YAML `fixtures:` maps these IDs; do not invent others. See Kid `walker-ref.yaml`.

**Kid testMode dock** uses private roots on pool Pis (`IDEA_DISKS_ROOT=/home/pi/idea/duration-disks`,
`IDEA_WATCH_DIR=/home/pi/idea/duration-watch`) — never `/disks`, never idea03 `sdb1`, never golden idea02.
Never eject/erase the idea03 Intenso Files Disk.

**Live App-open (later):** Kid sidecar `post-dock-restore-running.sh` → `idea166-kolibri-live` :18080. Fake walks do not require live.

Aligned (do not block): Atlas Ops [idea#167](https://github.com/koenswings/idea/pull/167); Pixel Console [agent-console-dev#134](https://github.com/koenswings/agent-console-dev/pull/134) tip **`128f2d3`** (58 Intents + `captureAfterIntent` / `screenshotPath`).

## Phase 1–4 (this tree)

- YAML loader + Markov walker + action dispatcher (**ONE** walker / schema / graph)
- Infra dock / undock / move / reboot via `FleetOps` (**FakeFleetOps** default; **RealFleetOps** with `--live`)
- Settle gate (`waitForConvergence` + WS ready)
- Semantic invariants (instanceDB / diskDB / engineDB fields — not Automerge blobs)
- Return-to-start hygiene (undock when leaving `infra_docked`)
- Shared-store (`shared` + mDNS-on) vs unique-doc (`unique` + mDNS-off) mode switch
- Structured JSON logs on `pnpm test:duration`
- **Phase 3:** `test/duration/ui/` → StubUiDriver (CI / missing-Intent) or PlaywrightUiDriver (`--ui`) calling Pixel `runDurationIntent` / `captureAfterIntent` (Console#134 @ `128f2d3`)
- **Phase 4:** dwell stability probes (~30s / `--fast` compressed) on FakeFleetOps
- **Walk recording:** `--record-walk <dir>` → `step-NNNN-<action>.png` + `walk.mp4` (ffmpeg)

**Deferred / blockers:** live Playwright claim (Axle→Atlas); shared-store live mode (Ops); instance-start after dock (Kid Running sidecar); Pixel deferred + remaining Pixel-missing Intents (Fake no-ops; see ACTIONS.md).

## Run modes (CLI — not separate graphs)

**`--scenario` semantics:**
- `random` / `unified` / default → **Markov** simulation on `scenarios/unified.yaml`
- `cover-all` → **deterministic walk** (`walks/cover-all.yaml`) covering every graph action once — regression before a long random soak
- Do **not** invent alternate Markov graphs

Deprecated aliases that still resolve to `unified.yaml`: `minimal`, `minimal-live`, `minimal-dock`, `stress`, `school-day`.

Canonical Fake pool: **idea01 + idea03 + idea04** (never idea02). Live `--hosts` takes whatever Atlas provides.

| Intent | Flags |
|---|---|
| Fake Markov smoke | `--scenario random --iterations 40 --fast` |
| Fake cover-all walk | `--scenario cover-all --fast` |
| Fake multi-hour proof | `--scenario random --iterations 2000 --seed 42 --fast` |
| Live reboot / dock | `--live --fast --hosts idea01=…,idea03=…,idea04=…` (same YAML) |
| **Live UI (preferred)** | `--live --ui --hosts idea01=…,idea03=…,idea04=… --console-url http://idea01:8080` |
| Record walk (real PNGs) | add `--record-walk /tmp/dur-walk` (pair with `--ui`) |

## Run (no Pis — FakeFleetOps)

```bash
pnpm test:duration                          # Markov random/unified, 40 steps (Fake + Stub UI + probes)
pnpm test:duration -- --scenario cover-all --fast
pnpm test:duration -- --scenario random --iterations 2000 --seed 42 --fast
# Dry-run --record-walk wiring (stub steps → record_walk_skip, 0 frames, no video):
pnpm test:duration -- --scenario cover-all --fast --record-walk /tmp/dur-rec
```

Unit tests (fakes, part of automated suite):

```bash
pnpm build:test && IDEA_SYSTEM_DISK_SKIP=true IDEA_TEST_MODE=true \
  IDEA_WATCH_DIR=/tmp/idea-dur-watch IDEA_DISKS_ROOT=/tmp/idea-dur-disks \
  mkdir -p /tmp/idea-dur-watch /tmp/idea-dur-disks && \
  node_modules/.bin/vitest run dist-test/test/automated/duration-walker.test.js
```

Or via the normal suite: `pnpm test:unit` / `pnpm test:full` (includes `duration-walker.test.ts`).

## Run live (RealFleetOps / `--live`) — prefer with `--ui`

Requires Tailscale reachability + SSH key `~/.ssh/id_ed25519` as `pi@<host>`.

**Host map flag is `--hosts`** (not `--engine-urls`). Same format via env `DURATION_FLEET_HOSTS`.

```bash
# Preferred: real UI walks once Pixel+Atlas ready
pnpm test:duration -- --live --ui --scenario cover-all --fast \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80,idea04=<ip> \
  --console-url http://idea01:8080 \
  --record-walk /tmp/dur-walk

pnpm test:duration -- --live --ui --scenario unified --fast --iterations 40 \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80,idea04=<ip> \
  --console-url http://idea01:8080

# Infra-only live (no UI)
pnpm test:duration -- --live --scenario unified --fast --iterations 20 \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80,idea04=<ip>

# Optional health wraps around reboot (Atlas PAUSED); {pis} → pool IPs
pnpm test:duration -- --live --scenario unified --fast \
  --hosts idea01=100.99.231.94,idea03=100.126.117.80,idea04=<ip> \
  --health-wrap-before 'echo pause {pis}' \
  --health-wrap-after 'echo resume {pis}'
```

`duration_start` JSON includes `live`, `ui`, `uiDriver`, `record_walk`, and the resolved `hosts` map.

### `--record-walk <dir>`

1. Creates `<dir>` if needed.
2. After each **UI** Intent (and any step with a live Playwright page), writes `step-NNNN-<action>.png`.
3. Soft-detect Pixel capture (aligned Console#134 @ `128f2d3`):
   1. Pass `screenshotPath` into `runDurationIntent` (Pixel may settle + write PNG once)
   2. Soft-detect `bridge.captureAfterIntent(page, { path, intent })` — **skip if PNG already exists** (no second capture)
   3. Else fallback `page.screenshot({ path, fullPage: true })`
4. At walk end (success or abort): `ffmpeg` → `walk.mp4` in `<dir>`. Logs `record_walk_frame` / `record_walk_video` / `record_walk_skip`.
5. Without `--ui`: Fake Stub logs `record_walk_skip` per UI step (flag dry-run); no PNGs → skip video.

ffmpeg on this box: `/usr/bin/ffmpeg`.

### Live caveats

- Claim **pool** Pis only (`idea01` / `idea03` / `idea04`). **Never golden idea02.**
- Tonight’s Pis use **unique** stores + `mdns:false`. `applyStoreMode('shared')` throws until Ops provisions shared store+mDNS.
- `dockFixture` = rsync Kid pack → `duration-disks/idea-test-N/` + touch sentinel under `duration-watch` (excludes `instances/` so Engine does not auto-start apps). `undock` = `ejectDisk` + remove sentinel. `moveDisk` = undock then dock.
- Engine on Pis must run with `testMode:true` and `IDEA_SYSTEM_DISK_SKIP=true` plus the private roots above (Atlas).
- Fixture disks must **never** be the idea03 hw-roundtrip Intenso
  (USB serial `26A1EE83197F` / disk serial `3813430-532011020` /
  UUID `a0bf8374-274e-4bef-b32e-cfbfd09d2884` / label `IDEA Disk`).
- Ask Atlas for health-wrap before intentional reboot churn.
- Do **not** claim fleet / run live without Atlas coordination.

## Intent keys

See [ACTIONS.md](./ACTIONS.md) — shared contract for Pixel Playwright adapters (registered / deferred / Pixel-missing).
