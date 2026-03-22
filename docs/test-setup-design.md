# Design: Automated Test Setup

**Status:** Proposed  
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
  00-config.test.ts           existing, keep
  01-e2e-execution.test.ts    existing, keep for interactive mode
  automated/
    disk-dock-undock.test.ts  dock/undock a disk, verify Automerge state
    instance-lifecycle.test.ts start/stop instances on docked disk
    multi-engine-sync.test.ts dock disk on engine-1, assert engine-2+3 see it
    engine-join-leave.test.ts remove engine-2, dock disk, re-add, assert sync
  harness/
    diskSim.ts                dock/undock helpers
    engineBattery.ts          compose start/stop/add/remove helpers
    waitFor.ts                polling assertion helper (already in test runner, extract)
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

---

## 6. What This Does Not Cover

- Actual Docker container startup for app instances (requires Docker-in-Docker or real hardware)
  — instances can be asserted in `Starting` state; Docker execution is out of scope for automated tests
- mDNS peer discovery (bypassed by explicit connect)
- USB mount/unmount syscalls (bypassed by test mode flag)
- Real disk I/O (simulated directories)

These gaps are acceptable. The scenarios above cover the Engine's core responsibilities:
**state management, event processing, and CRDT sync**.

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
