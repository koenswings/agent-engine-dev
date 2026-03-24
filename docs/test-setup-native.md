# Design: Native Engine Test Setup

**Status:** Proposed  
**Author:** Axle (Engine Developer)  
**Date:** 2025-07-11  
**Backlog item:** Engine — Test setup design

---

## Philosophy

Tests run on a real engine, against real infrastructure. There are no simulated engine
processes, no containers wrapping the engine, and no mocked Docker calls. The test suite
runs wherever the engine runs — a developer's machine, a Raspberry Pi in a lab, or a
battery of Pi devices on the same LAN — and automatically adjusts its scope to what
hardware is available.

This keeps the test environment honest: a passing test means a passing real system.

---

## Test Tiers

The suite has two tiers that are discovered at runtime, not configured:

**Tier 1 — Local** (always runs)

Tests that require only the local engine and its Docker daemon. No network peers needed.
These are the baseline: if they fail, nothing else matters.

- Engine starts and loads config
- Disk dock and undock (simulated, see below)
- App lifecycle: instance starts, reaches `Running`, smoke tests pass
- Instance stop and state cleanup
- App version detection from disk
- Upgrade proposal logic (minor vs major)

**Tier 2 — Network** (runs only if remote engines are found via mDNS)

The test runner scans for `_engine._tcp.local` on startup. If it finds one or more peers,
network tests run. If not, they are skipped with a clear log message — not failed.

- mDNS advertisement: this engine appears to peers
- mDNS discovery: remote engine is visible in local store after scan
- CRDT sync: disk docked on local engine → appears in remote engine's store
- Remote command: `send <engine> stopInstance` → state propagates back
- Engine leave: remote engine stopped → local store reflects offline status
- Engine rejoin: remote engine restarted → sync resumes, missed changes merge
- Engine reboot: remote engine rebooted → `lastBooted` updated in store

---

## Disk Simulation

Real USB hardware is not required. The Engine watches `/dev/engine` via chokidar for device
files. In test mode, the mount and unmount syscalls are skipped; everything else is real.

**`config.yaml` setting:**
```yaml
settings:
  testMode: true
```

**What changes in `testMode`:**
- `sudo mount /dev/<device> /disks/<device>` → skipped
- `sudo umount /disks/<device>` → skipped
- `/disks/<device>/` must be pre-created by the test harness (plain directory)
- All downstream logic — META.yaml reading, app processing, Docker startup — runs normally

**Test harness helpers (`test/harness/diskSim.ts`):**
```typescript
export const dockDisk = async (device: string, diskDir: string): Promise<void> => {
    // 1. Place the fixture disk directory at the expected mount point
    await $`cp -r ${diskDir} /disks/${device}`
    // 2. Touch sentinel file — triggers chokidar watcher → Engine processes disk
    await $`touch /dev/engine/${device}`
}

export const undockDisk = async (device: string): Promise<void> => {
    await $`rm /dev/engine/${device}`
    // Engine detects removal, stops instances, cleans state
}
```

The fixture disk carries the full app structure. When docked, the engine reads
`META.yaml`, reads `apps/<appId>/compose.yaml`, and runs `docker compose up` — exactly
as it would with a real USB disk. The app containers actually start.

---

## App Fixtures

Each fixture is a minimal disk directory that mirrors the real disk layout. It contains
real Docker Compose configuration pointing to real published images.

```
test/fixtures/
  disk-kolibri-v1/
    META.yaml
    apps/
      kolibri-1.0/
        compose.yaml          ← real image: learningequality/kolibri:v0.15
        tests/
          smoke.ts            ← HTTP GET /api/public/info → assert 200
          ui/
            homepage.spec.ts  ← Playwright: load page, assert content visible
  disk-kolibri-v1.1/
    META.yaml
    apps/
      kolibri-1.1/
        compose.yaml          ← image: learningequality/kolibri:v0.16
        tests/
          smoke.ts
          ui/homepage.spec.ts
  disk-kolibri-v2.0/
    ...                       ← major version, incompatible data
  disk-kiwix-v1/
    ...
```

Images are pre-pulled before the test run (`docker pull ...` in test setup). On a Pi
with a slow connection this is done once and cached; in CI it is part of the pipeline.

---

## App Tests

After the engine processes a docked disk and an instance reaches `Running`, the test
harness runs the app's own test suite from the disk. This is a standard hook — if
`tests/` exists on the disk, it runs. If not, the harness moves on.

```typescript
// test/harness/appRunner.ts
export const runAppTests = async (instance: Instance): Promise<void> => {
    const testsDir = `/disks/${instance.device}/apps/${instance.instanceOf}/tests`
    if (!fs.existsSync(testsDir)) return
    const port = instance.port
    await $`cd ${testsDir} && pnpm vitest run --reporter=verbose -- --port ${port}`
}
```

**Smoke tests** (`tests/smoke.ts`) check that the app is alive and serving:

```typescript
it('app responds to health check', async () => {
    const res = await fetch(`http://localhost:${port}/api/public/info`)
    expect(res.status).toBe(200)
})
```

**UI tests** (`tests/ui/homepage.spec.ts`) use Playwright:

```typescript
test('homepage loads and shows content', async ({ page }) => {
    await page.goto(`http://localhost:${port}/`)
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('.channel-list')).toBeVisible()
})
```

App tests live in the **app repo** (`app-kolibri`, `app-kiwix`) and are copied onto the
disk at disk-build time. They are versioned with the app: Kolibri 1.1's tests know what
Kolibri 1.1's UI looks like.

---

## Remote Engine Control

Multi-engine tests require starting, stopping, and rebooting remote Pi devices. Two
mechanisms are available:

**Via the Engine command system** (preferred — uses the same path as real operations):
```typescript
await handleCommand(commands, storeHandle, 'engine', `send engine-2 reboot`)
await handleCommand(commands, storeHandle, 'engine', `send engine-2 stopInstance kolibri`)
```

**Via SSH** (fallback, for engine process control):
```typescript
const stopEngineService = async (hostname: string): Promise<void> => {
    await $`ssh pi@${hostname}.local sudo systemctl stop engine`
}

