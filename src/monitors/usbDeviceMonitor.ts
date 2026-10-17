import chokidar, { FSWatcher } from 'chokidar'
import nodePath from 'path'
import { getKeys, log } from '../utils/utils.js'
import { DiskMeta, readMetaUpdateId } from '../data/Meta.js';
import { $, fs, YAML, chalk } from 'zx'

$.verbose = false;
import { Disk, clearDuplicateDiskRecords, createOrUpdateDisk, isSystemDiskRecord, processDisk } from '../data/Disk.js'
import { flushFilesRemountNow, optedInInstances } from '../data/FilesMount.js'
import { clearUndockPending, dockChangedReason, dockIdentityOf, ejectInFlightWaitMs, markUndockPending, waitInFlightOnDisk } from '../data/InstanceInFlight.js'
import { isSystemDevice, systemDriveNames, driveNameOf } from '../data/SystemDisk.js'
import { refreshUnformattedDisks } from '../data/UnformattedDisks.js'
import { setInitialiseAddDevice } from '../data/FlashCard.js'
import { eraseLockRefusesAdd, isEraseDeviceLocked, setEraseAddDevice } from '../data/EraseDisk.js'
import { findDiskByDevice, findDisksByDevice, Store, getDisksOfEngine, getLocalEngine } from '../data/Store.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../data/CommonTypes.js'

import { Instance, Status, stopInstance } from '../data/Instance.js';
import { config, disksRoot } from '../data/Config.js'
import { DocHandle } from '@automerge/automerge-repo';
import { getCommandLogHandle, addTrace, closeTrace } from '../data/CommandLogStore.js';
import { runWithTrace } from '../utils/CommandLogger.js';
import { recordDiskDetectionFailure, errorMessage } from './diskDetection.js';
import { addStick, classifyFsType, stickBlockedBySiblings, removeStick, removeSticksOnDrive, usbStartupCleanup, usbStickOps, usbStickRoutingActive, syncUsbApps } from '../data/UsbSticks.js'
import { lookForIdeaMeta, IdeaLookResult, safeMount, unmountAndRemove, mountCommandsActive, mountOps, mountPointOf } from './mounts.js';
import { isTestDeviceName, isValidDeviceName, isSdWholeDisk, partitionName, needsDirectSystemAdd } from './deviceNames.js'

/**
 * Filesystem UUID of each mounted device, recorded at mount time (or when an
 * existing mount is found) with lsblk -no UUID. Used for Disk.unmountError
 * (idea#126).
 */
const mountedFsUuids = new Map<string, string | null>()

// Test-only device names (idea#105) now live in deviceNames.ts; re-exported here
// for existing importers.
export { TEST_DEVICE_PATTERN, isTestDeviceName } from './deviceNames.js'

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

/**
 * Device names in the watch folder. A missing folder means "no USB devices", not
 * an error (agent-engine-dev#228): udev only creates /dev/engine with the first
 * sd* link, so a Pi with an NVMe or SD root and no USB disk has none. tmpfiles.d
 * (idea-engine.conf) should create it at boot, but the Engine cannot rely on it
 * and cannot create it itself (pi can't mkdir in /dev). Other errors are logged
 * and also read as empty, so they never stop the monitor from starting.
 */
export const listDeviceFolder = async (dir: string): Promise<string[]> => {
    try {
        return (await fs.readdir(dir)).filter(Boolean)
    } catch (e: any) {
        if (e?.code === 'ENOENT') log(`${dir} does not exist — no USB devices attached yet`)
        else log(`Could not list ${dir}: ${errorMessage(e)} — treating it as empty`)
        return []
    }
}

/** How often watchDeviceFolderWhenPresent checks whether the watch folder exists (one stat). */
export const DEVICE_FOLDER_POLL_MS = 2000

export interface DeviceFolderHandlers {
    add: (path: string) => unknown
    unlink: (path: string) => unknown
    error: (error: unknown) => void
}

export interface DeviceFolderWatch {
    /** True while a chokidar watcher is attached to the folder. */
    isAttached: () => boolean
    close: () => Promise<void>
}

