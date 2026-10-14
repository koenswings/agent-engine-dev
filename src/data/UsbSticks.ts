/**
 * UsbSticks.ts: teacher USB sticks, mounted read-only (idea#193, proposals/2026-10-14-teacher-usb-sticks.md)
 *
 *   §3.1 fstype routing: vfat / exfat on a non-system disk → this module; ext4 and
 *        everything else stay on the IDEA disk path (usbDeviceMonitor).
 *   §3.2 mount: /run/idea-usb/<dev>, exactly the typed commands in 11-engine-files:
 *          /usr/bin/mount -t vfat  -o ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8,shortname=mixed /dev/<dev> /run/idea-usb/<dev>
 *          /usr/bin/mount -t exfat -o ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8 /dev/<dev> /run/idea-usb/<dev>
 *          /usr/bin/umount /run/idea-usb/<dev>        (/usr/bin/umount -l … only when busy)
 *        /run/idea-usb itself is created by tmpfiles.d (idea-usb.conf: pi:pi 0755), so the
 *        mount point folders and .idea-usb.json are made and removed by pi without sudo.
 *        Never fsck, never chown, never a write under a stick's mount point.
 *   §3.3 Engine.usbSticks (whole-list replace; written only by this Engine).
 *   §3.4 unplug: store → .idea-usb.json + app sync → umount (lazy if busy) → rmdir.
 *        Startup: unmount and remove leftovers; the watcher's initial adds remount.
 *   §4   x-app.usbMount: one static read-only rslave bind of the whole root
 *        (FilesMount.ts buildOverride) + `docker exec` of the App's sync command
 *        after each plug/unplug and at Engine start (syncUsbApps).
 *   §8.2a kolibri folder → ChannelBuilderAutoStart.ts.
 *
 * All commands sit behind UsbStickOps so tests inject fakes.
 */
import path from 'path'
import { $, fs } from 'zx'
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import type { ChannelBuilderAutoStartResult, UsbStickPublic } from './Engine.js'
import type { Timestamp } from './CommonTypes.js'
import { DEFAULT_USB_ROOT, config, usbRoot } from './Config.js'
import { log } from '../utils/utils.js'
import { driveNameOf } from './SystemDisk.js'
import { mountOps, MountEntry } from '../monitors/mounts.js'

// ── Exact root commands (pinned by test/automated/usb-sticks.test.ts against 11-engine-files) ──

export const STICK_FS_TYPES = ['vfat', 'exfat'] as const
export type StickFsType = typeof STICK_FS_TYPES[number]

export const STICK_MOUNT_OPTIONS: Record<StickFsType, string> = {
    vfat: 'ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8,shortname=mixed',
    exfat: 'ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8',
}
export const SUDO_MOUNT_BIN = '/usr/bin/mount'
export const SUDO_UMOUNT_BIN = '/usr/bin/umount'
/** Devices a stick may be on: partition 1/2 or a whole disk without a partition table. */
export const STICK_DEVICE = /^sd[a-z][12]?$/

export const stickMountArgv = (fsType: StickFsType, device: string, mountPoint: string): string[] =>
    [SUDO_MOUNT_BIN, '-t', fsType, '-o', STICK_MOUNT_OPTIONS[fsType], `/dev/${device}`, mountPoint]
export const stickUmountArgv = (mountPoint: string, lazy = false): string[] =>
    lazy ? [SUDO_UMOUNT_BIN, '-l', mountPoint] : [SUDO_UMOUNT_BIN, mountPoint]

/** The display/contract JSON in the root of /run/idea-usb (seen in Apps as <path>/.idea-usb.json). */
export const IDEA_USB_JSON = '.idea-usb.json'
export const IDEA_USB_JSON_VERSION = 1

export const isStickFsType = (t: string | null | undefined): t is StickFsType =>
    !!t && (STICK_FS_TYPES as readonly string[]).includes(t.toLowerCase())

