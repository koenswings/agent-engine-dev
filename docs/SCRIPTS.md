# Provisioning Scripts Reference

This document provides a reference for the main provisioning and utility scripts used in the Engine project.

---

### `install.sh`

-   **Purpose:** Thin wrapper around `build-engine` (idea#322: one install path).
-   **Usage:** as pi, in a checkout of an `engine-vYYYY.MM.DD[-N]` tag: `bash script/install.sh [build-engine options]`
-   **Details:** Runs `pnpm install --frozen-lockfile` if build-engine's own dependencies are missing, then `exec ./build-engine "$@"` (local mode). It installs nothing else; all provisioning is in build-engine. `script/setup-dev.sh` calls it.

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
    -   `--hostname <name>`: The hostname to set. Default (idea#184): a generated two-word **sticker name** such as `brave-otter` (no digits), checked against the LAN (`avahi-resolve-host-name <name>.local`) and against the `engineDB` hostnames of the network database (read from an Engine found via mDNS or given with `--peer <host[,host]>`; when no store is reachable it says so and checks the LAN only). When `tailscale` is installed and online it is also checked against the tailnet's names (read-only `tailscale status --json`; no central registry). The words come from `src/utils/stickerWords.ts` (>= 100,000 combinations). The name is persisted in `/etc/idea/sticker-name`, so re-running the build or `--personalize` keeps it (`boot.sh` deletes it on a master-image clone's first boot so each clone gets its own). At the end the name and Console URL are printed for the sticker and saved in `/home/pi/STICKER.txt`. An explicit `--hostname` is used as given (existing idea01-04 keep their names). `provision-fleet.sh` takes `auto=<ip>` to use a generated name (each `auto` node logs to `/tmp/provision-auto-<ip>.log`). All schools use the same subnet; names, not addresses, tell Pis apart.
    -   `-l, --language <locale>`, `-k, --keyboard <layout>`, `-t, --timezone <tz>`: Localisation settings.
    -   `--upgrade`, `--argon`, `--zerotier`, `--raspap`, `--gadget`, `--temperature`: Optional parts of the build. Every one of these can be turned off with `--no-<option>` or `--<option>=false` (idea#146), which is required for argon/gadget on spare and Pi 5 profiles.
    -   `--model pi4|pi5`: Selects the Pi model. On pi5, gadget mode is forced off and an explicit `--gadget` is refused.
    -   `--prod`: Build in production mode.
    -   `--personalize`: Personalize Mode (see above).
-   **Details:** A full build handles everything from setting the hostname and installing Docker to deploying the Engine software itself. It also installs the Engine's two sudoers files (`installEngineSudoers`, each validated with `visudo` first, mode 0440, owner root:root): `/etc/sudoers.d/10-engine` from `script/build_image_assets/10-engine.sudoers`, the exact commands the Engine, running as `pi`, may run as root; and `/etc/sudoers.d/11-engine-files` from `script/build_image_assets/11-engine-files.sudoers`, the files and folders it may write, remove or re-own as root under `/disks` (`/usr/bin/tee /disks/sd[a-z][12]/META.yaml`, idea#121; `/usr/bin/rmdir /disks/sd[a-z][12]`, idea#126; the disk root owner for `createFilesDisk`: `/usr/bin/chown -h / idea-erase-disk / mount -t ext4 pi\:pi /disks/sd[a-z][12]`, idea#131). It also installs `rsync` and `borgbackup` and the root helpers as root-owned 0755 copies: `/usr/local/sbin/idea-erase-disk` (idea#134) and `/usr/local/sbin/idea-app-data` (instance data as root, idea#168; `11-engine-files` has its line `pi ALL=(root) NOPASSWD: /usr/local/sbin/idea-app-data`). An updated `11-engine-files` (or helper) must be installed before an Engine that needs it is deployed; the Engine refuses to start when `idea-app-data` is missing or the wrong version; `sudo -ll -U pi <exact command>` shows which sudoers file allows a command. pm2 and `pm2-logrotate` are installed into pi's pm2. The Engine is started and saved with pi's pm2 (`pm2 start`, `pm2 save`, no sudo); boot start-up is enabled with `sudo env PATH=$PATH:<node bin> <pm2> startup systemd -u pi --hp /home/pi`, which needs root to write the systemd unit but runs pm2 as pi (idea#273). `TAILSCALE_AUTHKEY` is used only by `installTailscale`: it is removed from build-engine's environment right after it is read, and the pm2 calls run under `env -u TAILSCALE_AUTHKEY`, so the key is never in pm2's environment or `~/.pm2/dump.pm2` (idea#273).

-   **Reproducibility (idea#322):** refuses to build unless the local checkout is a clean, tagged commit on `origin/main` (`--allow-untagged` overrides and is recorded). Installs the Engine with `pnpm install --frozen-lockfile` and pinned n/pnpm/pm2/pm2-logrotate/Node. After a full build it pins Debian apt to `DEBIAN_SNAPSHOT`, Docker Engine to `docker-pins.tsv` (sha-checked debs via `install-docker-pinned.sh`, cache first), Raspberry Pi packages to `apt-rpi-pins.tsv` and Tailscale to version + sha256. Accepts only `engine-vYYYY.MM.DD[-N]` tags. After a full build it writes a deployment record to `<idea checkout>/deployments/engines/<hostname>/<label>/` (`--idea-repo`, default `$IDEA_REPO_DIR`; `--batch`; skip with `--no-record`); commit it in the idea repo. See [REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md).

---

### `capture-engine-record.sh`, `engine-record.ts`, `archive-engine-inputs.sh` (idea#322)

-   `bash script/capture-engine-record.sh [--engine-dir D] [--console-dir D] [--out /tmp/D]`: read-only capture of an install (no sudo, no installs, no restarts; writes only its own `/tmp` folder). Writes `record.txt`, `packages.tsv`, `images.tsv`, `files.sha256`, `dist.sha256` and `helpers.sha256` (every `/usr/local/sbin/idea-*`); finds `tailscale` in `/usr/sbin` or `/usr/bin` when it is not on PATH.
-   `npx tsx script/engine-record.ts compare <expected> <actual>` (exit 1 on any content difference) and `check-secrets <dir>`.
-   `script/archive-engine-inputs.sh <commit> <out> [image...]`: archive the source, pnpm store (linux/arm64), Node tarball, global npm tools and arm64 Docker images of one commit, with `SHA256SUMS`.

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
-   **Details:** This script uses `rsync` to efficiently copy only the changed files, making it ideal for rapid development and testing cycles. It never copies a `gh_token.txt` (`--exclude='gh_token.txt'`, idea#116), so an old local token file cannot reach a Pi. It connects as `pi`, builds with a plain `pnpm build` and stops/starts the Engine with pi's pm2 (never `sudo pm2`, which would target root's process list). After the build it runs `./install-root-helpers` (`installRootHelpers`), which also applies the DHCP vendor class: it installs `script/build_image_assets/idea-dhcp-vendor-class` to `/usr/local/sbin/idea-dhcp-vendor-class`, runs it (idempotent; writes `/etc/NetworkManager/conf.d/90-idea-dhcp-vendor-class.conf` and/or a `vendorclassid idea-engine` line in `/etc/dhcpcd.conf`, with a `.idea-bak-<UTC>` backup on change) and only reloads NetworkManager's config (`nmcli general reload conf`; no restart, no link change). So an Engine built before the vendor class existed gets it from a normal update (idea#284); build-engine reaches the same step through `installUdev`. A failure there is logged and does not abort the update; the fleet health check (`tools/fleet/check-fleet-health.sh` in the idea repo) reports a missing drop-in.

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
-   **Details:** Refuses when any of these is true: pm2 process `engine` is online (or a `node …/dist/src/index.js` process runs); running Docker containers without the `org.idea.test=true` label; `/instances/*` exist; App Disks are present (`/disks/<name>/META.yaml` or `/disks/<name>/apps`, or `/dev/engine/sd*` links that resolve to a present block device mounted, itself or a partition, under `/disks`; stale links of an ejected, unmounted disk are not counted, agent-engine-dev#223). The App Disk check skips the machine's own root disk and all its partitions: the root device comes from `findmnt -n -o SOURCE /`, its parent disk from `lsblk -no PKNAME` (falling back to name parsing for `sdX`, `mmcblkN` and `nvmeNnM`). When the root is not a `/dev` device (e.g. `overlay` in a container), nothing is excluded. The helpers live in `script/test-preflight-lib.sh` and are unit-tested in `test/automated/test-isolation.test.ts`. Override at your own risk with `IDEA_TEST_ALLOW_LIVE=1`. On refusal it names where Engine tests may run (the Grok Bot box, or a claimed idle pool Pi after `pm2 stop engine`; idea#335, AGENTS.md "Where Engine tests run"). Tests bind only ephemeral ports, never the live Engine's 80 / 4321 / 8080 (guarded by `test/automated/tests-beside-live-engine.test.ts`).

---

### Root helpers `idea-flash-card` (v3) and `idea-write-card-timezone` (`script/build_image_assets/`, idea#208)

Installed by build-engine (`installRootHelpers`) as root-owned 0755 copies in `/usr/local/sbin`. `idea-flash-card` is the only one in sudoers (`11-engine-files`, unchanged). v3 adds `--timezone <Area/City>`: re-validated as root (tz regex, no `..`, file under `/usr/share/zoneinfo`; else `refused: BAD_ARGS`), then after the verified write and before power-off it calls `idea-write-card-timezone <byId> /dev/sdX <sizeBytes> <zone>`, which writes `idea-timezone.txt` = `<zone>\n` on FAT partition 1 (same identity checks as `idea-write-home-engine`). A failed timezone write leaves the flash `ok` with `"timezoneFile":"failed"`. Tests: `test/automated/client-timezone.test.ts`. Any Pi that flashes cards needs both helpers redeployed (`installRootHelpers`).

v4 adds `--home <engine-name>` (checked against the same rule as `idea-write-home-engine`, else `refused: BAD_ARGS`). After the verified write it calls `idea-write-home-engine <byId> /dev/sdX <sizeBytes> <name>`, which writes `idea-home.txt` = `<name>.local\n`. A failed write gives `warning: HOME_FAILED` and `"homeFile":"failed"`, and the flash stays `ok`. Tests: `test/automated/card-home-engine.test.ts` and `client-cards.test.ts`.

### `hw-home-engine-card.sh` (`script/hw-home-engine-card.sh`)

On-Pi hardware test for `idea-write-home-engine` (#213, idea#203 §2). Run on a pool Pi (never golden idea02), against a client card that was just flashed and verified, sitting in a card reader:

    bash script/hw-home-engine-card.sh --card /dev/disk/by-id/<whole-card-link> [--name <engine-name>] [--dry-run]

-   Refuses to start (exit 2) if the card holds `/` or `/boot(/firmware)`, any partition is mounted, partition 1 is not vfat, or the link is a `-partN` link.
-   Checks the helper's refusals (BAD_ARGS, MEDIUM_SWAPPED, MOUNTED, the system disk), each leaving the card unchanged and unmounted. Then it checks the write: `idea-home.txt` = `<name>.local\n` in the root of partition 1, no temp file left, other files and partitions unchanged. Finally it checks the system disk: same lsblk facts and boot file checksums, and no `idea-home.txt` on it.
-   `--dry-run` is read-only and runs no sudo. It is unit-tested in `test/automated/hw-home-engine-card.test.ts`. The evidence goes to `/tmp/hw-home-engine-<timestamp>/`, or to `--evidence <dir>`. Exit 0 means PASS.

### `hw-roundtrip.ts` (`script/hw-roundtrip.ts`)

-   **Purpose:** On-Pi hardware round-trip test for disk changes (idea#152). Every PR that touches docking, undocking, eject, mounting or disk records must pass it on a claimed pool Pi before hand-off (see AGENTS.md).
-   **Usage (on the Pi, Engine running):** `pnpm test:hw [--engine-dir <checkout>] [--port 4321] [--engine-log <file>] [--stick-config <file>] [--stick-usb-serial <s>] [--disk-serial <s>] [--uuid <u>]… [--refuse-serial <s>]… [--cycles 2] [--method unbind|authorized] [--timeout 60]`. Run it from any checkout with `node_modules`. `--engine-dir` is the checkout the running Engine uses (its `store-identity/`; default: this checkout). `--engine-log` is that Engine's stdout (default `~/.pm2/logs/engine-out.log`).
-   **What it checks:**
    1.  **System disk:** every store record on the drive holding `/` and `/boot/firmware` carries `diskTypes: ['system']`, so it fails the Console eject rule the test assumes: Console #124's `device !== null && !diskTypes.includes('backup')` plus `!diskTypes.includes('system')`. It also notes when the unchanged #124 rule would still show eject. `ejectDisk` on the system disk, first by name and then by id, must end with trace status `error` ("system disk"), `/` and `/boot/firmware` must stay mounted, and the record must stay docked. This runs before and after the round trip.
    2.  **Round trip,** for each cycle and for every partition of the USB test disk: `ejectDisk <diskId>` goes through the store command queue (`engineDB[<engine>].commands`, the path the Console uses). Then:
        -   After the eject: the trace is `ok`; the record is undocked (device null) with no `unmountError`; nothing is mounted by source or target; `/disks/<dev>` is gone.
        -   A simulated unplug and re-plug of the disk's USB device, both checked for udev `remove`/`add` block events and the Engine's `Processing the removal of USB device <dev>` / `A disk on device /dev/engine/<dev> has been added` log lines.
        -   After the re-plug: every partition is docked again exactly once, with the same disk id and the same `META.yaml` id, and has one mount by source and one by target. Partitions are matched by filesystem UUID, in case the device name changes.
-   **Unplug simulation:** `unbind` (default) writes the USB device id (e.g. `4-1`, resolved from `/sys/block/<dev>`) to `/sys/bus/usb/drivers/usb/unbind` and then to `.../bind`. `authorized` writes 0 and then 1 to `/sys/bus/usb/devices/<id>/authorized`. On idea03 both give the same kernel block sequence, udev events and Engine log lines as a real re-plug. The only difference is that the kernel logs no "USB disconnect" or new-device enumeration.
-   **Safety:**
    -   The sysfs writes are the only root actions. They run as `sudo -n tee <file>` with the tester's own sudo, not the Engine sudoers.
    -   The script refuses to run on idea02 (golden).
    -   **It only touches the recorded test disk, matched by IDs, never by a device name like `sdb`** (`script/hw-roundtrip-guard.ts`). The expected IDs come from `script/hw-roundtrip-disks.json`, keyed by hostname, and it matches on the **disk serial only**. USB enclosures get swapped and idea#139 dd rewrites change the filesystem UUIDs, so the entry keeps the current USB bridge serial and UUIDs under `informational`, and the script never reads them. idea03's entry follows idea fleet-state @a74d6e4 and docs §4.6 @e0ee92b (idea#393): disk serial `3813430-532011020` (bridge currently `26A1EE830E37`, one ext4 partition `b3e90dc7-…`), refused serials `AA202000000000004820` (idea03 root SSD) and `AA000000000000005638` (protected Intenso fixture). That disk is the idea#139 dd disk holding Disk B. hw-roundtrip never erases or formats it, but it ejects it and unbinds its USB device, so don't run it on idea03 while #139 is running. `--disk-serial` replaces the disk serial; `--stick-usb-serial` and `--uuid` (repeatable) add the optional USB-serial and exact-partition checks; `--refuse-serial` (repeatable) adds to the refused serials.
    -   The IDs are checked before anything is ejected and again before every unplug. From the partitions whose UUIDs match (all on one disk, no other partitions), the script resolves the disk and its USB device (bus-port from `/sys/block/<disk>`). The disk serial (`lsblk SERIAL`, the udev `ID_SERIAL_SHORT`) and the USB serial (sysfs `serial`, the udev `ID_USB_SERIAL_SHORT`) must match.
    -   Any missing or mismatched ID aborts the run with the reason (`ABORT test disk check (start) failed: …`) before the store is touched.
    -   A refused serial, the drive backing `/` or `/boot/firmware`, a non-USB disk, or a USB device that is or sits above the system drive's is refused outright.
    -   After an error, it always re-plugs the disk.
-   **Result:** exit code 0 only if every check passes. The log goes to `test/testresults/hw-roundtrip-<UTC yyyy-mm-dd-hhmmss>.log`.

---

### `script/archive-debs.py` and `script/release-archive.sh` (idea#322)

-   **archive-debs.py:** `--out DIR [--packages packages.tsv] [--rpi-current NAMES] [--snapshot ID]` downloads and verifies `.deb`s (Debian from snapshot.debian.org, Raspberry Pi from archive.raspberrypi.com) plus the indices used; writes `index.tsv`, `missing.tsv`, `SHA256SUMS`. Called by `archive-engine-inputs.sh`.
-   **release-archive.sh:** `<name> <commit> <archive-dir> <release-dir> [--tag T] [--prerelease]` packs an archive into <2 GB parts with `SHA256SUMS`, `RELEASE-NOTES.md` `gh-commands.sh` (release + upload on an existing tag; creates no tag) and `record-keys.txt` (`packageArchive*`). It never runs those commands; they need Koen's go.

### `idea-app-data` v5: updateApp snapshots (#230)

`snapshot <root> <id>` copies `instances/<id>` to `<root>/.pre-update/<id>/data` as root (rsync -aHAX) under the instance lock. It refuses while a container of compose project `<id>` exists (`docker ps`) and refuses with `NO_SPACE: snapshot needs X bytes (... KB folder + ... KB volumes + ... KB margin), free Y bytes` (exit 3) before writing anything when the free space of `<root>` is below the instance folder plus its named volumes plus 10 % (at least 1 GiB). Named volumes (`docker volume ls` label `com.docker.compose.project=<id>`, local driver only, mountpoint must be `/var/lib/docker/volumes/<v>/_data`) are exported with the host's `tar --numeric-owner --xattrs --acls` into `volumes/<v>.tar`, listed and checksummed (`volumes/SHA256SUMS`) before `COMPLETE`; one `VOLUME <name> <bytes> <ms>` line each. Since v9 (idea#448) it takes optional trailing `[exclude…]` tokens with the same rules as `borg-create` (instance-relative, no `..`, no globs, must stay inside `instances/<id>`; one bad token refuses before anything is locked, moved or written, so no snapshot is taken). Each one becomes an anchored `rsync --exclude=/<path>`, is listed in `JOURNAL` (`exclude <path>`) and in an `EXCLUDE` file (one path per line, empty when none) written just before `COMPLETE`. It writes `JOURNAL` first and `COMPLETE` last (by rename). An existing snapshot (complete or interrupted) is renamed into `.idea-quarantine/pre-update-<id>[-incomplete]-<stamp>` first. Prints `<dir> <kb> <quarantined old path|none>` as the last line.
`restore-snapshot <root> <id> [exclude…]` refuses a snapshot without `COMPLETE`. Since v9 (idea#448) it restores **in place**: `instances/<id>` is never moved or renamed. The excludes are the snapshot's `EXCLUDE` file plus any trailing tokens (union, same checks; a bad one refuses before anything is written). The snapshot is rsynced back with `--delete` and `--exclude` for each, so excluded live paths (e.g. `data/tailscale`) are never written, deleted or moved and keep their inodes, even when an older snapshot still holds them. Every live non-excluded file that is replaced or deleted is put first into `.idea-quarantine/<id>-before-restore-<stamp>/` (rsync `--backup-dir`, same filesystem, nothing removed). If `instances/<id>` is missing it is created and filled; each volume archive is re-checked against `SHA256SUMS`, the volume's current contents are renamed to `_data.idea-quarantine-<stamp>` and the archive is extracted (`VOLUME <name> <aside>` lines); the last line is the `<id>-before-restore-<stamp>` path (or `none` when the folder was missing). `estimate <root> <id>` is read-only (no lock, nothing stopped or written) and prints `<folder kb> <volumes kb> <free kb>`; updateApp uses it so NO_SPACE refuses before the stop. Export and restore refuse `IN_USE: volume <v> is mounted by a running container` when `docker ps -q --filter volume=<v>` (any project) is not empty. A volume that no longer exists is recreated on restore with `docker volume create --driver local` and the compose project/volume labels; the current `_data` is always moved aside beside itself (same filesystem). All these subcommands are covered by the existing sudoers entry (`pi ALL=(root) NOPASSWD: /usr/local/sbin/idea-app-data`, no argument list). `snapshots <root>` prints `<id> <kb> complete|incomplete` per snapshot, then `TOTAL pre-update <kb>` and `TOTAL quarantine <kb>`. No subcommand removes anything. Tests: `test/automated/idea-app-data-script.test.ts`.

### `idea-app-data` v7: usage-export key drop-in (idea#412)

`install-usage-key <ipv4> ssh-ed25519 <base64>` writes root-owned `/etc/ssh/idea_usage_keys/pi` with `restrict,from="<ipv4>",command="/usr/local/sbin/idea-usage-export"` (the helper constructs those options; it never accepts them from the caller). `<ipv4>` must be a Tailscale address in 100.64.0.0/10. The verb appends `/etc/ssh/idea_usage_keys/%u` to the existing first `AuthorizedKeysFile` line in `/etc/ssh/sshd_config.d/10-idea-peer.conf` without dropping `.ssh/authorized_keys`, `.ssh/authorized_keys2` or `/etc/ssh/idea_authorized_keys/%u`, checks `sshd -t` (and rolls the drop-in and key file back if that fails), reloads sshd only when the drop-in changed, and installs `/usr/local/sbin/idea-usage-export` (root:root 0755). `sync-peers` does not touch `idea_usage_keys`. `installPeerAccess` (run by `./install-root-helpers` and build-engine) installs the export binary, creates `/etc/ssh/idea_usage_keys`, and copies the updated drop-in the same way as `idea-peer-gate`. Sudoers is unchanged.

The file installed at `/usr/local/sbin/idea-usage-export` is `script/build_image_assets/idea-usage-export` (standalone Python, root:root 0755) — not `src/usage/exportMain.ts`. The TypeScript `src/usage/exportCmd.ts` stays in the idea-usage process for tests and the same wire format (`test/fixtures/usage-export-parity/`). The forced command reads `$SSH_ORIGINAL_COMMAND` or argv and accepts `since YYYY-MM-DD` and `archive-and-clear --before YYYY-MM-DD` (the contract's space form; `--before=YYYY-MM-DD` is also accepted), against `/var/lib/idea/usage` (see `docs/USAGE-CONTRACT.md` §7). When `usageMonitoring` is off, both verbs exit 10 with empty stdout and stderr `disabled`.

**Pool install order** (Atlas, [idea#412](https://github.com/koenswings/idea/issues/412#issuecomment-6779183579)): one spare at a time (idea03 or idea04); never idea02, idea, or a kit; golden idea01 last and only from merged main. Install the helper, `idea-usage-export` and the four-path drop-in *before* the Engine (`./install-root-helpers`). Confirm `sudo -n /usr/local/sbin/idea-app-data version` prints `idea-app-data 7`, then deploy and restart the Engine as `pi` (`pm2`, never root). Atlas already proved `restrict,from=,command=` with a stub on idea03.

**Pool rollback:** quarantine the new `idea-app-data`, `idea-usage-export`, `/etc/ssh/idea_usage_keys/pi` and the edited `10-idea-peer.conf` with a `.quarantine-<utc-ts>` suffix (never `rm -rf`). Copy the pre-change drop-in back (the three-path `AuthorizedKeysFile` line). Restore helper v5. `visudo -c`. `sudo sshd -t` and reload ssh if the drop-in changed. Restart the Engine as `pi` (`pm2 restart engine` / `pm2 save`). idea01 rolls back the same way, only after a spare already did.

Tests: `test/automated/idea-app-data-usage-key.test.ts`, `test/automated/idea-usage-export.test.ts`, `test/automated/install-peer-access.test.ts`.

### `idea-app-data` v10: `borg-list` inventory selects every archive (idea#450)

v9's 2-argument `borg-list <bdev> <id>` ran `borg info --json -- <repo>`. With no archive selector, borg 1.x (idea03 runs 1.4.0) prints repository info only: `cache`, `encryption`, `repository`, `security_dir`, and no `archives` key. So backup cleanup (idea#401) and listBackup/verifyBackup (idea#446) could never read an archive. v10 runs `borg info --json --glob-archives '*' -- <repo>`, which keeps the same JSON shape with `archives[]` and per-archive `stats`. `borg list --json` was not used because it has no sizes. No other verb changed and there is no new sudoers line; `install-root-helpers` replaces the binary and checks `idea-app-data version`. The Engine requires v10 for cleanup (`BACKUP_CLEANUP_HELPER_MIN`), so a v9 helper gets `HELPER_OUTDATED` instead of a silent empty inventory. updateApp (`UPDATE_HELPER_MIN`) is unchanged: it never calls `borg-list`. The test fake borg now behaves like real borg (no `archives` without a selector), and `test/automated/borg-list-real.test.ts` runs the real binary (`IDEA_TEST_BORG`, else `/usr/bin/borg`; skipped when neither exists). Rollout: install the helper before or together with the Engine; a v10 helper with an older Engine only logs the version mismatch warning at startup.

### `idea-app-data` v8: `borg-create` excludes (idea#443)

`borg-create <bdev> <id> <archive> <srcRoot> [exclude…]` accepts optional instance-relative exclude paths after the four existing arguments. A 4-argument call is unchanged. Each path is validated (no absolute path, no `..`, no glob, no leading `-`); a bare name other than `data` is treated as `data/<name>`. The helper writes a root-only temp pattern file of `- pp:$SRC/<rel>` lines and runs `borg create --numeric-ids --patterns-from <file> -- repo::archive $SRC`, then removes the file. A symlink whose target leaves the instance folder is refused. The Engine reads `x-app.backup.exclude` from the instance compose and, when the list is non-empty, requires helper v8 (`HELPER_OUTDATED` otherwise) so an old helper cannot silently pack secrets. `install-root-helpers` already replaces the helper and checks `idea-app-data version`; no new sudoers line. Tests: `test/automated/backup-exclude.test.ts`, `test/automated/idea-app-data-script.test.ts`, `test/automated/app-data-helper.test.ts`.

### `idea-app-data` v9: borg-list / borg-delete / borg-compact (idea#401) and verify/quarantine verbs (idea#446)

`borg-list <bdev> <id>` is read-only and prints `borg info --json --glob-archives '*'` for that instance repo (no `--last`), so the Engine can see every archive's name, time and sizes (v10, idea#450: v9 ran plain `borg info --json`, which on borg 1.x prints repository info only). `borg-list <bdev> <id> <archive>` (idea#446) lists the members of that one archive (`borg list --short`, paths only); the 2-argument inventory form is unchanged. `borg-extract-verify <bdev> <id> <archive> <stamp>` extracts into `<backup disk>/.idea-verify/<id>-<stamp>/` (created root-owned 0700). It never writes under `instances/<id>`, never replaces an existing target (refuses if that folder already exists), and never deletes a partial tree if extract fails. `id`, `archive` and `stamp` are validated like the other tokens (`stamp` is `^[0-9]{8}T[0-9]{6,15}Z$`, no `/` or `..`). `quarantine-backups <bdev>` moves `<disk>/backups/` to `<disk>/.idea-quarantine/backups-<UTC stamp>/` (mv only, never rm). It refuses if any `.backup-in-progress` exists under `backups/`, and refuses the system disk. `borg-delete <bdev> <id> <archive> [keepMin]` deletes exactly the named archive. The Engine chooses which one; the helper enforces the retention floor and refuses (exit 2) if the archive is among the newest `keepMin` (default **3**), if deleting it would leave fewer than `keepMin` archives, or if it is the instance's only archive. A 3-argument call uses `keepMin` 3. `borg-compact <bdev> <id>` runs `borg compact` so the disk actually gets the space back. There is no `borg prune` policy verb: with the Engine choosing archives, `borg-delete` is the destructive command. Tokens match today's helper (`bdev` is never `system` and the disk must hold `BACKUP.yaml`; `archive` matches `backupInstance`'s ISO stamp). No new sudoers line; `install-root-helpers` already replaces the binary and checks `idea-app-data version`.

The Engine (`src/utils/backupCleanup.ts`, called from `backupInstance`) runs cleanup after each successful backup and before a backup if space looks tight: if free space is below 15 %, it deletes oldest eligible archives until free space is above 25 %, then compact. It always keeps the newest 3 good backups per instance and never deletes an instance's only backup. Several instances on one disk are processed round-robin, oldest first. Cleanup uses fullness and backup count only, never age. Before a backup it estimates the next archive from the last archive's compressed size; if that still does not fit after cleanup it refuses with `BACKUP_DISK_FULL` ("Backup Disk full: add a bigger disk") before any hook or stop. `helperAtLeast(10, 'backup cleanup')` (v10 since idea#450) runs before any list/delete/compact; an older helper yields `HELPER_OUTDATED`, cleanup is skipped, and the backup itself still runs. Atlas owns the pool rollout (helper before the new Engine, one Pi at a time). The idea#446 verbs and the idea#448 `snapshot` excludes / in-place `restore-snapshot` stay on this same v9 (no v10, no new sudoers line). Engine commands for list/verify/clear/remove ship in a later PR after this helper is on main. Tests: `test/automated/backup-cleanup.test.ts`, `test/automated/idea-app-data-script.test.ts`, `test/automated/app-data-helper.test.ts`.

### `idea-usage-settings`: operator toggle for `usageMonitoring` (idea#411)

Installed by `installRootHelpers` as a root-owned 0755 copy at `/usr/local/sbin/idea-usage-settings`. It is not in sudoers (`11-engine-files` is unchanged): the Engine never calls it. Operators and `tools/fleet/usage-monitoring.sh` (idea repo) run it as `pi`. `/var/lib/idea/usage` is `pi:pi` 0750, so `pi` can write `settings.json`.

Accepts only `on`, `off` and `status`, via argv or `$SSH_ORIGINAL_COMMAND`. A missing file is `off`. `on`/`off` are idempotent (exit 0; no rewrite when the file already has that value; `off` when the file is absent creates nothing). Writes `{"usageMonitoring":"on"|"off"}` atomically (mode 0640; `pi:pi` when invoked as root). Exit 2 and stderr `invalid arguments` for anything else, including shell metacharacters. It never starts, stops or restarts pm2, docker or any App; the running `idea-usage` process re-reads the file at least once a minute. It is not `idea-usage-export` (the collector forced command still accepts only `since` and `archive-and-clear`). Tests: `test/automated/idea-usage-settings.test.ts`.


