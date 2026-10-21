/**
 * disk-id-per-partition.test.ts (idea#168 D4)
 *
 * readHardwareId() returns the serial of the whole drive, so every partition of
 * one Intenso / Samsung FIT SSD got the same diskId (one store record flipping
 * between devices), and Stage 2 had to pin skipHardwareId. The id is now
 * serial + partition identity (DiskIdentity.ts):
 *   - two partitions on one serial get distinct ids, stable across replug,
 *     reboot and a kernel rename (sdb → sdc);
 *   - a single-partition disk keeps its legacy serial id (no store churn);
 *   - assigned ids (Stage 2 fixtures) are no longer overridden by the serial;
 *   - no two partitions ever resolve to one id.
 * No /sys, no lsblk, no hdparm: hardware facts are injected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fs, YAML } from 'zx'
import path from 'path'
import { config, disksRoot } from '../../src/data/Config.js'
import { readMetaUpdateId, readHardwareIdentity, newHardwareDiskId } from '../../src/data/Meta.js'
import {
    HardwareIdentity, PartitionFacts, hardwareDiskId, isPrimaryPartition, partitionDiskId,
    readPartitionFacts, resolveHardwareDiskId,
} from '../../src/data/DiskIdentity.js'
import { DeviceName, DiskID } from '../../src/data/CommonTypes.js'

// test-run.sh runs vitest from the repo root
const ROOT = process.cwd()

// Stage 2 idea01 SSD: Intenso AA000000000000009991, two GPT ext4 partitions
const SERIAL = 'AA000000000000009991'
const FIT = '0374520060012345'                 // a Samsung FIT scsi_id-style serial
const P1 = 'b3f0c1de-1111-4a2b-9c3d-0123456789ab'
const P2 = 'B3F0C1DE-2222-4A2B-9C3D-0123456789AB'   // lsblk may report upper-case on some systems

const part = (name: string, partn: number | null, partuuid: string | null, fstype: string | null = 'ext4'): PartitionFacts => ({ name, partn, partuuid, fstype })
const drive = (serial: string, parts: PartitionFacts[], selfName: string): HardwareIdentity => ({
    serial, self: parts.find(p => p.name === selfName)!, siblings: parts,
})
const twoParts = (letter = 'b') => [part(`sd${letter}1`, 1, P1), part(`sd${letter}2`, 2, P2)]
const onePart = (letter = 'b') => [part(`sd${letter}1`, 1, P1)]

describe('DiskIdentity: ids for partitions on a drive with a hardware serial', () => {
    it('two partitions on one serial get distinct ids, neither the bare serial', () => {
        const a = resolveHardwareDiskId(null, drive(SERIAL, twoParts(), 'sdb1'))
        const b = resolveHardwareDiskId(null, drive(SERIAL, twoParts(), 'sdb2'))
        expect(a.diskId).toBe(`${SERIAL}-${P1}`)
        expect(b.diskId).toBe(`${SERIAL}-${P2.toLowerCase()}`)
        expect(a.diskId).not.toBe(b.diskId)
        expect([a.decision, b.decision, a.isHardwareId, b.isHardwareId]).toEqual(['new', 'new', true, true])
    })

    it('ids are stable across replug / reboot / rename sdb → sdc (device name is never part of the id)', () => {
        const before = ['sdb1', 'sdb2'].map(n => hardwareDiskId(drive(SERIAL, twoParts('b'), n)))
        const renamed = ['sdc1', 'sdc2'].map(n => hardwareDiskId(drive(SERIAL, twoParts('c'), n)))
        expect(renamed).toEqual(before)
        // and with META.yaml holding the id from the first dock: kept as is
        for (const [i, n] of ['sdc1', 'sdc2'].entries()) {
            const r = resolveHardwareDiskId({ diskId: before[i], isHardwareId: true }, drive(SERIAL, twoParts('c'), n))
            expect(r).toEqual({ diskId: before[i], isHardwareId: true, decision: 'keep-partition' })
        }
    })

    it('a single-partition disk keeps its legacy serial id; a new one gets the serial too', () => {
        expect(resolveHardwareDiskId({ diskId: SERIAL as DiskID, isHardwareId: true }, drive(SERIAL, onePart(), 'sdb1')))
            .toEqual({ diskId: SERIAL, isHardwareId: true, decision: 'keep-legacy' })
        expect(resolveHardwareDiskId(null, drive(SERIAL, onePart('d'), 'sdd1')).diskId).toBe(SERIAL)
        // eraseDisk writes the serial with isHardwareId: false — kept unchanged
        expect(resolveHardwareDiskId({ diskId: SERIAL as DiskID, isHardwareId: false }, drive(SERIAL, onePart(), 'sdb1')))
            .toEqual({ diskId: SERIAL, isHardwareId: false, decision: 'keep-legacy' })
    })

    it('a non-ext4 partition next to the data partition does not make the drive shared (legacy id kept)', () => {
        const parts = [part('sdb1', 1, P1, 'vfat'), part('sdb2', 2, P2, 'ext4')]
        expect(resolveHardwareDiskId({ diskId: SERIAL as DiskID, isHardwareId: true }, drive(SERIAL, parts, 'sdb2')).decision).toBe('keep-legacy')
        expect(hardwareDiskId(drive(SERIAL, parts, 'sdb2'))).toBe(SERIAL)
    })

    it('legacy collision (both partitions carry the bare serial): the primary keeps it, the other moves to <serial>-<PARTUUID>', () => {
        const meta = { diskId: SERIAL as DiskID, isHardwareId: true }
        const a = resolveHardwareDiskId(meta, drive(SERIAL, twoParts(), 'sdb1'))
        const b = resolveHardwareDiskId(meta, drive(SERIAL, twoParts(), 'sdb2'))
        expect(a).toEqual({ diskId: SERIAL, isHardwareId: true, decision: 'keep-legacy' })
        expect(b).toEqual({ diskId: `${SERIAL}-${P2.toLowerCase()}`, isHardwareId: true, decision: 'migrate-legacy' })
        // primary is decided by partition number, not by name or dock order
        expect(isPrimaryPartition(drive(SERIAL, twoParts('c'), 'sdc1'))).toBe(true)
        expect(isPrimaryPartition(drive(SERIAL, twoParts('c'), 'sdc2'))).toBe(false)
    })

    it('assigned ids are kept with the lookup on (Stage 2 fixtures on one Intenso SSD no longer collapse to the serial)', () => {
        const kol = resolveHardwareDiskId({ diskId: 'duration-kolibri-grade5a-001' as DiskID, isHardwareId: false }, drive(SERIAL, twoParts('a'), 'sda1'))
        const add = resolveHardwareDiskId({ diskId: 'duration-add-files-001' as DiskID }, drive(SERIAL, twoParts('a'), 'sda2'))
        expect([kol.diskId, kol.decision]).toEqual(['duration-kolibri-grade5a-001', 'keep-assigned'])
        expect([add.diskId, add.decision]).toEqual(['duration-add-files-001', 'keep-assigned'])
    })

    it("a clone (META claims another drive's hardware id) gets this partition's own id", () => {
        const r = resolveHardwareDiskId({ diskId: 'AA000000000000005638' as DiskID, isHardwareId: true }, drive(SERIAL, twoParts(), 'sdb2'))
        expect(r).toEqual({ diskId: `${SERIAL}-${P2.toLowerCase()}`, isHardwareId: true, decision: 'clone' })
        // a copy of the sibling partition's META on the same drive is a clone too
        const sib = resolveHardwareDiskId({ diskId: `${SERIAL}-${P1}` as DiskID, isHardwareId: true }, drive(SERIAL, twoParts(), 'sdb2'))
        expect(sib.decision).toBe('clone')
        expect(sib.diskId).toBe(`${SERIAL}-${P2.toLowerCase()}`)
    })

    it('without PARTUUID (e.g. no udev data) the partition number is the key; unknown layout never re-keys', () => {
        const parts = [part('sdb1', 1, null), part('sdb2', 2, null)]
        expect(['sdb1', 'sdb2'].map(n => hardwareDiskId(drive(SERIAL, parts, n)))).toEqual([`${SERIAL}-p1`, `${SERIAL}-p2`])
        expect(partitionDiskId(SERIAL, part('sdb9', null, null))).toBeNull()
        const unknown: HardwareIdentity = { serial: SERIAL, self: part('sdb2', 2, P2), siblings: null }
        expect(resolveHardwareDiskId({ diskId: SERIAL as DiskID, isHardwareId: true }, unknown).decision).toBe('keep-legacy')
        expect(hardwareDiskId(unknown)).toBe(SERIAL)
    })

    it('no collisions: every partition of two multi-partition SSDs (Intenso + FIT) and a single-partition stick resolves to a unique id, from any META state', () => {
        const drives = [
            { serial: SERIAL, parts: twoParts('a') },
            { serial: FIT, parts: [part('sdb1', 1, '11111111-01'), part('sdb2', 2, '11111111-02'), part('sdb3', 3, '11111111-03')] },  // MBR PARTUUIDs
            { serial: 'AA000000000000005638', parts: onePart('c') },
        ]
        const metaStates: ((d: { serial: string }) => { diskId: DiskID, isHardwareId?: boolean } | null)[] = [
            () => null,                                                       // first dock
            d => ({ diskId: d.serial as DiskID, isHardwareId: true }),        // old Engine wrote the bare serial everywhere
        ]
        for (const state of metaStates) {
            const ids: string[] = []
            for (const d of drives) for (const p of d.parts) ids.push(String(resolveHardwareDiskId(state(d), drive(d.serial, d.parts, p.name)).diskId))
            expect(new Set(ids).size, ids.join(' ')).toBe(ids.length)
        }
    })
})

describe('readPartitionFacts (lsblk + sysfs, injected)', () => {
    const lsblk = JSON.stringify({ blockdevices: [{ name: 'sdb', type: 'disk', partuuid: null, fstype: null, children: [
        { name: 'sdb1', type: 'part', partuuid: P1, fstype: 'ext4' },
        { name: 'sdb2', type: 'part', partuuid: P2, fstype: 'ext4' },
    ] }] })

    it('reads PARTUUID, FSTYPE and the partition number of self and siblings', async () => {
        const f = await readPartitionFacts('sdb2' as DeviceName, {
            lsblkJson: async (whole) => { expect(whole).toBe('sdb'); return lsblk },
            readSysfs: async (p) => p.endsWith('sdb1/partition') ? '1\n' : '2\n',
        })
        expect(f.self).toEqual(part('sdb2', 2, P2))
        expect(f.siblings).toEqual([part('sdb1', 1, P1), part('sdb2', 2, P2)])
    })

    it('falls back to the name suffix for the number; lsblk failure gives unknown siblings', async () => {
        const f = await readPartitionFacts('sdb1' as DeviceName, { lsblkJson: async () => lsblk, readSysfs: async () => { throw new Error('no sysfs') } })
        expect(f.self?.partn).toBe(1)
        const bad = await readPartitionFacts('sdb1' as DeviceName, { lsblkJson: async () => { throw new Error('lsblk: not found') } })
        expect(bad.siblings).toBeNull()
        expect((await readPartitionFacts('sdb' as DeviceName, { lsblkJson: async () => lsblk })).self).toBeNull()
    })
})

describe('readHardwareIdentity / newHardwareDiskId (D4: Intenso / Samsung FIT report the drive serial for every partition)', () => {
    const facts = async (d: DeviceName) => ({ self: twoParts().find(p => p.name === d)!, siblings: twoParts() })
    const intenso = async () => SERIAL as DiskID      // what hdparm -I /dev/sdb1 and /dev/sdb2 both return

    it('the drive serial is the same for both partitions, the new diskIds are not', async () => {
        const ids = await Promise.all(['sdb1', 'sdb2'].map(d => newHardwareDiskId(d as DeviceName,
            (dev) => readHardwareIdentity(dev, { readHardwareId: intenso, readPartitionFacts: facts }))))
        expect(ids).toEqual([`${SERIAL}-${P1}`, `${SERIAL}-${P2.toLowerCase()}`])
    })

    it('no hardware serial → undefined (caller generates a uuid, as before)', async () => {
        expect(await readHardwareIdentity('sdb1' as DeviceName, { readHardwareId: async () => undefined, readPartitionFacts: facts })).toBeUndefined()
        expect(await newHardwareDiskId('sdb1' as DeviceName, async () => undefined)).toBeUndefined()
    })
})

describe('readMetaUpdateId with the hardware lookup on (skipHardwareId false), META.yaml on fixture mounts', () => {
    const saved = { ...config.settings }
    const devs = ['sdb1', 'sdb2', 'sdc1', 'sdc2']
    const metaPath = (d: string) => `${disksRoot()}/${d}/META.yaml`
    const writeMeta = async (d: string, m: Record<string, unknown>) => {
        await fs.ensureDir(`${disksRoot()}/${d}`)
        await fs.writeFile(metaPath(d), YAML.stringify({ diskName: `Disk ${d}`, created: 1, lastDocked: 2, ...m }))
    }
    const identityFor = (letter: string, serial = SERIAL, parts = twoParts) => async (d: DeviceName): Promise<HardwareIdentity> =>
        drive(serial, parts(letter), d)

    beforeEach(() => {
        config.settings.isDev = false
        config.settings.testMode = true
        config.settings.skipHardwareId = false
        config.settings.skipMetaUpdate = false
        vi.spyOn(console, 'info').mockImplementation(() => {})
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        Object.assign(config.settings, saved)
        if (saved.skipHardwareId === undefined) delete config.settings.skipHardwareId
        if (saved.skipMetaUpdate === undefined) delete config.settings.skipMetaUpdate
        for (const d of devs) await fs.remove(`${disksRoot()}/${d}`)
    })

    it('old collision on disk (both METAs = serial) → distinct ids written back, then stable after replug as sdc', async () => {
        await writeMeta('sdb1', { diskId: SERIAL, isHardwareId: true })
        await writeMeta('sdb2', { diskId: SERIAL, isHardwareId: true })
        const a = await readMetaUpdateId('sdb1' as DeviceName, { readIdentity: identityFor('b') })
        const b = await readMetaUpdateId('sdb2' as DeviceName, { readIdentity: identityFor('b') })
        expect(a.diskId).toBe(SERIAL)                                   // primary keeps the legacy id
        expect(b.diskId).toBe(`${SERIAL}-${P2.toLowerCase()}`)
        expect(YAML.parse(await fs.readFile(metaPath('sdb2'), 'utf8')).diskId).toBe(b.diskId)
        // replug: the kernel names the SSD sdc now; META moves with the partition
        await fs.move(`${disksRoot()}/sdb1`, `${disksRoot()}/sdc1`)
        await fs.move(`${disksRoot()}/sdb2`, `${disksRoot()}/sdc2`)
        const a2 = await readMetaUpdateId('sdc1' as DeviceName, { readIdentity: identityFor('c') })
        const b2 = await readMetaUpdateId('sdc2' as DeviceName, { readIdentity: identityFor('c') })
        expect([a2.diskId, b2.diskId]).toEqual([a.diskId, b.diskId])
    })

    it('Stage 2 fixtures (assigned ids, isHardwareId false) on one Intenso SSD keep their ids with skipHardwareId false', async () => {
        await writeMeta('sdb1', { diskId: 'duration-nextcloud-grade5a-001', isHardwareId: false })
        await writeMeta('sdb2', { diskId: 'duration-empty-001', isHardwareId: false })
        const ids = [
            (await readMetaUpdateId('sdb1' as DeviceName, { readIdentity: identityFor('b') })).diskId,
            (await readMetaUpdateId('sdb2' as DeviceName, { readIdentity: identityFor('b') })).diskId,
        ]
        expect(ids).toEqual(['duration-nextcloud-grade5a-001', 'duration-empty-001'])
    })

    it('a single-partition production disk keeps its serial id and its META diskId is not rewritten', async () => {
        await writeMeta('sdb1', { diskId: SERIAL, isHardwareId: true })
        const m = await readMetaUpdateId('sdb1' as DeviceName, { readIdentity: identityFor('b', SERIAL, onePart) })
        expect(m.diskId).toBe(SERIAL)
        expect(YAML.parse(await fs.readFile(metaPath('sdb1'), 'utf8')).diskId).toBe(SERIAL)
    })

    it('the system disk (no device argument) keeps the bare root-drive serial: the partition reader is used for App Disks only', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/data/Meta.ts'), 'utf-8')
        expect(src).toContain('const identity = deviceSpec ? await deps.readIdentity(device).catch(() => undefined) : undefined')
        expect(src).toContain('diskId = (deviceSpec ? undefined : await deps.readHardwareId(device)) as DiskID')
        let calls = 0
        await writeMeta('sdb1', { diskId: SERIAL, isHardwareId: true })
        await readMetaUpdateId('sdb1' as DeviceName, { readIdentity: async (d) => { calls++; return identityFor('b', SERIAL, onePart)(d) } })
        expect(calls).toBe(1)
    })
})
