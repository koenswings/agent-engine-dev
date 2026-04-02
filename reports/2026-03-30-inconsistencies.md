# Report: Logical Inconsistencies — Architecture, Solution Description, and Code

**Date:** 2026-03-30  
**Updated:** 2026-04-01 (CEO review corrections applied)  
**Author:** Axle (Engine Developer)  
**Backlog task:** `83f843a4` — Find logical inconsistencies between architecture, solution description and current code  
**Sources reviewed:**
- `docs/SOLUTION_DESCRIPTION.md`
- `docs/ARCHITECTURE.md`
- `src/data/Disk.ts`, `Instance.ts`, `App.ts`, `Store.ts`, `Engine.ts`, `Commands.ts`
- `src/monitors/usbDeviceMonitor.ts`, `storeMonitor.ts`, `timeMonitor.ts`, `mdnsMonitor.ts`
- `script/build_image_assets/90-docking.rules`

---

## Severity classification

- **Critical** — logic bug or data loss risk
- **High** — operational feature described as working but not implemented
- **Medium** — documentation doesn't match code; causes confusion
- **Low** — minor gap or stale text; low operational impact

---

## Finding 1 — `removeInstance` deletes instances; `undockDisk` preserves them [CRITICAL — open]

**Files:** `src/data/Disk.ts::removeInstance()` vs `src/monitors/usbDeviceMonitor.ts::undockDisk()`

`undockDisk` (physical USB removal) sets `status = 'Undocked'` and preserves the entry in `instanceDB`.

`removeInstance` (called by `processAppDisk` when an instance folder is gone on re-scan) sets `status = 'Undocked'` then immediately `delete doc.instanceDB[instanceId]` — the status set is dead code.

**Context (CEO):** `removeInstance` is called when the app is physically no longer on the disk — a different scenario from undock, where the data is intact but the disk is not docked. An important edge case: if someone moved the instance directory to another disk that has not yet been docked, deleting the instanceDB entry loses the history and breaks the reconnection when the new disk is eventually docked.

**Proposed fix:** Add a new `'Missing'` status to the `Status` type. Use it in `removeInstance` instead of deleting the entry. This:
- Preserves instance history
- Allows clean reconnection if the instance reappears on a newly docked disk (same instanceId found → `storedOn` updated)
- Distinguishes "disk removed, data intact" (`Undocked`) from "instance directory gone from disk" (`Missing`)

**Status:** Awaiting CEO decision on `'Missing'` status vs reusing `'Undocked'`.

---

## Finding 2 — Backup, Upgrade, and Files disk types are unimplemented stubs [HIGH — backlog]

**File:** `src/data/Disk.ts`

`isBackupDisk`, `isUpgradeDisk`, and `isFilesDisk` all return `false`. A docked Backup Disk or Files Disk silently does nothing.

**CEO:** Implementation of these disk types belongs on the backlog, not in ARCHITECTURE.md. Architecture documents what is built; it should not note unimplemented features.

**Status:** ARCHITECTURE.md left unchanged for this finding. Backlog tasks created (see backlog section at end of this report).

---

## Finding 3 — Dead monitor files [MEDIUM — resolved PR #30]

Five files in `src/monitors/` had all code commented out:
`diskMonitor.ts`, `enginesMonitor.ts`, `instancesMonitor.ts`, `interfaceMonitor.ts`, `webSocketMonitor.ts`

**Resolution:** All five files deleted in PR #30.

---

## Finding 4 — Dead HTML server code [MEDIUM — resolved PR #26 + PR #30]

`instancesMonitor.ts` contained a full HTML page generator (`generateHTML`) that was the original "Console as Engine-served web page" approach. All calls were commented out; the file also had a stale import in `storeMonitor.ts`.

**Resolution:** PR #26 replaced this with a real HTTP server (`httpMonitor.ts`) serving the Console `dist/`. PR #30 deleted `instancesMonitor.ts` and cleaned up the stale comment in `storeMonitor.ts`.

---

## Finding 5 — Solution Description Data Syncing `[[TBD]]` marker [MEDIUM — partially resolved]

The Data Syncing section in the Solution Description opens with a `[[TBD]]` marker and a note that "Engine syncing has not been released yet."

**CEO correction:** The mesh topology described in that section IS what is implemented. Engine syncing is released. The described architecture (Console connects to one Engine; Engines use DNS-SD to find and WebSocket-connect to each other; Automerge sync propagates changes across the mesh) accurately describes the current codebase.

The only true gap is Console onboarding behaviour: scanning for `appdocker01.local`–`appdocker10.local` on first launch is described as the intended approach but is not yet implemented in the Console.

