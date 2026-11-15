/**
 * restore-reclaim.test.ts (engine#418)
 *
 * restoreApp onto ANOTHER disk returned ok but left the instance on its source disk:
 * the engine#381 claim guard in createOrUpdateInstance refused the id because
 * storedOn was a different disk, and nothing checked the outcome. Koen's decision
 * (Q2, via Steve): keep the #190 contract with an explicit restore-reclaim.
 *
 * Unlike restore-restart / restore-pre-quarantine, these tests run the REAL
 * processInstance and createOrUpdateInstance (only Instance.ts startInstance, the
 * #189 app-files copy, the lifecycle stop/start and the helper quarantine are fakes).
 *   1. source docked here, Stopped: re-homed onto the target, old folder quarantined, op Done
 *   2. source docked here, Running: stop, claim, then the #413 start on the target
 *   3. source undocked (lost disk): claimed, and started on the target only after the claim
 *   4. source docked to another Engine: SOURCE_ON_OTHER_ENGINE before any extract
 *   5. no claim (source Starting here): RESTORE_NOT_CLAIMED, op Failed, target copy
 *      quarantined, no start
 *   6. #381 regression: a plain dock of a leftover folder whose storedOn is another
 *      disk is neither claimed nor started
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'

const events: string[] = []
let startSeen: { diskId: string, storedOn: string | null }[] = []
let storeRef: DocHandle<any> | null = null

vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        // processInstance's auto-start (tracedStartInstance → startInstance): record, no Docker
        startInstance: vi.fn(async (_h: any, inst: any, disk: any) => {
            events.push(`autostart:${disk.id}`)
            startSeen.push({ diskId: String(disk.id), storedOn: storeRef?.doc()?.instanceDB?.[inst.id]?.storedOn ?? null })
        }),
    }
})
vi.mock('../../src/data/RestoreAppFiles.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, ensureAppFilesOnTarget: vi.fn(async () => {}) }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk, processInstance } from '../../src/data/Disk.js'
import { createOrUpdateInstance, restoreReclaimDecision } from '../../src/data/Instance.js'
import { config } from '../../src/data/Config.js'
import { restoreApp, backupLifecycle, RESTORE_POST_START_CAUSE } from '../../src/monitors/backupMonitor.js'
import { defaultPreQuarantineDeps } from '../../src/data/RestorePreQuarantine.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-reclaim-418' as InstanceID
const OTHER_ENGINE = 'other-engine-418' as EngineID

const makeDisk = (id: string, device: string | null, kind: 'app' | 'backup', dockedTo: string | null = String(localEngineId)): Disk => ({
    id: id as DiskID,
    name: `${kind}-${id}` as DiskName,
    device: device as any,
    dockedTo: dockedTo as EngineID,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: kind === 'backup' ? ['backup'] : ['app'],
    backupConfig: null,
} as Disk)

const COMPOSE = [
    'services:',
    '  web:',
    '    image: sample/web:1.0',
    'x-app:',
    '  name: sample-app',
    '  version: "1.0"',
    `  instanceName: ${INST}`,
    '',
].join('\n')

const devices: string[] = []
const newDevice = (): string => {
    let d: string
    do { d = uniqueTestDevice() } while (devices.includes(d))
    devices.push(d)
    return d
}
const instDir = (device: string) => `${DISKS_ROOT}/${device}/instances/${INST}`
const writeInstance = async (device: string) => {
    await fs.ensureDir(instDir(device))
    await fs.writeFile(`${instDir(device)}/compose.yaml`, COMPOSE)
}

const saved = { testMode: config.settings.testMode, skipBorg: config.settings.skipBorg }
const origLifecycle = { ...backupLifecycle }
const origDeps = { ...defaultPreQuarantineDeps }
let quarantined: { disk: string, path: string }[] = []

interface World {
    h: DocHandle<Store>
    source: Disk
    target: Disk
    targetDevice: string
    sourceDevice: string | null
}

/**
 * Source disk A (storedOn) and target disk B, both App Disks, plus a Backup Disk
 * with a repo for INST. skipBorg: the "extracted" folder is written on B up front,
 * as borg-extract would leave it (except for test 4, which checks it is never touched).
 */
