# IDEA Pi Fleet — Test Infrastructure

## Overview

The IDEA test fleet is four Raspberry Pi nodes used for hardware-backed Engine tests and PR review (real USB dock/undock, helpers, sudoers). **Atlas (Ops)** owns deploy and the live inventory in `fleet-state.json` in [koenswings/idea](https://github.com/koenswings/idea). **Axle (Engine Dev)** may claim a *pool* Pi for a proof, then release it. This document describes standing roles and how to reach and provision the nodes; it does not replace `fleet-state.json`.

Production `idea` (wizardly-hugle) and the Zimbabwe kit Engines (kind-panda, sunny-robin, happy-zebra) are **not** fleet test nodes. Never deploy a proof there, and never connect those kits to each other or to the pool for a test.

## Fleet nodes (standing roles)

| Node | Model | Storage | Standing role |
|------|-------|---------|----------------|
| idea01 | Raspberry Pi 5 | 240 GB SSD | **Golden.** Always runs merged `main`. Never used for PR proofs or reviews. |
| idea02 | Raspberry Pi 4 | (see fleet-state) | **LAN client and test-walk host** (`role: fleet-pending`). Never claimed and never deployed to. |
| idea03 | Raspberry Pi 5 | 240 GB SSD | **Test / review pool** (`role: spare`). Claim before use; restore `main`, restart pm2 as `pi`, and set `status: idle` when done. |
| idea04 | Raspberry Pi 4 | 240 GB SSD | **Test / review pool** (`role: spare`). Same claim/release rules as idea03. |

The shared test/review pool is **idea03 and idea04** only. One pool Pi down at a time. Leave each Pi's store, `config.yaml`, and existing `note` field alone unless the proof requires a documented, temporary change that you revert before release.

## Network

Addresses as recorded in idea `fleet-state.json` on `origin/main` at `b298083106b0c3446823eb8923b5b42b5b4987dd` (25 Nov 2026). If they disagree with the live file, the live file wins.

| Node | Tailscale IPv4 | LAN IPv4 | mDNS name |
|------|----------------|----------|-----------|
| idea01 | 100.99.231.94 | 192.168.0.138 | idea01.local |
| idea02 | 100.85.108.118 | 10.99.0.12 | (client LAN; do not assume idea02.local) |
| idea03 | 100.126.117.80 | 192.168.0.228 | idea03.local |
| idea04 | 100.108.39.45 | 192.168.0.113 | idea04.local |

idea01, idea03 and idea04 sit on the office LAN (`192.168.0.0/24`). idea02 is on a different LAN (`10.99.0.0/16`). mDNS names resolve via avahi on the LAN of that node. The Console HTTP port is `settings.httpPort`: **80** on a default install, often **8080** on the pool (`src/install/stickerName.ts` tries both).

## Access

SSH **directly** to the Tailscale IPv4 as `pi`, key-only, with **no jump host**. Do not use the fleet Tailscale auth key from the box, and do not run `tailscale up`, reauth, or restart `tailscaled` on the box; if Tailscale drops, ask Ops.

```bash
ssh pi@100.99.231.94          # idea01 (golden, read-only use)
ssh pi@100.126.117.80         # idea03
ssh pi@100.108.39.45          # idea04
./script/check-fleet.sh       # Status of fleet nodes the script knows
```

The provisioner no longer writes `~/.ssh/config`.

## Engine installation

Engine path on each node: `/home/pi/idea/agents/agent-engine-dev`  
Started via pm2 (`engine` and `idea-usage`), auto-starts on boot.

### Provisioning a node

Key-only SSH (idea#146). The Pi must already accept this machine's key and give `pi` passwordless sudo. The script never uses a password, never edits `/etc/hosts` on the runner, and never writes `~/.ssh/config`.

Standing access is direct Tailscale SSH (above). `provision-fleet.sh` still accepts `--jump` for an unusual network path; that is a script flag, not the normal way to reach the fleet, and it is not used from the box.

```bash
# Direct, key already on the Pi; fleet key from ~/.config/idea/fleet-authkey when that file exists
./script/provision-fleet.sh idea04=192.168.0.113,model=pi4

# Same, with an explicit key file (override)
./script/provision-fleet.sh --authkey-file /path/to/key idea04=192.168.0.113,model=pi4

# Optional: --jump <user@host> is a ProxyJump for the script only (not standing access).
# The `idea05=…` token in older examples is not a fleet node; do not treat it as one.
```

What it does per node:
1. Checks key-based SSH (`BatchMode`) and passwordless sudo
2. Bootstraps apt packages, Node 22.20.0 and the pinned pnpm from `package.json` (`packageManager`, currently 10.33.0), then clones `/home/pi/idea/agents/<repo>`
3. Stores the Tailscale fleet key over stdin from `--authkey-file` or, by default, `~/.config/idea/fleet-authkey` (idea#115). If the default file is absent and `--authkey-file` is not given, the Pi must already hold the key
4. Runs `build-engine` in **local mode on the Pi** with explicit `--no-argon` / `--no-gadget` (unless you pass `--argon` / `--gadget`; `--gadget` is refused on pi5)
5. Waits for the reboot and checks that pm2's `engine` is online and the Console HTTP port returns 200

Allow 15–20 minutes per node. The Pi reboots at the end.

**Fleet key file on the operator machine.** The operator fleet Tailscale key, when present, lives at `~/.config/idea/fleet-authkey` (mode `0600`). `provision-fleet.sh` uses this file by default; `--authkey-file <path>` overrides it. The file is preflighted (must exist, be mode `600`, owned by you, and non-empty) and sent over stdin into `/etc/tailscale/debug-authkey` on the Pi. A missing default file is not fatal by itself; a missing explicit `--authkey-file` is. Do not use this key from the box. Expiry, reuse and tag claims belong in the org Tailscale doc (see below); do not copy unverified console facts here.

The router enrol tool (`tools/router-image/idea-router-enrol` in koenswings/idea) reads `~/.config/idea-router/fleet-authkey`. On the ops box that path is a **hard link** to the same file (one inode, one copy) — not a symlink. Enrol's preflight runs `stat -c %a` without `-L`, which would see a symlink's mode `777` and refuse it.

To rotate the key, replace the file content in place so both names keep pointing at the same inode: write the new key to a temp file, then `cat tmp > ~/.config/idea/fleet-authkey` (or re-create the hard link after replacing the file). A plain `mv` onto one name would leave the other name on the old inode.

Off flags for a manual local `build-engine` run (same as the provisioner):

```bash
./build-engine --hostname idea01 --model pi5 --timezone Europe/Brussels --keyboard us \
  --temperature --no-argon --no-gadget --prod
```

### Syncing a code update

After provisioning, use `sync-engine` for code updates (no full reinstall needed). Only sync a Pi you have claimed, and never sync idea01 as a proof or idea02 at all:

```bash
./script/sync-engine idea03
```

### Checking fleet status

```bash
./script/check-fleet.sh
```

## Pi 4 vs Pi 5 Differences

| Feature | Pi 4 | Pi 5 |
|---------|------|------|
| USB gadget mode (LAN) | Supported | Not supported (PCIe USB) |
| Argon One fan script | Optional | Not applicable |
| Docker | Works | Works |
| Node.js 22 | Works | Works |
| BorgBackup | Works | Works |

The provisioner and `build-engine --model pi5` refuse `--gadget` on a Pi 5. Spare and test-fleet profiles leave gadget and argon off (`--no-gadget --no-argon`).

## OS Details

- OS: Raspberry Pi OS Lite (64-bit). Fleet nodes idea01–idea04 are on Debian 13 (trixie); older Bookworm images still work.
- Tooling pin: Node 22.20.0 and pnpm 10.33.0 (`package.json` `packageManager`). Do not float to latest pnpm — pnpm 12 rejects the lockfile and refuses `sudo pnpm setup` (idea#146).
- Kernel: 6.12+ (Pi 5), 6.6+ (Pi 4)
- Architecture: arm64 (both)

## Using the Fleet for Tests

The test suite can connect to a *claimed pool* node via SSH to simulate disk operations. Do not point tests at idea01 or idea02. Do not use the live pool store (`2VroE…`) as a test fixture store.

The `testSetup.engines` block in `config.yaml` is a **legacy interactive/automated scenario outline**; it is not the current pool inventory.

A scratch Engine checkout that must share another tree's `config.yaml`,
`store-identity` or `store-data` should use `script/link-scratch-store.sh`
(`ln -sfnT`, refuses if the destination exists as a non-symlink directory).
Plain `ln -sfn` into an existing `store-identity/` directory nests the link
(engine#321). Tests normally stay off the fleet store; see AGENTS.md.

## Maintenance

- **Engine update (claimed pool Pi only):** `./script/sync-engine idea03`
- **Reset a node:** `./script/reset-engine --machine idea03.local --all` (only on a Pi you have claimed; never idea01 or idea02)
- **Check status:** `./script/check-fleet.sh`
- **Re-provision (clean slate):** Re-flash SD card and run provision-fleet.sh again (Ops)

## Notes

- Pi 5 nodes (idea01, idea03) have PCIe USB — different from Pi 4's DWC2 USB controller
- 240 GB SSD provides ample space for Docker images and test data
- borgbackup is installed on all nodes for Backup Disk tests

## Tailscale

Org-level policy, ACLs, tags and remaining gaps are in koenswings/idea `docs/ops/tailscale-field-access.md` (and `docs/ops/security-overview.md`). This section only records how the Engine install stores the key and how you reach the fleet.

The pool and golden Pis are reached over Tailscale at the addresses above (current ops practice is always-on). Do not treat the older “latent debug” flow as the current fleet state: `tailscale-debug-activate.sh` still exists for an intervention, but a proof must not take Tailscale down on a fleet Pi.

**Fresh Pi provisioning:** `buildEngine` calls `installTailscale()` automatically. The key is read from the `TAILSCALE_AUTHKEY` environment variable, or, as a fallback still in code, `/home/pi/openclaw/secrets/tailscale_authkey.txt` on the machine running the provisioner (`src/data/Engine.ts`). Prefer the env var or `provision-fleet.sh`'s `--authkey-file` / `~/.config/idea/fleet-authkey` path. Never put the key on a command line.

**How the auth key is handled (idea#115):** the key is never a command-line argument, so it can't be seen with `ps`, and it never goes into logs, shell history or Console History.
- `installTailscale()` sends it over the stdin of `umask 077 && sudo tee /etc/tailscale/debug-authkey` (through ssh). The file is `0600 root:root`, in a `0700` folder.
- `tailscale-debug-activate.sh` passes `--auth-key=file:/etc/tailscale/debug-authkey`, so `tailscale up` reads the key from the file.
- The key never reaches pm2: build-engine drops `TAILSCALE_AUTHKEY` from its environment once `installTailscale()` has read it, and runs pm2 under `env -u TAILSCALE_AUTHKEY`, so it is not in `~/.pm2/dump.pm2` (idea#273).
- Never put the key on a command line yourself, e.g. `tailscale up --authkey …` or `echo … | …`.

**Target design: Tailscale always on, one fleet tag and one fleet key (Koen, 2026-10-13, idea#117).** See `proposals/2026-10-13-tailscale-single-fleet-tag.md` in koenswings/idea.
- Tailscale is always on at schools, on the router and on every Pi. There are no per-school tags or keys, so a Pi can move between schools without admin work.
- **One fleet tag, `tag:idea`, and one fleet auth key** tagged `tag:idea`. Every field Pi stores the same key at `/etc/tailscale/debug-authkey` (`0600 root:root`, never on a command line, see above).
- **ACL:** admins → `tag:idea` allowed; `tag:idea` → anything denied. Pis talk to each other only over the school LAN websocket, never over Tailscale.
- The key is a secret: never in docs, issues or chat.

Whether each *pool* node is already tagged, and the current key expiry, are recorded in the idea-repo Tailscale docs (idea#375). Do not repeat unverified admin-console facts here.

To replace the stored key on a Pi you can reach, without the key appearing on any command line:
1. Put the new key in a local file only you can read (`chmod 600`).
2. Run:
```bash
ssh pi@100.99.231.94 'sudo install -d -m 700 /etc/tailscale && umask 077 && sudo tee /etc/tailscale/debug-authkey > /dev/null' < ./new-authkey.txt
shred -u ./new-authkey.txt
```
(Use the target Pi's Tailscale IPv4, not a jump host.)
