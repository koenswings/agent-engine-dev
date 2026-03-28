import chokidar from 'chokidar'
import { getKeys, log, uuid } from '../utils/utils.js'
import { DiskMeta, readHardwareId, readMetaUpdateId } from '../data/Meta.js';
import { $, fs, YAML, chalk } from 'zx'

$.verbose = false;
import { Disk, createOrUpdateDisk, processDisk } from '../data/Disk.js'
import { findDiskByDevice, Store, getDisksOfEngine, getLocalEngine } from '../data/Store.js'
import { DeviceName, DiskID, DiskName, InstanceID, Timestamp } from '../data/CommonTypes.js'
import { Instance, Status, stopInstance } from '../data/Instance.js';
import { config } from '../data/Config.js'
import { DocHandle } from '@automerge/automerge-repo';

export const enableUsbDeviceMonitor = async (storeHandle: DocHandle<Store>) => {

    // TODO: Alternative implementations for usb device detection:
    // 1. Monitor /dev iso /dev/engine
    // 2. Monitor /dev/disk/by-label
    // 3. Monitor dmesg output

    const store: Store = storeHandle.doc()
    const localEngine = getLocalEngine(store)

    if (!localEngine) {
        log(`No local engine found in the store`)
        throw new Error(`No local engine found in the store`)
    }

    const validDevice = function (device: string): boolean {
        // Check if the device begins with "sd", is then followed by a letter and ends with the number 2
        // We need the m flag - see https://regexr.com/7rvpq 
        return device && (device.match(/^sd[a-z][1-2]$/m) || device.match(/^sd[a-z]$/m)) ? true : false
    }

    const addDevice = async function (path: string) {
        log(`A disk on device ${path} has been added`)
        const device = path.split('/').pop() as DeviceName

        if (validDevice(device)) {
            log(`The disk on device ${device} has a valid device name`)
            log(`Processing the disk on device ${device}`)
            try {
                if (config.settings.testMode) {
                    log(`testMode: skipping mount for device ${device} — fixture expected at /disks/${device}`)
                } else {
                    const mountOutput = await $`mount -t ext4`
                    if (mountOutput.stdout.includes(`/dev/${device} on /disks/${device} type ext4`)) {
                        log(`Device ${device} already mounted`)
                    } else {
                        log(`Mounting device ${device}`)
                        await $`sudo mkdir -p /disks/${device}`
                        await $`sudo mount /dev/${device} /disks/${device}`
                        log(`Device ${device} has been successfully mounted`)
                    }
                }

                let meta: DiskMeta
                if (fs.existsSync(`/disks/${device}/META.yaml`)) {
                    log(`Found a META file on device ${device}. This disk has been processed by the system before.`)
                    try {
                        meta = await readMetaUpdateId(device)
                        const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, meta.diskName, meta.created)
                        await processDisk(storeHandle, disk)
                    } catch (error) {
                        log('Error processing the META file on the disk: ' + error)
                    }
                } else {
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
                    const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, meta.diskName, meta.created)
                    await processDisk(storeHandle, disk)
                }
            } catch (e) {
                log(`Error processing device ${device}`)
                log(e)
            }
        } else {
            log(`The disk on device ${device} is not on a supported device name`)
        }
    }

    const removeDevice = async (path: string) => {
        const device = path.split('/').pop()
        if (validDevice(device!)) {
            log(`Processing the removal of USB device ${device}`)
            const disk = findDiskByDevice(storeHandle.doc(), device as DeviceName)
            if (!disk) {
                log(`No disk found on ${device}`)
                return
            }
            await undockDisk(storeHandle, disk)
        } else {
            log(`Non-USB device ${device} has been removed`)
        }
    }

    if (!config.settings.isDev && !config.settings.testMode) {
        try {
            log(`Cleaning up the /disks/old folder`)
            await $`sudo rm -fr /disks/old/*`
        } catch (e) {
            log(`Error cleaning up the /disks/old folder`)
            log(e)
        }
    }

    const actualDevices = (config.settings.isDev || config.settings.testMode) ? [] : (await $`ls /dev/engine`).toString().split('\n').filter(device => validDevice(device))
    log(`Actual devices: ${actualDevices}`)

    log(`Removing from the network database disks that were attached before the current boot but are no longer attached now...`)

    const storedDisks = getDisksOfEngine(store, localEngine)
    if (storedDisks.length !== 0) {
        log(`The engine object shows previously mounted disks: ${storedDisks.map(d => d.id)}`)
        const storedDevices = storedDisks.map(disk => disk.device).filter((device): device is DeviceName => device !== undefined && device !== null)
        log(`Which were on devices: ${storedDevices}`)

        for (let device of storedDevices) {
            if (!actualDevices.includes(device)) {
                log(`Removing disk from previously mounted device ${device}`)
                const disk = findDiskByDevice(store, device as DeviceName)
                if (disk) {
                    await undockDisk(storeHandle, disk)
                    log(`Disk ${disk.id} removed from local engine`)
                }
            }
        }
    } else {
        log(`No previous disks found in the network database`)
    }

    log(`Cleaning the mount points...`)
    const previousMounts = (config.settings.isDev || config.settings.testMode) ? [] : (await $`ls /disks`).toString().split('\n').filter(device => validDevice(device))
    log(`Previously mounted devices: ${previousMounts}`)
    const mountOutput = await $`mount -t ext4`
    for (let device of previousMounts) {
        log(`Checking if device ${device} is still actual or mounted`)
        if (!actualDevices.includes(device) && !mountOutput.stdout.includes(`/dev/${device} on /disks/${device} type ext4`)) {
            log(`Cleaning up stale mount point for ${device}`)
            try {
                await $`sudo umount /disks/${device}`
            } catch (e: any) {
                if (e.stderr.includes('not mounted')) {
                    await $`sudo mkdir -p /disks/old`
                    await $`sudo mv /disks/${device} /disks/old/${device}`
                    log(`Device ${device} has been moved to /disks/old`)
                } else {
                    log(`Error unmounting device during cleaning ${device}`)
                    log(e)
                }
            }
            log(`Device ${device} has been successfully cleaned up`)
        }
    }

    const watchDir = '/dev/engine'
    const watcher = chokidar.watch(watchDir, { persistent: true })

    watcher
        .on('add', addDevice)
        .on('unlink', removeDevice)
        .on('error', error => log(`Watcher error: ${error}`))

    log(`Watching ${watchDir} for USB devices`)
}

