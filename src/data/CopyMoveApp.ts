/**
 * CopyMoveApp.ts — copyApp and moveApp command implementations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine only. Both source and target disks must be docked to
 * the local engine. Cross-engine (remote rsync) is deferred to phase 2.
 */

import { chalk, fs, $ } from 'zx'
import { log } from '../utils/utils.js'
import { rsyncDirectory } from '../utils/rsync.js'
import {
    InstanceID, DiskID, DiskName, InstanceName, Timestamp,
    OperationKind
} from './CommonTypes.js'
import { Store, findDiskByName, getDisk, getInstance, getInstancesOfDisk } from './Store.js'
import { Disk, processInstance } from './Disk.js'
import { stopInstance, startInstance } from './Instance.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'
import { createOperation, updateOperation } from './Operations.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'

// ── Disk free-space check ─────────────────────────────────────────────────────

/**
 * Returns available bytes on the filesystem containing `path`.
 * Exported so tests can mock it.
 */
export const availableBytes = async (path: string): Promise<number> => {
    // df -k outputs 1K-blocks; Available is column 4
    const result = await $`df -k ${path} | awk 'NR==2{print $4}'`
    const kb = parseInt(result.stdout.trim(), 10)
    return kb * 1024
}

/**
 * Returns total size in bytes of `path` (recursive).
 * Exported so tests can mock it.
 */
export const directoryBytes = async (path: string): Promise<number> => {
    const result = await $`du -sk ${path} | awk '{print $1}'`
    const kb = parseInt(result.stdout.trim(), 10)
    return kb * 1024
}

// ── Shared validation ─────────────────────────────────────────────────────────

interface ValidatedCopyMove {
    instance: ReturnType<typeof getInstance> & {}
    sourceDisk: Disk
    targetDisk: Disk
    appId: string
    sourceDevice: string
    targetDevice: string
    appMasterSrc: string
    instanceSrc: string
}

const validate = async (
    store: Store,
    instanceName: InstanceName,
    sourceDiskName: DiskName,
    targetDiskName: DiskName
): Promise<ValidatedCopyMove | string> => {
    // Look up instance — search all (not just Running) so we can copy stopped instances too
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) return `Instance '${instanceName}' not found`

    const sourceDisk = (findDiskByName(store, sourceDiskName)
        ?? Object.values(store.diskDB).find(d => d.name === sourceDiskName)) as Disk | undefined
    if (!sourceDisk) return `Source disk '${sourceDiskName}' not found`
    if (!sourceDisk.device) return `Source disk '${sourceDiskName}' is not docked`

    const targetDisk = (findDiskByName(store, targetDiskName)
        ?? Object.values(store.diskDB).find(d => d.name === targetDiskName)) as Disk | undefined
    if (!targetDisk) return `Target disk '${targetDiskName}' not found`
    if (!targetDisk.device) return `Target disk '${targetDiskName}' is not docked`

    if (sourceDisk.id === targetDisk.id) return `Source and target disk are the same`

    if (instance.storedOn !== sourceDisk.id) {
        return `Instance '${instanceName}' is not stored on disk '${sourceDiskName}'`
    }

    const sourceDevice = sourceDisk.device
    const targetDevice = targetDisk.device

    // Locate app master: /disks/<src>/apps/<appId>/
    const appsDir = `/disks/${sourceDevice}/apps`
    let appId: string | null = null
    if (await fs.pathExists(appsDir)) {
        const entries = await fs.readdir(appsDir)
        appId = entries.find(e => instance.instanceOf.startsWith(e) || e === instance.instanceOf) ?? null
        // instanceOf is <appName>-<version>; the apps/ dir entry IS that appId
        if (!appId) appId = instance.instanceOf as string
    }
    if (!appId) return `App master for '${instance.instanceOf}' not found on source disk`

    const appMasterSrc = `/disks/${sourceDevice}/apps/${appId}`
    const instanceSrc = `/disks/${sourceDevice}/instances/${instance.id}`

    if (!await fs.pathExists(appMasterSrc)) return `App master directory not found: ${appMasterSrc}`
    if (!await fs.pathExists(instanceSrc)) return `Instance directory not found: ${instanceSrc}`

    return { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc }
}

// ── copyApp ───────────────────────────────────────────────────────────────────

/**
 * Copy an app instance from sourceDisk to targetDisk.
 * The copy receives a fresh InstanceID — it is a brand new instance.
 * The original keeps running (it is stopped during the file copy, then restarted).
 */