const setup = async (opts: { status: string, source: 'local' | 'undocked' | 'other', extracted?: boolean }): Promise<World> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    storeRef = h as any
    const sourceDevice = opts.source === 'undocked' ? null : newDevice()
    const targetDevice = newDevice()
    const backupDevice = newDevice()
    const source = makeDisk('r418-a', sourceDevice, 'app',
        opts.source === 'local' ? String(localEngineId) : opts.source === 'other' ? OTHER_ENGINE : null)
    const target = makeDisk('r418-b', targetDevice, 'app')
    const backup = makeDisk('r418-bd', backupDevice, 'backup')
    if (sourceDevice) await writeInstance(sourceDevice)
    if (opts.extracted !== false) await writeInstance(targetDevice)
    await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
    await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\n')
    h.change(doc => {
        doc.diskDB[source.id] = source
        doc.diskDB[target.id] = target
        doc.diskDB[backup.id] = backup
        doc.instanceDB[INST] = {
            id: INST, instanceOf: 'sample-app-1.0' as any, name: INST as any, status: opts.status as any,
            port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: source.id,
            currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
    return { h, source, target, targetDevice, sourceDevice }
}

const restoreOp = (h: DocHandle<Store>) =>
    Object.values(h.doc()!.operationDB).find((o: any) => o.kind === 'restoreApp') as any

let stop: ReturnType<typeof vi.fn>
let start: ReturnType<typeof vi.fn>

beforeEach(() => {
    events.length = 0
    startSeen = []
    quarantined = []
    config.settings.testMode = true
    config.settings.skipBorg = true
    stop = vi.fn(async (h: DocHandle<Store>, inst: any, disk: any) => {
        events.push(`stop:${disk.id}`)
        h.change(doc => { (doc.instanceDB as any)[inst.id].status = 'Stopped' })
    })
    start = vi.fn(async (h: DocHandle<Store>, inst: any, disk: any) => {
        events.push(`restart:${disk.id}`)
        startSeen.push({ diskId: String(disk.id), storedOn: (h.doc() as any)?.instanceDB?.[inst.id]?.storedOn ?? null })
    })
    backupLifecycle.stopInstance = stop as any
    backupLifecycle.startInstance = start as any
    // helper v4+ present; the fake quarantine moves the folder like `idea-app-data quarantine`
    defaultPreQuarantineDeps.helperProblem = async () => null
    defaultPreQuarantineDeps.quarantine = async (disk: Disk, id: InstanceID) => {
        const q = `${DISKS_ROOT}/${disk.device}/.idea-quarantine/${id}-test`
        await fs.move(`${DISKS_ROOT}/${disk.device}/instances/${id}`, q)
        events.push(`quarantine:${disk.id}`)
        quarantined.push({ disk: String(disk.id), path: q })
        return q
    }
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
    vi.restoreAllMocks()
    Object.assign(backupLifecycle, origLifecycle)
    Object.assign(defaultPreQuarantineDeps, origDeps)
    config.settings.testMode = saved.testMode
    config.settings.skipBorg = saved.skipBorg
    storeRef = null
    for (const d of devices.splice(0)) await fs.remove(`${DISKS_ROOT}/${d}`)
})

describe('restoreApp onto another disk re-homes the instance (engine#418)', () => {
    it('1. source docked here and Stopped: storedOn is the target, old folder quarantined, op Done, no start', async () => {
        const w = await setup({ status: 'Stopped', source: 'local' })
        await restoreApp(w.h, INST, w.target)
        const rec = w.h.doc()!.instanceDB[INST] as any
        expect(String(rec.storedOn)).toBe(String(w.target.id))
        expect(rec.status).toBe('Stopped')
        expect(quarantined.map(q => q.disk)).toEqual([String(w.source.id)])
        expect(await fs.pathExists(instDir(w.sourceDevice!))).toBe(false)
        expect(await fs.pathExists(quarantined[0].path)).toBe(true)
        expect(await fs.pathExists(`${instDir(w.targetDevice)}/compose.yaml`)).toBe(true)
        expect(restoreOp(w.h)?.status).toBe('Done')
        expect(startSeen).toEqual([])
    })

    it('2. source docked here and Running: stop on the source, claim, then the #413 start on the target', async () => {
        const w = await setup({ status: 'Running', source: 'local' })
        await restoreApp(w.h, INST, w.target)
        expect(events).toEqual([`stop:${w.source.id}`, `quarantine:${w.source.id}`, `restart:${w.target.id}`])
        expect(startSeen).toEqual([{ diskId: String(w.target.id), storedOn: String(w.target.id) }])
        expect(start.mock.calls[0][3]).toBe(RESTORE_POST_START_CAUSE)
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.target.id))
        expect(restoreOp(w.h)?.status).toBe('Done')
    })

    it('3. source undocked (lost disk): claimed on the target, started there only after the claim', async () => {
        const w = await setup({ status: 'Undocked', source: 'undocked' })
        await restoreApp(w.h, INST, w.target)
        const rec = w.h.doc()!.instanceDB[INST] as any
        expect(String(rec.storedOn)).toBe(String(w.target.id))
        expect(rec.status).toBe('Docked')
        expect(startSeen).toEqual([{ diskId: String(w.target.id), storedOn: String(w.target.id) }])
        expect(stop).not.toHaveBeenCalled()
        expect(quarantined).toEqual([])
        expect(restoreOp(w.h)?.status).toBe('Done')
    })

    it('4. source docked to another Engine: SOURCE_ON_OTHER_ENGINE before any extract, target untouched', async () => {
        const w = await setup({ status: 'Running', source: 'other', extracted: false })
        await expect(restoreApp(w.h, INST, w.target)).rejects.toThrow(/^SOURCE_ON_OTHER_ENGINE: /)
        expect(await fs.pathExists(`${DISKS_ROOT}/${w.targetDevice}/instances`)).toBe(false)
        expect(stop).not.toHaveBeenCalled()
        expect(events).toEqual([])
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.source.id))
        expect(restoreOp(w.h)?.status).toBe('Failed')
        expect(restoreOp(w.h)?.error).toMatch(/SOURCE_ON_OTHER_ENGINE/)
    })

    it('5. no claim (source Starting here): RESTORE_NOT_CLAIMED, op Failed, target copy quarantined, no start', async () => {
        const w = await setup({ status: 'Starting', source: 'local' })
        await expect(restoreApp(w.h, INST, w.target)).rejects.toThrow(/^RESTORE_NOT_CLAIMED: .* remains on r418-a; the restored copy is quarantined at /)
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.source.id))
        expect(quarantined.map(q => q.disk)).toEqual([String(w.target.id)])
        expect(await fs.pathExists(instDir(w.targetDevice))).toBe(false)
        expect(await fs.pathExists(instDir(w.sourceDevice!))).toBe(true)
        expect(startSeen).toEqual([])
        expect(start).not.toHaveBeenCalled()
        expect(restoreOp(w.h)?.status).toBe('Failed')
        expect(restoreOp(w.h)?.error).toMatch(/RESTORE_NOT_CLAIMED/)
    })
})

