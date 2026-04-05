# Design: Backup Disk — backupApp + restoreApp

**Status:** Proposed  
**Date:** 2026-04-04  
**Author:** Axle  
**MC task:** `6403aa38`

---

## Problem

App Instances store all their data on the App Disk they live on. If that disk is lost, corrupted,
or physically destroyed, all data is gone. There is no recovery path.

Backup Disks are the solution: a dedicated drive that archives one or more App Instances on a
configurable schedule or on demand, using a deduplicating backup tool for efficiency and
resilience.

---

## Backup Tool: BorgBackup

Backups use **BorgBackup** (`borg`), not tar archives.

**Why Borg:**
- **Deduplicating** — only changed chunks are written; re-running a backup after an interruption
  is fast because unchanged data is already stored
- **Atomic archives** — a `borg create` that is interrupted does not corrupt the repository;
  the partial archive is silently discarded and the repository remains valid
- **Idempotent** — initiating a backup that was previously interrupted simply creates a new
  archive from scratch, but deduplication means it completes in near-O(delta) time. Effectively
  continues where it stopped.
- **Self-contained repository** — all archives for an instance live in one Borg repository
  directory; no external index or manifest required
- **Efficient restore** — `borg extract` extracts a specific archive or the latest

**Dependency:** `borg` must be installed on the Pi. Add to provisioning:
```bash
apt-get install -y borgbackup
```

---

## Backup Disk Format

A disk is a Backup Disk if it has a `BACKUP.yaml` file in its root.

```
/disks/<device>/
  META.yaml          ← standard disk identity
  BACKUP.yaml        ← identifies as Backup Disk; contains config and link state
  backups/
    <instanceId>/    ← Borg repository (one per linked instance)
      config         ← Borg repo config (created by borg init)
      data/
      index.*
      ...
```

### BACKUP.yaml

```yaml
mode: on-demand      # immediate | on-demand  (scheduled: future)
links:
  - instanceId: kolibri-00000000-xyz2
    lastBackup: 1712345678000   # Unix ms; 0 if never backed up; updated by Engine after each run
  - instanceId: sample-00000000-abc1
    lastBackup: 0
```

**`mode`:**
- `immediate` — backup runs automatically whenever a linked instance's App Disk is docked
  (either the Backup Disk docks while App Disk is already present, or the App Disk docks while
  the Backup Disk is already present)
- `on-demand` — no auto-trigger; backup must be initiated via the `backupApp` command

**`links`:** list of App Instance IDs this disk is responsible for. Linking is by instance ID
(not app name) — this prevents cross-site accidents when the same backup disk is carried
between schools.

The Engine writes `lastBackup` back to `BACKUP.yaml` after each successful backup run.

---

## Modes

| Mode | Meaning |
|---|---|
| `immediate` | Backup triggers automatically on dock events (Backup Disk docked, App Disk docked) |
| `on-demand` | Backup only when explicitly triggered by `backupApp` command from Console |
| `scheduled` | Backup runs on a cron schedule while both disks are docked; **implementation deferred** |

## Scenarios × Modes

The five hardware/lifecycle scenarios and how each mode responds:

| Scenario | Immediate | On-demand | Scheduled |
|---|---|---|---|
| **Dock Backup Disk** (App Disk already docked) | Check stale locks → re-trigger interrupted backups. Trigger backup for each linked instance whose App Disk is docked. | Check stale locks → re-trigger interrupted backups. Register disk; no auto-backup. | Check stale locks → re-trigger interrupted backups. Start backup scheduler. |
| **Dock App Disk** (Backup Disk already docked) | `checkPendingBackups`: trigger backup for linked instances on this disk. | No action. | No action (scheduler already handles timing). |
| **Reboot** (both disks re-dock via chokidar) | Same as the two dock scenarios above, in sequence. **Race risk** — see below. In-memory mutex prevents double-backup. Stale lock files re-trigger interrupted backups. | Stale lock files re-trigger interrupted backups. No other auto-action. | Scheduler restarts on Backup Disk dock. Stale lock files re-trigger interrupted backups. |
| **Undock Backup Disk** | In-flight backup fails (disk removed); error logged; lock file stays on disk for boot-resume; instance restarted. | No active backup. Disk deregistered from available list. | Scheduler cancelled. In-flight backup fails; lock file stays. |
| **Undock App Disk** | In-flight backup fails (source path gone); error logged; lock file stays. Instance set to `Undocked` via existing path. | No active backup. Instance set to `Undocked`. | Scheduler continues running; next scheduled run finds App Disk undocked → error logged. Instance set to `Undocked`. |

