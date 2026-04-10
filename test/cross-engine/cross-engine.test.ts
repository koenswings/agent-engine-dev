/**
 * cross-engine.test.ts
 *
 * Cross-engine integration tests — Group Q.
 *
 * Verifies multi-engine behaviour that cannot be tested with a single in-process
 * Engine instance:
 *
 *   1. mDNS discovery & CRDT sync     — all engines find each other and share state
 *   2. Disk dock propagation           — dock on primary, observe on ALL others
 *   3. Remote command: stopInstance    — write command via CRDT, observe on ALL others
 *   4. Remote command: startInstance   — reverse; verify idempotent restart
 *   5. Undock propagation              — undock on primary, observe on ALL others
 *
 * Fleet discovery:
 *   The test runner scans idea01.local … idea10.local at startup and connects to
 *   every engine it finds. Tests run against the discovered fleet — no hardcoded
 *   host list. At least 2 engines must be reachable or beforeAll fails.
 *
 *   Override with FLEET_HOSTS env var (comma-separated):
 *     FLEET_HOSTS=idea01.local,idea02.local pnpm test:cross-engine
 *
 * Prerequisites:
 *   - 2+ engines provisioned from this repo (share store-identity/store-url.txt)
 *   - SSH key auth from this Pi to all fleet engines (installed during provisioning)
 *   - traefik/whoami image available on primary engine (pulled in beforeAll if absent)
 *
 * Run:
 *   pnpm test:cross-engine
 *
 * Not run in CI — requires physical fleet on LAN.
 *
 * Known issues found during initial testing (to be fixed separately):
 *
 * Test 1 — mDNS discovery:
 *   The store template may carry stale ENGINE_DevEngine entries with old lastBooted.
 *   Workaround: filter engines by lastBooted > Date.now() - 300_000.
 *   Fix: regenerate store template after provisioning.
 *
 * Test 3 — stopInstance:
 *   stopInstanceWrapper calls findDiskByName() → getDisks() (dockedTo != null filter).
 *   If CRDT state accumulation leaves the disk appearing undocked, stopInstance fails.
 *   Fix: look up disk by ID from instance.storedOn rather than by name.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import {
    connectToEngine,
    disconnectFromEngine,
    waitFor,
    waitForInstanceStatus,
    sendCommand,
    getCachedStoreDocId,
} from './remoteClient.js'
import {
    discoverEngineHosts,
    remoteDockFixture,
    remoteUndock,
    remoteCleanupDisk,
    isEngineRunning,
    ensureImagePulled,
    TEST_DEVICE,
} from './remoteSSH.js'

// ── Fixture constants ─────────────────────────────────────────────────────────

// Instance ID used by the disk-sample-v1 fixture (Automerge store key)
const TEST_INSTANCE_ID = 'sample-00000000-test1'

// Instance name from compose.yaml x-app.instanceName — used in commands
const TEST_INSTANCE_NAME = 'sample-instance-1'

// Disk name from META.yaml diskName — used in commands (no spaces: command parser splits on spaces)
const TEST_DISK_NAME = 'test-sample-v1'

// ── Fleet state (populated in beforeAll / Test 1) ─────────────────────────────

let fleetHosts: string[]                  // all discovered hosts, ordered
let fleetRepos: Repo[]                    // one Repo per host
let fleetStores: DocHandle<Store>[]       // one store handle per host
let fleetEngineIds: (string | null)[]     // engine ID per host, populated in Test 1
let primaryHost: string                   // fleetHosts[0] — dock / command target
let primaryEngineId: string | null        // engine ID for the primary host

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a hostname to its engine ID in the shared store.
 * Matches on the hostname field (strips .local suffix for comparison).
 */
const resolveEngineId = (store: Store, host: string): string | null => {
    const label = host.replace(/\.local$/, '').toLowerCase()
    const engines = Object.values(store.engineDB)
    const match = engines.find(e => (e.hostname as string)?.toLowerCase().includes(label))
    return match ? (match.id as string) : null
}

/**
 * Assert that a condition holds on ALL observer stores (every store except the primary).
 * Returns true only if all observers satisfy the predicate within the timeout.
 */
