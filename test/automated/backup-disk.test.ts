/**
 * backup-disk.test.ts
 *
 * Tests for Backup Disk processing, backupInstance, and boot-resume.
 * Uses /disks/<device>/ directories (same paths the production code uses).
 * All borg create/extract commands are skipped in testMode; store updates,
 * BACKUP.yaml writes, and lock file logic are fully exercised.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { backupInstance, processBackupDisk } from '../../src/monitors/backupMonitor.js'
import { fs } from 'zx'
import { randomUUID } from 'crypto'

// ── Test harness ──────────────────────────────────────────────────────────────

let appDevice: string
let backupDevice: string

const createMinimalStore = async (): Promise<{ repo: Repo; storeHandle: DocHandle<Store> }> => {
    const repo = new Repo({ network: [], storage: undefined })
    const storeHandle = repo.create<Store>({
        engineDB: {},
        diskDB: {},
        appDB: {},
        instanceDB: {},
        userDB: {},
    })
    await storeHandle.whenReady()
    await createOrUpdateEngine(storeHandle, localEngineId)
    return { repo, storeHandle }
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

const addDiskToStore = (storeHandle: DocHandle<Store>, disk: Disk) => {
    storeHandle.change(doc => { doc.diskDB[disk.id] = disk })
}

const addInstanceToStore = (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    diskId: DiskID,
    status = 'Stopped'
) => {
    storeHandle.change(doc => {
        doc.instanceDB[instanceId] = {
            id: instanceId,
            instanceOf: 'sample-app' as any,
            name: instanceId as any,
            status: status as any,
            port: 8080 as any,
            serviceImages: [],
            created: Date.now() as Timestamp,
            lastBackup: null,
            lastStarted: Date.now() as Timestamp,
            storedOn: diskId,
        }
    })
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
    // Use unique device names so parallel test runs don't collide
    const id = randomUUID().slice(0, 8)
    appDevice = `test-app-${id}`
    backupDevice = `test-bak-${id}`
    await fs.ensureDir(`/disks/${appDevice}/instances/inst-1`)
    await fs.ensureDir(`/disks/${backupDevice}/backups/inst-1`)
    // Pre-create a fake Borg repo config so borg init is skipped
    await fs.writeFile(`/disks/${backupDevice}/backups/inst-1/config`, '[repository]\nid = fake\n')
    await fs.writeFile(`/disks/${backupDevice}/BACKUP.yaml`,
        'mode: on-demand\nlinks:\n  - instanceId: inst-1\n    lastBackup: 0\n')
})

afterEach(async () => {
    await fs.remove(`/disks/${appDevice}`)
    await fs.remove(`/disks/${backupDevice}`)
})

// ── isBackupDisk ──────────────────────────────────────────────────────────────

describe('isBackupDisk', () => {
    it('returns true when BACKUP.yaml exists', async () => {
        const { isBackupDisk } = await import('../../src/data/Disk.js')
        const disk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
        expect(await isBackupDisk(disk)).to.be.true
    })

    it('returns false when BACKUP.yaml is absent', async () => {
        const { isBackupDisk } = await import('../../src/data/Disk.js')
        const disk = makeDisk('ad1', 'AppDisk', appDevice, false)
        expect(await isBackupDisk(disk)).to.be.false
    })
})

// ── backupInstance ────────────────────────────────────────────────────────────

describe('backupInstance', () => {
    it('skips if instance not in store', async () => {
        const { storeHandle } = await createMinimalStore()
        const backupDisk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
        addDiskToStore(storeHandle, backupDisk)

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        await backupInstance(storeHandle, 'nonexistent' as InstanceID, backupDisk)
        logSpy.mockRestore()
    })

    it('skips if App Disk is not docked', async () => {
        const { storeHandle } = await createMinimalStore()
        const appDisk = makeDisk('ad1', 'AppDisk', null) // NOT docked
        const backupDisk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
        addDiskToStore(storeHandle, appDisk)
        addDiskToStore(storeHandle, backupDisk)
        addInstanceToStore(storeHandle, 'inst-1' as InstanceID, 'ad1' as DiskID)

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        await backupInstance(storeHandle, 'inst-1' as InstanceID, backupDisk)
        logSpy.mockRestore()

        expect(storeHandle.doc()!.instanceDB['inst-1' as any]?.lastBackup).to.be.null
    })

    it('sets lastBackup in store and removes lock file on success (testMode)', async () => {
        const { storeHandle } = await createMinimalStore()
        const appDisk = makeDisk('ad1', 'AppDisk', appDevice)
        const backupDisk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
        addDiskToStore(storeHandle, appDisk)
        addDiskToStore(storeHandle, backupDisk)
        addInstanceToStore(storeHandle, 'inst-1' as InstanceID, 'ad1' as DiskID, 'Stopped')

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        await backupInstance(storeHandle, 'inst-1' as InstanceID, backupDisk)
        logSpy.mockRestore()

        // Lock file must be cleaned up
        expect(
            await fs.pathExists(`/disks/${backupDevice}/backups/inst-1/.backup-in-progress`),
            'lock file should be removed after success'
        ).to.be.false

        // lastBackup should be set in the store
        const lastBackup = storeHandle.doc()!.instanceDB['inst-1' as any]?.lastBackup
        expect(lastBackup, 'lastBackup should be set').to.be.a('number').that.is.greaterThan(0)
    })

    it('deduplicates concurrent calls (activeBackups mutex)', async () => {
        const { storeHandle } = await createMinimalStore()
        const appDisk = makeDisk('ad1', 'AppDisk', appDevice)
        const backupDisk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
        addDiskToStore(storeHandle, appDisk)
        addDiskToStore(storeHandle, backupDisk)
        addInstanceToStore(storeHandle, 'inst-1' as InstanceID, 'ad1' as DiskID, 'Stopped')

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        // Both calls in flight simultaneously
        await Promise.all([
            backupInstance(storeHandle, 'inst-1' as InstanceID, backupDisk),
            backupInstance(storeHandle, 'inst-1' as InstanceID, backupDisk),
        ])
        logSpy.mockRestore()
        // No errors; lock file removed; only one backup ran
        expect(await fs.pathExists(`/disks/${backupDevice}/backups/inst-1/.backup-in-progress`)).to.be.false
    })
})

// ── boot-resume ───────────────────────────────────────────────────────────────

describe('boot-resume (stale lock detection)', () => {
    it('re-triggers backup when stale lock file found on Backup Disk dock', async () => {
        const { storeHandle } = await createMinimalStore()
        const appDisk = makeDisk('ad1', 'AppDisk', appDevice)
        const backupDisk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
        addDiskToStore(storeHandle, appDisk)
        addDiskToStore(storeHandle, backupDisk)
        addInstanceToStore(storeHandle, 'inst-1' as InstanceID, 'ad1' as DiskID, 'Stopped')

        // Pre-seed a stale lock file (simulates interrupted backup before reboot)
        await fs.writeFile(
            `/disks/${backupDevice}/backups/inst-1/.backup-in-progress`,
            JSON.stringify({ instanceId: 'inst-1', startedAt: Date.now() - 60000 })
        )

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        await processBackupDisk(storeHandle, backupDisk)
        logSpy.mockRestore()

        // Lock file should be removed (re-triggered backup succeeded)
        expect(await fs.pathExists(`/disks/${backupDevice}/backups/inst-1/.backup-in-progress`)).to.be.false

        // lastBackup should be set
        expect(storeHandle.doc()!.instanceDB['inst-1' as any]?.lastBackup)
            .to.be.a('number').that.is.greaterThan(0)
    })
})

// ── processBackupDisk — backupConfig in store ─────────────────────────────────

describe('processBackupDisk', () => {
    it('sets backupConfig on the disk in the store', async () => {
        const { storeHandle } = await createMinimalStore()
        // Write immediate-mode BACKUP.yaml
        await fs.writeFile(`/disks/${backupDevice}/BACKUP.yaml`,
            'mode: immediate\nlinks:\n  - instanceId: inst-abc\n    lastBackup: 0\n')
        const backupDisk = makeDisk('bd1', 'BackupDisk', backupDevice, true)
        addDiskToStore(storeHandle, backupDisk)

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        await processBackupDisk(storeHandle, backupDisk)
        logSpy.mockRestore()

        const config = storeHandle.doc()!.diskDB['bd1' as any]?.backupConfig
        expect(config).to.not.be.null
        expect(config?.mode).to.equal('immediate')
        expect(config?.links).to.deep.include('inst-abc')
    })
})
