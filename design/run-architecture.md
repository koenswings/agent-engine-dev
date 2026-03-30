# Design: Engine Run Architecture — User, Ownership, and Permissions

**Status:** Proposed  
**Author:** Axle (Engine Developer)  
**Date:** 2026-03-30  
**Backlog item:** Engine — Review run architecture: which user? File ownership and permissions?

---

## Problem

The Engine is provisioned and operated by several different actors that run as different
Unix users:

| Actor | User | Creates files in |
|---|---|---|
| Engine process (pm2, runtime) | root (see below) | `store-data/`, `store-identity/`, `/disks/` |
| OpenClaw sandbox (AI agent) | root (container uid 0) | `dist/`, `node_modules/` |
| Pi shell / `run-tests.sh` | `pi` | `dist/` (via `pnpm build`) |
| `build-engine` provisioning | `pi` (SSH as pi) | whole repo |

The build step (`pnpm clean && tsc`) writes to `dist/`. `pnpm clean` does `rm -fr dist/*`.

When the sandbox runs a build, `dist/` is created owned by root. When `run-tests.sh`
then runs as `pi`, `pnpm clean` fails: *Permission denied*. This blocks every SSH-triggered
test run until someone manually fixes ownership.

This is a symptom of an inconsistency in the run architecture. The deeper question:
**which user should own what, and which user should the Engine run as?**

---

## Current State (as-built)

### How the Engine starts

`build-engine.ts` installs pm2 and starts the engine:

```ts
await exec`sudo pm2 start pm2.config.cjs --env production`
await exec`sudo pm2 save`
await exec`sudo pm2 startup`
```

`sudo pm2 startup` generates a systemd unit that runs the pm2 daemon as **root**.
All processes managed by that pm2 instance — including the Engine — also run as root.

### What the Engine needs privileged access for

Looking at `usbDeviceMonitor.ts` and `Instance.ts`:

| Operation | Command | Requires |
|---|---|---|
| Mount App Disk | `sudo mount /dev/${device} /disks/${device}` | root or `CAP_SYS_ADMIN` |
| Unmount App Disk | `sudo umount /disks/${device}` | root or `CAP_SYS_ADMIN` |
| Remove mount point | `sudo rm -fr /disks/${device}` | root (directory ownership) |
| Create mount point | `sudo mkdir -p /disks/${device}` | root (writing to `/disks/`) |
| Docker operations | `docker compose up/down` | docker group membership |
| Nextcloud post-start | `sudo docker exec ... runuser ...` | root |

### Source file ownership

`build-engine.ts` explicitly sets source ownership to `pi`:

```ts
await exec`sudo chown -R pi:pi ${permanentEnginePath}`
```

So the intended owner of the source tree is `pi` — but the pm2 process runs as root.

### What the `pi` user can do

- Full `sudo` (Raspberry Pi OS default: `pi ALL=(ALL) NOPASSWD: ALL`)
- In `docker` group (added by `installDocker`)

---

## The Conflict

Root cause: **two different actors write to the same directories under different uids.**

```
Sandbox (root) ──→ builds dist/ ──→ dist/ owned by root:root
Pi / run-tests.sh (pi) ──→ pnpm clean → rm -fr dist/* → PERMISSION DENIED
```

A second conflict exists between the Engine runtime (root) and development tooling (pi):
if the Engine ever writes to a file in the source tree at runtime, that file becomes
root-owned and `pi` cannot modify it.

The root of both problems is the same: **the Engine runs as root when it should not.**

---

## Proposed Architecture

### Decision: Engine runs as `pi`, not root

The Engine does not need to run as root. It needs:
1. `sudo` for a small, fixed set of mount/umount commands
2. Docker group membership for `docker compose`

Both of these are available to the `pi` user already. The correct pattern is:
**run the Engine as `pi`, grant `pi` passwordless sudo for the specific commands it needs.**

This is standard Unix practice for services that require limited elevated operations.

### Changes required

#### 1. Sudoers rule — targeted sudo for Engine operations

Create `/etc/sudoers.d/engine` on each Pi:

```
# Engine — passwordless sudo for disk mount/unmount operations only
pi ALL=(root) NOPASSWD: /bin/mount -t ext4 /dev/* /disks/*
pi ALL=(root) NOPASSWD: /bin/umount /disks/*
pi ALL=(root) NOPASSWD: /bin/mkdir -p /disks/*
pi ALL=(root) NOPASSWD: /bin/rm -fr /disks/*
pi ALL=(root) NOPASSWD: /bin/rm -fr /disks/old/*
pi ALL=(root) NOPASSWD: /bin/mv /disks/* /disks/old/*
```

This replaces the current `NOPASSWD: ALL` pattern with minimal, auditable permissions.

> **Note:** Raspberry Pi OS ships with `pi ALL=(ALL) NOPASSWD: ALL` by default.
> That broad grant already covers what the Engine needs. The change here is to make
> the intent explicit and to open the door to removing the blanket grant later.

#### 2. pm2 startup — run as `pi`, not root

Change `build-engine.ts` from:

```ts
await exec`sudo pm2 start pm2.config.cjs --env production`
await exec`sudo pm2 save`
await exec`sudo pm2 startup`
```

To:

```ts
// Start engine as pi (no sudo — pi is the acting user)
await exec`pm2 start pm2.config.cjs --env production`
await exec`pm2 save`
// Generate startup script (this still needs root to install the systemd unit)
const startupCmd = (await exec`pm2 startup systemd -u pi --hp /home/pi`).stdout.trim()
// The output of pm2 startup is a sudo command — run it
await exec`${startupCmd}`
```