/** §3.1 routing of one device by its filesystem type. */
export const classifyFsType = (t: string | null | undefined): 'ext4' | 'stick' | 'other' => {
    const v = (t ?? '').toLowerCase()
    if (v === 'ext4') return 'ext4'
    if (isStickFsType(v)) return 'stick'
    return 'other'
}

export const stickMountPoint = (device: string): string => path.join(usbRoot(), device)

// ── Ops ─────────────────────────────────────────────────────────────────────

export interface StickProbe {
    fsType: string | null
    label: string | null
    uuid: string | null
    sizeBytes: number
    model: string | null
}

export interface UsbStickOps {
    /** lsblk -J -b -o NAME,FSTYPE,LABEL,UUID,SIZE,MODEL /dev/<dev> (+ the drive's model) */
    probe(device: string): Promise<StickProbe | null>
    listMounts(): Promise<MountEntry[]>
    isMountPoint(p: string): Promise<boolean>
    /** Run one of the exact sudo commands above (argv without 'sudo') */
    sudo(argv: string[]): Promise<void>
    mkdir(p: string): Promise<void>
    rmdir(p: string): Promise<void>
    /** Top-level entries of a mounted stick (read only) */
    readdir(p: string): Promise<{ name: string, isDirectory: boolean }[]>
    statfs(p: string): Promise<{ sizeBytes: number, usedBytes: number } | null>
    writeFileAtomic(p: string, content: string): Promise<void>
    /** docker exec [-u user] -e K=V … <container> <command> */
    dockerExec(container: string, user: string | null, env: Record<string, string>, command: string): Promise<void>
    now(): number
}

export const defaultUsbStickOps: UsbStickOps = {
    probe: async (device) => {
        const out = await $`lsblk -J -b -o NAME,FSTYPE,LABEL,UUID,SIZE,MODEL /dev/${device}`.nothrow()
        if (out.exitCode !== 0 || !out.stdout.trim()) return null
        const node = (JSON.parse(out.stdout)?.blockdevices ?? [])[0]
        if (!node) return null
        let model: string | null = node.model?.trim() || null
        if (!model && driveNameOf(device) !== device) {
            const m = await $`lsblk -dno MODEL /dev/${driveNameOf(device)}`.nothrow()
            model = m.exitCode === 0 ? (m.stdout.trim() || null) : null
        }
        return {
            fsType: node.fstype ?? null,
            label: node.label?.trim() || null,
            uuid: node.uuid?.trim() || null,
            sizeBytes: Number(node.size) || 0,
            model,
        }
    },
    listMounts: () => mountOps().listMounts(),
    isMountPoint: (p) => mountOps().isMountPoint(p),
    sudo: async (argv) => { await $`sudo -n ${argv}` },
    mkdir: async (p) => { await fs.mkdir(p) },
    rmdir: async (p) => { await fs.rmdir(p) },
    readdir: async (p) => (await fs.readdir(p, { withFileTypes: true })).map(d => ({ name: d.name, isDirectory: d.isDirectory() })),
    statfs: async (p) => {
        try {
            const s = await fs.promises.statfs(p)
            return { sizeBytes: s.blocks * s.bsize, usedBytes: (s.blocks - s.bfree) * s.bsize }
        } catch { return null }
    },
    writeFileAtomic: async (p, content) => {
        const tmp = `${p}.tmp-${process.pid}`
        await fs.writeFile(tmp, content, { mode: 0o644 })
        await fs.rename(tmp, p)
    },
    dockerExec: async (container, user, env, command) => {
        const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
        const userArgs = user ? ['-u', user] : []
        await $`timeout 120 docker exec ${userArgs} ${envArgs} ${container} ${command}`
    },
    now: () => Date.now(),
}

let ops: UsbStickOps = defaultUsbStickOps
export const usbStickOps = (): UsbStickOps => ops
/** Tests: replace some or all ops; null restores the real commands. */
export const setUsbStickOpsForTests = (o: Partial<UsbStickOps> | null): void => {
    ops = o ? { ...defaultUsbStickOps, ...o } : defaultUsbStickOps
}
/** Real commands only outside testMode, or when a test injected fakes (like mountCommandsActive). */
export const usbStickRoutingActive = (): boolean => !config.settings.testMode || ops !== defaultUsbStickOps