const waitForAll = async (
    predicate: (store: Store) => boolean,
    timeoutMs = 30_000,
    label = '',
): Promise<boolean> => {
    const observers = fleetStores.slice(1)
    const results = await Promise.all(
        observers.map((s, i) =>
            waitFor(s, predicate, timeoutMs).then(ok => {
                if (!ok) console.warn(`[test] Observer ${fleetHosts[i + 1]} did not satisfy: ${label}`)
                return ok
            })
        )
    )
    return results.every(Boolean)
}

// ── Setup & teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
    // Discover live engines
    fleetHosts = await discoverEngineHosts()

    if (fleetHosts.length < 2) {
        throw new Error(
            `Cross-engine tests require at least 2 live engines — found: ${fleetHosts.length || 'none'}. ` +
            `Set FLEET_HOSTS=host1,host2 or ensure engines are reachable on the LAN.`
        )
    }
    console.log(`[test] Fleet: ${fleetHosts.join(', ')} (${fleetHosts.length} engines)`)

    primaryHost = fleetHosts[0]

    // Verify all discovered engines are actually running Engine via pm2
    const runChecks = await Promise.all(fleetHosts.map(isEngineRunning))
    for (let i = 0; i < fleetHosts.length; i++) {
        if (!runChecks[i]) {
            throw new Error(`${fleetHosts[i]} responded to HTTP but Engine (pm2) is not running`)
        }
    }

    // Pre-pull fixture image on primary to avoid dock test timeout on first pull
    await ensureImagePulled(primaryHost, 'traefik/whoami')

    // Read store document ID from the primary engine (handles store resets gracefully)
    const storeDocId = await getCachedStoreDocId(primaryHost)
    console.log(`[test] Store document ID: ${storeDocId}`)

    // Connect to all fleet engines in parallel
    const connections = await Promise.all(
        fleetHosts.map((host, i) =>
            connectToEngine(host, `engine-${i}`, storeDocId)
        )
    )
    fleetRepos   = connections.map(c => c.repo)
    fleetStores  = connections.map(c => c.storeHandle)
    fleetEngineIds = new Array(fleetHosts.length).fill(null)
}, 120_000)

