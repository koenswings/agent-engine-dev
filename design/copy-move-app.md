# Design: copyApp + moveApp + rsync Infrastructure

**Status:** Approved  
**Author:** Axle  
**Date:** 2026-04-07  

---

## Problem

App Instances need to move between disks. Two use cases:

- **Copy:** Duplicate an instance onto a different disk. The copy gets a new `InstanceID` — it is treated as a brand new instance. The original keeps running.
- **Move:** Relocate an instance to a different disk. The moved instance keeps its original `InstanceID` so it remains linked to its backup disks. The original is removed after the move completes.

Both operations require copying potentially large Docker volumes (gigabytes of app data) reliably and interruptibly. `rsync` is the right tool: it diffs before transferring, compresses in flight, and resumes cleanly after interruption.

The Solution Description calls these out explicitly as drag-and-drop operations in the Console UI (source disk → target disk), and as commands in the Engine.

---

## Scope

This design covers:
1. The `rsync`-based file copy primitive
2. The `copyApp` command (new instance ID)
3. The `moveApp` command (same instance ID)
4. Progress tracking in the store
5. Store types and lifecycle
6. Test strategy

**Out of scope:** Console UI drag-and-drop (Pixel's domain), cross-engine rsync (needs multi-engine setup, deferred).

**Phase 1 (this PR):** Same-engine, disk-to-disk only. Both source and target disks docked to the same engine.

---

## Constraints

- Both disks must be docked to the local engine during the operation.
- The source instance must be stopped before the file copy begins (consistent snapshot).
- The target disk must be an App Disk (has an `apps/` directory).
- Target disk must have enough free space (checked before starting).
- Operations are idempotent: if the engine reboots mid-transfer, the command can be re-executed safely.
- Progress must be observable in the store (Console can display it).

---

## File Layout on Disk

An App Instance lives in two places on the disk:

```
/disks/<device>/apps/<appName>-<appVersion>/          ← app master (compose, init_data)
/disks/<device>/instances/<appName>-<instanceId>/     ← instance data (volumes, .env)
```

A `copyApp`/`moveApp` must transfer both directories.

---

## Store Changes

### New type: `Operation`

Rather than a transfer-specific type, we introduce a general `Operation` record that covers all long-running commands: `copyApp`, `moveApp`, `backupApp`, `restoreApp`, `upgradeApp`, `upgradeEngine`. This gives us a single, consistent pattern for progress tracking, crash recovery, and retry across the whole command surface.

```typescript
export type OperationStatus = 'Pending' | 'Running' | 'Done' | 'Failed';
export type OperationKind =
  | 'copyApp'
  | 'moveApp'
  | 'backupApp'
  | 'restoreApp'
  | 'upgradeApp'
  | 'upgradeEngine';

export interface Operation {
  id: string;                        // UUID — unique per operation
  kind: OperationKind;
  args: Record<string, string>;      // command-specific payload (instanceId, sourceDisk, targetDisk, …)
  engineId: EngineID;                // engine executing the operation
  status: OperationStatus;
  progressPercent: number | null;    // null until the operation reports progress
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  error: string | null;
}
```

### Store addition

```typescript
// In Store interface (Store.ts)
operationDB: { [id: string]: Operation };
```

Operations are written to the store so every Console and peer engine can observe them reactively via CRDT sync — no polling needed.

**Cross-engine flow:** Engine A sends a `copyApp` command to engine B via the existing `Engine.commands` dispatch queue. Engine B creates an `Operation` record in `operationDB`. The CRDT propagates it back to engine A and all Consoles. Progress and completion are visible everywhere without any additional signalling.

**Crash recovery:** On restart, the engine scans `operationDB` for any `Operation` with `status: 'Running'` and marks them `Failed`. The operator re-issues the command. Because all long-running operations are idempotent (rsync diffs, BorgBackup resumes), retrying is always safe.

**Future:** `backupMonitor`'s lock-file mechanism can eventually be folded into this pattern, making `operationDB` the single source of truth for all operation state.

---

## rsync Primitive

New file: `src/utils/rsync.ts`

```typescript
export interface RsyncProgress {
  progressPercent: number;
}

export type RsyncProgressCallback = (progress: RsyncProgress) => void;

export const rsyncDirectory = async (
  src: string,
  dest: string,
  onProgress?: RsyncProgressCallback
): Promise<void>
```

Implementation notes:
- Uses `rsync -a --info=progress2 --no-inc-recursive <src>/ <dest>/`
  - `-a` = archive mode (preserves permissions, symlinks, timestamps)
  - `--info=progress2` = machine-parseable per-file progress
  - `--no-inc-recursive` = needed for accurate total progress reporting
- Parses stdout line by line for `%` values to drive `onProgress`
- Throws on non-zero exit
- `src` and `dest` are local paths (phase 1 — same engine)

For phase 2 (cross-engine), `dest` becomes `pi@<hostname>:<path>` with the engine's SSH key. The function signature stays the same; the caller passes a remote path.

---

## copyApp Implementation

New function: `src/data/App.ts` (or `Instance.ts`) — `copyApp()`

**Steps:**

1. **Validate:** source instance exists, source disk is docked, target disk is docked, target disk is an App Disk, target does not already contain an instance with a conflicting name.
2. **Stop source instance** if Running/Starting (call `stopInstance`). Wait for `Stopped`.
3. **Create Transfer record** in store: `status: 'Pending'`, new `targetInstanceId = uuid()`.
4. **Check disk space** on target: `df -k /disks/<targetDevice>` — abort early if insufficient.
5. **Set transfer `status: 'Copying'`**.
6. **rsync app master dir** (`/disks/<src>/apps/<appName>-<version>/` → `/disks/<target>/apps/<appName>-<version>/`). Skip if already present (idempotent).
7. **rsync instance dir** (`/disks/<src>/instances/<appName>-<srcId>/` → `/disks/<target>/instances/<appName>-<targetId>/`). Update progress in store.
8. **Set operation `status: 'Running'`** (progress advances toward 100%).
9. **Patch the copied instance's `compose.yaml`** inside `instances/<appName>-<targetId>/`: update the `x-app.instanceId` to the new `targetInstanceId`. Update `.env` with a new port number.
10. **Trigger disk re-processing** on target disk (`processDisk`) so the new instance appears in the store with `status: 'Docked'`.
11. **Set operation `status: 'Done'`**, set `completedAt`.
12. **Restart source instance** (if it was stopped in step 2).

---

## moveApp Implementation

Same as `copyApp` with these differences:

- `targetInstanceId` = `sourceInstanceId` (same ID retained).
- Step 9: No patch needed — compose.yaml instanceId stays the same.
- After step 10 (target disk re-processed, operation confirmed `Done`): **remove source instance directory** (`/disks/<src>/instances/<appName>-<srcId>/`) and update the source disk store (instance status → `Missing`).
- **App master cleanup:** After removing the instance dir, check whether any other instance dir on the source disk has the same `<appName>-<version>` prefix. If none found, delete the app master dir (`apps/<appName>-<version>/`). This check and delete happen only after the copy is confirmed successful — never before.
- No garbage collection mechanism is planned; this inline check is sufficient.

---

## Commands

Two new commands in `Commands.ts` / `CommandDefinition.ts`:

```
copyApp <instanceName> <sourceDiskName> <targetDiskName>
moveApp <instanceName> <sourceDiskName> <targetDiskName>
```

Both are `scope: 'engine'`, execute on the engine that owns both disks.

---

## Progress Reporting

The `rsync` primitive calls `onProgress` with `progressPercent` (0–100). The command handler writes this to `operation.progressPercent` in the store via a `storeHandle.change()` call.

The storeMonitor detects changes to `operationDB` and can log or act on them. The Console observes them reactively via CRDT sync.

---

## Error Handling

- If rsync fails mid-copy, `operation.status = 'Failed'`, `operation.error = <message>`.
- Partial files left on the target disk are safe to leave — re-running the command will rsync only the delta.
- If the engine reboots mid-operation: on restart, the engine scans `operationDB` for any `Operation` with `status: 'Running'` and marks them `Failed`. The operator re-issues the command.

---

## Test Strategy

Tests follow the existing Vitest pattern in `test/automated/`.

**Unit tests** (no real rsync):
- Mock `rsyncDirectory` to verify that `copyApp` calls it with correct source/target paths.
- Verify store state transitions: `Pending → Running → Done`.
- Verify that `copyApp` assigns a new instanceId; `moveApp` retains the original.
- Verify that a failed rsync sets `status: 'Failed'` and `error`.
- Verify that `moveApp` deletes the app master only when no other instance on the source disk shares the same `<appName>-<version>`.
- Verify that `moveApp` does NOT delete the app master when another instance shares it.

**Integration tests** (real disk, needs fixture):
- Add a `disk-sample-target-v1/` fixture: an empty App Disk (just `apps/`, `instances/`, `META.yaml`).
- Run `copyApp` between `disk-sample-v1` and `disk-sample-target-v1` using `IDEA_TEST_MODE=true`.
- Assert: target disk now contains instance dir; instance appears in store with new ID.
- Run `moveApp`; assert: source instance dir removed; target has instance with original ID.

---

## Open Questions

1. **What happens to the source instance's backup links after a move?** The instance ID is preserved, so existing backup disk links in `BackupConfig.links` should continue to work. Worth verifying against `backupMonitor.ts` during implementation.

2. **Operation TTL / cleanup:** When should completed/failed Operation records be removed from `operationDB`? Leaving them for now (cleared on engine restart is simplest). Can add explicit cleanup later.

3. **App master deduplication on target:** If the target disk already has the same app master (`apps/<appName>-<version>/`), rsync will diff and skip unchanged files — naturally idempotent. Document this explicitly.

4. **Concurrent operations on the same instance:** Not supported in phase 1. Document that issuing two operations on the same instance simultaneously has undefined behaviour. Phase 2: add a guard (check `operationDB` for a `Running` op on the same instanceId before starting).

---

## What This Unlocks

- Console drag-and-drop: Pixel can implement the UI on top of `copyApp`/`moveApp` commands.
- App Catalog Disk (future): copying an instance from a catalog disk to an app disk is just `copyApp`.
- Cross-engine transfer (future): phase 2 of this design, same API, remote rsync target.