/**
 * Watch the udev watch folder, also when it does not exist yet or disappears
 * again (agent-engine-dev#228). chokidar 3 on a missing folder reports the folder
 * appearing but not the links created in it, and a watcher on a folder that was
 * removed and recreated stays blind. So: one stat every `pollMs`; when the
 * folder is there (and not yet watched, or replaced by a new inode) a watcher is
 * attached with watchDeviceFolder, whose initial scan reports the links already
 * in it; when it is gone the watcher is closed and every link it had reported is
 * reported as unlinked (udev removes the folder only after its last link).
 */
export const watchDeviceFolderWhenPresent = (
    watchDir: string,
    handlers: DeviceFolderHandlers,
    pollMs: number = DEVICE_FOLDER_POLL_MS,
): DeviceFolderWatch => {
    const root = nodePath.resolve(watchDir)
    let watcher: FSWatcher | null = null
    let ino: number | null = null
    let closed = false
    const present = new Set<string>()

    const folderIno = (): number | null => {
        try {
            const st = fs.statSync(root)
            return st.isDirectory() ? st.ino : null
        } catch {
            return null
        }
    }
    const detach = (): void => {
        const w = watcher
        if (!w) return
        watcher = null
        ino = null
        const gone = [...present]
        present.clear()
        void w.close().catch(e => log(`Closing the watcher on ${root}: ${errorMessage(e)}`))
        log(`${root} is gone — device watcher detached${gone.length ? `; ${gone.length} device(s) unlinked` : ''}`)
        for (const p of gone) handlers.unlink(p)
    }
    const attach = (i: number): void => {
        ino = i
        const w = watchDeviceFolder(root)
        watcher = w
        w.on('add', p => { if (watcher !== w) return; present.add(p); handlers.add(p) })
            .on('unlink', p => { if (watcher !== w) return; present.delete(p); handlers.unlink(p) })
            .on('unlinkDir', p => { if (watcher === w && nodePath.resolve(p) === root) detach() })
            .on('error', e => { if (watcher === w) handlers.error(e) })
        log(`Device watcher attached to ${root}`)
    }
    const check = (): void => {
        if (closed) return
        const i = folderIno()
        if (watcher && i !== ino) detach()
        if (!watcher && i !== null) attach(i)
    }

    check()
    if (!watcher) log(`${root} does not exist yet — checking every ${pollMs} ms and watching it once it appears`)
    const timer = setInterval(check, pollMs)
    timer.unref?.()
    return {
        isAttached: () => watcher !== null,
        close: async () => {
            closed = true
            clearInterval(timer)
            const w = watcher
            watcher = null
            present.clear()
            await w?.close()
        },
    }
}

/**
 * agent-engine-dev#228: a root device outside the udev rule (nvme0n1p2 on a Pi 5
 * booting from NVMe, mmcblk0p2 on an SD-booted Pi) gets no link in the watch
 * folder, so the watcher never reports it: register it directly through
 * addDevice. Independent of whether the watch folder exists. Returns true when
 * it was started.
 */
