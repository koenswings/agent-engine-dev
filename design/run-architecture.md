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
| Engine process (pm2, runtime) | root (see §Current State) | `store-data/`, `store-identity/` |
| OpenClaw sandbox (AI agent) | root (Docker default) | `dist/`, `node_modules/` |
| Pi shell / `run-tests.sh` | `pi` | `dist/` (via `pnpm build`) |
| `build-engine` provisioning | `pi` (SSH as pi) | whole repo |

When the sandbox runs a build, `dist/` is created owned by root. When `run-tests.sh`
then runs as `pi`, `pnpm clean` (`rm -fr dist/*`) fails: *Permission denied*.

This is a symptom of two overlapping problems:
1. The Engine runs as root when it should not.
2. The OpenClaw sandbox also runs as root — but it does not have to.

Both are addressed below.

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
| Nextcloud post-start | `sudo docker exec ... runuser ...` | unnecessary once Engine runs as `pi` |

### Source file ownership

`build-engine.ts` explicitly sets source ownership to `pi:pi`:

```ts
await exec`sudo chown -R pi:pi ${permanentEnginePath}`
```

So the intended owner of the source tree is `pi` — but the pm2 process runs as root.
This inconsistency is the root cause.

### What the `pi` user can do

- Full passwordless `sudo` (Raspberry Pi OS default: `pi ALL=(ALL) NOPASSWD: ALL`)
- In `docker` group (added by `installDocker`)

---

## Problem 1: Engine running as root

### Why it is wrong

Running application code as root is a security anti-pattern regardless of environment.
More practically: if the Engine (as root) ever writes a file into the source tree at
runtime, that file becomes root-owned and `pi` cannot modify it. Any future split
between "what the Engine writes" and "what the developer edits" becomes a permission
problem.

### Fix: Engine runs as `pi`, not root

The Engine does not need to run as root. It needs:
1. `sudo` for a small, fixed set of mount/umount commands
2. Docker group membership for `docker compose`

Both are already available to `pi`. The correct pattern: run as `pi`, grant `pi`
passwordless sudo for the specific commands it needs.

#### Change A — pm2 startup as `pi`

Change `build-engine.ts` from:

```ts
await exec`sudo pm2 start pm2.config.cjs --env production`
await exec`sudo pm2 save`
await exec`sudo pm2 startup`
```

To:

```ts
await exec`pm2 start pm2.config.cjs --env production`  // no sudo — pi is the acting user
await exec`pm2 save`
const startupCmd = (await exec`pm2 startup systemd -u pi --hp /home/pi`).stdout.trim()
await exec`${startupCmd}`  // pm2 startup prints a sudo command; run it
```

`pm2 startup systemd -u pi --hp /home/pi` generates a systemd unit that runs pm2 as
`pi`. The Engine it manages also runs as `pi`.

#### Change B — targeted sudoers rule for mount operations

Create `/etc/sudoers.d/engine`:

```sudoers
# Engine — passwordless sudo for disk mount/unmount operations only
pi ALL=(root) NOPASSWD: /bin/mount -t ext4 /dev/* /disks/*
pi ALL=(root) NOPASSWD: /bin/umount /disks/*
pi ALL=(root) NOPASSWD: /bin/mkdir -p /disks/*
pi ALL=(root) NOPASSWD: /bin/rm -fr /disks/*
pi ALL=(root) NOPASSWD: /bin/rm -fr /disks/old/*
pi ALL=(root) NOPASSWD: /bin/mv /disks/* /disks/old/*
```

**This file must be deployed via `build-engine.ts` provisioning,** using the same
`copyAsset()` mechanism already used for the udev rules:

```ts
await copyAsset(exec, enginePath, '10-engine.sudoers', '/etc/sudoers.d', false, '0440', '0:0')
```

The asset `script/build_image_assets/10-engine.sudoers` must be created and copied
alongside the existing `90-docking.rules` step in `installUdev()`. Every Pi that runs
the Engine provisioning script gets this rule automatically.

> Note: Raspberry Pi OS ships with `pi ALL=(ALL) NOPASSWD: ALL`. The targeted rule
> is redundant in the short term but makes the intent explicit and is required if the
> broad grant is ever removed as part of security hardening.

---

## Problem 2: OpenClaw sandbox running as root

### Why this is not inevitable

Docker containers default to running as root because most images do not specify a `USER`.
This is a convenience default, not a requirement. OpenClaw's sandbox can be started with:

```
--user 1000:1000
```

