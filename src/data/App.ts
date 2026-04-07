import { $, YAML, chalk, fs } from 'zx';
import { Version, URL, AppID, AppName, Hostname, DeviceName, DiskName, DiskID, Operation, OperationStatus, Timestamp, InstanceID } from './CommonTypes.js';
import { log, uuid } from '../utils/utils.js';
import { Store, getDisk, getInstancesOfDisk } from './Store.js';
import { Disk } from './Disk.js';
import { DocHandle } from '@automerge/automerge-repo';
import { rsyncDirectory } from '../utils/rsync.js';
import { createInstanceId, createOrUpdateInstance, stopInstance } from './Instance.js';
import { processAppDisk } from './Disk.js';
import { localEngineId } from './Engine.js';

export interface App {
    id: AppID;
    name: AppName;
    version: Version;
    title: string;
    description: string | null;
    url: URL | null;
    category: AppCategory;
    icon: URL | null;
    author: string | null;
}

type AppCategory = 'Productivity' | 'Utilities' | 'Games' | 'education' | 'office' | 'it' | string;

export const createAppId = (appName: AppName, version: Version): AppID => {
    return appName + "-" + version as AppID
}

export const extractAppName = (appId: AppID): AppName => {
    // Use lastIndexOf so hyphenated names like 'kolibri-with-plugins-1.0' work correctly.
    // The convention is: last hyphen separates the name from the version.
    return appId.slice(0, appId.lastIndexOf('-')) as AppName
}

export const extractAppVersion = (appId: AppID): Version => {
    // Use lastIndexOf so hyphenated names like 'kolibri-with-plugins-1.0' work correctly.
    return appId.slice(appId.lastIndexOf('-') + 1) as Version
}

/**
 * Returns the major version number from an appId (e.g. 'sample-1.0' → 1).
 * Major-only comparison is sufficient for current apps: all versions use
 * integer-major style (1.x, 2.x). No 0.x or pre-release versions in use.
 */
export const extractMajorVersion = (appId: AppID): number => {
    const version = extractAppVersion(appId)   // e.g. "1.0"
    return parseInt(version.split('.')[0], 10)
}

/**
 * Returns true if docking newAppId onto a disk that already has an instance
 * of oldAppId represents a major (breaking) version change.
 *
 * Major upgrade (1.x → 2.x): engine blocks instance startup — the operator
 * must explicitly migrate data before the new version can run.
 *
 * Minor upgrade (1.0 → 1.1): allowed — engine restarts the instance with the
 * new version automatically.
 */
export const isMajorUpgrade = (oldAppId: AppID, newAppId: AppID): boolean => {
    if (oldAppId === newAppId) return false
    return extractMajorVersion(oldAppId) !== extractMajorVersion(newAppId)
}

