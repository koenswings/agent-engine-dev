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

## Reactive Triggers

This section defines all the events the Engine reacts to in the context of Backup Disks.

| Event | Condition | Action |
|---|---|---|
| Backup Disk docked | `mode=immediate`; linked App Disk is already docked | Start backup for each linked instance whose App Disk is present |
| App Disk docked | A docked Backup Disk is linked to one or more instances on this App Disk; `mode=immediate` | Start backup for those instances |
| `backupApp` command | Any mode; named instance + backup disk found | Start backup for the named instance |
| `restoreApp` command | Named instance has an archive on a docked Backup Disk | Restore to target disk |

**Not triggered by:**
- Backup Disk undock (no action; in-flight backups log an error and stop)
- App Disk undock (instance stops normally via existing undock path; no backup)
- Engine boot (no automatic catch-up; missed backups are not retroactively triggered)

### Reactive implementation

**Backup Disk docked** → `processBackupDisk(storeHandle, backupDisk)`:
- Read BACKUP.yaml
- If `mode=immediate`: for each linked `instanceId`, find its App Disk via `instanceDB[id].storedOn → diskDB`; if that disk is currently docked, call `backupInstance`

**App Disk docked** → `processAppDisk` (existing function) calls a new hook
`checkPendingBackups(storeHandle, appDisk)`:
- Scan all docked Backup Disks (from `diskDB` where `device != null`)
- For each, read its `BACKUP.yaml`
- If `mode=immediate` and any linked instance lives on `appDisk`, call `backupInstance`

---

## Idempotency

A backup is **idempotent**: initiating it when a previous run was interrupted is safe and efficient.

Borg guarantees this:
- An interrupted `borg create` leaves no partial archive in the repository
- Re-running `borg create` on the same data deduplicates against existing chunks — only the
  delta is written
- Result: the backup "continues" from the perspective of time and I/O, with no manual
  intervention required

The Engine does not need to track "in-progress" state for backup. It simply calls
`borg create` and handles success or error. If the disk is removed mid-backup, Borg leaves
the repository intact.

---

## `backupInstance` — Core Backup Logic

```
backupInstance(storeHandle, instanceId, backupDisk):
  1. Resolve instance → App Disk (via instanceDB.storedOn → diskDB)
  2. Verify App Disk is docked; error and return if not
  3. Init Borg repo if first backup:
       borg init --encryption=none /disks/<backupDevice>/backups/<instanceId>/
  4. If instance is Running: stopInstance (stops Docker containers)
  5. Create archive:
       borg create \
         /disks/<backupDevice>/backups/<instanceId>::{now} \
         /disks/<appDevice>/instances/<instanceId>/
  6. If instance was Running: startInstance (restart Docker containers)
  7. Write updated lastBackup timestamp to BACKUP.yaml on backup disk
  8. Log success
  Error path: if borg create fails, attempt to restart instance if it was stopped; log error;
  do NOT update lastBackup
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

No new fields on `Disk` or `Instance` in the Automerge store for V1.

Rationale: backup state (last run, archive list) is the Backup Disk's concern, not the
Engine's shared state. BACKUP.yaml on the disk is the source of truth. This avoids polluting
the CRDT store with per-disk operational data that other Engines don't need.

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

## Open Questions

1. **App Disk and Backup Disk on different Engines** — V1 requires both docked on the same
   Engine. Cross-engine backup needs Group B (rsync/network transfer). Confirm out of scope?

2. **Backup Disk created by Console** — Group G (Empty Disk provisioning) is responsible for
   writing the initial BACKUP.yaml and calling `borg init`. For now, manually created
   BACKUP.yaml + `borg init` is acceptable for testing.

3. **`borg init` encryption** — using `--encryption=none` for V1 simplicity. If disk
   encryption is ever added, this is the place to change it.

---

## Test Approach

- `isBackupDisk`: fixture with/without `BACKUP.yaml`
- `backupInstance`: dock App Disk fixture + Backup Disk fixture; run backup; verify Borg repo
  has a new archive; verify BACKUP.yaml `lastBackup` updated
- Immediate auto-trigger (Backup Disk docked first): dock Backup Disk with `mode: immediate`,
  then dock linked App Disk; verify backup runs without `backupApp` command
- Immediate auto-trigger (App Disk docked first): dock App Disk, then dock Backup Disk with
  `mode: immediate`; verify backup runs
- Idempotency: interrupt a backup mid-run; re-trigger; verify repo is intact and backup completes
- `restoreApp`: dock Backup Disk with an existing Borg repo; run restoreApp to a second disk
  fixture; verify instance directory and instanceDB state

Test fixtures needed:
- `disk-backup-v1/` — Backup Disk fixture with `BACKUP.yaml`; a pre-seeded Borg repo with
  one archive for `sample-00000000-test1`

---

## Implementation Order

1. Add `borg` to provisioning (`install.sh`)
2. `isBackupDisk` — detection
3. `processBackupDisk` — reads BACKUP.yaml, triggers `backupInstance` for immediate mode
4. `checkPendingBackups` hook in `processAppDisk` — second reactive trigger
5. `backupInstance` — core Borg backup logic
6. `backupApp` command registration
7. `restoreApp` command registration
8. Tests + fixtures
