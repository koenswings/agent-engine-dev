/**
 * restore-start-failed.test.ts (engine#468)
 *
 * An in-place restoreApp of a Running Nextcloud restored the files, the
 * post-restore start ended in Error (the db container exited 1), and the restore
 * still ended Done. Now:
 *   - a PORT_NOT_READY Error after the restart stays START_PENDING with the
 *     Operation Done (engine#428 heal path);
 *   - any other non-Running state fails the restore with RESTORE_START_FAILED
 *     (Operation Failed, the command throws so the trace ends as error); the
 *     restored files are not rolled back and the locks are released.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, processInstance: vi.fn(async () => {}) }
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
import { PORT_NOT_READY_PREFIX } from '../../src/data/Instance.js'
import {
    restoreApp, backupLifecycle, restoreStartOutcome, postStartWarningMessage,
} from '../../src/monitors/backupMonitor.js'
import { resourceLock, instanceKey, diskKey } from '../../src/utils/ResourceLock.js'
import { runWithTrace } from '../../src/utils/CommandLogger.js'
import { takePendingTraceCloseMessage, takePendingTraceResult } from '../../src/data/CommandLogStore.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-468-restore' as InstanceID
const DB_EXITED = 'Engine error: dependency nextcloud-db failed to start: container inst-468-restore-nextcloud-db-1 exited (1)'

const makeDisk = (id: string, device: string, dockedTo: EngineID | null, backup = false): Disk => ({
    id: id as DiskID,
    name: (backup ? 'Backup Disk' : 'App Disk') as DiskName,
    device: device as any,
    dockedTo,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: backup ? ['backup'] : ['app'],
    backupConfig: null,
} as Disk)

describe('restoreStartOutcome / postStartWarningMessage (engine#468, pure)', () => {
    it('Running is ok; PORT_NOT_READY Error is pending; any other state is RESTORE_START_FAILED', () => {
        expect(restoreStartOutcome({ status: 'Running', statusCondition: null } as any, 'App Disk')).toEqual({ kind: 'running' })
        expect(restoreStartOutcome({ status: 'Error', statusCondition: `${PORT_NOT_READY_PREFIX} at=1; never stayed ready` } as any, 'App Disk')).toEqual({ kind: 'pending' })
        expect(restoreStartOutcome({ status: 'Error', statusCondition: DB_EXITED } as any, 'App Disk')).toEqual({
            kind: 'failed', message: `RESTORE_START_FAILED: restored files to App Disk; the instance did not start: ${DB_EXITED}`,
        })
        expect(restoreStartOutcome({ status: 'Stopped', statusCondition: null } as any, 'App Disk')).toEqual({
            kind: 'failed', message: 'RESTORE_START_FAILED: restored files to App Disk; the instance did not start: status is Stopped',
        })
        expect(restoreStartOutcome(undefined, 'App Disk')).toMatchObject({ kind: 'failed' })
    })

    it('a post-start warning only when the instance is not Running', () => {
        expect(postStartWarningMessage({ status: 'Running', statusCondition: null } as any, 'after backup')).toBeNull()
        expect(postStartWarningMessage({ status: 'Error', statusCondition: DB_EXITED } as any, 'after backup'))
            .toBe(`POST_START_WARNING: the instance did not return to Running after backup: ${DB_EXITED}`)
        expect(postStartWarningMessage({ status: 'Stopped', statusCondition: null } as any, 'after failed backup'))
            .toBe('POST_START_WARNING: the instance did not return to Running after failed backup: status is Stopped')
    })
})

describe('restoreApp after the post-restore start (engine#468)', () => {
    let appDevice: string
    let backupDevice: string
    const orig = { ...backupLifecycle }
    const saved = { testMode: config.settings.testMode, skipBorg: config.settings.skipBorg }
    let stopCalls = 0

    const setup = async () => {
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}/data`)
        await fs.writeFile(`${DISKS_ROOT}/${appDevice}/instances/${INST}/data/restored.txt`, 'restored\n')
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\n')
        const h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
        } as unknown as Store)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        const appDisk = makeDisk('r468-ad', appDevice, localEngineId)
        const backupDisk = makeDisk('r468-bd', backupDevice, localEngineId, true)
        h.change(doc => {
            doc.diskDB[appDisk.id] = appDisk
            doc.diskDB[backupDisk.id] = backupDisk
            doc.instanceDB[INST] = {
                id: INST, instanceOf: 'nextcloud' as any, name: INST as any, status: 'Running' as any,
                port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
                lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: appDisk.id,
                currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            } as any
        })
        return { h, appDisk }
    }

    const startLeaves = (status: string, condition: string | null) => {
        backupLifecycle.startInstance = vi.fn(async (handle: any, inst: any) => {
            handle.change((doc: any) => {
                doc.instanceDB[inst.id].status = status
                doc.instanceDB[inst.id].statusCondition = condition
            })
        }) as any
    }

    const opOf = (h: any) => Object.values(h.doc()!.operationDB).find((o: any) => o.kind === 'restoreApp') as any

    const traced = async (traceId: string, fn: () => Promise<void>): Promise<string | null> => {
        let error: string | null = null
        await runWithTrace({ traceId, command: 'restoreApp', args: '{}' }, fn).catch((e: any) => { error = String(e?.message ?? e) })
        return error
    }

    beforeEach(() => {
        config.settings.testMode = true
        config.settings.skipBorg = true
        stopCalls = 0
        backupLifecycle.stopInstance = vi.fn(async (handle: any, inst: any) => {
            stopCalls += 1
            handle.change((doc: any) => { doc.instanceDB[inst.id].status = 'Stopped' })
        }) as any
        vi.spyOn(console, 'info').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        backupLifecycle.stopInstance = orig.stopInstance
        backupLifecycle.startInstance = orig.startInstance
        config.settings.testMode = saved.testMode
        config.settings.skipBorg = saved.skipBorg
        if (appDevice) await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        if (backupDevice) await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
    })

    it('PORT_NOT_READY after the restart: Operation Done, trace START_PENDING (engine#428 unchanged)', async () => {
        const { h, appDisk } = await setup()
        startLeaves('Error', `${PORT_NOT_READY_PREFIX} at=${Date.now()}; Instance ${INST} container is up but host port 8080 never stayed ready for 10000ms within 300000ms.`)
        const error = await traced('tr-468-pending', () => restoreApp(h, INST, appDisk))
        expect(error).toBeNull()
        expect(opOf(h)?.status).toBe('Done')
        expect(takePendingTraceCloseMessage('tr-468-pending')).toMatch(/^START_PENDING: restored; the app did not answer within 300 s/)
        expect(takePendingTraceResult('tr-468-pending')).toContain('START_PENDING')
    })

    it('a hard Error after the restart: RESTORE_START_FAILED, Operation Failed, trace error, files kept, locks released', async () => {
        const { h, appDisk } = await setup()
        startLeaves('Error', DB_EXITED)
        const error = await traced('tr-468-failed', () => restoreApp(h, INST, appDisk))
        const expected = `RESTORE_START_FAILED: restored files to App Disk; the instance did not start: ${DB_EXITED}`
        expect(error).toBe(expected)
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toBe(expected)
        expect(op?.completedAt).toBeTruthy()
        expect(takePendingTraceCloseMessage('tr-468-failed')).toBeUndefined()
        expect(h.doc()!.instanceDB[INST].status).toBe('Error')
        // no rollback: the restored files stay in place
        expect(await fs.readFile(`${DISKS_ROOT}/${appDevice}/instances/${INST}/data/restored.txt`, 'utf8')).toBe('restored\n')
        // the finally still ran
        expect(resourceLock.isLocked(instanceKey(INST))).toBe(false)
        expect(resourceLock.isLocked(diskKey(appDisk.id))).toBe(false)
        expect(backupLifecycle.startInstance).toHaveBeenCalledTimes(1)
    })

    it('a start that leaves the instance Stopped also fails with RESTORE_START_FAILED', async () => {
        const { h, appDisk } = await setup()
        backupLifecycle.startInstance = vi.fn(async () => {}) as any
        const error = await traced('tr-468-stopped', () => restoreApp(h, INST, appDisk))
        expect(error).toBe('RESTORE_START_FAILED: restored files to App Disk; the instance did not start: status is Stopped')
        expect(opOf(h)?.status).toBe('Failed')
    })

    it('a Running restart stays a plain Done', async () => {
        const { h, appDisk } = await setup()
        startLeaves('Running', null)
        const error = await traced('tr-468-ok', () => restoreApp(h, INST, appDisk))
        expect(error).toBeNull()
        expect(opOf(h)?.status).toBe('Done')
        expect(takePendingTraceCloseMessage('tr-468-ok')).toBeUndefined()
        expect(takePendingTraceResult('tr-468-ok')).toBeUndefined()
    })
})
