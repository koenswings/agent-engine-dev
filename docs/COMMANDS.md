# Engine Command Reference

This document provides a reference for all commands available in the Engine's command-line interface.

---

## Inspection Commands

These commands are used to view the current state of the system. They can be run from any context.

### `ls`
- **Description:** A raw dump of all data in the shared store.
- **Usage:** `ls`
- **Scope:** `any`

### `engines`
- **Description:** Lists all engines discovered on the network.
- **Usage:** `engines`
- **Scope:** `any`

### `disks`
- **Description:** Lists all disks known to the network.
- **Usage:** `disks`
- **Scope:** `any`

### `apps`
- **Description:** Lists all applications known to the network.
- **Usage:** `apps`
- **Scope:** `any`

### `instances`
- **Description:** Lists all application instances known to the network.
- **Usage:** `instances`
- **Scope:** `any`

---

## Action Commands

These commands perform actions on the system. Some are restricted to an `engine` context, meaning they must either be run on an engine device directly or sent to an engine using the `send` command.

### `send`
- **Description:** Sends a command to be executed on a specific remote engine. This is the primary way to manage engines from a client.
- **Usage:** `send <engineId> <command> [args...]`
- **Scope:** `any`

### `installApp`
- **Description:** Installs an application onto a target disk. Routes to the appropriate source automatically:
  - `--source` given: copies the app bundle from a docked disk (works offline).
  - No `--source`, internet available: clones from GitHub (same as the old `createInstance`).
  - No `--source`, no internet: searches `appDB` for a locally known source disk; fails with a clear message if none found.
