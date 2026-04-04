# Design: Backup Disk — backupApp + restoreApp

**Status:** Proposed  
**Date:** 2026-04-04  
**Author:** Axle  
**MC task:** `6403aa38`

---

## Problem

App Instances store all their data on the App Disk they live on. If that disk is lost, corrupted,
or physically destroyed, all data is gone. There is no recovery path.

Backup Disks are the solution: a dedicated USB drive that archives one or more App Instances on
a configurable schedule or on demand.

## Scope

This design covers:
- Backup Disk format (filesystem structure and config file)
- `isBackupDisk` detection
- Auto-trigger on dock (Immediate and On Demand modes; Scheduled deferred)
- `backupApp` command — manual or programmatic trigger
- `restoreApp` command — restore from latest archive to a target disk
- Store state changes
- Test approach

Out of scope (deferred):
- Scheduled backup mode (requires a cron/timer infrastructure not yet in Engine)
- Backup Disk creation from Empty Disk (Console responsibility)
- Multi-disk restore selection (Console UI concern)

---

## Backup Disk Format

A disk is a Backup Disk if it has a `BACKUP.yaml` file in its root.

```
/disks/<device>/
  BACKUP.yaml        ← identifies this as a Backup Disk; contains config
  META.yaml          ← standard disk identity file
  backups/
    <instanceId>/
      <timestamp>-<instanceId>.tar.gz   ← one archive per backup run
```

### BACKUP.yaml

```yaml
mode: on-demand      # immediate | on-demand  (scheduled: future)
links:               # instance IDs this disk is configured to back up
  - instanceId: sample-00000000-abc1
    lastBackup: 1712345678000     # Unix ms timestamp; 0 if never backed up
  - instanceId: kolibri-00000000-xyz2
    lastBackup: 0
```

**`mode`:**
- `immediate` — backup runs automatically as soon as the disk is docked; each linked App
  Instance is stopped, archived, then restarted in sequence
- `on-demand` — no auto-trigger; backup must be initiated via `backupApp` command from Console

**`links`:** List of App Instance IDs this disk is responsible for. The instance ID is the
authoritative link (not app name) — this prevents accidental cross-network overwrites when
the same backup disk is carried between sites.

The Engine writes `lastBackup` back to `BACKUP.yaml` after each successful backup.

---

## Archive Format

Each backup is a gzipped tar of the instance directory:

```
tar -czf <timestamp>-<instanceId>.tar.gz -C /disks/<appDevice>/instances <instanceId>/
```

This captures:
- `compose.yaml` (service definitions)
- All bind-mounted data volumes (Nextcloud files, Kolibri content, etc.)
- Any `.env` written by the Engine

Archive naming: `<unix-ms-timestamp>-<instanceId>.tar.gz`  
e.g. `1712345678000-kolibri-00000000-xyz2.tar.gz`

**Retention:** no automatic pruning in V1 — archives accumulate. The operator manages disk space
manually. Future: add `maxBackups` field to BACKUP.yaml.

---

## Detection

`isBackupDisk(disk)` in `Disk.ts`:

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

## Dock Processing

When `processDisk` detects a Backup Disk, it calls `processBackupDisk(storeHandle, disk)`:

```
processBackupDisk:
  1. Read BACKUP.yaml
  2. If mode = immediate:
       For each linked instanceId:
         Find the App Disk where the instance lives (via instanceDB.storedOn → diskDB)
         If the App Disk is docked and the instance is Running/Stopped:
           run backupInstance(storeHandle, instanceId, backupDisk)
  3. If mode = on-demand:
       Log that disk is available; no action taken
  4. Update store: mark disk as docked (already done by createOrUpdateDisk)
```

If a linked instance's App Disk is not currently docked, the backup for that instance is
skipped with a log warning. The Engine does not wait or retry.

---

## backupApp Command

**Usage:** `backupApp <instanceId> [backupDiskName]`

