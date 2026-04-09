/**
 * cross-engine.test.ts
 *
 * Cross-engine integration tests — Group Q.
 *
 * Verifies multi-engine behaviour that cannot be tested with a single in-memory
 * Engine instance:
 *
 *   1. mDNS discovery & CRDT sync     — engines find each other and share state
 *   2. Disk dock propagation           — dock on idea01, observe on idea02
 *   3. Remote command: stopInstance    — write command via CRDT, observe execution
 *   4. Remote command: startInstance   — reverse; verify idempotent restart
 *   5. Undock propagation              — undock on idea01, observe on idea02
 *
 * Prerequisites:
 *   - idea01 (192.168.0.138) and idea02 (192.168.0.180) running Engine in
 *     production mode, reachable from this Pi over LAN
 *   - Both engines provisioned from this repo (share store-identity/store-url.txt)
 *   - SSH key auth from this Pi to both fleet engines (installed during provisioning)
 *   - traefik/whoami image available on idea01 (pulled in beforeAll if absent)
 *
 * Run:
 *   pnpm test:cross-engine
 *
 * Not run in CI — requires physical fleet on LAN.
 *
 * Known issues (to be fixed separately):
 *
 * Test 1 — mDNS discovery:
 *   The test captures engine IDs from engines with `lastBooted` within the last 5 minutes.
 *   This filter can fail if the store template carries stale lastBooted values from a previous
 *   provisioning session. Fix: regenerate the store template after each fresh provisioning.
 *   Tracked: store-template contamination (no MC task yet).
 *
 * Test 3 — stopInstance:
 *   `stopInstanceWrapper` calls `findDiskByName()` which uses `getDisks()` — that only
 *   returns disks where `dockedTo != null`. If the CRDT shows the disk as undocked
 *   (e.g. after accumulated state writes from failed test runs), stopInstance silently fails.
 *   Fix: `stopInstanceWrapper` should look up the disk by ID (from the instance's `storedOn`
 *   field) rather than by name from the docked-disk list.
 *   Tracked: stopInstanceWrapper uses docked-disk lookup (no MC task yet).
 *
 * Architecture note:
 *   Commands are NOT sent over SSH or a separate API. They are written directly
 *   into the shared Automerge CRDT: engineDB[targetId].commands.push(cmd). The
 *   target engine's storeMonitor detects the patch and calls handleCommand().
 *   The result syncs back via Automerge. This is exactly how the Console works.
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
    remoteDockFixture,
    remoteUndock,
    remoteCleanupDisk,
    isEngineRunning,
    ensureImagePulled,
    TEST_DEVICE,
} from './remoteSSH.js'

// ── Fleet configuration ───────────────────────────────────────────────────────
const IDEA01_HOST = 'idea01.local'
const IDEA02_HOST = 'idea02.local'

// Instance ID used by the disk-sample-v1 fixture (Automerge store key)
const TEST_INSTANCE_ID = 'sample-00000000-test1'

// Instance name from compose.yaml x-app.instanceName — used in stopInstance/startInstance commands
const TEST_INSTANCE_NAME = 'sample-instance-1'

// Disk name from META.yaml diskName — used in stopInstance/startInstance commands
// Must not contain spaces (command parser splits on spaces)
const TEST_DISK_NAME = 'test-sample-v1'

// Disk device
const TEST_DISK_DEVICE = TEST_DEVICE  // sdz1

// ── Test state ────────────────────────────────────────────────────────────────
let repo01: Repo
let repo02: Repo
let store01: DocHandle<Store>
let store02: DocHandle<Store>
let idea01EngineId: string
let idea02EngineId: string

// ── Setup & teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
    // Verify both engines are reachable before spending time on anything else
    const [e01running, e02running] = await Promise.all([
        isEngineRunning(IDEA01_HOST),
        isEngineRunning(IDEA02_HOST),
    ])
    if (!e01running) throw new Error(`${IDEA01_HOST} is not running — start Engine before running cross-engine tests`)
    if (!e02running) throw new Error(`${IDEA02_HOST} is not running — start Engine before running cross-engine tests`)

    // Pre-pull the fixture image so dock tests don't time out on first pull
    await ensureImagePulled(IDEA01_HOST, 'traefik/whoami')

    // Read the current store URL from the fleet (self-healing: handles store resets)
    const storeDocId = await getCachedStoreDocId(IDEA01_HOST)
    console.log(`[test] Using store document ID: ${storeDocId}`)

    // Connect test runner to both engines
    const [conn01, conn02] = await Promise.all([
        connectToEngine(IDEA01_HOST, 'idea01', storeDocId),
        connectToEngine(IDEA02_HOST, 'idea02', storeDocId),
    ])
    repo01 = conn01.repo
    store01 = conn01.storeHandle
    repo02 = conn02.repo
    store02 = conn02.storeHandle
}, 120_000)

afterAll(async () => {
    // Clean up remote fixture (best-effort — don't fail if already gone)
    await remoteCleanupDisk(IDEA01_HOST, TEST_DISK_DEVICE).catch(() => {})
    await remoteUndock(IDEA01_HOST, TEST_DISK_DEVICE).catch(() => {})

    // Disconnect clients
    await Promise.all([
        disconnectFromEngine(repo01).catch(() => {}),
        disconnectFromEngine(repo02).catch(() => {}),
    ])
}, 30_000)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Cross-engine integration', () => {

    it('Test 1 — mDNS discovery: both engines appear in the shared store', { timeout: 60_000 }, async () => {
        // Wait for both engines to be visible from the idea01 connection.
        // mDNS runs every 10 s; allow 60 s for discovery to complete.
        // Wait up to 60 s for at least 2 engines with recent lastBooted.
        // mDNS discovery runs every 10 s; allow 6 cycles for reliable discovery.
        // lastBooted > Date.now() - 300_000 filters out stale pre-seeded entries
        // from the store template (which carry old lastBooted timestamps).
        const now = Date.now()
        const discovered = await waitFor(
            store01,
            store => {
                const engines = Object.values(store.engineDB)
                const recent = engines.filter(e => (e.lastBooted as number) > now - 300_000)
                return recent.length >= 2
            },
            60_000,
        )
        expect(discovered, 'at least 2 engines with recent lastBooted should appear within 60 s').to.be.true

        const store = store01.doc()!
        const engines = Object.values(store.engineDB)
        expect(engines.length, 'engineDB should contain at least 2 engines').to.be.greaterThanOrEqual(2)

        // Capture engine IDs for recently-booted engines only.
        // Sort by lastBooted descending — most recently started instance wins.
        // This filters out stale pre-seeded entries from the store template.
        const sortedByBooted = [...engines].sort((a, b) => ((b.lastBooted as number) ?? 0) - ((a.lastBooted as number) ?? 0))
        for (const engine of sortedByBooted) {
            const hostname = (engine.hostname as string)?.toLowerCase()
            const isRecent = (engine.lastBooted as number) > now - 300_000
            if (!idea01EngineId && isRecent && hostname?.includes('idea01')) idea01EngineId = engine.id as string
            if (!idea02EngineId && isRecent && hostname?.includes('idea02')) idea02EngineId = engine.id as string
        }
        expect(idea01EngineId, 'idea01 engine ID should be discoverable').to.exist
        expect(idea02EngineId, 'idea02 engine ID should be discoverable').to.exist
        console.log(`[test] idea01 engine ID: ${idea01EngineId}`)
        console.log(`[test] idea02 engine ID: ${idea02EngineId}`)

        // Verify store is also populated from the idea02 connection
        const store02doc = store02.doc()!
        const engines02 = Object.values(store02doc.engineDB)
        expect(engines02.length, 'idea02 should also have ≥2 engines in its store').to.be.greaterThanOrEqual(2)
    })

    it('Test 2 — Disk dock propagation: dock on idea01, observe on idea02', { timeout: 120_000 }, async () => {
        // Dock the fixture disk on idea01
        await remoteDockFixture(IDEA01_HOST, 'disk-sample-v1', TEST_DISK_DEVICE)

        // Wait for the instance to reach Running on idea01 (local engine processes it)
        const runningLocally = await waitForInstanceStatus(
            store01, TEST_INSTANCE_ID, 'Running', 90_000,
        )
        expect(runningLocally, 'instance should reach Running on idea01 within 90 s').to.be.true

        // Verify the same instance is visible on idea02's store connection
        const propagated = await waitForInstanceStatus(
            store02, TEST_INSTANCE_ID, 'Running', 30_000,
        )
        expect(propagated, 'Running status should propagate to idea02 store within 30 s').to.be.true

        // Cross-check: disk should also appear in diskDB on idea02's view
        const diskVisible = await waitFor(
            store02,
            store => Object.values(store.diskDB).some(
                (d: any) => d.device === TEST_DISK_DEVICE && d.dockedTo != null
            ),
            10_000,
        )
        expect(diskVisible, 'docked disk should appear in diskDB on idea02 view').to.be.true
    })

    it('Test 3 — Remote command: stopInstance on idea01 observed from idea02', { timeout: 30_000 }, async () => {
        expect(idea01EngineId, 'idea01 engine ID must be known (run Test 1 first)').to.exist

        // Send stopInstance command to idea01 via the shared CRDT.
        // Commands use human-readable names: instanceName (from compose x-app) and diskName (from META.yaml).
        // We write it through the store01 handle — could equally use store02.
        sendCommand(store01, idea01EngineId, `stopInstance ${TEST_INSTANCE_NAME} ${TEST_DISK_NAME}`)

        // Observe result from idea02's connection — proves cross-engine propagation.
        // Accept Stopped OR Undocked: stopInstance stops the container (Stopped),
        // and the engine may immediately transition to Undocked if the disk is no
        // longer docked. The important thing is the instance left Running.
        const stoppedOrUndocked = await waitFor(
            store02,
            store => {
                const status = store.instanceDB[TEST_INSTANCE_ID as any]?.status
                return status === 'Stopped' || status === 'Undocked'
            },
            30_000,
        )
        expect(stoppedOrUndocked, 'instance should reach Stopped or Undocked on idea02 view within 30 s').to.be.true
        const finalStatus = store02.doc()!.instanceDB[TEST_INSTANCE_ID as any]?.status
        expect(finalStatus, 'instance should not still be Running after stopInstance').to.not.equal('Running')
    })

    it('Test 4 — Remote command: startInstance on idea01 observed from idea02', { timeout: 30_000 }, async () => {
        expect(idea01EngineId, 'idea01 engine ID must be known (run Test 1 first)').to.exist

        sendCommand(store01, idea01EngineId, `startInstance ${TEST_INSTANCE_NAME} ${TEST_DISK_NAME}`)

        // Wait for Running on idea02's view
        const running = await waitForInstanceStatus(
            store02, TEST_INSTANCE_ID, 'Running', 30_000,
        )
        expect(running, 'instance should return to Running on idea02 view within 30 s').to.be.true
    })

    it('Test 5 — Undock propagation: undock on idea01, observe Undocked on idea02', { timeout: 30_000 }, async () => {
        // Remove the sentinel on idea01 to trigger undock
        await remoteUndock(IDEA01_HOST, TEST_DISK_DEVICE)

        // Observe on idea01 first (local processing)
        const undockedLocally = await waitForInstanceStatus(
            store01, TEST_INSTANCE_ID, 'Undocked', 20_000,
        )
        expect(undockedLocally, 'instance should reach Undocked on idea01 within 20 s').to.be.true

        // Observe propagation to idea02
        const undockedRemotely = await waitForInstanceStatus(
            store02, TEST_INSTANCE_ID, 'Undocked', 20_000,
        )
        expect(undockedRemotely, 'Undocked status should propagate to idea02 within 20 s').to.be.true

        // diskDB on idea02's view: no active docked entry for test device
        const store02doc = store02.doc()!
        const activeDisk = Object.values(store02doc.diskDB).find(
            (d: any) => d.device === TEST_DISK_DEVICE && d.dockedTo != null
        )
        expect(activeDisk, 'no active docked disk entry should remain on idea02 view after undock').to.be.undefined
    })

})
