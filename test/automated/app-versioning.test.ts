/**
 * app-versioning.test.ts
 *
 * Tier 1 automated test: verifies that the Engine correctly reads and tracks
 * app version metadata across dock/undock cycles.
 *
 * Scenario: the same physical disk is re-prepared with a newer minor version
 * (e.g. the App Maintainer updates the compose.yaml from version 1.0 to 1.1
 * on an existing disk). The instance ID stays the same because it is the same
 * disk. The engine must:
 *   - Update instanceOf in the store to reflect the new version
 *   - Restart the instance with the new version
 *   - Refresh lastStarted
 *
 * Store assertions:
 *
 *   v1.0 dock:
 *     instanceDB[id].instanceOf    === 'sample-1.0'
 *     instanceDB[id].status        === 'Running'
 *     instanceDB[id].lastStarted   > 0
 *
 *   minor upgrade (v1.0 → v1.1, same instance ID, same disk):
 *     instanceDB[id].instanceOf    === 'sample-1.1'   (updated from disk)
 *     instanceDB[id].status        === 'Running'
 *     instanceDB[id].lastStarted   > previous lastStarted  (refreshed)
 *
 * What is NOT tested here (future work):
 *
 *   Cross-disk upgrade detection — when Disk B (Kolibri 1.1) is docked
 *   alongside Disk A (Kolibri 1.0), the engine should detect that a newer
 *   version of the same app exists on the network and write an upgrade
 *   proposal to the store. The Console reads this and presents it to the
 *   Console Admin. Major versions are not proposed (data format incompatible).
 *   See backlog task: "Implement cross-disk upgrade detection".
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
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
    waitForStatus,
    FIXTURES_DIR,
    TEST_DEVICE,
    SENTINEL,
} from '../harness/diskSim.js'
import { fs } from 'zx'

const FIXTURE_SAMPLE_V1   = path.resolve(FIXTURES_DIR, 'disk-sample-v1')
const FIXTURE_SAMPLE_V1_1 = path.resolve(FIXTURES_DIR, 'disk-sample-v1.1')
const TEST_INSTANCE_ID    = 'sample-00000000-test1'

describe('App versioning (automated, real containers)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>

    beforeAll(async () => {
        // Defensive cleanup: ensure no orphan containers from the lifecycle suite.
        await cleanupContainers(TEST_INSTANCE_ID)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    }, 15_000)

    afterAll(async () => {
        await watcher?.close()
        await fs.remove(SENTINEL).catch(() => {})
        await cleanupDisk(TEST_DEVICE)
        await new Promise(r => setTimeout(r, 2_000))
        await cleanupContainers(TEST_INSTANCE_ID)
    }, 30_000)

    it('v1.0 dock: version is read from disk and stored in instanceOf', { timeout: 120_000 }, async () => {

        await dockFixture(FIXTURE_SAMPLE_V1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'v1.0 instance should reach Running').to.be.true

        const store = storeHandle.doc()!
        const instance = store.instanceDB[TEST_INSTANCE_ID as any]
        expect(instance.instanceOf, 'instanceOf should reflect version from disk').to.equal('sample-1.0')
        expect(instance.lastStarted, 'lastStarted should be set on first dock').to.be.greaterThan(0)
    })

    it('v1.0 undock: instance reaches Undocked', { timeout: 30_000 }, async () => {

        await triggerUndock()

        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'instance should reach Undocked after disk removal').to.be.true
    })

    it('minor upgrade (v1.0→v1.1): instanceOf updated, lastStarted refreshed', { timeout: 120_000 }, async () => {

        // Record the previous lastStarted — the minor upgrade must produce a fresh timestamp.
        const prevLastStarted = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]?.lastStarted ?? 0

        await dockFixture(FIXTURE_SAMPLE_V1_1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'minor upgrade should reach Running').to.be.true

        const store = storeHandle.doc()!
        const instance = store.instanceDB[TEST_INSTANCE_ID as any]

        expect(instance.instanceOf, 'instanceOf should be updated to reflect v1.1').to.equal('sample-1.1')
        expect(instance.lastStarted, 'lastStarted should be refreshed after re-dock with new version')
            .to.be.greaterThan(prevLastStarted)
    })

    it('minor upgrade: undock v1.1', { timeout: 30_000 }, async () => {

        await triggerUndock()

        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'v1.1 instance should reach Undocked').to.be.true
    })
})
