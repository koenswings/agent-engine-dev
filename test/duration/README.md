# Duration tests (unified Markov walker)

Canonical design: `proposals/duration-tests.md` (PR #144 docs — do not merge unless Koen asks).  
Parent: [idea#166](https://github.com/koenswings/idea/issues/166).  
**ONE canonical graph:** `test/duration/scenarios/unified.yaml` (28 states). Alternate scenario YAMLs are **demoted** — run modes are CLI flags only.

## Prefer real UI over stubs

**Policy:** once Pixel Intents harden and Atlas can claim the pool, prefer **`--live --ui`** for real Console walks (recording + cover-registered-intents (alias cover-hardpass) / cover-all / random).  
`StubUiDriver` / Fake is for **CI and missing-Intent dry-runs only**.

- With `--ui`, the runner always uses `PlaywrightUiDriver` (never silently forces Stub for registered Intents).
- Deferred / unregistered Intents soft-skip or clear-fail via existing `failLoud` — they do not fall back to Stub.
- Intended verification path when Pixel+Atlas are ready:  
  `--live --ui --scenario cover-registered-intents|cover-all|random --record-walk <dir>`

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

Aligned (do not block): Atlas Ops [idea#167](https://github.com/koenswings/idea/pull/167); Pixel Console [agent-console-dev#134](https://github.com/koenswings/agent-console-dev/pull/134) tip **`4f7cfba`** (68 Intents + click-mask wait; prod-web ignores sticky demoMode + `captureAfterIntent` / `screenshotPath`).

Pixel coaching set now registered at Console@`ba0cfa1`: `create_class`, `enroll_learners`, `build_lesson`, `create_quiz`, `read_reports`, `preview_as_learner`, `browse_classes`; `open_kolibri_as_teacher` opens `/en/coach/#/classes`. `back_to_console` is hardened.

### Service-image tars (idea#168 Stage 1 — `skipImageLoad: false`)

A real App Disk carries `services/<image with / → _>.tar`, and the Engine loads each tar
(`docker image load`) before `docker compose up` unless `skipImageLoad` is true. The Kid
packs do not ship the tars (GBs), so **Atlas stages them once per pool Pi** and the harness
hard-links them into the slot on every dock (`buildEnsureServiceTarsRemote`, `cp` fallback
across filesystems). The harness never downloads, builds or deletes a staged tar.

| Pack (diskId) | Image (compose `services.*.image`) | Staged file (`DURATION_SERVICE_TARS_ROOT`, default `/home/pi/idea/duration-service-tars/`) | ≈ size |
|---|---|---|---|
| `duration-kolibri-grade5a-001` | `koenswings/kolibri:1.0-0.15.5-dev` | `koenswings_kolibri:1.0-0.15.5-dev.tar` | 1.62 GB |
| `duration-nextcloud-grade5a-001` | `koenswings/nextcloud:1.0-31.0.1` | `koenswings_nextcloud:1.0-31.0.1.tar` | 2.02 GB |
| `duration-nextcloud-grade5a-001` | `koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404` | `koenswings_nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404.tar` | 0.49 GB |

- **Where:** on **idea01, idea03 and idea04** (every pool Pi a pack can dock on or move to; never idea02),
  same directory, pi-readable, on the same filesystem as `/home/pi/idea/duration-disks` so the
  slot links are hard links (no extra space). ≈ **4.13 GB per Pi**.
- **How (Atlas, once):** `docker save <image> -o /home/pi/idea/duration-service-tars/<file>` on a Pi
  that has the image, or copy `services/<file>` from a real App Disk; then `sha256sum` the three
  files on every Pi and compare. The file name must be exactly the Engine's
  `serviceImageTarPath` name (table above).
- **Free space:** the Engine's `copyApp`/`installApp` copy the tars onto the target disk
  (`services/`), so each `copy_app` / late `install_app` adds 1.6–2.5 GB to a slot. Keep
  ≥ 15 GB free under `/home/pi/idea` on each Pi; reset (fresh dock of empty packs, rm of app
  slots) removes those copies.
- **Dock:** with `--start-instances` and `DURATION_SERVICE_TARS=require` (default), an app pack's
  dock links its tars into `<slot>/services/` before the sentinel fires, in the fresh-copy and
  the reuse path; a missing staged tar refuses the dock (exit 5, `SERVICE_TAR_MISSING <path>`).
  `DURATION_SERVICE_TARS=off` restores the old behaviour (Engine warns, Docker uses a cached image).
- **moveDisk:** `services/` is not streamed between Pis (excluded from the tar stream and the
  digest); the target re-links its own staged copies after the commit.
- **Budgets** (`startBudgets.ts`; upper bounds, a healthy start returns at once; measured
  durations are logged as `instance_start_measured` JSON lines):
  `DURATION_INSTANCE_START_MS` (post-install start; fast 300 s / 600 s, was 120 s / 300 s),
  `DURATION_NEXTCLOUD_READY_MS` (420 s, was 180 s), `DURATION_COPY_DONE_MS` (fast 300 s / 900 s,
  was 120 s / 600 s), `DURATION_DOCK_WAIT_MS` (300 s, was 120 s).

## Phase 1–4 (this tree)

- YAML loader + Markov walker + action dispatcher (**ONE** walker / schema / graph)
- Infra dock / undock / move / reboot via `FleetOps` (**FakeFleetOps** default; **RealFleetOps** with `--live`)
- Settle gate (`waitForConvergence` + WS ready)
- Semantic invariants (instanceDB / diskDB / engineDB fields — not Automerge blobs)
- Return-to-start hygiene (undock when leaving `infra_docked`)
- Shared-store (`shared` + mDNS-on) vs unique-doc (`unique` + mDNS-off) mode switch
- Structured JSON logs on `pnpm test:duration`
- **Phase 3:** `test/duration/ui/` → StubUiDriver (CI / missing-Intent) or PlaywrightUiDriver (`--ui`) calling Pixel `runDurationIntent` / `captureAfterIntent` (Console#134 @ `cdcfdb1`); non-localhost `addInitScript` forces `demoMode=false`
- **Phase 4:** dwell stability probes (~30s / `--fast` compressed) on FakeFleetOps
- **Walk recording:** `--record-walk <dir>` → `step-NNNN-<action>.png` + `walk.mp4` (ffmpeg)

**Deferred / blockers:** live Playwright claim (Axle→Atlas); shared-store live mode (Ops); instance-start after dock (Kid Running sidecar); Pixel deferred + remaining Pixel-missing Intents (Fake no-ops; see ACTIONS.md).

## Run modes (CLI — not separate graphs)

**`--scenario` semantics:**
- `random` / `unified` / default → **Markov** simulation on `scenarios/unified.yaml`
- `cover-all` → **deterministic walk** (`walks/cover-all.yaml`) covering every graph action once — strict full-graph regression (under `--ui`, Pixel-missing still **failLoud** abort; live retry requires Console@`ba0cfa1`)
- `cover-registered-intents` (chat: **registered-intents walk**; alias `cover-hardpass`) → **deterministic walk** (`walks/cover-registered-intents.yaml`) covering the current Pixel-registered demo subset + Engine infra FleetOps — **live `--ui` demo now** (coaching Intents are registered but walk expansion is deferred; excludes DEFERRED + PIXEL_MISSING)
- `kolibri-learn-smoke` / `kolibri-teacher-preview-smoke` → short Prefer A walks to `finish_exercise` (6 / 7 steps; skips coaching 3–7)
- `--start-from <N|action>` (walks only): slice from 1-based step or first matching action; seeds `walker.current` to that step's `from`. With `--iterations`, start-from applies first then remaining are truncated.
- Do **not** invent alternate Markov graphs

Deprecated aliases that still resolve to `unified.yaml`: `minimal`, `minimal-live`, `minimal-dock`, `stress`, `school-day`.

Canonical Fake pool: **idea01 + idea03 + idea04** (never idea02). Live `--hosts` takes whatever Atlas provides.

| Intent | Flags |
|---|---|
| Fake Markov smoke | `--scenario random --iterations 40 --fast` |
| Fake cover-all walk (strict) | `--scenario cover-all --fast` |
| Fake cover-registered-intents / registered-intents walk | `--scenario cover-registered-intents --fast` (alias `cover-hardpass`) |
| Fake Kolibri finish_exercise smokes | `--scenario kolibri-learn-smoke --fast` / `kolibri-teacher-preview-smoke` |
| Walk mid-start | `--scenario cover-all --start-from 12` or `--start-from finish_exercise` (+ optional `--iterations N`) |
| Fake multi-hour proof | `--scenario random --iterations 2000 --seed 42 --fast` |
| Live reboot / dock | `--live --fast --hosts idea01=…,idea03=…,idea04=…` (same YAML) |
| **Live UI (preferred; Console@`cdcfdb1`)** | `--live --ui --start-instances --hosts idea01=…,idea03=…,idea04=… --console-url http://idea01:8080` |
| Path A start instances | `--start-instances` → RealFleetOps `startInstances:true` + preserve dock on return |
| Record walk (real PNGs) | add `--record-walk /tmp/dur-walk` (pair with `--ui`) |

## Run (no Pis — FakeFleetOps)

```bash
pnpm test:duration                          # Markov random/unified, 40 steps (Fake + Stub UI + probes)
pnpm test:duration -- --scenario cover-all --fast
pnpm test:duration -- --scenario cover-registered-intents --fast
pnpm test:duration -- --scenario kolibri-learn-smoke --fast
pnpm test:duration -- --scenario kolibri-teacher-preview-smoke --fast
pnpm test:duration -- --scenario cover-all --start-from finish_exercise --iterations 1 --fast
pnpm test:duration -- --scenario random --iterations 2000 --seed 42 --fast
# Dry-run --record-walk wiring (stub steps → record_walk_skip, 0 frames, no video):
pnpm test:duration -- --scenario cover-registered-intents --fast --record-walk /tmp/dur-rec
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
pnpm test:duration -- --live --ui --scenario cover-registered-intents --fast \
  --hosts idea01=…,idea03=…,idea04=… --console-url http://idea01:8080
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
3. Soft-detect Pixel capture (aligned Console#134 @ `ba0cfa1`):
   1. Pass `screenshotPath` into `runDurationIntent` (Pixel may settle + write PNG once)
   2. Soft-detect `bridge.captureAfterIntent(page, { path, intent })` — **skip if PNG already exists** (no second capture)
   3. Else fallback `page.screenshot({ path, fullPage: true })`
4. At walk end (success or abort): `ffmpeg` → `walk.mp4` in `<dir>`. Logs `record_walk_frame` / `record_walk_video` / `record_walk_skip`.
5. Without `--ui`: Fake Stub logs `record_walk_skip` per UI step (flag dry-run); no PNGs → skip video.

ffmpeg on this box: `/usr/bin/ffmpeg`.

**Caveat:** `--record-walk` frames often show the Console Apps page, not the Kolibri tab — the recorder does not follow app tabs. Do not trust screenshots alone for Kolibri steps; prefer Intent `ok` / structured logs. Live Kolibri smokes need Console@`4f7cfba`+ (click-mask wait).

### Live caveats

- Claim **pool** Pis only (`idea01` / `idea03` / `idea04`). **Never golden idea02.**
- idea#168 r38 (Koen's standing rule): the live pool idea01/03/04 shares ONE dev store (`3zoqd…`) with
  mDNS ON and NO static peers — a production replica. `RealFleetOps` accepts `store_mode: shared` (unified.yaml;
  no wrapper flip) and REFUSES `unique` (Fake keeps both). Every `--live` run starts with `store_preflight`
  (read-only ssh + the Engine's `/api/store-url` + the harness WS doc): per Pi, store id = `DURATION_EXPECTED_STORE_ID`
  (default `3zoqd`), `settings.mdns: true` and `IDEA_MDNS_DISABLE` not `true`, no `IDEA_STATIC_PEERS` /
  `settings.staticPeers`. Any mismatch → exit **6** before step 1 (Pi, field, expected vs actual). Exit codes:
  1 walk failures · 2 fatal/refused · 4 engine unreachable · 5 Console pin · 6 store preflight · 7 slot-layout preflight ·
  8 fixture-disk preflight · 9 peer-key preflight.
- Slot layout (idea#168, app-data root helper; `slotLayout.ts`). Every `--live` run logs `slot_layout_preflight`
  per Pi (read-only ssh). **mode=legacy** — no `/usr/local/sbin/idea-app-data` on the Pi (the current f65183a
  pool): slot handling unchanged (the harness creates/removes `idea-test-N` dirs, stages moves in
  `.incoming-*`, quarantines to `.moved-away/`). **mode=helper** — the helper exists and `sudo -n … version`
  answers `idea-app-data <N>`; enforced (else exit **7**): `duration-disks` root-owned and not g/o-writable,
  `idea-test-1..6` exist, real dirs (no symlink), pi-writable, listed in `/etc/idea/app-data-roots`
  (root:root 0644). In helper mode the harness never creates or removes a slot dir: it empties a slot's
  contents (dotfiles included; refuses a symlink / missing / non-child slot), removes `instances/<id>` only via
  `sudo -n /usr/local/sbin/idea-app-data delete <slot> <id>`, receives a move straight into a pre-created EMPTY
  slot, and moves a moved-away slot's contents to `~/idea/duration-moved-away/` (the slot dir stays).
- Empty fixture disks (idea#168 r38@103; `fixtureDisks.ts`). cover-all / cover-all-skip-copy consume THREE Empty
  disks, one per role, which must be different disks: **Files** — install_app@88 + make_files_disk@91
  (`DURATION_EMPTY_DISK_ID`, default `duration-empty-001`, Path A `idea-test-3`); **Backup** — make_backup_disk@95,
  then backup_instance@98/@112 + restore_from_backup@100 (`DURATION_BACKUP_DISK_ID`, default `duration-empty-003`,
  Path A `idea-test-6`, never re-docked by the harness); **Erase** — erase_disk@104/@121 + the late installs
  (`duration-empty-002`, Path A `idea-test-4`, re-docked Empty by the harness after confirm_erase / before the second
  install / before the late erase). Live, make_backup_disk and erase_disk are pinned to their role's disk (store
  Empty wait + row select with EmptyDiskPanel; the Console Intent's `DURATION_EMPTY_DISK_ID` points at it for that
  Intent only) and make_backup_disk must land `backup` on that disk in the store. Every `--live` walk logs
  `fixture_disk_preflight`: from step 1 each consumed role's disk must be docked on the Console engine and Empty
  (diskTypes=[empty], no instances), with `--start-from` docked + distinct only; role ids must be pairwise distinct
  (r38 ran with `DURATION_BACKUP_DISK_ID=DURATION_EMPTY_DISK_ID=duration-empty-001`). Else exit **8** before step 1.
- Per-Pi peer keys (idea#168; `peerPreflight.ts`; Engine feat/app-data-root-helper). Every `--live` walk logs
  `peer_preflight`. The cross-Engine copy steps are the walk's `copy_app` steps at/after `--start-from` (cover-all
  @43/@116; cover-all-skip-copy has none → `peer preflight skipped: no cross-engine copy steps`). Which Pis a copy joins
  is read from the store at run time and the walk can dock the app disks on any pool Pi, so every pool pair (never
  idea02) is checked, both ways: both Engine entries publish `peerAccess` (sshKey + ed25519 hostKey); each lists the
  other in `peerAccess.authorized` as `<engineId> <SHA256 key fp> <SHA256 hostkey fp>` with the other's CURRENT keys;
  no pool Engine authorizes idea02 or a non-pool Engine. Read-only ssh per Pi: `sudo -n idea-app-data version` >= 2;
  `/etc/ssh/idea_authorized_keys/pi` (gate line per peer) and `/etc/idea/peer_known_hosts` (pinned host key per peer)
  hold the peer's published keys — when not readable the store check stands alone (logged as a note); the Pi's own
  `~/.ssh/idea_engine_ed25519.pub` / `ssh_host_ed25519_key.pub` match what it publishes. Else exit **9** before step 1,
  naming the pair and the reason (unpublished, one-sided, not-exchanged, fingerprint-mismatch, foreign-id,
  helper-too-old, probe-failed). With a cross-Engine copy in the run the slot-layout check needs helper >= 2 (else >= 1).
- META.yaml is never compared by bytes or sha (skipMetaUpdate:false rewrites it on every dock): checks use the
  parsed `diskId` (+ `created` where two META files are compared, e.g. moveDisk); see `metaYaml.ts`.
- `dockFixture` = rsync Kid pack → `duration-disks/idea-test-N/` + touch sentinel under `duration-watch` (excludes `instances/` so Engine does not auto-start apps). `undock` = `ejectDisk` + remove sentinel. `moveDisk` = undock then dock.
- Engine on Pis must run with `testMode:true` and `IDEA_SYSTEM_DISK_SKIP=true` plus the private roots above (Atlas).
- Fixture disks must **never** be the idea03 hw-roundtrip Intenso
  (USB serial `26A1EE83197F` / disk serial `3813430-532011020` /
  UUID `a0bf8374-274e-4bef-b32e-cfbfd09d2884` / label `IDEA Disk`).
- Ask Atlas for health-wrap before intentional reboot churn.
- Do **not** claim fleet / run live without Atlas coordination.

## Intent keys

See [ACTIONS.md](./ACTIONS.md) — shared contract for Pixel Playwright adapters (registered / deferred / Pixel-missing).
