/**
 * EraseDisk.ts — erase any non-system disk to an empty IDEA disk (idea#134)
 *
 * eraseDisk <targetId> <summaryTraceId> <confirmName…>
 * Uses a fakeable script runner for tests. Never formats the fleet test stick
 * in automated tests — success paths inject runEraseScript.
 *
 * Loop-backed duration slots (device idea-test-N under IDEA_DISKS_ROOT): erase
 * goes through idea-app-data erase-slot (umount + mkfs.ext4 on the loop/image +
 * remount). Production USB (/dev/sdX) still uses idea-erase-disk unchanged.
 */

import os from 'os'
import path from 'path'
import { $, chalk, fs, YAML } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { Disk, diskMountRoot, processDisk, createOrUpdateDisk } from './Disk.js'
import { localEngineId, EraseInProgress } from './Engine.js'
import { DiskID, EngineID, Timestamp } from './CommonTypes.js'
import { resourceLock, diskKey, instanceKey } from '../utils/ResourceLock.js'
import { remountInstance, optedInInstances, ENGINE_STATE_DIR } from './FilesMount.js'
import { shouldHoldFilesRemount } from './FilesMount.js'
import { ContentSummary, readSummaryFromTrace, resolveSummaryTarget } from './SummariseDisk.js'
import { refreshUnformattedDisks } from './UnformattedDisks.js'
import { isSystemDevice, driveNameOf, bareDevice } from './SystemDisk.js'
import { log, print, uuid } from '../utils/utils.js'
import { disksRoot } from './Config.js'
import { APP_DATA_HELPER, eraseSlotArgs } from '../utils/appDataHelper.js'

/** Same pattern as TEST_DEVICE_PATTERN in usbDeviceMonitor (avoid a circular import). */
export const SLOT_ERASE_DEVICE_PATTERN = /^idea-test-[0-9]+$/
/** True when erase should use the loop-slot helper path, not idea-erase-disk. */
export const isSlotEraseDevice = (device: string | null | undefined): boolean =>
    !!device && SLOT_ERASE_DEVICE_PATTERN.test(device)

export const ERASE_SCRIPT = '/usr/local/sbin/idea-erase-disk'
export const ERASE_STAGING_ROOT = path.join(ENGINE_STATE_DIR, 'erase-staging')
export const IDEA_DISK_LABEL = 'IDEA Disk'
/** How long eraseDisk waits for the erased disk to be republished as empty after the add. */
export const ERASE_REPUBLISH_WAIT_MS = 20_000

/** Devices currently locked for erase; addDevice skips these. */
const lockedDevices = new Set<string>()
export const isEraseDeviceLocked = (device: string): boolean => lockedDevices.has(device)
/**
 * The addDevice guard (usbDeviceMonitor): a device, or its whole drive, that an erase holds is not
 * mounted by udev / chokidar adds while it is being repartitioned.
 */
export const eraseLockRefusesAdd = (device: string): boolean =>
    isEraseDeviceLocked(device) || isEraseDeviceLocked(driveNameOf(device.replace(/^\/dev\/(engine\/)?/, '')))
export const eraseLockedDevicesForTests = (): Set<string> => lockedDevices

/**
 * Partition adds that the erase lock refused, per locked drive (idea01 2026-10-16, trace 93de80a4:
 * "Device sda1 is locked for erase — addDevice skipped" twice, nothing re-added sda1, and the erase
 * failed with "did not come back as empty"). When the lock is released, eraseDisk adds these again.
 */
const skippedAdds = new Map<string, Set<string>>()
const bareName = (device: string): string => device.replace(/^\/dev\/(engine\/)?/, '')
/** Called by the addDevice guard when it refuses an add: remember the partition for the re-add. */
export const noteEraseSkippedAdd = (device: string): void => {
    const name = bareName(device)
    const whole = isEraseDeviceLocked(name) ? name : driveNameOf(name)
    if (!isEraseDeviceLocked(whole) || name === whole) return
    let set = skippedAdds.get(whole)
    if (!set) { set = new Set(); skippedAdds.set(whole, set) }
    set.add(name)
}
/** Release the erase lock on a drive; returns (and forgets) the partition adds it refused. */
export const releaseEraseLock = (whole: string): string[] => {
    lockedDevices.delete(whole)
    const skipped = [...(skippedAdds.get(whole) ?? [])]
    skippedAdds.delete(whole)
    return skipped
}
export const eraseSkippedAddsForTests = (): Map<string, Set<string>> => skippedAdds

