import chokidar from 'chokidar'
import { getKeys, log, uuid } from '../utils/utils.js'
import { DiskMeta, readHardwareId, readMetaUpdateId, writeMetaFile } from '../data/Meta.js';
import { $, fs, YAML, chalk } from 'zx'

$.verbose = false;
import { Disk, clearDuplicateDiskRecords, createOrUpdateDisk, isSystemDiskRecord, processDisk } from '../data/Disk.js'
import { findDiskByDevice, findDisksByDevice, Store, getDisksOfEngine, getLocalEngine } from '../data/Store.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../data/CommonTypes.js'

import { Instance, Status, stopInstance } from '../data/Instance.js';
import { config, disksRoot, skipMetaWrite } from '../data/Config.js'
import { DocHandle } from '@automerge/automerge-repo';
import { getCommandLogHandle, addTrace, closeTrace } from '../data/CommandLogStore.js';
import { runWithTrace } from '../utils/CommandLogger.js';
import { recordDiskDetectionFailure, errorMessage } from './diskDetection.js';
import { safeMount, unmountAndRemove, mountCommandsActive, mountOps, mountPointOf } from './mounts.js';

/**
 * Filesystem UUID of each mounted device, recorded at mount time (or when an
 * existing mount is found) with lsblk -no UUID. Used for Disk.unmountError
 * (idea#126).
 */
const mountedFsUuids = new Map<string, string | null>()

/**
 * Pretend disks created by the test harness use names that real hardware never
 * produces (e.g. `idea-test-1`). Only an Engine in testMode accepts them.
 */
export const TEST_DEVICE_PATTERN = /^idea-test-[0-9]+$/
export const isTestDeviceName = (device: string | undefined | null): boolean =>
    !!device && TEST_DEVICE_PATTERN.test(device)

/**
 * Options for the watcher on the udev watch folder (/dev/engine).
 *
 * udev creates /dev/engine/<device> as a symlink to /dev/<device> (root:disk 0660).
 * The Engine runs as pi, which is not in the disk group, so following the links
 * made chokidar put an inotify watch on the block device itself and fail with
 * EACCES (idea#110). With followSymlinks off, chokidar only watches the folder and
 * reports links being added and removed; mounting goes through sudo, so the
 * Engine never needs to open the block device. Do not add pi to the disk group
 * instead: that gives raw read access to every drive.
 */
export const DEVICE_WATCH_OPTIONS = { persistent: true, followSymlinks: false } as const

/** Watch the udev watch folder for device links (see DEVICE_WATCH_OPTIONS). */
export const watchDeviceFolder = (watchDir: string) => chokidar.watch(watchDir, { ...DEVICE_WATCH_OPTIONS })

