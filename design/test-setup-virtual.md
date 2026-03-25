# Design: Automated Test Setup — Proposal A (Virtual/Docker Battery)

**Status:** Superseded — Proposal B (native engine) was chosen. See `design/test-setup-native.md`.  
**Author:** Axle (Engine Developer)  
**Date:** 2025-07-11  
**Backlog item:** Engine — Test setup design

---

## Problem

The current test setup (`test/01-e2e-execution.test.ts`) cannot run automatically after a feature
merge. It requires:

- Physical Raspberry Pi devices powered on and accessible
- A human to flash SD cards, plug in USB disks, and press Enter at each manual step
- The `interactiveTestSequence` is not machine-runnable at all

This makes it impossible to validate features quickly or use tests as a CI gate.

---

## Goal

A fully automated test suite that:

1. Can run with `pnpm test` from any developer machine (or CI)
2. Covers the core Engine scenarios: disk dock/undock, instance lifecycle, multi-engine sync
3. Requires **no human interaction** and **no physical hardware** during the automated run
4. Remains close enough to real behaviour that passing tests give genuine confidence

The interactive test sequence (provisioning real Pis) stays as a separate, manual
**integration/acceptance test** — not the automated suite.

---

## Approach

Two complementary changes:

1. **Disk simulation** — trigger dock/undock events without real USB hardware
2. **Engine battery** — run a set of real Engine processes locally via Docker Compose

These let the automated tests exercise the actual Engine code paths, not mocks.

---

## 1. Disk Simulation

### How the Engine detects disks today

`usbDeviceMonitor.ts` uses chokidar to watch `/dev/engine`. When a file like `sda1` appears
there, the Engine:

1. Mounts `/dev/sda1` → `/disks/sda1` using `sudo mount -t ext4`
2. Reads `META.yaml` from the mount point
3. Processes the disk (creates/updates Automerge state, starts instances)

The critical insight: **chokidar just watches files — it doesn't care if they're real device
nodes**. The mount step is the only hardware dependency.

### Simulation design

Add a `testMode` flag to `config.yaml` settings. When `testMode: true`:

- The Engine skips `sudo mount` and `sudo umount` entirely
- It expects `/disks/<device>/` to already exist as a plain directory
- It reads `META.yaml` from that directory as normal

The test harness:

1. Creates `/disks/sda1/META.yaml` (and any app data the test needs)
2. Touches a sentinel file at `/dev/engine/sda1` → triggers chokidar → Engine processes disk
3. To simulate undock: removes `/dev/engine/sda1` → triggers chokidar remove event

This path through the code is **identical to production** except for the mount syscall.

### Changes to `usbDeviceMonitor.ts`

```typescript
// In addDevice():
if (!config.settings.testMode) {
    // existing mount logic
    await $`sudo mkdir -p /disks/${device}`
    await $`sudo mount /dev/${device} /disks/${device}`
} else {
    // In test mode, the directory must already exist
    if (!fs.existsSync(`/disks/${device}`)) {
        log(`TEST MODE: /disks/${device} not found — test harness must create it first`)
        return
    }
}

// In undockDisk():
if (!config.settings.testMode) {
    await $`sudo umount /disks/${device}`
    await $`sudo rm -fr /disks/${device}`
}
```

### Test harness helpers (`test/harness/diskSim.ts`)

```typescript
export const dockDisk = async (device: string, meta: DiskMeta): Promise<void> => {
    // 1. Create /disks/<device>/ with META.yaml
    await fs.mkdir(`/disks/${device}`, { recursive: true })
    await fs.writeFile(`/disks/${device}/META.yaml`, YAML.stringify(meta))
    // 2. Touch sentinel — triggers chokidar
    await $`touch /dev/engine/${device}`
}

export const undockDisk = async (device: string): Promise<void> => {
    await $`rm /dev/engine/${device}`
    // chokidar fires remove → Engine cleans up state
    // Leave /disks/<device>/ for post-test inspection
}
```

---

## 2. Engine Battery (Docker Compose)

### Why Docker, not in-process

Running multiple Engine instances in the same Node.js process would require significant
refactoring (singletons, global state). Docker Compose gives us **real isolation** — each engine
has its own process, store, identity, and network — while still being fully controllable from
a test runner on the host.

### Compose setup (`compose-engine-test.yaml`)

Three engine containers on a shared Docker bridge network (`test-net`):

```
engine-1  ← connects to test-net, mounts test data volumes
engine-2  ← same
engine-3  ← same
```

