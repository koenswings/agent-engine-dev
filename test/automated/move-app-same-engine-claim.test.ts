/**
 * move-app-same-engine-claim.test.ts (kc8 step 104)
 *
 * cover-all kc8 FAIL@104: a same-Engine moveApp (step 102) left instance.storedOn on the
 * source disk. moveApp's processInstance on the target hit the engine#381 claim guard
 * ("not claiming ... storedOn is already <source>"), and moveApp then started the
 * instance from the target anyway. Ejecting the target disk stops only instances whose
 * storedOn is that disk, so the app kept running on an unmounted filesystem and held the
 * partition (partx -d EBUSY on idea03; in the field: data written to a disk being unplugged).
 *
 * These tests run the REAL moveApp, processInstance, createOrUpdateInstance and undockDisk
 * (only rsync, the app-data helper, compose down / network prune and the Docker start/stop
 * are fakes; the fake instance copy really copies the folder so the target compose.yaml exists).
 *   1. Running instance: storedOn is the target, started on the target with storedOn = target
 *   2. ejecting the target disk afterwards stops the moved instance (the kc8 holder)
 *   3. a register that does not claim (storedOn on a third disk) fails the move loud
 *   4. createOrUpdateInstance moveFrom: claims only from that exact source disk
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'

const events: string[] = []
let storeRef: DocHandle<any> | null = null
const storedOnOf = (id: string) => storeRef?.doc()?.instanceDB?.[id]?.storedOn ?? null

vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        stopInstance: vi.fn(async (h: any, inst: any, disk: any) => {
            events.push(`stop:${disk.id}`)
            h.change((doc: any) => { const r = doc.instanceDB[inst.id]; if (r) r.status = 'Stopped' })
        }),
        startInstance: vi.fn(async (h: any, inst: any, disk: any) => {
            events.push(`start:${disk.id}:storedOn=${storedOnOf(inst.id)}`)
            h.change((doc: any) => { const r = doc.instanceDB[inst.id]; if (r) r.status = 'Running' })
        }),
    }
})

const { DISKS_ROOT_P } = vi.hoisted(() => ({ DISKS_ROOT_P: { v: '' } }))
vi.mock('../../src/utils/rsync.js', () => ({
    rsyncDirectory: vi.fn(async () => {}),
    // Really copy the instance folder: the target registration reads its compose.yaml
    rsyncInstanceData: vi.fn(async (t: any) => {
        const { fs: zfs } = await import('zx')
        await zfs.copy(`${DISKS_ROOT_P.v}/${t.srcRoot}/instances/${t.srcId}`, `${DISKS_ROOT_P.v}/${t.dstRoot}/instances/${t.dstId}`)
    }),
}))
vi.mock('../../src/utils/appDataHelper.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        instanceDataBytes: vi.fn(async () => 1024),
        deleteInstanceData: vi.fn(async (root: string, id: string) => {
            const { fs: zfs } = await import('zx')
            await zfs.remove(`${DISKS_ROOT_P.v}/${root}/instances/${id}`)
        }),
    }
})
vi.mock('../../src/utils/instanceNetworks.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        composeDownAt: vi.fn(async () => undefined),
        pruneUnusedInstanceNetworks: vi.fn(async () => ({ removed: [], skipped: [], errors: [] })),
    }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import * as DiskMod from '../../src/data/Disk.js'
import { createOrUpdateInstance } from '../../src/data/Instance.js'
import { moveApp } from '../../src/data/CopyMoveApp.js'
import { undockDisk } from '../../src/monitors/usbDeviceMonitor.js'
import { config } from '../../src/data/Config.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
// engine#497 (helper v20): marker, verify-copy and the version check, recorded (no sudo)
import { inFlightHelper } from '../../src/data/InFlight.js'
beforeEach(() => {
    inFlightHelper.atLeast = async () => null
    inFlightHelper.run = async (args: string[]) => args[0] === 'verify-copy' ? 'differences=0\n' : ''
})

DISKS_ROOT_P.v = DISKS_ROOT

// Same shape as the kc8 step-43 Kolibri copy: a dashed 19-char id
const INST = 'la7no6b75h72yvq6orn' as InstanceID
const APP = 'sample-app-1.0'

const makeDisk = (id: string, device: string): Disk => ({
    id: id as DiskID, name: `disk-${id}` as DiskName, device: device as any,
    dockedTo: String(localEngineId) as EngineID, created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp, diskTypes: ['app'], backupConfig: null,
} as Disk)

const COMPOSE = ['services:', '  web:', '    image: sample/web:1.0', 'x-app:', '  name: sample-app',
    '  version: "1.0"', `  instanceName: ${INST}`, ''].join('\n')

const devices: string[] = []
const newDevice = (): string => { let d: string; do { d = uniqueTestDevice() } while (devices.includes(d)); devices.push(d); return d }

interface World { h: DocHandle<Store>, source: Disk, target: Disk }

const setup = async (status: string): Promise<World> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    storeRef = h as any
    const source = makeDisk('kc8-nc', newDevice())
    const target = makeDisk('kc8-empty-001', newDevice())
    const src = `${DISKS_ROOT}/${source.device}`
    await fs.ensureDir(`${src}/apps/${APP}`)
    await fs.writeFile(`${src}/apps/${APP}/compose.yaml`, COMPOSE)
    await fs.ensureDir(`${src}/instances/${INST}`)
    await fs.writeFile(`${src}/instances/${INST}/compose.yaml`, COMPOSE)
    await fs.ensureDir(`${DISKS_ROOT}/${target.device}`)
    h.change(doc => {
        doc.diskDB[source.id] = source
        doc.diskDB[target.id] = target
        doc.instanceDB[INST] = {
            id: INST, instanceOf: APP as any, name: INST as any, status: status as any,
            port: 58110 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: source.id,
            currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
    return { h, source, target }
}

const moveOp = (h: DocHandle<Store>) => Object.values(h.doc()!.operationDB).find((o: any) => o.kind === 'moveApp') as any
const saved = { testMode: config.settings.testMode }

beforeEach(() => {
    events.length = 0
    config.settings.testMode = true
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
    vi.restoreAllMocks()
    config.settings.testMode = saved.testMode
    storeRef = null
    for (const d of devices.splice(0)) await fs.remove(`${DISKS_ROOT}/${d}`)
})

describe('same-Engine moveApp re-homes the instance (kc8 step 104)', () => {
    it('1. a Running instance ends storedOn the target and is started there with storedOn = target', async () => {
        const w = await setup('Running')
        await moveApp(w.h, INST as any, w.source.id, w.target.id)
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.target.id))
        expect(events).toEqual([`stop:${w.source.id}`, `start:${w.target.id}:storedOn=${w.target.id}`])
        expect(moveOp(w.h)?.status).toBe('Done')
        expect(await fs.pathExists(`${DISKS_ROOT}/${w.source.device}/instances/${INST}`)).toBe(false)
        expect(await fs.pathExists(`${DISKS_ROOT}/${w.target.device}/instances/${INST}/compose.yaml`)).toBe(true)
    })

    it('2. ejecting the target disk after the move stops the moved instance (the kc8 partition holder)', async () => {
        const w = await setup('Running')
        await moveApp(w.h, INST as any, w.source.id, w.target.id)
        events.length = 0
        await undockDisk(w.h, w.h.doc()!.diskDB[w.target.id] as Disk, { waitInFlight: false })
        expect(events).toEqual([`stop:${w.target.id}`])
        expect(w.h.doc()!.instanceDB[INST].status).toBe('Undocked')
    })

    it('3. a register that does not claim the id fails the move loud; the parked move keeps the source stopped (engine#497 stage 3 c)', async () => {
        const w = await setup('Running')
        const real = DiskMod.processInstance
        // e.g. a concurrent writer moved storedOn to a third disk: the moveFrom claim must refuse
        w.h.change(doc => { (doc.diskDB as any)['kc8-third'] = makeDisk('kc8-third', 'idea-test-0') })
        const spy = vi.spyOn(DiskMod, 'processInstance').mockImplementation(async (h, disk, id, opts) => {
            h.change(doc => { (doc.instanceDB as any)[id].storedOn = 'kc8-third' })
            const r = await real(h, disk, id, opts)
            h.change(doc => { (doc.instanceDB as any)[id].storedOn = w.source.id })
            return r
        })
        await expect(moveApp(w.h, INST as any, w.source.id, w.target.id)).rejects.toThrow(/not registered on/)
        spy.mockRestore()
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.source.id))
        // engine#497 (Koen's rule): a real failure after the marker parks the op (1/3) and keeps the partial target
        expect(moveOp(w.h)?.status).toBe('Pending')
        expect(moveOp(w.h)?.error).toMatch(/^RESUME_PENDING \(1\/3\): moveApp: instance .* was not registered on/)
        // engine#497 stage 3 (c): not started again while the move is in flight (only if it gives up)
        expect(events).toEqual([`stop:${w.source.id}`])
        expect(await fs.pathExists(`${DISKS_ROOT}/${w.target.device}/instances/${INST}`)).toBe(true)
    })

    it('4. createOrUpdateInstance moveFrom claims only from that exact source disk', async () => {
        const w = await setup('Stopped')
        await fs.copy(`${DISKS_ROOT}/${w.source.device}/instances/${INST}`, `${DISKS_ROOT}/${w.target.device}/instances/${INST}`)
        // no option: the engine#381 guard still refuses
        await createOrUpdateInstance(w.h, INST, w.target)
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.source.id))
        // moveFrom a different disk: refused
        await createOrUpdateInstance(w.h, INST, w.target, { moveFrom: 'some-other-disk' as DiskID })
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.source.id))
        // moveFrom the real source: claimed, status kept
        await createOrUpdateInstance(w.h, INST, w.target, { moveFrom: w.source.id })
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.target.id))
        expect(w.h.doc()!.instanceDB[INST].status).toBe('Stopped')
    })
})