export const enableUsbDeviceMonitor = async (storeHandle: DocHandle<Store>) => {

    // Detection relies on the udev rule 90-docking.rules (repaired by boot.sh and
    // verified by the startup self-check in diskDetection.ts, idea#82). A fallback
    // watcher (/dev/disk/by-label, dmesg) was ruled out for now: see
    // https://github.com/koenswings/idea/issues/82 and /issues/46.

    const store: Store = storeHandle.doc()
    const localEngine = getLocalEngine(store)

    if (!localEngine) {
        log(`No local engine found in the store`)
        throw new Error(`No local engine found in the store`)
    }

    // Detect the root partition (e.g. sda2) at startup so we can:
    //   - register it as a system disk
    //   - skip the whole-disk parent (e.g. sda) and the boot partition (e.g. sda1)
    // findmnt reads procfs — safe to run in all modes, no sudo needed.
    let systemDevice: DeviceName | null = null
    let systemBootDevice: DeviceName | null = null   // e.g. 'sda1' — the boot partition to skip
    try {
        const rootSource = (await $`findmnt -n -o SOURCE /`).stdout.trim()
        // rootSource is e.g. /dev/sda2 — strip the /dev/ prefix
        const rootDev = rootSource.replace('/dev/', '') as DeviceName
        if (rootDev.match(/^sd[a-z][0-9]+$/)) {
            systemDevice = rootDev
            // Boot partition is parent (strip trailing digits) + '1', e.g. sda2 → sda1
            const parentDev = rootDev.replace(/[0-9]+$/, '')
            systemBootDevice = (parentDev + '1') as DeviceName
            log(`System disk detected: root=${systemDevice}, boot=${systemBootDevice}`)
        }
    } catch (e) {
        log(`Could not detect system device via findmnt: ${e}`)
    }

    const validDevice = function (device: string): boolean {
        // Test-only device names (idea-test-N) are accepted only in testMode.
        // A live Engine (testMode off) ignores them, so a pretend disk can never
        // be picked up and mounted by a live Engine (idea#105).
        if (isTestDeviceName(device)) return config.settings.testMode
        // Check if the device begins with "sd", is then followed by a letter and ends with the number 2
        // We need the m flag - see https://regexr.com/7rvpq 
        return device && (device.match(/^sd[a-z][1-2]$/m) || device.match(/^sd[a-z]$/m)) ? true : false
    }

    const addDevice = async function (path: string) {
        log(`A disk on device ${path} has been added`)
        const device = path.split('/').pop() as DeviceName

        if (validDevice(device)) {
            log(`The disk on device ${device} has a valid device name`)

            // Skip whole-disk entries (e.g. sda, sdb) — raw block devices with no
            // filesystem; never directly mountable.
            if (device.match(/^sd[a-z]$/)) {
                log(`Device ${device} is a whole-disk entry — skipping`)
                return
            }

            // Skip the OS boot partition (e.g. sda1 on most Pis, but derived from
            // the actual root device so it works regardless of disk letter).
            if (systemBootDevice && device === systemBootDevice) {
                log(`Device ${device} is the OS boot partition — skipping`)
                return
            }

            log(`Processing the disk on device ${device}`)
            try {
                // System disk (root partition): already mounted at /, no mount needed.
                // Read identity from /META.yaml and register as a system disk.
                // Skip if IDEA_SYSTEM_DISK_SKIP=true (used by Kit's test harness to avoid
                // conflicts when a second engine runs alongside the production instance).
                if (systemDevice && device === systemDevice) {
                    if (config.settings.systemDiskSkip) {
                        log(`Device ${device} is the system disk — skipping registration (IDEA_SYSTEM_DISK_SKIP=true)`)
                        return
                    }
                    log(`Device ${device} is the system disk (root partition) — registering as system disk`)
                    try {
                        const meta = await readMetaUpdateId()  // reads /META.yaml, no device arg
                        const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, 'System Disk' as DiskName, meta.created)
                        // The marker the Console gates eject on, set with the device (idea#152)
                        storeHandle.change(doc => {
                            const d = doc.diskDB[disk.id]
                            if (d) d.diskTypes = ['system']
                        })
                        await processDisk(storeHandle, disk)
                    } catch (e) {
                        log(`Error processing system disk: ${e}`)
                        recordDiskDetectionFailure('readMeta', `Could not read /META.yaml of the system disk on ${device}: ${errorMessage(e)}`, { device })
                    }
                    return
                }

                if (!mountCommandsActive(config.settings.testMode)) {
                    log(`testMode: skipping mount for device ${device} — fixture expected at ${disksRoot()}/${device}`)
                } else {
                    // findmnt-based check by target and source, for every filesystem
                    // type; never mounts twice or onto an existing mount point (idea#126)
                    const result = await safeMount(device)
                    if (!result.ok) {
                        recordDiskDetectionFailure('mount', result.message, { device })
                        return
                    }
                    mountedFsUuids.set(device, result.fsUuid)
                    log(result.alreadyMounted ? `Device ${device} already mounted` : `Device ${device} has been successfully mounted`)
                }

                let meta: DiskMeta
                if (fs.existsSync(`${disksRoot()}/${device}/META.yaml`)) {
                    log(`Found a META file on device ${device}. This disk has been processed by the system before.`)
                    try {
                        meta = await readMetaUpdateId(device)
                        const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, meta.diskName, meta.created)
                        await processDisk(storeHandle, disk)
                    } catch (error) {
                        log('Error processing the META file on the disk: ' + error)
                        recordDiskDetectionFailure('readMeta', `Could not process META.yaml on ${device}: ${errorMessage(error)}`, { device })
                    }
                } else {
                    // Before creating a new disk entry, check if a disk is already
                    // registered for this device on THIS engine in the store. This prevents
                    // spurious empty-disk entries when addDevice fires for a device that's
                    // already docked (e.g. during docker compose up -d Recreate cycles).
                    // Scoped to localEngine.id to avoid false matches on other engines' disks
                    // in the shared CRDT store (e.g. all Pis having sda2 as the root device).
                    const existingDisk = findDiskByDevice(storeHandle.doc(), device as DeviceName, localEngine.id)
                    if (existingDisk) {
                        log(`Device ${device} already has a registered disk (${existingDisk.id}) on this engine — skipping new disk creation`)
                        return
                    }
                    log('Could not find a META file. Creating one now.')
                    const diskId = await readHardwareId(device) as DiskID
                    // The disk name should be the name of the volume if available, otherwise 'Unnamed Disk'
                    let diskName: DiskName = 'Unnamed Disk' as DiskName
                    try {
                        const volumeNameOutput = await $`lsblk -no LABEL /dev/${device}`
                        const volumeName = volumeNameOutput.stdout.trim()
                        // Check if it is a valid volume name (not empty) - it should also not have any newlines
                        if (volumeName && volumeName.length > 0 && !volumeName.includes('\n')) {
                            diskName = volumeName as DiskName
                        }
                    } catch (e) {
                        log(`Error reading volume name for device ${device}: ${e}`)
                    }
                    meta = {
                        diskId: diskId ? diskId : uuid() as DiskID,
                        isHardwareId: !!diskId,
                        diskName: diskName,
                        created: Date.now() as Timestamp,
                        lastDocked: Date.now() as Timestamp
                    }
                    // Persist the identity on the disk (idea#121). Without this every
                    // dock generated a new diskId (when there is no hardware serial)
                    // and left an orphan diskDB entry behind. Under /disks the write goes through
                    // sudo tee (11-engine-files). A failed write (read-only
                    // mount, sudoers entry missing) is recorded and the disk is still registered.
                    const metaPath = `${disksRoot()}/${device}/META.yaml`
                    if (skipMetaWrite()) {
                        log(`Not writing ${metaPath} (skipMetaWrite)`)
                    } else {
                        try {
                            await writeMetaFile(meta, metaPath)
                        } catch (e) {
                            const idNote = meta.isHardwareId ? 'its id comes from the hardware serial' : 'it will get a new id on its next dock'
                            recordDiskDetectionFailure('writeMeta', `Could not write META.yaml on ${device} (${idNote}); registering the disk anyway: ${errorMessage(e)}`, { device, diskId: meta.diskId })
                        }
                    }
                    const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, meta.diskName, meta.created)
                    await processDisk(storeHandle, disk)
                }
            } catch (e) {
                log(`Error processing device ${device}`)
                log(e)
                recordDiskDetectionFailure('dock', `Could not process the disk on ${device}: ${errorMessage(e)}`, { device })
            }
        } else {
            log(`The disk on device ${device} is not on a supported device name`)
        }
    }

    const removeDevice = async (path: string) => {
        const device = path.split('/').pop()
        if (validDevice(device!)) {
            log(`Processing the removal of USB device ${device}`)
            // Every record on the device, not just the first (idea#152)
            const undocked = await undockAllOnDevice(storeHandle, localEngine.id, device as DeviceName)
            if (undocked.length === 0) {
                log(`No disk found on ${device}`)
            }
        } else {
            log(`Non-USB device ${device} has been removed`)
        }
    }

    if (!config.settings.isDev && !config.settings.testMode) {
        try {
            log(`Cleaning up the ${disksRoot()}/old folder`)
            // Remove the folder itself, not old/*: the shell would expand the glob
            // before sudo runs, and the Engine's sudoers file only allows this exact
            // command (idea#80). /disks/old is recreated with mkdir -p when needed.
            await $`sudo rm -fr ${disksRoot()}/old`
        } catch (e) {
            log(`Error cleaning up the ${disksRoot()}/old folder`)
            log(e)
        }
    }

    const engineWatchDir = process.env.IDEA_WATCH_DIR || '/dev/engine'
    const actualDevices = (config.settings.isDev || config.settings.testMode) ? [] : (await $`ls ${engineWatchDir}`).toString().split('\n').filter(device => validDevice(device))
    log(`Actual devices: ${actualDevices}`)

    log(`Removing from the network database disks that were attached before the current boot but are no longer attached now...`)

    const storedDisks = getDisksOfEngine(store, localEngine)
    if (storedDisks.length !== 0) {
        log(`The engine object shows previously mounted disks: ${storedDisks.map(d => d.id)}`)
        const storedDevices = storedDisks.map(disk => disk.device).filter((device): device is DeviceName => device !== undefined && device !== null)
        log(`Which were on devices: ${storedDevices}`)

        for (let device of [...new Set(storedDevices)]) {
            const disks = findDisksByDevice(storeHandle.doc(), device, localEngine.id)
            if (disks.length === 0) continue
            // Never undock the system disk based on /dev/engine listing —
            // the root partition is always present and /dev/engine may not
            // be populated yet (e.g. tmpfiles.d race) or may be empty in
            // testMode. System disk presence is guaranteed by the OS itself.
            const systemDisk = disks.find(d => d.diskTypes?.includes('system'))
            if (systemDisk) {
                log(`Skipping undock of system disk ${systemDisk.id} on device ${device} — system disk is always present`)
                continue
            }
            if (!actualDevices.includes(device)) {
                log(`Removing disk from previously mounted device ${device}`)
                const undocked = await undockAllOnDevice(storeHandle, localEngine.id, device)
                log(`Disk(s) ${undocked.join(', ')} removed from local engine`)
            } else {
                // Still attached: if stale records share the device, keep the one
                // META.yaml names (idea#152)
                await resolveDuplicateDisksOnDevice(storeHandle, localEngine.id, device)
            }
        }
    } else {
        log(`No previous disks found in the network database`)
    }

    log(`Cleaning the mount points...`)
    const previousMounts = (config.settings.isDev || config.settings.testMode) ? [] : (await $`ls ${disksRoot()}`).toString().split('\n').filter(device => validDevice(device))
    log(`Previously mounted devices: ${previousMounts}`)
    // Stale mount point folders of devices that are no longer attached. A folder
    // that is still a mount point (by findmnt target or mountpoint -q) is left
    // alone; an empty one is removed with rmdir, never rm -fr (idea#126).
    for (let device of previousMounts) {
        log(`Checking if device ${device} is still actual or mounted`)
        if (actualDevices.includes(device)) continue
        try {
            const mounts = await mountOps().listMounts()
            const mountPoint = mountPointOf(device)
            if (mounts.some(m => m.target === mountPoint) || await mountOps().isMountPoint(mountPoint)) {
                log(`Stale mount point ${mountPoint} is still mounted — leaving it`)
                continue
            }
            log(`Cleaning up stale mount point for ${device}`)
            await mountOps().rmdir(mountPoint)
            log(`Device ${device} has been successfully cleaned up`)
        } catch (e) {
            log(`Error cleaning up the stale mount point of ${device}: ${errorMessage(e)}`)
        }
    }

    const watchDir = process.env.IDEA_WATCH_DIR || '/dev/engine'
    const watcher = watchDeviceFolder(watchDir)

    watcher
        .on('add', addDevice)
        .on('unlink', removeDevice)
        .on('error', error => recordDiskDetectionFailure('watcher', `Watcher error on ${watchDir}: ${errorMessage(error)}`, { watchDir }))

    log(`Watching ${watchDir} for USB devices`)
    return watcher
}

