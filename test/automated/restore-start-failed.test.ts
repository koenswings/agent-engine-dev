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
 *     restored files are not rolled back and the locks are released;
 *   - helper v19 moves the replaced instance folder into .idea-quarantine; the
 *     Engine logs that path and puts it in the trace result and the error;
 *   - an in-place restore refuses HELPER_OUTDATED below v19, before any stop.
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
const helperFake = vi.hoisted(() => ({
    problem: null as string | null,
    extractOut: '',
    calls: [] as string[][],
}))
vi.mock('../../src/utils/appDataHelper.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        borgProblem: () => null,
        helperAtLeast: vi.fn(async () => helperFake.problem),
        runAppData: vi.fn(async (args: string[]) => {
            helperFake.calls.push(args)
            if (args[0] === 'borg-info') {
                return JSON.stringify({ archives: [{ name: '2026-11-16T03-34-19-273Z-hook', command_line: ['/usr/bin/borg', 'create', 'x::y', `/disks/sdb1/instances/${args[2]}`] }] })
            }
            if (args[0] === 'borg-extract') return helperFake.extractOut
            return ''
        }),
    }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { PORT_NOT_READY_PREFIX } from '../../src/data/Instance.js'
import {
    restoreApp, backupLifecycle, restoreStartOutcome, postStartWarningMessage, replacedFolderNote,
} from '../../src/monitors/backupMonitor.js'
import { parseBorgExtract, APP_DATA_HELPER_VERSION, RESTORE_REPLACED_QUARANTINE_HELPER_MIN } from '../../src/utils/appDataHelper.js'
import { resourceLock, instanceKey, diskKey } from '../../src/utils/ResourceLock.js'
import { runWithTrace } from '../../src/utils/CommandLogger.js'
import { takePendingTraceCloseMessage, takePendingTraceResult } from '../../src/data/CommandLogStore.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-468-restore' as InstanceID
const DB_EXITED = 'Engine error: dependency nextcloud-db failed to start: container inst-468-restore-nextcloud-db-1 exited (1)'
const QPATH = '/disks/sdb1/.idea-quarantine/inst-468-restore-replaced-20261116T033756123456789Z'

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

describe('restoreStartOutcome / postStartWarningMessage / parseBorgExtract (engine#468, pure)', () => {
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

    it('parseBorgExtract reads the v19 key=value lines and ignores anything else', () => {
        expect(parseBorgExtract('')).toEqual({ replacedQuarantine: null, replacedKept: null })
        // v19 never prunes; an old pruned= line is just noise
        expect(parseBorgExtract(`noise\nreplacedQuarantine=${QPATH}\npruned=/disks/sdb1/.idea-quarantine/a-replaced-1\n`)).toEqual({
            replacedQuarantine: QPATH, replacedKept: null,
        })
        expect(parseBorgExtract('replacedKept=/disks/sdb1/.idea-app-data-staging/restore-x.AbC/.previous\nreplacedQuarantine=relative\n')).toEqual({
            replacedQuarantine: null, replacedKept: '/disks/sdb1/.idea-app-data-staging/restore-x.AbC/.previous',
        })
        expect(replacedFolderNote({ replacedQuarantine: QPATH, replacedKept: null })).toBe(`the replaced folder is in quarantine at ${QPATH}`)
        expect(replacedFolderNote({ replacedQuarantine: null, replacedKept: '/k' })).toBe('the replaced folder could not be quarantined and is kept at /k')
        expect(replacedFolderNote({ replacedQuarantine: null, replacedKept: null })).toBeNull()
    })

    it('Engine speaks helper v21 and an in-place restore still needs v19', () => {
        expect(APP_DATA_HELPER_VERSION).toBe('21')
        expect(RESTORE_REPLACED_QUARANTINE_HELPER_MIN).toBe(19)
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
        helperFake.problem = null
        helperFake.extractOut = ''
        helperFake.calls.length = 0
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

    it('helper v19: the quarantine path of the replaced folder is in the trace result (ok) and in RESTORE_START_FAILED', async () => {
        config.settings.skipBorg = false
        helperFake.extractOut = `replacedQuarantine=${QPATH}\n`
        const first = await setup()
        startLeaves('Running', null)
        expect(await traced('tr-468-q-ok', () => restoreApp(first.h, INST, first.appDisk))).toBeNull()
        expect(helperFake.calls.map(c => c[0])).toEqual(['borg-info', 'borg-extract'])
        expect(JSON.parse(takePendingTraceResult('tr-468-q-ok')!)).toEqual({ replacedQuarantine: QPATH })

        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
        const second = await setup()
        startLeaves('Error', DB_EXITED)
        const error = await traced('tr-468-q-failed', () => restoreApp(second.h, INST, second.appDisk))
        expect(error).toBe(`RESTORE_START_FAILED: restored files to App Disk; the instance did not start: ${DB_EXITED}; the replaced folder is in quarantine at ${QPATH}`)
        expect(JSON.parse(takePendingTraceResult('tr-468-q-failed')!)).toEqual({ replacedQuarantine: QPATH })
    })

    it('helper v19 could not quarantine: the restore still succeeds and reports where the folder was kept', async () => {
        config.settings.skipBorg = false
        const kept = `/disks/sdb1/.idea-app-data-staging/restore-${INST}.AbC123/.previous`
        helperFake.extractOut = `replacedKept=${kept}\n`
        const { h, appDisk } = await setup()
        startLeaves('Running', null)
        expect(await traced('tr-468-kept', () => restoreApp(h, INST, appDisk))).toBeNull()
        expect(opOf(h)?.status).toBe('Done')
        expect(JSON.parse(takePendingTraceResult('tr-468-kept')!)).toEqual({ replacedKept: kept })
    })

    it('an in-place restore with a helper older than v19 refuses HELPER_OUTDATED before any stop or extract', async () => {
        config.settings.skipBorg = false
        helperFake.problem = 'restoreApp onto an existing instance folder needs the app-data root helper v19 or later'
        const { h, appDisk } = await setup()
        startLeaves('Running', null)
        const error = await traced('tr-468-old', () => restoreApp(h, INST, appDisk))
        expect(error).toMatch(/^HELPER_OUTDATED: restoreApp onto an existing instance folder/)
        expect(stopCalls).toBe(0)
        expect(helperFake.calls).toEqual([])
        expect(opOf(h)?.status).toBe('Failed')
        expect(h.doc()!.instanceDB[INST].status).toBe('Running')
    })
})