**Additional triggers not listed above:**
- `backupApp` command — initiates `backupInstance` directly regardless of mode; this is the primary On-demand trigger
- Scheduled timer fires — while both disks remain docked, `backupInstance` runs on schedule (Scheduled mode only)

**Additional scenarios not listed above:**
- None identified beyond the five. The Backup Disk missing a link for the docked App Disk's instances is handled by `checkPendingBackups` finding no match → no action.

## Reboot Race Condition

After a reboot, chokidar fires `add` for every device in `/dev/engine`. `addDevice` is async.
At each `await` point, another `addDevice` call can interleave. This creates a race when both
an App Disk and a Backup Disk are docked:

```
addDevice(appDisk)  → createOrUpdateDisk → diskDB[appDisk].device set
                    → AWAIT processDisk...
  addDevice(backupDisk) → createOrUpdateDisk → diskDB[backupDisk].device set
                        → AWAIT processDisk...
    processAppDisk → checkPendingBackups → sees backupDisk docked → triggers backupInstance
    processBackupDisk → sees appDisk docked → ALSO triggers backupInstance
```

Both `backupInstance` calls run for the same `instanceId`. Borg's internal repo lock prevents
corruption, but the outcome is unpredictable: the second caller may block, create a redundant
archive, or fail — and may leave a stale lock file even after a successful backup.

**Fix: in-memory `activeBackups` set**

A module-level `Set<InstanceID>` tracks in-flight backups:

```typescript
const activeBackups = new Set<InstanceID>()

const backupInstance = async (...) => {
    if (activeBackups.has(instanceId)) {
        log(`Backup for ${instanceId} already in progress — skipping duplicate trigger`)
        return
    }
    activeBackups.add(instanceId)
    try {
        // ... backup logic ...
    } finally {
        activeBackups.delete(instanceId)
    }
}
```

This is safe in single-threaded Node.js (no true concurrent access between the `has` check and
`add` call). The first trigger wins; duplicates are silently discarded.

## Reactive Triggers

Full trigger table after the above analysis:

| Trigger | Condition | Action |
|---|---|---|
| Backup Disk docked | `mode=immediate`; linked App Disk docked | Start backup (via `activeBackups` mutex) |
| Backup Disk docked | Stale `.backup-in-progress` lock found | Re-trigger backup once App Disk confirmed docked |
| Backup Disk docked | `mode=scheduled` | Start scheduler |
| App Disk docked | Linked Backup Disk docked; `mode=immediate` | Start backup (via `activeBackups` mutex) |
| `backupApp` command | Any mode; named instance + backup disk docked | Start backup |
| `restoreApp` command | Named instance has archive on a docked Backup Disk | Restore to target disk |
| Scheduled timer fires | Both disks docked; `mode=scheduled` | Start backup |
| Backup Disk undocked | Backup in-flight | Borg fails; error logged; lock file remains; instance restarted |
| App Disk undocked | Backup in-flight | Borg fails; error logged; lock file remains; instance → Undocked |

**Not triggered:**
- App Disk undocked (no backup action — existing `undockDisk` path handles instance lifecycle)
- Engine boot with no disks present (nothing to process)

### Reactive implementation

