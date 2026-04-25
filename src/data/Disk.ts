import { $, YAML, chalk, fs, os } from 'zx';
import { deepPrint, log } from '../utils/utils.js';
import { App, createAppId, createOrUpdateApp, extractAppName, extractAppVersion } from './App.js'
import { Instance, Status, createOrUpdateInstance, startInstance } from './Instance.js'
import { AppID, BackupMode, DeviceName, DiskID, DiskType, EngineID, DiskName, InstanceID, PortNumber, ServiceImage, Timestamp } from './CommonTypes.js';
import { Store, getAppsOfDisk, getInstance, getInstancesOfDisk } from './Store.js';
import { DocHandle } from '@automerge/automerge-repo';



// Disks are multi-purpose  - they can be used for engines, apps, backups, etc.

export interface BackupConfig {
    mode: BackupMode
    links: InstanceID[]
}

export interface Disk {
    id: DiskID;                   // The serial number of the disk, or a user-defined id if the disk has no serial number
    name: DiskName;               // The user-defined name of the disk.  Not necessarily unique  
    device: DeviceName | null;    // The device under /disks where this disk is mounted. null if the disk is not mounted
    created: Timestamp;           // We must use a timestamp number as Date objects are not supported in YJS
    lastDocked: Timestamp;        // We must use a timestamp number as Date objects are not supported in YJS
    dockedTo: EngineID | null;    // The engine to which this disk is currently docked. null if it is not docked to an engine
    diskTypes: DiskType[];        // Types detected for this disk (may be multiple); empty until processDisk runs
    backupConfig: BackupConfig | null;  // Set when disk is a Backup Disk; null otherwise
}


// export const getApps = (store: Store, disk: Disk): App[] => {
//     const appIds = getKeys(disk.apps) as AppID[]
//     return appIds.map(appId => getApp(store, appId))
// }


// export const findApp = (store: Store, disk: Disk, appId: AppID): App | undefined => {
//     return getApps(store, disk).find(app => app.id === appId)
// }

// Function findApp that searches for an app with the specified name and version on the specified disk
// export const findAppByNameAndVersion = (store: Store, disk: Disk, appName: AppName, version: Version): App | undefined => {
//     const appIds = Object.keys(disk.apps) as AppID[]
//     const appId = appIds.find(appId => {
//         const app = store.appDB[appId]
//         app.name === appName && app.version === version
//     })
//     if (appId) {
//         return store.appDB[appId]
//     } else {
//         return undefined
//     }
// }

// export const getInstances = (store: Store, disk: Disk): Instance[] => {
//     const instanceIds = getKeys(disk.instances) as InstanceID[]
//     return instanceIds.map(instanceId => getInstance(store, instanceId))
// }

// export const findInstance = (store: Store, disk: Disk, instanceId: InstanceID): Instance | undefined => {
//     return getInstances(store, disk).find(instance => instance.id === instanceId)
// }

// export const findInstanceOfApp = (store: Store, disk: Disk, appId: AppID): Instance | undefined => {
//     return getInstances(store, disk).find(instance => instance.instanceOf === appId)
// }
// export const findInstanceByName = (store: Store, disk: Disk, instanceName: InstanceName): Instance | undefined => {
//     const instanceIds = Object.keys(disk.instances) as InstanceID[]
//     const instanceId = instanceIds.find(instanceId => store.instanceDB[instanceId].name === instanceName)
//     if (instanceId) {
//         return store.instanceDB[instanceId]
//     } else {
//         return undefined
//     }
// }

// export const addInstance = (store: Store, disk: Disk, instance: Instance): void => {
//     log(`Updating instance ${instance.name} of disk ${disk.name}:`)
//     const existingInstance = findInstanceByName(store, disk, instance.name)
//     if (existingInstance) {
//         log(`Disk ${disk.name} already has an instance ${instance.name}. Merging the new instance with the existing instance.`)
//         Object.assign(existingInstance, instance)
//     } else {
//         //log(deepPrint(disk))
//         log(`Pushing a new instance ${instance.name} to engine ${disk.name}`)
//         disk.instances[instance.id] = true
//     }
// }




