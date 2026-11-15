/**
 * stale-backup-lock.test.ts — auto-clear of abandoned backup locks (engine#429)
 *
 *   1. Dock with a stale lock: quarantined, store entry dropped, INTERRUPTED once
 *   2. A lock while resourceLock is held is not cleared
 *   3. A lock with a fake live borg pid is not cleared, then is cleared once borg exits
 *   4. A Pending/Running backup or restore Operation, or an undocked disk, is not cleared
 *   5. New lock files carry engineId and bootId
 *   6. INTERRUPTED is recorded once, not twice, when the same lock is seen again
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import {
    processBackupDisk, recordBackupStaleLocks, clearAbandonedBackupLock,
    staleBackupLock, backupLockContents, BACKUP_IN_PROGRESS,
} from '../../src/monitors/backupMonitor.js'
import { createOperation } from '../../src/data/Operations.js'
import { resourceLock, instanceKey, diskKey } from '../../src/utils/ResourceLock.js'
import { fs } from 'zx'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import { drainDataBytesQueue } from '../harness/drainDataBytes.js'
import { config } from '../../src/data/Config.js'

let prevSkipBorg: boolean | undefined
const defaultBorgPid = staleBackupLock.borgPidUsingRepo
const defaultBootId = staleBackupLock.readBootId
let appDevice: string
let backupDevice: string

const repoOf = (id = 'inst-1') => `${DISKS_ROOT}/${backupDevice}/backups/${id}`
const lockOf = (id = 'inst-1') => `${repoOf(id)}/${BACKUP_IN_PROGRESS}`

const createMinimalStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const storeHandle = repo.create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    })
    await storeHandle.whenReady()
    await createOrUpdateEngine(storeHandle, localEngineId)
    return storeHandle
}

const makeDisk = (id: string, name: string, device: string | null, isBackup = false): Disk => ({
    id: id as DiskID,
    name: name as DiskName,
    device: device as any,
    dockedTo: localEngineId as EngineID,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: isBackup ? ['backup'] : ['app'],
    backupConfig: null,
})

const addDisk = (h: DocHandle<Store>, disk: Disk) => { h.change(doc => { doc.diskDB[disk.id] = disk }) }
const addInstance = (h: DocHandle<Store>, instanceId: InstanceID, diskId: DiskID) => {
    h.change(doc => {
        doc.instanceDB[instanceId] = {
            id: instanceId, instanceOf: 'sample-app' as any, name: instanceId as any,
            status: 'Stopped' as any, port: 8080 as any, serviceImages: [],
            created: Date.now() as Timestamp, lastBackup: null, lastStarted: Date.now() as Timestamp,
            statusCondition: null, storedOn: diskId, currentStep: null, totalSteps: null,
            stepLabel: null, metrics: null,
        }
    })
}

const setup = async () => {
    const h = await createMinimalStore()
    const appDisk = makeDisk('ad1', 'AppDisk', appDevice)
    const backupDisk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
    addDisk(h, appDisk)
    addDisk(h, backupDisk)
    addInstance(h, 'inst-1' as InstanceID, 'ad1' as DiskID)
    return { h, appDisk, backupDisk }
}

beforeEach(async () => {
    prevSkipBorg = config.settings.skipBorg
    config.settings.skipBorg = true
    staleBackupLock.borgPidUsingRepo = defaultBorgPid
    staleBackupLock.readBootId = defaultBootId
    appDevice = uniqueTestDevice()
    do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
    await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/inst-1`)
    await fs.ensureDir(repoOf())
    await fs.writeFile(`${repoOf()}/config`, '[repository]\nid = fake\n')
    await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`,
        'mode: on-demand\nlinks:\n  - instanceId: inst-1\n    lastBackup: 0\n')
})
afterEach(async () => {
    config.settings.skipBorg = prevSkipBorg
    staleBackupLock.borgPidUsingRepo = defaultBorgPid
    staleBackupLock.readBootId = defaultBootId
    vi.restoreAllMocks()
    resourceLock.releaseAll([diskKey('bd1'), instanceKey('inst-1')])
    await drainDataBytesQueue()
    await fs.remove(`${DISKS_ROOT}/${appDevice}`)
    await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
})

describe('engine#429 auto-clear of stale backup locks', () => {
    it('dock with a stale lock: quarantined, entry dropped, INTERRUPTED recorded once', async () => {
        const { h, backupDisk } = await setup()
        const startedAt = Date.now() - 60000
        await fs.writeFile(lockOf(), JSON.stringify({ instanceId: 'inst-1', startedAt }))
        const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
        try {
            await processBackupDisk(h, backupDisk)
            await processBackupDisk(h, backupDisk)
        } finally { logSpy.mockRestore() }
        expect(await fs.pathExists(lockOf())).toBe(false)
        expect((await fs.readdir(repoOf())).some(f => f.startsWith(`${BACKUP_IN_PROGRESS}.stale-`))).toBe(true)
        expect(h.doc()!.diskDB['bd1' as DiskID].backupStaleLocks ?? []).toEqual([])
        const inst = h.doc()!.instanceDB['inst-1' as InstanceID]
        expect(inst.lastResult?.result).toBe('INTERRUPTED')
        expect(inst.backupHistory?.length).toBe(1)
        expect(inst.lastBackup).toBeNull()
    })

    it('a lock while resourceLock is held is not cleared', async () => {
        const { h, backupDisk } = await setup()
        await fs.writeFile(lockOf(), JSON.stringify({ instanceId: 'inst-1', startedAt: 1 }))
        expect(resourceLock.acquireAll([diskKey('bd1')], 'backupApp')).toBe(true)
        const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
        try {
            expect(await clearAbandonedBackupLock(h, backupDisk, 'inst-1' as InstanceID)).toBe(false)
            await recordBackupStaleLocks(h, backupDisk)
        } finally {
            logSpy.mockRestore()
            resourceLock.releaseAll([diskKey('bd1')])
        }
        expect(await fs.pathExists(lockOf())).toBe(true)
        expect((h.doc()!.diskDB['bd1' as DiskID].backupStaleLocks ?? []).map(l => l.instanceId)).toEqual(['inst-1'])
        expect(h.doc()!.instanceDB['inst-1' as InstanceID].lastResult?.result).toBe('INTERRUPTED')
    })

    it('a lock with a fake live borg is not cleared, then is cleared once borg exits', async () => {
        const { h, backupDisk } = await setup()
        await fs.writeFile(lockOf(), JSON.stringify({ instanceId: 'inst-1', startedAt: 1 }))
        staleBackupLock.borgPidUsingRepo = async () => 4242
        const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
        try {
            expect(await clearAbandonedBackupLock(h, backupDisk, 'inst-1' as InstanceID)).toBe(false)
            await recordBackupStaleLocks(h, backupDisk)
            expect(await fs.pathExists(lockOf())).toBe(true)
            expect((h.doc()!.diskDB['bd1' as DiskID].backupStaleLocks ?? []).map(l => l.instanceId)).toEqual(['inst-1'])
            staleBackupLock.borgPidUsingRepo = async () => null
            expect(await clearAbandonedBackupLock(h, backupDisk, 'inst-1' as InstanceID)).toBe(true)
        } finally { logSpy.mockRestore() }
        expect(await fs.pathExists(lockOf())).toBe(false)
        expect((await fs.readdir(repoOf())).some(f => f.startsWith(`${BACKUP_IN_PROGRESS}.stale-`))).toBe(true)
        expect(h.doc()!.diskDB['bd1' as DiskID].backupStaleLocks ?? []).toEqual([])
    })

    it('a Pending restore Operation or an undocked disk blocks the clear', async () => {
        const { h, backupDisk } = await setup()
        await fs.writeFile(lockOf(), JSON.stringify({ instanceId: 'inst-1', startedAt: 1 }))
        const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
        try {
            createOperation(h, 'restoreApp', { instanceId: 'inst-1', targetDiskId: 'ad1' }, 'console-command')
            expect(await clearAbandonedBackupLock(h, backupDisk, 'inst-1' as InstanceID)).toBe(false)
            expect(await fs.pathExists(lockOf())).toBe(true)

            h.change(doc => {
                const op = Object.values(doc.operationDB ?? {}).find(o => o.kind === 'restoreApp')
                if (op) op.status = 'Done'
            })
            h.change(doc => { doc.diskDB['bd1' as DiskID].dockedTo = 'other-engine' as EngineID })
            const undocked = h.doc()!.diskDB['bd1' as DiskID]
            expect(await clearAbandonedBackupLock(h, undocked, 'inst-1' as InstanceID)).toBe(false)
            expect(await fs.pathExists(lockOf())).toBe(true)
        } finally { logSpy.mockRestore() }
    })

    it('new lock files carry engineId and bootId', async () => {
        staleBackupLock.readBootId = () => 'boot-test-429'
        const body = backupLockContents('inst-1')
        expect(body.instanceId).toBe('inst-1')
        expect(body.engineId).toBe(localEngineId)
        expect(body.bootId).toBe('boot-test-429')
        expect(typeof body.startedAt).toBe('number')
        expect(body).not.toHaveProperty('reason')
        expect(backupLockContents('inst-1', { reason: 'pre-update' }).reason).toBe('pre-update')
        const src = await fs.readFile(`${process.cwd()}/src/monitors/backupMonitor.ts`, 'utf8')
        expect(src).toMatch(/writeFile\(lockPath, JSON\.stringify\(backupLockContents\(/)
    })
})
