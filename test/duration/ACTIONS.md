# Duration-test Intent action keys

**Contract owner:** Axle (Engine walker). Pixel matches Playwright adapters to these keys.  
**Locked** by Steve Design Review for idea#166 — do not rename without reporting a clash.  
**Phase 3+4 (idea#168):** walker dispatches usage/operator Intents via `test/duration/ui/` → Pixel `e2e/intents` (`getIntent`).  
**ONE graph:** `scenarios/unified.yaml` is the only Markov state table. Run modes = CLI knobs.  
**Pixel registry:** Console#134 head `f26f737` — **47** Intent keys (Engine ACTIONS.md on #145 is source for walker contract).

YAML transition shape (all layers): `{ to, weight, action }`.

## Hub / cross-layer

| Key | Meaning |
|---|---|
| `return_to_start` | Clear layer context; undock fixtures if leaving infra_docked; Pixel dismisses modals when `--ui` |
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
| `infra_reboot_engine` | `infra_reboot` — SSH reboot; `--fast` → `pm2 restart engine` |

## Usage / operator Intent registry

Fake/CI default: `StubUiDriver` (no browser). Live UI: `pnpm test:duration -- --ui` → `PlaywrightUiDriver` loads Pixel `getIntent` from `agent-console-dev/e2e/intents` (or `DURATION_CONSOLE_INTENTS`).

### Pixel-registered (47 — Console#134 @ f26f737)

Hub/dwell: `open_console_as_*`, `return_to_start`, `stay_on_*`  
App-open: `open_kolibri_as_*`, `open_nextcloud_as_*`, `open_video`, `open_exercise`  
Operator: `open_disk_inventory`, `open_instance_controls`, `eject_disk`, `confirm_eject`, `cancel_eject`, `erase_disk`, `confirm_erase`, `cancel_erase`, `start_instance`, `stop_instance`, `open_account`, `close_account`, `open_settings`, `close_settings`, `sign_in`, `make_files_disk`, `add_files_role`  
**+17 operator deep:** `install_app`, `start_after_install`, `stay_on_disk`, `make_backup_disk`, `restore_from_backup`, `open_app`, `backup_instance`, `back_to_disk`, `back_to_overview`, `log_out`, `notice_usb_dock`, `retry_login_first_time_setup`, `change_password`, `add_operator`, `remove_operator`, `copy_app`, `move_app`

### Deferred (clear message, not silent)

`keep_watching`, `next_resource`, `exit_lesson`, `open_wikipedia_as_teacher`, `open_wikipedia_as_learner`

### Pixel-missing (still on unified.yaml — Fake Stub no-op / live clear-miss)

Do **not** silently drop these edges from `unified.yaml`.

**Kolibri coaching / navigation:** `create_class`, `enroll_learners`, `build_lesson`, `create_quiz`, `read_reports`, `preview_as_learner`, `back_to_console`, `browse_classes`, `leave_kolibri`, `finish_exercise`, `next_video`

**Nextcloud deep:** `share_to_class`, `done_sharing`, `back_to_console_from_share`, `open_file_drop`, `after_upload`, `leave_file_drop`, `open_collab_doc`, `close_doc`, `keep_editing`, `browse_folders`, `leave_nextcloud_as_learner`, `leave_nextcloud_as_teacher`

**Wikipedia leave/search:** `search_browse_wikipedia`, `leave_wikipedia_as_learner`, `leave_wikipedia_as_teacher`

**Operator still missing:** `backup_configured_restored`, `files_role_added`, `done_redistribute`, `stay_on_source_disk`, `open_copied_instance`, `switch_engine`, `reboot_engine`

### Engine-owned (not Pixel)

`enter_infra_fleet_walk`, all `infra_*`

## Live Console / Kid App-open

Base URL live: Engine-served Console on port **8080** (`http://idea01:8080`). Canonical pool idea01+idea03+idea04 (never idea02).

**Kid Running after dock (later live App-open — do not block Fake):**  
`post-dock-restore-running.sh` → restores instances under `idea166-kolibri-live` on **:18080** (behind Engine :80 proxy). RealFleetOps `dockFixture` defaults to dock-only (strips `instances/`). Until Kid sidecar leaves Running cards, live `--ui` App-open Intents may fail — use Fake Stub for full-graph proof.

Deprecated CLI aliases (`minimal-*`, `stress`, `school-day`) load **`unified.yaml`** (Markov). Prefer `--scenario random` / `unified` for Markov, or `--scenario cover-all` for the deterministic walk. Hosts/iterations/live/ui are CLI knobs — not alternate graphs.

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
