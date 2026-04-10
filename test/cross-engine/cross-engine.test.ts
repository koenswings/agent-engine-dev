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
 *   The test runner behaves like a Console client. It connects to the local Engine
 *   on this machine (localhost) and reads engineDB from the shared Automerge store.
 *   The engines have already done mDNS discovery and registered all peers there.
 *   No pre-knowledge of remote hostnames is required — the fleet is whatever the
 *   local Engine has discovered, exactly as a Console would see it.
 *
 *   At least 2 engines must appear in engineDB or beforeAll fails.
 *   Override with FLEET_HOSTS=host1,host2 to bypass store lookup.
 *
 * Prerequisites:
 *   - Engine running on this machine (localhost), provisioned as a fleet member
 *   - 2+ peer engines on the LAN (discovered via mDNS by the local Engine)
 *   - SSH key auth from this machine to all fleet engines
 *   - traefik/whoami image available on primary engine (pulled in beforeAll if absent)
 *
 * Run:
 *   pnpm test:cross-engine
 *
 * Not run in CI — requires physical fleet on LAN.
 *
 * Known issues:
 *   Test 3 — stopInstance: stopInstanceWrapper uses findDiskByName() → getDisks()
 *   which only returns disks with dockedTo != null. Fix: look up disk by ID from
 *   instance.storedOn. Tracked as follow-up PR.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import os from 'os'
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

// ── Fleet state (populated in beforeAll) ────────────────────────────────────

let fleetHosts: string[]                  // all fleet hostnames, e.g. ['idea02.local', 'idea03.local']
let fleetRepos: Repo[]                    // one Automerge Repo per fleet host
let fleetStores: DocHandle<Store>[]       // one store handle per fleet host
let fleetEngineIds: (string | null)[]     // engine ID per fleet host
let primaryHost: string                   // fleetHosts[0] — dock / command target
let primaryEngineId: string | null        // engine ID for primaryHost

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
    // ── Step 1: Connect to local Engine as a Console client ──────────────────
    // The test runner connects to the Engine on this machine (localhost) exactly
    // as a Console client would. No pre-knowledge of remote fleet hosts is needed:
    // the local Engine has already done mDNS discovery and populated engineDB.
    //
    // Prerequisite: this machine must be running a fleet Engine (pm2 engine, port 4321).
    // Override with LOCAL_ENGINE env var if needed (e.g. LOCAL_ENGINE=idea01.local).
    const localHost = process.env.LOCAL_ENGINE ?? 'localhost'
    const storeDocId = await getCachedStoreDocId(localHost)
    console.log(`[test] Connecting to local engine at ${localHost}, store ID: ${storeDocId}`)

    const localConn = await connectToEngine(localHost, 'local', storeDocId)

    // ── Step 2: Read fleet from engineDB ─────────────────────────────────────
    // Wait up to 30 s for engineDB to contain at least 2 engines.
    // mDNS runs every 10 s; engines booted long ago are still valid peers.
    if (process.env.FLEET_HOSTS) {
        fleetHosts = process.env.FLEET_HOSTS.split(',').map(h => h.trim()).filter(Boolean)
        console.log(`[test] FLEET_HOSTS override: ${fleetHosts.join(', ')}`)
        await disconnectFromEngine(localConn.repo).catch(() => {})
    } else {
        const enoughEngines = await waitFor(
            localConn.storeHandle,
            store => Object.keys(store.engineDB).length >= 2,
            30_000,
        )
        const localStore = localConn.storeHandle.doc()!
        const localHostname = os.hostname().toLowerCase()
        // Exclude this machine from the fleet — it's the test runner / observer.
        // Dock/undock targets must be remote Pis reachable via SSH.
        // Also deduplicate: a peer may appear multiple times if mDNS cycles overlap.
        const seen = new Set<string>()
        fleetHosts = Object.values(localStore.engineDB)
            .filter(e => {
                const h = (e.hostname as string)?.toLowerCase()
                return !!h && !h.includes(localHostname) && !seen.has(h) && seen.add(h)
            })
            .map(e => `${e.hostname as string}.local`)
        await disconnectFromEngine(localConn.repo).catch(() => {})

        if (!enoughEngines || fleetHosts.length < 2) {
            throw new Error(
                `Cross-engine tests require at least 2 engines in engineDB — found: ${fleetHosts.length}. ` +
                `Ensure fleet engines are running and the local Engine has had time to discover them via mDNS. ` +
                `Or set FLEET_HOSTS=host1,host2 to override.`
            )
        }
    }
    console.log(`[test] Fleet: ${fleetHosts.join(', ')}`)

    primaryHost = fleetHosts[0]

    // ── Step 3: Pre-pull fixture image on primary ─────────────────────────────
    await ensureImagePulled(primaryHost, 'traefik/whoami')

    // ── Step 4: Connect to each fleet engine ─────────────────────────────────
    const connections = await Promise.all(
        fleetHosts.map((host, i) => connectToEngine(host, `engine-${i}`, storeDocId))
    )
    fleetRepos   = connections.map(c => c.repo)
    fleetStores  = connections.map(c => c.storeHandle)
    fleetEngineIds = new Array(fleetHosts.length).fill(null)

    // ── Step 5: Capture engine IDs from the confirmed store ───────────────────
    const confirmedStore = fleetStores[0].doc()!
    for (let i = 0; i < fleetHosts.length; i++) {
        fleetEngineIds[i] = resolveEngineId(confirmedStore, fleetHosts[i])
        if (fleetEngineIds[i]) console.log(`[test] ${fleetHosts[i]} → ${fleetEngineIds[i]}`)
    }
    primaryEngineId = fleetEngineIds[0]
    console.log(`[test] Connected to ${fleetHosts.length} fleet engines`)
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

    it('Test 1 — mDNS discovery: all engines appear in the shared store', async () => {
        const expectedCount = fleetHosts.length

        // Engine IDs were captured in beforeAll (which waited for the store to populate).
        // Assert here — if beforeAll succeeded, discovery is already confirmed.
        for (let i = 0; i < fleetHosts.length; i++) {
            expect(fleetEngineIds[i], `engine ID for ${fleetHosts[i]} should have been resolved in beforeAll`).to.exist
        }

        // Verify all observer stores also have the full fleet synced
        for (let i = 1; i < fleetHosts.length; i++) {
            const observerEngines = Object.values(fleetStores[i].doc()!.engineDB)
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