export const createOrUpdateDisk = (storeHandle: DocHandle<Store>, engineId: EngineID, device: DeviceName, diskId: DiskID, diskName: DiskName, created: Timestamp): Disk => {
    let disk: Disk
    storeHandle.change(doc => {
        let storedDisk = doc.diskDB[diskId];
        if (!storedDisk) {
            log(`Creating disk ${diskId} on engine ${engineId}`);
            disk = {
                id: diskId,
                name: diskName,
                device: device,
                dockedTo: engineId,
                created: created,
                lastDocked: new Date().getTime() as Timestamp,
                diskTypes: [],
                backupConfig: null,
            };
            doc.diskDB[diskId] = disk;
        } else {
            log(`Granularly updating disk ${diskId} on engine ${engineId}`);
            disk = storedDisk;
            disk.dockedTo = engineId;
            disk.name = diskName;
            disk.device = device;
            disk.created = created;
            disk.lastDocked = new Date().getTime() as Timestamp;
            disk.diskTypes = [];        // reset; will be repopulated by processDisk
            disk.backupConfig = null;   // reset; will be repopulated if Backup Disk
        }
    });
    return disk!; // Non-null assertion
}   

export const OLDcreateOrUpdateDisk = (storeHandle: DocHandle<Store>, engineId: EngineID, device: DeviceName, diskId: DiskID, diskName: DiskName, created: Timestamp): Disk => {
    const store: Store = storeHandle.doc()
    let storedDisk: Disk | undefined = store.diskDB[diskId]
    if (!storedDisk) {
        log(`Creating disk ${diskId} on engine ${engineId}`)
        // Create a new disk object
        const disk: Disk = {
            id: diskId,
            name: diskName,
            device: device,
            dockedTo: engineId,
            created: created,
            lastDocked: new Date().getTime() as Timestamp,
            diskTypes: [],
            backupConfig: null,
        }
        storeHandle.change(doc => {
            doc.diskDB[diskId] = disk
        })
        // enableDiskMonitor(disk)
        return disk
    } else {
        log(`Granularly updating disk ${diskId} on engine ${engineId}`)
        storeHandle.change(doc => {
            const disk = doc.diskDB[diskId]
            disk.dockedTo = engineId
            disk.name = diskName
            disk.device = device
            disk.created = created
            disk.lastDocked = new Date().getTime() as Timestamp
        })
        return store.diskDB[diskId]
    }
}   


export const processDisk = async (storeHandle: DocHandle<Store>, disk: Disk): Promise<void> => {
    log(`Processing disk ${disk.id} on engine ${disk.dockedTo}`)

    const detectedTypes: DiskType[] = []

    // System disk: root partition of the Pi itself, mounted at /.
    // Apps and instances live at /apps/<id> and /instances/<id>.
    // Must be checked first so it is not misidentified as an empty disk.
    if (isSystemDisk(disk)) {
        log(`Disk ${disk.id} is the system disk`)
        detectedTypes.push('system')
        await processSystemDisk(storeHandle, disk)
    } else {
        if (await isAppDisk(disk)) {
            log(`Disk ${disk.id} is an app disk`)
            detectedTypes.push('app')
            await processAppDisk(storeHandle, disk)
        }

        if (await isBackupDisk(disk)) {
            log(`Disk ${disk.id} is a backup disk`)
            detectedTypes.push('backup')
            // processBackupDisk is imported from backupMonitor to avoid circular deps
            const { processBackupDisk } = await import('../monitors/backupMonitor.js')
            await processBackupDisk(storeHandle, disk)
        }

        if (await isUpgradeDisk(disk)) {
            log(`Disk ${disk.id} is an upgrade disk`)
            detectedTypes.push('upgrade')
            // TODO: Implement upgrade disk processing
        }

        if (await isFilesDisk(disk)) {
            log(`Disk ${disk.id} is a files disk`)
            detectedTypes.push('files')
            // TODO: Implement files disk processing
        }

        if (detectedTypes.length === 0) {
            log(`Disk ${disk.id} is an empty disk`)
            detectedTypes.push('empty')
        }
    }

    // Persist detected types to the store
    storeHandle.change(doc => {
        const d = doc.diskDB[disk.id]
        if (d) d.diskTypes = detectedTypes
    })
}