/**
 * diskId from <disksRoot>/<device>/META.yaml, read only (no lastDocked update, no
 * sudo). null when there is no readable META.yaml or it has no diskId.
 */
export const readMetaDiskIdOnDevice = async (device: DeviceName): Promise<DiskID | null> => {
    const metaPath = `${disksRoot()}/${device}/META.yaml`
    try {
        if (!(await fs.pathExists(metaPath))) return null
        const meta = YAML.parse(await fs.readFile(metaPath, 'utf-8'))
        return meta?.diskId ? String(meta.diskId) as DiskID : null
    } catch (e) {
        log(`Could not read ${metaPath}: ${errorMessage(e)}`)
        return null
    }
}

/**
 * Startup, device still attached (idea#152): when several records on this engine
 * claim the device, keep the one whose id matches the device's META.yaml and
 * undock the others in the store. Without a matching META.yaml nothing changes
 * here; the dock of the device (createOrUpdateDisk) clears the others. Returns
 * the ids that were undocked.
 */
export const resolveDuplicateDisksOnDevice = async (
    storeHandle: DocHandle<Store>,
    engineId: EngineID,
    device: DeviceName,
    readMetaDiskId: (device: DeviceName) => Promise<DiskID | null> = readMetaDiskIdOnDevice,
): Promise<DiskID[]> => {
    const disks = findDisksByDevice(storeHandle.doc(), device, engineId)
    if (disks.length < 2) return []
    const metaDiskId = await readMetaDiskId(device)
    const keep = metaDiskId ? disks.find(d => String(d.id) === String(metaDiskId)) : undefined
    if (!keep) {
        log(`Disk records ${disks.map(d => d.id).join(', ')} share ${device} and none matches its META.yaml (${metaDiskId ?? 'none'}); the next dock of ${device} resolves them`)
        return []
    }
    let cleared: DiskID[] = []
    storeHandle.change(doc => { cleared = clearDuplicateDiskRecords(doc, engineId, device, keep.id) })
    log(`Undocked stale disk record(s) ${cleared.join(', ')} on ${device}; kept ${keep.id} (META.yaml)`)
    return cleared
}

