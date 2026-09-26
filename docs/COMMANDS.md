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
- **Usage:** `installApp <appId> <targetDiskName> [--source <sourceDiskName>] [--name <instanceName>]`
- **Scope:** `engine`
- **Examples:**
  - `installApp kolibri-1.0 my-disk` — auto-route (online → GitHub, offline → appDB lookup)
  - `installApp kolibri-1.0 my-disk --source catalog-disk` — copy from a docked catalog disk
  - `installApp kolibri-1.0 my-disk --source catalog-disk --name school-kolibri` — custom instance name

### `createInstance` *(deprecated)*
- **Description:** Deprecated alias for `installApp`. Use `installApp` instead. Builds a new application instance from a git repository.
- **Usage:** `createInstance <instanceName> <appName> <gitAccount> <gitTag> <diskName>`
- **Scope:** `engine`

### `startInstance`
- **Description:** Starts a previously created application instance. This involves preloading services and creating and running the Docker containers.
- **Usage:** `startInstance <instanceName> <diskName>`
- **Scope:** `engine`

### `runInstance`
- **Description:** A shortcut for running an already-created instance's containers. Assumes `startInstance` has been run at least once.
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
- **Description:** Backs up an app instance to a Backup Disk. Stops the instance briefly for filesystem consistency, runs a BorgBackup archive, then restarts it. If no Backup Disk name is given, the first docked Backup Disk linked to the instance is used.
- **Usage:** `backupApp <instanceName> [backupDiskName]`
- **Scope:** `engine`

### `restoreApp`
- **Description:** Restores the latest backup archive for an instance from any docked Backup Disk onto a target disk. Extracts the archive and calls processInstance to register and start the restored instance.
- **Usage:** `restoreApp <instanceName> <targetDiskName>`
- **Scope:** `engine`

### `createBackupDisk`
- **Description:** Writes a BACKUP.yaml configuration onto a docked disk, turning it into a Backup Disk. Specify the mode (`immediate`, `on-demand`, or `scheduled`) and one or more instance names to link.
- **Usage:** `createBackupDisk <diskName> <mode> <instanceName...>`
- **Scope:** `engine`

### `ejectDisk`
- **Description:** Safely ejects a docked disk from this engine. Stops all running instances on the disk, unmounts it, and updates the shared store to reflect the undocked state. Equivalent to a clean physical removal.
- **Usage:** `ejectDisk <diskName>`
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