(where 1000 is the `pi` user's uid/gid on a standard Raspberry Pi OS install)

If the sandbox runs as `pi`, every file it creates — `dist/`, `node_modules/`, outputs —
is owned by `pi`. The Pi's `pnpm clean`, `git pull`, and `run-tests.sh` all work without
`sudo`. The workaround in `run-tests.sh` (`sudo rm -rf dist/`) becomes unnecessary.

### Two paths to fix this

#### Option 2A — Run OpenClaw sandbox container as `pi` (uid 1000)

Pass `--user 1000:1000` to the Docker run command that starts the OpenClaw sandbox.

Pros: minimal change; OpenClaw remains containerised; ownership problem eliminated at source.  
Cons: requires knowing the Pi's uid (1000 on standard Raspberry Pi OS); may need to ensure
the container user can write to shared paths.

This is the right fix if OpenClaw stays in Docker. It should be done regardless of whether
Problem 1 is fixed, because it eliminates the ownership conflict class entirely.

> **Action:** Koen to check whether OpenClaw's Docker Compose or start command allows
> `--user` override. If so, add `user: "1000:1000"` to the OpenClaw service definition
> in `openclaw.json` or the relevant compose file. This is an Atlas (operations) task.

#### Option 2B — Run OpenClaw natively on the Pi (no Docker)

Instead of running OpenClaw in a container, install and run it directly on the Pi as the
`pi` user.

Pros:
- OpenClaw runs as `pi` by default — no ownership conflict, ever
- Simpler mental model: one filesystem, one user, no container boundary
- No `--user` configuration needed; works correctly on any Pi regardless of uid
- Eliminates an entire class of permission bugs permanently
- The Engine source directory is just a local directory; no shared-filesystem complexity

Cons:
- Reduced isolation: OpenClaw's `exec` tool has direct access to the Pi's filesystem as `pi`
  (though it already has this via the shared volume in Docker mode)
- Updates: `pnpm update` or `git pull` instead of `docker pull`
- Any OpenClaw dependencies installed globally affect the Pi's system Node.js

Assessment: **For the IDEA use case, this is a reasonable choice.** The Pi is a trusted
development machine, not a public-facing server. The isolation Docker provides is minimal
in practice — the sandbox already has access to the full source tree via the shared volume.
Native OpenClaw is simpler, more transparent, and eliminates the ownership problem by design.

**Recommendation:** Evaluate Option 2B seriously. If it works with OpenClaw's current
install path, prefer it over Option 2A.

---

## Ownership Map (target state)

Assuming Problem 1 (Engine as `pi`) and Problem 2 (sandbox as `pi`) are both fixed:

| Path | Owner | Writable by |
|---|---|---|
| `/home/pi/idea/agents/agent-engine-dev/` | `pi:pi` | `pi` (all actors) |
| `dist/` | `pi:pi` | `pi` (tsc, sandbox, run-tests.sh) |
| `node_modules/` | `pi:pi` | `pi` (pnpm install) |
| `store-data/` | `pi:pi` | Engine process (as `pi`) |
| `store-identity/` | `pi:pi` | Engine process (as `pi`); read-only after init |
| `/disks/` | `root:root` | Engine (as `pi`) via sudoers |
| `/disks/sdX1/` (mount points) | `root:root` | Engine via `sudo mount/umount` |

If only Problem 1 is fixed (sandbox still runs as root), the `run-tests.sh` workaround
(`sudo rm -rf dist/`) is still needed, and builds triggered by the sandbox leave
root-owned files until they are cleaned up.

---

## What this does NOT change

- App Disk format, META.yaml, instance lifecycle — unchanged.
- Docker Compose invocations for app instances — unchanged (already work without root).
- The `pi` user's broad sudo grant — not removed in this design (separate hardening task).

---

## Open Questions

1. **OpenClaw Docker user:** Can `--user 1000:1000` be passed via `openclaw.json` or the
   compose file? Does the OpenClaw image work correctly as non-root?

2. **Native OpenClaw viability:** Does OpenClaw support a native (non-Docker) install on
   Raspberry Pi OS (arm64)? What does the install look like?

3. **`node_modules/` after sandbox `pnpm install`:** If the sandbox (as root or as pi)
   runs `pnpm install` to add a new devDependency, the lockfile changes. The next
   `run-tests.sh` pull and `pnpm install` must succeed. Verify this works with
   `CI=true pnpm install --frozen-lockfile` once the sandbox user is fixed.

4. **Nextcloud `sudo docker exec`:** These lines use `sudo docker exec` unnecessarily
   once the Engine runs as `pi` (which is in the docker group). Remove `sudo` prefix
   in a follow-up code change.

5. **`/disks/` mkdir during provisioning:** `build-engine.ts` creates `/disks/` as root.
   The Engine running as `pi` will use `sudo mkdir -p /disks/${device}` per the sudoers
   rule. Verify the sudoers pattern covers nested paths (e.g. `/disks/sda1`).

---

## Implementation Plan

Depends on decision for Problem 2 (Option 2A vs 2B):

**Both options require (Engine repo — Axle):**
- [ ] Add `script/build_image_assets/10-engine.sudoers`
- [ ] Add `copyAsset()` call in `installUdev()` in `Engine.ts` to deploy it
- [ ] Update `startEngine()` in `Engine.ts`: remove `sudo` from `pm2 start`/`pm2 save`; update `pm2 startup` call
- [ ] Remove `sudo` from Nextcloud `docker exec` lines in `Instance.ts` (follow-up)

**If Option 2A (Docker, `--user 1000:1000`) — Atlas:**
- [ ] Add `user: "1000:1000"` to OpenClaw service definition
- [ ] Remove `sudo rm -rf dist/` workaround from `run-tests.sh` (no longer needed)

**If Option 2B (native OpenClaw) — Atlas:**
- [ ] Remove OpenClaw Docker service; install OpenClaw natively as `pi`
- [ ] Remove `sudo rm -rf dist/` workaround from `run-tests.sh` (no longer needed)
- [ ] Update `openclaw/README.md` with native install instructions

**pm2 + sudoers must land together** — if pm2 changes before the sudoers rule is
deployed, mount operations will fail.