// ── State ───────────────────────────────────────────────────────────────────

interface StickRecord extends UsbStickPublic {
    uuid: string | null
    mountPoint: string
    kolibriFolder: string | null
}

const sticks = new Map<string, StickRecord>()   // device → record
/** Tests only. */
export const resetUsbSticksForTests = (): void => { sticks.clear(); syncChain = Promise.resolve() }
export const mountedSticks = (): UsbStickPublic[] => [...sticks.values()].map(toPublic)
export const stickOnDevice = (device: string): UsbStickPublic | undefined => {
    const r = sticks.get(device); return r ? toPublic(r) : undefined
}

const toPublic = (r: StickRecord): UsbStickPublic => ({
    stickId: r.stickId, device: r.device, label: r.label, displayName: r.displayName,
    fsType: r.fsType, sizeBytes: r.sizeBytes, usedBytes: r.usedBytes, mountedAt: r.mountedAt,
    readOnly: true, hasKolibriFolder: r.hasKolibriFolder, builderAutoStart: r.builderAutoStart,
})

export const stickIdFor = (uuid: string | null, device: string): string =>
    uuid ? `usb-${uuid}` : `usb-nouuid-${device}`

export const stickLabel = (p: Pick<StickProbe, 'label' | 'model'>): string =>
    p.label || p.model || 'USB stick'

/** 'USB: <label>', ' (2)', ' (3)' … for clashes with sticks already mounted on this Engine. */
export const uniqueDisplayName = (label: string, taken: string[]): string => {
    const base = `USB: ${label}`
    if (!taken.includes(base)) return base
    for (let n = 2; ; n++) if (!taken.includes(`${base} (${n})`)) return `${base} (${n})`
}

/** Name of the top-level kolibri folder (any case), or null. Read only. */
export const findKolibriFolder = (entries: { name: string, isDirectory: boolean }[]): string | null =>
    entries.find(e => e.isDirectory && e.name.toLowerCase() === 'kolibri')?.name ?? null

// ── Store + JSON ────────────────────────────────────────────────────────────

const engineIdOf = async (): Promise<string> => (await import('./Engine.js')).localEngineId

const publishToStore = async (storeHandle: DocHandle<Store>): Promise<void> => {
    const id = await engineIdOf()
    const list = mountedSticks()
    storeHandle.change(doc => {
        const eng = doc.engineDB[id as any]
        if (eng) eng.usbSticks = list
    })
}

/** The .idea-usb.json Apps read (Kid's contract, see docs/USB-STICKS.md). */
export const buildUsbJson = (engineId: string, updatedAt: number, records: Array<UsbStickPublic & { uuid: string | null, kolibriFolder: string | null }>) => ({
    version: IDEA_USB_JSON_VERSION,
    engineId,
    updatedAt,
    sticks: records.map(r => ({
        stickId: r.stickId,
        uuid: r.uuid,
        device: r.device,
        dir: r.device,
        label: r.label,
        displayName: r.displayName,
        fsType: r.fsType,
        sizeBytes: r.sizeBytes,
        usedBytes: r.usedBytes,
        mountedAt: r.mountedAt,
        readOnly: true,
        hasKolibriFolder: r.hasKolibriFolder,
        kolibriFolder: r.kolibriFolder,
    })),
})

/**
 * Make sure the USB root exists without needing a restart. tmpfiles.d
 * (install-root-helpers) normally creates /run/idea-usb as pi:pi 0755; when the
 * Engine runs before that, it creates the folder itself if the parent lets it
 * (parent exists and is writable by this user, e.g. pi-owned 0755). Otherwise it
 * returns false and is retried on the next plug and the next JSON write/sync.
 * A non-default root (tests, dev) whose parent is missing is created recursively.
 */