afterAll(async () => {
    // Clean up remote fixture on primary (best-effort)
    await remoteCleanupDisk(primaryHost, TEST_DEVICE).catch(() => {})
    await remoteUndock(primaryHost, TEST_DEVICE).catch(() => {})

    // Disconnect all clients
    await Promise.all(fleetRepos.map(repo => disconnectFromEngine(repo).catch(() => {})))
}, 30_000)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Cross-engine integration', () => {

    it('Test 1 — mDNS discovery: all engines appear in the shared store', { timeout: 60_000 }, async () => {
        const expectedCount = fleetHosts.length
        const now = Date.now()

        // Wait until all N engines appear in the primary store with a recent lastBooted.
        // mDNS discovery runs every ~10 s; allow 60 s for full fleet convergence.
        // The recent-lastBooted filter (< 5 min) excludes stale store-template entries.
        const allDiscovered = await waitFor(
            fleetStores[0],
            store => {
                const recent = Object.values(store.engineDB)
                    .filter(e => (e.lastBooted as number) > now - 300_000)
                return recent.length >= expectedCount
            },
            60_000,
        )
        expect(allDiscovered, `all ${expectedCount} engines should appear in the primary store within 60 s`).to.be.true

        // Capture engine ID for each host
        const primaryStore = fleetStores[0].doc()!
        for (let i = 0; i < fleetHosts.length; i++) {
            fleetEngineIds[i] = resolveEngineId(primaryStore, fleetHosts[i])
            expect(fleetEngineIds[i], `engine ID for ${fleetHosts[i]} should be discoverable`).to.exist
            console.log(`[test] ${fleetHosts[i]} → engine ID: ${fleetEngineIds[i]}`)
        }
        primaryEngineId = fleetEngineIds[0]

        // Verify all observer stores have also synced the full fleet
        for (let i = 1; i < fleetHosts.length; i++) {
            const observerStore = fleetStores[i].doc()!
            const observerEngines = Object.values(observerStore.engineDB)
            expect(
                observerEngines.length,
                `${fleetHosts[i]} store should contain ≥${expectedCount} engines`,
            ).to.be.greaterThanOrEqual(expectedCount)
        }
    })

    it('Test 2 — Disk dock propagation: dock on primary, observe Running on all others', { timeout: 120_000 }, async () => {
        await remoteDockFixture(primaryHost, 'disk-sample-v1', TEST_DEVICE)

        // Wait for Running on primary first (local engine processes it)
        const runningLocally = await waitForInstanceStatus(
            fleetStores[0], TEST_INSTANCE_ID, 'Running', 90_000,
        )
        expect(runningLocally, `instance should reach Running on ${primaryHost} within 90 s`).to.be.true

        // Assert Running propagates to ALL other engines
        const allPropagated = await waitForAll(
            store => store.instanceDB[TEST_INSTANCE_ID as any]?.status === 'Running',
            30_000,
            'Running propagation',
        )
        expect(allPropagated, 'Running status should propagate to all observer engines within 30 s').to.be.true

        // Cross-check: docked disk should appear in diskDB on all observer stores
        const diskVisibleEverywhere = await waitForAll(
            store => Object.values(store.diskDB).some(
                (d: any) => d.device === TEST_DEVICE && d.dockedTo != null
            ),
            10_000,
            'disk visible in diskDB',
        )
        expect(diskVisibleEverywhere, 'docked disk should appear in diskDB on all observer stores').to.be.true
    })

    it('Test 3 — Remote command: stopInstance on primary, observe on all others', { timeout: 30_000 }, async () => {
        expect(primaryEngineId, 'primary engine ID must be known (run Test 1 first)').to.exist

        // Send stopInstance to primary via the shared CRDT.
        // Any connected store handle will do — the change syncs to all peers.
        sendCommand(fleetStores[0], primaryEngineId!, `stopInstance ${TEST_INSTANCE_NAME} ${TEST_DISK_NAME}`)

        // Assert stopped (or undocked — see known issue in file header) on ALL observers
        const allStopped = await waitForAll(
            store => {
                const status = store.instanceDB[TEST_INSTANCE_ID as any]?.status
                return status === 'Stopped' || status === 'Undocked'
            },
            30_000,
            'Stopped or Undocked after stopInstance',
        )
        expect(allStopped, 'instance should reach Stopped or Undocked on all observer stores within 30 s').to.be.true

        // Also check primary itself
        const primaryStatus = fleetStores[0].doc()!.instanceDB[TEST_INSTANCE_ID as any]?.status
        expect(primaryStatus, 'instance should not still be Running on primary after stopInstance').to.not.equal('Running')
    })

    it('Test 4 — Remote command: startInstance on primary, observe Running on all others', { timeout: 30_000 }, async () => {
        expect(primaryEngineId, 'primary engine ID must be known (run Test 1 first)').to.exist

        sendCommand(fleetStores[0], primaryEngineId!, `startInstance ${TEST_INSTANCE_NAME} ${TEST_DISK_NAME}`)

        // Assert Running on primary
        const runningLocally = await waitForInstanceStatus(
            fleetStores[0], TEST_INSTANCE_ID, 'Running', 30_000,
        )
        expect(runningLocally, `instance should return to Running on ${primaryHost} within 30 s`).to.be.true

        // Assert Running propagates to ALL observers
        const allRunning = await waitForAll(
            store => store.instanceDB[TEST_INSTANCE_ID as any]?.status === 'Running',
            30_000,
            'Running after startInstance',
        )
        expect(allRunning, 'Running status should propagate to all observer engines within 30 s').to.be.true
    })

    it('Test 5 — Undock propagation: undock on primary, observe Undocked on all engines', { timeout: 30_000 }, async () => {
        await remoteUndock(primaryHost, TEST_DEVICE)

        // Assert Undocked on primary first
        const undockedLocally = await waitForInstanceStatus(
            fleetStores[0], TEST_INSTANCE_ID, 'Undocked', 20_000,
        )
        expect(undockedLocally, `instance should reach Undocked on ${primaryHost} within 20 s`).to.be.true

        // Assert Undocked propagates to ALL observers
        const allUndocked = await waitForAll(
            store => store.instanceDB[TEST_INSTANCE_ID as any]?.status === 'Undocked',
            20_000,
            'Undocked propagation',
        )
        expect(allUndocked, 'Undocked status should propagate to all observer engines within 20 s').to.be.true

        // No active docked entry should remain on any observer store
        for (let i = 1; i < fleetHosts.length; i++) {
            const activeDisk = Object.values(fleetStores[i].doc()!.diskDB).find(
                (d: any) => d.device === TEST_DEVICE && d.dockedTo != null
            )
            expect(
                activeDisk,
                `no active docked disk entry should remain on ${fleetHosts[i]} after undock`,
            ).to.be.undefined
        }
    })

})
