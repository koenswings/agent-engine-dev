# Provisioning Scripts Reference

This document provides a reference for the main provisioning and utility scripts used in the Engine project.

---

### `install.sh`

-   **Purpose:** A bootstrap script for setting up a new Engine device from scratch. This is the easiest way to perform a fresh installation on a new Raspberry Pi.
-   **Usage:** `curl -sSL <URL_to_install.sh> | sudo bash`
-   **Details:** This script installs the necessary base system dependencies (like Node.js, `zx`, `git`) and then runs the `./build-engine` wrapper (`script/build-engine.ts`) in local mode to complete the provisioning.

---

### `build-engine` (`script/build-engine.ts`)

-   **Purpose:** The primary, all-in-one script for provisioning a full Engine device. It runs via the `./build-engine` wrapper in the repo root (which calls `tsx script/build-engine.ts`). It has three modes:
    1.  **Remote Mode** (`--machine` given): First syncs the code to the Pi with `sync-engine`, then configures the Pi over SSH. No GitHub token is needed or asked for: the Engine repo is public (idea#116).
    2.  **Local Mode** (no `--machine`): Configures the machine it is running on (used by `install.sh`).
    3.  **Personalize Mode** (`--personalize`): Only sets the hostname and rewrites `/META.yaml` (disk id from the disk serial via `hdparm`, or a new random id if there is none; hostname; version; timestamps). It does not build the Engine and asks no questions. `script/build_image_assets/boot.sh` runs it on the first boot of a freshly flashed master image (when `/boot/MASTER` exists). On every boot, `boot.sh` also reinstalls the udev rule `/etc/udev/rules.d/90-docking.rules` from `script/build_image_assets/90-docking.rules` when it is missing or differs, then reloads and re-triggers udev (idea#82; output in `/home/pi/boot.out`).
-   **Usage (Remote):** `./build-engine --machine <pi-address> [options]`
-   **Usage (Local):** `./build-engine [options]`
-   **Usage (Personalize):** `./build-engine --personalize [--hostname <name>]`
-   **Options** (defaults come from `defaults` in `config.yaml`):
    -   `-h, --help`: Show help.
    -   `-v, --version`: Show the version.
    -   `-u, --user <user>`: The SSH user for Remote Mode.
    -   `-m, --machine <address>`: The Pi's hostname or IP address. Leave it out for Local Mode.
    -   `--hostname <name>`: The hostname to set (default: randomly generated).
    -   `-l, --language <locale>`, `-k, --keyboard <layout>`, `-t, --timezone <tz>`: Localisation settings.
    -   `--upgrade`, `--argon`, `--zerotier`, `--raspap`, `--gadget`, `--temperature`: Optional parts of the build. Every one of these can be turned off with `--no-<option>` or `--<option>=false` (idea#146), which is required for argon/gadget on spare and Pi 5 profiles.
    -   `--model pi4|pi5`: Selects the Pi model. On pi5, gadget mode is forced off and an explicit `--gadget` is refused.
    -   `--prod`: Build in production mode.
    -   `--personalize`: Personalize Mode (see above).
-   **Details:** A full build handles everything from setting the hostname and installing Docker to deploying the Engine software itself. It also installs the Engine's two sudoers files (`installEngineSudoers`, each validated with `visudo` first, mode 0440, owner root:root): `/etc/sudoers.d/10-engine` from `script/build_image_assets/10-engine.sudoers`, the exact commands the Engine, running as `pi`, may run as root; and `/etc/sudoers.d/11-engine-files` from `script/build_image_assets/11-engine-files.sudoers`, the files and folders it may write or remove as root under `/disks` (`/usr/bin/tee /disks/sd[a-z][12]/META.yaml`, idea#121; `/usr/bin/rmdir /disks/sd[a-z][12]`, idea#126). An updated `11-engine-files` must be installed before an Engine that needs it is deployed; `sudo -ll -U pi <exact command>` shows which sudoers file allows a command. pm2 and `pm2-logrotate` are installed into pi's pm2.

---

### `build-app-instance.ts`

-   **Purpose:** Used to create a new **App Disk**. This script takes an existing application definition from a git repository and prepares it as a runnable instance on a specified, mounted disk.
-   **Usage:** `./script/build-app-instance [options] <appName>`
-   **Options:**
    -   `--instance <name>`: A user-friendly name for the instance (defaults to the app name).
    -   `--disk <deviceName>`: The device name of the disk (e.g., `sda1`).
    -   `--git <account>`: The GitHub account to pull the app from.
    -   `--tag <tag>`: The git tag or branch to use (defaults to `latest`).

---

### `build-service.ts`

-   **Purpose:** Used to build a Docker image for a specific service component from its git repository and push it to a container registry like Docker Hub.
-   **Usage:** `./script/build-service [options] <serviceName>`
-   **Options:**
    -   `--registry <url>`: The container registry URL.
    -   `--user <user>`: The user account for the registry.
    -   `--git <account>`: The GitHub account where the service source is located.
    -   `--platform <platform>`: The target platform for the build (e.g., `linux/arm64`).
    -   `--tag <tag>`: The version/tag for the build.

---

### `sync-engine.ts`

-   **Purpose:** A utility script to synchronize code changes from a Development System to a running Runtime System (a Raspberry Pi).
-   **Usage:** `./script/sync-engine --machine <pi-address>`
-   **Details:** This script uses `rsync` to efficiently copy only the changed files, making it ideal for rapid development and testing cycles. It never copies a `gh_token.txt` (`--exclude='gh_token.txt'`, idea#116), so an old local token file cannot reach a Pi. It connects as `pi`, builds with a plain `pnpm build` and stops/starts the Engine with pi's pm2 (never `sudo pm2`, which would target root's process list).

---

### `reset-engine.ts`

-   **Purpose:** Resets the store data, store identity, `/META.yaml` and/or the code of one or more Engines (or the local one).
-   **Usage:** `./reset-engine [-d] [-i] [-m] [-c] [-a] [engineName1] [engineName2] ...` (see `./reset-engine -h`).
-   **Details:** Remote targets are reached over SSH as `pi`. It builds with a plain `pnpm build` and uses pi's pm2, so run it as `pi`: a local reset refuses to run as root.

---

### `client.ts`

-   **Purpose:** This script is the entry point for the interactive Command-Line Interface (CLI).
-   **Usage:** `./script/client --engine <engine-address>`
-   **Details:** For a full list of commands available within the CLI, see the [Command Reference](COMMANDS.md).

---

### `bundle-context.ts`

-   **Purpose:** Bundles the project source code into a single Markdown file (`docs/source-bundle.md`). This is useful for providing context to LLMs like NotebookLM or Gemini.
-   **Usage:** `pnpm bundle-context`
-   **Details:** Ignores `node_modules` and `dist`.

---

### `cleanup-store.ts` (`script/cleanup-store.ts`)

-   **Purpose:** Removes stale entries from the Engine's local Automerge store (`store-data/`, document from `store-identity/store-url.txt`).
-   **Usage:** `pnpm cleanup-store` (dry run), `npx tsx script/cleanup-store.ts --commit` (write), add `--orphans-only` to remove only orphan disk entries. Stop the Engine first (`sudo -u pi pm2 stop engine`); with `--commit` the script refuses to run while pm2 shows it online.
-   **Details:**
    -   Default mode removes every undocked disk that is not a system disk, instances that are `Missing` or stored on a removed or unknown disk, and apps without instances. Meant for stores full of test fixture entries.
    -   **Orphan disk entries (idea#121):** before idea#121 a disk without `META.yaml` and without a readable hardware serial got a new random diskId on every dock, leaving one `diskDB` entry per dock. `findOrphanDiskIds()` in `script/cleanup-store-lib.ts` marks an entry as an orphan when it is undocked (no `dockedTo`, no `device`), not a system disk, no instance is stored on it, it has no `backupConfig`, and no operation names it in its args. Orphans are tagged `[orphan]` in the report. `--orphans-only` removes only those and keeps everything else (undocked App Disks with instances, Backup Disks, instances, apps), so it is safe on a real store. Removing an orphan loses no data: a disk that has a `META.yaml` gets its entry back with the same id on its next dock.
    -   The rule is unit-tested in `test/automated/meta-first-dock.test.ts`.

---

### `test-run.sh` (`script/test-run.sh`)

-   **Purpose:** Runs an Engine test suite fully isolated from any live Engine on the same machine (idea#105). All `pnpm test:*` scripts call it.
-   **Usage:** `script/test-run.sh <suite> <test-subdir>` (e.g. `script/test-run.sh full automated`). Normally run via `pnpm test:full`, `pnpm test:unit`, `pnpm test:diagnostic` or `pnpm test:cross-engine`.
-   **Details:**
    -   Sets `IDEA_SYSTEM_DISK_SKIP=true` so the test watcher never registers the system disk.
    -   Runs `test-preflight.sh` first (skipped for `cross-engine`, which drives live fleet Engines by design).
    -   Compiles into `dist-test/` (`tsc --outDir dist-test`), never `dist/`.
    -   Creates a private temp folder per run and exports `IDEA_WATCH_DIR` (replaces `/dev/engine`) and `IDEA_DISKS_ROOT` (replaces `/disks`); removes it on exit.
    -   Sets `IDEA_TEST_MODE=true` (not for `cross-engine`) and writes the log to `test/testresults/test-<suite>-<UTC timestamp>.log`.

---

### `test-preflight.sh` (`script/test-preflight.sh`)

-   **Purpose:** Refuses to run tests on a machine with a live Engine (idea#105).
-   **Usage:** `pnpm test:preflight` or `bash script/test-preflight.sh`. Exit code 0 = safe, 1 = live Engine detected.
-   **Details:** Refuses when any of these is true: pm2 process `engine` is online (or a `node …/dist/src/index.js` process runs); running Docker containers without the `org.idea.test=true` label; `/instances/*` exist; App Disks are present (`/disks/<name>/META.yaml` or `/disks/<name>/apps`, or `sd*` sentinels in `/dev/engine`). The App Disk check skips the machine's own root disk and all its partitions: the root device comes from `findmnt -n -o SOURCE /`, its parent disk from `lsblk -no PKNAME` (falling back to name parsing for `sdX`, `mmcblkN` and `nvmeNnM`). When the root is not a `/dev` device (e.g. `overlay` in a container), nothing is excluded. The helpers live in `script/test-preflight-lib.sh` and are unit-tested in `test/automated/test-isolation.test.ts`. Override at your own risk with `IDEA_TEST_ALLOW_LIVE=1`.

---

### `hw-roundtrip.ts` (`script/hw-roundtrip.ts`)

-   **Purpose:** On-Pi hardware round-trip test for disk changes (idea#152). Every PR that touches docking, undocking, eject, mounting or disk records must pass it on a claimed pool Pi before hand-off (see AGENTS.md).
-   **Usage (on the Pi, Engine running):** `pnpm test:hw [--engine-dir <checkout>] [--port 4321] [--engine-log <file>] [--device sdX] [--cycles 2] [--method unbind|authorized] [--timeout 60]`. Run it from any checkout with `node_modules`. `--engine-dir` is the checkout the running Engine uses (its `store-identity/`; default: this checkout). `--engine-log` is that Engine's stdout (default `~/.pm2/logs/engine-out.log`).
-   **What it checks:**
    1.  **System disk:** every store record on the drive holding `/` and `/boot/firmware` carries `diskTypes: ['system']`, so it fails the Console eject rule the test assumes: Console #124's `device !== null && !diskTypes.includes('backup')` plus `!diskTypes.includes('system')`. It also notes when the unchanged #124 rule would still show eject. `ejectDisk` on the system disk, first by name and then by id, must end with trace status `error` ("system disk"), `/` and `/boot/firmware` must stay mounted, and the record must stay docked. This runs before and after the round trip.
    2.  **Round trip,** for each cycle and for every partition of the USB test disk: `ejectDisk <diskId>` goes through the store command queue (`engineDB[<engine>].commands`, the path the Console uses). Then:
        -   After the eject: the trace is `ok`; the record is undocked (device null) with no `unmountError`; nothing is mounted by source or target; `/disks/<dev>` is gone.
        -   A simulated unplug and re-plug of the disk's USB device, both checked for udev `remove`/`add` block events and the Engine's `Processing the removal of USB device <dev>` / `A disk on device /dev/engine/<dev> has been added` log lines.
        -   After the re-plug: every partition is docked again exactly once, with the same disk id and the same `META.yaml` id, and has one mount by source and one by target. Partitions are matched by filesystem UUID, in case the device name changes.
-   **Unplug simulation:** `unbind` (default) writes the USB device id (e.g. `4-1`, resolved from `/sys/block/<dev>`) to `/sys/bus/usb/drivers/usb/unbind` and then to `.../bind`. `authorized` writes 0 and then 1 to `/sys/bus/usb/devices/<id>/authorized`. On idea03 both give the same kernel block sequence, udev events and Engine log lines as a real re-plug. The only difference is that the kernel logs no "USB disconnect" or new-device enumeration.
-   **Safety:**
    -   The sysfs writes are the only root actions. They run as `sudo -n tee <file>` with the tester's own sudo, not the Engine sudoers.
    -   The script refuses to run on idea02 (golden). It refuses a disk on the system drive, a non-USB disk, and a USB device that is, or sits above, the system drive's USB device.
    -   After an error, it always re-plugs the disk.
-   **Result:** exit code 0 only if every check passes. The log goes to `test/testresults/hw-roundtrip-<UTC yyyy-mm-dd-hhmmss>.log`.
