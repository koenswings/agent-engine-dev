# Report: Logical Inconsistencies — Architecture, Solution Description, and Code

**Date:** 2026-03-30  
**Author:** Axle (Engine Developer)  
**Backlog task:** `83f843a4` — Find logical inconsistencies between architecture, solution description and current code  
**Sources reviewed:**
- `docs/SOLUTION_DESCRIPTION.md`
- `docs/ARCHITECTURE.md`
- `src/data/Disk.ts`, `Instance.ts`, `App.ts`, `Store.ts`, `Engine.ts`, `Commands.ts`
- `src/monitors/usbDeviceMonitor.ts`, `storeMonitor.ts`, `instancesMonitor.ts`, `timeMonitor.ts`, `mdnsMonitor.ts`
- `script/build_image_assets/90-docking.rules`

---

## Severity classification

- **Critical** — logic bug or data loss risk
- **High** — operational feature described as working but not implemented
- **Medium** — documentation doesn't match code; causes confusion
- **Low** — minor gap or stale text; low operational impact

---

## Finding 1 — `removeInstance` deletes instances; `undockDisk` preserves them [CRITICAL]

**Files:** `src/data/Disk.ts::removeInstance()` vs `src/monitors/usbDeviceMonitor.ts::undockDisk()`

`undockDisk` (physical USB removal):
```ts
inst.status = 'Undocked'  // preserves entry in instanceDB
```

`removeInstance` (called by `processAppDisk` during re-scan if instance folder is gone):
```ts
instance.status = 'Undocked'
instance.storedOn = null
delete doc.instanceDB[instanceId]  // DELETES the entry
```

These two code paths handle "instance no longer available" differently:
- Physical undock → preserve history (correct per design intent)
- App folder missing on re-scan → delete permanently (inconsistent)

The `Undocked` status is meant to preserve history. Deleting from `instanceDB` loses it.
The automated tests in `test/automated/instance-lifecycle.test.ts` assert preservation
behaviour — but those tests exercise `undockDisk`, not `processAppDisk`.

**Fix:** `removeInstance` should set `status = 'Undocked'` and not delete the entry,
consistent with `undockDisk`.

---

## Finding 2 — Backup, Upgrade, and Files disk types are unimplemented stubs [HIGH]

**File:** `src/data/Disk.ts`

```ts
export const isBackupDisk = async (disk: Disk): Promise<boolean> => {
    return false  // Create dummy code that always returns false
}
export const isUpgradeDisk = async (disk: Disk): Promise<boolean> => {
    return false  // Create dummy code that always returns false
}
export const isFilesDisk = async (disk: Disk): Promise<boolean> => {
    return false  // Create dummy code that always returns false
}
```

The Solution Description describes all three disk types as operational system features
with detailed behaviour. `ARCHITECTURE.md` does not document that these are unimplemented.
A docked Backup Disk or Files Disk silently does nothing.

**Fix:** `ARCHITECTURE.md` should explicitly list these as not yet implemented.

---

## Finding 3 — Five monitors exist in code with no description in ARCHITECTURE.md [MEDIUM]

`src/monitors/` contains:

| File | Status in ARCHITECTURE.md |
|---|---|
| `usbDeviceMonitor.ts` | Described ✓ |
| `mdnsMonitor.ts` | Described ✓ |
| `timeMonitor.ts` | Described ✓ |
| `storeMonitor.ts` | Described ✓ |
| `diskMonitor.ts` | Not mentioned |
| `enginesMonitor.ts` | Not mentioned |
| `instancesMonitor.ts` | Not mentioned |
| `interfaceMonitor.ts` | Not mentioned |
| `webSocketMonitor.ts` | Not mentioned |

`ARCHITECTURE.md` should either document these or note that they are internal
utilities not part of the public monitor pattern.

---

## Finding 4 — `instancesMonitor.ts` HTML web server: dead code from a superseded Console strategy [MEDIUM]