export const registerUnlinkedSystemDisk = (opts: {
    systemDevice: string | null | undefined
    watchDir: string
    systemDiskSkip: boolean
    addDevice: (path: string) => Promise<unknown>
}): boolean => {
    const { systemDevice, watchDir, systemDiskSkip, addDevice } = opts
    const linkExists = !!systemDevice && fs.existsSync(`${watchDir}/${systemDevice}`)
    if (!needsDirectSystemAdd(systemDevice, { systemDiskSkip, linkExists })) return false
    log(`System disk ${systemDevice} has no link in ${watchDir} — registering it directly`)
    void addDevice(`${watchDir}/${systemDevice}`).catch(e =>
        recordDiskDetectionFailure('dock', `Could not register the system disk on ${systemDevice}: ${errorMessage(e)}`, { device: systemDevice }))
    return true
}

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

    // System drives via findmnt / + /boot/firmware and lsblk PKNAME (idea#134).
    // Covers a USB system disk and idea02's Intenso — never by name/model alone.
    let systemDevice: DeviceName | null = null
    let systemBootDevice: DeviceName | null = null
    let systemDrives: string[] = []
    try {
        systemDrives = await systemDriveNames()
        const rootSource = (await $`findmnt -n -o SOURCE /`).stdout.trim()
        const rootDev = rootSource.replace(/^\/dev\//, '').replace(/\[.*\]$/, '') as DeviceName
        if (rootDev && !rootDev.startsWith('overlay')) {
            systemDevice = rootDev
            const parent = driveNameOf(rootDev)
            // Boot partition: prefer the findmnt /boot/firmware source's device
            try {
                const bootSrc = (await $`findmnt -n -o SOURCE /boot/firmware`).stdout.trim()
                const bootDev = bootSrc.replace(/^\/dev\//, '').replace(/\[.*\]$/, '')
                if (bootDev) systemBootDevice = bootDev as DeviceName
                else systemBootDevice = partitionName(parent, 1) as DeviceName
            } catch {
                systemBootDevice = partitionName(parent, 1) as DeviceName
            }
            log(`System disk detected: root=${systemDevice}, boot=${systemBootDevice}, drives=${systemDrives.join(',')}`)
        }
    } catch (e) {
        log(`Could not detect system device: ${e}`)
    }

    // sd* (sda, sda1, sda2), NVMe / mmcblk partitions and the detected root
    // device itself (agent-engine-dev#228); idea-test-N only in testMode (idea#105).
    const validDevice = function (device: string): boolean {
        return isValidDeviceName(device, { systemDevice, testMode: config.settings.testMode })
    }

    /**
     * idea#201 §10: one read-only META look per device, shared by the device's own
     * addDevice and by the stick check of a FAT partition on the same drive, so
     * they never race (two ro mounts of one device) and agree on the answer.
     * Forgotten when the device is removed.
     */
    const metaLooks = new Map<string, Promise<IdeaLookResult>>()
    const sharedMetaLook = (device: DeviceName): Promise<IdeaLookResult> => {
        let p = metaLooks.get(device)
        if (!p) {
            p = !mountCommandsActive(config.settings.testMode)
                ? Promise.resolve({ ok: true, hasMeta: fs.existsSync(`${disksRoot()}/${device}/META.yaml`), alreadyMounted: false } as IdeaLookResult)
                : lookForIdeaMeta(device).catch(e => ({ ok: false, message: errorMessage(e) }) as IdeaLookResult)
            metaLooks.set(device, p)
            // A failed look may be retried on the next add event
            p.then(r => { if (!r.ok && metaLooks.get(device) === p) metaLooks.delete(device) })
        }
        return p
    }

    /**
     * idea#193 §3.1: probe the filesystem type; vfat/exfat on a non-system disk is
     * mounted read-only as a teacher stick. Returns true when the device was a
     * stick (mounted, or refused with a recorded failure), false for ext4 and
     * anything else (the IDEA disk path continues unchanged).
     */
    const tryAddStick = async (device: DeviceName): Promise<boolean> => {
        if (isTestDeviceName(device) || !usbStickRoutingActive()) return false
        let probe
        try { probe = await usbStickOps().probe(device) } catch (e) { log(`USB stick probe of ${device}: ${errorMessage(e)}`); return false }
        if (!probe || classifyFsType(probe.fsType) !== 'stick') return false
        if (await isSystemDevice(device) || device === systemBootDevice || device === systemDevice) {
            log(`Device ${device} (${probe.fsType}) is on the system drive — never mounted as a USB stick`)
            return true
        }
        // idea#201 §10 follow-up: the FAT boot partition of an OS card (Linux
        // partition without META.yaml) is not a stick. The sibling is judged by
        // the same shared read-only look its own addDevice uses, so the order of
        // the add events does not matter. Never mounted, never registered.
        if (driveNameOf(device) !== device) {
            let parts: Awaited<ReturnType<ReturnType<typeof usbStickOps>['drivePartitions']>> = []
            try { parts = await usbStickOps().drivePartitions(device) } catch (e) { log(`USB stick sibling check of ${device}: ${errorMessage(e)}`) }
            const why = await stickBlockedBySiblings(device, parts, async (sib) => {
                const look = await sharedMetaLook(sib as DeviceName)
                return look.ok ? look.hasMeta : null
            })
            if (why) {
                log(`Device ${device} (${probe.fsType}) is not a teacher stick: ${why} — not mounted`)
                return true
            }
        }
        const result = await addStick(storeHandle, device, probe)
        if (!result.ok) recordDiskDetectionFailure('mount', result.message, { device })
        return true
    }

    /** idea#201 §10 rule 1: a device without IDEA META.yaml is left untouched. */
    const logUnknownDisk = (device: DeviceName): void => {
        log(`Device ${device} has no IDEA META.yaml — not an IDEA disk; left untouched (never mounted read-write, no META.yaml written)`)
    }

    const addDevice = async function (path: string) {
        log(`A disk on device ${path} has been added`)
        const device = path.split('/').pop() as DeviceName

        if (validDevice(device)) {
            log(`The disk on device ${device} has a valid device name`)

            // Skip whole-disk entries for mounting (idea#134): accepted by validDevice
            // so lsblk can list them as unformatted candidates; never mounted.
            if (isSdWholeDisk(device)) {
                // A stick formatted without a partition table carries FAT/exFAT on the
                // whole disk (idea#193 §3.2): mount it read-only like a partition.
                if (!isEraseDeviceLocked(device) && await tryAddStick(device)) {
                    await refreshUnformattedDisks(storeHandle).catch(e => log(`unformatted refresh: ${e}`))
                    return
                }
                log(`Device ${device} is a whole-disk entry — refreshing unformattedDisks, not mounting`)
                await refreshUnformattedDisks(storeHandle).catch(e => log(`unformatted refresh: ${e}`))
                return
            }
            // Skip devices locked by eraseDisk for the whole erase (idea#134)
            if (eraseLockRefusesAdd(device)) {
                log(`Device ${device} is locked for erase — addDevice skipped`)
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

                // FAT/exFAT teacher stick (idea#193 §3.1): read-only under /run/idea-usb, never an IDEA disk
                if (await tryAddStick(device)) {
                    await refreshUnformattedDisks(storeHandle).catch(e => log(`unformatted refresh: ${e}`))
                    return
                }

                // idea#201 §10 rule 1: only a device with IDEA META.yaml is ever
                // mounted read-write. Anything else (client SD cards, an Ubuntu or
                // Raspberry Pi OS card, a foreign ext4 disk) is looked at read-only
                // at most, released again, and never gets a META.yaml. Such a disk
                // becomes an IDEA disk only through an explicit command
                // (eraseDisk today, initialiseDisk later).
                const metaPath = `${disksRoot()}/${device}/META.yaml`
                if (!mountCommandsActive(config.settings.testMode)) {
                    log(`testMode: skipping mount for device ${device} — fixture expected at ${disksRoot()}/${device}`)
                    if (!fs.existsSync(metaPath)) {
                        logUnknownDisk(device)
                        return
                    }
                } else {
                    const look = await sharedMetaLook(device)
                    if (!look.ok) {
                        recordDiskDetectionFailure('mount', look.message, { device })
                        return
                    }
                    if (!look.hasMeta) {
                        if (look.alreadyMounted) log(`Device ${device} is already mounted without META.yaml — left as it is`)
                        logUnknownDisk(device)
                        return
                    }
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

                log(`Found a META file on device ${device}. This disk has been processed by the system before.`)
                try {
                    const meta: DiskMeta = await readMetaUpdateId(device)
                    const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, meta.diskName, meta.created)
                    await processDisk(storeHandle, disk)
                } catch (error) {
                    log('Error processing the META file on the disk: ' + error)
                    recordDiskDetectionFailure('readMeta', `Could not process META.yaml on ${device}: ${errorMessage(error)}`, { device })
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

        setEraseAddDevice(addDevice)
        setInitialiseAddDevice(addDevice)

    const removeDevice = async (path: string) => {
        const device = path.split('/').pop()
        if (validDevice(device!)) {
            log(`Processing the removal of USB device ${device}`)
            metaLooks.delete(device!)
            // Teacher sticks first (idea#193 §3.4): partition, or every stick of a whole drive
            const removedSticks = isSdWholeDisk(device)
                ? await removeSticksOnDrive(storeHandle, device!, 'unplugged')
                : (await removeStick(storeHandle, device!, 'unplugged')) ? [device] : []
            if (removedSticks.length) {
                await refreshUnformattedDisks(storeHandle).catch(e => log(`unformatted refresh: ${e}`))
                return
            }
            // Every record on the device, not just the first (idea#152)
            const undocked = await undockAllOnDevice(storeHandle, localEngine.id, device as DeviceName)
            if (undocked.length === 0) {
                log(`No disk found on ${device}`)
            }
            // idea#201 §10: a pulled card / new disk leaves clientCards / newDisks at once
            await refreshUnformattedDisks(storeHandle).catch(e => log(`unformatted refresh: ${e}`))
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

    const watchDir = process.env.IDEA_WATCH_DIR || '/dev/engine'
    // Startup cleanup of records and mount points from before this start. A
    // failure here is reported but never stops the system disk registration or
    // the watcher below (agent-engine-dev#228).
    try {
        const actualDevices = (config.settings.isDev || config.settings.testMode) ? [] : (await listDeviceFolder(watchDir)).filter(device => validDevice(device))
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
        const previousMounts = (config.settings.isDev || config.settings.testMode) ? [] : (await listDeviceFolder(disksRoot())).filter(device => validDevice(device))
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
    } catch (e) {
        recordDiskDetectionFailure('monitorStart', `USB device monitor startup cleanup failed (monitor continues): ${errorMessage(e)}`, { watchDir })
    }

    // Teacher sticks (idea#193 §3.4): unmount leftovers under /run/idea-usb before the
    // watcher's initial adds mount the sticks that are still plugged in.
    if (usbStickRoutingActive()) {
        await usbStartupCleanup(storeHandle).catch(e => log(`USB sticks startup cleanup: ${errorMessage(e)}`))
        void syncUsbApps(storeHandle, 'start')
    }

    // agent-engine-dev#228: register a root device the udev rule does not link
    // (nvme0n1p2, mmcblk0p2) directly, whether or not the watch folder exists.
    registerUnlinkedSystemDisk({ systemDevice, watchDir, systemDiskSkip: !!config.settings.systemDiskSkip, addDevice })

    // Also when the folder is missing (no USB disk yet on an NVMe/SD-root Pi):
    // the watcher attaches as soon as udev creates it (agent-engine-dev#228).
    const watcher = watchDeviceFolderWhenPresent(watchDir, {
        add: addDevice,
        unlink: removeDevice,
        error: error => recordDiskDetectionFailure('watcher', `Watcher error on ${watchDir}: ${errorMessage(error)}`, { watchDir }),
    })

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
    // Device-removal path: the disk is already gone, so no in-flight wait (#179 applies to eject).
    await undockDisk(storeHandle, primary, { waitInFlight: false })
    return [primary.id, ...cleared]
}

/** Result of undockDisk: `aborted` names why an eject stopped after its in-flight wait (disk pulled/re-docked meanwhile). */
export type UndockResult = { aborted: string | null }

/** Device node + mount still the one this dock made? Only with real mount commands (not testMode/sim). */
const liveMountChangedReason = async (device: string): Promise<string | null> => {
    if (!mountCommandsActive(config.settings.testMode)) return null
    if (!fs.existsSync(`/dev/${device}`)) return `device /dev/${device} is gone`
    const src = (await $`findmnt -n -o SOURCE ${mountPointOf(device)}`.nothrow()).stdout.trim()
    if (src !== `/dev/${device}`) return `${mountPointOf(device)} is not mounted from /dev/${device} (source ${src || 'none'})`
    return null
}

export const undockDisk = async (storeHandle: DocHandle<Store>, disk: Disk, opts: { waitInFlight?: boolean } = {}): Promise<UndockResult | void> => {
    markUndockPending(String(disk.id))
    try { return await undockDiskInner(storeHandle, disk, opts) } finally { clearUndockPending(String(disk.id)) }
}

const undockDiskInner = async (storeHandle: DocHandle<Store>, disk: Disk, opts: { waitInFlight?: boolean }): Promise<UndockResult> => {
    const device0 = disk.device
    const before = dockIdentityOf(disk)
    // #179: an instance start/install still running on this disk must settle first (bounded),
    // then it is stopped below. Otherwise it carries on against the unmounted disk (r82b/r83).
    // Only for an Engine-initiated undock (ejectDisk, erase), where the disk is still there and
    // the Engine itself unmounts it. After a physical removal (device gone, undockAllOnDevice
    // from the monitor) the disk is already gone: waiting cannot help the start and would only
    // keep the pulled disk listed as docked for up to the bound (disk-dock-undock).
    if (opts.waitInFlight !== false && device0 && !(await isSystemDiskRecord(disk))) {
        const w = await waitInFlightOnDisk(String(disk.id), ejectInFlightWaitMs())
        if (w.timedOut.length) log(`Undock ${disk.id}: still in flight after ${w.waitedMs}ms (${w.timedOut.join(', ')}) — stopping anyway`)
        else if (w.waitedMs > 0) log(`Undock ${disk.id}: in-flight start(s) settled after ${w.waitedMs}ms`)
        // hw180: the disk may have been pulled (and even re-plugged on a new device) during the wait.
        // Only act on the very dock this eject was for: same device node, mount and dock generation.
        if (w.waitedMs > 0 || w.timedOut.length) {
            const reason = dockChangedReason(before, dockIdentityOf(storeHandle.doc()?.diskDB?.[disk.id]))
                ?? await liveMountChangedReason(device0)
            if (reason) {
                log(`Eject of ${disk.id} aborted after the in-flight wait: ${reason}; nothing unmounted, store left as is`)
                return { aborted: reason }
            }
        }
    }
    // Read the store AFTER the wait, so instances registered by a settling install are stopped too
    const store: Store = storeHandle.doc()
    const device = disk.device
    if (!device) {
        log(`Disk ${disk.id} is not mounted on any device. Nothing to undock.`)
        return { aborted: null }
    }
    if (await isSystemDiskRecord(disk)) {
        log(`Disk ${disk.id} on ${device} is this Pi's system disk — never undocked`)
        return { aborted: null }
    }
    try {
        // Combined Files Disk eject (§7.3): recreate opted-in instances on *other*
        // disks without this bind, then stop this disk's own instances, then unmount
        // once. Same-disk Nextcloud is simply stopped with the disk (no recreate).
        const wasFiles = (disk.diskTypes ?? []).includes('files') || !!disk.filesConfig
        if (wasFiles) {
            log(`Undock of Files Disk ${disk.id}: remounting other-disk opted-in instances without its bind`)
            await flushFilesRemountNow(storeHandle)  // flush any pending dock remount first
            // Mark exclude and remount immediately (can't wait for the grouping window)
            const { remountInstance } = await import('../data/FilesMount.js')
            for (const inst of optedInInstances(store)) {
                if (inst.storedOn === disk.id) continue
                await remountInstance(storeHandle, inst.id, { excludeDiskId: disk.id })
            }
        }
        // The store is updated whatever happens to the unmount below (idea#126)
        storeHandle.change(doc => {
            const dsk = doc.diskDB[disk.id]
            if (dsk) {
                dsk.dockedTo = null
                dsk.device = null
                dsk.diskTypes = []
                dsk.backupConfig = null
                dsk.filesConfig = null      // idea#131
                dsk.sizeBytes = null
                dsk.freeBytes = null
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
    return { aborted: null }
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