- **Usage:** `installApp <appId> <targetDiskId> [--source <sourceDiskId>] [--name <instanceName>] [--fresh]` (idea#128). The target and source are disk ids (the Console sends `disk.id`), resolved by the shared disk resolver (see [Disk arguments](#disk-arguments)). Both must be docked to this engine; a disk on another engine or an undocked record is refused (the old any-engine and undocked fallbacks are gone). Every refusal and usage error ends the command trace as `error` with the reason.
- **Scope:** `engine`
- **Examples:**
  - `installApp kolibri-1.0 f3a9c2d1` — auto-route (online → GitHub, offline → appDB lookup)
  - `installApp kolibri-1.0 f3a9c2d1 --source 7be04c11` — copy from a docked catalog disk
  - `installApp kolibri-1.0 f3a9c2d1 --source 7be04c11 --name school-kolibri` — custom instance name
  - `installApp kolibri-1.0 f3a9c2d1 --source 7be04c11 --name "Kolibri Demo" --fresh` — display name with a space, clean instance (idea#235)
- **Arguments are quote-aware:** the line is split with the shared `splitArgs` (see [Quoted arguments](#disk-arguments)), so a value with spaces goes in double quotes (`--name "Kolibri Demo"`). Lines without a `"` split exactly as before. An unexpected extra argument (e.g. an unquoted `--name Kolibri Demo`) is refused with the usage line.
- **`--name`:** the instance's display name. It is checked (not empty or blank, at most 64 characters, no control characters or newlines) and written to `x-app.instanceName` in the new instance's `compose.yaml` and to the store record, on both the GitHub route and the disk route. The instance id and folder, and so the Docker project, container and volume names, are still the generated id and never contain the name. Default: the appId.
- **App id forms:** `<name>-<version>` as stored on disks (`nextcloud-1.0-31.0.1`, `kolibri-channel-builder-2551b7d…`), or `<name>@<git ref>` for an exact repo ref that may contain `-` or `/` (`nextcloud@feat/nextcloud-demo`, `nextcloud@21d7f75`). A `<name>@<ref>` id is stored on disk as `<name>-<ref>`, with the ref made folder-safe (`/` becomes `-`). Parsing rules: `@` splits explicitly; otherwise the version starts at the first `-` followed by a digit; otherwise a trailing 7–40 hex commit SHA or `latest`; otherwise the last `-` (ambiguous, so use `@`). The GitHub route clones a branch or tag with `--branch`; a commit SHA is cloned and then checked out.
- **Same disk:** when `--source` is the target disk, the `apps/<appId>/` bundle is already in place and is not copied onto itself (paths compared with realpath).
- **`x-app.title`:** when the bundle omits `x-app.title` (or it is blank), the app record's title defaults to the app name so Automerge is not given `undefined` (idea#428). `createOrUpdateApp` and `processSystemApp` share this rule.
- **`--fresh`:** disk route only. The new instance starts from a copy of the whole app bundle (`apps/<appId>/`: compose.yaml, entrypoint scripts, hooks, bundled apps) with no data directory; no data is copied from an existing instance on the source disk. Without `--fresh` the disk route still copies the source disk's instance of the app as the starting point (unchanged). Use `--fresh` for demo instances so they never inherit a school's data. The GitHub route always starts clean.

### `createInstance` *(deprecated)*
- **Description:** Deprecated alias for `installApp`. Use `installApp` instead. Builds a new application instance from a git repository.
- **Usage:** `createInstance <instanceName> <appName> <gitAccount> <gitTag> <diskName>`
- **Scope:** `engine`

### `startInstance`
- **Description:** Starts a previously created application instance. This involves preloading services and creating and running the Docker containers. The instance becomes `Running` only after `docker compose up` succeeded; any failure sets it to `Error` and closes the command's trace as failed (idea#109). For an unpinned image, a missing or unloadable `services/<image>.tar` is only a warning (a `warn` log line in the trace): Docker pulls the image at create time if it can. For a digest-pinned image (idea#445), start skips the load when `repo@digest` is already local (and retags `repo:tag`); a tar whose digest does not match the pin is quarantined and never loaded, and start fails with a `stale service tar` error if the pin is not already local.
- **Usage:** `startInstance <instanceId|instanceName> <diskId|diskName> [--cause <cause>]` (idea#168). The instance resolves id-first (see [Instance arguments](#instance-arguments)); an ambiguous name is refused. `--cause` is sent by the cross-engine `copyApp` dispatch (`startInstance <newInstanceId> <targetDiskId> --cause cross-engine-cmd`). The trace arg keys stay `instanceName` and `diskId` (plus `options`).
- **Port:** the instance keeps the `port=` in its `.env` unless that port is listening (netstat), reserved (80, 8080) or owned by another instance in the store on this engine (idea#168 r35, `storePortOwner`); then, and when `.env` has no port, a fresh port is allocated that is none of those. When two records claim one port (data from before the fix), a Running/Starting claimant owns it, else the older record.
- **Second port, `port_zip` (agent-engine-dev#267):** only when the App's compose references `${port_zip}` or a default form such as `${port_zip:-8081}`. At each start the Engine keeps the `.env` `port_zip=` unless it is listening, reserved, equal to the instance's own `port`, or owned (as `port` or `port_zip`) by another instance in the store; otherwise, and when missing (an existing instance gets one at its next start), it allocates one with the same checks and writes it atomically to `.env` next to `port`. It is stored as `portZip` on the instance. Apps that don't reference it get nothing. For host-network Kolibri a literal `KOLIBRI_ZIP_CONTENT_PORT` is synced to it; a `${port_zip…}` reference is left for compose to resolve.
- **Scope:** `engine`

### `runInstance`
- **Description:** A shortcut for running an already-created instance's containers. Assumes `startInstance` has been run at least once. Sets `Running` only after `docker compose up` succeeded; on failure the instance is set to `Error` and the command fails.
- **Usage:** `runInstance <instanceId|instanceName> <diskName>` (idea#168). The instance resolves id-first (see [Instance arguments](#instance-arguments)).
- **Scope:** `engine`

### `stopInstance`
- **Description:** Stops a running application instance and its associated Docker containers.
- **Usage:** `stopInstance <instanceId|instanceName> <diskId|diskName>` (idea#168). The instance resolves id-first (see [Instance arguments](#instance-arguments)); an ambiguous name is refused.
- **Scope:** `engine`

### `renameInstance`
- **Description:** Changes only an instance's display name (agent-engine-dev#220). It rewrites `x-app.instanceName` in `<disk>/instances/<id>/compose.yaml` (written as pi) and then `instance.name` in the store, so the name survives the next dock or Engine restart without a `pm2 restart`. The id, folder, Docker project, containers, volumes, data and port are unchanged. Nothing uses the display name as a key, so a running instance may be renamed.
- **Usage:** `renameInstance <instanceId|instanceName> <newName…>`. The new name is the rest of the line, quoted or not (`renameInstance kolibri-g3c6r "Kolibri Demo"`). An instance name must be unique among instances on this Engine (see [Instance arguments](#instance-arguments)); send the id.
- **Validation:** the name is trimmed, then must be 1–64 characters with no control characters (the same limits as `installApp --name`, `MAX_INSTANCE_NAME_LENGTH`), and unique, case-insensitive, among instances stored on this Engine. The same name as now is a no-op ok (`changed: false`, nothing written).
- **Result:** `CommandTrace.result` = `{ instanceId, oldName, newName, changed }`.
- **Refusals** (trace ends as `error`, `errorMessage` starts with the code): `NOT_FOUND`, `NOT_LOCAL` (stored on a disk not docked here), `AMBIGUOUS` (name shared on this Engine), `EMPTY_NAME`, `NAME_TOO_LONG`, `BAD_NAME`, `NAME_TAKEN`, `BUSY` (a copy, move, backup or restore holds the instance lock), `COMPOSE_WRITE_FAILED` (compose.yaml not written; store unchanged).
- **Capability:** `capabilities.includes('renameInstance') && capabilitiesBootedAt === lastBooted`
- **Scope:** `engine`

### `copyApp`
- **Description:** Copies an app instance from one disk to another. The copy receives a brand new InstanceID — it is treated as a fresh instance. The original instance is stopped during the file copy (for a consistent snapshot) and restarted **before the copy starts**, so it keeps its port (idea#168 r35). Progress is tracked in `operationDB` in the store and visible to all Consoles.
- **The copy is its own instance (idea#168 r35):**
  - **Name:** `<name>-2`, or the next free `<name>-<n>` (n ≥ 2) that no instance in the store uses. Copying a copy continues its series (`kolibri-2` → `kolibri-3`, when `kolibri` exists); other names are kept whole (`kolibri-grade5a-001` → `kolibri-grade5a-001-2`). Written to the copy's `compose.yaml` `x-app.instanceName` (comments kept) and stored on the instance.
  - **Port:** the Engine-written `port=` and `port_zip=` lines are removed from the copy's `.env` (other lines are kept), so its start allocates a fresh port (and a fresh `port_zip` when the App uses it) (see `startInstance`). App keys such as `KOLIBRI_HTTP_PORT` in `.env` are not Engine-written and are left alone; the Engine rewrites the Kolibri listen env in `compose.yaml` to the allocated port at every start.
  - **Data:** refused when the instance folder holds a symlink that resolves outside it (see [Instance data links](#instance-data-links)).
- **Usage:** `copyApp <instanceId|instanceName> <sourceDiskId> <targetDiskId>`. The instance resolves id-first (see [Instance arguments](#instance-arguments)); a name shared by several instances resolves only to the one on the source disk. Crash recovery retries with the instance id. A cross-engine copy dispatches `startInstance <newInstanceId> <targetDiskId> --cause cross-engine-cmd` to the target Engine.
- **Scope:** `engine`

### `moveApp`
- **Description:** Moves an app instance from one disk to another. The instance keeps its original InstanceID so backup disk links remain intact. The source instance directory (and app master, if no other instance on the source disk uses it) is removed after a successful transfer.
- **Usage:** `moveApp <instanceId|instanceName> <sourceDiskId> <targetDiskId>`. The instance resolves id-first (see [Instance arguments](#instance-arguments)). Refused when the instance folder holds a symlink that resolves outside it (see [Instance data links](#instance-data-links)).
- **Across Engines** (capability `moveAppCrossEngine`, idea#79): when the target disk is docked to another Engine, the move is a copy followed by a delete in one `moveApp` operation with steps `Copying`, `Checking`, `Removing the old copy` and an `Operation.move` record (shapes: `src/data/MoveAppShapes.ts`). 1) The existing cross-Engine copyApp path copies it (the copy gets a fresh id and keeps the name). 2) The target Engine runs `verifyMoveTarget`: registered on a disk docked to it, instance data size matches (within 1 MB or 1 %), and Running when the source was running; it writes the verdict into the operation. 3) Only after a recorded good verify the source is stopped and removed with `removeInstance` (helper v4 quarantine, never rm). Copy or verify failure deletes nothing: `MOVE FAILED: <reason>; source kept`. A failed removal after a good copy: `MOVED, source not removed: <reason>` (status Done, `SOURCE_NOT_REMOVED`). The source is kept stopped from the copy until removal (a failed move restarts it); if it was started (status or `lastStarted` changed) or written to (helper size changed) after the copy began, it is not removed: `MOVED, source not removed: the source was started/written to during the move …`, code `SOURCE_CHANGED`. Success: `MOVED to <Engine>`. Refused before anything happens (`MOVE FAILED: …; source kept`, codes `NOT_FOUND`, `AMBIGUOUS`, `SOURCE_REMOTE`, `TARGET_UNREACHABLE`, `PEER_ACCESS`, `TARGET_OUTDATED` (target lacks the capability), `HELPER_OUTDATED` (helper < v4), `BUSY`, `INVALID`). An Engine restart never retries it and never removes the source (`INTERRUPTED`, or `SOURCE_NOT_REMOVED` when verify was already recorded). Every outcome carries a stable code (`MOVE_CODES` in `MoveAppShapes.ts`) in `Operation.move.code` and the trace `result.code`; refusals and failures also end the trace as `error` with `errorCode` = the code and `errorMessage` = the text. Verify failures are split: `VERIFY_NOT_FOUND`, `VERIFY_NOT_RUNNING`, `VERIFY_SIZE`, `VERIFY_TIMEOUT` (`VERIFY_FAILED` only as fallback). Any command error that carries an upper-case `code` writes it to the trace `errorCode`. The command trace result is the `MoveResult`.
- **Scope:** `engine`

### `verifyMoveTarget`
- **Description:** Internal, Engine → Engine (idea#79): the source Engine of a cross-Engine `moveApp` sends it to the target Engine, which checks the copy and writes `{ ok, code, bytes, detail, at }` into the move operation's `move.verify`. Not for the Console.
- **Usage:** `verifyMoveTarget <opId> <instanceId> <expectedBytes> <true|false>`
- **Scope:** `engine`

### `backupApp`
- **Description:** Backs up an app instance to a Backup Disk. The default `x-app.backup.method` is `stop`: the Engine stops the instance briefly, runs a BorgBackup archive, then restarts it. **`method: hook` (idea#444):** while holding the instance lock, the Engine runs the App's `preHook` with `timeout … docker compose exec -T [--user] -- <service> <command…>` from the instance directory (no shell), then `borg-create` without stopping the compose project, then the optional `postHook`. `postHook` always runs, even after a failed or timed-out `preHook`. If `preHook` fails or times out, `fallback` (default `stop`) either takes the short-stop path and records `HOOK_FALLBACK` on the operation, or `fail` refuses with `HOOK_FAILED` without stopping. A `postHook` failure after a successful `borg create` leaves the backup `Done` and records `HOOK_POST_WARNING` on the operation (`args.warning` and `stepLabel`). `live` and `none` fail closed until an App needs them. Optional `hookExclude` (same path rules as `exclude`, including multi-segment directory paths such as `data/backup/daily`) is applied only when the preHook succeeded, so a live copy does not pack files the dump replaces (for example a SQLite db and its `-wal`/`-shm`). On `HOOK_FALLBACK` those paths are dropped and the now-stopped live files are packed; `exclude` is still applied in both cases (secrets such as keys and Tailscale state). Hooks do not bump the helper (v8). Restore does not apply the dump — the App entrypoint does that. If no Backup Disk name is given, the first docked Backup Disk linked to the instance is used. The backup holds the instance lock and the Backup Disk lock together (idea#126); if another operation holds either, the backup is not started and the command fails with the reason. A failure during the backup fails the command with its message. **`x-app.backup.exclude` (idea#443):** paths declared on the instance compose are passed through to `idea-app-data borg-create` (helper v8) and excluded from the archive (path-prefix, confined to the instance folder; a bare name other than `data` means `data/<name>`). A non-empty list on a helper older than v8 fails with `HELPER_OUTDATED` before any hook or stop and without writing `lastBackup`. **Cleanup (idea#401, helper v10 since idea#450):** after a successful backup, and before a backup if space looks tight, the Engine deletes oldest eligible archives (round-robin across instances, never the newest 3 or an instance's only backup) when free space is below 15 % until it is above 25 %, then `borg-compact`. An older helper (v9 included: its `borg-list` printed no archive list on real borg, idea#450) skips cleanup (`HELPER_OUTDATED` recorded) and the backup still runs. If the next backup's estimated size still does not fit after cleanup, the command fails with `BACKUP_DISK_FULL` ("Backup Disk full: add a bigger disk") before any hook or stop. The helper still refuses `system` as a Backup Disk *target* (source `system` stays allowed); `.env` and `operators.json` stay in the archive because a restore needs them.
- **Usage:** `backupApp <instanceId|instanceName> <backupDiskId>` (idea#168). The instance is an instance id or a unique instance name (see [Instance arguments](#instance-arguments)); the disk goes through the shared disk resolver (see [Disk arguments](#disk-arguments)). Every refusal ends the command trace as `error` with the reason. The trace arg keys stay `instanceName` and `backupDiskId`.
- **Scope:** `engine`

### `restoreApp`
- **Description:** Restores the latest backup archive for an instance from any docked Backup Disk onto a target disk. Extracts the archive and calls processInstance to register and start the restored instance.
- **Usage:** `restoreApp <instanceId|instanceName> <targetDiskId>` (idea#168). The instance is an instance id or a unique instance name (see [Instance arguments](#instance-arguments)); the target disk goes through the shared disk resolver (see [Disk arguments](#disk-arguments)). Every refusal ends the command trace as `error` with the reason. The trace arg keys stay `instanceName` and `backupDiskId` (the latter holds the target disk).
- **Scope:** `engine`
- **Restore to another disk (#189):** before registering, the app master (`apps/<appId>`) and the instance's service tars (`services/<image>.tar`, named with `serviceImageTarName` so a pinned `repo:tag@sha256:…` finds the `repo:tag` file, idea#445) are copied onto the target when missing, from the previous `storedOn` disk first, then the other locally docked disks. Files already on the target are left alone; a piece found nowhere is logged and does not fail the restore. Code: `src/data/RestoreAppFiles.ts`.
- **Restore to another disk (#190):** when the instance was stored on another disk docked to this Engine and that disk still has `instances/<id>`, the old pre-restore folder is quarantined after the instance is registered on the target, with the helper v4 op `idea-app-data quarantine` (to `<old disk>/.idea-quarantine/<id>-<UTC stamp>`; never deleted, it may be newer than the backup). The quarantine path is logged in the command trace. A helper older than v4 refuses the restore up front with `HELPER_OUTDATED`; a failed quarantine is logged and leaves the folder in place. Code: `src/data/RestorePreQuarantine.ts`.

### `listBackup`
- **Description:** Lists Borg archives for an instance on a docked Backup Disk (helper v10 `borg-list`, idea#450). With an optional archive name, also lists member paths (capped; `partial: true` when truncated). Does not stop the instance, does not take the instance lock, and may run while the App is Running. The result (archives, optional members, whether a `.backup-in-progress` lock is present) is attached to the command trace. Refuses when the disk is not a Backup Disk, is this Pi's system disk, is undocked, has no repository for the instance, the helper is older than v10 (`HELPER_OUTDATED`; v9's `borg-list` printed no archive list on real borg, idea#450), or `skipBorg` is set. Capability `backupVerify` (idea#446; helper v10).
- **Usage:** `listBackup <instanceId|instanceName> <backupDiskId> [archive]`. The instance is an instance id or a unique instance name (see [Instance arguments](#instance-arguments)); the disk goes through the shared disk resolver (see [Disk arguments](#disk-arguments)). At most one archive name. Every refusal ends the command trace as `error` with the reason.
- **Scope:** `engine`

### `verifyBackup`
- **Description:** Restores a backup archive into a scratch folder on the Backup Disk itself, `<backup disk>/.idea-verify/<instanceId>-<stamp>/` (root-owned 0700 via helper v9 `borg-extract-verify`), and checks it without disturbing the live instance: no stop/start, no instance lock, no write under `instances/<id>`, no containers, no `processInstance`. The scratch folder is never auto-deleted. Path checks always include `x-app.backup.exclude` (must be absent in the archive) plus optional `x-app.backup.verify.present` / `verify.absent` on the *live instance compose* (same path rules as `exclude`: a bare name other than `data` or a leading-dot file such as `.env` is `data/<name>`; no hook/stop guessing). The result on the command trace includes `archive`, `scratchPath`, `members` (or a cap + `partial: true`), per-path pass/fail, `ok`, and sizes (`archiveOriginalBytes`, `archiveCompressedBytes`, `neededBytes`, `freeBytes`, `scratchBytes`). `scratchBytes` is the helper v12 (idea#460) count: `borg-extract-verify` runs `du -sb -x` on the root-owned 0700 extract and prints `scratchBytes=<n>`; the Engine uses that value. The Engine runs as `pi` and cannot size that tree itself (a local walk reports 0). An older helper that does not print the count still verifies (`BACKUP_VERIFY_HELPER_MIN` stays v10); `scratchBytes` is then `null`. There is no store field for verify space: space is checked up front (`original_size * 1.1`, or `compressed_size * 2` when original is missing) against the disk's free bytes and reported in the result; too little space is `NO_SPACE`. Takes only the Backup Disk lock. Refuses if `backupApp` is Pending/Running on that disk, the disk is locked, the archive is missing, the helper is older than v10, or `skipBorg` is set. The system disk is never a Backup target. Capability `backupVerify` (idea#446).
- **Usage:** `verifyBackup <instanceId|instanceName> <backupDiskId> [archive]`. Without an archive name, the newest archive is used. At most one archive name. Every refusal ends the command trace as `error` with the reason.
- **Scope:** `engine`

### `clearBackupLock`
- **Description:** Removes only the `.backup-in-progress` lock file for an instance on a docked Backup Disk, and drops the matching `Disk.backupStaleLocks` entry. Never starts a backup (idea#446: boot no longer auto-retries a leftover lock). When the lock file is already gone but `Disk.backupStaleLocks` still lists the instance, it drops only the store entry (result `lockFileRemoved: false`, idea#454). Refuses if a `backupApp` of that instance to this disk is Pending/Running, the in-memory backup mutex is held, or the disk is locked (those still end the trace as `error`). When there is neither a lock file nor a stale-lock entry, nothing is cleared (`cleared: false`); the command returns the plain message `no backup lock to clear for <instance>`, writes it as an info log line, and ends the trace as `ok` with that result, so the Console does not show an error (idea#454). Capability `backupVerify`.
- **Usage:** `clearBackupLock <instanceId|instanceName> <backupDiskId>`. Refusals other than "nothing to clear" end the command trace as `error` with the reason.
- **Scope:** `engine`

### `removeBackupRole`
- **Description:** Drops the Backup role from a docked disk without touching App or Files roles. Quarantines `backups/` to `.idea-quarantine/backups-<stamp>/` (helper v9 `quarantine-backups`; never deletes), unlinks `BACKUP.yaml`, and runs `processDisk`. Refuses if a stale `.backup-in-progress` lock is still present or `Disk.backupStaleLocks` is non-empty (clear it first), if `backupApp` is running to the disk, or if the disk is locked. If `backups/` is already absent, only `BACKUP.yaml` is removed. Capability `backupVerify` (idea#446).
- **Usage:** `removeBackupRole <diskId>`. The disk goes through the shared disk resolver (see [Disk arguments](#disk-arguments)). Every refusal ends the command trace as `error` with the reason.
- **Scope:** `engine`

### `removeInstance`
`removeInstance <instanceId>` (capability `removeInstance`, idea#347). Removes a stopped instance on a disk docked to this Engine without deleting any data. Under the instance lock it runs `docker compose -p <id> down` (never `-v`, so named volumes are kept), then the root helper `idea-app-data quarantine <root> <id>` (helper v4) renames `instances/<id>` to `<disk>/.idea-quarantine/<id>-<UTC stamp>` (root-owned, 0700). Only then is the instance record dropped from the store. The `removeInstance` log entry and History name the quarantine path and the kept volumes. After a successful remove, `Disk.preUpdateSnapshots`, `Disk.preUpdateBytes` and `Disk.quarantineBytes` are refreshed from the helper (idea#428), the same way `updateApp` refreshes them after a snapshot. The removed instance's own snapshot entry is then dropped from the disk row (and subtracted from `preUpdateBytes`) even if `.pre-update/<id>` is still on disk — that folder is never deleted. `quarantineBytes` comes from the helper, so it includes the new `.idea-quarantine/<id>-<stamp>`. Nothing is ever purged automatically; clearing `.idea-quarantine` needs Koen's OK. Disk scans, listing, backups and space accounting ignore `.idea-quarantine`.

Refusals (code at the start of the error text; the store is untouched): `NOT_FOUND`, `NOT_LOCAL`, `AMBIGUOUS`, `RUNNING` (Running/Starting), `BUSY_BACKUP` (backup/restore holds the lock), `BUSY_MOVE` (move/copy holds it), `BUSY` (other holder), `COMPOSE_DOWN_FAILED`, `QUARANTINE_FAILED`, `HELPER_OUTDATED` (root helper older than v4).

**Helper version:** the Engine always starts, whatever `idea-app-data` version is installed; a missing or different helper is only logged as a warning at startup. Commands that need a newer helper refuse with `HELPER_OUTDATED`: `removeInstance` and a cross-Engine `moveApp` need v4, `updateApp` v5, `backupApp` with a non-empty `x-app.backup.exclude` needs v8 (idea#443), and `listBackup` / `verifyBackup` / `clearBackupLock` / `removeBackupRole` (and backup cleanup, idea#401) need v10 (idea#446; idea#450 fixed v9's `borg-list` inventory). A backup with no excludes still runs on v7. This Engine speaks helper v12 (`APP_DATA_HELPER_VERSION`; idea#460: `borg-extract-verify` prints `scratchBytes=<n>`). `verifyBackup` still runs on v10, with `scratchBytes` null. No new sudoers line.

### `updateApp`
`updateApp <instanceId|name> <newAppId> [--allow-major] [--source <diskId>]` (capability `updateApp`, #230, proposal idea#351). Updates an instance to a newer bundle `apps/<newAppId>/` on a disk docked to this Engine, or — with `--source <diskId>` naming a disk docked to another Engine — fetched first (cross-Engine Fetch, capability `updateAppFetch`, #263; see below). Needs root helper `idea-app-data` v9 (idea#448: snapshot excludes and in-place restore).

Steps (progress: ephemeral message `idea/updateProgress` with `{engineId, instanceId, step, bytesDone, bytesTotal}`; also the `updateApp` operation's step): Fetch, Check, Snapshot, Swap, Start, Health.

**Cross-Engine Fetch (#263, capability `updateAppFetch`).** Push model: under the instance lock, before anything is stopped, the target Engine writes `apps/<newAppId>/.idea-fetching` (request id) on the instance's disk and sends `pushAppBundle <sourceDiskId> <appId> <targetEngineId> <targetRoot> <requestId> <instanceId>` to the source Engine. The source refuses bundles carrying bundle-root `.idea-*` files or no `SHA256SUMS`, and pushes with `rsyncToPeer` through the existing `receive-app` path with `--partial`, 3 retries with backoff (5 s, 20 s, 60 s). It answers `appFetchResult <requestId> ok|TRANSFER_FAILED <why>`. The target refuses pushed bundle-root `.idea-*` files, re-checks `SHA256SUMS`, then renames `.idea-fetching` to `.idea-fetched`. Dock and the app listing ignore a folder until `.idea-fetched` exists; a partial or refused folder is moved aside to `apps/.idea-aborted-<appId>-<stamp>/` (never removed). Any failure refuses `TRANSFER_FAILED` with nothing stopped. Thermal pause: at ≥75 °C the source pauses (stopping a running rsync; not counted as a retry) until ≤65 °C, broadcasting `idea/updateProgress` with `fetchPaused: {reason: 'thermal', bytesDone, bytesTotal, since}`. No helper or gate change.
- **Identity (idea#448).** The snapshot leaves out the union of the live and the new compose's `x-app.backup.exclude` (for usage-dashboard `data/keys`, `data/tailscale`, `data/tailscale-run`); it is recorded in the snapshot's `EXCLUDE` file. A rollback restores in place and never writes, deletes or moves those paths, so the Tailscale state file keeps its inode and the node keeps its identity. A malformed exclude in either compose refuses `BAD_BACKUP_SPEC` before anything changes. A new bundle that itself contains one of those paths (or a non-directory where a parent of one should be) refuses `BUNDLE_CONTAINS_EXCLUDED`, naming the paths, before the Snapshot: nothing is stopped, backed up or written.
- **Pre-update backup (idea#448).** A major update (an unversioned SHA to a tag stays major, idea#76; `--allow-major` is still required) with no backup in the last hour no longer needs a separate `backupApp`: when a Backup Disk linked to the instance is docked to this Engine, `updateApp` takes the backup itself. It is a backup of the CURRENT instance, so it uses the current (live) compose's `x-app.backup` (`instances/<id>/compose.yaml`), never the new bundle's (idea#458: a hook that only the new version ships ran inside the old containers and exited 127). With `method: hook` in the current compose and the instance running, the current compose's preHook runs (`docker compose -p <id> --project-directory instances/<id> -f instances/<id>/compose.yaml exec`, against the live containers and data) and Borg runs before anything is stopped; a failed preHook refuses `HOOK_FAILED` ("… (the current version's backup hook); nothing was stopped or changed, and the update does not fall back to a stop-mode backup") whatever its `fallback` says. With `method: stop` or no `x-app.backup` in the current compose (an update that introduces a hook backs up the old version in stop mode), or when the instance is not running, Borg runs inside the one Snapshot stop (no second stop). The new bundle's `x-app.backup` only adds its `exclude` list to the snapshot excludes. The backup honours `exclude` (and `hookExclude` after a good preHook), sets `lastBackup` and shows as a `backupApp` operation with `reason: pre-update`. Any other backup failure refuses `BACKUP_FAILED`, including a `.backup-in-progress` left by an earlier backup (`BACKUP_STALE_LOCK`, not retried, idea#446); if the instance was stopped for it, the old version is started again. Without a linked docked Backup Disk the refusal is still `NEEDS_BACKUP`.
- **Check** refuses before anything changes. Its space check uses the helper's read-only `estimate` (instance folder + named volumes, and the App Disk's free space), so `NO_SPACE` refuses before the instance is stopped; the snapshot's own check stays as a backstop.
- **Snapshot** stops the instance and waits until its containers are gone. Then `idea-app-data snapshot` copies `instances/<id>` (bundle files, `.env`, data) to `<disk>/.pre-update/<id>/` (root, 0700). Each named Docker volume of the instance (compose project `<id>`) is exported too, to `.pre-update/<id>/volumes/<volume>.tar`: offline, with the host's GNU tar from the local volume folder (no image is run or pulled), keeping owners, modes, ACLs and xattrs; each archive is listed (`tar -t`) and checksummed (`volumes/SHA256SUMS`, re-checked) before `COMPLETE`. The export time per volume is in the op log and the result. A `COMPLETE` marker is written last; a snapshot without it is never restored. A previous snapshot of the same instance (complete or not) does not block a second update: it is renamed (same disk, never copied or removed) into `.idea-quarantine/pre-update-<id>-<stamp>` first, and that path is reported.
- **Swap** copies the new bundle files over the instance folder (`.env` kept) and sets `x-app.instanceName` again.
- **Health** waits for healthy within `x-app.healthTimeout` (defaults: Kolibri 900 s, Nextcloud 300 s, others 600 s). `starting`/`unhealthy` mean "wait"; an exited container, a crash loop (3 restarts) or the timeout fail.
- A failure from Snapshot on rolls back: compose down (no `-v`), `restore-snapshot` in place with the same excludes (`instances/<id>` is never moved; every live file it replaces or deletes goes to `.idea-quarantine/<id>-before-restore-<stamp>/` first; each volume's current contents are renamed to `_data.idea-quarantine-<stamp>` beside it before the archive is extracted), old version started. The error starts `ROLLED BACK: <why>`. If the rollback fails, the instance is left Stopped with a status starting `ROLLBACK FAILED:`.
- The result and History carry `snapshotPath`, `snapshotBytes`, `previousSnapshotQuarantinedAt` (or null), `volumes` (`{name, bytes, exportMs}`), `snapshotExcludes` and `preUpdateBackup` (`{backupDiskId, method, duringStop}` or null, idea#448). Snapshots are kept; `Disk.preUpdateSnapshots` lists `{instanceId, sizeBytes, complete}` per disk, and `Disk.preUpdateBytes` / `Disk.quarantineBytes` give the totals of `.pre-update` and `.idea-quarantine`. Nothing is purged automatically.
- An Engine restart during an update rolls back at startup when the snapshot is complete and the swap had started (in place, with the snapshot's `EXCLUDE` plus the excludes of the compose now in the folder); the operation ends Failed with `INTERRUPTED: ...`.

Refusal codes (start of the error text): `NOT_FOUND`, `AMBIGUOUS`, `NOT_DOCKED`, `HELPER_OUTDATED` (helper older than v9), `BUSY`, `SOURCE_MISSING`, `NO_SUMS` (the bundle has no valid `SHA256SUMS`, root-relative, checked with `sha256sum --check --strict`; such an App is never offered an update), `DIFFERENT_APP` (names the missing or mismatched `x-app.name` and/or `x-app.version`, with actual and expected values), `NOT_NEWER`, `MAJOR_NOT_ALLOWED`, `NEEDS_BACKUP` (major update without a backup in the last hour and no linked Backup Disk docked here), `BAD_BACKUP_SPEC`, `HOOK_FAILED`, `BACKUP_FAILED` (idea#448, the pre-update backup), `BUNDLE_CONTAINS_EXCLUDED` (idea#448, the bundle ships an excluded path), `NO_SPACE` (`NO_SPACE: ... snapshot needs X, free Y`; the snapshot needs the instance folder plus its named volumes, which may live on the system SSD, plus 10 %, at least 1 GiB, all against the free space of the instance's App Disk). Reserved: `TRANSFER_FAILED` (#263 only), `SOURCE_UNSUPPORTED` (not emitted in v1).

`Instance.updateAvailable`: `{appId, sourceDiskId?, sourceEngineId?, fromVersion?, toVersion?, major?, estimatedMinutes?, sizeBytes?, migrationNote?}` or null. Filled at dock time, cheaply: a newer `apps/<name>-<version>/` of the same App on a disk docked to this Engine whose `SHA256SUMS` exists and lists `compose.yaml` (the file is read, not verified; the highest version wins). The full `SHA256SUMS` check runs at update start (`NO_SUMS`). Once an `updateApp` has started its operation it recomputes the field when it ends, whatever the outcome, from the instance's version at that moment (idea#459): after a successful update an offer of the version the instance now runs (or an older one) is cleared and only a genuinely newer bundle is still offered, with `fromVersion` the new version; after a rollback or a failure before the swap the old version runs and the offer stays. A refusal before the operation leaves the field untouched. A startup recovery of an interrupted update recomputes it too.

### `createBackupDisk`
- **Description:** Writes a BACKUP.yaml configuration onto a docked disk, turning it into a Backup Disk. Specify the mode (`immediate`, `on-demand`, or `scheduled`) and one or more instance names to link.
- **Usage:** `createBackupDisk <diskId> <mode> <instanceName...>` (idea#128; the argument was `diskName`). The disk is resolved by the shared disk resolver (see [Disk arguments](#disk-arguments)). An unknown, undocked, remote or ambiguous disk, a bad mode or a missing store ends the command trace as `error` with the reason.
- **Scope:** `engine`


### `summariseDisk`
- **Description:** Content summary for erase confirmation (idea#134). Walks a mounted IDEA disk (or reports `readable: false` for an unformatted candidate) and stores the JSON `contentSummary` on `CommandTrace.result`. Caps: 100 000 entries or 10 s → `partial: true`. Backups from `BACKUP.yaml` + store (no `borg list`).
- **Usage:** `summariseDisk <diskId|candidateId>`
- **Capability:** `eraseDisk`

### `eraseDisk`
- **Description:** Erase any non-system disk to an empty IDEA disk (idea#134): GPT + one ext4 partition, label "IDEA Disk", only `META.yaml`, `diskTypes` `['empty']`. Requires a fresh `summariseDisk` trace (same target, &lt;10 min) and the exact label as confirmation. Eject path first; blockers for backup / instance lock / Nextcloud first-start|upgrade; `docker compose down -v` per instance; instances and app entries removed (E9); backup links to an erased Backup Disk cleared. Script: `/usr/local/sbin/idea-erase-disk` (11-engine-files, no argument list).
- **Usage:** `eraseDisk <targetId> <summaryTraceId> <confirmName…>`
- **Capability:** `capabilities.includes('eraseDisk') && capabilitiesBootedAt === lastBooted`

### `createFilesDisk`
- **Description:** Adds the Files role to a docked disk (idea#131, Files Disk step 1): writes `FILES.yaml` and an empty `files/` folder in the disk root, plus `META.yaml` if it is missing (the disk ID is always kept), then processes the disk again so `diskTypes` gains `'files'` next to its other roles (for example `['app', 'files']` or `['app', 'backup', 'files']`). Works on an empty ext4 disk (`['empty']`) and on an App and/or Backup Disk. Nothing else on the disk changes: `apps/`, `services/`, `instances/`, `BACKUP.yaml` and `backups/` are untouched, existing instances keep running, and the filesystem label is never changed. Mounting `files/` into opted-in Apps is idea#133 (step 2): `createFilesDisk` ends with `processDisk`, which schedules a remount of other-disk opted-in instances (same-disk instances start with the override via `processAppDisk`).
- **Usage:** `createFilesDisk <diskId> [<shareName…>]`. The disk **ID** only (the command has no name form, so there is no name fallback). The share name is optional, takes the rest of the line and defaults to `School Files`: 1 to 16 characters from `A–Z a–z 0–9`, space, hyphen, underscore and parentheses, with no leading or trailing space (tokens are joined with one space). The trace records `args.diskId` and `args.shareName` (the tokens, `[]` for the default).
- **Refused** (the trace ends as `error`; nothing is written to the disk), checked in this order:
  1. a bad share name, or `Engine.eraseInProgress` is set for this disk;
  2. the ID is unknown, the disk isn't docked, or it is docked to another engine;
  3. the system disk;
  4. the disk is already a Files Disk (`'files'` in `diskTypes` or `FILES.yaml` present), an Upgrade Disk, or not processed yet (`diskTypes` empty);
  5. the root holds anything besides `META.yaml`, `lost+found` and its roles' IDEA entries (`apps/`, `services/`, `instances/` for an App Disk; `BACKUP.yaml`, `backups/` for a Backup Disk), including a stray `files/`: "<name> has other files on it (…). Use Make this a Files Disk to erase it, or empty it on another computer.";
  6. not ext4 (`findmnt -no FSTYPE /disks/<device>`);
  7. the disk is locked by another operation, or a backup to it is pending or running. This is checked before anything changes, and the disk lock is held until the files are written;
  8. the root isn't writable by `pi` and the owner change fails ("this Engine is missing a permission update; ask Ops to install the new 11-engine-files sudoers file"), or the root is still not writable afterwards.
- **Owner change:** only when `pi` can't write the disk root (a root-owned mount root). The trace first records the root folder's previous `uid:gid` and mode (so it can be undone by hand), then the Engine runs exactly `sudo /usr/bin/chown -h pi:pi /disks/<device>` (entry in `/etc/sudoers.d/11-engine-files`): the root folder only, not recursive, `-h` never follows a symlink. `createFilesDisk` is the only command that changes a disk root's owner.
- **Scope:** `engine`
- **Examples:**
  - `createFilesDisk f3a9c2d1` — share name "School Files"
  - `createFilesDisk f3a9c2d1 My Share (2)` — share name "My Share (2)"

### `ejectDisk`
- **Description:** Safely ejects a docked disk from this engine. Updates the shared store to reflect the undocked state, stops all running instances on the disk, then unmounts it: `umount` is repeated (at most 5 times, 1 s apart after a failure) until the mount point is no longer a mount point, and the empty mount point is removed with `rmdir`, never `rm -fr` (idea#126). If it stays busy, nothing is removed, a failed `diskDetection` trace is written and the disk gets `unmountError` (restart the Pi to release it). Refused for this Pi's system disk (the record marked `diskTypes: ['system']`, or any record on the drive holding `/` and `/boot/firmware`), whether it is named by id or by name (idea#152). Refused while the disk is locked by an operation or while a `backupApp` operation writing to it is pending or running. Any stale store record that still claims the same device is undocked too (idea#152). Equivalent to a clean physical removal.
- **Usage:** `ejectDisk <diskId>` (the Console sends `disk.id`). A disk name is still accepted for older Consoles and the CLI, under the rules in [Disk arguments](#disk-arguments) (idea#128; eject by id instead). Every refusal ends the command trace as `error` with the reason (idea#152).
- **Scope:** `engine`

### `forgetDisk`
- **Description:** Removes a stale disk record from the shared store (idea#279, idea#282), e.g. the record an older Engine created when it wrote `META.yaml` onto a client SD card. A store edit only: nothing on any disk is read or written. Refused (trace ends as `error`; `error` and `errorMessage` both carry the reason, like other commands) when there is no record with exactly that id (no name fallback, because forgetting cannot be undone), when the record is docked (`dockedTo` or `device` set: eject or unplug it first), or when instance records are still stored on the disk (they would be orphaned; forgetDisk never removes instances). If the disk is an IDEA disk and is plugged in again later, it docks and gets a new record from its `META.yaml` as usual.
- **Usage:** `forgetDisk <diskId>`, e.g. `forgetDisk 7wt29vdzvj3b2xxt605`
- **Scope:** `engine`
- **Capability:** `forgetDisk`

### `reboot`
- **Description:** Reboots the engine device.
- **Usage:** `reboot`
- **Scope:** `engine`

---

## Provisioning Commands

### `buildEngine`
- **Description:** Executes the `build-engine` script to provision a new Raspberry Pi Engine from the current engine. This command streams the output of the build script to the console.
- **Usage:** `buildEngine "--machine <hostname> --user <user> ..."`
- **Scope:** `engine`
- **Note:** The arguments must be passed as a single, quoted string.

### Disk arguments

`installApp` (target and `--source`), `createBackupDisk`, `ejectDisk`, `backupApp` and `restoreApp` (idea#168) take a disk id and resolve it with one shared resolver, `resolveDiskArg` in `src/data/DiskArg.ts` (idea#128):

1. **Id first.** A record with that id must be docked to this engine and have a device. Otherwise the command is refused (`not currently docked`, `not docked to this engine`).
2. **Name fallback (deprecated).** When no record has that id, the argument is matched as a disk name, but only against records docked to this engine with a device. Stale or remote records with the same name are ignored. If two such records share the name, the command is refused as ambiguous and the ids are listed. A name that resolves logs a deprecation warning into the trace: `<command>: disk '<name>' was given by name; use the disk id <id> (names are deprecated, idea#128).`
3. **Not found.** `Disk '<arg>' not found.`

Every refusal throws, so the command trace ends as `error`. The resolver does not refuse the system disk (it is a valid `installApp` target); `ejectDisk` refuses it separately.

A Console can tell whether the Engine takes disk ids from the Engine record: `capabilities.includes('diskIdArgs') && capabilitiesBootedAt === lastBooted` (see ARCHITECTURE.md, Engine capabilities).

A disk name with spaces can be passed as one argument in double quotes, e.g. `restoreApp kolibri "Duration Tests — Add Files App"` (idea#168). A token that starts with `"` runs to the next `"` that ends a token; the quotes are removed. Lines without a `"` are split on spaces exactly as before. Commands that take the whole rest of the line as one argument (`send`, `connect`, `buildEngine`) are not affected; `installApp` takes the rest of the line and splits it with the same quote-aware `splitArgs`.

`createFilesDisk` (idea#131) is new and takes the disk ID only: it uses `lookupDiskById` (the id rule above, without the name fallback). A Console knows the Engine has it when `capabilities.includes('filesDisk') && capabilitiesBootedAt === lastBooted`. Files binds into Apps (`Instance.filesMounts`) need `capabilities.includes('filesMount')` as well (idea#133). Erase needs `capabilities.includes('eraseDisk')` (idea#134). Per-disk allowed actions (`Engine.diskCandidates`, idea#303) need `capabilities.includes('diskCandidates')`; with it, a USB SSD/HDD can be a client-image flash target and `flashCard` returns NOT_REMOVABLE only for a non-USB disk. `flashCard` also writes the Engine's own time zone to the card as `idea-timezone.txt` (idea#208; skipped and logged when the zone is empty or invalid; no new arguments or Console UI).

### Instance arguments

`startInstance`, `runInstance`, `stopInstance`, `copyApp`, `moveApp`, `backupApp` and `restoreApp` resolve their instance argument id-first with `lookupInstanceArg` / `resolveInstanceArg` in `src/data/InstanceArg.ts` (idea#168):

1. **Id.** An instance with that id.
2. **Unique name.** Exactly one instance with that name.
3. **Name on the command's disk.** When several instances share the name, the one stored on the disk the command names: the disk argument of `startInstance` / `runInstance` / `stopInstance` (a disk id or disk name), the source disk of `copyApp` / `moveApp`. A warning in the trace names the id to send instead. This keeps the Console's wire format (`startInstance <name> <storedOn>`, `copyApp <name> <sourceDiskId> <targetDiskId>`) working and unambiguous. `backupApp` / `restoreApp` have no such disk and skip this step.
4. **Refused.** Otherwise the command is refused as ambiguous (the candidate ids and their disks are listed) or as not found. Both refusals end the trace as `error`.

Trace arg keys are unchanged (`instanceName`), so a Console that filters traces by the value it sent keeps working. An Engine with this resolver advertises the `instanceIdArgs` capability (see ARCHITECTURE.md, Engine capabilities); a Console can send instance ids to such Engines.

### Instance data links

`copyApp`, `moveApp` and `installApp` (when it copies an existing source instance) refuse instance data that links off the disk (idea#168 r35). Before anything is stopped or written, the instance folder is scanned; any symlink that resolves outside the instance folder (lexically, or after following the link chain; dangling links included) refuses the command with every such link and its target, e.g. `copyApp: instance data links off the disk: 'data/kolibri' -> '/home/pi/idea166-kolibri-live/data/kolibri'. …`. rsync `-a` and `fs.copy` reproduce a link verbatim, so the copy would share the original's data; the Engine refuses rather than dereferencing, which would silently copy an arbitrarily large external tree. Links that stay inside the instance folder are copied as links. Folders the Engine (pi) cannot read are skipped by this scan; the instance data itself is copied as root by the app-data helper (`idea-app-data copy|send`, idea#168), which keeps owners and modes and runs the same link check as root before it writes anything (`instance data links off the slot: …`). No IDEA product path creates such a link; replace it with the real data and retry.

---

## Connection Commands

### `connect`
- **Description:** Connects the CLI to one or more remote engines.
- **Usage:** `connect <engine-hostname> [engine-hostname...]`
- **Scope:** `any`

### `disconnect`
- **Description:** Disconnects the CLI from the current engine(s).
- **Usage:** `disconnect`
- **Scope:** `any`
