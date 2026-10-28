/**
 * erase-whole-disk-checks.test.ts — #188 (idea03 2026-10-15): erase wipes the whole
 * physical disk, so a mounted sibling partition (sdb1 next to the target sdb2) or the
 * system disk must refuse BEFORE any unmount or store change; and an erase that fails
 * after unmounting mounts and registers the partition again.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { createOrUpdateDisk, processDisk } from '../../src/data/Disk.js'
import { eraseDisk, isEspPartType, parseHiddenPartitions, setEraseOpsForTests, setEraseAddDevice, ERASE_STAGING_ROOT, isEraseDeviceLocked } from '../../src/data/EraseDisk.js'
import { setSystemDiskOpsForTests } from '../../src/data/SystemDisk.js'
import { CommandLogStore, setCommandLogHandle, addTrace } from '../../src/data/CommandLogStore.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { DISKS_ROOT } from '../harness/diskSim.js'
import { usbRoot } from '../../src/data/Config.js'

const LOCAL = localEngineId as EngineID

describe('eraseDisk whole-disk checks and remount on failure (#188)', () => {
    let h: DocHandle<Store>
    const roots: string[] = []
    let scriptCalls = 0
    let downCalls = 0
    let addCalls: string[] = []
    let siblings: { partition: string; mountpoint: string }[] = []
    let siblingsFn: (() => { partition: string; mountpoint: string }[]) | null = null
    let espFn: ((p: string) => boolean) | null = null
    let scriptError: Error | null = null
    let hidden: { partition: string; name: string | null }[] | Error = []

    const writeMeta = async (device: string, diskId: string, name: string) => {
        const root = `${DISKS_ROOT}/${device}`
        await fs.ensureDir(root)
        await fs.writeFile(path.join(root, 'META.yaml'), YAML.stringify({ diskId, diskName: name, isHardwareId: false, created: 1, version: '1.0' }))
        if (!roots.includes(root)) roots.push(root)
        return root
    }
    const dock = async (device: string, diskId: string, name: string) => {
        await writeMeta(device, diskId, name)
        const d = createOrUpdateDisk(h, LOCAL, device as DeviceName, diskId as DiskID, name as DiskName, 1 as Timestamp)
        await processDisk(h, d)
    }
    const summary = async (targetId: string, label: string) => {
        const logHandle = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        await logHandle.whenReady()
        setCommandLogHandle(logHandle)
        addTrace(logHandle, {
            traceId: 'sum-whole', command: 'summariseDisk', args: JSON.stringify({ targetId }),
            startedAt: Date.now(), completedAt: Date.now(), status: 'ok', errorMessage: null,
            result: JSON.stringify({ targetId, label, serial: 'FAKE1', model: null, sizeBytes: 32e9, fsType: 'ext4',
                usedBytes: null, readable: true, apps: [], instances: [], backups: [], files: null, other: null,
                otherPartitions: [], computedAt: Date.now() }),
        } as any)
        return 'sum-whole'
    }

    beforeEach(async () => {
        h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, LOCAL)
        scriptCalls = 0; downCalls = 0; addCalls = []; siblings = []; siblingsFn = null; espFn = null; scriptError = null; hidden = []
        setEraseOpsForTests({
            mountedPartitions: async () => (siblingsFn ? siblingsFn() : siblings),
            isEspPartition: async (p) => { if (espFn) return espFn(p); return false },
            hiddenTablePartitions: async () => { if (hidden instanceof Error) throw hidden; return hidden },
            runScript: async () => { scriptCalls++; if (scriptError) throw scriptError; return { stdout: '' } },
            runSlotErase: async () => { throw new Error('no slots here') },
            composeDownV: async () => { downCalls++ },
            udevadmSettle: async () => {},
            isMountPoint: async () => false,
            lsblkSizeSerial: async () => ({ sizeBytes: 32e9, serial: 'FAKE1' }),
        })
        setEraseAddDevice(async (p) => {
            addCalls.push(p)
            const device = p.split('/').pop()!
            const meta = YAML.parse(await fs.readFile(path.join(DISKS_ROOT, device, 'META.yaml'), 'utf8'))
            const d = createOrUpdateDisk(h, LOCAL, device as DeviceName, meta.diskId as DiskID, meta.diskName as DiskName, 2 as Timestamp)
            await processDisk(h, d)
        })
        setSystemDiskOpsForTests({ findmntSource: async (mp) => mp === '/' ? '/dev/sda2' : null, pkname: async () => 'sda' })
    })
    afterEach(async () => {
        setEraseOpsForTests(null)
        setEraseAddDevice(null)
        setSystemDiskOpsForTests(null)
        setCommandLogHandle(null)
        for (const r of roots.splice(0)) await fs.remove(r).catch(() => {})
        await fs.remove(ERASE_STAGING_ROOT).catch(() => {})
    })

    it('refuses before any unmount or store change when a sibling partition on the same disk is mounted', async () => {
        await dock('sdb1', 'nc-disk', 'Nextcloud Disk')
        await dock('sdb2', 'f-disk', 'Files F')
        siblings = [{ partition: 'sdb1', mountpoint: '/disks/sdb1' }, { partition: 'sdb2', mountpoint: '/disks/sdb2' }]
        const before = JSON.stringify(h.doc()!.diskDB)
        const tid = await summary('f-disk', 'Files F')
        await expect(eraseDisk(h, 'f-disk', tid, 'Files F'))
            .rejects.toThrow(/Files F shares its physical disk \(\/dev\/sdb\) with sdb1 mounted at \/disks\/sdb1\. Erasing wipes the whole disk, so nothing was erased\./)
        expect(scriptCalls).toBe(0)
        expect(downCalls).toBe(0)
        expect(addCalls).toEqual([])
        expect(JSON.stringify(h.doc()!.diskDB)).toBe(before)
        expect(h.doc()!.engineDB[LOCAL].eraseInProgress ?? null).toBeNull()
        expect(isEraseDeviceLocked('sdb')).toBe(false)
    })

    it('#235: a teacher-stick sibling under the USB root does not block; it is unmounted before the wipe', async () => {
        await dock('sdc2', 'os-disk', 'Old OS Disk')
        const stick = { partition: 'sdc1', mountpoint: path.join(usbRoot(), 'sdc1') }
        let calls = 0
        siblingsFn = () => (++calls === 1 ? [stick, { partition: 'sdc2', mountpoint: '/disks/sdc2' }] : [{ partition: 'sdc2', mountpoint: '/disks/sdc2' }])
        const tid = await summary('os-disk', 'Old OS Disk')
        scriptError = new Error('stop here')
        await expect(eraseDisk(h, 'os-disk', tid, 'Old OS Disk')).rejects.toThrow(/stop here/)
        expect(calls).toBe(2)
        expect(scriptCalls).toBe(1)
    })

    it('#235: a stick that is still mounted after the stick unmount refuses, nothing wiped', async () => {
        await dock('sdc2', 'os-disk', 'Old OS Disk')
        const stick = { partition: 'sdc1', mountpoint: path.join(usbRoot(), 'sdc1') }
        siblings = [stick]
        const tid = await summary('os-disk', 'Old OS Disk')
        await expect(eraseDisk(h, 'os-disk', tid, 'Old OS Disk'))
            .rejects.toThrow(/shares its physical disk \(\/dev\/sdc\) with sdc1 mounted at .*sdc1, which could not be unmounted.*nothing was erased/)
        expect(scriptCalls).toBe(0)
        expect(h.doc()!.engineDB[LOCAL].eraseInProgress ?? null).toBeNull()
        expect(isEraseDeviceLocked('sdc')).toBe(false)
    })

    it('#235: a mounted EFI System Partition (even as a stick) means an OS disk: refuse, nothing wiped', async () => {
        await dock('sdc2', 'os-disk', 'Old OS Disk')
        siblings = [{ partition: 'sdc1', mountpoint: path.join(usbRoot(), 'sdc1') }]
        espFn = (p) => p === 'sdc1'
        const tid = await summary('os-disk', 'Old OS Disk')
        await expect(eraseDisk(h, 'os-disk', tid, 'Old OS Disk')).rejects.toThrow(/EFI System Partition \(sdc1 mounted at .*\)\. That makes it an OS disk, so nothing was erased/)
        expect(scriptCalls).toBe(0)
        expect(isEraseDeviceLocked('sdc')).toBe(false)
    })

    it('#235: a partition type that cannot be read refuses (fail closed)', async () => {
        await dock('sdc2', 'os-disk', 'Old OS Disk')
        siblings = [{ partition: 'sdc1', mountpoint: path.join(usbRoot(), 'sdc1') }]
        espFn = () => { throw new Error('lsblk gone') }
        const tid = await summary('os-disk', 'Old OS Disk')
        await expect(eraseDisk(h, 'os-disk', tid, 'Old OS Disk')).rejects.toThrow(/Could not check the partition type of \/dev\/sdc1 \(lsblk gone\).*nothing was erased/)
        expect(scriptCalls).toBe(0)
    })

    it('#235: isEspPartType recognises GPT and MBR ESP types only', () => {
        expect(isEspPartType('C12A7328-F81F-11D2-BA4B-00A0C93EC93B\n')).toBe(true)
        expect(isEspPartType('0xef')).toBe(true)
        expect(isEspPartType('0x83')).toBe(false)
        expect(isEspPartType('0fc63daf-8483-4772-8e79-3d69d8477de4')).toBe(false)
        expect(isEspPartType('')).toBe(false)
    })

    it('#235: a sibling mounted anywhere else (not a stick) still refuses up front', async () => {
        await dock('sdc2', 'os-disk', 'Old OS Disk')
        siblings = [{ partition: 'sdc1', mountpoint: '/media/sdc1' }]
        const tid = await summary('os-disk', 'Old OS Disk')
        await expect(eraseDisk(h, 'os-disk', tid, 'Old OS Disk')).rejects.toThrow(/sdc1 mounted at \/media\/sdc1\. Erasing/)
        expect(scriptCalls).toBe(0)
    })

    it('the target partition itself being mounted is not a sibling', async () => {
        await dock('sdc1', 'f-disk', 'Files F')
        siblings = [{ partition: 'sdc1', mountpoint: '/disks/sdc1' }]
        const tid = await summary('f-disk', 'Files F')
        scriptError = new Error('stop here')
        await expect(eraseDisk(h, 'f-disk', tid, 'Files F')).rejects.toThrow(/stop here/)
        expect(scriptCalls).toBe(1)
    })

    it('refuses an unformatted candidate whose partition is mounted', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{ candidateId: 'CAND1', device: 'sdd', sizeBytes: 32e9, model: 'X', fsType: 'exfat', label: 'X 32 GB', serial: 'FAKE1' }] as any
        })
        siblings = [{ partition: 'sdd1', mountpoint: '/media/x' }]
        const tid = await summary('CAND1', 'X 32 GB')
        await expect(eraseDisk(h, 'CAND1', tid, 'X 32 GB')).rejects.toThrow(/sdd1 mounted at \/media\/x.*nothing was erased/)
        expect(scriptCalls).toBe(0)
    })

    it('a failure after unmounting mounts and registers the partition again', async () => {
        await dock('sdc1', 'f-disk', 'Files F')
        const tid = await summary('f-disk', 'Files F')
        scriptError = new Error('refused: /dev/sdc is busy')
        await expect(eraseDisk(h, 'f-disk', tid, 'Files F')).rejects.toThrow(/busy/)
        expect(scriptCalls).toBe(1)
        expect(addCalls).toEqual(['/dev/engine/sdc1'])
        const d = h.doc()!.diskDB['f-disk' as DiskID]
        expect(d).toBeTruthy()
        expect(d.device).toBe('sdc1')
        expect(d.dockedTo).toBe(LOCAL)
        expect(h.doc()!.engineDB[LOCAL].eraseInProgress ?? null).toBeNull()
        expect(isEraseDeviceLocked('sdc')).toBe(false)
    })

    it('a successful erase does not trigger the failure remount', async () => {
        await dock('sdc1', 'f-disk', 'Files F')
        const tid = await summary('f-disk', 'Files F')
        // Script "erases": the new partition carries the staged META (same id)
        setEraseOpsForTests({
            mountedPartitions: async () => [],
            hiddenTablePartitions: async () => [],
            runScript: async (a) => { scriptCalls++; await fs.copy(path.join(a.stagingDir, 'META.yaml'), path.join(DISKS_ROOT, 'sdc1', 'META.yaml')); return { stdout: '' } },
            udevadmSettle: async () => {}, composeDownV: async () => {}, isMountPoint: async () => false,
            lsblkSizeSerial: async () => ({ sizeBytes: 32e9, serial: 'FAKE1' }),
        })
        await eraseDisk(h, 'f-disk', tid, 'Files F')
        expect(addCalls).toEqual(['/dev/engine/sdc1'])
        expect([...h.doc()!.diskDB['f-disk' as DiskID].diskTypes]).toEqual(['empty'])
    })
    it('refuses before any unmount when the partition table has a partition the kernel does not show (idea01 sda1)', async () => {
        await dock('sdc2', 'f-disk', 'Files F')
        hidden = [{ partition: 'sdc1', name: 'IDEA-KOLIBRI' }]
        const before = JSON.stringify(h.doc()!.diskDB)
        const tid = await summary('f-disk', 'Files F')
        await expect(eraseDisk(h, 'f-disk', tid, 'Files F'))
            .rejects.toThrow(/Files F is on \/dev\/sdc, whose partition table also has sdc1 \("IDEA-KOLIBRI"\), which this Pi does not show.*nothing was erased/)
        expect(scriptCalls).toBe(0)
        expect(downCalls).toBe(0)
        expect(addCalls).toEqual([])
        expect(JSON.stringify(h.doc()!.diskDB)).toBe(before)
        expect(isEraseDeviceLocked('sdc')).toBe(false)
    })

    it('fails closed when the partition table cannot be checked (old root helper)', async () => {
        await dock('sdc1', 'f-disk', 'Files F')
        hidden = new Error('refused: device must be a whole disk /dev/sdX')
        const tid = await summary('f-disk', 'Files F')
        await expect(eraseDisk(h, 'f-disk', tid, 'Files F'))
            .rejects.toThrow(/Could not check the partition table of \/dev\/sdc .*nothing was erased/)
        expect(scriptCalls).toBe(0)
        expect(h.doc()!.diskDB['f-disk' as DiskID].dockedTo).toBe(LOCAL)
    })

    it('refuses an unformatted candidate with a hidden partition', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{ candidateId: 'CAND1', device: 'sdd', sizeBytes: 32e9, model: 'X', fsType: 'exfat', label: 'X 32 GB', serial: 'FAKE1' }] as any
        })
        hidden = [{ partition: 'sdd1', name: null }]
        const tid = await summary('CAND1', 'X 32 GB')
        await expect(eraseDisk(h, 'CAND1', tid, 'X 32 GB')).rejects.toThrow(/also has sdd1, which this Pi does not show/)
        expect(scriptCalls).toBe(0)
    })

    it('parseHiddenPartitions reads the helper output', () => {
        expect(parseHiddenPartitions(
            'hidden: sda1 start=        2048, size=   105498624, type=0FC63DAF, uuid=E38E, name="IDEA-KOLIBRI"\n' +
            'hidden: sda3 start=1, size=2, type=83\n\n'))
            .toEqual([{ partition: 'sda1', name: 'IDEA-KOLIBRI' }, { partition: 'sda3', name: null }])
        expect(parseHiddenPartitions('')).toEqual([])
    })
})