const startEngineService = async (hostname: string): Promise<void> => {
    await $`ssh pi@${hostname}.local sudo systemctl start engine`
}
```

SSH access requires the test runner's public key to be in the Pi's
`~/.ssh/authorized_keys`. This is part of the Pi provisioning process
(`script/build-engine` should add the test key at build time).

---

## Network Discovery in Tests

The test runner uses the Engine's own mDNS stack to find peers. This tests discovery as a
side effect of running — no mock needed.

```typescript
// test/harness/networkDiscovery.ts

export const discoverPeers = async (timeoutMs = 15000): Promise<string[]> => {
    // Connect to local engine and wait for mDNS to populate the store
    const store = testContext.storeHandle?.doc()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const engines = getRunningEngines(store).filter(e => e.hostname !== localHostname)
        if (engines.length > 0) return engines.map(e => e.hostname)
        await sleep(1000)
    }
    return []
}

export const skipIfNoPeers = (peers: string[]): void => {
    if (peers.length === 0) {
        console.log('No remote engines found on mDNS — skipping network tests')
        return
    }
}
```

---

## Test Structure

```
test/
  00-config.test.ts          config loading and validation
  automated/
    engine-startup.test.ts   engine starts, store initialises
    disk-dock-undock.test.ts disk dock/undock → Automerge state
    instance-lifecycle.test.ts start, Running, stop cycle
    app-versioning.test.ts   version read from disk, appDB populated
    app-upgrade.test.ts      minor/major upgrade proposal logic
    app-smoke.test.ts        dock real disk → app Running → smoke tests pass
    app-ui.test.ts           dock real disk → Playwright UI tests pass
    network-sync.test.ts     (tier 2) mDNS, CRDT sync, remote commands
    engine-join-leave.test.ts (tier 2) remove/add remote engine, sync resumes
  fixtures/
    disk-kolibri-v1/
    disk-kolibri-v1.1/
    disk-kolibri-v2.0/
    disk-kiwix-v1/
  harness/
    diskSim.ts
    appRunner.ts
    networkDiscovery.ts
    waitFor.ts
```

`pnpm test` runs everything. Tier 2 tests auto-skip if no peers are found.

---

## Prerequisites

| Requirement | Local only | With remote engines |
|---|---|---|
| Docker installed and running | ✓ | ✓ |
| App images pre-pulled | ✓ | ✓ |
| Playwright browsers installed | ✓ | ✓ |
| SSH key on remote Pis | — | ✓ |
| Remote Pis on same LAN | — | ✓ |
| Remote Pis running engine service | — | ✓ |

---

## What This Covers

| Area | Coverage |
|---|---|
| Engine config and startup | ✓ |
| Disk dock/undock (simulated hardware) | ✓ |
| App metadata read and stored | ✓ |
| App containers start (real Docker) | ✓ |
| App smoke tests (HTTP) | ✓ |
| App UI tests (Playwright) | ✓ |
| Version detection and comparison | ✓ |
| Upgrade proposal (minor/major logic) | ✓ |
| Data survival across minor upgrade | ✓ |
| mDNS advertisement and discovery | ✓ (tier 2) |
| CRDT sync across engines | ✓ (tier 2) |
| Engine join and leave | ✓ (tier 2) |
| Remote command propagation | ✓ (tier 2) |
| USB mount/unmount syscalls | ✗ (simulated) |
| Real USB hardware detection | ✗ (simulated) |

---

## Implementation Plan

**PR 1 — Disk simulation + local engine tests**
- Add `testMode` flag to `Config.ts`
- Modify `usbDeviceMonitor.ts` to skip mount/umount in test mode
- Write `test/harness/diskSim.ts`
- Write `test/automated/disk-dock-undock.test.ts`
- Write `test/automated/instance-lifecycle.test.ts`

**PR 2 — App tests**
- Create fixture disks with real compose.yaml files
- Write `test/harness/appRunner.ts`
- Write `test/automated/app-smoke.test.ts`
- Write `test/automated/app-ui.test.ts` (Playwright)
- Write `test/automated/app-versioning.test.ts`
- Write `test/automated/app-upgrade.test.ts`

**PR 3 — Network tests**
- Write `test/harness/networkDiscovery.ts`
- Write `test/automated/network-sync.test.ts`
- Write `test/automated/engine-join-leave.test.ts`
- Add SSH remote control helpers
- Update Pi provisioning to install test SSH key

**PR 4 — Framework migration**
- Migrate from Mocha → Vitest
- Update `pnpm test` script
- Retire `test/01-e2e-execution.test.ts` (superseded)

---

## Open Questions

1. **Version comparison** — `Version` is currently a plain string (semver tag or git hash).
   `isMinorUpdate(vA, vB)` needs a definition. Semver strict, or just major-number check?

2. **SSH key distribution** — should `build-engine` add a well-known test key automatically,
   or should this be a separate provisioning step?

3. **Image pre-pull strategy** — pull in test setup (slow first run) or require pre-pulled as
   a documented prerequisite? For CI, pre-pull in pipeline; for Pi, document as setup step.

4. **Port allocation** — multiple app instances in one test run need non-conflicting ports.
   The engine assigns ports; tests should read from Automerge rather than hardcoding.