let rootMissingLogged = false
export const ensureUsbRoot = async (): Promise<boolean> => {
    const root = usbRoot()
    if (await fs.pathExists(root)) { rootMissingLogged = false; return true }
    const parent = path.dirname(root)
    try {
        if (root !== DEFAULT_USB_ROOT && !(await fs.pathExists(parent))) {
            await fs.ensureDir(root)
        } else {
            await fs.access(parent, fs.constants.W_OK | fs.constants.X_OK)
            await fs.mkdir(root, { mode: 0o755 })
            await fs.chmod(root, 0o755)   // umask-independent
        }
        log(`USB sticks: created ${root}`)
        rootMissingLogged = false
        return true
    } catch (e: any) {
        if (e?.code === 'EEXIST') return true
        if (!rootMissingLogged) {
            log(`USB sticks: ${root} is missing and ${parent} does not let the Engine create it (${e?.code ?? e?.message ?? e}); tmpfiles.d idea-usb.conf not installed? Will retry on the next plug/sync; Ops: run install-root-helpers`)
            rootMissingLogged = true
        }
        return false
    }
}

const writeUsbJson = async (): Promise<void> => {
    const root = usbRoot()
    if (!(await ensureUsbRoot())) return
    const json = buildUsbJson(await engineIdOf(), ops.now(), [...sticks.values()])
    try {
        await ops.writeFileAtomic(path.join(root, IDEA_USB_JSON), JSON.stringify(json, null, 2) + '\n')
    } catch (e: any) {
        log(`USB sticks: could not write ${path.join(root, IDEA_USB_JSON)}: ${e?.message ?? e}`)
    }
}

// ── App sync (x-app.usbMount.sync) ─────────────────────────────────────────

export type UsbSyncEvent = 'plug' | 'unplug' | 'start'

let syncChain: Promise<void> = Promise.resolve()

/**
 * Run each Running opted-in App's sync command (x-app.usbMount.sync) once, one
 * at a time. A failure is logged and retried once after SYNC_RETRY_MS; the next
 * plug/unplug reconciles again anyway.
 */
export const SYNC_RETRY_MS = 15_000
export const syncUsbApps = (storeHandle: DocHandle<Store>, event: UsbSyncEvent, retry = true, onlyInstanceId?: string): Promise<void> => {
    syncChain = syncChain.then(() => runSync(storeHandle, event, retry, onlyInstanceId)).catch(() => {})
    return syncChain
}

const runSync = async (storeHandle: DocHandle<Store>, event: UsbSyncEvent, retry: boolean, onlyInstanceId?: string): Promise<void> => {
    const store = storeHandle.doc()
    if (!store) return
    const engineId = await engineIdOf()
    for (const inst of Object.values(store.instanceDB ?? {})) {
        if (inst.status !== 'Running') continue
        if (onlyInstanceId && String(inst.id) !== String(onlyInstanceId)) continue
        const disk = inst.storedOn ? store.diskDB[inst.storedOn] : null
        if (!disk || disk.dockedTo !== engineId) continue
        const um = store.appDB[inst.instanceOf]?.usbMount
        if (!um?.sync) continue
        const container = `${inst.id}-${um.sync.service}-1`
        const env = {
            IDEA_USB_EVENT: event,
            IDEA_USB_ROOT: um.path,
            IDEA_USB_JSON: `${um.path.replace(/\/$/, '')}/${IDEA_USB_JSON}`,
        }
        try {
            await ops.dockerExec(container, um.sync.user, env, um.sync.command)
            log(`USB sticks: ${um.sync.command} in ${container} (${event}) ok`)
        } catch (e: any) {
            log(`USB sticks: ${um.sync.command} in ${container} (${event}) failed: ${e?.message ?? e}`)
            if (retry) setTimeout(() => { void syncUsbApps(storeHandle, event, false, onlyInstanceId) }, SYNC_RETRY_MS).unref?.()
        }
    }
}

// ── Plug ────────────────────────────────────────────────────────────────────

export type StickAddResult =
    | { ok: true, stick: UsbStickPublic, alreadyMounted: boolean }
    | { ok: false, message: string }

/**
 * Mount a FAT/exFAT stick read-only and publish it. The caller (usbDeviceMonitor)
 * has already checked: valid device, not erase-locked, not a system device,
 * classifyFsType(probe.fsType) === 'stick'.
 */