Each container:
- Runs the local engine code (bind-mounted source, or built image)
- Has `testMode: true` in its `config.yaml`
- Has separate `store-data/` and `store-identity/` volumes
- Exposes its WebSocket port to the host (4321, 4322, 4323)

mDNS discovery does not work across Docker bridges. Replace with **explicit connect commands**
in the test setup — each engine connects directly to the others by container hostname.

### Engine battery helpers (`test/harness/engineBattery.ts`)

```typescript
export const startBattery = async (): Promise<void> => {
    await $`docker compose -f compose-engine-test.yaml up -d`
    await waitForEnginesReady(['engine-1', 'engine-2', 'engine-3'])
}

export const stopBattery = async (): Promise<void> => {
    await $`docker compose -f compose-engine-test.yaml down -v`
}

export const removeEngine = async (name: string): Promise<void> => {
    await $`docker compose -f compose-engine-test.yaml stop ${name}`
}

export const addEngine = async (name: string): Promise<void> => {
    await $`docker compose -f compose-engine-test.yaml start ${name}`
}
```

---

## 3. Test Framework

The current setup uses Mocha + Chai. AGENTS.md specifies **Vitest**.

The data-driven test runner in `01-e2e-execution.test.ts` is clever but adds indirection
that makes failures hard to diagnose. For the automated suite:

- Use **Vitest** directly (as specified in AGENTS.md)
- Write tests as explicit `it()` blocks — not data-driven YAML sequences
- Keep the YAML-driven approach only for the interactive/acceptance suite

The config-based test sequences (`interactiveTestSequence`, `automatedTestSequence`) stay in
`config.yaml` and are used only when running `TEST_MODE=full`.

---

## 4. Test Structure

```
test/
  00-config.test.ts              existing, keep
  01-e2e-execution.test.ts       existing, keep for interactive mode
  automated/
    disk-dock-undock.test.ts     dock/undock a disk, verify Automerge state
    instance-lifecycle.test.ts   start/stop instances on docked disk
    multi-engine-sync.test.ts    dock disk on engine-1, assert engine-2+3 see it
    engine-join-leave.test.ts    remove engine-2, dock disk, re-add, assert sync
    app-versioning.test.ts       version read from disk, stored in Automerge
    app-upgrade.test.ts          upgrade proposal flow, minor vs major detection
  acceptance/
    app-upgrade.test.ts          Kolibri v1→v2 with real data (interactive only)
  fixtures/
    disk-kolibri-v1/             mock disk with kolibri 1.0
    disk-kolibri-v1.1/           mock disk with kolibri 1.1 (minor bump)
    disk-kolibri-v2.0/           mock disk with kolibri 2.0 (major bump)
  harness/
    diskSim.ts                   dock/undock helpers
    engineBattery.ts             compose start/stop/add/remove helpers
    waitFor.ts                   polling assertion helper
```

`pnpm test` runs `automated/` only — fast, no hardware, no interaction.  
`pnpm test:full` runs `01-e2e-execution.test.ts` — the interactive suite.

---

## 5. Scenarios to Cover

| Scenario | Tests |
|---|---|
| Dock a disk → state appears in Automerge | `disk-dock-undock.test.ts` |
| Undock a disk → instances stop, state updated | `disk-dock-undock.test.ts` |
| Create and start an instance on a docked disk | `instance-lifecycle.test.ts` |
| Stop an instance | `instance-lifecycle.test.ts` |
| Disk docked on engine-1 → engine-2 and engine-3 see it | `multi-engine-sync.test.ts` |
| Engine-2 leaves → engine-1+3 still consistent | `engine-join-leave.test.ts` |
| Engine-2 rejoins → syncs up with missed changes | `engine-join-leave.test.ts` |
| App version read from disk → stored in `appDB` | `app-versioning.test.ts` |
| Minor update docked → upgrade proposed, `compatible: true` | `app-upgrade.test.ts` |
| Major update docked → no auto-upgrade, `compatible: false` | `app-upgrade.test.ts` |
| Upgrade accepted → instance `instanceOf` updated to new version | `app-upgrade.test.ts` |
| Kolibri v1→v1.1 on real Pi, data survives | `acceptance/app-upgrade.test.ts` |
| Major upgrade correctly blocked on real Pi | `acceptance/app-upgrade.test.ts` |

---

## 8. App Version & Upgrade Tests

This section covers Koen's specific questions:

- *Is our latest version of app-kolibri running?*
- *For a non-major update, does the new version run against data from the previous version?*

