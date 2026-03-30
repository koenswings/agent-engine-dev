import { $, YAML, chalk, fs, os } from 'zx';
import { deepPrint, log } from '../utils/utils.js';
import { App, createOrUpdateApp } from './App.js'
import { Instance, Status, createOrUpdateInstance, startInstance } from './Instance.js'
import { AppID, DeviceName, DiskID, EngineID, DiskName, InstanceID, Timestamp } from './CommonTypes.js';
import { Store, getAppsOfDisk, getInstance, getInstancesOfDisk } from './Store.js';
import { DocHandle } from '@automerge/automerge-repo';



// Disks are multi-purpose  - they can be used for engines, apps, backups, etc.

export interface Disk {
    id: DiskID;                   // The serial number of the disk, or a user-defined id if the disk has no serial number
    name: DiskName;               // The user-defined name of the disk.  Not necessarily unique  
    device: DeviceName | null;    // The device under /disks where this disk is mounted. null if the disk is not mounted
    created: Timestamp;           // We must use a timestamp number as Date objects are not supported in YJS
    lastDocked: Timestamp;        // We must use a timestamp number as Date objects are not supported in YJS
    dockedTo: EngineID | null;    // The engine to which this disk is currently docked. null if it is not docked to an engine
    // apps: { [key: AppID]: boolean };
    // instances: { [key: InstanceID]: boolean };
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
                lastDocked: new Date().getTime() as Timestamp
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
            lastDocked: new Date().getTime() as Timestamp
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

    const store: Store = storeHandle.doc()
    // Check if the disk is an app disk, backup disk, upgrade disk, or files disk and perform the necessary actions
    // NOTE: we currently allow Disks to be multi-purpose and be used for apps, backups, upgrades, etc. This might change in the 
    // future towards a model in which Disks are only used for one purpose
    
    // Check if the disk is an app disk
    if (await isAppDisk(disk)) {
        log(`Disk ${disk.id} is an app disk`)   
        await processAppDisk(storeHandle, disk)
    }

    // Check if the disk is a backup disk
    if (await isBackupDisk(disk)) {
        log(`Disk ${disk.id} is a backup disk`)
        // TODO: Implement backup disk processing
        // -  Read the backup configuration from the disk
        // -  Perform the backup if the backup type is IMMEDIATE
        // -  Schedule the backup if the backup type is SCHEDULED
    }

    // Check if the disk is an upgrade disk
    if (await isUpgradeDisk(disk)) {
        log(`Disk ${disk.id} is an upgrade disk`)
        // TODO: Implement upgrade disk processing
        // - Execute the upgrade script if the disk is an upgrade disk
    }

    // Check if the disk is a files disk
    if (await isFilesDisk(disk)) {
        log(`Disk ${disk.id} is a files disk`)
        // TODO: Implement files disk processing
        // - Do a network mount of the files on the disk
    }

    // If the disk is not an app disk, backup disk, upgrade disk, or files disk, itis a freshly created empty disk
    // Just log it
    if (!(await isAppDisk(disk) || await isBackupDisk(disk) || await isUpgradeDisk(disk) || await isFilesDisk(disk))) {
        log(`Disk ${disk.id} is an empty disk`)
    }
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
    // Create dummy code that always returns false
    // To be updated later
    return false
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
        // if (!actualInstances.includes(storedInstance)) {
        //     removeInstance(storeHandle, disk, storedInstance.id)
        // }
        if (!actualInstances.some(actualInstance => actualInstance.id === storedInstance.id)) {
            removeInstance(storeHandle, disk, storedInstance.id)
        }
    })
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
            instance.status = 'Undocked' as Status // Set the status to Undocked when the instance is removed
            instance.storedOn = null // Clear the storedOn property
            // Remove the instance from the instanceDB
            delete doc.instanceDB[instanceId]
        }
    })
}





