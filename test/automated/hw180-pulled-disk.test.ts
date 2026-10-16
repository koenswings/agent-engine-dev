/**
 * hw180-pulled-disk.test.ts — two product bugs found by the #180 hw round-trip on idea04 (2026-10-13).
 *
 * (1) Stale-device eject: an eject that waited for an in-flight start acted on the disk object it
 *     captured before the wait. The disk was pulled and re-plugged meanwhile (sda2 → sdc2): the eject
 *     cleared the NEW dock in the store and left /dev/sdc2 mounted. After the wait the eject must
 *     re-check that it is still the same dock (device node, mount, dock generation) or abort cleanly.
 * (2) Error flicker: the start in flight when the disk was pulled failed (image load I/O error) and
 *     marked the instance Error before the undock set Undocked. A start that fails because its disk
 *     is gone (undock pending, record undocked/moved, device node gone) goes to Undocked; only real
 *     start failures go to Error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { undockDisk } from '../../src/monitors/usbDeviceMonitor.js'
import { markInstanceError, setDeviceExistsCheckForTests } from '../../src/data/Instance.js'
import {
    trackInFlight, resetInFlightForTests, resetUndockPendingForTests, markUndockPending, clearUndockPending, isUndockPending,
    dockChangedReason, startDiskGoneReason,
} from '../../src/data/InstanceInFlight.js'
import { uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}
const addDisk = (h: DocHandle<Store>, id: string, device: string, lastDocked = 1) => h.change(doc => {
    doc.diskDB[id as DiskID] = {
        id: id as DiskID, name: `Disk ${id}` as DiskName, device: device as DeviceName, dockedTo: LOCAL,
        created: 1 as Timestamp, lastDocked: lastDocked as Timestamp, diskTypes: ['app'], backupConfig: null,
    } as any
})
const addInstance = (h: DocHandle<Store>, id: string, diskId: string, status = 'Starting') => h.change(doc => {
    doc.instanceDB[id as InstanceID] = {
        id, name: 'kolibri-1.0', instanceOf: 'kolibri-1.0', status, port: 0, serviceImages: [], created: 1,
        lastBackup: null, lastStarted: 0, storedOn: diskId, currentStep: null, totalSteps: null, stepLabel: null,
        statusCondition: null, metrics: null,
    } as any
})
const deferred = () => { let resolve!: () => void; const p = new Promise<void>(r => { resolve = r }); return { p, resolve } }
const disk = (h: DocHandle<Store>, id: string) => h.doc()!.diskDB[id as DiskID] as any
const inst = (h: DocHandle<Store>, id: string) => h.doc()!.instanceDB[id as InstanceID] as any

describe('hw180 (1): eject after an in-flight wait acts only on the same dock', () => {
    const prev = process.env.IDEA_EJECT_INFLIGHT_WAIT_MS
    beforeEach(() => { resetInFlightForTests(); resetUndockPendingForTests(); process.env.IDEA_EJECT_INFLIGHT_WAIT_MS = '5000' })
    afterEach(() => { if (prev === undefined) delete process.env.IDEA_EJECT_INFLIGHT_WAIT_MS; else process.env.IDEA_EJECT_INFLIGHT_WAIT_MS = prev })

    it('pulled and re-docked on a new device during the wait → eject aborts, new dock and instance untouched', async () => {
        const h = await newStore()
        const oldDev = uniqueTestDevice(); const newDev = uniqueTestDevice()
        addDisk(h, 'k1', oldDev, 100); addInstance(h, 'kolibri-a', 'k1', 'Starting')
        const start = deferred(); trackInFlight('k1', 'startInstance kolibri-a', start.p)
        const eject = undockDisk(h, { ...disk(h, 'k1') })
        await new Promise(r => setTimeout(r, 50))
        // the monitor undocks the pulled disk, then the re-plug docks it again on a new device
        h.change(doc => { const d = doc.diskDB['k1' as DiskID]!; d.device = newDev as DeviceName; d.lastDocked = 200 as Timestamp })
        h.change(doc => { doc.instanceDB['kolibri-a' as InstanceID]!.status = 'Running' as any })
        start.resolve()
        const r = await eject
        expect(r?.aborted).toMatch(/re-docked on/)
        expect(disk(h, 'k1').dockedTo).toBe(LOCAL)
        expect(disk(h, 'k1').device).toBe(newDev)
        expect(inst(h, 'kolibri-a').status).toBe('Running')
    })

    it('re-docked on the SAME device name (new generation) → still aborts', async () => {
        const h = await newStore()
        const dev = uniqueTestDevice(); addDisk(h, 'k2', dev, 100)
        const start = deferred(); trackInFlight('k2', 'startInstance x', start.p)
        const eject = undockDisk(h, { ...disk(h, 'k2') })
        await new Promise(r => setTimeout(r, 50))
        h.change(doc => { doc.diskDB['k2' as DiskID]!.lastDocked = 300 as Timestamp })
        start.resolve()
        expect((await eject)?.aborted).toMatch(/dock generation 100 → 300/)
        expect(disk(h, 'k2').dockedTo).toBe(LOCAL)
    })

    it('pulled during the wait (not re-plugged) → aborts cleanly, no error', async () => {
        const h = await newStore()
        const dev = uniqueTestDevice(); addDisk(h, 'k3', dev, 100)
        const start = deferred(); trackInFlight('k3', 'startInstance x', start.p)
        const eject = undockDisk(h, { ...disk(h, 'k3') })
        await new Promise(r => setTimeout(r, 50))
        h.change(doc => { const d = doc.diskDB['k3' as DiskID]!; d.dockedTo = null; d.device = null })
        start.resolve()
        expect((await eject)?.aborted).toMatch(/no longer docked/)
    })

    it('same dock after the wait → eject proceeds (undocked)', async () => {
        const h = await newStore()
        const dev = uniqueTestDevice(); addDisk(h, 'k4', dev, 100)
        const start = deferred(); trackInFlight('k4', 'startInstance x', start.p)
        const eject = undockDisk(h, { ...disk(h, 'k4') })
        await new Promise(r => setTimeout(r, 50))
        start.resolve()
        expect((await eject)?.aborted).toBeNull()
        expect(disk(h, 'k4').dockedTo).toBeNull()
    })

    it('dockChangedReason: pure cases', () => {
        const b = { device: 'sda2', dockedTo: 'E', lastDocked: 1 }
        expect(dockChangedReason(b, { ...b })).toBeNull()
        expect(dockChangedReason(b, null)).toMatch(/no longer docked/)
        expect(dockChangedReason(b, { ...b, dockedTo: null })).toMatch(/no longer docked/)
        expect(dockChangedReason(b, { ...b, dockedTo: 'F' })).toMatch(/docked to F/)
        expect(dockChangedReason(b, { ...b, device: 'sdc2' })).toMatch(/re-docked on sdc2/)
        expect(dockChangedReason(b, { ...b, lastDocked: 2 })).toMatch(/generation/)
    })

    it('undock marks the disk pending while it runs and clears it after', async () => {
        const h = await newStore()
        addDisk(h, 'k5', uniqueTestDevice())
        const start = deferred(); trackInFlight('k5', 'startInstance x', start.p)
        const eject = undockDisk(h, { ...disk(h, 'k5') })
        await new Promise(r => setTimeout(r, 20))
        expect(isUndockPending('k5')).toBe(true)
        start.resolve(); await eject
        expect(isUndockPending('k5')).toBe(false)
    })
})

describe('hw180 (2): a start that fails because its disk was pulled → Undocked, not Error', () => {
    beforeEach(() => { resetUndockPendingForTests(); setDeviceExistsCheckForTests(undefined) })
    afterEach(() => setDeviceExistsCheckForTests(undefined))
    const err = new Error('loading /disks/sda2/services/x.tar failed: read /dev/stdin: input/output error')

    it('undock pending → Undocked', async () => {
        const h = await newStore(); const dev = uniqueTestDevice(); addDisk(h, 'p1', dev); addInstance(h, 'i1', 'p1')
        markUndockPending('p1')
        await markInstanceError(h, inst(h, 'i1'), disk(h, 'p1'), err)
        clearUndockPending('p1')
        expect(inst(h, 'i1').status).toBe('Undocked')
        expect(inst(h, 'i1').statusCondition).toBeNull()
    })
    it('disk record already undocked → Undocked', async () => {
        const h = await newStore(); const dev = uniqueTestDevice(); addDisk(h, 'p2', dev); addInstance(h, 'i2', 'p2')
        const atStart = { ...disk(h, 'p2') }
        h.change(doc => { const d = doc.diskDB['p2' as DiskID]!; d.dockedTo = null; d.device = null })
        await markInstanceError(h, inst(h, 'i2'), atStart, err)
        expect(inst(h, 'i2').status).toBe('Undocked')
    })
    it('device node gone (record not yet updated) → Undocked', async () => {
        const h = await newStore(); const dev = uniqueTestDevice(); addDisk(h, 'p3', dev); addInstance(h, 'i3', 'p3')
        setDeviceExistsCheckForTests(() => false)
        await markInstanceError(h, inst(h, 'i3'), disk(h, 'p3'), err)
        expect(inst(h, 'i3').status).toBe('Undocked')
    })
    it('disk moved to another device → Undocked', async () => {
        const h = await newStore(); const dev = uniqueTestDevice(); addDisk(h, 'p4', dev); addInstance(h, 'i4', 'p4')
        const atStart = { ...disk(h, 'p4') }
        h.change(doc => { doc.diskDB['p4' as DiskID]!.device = uniqueTestDevice() as DeviceName })
        await markInstanceError(h, inst(h, 'i4'), atStart, err)
        expect(inst(h, 'i4').status).toBe('Undocked')
    })
    it('real start failure (disk docked, device present, no undock) → Error', async () => {
        const h = await newStore(); const dev = uniqueTestDevice(); addDisk(h, 'p5', dev); addInstance(h, 'i5', 'p5')
        setDeviceExistsCheckForTests(() => true)
        await markInstanceError(h, inst(h, 'i5'), disk(h, 'p5'), new Error('compose up failed: port in use'))
        expect(inst(h, 'i5').status).toBe('Error')
        expect(inst(h, 'i5').statusCondition).toMatch(/port in use/)
    })
    it('startDiskGoneReason: pure cases', () => {
        const now = { device: 'sda2', dockedTo: 'E', lastDocked: 1 }
        expect(startDiskGoneReason('d', 'sda2', now, () => true)).toBeNull()
        expect(startDiskGoneReason('d', 'sda2', now, null)).toBeNull()
        expect(startDiskGoneReason('d', 'sda2', now, () => false)).toMatch(/gone/)
        expect(startDiskGoneReason('d', 'sda2', null, () => true)).toMatch(/no longer docked/)
        expect(startDiskGoneReason('d', 'sda2', { ...now, device: 'sdc2' }, () => true)).toMatch(/moved/)
    })
})
