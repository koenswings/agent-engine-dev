/**
 * backup-locks.test.ts
 *
 * idea#126 (Files Disk step 0, backup locks):
 *   - every backup takes the instance lock and the Backup Disk lock together
 *     via resourceLock.acquireAll (as restore does) and releases both
 *   - a backup is not started while either is locked, with an error trace
 *   - a failure inside the backup gives an error trace with its message
 *   - ejectDisk is refused while a backupApp operation with that backupDiskId
 *     is running, whatever started it (runningBackupOnDisk)
 *
 * testMode: borg is skipped; store, lock files and traces are real.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp, OperationCause } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { backupInstance, backupLockKeysFor, runningBackupOnDisk, createBackupDiskConfig } from '../../src/monitors/backupMonitor.js'
import { runWithTrace } from '../../src/utils/CommandLogger.js'
import { resourceLock, instanceKey, diskKey } from '../../src/utils/ResourceLock.js'
import { createOperation, updateOperation } from '../../src/data/Operations.js'
import { CommandLogStore, CommandTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-126' as InstanceID
let appDevice = ''
let backupDevice = ''

const newStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const h = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} })
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}
const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] =>
    h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])

const makeDisk = (id: string, name: string, device: string | null, backup = false): Disk => ({
    id: id as DiskID, name: name as DiskName, device: device as any, dockedTo: localEngineId as EngineID,
    created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: backup ? ['backup'] : ['app'], backupConfig: null,
})

const setup = async () => {
    const storeHandle = await newStore()
    const appDisk = makeDisk('ad-126', 'AppDisk126', appDevice)
    const backupDisk = makeDisk('bd-126', 'BackupDisk126', backupDevice, true)
    storeHandle.change(doc => {
        doc.diskDB[appDisk.id] = appDisk
        doc.diskDB[backupDisk.id] = backupDisk
        doc.instanceDB[INST] = {
            id: INST, instanceOf: 'sample-app' as any, name: INST as any, status: 'Stopped' as any, port: 8080 as any,
            serviceImages: [], created: 1 as Timestamp, lastBackup: null, lastStarted: 1 as Timestamp, statusCondition: null,
            storedOn: appDisk.id, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
    return { storeHandle, appDisk, backupDisk }
}

describe('backup locks via acquireAll (idea#126)', () => {
    let logHandle: DocHandle<CommandLogStore>

    beforeEach(async () => {
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\n')
        logHandle = newCommandLog()
        setCommandLogHandle(logHandle)
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        setCommandLogHandle(null)
        await fs.chmod(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`, 0o755).catch(() => {})
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
    })

    it('takes the instance lock and the Backup Disk lock together, and releases both', async () => {
        const { storeHandle, backupDisk } = await setup()
        const spy = vi.spyOn(resourceLock, 'acquireAll')
        let heldDuringBackup: boolean[] = []
        const origChange = storeHandle.change.bind(storeHandle)
        vi.spyOn(storeHandle, 'change').mockImplementation(((fn: any, opts?: any) => {
            if (heldDuringBackup.length === 0 && resourceLock.isLocked(instanceKey(INST))) {
                heldDuringBackup = [resourceLock.isLocked(instanceKey(INST)), resourceLock.isLocked(diskKey(backupDisk.id))]
            }
            return origChange(fn, opts)
        }) as any)

        await backupInstance(storeHandle, INST, backupDisk)

        expect(spy).toHaveBeenCalledWith([instanceKey(INST), diskKey(backupDisk.id)], 'backupApp')
        expect(backupLockKeysFor(INST, backupDisk.id)).toEqual([`instance:${INST}`, `disk:${backupDisk.id}`])
        expect(heldDuringBackup).toEqual([true, true])
        expect(resourceLock.isLocked(instanceKey(INST))).toBe(false)
        expect(resourceLock.isLocked(diskKey(backupDisk.id))).toBe(false)
        expect(storeHandle.doc()!.instanceDB[INST].lastBackup).toBeGreaterThan(0)
        const op = Object.values(storeHandle.doc()!.operationDB).find(o => o.kind === 'backupApp')
        expect(op?.status).toBe('Done')
    })

    it('does not start while the Backup Disk is locked by another operation: error trace, instance lock untouched', async () => {
        const { storeHandle, backupDisk } = await setup()
        expect(resourceLock.acquire(diskKey(backupDisk.id), 'restoreApp')).toBe(true)
        try {
            await backupInstance(storeHandle, INST, backupDisk)
            expect(storeHandle.doc()!.instanceDB[INST].lastBackup).toBeNull()
            expect(resourceLock.isLocked(instanceKey(INST))).toBe(false)   // rolled back
            const t = traces(logHandle).find(x => x.command === 'backupApp')
            expect(t?.status).toBe('error')
            expect(t?.errorMessage).toContain('locked')
            expect(t?.errorMessage).toContain("'restoreApp'")
        } finally {
            resourceLock.release(diskKey(backupDisk.id))
        }
    })

    it('does not start while the instance is locked either', async () => {
        const { storeHandle, backupDisk } = await setup()
        resourceLock.acquire(instanceKey(INST), 'copyApp')
        try {
            await backupInstance(storeHandle, INST, backupDisk)
            expect(resourceLock.isLocked(diskKey(backupDisk.id))).toBe(false)
            expect(traces(logHandle).find(x => x.command === 'backupApp')?.status).toBe('error')
        } finally {
            resourceLock.release(instanceKey(INST))
        }
    })

    it.skipIf(process.getuid?.() === 0)('a failure inside the backup gives an error trace with its message and a Failed operation', async () => {
        const { storeHandle, backupDisk } = await setup()
        // The lock file cannot be written: the backup fails halfway
        await fs.chmod(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`, 0o555)
        await backupInstance(storeHandle, INST, backupDisk)
        const t = traces(logHandle).find(x => x.command === 'backupApp')
        expect(t?.status).toBe('error')
        expect(t?.errorMessage).toMatch(/EACCES|permission denied/i)
        const op = Object.values(storeHandle.doc()!.operationDB).find(o => o.kind === 'backupApp')
        expect(op?.status).toBe('Failed')
        expect(op?.error).toBe(t?.errorMessage)
        expect(resourceLock.isLocked(diskKey(backupDisk.id))).toBe(false)
    })

    it('inside a command trace (console backupApp) the failure is thrown, so that trace ends as error', async () => {
        const { storeHandle, backupDisk } = await setup()
        resourceLock.acquire(diskKey(backupDisk.id), 'restoreApp')
        try {
            await handleCommand(commands, storeHandle, 'engine', `backupApp ${INST} ${backupDisk.name}`, logHandle)
            const t = traces(logHandle).find(x => x.command === 'backupApp')
            expect(t?.status).toBe('error')
            expect(t?.errorMessage).toContain('locked')
        } finally {
            resourceLock.release(diskKey(backupDisk.id))
        }
    })
})

describe('backup / restore refusals fail loud (idea#168 r29@97)', () => {
    let logHandle: DocHandle<CommandLogStore>
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\n')
        logHandle = newCommandLog()
        setCommandLogHandle(logHandle)
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        setCommandLogHandle(null)
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
    })

    it('restoreApp while the target disk is locked: trace error, no operation', async () => {
        const { storeHandle, appDisk } = await setup()
        resourceLock.acquire(diskKey(appDisk.id), 'copyApp')
        try {
            await handleCommand(commands, storeHandle, 'engine', `restoreApp ${INST} ${appDisk.id}`, logHandle)
            const t = traces(logHandle).find(x => x.command === 'restoreApp')
            expect(t?.status).toBe('error')
            expect(t?.errorMessage).toContain('restoreApp: resource locked')
            expect(Object.values(storeHandle.doc()!.operationDB).find(o => o.kind === 'restoreApp')).toBeUndefined()
        } finally {
            resourceLock.release(diskKey(appDisk.id))
        }
    })

    it('restoreApp that fails (no Backup Disk with archives): trace error, operation Failed, locks released', async () => {
        const { storeHandle, appDisk } = await setup()
        await fs.remove(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`)
        await handleCommand(commands, storeHandle, 'engine', `restoreApp ${INST} ${appDisk.id}`, logHandle)
        const t = traces(logHandle).find(x => x.command === 'restoreApp')
        expect(t?.status).toBe('error')
        expect(t?.errorMessage).toContain(`No docked Backup Disk with archives for instance ${INST}`)
        const op = Object.values(storeHandle.doc()!.operationDB).find(o => o.kind === 'restoreApp')
        expect(op?.status).toBe('Failed')
        expect(resourceLock.isLocked(diskKey(appDisk.id))).toBe(false)
        expect(resourceLock.isLocked(instanceKey(INST))).toBe(false)
    })

    it('a second console backupApp while one runs is refused (throws); a duplicate automatic trigger is a quiet skip', async () => {
        const { storeHandle, backupDisk } = await setup()
        await runWithTrace({ traceId: 't-dup', command: 'backupApp', args: '{}' }, async () => {
            const first = backupInstance(storeHandle, INST, backupDisk, undefined, 'console-command')
            await expect(backupInstance(storeHandle, INST, backupDisk, undefined, 'console-command')).rejects.toThrow('already in progress')
            await expect(backupInstance(storeHandle, INST, backupDisk, undefined, 'backup-app-docked')).resolves.toBeUndefined()
            await first
        })
    })

    it('createBackupDiskConfig on an undocked disk throws', async () => {
        const { storeHandle } = await setup()
        await expect(createBackupDiskConfig(storeHandle, makeDisk('bd-x', 'X', null, true), 'on-demand', [INST]))
            .rejects.toThrow('createBackupDiskConfig: disk bd-x is not docked')
    })
})

describe('eject refused while a backup writes to the disk (idea#126)', () => {
    const errors: string[] = []
    beforeEach(() => {
        errors.length = 0
        vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.join(' ')) })
    })
    afterEach(() => vi.restoreAllMocks())

    const causes: OperationCause[] = ['console-command', 'backup-app-docked', 'backup-stale-lock', 'crash-recovery']
    for (const cause of causes) {
        it(`refuses while a backupApp operation (cause ${cause}) with that backupDiskId is running; allows it once done`, async () => {
            const storeHandle = await newStore()
            const disk = makeDisk(`bd-eject-${cause}`, `EjectMe-${cause}`, 'idea-test-1', true)
            storeHandle.change(doc => { doc.diskDB[disk.id] = disk })
            const opId = createOperation(storeHandle, 'backupApp', { instanceId: 'inst-x', backupDiskId: disk.id }, cause, { type: 'instance', id: 'inst-x' })
            updateOperation(storeHandle, opId, { status: 'Running' })
            // No resource lock is held: only the operation says the disk is busy
            expect(resourceLock.isLocked(diskKey(disk.id))).toBe(false)
            expect(runningBackupOnDisk(storeHandle.doc()!, disk.id)?.id).toBe(opId)

            await handleCommand(commands, storeHandle, 'engine', `ejectDisk ${disk.name}`)
            expect(errors.join('\n')).toContain('in use by a running backup')
            expect(storeHandle.doc()!.diskDB[disk.id].dockedTo).toBe(localEngineId)

            updateOperation(storeHandle, opId, { status: 'Done' })
            expect(runningBackupOnDisk(storeHandle.doc()!, disk.id)).toBeUndefined()
            await handleCommand(commands, storeHandle, 'engine', `ejectDisk ${disk.name}`)
            expect(storeHandle.doc()!.diskDB[disk.id].dockedTo).toBeNull()
        })
    }

    it('runningBackupOnDisk ignores other disks, other kinds and finished backups', async () => {
        const storeHandle = await newStore()
        const mk = (kind: any, backupDiskId: string, status: any) => {
            const id = createOperation(storeHandle, kind, { instanceId: 'i', backupDiskId }, 'console-command')
            updateOperation(storeHandle, id, { status })
            return id
        }
        mk('backupApp', 'other-disk', 'Running')
        mk('restoreApp', 'd1', 'Running')
        mk('backupApp', 'd1', 'Done')
        mk('backupApp', 'd1', 'Failed')
        expect(runningBackupOnDisk(storeHandle.doc()!, 'd1')).toBeUndefined()
        const pending = mk('backupApp', 'd1', 'Pending')
        expect(runningBackupOnDisk(storeHandle.doc()!, 'd1')?.id).toBe(pending)
    })
})
