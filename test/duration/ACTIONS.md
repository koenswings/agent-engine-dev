# Duration-test Intent action keys

**Contract owner:** Axle (Engine walker). Pixel matches Playwright adapters to these keys.  
**Locked** by Steve Design Review for idea#166 — do not rename without reporting a clash.  
**Phase 3+4 (idea#168):** walker dispatches usage/operator Intents via `test/duration/ui/` → Pixel `e2e/intents` (`getIntent`).  
**ONE graph:** `scenarios/unified.yaml` is the only Markov state table. Run modes = CLI knobs.  
**Pixel registry:** Console#134 tip `cdcfdb1` — **65** Intent keys (+ `captureAfterIntent` / `screenshotPath` for `--record-walk`; production web ignores sticky `demoMode`). Engine ACTIONS.md on #145 is source for walker contract.

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
| `infra_dock_fixture` | `infra_docked` — Engine dock fixture on a pool engine |
| `infra_move_disk` | `infra_disk_moved` — undock then dock on another pool engine |
| `infra_reboot_engine` | `infra_reboot` — SSH reboot; `--fast` → `pm2 restart engine` (Path A: stop duration docker zombies before/after pm2 so `no_zombie_instances` holds) |

## Usage / operator Intent registry

**Prefer real UI:** `--live --ui` once Pixel adapters harden (Fake `StubUiDriver` = CI / missing-Intent only).  
With `--ui`, Engine always uses `PlaywrightUiDriver` — deferred / unregistered Intents soft-skip or clear-fail via `failLoud`; never silently force Stub for registered Intents.  
Recording + **cover-hardpass** (Pixel-registered demo + infra; live `--ui` demo; `copy_app`/`move_app` require Console#134 @`b63e1ec`+ multi-disk) or cover-all (strict full graph) / random with `--ui --live` (+ `--record-walk <dir>`) is the intended verification path once Pixel+Atlas are ready. cover-all under `--ui` keeps failLoud abort on Pixel-missing (no soft-skip); a live cover-all retry requires Console@`ba0cfa1`.

Fake/CI default: `StubUiDriver` (no browser). Live UI: `pnpm test:duration -- --live --ui` → `PlaywrightUiDriver` loads Pixel `runDurationIntent` / optional `captureAfterIntent` from `idea-console/duration-intents` or `agent-console-dev/e2e/intents` (or `DURATION_CONSOLE_INTENTS`).

### Pixel-registered (65 — Console#134 @ ba0cfa1)

Hub/dwell: `open_console_as_*`, `return_to_start`, `stay_on_*`  
App-open: `open_kolibri_as_teacher` → `/en/coach/#/classes`, `open_kolibri_as_learner`, `open_nextcloud_as_*`, `open_video`, `open_exercise`
Operator: `open_disk_inventory`, `open_instance_controls`, `eject_disk`, `confirm_eject`, `cancel_eject`, `erase_disk`, `confirm_erase`, `cancel_erase`, `start_instance`, `stop_instance`, `open_account`, `close_account`, `open_settings`, `close_settings`, `sign_in`, `make_files_disk`, `add_files_role`  
Operator deep: `install_app`, `start_after_install`, `stay_on_disk`, `make_backup_disk`, `restore_from_backup`, `open_app`, `backup_instance`, `back_to_disk`, `back_to_overview`, `log_out`, `notice_usb_dock`, `retry_login_first_time_setup`, `change_password`, `add_operator`, `remove_operator`, `copy_app`, `move_app`  
**Coaching (Console#134 @ ba0cfa1):** `create_class`, `enroll_learners`, `build_lesson`, `create_quiz`, `read_reports`, `preview_as_learner`, `browse_classes`

**Part B leftovers + leave/back (@ ba0cfa1; `back_to_console` hardened):** `files_role_added`, `backup_configured_restored`, `done_redistribute`, `stay_on_source_disk`, `open_copied_instance`, `switch_engine`, `reboot_engine`, `back_to_console`, `leave_kolibri`, `leave_nextcloud_as_teacher`, `leave_nextcloud_as_learner`

### Deferred (clear message, not silent)

`keep_watching`, `next_resource`, `exit_lesson`, `open_wikipedia_as_teacher`, `open_wikipedia_as_learner`

### Pixel-missing (still on unified.yaml — Fake Stub no-op / live clear-miss)

Do **not** silently drop these edges from `unified.yaml`.

**Kolibri navigation:** `finish_exercise`, `next_video`

**Nextcloud deep:** `share_to_class`, `done_sharing`, `back_to_console_from_share`, `open_file_drop`, `after_upload`, `leave_file_drop`, `open_collab_doc`, `close_doc`, `keep_editing`, `browse_folders`

**Wikipedia leave/search:** `search_browse_wikipedia`, `leave_wikipedia_as_learner`, `leave_wikipedia_as_teacher`

### Engine-owned (not Pixel)

`enter_infra_fleet_walk`, all `infra_*`


## Live demoMode OFF (PlaywrightUiDriver)

Before first `goto` to Engine-hosted Console (**idea01:8080** / any non-localhost base URL), `PlaywrightUiDriver` registers:

```ts
await context.addInitScript(() => { localStorage.setItem('demoMode', 'false') })
```

Sticky `localStorage.demoMode==='true'` (Pixel `bootDemo`) must not mask Kid fixtures on production web. **Do not** remap Intents to demo disk IDs (`DISK001` / `kolibri-disk`). **No** `DURATION_ALLOW_DEMO`. Pixel#134 @`cdcfdb1` also forces demo off via `isProductionWebMode()`.

## Path A — `--start-instances`

CLI `--start-instances` → `RealFleetOps({ startInstances: true })` (keep `instances/` on dock so Console shows Running cards) **and** `preserveDockedOnReturn` so `return_to_start` after infra dock does **not** undock — required for cover-hardpass **dock-before-inventory** (`infra_dock_fixture` → … → `open_disk_inventory` on `disk-duration-kolibri-grade5a-001`). Fake default still undocks on return (hygiene).

Path A re-dock after eject: RealFleetOps does `rm -f` sentinel, `sleep 5`, then `touch` (Atlas — chokidar needs unlink before create, not mtime-only touch; Atlas Ops proof: 5s before touch). `dockFixture` waits up to **120s** for store dock, and on first timeout re-fires the sentinel once then waits again before failing.

Path A `infra_dock_fixture` re-dock (findDockedEngine miss / no walker dock): prefer non-excluded `poolEngines[0]` (Console host / idea01) — not RNG; also dock sibling `fixtureDisks` on the same engine.

Path A / `infra_reboot_engine --fast`: `rebootEngine` stops `kolibri-grade5a` / `nextcloud-grade5a` / `duration-*` containers (never `idea166-*`) before `pm2 restart`, then `reconcileDurationZombies` after `waitReady` so Automerge Running+Undocked fixtures do not trip `no_zombie_instances`.


## Multi-disk copy_app / move_app preload (Pixel Prefer A @b63e1ec)

Live `--ui` hardpass needs Console#134 **@b63e1ec+** (real HTML5 drag + Copy/Move modal). Preload:

1. **demoMode=false** — `PlaywrightUiDriver` initScript (already); production web ignores sticky demo.
2. **Both duration disks docked** — `duration-kolibri-grade5a-001` + `duration-nextcloud-grade5a-001` (Path A `--start-instances` keeps instances/).
3. **Optional env** — `DURATION_COPY_SOURCE_DISK`, `DURATION_COPY_TARGET_DISK`, `DURATION_COPY_INSTANCE_ID` (Pixel defaults: kolibri → nextcloud). Sidecars: `DURATION_KOLIBRI_URL` / `DURATION_NEXTCLOUD_URL` as needed.

Do **not** live-run until Atlas confirms idea01 `:8080` serves Console @`b63e1ec`.

## Live Console / Kid App-open

Base URL live: Engine-served Console on port **8080** (`http://idea01:8080`). Canonical pool idea01+idea03+idea04 (never idea02).

**Kid Running after dock (later live App-open — do not block Fake):**  
`post-dock-restore-running.sh` → restores instances under `idea166-kolibri-live` on **:18080** (behind Engine :80 proxy). RealFleetOps `dockFixture` defaults to dock-only (strips `instances/`). Until Kid sidecar leaves Running cards, live `--ui` App-open Intents may fail — Fake Stub remains OK for full-graph CI proof; prefer `--live --ui` for real walks as Pixel+Kid land.

Deprecated CLI aliases (`minimal-*`, `stress`, `school-day`) load **`unified.yaml`** (Markov). Prefer `--scenario random` / `unified` for Markov, `--scenario cover-hardpass` for the live `--ui` demo walk, or `--scenario cover-all` for the strict full-graph walk. Hosts/iterations/live/ui are CLI knobs — not alternate graphs.

## Fixture disk targets (Kid / agent-app-dev#10)

| Action | diskId | instanceId |
|---|---|---|
| `infra_dock_fixture` (primary) | `duration-kolibri-grade5a-001` | `kolibri-grade5a-001` |
| nextcloud pack | `duration-nextcloud-grade5a-001` | `nextcloud-grade5a-001` |

Content pins (stable): `open_video` contentId `e60662de-b15c-52f9-b003-359f7d91f8fd` / nodeId `4a1a1b92-3f6d-59eb-a94c-3f91f0011dd5`; `open_exercise` contentId `7eb9de46-96eb-53d0-bcc1-2fb270b96f03` / nodeId `94a47ec7-f30d-5cd1-93f8-ad08c42b6c2a`. Auth Morango IDs are re-provision mutable.

`infra_undock_fixtures` undocks **all** infra-eligible fixture disks. Kiwix omitted until wiki edges go live.

## Phase 4 stability

During dwell between transitions (~30s; `--fast` → ~80ms): WS ping + docker ps / status anomaly. Fail after 3 consecutive probe failures. `--no-stability` to skip.

## Live fleet (`--live` / RealFleetOps)

- Default remains FakeFleetOps. Pass `--live` + `--hosts idea01=IP,idea03=IP,idea04=IP`.
- Never target idea02. Never eject the idea03 Intenso Files Disk.
- Do not claim Pis from this doc — Axle coords Atlas.
