/**
 * CopyMoveApp.ts — copyApp and moveApp command implementations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine — source and target on local engine.
 * Phase 2: cross-engine — source on local engine, target on remote engine;
 *   rsync over SSH, remote start via sendCommand.
 */

import { chalk, fs, $ } from 'zx'
import { log } from '../utils/utils.js'
import { rsyncDirectory } from '../utils/rsync.js'
import {
    InstanceID, DiskID, DiskName, InstanceName, Timestamp,
    OperationKind, OperationCause, ServiceImage
} from './CommonTypes.js'
import { Store, getDisk, getInstance, getInstancesOfDisk } from './Store.js'
import { Disk, processInstance, diskMountRoot, diskFsRoot } from './Disk.js'
import { stopInstance, startInstance } from './Instance.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'
import { createOperation, updateOperation } from './Operations.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { sendCommand } from '../utils/commandUtils.js'
import { getEngineAddress } from './Network.js'
import { Instance, Status } from './Instance.js'
import { IPAddress } from './CommonTypes.js'
import os from 'os'

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
    sourceDiskId: DiskID,
    targetDiskId: DiskID
): Promise<ValidatedCopyMove | string> => {
    // Look up instance — search all (not just Running) so we can copy stopped instances too
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) return `Instance '${instanceName}' not found`

    const sourceDisk = getDisk(store, sourceDiskId) as Disk | undefined
    if (!sourceDisk) return `Source disk '${sourceDiskId}' not found`
    if (!sourceDisk.device) return `Source disk '${sourceDiskId}' is not docked`

    const targetDisk = getDisk(store, targetDiskId) as Disk | undefined
    if (!targetDisk) return `Target disk '${targetDiskId}' not found`
    if (!targetDisk.device) return `Target disk '${targetDiskId}' is not docked`

    if (sourceDisk.id === targetDisk.id) return `Source and target disk are the same`

    // Source must always be local — we rsync FROM local paths.
    const { localEngineId } = await import('./Engine.js')
    if (String(sourceDisk.dockedTo) !== String(localEngineId)) {
        return `Source disk '${sourceDisk.name}' is docked to a remote engine. Copy/move must be initiated from that engine.`
    }

    // Target may be local or remote (cross-engine Phase 2).
    // If remote, validate that the engine is reachable (has an address in network.connections).
    if (String(targetDisk.dockedTo) !== String(localEngineId)) {
        const targetEngineId = targetDisk.dockedTo!
        const remoteAddress = getEngineAddress(targetEngineId as any)
        if (!remoteAddress) {
            return `Target engine '${targetEngineId}' is not currently reachable (not in network connections). Ensure it is online and connected.`
        }
    }

    if (String(instance.storedOn) !== String(sourceDisk.id)) {
        return `Instance '${instanceName}' is not stored on disk '${sourceDiskId}'`
    }

    const sourceDevice = sourceDisk.device
    const targetDevice = targetDisk.device

    // Locate app master: <mountRoot>/apps/<appId>/
    const sourceMountRoot = await diskMountRoot(sourceDisk)
    const appsDir = `${sourceMountRoot}/apps`
    let appId: string | null = null
    if (await fs.pathExists(appsDir)) {
        const entries = await fs.readdir(appsDir)
        appId = entries.find(e => instance.instanceOf.startsWith(e) || e === instance.instanceOf) ?? null
        // instanceOf is <appName>-<version>; the apps/ dir entry IS that appId
        if (!appId) appId = instance.instanceOf as string
    }
    if (!appId) return `App master for '${instance.instanceOf}' not found on source disk`

    const appMasterSrc = `${sourceMountRoot}/apps/${appId}`
    const instanceSrc = `${sourceMountRoot}/instances/${instance.id}`

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
    sourceDiskId: DiskID,
    targetDiskId: DiskID,
    cause: OperationCause = 'console-command',
): Promise<void> => {
    const store = storeHandle.doc()

    const v = await validate(store, instanceName, sourceDiskId, targetDiskId)
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
    }, cause, { type: 'instance', id: instance.id })

    const newInstanceId = uuid() as InstanceID
    let wasRunning = false

    // Detect cross-engine: target disk is on a different engine
    const { localEngineId } = await import('./Engine.js')
    const isCrossEngine = String(targetDisk.dockedTo) !== String(localEngineId)
    const remoteAddress = isCrossEngine
        ? getEngineAddress(targetDisk.dockedTo as any) as string
        : undefined

    // ── step definitions ──────────────────────────────────────────────────────
    const COPY_STEPS = [
        'Stopping instance',          // 0
        'Checking free space',        // 1
        'Syncing app master',         // 2
        'Syncing instance data',      // 3
        'Syncing service images',     // 4
        'Registering on target disk', // 5
    ]
    const setCopyStep = (step: number) =>
        updateOperation(storeHandle, opId, { currentStep: step, totalSteps: COPY_STEPS.length, stepLabel: COPY_STEPS[step] })

    try {
        // 1. Stop source instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            wasRunning = true
            log(`copyApp: stopping instance '${instanceName}' for consistent snapshot`)
            setCopyStep(0)
            await stopInstance(storeHandle, instance, sourceDisk, 'post-copy')
        }

        updateOperation(storeHandle, opId, { status: 'Running' })

        // 2. Check free space (local only — skip for cross-engine)
        setCopyStep(1)
        if (!isCrossEngine) {
            const needed = await directoryBytes(appMasterSrc) + await directoryBytes(instanceSrc)
            const available = await availableBytes(await diskFsRoot(targetDisk))
            if (available < needed) {
                throw new Error(
                    `Not enough space on disk '${targetDisk.name}' (${targetDisk.id}): need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                    `have ${Math.ceil(available / 1024 / 1024)}MB`
                )
            }
        }

        // 3. Ensure target directory structure
        // For cross-engine: SSH mkdir on remote Pi
        const targetMountRoot = await diskMountRoot(targetDisk) // '' for system disk (both local and remote)
        if (isCrossEngine) {
            log(`copyApp: ensuring remote directories on ${remoteAddress}`)
            await $`ssh -o StrictHostKeyChecking=no pi@${remoteAddress} sudo mkdir -p ${targetMountRoot}/apps ${targetMountRoot}/instances ${targetMountRoot}/services && sudo chown -R pi:pi ${targetMountRoot}/apps ${targetMountRoot}/instances ${targetMountRoot}/services`
        } else {
            await fs.ensureDir(`${targetMountRoot}/apps`)
            await fs.ensureDir(`${targetMountRoot}/instances`)
            await fs.ensureDir(`${targetMountRoot}/services`)
        }

        // 4. rsync app master (idempotent — skips if already present and identical)
        setCopyStep(2)
        const appMasterDest = `${targetMountRoot}/apps/${appId}`
        log(`copyApp: syncing app master ${appMasterSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${appMasterDest}`)
        await rsyncDirectory(appMasterSrc, appMasterDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: Math.round(progressPercent * 0.25) })
        }, opId, remoteAddress)

        // 5. rsync instance data into a NEW instance directory (new ID)
        setCopyStep(3)
        const instanceDest = `${targetMountRoot}/instances/${newInstanceId}`
        if (!isCrossEngine) await fs.ensureDir(instanceDest)
        else await $`ssh -o StrictHostKeyChecking=no pi@${remoteAddress} mkdir -p ${instanceDest}`
        log(`copyApp: syncing instance data ${instanceSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${instanceDest}`)
        await rsyncDirectory(instanceSrc, instanceDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: 25 + Math.round(progressPercent * 0.30) })
        }, opId, remoteAddress)

        // 5b. rsync service image tars needed by this instance
        //     services/ holds the Docker image tars that startInstance loads via
        //     `docker image load`. Without them the copied instance cannot start.
        setCopyStep(4)
        const sourceMountRootCopy = await diskMountRoot(sourceDisk)
        const copyServicesSrcDir = `${sourceMountRootCopy}/services`
        const copyServicesDestDir = `${targetMountRoot}/services`
        if (instance.serviceImages?.length) {
            let servicesDone = 0
            for (const serviceImage of instance.serviceImages) {
                const tarName = (serviceImage as string).replace(/\//g, '_') + '.tar'
                const tarSrc = `${copyServicesSrcDir}/${tarName}`
                if (await fs.pathExists(tarSrc)) {
                    log(`copyApp: syncing service image ${tarName}`)
                    if (isCrossEngine) {
                        await $`rsync -a -e ${'ssh -o StrictHostKeyChecking=no'} ${tarSrc} pi@${remoteAddress}:${copyServicesDestDir}/`
                    } else {
                        await $`rsync -a ${tarSrc} ${copyServicesDestDir}/`
                    }
                } else {
                    log(`copyApp: service image tar not found at ${tarSrc} — skipping`)
                }
                servicesDone++
                updateOperation(storeHandle, opId, {
                    progressPercent: 55 + Math.round((servicesDone / instance.serviceImages.length) * 38),
                })
            }
        }

        // 6. Register/start the new instance
        setCopyStep(5)
        if (isCrossEngine) {
            // Cross-engine: create instance record in shared store (as Docked),
            // then tell the remote engine to start it via sendCommand.
            log(`copyApp: registering new instance ${newInstanceId} on remote disk '${targetDisk.name}' (${targetDisk.id})`)
            const composeContent = (await $`cat ${instanceSrc}/compose.yaml`).stdout
            const { parse: parseYAML } = await import('yaml')
            const compose = parseYAML(composeContent)
            const services = Object.keys(compose.services)
            const serviceImages = services.map((s: string) => compose.services[s].image)
            storeHandle.change(doc => {
                const newInst: Instance = {
                    id: newInstanceId,
                    instanceOf: instance.instanceOf,
                    name: instance.name,
                    storedOn: targetDisk.id,
                    status: 'Docked' as Status,
                    statusCondition: null,
                    port: 0 as any,
                    serviceImages: serviceImages as ServiceImage[],
                    created: Date.now() as Timestamp,
                    lastBackup: null,
                    lastStarted: 0 as Timestamp,
                    currentStep: null,
                    totalSteps: null,
                    stepLabel: null,
                    metrics: null,
                }
                doc.instanceDB[newInstanceId] = newInst
            })
            // Tell the remote engine to start this instance
            log(`copyApp: sending startInstance command to remote engine '${targetDisk.dockedTo}'`)
            sendCommand(storeHandle, targetDisk.dockedTo as any, `startInstance ${instance.name} ${targetDisk.id} --cause cross-engine-cmd` as any)
        } else {
            // Local: use existing processInstance flow
            log(`copyApp: registering new instance ${newInstanceId} on disk '${targetDisk.name}' (${targetDisk.id})`)
            await processInstance(storeHandle, targetDisk, newInstanceId)
        }

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`copyApp: done — new instance ${newInstanceId} on '${targetDisk.name}' (${targetDisk.id})`))

    } catch (e: any) {
        // Don't overwrite Cancelled status (set by cancelOperation before SIGTERM completes)
        const currentStatus = storeHandle.doc()?.operationDB?.[opId]?.status
        if (currentStatus !== 'Cancelled') {
            updateOperation(storeHandle, opId, {
                status: 'Failed',
                error: e.message ?? String(e),
                completedAt: Date.now() as Timestamp,
            })
        }
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
                    await startInstance(storeHandle, freshInstance, sourceDisk, 'post-copy')
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
    sourceDiskId: DiskID,
    targetDiskId: DiskID,
    cause: OperationCause = 'console-command',
): Promise<void> => {
    const store = storeHandle.doc()

    const v = await validate(store, instanceName, sourceDiskId, targetDiskId)
    if (typeof v === 'string') {
        console.error(chalk.red(`moveApp: ${v}`))
        return
    }
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc } = v

    // moveApp does not support cross-engine targets (data integrity risk if move fails midway).
    // Use copyApp + manual delete instead.
    const { localEngineId: localId } = await import('./Engine.js')
    if (String(targetDisk.dockedTo) !== String(localId)) {
        log(`moveApp: Target disk '${targetDisk.name}' is on a remote engine. Cross-engine move is not supported — use copyApp instead, then delete the source.`)
        return
    }

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
    }, cause, { type: 'instance', id: instance.id })

    let wasRunning = false

    // ── step definitions ──────────────────────────────────────────────────────
    const MOVE_STEPS = [
        'Stopping instance',          // 0
        'Checking free space',        // 1
        'Syncing app master',         // 2
        'Syncing instance data',      // 3
        'Syncing service images',     // 4
        'Registering on target disk', // 5
        'Removing source data',       // 6
    ]
    const setMoveStep = (step: number) =>
        updateOperation(storeHandle, opId, { currentStep: step, totalSteps: MOVE_STEPS.length, stepLabel: MOVE_STEPS[step] })

    try {
        // 1. Stop source instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            wasRunning = true
            log(`moveApp: stopping instance '${instanceName}'`)
            setMoveStep(0)
            await stopInstance(storeHandle, instance, sourceDisk, 'post-move')
        }

        updateOperation(storeHandle, opId, { status: 'Running' })

        // 2. Check free space
        setMoveStep(1)
        const needed = await directoryBytes(appMasterSrc) + await directoryBytes(instanceSrc)
        const available = await availableBytes(await diskFsRoot(targetDisk))
        if (available < needed) {
            throw new Error(
                `Not enough space on disk '${targetDisk.name}' (${targetDisk.id}): need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                `have ${Math.ceil(available / 1024 / 1024)}MB`
            )
        }

        // 3. Ensure target directory structure
        const targetMountRoot = await diskMountRoot(targetDisk)
        await fs.ensureDir(`${targetMountRoot}/apps`)
        await fs.ensureDir(`${targetMountRoot}/instances`)
        await fs.ensureDir(`${targetMountRoot}/services`)

        // 4. rsync app master
        setMoveStep(2)
        const appMasterDest = `${targetMountRoot}/apps/${appId}`
        log(`moveApp: syncing app master ${appMasterSrc} → ${appMasterDest}`)
        await rsyncDirectory(appMasterSrc, appMasterDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: Math.round(progressPercent * 0.25) })
        }, opId)

        // 5. rsync instance data — same instance ID, new location
        setMoveStep(3)
        const instanceDest = `${targetMountRoot}/instances/${instance.id}`
        await fs.ensureDir(instanceDest)
        log(`moveApp: syncing instance data ${instanceSrc} → ${instanceDest}`)
        await rsyncDirectory(instanceSrc, instanceDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: 25 + Math.round(progressPercent * 0.30) })
        }, opId)

        // 5b. rsync service image tars needed by this instance
        //     services/ holds the Docker image tars that startInstance loads via
        //     `docker image load`. Without them the moved instance cannot start.
        setMoveStep(4)
        const sourceMountRootMove = await diskMountRoot(sourceDisk)
        const moveServicesSrcDir = `${sourceMountRootMove}/services`
        const moveServicesDestDir = `${targetMountRoot}/services`
        if (instance.serviceImages?.length) {
            let servicesDone = 0
            for (const serviceImage of instance.serviceImages) {
                const tarName = (serviceImage as string).replace(/\//g, '_') + '.tar'
                const tarSrc = `${moveServicesSrcDir}/${tarName}`
                if (await fs.pathExists(tarSrc)) {
                    log(`moveApp: syncing service image ${tarName}`)
                    await $`rsync -a ${tarSrc} ${moveServicesDestDir}/`
                } else {
                    log(`moveApp: service image tar not found at ${tarSrc} — skipping`)
                }
                servicesDone++
                updateOperation(storeHandle, opId, {
                    progressPercent: 55 + Math.round((servicesDone / instance.serviceImages.length) * 35),
                })
            }
        }

        // 6. Register on target disk (storedOn + status set here; instance starts).
        //    This MUST succeed before we touch the source record — if cancelled before
        //    this point the source record is untouched and the operator can retry cleanly.
        setMoveStep(5)
        log(`moveApp: registering instance ${instance.id} on disk '${targetDisk.name}' (${targetDisk.id})`)
        await processInstance(storeHandle, targetDisk, instance.id)

        // 8. Remove source instance directory
        setMoveStep(6)
        // Use sudo rm -rf because instance data dirs may contain files owned by
        // Docker container users (e.g. Kolibri data owned by root inside the container).
        log(`moveApp: removing source instance directory ${instanceSrc}`)
        await $`sudo rm -rf ${instanceSrc}`

        // 9. Remove source app master only if no other instance on the source disk uses it
        // App master files are pi-owned, so fs.remove is sufficient.
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
        log(chalk.green(`moveApp: done — instance ${instance.id} moved to '${targetDisk.name}' (${targetDisk.id})`))

    } catch (e: any) {
        // Don't overwrite Cancelled status (set by cancelOperation before SIGTERM completes)
        const currentStatus = storeHandle.doc()?.operationDB?.[opId]?.status
        if (currentStatus !== 'Cancelled') {
            updateOperation(storeHandle, opId, {
                status: 'Failed',
                error: e.message ?? String(e),
                completedAt: Date.now() as Timestamp,
            })
        }
        console.error(chalk.red(`moveApp: failed — ${e.message ?? e}`))

        // On failure, try to restart the source instance if we stopped it
        if (wasRunning) {
            try {
                const freshStore = storeHandle.doc()
                const freshInstance = getInstance(freshStore, instance.id)
                if (freshInstance) {
                    log(`moveApp: restarting source instance '${instanceName}' after failure`)
                    await startInstance(storeHandle, freshInstance, sourceDisk, 'post-move')
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