export const addStick = async (
    storeHandle: DocHandle<Store>,
    device: string,
    probe: StickProbe,
    opts: { autoStart?: boolean } = {},
): Promise<StickAddResult> => {
    if (!STICK_DEVICE.test(device)) return { ok: false, message: `Refusing to mount ${device} as a USB stick: not an sdX/sdXN device` }
    const fsType = (probe.fsType ?? '').toLowerCase()
    if (!isStickFsType(fsType)) return { ok: false, message: `Refusing to mount ${device} as a USB stick: filesystem ${probe.fsType}` }
    const mp = stickMountPoint(device)
    if (usbRoot() === DEFAULT_USB_ROOT && path.dirname(mp) !== DEFAULT_USB_ROOT) return { ok: false, message: `bad mount point ${mp}` }
    if (!(await ensureUsbRoot())) return { ok: false, message: `Cannot mount USB stick /dev/${device}: ${usbRoot()} is missing and could not be created (run install-root-helpers)` }
    const mounts = await ops.listMounts()
    const atTarget = mounts.filter(m => m.target === mp)
    const ofSource = mounts.filter(m => m.source === `/dev/${device}`)
    let alreadyMounted = false
    if (atTarget.length) {
        if (!atTarget.every(m => m.source === `/dev/${device}`)) return { ok: false, message: `Refusing to mount /dev/${device}: ${mp} is already a mount point` }
        alreadyMounted = true
    } else if (ofSource.length) {
        return { ok: false, message: `Refusing to mount /dev/${device} on ${mp}: it is already mounted on ${ofSource.map(m => m.target).join(', ')}` }
    } else if (await ops.isMountPoint(mp)) {
        return { ok: false, message: `Refusing to mount /dev/${device}: ${mp} is already a mount point` }
    }
    if (!alreadyMounted) {
        try {
            if (!(await fs.pathExists(mp))) await ops.mkdir(mp)
            await ops.sudo(stickMountArgv(fsType, device, mp))
        } catch (e: any) {
            try { if (!(await ops.isMountPoint(mp))) await ops.rmdir(mp) } catch { /* */ }
            return { ok: false, message: `Could not mount USB stick /dev/${device} read-only on ${mp}: ${e?.stderr?.trim() || e?.message || e}` }
        }
    }
    let kolibriFolder: string | null = null
    try { kolibriFolder = findKolibriFolder(await ops.readdir(mp)) } catch (e: any) { log(`USB stick ${device}: could not list ${mp}: ${e?.message ?? e}`) }
    const fs_ = await ops.statfs(mp)
    const label = stickLabel(probe)
    const taken = [...sticks.values()].filter(s => s.device !== device).map(s => s.displayName)
    const record: StickRecord = {
        stickId: stickIdFor(probe.uuid, device),
        device,
        label,
        displayName: uniqueDisplayName(label, taken),
        fsType,
        sizeBytes: fs_?.sizeBytes ?? probe.sizeBytes,
        usedBytes: fs_?.usedBytes ?? 0,
        mountedAt: ops.now() as Timestamp,
        readOnly: true,
        hasKolibriFolder: !!kolibriFolder,
        builderAutoStart: null,
        uuid: probe.uuid,
        mountPoint: mp,
        kolibriFolder,
    }
    sticks.set(device, record)
    log(`USB stick ${record.displayName} (${fsType}, ${record.stickId}) mounted read-only on ${mp}${kolibriFolder ? `; has a '${kolibriFolder}' folder` : ''}`)
    await publishToStore(storeHandle)
    await writeUsbJson()
    void syncUsbApps(storeHandle, 'plug')
    if (kolibriFolder && opts.autoStart !== false) {
        const { autoStartChannelBuilderForStick } = await import('./ChannelBuilderAutoStart.js')
        const result = await autoStartChannelBuilderForStick(storeHandle, toPublic(record))
        await setBuilderAutoStart(storeHandle, device, result)
    }
    return { ok: true, stick: toPublic(sticks.get(device) ?? record), alreadyMounted }
}