export const copyApp = async (
    storeHandle: DocHandle<Store>,
    instanceName: InstanceName,
    sourceDiskName: DiskName,
    targetDiskName: DiskName
): Promise<void> => {
    const store = storeHandle.doc()

    const v = await validate(store, instanceName, sourceDiskName, targetDiskName)
    if (typeof v === 'string') {
        console.error(chalk.red(`copyApp: ${v}`))
        return
    }
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc } = v

    // Acquire per-resource locks: source instance + target disk
    const lockKeys = [instanceKey(instance.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(lockKeys, 'copyApp')) {
        console.error(chalk.red(`copyApp: resource locked — another operation is already running on instance '${instanceName}' or target disk '${targetDisk.name}'. Retry when it completes.`))
        return
    }

    const opId = createOperation(storeHandle, 'copyApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
    })

    const newInstanceId = uuid() as InstanceID
    let wasRunning = false

    try {
        // 1. Stop source instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            wasRunning = true
            log(`copyApp: stopping instance '${instanceName}' for consistent snapshot`)
            await stopInstance(storeHandle, instance, sourceDisk)
        }

        updateOperation(storeHandle, opId, { status: 'Running' })

        // 2. Check free space
        const needed = await directoryBytes(appMasterSrc) + await directoryBytes(instanceSrc)
        const available = await availableBytes(`/disks/${targetDevice}`)
        if (available < needed) {
            throw new Error(
                `Not enough space on '${targetDiskName}': need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                `have ${Math.ceil(available / 1024 / 1024)}MB`
            )
        }

        // 3. Ensure target directory structure
        await fs.ensureDir(`/disks/${targetDevice}/apps`)
        await fs.ensureDir(`/disks/${targetDevice}/instances`)
        await fs.ensureDir(`/disks/${targetDevice}/services`)

        // 4. rsync app master (idempotent — skips if already present and identical)
        const appMasterDest = `/disks/${targetDevice}/apps/${appId}`
        log(`copyApp: syncing app master ${appMasterSrc} → ${appMasterDest}`)
        await rsyncDirectory(appMasterSrc, appMasterDest, ({ progressPercent }) => {
            // app master typically small — report first half of progress
            updateOperation(storeHandle, opId, { progressPercent: Math.round(progressPercent * 0.4) })
        })

        // 5. rsync instance data into a NEW instance directory (new ID)
        const instanceDest = `/disks/${targetDevice}/instances/${newInstanceId}`
        await fs.ensureDir(instanceDest)
        log(`copyApp: syncing instance data ${instanceSrc} → ${instanceDest}`)
        await rsyncDirectory(instanceSrc, instanceDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: 40 + Math.round(progressPercent * 0.55) })
        })

        // 6. Register the new instance in the store and start it
        log(`copyApp: registering new instance ${newInstanceId} on disk '${targetDiskName}'`)
        await processInstance(storeHandle, targetDisk, newInstanceId)

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`copyApp: done — new instance ${newInstanceId} on '${targetDiskName}'`))

    } catch (e: any) {
        updateOperation(storeHandle, opId, {
            status: 'Failed',
            error: e.message ?? String(e),
            completedAt: Date.now() as Timestamp,
        })
        console.error(chalk.red(`copyApp: failed — ${e.message ?? e}`))
    } finally {
        resourceLock.releaseAll(lockKeys)
        // Always restart source instance if we stopped it
        if (wasRunning) {
            try {
                const freshStore = storeHandle.doc()
                const freshInstance = getInstance(freshStore, instance.id)
                if (freshInstance) {
                    log(`copyApp: restarting source instance '${instanceName}'`)
                    await startInstance(storeHandle, freshInstance, sourceDisk)
                }
            } catch (restartErr: any) {
                console.error(chalk.red(`copyApp: failed to restart source instance: ${restartErr.message}`))
            }
        }
    }
}

// ── moveApp ───────────────────────────────────────────────────────────────────

/**
 * Move an app instance from sourceDisk to targetDisk.
 * The instance retains its original InstanceID so backup links remain intact.
 * The source instance directory and (if no other instance needs it) app master
 * are removed after a successful copy.
 */
export const moveApp = async (
    storeHandle: DocHandle<Store>,
    instanceName: InstanceName,
    sourceDiskName: DiskName,
    targetDiskName: DiskName
): Promise<void> => {
    const store = storeHandle.doc()

    const v = await validate(store, instanceName, sourceDiskName, targetDiskName)
    if (typeof v === 'string') {
        console.error(chalk.red(`moveApp: ${v}`))
        return
    }
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc } = v

    // Acquire per-resource locks: instance + both disks
    const moveLockKeys = [instanceKey(instance.id), diskKey(sourceDisk.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(moveLockKeys, 'moveApp')) {
        console.error(chalk.red(`moveApp: resource locked — another operation is already running on instance '${instanceName}' or one of its disks. Retry when it completes.`))
        return
    }

    const opId = createOperation(storeHandle, 'moveApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
    })

    let wasRunning = false

    try {
        // 1. Stop source instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            wasRunning = true
            log(`moveApp: stopping instance '${instanceName}'`)
            await stopInstance(storeHandle, instance, sourceDisk)
        }

        updateOperation(storeHandle, opId, { status: 'Running' })

        // 2. Check free space
        const needed = await directoryBytes(appMasterSrc) + await directoryBytes(instanceSrc)
        const available = await availableBytes(`/disks/${targetDevice}`)
        if (available < needed) {
            throw new Error(
                `Not enough space on '${targetDiskName}': need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                `have ${Math.ceil(available / 1024 / 1024)}MB`
            )
        }

        // 3. Ensure target directory structure
        await fs.ensureDir(`/disks/${targetDevice}/apps`)
        await fs.ensureDir(`/disks/${targetDevice}/instances`)
        await fs.ensureDir(`/disks/${targetDevice}/services`)

        // 4. rsync app master
        const appMasterDest = `/disks/${targetDevice}/apps/${appId}`
        log(`moveApp: syncing app master ${appMasterSrc} → ${appMasterDest}`)
        await rsyncDirectory(appMasterSrc, appMasterDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: Math.round(progressPercent * 0.4) })
        })

        // 5. rsync instance data — same instance ID, new location
        const instanceDest = `/disks/${targetDevice}/instances/${instance.id}`
        await fs.ensureDir(instanceDest)
        log(`moveApp: syncing instance data ${instanceSrc} → ${instanceDest}`)
        await rsyncDirectory(instanceSrc, instanceDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: 40 + Math.round(progressPercent * 0.55) })
        })

        // 6. Register on target disk (updates storedOn, starts instance)
        log(`moveApp: registering instance ${instance.id} on disk '${targetDiskName}'`)
        await processInstance(storeHandle, targetDisk, instance.id)

        // 7. Mark source disk's record of this instance as Missing in store.
        //    Do this BEFORE checking remaining instances so getInstancesOfDisk
        //    no longer counts this instance when deciding whether to delete the app master.
        storeHandle.change(doc => {
            const inst = doc.instanceDB[instance.id]
            if (inst) {
                inst.status = 'Missing'
                inst.storedOn = null
            }
        })

        // 8. Remove source instance directory
        log(`moveApp: removing source instance directory ${instanceSrc}`)
        await fs.remove(instanceSrc)

        // 9. Remove source app master only if no other instance on the source disk uses it
        const remainingInstances = getInstancesOfDisk(storeHandle.doc(), sourceDisk)
        const stillNeedsAppMaster = remainingInstances.some(i => i.instanceOf === appId)
        if (!stillNeedsAppMaster) {
            log(`moveApp: removing app master ${appMasterSrc} (no other instances on source disk)`)
            await fs.remove(appMasterSrc)
        } else {
            log(`moveApp: keeping app master ${appMasterSrc} (other instances still use it)`)
        }

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`moveApp: done — instance ${instance.id} moved to '${targetDiskName}'`))

    } catch (e: any) {
        updateOperation(storeHandle, opId, {
            status: 'Failed',
            error: e.message ?? String(e),
            completedAt: Date.now() as Timestamp,
        })
        console.error(chalk.red(`moveApp: failed — ${e.message ?? e}`))

        // On failure, try to restart the source instance if we stopped it
        if (wasRunning) {
            try {
                const freshStore = storeHandle.doc()
                const freshInstance = getInstance(freshStore, instance.id)
                if (freshInstance) {
                    log(`moveApp: restarting source instance '${instanceName}' after failure`)
                    await startInstance(storeHandle, freshInstance, sourceDisk)
                }
            } catch (restartErr: any) {
                console.error(chalk.red(`moveApp: failed to restart source instance: ${restartErr.message}`))
            }
        }
    } finally {
        resourceLock.releaseAll(moveLockKeys)
    }
}

// recoverInterruptedOperations moved to Operations.ts
export { recoverInterruptedOperations } from './Operations.js'