/**
 * A system disk is the root partition of the Pi itself.
 * It is pre-identified by usbDeviceMonitor (via findmnt) and has no
 * /disks/<device> mount point — its effective mount root is /.
 * We detect it here by the absence of the /disks/<device> directory.
 */
export const isSystemDisk = (disk: Disk): boolean => {
    if (!disk.device) return false
    return !fs.existsSync(`/disks/${disk.device}`)
}

/**
 * Returns the filesystem root for a disk's app/instance directories.
 * Regular app disks mount at /disks/<device>; the system disk mounts at /.
 */
export const diskMountRoot = (disk: Disk): string => {
    return isSystemDisk(disk) ? '' : `/disks/${disk.device}`
}

/**
 * Process the system disk: scan /apps and /instances at the root filesystem.
 * Apps live at /apps/<appId>/ and instances at /instances/<instanceId>/.
 * This mirrors processAppDisk but uses / as the mount root instead of /disks/<device>/.
 */
export const processSystemDisk = async (storeHandle: DocHandle<Store>, disk: Disk): Promise<void> => {
    log(`Processing system disk ${disk.id} (mount root: /)`)

    const store: Store = storeHandle.doc()

    // Apps
    const storedApps = getAppsOfDisk(store, disk)
    const actualApps: App[] = []

    if (await $`test -d /apps`.then(() => true).catch(() => false)) {
        log(`/apps directory found on system disk ${disk.id}`)
        const appIds = (await $`ls /apps`).stdout.split('\n').filter(Boolean)
        log(`App ids on system disk: ${appIds}`)
        for (const appId of appIds) {
            const app = await processSystemApp(storeHandle, disk, appId as AppID)
            if (app) actualApps.push(app)
        }
    }

    // Remove apps no longer on disk
    storedApps.forEach(storedApp => {
        if (!actualApps.some(a => a.id === storedApp.id)) {
            removeApp(store, disk, storedApp.id)
        }
    })

    // Instances
    const storedInstances = getInstancesOfDisk(store, disk)
    const actualInstances: Instance[] = []

    if (await $`test -d /instances`.then(() => true).catch(() => false)) {
        const instanceIds = (await $`ls /instances`).stdout.split('\n').filter(Boolean)
        log(`Instance ids on system disk: ${instanceIds}`)
        for (const instanceId of instanceIds) {
            const instance = await processSystemInstance(storeHandle, disk, instanceId as InstanceID)
            if (instance) actualInstances.push(instance)
        }
    }

    // Remove instances no longer on disk
    storedInstances.forEach(storedInstance => {
        if (!actualInstances.some(i => i.id === storedInstance.id)) {
            removeInstance(storeHandle, disk, storedInstance.id)
        }
    })
}

/**
 * Process a single app on the system disk (reads from /apps/<appId>/compose.yaml).
 */
export const processSystemApp = async (storeHandle: DocHandle<Store>, disk: Disk, appId: AppID): Promise<App | undefined> => {
    try {
        const appComposeFile = await $`cat /apps/${appId}/compose.yaml`
        const appCompose = YAML.parse(appComposeFile.stdout)
        let app: App
        storeHandle.change(doc => {
            const storedApp: App | undefined = doc.appDB[appId]
            const xapp = appCompose['x-app']
            if (!storedApp) {
                log(`Creating new system app ${appId}`)
                app = {
                    id: appId,
                    name: extractAppName(appId),
                    version: extractAppVersion(appId),
                    title: xapp.title,
                    description: xapp.description ?? null,
                    url: xapp.url ?? null,
                    category: xapp.category,
                    icon: xapp.icon ?? null,
                    author: xapp.author ?? null,
                }
                doc.appDB[appId] = app
            } else {
                log(`Updating existing system app ${appId}`)
                app = storedApp
            }
        })
        return app!
    } catch (e) {
        log(`Error processing system app ${appId}: ${e}`)
        return undefined
    }
}