**Backup Disk docked** → `processBackupDisk(storeHandle, backupDisk)`:
- Read BACKUP.yaml
- Scan `backups/*/` for stale lock files → queue `backupInstance` for each stale instance once its App Disk is confirmed docked
- If `mode=immediate`: for each linked `instanceId`, find App Disk via `instanceDB[id].storedOn → diskDB`; if docked, call `backupInstance` (guarded by `activeBackups`)
- If `mode=scheduled`: start scheduler

**App Disk docked** → `processAppDisk` calls new hook `checkPendingBackups(storeHandle, appDisk)`:
- Scan all docked Backup Disks (`diskDB` where `device != null`)
- For each, read its `BACKUP.yaml`
- If `mode=immediate` and a linked instance lives on `appDisk`, call `backupInstance` (guarded by `activeBackups`)

---

## Idempotency and Boot Resume

### Idempotency

A backup is **idempotent**: initiating it when a previous run was interrupted is safe and efficient.

Borg guarantees this:
- An interrupted `borg create` leaves no partial archive in the repository
- Re-running `borg create` on the same data deduplicates against existing chunks — only the
  delta is written
- Result: the backup effectively "continues" from the perspective of time and I/O

### Boot Resume (interrupted backup)

If the Engine reboots during an active backup, the backup must resume automatically when the
Backup Disk is next docked (typically on the next boot if the disk stays connected).

**Mechanism: lock file on the Backup Disk**

Before calling `borg create`, the Engine writes a lock file:

```
/disks/<backupDevice>/backups/<instanceId>/.backup-in-progress
```

Contents: `{ "instanceId": "...", "startedAt": <unix-ms> }`

After a successful backup (and after updating BACKUP.yaml), the lock file is removed.

If the Engine reboots mid-backup:
- The Backup Disk is re-detected by chokidar on the next boot (or on re-dock)
- `processBackupDisk` checks for `.backup-in-progress` lock files in `backups/*/`
- For each stale lock found, it queues a `backupInstance` call (after linked App Disk is
  confirmed docked)

**Stale lock detection** — when `processBackupDisk` runs:

```
For each instanceId in backups/:
  If .backup-in-progress exists:
    → queue backupInstance(instanceId, backupDisk) once its App Disk is confirmed docked
```

This runs **in addition to** the normal mode logic — a stale lock triggers re-backup
regardless of `mode` (on-demand or immediate), since the backup was already explicitly
initiated before the crash.

---

## `backupInstance` — Core Backup Logic

```
backupInstance(storeHandle, instanceId, backupDisk):
  1. Resolve instance → App Disk (via instanceDB.storedOn → diskDB)
  2. Verify App Disk is docked; error and return if not
  3. Init Borg repo if first backup:
       borg init --encryption=none /disks/<backupDevice>/backups/<instanceId>/
  4. Write lock file: /disks/<backupDevice>/backups/<instanceId>/.backup-in-progress
       { "instanceId": "...", "startedAt": <unix-ms> }
  5. If instance is Running: stopInstance (stops Docker containers)
  6. Create archive:
       borg create \
         /disks/<backupDevice>/backups/<instanceId>::{now} \
         /disks/<appDevice>/instances/<instanceId>/
  7. If instance was Running: startInstance (restart Docker containers)
  8. Update lastBackup in Automerge store: instanceDB[instanceId].lastBackup = Date.now()
  9. Write updated lastBackup timestamp to BACKUP.yaml on backup disk
  10. Remove lock file: /disks/<backupDevice>/backups/<instanceId>/.backup-in-progress
  11. Log success

  Error path (borg create fails or disk removed):
    - Attempt to restart instance if it was stopped (always)
    - Log error; do NOT update lastBackup in store or BACKUP.yaml
    - Leave lock file in place (signals interrupted backup for boot-resume)
```

Archive name: `{now}` — Borg's built-in ISO timestamp placeholder.

**Instance stop/start:** Stopping the instance before backup ensures filesystem consistency
(no open database files). The instance is always restarted after, regardless of backup outcome.

---

## `backupApp` Command

**Usage:** `backupApp <instanceId> [backupDiskName]`  
**Scope:** `engine`

