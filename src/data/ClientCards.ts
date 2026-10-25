/**
 * ClientCards.ts — new disks, card readers and client cards (idea#201 §10, contract v2)
 *
 * Read-only view of every whole disk on this Engine that is NOT an IDEA disk:
 *   Engine.cardReaders  every removable USB mass-storage device (a card reader), with or without a medium
 *   Engine.clientCards  removable media present now (the only Flash targets)
 *   Engine.newDisks     non-removable disks without IDEA META (the Initialise targets);
 *                       a removable card is never in newDisks (contract v2 decision 6)
 * Nothing here mounts or writes anything (rule 1): the view comes from lsblk, sysfs and
 * /dev/disk/by-id only. IDEA disks (any partition docked in diskDB on this Engine) and the
 * system drive are never listed.
 *
 * Ids: a non-removable new disk uses the unformattedDisks candidateId (one id space,
 * decision 5). A card uses 'card-' + sha1(reader serial, size, PTUUID): it changes when the
 * medium is swapped, which the reader serial alone would not.
 */
import crypto from 'crypto'
import { $, fs } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { EngineID, Timestamp } from './CommonTypes.js'
import { isSystemDevice } from './SystemDisk.js'
import { LsblkDevice, candidateIdFor, isSdCardMedium } from './UnformattedDisks.js'
import { localEngineId } from './Engine.js'
import { log } from '../utils/utils.js'

export type CandidateID = string
export type ReaderID = string
export type ClientImageVersion = string

export type CardContents =
    | { kind: 'idea-client'; imageName: string; version: ClientImageVersion | null }
    | { kind: 'raspios' }
    | { kind: 'ubuntu' }
    | { kind: 'empty' }
    | { kind: 'other'; summary: string }
    | { kind: 'unknown' }

export interface NewDiskPartition { label: string | null; fsType: string | null; sizeBytes: number }

export interface NewDisk {
    candidateId: CandidateID
    device: string
    byId: string
    sizeBytes: number
    model: string | null
    serial: string | null
    removable: boolean
    readerId: ReaderID | null
    partitions: NewDiskPartition[]
    contents: CardContents
    mountedReadOnly: boolean
    firstSeen: Timestamp
}

export interface CardReader {
    id: ReaderID
    name: string
    usbPath: string
    hasMedium: boolean
    candidateId: CandidateID | null
}

/** Refusal codes (contract §5) a card can carry before any command is sent. */
export type FlashRefusal = 'MOUNTED' | 'IN_USE_BY_APP' | 'BUSY' | 'NOT_REMOVABLE' | 'HELPER_MISSING' | 'SYSTEM_DISK' | 'HAS_IDEA_META'

export interface ClientCard {
    candidateId: CandidateID
    sizeBytes: number
    model: string | null
    readerId: ReaderID | null
    contents: CardContents
    flashable: boolean
    refusal: FlashRefusal | null
}

/** Internal scan result: the published shapes plus what the commands need (device, by-id, partitions). */
export interface ScannedCard extends ClientCard {
    device: string
    byId: string | null
    ptuuid: string | null
    serial: string | null
    partitionNames: string[]
    /** ext4 partitions (idea#303: looked at for an OS rootfs layout before a flash) */
    ext4PartitionNames: string[]
    mountpoints: string[]
}

/** idea#303: what a physical non-IDEA disk can become. */
export type DiskAction = 'initialise' | 'erase' | 'flash'
export type DiskCandidateKind = 'usbDisk' | 'sdCard'

/** idea#303: one entry per physical non-IDEA disk, with the actions it allows (Engine.diskCandidates). */
export interface DiskCandidate {
    candidateId: CandidateID
    kind: DiskCandidateKind
    device: string
    sizeBytes: number
    model: string | null
    serial: string | null
    removable: boolean
    readerId: ReaderID | null
    partitions: NewDiskPartition[]
    contents: CardContents
    actions: DiskAction[]
    flashRefusal: FlashRefusal | null
    mountedReadOnly: boolean
    firstSeen: Timestamp
}