/** A partition of this drive by name: sda → sda1, sda2 (not sdaa1); mmcblk0 / nvme0n1 → p1. */
export const isPartitionOfDrive = (whole: string, device: string): boolean =>
    device !== whole && device.startsWith(whole) && /^p?[0-9]+$/.test(device.slice(whole.length))

export interface EraseScriptArgs {
    device: string       // /dev/sdX
    serial: string       // or "-"
    sizeBytes: number
    label: string
    stagingDir: string
}

export interface EraseSlotArgs {
    slot: string         // idea-test-N
    stagingDir: string
}

export interface EraseOps {
    runScript: (args: EraseScriptArgs) => Promise<{ stdout: string }>
    /** TEST-ONLY loop slot: sudo -n idea-app-data erase-slot <slot> <stagingDir> */
    runSlotErase: (args: EraseSlotArgs) => Promise<{ stdout: string }>
    udevadmSettle: () => Promise<void>
    composeDownV: (instanceDir: string) => Promise<void>
    lsblkSizeSerial: (wholeDevice: string) => Promise<{ sizeBytes: number; serial: string | null }>
    addDevice: (devicePath: string) => Promise<void>
    /** mountpoint -q; injectable so tests can simulate a still-mounted refusal */
    isMountPoint: (mp: string) => Promise<boolean>
    /** Mounted partitions of a whole device as [partition, mountpoint] (findmnt); injectable for tests */
    mountedPartitions: (wholeDevice: string) => Promise<{ partition: string; mountpoint: string }[]>
    /**
     * Partitions in the on-disk partition table that the kernel does not show
     * (root helper `idea-erase-disk --check-table`, read-only). Throws when the
     * table can't be checked. Injectable for tests.
     */
    hiddenTablePartitions: (wholeDevice: string) => Promise<HiddenPartition[]>
    /** Partitions of a whole device the kernel shows now (/sys/block/<whole>); injectable for tests */
    presentPartitions: (wholeDevice: string) => Promise<string[]>
}

export interface HiddenPartition { partition: string; name: string | null }

/** Parse `idea-erase-disk --check-table` output: lines "hidden: sda1 start=..., name=\"X\"". */
export const parseHiddenPartitions = (stdout: string): HiddenPartition[] => {
    const res: HiddenPartition[] = []
    for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^hidden:\s+(\S+)(.*)$/)
        if (!m) continue
        const name = m[2].match(/name="([^"]*)"/)?.[1] ?? null
        res.push({ partition: m[1], name: name || null })
    }
    return res
}

export const hiddenPartitionsMessage = (label: string, whole: string, hidden: HiddenPartition[]): string =>
    `${label} is on /dev/${whole}, whose partition table also has ` +
    `${hidden.map(h => h.name ? `${h.partition} ("${h.name}")` : h.partition).join(', ')}, ` +
    `which this Pi does not show (not in lsblk). Erasing wipes the whole disk, so nothing was erased. ` +
    `Unplug the disk and plug it in again, then check it.`