/**
 * Process a single instance on the system disk.
 * Reads compose.yaml from /instances/<instanceId>/ (not /disks/<device>/instances/).
 */
export const processSystemInstance = async (storeHandle: DocHandle<Store>, disk: Disk, instanceId: InstanceID): Promise<Instance | undefined> => {
    const { startInstance } = await import('./Instance.js')
    let instance: Instance | undefined
    try {
        const composeFile = await $`cat /instances/${instanceId}/compose.yaml`
        const compose = YAML.parse(composeFile.stdout)
        const services = Object.keys(compose.services)
        const serviceImages = services.map((s: string) => compose.services[s].image)
        const instanceName = compose['x-app'].instanceName
        storeHandle.change(doc => {
            const stored = doc.instanceDB[instanceId]
            if (!stored) {
                log(`Creating new system instance ${instanceId}`)
                const newInst: Instance = {
                    id: instanceId,
                    instanceOf: createAppId(compose['x-app'].name, compose['x-app'].version) as AppID,
                    name: instanceName,
                    storedOn: disk.id,
                    status: 'Docked' as Status,
                    port: 0 as PortNumber,
                    serviceImages: serviceImages as ServiceImage[],
                    created: new Date().getTime() as Timestamp,
                    lastBackup: null,
                    lastStarted: 0 as Timestamp,
                }
                doc.instanceDB[instanceId] = newInst
                instance = newInst
            } else {
                log(`Updating existing system instance ${instanceId}`)
                stored.storedOn = disk.id
                stored.status = 'Docked' as Status
                instance = stored
            }
        })
    } catch (e) {
        log(`Error processing system instance ${instanceId}: ${e}`)
        return undefined
    }
    if (instance) {
        await startInstance(storeHandle, instance, disk)
    }
    return instance
}

export const isAppDisk = async (disk: Disk): Promise<boolean> => {
    // Check if the disk has an apps folder
    try {
        await $`test -d /disks/${disk.device}/apps`;
        return true;
    } catch {
        return false;
    }
}

export const isBackupDisk = async (disk: Disk): Promise<boolean> => {
    try {
        await $`test -f /disks/${disk.device}/BACKUP.yaml`
        return true
    } catch {
        return false
    }
}

export const isUpgradeDisk = async (disk: Disk): Promise<boolean> => {
    // Create dummy code that always returns false
    // To be updated later
    return false
}

export const isFilesDisk = async (disk: Disk): Promise<boolean> => {
    // Create dummy code that always returns false
    // To be updated later
    return false
}

