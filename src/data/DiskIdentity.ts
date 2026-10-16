/**
 * DiskIdentity.ts — the diskId of an App Disk partition with a hardware serial (idea#168 D4)
 *
 * Problem: readHardwareId() returns the serial of the WHOLE drive (Intenso via
 * hdparm, Samsung FIT via scsi_id). Every partition of one SSD therefore got the
 * same diskId, so two partitions on one SSD were one store record that flipped
 * between devices. Stage 2 had to pin skipHardwareId to avoid it.
 *
 * Rule (pure, see resolveHardwareDiskId):
 *   - A drive with ONE ext4 partition: diskId = serial (unchanged, legacy form;
 *     also what eraseDisk's candidateId and every production App Disk use).
 *   - A drive with SEVERAL ext4 partitions: diskId = `<serial>-<partition key>`,
 *     partition key = the partition's PARTUUID (GPT GUID, or MBR `<disk id>-<nn>`),
 *     lower-case; `p<N>` (partition number) only when there is no PARTUUID.
 *     PARTUUID and the number live in the partition table, so the id survives
 *     unplug/replug, reboot and a kernel rename (sdb2 → sdc2). The device name
 *     (sdX) is never part of the id.
 *   - Existing META ids are kept when they are still valid for this partition:
 *       * `<serial>-<key>` of THIS partition: kept (even if siblings come or go);
 *       * bare `<serial>` (legacy): kept on the drive's primary partition (lowest
 *         numbered ext4 partition), so every single-partition disk already in the
 *         store keeps its id; a non-primary partition carrying it (the old
 *         collision) moves to `<serial>-<key>`;
 *       * an assigned/generated id (isHardwareId not true): kept. The serial no
 *         longer overrides it — that override is what re-keyed both Stage 2
 *         fixtures on one SSD to the same serial;
 *       * isHardwareId true but not this drive's serial (a clone of another
 *         disk): replaced by this partition's hardware id, as before.
 *
 * The system disk (/META.yaml) is not handled here: its id stays the bare root
 * drive serial, because the Engine id is derived from it.
 */

import { $ } from 'zx'
import { stripPartition, log } from '../utils/utils.js'
import { DeviceName, DiskID } from './CommonTypes.js'

/** One partition of the drive, as lsblk/sysfs report it. */
export interface PartitionFacts {
    name: string                // kernel name now (sdb2) — informational only, never part of the id
    partn: number | null        // partition number in the table
    partuuid: string | null     // PARTUUID (GPT GUID or MBR <disk id>-<nn>)
    fstype: string | null
}

/** What the id of one partition depends on. */
export interface HardwareIdentity {
    serial: string
    self: PartitionFacts
    /** Every partition of the same drive, self included; null when it could not be read */
    siblings: PartitionFacts[] | null
}

export interface MetaIdClaim {
    diskId: DiskID
    isHardwareId?: boolean
}

export type IdDecision =
    | 'new'               // no META: the computed hardware id
    | 'keep-partition'    // META holds <serial>-<key> of this partition
    | 'keep-legacy'       // META holds the bare serial and this is the primary partition
    | 'migrate-legacy'    // META holds the bare serial on a non-primary partition → <serial>-<key>
    | 'keep-assigned'     // META holds an assigned/generated id (isHardwareId not true)
    | 'clone'             // META holds another drive's hardware id → this partition's id

export interface IdResolution {
    diskId: DiskID
    isHardwareId: boolean
    decision: IdDecision
}

/** The Engine docks only ext4 partitions (idea#134). */
const docked = (p: PartitionFacts) => (p.fstype ?? '').toLowerCase() === 'ext4'

/** Stable per-partition key: PARTUUID, else the partition number; null when neither is known. */
export const partitionKey = (p: PartitionFacts): string | null => {
    const u = p.partuuid?.trim().toLowerCase()
    if (u) return u
    if (p.partn != null && Number.isFinite(p.partn)) return `p${p.partn}`
    return null
}

/** `<serial>-<partition key>`, or null when the partition has no stable key. */
export const partitionDiskId = (serial: string, p: PartitionFacts): DiskID | null => {
    const key = partitionKey(p)
    return key ? `${serial}-${key}` as DiskID : null
}

/** ext4 partitions of the drive; self always counts (it is being docked). */
const dockedSiblings = (id: HardwareIdentity): PartitionFacts[] | null => {
    if (!id.siblings) return null
    const same = (a: PartitionFacts, b: PartitionFacts) =>
        (a.partuuid && b.partuuid) ? a.partuuid.toLowerCase() === b.partuuid.toLowerCase()
            : (a.partn != null && b.partn != null) ? a.partn === b.partn : a.name === b.name
    const list = id.siblings.filter(docked)
    if (!list.some(p => same(p, id.self))) list.push(id.self)
    return list
}

/** Whether the drive holds more than one ext4 partition (null: unknown). */
export const isSharedDrive = (id: HardwareIdentity): boolean | null => {
    const s = dockedSiblings(id)
    return s ? s.length > 1 : null
}

