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

SSH config entries (managed by `script/provision-fleet.sh`) are in `~/.ssh/config`.  
mDNS names (`idea0N.local`) resolve via avahi on the LAN.

```bash
ssh pi@idea01.local          # Direct SSH
./script/check-fleet.sh      # Status of all nodes
```

## Engine Installation

Engine path on each node: `/home/pi/projects/engine`  
Started via pm2, auto-starts on boot.

### Provisioning a node

```bash
# Provision a single node (Pi 5 example)
PI_PASS=<password> ./script/provision-fleet.sh idea01=<ip>,model=pi5

# Provision all four nodes
PI_PASS=<password> ./script/provision-fleet.sh \
  idea01=<ip1>,model=pi5 \
  idea02=<ip2>,model=pi4 \
  idea03=<ip3>,model=pi5 \
  idea04=<ip4>,model=pi4
```

The provisioner:
1. Pushes the SSH key via password auth (sshpass)
2. Updates `/etc/hosts` and `~/.ssh/config` in the sandbox
3. Syncs engine code via rsync
4. Installs Node.js 22, pnpm, pm2, Docker, borgbackup
5. Sets hostname, locale, udev rules
6. Builds and starts the engine
7. Reboots the Pi

Allow 15–20 minutes per node. The Pi reboots at the end.

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

Provisioner automatically skips `--gadget` for Pi 5 nodes.

## OS Details

- OS: Raspberry Pi OS Lite (64-bit, Bookworm / Debian 12)
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

See `design/tailscale-remote-management.md` for full design and Phase 2 (Console UI toggle).