const defaultOps: EraseOps = {
    runScript: async (a) => {
        const out = await $`sudo -n ${ERASE_SCRIPT} ${a.device} ${a.serial} ${String(a.sizeBytes)} ${a.label} ${a.stagingDir}`
        return { stdout: out.stdout }
    },
    runSlotErase: async (a) => {
        const argv = eraseSlotArgs(a.slot, a.stagingDir)
        const out = await $`sudo -n ${APP_DATA_HELPER} ${argv[0]} ${argv[1]} ${argv[2]}`
        return { stdout: out.stdout }
    },
    udevadmSettle: async () => { await $`udevadm settle` },
    composeDownV: async (instanceDir) => {
        await $({ cwd: instanceDir, nothrow: true })`docker compose down -v`
    },
    lsblkSizeSerial: async (whole) => {
        const size = (await $`lsblk -dn -b -o SIZE /dev/${whole}`.nothrow()).stdout.trim()
        const serial = (await $`lsblk -dn -o SERIAL /dev/${whole}`.nothrow()).stdout.trim()
        return { sizeBytes: parseInt(size, 10) || 0, serial: serial || null }
    },
    addDevice: async () => { /* wired from usb monitor at runtime */ },
    isMountPoint: async (mp) => (await $`mountpoint -q ${mp}`.nothrow()).exitCode === 0,
    mountedPartitions: async (whole) => {
        const out = (await $`findmnt -rn -o SOURCE,TARGET`.nothrow()).stdout
        const res: { partition: string; mountpoint: string }[] = []
        for (const line of out.split('\n')) {
            const [src, target] = line.trim().split(/\s+/)
            if (!src?.startsWith('/dev/') || !target) continue
            const part = bareDevice(src)
            if (part !== whole && driveNameOf(part) === whole) res.push({ partition: part, mountpoint: target.replace(/\\x20/g, ' ') })
        }
        return res
    },
    hiddenTablePartitions: async (whole) => {
        const out = await $`sudo -n ${ERASE_SCRIPT} --check-table /dev/${whole}`.nothrow()
        if (out.exitCode !== 0) {
            throw new Error((out.stderr || out.stdout).trim() || `exit ${out.exitCode}`)
        }
        return parseHiddenPartitions(out.stdout)
    },
    presentPartitions: async (whole) => {
        const entries = await fs.readdir(`/sys/block/${whole}`).catch(() => [] as string[])
        return entries.filter(e => isPartitionOfDrive(whole, e)).sort()
    },
}

let ops = defaultOps
let addDeviceImpl: ((path: string) => Promise<void>) | null = null

export const setEraseOpsForTests = (o: Partial<EraseOps> | null): void => {
    ops = o ? { ...defaultOps, ...o } : defaultOps
}
/** Wire the live addDevice from enableUsbDeviceMonitor. */
export const setEraseAddDevice = (fn: ((path: string) => Promise<void>) | null): void => {
    addDeviceImpl = fn
}
let forgetDeviceImpl: ((device: string) => void) | null = null
/**
 * Wire the usb monitor's "forget what you know about this device" (its cached META look). The
 * erase rewrote the partition, so a look cached before the erase must not decide the re-add.
 */
export const setEraseForgetDevice = (fn: ((device: string) => void) | null): void => {
    forgetDeviceImpl = fn
}

const setEraseStep = (storeHandle: DocHandle<Store>, step: EraseInProgress['step'], targetId: string, label: string) => {
    storeHandle.change(doc => {
        const eng = doc.engineDB[localEngineId]
        if (eng) eng.eraseInProgress = { targetId, label, step }
    })
}

const clearEraseProgress = (storeHandle: DocHandle<Store>) => {
    storeHandle.change(doc => {
        const eng = doc.engineDB[localEngineId]
        if (eng) eng.eraseInProgress = null
    })
}

export const clearStaleEraseStaging = async (): Promise<void> => {
    try {
        if (!(await fs.pathExists(ERASE_STAGING_ROOT))) return
        const ids = await fs.readdir(ERASE_STAGING_ROOT)
        for (const id of ids) {
            await fs.remove(path.join(ERASE_STAGING_ROOT, id))
            log(`Deleted stale erase-staging/${id}`)
        }
    } catch (e: any) {
        log(`Could not clear erase-staging: ${e.message ?? e}`)
    }
}