/**
 * Undock every record on this engine that claims the device (idea#152). The
 * extra records are cleared in the store first; the first one goes through
 * undockDisk (unmount, instances, store). Returns all undocked ids.
 */
export const undockAllOnDevice = async (storeHandle: DocHandle<Store>, engineId: EngineID, device: DeviceName): Promise<DiskID[]> => {
    const disks = findDisksByDevice(storeHandle.doc(), device, engineId)
    if (disks.length === 0) return []
    const primary = disks[0]
    let cleared: DiskID[] = []
    if (disks.length > 1) {
        storeHandle.change(doc => { cleared = clearDuplicateDiskRecords(doc, engineId, device, primary.id) })
        log(`Undocked stale disk record(s) ${cleared.join(', ')} on ${device}`)
    }
    await undockDisk(storeHandle, primary)
    return [primary.id, ...cleared]
}

export const undockDisk = async (storeHandle: DocHandle<Store>, disk: Disk) => {
    const store: Store = storeHandle.doc()
    const device = disk.device
    if (!device) {
        log(`Disk ${disk.id} is not mounted on any device. Nothing to undock.`)
        return
    }
    if (await isSystemDiskRecord(disk)) {
        log(`Disk ${disk.id} on ${device} is this Pi's system disk — never undocked`)
        return
    }
    try {
        // The store is updated whatever happens to the unmount below (idea#126)
        storeHandle.change(doc => {
            const dsk = doc.diskDB[disk.id]
            if (dsk) {
                dsk.dockedTo = null
                dsk.device = null
                dsk.diskTypes = []
                dsk.backupConfig = null
            }
        })
        // Stop all instances of the disk and move them to the 'Undocked' state
        const instancesOnDisk = Object.values(store.instanceDB).filter(instance => String(instance.storedOn) === String(disk.id));
        for (const instance of instancesOnDisk) {
            const cmdLogHandle = getCommandLogHandle()
            const traceId = crypto.randomUUID()
            const traceCtx = { traceId, command: 'stopInstance', args: JSON.stringify({ instanceName: instance.name, diskId: disk.id, reason: 'disk-undocked' }) }
            if (cmdLogHandle) addTrace(cmdLogHandle, { traceId, command: 'stopInstance', args: traceCtx.args, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
            try {
                await runWithTrace(traceCtx, () => stopInstance(storeHandle, instance, disk, 'disk-undocked'))
                if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'ok')
            } catch (e: any) {
                if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'error', e.message ?? String(e))
            }
            log(`Instance ${instance.id} stopped`)
            storeHandle.change(doc => {
                const inst = doc.instanceDB[instance.id]
                // Move the instance to the 'Undocked' state and clear metrics
                if (inst) {
                    inst.status = 'Undocked' as Status
                    inst.metrics = null
                }
            })
            log(`Instance ${instance.id} has been moved to the 'Undocked' state`)
        }
        // Unmount after the instances are stopped (their containers keep files on
        // the disk open). Repeat umount until the folder is no longer a mount
        // point, then rmdir it; never rm -fr (idea#126).
        if (!mountCommandsActive(config.settings.testMode)) {
            log(`testMode: skipping umount and rmdir for device ${device}`)
        } else {
            await unmountDisk(storeHandle, disk, device, store)
        }
    } catch (e) {
        log(`Error unmounting device ${device}`)
        log(e)
        recordDiskDetectionFailure('undock', `Could not undock the disk on ${device}: ${errorMessage(e)}`, { device, diskId: disk.id })
    }
}