export const createOrUpdateApp = async (storeHandle: DocHandle<Store>, appId: AppID, disk: Disk) => {
    const store: Store = storeHandle.doc()
    const device: DeviceName = disk.device as DeviceName;
    const diskID: DiskID = disk.id as DiskID;
    let app: App;
    try {
        // The full name of the app is <appName>-<version>
        const appName = extractAppName(appId)
        const appVersion = extractAppVersion(appId)

        // Read the compose.yaml file in the app folder
        const appComposeFile = await $`cat /disks/${device}/apps/${appId}/compose.yaml`
        const appCompose = YAML.parse(appComposeFile.stdout)
        storeHandle.change(doc => {
            const storedApp: App | undefined = doc.appDB[appId]
            // Automerge rejects undefined — use null for absent optional fields
            const xapp = appCompose['x-app']
            if (!storedApp) {
                // Create a new app object
                log(chalk.green(`Creating new app ${appId} on disk ${diskID}`))
                app = {
                    id: appId as AppID,
                    name: appName,
                    version: appVersion,
                    title: xapp.title,
                    description: xapp.description ?? null,
                    url: xapp.url ?? null,
                    category: xapp.category,
                    icon: xapp.icon ?? null,
                    author: xapp.author ?? null
                }
                // Store the new app object in the store
                doc.appDB[appId] = app
            } else {
                // Granularly update the existing app object
                log(chalk.green(`Granularly updating existing app ${appId} on disk ${diskID}`))
                app = storedApp
                app.name = appName
                app.version = appVersion
                app.title = xapp.title
                app.description = xapp.description ?? null
                app.url = xapp.url ?? null
                app.category = xapp.category
                app.icon = xapp.icon ?? null
                app.author = xapp.author ?? null
            }
        })
    return app!
    } catch (e) {
        log(chalk.red(`Error initializing instance ${appId} on disk ${disk.id}`))
        console.error(e)
        return undefined
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operation helpers
// ─────────────────────────────────────────────────────────────────────────────

const createOperation = (
    storeHandle: DocHandle<Store>,
    kind: Operation['kind'],
    args: { [key: string]: string }
): string => {
    const id = uuid()
    storeHandle.change(doc => {
        doc.operationDB[id] = {
            id,
            kind,
            args,
            engineId: localEngineId,
            status: 'Pending',
            progressPercent: null,
            startedAt: Date.now() as Timestamp,
            completedAt: null,
            error: null,
        }
    })
    return id
}

const updateOperation = (
    storeHandle: DocHandle<Store>,
    id: string,
    patch: Partial<Pick<Operation, 'status' | 'progressPercent' | 'error' | 'completedAt'>>
): void => {
    storeHandle.change(doc => {
        const op = doc.operationDB[id]
        if (!op) return
        if (patch.status !== undefined) op.status = patch.status
        if (patch.progressPercent !== undefined) op.progressPercent = patch.progressPercent
        if (patch.error !== undefined) op.error = patch.error
        if (patch.completedAt !== undefined) op.completedAt = patch.completedAt
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// copyApp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copies an app instance from one docked disk to another on the same engine.
 * The copy receives a new InstanceID. The source instance is stopped during
 * the copy and restarted afterwards.
 * Progress is tracked in operationDB so the Console can observe it reactively.
 */
export const copyApp = async (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    sourceDiskId: DiskID,
    targetDiskId: DiskID
): Promise<void> => {
    const store = storeHandle.doc()
    const sourceDisk = getDisk(store, sourceDiskId)
    const targetDisk = getDisk(store, targetDiskId)

    if (!sourceDisk?.device) throw new Error(`Source disk ${sourceDiskId} not docked`)
    if (!targetDisk?.device) throw new Error(`Target disk ${targetDiskId} not docked`)

    const instance = store.instanceDB[instanceId]
    if (!instance) throw new Error(`Instance ${instanceId} not found`)

    const opId = createOperation(storeHandle, 'copyApp', {
        instanceId,
        sourceDiskId,
        targetDiskId,
    })

    let wasRunning = false
    try {
        // 1. Stop instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            log(`copyApp: stopping instance ${instanceId} before copy`)
            wasRunning = true
            await stopInstance(storeHandle, instance, sourceDisk)
        }

        // 2. Read compose.yaml for app name + version
        const composeRaw = (await $`cat /disks/${sourceDisk.device}/instances/${instanceId}/compose.yaml`).stdout
        const compose = YAML.parse(composeRaw)
        const appName = compose['x-app'].name as AppName
        const appVersion = compose['x-app'].version as Version
        const appMasterDir = `${appName}-${appVersion}`

        // 3. New instance ID for the copy
        const newInstanceId = createInstanceId(appName)
        log(`copyApp: new instance ID = ${newInstanceId}`)

        updateOperation(storeHandle, opId, { status: 'Running', progressPercent: 0 })

        // 4. Check disk space
        const instanceSizeKb = parseInt((await $`du -sk /disks/${sourceDisk.device}/instances/${instanceId}`).stdout.split('\t')[0], 10)
        const targetFreeKb = parseInt((await $`df -k /disks/${targetDisk.device} --output=avail | tail -1`).stdout.trim(), 10)
        if (instanceSizeKb * 1.1 > targetFreeKb) {
            throw new Error(`Insufficient space on target disk ${targetDiskId}: need ~${instanceSizeKb}KB, have ${targetFreeKb}KB`)
        }

        // 5. rsync app master dir (skip if already present on target)
        const srcMaster = `/disks/${sourceDisk.device}/apps/${appMasterDir}`
        const destMaster = `/disks/${targetDisk.device}/apps/${appMasterDir}`
        if (!fs.existsSync(destMaster)) {
            log(`copyApp: rsyncing app master ${appMasterDir}`)
            await rsyncDirectory(srcMaster, destMaster, p => {
                updateOperation(storeHandle, opId, { progressPercent: Math.round(p.progressPercent * 0.4) })
            })
        } else {
            log(`copyApp: app master ${appMasterDir} already present on target, skipping`)
        }

        // 6. rsync instance dir into new instance dir
        const srcInstance = `/disks/${sourceDisk.device}/instances/${instanceId}`
        const destInstance = `/disks/${targetDisk.device}/instances/${newInstanceId}`
        await rsyncDirectory(srcInstance, destInstance, p => {
            updateOperation(storeHandle, opId, { progressPercent: 40 + Math.round(p.progressPercent * 0.5) })
        })

        // 7. Patch compose.yaml in the copy: update x-app.instanceId to new ID
        const newComposePath = `${destInstance}/compose.yaml`
        const newComposeRaw = (await $`cat ${newComposePath}`).stdout
        const newCompose = YAML.parse(newComposeRaw)
        if (newCompose['x-app']?.instanceId !== undefined) {
            newCompose['x-app'].instanceId = newInstanceId
        }
        await $`echo ${YAML.stringify(newCompose)} > ${newComposePath}`

        // 8. Re-process target disk so new instance appears in store
        updateOperation(storeHandle, opId, { progressPercent: 95 })
        await processAppDisk(storeHandle, targetDisk)

        updateOperation(storeHandle, opId, { status: 'Done', progressPercent: 100, completedAt: Date.now() as Timestamp })
        log(`copyApp: done — new instance ${newInstanceId} on disk ${targetDiskId}`)
    } catch (e: any) {
        updateOperation(storeHandle, opId, { status: 'Failed', error: String(e), completedAt: Date.now() as Timestamp })
        log(chalk.red(`copyApp failed: ${e}`))
        throw e
    } finally {
        // 9. Restart source instance if it was running before
        if (wasRunning) {
            const refreshedDisk = getDisk(storeHandle.doc(), sourceDiskId)
            if (refreshedDisk?.device) {
                log(`copyApp: restarting source instance ${instanceId}`)
                await $`docker compose -f /disks/${refreshedDisk.device}/instances/${instanceId}/compose.yaml up -d`.catch(err => {
                    log(chalk.yellow(`copyApp: could not restart source instance: ${err}`))
                })
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// moveApp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Moves an app instance from one docked disk to another on the same engine.
 * The moved instance retains its InstanceID (preserving backup disk links).
 * Source instance dir is removed only after copy is confirmed successful.
 * Source app master dir is removed if no other instance on that disk uses it.
 */
export const moveApp = async (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    sourceDiskId: DiskID,
    targetDiskId: DiskID
): Promise<void> => {
    const store = storeHandle.doc()
    const sourceDisk = getDisk(store, sourceDiskId)
    const targetDisk = getDisk(store, targetDiskId)

    if (!sourceDisk?.device) throw new Error(`Source disk ${sourceDiskId} not docked`)
    if (!targetDisk?.device) throw new Error(`Target disk ${targetDiskId} not docked`)

    const instance = store.instanceDB[instanceId]
    if (!instance) throw new Error(`Instance ${instanceId} not found`)

    const opId = createOperation(storeHandle, 'moveApp', {
        instanceId,
        sourceDiskId,
        targetDiskId,
    })

    try {
        // 1. Stop instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            log(`moveApp: stopping instance ${instanceId}`)
            await stopInstance(storeHandle, instance, sourceDisk)
        }

        // 2. Read compose.yaml for app name + version
        const composeRaw = (await $`cat /disks/${sourceDisk.device}/instances/${instanceId}/compose.yaml`).stdout
        const compose = YAML.parse(composeRaw)
        const appName = compose['x-app'].name as AppName
        const appVersion = compose['x-app'].version as Version
        const appMasterDir = `${appName}-${appVersion}`

        updateOperation(storeHandle, opId, { status: 'Running', progressPercent: 0 })

        // 3. Check disk space
        const instanceSizeKb = parseInt((await $`du -sk /disks/${sourceDisk.device}/instances/${instanceId}`).stdout.split('\t')[0], 10)
        const targetFreeKb = parseInt((await $`df -k /disks/${targetDisk.device} --output=avail | tail -1`).stdout.trim(), 10)
        if (instanceSizeKb * 1.1 > targetFreeKb) {
            throw new Error(`Insufficient space on target disk ${targetDiskId}: need ~${instanceSizeKb}KB, have ${targetFreeKb}KB`)
        }

        // 4. rsync app master dir if not already on target
        const srcMaster = `/disks/${sourceDisk.device}/apps/${appMasterDir}`
        const destMaster = `/disks/${targetDisk.device}/apps/${appMasterDir}`
        if (!fs.existsSync(destMaster)) {
            log(`moveApp: rsyncing app master ${appMasterDir}`)
            await rsyncDirectory(srcMaster, destMaster, p => {
                updateOperation(storeHandle, opId, { progressPercent: Math.round(p.progressPercent * 0.4) })
            })
        } else {
            log(`moveApp: app master ${appMasterDir} already present on target, skipping`)
        }

        // 5. rsync instance dir (same ID — no compose patch needed)
        const srcInstance = `/disks/${sourceDisk.device}/instances/${instanceId}`
        const destInstance = `/disks/${targetDisk.device}/instances/${instanceId}`
        await rsyncDirectory(srcInstance, destInstance, p => {
            updateOperation(storeHandle, opId, { progressPercent: 40 + Math.round(p.progressPercent * 0.5) })
        })

        // 6. Verify copy: list dest dir — if ls fails or returns empty, copy is incomplete
        let destFiles: string
        try {
            destFiles = (await $`ls ${destInstance}`).stdout.trim()
        } catch {
            destFiles = ''
        }
        if (!destFiles) {
            throw new Error(`Copy verification failed: ${destInstance} is missing or empty`)
        }

        updateOperation(storeHandle, opId, { progressPercent: 95 })

        // 7. Re-process target disk
        await processAppDisk(storeHandle, targetDisk)

        // 8. Remove source instance dir (copy confirmed)
        log(`moveApp: removing source instance dir ${srcInstance}`)
        await $`rm -rf ${srcInstance}`
        storeHandle.change(doc => {
            const inst = doc.instanceDB[instanceId]
            if (inst) inst.status = 'Missing'
        })

        // 9. Remove source app master if no other instance on source disk uses it
        const remainingInstances = getInstancesOfDisk(storeHandle.doc(), sourceDisk)
        const masterStillNeeded = remainingInstances.some(inst =>
            inst.id !== instanceId &&
            inst.instanceOf === (`${appName}-${appVersion}` as AppID)
        )
        if (!masterStillNeeded) {
            log(`moveApp: no other instances use master ${appMasterDir} on source — removing`)
            await $`rm -rf ${srcMaster}`
        } else {
            log(`moveApp: other instances still use master ${appMasterDir} — keeping`)
        }

        updateOperation(storeHandle, opId, { status: 'Done', progressPercent: 100, completedAt: Date.now() as Timestamp })
        log(`moveApp: done — instance ${instanceId} moved to disk ${targetDiskId}`)
    } catch (e: any) {
        updateOperation(storeHandle, opId, { status: 'Failed', error: String(e), completedAt: Date.now() as Timestamp })
        log(chalk.red(`moveApp failed: ${e}`))
        throw e
    }
}