/**
 * Whether this is the drive's primary partition: the lowest-numbered ext4
 * partition (null: unknown). Partition numbers come from the table, so this does
 * not change on replug or rename.
 */
export const isPrimaryPartition = (id: HardwareIdentity): boolean | null => {
    const s = dockedSiblings(id)
    if (!s || id.self.partn == null) return null
    const nums = s.map(p => p.partn).filter((n): n is number => n != null)
    return nums.length === 0 ? null : id.self.partn === Math.min(...nums)
}

/** The id a partition gets when it has no (valid) META id. */
export const hardwareDiskId = (id: HardwareIdentity): DiskID => {
    if (isSharedDrive(id) === true) {
        const pid = partitionDiskId(id.serial, id.self)
        if (pid) return pid
        log(`Drive ${id.serial} has several ext4 partitions but ${id.self.name} has no PARTUUID or number; using the serial`)
    }
    return id.serial as DiskID
}

/**
 * Decide the diskId of a partition whose drive has a hardware serial.
 * meta: the current META.yaml claim, or null for a disk without META.yaml.
 */
export const resolveHardwareDiskId = (meta: MetaIdClaim | null, id: HardwareIdentity): IdResolution => {
    const fresh = hardwareDiskId(id)
    if (!meta || meta.diskId == null || String(meta.diskId) === '') {
        return { diskId: fresh, isHardwareId: true, decision: 'new' }
    }
    const current = String(meta.diskId)
    const own = partitionDiskId(id.serial, id.self)
    if (own && current === own) {
        return { diskId: own, isHardwareId: true, decision: 'keep-partition' }
    }
    if (current === id.serial) {
        const primary = isPrimaryPartition(id)
        const shared = isSharedDrive(id)
        // Unknown layout: keep (never re-key on missing information)
        if (primary === null || shared === null || primary || !shared) {
            return { diskId: meta.diskId, isHardwareId: meta.isHardwareId ?? true, decision: 'keep-legacy' }
        }
        if (own) return { diskId: own, isHardwareId: true, decision: 'migrate-legacy' }
        return { diskId: meta.diskId, isHardwareId: meta.isHardwareId ?? true, decision: 'keep-legacy' }
    }
    if (meta.isHardwareId !== true) {
        return { diskId: meta.diskId, isHardwareId: false, decision: 'keep-assigned' }
    }
    return { diskId: fresh, isHardwareId: true, decision: 'clone' }
}

// ── Facts from the running system ────────────────────────────────────────────

export interface PartitionFactsDeps {
    lsblkJson: (wholeDevice: string) => Promise<string>
    readSysfs: (path: string) => Promise<string>
}

const defaultFactsDeps: PartitionFactsDeps = {
    // lsblk reads PARTUUID/FSTYPE from the udev database: no root needed
    lsblkJson: async (whole) => (await $`lsblk -J -o NAME,TYPE,PARTUUID,FSTYPE /dev/${whole}`).stdout,
    readSysfs: async (p) => (await $`cat ${p}`).stdout,
}

const partnFromName = (name: string): number | null => {
    const m = name.match(/(?:p)?(\d+)$/)
    return m && stripPartition(name) !== name ? parseInt(m[1], 10) : null
}

/**
 * Read this partition and its siblings: lsblk for PARTUUID/FSTYPE, sysfs
 * /sys/class/block/<part>/partition for the number (name suffix as fallback).
 * self is null when the device is not a partition of a block device we can read.
 */
export const readPartitionFacts = async (device: DeviceName, deps: Partial<PartitionFactsDeps> = {}): Promise<{ self: PartitionFacts | null, siblings: PartitionFacts[] | null }> => {
    const d = { ...defaultFactsDeps, ...deps }
    const whole = stripPartition(device)
    if (whole === device) return { self: null, siblings: null }
    try {
        const parsed = JSON.parse(await d.lsblkJson(whole))
        const flat: any[] = []
        const walk = (n: any) => { flat.push(n); (n.children ?? []).forEach(walk) }
        ;(parsed.blockdevices ?? []).forEach(walk)
        const parts: PartitionFacts[] = []
        for (const n of flat.filter(n => n.type === 'part')) {
            let partn: number | null = null
            try {
                const v = parseInt((await d.readSysfs(`/sys/class/block/${n.name}/partition`)).trim(), 10)
                partn = Number.isFinite(v) ? v : null
            } catch { /* fall back to the name */ }
            if (partn == null) partn = partnFromName(n.name)
            parts.push({ name: n.name, partn, partuuid: n.partuuid || null, fstype: n.fstype || null })
        }
        const self = parts.find(p => p.name === device) ?? null
        return { self, siblings: self ? parts : null }
    } catch (e) {
        log(`Could not read the partitions of ${whole}: ${e}`)
        return { self: { name: device, partn: partnFromName(device), partuuid: null, fstype: null }, siblings: null }
    }
}