**File:** `src/monitors/instancesMonitor.ts`, `src/monitors/storeMonitor.ts`

`instancesMonitor.ts` contains a full HTTP server that generates and serves a simple
HTML page listing running apps — this was the original "Console as web page served by
the Engine" described in the Solution Description.

All calls to `generateHTML()` in `storeMonitor.ts` are commented out:
```ts
// generateHTML(storeHandle)   // commented out in 3 places
```

The import still exists in `storeMonitor.ts`:
```ts
import { generateHTML } from './instancesMonitor.js'
```

The Solution Description says: "Currently, the Console UI is implemented as web page
served by each Engine." This is no longer true — the code is disabled. Meanwhile,
a proper Console extension is being built (Pixel, agent-console-dev).

**Fix:** Remove the dead HTML server code from `instancesMonitor.ts` and clean up the
import in `storeMonitor.ts`. Update the Solution Description to remove the "current
Console" paragraph.

---

## Finding 5 — Solution Description Data Syncing section is stale [MEDIUM]

**File:** `docs/SOLUTION_DESCRIPTION.md`, Network Architecture → Data Syncing

The section opens with:
> *"[[TBD]] Since Engine syncing has not been released yet, the procedure below will be
> subject to change once we proceed with the project"*

Engine syncing is fully implemented: mDNS advertisement and discovery via `ciao` and
`node-dns-sd`, WebSocket connections via `BrowserWebSocketClientAdapter`, Automerge
document sync. This `[[TBD]]` block describes a speculative design that was superseded
by the CRDT implementation.

The section also describes a non-CRDT approach (Engines acting as relays, Consoles
connecting to a single Engine as a gateway) that is different from the actual mesh
topology now implemented.

**Fix:** Update or replace this section to describe the actual Automerge mesh topology.

---

## Finding 6 — udev rule covers `sd?` (whole disk) not just `sd?2` (partition 2) [MEDIUM]

**File:** `script/build_image_assets/90-docking.rules`

Actual rule:
```
KERNEL=="sd?|sd?2", SYMLINK+="engine/%k"
```

Solution Description says:
> *"We use udev rules in Linux in order to create symlinks in the `/dev/engine` directory
> to `sd?2` devices"*

The rule creates symlinks for BOTH `sd?` (whole disk device, e.g. `sda`) AND `sd?2`
(second partition, e.g. `sda2`). Only `sd?2` (the second partition of ext4 App Disks)
is processed by the monitor — `sd?` entries are valid device nodes but App Disks
formatted with a single partition would appear as `sda1` not `sda2`, which is not matched.

This may be intentional (covering both single- and dual-partition disks) but is
undocumented. `ARCHITECTURE.md` says "The monitor watches `/dev/engine`" without
clarifying which device patterns are expected.

**Fix:** Document the device pattern intent in `ARCHITECTURE.md`.

---

## Finding 7 — `Disk` interface has no `type` field; Solution Description describes 7+ typed disks [MEDIUM]

**File:** `src/data/Disk.ts`

The `Disk` interface has no `type` field. Disk type is determined at runtime by
inspecting filesystem content:
- Has `apps/` folder → App Disk
- Has backup config (stub, not yet implemented) → Backup Disk
- etc.

The Solution Description describes Engine, Client, Empty, Upgrade, App, Backup,
App Catalog, and Files disks as distinct types.

`ARCHITECTURE.md` does not explain the "no explicit type field" design choice.
The `processDisk` comment notes: *"we currently allow Disks to be multi-purpose
and be used for apps, backups, upgrades, etc. This might change in the future"* —
but this rationale is buried in a code comment, not in any doc.

**Fix:** Document the type-inference approach in `ARCHITECTURE.md` and explain why there
is no explicit type field.

---

## Finding 8 — Commands listed in Solution Description are mostly unimplemented [MEDIUM]