const wholeDeviceOf = (device: string): string => {
    const bare = device.replace(/^\/dev\//, '')
    return driveNameOf(bare)
}

/**
 * Instances that live on ANOTHER disk but hold this disk open: a Files Disk
 * bind-mounted through filesMounts (e.g. Nextcloud /files), or an app volume
 * whose host path is under this disk's mount root. A running container keeps
 * the block device busy, so wipefs fails with "Device or resource busy" and the
 * fallback fails too. Erase refuses up front and names them instead.
 * (Could be extended to stop them first if preferred.)
 */
/** Host paths of bind volumes in an instance's compose.yaml (absolute paths only). */
export const composeVolumeHostPaths = async (store: Store, inst: { id: string; storedOn?: any }): Promise<string[]> => {
    try {
        const home = inst.storedOn ? store.diskDB[inst.storedOn as DiskID] : null
        if (!home?.device) return []
        const file = path.join(await diskMountRoot(home), 'instances', inst.id, 'compose.yaml')
        const doc = YAML.parse(await fs.readFile(file, 'utf8')) ?? {}
        const out: string[] = []
        for (const svc of Object.values<any>(doc.services ?? {})) {
            for (const v of svc?.volumes ?? []) {
                const src = typeof v === 'string' ? v.split(':')[0] : v?.source
                if (typeof src === 'string' && src.startsWith('/')) out.push(path.normalize(src))
            }
        }
        return out
    } catch {
        return []
    }
}

export const instancesUsingDisk = async (
    store: Store,
    disk: Disk,
    volumeHostPaths: (store: Store, inst: any) => Promise<string[]> = composeVolumeHostPaths,
): Promise<{ id: string; name: string; via: 'filesMounts' | 'volume' }[]> => {
    const out: { id: string; name: string; via: 'filesMounts' | 'volume' }[] = []
    const mp = disk.device ? `${disksRoot()}/${disk.device}` : null
    for (const inst of Object.values(store.instanceDB)) {
        if (inst.storedOn === disk.id) continue // removed by the erase itself
        const status = String(inst.status ?? '')
        if (['Stopped', 'Undocked', 'Docked', 'Missing'].includes(status)) continue
        if ((inst.filesMounts ?? []).includes(disk.id)) {
            out.push({ id: inst.id, name: String(inst.name ?? inst.id), via: 'filesMounts' })
            continue
        }
        if (mp) {
            const paths = await volumeHostPaths(store, inst)
            if (paths.some(p => p === mp || p.startsWith(mp + '/'))) {
                out.push({ id: inst.id, name: String(inst.name ?? inst.id), via: 'volume' })
            }
        }
    }
    return out
}

export const instancesUsingDiskMessage = (label: string, users: { name: string; via: string }[]): string =>
    `${label} is in use by ${users.map(u => `${u.name} (${u.via === 'filesMounts' ? 'Files mount' : 'app volume'})`).join(', ')}. ` +
    `Stop ${users.length === 1 ? 'that instance' : 'those instances'} or remove the Files mount first; nothing was erased.`

/**
 * Blockers: running backup, held instance lock, Nextcloud first-start/upgrade,
 * another erase in progress. Returns an error message or null.
 */
export const eraseBlocker = async (store: Store, disk: Disk | null): Promise<string | null> => {
    const eng = store.engineDB[localEngineId]
    if (eng?.eraseInProgress) return `try again later: an erase is already in progress (${eng.eraseInProgress.label})`
    if (!disk) return null
    // Running backup to/from this disk
    for (const op of Object.values(store.operationDB ?? {})) {
        if ((op.status === 'Running' || op.status === 'Pending') && op.kind === 'backupApp') {
            const bid = op.args?.backupDiskId
            const iid = op.args?.instanceId
            if (bid === disk.id) return `try again later: a backup is running on this disk`
            const inst = iid ? store.instanceDB[iid as any] : null
            if (inst?.storedOn === disk.id) return `try again later: a backup is running for an instance on this disk`
        }
    }
    if (resourceLock.isLocked(diskKey(disk.id))) return `try again later: the disk is locked`
    for (const inst of Object.values(store.instanceDB)) {
        if (inst.storedOn !== disk.id) continue
        if (resourceLock.isLocked(instanceKey(inst.id))) return `try again later: an instance on this disk is busy`
        if (await shouldHoldFilesRemount(store, inst)) {
            return `try again later: Nextcloud (or an instance) is in first start or an upgrade`
        }
    }
    return null
}

export const eraseDisk = async (
    storeHandle: DocHandle<Store>,
    targetId: string,
    summaryTraceId: string,
    confirmName: string,
): Promise<{ diskId: DiskID; removedInstances: { id: string; name: string; dataBytes: number }[] }> => {
    const store = storeHandle.doc()!
    const eng = store.engineDB[localEngineId]
    if (!eng) throw new Error(`Local Engine not found`)
    if (eng.eraseInProgress) throw new Error(`try again later: an erase is already in progress`)

    const summary = readSummaryFromTrace(store, summaryTraceId, targetId)
    if (!summary) throw new Error(`The summary is missing, for another disk, or older than 10 minutes. Check the disk again.`)
    if (summary.label !== confirmName) throw new Error(`Typed name does not match the disk label '${summary.label}'.`)

    const target = resolveSummaryTarget(store, targetId)
    if (!target) throw new Error(`No disk or unformatted candidate '${targetId}' on this Engine.`)

    let whole: string
    let serial: string
    let sizeBytes: number
    let disk: Disk | null = null
    let keptId: string
    let devicePartition: string | null = null

    if (target.kind === 'disk') {
        disk = target.disk!
        if (!disk.device) throw new Error(`${disk.name} is not docked.`)
        if (await isSystemDevice(disk.device)) throw new Error(`${disk.name} is this Pi's system disk and cannot be erased.`)
        devicePartition = disk.device
        whole = wholeDeviceOf(disk.device)
        if (isSlotEraseDevice(disk.device)) {
            // Loop slots have no /dev/<name> for lsblk; size/serial come from the summary.
            sizeBytes = summary.sizeBytes
            serial = summary.serial ?? '-'
        } else {
            const info = await ops.lsblkSizeSerial(whole)
            sizeBytes = info.sizeBytes
            serial = info.serial ?? summary.serial ?? '-'
            // Summary serial check when both known
            if (summary.serial && info.serial && summary.serial !== info.serial) {
                throw new Error(`The summary is for a different disk (serial mismatch). Check the disk again.`)
            }
        }
        keptId = disk.id
    } else {
        const c = target.candidate!
        whole = c.device
        if (await isSystemDevice(whole)) throw new Error(`${c.label} is this Pi's system disk and cannot be erased.`)
        sizeBytes = c.sizeBytes
        serial = c.serial ?? c.candidateId
        if (summary.serial && summary.serial !== serial && summary.serial !== c.candidateId) {
            throw new Error(`The summary is for a different disk (serial mismatch). Check the disk again.`)
        }
        keptId = c.candidateId
    }

    const blocker = await eraseBlocker(store, disk)
    if (blocker) throw new Error(blocker)

    if (disk) {
        const users = await instancesUsingDisk(storeHandle.doc()!, disk)
        if (users.length > 0) throw new Error(instancesUsingDiskMessage(summary.label, users))
    }

    // Whole-device checks BEFORE any unmount or store change (#188): erase wipes the
    // whole physical disk, so another mounted partition on it (e.g. sdb1 next to sdb2)
    // or the system disk must refuse here, not after the target was undocked.
    if (!isSlotEraseDevice(devicePartition ?? whole)) {
        if (await isSystemDevice(whole)) throw new Error(`${summary.label} is on this Pi's system disk and cannot be erased.`)
        const siblings = (await ops.mountedPartitions(whole)).filter(m => m.partition !== devicePartition)
        if (siblings.length > 0) {
            throw new Error(
                `${summary.label} shares its physical disk (/dev/${whole}) with ${siblings.map(m => `${m.partition} mounted at ${m.mountpoint}`).join(', ')}. ` +
                `Erasing wipes the whole disk, so nothing was erased.`)
        }
        // lsblk/findmnt only see partitions the kernel knows. A partition that is in
        // the on-disk table but missing from /proc/partitions (idea01 sda1,
        // 2026-10-15) would be wiped unseen, so read the table itself. Fail closed.
        let hidden: HiddenPartition[]
        try {
            hidden = await ops.hiddenTablePartitions(whole)
        } catch (e: any) {
            throw new Error(`Could not check the partition table of /dev/${whole} (${e.message ?? e}), so nothing was erased.`)
        }
        if (hidden.length > 0) throw new Error(hiddenPartitionsMessage(summary.label, whole, hidden))
    }

    setEraseStep(storeHandle, 'checking', targetId, summary.label)
    lockedDevices.add(whole)
    const stagingId = keptId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || uuid()
    const stagingDir = path.join(ERASE_STAGING_ROOT, stagingId)
    const removedInstances: { id: string; name: string; dataBytes: number }[] = []
    let undocked = false
    let erased = false

    try {
        setEraseStep(storeHandle, 'stopping and unmounting', targetId, summary.label)

        // A teacher stick on this drive is mounted read-only under /run/idea-usb
        // (idea#193 §3.5): unmount it first; nothing was written, so this is safe.
        {
            const { removeSticksOnDrive } = await import('./UsbSticks.js')
            const gone = await removeSticksOnDrive(storeHandle, whole, 'erase requested')
            if (gone.length) log(`eraseDisk: unmounted USB stick(s) ${gone.join(', ')} before erasing`)
        }

        if (disk) {
            // Recreate other-disk Files mounts without this bind (R1 / §7.3)
            for (const inst of optedInInstances(storeHandle.doc()!)) {
                if (inst.storedOn === disk.id) continue
                await remountInstance(storeHandle, inst.id, { excludeDiskId: disk.id })
            }
            // Stop instances + undock (unmount)
            const instances = Object.values(storeHandle.doc()!.instanceDB).filter(i => i.storedOn === disk!.id)
            for (const inst of instances) {
                const instSummary = summary.instances.find(s => s.id === inst.id)
                removedInstances.push({
                    id: inst.id,
                    name: inst.name as string,
                    dataBytes: instSummary?.dataBytes ?? 0,
                })
                const mountRoot = await diskMountRoot(disk)
                const instanceDir = path.join(mountRoot, 'instances', inst.id)
                try { await ops.composeDownV(instanceDir) } catch (e: any) {
                    log(`compose down -v for ${inst.id}: ${e.message ?? e}`)
                }
            }
            // Capture apps on this disk before undock
            const appIds = new Set<string>()
            try {
                const appsRoot = path.join(await diskMountRoot(disk), 'apps')
                for (const id of await fs.readdir(appsRoot)) appIds.add(id)
            } catch { /* */ }
            for (const inst of instances) appIds.add(inst.instanceOf)

            const { undockDisk } = await import('../monitors/usbDeviceMonitor.js')
            await undockDisk(storeHandle, disk)

            // USB: undock must have unmounted. Loop slots skip umount in testMode;
            // erase-slot does the real umount — do not refuse here for slots.
            const mp = `${disksRoot()}/${devicePartition}`
            const slotErase = isSlotEraseDevice(devicePartition)
            if (!slotErase && await ops.isMountPoint(mp)) {
                await processDisk(storeHandle, disk).catch(() => {})
                throw new Error(`${summary.label} couldn't be unmounted, so nothing was erased.`)
            }
            undocked = true

            // Remove Disk entry and instances/apps from store
            storeHandle.change(doc => {
                for (const inst of instances) delete doc.instanceDB[inst.id]
                for (const appId of appIds) {
                    // Drop app entries that came from this disk (E9)
                    if (doc.appDB[appId as any]) delete doc.appDB[appId as any]
                }
                // Clear backup links pointing at this disk
                for (const d of Object.values(doc.diskDB)) {
                    if (d.backupConfig?.links) {
                        const links = (d.backupConfig.links as any[]).filter((l: any) => {
                            const id = typeof l === 'string' ? l : l?.diskId
                            return id !== disk!.id
                        })
                        if (links.length !== (d.backupConfig.links as any[]).length) {
                            d.backupConfig = { ...d.backupConfig, links } as any
                        }
                    }
                }
                if (doc.diskDB[disk!.id]?.backupConfig) {
                    // The erased disk itself — entry removed below
                }
                delete doc.diskDB[disk!.id]
            })
        }

        // Staging with only META.yaml
        await fs.ensureDir(stagingDir)
        const meta = {
            diskId: keptId,
            diskName: IDEA_DISK_LABEL,
            isHardwareId: false,
            created: Date.now(),
            version: '1.0',
        }
        await fs.writeFile(path.join(stagingDir, 'META.yaml'), YAML.stringify(meta))

        const slotErase = isSlotEraseDevice(devicePartition ?? whole)
        setEraseStep(storeHandle, slotErase ? 'creating filesystem' : 'partitioning', targetId, summary.label)
        let scriptOut: { stdout: string }
        if (slotErase) {
            try {
                scriptOut = await ops.runSlotErase({
                    slot: devicePartition ?? whole,
                    stagingDir,
                })
            } catch (e) {
                const mp = `${disksRoot()}/${devicePartition ?? whole}`
                if (await ops.isMountPoint(mp)) {
                    throw new Error(`${summary.label} couldn't be unmounted, so nothing was erased.`)
                }
                throw e
            }
        } else {
            scriptOut = await ops.runScript({
                device: `/dev/${whole}`,
                serial: serial || '-',
                sizeBytes,
                label: IDEA_DISK_LABEL,
                stagingDir,
            })
        }
        erased = true
        // Parse STEP markers into eraseInProgress
        for (const line of scriptOut.stdout.split('\n')) {
            if (line.startsWith('STEP:')) {
                const step = line.slice(5).trim()
                if (step === 'creating filesystem') setEraseStep(storeHandle, 'creating filesystem', targetId, summary.label)
                else if (step === 'mounting') setEraseStep(storeHandle, 'mounting', targetId, summary.label)
                else if (step === 'partitioning') setEraseStep(storeHandle, 'partitioning', targetId, summary.label)
                else if (step === 'unmounting') setEraseStep(storeHandle, 'stopping and unmounting', targetId, summary.label)
            }
        }

        setEraseStep(storeHandle, 'mounting', targetId, summary.label)
        if (!slotErase) await ops.udevadmSettle()
        // USB: partition is whole+1 (sdb → sdb1). Loop slots keep the slot name.
        const partition = slotErase ? (devicePartition ?? whole) : `${whole}1`
        // Engine mounts via addDevice (testMode slots: fixture already remounted by erase-slot)
        const add = addDeviceImpl ?? ops.addDevice
        // The repartitioning is done: release the erase lock BEFORE the post-erase add. While the lock
        // was held, addDevice refused both this add and the udev add event of the new partition
        // ("Device sdb1 is locked for erase — addDevice skipped"). The disk then never came back, and
        // the erase failed with "did not come back as empty" (wizardly-hugle 2026-10-12 18:46).
        // The finally below still deletes the lock (idempotent) on every path.
        // udev's own add for the new partition usually arrives while the lock is still held and is
        // refused (idea01 2026-10-16, trace 93de80a4). So on release, add every partition of the
        // drive that was refused, or that the kernel shows now, plus the expected one: each once.
        const skipped = releaseEraseLock(whole)
        const rescan = async (why: string) => {
            const names = new Set<string>([partition])
            if (!slotErase) {
                for (const d of skipped) names.add(d)
                const present = await ops.presentPartitions(whole).catch(() => [] as string[])
                for (const d of present) if (isPartitionOfDrive(whole, d)) names.add(d)
            }
            if (skipped.length) log(`eraseDisk: ${why}: re-adding ${[...names].join(', ')} (refused while locked: ${skipped.join(', ')})`)
            for (const d of names) {
                forgetDeviceImpl?.(d)
                try { await add(`/dev/engine/${d}`) } catch (e: any) { log(`eraseDisk: add of ${d} failed: ${e?.message ?? e}`) }
            }
        }
        await rescan('erase lock released')

        // Wait briefly for the disk to appear as empty
        let published: Disk | undefined
        // A USB first mount can take longer than the old 4 s: wait up to ERASE_REPUBLISH_WAIT_MS.
        const waitSteps = Math.ceil(ERASE_REPUBLISH_WAIT_MS / 200)
        for (let i = 0; i < waitSteps; i++) {
            const s = storeHandle.doc()!
            published = Object.values(s.diskDB).find(d => d.id === keptId && d.dockedTo === localEngineId)
            if (published && published.diskTypes?.includes('empty')) break
            // Halfway and still not docked: rescan the drive once (a late partition, a failed look)
            if (i === Math.floor(waitSteps / 2) && !published) await rescan('disk not back yet, rescanning')
            await new Promise(r => setTimeout(r, 200))
            if (!published && Object.values(s.diskDB).some(d => d.device === partition)) {
                published = Object.values(s.diskDB).find(d => d.device === partition)
                if (published) await processDisk(storeHandle, published)
            }
        }

        await refreshUnformattedDisks(storeHandle).catch(() => {})

        const finalDisk = storeHandle.doc()!.diskDB[keptId as DiskID]
        if (!finalDisk || !finalDisk.diskTypes?.includes('empty')) {
            throw new Error(`Erase finished but the disk did not come back as empty (id ${keptId}).`)
        }

        print(chalk.green(`Erased ${summary.label} → empty IDEA disk ${keptId}`))
        return { diskId: keptId as DiskID, removedInstances }
    } catch (e) {
        // Failed after the target was unmounted but before the erase ran (#188):
        // mount it again and re-register it, so it reappears in the store.
        if (undocked && !erased && devicePartition) {
            try {
                const add = addDeviceImpl ?? ops.addDevice
                await add(`/dev/engine/${devicePartition}`)
                log(`Erase of ${summary.label} failed after unmounting; ${devicePartition} was mounted and registered again`)
            } catch (re: any) {
                log(`Erase of ${summary.label} failed after unmounting and ${devicePartition} could not be mounted again: ${re?.message ?? re}`)
            }
        }
        throw e
    } finally {
        releaseEraseLock(whole)
        clearEraseProgress(storeHandle)
        await fs.remove(stagingDir).catch(() => {})
    }
}
