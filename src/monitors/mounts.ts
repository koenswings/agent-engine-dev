/**
 * mounts.ts — mounting and unmounting App Disk partitions safely (idea#126)
 *
 * Files Disk step 0, Q5 safety fix:
 *   - "Already mounted" is detected with findmnt (it reads /proc/self/mountinfo)
 *     by target AND by source, so it works for every filesystem type. Before
 *     this, `mount -t ext4` output was searched, which missed vfat partitions:
 *     after an Engine restart a docked vfat partition was mounted a second time
 *     on top of itself (Atlas, idea03).
 *   - Mounting onto a target that is already a mount point is refused.
 *   - Unmounting repeats `umount` until `mountpoint -q` says the target is no
 *     longer a mount point (a stacked double mount needs one umount per layer),
 *     then removes the empty folder with rmdir. Never `rm -fr`: rmdir only
 *     removes an empty folder, so a still-mounted disk's data cannot be deleted.
 *   - The filesystem UUID is recorded at mount time (lsblk -no UUID) for
 *     Disk.unmountError and the startup cleanup.
 *
 * Root commands: mkdir, mount and umount are in 10-engine; rmdir of
 * /disks/sd[a-z][12] is in 11-engine-files. findmnt, mountpoint and lsblk need no
 * root. The commands are behind MountOps so tests can inject fakes.
 */

import { $, fs, sleep } from 'zx'
import { log } from '../utils/utils.js'
import { disksRoot } from '../data/Config.js'
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from '../data/Store.js'
import type { Disk } from '../data/Disk.js'
import type { DiskID, EngineID } from '../data/CommonTypes.js'

export interface MountEntry {
    source: string   // e.g. /dev/sdb1 (bind-mount suffixes like [/dir] removed)
    target: string   // e.g. /disks/sdb1
    fstype: string
}

export interface MountOps {
    /** Every mount on the system: `findmnt -J -l -o SOURCE,TARGET,FSTYPE` */
    listMounts(): Promise<MountEntry[]>
    /** `mountpoint -q <path>`: true only when the path is a mount point */
    isMountPoint(path: string): Promise<boolean>
    /** Filesystem UUID of a device: `lsblk -no UUID /dev/<device>`, null if unknown */
    fsUuidOfDevice(device: string): Promise<string | null>
    /** UUID of the filesystem mounted at a path: `findmnt -no UUID <path>`, null if none */
    fsUuidAt(mountPoint: string): Promise<string | null>
    /** `sudo mkdir -p <disksRoot>/<device>` */
    mkdir(device: string): Promise<void>
    /** `sudo mount /dev/<device> <disksRoot>/<device>` */
    mount(device: string): Promise<void>
    /** `sudo umount <disksRoot>/<device>` (removes the top mount only) */
    umount(device: string): Promise<void>
    /** Remove the empty mount point folder (see removeMountPointFolder) */
    rmdir(mountPoint: string): Promise<void>
}

/** Mount points the 11-engine-files entry `/usr/bin/rmdir /disks/sd[a-z][12]` covers. */
export const SUDO_RMDIR_PATH = /^\/disks\/sd[a-z][12]$/
export const SUDO_RMDIR = '/usr/bin/rmdir'

/**
 * Remove an empty mount point folder. /disks/sd[a-z][12] folders are created
 * with sudo under the root-owned /disks, so they are removed with exactly
 * `sudo /usr/bin/rmdir /disks/<device>` (11-engine-files). Other roots (test and
 * fixture roots from IDEA_DISKS_ROOT) are owned by pi and use a plain rmdir.
 * Both fail on a folder that is not empty.
 */
export const removeMountPointFolder = async (mountPoint: string): Promise<void> => {
    if (SUDO_RMDIR_PATH.test(mountPoint)) {
        await $`sudo ${SUDO_RMDIR} ${mountPoint}`
    } else {
        await fs.rmdir(mountPoint)
    }
}

const stripBindSuffix = (source: string): string => source.replace(/\[.*\]$/, '')