export interface ScanResult {
    diskCandidates?: DiskCandidate[]
    /** candidateId → partition device names, in the order of NewDisk.partitions (internal) */
    newDiskPartitions?: Record<string, string[]>
    newDisks: NewDisk[]
    cardReaders: CardReader[]
    clientCards: ScannedCard[]
}

export interface CardLsblkDevice extends LsblkDevice {
    label?: string | null
    rm?: boolean | string | number | null
    tran?: string | null
    mountpoint?: string | null
    mountpoints?: (string | null)[] | null
    ptuuid?: string | null
    vendor?: string | null
    children?: CardLsblkDevice[]
}

export interface ClientCardOps {
    lsblkJson: () => Promise<CardLsblkDevice[]>
    /** /dev/disk/by-id whole-disk links → target device name (sdX) */
    byIdLinks: () => Promise<{ link: string; device: string }[]>
    /** realpath of /sys/block/<dev> (USB topology) */
    sysfsPath: (device: string) => Promise<string | null>
    isSystemDevice: (device: string) => Promise<boolean>
    /** Devices (partitions or whole disks) of IDEA disks docked on this Engine */
    dockedDevices: (store: Store | undefined, engineId: string) => Set<string>
    now: () => number
}

const defaultOps: ClientCardOps = {
    lsblkJson: async () => {
        const out = await $`lsblk -J -b -o NAME,TYPE,FSTYPE,SIZE,MODEL,VENDOR,SERIAL,LABEL,RM,TRAN,MOUNTPOINT,PTUUID`.nothrow()
        if (out.exitCode !== 0 || !out.stdout.trim()) return []
        return (JSON.parse(out.stdout) as { blockdevices?: CardLsblkDevice[] }).blockdevices ?? []
    },
    byIdLinks: async () => {
        const dir = '/dev/disk/by-id'
        let names: string[] = []
        try { names = await fs.readdir(dir) } catch { return [] }
        const out: { link: string; device: string }[] = []
        for (const n of names) {
            if (/-part\d+$/.test(n)) continue
            try {
                const target = await fs.realpath(`${dir}/${n}`)
                out.push({ link: `${dir}/${n}`, device: target.replace(/^\/dev\//, '') })
            } catch { /* dangling */ }
        }
        return out
    },
    sysfsPath: async (device) => { try { return await fs.realpath(`/sys/block/${device}`) } catch { return null } },
    isSystemDevice: (d) => isSystemDevice(d),
    dockedDevices: (store, engineId) => {
        const s = new Set<string>()
        for (const d of Object.values(store?.diskDB ?? {}) as any[]) {
            if (d && String(d.dockedTo) === engineId && d.device) s.add(String(d.device))
        }
        return s
    },
    now: () => Date.now(),
}

let ops: ClientCardOps = defaultOps
export const setClientCardOpsForTests = (o: Partial<ClientCardOps> | null): void => {
    ops = o ? { ...defaultOps, ...o } : defaultOps
}

const firstSeenByKey = new Map<string, number>()
export const clearClientCardStateForTests = (): void => { firstSeenByKey.clear() }

const sha16 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
const num = (v: unknown): number => typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10) || 0
const isRemovable = (d: CardLsblkDevice): boolean => d.rm === true || d.rm === 1 || d.rm === '1' || d.rm === 'true'
const clean = (v: string | null | undefined): string | null => (v ?? '').trim() || null
const mountsOf = (d: CardLsblkDevice): string[] => {
    const own = [d.mountpoint, ...(d.mountpoints ?? [])].filter((m): m is string => !!m)
    return [...new Set([...own, ...(d.children ?? []).flatMap(mountsOf)])]
}

/** "1-1.2" from /sys/devices/platform/.../usb1/1-1/1-1.2/1-1.2:1.0/host0/... */
export const usbPathOf = (sysfs: string | null): string => {
    if (!sysfs) return ''
    const segs = sysfs.split('/').filter(s => /^\d+-[\d.]+$/.test(s))
    return segs[segs.length - 1] ?? ''
}

/** Read-only classification from partition labels and types (no mount, contract §1). */
export const classifyContents = (parts: NewDiskPartition[], wholeFsType: string | null): CardContents => {
    if (parts.length === 0) {
        if (!wholeFsType) return { kind: 'empty' }
        return { kind: 'other', summary: `whole disk ${wholeFsType}` }
    }
    const labels = parts.map(p => (p.label ?? '').toLowerCase())
    const idea = parts.find(p => /^idea-client/i.test(p.label ?? ''))
    if (idea) {
        const m = /^idea-client[-_]?(.+)?$/i.exec(idea.label ?? '')
        return { kind: 'idea-client', imageName: idea.label ?? 'IDEA client', version: m?.[1] ?? null }
    }
    if (labels.includes('bootfs') && labels.includes('rootfs')) return { kind: 'raspios' }
    if (labels.includes('system-boot') && labels.includes('writable')) return { kind: 'ubuntu' }
    if (parts.every(p => !p.fsType)) return { kind: 'unknown' }
    const summary = parts.map(p => `${p.fsType ?? 'unknown'}${p.label ? ` '${p.label}'` : ''}`).join(', ')
    return { kind: 'other', summary }
}

/**
 * Scan this Engine's whole sd* disks. `busy` = a flash/erase/initialise runs here (cards
 * then carry BUSY); `helperInstalled` false → HELPER_MISSING.
 */
export const scanClientCards = async (
    store: Store | undefined,
    engineId: string,
    opts: { busy?: boolean; helperInstalled?: boolean } = {},
): Promise<ScanResult> => {
    const devices = await ops.lsblkJson()
    const links = await ops.byIdLinks()
    const docked = ops.dockedDevices(store, engineId)
    const now = ops.now()
    const res: ScanResult = { newDisks: [], cardReaders: [], clientCards: [], newDiskPartitions: {}, diskCandidates: [] }
    const present = new Set<string>()

    for (const d of devices) {
        if ((d.type ?? 'disk') !== 'disk' || !/^sd[a-z]$/.test(d.name)) continue
        if (await ops.isSystemDevice(d.name)) continue
        const children = (d.children ?? []).filter(c => (c.type ?? 'part') === 'part')
        // An IDEA disk (any partition, or the whole disk, docked here) is never listed
        if (docked.has(d.name) || children.some(c => docked.has(c.name))) continue

        const removable = isRemovable(d)
        const sizeBytes = num(d.size)
        const model = clean(d.model)
        const serial = clean(d.serial)
        const byId = links.filter(l => l.device === d.name).map(l => l.link).sort((a, b) => {
            // prefer usb-* links (what the helper accepts)
            const ua = a.includes('/usb-') ? 0 : 1, ub = b.includes('/usb-') ? 0 : 1
            return ua - ub || a.localeCompare(b)
        })[0] ?? null
        const partitions: NewDiskPartition[] = children.map(c => ({ label: clean(c.label), fsType: clean(c.fstype), sizeBytes: num(c.size) }))
        const contents = classifyContents(partitions, clean(d.fstype))
        const mounts = mountsOf(d)

        let readerId: ReaderID | null = null
        if (removable && (d.tran ?? 'usb') === 'usb' && isSdCardMedium(d)) {
            const usbPath = usbPathOf(await ops.sysfsPath(d.name))
            readerId = sha16(`${usbPath || d.name}|${serial ?? ''}`)
            const hasMedium = sizeBytes > 0
            const name = [clean(d.vendor), model].filter(Boolean).join(' ') || 'Card reader'
            const candidateId = hasMedium ? `card-${sha16(`${serial ?? d.name}|${sizeBytes}|${clean(d.ptuuid) ?? ''}`)}` : null
            res.cardReaders.push({ id: readerId, name, usbPath, hasMedium, candidateId })
            if (!hasMedium) continue
            present.add(candidateId!)
            if (!firstSeenByKey.has(candidateId!)) firstSeenByKey.set(candidateId!, now)
            let refusal: FlashRefusal | null = null
            if (opts.helperInstalled === false) refusal = 'HELPER_MISSING'
            else if (mounts.length > 0) refusal = 'MOUNTED'
            else if (opts.busy) refusal = 'BUSY'
            res.clientCards.push({
                candidateId: candidateId!, sizeBytes, model, readerId, contents,
                flashable: refusal === null, refusal,
                device: d.name, byId, ptuuid: clean(d.ptuuid), serial,
                partitionNames: children.map(c => c.name), ext4PartitionNames: children.filter(c => c.fstype === 'ext4').map(c => c.name), mountpoints: mounts,
            })
            res.diskCandidates!.push({
                candidateId: candidateId!, kind: 'sdCard', device: d.name, sizeBytes, model, serial, removable: true, readerId,
                partitions, contents, actions: ['flash'], flashRefusal: refusal, mountedReadOnly: false,
                firstSeen: firstSeenByKey.get(candidateId!)! as Timestamp,
            })
            continue
        }
        if (removable && (d.tran ?? 'usb') !== 'usb') {
            // Removable but not on USB (e.g. a native SD slot that is not the system disk): a card without a reader entry
            const candidateId = `card-${sha16(`${serial ?? d.name}|${sizeBytes}|${clean(d.ptuuid) ?? ''}`)}`
            if (sizeBytes <= 0) continue
            present.add(candidateId)
            if (!firstSeenByKey.has(candidateId)) firstSeenByKey.set(candidateId, now)
            const refusal: FlashRefusal | null = opts.helperInstalled === false ? 'HELPER_MISSING' : mounts.length ? 'MOUNTED' : opts.busy ? 'BUSY' : null
            res.clientCards.push({
                candidateId, sizeBytes, model, readerId: null, contents, flashable: refusal === null, refusal,
                device: d.name, byId, ptuuid: clean(d.ptuuid), serial, partitionNames: children.map(c => c.name), ext4PartitionNames: children.filter(c => c.fstype === 'ext4').map(c => c.name), mountpoints: mounts,
            })
            res.diskCandidates!.push({
                candidateId, kind: 'sdCard', device: d.name, sizeBytes, model, serial, removable: true, readerId: null,
                partitions, contents, actions: ['flash'], flashRefusal: refusal, mountedReadOnly: false,
                firstSeen: firstSeenByKey.get(candidateId)! as Timestamp,
            })
            continue
        }
        // idea#303: a USB disk (stick, SSD or HDD, whatever its rm flag) or a non-USB disk.
        // Both IDEA-disk roles and, on USB with a usb-* by-id link, the client-image role.
        if (sizeBytes <= 0) continue
        const { candidateId, serial: idSerial } = await candidateIdFor(d.name, serial)
        present.add(candidateId)
        if (!firstSeenByKey.has(candidateId)) firstSeenByKey.set(candidateId, now)
        const firstSeen = firstSeenByKey.get(candidateId)! as Timestamp
        const mountedReadOnly = mounts.length > 0 && mounts.every(m => m.startsWith('/run/idea-usb'))
        res.newDiskPartitions![candidateId] = children.map(c => c.name)
        res.newDisks.push({
            candidateId, device: d.name, byId: byId ?? '', sizeBytes, model, serial: idSerial,
            removable, readerId: null, partitions, contents, mountedReadOnly, firstSeen,
        })
        const anyExt4 = clean(d.fstype) === 'ext4' || children.some(c => clean(c.fstype) === 'ext4')
        const actions: DiskAction[] = []
        if (children.some(c => clean(c.fstype) === 'ext4' && /^sd[a-z][12]$/.test(c.name))) actions.push('initialise')
        if (!anyExt4) actions.push('erase')
        let flashRefusal: FlashRefusal | null = null
        if ((d.tran ?? 'usb') === 'usb' && byId && byId.startsWith('/dev/disk/by-id/usb-')) {
            actions.push('flash')
            flashRefusal = opts.helperInstalled === false ? 'HELPER_MISSING' : mounts.length ? 'MOUNTED' : opts.busy ? 'BUSY' : null
            res.clientCards.push({
                candidateId, sizeBytes, model, readerId: null, contents, flashable: flashRefusal === null, refusal: flashRefusal,
                device: d.name, byId, ptuuid: clean(d.ptuuid), serial, partitionNames: children.map(c => c.name), ext4PartitionNames: children.filter(c => c.fstype === 'ext4').map(c => c.name), mountpoints: mounts,
            })
        }
        res.diskCandidates!.push({
            candidateId, kind: 'usbDisk', device: d.name, sizeBytes, model, serial: idSerial, removable, readerId: null,
            partitions, contents, actions, flashRefusal, mountedReadOnly, firstSeen,
        })
    }
    for (const k of [...firstSeenByKey.keys()]) if (!present.has(k)) firstSeenByKey.delete(k)
    return res
}

/** Last scan, for the commands (device / by-id never travel in a command). */
let lastScan: ScanResult = { newDisks: [], cardReaders: [], clientCards: [] }
export const lastClientCardScan = (): ScanResult => lastScan

let busyProbe: () => boolean = () => false
let helperProbe: () => boolean = () => true
export const setClientCardProbes = (p: { busy?: () => boolean; helperInstalled?: () => boolean }): void => {
    if (p.busy) busyProbe = p.busy
    if (p.helperInstalled) helperProbe = p.helperInstalled
}

const publicCard = (c: ScannedCard): ClientCard => ({
    candidateId: c.candidateId, sizeBytes: c.sizeBytes, model: c.model, readerId: c.readerId,
    contents: c.contents, flashable: c.flashable, refusal: c.refusal,
})

const fingerprint = (r: ScanResult): string => JSON.stringify([r.newDisks, r.cardReaders, r.clientCards.map(publicCard), r.diskCandidates ?? []])
let lastWritten = ''

/**
 * Rescan and write Engine.newDisks / cardReaders / clientCards (whole-list replace, only on change).
 * Refreshes run one at a time and read the busy probe when they start: a poll scan that began
 * during a flash used to finish after the flash's own end-of-flash refresh and write its BUSY
 * last, leaving a stale BUSY hint on the card (idea#201).
 */
let refreshChain: Promise<unknown> = Promise.resolve()
export const refreshClientCards = (
    storeHandle: DocHandle<Store>,
    engineId: EngineID = localEngineId as EngineID,
): Promise<ScanResult> => {
    const run = refreshChain.then(() => refreshClientCardsNow(storeHandle, engineId))
    refreshChain = run.catch(() => {})
    return run
}
const refreshClientCardsNow = async (
    storeHandle: DocHandle<Store>,
    engineId: EngineID,
): Promise<ScanResult> => {
    const scan = await scanClientCards(storeHandle.doc(), String(engineId), { busy: busyProbe(), helperInstalled: helperProbe() })
    lastScan = scan
    const fp = fingerprint(scan)
    const eng = storeHandle.doc()?.engineDB?.[engineId]
    if (fp === lastWritten && eng?.clientCards !== undefined) return scan
    lastWritten = fp
    storeHandle.change(doc => {
        const e = doc.engineDB[engineId]
        if (!e) return
        e.newDisks = JSON.parse(JSON.stringify(scan.newDisks))
        e.cardReaders = JSON.parse(JSON.stringify(scan.cardReaders))
        e.clientCards = scan.clientCards.map(publicCard)
        e.diskCandidates = JSON.parse(JSON.stringify(scan.diskCandidates ?? []))
    })
    log(`Client cards: ${scan.clientCards.map(c => `${c.device}(${c.candidateId}${c.refusal ? ' ' + c.refusal : ''})`).join(', ') || '(none)'}; ` +
        `new disks: ${scan.newDisks.map(d => d.device).join(', ') || '(none)'}; readers: ${scan.cardReaders.length}`)
    return scan
}

export const resetClientCardWriteCacheForTests = (): void => { refreshChain = Promise.resolve(); lastWritten = ''; lastScan = { newDisks: [], cardReaders: [], clientCards: [] } }

/** Media changes in a reader send no add event for the whole disk: poll lsblk (cheap, write only on change). */
export const CLIENT_CARD_POLL_MS = 5_000
export const startClientCardPoll = (storeHandle: DocHandle<Store>): (() => void) => {
    let running = false
    const t = setInterval(() => {
        if (running) return
        running = true
        refreshClientCards(storeHandle).catch(e => log(`client card poll: ${e}`)).finally(() => { running = false })
    }, CLIENT_CARD_POLL_MS)
    return () => clearInterval(t)
}
