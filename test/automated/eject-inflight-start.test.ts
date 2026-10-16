/**
 * eject-inflight-start.test.ts (#179, idea#168 r82b/r83 FAIL@91)
 *
 * idea03, r83: a dock auto-start of kolibri-kwffassvyg6o9l00nnv was at "Starting" when ejectDisk ran.
 * undockDisk stopped it and set Undocked at once, the start carried on (Step 5/6 Creating
 * containers, Step 6/6) against the disk being unmounted, and the row ended Pauzed; r82b ended
 * in Error (spawn /usr/bin/bash ENOENT). Then the reset Empty disk was docked and the stale record
 * (storedOn=empty-001) survived because only an App Disk reconciles its instance records.
 *
 * (1) undockDisk waits (bounded) for in-flight starts/installs on the disk, then stops them.
 * (2) Status/field writes never touch (or resurrect) a deleted instance row.
 * (3) On dock of a non-App disk, records stored on it whose files are missing are removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { undockDisk, undockAllOnDevice } from '../../src/monitors/usbDeviceMonitor.js'
import { processDisk } from '../../src/data/Disk.js'
import { trackInFlight, inFlightOnDisk, resetInFlightForTests } from '../../src/data/InstanceInFlight.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}
const addDisk = (h: DocHandle<Store>, id: string, device: string) => h.change(doc => {
    doc.diskDB[id as DiskID] = {
        id: id as DiskID, name: `Disk ${id}` as DiskName, device: device as DeviceName, dockedTo: LOCAL,
        created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['empty'], backupConfig: null,
    } as any
})
const addInstance = (h: DocHandle<Store>, id: string, diskId: string, status = 'Undocked') => h.change(doc => {
    doc.instanceDB[id as InstanceID] = {
        id, name: 'kolibri-1.0', instanceOf: 'kolibri-1.0', status, port: 0, serviceImages: [], created: 1,
        lastBackup: null, lastStarted: 0, storedOn: diskId, currentStep: null, totalSteps: null, stepLabel: null,
        statusCondition: null, metrics: null,
    } as any
})
const deferred = () => { let resolve!: () => void; const p = new Promise<void>(r => { resolve = r }); return { p, resolve } }

describe('#179 (1): eject waits for an in-flight start on the disk, then stops', () => {
    const prev = process.env.IDEA_EJECT_INFLIGHT_WAIT_MS
    beforeEach(() => resetInFlightForTests())
    afterEach(() => { if (prev === undefined) delete process.env.IDEA_EJECT_INFLIGHT_WAIT_MS; else process.env.IDEA_EJECT_INFLIGHT_WAIT_MS = prev })

    it('undock does not clear the disk while a start is in flight; proceeds once it settles', async () => {
        process.env.IDEA_EJECT_INFLIGHT_WAIT_MS = '5000'
        const h = await newStore()
        const dev = uniqueTestDevice(); addDisk(h, 'e001', dev)
        const start = deferred()
        trackInFlight('e001', 'startInstance kolibri-kwffass', start.p)
        expect(inFlightOnDisk('e001')).toEqual(['startInstance kolibri-kwffass'])
        const undock = undockDisk(h, h.doc()!.diskDB['e001' as DiskID] as any)
        await new Promise(r => setTimeout(r, 100))
        expect(h.doc()!.diskDB['e001' as DiskID]!.dockedTo).toBe(LOCAL) // still waiting
        start.resolve()
        await undock
        expect(h.doc()!.diskDB['e001' as DiskID]!.dockedTo).toBeNull()
        expect(inFlightOnDisk('e001')).toEqual([])
    })

    it('a start that never settles: undock proceeds after the bound (stops it anyway)', async () => {
        process.env.IDEA_EJECT_INFLIGHT_WAIT_MS = '50'
        const h = await newStore()
        const dev = uniqueTestDevice(); addDisk(h, 'e002', dev)
        trackInFlight('e002', 'startInstance stuck', new Promise<void>(() => {}))
        const t0 = Date.now()
        await undockDisk(h, h.doc()!.diskDB['e002' as DiskID] as any)
        expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
        expect(h.doc()!.diskDB['e002' as DiskID]!.dockedTo).toBeNull()
    })

    it('a start in flight on ANOTHER disk does not delay the undock', async () => {
        process.env.IDEA_EJECT_INFLIGHT_WAIT_MS = '5000'
        const h = await newStore()
        addDisk(h, 'e003', uniqueTestDevice())
        trackInFlight('other', 'startInstance x', new Promise<void>(() => {}))
        const t0 = Date.now()
        await undockDisk(h, h.doc()!.diskDB['e003' as DiskID] as any)
        expect(Date.now() - t0).toBeLessThan(1000)
    })

    it('physical removal (undockAllOnDevice, device gone): no in-flight wait, disk undocked at once', async () => {
        process.env.IDEA_EJECT_INFLIGHT_WAIT_MS = '5000'
        const h = await newStore()
        const dev = uniqueTestDevice(); addDisk(h, 'e004', dev)
        trackInFlight('e004', 'startInstance pulled', new Promise<void>(() => {}))
        const t0 = Date.now()
        await undockAllOnDevice(h, LOCAL, dev as DeviceName)
        expect(Date.now() - t0).toBeLessThan(1000)
        expect(h.doc()!.diskDB['e004' as DiskID]!.dockedTo).toBeNull()
    })
})

describe('#179 (2): writes never touch or resurrect a deleted instance row', () => {
    it('every instance-row write in Instance.ts is guarded against a missing row', async () => {
        const src = await fs.readFile(path.resolve(process.cwd(), 'src/data/Instance.ts'), 'utf8')
        const lines = src.split('\n')
        const unguarded: number[] = []
        lines.forEach((l, i) => {
            if (/const inst = doc\.instanceDB\[instance\.id\]/.test(l) && !/if \(!inst\)/.test(lines[i + 1] ?? '')) unguarded.push(i + 1)
        })
        expect(unguarded).toEqual([])
    })

    it('a late write after the row is deleted leaves no row (no resurrection, no throw)', async () => {
        const h = await newStore()
        addInstance(h, 'kolibri-gone', 'e001', 'Starting')
        h.change(doc => { delete doc.instanceDB['kolibri-gone' as InstanceID] })
        const { markInstanceError } = await import('../../src/data/Instance.js')
        await markInstanceError(h, { id: 'kolibri-gone', name: 'k' } as any, { id: 'e001', device: null } as any, new Error('late'))
        expect(h.doc()!.instanceDB['kolibri-gone' as InstanceID]).toBeUndefined()
    })
})

describe('#179 (3): dock of a non-App disk drops records whose files are gone', () => {
    it('reset Empty disk (META only): stale Pauzed/Undocked records stored on it are removed; others untouched', async () => {
        const h = await newStore()
        const dev = uniqueTestDevice()
        await fs.ensureDir(path.join(DISKS_ROOT, dev))
        addDisk(h, 'e010', dev)
        addInstance(h, 'kolibri-kwffass', 'e010', 'Pauzed')
        addInstance(h, 'kolibri-244pq', 'e010', 'Undocked')
        addInstance(h, 'kolibri-elsewhere', 'other-disk', 'Running')
        await processDisk(h, h.doc()!.diskDB['e010' as DiskID] as any)
        const db = h.doc()!.instanceDB
        for (const id of ['kolibri-kwffass', 'kolibri-244pq']) {
            expect(db[id as InstanceID]?.storedOn ?? null).toBeNull()
            expect(db[id as InstanceID]?.status).toBe('Missing')
        }
        expect(db['kolibri-elsewhere' as InstanceID]?.storedOn).toBe('other-disk')
        expect(db['kolibri-elsewhere' as InstanceID]?.status).toBe('Running')
        expect(h.doc()!.diskDB['e010' as DiskID]!.diskTypes).toEqual(['empty'])
    })
})
