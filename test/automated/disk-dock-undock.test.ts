/**
 * disk-dock-undock.test.ts
 *
 * Tier 1 automated test: verifies that the Engine correctly processes a disk
 * dock and undock event without any physical hardware.
 *
 * Uses testMode (via IDEA_TEST_MODE=true) so usbDeviceMonitor skips sudo
 * mount/umount. The harness copies a synthetic fixture (disk-sample-v1) to
 * /disks/sdz1/ and touches /dev/engine/sdz1 to simulate the chokidar event.
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import path from 'path'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    cleanupContainers,
    waitFor,
    TEST_DEVICE,
    SENTINEL,
    FIXTURES_DIR,
} from '../harness/diskSim.js'
import { fs } from 'zx'

const FIXTURE_SAMPLE_V1 = path.resolve(FIXTURES_DIR, 'disk-sample-v1')
const TEST_INSTANCE_ID = 'sample-00000000-test1'

describe('Disk dock / undock (automated, testMode)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>

    before(async function () {
        this.timeout(15_000)

        // Create in-memory store with local engine registered
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle

        // Start the USB device monitor (no mDNS, no WebSocket — disk events only)
        watcher = await enableUsbDeviceMonitor(storeHandle)
    })

    after(async function () {
        this.timeout(30_000)
        // Close the watcher before cleanup — prevents it from firing on subsequent test suites
        // that run in the same mocha process.
        await watcher?.close()
        // Remove sentinel and force-remove any containers started by the dock events.
        // cleanupContainers must run before cleanupDisk (needs the disk to exist).
        await fs.remove(SENTINEL).catch(() => {})
        await cleanupContainers(TEST_INSTANCE_ID)
        await cleanupDisk(TEST_DEVICE)
    })

    it('registers a disk in the store when a fixture is docked', async function () {
        this.timeout(15_000)

        await dockFixture(FIXTURE_SAMPLE_V1)

        const docked = await waitFor(storeHandle, store => {
            return Object.values(store.diskDB).some(
                d => d.device === TEST_DEVICE && d.dockedTo === localEngineId
            )
        })

        expect(docked, 'disk should appear in store within 10 s').to.be.true

        // Verify the disk has the expected diskId from the fixture META.yaml
        const store = storeHandle.doc()!
        const disk = Object.values(store.diskDB).find(d => d.device === TEST_DEVICE)
        expect(disk).to.exist
        expect(disk!.id).to.include('test-fixture-sample')
    })

    // Tests 2 and 3 depend on the store state established by Test 1 (disk docked).
    // They run in sequence: dock → undock → re-dock. This is intentional: the
    // dock/undock cycle is inherently stateful and is best verified as a sequence.
    it('removes the disk from the store when undocked', async function () {
        this.timeout(15_000)

        await triggerUndock()

        const undocked = await waitFor(storeHandle, store => {
            return !Object.values(store.diskDB).some(
                d => d.device === TEST_DEVICE && d.dockedTo === localEngineId
            )
        })

        expect(undocked, 'disk should be removed from store within 10 s').to.be.true
    })

    it('re-registers the disk after a second dock', async function () {
        this.timeout(15_000)

        await dockFixture(FIXTURE_SAMPLE_V1)

        const redocked = await waitFor(storeHandle, store => {
            return Object.values(store.diskDB).some(
                d => d.device === TEST_DEVICE && d.dockedTo === localEngineId
            )
        })

        expect(redocked, 'disk should reappear in store on re-dock').to.be.true
    })
})
