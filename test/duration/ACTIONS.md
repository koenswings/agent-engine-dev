# Duration-test Intent action keys

**Contract owner:** Axle (Engine walker). Pixel matches Playwright adapters to these keys.  
**Locked** by Steve Design Review for idea#166 — do not rename without reporting a clash.  
**Phase 3+4 (idea#168):** walker dispatches usage/operator Intents via `test/duration/ui/` → Pixel `e2e/intents` (`getIntent`).  
**ONE graph:** `scenarios/unified.yaml` is the only Markov state table. Run modes = CLI knobs.  
**Pixel registry:** Console tip `198eb69` (PR #135) — **85** Intent keys (+ `captureAfterIntent` / `screenshotPath` for `--record-walk`; production web ignores sticky `demoMode`). Engine ACTIONS.md on #145 is source for walker contract.

YAML transition shape (all layers): `{ to, weight, action }`.

## Hub / cross-layer

| Key | Meaning |
|---|---|
| `return_to_start` | Clear layer context; undock fixtures if leaving infra_docked (default hygiene); Path A `--start-instances` preserves dock; Pixel dismisses modals when `--ui` |
| `enter_infra_fleet_walk` | Enter infra subgraph at `infra_idle` (undock fixtures first) — **Engine-owned, not in Pixel registry** |
| `open_console_as_teacher` | Usage entry → `console_teacher` |
| `open_console_as_learner` | Usage entry → `console_learner` |
| `open_console_as_operator` | Operator entry → `op_entry` |

## Infra (pool-only; never golden idea02)

| Key | Entry / effect |
|---|---|
| `infra_undock_fixtures` | `infra_idle` — Engine eject/undock fixture disks |
| `infra_dock_fixture` | `infra_docked` — Engine dock fixture on a pool engine. Prefer A r16 FAIL@65 / r17 FAIL@58: after dock+settle, when Nextcloud is among fixtures, live path polls `http://<engineId>:18280/login` (logical hostname, not Tailscale IP — NC trusted_domains) until login-form HTML ready (and sets `DURATION_NEXTCLOUD_URL`); Fake skips the wait |
| `infra_move_disk` | `infra_disk_moved` — undock then dock on another pool engine (wait undock settle; dockFixture no-op only if already on *target*; docker settle grace like move_app). Prefer A r15: sets `DURATION_KOLIBRI_URL` to the target host so Console Path B follows the disk (not Console idea01) |
| `infra_reboot_engine` | `infra_reboot` — SSH reboot; `--fast` → `pm2 restart engine` (Path A: stop duration docker zombies before/after pm2 so `no_zombie_instances` holds) |

## Usage / operator Intent registry

**Prefer real UI:** `--live --ui` once Pixel adapters harden (Fake `StubUiDriver` = CI / missing-Intent only).  
With `--ui`, Engine always uses `PlaywrightUiDriver` — deferred / unregistered Intents soft-skip or clear-fail via `failLoud`; never silently force Stub for registered Intents.  
Recording + **cover-registered-intents** (Pixel-registered demo + infra; live `--ui` demo; `copy_app`/`move_app` require Console#134 @`b63e1ec`+ multi-disk) or cover-all (strict full graph) / random with `--ui --live` (+ `--record-walk <dir>`) is the intended verification path once Pixel+Atlas are ready. cover-all under `--ui` keeps failLoud abort on Pixel-missing (no soft-skip); a live cover-all retry requires Console@`ba0cfa1`.

Fake/CI default: `StubUiDriver` (no browser). Live UI: `pnpm test:duration -- --live --ui` → `PlaywrightUiDriver` loads Pixel `runDurationIntent` / optional `captureAfterIntent` from `idea-console/duration-intents` or `agent-console-dev/e2e/intents` (or `DURATION_CONSOLE_INTENTS`).

### Pixel-registered (85 — + keep_editing + Wikipedia open/search/leave + File Drop trio; Console@198eb69; was 76 @ 2da863c)

Hub/dwell: `open_console_as_*`, `return_to_start`, `stay_on_*`  
App-open: `open_kolibri_as_teacher` → `/en/coach/#/classes`, `open_kolibri_as_learner`, `open_nextcloud_as_*` (Console#135 @ f150b9e / settle @ b1d3d60: loud-fail if Nextcloud sign-in fails — live smoke may need Kid passwords; do not change NC Intent code here), `open_video`, `open_exercise`, `keep_watching` (Console#134 @ 329dc38, stay on pinned video URL), `next_resource` (Console#135 @ f16ee18, video→exercise via resource panel), `finish_exercise` (Console#135 @ d087081, exercise→Learn home via Perseus Check), `next_video` (Console#135 @ a8b4b6c, exercise→video via resource panel), `exit_lesson` (Console#135 @ 549f72b, video/exercise→Learn home via Kolibri chrome), `browse_folders` (Console#135 @ f150b9e, Nextcloud Class Materials / Drop Zone / Collab dwell), `share_to_class` (Console#135 @ 953af05 — will fail until Kid sets `enable_sharing true` on Grade 5A Files mount; do not change Kid/app code here), `done_sharing` / `back_to_console_from_share` (Console#135 @ 1709165), `open_collab_doc` / `close_doc` (Console#135 @ 2da863c), `keep_editing` (Console#135 @ 1bbb729, NC Text write dwell), `open_file_drop` / `after_upload` / `leave_file_drop` (Console#135 @ 198eb69 — names match cover-all.yaml), `open_wikipedia_as_teacher` / `open_wikipedia_as_learner` / `search_browse_wikipedia` / `leave_wikipedia_as_teacher` / `leave_wikipedia_as_learner` (Console#135 @ 1bbb729 — names match cover-all.yaml)
Operator: `open_disk_inventory`, `open_instance_controls`, `eject_disk`, `confirm_eject`, `cancel_eject`, `erase_disk`, `confirm_erase`, `cancel_erase`, `start_instance`, `stop_instance`, `open_account`, `close_account`, `open_settings`, `close_settings`, `sign_in`, `make_files_disk`, `add_files_role`  
Operator deep: `install_app`, `start_after_install`, `stay_on_disk`, `make_backup_disk`, `restore_from_backup`, `open_app`, `backup_instance`, `back_to_disk`, `back_to_overview`, `log_out`, `notice_usb_dock`, `retry_login_first_time_setup`, `change_password`, `add_operator`, `remove_operator`, `copy_app`, `move_app`  
**Coaching (Console#134 @ ba0cfa1):** `create_class`, `enroll_learners`, `build_lesson`, `create_quiz`, `read_reports`, `preview_as_learner`, `browse_classes`

**Part B leftovers + leave/back (@ ba0cfa1; `back_to_console` hardened):** `files_role_added`, `backup_configured_restored`, `done_redistribute`, `stay_on_source_disk`, `open_copied_instance`, `switch_engine`, `reboot_engine`, `back_to_console`, `leave_kolibri`, `leave_nextcloud_as_teacher`, `leave_nextcloud_as_learner`

**Registered-intents instance walk:** `start_instance` → `open_app` → `stop_instance` → `backup_instance` so `open_app` runs while the instance is Running.

### Deferred (clear message, not silent)

*(none — Wikipedia + File Drop undeferred @ Console `198eb69`)*

### Pixel-missing (still on unified.yaml — Fake Stub no-op / live clear-miss)

Do **not** silently drop these edges from `unified.yaml`.

*(none — File Drop trio undeferred @ Console `198eb69`)*

### Engine-owned (not Pixel)

`enter_infra_fleet_walk`, all `infra_*`


## `--start-from` + Kolibri finish_exercise smokes (Prefer A)

Walks only (`--scenario cover-all|kolibri-*-smoke|…`). Markov rejects `--start-from`.

- `--start-from <N>` — 1-based step number matching `duration_step` numbering on the full walk; seeds `walker.current` to that step's `from`.
- `--start-from <action>` — first step whose `action` matches (e.g. `finish_exercise`).
- With `--iterations N`: apply start-from first, then truncate the remaining slice to N steps.
- Past end / unknown action → clear CLI error (exit 2).

**Smoke walks** (Fake Stub OK; live `--ui` needs Console@`f150b9e`+ for next_video/exit_lesson/browse_folders; finish_exercise needs `4f7cfba`+):

```bash
pnpm test:duration -- --scenario kolibri-learn-smoke --fast
pnpm test:duration -- --scenario kolibri-teacher-preview-smoke --fast
pnpm test:duration -- --scenario kolibri-next-video-exit-smoke --fast
pnpm test:duration -- --scenario nextcloud-share-smoke --fast   # Fake only — HOLD live (see below)
pnpm test:duration -- --scenario nextcloud-collab-smoke --fast     # Fake only — HOLD live until Atlas 198eb69 + GO
pnpm test:duration -- --scenario wikipedia-smoke --fast            # Fake only — HOLD live until Atlas 198eb69 + GO
pnpm test:duration -- --scenario nextcloud-file-drop-smoke --fast # Fake only — HOLD live until Atlas 198eb69 + GO
# Mid-cover-all without re-walking 1..11:
pnpm test:duration -- --scenario cover-all --start-from 12 --fast
pnpm test:duration -- --scenario cover-all --start-from finish_exercise --iterations 1 --fast
pnpm test:duration -- --scenario kolibri-learn-smoke --start-from finish_exercise --fast
```

`kolibri-next-video-exit-smoke` extends the teacher-preview path with `open_exercise` → `next_video` → `exit_lesson`. Mid-start on `finish_exercise` alone does **not** auto-navigate the page — live UI must already be on the pinned exercise, or run the full smoke.

**`nextcloud-share-smoke`** (8 steps, teacher): `open_console_as_teacher` → `open_nextcloud_as_teacher` → `browse_folders` → `share_to_class` → `done_sharing` → `share_to_class` → `back_to_console_from_share` → `return_to_start`. Seeded Grade5A pins only (`duration-nextcloud-grade5a-001` / `nextcloud-grade5a-001`), store_mode shared via unified.yaml. **HOLD live** until Atlas confirms Path A with Kid App#11 @`a443398` Prefer A fixtures + Kid `enable_sharing true` on the Grade 5A Files mount + Steve clear; needs Console@`198eb69`+ (Files settle @ b1d3d60). Share re-run waits Atlas 198eb69.

**`nextcloud-collab-smoke`** (7 steps, teacher): `open_console_as_teacher` → `open_nextcloud_as_teacher` → `browse_folders` → `open_collab_doc` → `keep_editing` → `close_doc` → `return_to_start`. Seeded Grade5A pins only. **HOLD live** until Atlas redeploys Console@`198eb69` + Steve/Atlas GO.

**`wikipedia-smoke`** (9 steps): learner `open_wikipedia_as_learner` → `search_browse_wikipedia` → `leave_wikipedia_as_learner` then teacher `open_wikipedia_as_teacher` → `leave_wikipedia_as_teacher` (names match cover-all.yaml). Kiwix pins `duration-kiwix-ideaa-001` / `kiwix-ideaa-001` (not infra_disk yet). **HOLD live** until Atlas redeploys Console@`198eb69` + Steve/Atlas GO.

**`nextcloud-file-drop-smoke`** (8 steps, learner): `open_console_as_learner` → `open_nextcloud_as_learner` → `browse_folders` → `open_file_drop` → `after_upload` → `open_file_drop` → `leave_file_drop` → `return_to_start` (names match cover-all.yaml). Seeded Grade5A pins only. **HOLD live** until Atlas redeploys Console@`198eb69` + Steve/Atlas GO.

**`--record-walk` caveat:** frames often show the Console Apps page, not the Kolibri tab — the recorder does not follow app tabs. Do not trust screenshots alone for Kolibri steps; prefer Intent `ok` / structured logs.

## Live demoMode OFF (PlaywrightUiDriver)

Before first `goto` to Engine-hosted Console (**idea01:8080** / any non-localhost base URL), `PlaywrightUiDriver` registers:

```ts
await context.addInitScript(() => { localStorage.setItem('demoMode', 'false') })
```

Sticky `localStorage.demoMode==='true'` (Pixel `bootDemo`) must not mask Kid fixtures on production web. **Do not** remap Intents to demo disk IDs (`DISK001` / `kolibri-disk`). **No** `DURATION_ALLOW_DEMO`. Pixel#134 @`cdcfdb1` also forces demo off via `isProductionWebMode()`.

## Path A — `--start-instances`

CLI `--start-instances` → `RealFleetOps({ startInstances: true })` (keep `instances/` on dock so Console shows Running cards) **and** `preserveDockedOnReturn` so `return_to_start` after infra dock does **not** undock — required for cover-registered-intents **dock-before-inventory** (`infra_dock_fixture` → … → `open_disk_inventory` on `disk-duration-kolibri-grade5a-001`). Fake default still undocks on return (hygiene).

Path A re-dock after eject: RealFleetOps does `rm -f` sentinel, `sleep 5`, then `touch` (Atlas — chokidar needs unlink before create, not mtime-only touch; Atlas Ops proof: 5s before touch). `dockFixture` waits up to **120s** for store dock, and on first timeout re-fires the sentinel once then waits again before failing.

Path A `infra_dock_fixture` re-dock (findDockedEngine miss / no walker dock): prefer non-excluded `poolEngines[0]` (Console host / idea01) — not RNG; also dock sibling `fixtureDisks` (nextcloud + empty-001 + empty-002) on the same engine. Empty packs prefer `idea-test-3` / `idea-test-4`.

**Prefer A r16 FAIL@65 → NC readiness:** `open_nextcloud_as_teacher` aborted ~31s after NC re-dock (`login form incomplete` on `idea01:18280`). Unlike Kolibri Path B `waitForSidecarHttpReady`, Engine did not wait for NC. Tip: `waitNextcloudSidecarReadyForEngine` after `infra_dock_fixture` settle (Path A no-op + re-dock) when any `fixtureDisks` id includes `nextcloud`; poll GET `/login` for user+password+submit HTML; `DURATION_NEXTCLOUD_READY_MS` default 180000; skip on FakeFleetOps.

**Prefer A r17 FAIL@58 → NC probe hostname:** readiness timed out probing Tailscale IP (`http://100.99.231.94:18280/login` → HTTP 400 untrusted domain). Post-run: IP → 400; `http://idea01:18280/login` → 200. Tip: NC readiness uses Engine logical id / hostname (trusted_domains), not `hostMap` Tailscale IP. Kolibri follow-host may still use IP. Do not treat 400 as up; do not change Pi trusted_domains.

Path A / `infra_reboot_engine --fast`: `rebootEngine` stops `kolibri-grade5a` / `nextcloud-grade5a` / `duration-*` containers (never `idea166-*`) before `pm2 restart`, then `reconcileDurationZombies` after `waitReady` so Automerge Running+Undocked fixtures do not trip `no_zombie_instances`.


## Multi-disk Prefer A preload (Pixel @b63e1ec + EmptyDiskPanel @db21bf4)

Live `--ui` Prefer A needs Console#134 **@48a4a05+** (Copy/Move + EmptyDiskPanel + erase empty-only / eject survivor). Preload:

1. **demoMode=false** — `PlaywrightUiDriver` initScript (already); production web ignores sticky demo.
2. **Four Path A disks docked on Console host (pool[0]/idea01)** — `duration-kolibri-grade5a-001` + `duration-nextcloud-grade5a-001` + `duration-empty-001` + **`duration-empty-002`** (Kid App#10 @`f945203` packs `fixtures/empty/` + `fixtures/empty-002/`). Prefer slots **idea-test-1 / idea-test-2 / idea-test-3 / idea-test-4** under `IDEA_DISKS_ROOT` (empty-001 → **idea-test-3**, empty-002 → **idea-test-4** when free). Path A `--start-instances` keeps instances/ on app disks. **Empty packs must be fresh from Kid pack before EmptyDiskPanel Intents** — Engine `sshDockCopy` always `rm -rf` + `cp -a` for packs `empty` / `empty-002` on every `dockFixture` (never Path A reuse). Prior `install_app` / `make_backup` leaves `apps/` → Engine `isAppDisk` → app badge / no EmptyDiskPanel; empty packs have no docker-owned instance files so wipe is safe. Kolibri/Nextcloud Grade5A keep reuse (docker-owned `instances/`).
3. **Live env (Prefer A r17)** — `DURATION_EMPTY_DISK_ID=duration-empty-001` for early EmptyDiskPanel / `make_backup_*` — do **not** remap onto Kolibri Grade5A. **`DURATION_BACKUP_DISK_ID=duration-empty-001`** after `make_backup_disk` (same pack; role=backup) for `restore_from_backup`. Keep **`duration-empty-002` docked** so Pixel @`48a4a05` `erase_disk` → `ensureEmptyDiskPanel` can **discover** `data-role=empty` after empty-001 became backup (loud-fail if no empty). **`DURATION_EJECT_DISK_ID=duration-nextcloud-grade5a-001`** for post-erase `eject_disk`. Optional: `DURATION_COPY_SOURCE_DISK`, `DURATION_COPY_TARGET_DISK`, `DURATION_COPY_INSTANCE_ID` (default kolibri → nextcloud). Fixture source: `DURATION_FIXTURE_SOURCE_ROOT`.
4. **cover-registered-intents** — erase selects empty via Pixel EmptyDiskPanel discover (empty-002) — never Grade5A / never Backup (walk: `back_to_overview` → `open_disk_inventory` before `erase_disk` / `confirm_erase`). **`restore_from_backup`:** `back_to_overview` → `open_disk_inventory` with `DURATION_BACKUP_DISK_ID` before restore. Post-erase eject: `DURATION_EJECT_DISK_ID=duration-nextcloud-grade5a-001`.
5. **Late `install_app` after erase (Prefer A r24/r26 → Engine tip r27)** — After `confirm_erase` of empty-002, empty-002 **must remain docked** with `diskTypes=['empty']` + EmptyDiskPanel so late `install_app` (and the second late install) can discover `data-role=empty`. Pixel `ensureEmptyDiskPanel` already prefers `DURATION_EMPTY_DISK_ID` (=001) then discovers any empty-badge row — **no `DURATION_EMPTY_DISK_ID_2`**. Keep primary EMPTY=001. r24/r26 FAIL@85: erase@75–76 left empty-002 **absent** from diskDB (idea-test-4 META-only/sparse); empty-001 stayed app+backup; empty-badge rows=0 → starve. **Atlas Path A** should still prefer operator erase of idea-test-4 to republish docked `['empty']` (chokidar/sentinel). **Engine live safety net (r27):** after walk `confirm_erase` succeeds, `redockEmpty002AfterErase` force undocks (if present) then `dockFixture` Kid pack `fixtures/empty-002/` onto Console host `pool[0]` / `walker.dockedEngine` (preferred slot idea-test-4; empty always-fresh-copy). Between-run Atlas re-dock alone is not enough — erase mid-walk undocks again.
6. **Late `start_after_install` (Prefer A r27 FAIL@86 → tip r28)** — After late `install_app` on empty-002, `start_after_install` must start the **newly installed** uuid on that disk — **not** `kolibri-grade5a-001` (Stopped on nextcloud after move/backup). Engine `defaultIdsForIntent` omits grade5a `instanceId` for `install_app` / `start_after_install` (empty diskId only). Pixel @`2c55756`: wait install settle, leave Install picker, ALL APPS, discover non-grade5a `start-*` (override `DURATION_START_AFTER_INSTALL_ID`). Keep `start_instance` Path A grade5a. Do **not** set `DURATION_EMPTY_DISK_ID=002` as primary. Do **not** regress `redockEmpty002AfterErase` @`6d1e144`.
7. **Late `install_app` stale `--source` (Prefer A r31 FAIL@86)** — After `make_backup_disk`, empty-001 is backup and often has **no** `apps/kolibri-1.0` (BACKUP.yaml+META only), but appDB may still advertise `source=disk` / `sourceDiskId=duration-empty-001` (or a prior walk left the pointer). Console EmptyDiskPanel then sends `installApp … --source empty-001` → Engine "App not found" → no new empty-002 instance → `start_after_install` sees Install picker / ids=[]. **Product fix (Engine):** if `--source` disk lacks `apps/<appId>`, fall through to **GitHub** when online (Kid tag `1.0` present); else scan other docked disks for the bundle. `indexBackupDiskApps` clears stale source pointers when `apps/` is missing/empty. Prefer online install over copying from Grade5A (fast local copy would finish early install onto empty-001 and starve EmptyDiskPanel for make_files). Keep port tip `650d3ac`, omit-grade5a `71456e1`, re-dock `6d1e144`. **Console:** deploy Pixel @`2c55756` (soft early install + start_after_install discover) — served `873e113` still reuses grade5a for start_after_install.

8. Late start_after_install auto-start race (Prefer A r32 FAIL@86). Engine waitEmpty002PostInstallRunning before Intent. Pixel runStartInstance should wait on Starting→Running.

9. **Second late `install_app` needs empty-002 Empty again (Prefer A r35/r36 FAIL@90)** — Late `install_app`@85 + `start_after_install`@86 fills `duration-empty-002` with kolibri (app disk). Then `copy_app`@87 PASS, `open_copied`@88, `back_to_disk`@89, second `install_app`@90 FAIL — no EmptyDiskPanel (empty-001 is backup; empty-002 is app). ACTIONS.md already said the second late install needs empty-002 Empty — `start_after_install` broke that. **Engine live safety net (r35):** after walk `open_copied_instance` succeeds, `redockEmpty002BeforeSecondInstall` mirrors `redockEmpty002AfterErase` — force undock (if present) then `dockFixture` Kid pack `fixtures/empty-002/` onto Console host `pool[0]` / `walker.dockedEngine` (preferred slot idea-test-4; empty always-fresh-copy). **r36 store purge:** FS wipe alone is not enough — Automerge `instanceDB` rows with `storedOn=duration-empty-002` survive; Console `hasInstancesOn` keys off store (not FS) → still shows empty-002 as **app** / kolibri / APPS 1 / no EmptyDiskPanel. AfterErase works without purge because erase cleared instances; BeforeSecondInstall must `purgeInstancesStoredOn(engine, duration-empty-002)` (delete matching keys; stop Running/Starting duration docker by exact id; set `diskTypes=['empty']`). Do **not** regress AfterErase @`6d1e144`. FakeFleetOps deletes synthetic instanceDB rows for that diskId so Fake CRI stays green.

10. **Late `erase_disk` after second late install (Prefer A r37 FAIL@92)** — BeforeSecondInstall@88 + purge got second `install_app`@90 PASS, but that install fills empty-002 with kolibri again → `stay_on_disk`@91 PASS → `erase_disk`@92 FAIL (empty-badge rows=0; empty-001=backup; empty-002=app). **Engine live safety net (r37):** after walk `stay_on_disk` succeeds (only CRI occurrence; precedes late erase), `redockEmpty002BeforeErase` mirrors BeforeSecondInstall — undock+dockFixture Kid pack empty-002/ + `purgeInstancesStoredOn` (same purge flag). Do **not** regress AfterErase (no purge) or BeforeSecondInstall.

11. **`files_role_added` after `infra_move_disk` + dirty empty (Prefer A cover-all-843d154-r20 FAIL@92)** — Step 62 moves Kolibri Grade5A idea01→idea03. cover-all op-files then `install_app`@88 dirties empty-001; `make_files_disk`@91 Pixel soft-passes while Engine `createFilesDisk` refuses ("has other files… README.md, apps, instances, services") because settle matches Nextcloud's tree `[data-role=files]` badge; `files_role_added`@92 waits for hard-coded `disk-duration-kolibri-grade5a-001` (absent on Console). **Engine tip (harness-only; Con 230b70f / Eng 8d98718 leave-as-is):** (1) `defaultIdsForIntent` + `runUiIntent` pass **empty-001** (or `DURATION_FILES_DISK_ID` after convert) for `make_files_disk` / `add_files_role` / `files_role_added` / backup+erase EmptyDiskPanel Intents — **not** Kolibri. (2) `redockEmpty001BeforeMakeFiles` before `make_files_disk` (fresh empty pack + store purge). (3) `buildSshDockCopyRemote` strips non-META on empty/empty-002 (Kid README.md blocks createFilesDisk). (4) Playwright post-check: store `diskTypes` must include `files` or fail loud. Do **not** silently move Kolibri back for files_role_added — Atlas Path A may still restore Kolibri→idea01 for later App-open. Never idea02.

Do **not** live-run until Atlas confirms idea01 `:8080` serves Console @`2c55756` (or later tip with start_after_install discover) **and** both `duration-empty-001` + `duration-empty-002` are docked (and empty-002 stays Empty through late install after erase).

## Live Console / Kid App-open

Base URL live: Engine-served Console on port **8080** (`http://idea01:8080`). Canonical pool idea01+idea03+idea04 (never idea02).

**Kid Running after dock (later live App-open — do not block Fake):**  
`post-dock-restore-running.sh` → restores instances under `idea166-kolibri-live` on **:18080** (behind Engine :80 proxy). RealFleetOps `dockFixture` defaults to dock-only (strips `instances/`). Until Kid sidecar leaves Running cards, live `--ui` App-open Intents may fail — Fake Stub remains OK for full-graph CI proof; prefer `--live --ui` for real walks as Pixel+Kid land.

Deprecated CLI aliases (`minimal-*`, `stress`, `school-day`) load **`unified.yaml`** (Markov). Prefer `--scenario random` / `unified` for Markov, `--scenario cover-registered-intents` (alias `cover-hardpass`; chat: registered-intents walk) for the live `--ui` demo walk, or `--scenario cover-all` for the strict full-graph walk. Hosts/iterations/live/ui are CLI knobs — not alternate graphs.

## Fixture disk targets (Kid / agent-app-dev#10)

| Action | diskId | instanceId |
|---|---|---|
| `infra_dock_fixture` (primary) | `duration-kolibri-grade5a-001` | `kolibri-grade5a-001` |
| nextcloud pack | `duration-nextcloud-grade5a-001` | `nextcloud-grade5a-001` |
| wikipedia / kiwix (Prefer A / App#11) | `duration-kiwix-ideaa-001` | `kiwix-ideaa-001` |
| empty pack (EmptyDiskPanel / make_backup) | `duration-empty-001` | — (no instance; slot idea-test-3; early `DURATION_EMPTY_DISK_ID`) |
| empty pack #2 (Prefer A r17 erase + late install) | `duration-empty-002` | — (Kid pack `empty-002/`; slot idea-test-4; erase discover **and** must stay Empty after erase for late `install_app`) |
| Backup Disk (post `make_backup_disk`) | `duration-empty-001` via `DURATION_BACKUP_DISK_ID` | — (role=backup; required before `restore_from_backup`; **not** erase target) |
| eject after erase (late walk) | `duration-nextcloud-grade5a-001` via `DURATION_EJECT_DISK_ID` | — Prefer A post-erase survivor; Pixel also discovers ejectable row |

Content pins (stable): `open_video` contentId `e60662de-b15c-52f9-b003-359f7d91f8fd` / nodeId `4a1a1b92-3f6d-59eb-a94c-3f91f0011dd5`; `open_exercise` contentId `7eb9de46-96eb-53d0-bcc1-2fb270b96f03` / nodeId `94a47ec7-f30d-5cd1-93f8-ad08c42b6c2a`. Auth Morango IDs are re-provision mutable.

`infra_undock_fixtures` undocks **all** infra-eligible fixture disks. Kiwix omitted from infra dock until wiki edges go live (not infra_disk in unified.yaml).

**UI Intent fixture remap** (`actions.ts` `runUiIntent`): defaults are primary kolibri Grade5A; Intents whose name includes `nextcloud` remap to nextcloud Grade5A from `fixtureInstances`; names including `wikipedia` / `kiwix` remap to Prefer A Kiwix pins (`duration-kiwix-ideaa-001` / `kiwix-ideaa-001`, falling back to `DURATION_UI_FIXTURES.kiwix` when not in `fixtureInstances`); `kolibri` / `open_video` / `open_exercise` stay on kolibri. Playwright must not receive kolibri `instanceId` for wikipedia Intents (r1 FAIL@2: Open landed on Kolibri :18080 signin).

## Phase 4 stability

During dwell between transitions (~30s; `--fast` → ~80ms): WS ping + docker ps / status anomaly; fail after 3 consecutive probe failures, with `docker missing` aborting on its first sample except immediately after `move_app`/`copy_app`/`infra_move_disk`/`confirm_eject`, which gets up to 90s (1s under `--fast`; `confirm_eject` at least 15s) to reappear or leave Running/Starting before aborting if still ghost. An undocked disk (or one docked to another engine) is not a docker-missing ghost. `--no-stability` to skip.

## Live fleet (`--live` / RealFleetOps)

- Default remains FakeFleetOps. Pass `--live` + `--hosts idea01=IP,idea03=IP,idea04=IP`.
- Never target idea02. Never eject the idea03 Intenso Files Disk.
- Do not claim Pis from this doc — Axle coords Atlas.
