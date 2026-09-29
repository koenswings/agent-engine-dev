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
- **Usage:** `installApp <appId> <targetDiskId> [--source <sourceDiskId>] [--name <instanceName>]` (idea#128). The target and source are disk ids (the Console sends `disk.id`), resolved by the shared disk resolver (see [Disk arguments](#disk-arguments)). Both must be docked to this engine; a disk on another engine or an undocked record is refused (the old any-engine and undocked fallbacks are gone). Every refusal and usage error ends the command trace as `error` with the reason.
- **Scope:** `engine`
- **Examples:**
  - `installApp kolibri-1.0 f3a9c2d1` — auto-route (online → GitHub, offline → appDB lookup)
  - `installApp kolibri-1.0 f3a9c2d1 --source 7be04c11` — copy from a docked catalog disk
  - `installApp kolibri-1.0 f3a9c2d1 --source 7be04c11 --name school-kolibri` — custom instance name

### `createInstance` *(deprecated)*
- **Description:** Deprecated alias for `installApp`. Use `installApp` instead. Builds a new application instance from a git repository.
- **Usage:** `createInstance <instanceName> <appName> <gitAccount> <gitTag> <diskName>`
- **Scope:** `engine`

### `startInstance`
- **Description:** Starts a previously created application instance. This involves preloading services and creating and running the Docker containers. The instance becomes `Running` only after `docker compose up` succeeded; any failure sets it to `Error` and closes the command's trace as failed (idea#109). A missing or unloadable `services/<image>.tar` is only a warning (a `warn` log line in the trace): Docker pulls the image at create time if it can.
- **Usage:** `startInstance <instanceName> <diskName>`
- **Scope:** `engine`

### `runInstance`
- **Description:** A shortcut for running an already-created instance's containers. Assumes `startInstance` has been run at least once. Sets `Running` only after `docker compose up` succeeded; on failure the instance is set to `Error` and the command fails.
- **Usage:** `runInstance <instanceName> <diskName>`
- **Scope:** `engine`

### `stopInstance`
- **Description:** Stops a running application instance and its associated Docker containers.
- **Usage:** `stopInstance <instanceName> <diskName>`
- **Scope:** `engine`

### `copyApp`
- **Description:** Copies an app instance from one disk to another. The copy receives a brand new InstanceID — it is treated as a fresh instance. The original instance is stopped during the file copy (for a consistent snapshot) and restarted afterwards. Progress is tracked in `operationDB` in the store and visible to all Consoles.
- **Usage:** `copyApp <instanceName> <sourceDiskName> <targetDiskName>`
- **Scope:** `engine`

### `moveApp`
- **Description:** Moves an app instance from one disk to another. The instance keeps its original InstanceID so backup disk links remain intact. The source instance directory (and app master, if no other instance on the source disk uses it) is removed after a successful transfer.
- **Usage:** `moveApp <instanceName> <sourceDiskName> <targetDiskName>`
- **Scope:** `engine`

### `backupApp`
- **Description:** Backs up an app instance to a Backup Disk. Stops the instance briefly for filesystem consistency, runs a BorgBackup archive, then restarts it. If no Backup Disk name is given, the first docked Backup Disk linked to the instance is used. The backup holds the instance lock and the Backup Disk lock together (idea#126); if another operation holds either, the backup is not started and the command fails with the reason. A failure during the backup fails the command with its message.
- **Usage:** `backupApp <instanceName> [backupDiskName]`
- **Scope:** `engine`

### `restoreApp`
- **Description:** Restores the latest backup archive for an instance from any docked Backup Disk onto a target disk. Extracts the archive and calls processInstance to register and start the restored instance.
- **Usage:** `restoreApp <instanceName> <targetDiskName>`
- **Scope:** `engine`

### `createBackupDisk`
- **Description:** Writes a BACKUP.yaml configuration onto a docked disk, turning it into a Backup Disk. Specify the mode (`immediate`, `on-demand`, or `scheduled`) and one or more instance names to link.
- **Usage:** `createBackupDisk <diskId> <mode> <instanceName...>` (idea#128; the argument was `diskName`). The disk is resolved by the shared disk resolver (see [Disk arguments](#disk-arguments)). An unknown, undocked, remote or ambiguous disk, a bad mode or a missing store ends the command trace as `error` with the reason.
- **Scope:** `engine`

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

`installApp` (target and `--source`), `createBackupDisk` and `ejectDisk` take a disk id and resolve it with one shared resolver, `resolveDiskArg` in `src/data/DiskArg.ts` (idea#128):

1. **Id first.** A record with that id must be docked to this engine and have a device. Otherwise the command is refused (`not currently docked`, `not docked to this engine`).
2. **Name fallback (deprecated).** When no record has that id, the argument is matched as a disk name, but only against records docked to this engine with a device. Stale or remote records with the same name are ignored. If two such records share the name, the command is refused as ambiguous and the ids are listed. A name that resolves logs a deprecation warning into the trace: `<command>: disk '<name>' was given by name; use the disk id <id> (names are deprecated, idea#128).`
3. **Not found.** `Disk '<arg>' not found.`

Every refusal throws, so the command trace ends as `error`. The resolver does not refuse the system disk (it is a valid `installApp` target); `ejectDisk` refuses it separately.

A Console can tell whether the Engine takes disk ids from the Engine record: `capabilities.includes('diskIdArgs') && capabilitiesBootedAt === lastBooted` (see ARCHITECTURE.md, Engine capabilities).

`createFilesDisk` (idea#131) is new and takes the disk ID only: it uses `lookupDiskById` (the id rule above, without the name fallback). A Console knows the Engine has it when `capabilities.includes('filesDisk') && capabilitiesBootedAt === lastBooted`. Files binds into Apps (`Instance.filesMounts`) need `capabilities.includes('filesMount')` as well (idea#133).

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
