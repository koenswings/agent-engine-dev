# Duration-test Intent action keys

**Contract owner:** Axle (Engine walker). Pixel matches Playwright stubs to these keys.  
**Locked** by Steve Design Review for idea#166 Phase 1–2 — do not rename without reporting a clash.

YAML transition shape (all layers): `{ to, weight, action }`.

## Hub / cross-layer

| Key | Meaning |
|---|---|
| `return_to_start` | Clear layer context; undock fixtures if leaving infra_docked; next sample from `start` |
| `enter_infra_fleet_walk` | Enter infra subgraph at `infra_idle` (undock fixtures first) |
| `open_console_as_teacher` | Usage entry → `console_teacher` (Phase 1–2: UI stub) |
| `open_console_as_learner` | Usage entry → `console_learner` (UI stub) |
| `open_console_as_operator` | Operator entry → `op_entry` (UI stub) |

## Infra (pool-only; never golden idea02)

| Key | Entry / effect |
|---|---|
| `infra_undock_fixtures` | `infra_idle` — Engine eject/undock fixture disks |
| `infra_dock_fixture` | `infra_docked` — Engine dock fixture on a pool engine |
| `infra_move_disk` | `infra_disk_moved` — undock then dock on another pool engine |
| `infra_reboot_engine` | `infra_reboot` — SSH reboot; `--fast` → `pm2 restart engine` |

## Usage / operator stubs (Phase 1–2 no-op; Pixel wires later)

Prefer proposal Intent titles snake_cased when naming YAML edges:

- `open_kolibri_as_teacher`, `open_kolibri_as_learner`
- `open_nextcloud_as_teacher`, `open_nextcloud_as_learner`
- `open_wikipedia_as_teacher`, `open_wikipedia_as_learner`
- `stay_on_teacher_overview`, `stay_on_learner_overview`, `stay_on_overview`
- `keep_watching`, `next_resource`, `exit_lesson`
- `open_disk_inventory`, `open_instance_controls`, `eject_disk`

Phase 3: `test/duration/ui/` Playwright adapters keyed by the same names.

## Fixture disk targets (Kid / agent-app-dev#10)

| Action | diskId | instanceId |
|---|---|---|
| `infra_dock_fixture` (primary) | `duration-kolibri-grade5a-001` | `kolibri-grade5a-001` |
| `infra_dock_fixture` / undock / move (also) | `duration-nextcloud-grade5a-001` | `nextcloud-grade5a-001` |

`infra_undock_fixtures` undocks **all** infra-eligible fixture disks. Kiwix omitted Phase 1–2.

## Live fleet (`--live` / RealFleetOps)

- Default remains FakeFleetOps. Pass `--live` + `--hosts idea01=IP,idea03=IP`.
- Scenario `minimal-live`: dock-free (`infra_reboot_engine` + hub stubs only).
- `infra_dock_fixture` / `infra_move_disk` require physical Kid USB fixtures — not on Pis yet.
- Never target idea02. Never eject the idea03 Intenso Files Disk.
