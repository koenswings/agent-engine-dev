# Design: Native Engine Test Setup

**Status:** Partially Implemented (PR 5 of 6 complete — disk simulation + instance lifecycle + app versioning + engine network + field health diagnostic)  
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
export const dockFixture = async (fixturePath: string, device = TEST_DEVICE): Promise<void> => {
    await fs.ensureDir(DISKS_ROOT)   // /disks/ — must be writable by the test runner
    await fs.ensureDir(DEV_ROOT)     // /dev/engine/ — must be writable by the test runner
    await fs.copy(fixturePath, `${DISKS_ROOT}/${device}`, { overwrite: true })
    await fs.writeFile(`${DEV_ROOT}/${device}`, '')  // triggers chokidar → addDevice()
}

export const triggerUndock = async (device = TEST_DEVICE): Promise<void> => {
    await fs.remove(`${DEV_ROOT}/${device}`)
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

## Multi-Engine App Assignment

When running Tier 2 tests with N engines and M app disks (fixtures), the harness must
decide which fixture goes to which engine. The goal: deterministic, balanced, and
trivially scalable.

**Scheme: sorted round-robin**

Sort all app fixture identifiers alphabetically, then assign by index modulo engine
count:

```typescript
// test/harness/networkDiscovery.ts

export const assignAppsToEngines = (
    apps: AppFixture[],
    engines: EngineHost[],
): Array<{ app: AppFixture; engine: EngineHost }> => {
    const sorted = [...apps].sort((a, b) => a.appId.localeCompare(b.appId))
    return sorted.map((app, i) => ({ app, engine: engines[i % engines.length] }))
}
```

This scales to any N and M:

| Situation | Result |
|---|---|
| N = 1 | All apps on local engine — degrades to Tier 1 |
| N = M | One app per engine — cleanest case |
| N < M | Some engines host multiple apps — tests concurrent instance lifecycle |
| N > M | Some engines get no apps — still tested for startup, mDNS, and sync |

The harness docks each fixture to its assigned engine. For remote engines this is done
via SSH: copy the fixture directory to the Pi, then touch the sentinel file. For the
local engine the existing `diskSim.ts` helpers are used directly.

---

## Diagnostic Mode (Offline / Field)

A production engine in a school can be tested in the field — no internet, no fixture
disks, no CI. The diagnostic mode reuses the same harness infrastructure but operates
on the real system as found.

**Key principle:** `testMode: true` skips `sudo mount/umount` only. In the field, app
disks are already physically mounted at `/disks/<device>/`. Enabling `testMode`
therefore lets the harness replay dock/undock events via the `/dev/engine/<device>`
sentinel file without touching the actual mount. The disk stays mounted; the engine
just re-processes it.

`testMode` serves double duty:
- **Dev/CI:** disk content is a fixture directory; sentinel triggers first processing
- **Field diagnostic:** disk content is real (already mounted); sentinel triggers
  re-processing without unmounting — the OS mount is never touched

**Running a diagnostic:**
```bash
pnpm test:diagnostic
```

This switches the harness into discovery mode:

1. **Discover** — enumerate currently mounted disks from `/disks/` and from Automerge
   store (so peers' disks are included if engines are networked)
2. **Cycle** — for each local disk: remove sentinel → wait for instance to stop →
   recreate sentinel → wait for instance to reach `Running`
3. **Smoke test** — run HTTP health checks against each restarted instance; no image
   pulls, no network required
4. **Sync check** — if mDNS peers are present, confirm that the cycled disk's
   Automerge state propagates to at least one peer within the discovery window
5. **Report** — per-app pass/fail; any instance that fails to reach `Running` within
   the timeout is flagged

**Constraints in diagnostic mode:**

- **No image pulls.** All required Docker images must already be present in the local
  cache. Tests that would require a pull are skipped, not failed.
- **No fixtures.** The harness does not copy any fixture directories; it tests what is
  physically connected.
- **No destructive steps.** The diagnostic never removes disk content, never runs
  `docker compose down --volumes`, and never modifies Automerge state beyond what the
  normal dock/undock cycle would do.
- **`testMode` must be enabled** in `config.yaml` for the diagnostic to work without
  requiring physical plug/unplug. On a system where `testMode` is not set, the
  diagnostic skips the cycle step and runs smoke tests only against already-running
  instances.

**Diagnostic vs standard test suite:**

| | Standard (`pnpm test`) | Diagnostic (`pnpm test:diagnostic`) |
|---|---|---|
| Disk content | Fixtures | Real disks |
| Docker images | Pre-pulled (or pulled at setup) | Must already be cached |
| Internet required | For image pull | Never |
| Runs on | Dev machine or Pi | Production Pi only |
| Dock/undock | Simulated via sentinel | Replayed via sentinel (disk stays mounted) |
| Destructive | No | No |

---

## Test Structure

```
test/
  00-config.test.ts              config loading and validation
  automated/
    engine-startup.test.ts       engine starts, store initialises
    disk-dock-undock.test.ts     disk dock/undock → Automerge state
    instance-lifecycle.test.ts   start, Running, stop cycle
    app-versioning.test.ts       version read from disk, appDB populated
    app-upgrade.test.ts          minor/major upgrade proposal logic
    app-smoke.test.ts            dock real disk → app Running → smoke tests pass
    app-ui.test.ts               dock real disk → Playwright UI tests pass
    network-sync.test.ts         (tier 2) mDNS, CRDT sync, remote commands
    engine-join-leave.test.ts    (tier 2) remove/add remote engine, sync resumes
  diagnostic/
    field-health.test.ts         discover real disks, cycle dock/undock, smoke test
  fixtures/
    disk-kolibri-v1/
    disk-kolibri-v1.1/
    disk-kolibri-v2.0/
    disk-kiwix-v1/
  harness/
    diskSim.ts
    appRunner.ts
    networkDiscovery.ts          includes assignAppsToEngines()
    waitFor.ts
```

`pnpm test` runs everything. Tier 2 tests auto-skip if no peers are found.
`pnpm test:diagnostic` runs field-health tests only against real connected disks.

---

## Prerequisites

| Requirement | Local only | With remote engines | Diagnostic |
|---|---|---|---|
| Docker installed and running | ✓ | ✓ | ✓ |
| `/disks/` and `/dev/engine/` writable by test runner | ✓ | ✓ | ✓ |
| App images pre-pulled | ✓ | ✓ | must already be cached |
| Playwright browsers installed | ✓ | ✓ | — |
| SSH key on remote Pis | — | ✓ | — |
| Remote Pis on same LAN | — | ✓ | optional |
| Remote Pis running engine service | — | ✓ | optional |
| Real app disks connected | — | — | ✓ |
| Internet access | for image pull | for image pull | never |
| `testMode: true` in config | ✓ | ✓ | recommended |

---

## What This Covers

| Area | Standard tests | Diagnostic mode |
|---|---|---|
| Engine config and startup | ✓ | — |
| Disk dock/undock (simulated hardware) | ✓ | ✓ (real disk, sentinel replay) |
| App metadata read and stored | ✓ | ✓ |
| App containers start (real Docker) | ✓ | ✓ |
| App smoke tests (HTTP) | ✓ | ✓ |
| App UI tests (Playwright) | ✓ | — |
| Version detection and comparison | ✓ | — |
| Upgrade proposal (minor/major logic) | ✓ | — |
| Data survival across minor upgrade | ✓ | — |
| mDNS advertisement and discovery | ✓ (tier 2) | ✓ (if peers present) |
| CRDT sync across engines | ✓ (tier 2) | ✓ (if peers present) |
| Engine join and leave | ✓ (tier 2) | — |
| Remote command propagation | ✓ (tier 2) | — |
| Multi-engine app assignment (round-robin) | ✓ (tier 2) | — (test real layout) |
| USB mount/unmount syscalls | ✗ (simulated) | ✗ (simulated) |
| Real USB hardware detection | ✗ (simulated) | ✗ (simulated) |
| Works without internet | ✗ (image pull) | ✓ |
| Works on production system | ✗ (fixtures needed) | ✓ |

---

## Store Assertions

Every test that touches the Automerge store must verify specific fields — not just that
the engine "did something". The tables below document the complete assertion contract
for each test file. Fields in _italics_ are not yet asserted (planned in the PR noted).

---

### PR 1 — `disk-dock-undock.test.ts`

Assertions against `diskDB` only.

| Test | Store field | Assertion |
|---|---|---|
| dock | `diskDB[*].device` | some entry has `device === TEST_DEVICE` |
| dock | `diskDB[*].dockedTo` | that entry has `dockedTo === localEngineId` |
| dock | `diskDB[*].id` | that entry's `id` includes the fixture name |
| undock | `diskDB[*]` | no entry with `device === TEST_DEVICE` AND `dockedTo === localEngineId` |
| re-dock | `diskDB[*].device` + `.dockedTo` | same as dock |

---

### PR 2 — `instance-lifecycle.test.ts`

Assertions against `instanceDB`, `appDB`, `diskDB`, and one out-of-store HTTP check.

**After dock (instance reaches `Running`):**

| Store field | Assertion |
|---|---|
| `instanceDB[id].status` | `=== 'Running'` |
| `instanceDB[id].port` | `> 0` |
| `instanceDB[id].storedOn` | is a string (disk id) |
| `instanceDB[id].instanceOf` | is a string containing the app name |
| `instanceDB[id].name` | is a non-empty string |
| `instanceDB[id].serviceImages` | is a non-empty array |
| `instanceDB[id].created` | `> 0` (set at first dock) |
| `instanceDB[id].lastStarted` | `> 0` (set when `runInstance` fires) |
| `appDB` | at least one entry whose key includes the app name |
| _(out of store)_ | HTTP GET on `localhost:${port}` returns 2xx |

**After undock (instance reaches `Undocked`):**

| Store field | Assertion |
|---|---|
| `instanceDB[id]` | entry still exists (retained by design — not deleted on undock) |
| `instanceDB[id].status` | `=== 'Undocked'` |
| `diskDB` | no entry with `device === TEST_DEVICE` AND `dockedTo !== null` |
| _(out of store)_ | HTTP GET on same port times out (no response) |

---

### PR 3 — `app-versioning.test.ts`

Tests version tracking when the same disk is re-docked with a newer minor version
(same instance ID, updated `x-app.version` in compose.yaml).

| Test | Store field | Assertion |
|---|---|---|
| v1.0 dock | `instanceDB[id].instanceOf` | `=== 'sample-1.0'` |
| v1.0 dock | `instanceDB[id].lastStarted` | `> 0` |
| minor upgrade (v1.1) | `instanceDB[id].instanceOf` | `=== 'sample-1.1'` (updated from disk) |
| minor upgrade (v1.1) | `instanceDB[id].lastStarted` | `>` previous `lastStarted` (refreshed) |

**Not tested here — cross-disk upgrade detection (planned, separate PR):**

When Disk B (newer version) is docked alongside Disk A (older version of same app),
the Engine should write an upgrade proposal to the store. Major versions are not
proposed (data-format incompatible). See `isMajorUpgrade()` in `App.ts`.

---

### PR 4 — `engine-network.test.ts`

**Suite 1 — Engine registration (always runs):**

| Store field | Assertion |
|---|---|
| `engineDB[localEngineId]` | exists after store initialisation |
| `engineDB[localEngineId].id` | `=== localEngineId` |
| `engineDB[localEngineId].hostname` | non-empty string |
| `engineDB[localEngineId].lastBooted` | `> 0` |
| `engineDB[localEngineId].lastHalted` | `=== null` (first boot) |
| `engineDB[localEngineId].version` | non-empty string |
| `getLocalEngine(store)` | returns the registered engine |
| `getRunningEngines(store)` | includes localEngineId |

**Suite 2 — `assignAppsToEngines()` (always runs, pure function):**

| Scenario | Assertion |
|---|---|
| 0 engines | returns empty Map |
| 1 engine, 3 instances | all 3 assigned to the single engine |
| 2 engines, 4 instances | 2 each (round-robin) |
| 2 engines, 3 instances | 2 and 1 |
| halted engine | excluded from assignment |
| repeated calls | deterministic — identical output each time |

**Suite 3 — Multi-engine network (skips unless `IDEA_NETWORK_TESTS=true`):**

| Store field | Assertion |
|---|---|
| `engineDB[remoteEngineId]` | appears within mDNS discovery window |
| `getRunningEngines(store)` | includes both local and remote engines |
| CRDT sync | remote store reflects local `diskDB`/`instanceDB` changes |
| `engineDB[remoteEngineId].lastHalted` | `> lastBooted` after peer disconnect |

---

### PR 5 — `test/diagnostic/field-health.test.ts`

Two modes: **fixture** (default, always runs) and **live** (`IDEA_DIAGNOSTIC_LIVE=true`).

Run with: `pnpm test:diagnostic` — writes a timestamped report to `test/testresults/`.

**Fixture mode (12 tests):**

| Field | Assertion |
|---|---|
| `id` | non-empty string |
| `instanceOf` | non-empty string containing app name |
| `name` | non-empty string |
| `status` | `=== 'Running'` |
| `port` | `> 0` |
| `storedOn` | non-empty string (disk id) |
| `serviceImages` | non-empty array; each element is a Docker image reference string |
| `created` | `> 0` (timestamp, set at first dock) |
| `lastStarted` | `> 0` (timestamp, set when `runInstance` fires) |
| `lastBackedUp` | `>= 0` (0 = never backed up; must never be `undefined`) |
| HTTP health | GET on `localhost:${port}` returns 2xx |

**Live mode (2 tests, skips unless `IDEA_DIAGNOSTIC_LIVE=true`):**

Reads the real store from `./store-identity/store-url.txt`. Checks all currently
running instances. If no instances are running, passes with no assertions.
Use on a field Pi to verify system health without touching hardware.

---

### Not asserted (by design)

| Field | Reason |
|---|---|
| `instanceDB[id].lastBackedUp` (PR 1–4) | Backup feature not yet implemented; field stays `0` |
| `engineDB` in Tier 1 tests | Only meaningful in multi-engine context (PR 4) |
| `diskDB` during lifecycle tests (PR 1) | Covered in `disk-dock-undock.test.ts`; lifecycle tests cross-check only after undock |

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

**PR 4 — Multi-engine tests**
- Write `test/harness/networkDiscovery.ts` with `assignAppsToEngines()` (round-robin)
- Write `test/automated/network-sync.test.ts`
- Write `test/automated/engine-join-leave.test.ts`
- Add SSH remote control helpers
- Update Pi provisioning to install test SSH key

**PR 5 — Diagnostic mode**
- Add `pnpm test:diagnostic` script
- Write `test/diagnostic/field-health.test.ts`
- Harness discovers real disks, replays sentinel dock/undock, runs smoke tests
- Report per-app pass/fail to terminal; skip any test requiring image pull

**PR 6 — Framework migration**
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

5. **Diagnostic `testMode` in production** — enabling `testMode` in production `config.yaml`
   lets the diagnostic cycle disks without physical plug/unplug. Should `testMode` be the
   default on Pi builds so diagnostics always work, or should it be an explicit opt-in set
   by the technician running the test? (Implication: if `testMode` is off on a production
   system, the diagnostic can only smoke-test already-running instances, not cycle them.)

6. **Diagnostic reporting** — output format for field use: terminal only, or write a
   machine-readable report file to the disk (e.g., `META.yaml` test-results block) that
   can be read back when the disk is returned to base?