export const defaultMountOps: MountOps = {
    listMounts: async () => {
        const out = await $`findmnt -J -l -o SOURCE,TARGET,FSTYPE`.nothrow()
        if (out.exitCode !== 0 || !out.stdout.trim()) return []
        const parsed = JSON.parse(out.stdout) as { filesystems?: Array<{ source?: string, target?: string, fstype?: string }> }
        return (parsed.filesystems ?? []).map(f => ({
            source: stripBindSuffix(f.source ?? ''),
            target: f.target ?? '',
            fstype: f.fstype ?? '',
        }))
    },
    isMountPoint: async (path) => (await $`mountpoint -q ${path}`.nothrow()).exitCode === 0,
    fsUuidOfDevice: async (device) => {
        const out = await $`lsblk -no UUID /dev/${device}`.nothrow()
        const uuid = out.exitCode === 0 ? out.stdout.trim().split('\n')[0].trim() : ''
        return uuid || null
    },
    fsUuidAt: async (mountPoint) => {
        const out = await $`findmnt -no UUID ${mountPoint}`.nothrow()
        if (out.exitCode !== 0) return null
        // A stacked mount lists one line per layer: the last one is on top
        const lines = out.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        return lines.length ? lines[lines.length - 1] : null
    },
    mkdir: async (device) => { await $`sudo mkdir -p ${disksRoot()}/${device}` },
    mount: async (device) => { await $`sudo mount /dev/${device} ${disksRoot()}/${device}` },
    umount: async (device) => { await $`sudo umount ${disksRoot()}/${device}` },
    rmdir: removeMountPointFolder,
}

let currentOps: MountOps = defaultMountOps

/** The MountOps in use (the real commands unless a test injected fakes). */
export const mountOps = (): MountOps => currentOps

/** Tests: replace some or all MountOps; pass null to restore the real commands. */
export const setMountOps = (ops: Partial<MountOps> | null): void => {
    currentOps = ops ? { ...defaultMountOps, ...ops } : defaultMountOps
}

/**
 * Whether mount commands really run. testMode skips the real (sudo) commands
 * because fixture disks are plain folders; a test that injects MountOps runs the
 * full mount/unmount logic against its fakes.
 */
export const mountCommandsActive = (testMode: boolean): boolean => !testMode || currentOps !== defaultMountOps

export const mountPointOf = (device: string): string => `${disksRoot()}/${device}`

// ── Mounting ────────────────────────────────────────────────────────────────

export type MountCheck =
    | { state: 'free' }                                  // nothing there: mount
    | { state: 'mounted' }                               // this device is already mounted at its target
    | { state: 'targetBusy', mounts: MountEntry[] }      // something else is mounted at the target
    | { state: 'deviceElsewhere', mounts: MountEntry[] } // this device is mounted somewhere else

/**
 * Check, before mounting, what findmnt says about the device and its target.
 * Looks at both the target and the source, for every filesystem type.
 */
export const checkMountState = async (device: string, ops: MountOps = mountOps()): Promise<MountCheck> => {
    const target = mountPointOf(device)
    const source = `/dev/${device}`
    const mounts = await ops.listMounts()
    const atTarget = mounts.filter(m => m.target === target)
    const ofSource = mounts.filter(m => m.source === source)
    if (atTarget.length > 0) {
        return atTarget.every(m => m.source === source)
            ? { state: 'mounted' }
            : { state: 'targetBusy', mounts: atTarget }
    }
    if (ofSource.length > 0) return { state: 'deviceElsewhere', mounts: ofSource }
    // Not in the mount table, but still a mount point (e.g. a bind mount findmnt
    // shows with another source path): refuse as well.
    if (await ops.isMountPoint(target)) return { state: 'targetBusy', mounts: [] }
    return { state: 'free' }
}

export type MountResult =
    | { ok: true, alreadyMounted: boolean, fsUuid: string | null }
    | { ok: false, message: string }

/**
 * Mount /dev/<device> on <disksRoot>/<device> unless it is already mounted there.
 * Never mounts a second time and never mounts onto an existing mount point.
 * Returns the filesystem UUID (lsblk -no UUID) for Disk.unmountError.
 */
export const safeMount = async (device: string, ops: MountOps = mountOps()): Promise<MountResult> => {
    const target = mountPointOf(device)
    const check = await checkMountState(device, ops)
    const describe = (ms: MountEntry[]) => ms.map(m => `${m.source} on ${m.target} (${m.fstype})`).join(', ')
    if (check.state === 'targetBusy') {
        return { ok: false, message: `Refusing to mount /dev/${device}: ${target} is already a mount point${check.mounts.length ? ` (${describe(check.mounts)})` : ''}` }
    }
    if (check.state === 'deviceElsewhere') {
        return { ok: false, message: `Refusing to mount /dev/${device} on ${target}: it is already mounted (${describe(check.mounts)})` }
    }
    const alreadyMounted = check.state === 'mounted'
    if (alreadyMounted) {
        log(`Device ${device} already mounted on ${target}`)
    } else {
        try {
            await ops.mkdir(device)
            await ops.mount(device)
        } catch (e) {
            return { ok: false, message: `Could not mount /dev/${device} on ${target}: ${e instanceof Error ? e.message : String(e)}` }
        }
    }
    const fsUuid = await ops.fsUuidOfDevice(device).catch(() => null)
    return { ok: true, alreadyMounted, fsUuid }
}