**Fix:** Remove the `[[TBD]]` prefix from the Data Syncing section of the Solution Description. The topology description is accurate and should remain. Console onboarding is a Console-side task.

**Status:** `[[TBD]]` removal pending (minor edit to Solution Description).

---

## Finding 6 — udev rule missing `sd?1` for single-partition disks [MEDIUM — resolved PR #30]

The rule `KERNEL=="sd?|sd?2"` created symlinks for whole-disk devices (`sda`) and second-partition dual-partition disks (`sda2`), but not for first-partition single-partition disks (`sda1`).

**Resolution:** Rule updated to `KERNEL=="sd?|sd?1|sd?2"` in PR #30. ARCHITECTURE.md now documents all three device patterns.

---

## Finding 7 — `Disk` interface has no `type` field [MEDIUM — resolved PR #30]

No explicit `type` field exists. Disk type is inferred at runtime from filesystem content.

**CEO:** Agrees with documenting this design choice.

**Resolution:** ARCHITECTURE.md updated in PR #30 with an explanation of content-based disk type detection and the rationale (allows multi-purpose disks).

---

## Finding 8 — Unimplemented commands [MEDIUM — backlog]

Seven commands described in the Solution Description are not implemented: `ejectDisk`, `copyApp`, `moveApp`, `backupApp`, `restoreApp`, `upgradeApp`, `upgradeEngine`.

**CEO:** Agreed. All should be on the backlog. Features that depend on each other go in one backlog item. See backlog section below.

---

## Finding 9 — Backup Disk operations [HIGH — backlog]

Three backup modes (immediate, scheduled, on-demand), BorgBackup integration, and backup progress reporting are described in the Solution Description. None is implemented.

**CEO:** Solution Description should continue to document the intent. Implementation goes on the backlog.

**Status:** Solution Description unchanged. Backlog task created (grouped with `backupApp`/`restoreApp` commands).

---

## Finding 10 — Architecture doc should not document future intent [MEDIUM — resolved by policy]

Original finding proposed adding "not yet implemented" notes to ARCHITECTURE.md for unimplemented disk types and features.

**CEO:** Rejected. Architecture is an authoritative doc describing only what IS built. It should not contain forward-looking notes. Solution Description is where intent lives.

**Resolution:** No changes made to ARCHITECTURE.md for this finding. Finding 2 (Backup/Files/Upgrade stubs) handled through backlog only.

---

## Unimplemented features scan

### Corrections from CEO review

**Multi-engine app distribution** *(originally listed as unimplemented)*: Removed. The Solution Description language about "distributing apps across Appdockers" describes an operator practice (deliberately docking apps to different engines to balance load), not a system feature to be automated. `assignAppsToEngines()` in `Store.ts` is a utility for deterministic assignment; it is not a runtime feature.

**User notifications** *(originally listed as Engine-side gap)*: Push notifications when apps become available should be driven by store updates triggering a monitor in the Console — not by the Engine pushing notifications. This is a Console concern. `3. User notifications` removed from Engine backlog.

**Offline Docker images from `services/` directory**: CEO confirms this works in the field. The gap is test coverage — this code path is skipped in `testMode` (Docker Hub is used instead). Needs a test that exercises the `services/` tar-loading path. Added to backlog.

---

## New backlog tasks (from this review)

The following grouped tasks should be tracked in Mission Control. Items that depend on each other are grouped into one task.

| Group | Task | Linked features |
|---|---|---|
| A | ejectDisk command | standalone |
| B | copyApp + moveApp commands | rsync infrastructure, remote App copy/move |
| C | backupApp + restoreApp + Backup Disk type | BorgBackup, backup modes, lastBackedUp tracking |
| D | upgradeApp command + minor upgrade proposal | `isMajorUpgrade()` wiring, upgrade proposal in store |
| E | upgradeEngine command + Engine self-upgrade detection | version comparison in mDNS handler |
| F | Files Disk type + network filesystem mount | `isFilesDisk`, auto-mount logic |
| G | Empty Disk detection + Console-driven provisioning | detect Empty Disk, trigger Console action |
| H | Engine Disk upgrade flow | detect Engine Disk, propose upgrade |
| I | USB Gadget — LAN access for non-host computers | gadget mode networking, how other LAN clients reach apps |
| J | Offline Docker image loading — test coverage | test the `services/` tar path; currently skipped in testMode |
| K | Per-engine SSH keypair generation | already has design proposal in `idea/design/ssh-key-management.md` |

App Catalog Disk, Client Disk, and Docker metrics collection are lower priority and not grouped here.