- If `backupDiskName` is omitted, use the first docked Backup Disk linked to `instanceId`
- If no linked Backup Disk is found, error
- Calls `backupInstance(storeHandle, instanceId, backupDisk)`

**`backupInstance` sequence:**
1. Find instance in `instanceDB`; find its App Disk via `storedOn`
2. Verify App Disk is docked (`device != null`)
3. If instance status is `Running`: call `stopInstance` (stops containers)
4. Create `backups/<instanceId>/` on the Backup Disk if it doesn't exist
5. `tar -czf <timestamp>-<instanceId>.tar.gz ...` on the App Disk, write to Backup Disk
6. If instance was Running: call `startInstance` to restart it
7. Write updated `lastBackup` timestamp to `BACKUP.yaml` on the Backup Disk
8. Update store: log backup event (timestamp on instance or a new backupLog field — TBD)

**Error handling:**
- If tar fails: restart the instance (if it was stopped for backup), log error, do not update
  `lastBackup`
- If the Backup Disk becomes unavailable mid-backup: log error, attempt instance restart

---

## restoreApp Command

**Usage:** `restoreApp <instanceId> <targetDiskName>`

Restores the latest archive for `instanceId` from any docked Backup Disk onto `targetDisk`.

**Sequence:**
1. Find any docked Backup Disk that has `backups/<instanceId>/` with at least one archive
2. Select the latest archive (highest timestamp in filename)
3. Verify `targetDisk` is docked and has an `instances/` directory (or create it)
4. If `instanceDB[instanceId]` already exists and is Running/Stopped on `targetDisk`:
   stop the running instance first
5. Extract archive: `tar -xzf <archive> -C /disks/<targetDevice>/instances/`
6. Call `processInstance(storeHandle, targetDisk, instanceId)` — registers and starts the
   restored instance

**Notes:**
- Restore overwrites the instance directory if it already exists on the target disk
- This matches the Solution Description: "there is no explicit Restore operation (at least
  not in the UI). We just add an App from a backup source"
- If no Backup Disk with a matching archive is docked, error

---

## Store Changes

No new fields on the `Disk` interface. Backup state lives on the disk (BACKUP.yaml) not in
the Engine store. Rationale: the Backup Disk is the source of truth; Engine store is ephemeral.

One optional addition: an `events` or `lastBackup` timestamp on `Instance` to surface in
Console. Deferred — Console can derive this from BACKUP.yaml if needed.

---

## Open Questions

1. **What if the backup disk and the app disk are on different Engines?**  
   V1: backupApp only runs when both disks are docked to the same Engine. Cross-engine backup
   requires rsync (Group B infrastructure) — deferred.

2. **Should BACKUP.yaml be written by Engine or by the Console provisioning flow?**  
   Both. Engine reads it and updates `lastBackup`. Console creates it when provisioning an
   Empty Disk as a Backup Disk (Group G). For V1, manual creation of BACKUP.yaml is acceptable
   for testing.

3. **Multiple Backup Disks for the same instance — which to use for restore?**  
   V1: pick the first docked one with an archive. Console selects in a future iteration.

---

## Test Approach

- `isBackupDisk` unit test: fixture disk with/without `BACKUP.yaml`
- `backupApp` integration: dock App Disk fixture + Backup Disk fixture, trigger backup, verify
  archive created and `lastBackup` updated in BACKUP.yaml
- `restoreApp` integration: dock Backup Disk with a pre-built archive, restore to a second
  disk fixture, verify instance directory and instanceDB state
- Immediate-mode auto-trigger: dock a Backup Disk with `mode: immediate`, verify backup runs
  without manual command

Test fixtures needed:
- `disk-backup-v1/` — a Backup Disk fixture with `BACKUP.yaml` and an existing archive
- Extension to existing `disk-sample-v1/` fixture or a new App Disk fixture

---

## Implementation Order

1. `isBackupDisk` — detection
2. `processBackupDisk` + BACKUP.yaml read/write
3. `backupInstance` (core backup logic)
4. `backupApp` command
5. `restoreApp` command
6. Tests