There are two distinct layers here, and it matters which layer a test belongs to.

### Layer A — Engine logic (automated, no Docker)

The Engine is responsible for:

1. Reading the app version from the disk (`compose.yaml` → `x-app.version`)
2. Storing it in Automerge as part of the `App` and `Instance` records
3. Detecting when a newly-docked disk carries a **newer version** of an already-running app
4. Determining whether the update is **minor** (data-compatible, upgrade safe) or **major**
   (breaking, upgrade must be manual)
5. Proposing the upgrade to the Console UI via Automerge state

All of this is pure state management — no Docker required. The automated tests cover it.

### Layer B — App compatibility (acceptance, requires Docker + real data)

Whether Kolibri v2 actually starts and serves content against v1 data is an app-level concern.
The Engine's job is to orchestrate the upgrade; whether the app itself handles the data
migration correctly is the app's responsibility.

These tests run against real Docker containers on real Pi hardware, as part of the interactive
acceptance suite. They are **not** in `pnpm test`.

---

### 8.1 Version Detection Tests (`app-versioning.test.ts`)

Test that the Engine correctly reads and stores version information when a disk is docked.

**Fixtures needed:** mock disk directories with a known `compose.yaml` containing an
`x-app` block (name, version, title, etc.). No app containers are started.

```
test/fixtures/
  disk-kolibri-v1/
    META.yaml                     ← diskId, diskName
    apps/
      kolibri-1.0/
        compose.yaml              ← x-app.name=kolibri, x-app.version=1.0, services...
  disk-kolibri-v2-minor/
    META.yaml
    apps/
      kolibri-1.1/
        compose.yaml              ← version=1.1 (minor bump, same major)
  disk-kolibri-v2-major/
    META.yaml
    apps/
      kolibri-2.0/
        compose.yaml              ← version=2.0 (major bump, breaking)
```

**Test cases:**

| Test | What it verifies |
|---|---|
| Dock kolibri-v1 → `appDB` entry with `version=1.0` | Version read from disk correctly |
| Instance `instanceOf` field → `kolibri-1.0` | AppID correctly composed |
| Instance status → `Starting` (no Docker) | Engine moves to correct state |
| Dock kolibri-v1 running + dock kolibri-v1.1 → upgrade proposed | Engine detects newer minor version |
| Dock kolibri-v1 running + dock kolibri-v2.0 → **no** auto-upgrade | Major version blocked |
| Version comparison: `1.0` < `1.1` (minor), `1.0` < `2.0` (major) | Version comparison logic correct |

The last two tests require a `isMinorUpdate(vA, vB)` function in the Engine. If it doesn't
exist yet, these tests define the required behaviour and fail until the function is
implemented — which is the right way to do test-driven development.

### 8.2 Upgrade Proposal Tests (`app-upgrade.test.ts`)

Simulate the full upgrade proposal flow:

1. Dock `disk-kolibri-v1` on `engine-1` → instance `Running`
2. Dock `disk-kolibri-v1.1` on `engine-1` → Engine detects newer minor version
3. Assert: Automerge state contains an upgrade proposal for the kolibri instance
4. Assert: proposal shows `from: 1.0`, `to: 1.1`, `compatible: true`
5. Send `acceptUpgrade` command → Engine executes upgrade workflow
6. Assert: instance `instanceOf` updated to `kolibri-1.1`
7. Repeat with `disk-kolibri-v2.0` → assert `compatible: false`, no auto-accept

These tests exercise the full state machine without needing running Docker containers.

### 8.3 App Acceptance Tests (interactive suite only)

These run as part of `pnpm test:full` against the real Pi hardware battery.
They test what the Engine cannot: whether the app actually works end-to-end.

**Scenario: Kolibri upgrade with real data**

```
Stage 1: Dock disk-kolibri-v1 on engine-1
         → Wait for instance status = Running
         → HTTP GET http://engine-1.local:<port>/api/public/info → assert 200 OK

Stage 2: Manually (or via script) write some content to Kolibri
         (create a channel, import a resource)

Stage 3: Dock disk-kolibri-v1.1 (minor update)
         → Accept upgrade proposal via Console command
         → Wait for instance status = Running on new version

Stage 4: HTTP GET same /api/public/info → assert 200 OK
         Verify the resource from Stage 2 still exists
         → assert Kolibri did not wipe data on minor upgrade
```

**Scenario: Major upgrade blocked**