/**
 * Unmount a disk on undock (idea#126): unmountAndRemove() repeats umount until
 * `mountpoint -q` is false (at most UMOUNT_MAX_ATTEMPTS), then rmdirs the mount
 * point. On a busy unmount: a failed `diskDetection` trace (step 'undock') and
 * Disk.unmountError { engineId, mountPoint, fsUuid, message }, for every disk
 * type. The caller has already updated the store.
 */
const unmountDisk = async (storeHandle: DocHandle<Store>, disk: Disk, device: DeviceName, store: Store): Promise<void> => {
    const mountPoint = mountPointOf(device)
    log(`Attempting to unmount device ${device}`)
    let result
    try {
        result = await unmountAndRemove(device)
    } catch (e) {
        // Unmounted, but the folder could not be removed (e.g. not empty): no data at risk
        recordDiskDetectionFailure('undock', `Unmounted ${mountPoint} but could not remove the folder: ${errorMessage(e)}`, { device, diskId: disk.id, mountPoint })
        mountedFsUuids.delete(device)
        return
    }
    if (result.ok) {
        log(`Device ${device} unmounted after ${result.attempts} umount call(s)${result.removed ? `; ${mountPoint} removed` : ''}`)
        mountedFsUuids.delete(device)
        return
    }
    const engineId = (getLocalEngine(store)?.id ?? disk.dockedTo) as EngineID
    const fsUuid = mountedFsUuids.get(device) ?? null
    const message = `Could not unmount ${mountPoint}: ${result.message}. Restart this Pi to release the disk.`
    recordDiskDetectionFailure('undock', message, { device, diskId: disk.id, mountPoint, fsUuid })
    storeHandle.change(doc => {
        const dsk = doc.diskDB[disk.id]
        if (dsk) dsk.unmountError = { engineId, mountPoint, fsUuid, message }
    })
}
