/**
 * app-versioning.test.ts
 *
 * Tier 1 automated test: verifies that the Engine correctly reads and tracks
 * app version metadata across dock/undock cycles.
 *
 * In-place minor upgrade: the SAME disk (same diskId) is re-prepared with a newer
 * minor version (the App Maintainer updates compose.yaml from 1.0 to 1.1 on an
 * existing disk). The instance id stays the same. The engine must:
 *   - update instanceOf to sample-1.1
 *   - start the instance with the new version and refresh lastStarted
 *
 * Another disk with the same instance id (engine#423, engine#418/#420): the
 * v1.1 fixture `disk-sample-v1.1` is a DIFFERENT disk (diskId
 * test-fixture-sample-v1.1) that carries the same instance id. Since engine#381 the
 * record is not claimed by that disk, and since engine#418 the dock path never
 * starts an instance on a disk that is not its storedOn. Re-homing only happens
 * through restoreApp's restore-reclaim (Koen's #418 decision). So:
 *   - the v1.1 disk docks, but the instance does NOT start there
 *   - the record keeps instanceOf sample-1.0 and storedOn test-fixture-sample-v1
 *   - undocking the v1.1 disk leaves the record as it was (Undocked, on v1)
 *
 * Store assertions:
 *   v1.0 dock:                 instanceOf 'sample-1.0', Running, lastStarted > 0
 *   v1.1 on another disk:      not Running, instanceOf 'sample-1.0', storedOn v1
 *   in-place v1.0 → v1.1:      instanceOf 'sample-1.1', Running, lastStarted refreshed, storedOn v1
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
import os from 'os'
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
    TEST_CONTAINER_LABEL,
} from '../harness/diskSim.js'
import { $, fs } from 'zx'

const FIXTURE_SAMPLE_V1   = path.resolve(FIXTURES_DIR, 'disk-sample-v1')
const FIXTURE_SAMPLE_V1_1 = path.resolve(FIXTURES_DIR, 'disk-sample-v1.1')
const TEST_INSTANCE_ID    = 'sample-00000000-test1'
const DISK_V1             = 'test-fixture-sample-v1'
const DISK_V1_1           = 'test-fixture-sample-v1.1'

const inst = (h: DocHandle<Store>) => h.doc()!.instanceDB[TEST_INSTANCE_ID as any] as any
const diskDocked = (h: DocHandle<Store>, id: string) => waitFor(h, s => (s.diskDB as any)[id]?.device != null, 30_000)
const diskUndocked = (h: DocHandle<Store>, id: string) => waitFor(h, s => (s.diskDB as any)[id]?.device == null, 20_000)
const runningContainers = async (): Promise<string[]> => {
    const r = await $`docker ps -q --filter label=${TEST_CONTAINER_LABEL} --filter name=${TEST_INSTANCE_ID}`.nothrow()
    return r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

describe('App versioning (automated, real containers)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    let sameDiskV1_1: string

    beforeAll(async () => {
        // Defensive cleanup: ensure no orphan containers from the lifecycle suite.
        await cleanupContainers(TEST_INSTANCE_ID)
        // The in-place upgrade fixture: disk-sample-v1.1 content with v1's diskId
        // (the same disk re-prepared with 1.1).
        sameDiskV1_1 = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-av-v11-same-disk-'))
        await fs.copy(FIXTURE_SAMPLE_V1_1, sameDiskV1_1)
        const meta = await fs.readFile(path.join(sameDiskV1_1, 'META.yaml'), 'utf-8')
        await fs.writeFile(path.join(sameDiskV1_1, 'META.yaml'), meta.replace(`diskId: "${DISK_V1_1}"`, `diskId: "${DISK_V1}"`))
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    }, 15_000)

    afterAll(async () => {
        await watcher?.close()
        await fs.remove(SENTINEL).catch(() => {})
        await cleanupDisk(TEST_DEVICE)
        if (sameDiskV1_1) await fs.remove(sameDiskV1_1).catch(() => {})
        await new Promise(r => setTimeout(r, 2_000))
        await cleanupContainers(TEST_INSTANCE_ID)
    }, 30_000)

    it('v1.0 dock: version is read from disk and stored in instanceOf', { timeout: 120_000 }, async () => {

        await dockFixture(FIXTURE_SAMPLE_V1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'v1.0 instance should reach Running').to.be.true

        const instance = inst(storeHandle)
        expect(instance.instanceOf, 'instanceOf should reflect version from disk').to.equal('sample-1.0')
        expect(String(instance.storedOn)).to.equal(DISK_V1)
        expect(instance.lastStarted, 'lastStarted should be set on first dock').to.be.greaterThan(0)
    })

    it('v1.0 undock: instance reaches Undocked', { timeout: 30_000 }, async () => {

        await triggerUndock()

        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'instance should reach Undocked after disk removal').to.be.true
    })

    it('v1.1 on ANOTHER disk (same instance id): not started there, record stays on v1 (engine#423)', { timeout: 60_000 }, async () => {

        const before = { ...inst(storeHandle) }
        await dockFixture(FIXTURE_SAMPLE_V1_1)

        expect(await diskDocked(storeHandle, DISK_V1_1), 'the v1.1 disk should dock').to.be.true
        // Give the dock pass time to (wrongly) start it: before engine#418 it reached Running in ~13 s.
        const started = await waitFor(storeHandle, s => (s.instanceDB as any)[TEST_INSTANCE_ID]?.status === 'Running', 20_000)
        expect(started, 'the instance must not start on a disk that is not its storedOn').to.be.false
        expect(await runningContainers(), 'no v1.1 container may be running').to.deep.equal([])

        const instance = inst(storeHandle)
        expect(instance.instanceOf, 'instanceOf stays on v1.0').to.equal('sample-1.0')
        expect(String(instance.storedOn), 'storedOn stays the v1 disk').to.equal(DISK_V1)
        expect(instance.status).to.equal('Undocked')
        expect(instance.lastStarted).to.equal(before.lastStarted)
    })

    it('v1.1 on another disk: undock leaves the record unchanged', { timeout: 30_000 }, async () => {

        await triggerUndock()

        expect(await diskUndocked(storeHandle, DISK_V1_1), 'the v1.1 disk should undock').to.be.true
        const instance = inst(storeHandle)
        expect(instance.status).to.equal('Undocked')
        expect(instance.instanceOf).to.equal('sample-1.0')
        expect(String(instance.storedOn)).to.equal(DISK_V1)
    })

    it('in-place minor upgrade (v1.0→v1.1, same diskId): instanceOf updated, lastStarted refreshed', { timeout: 120_000 }, async () => {

        // Record the previous lastStarted — the minor upgrade must produce a fresh timestamp.
        const prevLastStarted = inst(storeHandle)?.lastStarted ?? 0

        await dockFixture(sameDiskV1_1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'minor upgrade should reach Running').to.be.true

        const instance = inst(storeHandle)
        expect(instance.instanceOf, 'instanceOf should be updated to reflect v1.1').to.equal('sample-1.1')
        expect(String(instance.storedOn)).to.equal(DISK_V1)
        expect(instance.lastStarted, 'lastStarted should be refreshed after re-dock with new version')
            .to.be.greaterThan(prevLastStarted)
    })

    it('in-place minor upgrade: undock v1.1', { timeout: 30_000 }, async () => {

        await triggerUndock()

        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'v1.1 instance should reach Undocked').to.be.true
    })
})