- If `backupDiskName` omitted: use the first docked Backup Disk linked to `instanceId`
- If no linked Backup Disk docked: error
- Calls `backupInstance(storeHandle, instanceId, backupDisk)`

---

## `restoreApp` Command

**Usage:** `restoreApp <instanceId> <targetDiskName>`  
**Scope:** `engine`

Restores the latest archive for `instanceId` from any docked Backup Disk onto `targetDisk`.

```
restoreApp:
  1. Find a docked Backup Disk with backups/<instanceId>/ (a valid Borg repo)
  2. If instance is currently Running on any disk: stopInstance
  3. Ensure /disks/<targetDevice>/instances/ exists
  4. Extract latest archive:
       borg extract \
         /disks/<backupDevice>/backups/<instanceId>::latest \
         --strip-components 0 \
         --target /disks/<targetDevice>/instances/
  5. Call processInstance(storeHandle, targetDisk, instanceId)
     → registers instance in instanceDB, sets storedOn = targetDisk, starts containers
```

**Overwrite behaviour:** restoring to a disk where `instanceId` already exists overwrites the
instance directory. This is intentional — restore means "put this instance here, as archived".

**Multiple Backup Disks:** if more than one docked Backup Disk has archives for `instanceId`,
the first found is used. Console selection is a future iteration.

---

## Store Changes

### Disk: `diskTypes`

Add `diskTypes: DiskType[]` to the `Disk` interface, where:

```typescript
export type DiskType = 'app' | 'backup' | 'empty' | 'upgrade' | 'files'

export interface Disk {
    // ... existing fields ...
    diskTypes: DiskType[]   // empty array until processDisk runs; may contain multiple types
}
```

Set in `processDisk` after all type-detection checks have run — each check that returns true
appends its type to the list. A disk that is both an App Disk and a Backup Disk will have
`diskTypes: ['app', 'backup']`.

Default: `[]` on disk creation. Populated during `processDisk`. Cleared to `[]` on undock.

**Rationale:** The Solution Description explicitly allows multi-purpose disks. A single
`diskType` string forces a hierarchy that does not reflect reality. A list models the actual
state correctly and lets the Console render all applicable UI sections for a disk.

Cleared to `[]` on undock (`undockDisk`).

### Disk: `backupConfig`

Add `backupConfig: { mode: 'immediate' | 'on-demand' | 'scheduled'; links: InstanceID[] } | null`
to the `Disk` interface:

```typescript
export interface Disk {
    // ... existing fields ...
    backupConfig: { mode: BackupMode; links: InstanceID[] } | null
}
```

Set in `processBackupDisk` after reading `BACKUP.yaml`. Cleared to `null` on undock.

**Rationale:** Lets the Console display which instances a Backup Disk is linked to, and what
mode it runs in, without reading the disk directly.

### Instance: `lastBackup` (rename from `lastBackedUp`)

The existing `Instance` interface has `lastBackedUp: Timestamp` (initialized to `0`).

**Rename to `lastBackup: Timestamp | null`**, treating `null` as "never backed up":

```typescript
export interface Instance {
    // replaces lastBackedUp: Timestamp
    lastBackup: Timestamp | null   // Unix ms of last successful backup; null if never
}
```

Migration: existing records have `lastBackedUp: 0`. The rename PR will:
1. Remove `lastBackedUp` from the interface and all write sites
2. Add `lastBackup: null` as the initialisation value
3. Update all read sites to use `lastBackup`

Since `lastBackedUp = 0` was never used by any consumer (backup not yet implemented),
this is a clean rename with no data migration concern.

Set by the Engine after each successful `backupInstance` run:

```typescript
storeHandle.change(doc => {
    const inst = doc.instanceDB[instanceId]
    if (inst) inst.lastBackup = Date.now() as Timestamp
})
```

### `createBackupDisk` command

New Engine command (added in the implementation PR):

**Usage:** `createBackupDisk <diskName> <mode> <instanceId...>`  
**Scope:** `engine`

