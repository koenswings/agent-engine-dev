# IDEA Pi Fleet — Test Infrastructure

## Overview

The IDEA test fleet consists of four Raspberry Pi nodes used for remote automated testing — specifically for simulating disk dock/undock operations that require real USB hardware. These nodes are managed by the Engine Developer agent (Axle) and are used to replace manual testing with real hardware.

## Fleet Nodes

| Node | Model | Storage | Role |
|------|-------|---------|------|
| idea01 | Raspberry Pi 5 | 240 GB SSD | Primary test node (Pi 5) |
| idea02 | Raspberry Pi 4 | 240 GB SSD | Primary test node (Pi 4) |
| idea03 | Raspberry Pi 5 | 240 GB SSD | Secondary test node (Pi 5) |
| idea04 | Raspberry Pi 4 | 240 GB SSD | Secondary test node (Pi 4) |

## Network Configuration

| Node | IP | mDNS name | SSH user |
|------|----|-----------|----|
| idea01 | TBD | idea01.local | pi |
| idea02 | TBD | idea02.local | pi |
| idea03 | TBD | idea03.local | pi |
| idea04 | TBD | idea04.local | pi |

IPs are assigned by the local DHCP server (see router for current assignments).  
These nodes are on the local LAN. Tailscale is not yet active on the fleet — see [Tailscale status](#tailscale-status) below.

## Access

SSH key: `/home/node/workspace/.ssh/id_ed25519` (openclaw-axle@idea)

SSH to a Pi by its Tailscale address or LAN IP. The provisioner no longer writes `~/.ssh/config`.  
mDNS names (`idea0N.local`) resolve via avahi on the LAN.

```bash
ssh pi@idea01.local          # Direct SSH
./script/check-fleet.sh      # Status of all nodes
```

## Engine Installation

Engine path on each node: `/home/pi/idea/agents/agent-engine-dev`  
Started via pm2, auto-starts on boot.

### Provisioning a node

Key-only SSH (idea#146). The Pi must already accept this machine's key and give `pi` passwordless sudo. The script never uses a password, never edits `/etc/hosts` on the runner, and never writes `~/.ssh/config`.

```bash
# Pi 5 reached through idea03 as a jump host; fleet Tailscale key from a local file
./script/provision-fleet.sh --jump pi@100.126.117.80 --authkey-file ~/fleet-authkey.txt \
  idea01=192.168.0.138,model=pi5

# Two Pis on the same LAN; the Pi already holds the Tailscale key
./script/provision-fleet.sh idea04=192.168.0.113,model=pi4 idea05=192.168.0.120,model=pi5
```

What it does per node:
1. Checks key-based SSH (`BatchMode`) and passwordless sudo
2. Bootstraps apt packages, Node 22.20.0 and the pinned pnpm from `package.json` (`packageManager`, currently 10.33.0), then clones `/home/pi/idea/agents/<repo>`
3. Stores the Tailscale fleet key over stdin when `--authkey-file` is given (idea#115)
4. Runs `build-engine` in **local mode on the Pi** with explicit `--no-argon` / `--no-gadget` (unless you pass `--argon` / `--gadget`; `--gadget` is refused on pi5)
5. Waits for the reboot and checks that pm2's `engine` is online and the Console HTTP port returns 200

Allow 15–20 minutes per node. The Pi reboots at the end.

Off flags for a manual local `build-engine` run (same as the provisioner):

```bash
./build-engine --hostname idea01 --model pi5 --timezone Europe/Brussels --keyboard us \
  --temperature --no-argon --no-gadget --prod
```

### Syncing a code update

After provisioning, use `sync-engine` for code updates (no full reinstall needed):

```bash
./script/sync-engine idea01 idea02 idea03 idea04
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

The test suite connects to fleet nodes via SSH to simulate disk operations.  
Test targets are configured in `config.yaml` under `testSetup.engines`.

The run-tests.sh SSH restriction on wizardly-hugle does **not** apply here —  
fleet Pis have direct SSH access for all commands.

## Maintenance

- **Engine update:** `./script/sync-engine idea01 idea02 idea03 idea04`
- **Reset a node:** `./script/reset-engine --machine idea01.local --all`
- **Check status:** `./script/check-fleet.sh`
- **Re-provision (clean slate):** Re-flash SD card and run provision-fleet.sh again

## Notes

- Pi 5 nodes (idea01, idea03) have PCIe USB — different from Pi 4's DWC2 USB controller
- 240 GB SSD provides ample space for Docker images and test data
- borgbackup is installed on all nodes for Backup Disk tests

## Tailscale Status

Tailscale latent remote-access is **installed and ready** on all three fleet nodes (2026-04-11).

| Node | Binary | Service | Auth key | Activation script |
|------|--------|---------|----------|-------------------|
| idea01 (192.168.0.138) | ✅ | disabled | ✅ 600 root | ✅ |
| idea02 (192.168.0.180) | ✅ | disabled | ✅ 600 root | ✅ |
| idea03 (192.168.0.228) | ✅ | disabled | ✅ 600 root | ✅ |

**To activate debug mode on a fleet Pi:**
```bash
ssh pi@idea01.local
sudo /usr/local/bin/tailscale-debug-activate.sh
```
The script checks internet connectivity, joins the IDEA Tailnet (ephemeral), and prints the Tailscale IP. Press Enter when done — Pi leaves the Tailnet automatically.

**Fresh Pi provisioning:** `buildEngine` now calls `installTailscale()` automatically. Auth key is read from `TAILSCALE_AUTHKEY` env var or `/home/pi/openclaw/secrets/tailscale_authkey.txt` on wizardly-hugle.

**How the auth key is handled (idea#115):** the key is never a command-line argument, so it can't be seen with `ps`, and it never goes into logs, shell history or Console History.
- `installTailscale()` sends it over the stdin of `umask 077 && sudo tee /etc/tailscale/debug-authkey` (through ssh). The file is `0600 root:root`, in a `0700` folder.
- `tailscale-debug-activate.sh` passes `--auth-key=file:/etc/tailscale/debug-authkey`, so `tailscale up` reads the key from the file.
- Never put the key on a command line yourself, e.g. `tailscale up --authkey tskey-…` or `echo tskey-… | …`.

**Field Pis use one reusable, ephemeral fleet auth key (idea#117).** Every field Pi stores the same key at `/etc/tailscale/debug-authkey` (`0600 root:root`, never on a command line, see above).
- **Why:** during an intervention, someone at the school runs `tailscale-debug-activate.sh`, and the Pi joins the tailnet with that key.
- **Reusable:** the key has to work for every session on every field Pi. We usually can't reach a Pi in the field to give it a new key, so a single-use key would be spent after its first session.
- **Ephemeral:** the Pi drops off the tailnet when the session ends. That way it doesn't keep using a device slot, which keeps the licence count low.
- **The current key:** "idea fleet authentication", created in the Tailscale admin console (Settings → Keys). It expires 2026-12-20. Koen is keeping it, so don't revoke it.

The permanent fleet Pis (idea02, idea03) didn't join with this key and aren't ephemeral.

**Refresh the key before it expires.** Tailscale auth keys expire after at most 90 days. Once the stored key has expired, a field Pi can no longer join the tailnet, so every Pi's stored key must be replaced with a new fleet key before that happens. How the refresh works in the field is still open in [idea#117](https://github.com/koenswings/idea/issues/117). That issue also covers the key's tag and the tailnet access rules. Options for the refresh include refreshing during site visits or pushing a new key while a Pi is connected.

To replace the stored key on a Pi you can reach, without the key appearing on any command line:
1. Put the new key in a local file only you can read (`chmod 600`).
2. Run:
```bash
ssh pi@idea01.local 'sudo install -d -m 700 /etc/tailscale && umask 077 && sudo tee /etc/tailscale/debug-authkey > /dev/null' < ./new-authkey.txt
shred -u ./new-authkey.txt
```

See `design/tailscale-remote-management.md` for full design and Phase 2 (Console UI toggle).
