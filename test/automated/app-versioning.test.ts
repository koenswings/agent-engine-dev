/**
 * app-versioning.test.ts
 *
 * Tier 1 automated test: verifies that the Engine correctly handles app version
 * changes when a disk is re-docked with a different version.
 *
 * Two upgrade scenarios are tested:
 *
 *   Minor upgrade (1.0 → 1.1)
 *     Same major version: engine allows the upgrade, restarts the instance with
 *     the new version. Store reflects updated instanceOf and a fresh lastStarted.
 *
 *   Major upgrade (1.1 → 2.0)
 *     Different major version: engine BLOCKS automatic startup. The instance
 *     remains in Docked status — the operator must explicitly migrate data before
 *     the new version can run. No container is started.
 *
 * Tests run in sequence — each test builds on the store state established by the
 * previous one. The final state (major upgrade blocked) is the important assertion:
 * it requires a prior v1.x entry in the store to detect the major version change.
 *
 * Store assertions (full coverage for this suite):
 *
 *   v1.0 dock:
 *     instanceDB[id].instanceOf    === 'sample-1.0'
 *     instanceDB[id].status        === 'Running'
 *     instanceDB[id].lastStarted   > 0
 *
 *   minor upgrade (v1.1):
 *     instanceDB[id].instanceOf    === 'sample-1.1'   (updated)
 *     instanceDB[id].status        === 'Running'
 *     instanceDB[id].lastStarted   > previous lastStarted  (refreshed)
 *
 *   major upgrade (v2.0):
 *     instanceDB[id].instanceOf    === 'sample-2.0'   (store updated, but startup blocked)
 *     instanceDB[id].status        === 'Docked'       (never reaches Starting or Running)
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import path from 'path'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    cleanupContainers,
    waitFor,
    waitForStatus,
    FIXTURES_DIR,
    TEST_DEVICE,
    SENTINEL,
} from '../harness/diskSim.js'
import { fs } from 'zx'

const FIXTURE_SAMPLE_V1   = path.resolve(FIXTURES_DIR, 'disk-sample-v1')
const FIXTURE_SAMPLE_V1_1 = path.resolve(FIXTURES_DIR, 'disk-sample-v1.1')
const FIXTURE_SAMPLE_V2   = path.resolve(FIXTURES_DIR, 'disk-sample-v2')
const TEST_INSTANCE_ID    = 'sample-00000000-test1'

describe('App versioning (automated, real containers)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>

    before(async function () {
        this.timeout(15_000)
        // Defensive cleanup: ensure no orphan containers or disk state from
        // the lifecycle suite (which runs before this in the same mocha process).
        await cleanupContainers(TEST_INSTANCE_ID)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    })

    after(async function () {
        this.timeout(30_000)
        await watcher?.close()
        await fs.remove(SENTINEL).catch(() => {})
        await cleanupDisk(TEST_DEVICE)
        await new Promise(r => setTimeout(r, 2_000))
        await cleanupContainers(TEST_INSTANCE_ID)
    })

    // ── v1.0 baseline ────────────────────────────────────────────────────────

    it('v1.0 dock: instance reaches Running', async function () {
        this.timeout(120_000)

        await dockFixture(FIXTURE_SAMPLE_V1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'v1.0 instance should reach Running').to.be.true

        const store = storeHandle.doc()!
        const instance = store.instanceDB[TEST_INSTANCE_ID as any]
        expect(instance.instanceOf, 'instanceOf should be sample-1.0').to.equal('sample-1.0')
        expect(instance.lastStarted, 'lastStarted should be set').to.be.greaterThan(0)
    })

    it('v1.0 undock: instance reaches Undocked', async function () {
        this.timeout(30_000)

        await triggerUndock()

        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'v1.0 instance should reach Undocked').to.be.true
    })

    // ── minor upgrade: 1.0 → 1.1 ────────────────────────────────────────────

    it('minor upgrade (v1.0→v1.1): instance updates and reaches Running', async function () {
        this.timeout(120_000)

        // Record lastStarted before the upgrade — must be greater after re-start.
        const prevLastStarted = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]?.lastStarted ?? 0

        await dockFixture(FIXTURE_SAMPLE_V1_1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'minor upgrade should reach Running').to.be.true

        const store = storeHandle.doc()!
        const instance = store.instanceDB[TEST_INSTANCE_ID as any]

        // ── version updated ──────────────────────────────────────────────────
        expect(instance.instanceOf, 'instanceOf should be updated to sample-1.1').to.equal('sample-1.1')

        // ── lastStarted refreshed ────────────────────────────────────────────
        // Confirms the engine ran startInstance for the new version, not just
        // inherited the old timestamp.
        expect(instance.lastStarted, 'lastStarted should be refreshed after minor upgrade')
            .to.be.greaterThan(prevLastStarted)
    })

    it('minor upgrade: undock v1.1', async function () {
        this.timeout(30_000)

        await triggerUndock()

        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'v1.1 instance should reach Undocked').to.be.true
    })

    // ── major upgrade: 1.1 → 2.0 (blocked) ──────────────────────────────────

    it('major upgrade (v1.1→v2.0): startup blocked — instance stays Docked', async function () {
        this.timeout(30_000)

        await dockFixture(FIXTURE_SAMPLE_V2)

        // Wait for the dock event to be processed: createOrUpdateInstance runs and
        // updates instanceOf to 'sample-2.0' in the store.
        const processed = await waitFor(
            storeHandle,
            store => (store.instanceDB[TEST_INSTANCE_ID as any]?.instanceOf as string) === 'sample-2.0',
            10_000
        )
        expect(processed, 'dock event should be processed and instanceOf updated to sample-2.0').to.be.true

        // Allow enough time for startInstance to have fired if blocking were absent.
        // A container start (compose create + up) takes < 2 s once the image is cached.
        // 5 s is a safe margin — any status change would appear well within this window.
        await new Promise(r => setTimeout(r, 5_000))

        const store = storeHandle.doc()!
        const instance = store.instanceDB[TEST_INSTANCE_ID as any]

        // ── startup blocked ──────────────────────────────────────────────────
        expect(instance.status, 'major upgrade must be blocked: status must remain Docked')
            .to.equal('Docked')

        // ── store reflects new version ────────────────────────────────────────
        // The engine updates the store even when blocking startup — the operator
        // can see what version is on the disk.
        expect(instance.instanceOf, 'instanceOf should reflect the disk version')
            .to.equal('sample-2.0')
    })
})