1. Find disk by name; verify it is docked and has no existing apps or instances (empty)
2. Write `BACKUP.yaml` to the disk with the specified mode and linked instance IDs
3. Call `processDisk(storeHandle, disk)` — triggers `processBackupDisk`, sets `diskType` and
   `backupConfig` in the store
4. `borg init` is deferred to first `backupInstance` run (as per design)

This is the Engine-side counterpart to the Console's Backup Disk provisioning UI.

---

## `isBackupDisk` Detection

```typescript
export const isBackupDisk = async (disk: Disk): Promise<boolean> => {
    try {
        await $`test -f /disks/${disk.device}/BACKUP.yaml`
        return true
    } catch {
        return false
    }
}
```

---

## Provisioning Dependency

`borgbackup` must be present on the Pi. Add to `install.sh`:

```bash
apt-get install -y borgbackup
```

---

## Resolved Decisions

- **`lastBackup` null/undefined = never backed up.** Console treats both the same.
- **No encryption.** `borg init --encryption=none` for V1. Encryption revisited if needed.
- **Backup Disk created by Console** (Group G / Empty Disk provisioning). BACKUP.yaml is written
  by Console; `borg init` is called by Engine on first `backupInstance` run.
- **Cross-engine backup: out of scope for V1.** Both disks must be docked on the same Engine.
  A future task has been created to implement cross-engine backup after a multi-engine test hub
  is available. (See MC task for cross-engine backup.)
- **`lastBackup` field on existing Instance records** — Automerge reads missing fields as
  `undefined`; Engine and Console treat `undefined` the same as `null` (never backed up).

---

## Test Approach

- `isBackupDisk`: fixture with/without `BACKUP.yaml`
- `backupInstance`: dock App Disk fixture + Backup Disk fixture; run backup; verify Borg repo
  has a new archive; verify BACKUP.yaml `lastBackup` updated; verify `instanceDB[id].lastBackup`
  set in store
- Immediate auto-trigger (Backup Disk docked first): dock Backup Disk with `mode: immediate`,
  then dock linked App Disk; verify backup runs without `backupApp` command
- Immediate auto-trigger (App Disk docked first): dock App Disk, then dock Backup Disk with
  `mode: immediate`; verify backup runs
- Boot-resume: pre-seed a `.backup-in-progress` lock file in the Backup Disk fixture; dock the
  Backup Disk + linked App Disk; verify `backupInstance` is triggered automatically; verify
  lock file is removed after success
- Idempotency: run backup; simulate interruption (leave lock file); re-trigger; verify repo is
  intact, backup completes, lock file removed
- `restoreApp`: dock Backup Disk with an existing Borg repo; run restoreApp to a second disk
  fixture; verify instance directory and instanceDB state

Test fixtures needed:
- `disk-backup-v1/` — Backup Disk fixture with `BACKUP.yaml`; a pre-seeded Borg repo with
  one archive for `sample-00000000-test1`

---

## Implementation Order

1. Add `borg` to provisioning (`install.sh`)
2. **Store field changes** (one PR):
   - Rename `lastBackedUp` → `lastBackup: Timestamp | null` in `Instance.ts`
   - Add `diskTypes: DiskType[]` + `DiskType` type alias to `Disk.ts`; populate in `processDisk` across all type checks (`isAppDisk` → `'app'`, `isBackupDisk` → `'backup'`, etc.); clear on undock
   - Add `backupConfig: { mode, links } | null` to `Disk.ts`
3. `isBackupDisk` — detection; appends `'backup'` to `diskTypes` in `processDisk`
4. `backupInstance` — core Borg backup logic (lock file, `activeBackups` mutex, stop, borg create, restart, store update)
5. `processBackupDisk` — reads BACKUP.yaml; sets `backupConfig` in store; immediate trigger; stale lock scan; scheduled stub
6. `checkPendingBackups` hook in `processAppDisk` — second reactive trigger
7. `backupApp` command
8. `restoreApp` command
9. `createBackupDisk` command
10. Tests + fixtures