`pm2 startup systemd -u pi --hp /home/pi` generates a systemd unit that runs the pm2
daemon as the `pi` user. The Engine process it manages also runs as `pi`.

#### 3. Source tree and build artifacts — owned by `pi:pi`

No change to the existing `chown -R pi:pi` in `build-engine.ts`. This is already correct.

What changes: the sandbox (OpenClaw container, root) must not leave root-owned files in
the source tree. Two mechanisms enforce this:

**a) `run-tests.sh` — defensive cleanup before build (already fixed in PR #17):**

```bash
sudo rm -rf "$ENGINE_DIR/dist/"
```

This handles any root-owned `dist/` left by sandbox builds. Safe: `dist/` is gitignored.

**b) Sandbox test scripts — clean up after builds:**

After every sandbox build or test run, the sandbox should run `pnpm clean`. The sandbox
runs as root, so it can delete root-owned files. The Pi never sees them.

This should be added to the engine's test scripts:

```json
"test:unit": "pnpm build && ... vitest run ... && pnpm clean"
```

> This is belt-and-suspenders with (a). Either one alone is sufficient; together they
> guarantee the Pi always starts with a clean slate.

#### 4. `/disks/` directory — owned by root, writable by Engine via sudo

`/disks/` is the mount point for App Disks. It should be owned by root with no world
write permission. The Engine accesses it exclusively via `sudo mkdir`, `sudo mount`,
`sudo umount`, `sudo rm` — the sudoers rule in (1) covers all of these.

```
drwxr-xr-x  root:root  /disks/
```

No change needed here — this is the natural state when `mkdir /disks` is run as root
during provisioning.

#### 5. Nextcloud-specific `sudo docker exec`

`Instance.ts` uses `sudo docker exec` for Nextcloud post-start configuration. Once the
Engine runs as `pi` and `pi` is in the `docker` group, these commands do not need
`sudo`. The `sudo` prefix should be removed.

> This is an implementation detail — do not change it in this design phase. Flag it as
> a known TODO in the code comment.

---

## Ownership Map (target state)

| Path | Owner | Writable by |
|---|---|---|
| `/home/pi/idea/agents/agent-engine-dev/` | `pi:pi` | `pi` (git, pnpm, tests) |
| `dist/` | `pi:pi` | `pi` (tsc); sandbox cleans up after itself |
| `node_modules/` | `pi:pi` | `pi` (pnpm install) |
| `store-data/` | `pi:pi` | Engine process (as `pi`) |
| `store-identity/` | `pi:pi` | Engine process (as `pi`); read-only after init |
| `/disks/` | `root:root` | Engine process (as `pi`) via sudoers |
| `/disks/sdX1/` (mount points) | `root:root` | Engine via `sudo mount/umount` |

---

## What this does NOT change

- The `pi` user's broad sudo grant (`NOPASSWD: ALL`) is not removed in this design.
  That is a separate security hardening task (healthcheck skill scope).
- App Disk format, META.yaml, instance lifecycle — unchanged.
- Docker Compose invocations — unchanged (already work without root).
- The OpenClaw sandbox runs as root — unchanged. The sandbox cleans up its own
  build artifacts as part of this design.

---

## Open Questions

1. **`node_modules/` ownership after sandbox `pnpm install`:** If the sandbox runs
   `pnpm install` (e.g. to add a new devDependency), `node_modules/` may become
   partially root-owned. `run-tests.sh` uses `CI=true pnpm install --frozen-lockfile`
   which updates node_modules in-place. If the lockfile hasn't changed since the
   last Pi-local install, pnpm skips the update entirely and ownership is preserved.
   If the lockfile has changed and pnpm needs to install new packages into existing
   root-owned directories, it may fail. **Mitigation:** `run-tests.sh` could also
   run `sudo chown -R pi:pi node_modules/` before the install step, but this is slow
   (~30 s on Pi). Accept the current behaviour for now; address if it causes failures.

2. **Nextcloud `sudo docker exec`:** Once Engine runs as `pi` (in docker group), the
   `sudo` prefix on these commands is unnecessary. Remove in a follow-up code change.

3. **`/disks/` creation during provisioning:** Currently `build-engine.ts` creates
   `/disks/` as root. After this design, the Engine running as `pi` will call
   `sudo mkdir -p /disks/${device}` per the sudoers rule. Verify the sudoers pattern
   covers `mkdir` on nested paths (e.g. `/disks/sda1`).

---

## Implementation Plan

This design requires changes in two repos:

**`agent-engine-dev` repo (Axle):**
- [ ] Remove `sudo` prefix from `pm2 start`, `pm2 save`; update `pm2 startup` call in `Engine.ts`
- [ ] Add `pnpm clean` step at end of `test:unit` and `test:diagnostic` scripts
- [ ] Add TODO comment on Nextcloud `sudo docker exec` lines

**`idea` org repo (Atlas — provisioning):**
- [ ] Add sudoers rule file `build_image_assets/10-engine.sudoers`
- [ ] Add `copyAsset(exec, enginePath, '10-engine.sudoers', '/etc/sudoers.d', true, '0440', '0:0')` to `build-engine.ts`
- [ ] Update `build-engine.ts` pm2 startup sequence

These changes are **not** a single atomic commit — the sudoers rule and pm2 fix must
land together (if pm2 changes before the sudoers rule exists, mount operations will fail).
