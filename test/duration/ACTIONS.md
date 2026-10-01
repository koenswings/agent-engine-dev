# Duration-test Intent action keys

**Contract owner:** Axle (Engine walker). Pixel matches Playwright adapters to these keys.  
**Locked** by Steve Design Review for idea#166 — do not rename without reporting a clash.  
**Phase 3+4 (idea#168):** walker dispatches usage/operator Intents via `test/duration/ui/` → Pixel `e2e/intents` (`getIntent`).

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

## Usage / operator (Phase 3 → Pixel Playwright)

Fake/CI default: `StubUiDriver` (no browser). Live UI: `pnpm test:duration -- --ui` → `PlaywrightUiDriver` loads Pixel `getIntent` from `agent-console-dev/e2e/intents` (or `DURATION_CONSOLE_INTENTS`).

**Pixel-registered (Console#134):**  
`open_console_as_*`, `return_to_start`, `stay_on_*`, `open_kolibri_as_*`, `open_nextcloud_as_*`, `open_video`, `open_exercise`, `open_disk_inventory`, `open_instance_controls`, `eject_disk`, `confirm_eject`, `cancel_eject`, `erase_disk`, `confirm_erase`, `cancel_erase`, `start_instance`, `stop_instance`, `open_account`, `close_account`, `open_settings`, `close_settings`, `sign_in`, `make_files_disk`, `add_files_role`

**Deferred (clear message, not silent):** `keep_watching`, `next_resource`, `exit_lesson`, `open_wikipedia_*`

**Not registered (Engine-owned):** `enter_infra_fleet_walk`, all `infra_*`

Base URL live: Engine port 80 `http://idea01` (NOT Vite 5173). Prefer idea01+idea03 for Playwright (Kolibri live on idea01).

**2-engine UI scenario:** `school-day-2engine` — pool idea01+idea03 only; unique store; hardpass Intents including `open_video` / `open_exercise` (Kid pins); no deferred chrome.

## Fixture disk targets (Kid / agent-app-dev#10)

| Action | diskId | instanceId |
|---|---|---|
| `infra_dock_fixture` (primary) | `duration-kolibri-grade5a-001` | `kolibri-grade5a-001` |
| nextcloud pack | `duration-nextcloud-grade5a-001` | `nextcloud-grade5a-001` |

Content pins (stable): `open_video` contentId `e60662de-b15c-52f9-b003-359f7d91f8fd` / nodeId `4a1a1b92-3f6d-59eb-a94c-3f91f0011dd5`; `open_exercise` contentId `7eb9de46-96eb-53d0-bcc1-2fb270b96f03` / nodeId `94a47ec7-f30d-5cd1-93f8-ad08c42b6c2a`. Auth Morango IDs are re-provision mutable.

`infra_undock_fixtures` undocks **all** infra-eligible fixture disks. Kiwix omitted.

## Phase 4 stability

During dwell between transitions (~30s; `--fast` → ~80ms): WS ping + docker ps / status anomaly. Fail after 3 consecutive probe failures. `--no-stability` to skip.

## Live fleet (`--live` / RealFleetOps)

- Default remains FakeFleetOps. Pass `--live` + `--hosts idea01=IP,idea03=IP`.
- Never target idea02. Never eject the idea03 Intenso Files Disk.
- Do not claim Pis from this doc — Axle coords Atlas.
