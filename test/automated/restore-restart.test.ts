/**
 * restore-restart.test.ts (engine#413)
 *
 * Kid's #403 proofs on idea03: an in-place restoreApp of a Running Nextcloud and
 * Kolibri stopped the app, extracted, and left it Stopped, because the restore's
 * own stop writes status Stopped and processInstance then skips the auto-start
 * (shouldAutoStart: 'status is Stopped'). restoreApp now remembers wasRunning
 * before the pre-stop and starts the instance after processInstance, like
 * moveApp (idea#474). Covers:
 *   - Running before the restore: stopped, then started after processInstance
 *   - Stopped before the restore: no stop and no start
 *   - the start cause is not a user cause (AutoStart USER_CAUSES)
 *   - the regression: the just-stopped record alone would be skipped by shouldAutoStart
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'

const order: string[] = []

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, processInstance: vi.fn(async () => { order.push('processInstance') }) }
})
vi.mock('../../src/data/RestoreAppFiles.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, ensureAppFilesOnTarget: vi.fn(async () => {}) }
})
vi.mock('../../src/data/RestorePreQuarantine.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, assertPreQuarantineHelper: vi.fn(async () => null), quarantinePreRestore: vi.fn(async () => null) }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { restoreApp, backupLifecycle, RESTORE_POST_START_CAUSE } from '../../src/monitors/backupMonitor.js'
import { USER_CAUSES, shouldAutoStart } from '../../src/data/AutoStart.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-restore-413' as InstanceID

const makeDisk = (id: string, device: string, backup: boolean): Disk => ({
    id: id as DiskID,
    name: (backup ? 'Backup Disk' : 'App Disk') as DiskName,
    device: device as any,
    dockedTo: localEngineId as EngineID,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: backup ? ['backup'] : ['app'],
    backupConfig: null,
} as Disk)

let appDevice: string
let backupDevice: string
const saved = { testMode: config.settings.testMode, skipBorg: config.settings.skipBorg }
const orig = { ...backupLifecycle }
let stop: ReturnType<typeof vi.fn>
let start: ReturnType<typeof vi.fn>

const setup = async (status: 'Running' | 'Stopped') => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    const appDisk = makeDisk('r413-ad', appDevice, false)
    const backupDisk = makeDisk('r413-bd', backupDevice, true)
    h.change(doc => {
        doc.diskDB[appDisk.id] = appDisk
        doc.diskDB[backupDisk.id] = backupDisk
        doc.instanceDB[INST] = {
            id: INST, instanceOf: 'sample-app' as any, name: INST as any, status: status as any,
            port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: appDisk.id,
            currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
    return { h, appDisk }
}

beforeEach(async () => {
    order.length = 0
    appDevice = uniqueTestDevice()
    do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
    await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
    await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
    await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\n')
    config.settings.testMode = true
    config.settings.skipBorg = true
    // the fake stop writes Stopped, like Instance.ts stopInstance does
    stop = vi.fn(async (h: DocHandle<Store>, inst: any) => {
        order.push('stop')
        h.change(doc => { (doc.instanceDB as any)[inst.id].status = 'Stopped' })
    })
    start = vi.fn(async () => { order.push('start') })
    backupLifecycle.stopInstance = stop as any
    backupLifecycle.startInstance = start as any
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
    vi.restoreAllMocks()
    backupLifecycle.stopInstance = orig.stopInstance
    backupLifecycle.startInstance = orig.startInstance
    config.settings.testMode = saved.testMode
    config.settings.skipBorg = saved.skipBorg
    await fs.remove(`${DISKS_ROOT}/${appDevice}`)
    await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
})

describe('restoreApp in place restarts an instance that was Running (engine#413)', () => {
    it('Running: stopped with backup-pre-stop, then started after processInstance', async () => {
        const { h, appDisk } = await setup('Running')
        await restoreApp(h, INST, appDisk)
        expect(order).toEqual(['stop', 'processInstance', 'start'])
        expect(stop.mock.calls[0][3]).toBe('backup-pre-stop')
        const [, rec, disk, cause] = start.mock.calls[0]
        expect(rec.id).toBe(INST)
        expect(String(disk.id)).toBe(String(appDisk.id))
        expect(cause).toBe(RESTORE_POST_START_CAUSE)
        const op = Object.values(h.doc()!.operationDB).find((o: any) => o.kind === 'restoreApp') as any
        expect(op?.status).toBe('Done')
    })

    it('Stopped: no stop and no start (a stopped app stays stopped)', async () => {
        const { h, appDisk } = await setup('Stopped')
        await restoreApp(h, INST, appDisk)
        expect(order).toEqual(['processInstance'])
        expect(stop).not.toHaveBeenCalled()
        expect(start).not.toHaveBeenCalled()
    })

    it('the post-restore start cause is an Engine cause, not a user cause', () => {
        expect(USER_CAUSES.has(RESTORE_POST_START_CAUSE)).toBe(false)
        expect(USER_CAUSES.has('backup-pre-stop')).toBe(false)
    })

    it('regression: the record the restore stop leaves behind is skipped by shouldAutoStart, so the explicit start is needed', async () => {
        const { h, appDisk } = await setup('Running')
        await restoreApp(h, INST, appDisk)
        const rec = h.doc()!.instanceDB[INST] as any
        expect(rec.status).toBe('Stopped')
        expect(shouldAutoStart(h.doc()!, rec)).toMatchObject({ start: false, reason: 'status is Stopped' })
        expect(start).toHaveBeenCalledTimes(1)
    })
})