const undockDisk = async (storeHandle: DocHandle<Store>, disk: Disk) => {
    const store: Store = storeHandle.doc()
    const device = disk.device
    if (!device) {
        log(`Disk ${disk.id} is not mounted on any device. Nothing to undock.`)
        return
    }
    try {
        if (config.settings.testMode) {
            log(`testMode: skipping umount and rm for device ${device}`)
        } else {
            log(`Attempting to unmount device ${device}`)
            try {
                await $`sudo umount /disks/${device}`
                log(`Device ${device} has been successfully unmounted`)
            } catch (e: any) {
                // If the error indicates it wasn't mounted, we can proceed.
                // Otherwise, we must abort to avoid deleting data on a mounted disk.
                if (!e.stderr.includes('not mounted')) {
                    throw new Error(`Failed to unmount ${device}: ${e.message}`)
                }
                log(`Device ${device} was not mounted`)
            }
            await $`sudo rm -fr /disks/${device}`
            log(`Mount point /disks/${device} has been removed`)
        }
        storeHandle.change(doc => {
            const dsk = doc.diskDB[disk.id]
            if (dsk) {
                // Move the disk to the 'Undocked' state
                dsk.dockedTo = null
                // Set the disk's device to null    
                dsk.device = null
            }
        })
        // Stop all instances of the disk and move them to the 'Undocked' state
        const instancesOnDisk = Object.values(store.instanceDB).filter(instance => instance.storedOn === disk.id);
        for (const instance of instancesOnDisk) {
            await stopInstance(storeHandle, instance, disk)
            log(`Instance ${instance.id} stopped`)
            storeHandle.change(doc => {
                const inst = doc.instanceDB[instance.id]
                // Move the instance to the 'Undocked' state
                if (inst) inst.status = 'Undocked' as Status
            })
            log(`Instance ${instance.id} has been moved to the 'Undocked' state`)
        }
    } catch (e) {
        log(`Error unmounting device ${device}`)
        log(e)
    }
}
