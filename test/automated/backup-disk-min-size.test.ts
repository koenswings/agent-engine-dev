/**
 * backup-disk-min-size.test.ts (engine#452)
 *
 * The 8 GiB Backup Disk floor (MAKE_BACKUP_DISK_MIN_BYTES, Steve, idea#404)
 * is shared by makeBackupDisk Check, createBackupDisk and initialiseDisk …
 * backup. makeBackupDisk Check coverage stays in make-backup-disk.test.ts.
 * createBackupDisk command coverage is in create-backup-disk.test.ts.
 * This file locks the shared helper wording and the initialiseDisk … backup path.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { EngineID, DiskID } from '../../src/data/CommonTypes.js'
import {
    scanClientCards, setClientCardOpsForTests, clearClientCardStateForTests, resetClientCardWriteCacheForTests, CardLsblkDevice,
} from '../../src/data/ClientCards.js'
import { initialiseDisk, setFlashCardOpsForTests, clearFlashStateForTests, CardError } from '../../src/data/FlashCard.js'
import { setUnformattedOpsForTests, clearGeneratedUnformattedIdsForTests } from '../../src/data/UnformattedDisks.js'
import {
    MAKE_BACKUP_DISK_MIN_BYTES, MakeBackupDiskError, assertBackupDiskMinSize, backupDiskMinSizeRefusal, readableBackupDiskBytes,
} from '../../src/data/MakeBackupDisk.js'
import { fs } from 'zx'
import { DISKS_ROOT } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const EIGHT_GIB = MAKE_BACKUP_DISK_MIN_BYTES
const GB = 1_000_000_000
const SYS: CardLsblkDevice = { name: 'sda', type: 'disk', size: 500 * GB, rm: false, tran: 'usb', model: 'SSD', serial: 'SYS1',
    children: [{ name: 'sda1', type: 'part', fstype: 'vfat', label: 'bootfs', size: 512e6, mountpoint: '/boot/firmware' },
               { name: 'sda2', type: 'part', fstype: 'ext4', label: 'rootfs', size: 499 * GB, mountpoint: '/' }] }

const stick = (name: string, size: number, serial: string): CardLsblkDevice => ({
    name, type: 'disk', size, rm: true, tran: 'usb', model: 'TestStick', serial,
    children: [{ name: `${name}1`, type: 'part', fstype: 'ext4', label: 'data', size }],
})

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

const useDevices = (devs: CardLsblkDevice[]) => {
    setClientCardOpsForTests({
        lsblkJson: async () => JSON.parse(JSON.stringify(devs)),
        byIdLinks: async () => devs.filter(d => d.name !== 'sda').map(d => ({
            link: `/dev/disk/by-id/usb-${(d.model ?? 'X').replace(/ /g, '_')}_${d.serial}-0:0`,
            device: d.name,
        })),
        sysfsPath: async (d) => `/sys/devices/platform/usb1/1-1/1-1.2/1-1.2:1.0/host0/target0:0:0/0:0:0:0/block/${d}`,
        isSystemDevice: async (d) => d.startsWith('sda'),
        dockedDevices: () => new Set<string>(),
    })
    setUnformattedOpsForTests({ lsblkJson: async () => JSON.parse(JSON.stringify(devs)) as any, hardwareId: async () => undefined })
}

describe('shared Backup Disk minimum helper (engine#452)', () => {
    it('MAKE_BACKUP_DISK_MIN_BYTES is 8 GiB', () => {
        expect(EIGHT_GIB).toBe(8 * 1024 * 1024 * 1024)
    })
    it('readableBackupDiskBytes accepts only a positive finite number', () => {
        expect(readableBackupDiskBytes(EIGHT_GIB)).toBe(EIGHT_GIB)
        expect(readableBackupDiskBytes(1)).toBe(1)
        expect(readableBackupDiskBytes(0)).toBeNull()
        expect(readableBackupDiskBytes(-1)).toBeNull()
        expect(readableBackupDiskBytes(null)).toBeNull()
        expect(readableBackupDiskBytes(undefined)).toBeNull()
        expect(readableBackupDiskBytes(Number.NaN)).toBeNull()
        expect(readableBackupDiskBytes('8589934592')).toBeNull()
    })
    it('the unread and under-8-GiB wording matches makeBackupDisk Check', () => {
        expect(backupDiskMinSizeRefusal('tiny', null)).toEqual({
            code: 'TOO_SMALL',
            text: "could not read the size of 'tiny', so it was not turned into a Backup Disk.",
        })
        expect(backupDiskMinSizeRefusal('tiny', EIGHT_GIB - 1)).toEqual({
            code: 'TOO_SMALL',
            text: `this disk is ${EIGHT_GIB - 1} bytes; a Backup Disk must be at least ${EIGHT_GIB} bytes (8 GiB).`,
        })
    })
    it('assertBackupDiskMinSize allows exactly 8 GiB and takes the first readable fallback', () => {
        expect(assertBackupDiskMinSize('d1', EIGHT_GIB)).toBe(EIGHT_GIB)
        expect(assertBackupDiskMinSize('d1', null, EIGHT_GIB)).toBe(EIGHT_GIB)
        expect(assertBackupDiskMinSize('d1', undefined, 0, EIGHT_GIB + 1)).toBe(EIGHT_GIB + 1)
    })
    it('assertBackupDiskMinSize throws TOO_SMALL under 8 GiB or when no size is readable', () => {
        try {
            assertBackupDiskMinSize('tiny', EIGHT_GIB - 1)
            throw new Error('expected throw')
        } catch (e: any) {
            expect(e).toBeInstanceOf(MakeBackupDiskError)
            expect(e.code).toBe('TOO_SMALL')
            expect(e.message).toBe(`TOO_SMALL: this disk is ${EIGHT_GIB - 1} bytes; a Backup Disk must be at least ${EIGHT_GIB} bytes (8 GiB).`)
        }
        try {
            assertBackupDiskMinSize('gone', null, 0, undefined)
            throw new Error('expected throw')
        } catch (e: any) {
            expect(e.code).toBe('TOO_SMALL')
            expect(e.message).toBe("TOO_SMALL: could not read the size of 'gone', so it was not turned into a Backup Disk.")
        }
    })
})

describe('initialiseDisk … backup 8 GiB minimum (engine#452)', () => {
    let h: DocHandle<Store>
    let onDisk: Record<string, string>
    let deviceDir: string

    const addDeviceWithSize = (sizeBytes: number | undefined) => async (_partition: string) => {
        // initialiseDisk has already written META.yaml into onDisk; parse the new id.
        const yaml = Object.values(onDisk)[0]
        const id = /diskId: (\S+)/.exec(yaml)![1]
        const partition = Object.keys(onDisk)[0]
        h.change(d => {
            (d.diskDB as any)[id] = {
                id, name: 'IDEA Disk', device: partition, dockedTo: LOCAL, diskTypes: ['empty'],
                backupConfig: null,
                ...(sizeBytes !== undefined ? { sizeBytes } : {}),
            }
        })
        // Create writes BACKUP.yaml under DISKS_ROOT/<device>
        await fs.ensureDir(`${DISKS_ROOT}/${partition}`)
        deviceDir = `${DISKS_ROOT}/${partition}`
    }

    beforeEach(async () => {
        clearClientCardStateForTests(); resetClientCardWriteCacheForTests(); clearFlashStateForTests(); clearGeneratedUnformattedIdsForTests()
        h = await newStore()
        onDisk = {}
        deviceDir = ''
    })
    afterEach(async () => {
        setFlashCardOpsForTests(null); setClientCardOpsForTests(null); setUnformattedOpsForTests(null)
        if (deviceDir) await fs.remove(deviceDir)
    })

    const arm = (devs: CardLsblkDevice[], registeredSize?: number | undefined, roleOpts: { stubBackup?: boolean } = {}) => {
        useDevices(devs)
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async () => ({ ok: true, hasMeta: false, alreadyMounted: false }),
            mountRw: async () => ({ ok: true, alreadyMounted: false, fsUuid: null }),
            writeMeta: async (p, yaml) => { onDisk[p] = yaml },
            forgetMetaLook: () => {},
            addDevice: addDeviceWithSize(registeredSize),
            unmount: async () => ({ ok: true }),
            createFilesDisk: async () => undefined,
            ...(roleOpts.stubBackup ? { createBackupDisk: async () => undefined } : {}),
        })
    }

    const candidateOf = async (device: string) =>
        (await scanClientCards(undefined, String(LOCAL))).newDisks.find(d => d.device === device)!.candidateId

    it('TOO_SMALL on a candidate under 8 GiB; BACKUP.yaml is not written; the disk is not a Backup Disk', async () => {
        arm([SYS, stick('sdc', EIGHT_GIB - 1, 'TINY1')], EIGHT_GIB - 1)
        const cand = await candidateOf('sdc')
        let err: CardError | null = null
        try { await initialiseDisk(h, cand, 'backup') } catch (e) { err = e as CardError }
        expect(err?.code).toBe('TOO_SMALL')
        expect(err?.message).toBe(`TOO_SMALL: this disk is ${EIGHT_GIB - 1} bytes; a Backup Disk must be at least ${EIGHT_GIB} bytes (8 GiB).`)
        const ops = Object.values(h.doc()!.operationDB)
        expect(ops[0].status).toBe('Failed')
        expect(ops[0].error).toMatch(/^TOO_SMALL:/)
        expect(ops[0].kind).toBe('initialiseDisk')
        const disks = Object.values(h.doc()!.diskDB)
        expect(disks).toHaveLength(1)
        expect(disks[0].diskTypes).toEqual(['empty'])
        expect(disks[0].backupConfig).toBeNull()
        expect(await fs.pathExists(`${DISKS_ROOT}/sdc1/BACKUP.yaml`)).toBe(false)
    })

    it('allows initialiseDisk … backup on a disk that is exactly 8 GiB', async () => {
        arm([SYS, stick('sdc', EIGHT_GIB, 'EXACT1')], EIGHT_GIB)
        const cand = await candidateOf('sdc')
        const r = await initialiseDisk(h, cand, 'backup')
        expect(h.doc()!.operationDB[r.operationId].status).toBe('Done')
        const disk = h.doc()!.diskDB[r.diskId as DiskID]
        expect(disk.backupConfig?.mode).toBe('scheduled')
        expect(await fs.pathExists(`${DISKS_ROOT}/sdc1/BACKUP.yaml`)).toBe(true)
        expect(await fs.pathExists(`${DISKS_ROOT}/sdc1/backups`)).toBe(true)
    })

    it('TOO_SMALL when the size cannot be read (no sizeBytes on the record or the candidate)', async () => {
        // lsblk skips a 0-byte disk, so stub scan with an otherwise valid candidate whose size is unreadable.
        const cand = 'cand-nosize'
        useDevices([SYS])
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            scan: async () => ({
                newDisks: [{
                    candidateId: cand, device: 'sdc', byId: '', sizeBytes: 0, model: 'TestStick', serial: 'NOSIZE',
                    removable: true, readerId: null, partitions: [{ label: 'data', fsType: 'ext4', sizeBytes: 0 }],
                    contents: { kind: 'empty' }, mountedReadOnly: false, firstSeen: 1,
                }],
                cardReaders: [], clientCards: [], newDiskPartitions: { [cand]: ['sdc1'] }, diskCandidates: [],
            } as any),
            lookForMeta: async () => ({ ok: true, hasMeta: false, alreadyMounted: false }),
            mountRw: async () => ({ ok: true, alreadyMounted: false, fsUuid: null }),
            writeMeta: async (p, yaml) => { onDisk[p] = yaml },
            forgetMetaLook: () => {},
            addDevice: addDeviceWithSize(undefined),
            unmount: async () => ({ ok: true }),
        })
        let err: CardError | null = null
        try { await initialiseDisk(h, cand, 'backup') } catch (e) { err = e as CardError }
        expect(err?.code).toBe('TOO_SMALL')
        expect(err?.message).toMatch(/^TOO_SMALL: could not read the size of '[^']+', so it was not turned into a Backup Disk\.$/)
        const disk = Object.values(h.doc()!.diskDB)[0]
        expect(disk.backupConfig).toBeNull()
        expect(disk.diskTypes).toEqual(['empty'])
        expect(await fs.pathExists(`${DISKS_ROOT}/sdc1/BACKUP.yaml`)).toBe(false)
        const op = Object.values(h.doc()!.operationDB)[0]
        expect(op.status).toBe('Failed')
        expect(op.error).toMatch(/^TOO_SMALL:/)
    })

    it('falls back to the candidate size when the newly registered disk has no sizeBytes', async () => {
        arm([SYS, stick('sdc', EIGHT_GIB, 'FALLBACK1')], undefined)
        const cand = await candidateOf('sdc')
        const r = await initialiseDisk(h, cand, 'backup')
        expect(h.doc()!.operationDB[r.operationId].status).toBe('Done')
        expect(h.doc()!.diskDB[r.diskId as DiskID].backupConfig?.mode).toBe('scheduled')
    })

    it('roles empty and files are not subject to the 8 GiB rule', async () => {
        arm([SYS, stick('sdc', EIGHT_GIB - 1, 'EMPTY1')], EIGHT_GIB - 1, { stubBackup: true })
        const cand = await candidateOf('sdc')
        const r = await initialiseDisk(h, cand, 'empty')
        expect(h.doc()!.operationDB[r.operationId].status).toBe('Done')
        expect(h.doc()!.diskDB[r.diskId as DiskID].diskTypes).toEqual(['empty'])
        expect(h.doc()!.diskDB[r.diskId as DiskID].backupConfig ?? null).toBeNull()
    })
})