export const processAppDisk = async (storeHandle: DocHandle<Store>, disk: Disk): Promise<void> => {
    log(`Processing the apps and instances of App Disk ${disk.id} on device ${disk.device}`)

    const store: Store = storeHandle.doc()

    // Apps
    const storedApps = getAppsOfDisk(store, disk)
    const actualApps: App[] = []

    // Call processApp for each folder found in /disks/diskName/apps
    // First check if it has an apps folder
    if (await $`test -d /disks/${disk.device}/apps`.then(() => true).catch(() => false)) {
        log(`Apps folder found on disk ${disk.id}`)
        const appIds = (await $`ls /disks/${disk.device}/apps`).stdout.split('\n')
        log(`App ids found on disk ${disk.id}: ${appIds}`)
        for (let appId of appIds) {
            if (!(appId === "") && !(disk.device == null)) {
                const app = await processApp(storeHandle, disk, appId as AppID)
                if (app) {
                    actualApps.push(app)
                }
            }
        }
    }

    log(`Actual apps: ${actualApps.map(app => app.id)}`)
    log(`Stored apps: ${storedApps.map(app => app.id)}`)

    // Remove apps that are no longer on disk
    storedApps.forEach((storedApp) => {
        // if (!actualApps.includes(storedApp)) {
        //     removeApp(store, disk, storedApp.id)
        // }
        if (!actualApps.some(actualApp => actualApp.id === storedApp.id)) {
            removeApp(store, disk, storedApp.id)
        }
    })

    // Instances
    const storedInstances = getInstancesOfDisk(store, disk)
    const actualInstances: Instance[] = []

    // Call processInstance for each folder found in /instances
    if (await $`test -d /disks/${disk.device}/instances`.then(() => true).catch(() => false)) {
        const instanceIds = (await $`ls /disks/${disk.device}/instances`).stdout.split('\n')
        log(`Instance Ids found on disk ${disk.id}: ${instanceIds}`)
        for (let instanceId of instanceIds) {
            if (!(instanceId === "")) {
                const instance = await processInstance(storeHandle, disk, instanceId as InstanceID)
                if (instance) {
                    actualInstances.push(instance)
                }
            }
        }
    }

    log(`Actual instances: ${actualInstances.map(instance => instance.id)}`)
    log(`Stored instances: ${storedInstances.map(instance => instance.id)}`)

    // Remove instances that are no longer on disk
    storedInstances.forEach((storedInstance) => {
        if (!actualInstances.some(actualInstance => actualInstance.id === storedInstance.id)) {
            removeInstance(storeHandle, disk, storedInstance.id)
        }
    })

    // Trigger backups on any docked Backup Disk linked to instances on this App Disk
    const { checkPendingBackups } = await import('../monitors/backupMonitor.js')
    await checkPendingBackups(storeHandle, disk)
}

export const processApp = async (storeHandle: DocHandle<Store>, disk: Disk, appID: AppID): Promise<App | undefined> => {
    const app: App | undefined = await createOrUpdateApp(storeHandle, appID, disk)
    // There is nothing else that we need to do so return the app
    return app
}


export const removeApp = (store: Store, disk: Disk, appId: AppID): void => {
    log(`App ${appId} no longer found on disk ${disk.id}`)
    // There is nothing that we need to do as we do not record on which disks Apps are stored
    // However,  we need to check if there are instances of this app on the disk and signal an error if this is the case
    //   Find the instance of this app on the disk and check if it is still physically on the disk
    //   If it is, then this is an error and we should log an error message as the Instance will fail to start
    const instance = getInstancesOfDisk(store, disk).find(instance => instance.instanceOf === appId)
    // Check if the instance is still physically on the file system of the disk and signal an error
    if (instance && fs.existsSync(`/disks/${disk.device}/instances/${instance.id}`)) {
        log(`Error: Instance ${instance.id} of app ${appId} is still physically on the disk ${disk.id} but the app is being removed. This is an error and should not happen.`)
    }
}

export const processInstance = async (storeHandle: DocHandle<Store>, disk: Disk, instanceId: InstanceID): Promise<Instance | undefined> => {
    const instance = await createOrUpdateInstance(storeHandle, instanceId, disk)
    if (instance) {
        await startInstance(storeHandle, instance, disk)
    }
    return instance
}

export const removeInstance = (storeHandle: DocHandle<Store>, disk: Disk, instanceId: InstanceID): void => {
    log(`Instance ${instanceId} no longer found on disk ${disk.id}`)
    storeHandle.change(doc => {
        const instance = getInstance(doc, instanceId)
        if (instance) {
            // Mark as Missing — the instance directory is no longer on this disk (deleted or moved).
            // We preserve the instanceDB entry so that:
            //   1. Instance history is not lost.
            //   2. If the instance was moved to another disk, docking that disk will find this entry
            //      by instanceId and restore it (updating storedOn) without creating a duplicate.
            // This is distinct from 'Undocked', where the disk is simply not currently docked and
            // the instance data is known to still be physically present on it.
            instance.status = 'Missing' as Status
            instance.storedOn = null
        }
    })
}





