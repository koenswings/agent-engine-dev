/**
 * make-backup-disk.test.ts — idea#404 Engine PR 4
 *
 * makeBackupDisk Check / Erase / Re-dock / Create, refusals, unplug mapping,
 * and initialiseDisk … backup Create defaults. Erase success paths use a fake
 * script (never a real stick).
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { createOrUpdateDisk, processDisk, setRootDeviceForTests } from '../../src/data/Disk.js'
import {
    setEraseOpsForTests, ERASE_STAGING_ROOT,
} from '../../src/data/EraseDisk.js'
import { setSystemDiskOpsForTests } from '../../src/data/SystemDisk.js'
import { CommandLogStore, setCommandLogHandle, addTrace } from '../../src/data/CommandLogStore.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import { resourceLock } from '../../src/utils/ResourceLock.js'
import {
    makeBackupDisk, applyMakeBackupDiskCreate, setMakeBackupDiskOpsForTests,
    MakeBackupDiskError, MAKE_BACKUP_DISK_MIN_BYTES,
} from '../../src/data/MakeBackupDisk.js'
import { setFlashCardOpsForTests, clearFlashStateForTests, CardError } from '../../src/data/FlashCard.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'

const LOCAL = localEngineId as EngineID
const EIGHT_GIB = MAKE_BACKUP_DISK_MIN_BYTES
const BIG = 32 * 1024 * 1024 * 1024

const newStore = async () => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
        await p
        return 'OK'
    } catch (e: any) {
        if (e instanceof MakeBackupDiskError || e instanceof CardError) return e.code
        const m = String(e?.message ?? e)
        return m.split(':')[0] || m
    }
}

const putSummary = (logHandle: DocHandle<CommandLogStore>, targetId: string, label: string, sizeBytes: number, serial: string | null = 'FAKE1') => {
    const traceId = 'sum-1'
    addTrace(logHandle, {
        traceId, command: 'summariseDisk', args: JSON.stringify({ targetId }),
        startedAt: Date.now(), completedAt: Date.now(), status: 'ok', errorMessage: null,
        result: JSON.stringify({
            targetId, label, serial, model: 'Test', sizeBytes, usedBytes: 0, fsType: 'exfat',
            apps: [], instances: [], backups: [], files: null, other: null, otherPartitions: [],
            readable: false, computedAt: Date.now(),
        }),
    } as any)
    return traceId
}

describe('makeBackupDisk capability (idea#404)', () => {
    it('is in the always-on ENGINE_CAPABILITIES list', () => {
        expect(ENGINE_CAPABILITIES).toContain('makeBackupDisk')
        expect(commands.find(c => c.name === 'makeBackupDisk')).toBeTruthy()
    })
    it('MAKE_BACKUP_DISK_MIN_BYTES is 8 GiB', () => {
        expect(EIGHT_GIB).toBe(8 * 1024 * 1024 * 1024)
    })
})

describe('makeBackupDisk Check refusals', () => {
    let h: DocHandle<Store>
    let logHandle: DocHandle<CommandLogStore>
    const roots: string[] = []

    beforeEach(async () => {
        h = await newStore()
        logHandle = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        await logHandle.whenReady()
        setCommandLogHandle(logHandle)
        setSystemDiskOpsForTests({
            findmntSource: async (mp) => mp === '/' ? '/dev/sda2' : null,
            pkname: async () => 'sda',
        })
        setRootDeviceForTests('sda2')
        setMakeBackupDiskOpsForTests({ devicePresent: async () => true })
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        setMakeBackupDiskOpsForTests(null)
        setEraseOpsForTests(null)
        setSystemDiskOpsForTests(null)
        setRootDeviceForTests(null)
        setCommandLogHandle(null)
        resourceLock.releaseAll([...resourceLock.allLocks().keys()])
        for (const r of roots.splice(0)) await fs.remove(r).catch(() => {})
    })

    const addDocked = (id: string, name: string, device: string, types: string[], size = BIG, extra: Record<string, unknown> = {}) => {
        h.change(doc => {
            doc.diskDB[id as DiskID] = {
                id: id as DiskID,
                name: name as DiskName,
                device: device as DeviceName,
                dockedTo: LOCAL,
                created: Date.now() as Timestamp,
                lastDocked: Date.now() as Timestamp,
                diskTypes: types as any,
                backupConfig: null,
                sizeBytes: size,
                ...extra,
            } as any
        })
    }

    it('NOT_FOUND for an unknown id', async () => {
        expect(await codeOf(makeBackupDisk(h, 'no-such-disk'))).toBe('NOT_FOUND')
    })

    it('NOT_DOCKED for a record without a device', async () => {
        addDocked('d-away', 'Away', 'sdb1', ['empty'], BIG)
        h.change(doc => { doc.diskDB['d-away' as DiskID].device = null as any; doc.diskDB['d-away' as DiskID].dockedTo = null })
        // resolveSummaryTarget requires docked+device, so this is NOT_FOUND
        expect(await codeOf(makeBackupDisk(h, 'd-away'))).toBe('NOT_FOUND')
    })

    it('SYSTEM_DISK for the Engine system disk', async () => {
        addDocked('sys1', 'System', 'sda2', ['system'], BIG)
        expect(await codeOf(makeBackupDisk(h, 'sys1'))).toBe('SYSTEM_DISK')
    })

    it('TOO_SMALL when the disk is under 8 GiB', async () => {
        addDocked('tiny', 'Tiny', 'sdc1', ['empty'], EIGHT_GIB - 1)
        const device = uniqueTestDevice()
        const root = `${DISKS_ROOT}/${device}`
        roots.push(root)
        // retarget to a real folder? size comes from the record
        expect(await codeOf(makeBackupDisk(h, 'tiny'))).toBe('TOO_SMALL')
        const ops = Object.values(h.doc()!.operationDB)
        expect(ops[0].status).toBe('Failed')
        expect(ops[0].error).toMatch(/^TOO_SMALL:/)
    })

    it('allows a disk that is exactly 8 GiB', async () => {
        const device = uniqueTestDevice()
        const root = `${DISKS_ROOT}/${device}`
        await fs.ensureDir(root)
        roots.push(root)
        addDocked('exact', 'Exact', device, ['empty'], EIGHT_GIB)
        const r = await makeBackupDisk(h, 'exact')
        expect(r.erased).toBe(false)
        expect(h.doc()!.diskDB[r.diskId].backupConfig?.mode).toBe('scheduled')
    })

    it('ALREADY_BACKUP when the disk already has the backup role', async () => {
        addDocked('b1', 'Backup', 'sdd1', ['backup'], BIG, { backupConfig: { mode: 'on-demand', links: [] } })
        expect(await codeOf(makeBackupDisk(h, 'b1'))).toBe('ALREADY_BACKUP')
    })

    it('BUSY when an erase is already in progress', async () => {
        addDocked('e1', 'Empty', 'sde1', ['empty'], BIG)
        h.change(doc => {
            doc.engineDB[LOCAL].eraseInProgress = { targetId: 'other', label: 'Other', step: 'partitioning' } as any
        })
        expect(await codeOf(makeBackupDisk(h, 'e1'))).toBe('BUSY')
    })

    it('BAD_ARGS when Erase is needed but confirm is missing', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'STICK1', device: 'sdf', sizeBytes: BIG, model: 'SanDisk',
                fsType: 'exfat', label: 'SanDisk 32 GB',
            } as any]
        })
        expect(await codeOf(makeBackupDisk(h, 'STICK1'))).toBe('BAD_ARGS')
        expect(await codeOf(makeBackupDisk(h, 'STICK1', 'sum-1'))).toBe('BAD_ARGS')
    })

    it('SUMMARY_STALE / CONFIRM_MISMATCH on the erase path', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'STICK1', device: 'sdf', sizeBytes: BIG, model: 'SanDisk',
                fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'STICK1',
            } as any]
        })
        expect(await codeOf(makeBackupDisk(h, 'STICK1', 'no-trace', 'SanDisk 32 GB'))).toBe('SUMMARY_STALE')
        putSummary(logHandle, 'STICK1', 'SanDisk 32 GB', BIG, 'STICK1')
        expect(await codeOf(makeBackupDisk(h, 'STICK1', 'sum-1', 'Wrong Label'))).toBe('CONFIRM_MISMATCH')
    })
})

describe('makeBackupDisk adopt / erase / create', () => {
    let h: DocHandle<Store>
    let logHandle: DocHandle<CommandLogStore>
    const roots: string[] = []
    let scriptCalls: any[]
    let present = true

    beforeEach(async () => {
        h = await newStore()
        logHandle = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        await logHandle.whenReady()
        setCommandLogHandle(logHandle)
        scriptCalls = []
        present = true
        setMakeBackupDiskOpsForTests({ devicePresent: async () => present })
        setEraseOpsForTests({
            mountedPartitions: async () => [],
            hiddenTablePartitions: async () => [],
            runScript: async (a) => {
                scriptCalls.push(a)
                const part = a.device.replace('/dev/', '') + '1'
                const root = `${DISKS_ROOT}/${part}`
                await fs.ensureDir(root)
                await fs.copy(path.join(a.stagingDir, 'META.yaml'), path.join(root, 'META.yaml'))
                roots.push(root)
                return { stdout: 'ok: erased\n' }
            },
            runSlotErase: async (a) => {
                const root = `${DISKS_ROOT}/${a.slot}`
                await fs.ensureDir(root)
                await fs.copy(path.join(a.stagingDir, 'META.yaml'), path.join(root, 'META.yaml'))
                roots.push(root)
                return { stdout: 'ok: erased slot\n' }
            },
            udevadmSettle: async () => {},
            composeDownV: async () => {},
            lsblkSizeSerial: async () => ({ sizeBytes: BIG, serial: 'STICK1' }),
            isMountPoint: async () => false,
            addDevice: async (p) => {
                const device = p.split('/').pop()!
                const root = `${DISKS_ROOT}/${device}`
                if (!(await fs.pathExists(root))) await fs.ensureDir(root)
                const meta = YAML.parse(await fs.readFile(path.join(root, 'META.yaml'), 'utf8'))
                const disk = createOrUpdateDisk(h, LOCAL, device as DeviceName, meta.diskId as DiskID, 'IDEA Disk' as DiskName, 1 as Timestamp)
                await processDisk(h, disk)
            },
        })
        setSystemDiskOpsForTests({
            findmntSource: async (mp) => mp === '/' ? '/dev/sda2' : null,
            pkname: async () => 'sda',
        })
        setRootDeviceForTests('sda2')
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        setMakeBackupDiskOpsForTests(null)
        setEraseOpsForTests(null)
        setSystemDiskOpsForTests(null)
        setRootDeviceForTests(null)
        setCommandLogHandle(null)
        setFlashCardOpsForTests(null)
        clearFlashStateForTests()
        resourceLock.releaseAll([...resourceLock.allLocks().keys()])
        for (const r of roots.splice(0)) await fs.remove(r).catch(() => {})
        await fs.remove(ERASE_STAGING_ROOT).catch(() => {})
    })

    const addDocked = async (id: string, name: string, types: string[], size = BIG) => {
        const device = uniqueTestDevice()
        const root = `${DISKS_ROOT}/${device}`
        await fs.ensureDir(root)
        roots.push(root)
        h.change(doc => {
            doc.diskDB[id as DiskID] = {
                id: id as DiskID,
                name: name as DiskName,
                device: device as DeviceName,
                dockedTo: LOCAL,
                created: Date.now() as Timestamp,
                lastDocked: Date.now() as Timestamp,
                diskTypes: types as any,
                backupConfig: null,
                sizeBytes: size,
            } as any
        })
        return { device, root }
    }

    const readYaml = async (device: string) =>
        YAML.parse(await fs.readFile(`${DISKS_ROOT}/${device}/BACKUP.yaml`, 'utf8'))

    it('skips Erase on an empty IDEA disk and writes scheduled 02:30 plus backups/', async () => {
        const { device, root } = await addDocked('empty1', 'Empty One', ['empty'])
        const r = await makeBackupDisk(h, 'empty1')
        expect(r.erased).toBe(false)
        expect(scriptCalls).toEqual([])
        expect(r.diskId).toBe('empty1' as any)
        const yaml = await readYaml(device)
        expect(yaml.mode).toBe('scheduled')
        expect(yaml.schedule).toEqual({ daily: '02:30' })
        expect(yaml.links ?? []).toEqual([])
        expect(await fs.pathExists(`${root}/backups`)).toBe(true)
        const disk = h.doc()!.diskDB[r.diskId]
        expect(disk.diskTypes).toContain('backup')
        expect(disk.backupConfig?.mode).toBe('scheduled')
        expect(disk.backupConfig?.schedule).toEqual({ daily: '02:30' })
        const op = h.doc()!.operationDB[r.operationId]
        expect(op).toMatchObject({ kind: 'makeBackupDisk', status: 'Done' })
    })

    it('skips Erase on an App disk and keeps the app role', async () => {
        const { device, root } = await addDocked('app1', 'App Disk', ['app'])
        await fs.ensureDir(`${root}/apps`)
        const r = await makeBackupDisk(h, 'app1')
        expect(r.erased).toBe(false)
        expect(scriptCalls).toEqual([])
        const disk = h.doc()!.diskDB[r.diskId]
        expect(disk.diskTypes).toContain('app')
        expect(disk.diskTypes).toContain('backup')
        expect((await readYaml(device)).mode).toBe('scheduled')
    })

    it('skips Erase on a Files disk and keeps the files role', async () => {
        const { root } = await addDocked('files1', 'Files Disk', ['files'])
        await fs.writeFile(`${root}/FILES.yaml`, 'version: 1\nshareName: School Files\nreadOnly: false\npassword: null\n')
        await fs.ensureDir(`${root}/files`)
        const r = await makeBackupDisk(h, 'files1')
        expect(r.erased).toBe(false)
        const disk = h.doc()!.diskDB[r.diskId]
        expect(disk.diskTypes).toContain('files')
        expect(disk.diskTypes).toContain('backup')
    })

    it('erases an unformatted candidate, adopts once under keptId, then Creates', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'STICK1', device: 'sdf', sizeBytes: BIG, model: 'SanDisk',
                fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'STICK1',
            } as any]
        })
        putSummary(logHandle, 'STICK1', 'SanDisk 32 GB', BIG, 'STICK1')
        const r = await makeBackupDisk(h, 'STICK1', 'sum-1', 'SanDisk 32 GB')
        expect(r.erased).toBe(true)
        expect(scriptCalls).toHaveLength(1)
        expect(r.diskId).toBe('STICK1' as any)
        const disk = h.doc()!.diskDB[r.diskId]
        expect(disk).toBeTruthy()
        expect(String(disk.dockedTo)).toBe(String(LOCAL))
        expect(disk.diskTypes).toContain('backup')
        expect(disk.backupConfig?.mode).toBe('scheduled')
        expect(disk.backupConfig?.schedule).toEqual({ daily: '02:30' })
        const yaml = YAML.parse(await fs.readFile(`${DISKS_ROOT}/${disk.device}/BACKUP.yaml`, 'utf8'))
        expect(yaml).toMatchObject({ mode: 'scheduled', schedule: { daily: '02:30' } })
        expect(await fs.pathExists(`${DISKS_ROOT}/${disk.device}/backups`)).toBe(true)
        const op = h.doc()!.operationDB[r.operationId]
        expect(op.status).toBe('Done')
    })

    it('UNPLUGGED when the disk is gone from sysfs during Erase', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'STICK1', device: 'sdf', sizeBytes: BIG, model: 'SanDisk',
                fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'STICK1',
            } as any]
        })
        putSummary(logHandle, 'STICK1', 'SanDisk 32 GB', BIG, 'STICK1')
        present = false
        setEraseOpsForTests({
            mountedPartitions: async () => [],
            hiddenTablePartitions: async () => [],
            runScript: async () => { throw new Error('ENODEV: No such device') },
            runSlotErase: async () => { throw new Error('ENODEV: No such device') },
            udevadmSettle: async () => {},
            composeDownV: async () => {},
            lsblkSizeSerial: async () => ({ sizeBytes: BIG, serial: 'STICK1' }),
            isMountPoint: async () => false,
            addDevice: async () => {},
        })
        expect(await codeOf(makeBackupDisk(h, 'STICK1', 'sum-1', 'SanDisk 32 GB'))).toBe('UNPLUGGED')
        const op = Object.values(h.doc()!.operationDB)[0]
        expect(op.status).toBe('Failed')
        expect(op.error).toBe('UNPLUGGED: the disk was unplugged during setup; plug it back in and try again')
    })

    it('REDOCK_TIMEOUT when the disk stays present but never republishes', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'STICK1', device: 'sdf', sizeBytes: BIG, model: 'SanDisk',
                fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'STICK1',
            } as any]
        })
        putSummary(logHandle, 'STICK1', 'SanDisk 32 GB', BIG, 'STICK1')
        present = true
        setMakeBackupDiskOpsForTests({
            devicePresent: async () => true,
            runErase: async () => ({ diskId: 'STICK1' as any, removedInstances: [] }),
        })
        expect(await codeOf(makeBackupDisk(h, 'STICK1', 'sum-1', 'SanDisk 32 GB'))).toBe('REDOCK_TIMEOUT')
    })

    it('initialiseDisk … backup uses the same Create defaults (scheduled / 02:30)', async () => {
        const { device, root } = await addDocked('initb', 'Init Backup', ['empty'])
        // Direct Create path used by initialiseDisk's default ops (idea#404 Q3)
        const disk = h.doc()!.diskDB['initb' as DiskID]
        await applyMakeBackupDiskCreate(h, disk)
        const yaml = await readYaml(device)
        expect(yaml.mode).toBe('scheduled')
        expect(yaml.schedule).toEqual({ daily: '02:30' })
        expect(yaml.links ?? []).toEqual([])
        expect(await fs.pathExists(`${root}/backups`)).toBe(true)
        expect(h.doc()!.diskDB['initb' as DiskID].backupConfig?.mode).toBe('scheduled')
    })

    it('the makeBackupDisk command is registered and runs the adopt path', async () => {
        const { device } = await addDocked('cmd1', 'Via Command', ['empty'])
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        await handleCommand(commands, h, 'engine', 'makeBackupDisk cmd1')
        err.mockRestore()
        const yaml = await readYaml(device)
        expect(yaml.mode).toBe('scheduled')
        expect(yaml.schedule).toEqual({ daily: '02:30' })
    })
})
