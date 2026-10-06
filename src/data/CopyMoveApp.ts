/**
 * CopyMoveApp.ts — copyApp and moveApp command implementations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine — source and target on local engine.
 * Phase 2: cross-engine — source on local engine, target on remote engine;
 *   rsync over ssh with this Engine's own key (per-Pi Engine keys,
 *   data/PeerAccess.ts, utils/peerSsh.ts), remote start via sendCommand. Every
 *   remote step runs the peer's helper through its gate (ensure-dirs, receive-app,
 *   receive / receive-files, receive-service, delete); none is a plain ssh command.
 */

import { chalk, fs, $ } from 'zx'
import { log } from '../utils/utils.js'
import { rsyncDirectory, rsyncInstanceData, rsyncToPeer, PeerEngine } from '../utils/rsync.js'
import {
    instanceDataBytes, deleteInstanceData, deleteRemoteInstanceData, ensureRemoteDirs,
    receiveAppArgs, receiveFilesArgs, receiveServiceArgs,
} from '../utils/appDataHelper.js'
import { peerCopyRefusal, peerAccessProblem } from './PeerAccess.js'
import {
    InstanceID, DiskID, DiskName, InstanceName, Timestamp,
    OperationKind, OperationCause, ServiceImage
} from './CommonTypes.js'
import { Store, getDisk, getInstance, getInstancesOfDisk } from './Store.js'
import { Disk, processInstance, diskMountRoot, diskFsRoot, appDataRoot } from './Disk.js'
import { stopInstance, startInstance } from './Instance.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'
import { createOperation, updateOperation } from './Operations.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { sendCommand } from '../utils/commandUtils.js'
import { getEngineAddress } from './Network.js'
import { Instance, Status } from './Instance.js'
import { IPAddress } from './CommonTypes.js'
import { lookupInstanceArg, describeInstanceCandidates } from './InstanceArg.js'
import { findExternalLinks, externalLinksMessage, uniqueCopyName, preparedCopyFiles, instanceDirLooksLikeKolibri } from './InstanceCopy.js'
import os from 'os'
import path from 'path'

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
 * Returns total size in bytes of `path` (recursive), as the Engine user.
 * Used for the pi-owned app master; instance data is sized as root by the
 * app-data helper (instanceDataBytes), because pi cannot read all of it (idea#168).
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
    /** app-data helper root tokens (idea#168): 'system', 'sdX1' or a test slot name */
    sourceRoot: string
    targetRoot: string
}

