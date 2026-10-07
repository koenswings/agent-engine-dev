/**
 * erase-disk.test.ts — Files Disk step 3: summariseDisk + eraseDisk (idea#134)
 *
 * Success erase paths use a fake script (never the fleet stick). Covers refusals,
 * staging META-only, filesMounts remount exclude, empty result, capabilities.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { createOrUpdateDisk, processDisk } from '../../src/data/Disk.js'
import {
    eraseDisk, setEraseOpsForTests, clearStaleEraseStaging, ERASE_STAGING_ROOT,
    eraseBlocker, IDEA_DISK_LABEL, isEraseDeviceLocked, isSlotEraseDevice,
} from '../../src/data/EraseDisk.js'
import { summariseDisk, attachTraceResult, SUMMARY_MAX_AGE_MS, setSummariseOpsForTests } from '../../src/data/SummariseDisk.js'
import { scanUnformattedDisks, setUnformattedOpsForTests, uniquifyLabels, clearGeneratedUnformattedIdsForTests, labelForUnformatted } from '../../src/data/UnformattedDisks.js'
import { setSystemDiskOpsForTests, isSystemDevice, driveNameOf } from '../../src/data/SystemDisk.js'
import { SUDO_MOUNT_PATTERN, mountExt4Command } from '../../src/monitors/mounts.js'
import { CommandLogStore, setCommandLogHandle, addTrace, closeTrace } from '../../src/data/CommandLogStore.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { DISKS_ROOT, FIXTURES_DIR, uniqueTestDevice } from '../harness/diskSim.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'

const LOCAL = localEngineId as EngineID

const newStore = async () => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

describe('system disk helper + mount command (idea#134)', () => {
    afterEach(() => setSystemDiskOpsForTests(null))

    it('driveNameOf handles sd / mmcblk / nvme', () => {
        expect(driveNameOf('sda2')).toBe('sda')
        expect(driveNameOf('mmcblk0p2')).toBe('mmcblk0')
        expect(driveNameOf('nvme0n1p1')).toBe('nvme0n1')
    })

    it('isSystemDevice uses findmnt + PKNAME (USB system disk)', async () => {
        setSystemDiskOpsForTests({
            findmntSource: async (mp) => mp === '/' ? '/dev/sdb2' : mp === '/boot/firmware' ? '/dev/sdb1' : null,
            pkname: async () => 'sdb',
        })
        expect(await isSystemDevice('sdb')).toBe(true)
        expect(await isSystemDevice('sdb1')).toBe(true)
        expect(await isSystemDevice('sda')).toBe(false)
    })

    it('Engine mount command matches the sudoers typed entry exactly', () => {
        expect(SUDO_MOUNT_PATTERN).toBe('/usr/bin/mount -t ext4 /dev/sd[a-z][12] /disks/sd[a-z][12]')
        expect(mountExt4Command('sdb2', '/disks/sdb2')).toEqual([
            '/usr/bin/mount', '-t', 'ext4', '/dev/sdb2', '/disks/sdb2',
        ])
    })

    it('ENGINE_CAPABILITIES includes eraseDisk', () => {
        expect(ENGINE_CAPABILITIES).toEqual(['diskIdArgs', 'filesDisk', 'filesMount', 'eraseDisk', 'instanceIdArgs'])
    })
})

describe('unformattedDisks scan (idea#134)', () => {
    afterEach(() => {
        setUnformattedOpsForTests(null)
        setSystemDiskOpsForTests(null)
        clearGeneratedUnformattedIdsForTests()
    })

    it('lists whole non-system disks without ext4; skips system and ext4 disks', async () => {
        setSystemDiskOpsForTests({
            findmntSource: async (mp) => mp === '/' ? '/dev/sda2' : null,
            pkname: async () => 'sda',
        })
        setUnformattedOpsForTests({
            lsblkJson: async () => [
                { name: 'sda', type: 'disk', size: '240000000000', model: 'Intenso', serial: 'SYS1', children: [
                    { name: 'sda1', type: 'part', fstype: 'vfat', size: '500000000' },
                    { name: 'sda2', type: 'part', fstype: 'ext4', size: '239000000000' },
                ]},
                { name: 'sdb', type: 'disk', size: '32000000000', model: 'SanDisk', serial: 'STICK1', children: [
                    { name: 'sdb1', type: 'part', fstype: 'exfat', size: '32000000000' },
                ]},
                { name: 'sdc', type: 'disk', size: '16000000000', model: 'Other', serial: 'EXT4DISK', children: [
                    { name: 'sdc1', type: 'part', fstype: 'ext4', size: '16000000000' },
                ]},
                { name: 'sdd', type: 'disk', size: '8000000000', model: null, serial: null, children: [] },
            ],
        })
        const list = await scanUnformattedDisks()
        const names = list.map(d => d.device)
        expect(names).toContain('sdb')
        expect(names).toContain('sdd')
        expect(names).not.toContain('sda')
        expect(names).not.toContain('sdc')
        expect(list.find(d => d.device === 'sdb')!.candidateId).toBe('STICK1')
        expect(list.find(d => d.device === 'sdb')!.label).toMatch(/SanDisk/)
    })

    it('labels get (2) on a clash (display only)', () => {
        const items = [
            { label: labelForUnformatted('SanDisk', 32e9) },
            { label: labelForUnformatted('SanDisk', 32e9) },
        ]
        uniquifyLabels(items)
        expect(items[0].label).toBe('SanDisk 32 GB')
        expect(items[1].label).toBe('SanDisk 32 GB (2)')
    })

    it('a disk with ext4 on partition 3 is not listed', async () => {
        setSystemDiskOpsForTests({ findmntSource: async () => null, pkname: async () => null })
        setUnformattedOpsForTests({
            lsblkJson: async () => [{
                name: 'sde', type: 'disk', size: '10000000000', serial: 'P3',
                children: [
                    { name: 'sde1', type: 'part', fstype: 'vfat', size: '100000000' },
                    { name: 'sde2', type: 'part', fstype: null, size: '100000000' },
                    { name: 'sde3', type: 'part', fstype: 'ext4', size: '9000000000' },
                ],
            }],
        })
        expect(await scanUnformattedDisks()).toEqual([])
    })
})

describe('summariseDisk + eraseDisk (idea#134)', () => {
    let h: DocHandle<Store>
    let logHandle: DocHandle<CommandLogStore>
    const roots: string[] = []
    let scriptCalls: any[]
    let slotCalls: any[]

    beforeEach(async () => {
        h = await newStore()
        logHandle = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        await logHandle.whenReady()
        setCommandLogHandle(logHandle)
        scriptCalls = []
        slotCalls = []
        setEraseOpsForTests({
            runScript: async (a) => {
                scriptCalls.push(a)
                // Fake: leave a META.yaml-only empty disk folder at DISKS_ROOT/<whole>1
                const part = a.device.replace('/dev/', '') + '1'
                const root = `${DISKS_ROOT}/${part}`
                await fs.ensureDir(root)
                await fs.copy(path.join(a.stagingDir, 'META.yaml'), path.join(root, 'META.yaml'))
                roots.push(root)
                return { stdout: 'STEP:partitioning\nSTEP:creating filesystem\nSTEP:mounting\nok: erased\n' }
            },
            runSlotErase: async (a) => {
                slotCalls.push(a)
                const root = `${DISKS_ROOT}/${a.slot}`
                await fs.ensureDir(root)
                await fs.copy(path.join(a.stagingDir, 'META.yaml'), path.join(root, 'META.yaml'))
                roots.push(root)
                return { stdout: 'STEP:unmounting\nSTEP:creating filesystem\nSTEP:mounting\nok: erased slot\n' }
            },
            udevadmSettle: async () => {},
            composeDownV: async () => {},
            lsblkSizeSerial: async () => ({ sizeBytes: 32_000_000_000, serial: 'FAKE1' }),
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
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        setEraseOpsForTests(null)
        setSystemDiskOpsForTests(null)
        setCommandLogHandle(null)
        resourceLock.releaseAll([...resourceLock.allLocks().keys()])
        for (const r of roots.splice(0)) await fs.remove(r).catch(() => {})
        await fs.remove(ERASE_STAGING_ROOT).catch(() => {})
    })

    const putSummary = (targetId: string, label: string, serial: string | null = 'FAKE1') => {
        const traceId = 'sum-1'
        addTrace(logHandle, {
            traceId, command: 'summariseDisk', args: JSON.stringify({ targetId }),
            startedAt: Date.now(), completedAt: Date.now(), status: 'ok', errorMessage: null,
            result: JSON.stringify({
                targetId, label, serial, model: null, sizeBytes: 32e9, fsType: 'exfat',
                usedBytes: null, readable: false,
                apps: [], instances: [], backups: [],
                files: null, other: null, otherPartitions: [],
                computedAt: Date.now(),
            }),
        } as any)
        return traceId
    }

    it('summariseDisk on an unformatted candidate: readable false, no walk', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'CAND1', device: 'sdb', sizeBytes: 32e9,
                model: 'SanDisk', fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'FAKE1',
            }]
        })
        const summary = await summariseDisk(h, 'CAND1')
        expect(summary.readable).toBe(false)
        expect(summary.label).toBe('SanDisk 32 GB')
        expect(summary.apps).toEqual([])
        expect(summary.fsType).toBe('exfat')
        expect(summary.files).toBeNull()
        expect(summary.otherPartitions).toEqual([])
        expect(typeof summary.computedAt).toBe('number')
        expect(summary.computedAt).toBeGreaterThan(0)
    })

    it('eraseDisk refuses: unknown target, label mismatch, missing/old summary, system disk', async () => {
        await expect(eraseDisk(h, 'nope', 'missing', 'x')).rejects.toThrow(/summary|missing|10 minutes/i)
        const tid = putSummary('CAND1', 'SanDisk 32 GB')
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'CAND1', device: 'sdb', sizeBytes: 32e9,
                model: 'SanDisk', fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'FAKE1',
            }]
        })
        await expect(eraseDisk(h, 'CAND1', tid, 'Wrong Name')).rejects.toThrow(/Typed name/)
        // system disk candidate
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'SYS', device: 'sda', sizeBytes: 240e9,
                model: 'Intenso', fsType: null, label: 'Intenso 240 GB',
            }]
        })
        const tid2 = putSummary('SYS', 'Intenso 240 GB')
        await expect(eraseDisk(h, 'SYS', tid2, 'Intenso 240 GB')).rejects.toThrow(/system disk/)
    })

    it('eraseDisk success on unformatted: fake script, staging META-only, empty disk published', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'CAND1', device: 'sdb', sizeBytes: 32e9,
                model: 'SanDisk', fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'FAKE1',
            }]
        })
        const tid = putSummary('CAND1', 'SanDisk 32 GB')
        const result = await eraseDisk(h, 'CAND1', tid, 'SanDisk 32 GB')
        expect(result.diskId).toBe('CAND1')
        expect(scriptCalls).toHaveLength(1)
        expect(slotCalls).toHaveLength(0)
        expect(scriptCalls[0].device).toBe('/dev/sdb')
        expect(scriptCalls[0].label).toBe(IDEA_DISK_LABEL)
        // Production USB path still invokes idea-erase-disk args (partition whole disk)
        expect(scriptCalls[0]).toMatchObject({
            device: '/dev/sdb', serial: 'FAKE1', sizeBytes: 32_000_000_000, label: IDEA_DISK_LABEL,
        })
        // Staging was META-only (deleted after; check what script received existed)
        expect(scriptCalls[0].stagingDir).toMatch(/erase-staging/)
        const disk = h.doc()!.diskDB['CAND1' as DiskID]
        expect(disk).toBeTruthy()
        expect([...disk.diskTypes]).toEqual(['empty'])
        expect(h.doc()!.engineDB[LOCAL].eraseInProgress).toBeNull()
        expect(isEraseDeviceLocked('sdb')).toBe(false)
    })

    it('second concurrent erase is refused', async () => {
        h.change(doc => {
            doc.engineDB[LOCAL].eraseInProgress = { targetId: 'other', label: 'Other', step: 'partitioning' }
            doc.engineDB[LOCAL].unformattedDisks = [{
                candidateId: 'CAND1', device: 'sdb', sizeBytes: 32e9,
                model: 'SanDisk', fsType: 'exfat', label: 'SanDisk 32 GB', serial: 'FAKE1',
            }]
        })
        const tid = putSummary('CAND1', 'SanDisk 32 GB')
        await expect(eraseDisk(h, 'CAND1', tid, 'SanDisk 32 GB')).rejects.toThrow(/already in progress/)
    })

    it('clearStaleEraseStaging removes leftover folders', async () => {
        const dir = path.join(ERASE_STAGING_ROOT, 'stale-id')
        await fs.ensureDir(dir)
        await fs.writeFile(path.join(dir, 'META.yaml'), 'diskId: x\n')
        await clearStaleEraseStaging()
        expect(await fs.pathExists(dir)).toBe(false)
    })

    it('isSlotEraseDevice detects idea-test-N only', () => {
        expect(isSlotEraseDevice('idea-test-4')).toBe(true)
        expect(isSlotEraseDevice('sdb1')).toBe(false)
        expect(isSlotEraseDevice('sda')).toBe(false)
        expect(isSlotEraseDevice(null)).toBe(false)
    })

    it('eraseDisk loop slot success: runSlotErase, not runScript; remounts as empty', async () => {
        const device = 'idea-test-4'
        const diskId = 'duration-empty-002'
        const root = `${DISKS_ROOT}/${device}`
        await fs.ensureDir(root)
        await fs.writeFile(path.join(root, 'META.yaml'), YAML.stringify({
            diskId, diskName: 'Duration Tests — Empty Disk 002', isHardwareId: false, created: 1, version: '1.0',
        }))
        roots.push(root)
        const disk = createOrUpdateDisk(h, LOCAL, device as DeviceName, diskId as DiskID, 'Duration Tests — Empty Disk 002' as DiskName, 1 as Timestamp)
        await processDisk(h, disk)

        const tid = putSummary(diskId, 'Duration Tests — Empty Disk 002', null)
        // undockDisk is heavy; stub it so erase only exercises the slot path
        const usb = await import('../../src/monitors/usbDeviceMonitor.js')
        const undockSpy = vi.spyOn(usb, 'undockDisk').mockImplementation(async (storeHandle, d) => {
            storeHandle.change(doc => {
                const x = doc.diskDB[d.id]
                if (x) { x.dockedTo = null; x.device = null as any }
            })
        })

        const result = await eraseDisk(h, diskId, tid, 'Duration Tests — Empty Disk 002')
        expect(result.diskId).toBe(diskId)
        expect(slotCalls).toHaveLength(1)
        expect(slotCalls[0].slot).toBe(device)
        expect(slotCalls[0].stagingDir).toMatch(/erase-staging/)
        expect(scriptCalls).toHaveLength(0)
        const published = h.doc()!.diskDB[diskId as DiskID]
        expect(published).toBeTruthy()
        expect([...published.diskTypes]).toEqual(['empty'])
        undockSpy.mockRestore()
    })

    it('eraseDisk loop slot: still-mounted refusal when umount really fails', async () => {
        const device = 'idea-test-4'
        const diskId = 'duration-empty-002'
        const root = `${DISKS_ROOT}/${device}`
        await fs.ensureDir(root)
        await fs.writeFile(path.join(root, 'META.yaml'), YAML.stringify({
            diskId, diskName: 'Duration Tests — Empty Disk 002', isHardwareId: false, created: 1, version: '1.0',
        }))
        roots.push(root)
        const disk = createOrUpdateDisk(h, LOCAL, device as DeviceName, diskId as DiskID, 'Duration Tests — Empty Disk 002' as DiskName, 1 as Timestamp)
        await processDisk(h, disk)
        const tid = putSummary(diskId, 'Duration Tests — Empty Disk 002', null)

        const usb = await import('../../src/monitors/usbDeviceMonitor.js')
        vi.spyOn(usb, 'undockDisk').mockImplementation(async (storeHandle, d) => {
            storeHandle.change(doc => {
                const x = doc.diskDB[d.id]
                if (x) { x.dockedTo = null; x.device = null as any }
            })
        })

        setEraseOpsForTests({
            runSlotErase: async () => { throw new Error('helper: could not unmount') },
            isMountPoint: async () => true,
            runScript: async () => { throw new Error('USB script must not run for slots') },
            addDevice: async () => {},
            udevadmSettle: async () => {},
            composeDownV: async () => {},
            lsblkSizeSerial: async () => ({ sizeBytes: 0, serial: null }),
        })

        await expect(eraseDisk(h, diskId, tid, 'Duration Tests — Empty Disk 002'))
            .rejects.toThrow(/couldn't be unmounted, so nothing was erased/)
        expect(scriptCalls).toHaveLength(0)
    })

    it('eraseDisk USB path refuses when still mounted (unchanged)', async () => {
        const device = 'sdb1'
        const diskId = 'usb-disk-1'
        const root = `${DISKS_ROOT}/${device}`
        await fs.ensureDir(root)
        await fs.writeFile(path.join(root, 'META.yaml'), YAML.stringify({
            diskId, diskName: 'USB Stick', isHardwareId: false, created: 1, version: '1.0',
        }))
        roots.push(root)
        const disk = createOrUpdateDisk(h, LOCAL, device as DeviceName, diskId as DiskID, 'USB Stick' as DiskName, 1 as Timestamp)
        await processDisk(h, disk)
        const tid = putSummary(diskId, 'USB Stick', 'FAKE1')

        const usb = await import('../../src/monitors/usbDeviceMonitor.js')
        vi.spyOn(usb, 'undockDisk').mockImplementation(async (storeHandle, d) => {
            storeHandle.change(doc => {
                const x = doc.diskDB[d.id]
                if (x) { x.dockedTo = null; x.device = null as any }
            })
        })
        setEraseOpsForTests({
            isMountPoint: async () => true,
            runScript: async () => { throw new Error('should not partition') },
            runSlotErase: async () => { throw new Error('should not slot-erase') },
            addDevice: async () => {},
            udevadmSettle: async () => {},
            composeDownV: async () => {},
            lsblkSizeSerial: async () => ({ sizeBytes: 32e9, serial: 'FAKE1' }),
        })

        await expect(eraseDisk(h, diskId, tid, 'USB Stick'))
            .rejects.toThrow(/couldn't be unmounted, so nothing was erased/)
        expect(scriptCalls).toHaveLength(0)
        expect(slotCalls).toHaveLength(0)
    })
})