describe('engine#381 guard unchanged outside restoreApp (engine#418 regression)', () => {
    it('6. a plain dock of a leftover folder whose storedOn is another (docked, Stopped) disk is not claimed and not started', async () => {
        const w = await setup({ status: 'Stopped', source: 'local' })
        await processInstance(w.h, w.target, INST)
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.source.id))
        expect(startSeen).toEqual([])
    })

    it('6b. the same for a lost (undocked) storedOn disk: only restoreApp may reclaim', async () => {
        const w = await setup({ status: 'Undocked', source: 'undocked' })
        await processInstance(w.h, w.target, INST)
        const rec = w.h.doc()!.instanceDB[INST] as any
        expect(String(rec.storedOn)).toBe(String(w.source.id))
        expect(rec.status).toBe('Undocked')
        expect(startSeen).toEqual([])
    })

    it('createOrUpdateInstance with reclaim refuses a storedOn disk where the instance is Running', async () => {
        const w = await setup({ status: 'Running', source: 'local' })
        await createOrUpdateInstance(w.h, INST, w.target, { reclaim: 'restore' })
        expect(String(w.h.doc()!.instanceDB[INST].storedOn)).toBe(String(w.source.id))
    })

    it('restoreReclaimDecision covers the (a) / (b) matrix', async () => {
        const local = await setup({ status: 'Stopped', source: 'local' })
        const s = local.h.doc()!
        const rec = (status: string, storedOn: string | null = 'r418-a') => ({ id: INST, storedOn: storedOn as any, status: status as any })
        expect(restoreReclaimDecision(s, rec('Stopped'), local.target).allowed).toBe(true)
        expect(restoreReclaimDecision(s, rec('Docked'), local.target).allowed).toBe(true)
        expect(restoreReclaimDecision(s, rec('Running'), local.target).allowed).toBe(false)
        expect(restoreReclaimDecision(s, rec('Starting'), local.target).allowed).toBe(false)
        expect(restoreReclaimDecision(s, rec('Running', 'no-such-disk'), local.target).allowed).toBe(true)
        expect(restoreReclaimDecision(s, rec('Stopped'), local.target, 'some-other-engine').allowed).toBe(false)
        expect(restoreReclaimDecision(s, rec('Running', 'r418-b'), local.target).allowed).toBe(true)
    })
})