const setBuilderAutoStart = async (storeHandle: DocHandle<Store>, device: string, result: ChannelBuilderAutoStartResult): Promise<void> => {
    const r = sticks.get(device)
    if (!r) return
    r.builderAutoStart = result
    await publishToStore(storeHandle)
}

// ── Unplug / cleanup ────────────────────────────────────────────────────────

/** Unmount a stick mount point: umount, `umount -l` only if busy; then rmdir. */
export const unmountStickPath = async (mp: string): Promise<{ ok: boolean, lazy: boolean, message?: string }> => {
    let lazy = false
    if (await ops.isMountPoint(mp)) {
        try {
            await ops.sudo(stickUmountArgv(mp))
        } catch (e: any) {
            // Read-only: nothing to flush, so a lazy unmount is safe (§3.4)
            log(`USB stick: umount ${mp} failed (${e?.stderr?.trim() || e?.message || e}); lazy unmount`)
            try { await ops.sudo(stickUmountArgv(mp, true)); lazy = true } catch (e2: any) {
                return { ok: false, lazy: true, message: `Could not unmount ${mp}: ${e2?.stderr?.trim() || e2?.message || e2}` }
            }
        }
    }
    try {
        if (await ops.isMountPoint(mp)) return { ok: false, lazy, message: `${mp} is still a mount point` }
        await ops.rmdir(mp)
    } catch (e: any) {
        if (e?.code !== 'ENOENT') return { ok: false, lazy, message: `Unmounted, but could not remove ${mp}: ${e?.message ?? e}` }
    }
    return { ok: true, lazy }
}

/** §3.4: store → JSON + app sync → umount → rmdir. Returns false when no stick was on the device. */
export const removeStick = async (storeHandle: DocHandle<Store>, device: string, reason = 'unplugged'): Promise<boolean> => {
    const r = sticks.get(device)
    if (!r) return false
    sticks.delete(device)
    log(`USB stick ${r.displayName} on ${device} ${reason}: removing`)
    await publishToStore(storeHandle)
    await writeUsbJson()
    await syncUsbApps(storeHandle, 'unplug')
    const res = await unmountStickPath(r.mountPoint)
    if (!res.ok) log(`USB stick ${device}: ${res.message}`)
    return true
}

/** All sticks on a whole drive (erase / whole-disk unplug). Returns the devices removed. */
export const removeSticksOnDrive = async (storeHandle: DocHandle<Store>, drive: string, reason: string): Promise<string[]> => {
    const devs = [...sticks.keys()].filter(d => driveNameOf(d) === drive || d === drive)
    for (const d of devs) await removeStick(storeHandle, d, reason)
    return devs
}

/**
 * Startup (§3.4): forget every stick, unmount anything still mounted under the
 * USB root, remove the empty folders, write an empty JSON and clear
 * Engine.usbSticks. The watcher's initial add events mount present sticks again.
 */
export const usbStartupCleanup = async (storeHandle: DocHandle<Store>): Promise<void> => {
    sticks.clear()
    const root = usbRoot()
    await ensureUsbRoot()
    try {
        const mounts = (await ops.listMounts()).filter(m => path.dirname(m.target) === root)
        for (const m of mounts) {
            const res = await unmountStickPath(m.target)
            log(`USB sticks startup: ${m.target} ${res.ok ? 'unmounted and removed' : res.message}`)
        }
        if (await fs.pathExists(root)) {
            for (const name of await fs.readdir(root)) {
                const p = path.join(root, name)
                if (!STICK_DEVICE.test(name) || mounts.some(m => m.target === p)) continue
                try { if (!(await ops.isMountPoint(p))) await ops.rmdir(p) } catch (e: any) { log(`USB sticks startup: could not remove ${p}: ${e?.message ?? e}`) }
            }
        }
    } catch (e: any) {
        log(`USB sticks startup cleanup: ${e?.message ?? e}`)
    }
    await publishToStore(storeHandle)
    await writeUsbJson()   // retries creating the root
}