const validate = async (
    store: Store,
    instanceName: InstanceName,
    sourceDiskId: DiskID,
    targetDiskId: DiskID,
    kind: 'copy' | 'move' = 'copy'
): Promise<ValidatedCopyMove | string> => {
    // Look up the instance id-first (idea#168): an instance id, else a unique
    // name, else the one instance with that name on the source disk (the
    // Console sends `<name> <sourceDiskId> <targetDiskId>`). Any status, so
    // stopped instances can be copied too. Crash recovery passes the id.
    const found = lookupInstanceArg(store, String(instanceName), String(sourceDiskId))
    if (!found.ok && found.reason === 'ambiguous') {
        return `Instance name '${instanceName}' is ambiguous: ${describeInstanceCandidates(found.candidates)}. Use the instance id.`
    }
    if (!found.ok) return `Instance '${instanceName}' not found`
    const instance = found.instance
    if (found.via === 'name-on-disk') {
        console.warn(`Instance name '${instanceName}' is shared by several instances; using ${instance.id}, the one on disk ${sourceDiskId}. Send the instance id.`)
    }

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
        // Per-Pi Engine keys: both Engines must have accepted each other's key
        // (a move refuses a remote target itself, with its own message)
        if (kind === 'copy') {
            const refusal = peerCopyRefusal(store, String(localEngineId), String(targetEngineId), peerAccessProblem())
            if (refusal) return refusal
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

    // Refuse instance data that links off the disk (idea#168 r35), before the
    // source is stopped: rsync -a copies a link verbatim, so the result would
    // share the original's data.
    const externalLinks = await findExternalLinks(instanceSrc)
    if (externalLinks.length > 0) return externalLinksMessage(instanceSrc, sourceDisk, externalLinks)

    const sourceRoot = await appDataRoot(sourceDisk)
    const targetRoot = await appDataRoot(targetDisk)

    return { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc, sourceRoot, targetRoot }
}

// ── copyApp ───────────────────────────────────────────────────────────────────

/**
 * Copy an app instance from sourceDisk to targetDisk.
 * The copy receives a fresh InstanceID — it is a brand new instance — and its
 * own name (`<name>-2`, `<name>-3`, …) and port (idea#168 r35).
 * The original keeps running: it is stopped during the file copy and restarted
 * before the copy starts, so it keeps its port.
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
    // Validation refusals throw (idea#168 r29@97), so the command trace or
    // crash-recovery retry ends as error instead of silently succeeding.
    if (typeof v === 'string') throw new Error(`copyApp: ${v}`)
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc, sourceRoot, targetRoot } = v

    // Acquire per-resource locks: source instance + target disk
    const lockKeys = [instanceKey(instance.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(lockKeys, 'copyApp')) {
        throw new Error(`copyApp: resource locked — another operation is already running on instance '${instanceName}' or target disk '${targetDisk.name}'. Retry when it completes.`)
    }

    const opId = createOperation(storeHandle, 'copyApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
    }, cause, { type: 'instance', id: instance.id })

    const newInstanceId = uuid() as InstanceID
    let wasRunning = false
    let sourceRestarted = false
    // idea#168 r36: the folder this copy creates on the target disk. A failed copy
    // removes it, else the next dock of that disk registers the partial folder as a
    // new instance (r36: the @43 copy failed in rsync and its folder vuf3im3mbayl9z6uou3,
    // named like the original, registered on Nextcloud Grade 5A).
    let createdInstanceDest: string | null = null

    // Restart the source if we stopped it. Called once: before the copy starts
    // on success (idea#168 r35), else from finally.
    const restartSource = async (when: string): Promise<void> => {
        sourceRestarted = true
        try {
            const freshInstance = getInstance(storeHandle.doc(), instance.id)
            if (freshInstance) {
                log(`copyApp: restarting source instance '${instance.name}' (${instance.id}) ${when}`)
                await startInstance(storeHandle, freshInstance, sourceDisk, 'post-copy')
            }
        } catch (restartErr: any) {
            console.error(chalk.red(`copyApp: failed to restart source instance: ${restartErr.message}`))
        }
    }

    // Detect cross-engine: target disk is on a different engine
    const { localEngineId } = await import('./Engine.js')
    const isCrossEngine = String(targetDisk.dockedTo) !== String(localEngineId)
    const remoteAddress = isCrossEngine
        ? getEngineAddress(targetDisk.dockedTo as any) as string
        : undefined
    // The peer: its address now, and its Engine id (key and host key pinned by id)
    const peer: PeerEngine | undefined = isCrossEngine ? { host: remoteAddress!, engineId: String(targetDisk.dockedTo) } : undefined

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
            // Instance data is sized as root by the app-data helper (idea#168): pi cannot
            // read all of it (root 0600 sessions, MariaDB 0700 folders).
            const needed = await directoryBytes(appMasterSrc) + await instanceDataBytes(sourceRoot, instance.id)
            const available = await availableBytes(await diskFsRoot(targetDisk))
            if (available < needed) {
                throw new Error(
                    `Not enough space on disk '${targetDisk.name}' (${targetDisk.id}): need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                    `have ${Math.ceil(available / 1024 / 1024)}MB`
                )
            }
        }

        // 3. Ensure target directory structure
        // For cross-engine: the peer's helper (ensure-dirs <root>, through its gate)
        const targetMountRoot = await diskMountRoot(targetDisk) // '' for system disk (both local and remote)
        if (peer) {
            log(`copyApp: ensuring remote directories on ${peer.host} (Engine ${peer.engineId}, idea-app-data ensure-dirs ${targetRoot})`)
            await ensureRemoteDirs(peer.host, peer.engineId, targetRoot)
        } else {
            await fs.ensureDir(`${targetMountRoot}/apps`)
            await fs.ensureDir(`${targetMountRoot}/instances`)
            await fs.ensureDir(`${targetMountRoot}/services`)
        }

        // 4. rsync app master (idempotent — skips if already present and identical)
        setCopyStep(2)
        const appMasterDest = `${targetMountRoot}/apps/${appId}`
        log(`copyApp: syncing app master ${appMasterSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${appMasterDest}`)
        const appMasterProgress = ({ progressPercent }: { progressPercent: number }) => {
            updateOperation(storeHandle, opId, { progressPercent: Math.round(progressPercent * 0.25) })
        }
        if (peer) await rsyncToPeer(appMasterSrc.replace(/\/*$/, '/'), peer, receiveAppArgs(targetRoot, appId), appMasterProgress, opId)
        else await rsyncDirectory(appMasterSrc, appMasterDest, appMasterProgress, opId)

        // 5. Copy instance data into a NEW instance directory (new ID), as root through
        //    the app-data helper (idea#168): owners and modes are kept, and data pi
        //    cannot read is copied too. The helper creates the folder; cross-engine it
        //    sends to pi@<remote>, where that Engine's helper receives it (rrsync -wo).
        setCopyStep(3)
        const instanceDest = `${targetMountRoot}/instances/${newInstanceId}`
        createdInstanceDest = instanceDest
        log(`copyApp: syncing instance data ${instanceSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${instanceDest} (idea-app-data ${isCrossEngine ? 'send' : 'copy'})`)
        await rsyncInstanceData(
            peer
                ? { kind: 'send', srcRoot: sourceRoot, srcId: instance.id, host: peer.host, peerEngineId: peer.engineId, dstRoot: targetRoot, dstId: newInstanceId }
                : { kind: 'copy', srcRoot: sourceRoot, srcId: instance.id, dstRoot: targetRoot, dstId: newInstanceId },
            ({ progressPercent }) => {
                updateOperation(storeHandle, opId, { progressPercent: 25 + Math.round(progressPercent * 0.30) })
            }, opId)

        // 5a. Give the copy its own name and port (idea#168 r35). The rsync
        //     copied the original's compose.yaml (x-app.instanceName) and .env
        //     (port=). The copy gets a unique name (<name>-2, -3, …; see
        //     uniqueCopyName) and no port, so startInstance allocates one that is
        //     neither listening nor owned by another instance in the store.
        const copyName = uniqueCopyName(storeHandle.doc(), String(instance.name))
        const prepared = await preparedCopyFiles(instanceSrc, copyName)
        const preparedNames = Object.keys(prepared) as (keyof typeof prepared)[]
        if (preparedNames.length > 0) {
            if (peer) {
                const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-copy-'))
                try {
                    for (const f of preparedNames) await fs.writeFile(`${tmp}/${f}`, prepared[f]!)
                    // only into the folder this Engine's receive just created (the peer's gate checks
                    // its ledger); the files only, so the instance folder keeps its own owner and mode
                    await rsyncToPeer(preparedNames.map(f => `${tmp}/${f}`), peer, receiveFilesArgs(targetRoot, newInstanceId), undefined, opId)
                } finally {
                    await fs.remove(tmp).catch(() => undefined)
                }
            } else {
                for (const f of preparedNames) await fs.writeFile(`${instanceDest}/${f}`, prepared[f]!)
            }
        }
        log(`copyApp: the copy is named '${copyName}'; its .env has no port, so it gets its own port at start`)

        // 5a2. r40: mark Kolibri copies so startInstance rebinds morango id before
        //     zeroconf advertise (NonUniqueNameException → fake Docker Running).
        //     Marker works for local and cross-engine (file is in the instance folder).
        const kolibriCopy = peer
            ? await instanceDirLooksLikeKolibri(instanceSrc)
            : await instanceDirLooksLikeKolibri(instanceDest)
        if (kolibriCopy) {
            // Nested path under the instance folder; receive-files places named files
            // at the instance root, so for peer we write a flat marker and rename is
            // not available — write the full relative tree via a tiny staging dir of
            // files listed with their paths... receive-files only stores basename.
            // Local: write nested. Peer: write flat marker at instance root that
            // runInstance also recognizes.
            if (peer) {
                const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-kolibri-rebind-'))
                try {
                    await fs.writeFile(`${tmp}/.idea-rebind-morango`, 'r40\n')
                    await rsyncToPeer(
                        [`${tmp}/.idea-rebind-morango`],
                        peer,
                        receiveFilesArgs(targetRoot, newInstanceId),
                        undefined,
                        opId,
                    )
                } finally {
                    await fs.remove(tmp).catch(() => undefined)
                }
            } else {
                await fs.ensureDir(`${instanceDest}/data/kolibri`)
                await fs.writeFile(`${instanceDest}/data/kolibri/.idea-rebind-morango`, 'r40\n')
            }
            log(`copyApp: wrote Kolibri morango-rebind marker so start mints a fresh id (r40)`)
        }

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
                    if (peer) {
                        await rsyncToPeer(tarSrc, peer, receiveServiceArgs(targetRoot), undefined, opId)
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

        // Restart the source BEFORE the copy starts (idea#168 r35): the
        // original takes its own port back first, and the copy can never grab
        // it while the original is down for the snapshot.
        if (wasRunning) await restartSource('before the copy starts')

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
                    name: copyName,
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
            // Tell the remote engine to start this instance, by id (idea#168)
            log(`copyApp: sending startInstance command to remote engine '${targetDisk.dockedTo}'`)
            sendCommand(storeHandle, targetDisk.dockedTo as any, `startInstance ${newInstanceId} ${targetDisk.id} --cause cross-engine-cmd` as any)
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
        // Remove the partial copy unless it was already registered (fresh id, so the
        // folder holds only what this op wrote). As root through the app-data helper
        // (idea#168): the copy holds files owned by root, 999 and www-data.
        if (createdInstanceDest && !storeHandle.doc()?.instanceDB?.[newInstanceId]) {
            try {
                if (peer) await deleteRemoteInstanceData(peer.host, peer.engineId, targetRoot, newInstanceId)
                else await deleteInstanceData(targetRoot, newInstanceId)
                log(`copyApp: removed the partial copy ${isCrossEngine ? remoteAddress + ':' : ''}${createdInstanceDest}`)
            } catch (cleanupErr: any) {
                console.error(chalk.red(`copyApp: could not remove the partial copy ${createdInstanceDest}: ${cleanupErr?.message ?? cleanupErr}`))
            }
        }
    } finally {
        resourceLock.releaseAll(lockKeys)
        // Always restart the source if we stopped it and the success path did not
        if (wasRunning && !sourceRestarted) await restartSource('after a failed copy')
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

    const v = await validate(store, instanceName, sourceDiskId, targetDiskId, 'move')
    // Validation refusals throw (idea#168 r29@97), so the command trace or
    // crash-recovery retry ends as error instead of silently succeeding.
    if (typeof v === 'string') throw new Error(`moveApp: ${v}`)
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc, sourceRoot, targetRoot } = v

    // moveApp does not support cross-engine targets (data integrity risk if move fails midway).
    // Use copyApp + manual delete instead.
    const { localEngineId: localId } = await import('./Engine.js')
    if (String(targetDisk.dockedTo) !== String(localId)) {
        throw new Error(`moveApp: Target disk '${targetDisk.name}' is on a remote engine. Cross-engine move is not supported — use copyApp instead, then delete the source.`)
    }

    // Acquire per-resource locks: instance + both disks
    const moveLockKeys = [instanceKey(instance.id), diskKey(sourceDisk.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(moveLockKeys, 'moveApp')) {
        throw new Error(`moveApp: resource locked — another operation is already running on instance '${instanceName}' or one of its disks. Retry when it completes.`)
    }

    const opId = createOperation(storeHandle, 'moveApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
    }, cause, { type: 'instance', id: instance.id })

    let wasRunning = false
    // idea#168: set once the helper copy into the target started, cleared when the
    // instance is registered there. A failed move removes this partial copy, else a
    // retry is refused (the helper needs an absent or empty destination) and the next
    // dock of the target disk would register the partial folder.
    let partialTarget = false

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
        const needed = await directoryBytes(appMasterSrc) + await instanceDataBytes(sourceRoot, instance.id)
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

        // 5. Copy instance data as root through the app-data helper (idea#168) —
        //    same instance ID, new location; owners and modes are kept.
        setMoveStep(3)
        const instanceDest = `${targetMountRoot}/instances/${instance.id}`
        log(`moveApp: syncing instance data ${instanceSrc} → ${instanceDest} (idea-app-data copy)`)
        partialTarget = true
        await rsyncInstanceData({ kind: 'copy', srcRoot: sourceRoot, srcId: instance.id, dstRoot: targetRoot, dstId: instance.id },
            ({ progressPercent }) => {
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
        partialTarget = false

        // 8. Remove source instance directory
        setMoveStep(6)
        // Removed as root through the app-data helper (idea#168): the folder holds
        // files containers wrote as root, 999 or www-data, which pi cannot remove.
        // The instance already runs from the target disk at this point, so a failure
        // is logged and does not fail the move.
        log(`moveApp: removing source instance directory ${instanceSrc} (idea-app-data delete)`)
        try {
            await deleteInstanceData(sourceRoot, instance.id)
        } catch (e: any) {
            log(chalk.yellow(`moveApp: could not remove ${instanceSrc}: ${e.message}. Remove the leftover folder by hand.`))
        }

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

        // Remove the partial copy on the target (idea#168) while the instance is still
        // registered on the source disk. Never the source: the helper refuses a copy
        // onto the same root, so target root ≠ source root. Not after a helper
        // refusal: it wrote nothing, and a folder that was already there (e.g. an
        // earlier restore of this instance onto the target) is not ours to remove.
        const stillOnSource = String(storeHandle.doc()?.instanceDB?.[instance.id]?.storedOn) === String(sourceDisk.id)
        const helperRefused = /idea-app-data [\w-]+ refused: /.test(String(e?.message ?? ''))
        if (partialTarget && stillOnSource && !helperRefused && targetRoot !== sourceRoot) {
            try {
                await deleteInstanceData(targetRoot, instance.id)
                log(`moveApp: removed the partial copy of ${instance.id} on '${targetDisk.name}'`)
            } catch (cleanupErr: any) {
                console.error(chalk.red(`moveApp: could not remove the partial copy of ${instance.id} on '${targetDisk.name}': ${cleanupErr?.message ?? cleanupErr}`))
            }
        }

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