```
Stage 1: Dock disk-kolibri-v1
Stage 2: Dock disk-kolibri-v2.0
         → assert upgrade NOT auto-proposed
         → assert Engine warns: major version, manual upgrade required
```

These are defined in `test/acceptance/app-upgrade.test.ts`, which is excluded from
`pnpm test` and only runs via `pnpm test:full` with `TEST_MODE=acceptance`.

### 8.4 App Fixture Structure

Each app fixture is a minimal disk that exercises a specific scenario. The fixture directory
mirrors the real disk layout but contains no actual app data (no Docker images, no volumes).

A `compose.yaml` fixture only needs the `x-app` block and a `services` stub:

```yaml
# test/fixtures/disk-kolibri-v1/apps/kolibri-1.0/compose.yaml
x-app:
  name: kolibri
  version: "1.0"
  title: "Kolibri"
  description: "Offline learning platform"
  url: "http://localhost"
  category: "Productivity"
  icon: ""
  author: "koenswings"

services:
  kolibri:
    image: learningequality/kolibri:1.0   # real image for acceptance tests
    # volumes, ports etc. only needed for acceptance tests
```

For the automated suite, the Engine reads the `x-app` block and never touches `services`.

---

## 6. What This Does Not Cover (automated suite)

- **Actual Docker container startup** — instances are asserted in `Starting` state only;
  Docker execution requires Docker-in-Docker (complex, deferred) or real Pi hardware.
  App compatibility (does Kolibri v2 run against v1 data?) is covered in the acceptance suite.
- **mDNS peer discovery** — bypassed by explicit connect in the battery.
- **USB mount/unmount syscalls** — bypassed by test mode flag.
- **Real disk I/O** — simulated directories only.

These gaps are acceptable for `pnpm test`. The acceptance suite (`pnpm test:full`) closes the
Docker and real-hardware gaps. The scenarios above together cover the Engine's full
responsibility surface: **state management, event processing, CRDT sync, and upgrade logic**.

---

## 7. Implementation Plan

The build is split into three PRs so each is reviewable in isolation:

**PR 1 — Disk simulation mode**
- Add `testMode` flag to `Config.ts` and `config.yaml`
- Modify `usbDeviceMonitor.ts` to skip mount/umount in test mode
- Write `test/harness/diskSim.ts`
- Write first automated test: `disk-dock-undock.test.ts`

**PR 2 — Engine battery**
- Write `compose-engine-test.yaml`
- Write `test/harness/engineBattery.ts`
- Write `multi-engine-sync.test.ts` and `engine-join-leave.test.ts`

**PR 3 — Framework migration + cleanup**
- Migrate from Mocha → Vitest
- Restructure test directory as above
- Update `pnpm test` and `pnpm test:full` scripts in `package.json`

**PR 4 — App version & upgrade tests**
- Write `test/fixtures/` disk directories for kolibri v1.0, v1.1, v2.0
- Implement `isMinorUpdate(vA, vB)` in the Engine (if not yet present)
- Write `test/automated/app-versioning.test.ts`
- Write `test/automated/app-upgrade.test.ts`
- Write `test/acceptance/app-upgrade.test.ts` (interactive, excluded from `pnpm test`)

---

## Open Questions

1. **Docker-in-Docker for instance tests?** Starting actual Docker containers inside the engine
   battery containers is possible but complex. Recommend deferring — assert status only.

2. **mDNS vs explicit connect** — the explicit connect approach means we do not test peer
   *discovery*. Is that acceptable for the automated suite, or should we find a way to run
   mDNS across Docker networks?

3. **CI environment** — where will automated tests run? If on a Pi, the Docker Compose battery
   may need ARM images. If on a developer laptop (x86), cross-compilation is needed for the
   production image but not for test runs (Node.js is portable).

4. **`/dev/engine` permissions** — writing to `/dev/engine` in test mode may require root or a
   named group. Should we change the watch path to something under `/tmp` in test mode to avoid
   permission issues in CI?

5. **Version comparison logic** — currently `Version` is a plain string and can be a semver tag
   (`1.0`, `1.1`) or a git commit hash. The upgrade proposal tests require a `isMinorUpdate(vA, vB)`
   function. Should this use strict semver (major.minor.patch), or is a simpler
   major-only check (first number) sufficient for the current app set?

6. **App acceptance test automation** — the Kolibri data-compatibility test requires creating
   content in Kolibri v1, then verifying it survives the upgrade. Is this done manually
   (human creates content, presses Enter) or can it be scripted via the Kolibri REST API?