// ── Unmounting ──────────────────────────────────────────────────────────────

/**
 * Unmount retry policy (idea#126, documented in docs/ARCHITECTURE.md):
 * at most UMOUNT_MAX_ATTEMPTS umount calls per undock, with UMOUNT_RETRY_DELAY_MS
 * between a failed attempt and the next one. Every successful umount removes
 * one layer of a stacked mount, so 5 attempts cover a double mount plus three
 * busy retries (about 3 s) for a process that is just letting go of the disk.
 */
export const UMOUNT_MAX_ATTEMPTS = 5
export const UMOUNT_RETRY_DELAY_MS = 1000

export type UnmountResult =
    | { ok: true, attempts: number, removed: boolean }
    | { ok: false, attempts: number, message: string }

/**
 * Repeat `umount` until `mountpoint -q <mountPoint>` is false, then rmdir the
 * mount point. If it is still a mount point after UMOUNT_MAX_ATTEMPTS, nothing
 * is removed and the result says why. Never rm -fr.
 */
export const unmountAndRemove = async (
    device: string,
    ops: MountOps = mountOps(),
    maxAttempts = UMOUNT_MAX_ATTEMPTS,
    retryDelayMs = UMOUNT_RETRY_DELAY_MS,
): Promise<UnmountResult> => {
    const mountPoint = mountPointOf(device)
    let attempts = 0
    let lastError = ''
    while (await ops.isMountPoint(mountPoint)) {
        if (attempts >= maxAttempts) {
            return {
                ok: false, attempts,
                message: `${mountPoint} is still mounted after ${attempts} umount attempts${lastError ? `: ${lastError}` : ''}`,
            }
        }
        attempts++
        try {
            await ops.umount(device)
            log(`umount ${mountPoint}: attempt ${attempts} removed one mount`)
        } catch (e: any) {
            lastError = (e?.stderr || e?.message || String(e)).toString().trim()
            log(`umount ${mountPoint}: attempt ${attempts} failed: ${lastError}`)
            if (attempts < maxAttempts) await sleep(retryDelayMs)
        }
    }
    if (!(await fs.pathExists(mountPoint))) return { ok: true, attempts, removed: false }
    await ops.rmdir(mountPoint)
    return { ok: true, attempts, removed: true }
}

// ── Startup cleanup ─────────────────────────────────────────────────────────

/**
 * Engine startup (idea#126): clear every Disk.unmountError recorded by this
 * Engine unless the same filesystem is still mounted at its mountPoint.
 *   - mountPoint not mounted (findmnt -no UUID gives nothing) → cleared
 *   - another filesystem mounted there (UUID differs from fsUuid; device names
 *     get reused) → cleared
 *   - the same filesystem still mounted there (same UUID) → kept
 *   - fsUuid unknown (null) and something is still mounted there → kept, since
 *     it cannot be ruled out that it is the same disk
 * Errors recorded by other Engines are never touched.
 * Returns the ids of the disks whose error was cleared.
 */
export const clearStaleUnmountErrors = async (
    storeHandle: DocHandle<Store>,
    engineId: EngineID,
    ops: MountOps = mountOps(),
): Promise<string[]> => {
    const store = storeHandle.doc()
    if (!store) return []
    const toClear: string[] = []
    for (const [diskId, disk] of Object.entries(store.diskDB ?? {})) {
        const err = (disk as Disk).unmountError
        if (!err || err.engineId !== engineId) continue
        const uuidNow = await ops.fsUuidAt(err.mountPoint).catch(() => null)
        const stillSameFs = uuidNow !== null && (err.fsUuid === null || uuidNow === err.fsUuid)
        if (stillSameFs) {
            log(`Keeping the unmount error of disk ${diskId}: ${err.mountPoint} is still mounted (UUID ${uuidNow})`)
        } else {
            toClear.push(diskId)
        }
    }
    if (toClear.length) {
        storeHandle.change(doc => {
            for (const id of toClear) {
                const d = doc.diskDB[id as DiskID]
                if (d && d.unmountError) d.unmountError = null
            }
        })
        log(`Cleared stale unmount errors for disks: ${toClear.join(', ')}`)
    }
    return toClear
}