**File:** `src/data/Commands.ts`

Solution Description lists these commands:
`ls`, `lsEngines`, `lsDisks`, `lsApps`, `lsInstances`, start/stop apps, **eject disks**,
**App copy**, **App move**, **App backup**, **App restore**, **App upgrade**,
**Engine upgrade**

Implemented in `commands` array:
`createInstance`, `startInstance`, `runInstance`, `stopInstance`, `connect`,
`buildEngine`, `send`

Not implemented: eject, copy, move, backup, restore, upgrade (App or Engine).

`ARCHITECTURE.md` does not document this gap.

**Fix:** `ARCHITECTURE.md` should list which commands are implemented and which are planned.

---

## Finding 9 — BorgBackup mentioned in Solution Description; absent from code [LOW]

**File:** `docs/SOLUTION_DESCRIPTION.md`

> *"Backups are performed using BorgBackup"*

There is no `borgbackup` dependency or any BorgBackup code anywhere in the codebase.
Backup disk handling is a stub (see Finding 2).

**Fix:** Remove the BorgBackup reference until backup is implemented. Add a `[planned]`
note or move to a separate design doc.

---

## Finding 10 — `App` entity in store vs "Remove App concept" backlog task [LOW]

**File:** `docs/ARCHITECTURE.md`, backlog task `d5ad1fcf`

`ARCHITECTURE.md` describes `appDB` as a first-class store entity alongside `instanceDB`.
There is an approved backlog task (`d5ad1fcf`) to remove the `App` concept entirely —
instances should carry all app metadata directly.

`ARCHITECTURE.md` does not mention this planned change, which means it describes a data
model that may not exist after `d5ad1fcf` is executed.

The Solution Description also hints at this:
> *"In the future, we might want to step away from the concept of an App and only talk
> about instances — instantiating an App Master is nothing else than cloning another
> App Instance"*

**Fix:** Add a note to `ARCHITECTURE.md` acknowledging that `appDB` is slated for removal.

---

## Summary

| # | Finding | Severity | Affects |
|---|---|---|---|
| 1 | `removeInstance` deletes; `undockDisk` preserves — inconsistent behavior | Critical | Data integrity |
| 2 | Backup/Upgrade/Files disk types are stubs | High | Feature completeness |
| 3 | 5 monitors undocumented in ARCHITECTURE.md | Medium | ARCHITECTURE.md accuracy |
| 4 | HTML web server / old Console in `instancesMonitor.ts` is dead code | Medium | Code hygiene |
| 5 | Data Syncing TBD block in Solution Description is stale | Medium | Solution Description accuracy |
| 6 | udev rule covers `sd?` and `sd?2`; docs say `sd?2` only | Medium | ARCHITECTURE.md accuracy |
| 7 | No `Disk.type` field; design rationale undocumented | Medium | ARCHITECTURE.md clarity |
| 8 | Most commands described in Solution Description are not implemented | Medium | ARCHITECTURE.md accuracy |
| 9 | BorgBackup reference with no code | Low | Solution Description accuracy |
| 10 | `appDB` removal planned but not noted in ARCHITECTURE.md | Low | ARCHITECTURE.md accuracy |

---

## Recommended next steps

1. **Fix Finding 1 immediately** — it's a code bug with data loss potential.
   `removeInstance` should not delete from `instanceDB`.

2. **Update `ARCHITECTURE.md`** — Findings 2, 3, 6, 7, 8, 10 are all docs gaps.
   These can be batched into a single PR.

3. **Clean up dead code** — Finding 4: remove HTML server code and the stale import.

4. **Update Solution Description** — Findings 5, 9: remove stale TBD section and
   BorgBackup reference. This lives in the org-level `SOLUTION_DESCRIPTION.md`.

Items 2–4 map to existing backlog tasks:
- `c9cb8515` — Update Architecture doc from Solution Description
- `3b0f08f6` — Review and improve Solution Description
