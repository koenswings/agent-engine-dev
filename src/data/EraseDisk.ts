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
import { isSystemDevice, driveNameOf } from './SystemDisk.js'
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

/** Devices currently locked for erase; addDevice skips these. */
const lockedDevices = new Set<string>()
export const isEraseDeviceLocked = (device: string): boolean => lockedDevices.has(device)
export const eraseLockedDevicesForTests = (): Set<string> => lockedDevices

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
}

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

    setEraseStep(storeHandle, 'checking', targetId, summary.label)
    lockedDevices.add(whole)
    const stagingId = keptId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || uuid()
    const stagingDir = path.join(ERASE_STAGING_ROOT, stagingId)
    const removedInstances: { id: string; name: string; dataBytes: number }[] = []

    try {
        setEraseStep(storeHandle, 'stopping and unmounting', targetId, summary.label)

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
        await add(`/dev/engine/${partition}`)

        // Wait briefly for the disk to appear as empty
        let published: Disk | undefined
        for (let i = 0; i < 20; i++) {
            const s = storeHandle.doc()!
            published = Object.values(s.diskDB).find(d => d.id === keptId && d.dockedTo === localEngineId)
            if (published && published.diskTypes?.includes('empty')) break
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
        throw e
    } finally {
        lockedDevices.delete(whole)
        clearEraseProgress(storeHandle)
        await fs.remove(stagingDir).catch(() => {})
    }
}
