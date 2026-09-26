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
    1.  **Remote Mode** (`--machine` given): First syncs the code to the Pi with `sync-engine` (asks for a GitHub token if `script/build_image_assets/gh_token.txt` is missing), then configures the Pi over SSH.
    2.  **Local Mode** (no `--machine`): Configures the machine it is running on (used by `install.sh`).
    3.  **Personalize Mode** (`--personalize`): Only sets the hostname and rewrites `/META.yaml` (disk id from the disk serial via `hdparm`, or a new random id if there is none; hostname; version; timestamps). It does not build the Engine and asks no questions. `script/build_image_assets/boot.sh` runs it on the first boot of a freshly flashed master image (when `/boot/MASTER` exists).
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
    -   `--upgrade`, `--argon`, `--zerotier`, `--raspap`, `--gadget`, `--temperature`: Turn on optional parts of the build.
    -   `--prod`: Build in production mode.
    -   `--personalize`: Personalize Mode (see above).
-   **Details:** A full build handles everything from setting the hostname and installing Docker to deploying the Engine software itself.

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
-   **Details:** This script uses `rsync` to efficiently copy only the changed files, making it ideal for rapid development and testing cycles.

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
