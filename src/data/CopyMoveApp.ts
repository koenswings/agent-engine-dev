/**
 * CopyMoveApp.ts — copyApp and moveApp command implementations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine — source and target on local engine.
 * Phase 2: cross-engine — source on local engine, target on remote engine;
 *   rsync over ssh with this Engine's own key (per-Pi Engine keys,
 *   data/PeerAccess.ts, utils/peerSsh.ts), remote start via PeerCommands.dispatchToPeer (peer grant). Every
 *   remote step runs the peer's helper through its gate (ensure-dirs, receive-app,
 *   receive / receive-files, receive-service, delete); none is a plain ssh command.
 */

import { childPathInside } from './NameCheck.js'
import { chalk, fs, $ } from 'zx'
import { log, isEngineOnline } from '../utils/utils.js'
import { rsyncDirectory, rsyncInstanceData, rsyncToPeer, PeerEngine } from '../utils/rsync.js'
import {
    instanceDataBytes, deleteInstanceData, deleteRemoteInstanceData, ensureRemoteDirs,
    receiveAppArgs, receiveFilesArgs, receiveServiceArgs, putInstanceFiles,
} from '../utils/appDataHelper.js'
import { peerCopyRefusal, peerAccessProblem } from './PeerAccess.js'
import {
    InstanceID, DiskID, DiskName, InstanceName, Timestamp,
    OperationKind, OperationCause, ServiceImage
} from './CommonTypes.js'
import { Store, getDisk, getInstance, getInstancesOfDisk } from './Store.js'
import { Disk, processInstance, diskMountRoot, diskFsRoot, appDataRoot } from './Disk.js'
import { stopInstance, startInstance, applyBackupMethod } from './Instance.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'
import { beginUsageSkip, endUsageSkip } from '../usage/opFlags.js'
import { createOperation, updateOperation, setOperationArgs, parkResumableOp, resumeGaveUpHooks, peerResumeProbe, peerInterruption } from './Operations.js'
import {
    markInFlight, clearInFlight, verifyInstanceCopy, resumeHelperProblem,
    engineCanResume, peerInFlight, markPeerInFlight, clearPeerInFlight, verifyPeerCopyOrThrow,
} from './InFlight.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { dispatchToPeer } from './PeerCommands.js'
import { getEngineAddress, getLiveEngineAddress, getLiveEngineEndpoint } from './Network.js'
import { peerLiveSeen, PEER_CLOCK_STALE_MS } from './Liveness.js'
import { serviceImageTarName } from './ImageRef.js'
import { Instance, Status } from './Instance.js'
import { IPAddress } from './CommonTypes.js'
import { lookupInstanceArg, describeInstanceCandidates } from './InstanceArg.js'
import { checkInstanceIdForDocker } from '../utils/instanceIds.js'
import { MoveError, moveFailedText } from './MoveAppShapes.js'
import { findExternalLinks, externalLinksMessage, uniqueCopyName, preparedCopyFiles, instanceDirLooksLikeKolibri } from './InstanceCopy.js'
import type { MoveResult } from './MoveAppShapes.js'
import { composeDownAt, pruneUnusedInstanceNetworks } from '../utils/instanceNetworks.js'
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

export const validate = async (
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
    if ((instance as any).demo === true) {
        return `NOT_DEMO: cannot ${kind} a demo instance (${instance.id}); demo instances are not copied or moved`
    }
    if (found.via === 'name-on-disk') {
        console.warn(`Instance name '${instanceName}' is shared by several instances; using ${instance.id}, the one on disk ${sourceDiskId}. Send the instance id.`)
    }
    // idea#479: moveApp takes the source compose project down, so the id is
    // checked before any Docker action. A legacy dotted id is refused here
    // (only removeInstance accepts it).
    if (kind === 'move') {
        const idCheck = checkInstanceIdForDocker(String(instance.id))
        if (!idCheck.ok) return `INVALID_INSTANCE_ID: ${idCheck.reason}`
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

/** Options for copyApp when it runs as the copy step of a cross-Engine move (idea#79, engine#381). */
export interface CopyAppOptions {
    /** write progress into this (moveApp) operation instead of creating a copyApp one */
    journalOpId?: string
    /** the copy keeps the source's name (the source is removed after verify) */
    keepName?: boolean
    /** throw the copy failure instead of only recording it */
    rethrow?: boolean
    /** a move keeps the source stopped after a good copy (it restarts it itself on failure) */
    keepSourceStopped?: boolean
    /**
     * Internal only (not on the CLI). Cross-Engine moveApp passes the source id so
     * the target folder is instances/<same id> and no second instanceDB row is written.
     * A plain copyApp omits this and still mints a fresh id.
     */
    dstId?: InstanceID
    /** Ephemeral copy byte progress for moveApp (engine#387). Not stored. */
    onByteProgress?: (p: { bytesDone: number, bytesTotal: number }) => void
    /**
     * Internal only (not on the CLI): boot recovery re-runs an interrupted copyApp inside
     * its original Operation (engine#497). That op gets the status and progress updates
     * instead of a new one, so it ends Done or Failed and is never retried again.
     */
    recoveredOpId?: string
}

/** Accumulate rsync --info=progress2 bytes across the app-master and instance stages. */
export const accumulateCopyByteProgress = (
    onByteProgress: ((p: { bytesDone: number, bytesTotal: number }) => void) | undefined,
    bytesTotal: number,
) => {
    let completed = 0
    const report = (bytesDone: number) => {
        if (!onByteProgress) return
        const total = bytesTotal > 0 ? bytesTotal : Math.max(0, bytesDone)
        onByteProgress({ bytesDone: total > 0 ? Math.min(Math.max(0, bytesDone), total) : Math.max(0, bytesDone), bytesTotal: total })
    }
    const stage = (stageBytes: number) => {
        let finished = false
        return (p: { progressPercent: number, bytesDone?: number }) => {
            const chunk = p.bytesDone != null ? p.bytesDone : Math.round(Math.max(0, stageBytes) * (p.progressPercent / 100))
            report(completed + chunk)
            if (!finished && p.progressPercent >= 100) {
                finished = true
                completed += Math.max(0, stageBytes)
            }
        }
    }
    const finish = () => report(bytesTotal > 0 ? bytesTotal : completed)
    return { stage, finish }
}

// ── engine#497: resumable local copies (Koen's rule) ─────────────────────────

/**
 * Why a failed local copy/move counts as an interruption (a disk left this Engine or
 * is no longer mounted), or null when the failure is real and counts towards the limit.
 */
export const copyInterruption = async (storeHandle: DocHandle<Store>, diskIds: string[]): Promise<string | null> => {
    const { localEngineId } = await import('./Engine.js')
    for (const id of diskIds) {
        const d = getDisk(storeHandle.doc(), id as DiskID) as Disk | undefined
        const label = d?.name ? `'${d.name}' (${id})` : id
        if (!d?.device || String(d.dockedTo) !== String(localEngineId)) return `disk ${label} is no longer docked on this Engine`
        try {
            if (!await fs.pathExists(`${await diskMountRoot(d)}/instances`)) return `disk ${label} is no longer mounted`
        } catch {
            return `disk ${label} cannot be read`
        }
    }
    return null
}

/** Park a resumable op after a failed run: kept marked, resumed at the next boot or dock (engine#497). */
const parkCopyMove = async (storeHandle: DocHandle<Store>, opId: string, diskIds: string[], e: unknown): Promise<void> => {
    const reason = (e as any)?.message ?? String(e)
    const gone = await copyInterruption(storeHandle, diskIds)
    parkResumableOp(storeHandle, opId, gone ? `${gone}: ${reason}` : reason, { interrupted: !!gone })
}

// engine#497 / #511 B2: a parked-op resume needs a live WS address, a fresh
// heartbeat (when one has been seen), and a successful TCP probe of the Engine port.
// copyApp itself still uses getEngineAddress so a forced retry can reach ssh and
// re-park on a transport failure rather than treating a stale entry as "no peer".
export const PEER_RESUME_LIVE_MS = PEER_CLOCK_STALE_MS

export const probePeerEngineReachable = async (engineId: string, now: number = Date.now()): Promise<boolean> => {
    const ep = getLiveEngineEndpoint(engineId as any)
    if (!ep) return false
    const seen = peerLiveSeen(engineId)
    if (seen != null && now - seen > PEER_RESUME_LIVE_MS) return false
    return isEngineOnline(ep.address, ep.port)
}

peerResumeProbe.address = (engineId: string) => getLiveEngineAddress(engineId as any) as string | undefined
peerResumeProbe.reachable = (engineId: string) => probePeerEngineReachable(engineId)

/**
 * engine#497 stage 3 (a): park a cross-Engine copy/move after a failed run. An interruption (the
 * source disk left this Engine, the target disk or its Engine is gone, or the link to it failed)
 * is never counted; anything else is a real failure (RESUME_PENDING n/3, then RESUME_GAVE_UP).
 */
export const parkCrossCopyMove = async (
    storeHandle: DocHandle<Store>, opId: string, sourceDiskId: string, targetDiskId: string, targetEngineId: string, e: unknown,
): Promise<void> => {
    const reason = (e as any)?.message ?? String(e)
    const gone = await copyInterruption(storeHandle, [sourceDiskId]) ?? peerInterruption(storeHandle.doc(), targetDiskId, targetEngineId, reason)
    parkResumableOp(storeHandle, opId, gone ? `${gone}: ${reason}` : reason, { interrupted: !!gone })
}

/** TARGET_OUTDATED / HELPER_OUTDATED text when a cross-Engine copy to `targetEngineId` cannot be resumed, else null. */
export const crossResumeRefusal = async (store: Store, targetEngineId: string, what: string): Promise<string | null> => {
    if (!engineCanResume(store, targetEngineId)) {
        const name = String((store?.engineDB as any)?.[targetEngineId]?.hostname ?? targetEngineId)
        return `TARGET_OUTDATED: Engine ${name} cannot resume an interrupted ${what} (no crossEngineResume capability); update it first (engine#497)`
    }
    const helperIssue = await peerInFlight.helperProblem(`${what} to another Engine (resumable cross-Engine ${what}, engine#497)`)
    return helperIssue ? `HELPER_OUTDATED: ${helperIssue}` : null
}

/** VERIFY_FAILED unless the copy matches its source (helper verify-copy). */
const verifyCopyOrThrow = async (sourceRoot: string, srcId: string, targetRoot: string, dstId: string, who: string): Promise<void> => {
    const v = await verifyInstanceCopy(sourceRoot, srcId, targetRoot, dstId)
    if (v.differences > 0) {
        throw new Error(`VERIFY_FAILED: the copy instances/${dstId} on ${targetRoot} differs from its source in ${v.differences} item(s)` +
            `${v.diffs.length ? `: ${v.diffs.join('; ')}` : ''}`)
    }
    log(`${who}: the copy instances/${dstId} on ${targetRoot} matches its source (idea-app-data verify-copy)`)
}

// ── copyApp ───────────────────────────────────────────────────────────────────

/**
 * Copy an app instance from sourceDisk to targetDisk.
 * A plain copyApp receives a fresh InstanceID — it is a brand new instance — and its
 * own name (`<name>-2`, `<name>-3`, …) and port (idea#168 r35).
 * When called as the copy step of a cross-Engine move with dstId set to the source
 * id (engine#381), the target folder uses that same id: no second instanceDB row,
 * lastBackup is kept, and Kolibri morango is not rebound. storedOn is not flipped
 * here; the move flips it only after verify.
 * The original keeps running: it is stopped during the file copy and restarted
 * before the copy starts, so it keeps its port (unless keepSourceStopped).
 */
export const copyApp = async (
    storeHandle: DocHandle<Store>,
    instanceName: InstanceName,
    sourceDiskId: DiskID,
    targetDiskId: DiskID,
    cause: OperationCause = 'console-command',
    opts: CopyAppOptions = {},
): Promise<InstanceID | null> => {
    const store = storeHandle.doc()

    const v = await validate(store, instanceName, sourceDiskId, targetDiskId)
    // Validation refusals throw (idea#168 r29@97), so the command trace or
    // crash-recovery retry ends as error instead of silently succeeding.
    if (typeof v === 'string') throw new Error(`copyApp: ${v}`)
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc, sourceRoot, targetRoot } = v

    // engine#497 stage 3 (a): every cross-Engine copy is resumable, so both Engines need helper v23
    // (a clear refusal before anything is stopped or written; no partial on an older peer)
    if (String(targetDisk.dockedTo) !== String((await import('./Engine.js')).localEngineId)) {
        const refusal = await crossResumeRefusal(store, String(targetDisk.dockedTo), 'copy')
        if (refusal) throw new Error(`copyApp: ${refusal}`)
    }

    // Acquire per-resource locks: source instance + target disk
    const lockKeys = [instanceKey(instance.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(lockKeys, 'copyApp')) {
        throw new Error(`copyApp: resource locked — another operation is already running on instance '${instanceName}' or target disk '${targetDisk.name}'. Retry when it completes.`)
    }

    // A cross-Engine move (idea#79) runs this copy inside its own moveApp operation
    const journal = opts.journalOpId ?? null
    const opId = journal ?? opts.recoveredOpId ?? createOperation(storeHandle, 'copyApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
        instanceName: String(instance.name),
    }, cause, { type: 'instance', id: instance.id })
    let copyError: Error | null = null
    beginUsageSkip('move')

    // engine#497: a resumed local copy continues into the folder and id it recorded
    const resumedArgs = (!journal && opts.recoveredOpId
        ? storeHandle.doc()?.operationDB?.[opts.recoveredOpId]?.args
        : undefined) as Record<string, string> | undefined
    const newInstanceId = (opts.dstId ?? resumedArgs?.targetInstanceId ?? uuid()) as InstanceID
    const preserveId = Boolean(opts.dstId) && String(opts.dstId) === String(instance.id)
    let wasRunning = false
    // engine#497: set once instances/<new id>.idea-op-in-flight is written. From then on a
    // failure keeps the partial copy (marked) and parks the op to resume; nothing is deleted.
    let markerWritten = false
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
    // engine#497 stage 2: a same-Engine copy resumes after an interruption (in-flight marker,
    // same folder and id, verify). Cross-Engine copies keep the idea#79 rules (stage 3).
    // (dstId is the copy step of a cross-Engine move, which keeps its own rules)
    const resumable = !journal && !isCrossEngine && !opts.dstId
    // engine#497 stage 3 (a), Koen Q1 option A: a cross-Engine copy (a plain copy, or the copy step of
    // a cross-Engine move under its moveApp op) resumes too. This Engine marks the target id on the
    // peer before the first byte, pushes into it with the op id, verifies against the source and
    // clears the marker only after success. A failure keeps the partial folder marked on the peer.
    const crossResumable = isCrossEngine
    const anyResumable = resumable || crossResumable

    // ── step definitions ──────────────────────────────────────────────────────
    const COPY_STEPS = [
        'Stopping instance',          // 0
        'Checking free space',        // 1
        'Syncing app master',         // 2
        'Syncing instance data',      // 3
        'Syncing service images',     // 4
        'Registering on target disk', // 5
    ]
    const setCopyStep = (step: number) => journal ? undefined :
        updateOperation(storeHandle, opId, { currentStep: step, totalSteps: COPY_STEPS.length, stepLabel: COPY_STEPS[step] })

    try {
        if (resumable) {
            const helperIssue = await resumeHelperProblem('copyApp on this Engine (resumable copy, engine#497)')
            if (helperIssue) throw new Error(`HELPER_OUTDATED: ${helperIssue}`)
            if (resumedArgs?.targetInstanceId && resumedArgs.phase) {
                log(`copyApp: resuming operation ${opId} (phase ${resumedArgs.phase}) into instances/${newInstanceId} on '${targetDisk.name}'`)
            }
            // engine#497: registered before the Engine stopped; only the marker is left
            const registered = storeHandle.doc()?.instanceDB?.[newInstanceId]
            if (resumedArgs?.targetInstanceId && (resumedArgs.phase === 'registered' || String(registered?.storedOn ?? '') === String(targetDisk.id))) {
                await clearInFlight(targetRoot, newInstanceId, opId)
                setOperationArgs(storeHandle, opId, { phase: 'done' })
                updateOperation(storeHandle, opId, { status: 'Done', progressPercent: 100, error: null, completedAt: Date.now() as Timestamp })
                log(chalk.green(`copyApp: done — instance ${newInstanceId} was already registered on '${targetDisk.name}'; cleared its in-flight marker`))
                return newInstanceId
            }
        }

        // engine#497 (a): a resumed cross-Engine copy that registered the copy before it stopped
        if (crossResumable && !journal && peer && resumedArgs?.targetInstanceId &&
            (resumedArgs.phase === 'registered' || String(storeHandle.doc()?.instanceDB?.[newInstanceId]?.storedOn ?? '') === String(targetDisk.id))) {
            await clearPeerInFlight(peer.host, peer.engineId, targetRoot, newInstanceId, opId)
            setOperationArgs(storeHandle, opId, { phase: 'done' })
            void dispatchToPeer(storeHandle, String(targetDisk.dockedTo), `startInstance ${newInstanceId} ${targetDisk.id} --cause cross-engine-cmd`)
            updateOperation(storeHandle, opId, { status: 'Done', progressPercent: 100, error: null, completedAt: Date.now() as Timestamp })
            log(chalk.green(`copyApp: done — instance ${newInstanceId} was already registered on '${targetDisk.name}' (Engine ${peer.engineId}); cleared its in-flight marker there`))
            return newInstanceId
        }

        // 1. Stop source instance if running
        if (resumedArgs?.wasRunning === '1') wasRunning = true
        if (instance.status === 'Running' || instance.status === 'Starting') {
            wasRunning = true
            log(`copyApp: stopping instance '${instanceName}' for consistent snapshot`)
            setCopyStep(0)
            await stopInstance(storeHandle, instance, sourceDisk, 'post-copy')
        }

        if (!journal) updateOperation(storeHandle, opId, { status: 'Running' })

        // 2. Check free space (local only — skip for cross-engine)
        setCopyStep(1)
        if (!isCrossEngine) {
            // Instance data is sized as root by the app-data helper (idea#168): pi cannot
            // read all of it (root 0600 sessions, MariaDB 0700 folders).
            let needed = await directoryBytes(appMasterSrc) + await instanceDataBytes(sourceRoot, instance.id)
            // engine#497: a resumed copy only needs what is not on the target yet
            if (resumable && resumedArgs?.targetInstanceId) {
                try { needed = Math.max(0, needed - await instanceDataBytes(targetRoot, newInstanceId)) } catch { /* nothing copied yet */ }
            }
            const available = await availableBytes(await diskFsRoot(targetDisk))
            if (available < needed) {
                throw new Error(
                    `Not enough space on disk '${targetDisk.name}' (${targetDisk.id}): need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                    `have ${Math.ceil(available / 1024 / 1024)}MB`
                )
            }
        }

        // engine#511 B2: a resume of a marked cross-Engine copy already has the
        // marker (and often a partial folder) on the peer. Treat the marker as
        // written before ensureRemoteDirs so an ssh/transport failure (exit 255)
        // parks as RESUME_WAITING instead of marking the op Failed, and so the
        // partial is not treated as an unmarked leftover.
        if (crossResumable && resumedArgs?.targetMarked === '1') {
            markerWritten = true
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

        // engine#497: record the target and write its in-flight marker before the first byte
        if (resumable) {
            setOperationArgs(storeHandle, opId, { targetInstanceId: String(newInstanceId), phase: 'copying', wasRunning: wasRunning ? '1' : '0' })
            await markInFlight(targetRoot, newInstanceId, opId, String(localEngineId))
            markerWritten = true
        }
        // engine#497 (a): the marker on the peer, written by its gate with this Engine's id
        if (crossResumable && peer) {
            if (!journal) {
                setOperationArgs(storeHandle, opId, {
                    targetInstanceId: String(newInstanceId), phase: 'copying', wasRunning: wasRunning ? '1' : '0',
                    crossEngine: 'true', crossResume: '1', targetEngineId: peer.engineId,
                })
            }
            await markPeerInFlight(peer.host, peer.engineId, targetRoot, String(newInstanceId), opId)
            markerWritten = true
            setOperationArgs(storeHandle, opId, { targetMarked: '1' })
        }

        // 4. rsync app master (idempotent — skips if already present and identical)
        setCopyStep(2)
        const appMasterDest = `${targetMountRoot}/apps/${appId}`
        log(`copyApp: syncing app master ${appMasterSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${appMasterDest}`)
        let appMasterBytes = 0
        let instanceBytes = 0
        if (opts.onByteProgress) {
            try { appMasterBytes = await directoryBytes(appMasterSrc) } catch { appMasterBytes = 0 }
            try { instanceBytes = await instanceDataBytes(sourceRoot, instance.id) } catch { instanceBytes = 0 }
        }
        const copyBytes = accumulateCopyByteProgress(opts.onByteProgress, appMasterBytes + instanceBytes)
        if (opts.onByteProgress) opts.onByteProgress({ bytesDone: 0, bytesTotal: appMasterBytes + instanceBytes })
        const appMasterByteProgress = copyBytes.stage(appMasterBytes)
        const appMasterProgress = (p: { progressPercent: number, bytesDone?: number }) => {
            updateOperation(storeHandle, opId, { progressPercent: Math.round(p.progressPercent * 0.25) })
            appMasterByteProgress(p)
        }
        if (peer) await rsyncToPeer(appMasterSrc.replace(/\/*$/, '/'), peer, receiveAppArgs(targetRoot, appId), appMasterProgress, opId)
        else await rsyncDirectory(appMasterSrc, appMasterDest, appMasterProgress, opId)

        // 5. Copy instance data into a NEW instance directory (new ID), as root through
        //    the app-data helper (idea#168): owners and modes are kept, and data pi
        //    cannot read is copied too. The helper creates the folder; cross-engine it
        //    sends to pi@<remote>, where that Engine's helper receives it (rrsync -wo).
        setCopyStep(3)
        const instanceDest = `${targetMountRoot}/instances/${newInstanceId}`
        // a resumable copy is kept (marked) on failure; only a cross-Engine one is removed
        if (!anyResumable) createdInstanceDest = instanceDest
        log(`copyApp: syncing instance data ${instanceSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${instanceDest} (idea-app-data ${isCrossEngine ? 'send' : 'copy'})`)
        const instanceByteProgress = copyBytes.stage(instanceBytes)
        await rsyncInstanceData(
            peer
                ? { kind: 'send', srcRoot: sourceRoot, srcId: instance.id, host: peer.host, peerEngineId: peer.engineId, dstRoot: targetRoot, dstId: newInstanceId, ...(crossResumable ? { opId } : {}) }
                : { kind: 'copy', srcRoot: sourceRoot, srcId: instance.id, dstRoot: targetRoot, dstId: newInstanceId, ...(resumable ? { opId } : {}) },
            (p) => {
                updateOperation(storeHandle, opId, { progressPercent: 25 + Math.round(p.progressPercent * 0.30) })
                instanceByteProgress(p)
            }, opId)

        // engine#497: verify against the source before the copy gets its own name and port
        if (resumable) {
            await verifyCopyOrThrow(sourceRoot, String(instance.id), targetRoot, String(newInstanceId), 'copyApp')
            setOperationArgs(storeHandle, opId, { phase: 'verified' })
        }
        // engine#497 (a): verified against the source on the peer (dry run both sides)
        if (crossResumable && peer) {
            await verifyPeerCopyOrThrow(sourceRoot, String(instance.id), peer.host, peer.engineId, targetRoot, String(newInstanceId), opId, 'copyApp')
            if (!journal) setOperationArgs(storeHandle, opId, { phase: 'verified' })
        }

        // 5a. Give the copy its own name and port (idea#168 r35). The rsync
        //     copied the original's compose.yaml (x-app.instanceName) and .env
        //     (port=). The copy gets a unique name (<name>-2, -3, …; see
        //     uniqueCopyName) and no port, so startInstance allocates one that is
        //     neither listening nor owned by another instance in the store.
        const copyName = opts.keepName ? instance.name
            : ((resumedArgs?.copyName as InstanceName | undefined) || uniqueCopyName(storeHandle.doc(), String(instance.name)))
        if (anyResumable && !journal) setOperationArgs(storeHandle, opId, { copyName: String(copyName) })
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
        if (kolibriCopy && !preserveId) {
            // Flat marker at instance root (receive-files / put-files place basenames).
            // Peer: receive-files through the gate. Local: put-files as root (app-data policy).
            const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-kolibri-rebind-'))
            try {
                await fs.writeFile(`${tmp}/.idea-rebind-morango`, 'r40\n')
                if (peer) {
                    await rsyncToPeer(
                        [`${tmp}/.idea-rebind-morango`],
                        peer,
                        receiveFilesArgs(targetRoot, newInstanceId),
                        undefined,
                        opId,
                    )
                } else {
                    await putInstanceFiles(targetRoot, newInstanceId, tmp)
                }
            } finally {
                await fs.remove(tmp).catch(() => undefined)
            }
            log(`copyApp: wrote Kolibri morango-rebind marker so start mints a fresh id (r40)`)
        }

        // 5b. rsync service image tars needed by this instance
        //     services/ holds the Docker image tars that startInstance loads via
        //     `docker image load`. Without them the copied instance cannot start.
        //     Names come from serviceImageTarName (repo:tag, not @sha256; idea#445).
        setCopyStep(4)
        const sourceMountRootCopy = await diskMountRoot(sourceDisk)
        const copyServicesSrcDir = `${sourceMountRootCopy}/services`
        const copyServicesDestDir = `${targetMountRoot}/services`
        if (instance.serviceImages?.length) {
            let servicesDone = 0
            for (const serviceImage of instance.serviceImages) {
                const tarName = serviceImageTarName(serviceImage as string)
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

        if (opts.onByteProgress) copyBytes.finish()

        // 6. Register/start the new instance
        setCopyStep(5)

        // Restart the source BEFORE the copy starts (idea#168 r35): the
        // original takes its own port back first, and the copy can never grab
        // it while the original is down for the snapshot.
        if (wasRunning && !opts.keepSourceStopped) await restartSource('before the copy starts')

        if (preserveId) {
            // engine#381: the existing instanceDB row stays the source of truth
            // until moveApp flips storedOn after verify. Do not start the target
            // here (the move starts it on the target disk during Checking).
            log(`copyApp: kept instance id ${newInstanceId} on '${targetDisk.name}' (${targetDisk.id}); storedOn is unchanged until verify`)
        } else if (isCrossEngine) {
            // Cross-engine: create instance record in shared store (as Docked),
            // then tell the remote engine to start it (dispatchToPeer, peer grant).
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
                    portZip: null,
                    serviceImages: serviceImages as ServiceImage[],
                    created: Date.now() as Timestamp,
                    lastBackup: null,
                    lastStarted: 0 as Timestamp,
                    currentStep: null,
                    totalSteps: null,
                    stepLabel: null,
                    metrics: null,
                }
                applyBackupMethod(newInst, compose)   // idea#403
                doc.instanceDB[newInstanceId] = newInst
            })
            // engine#497 (a): registered; then the marker on the peer goes, before the start
            if (crossResumable && peer) {
                setOperationArgs(storeHandle, opId, { phase: 'registered' })
                await clearPeerInFlight(peer.host, peer.engineId, targetRoot, String(newInstanceId), opId)
                markerWritten = false
                setOperationArgs(storeHandle, opId, { phase: 'done', targetMarked: null })
            }
            // Tell the remote engine to start this instance, by id (idea#168)
            log(`copyApp: sending startInstance command to remote engine '${targetDisk.dockedTo}'`)
            void dispatchToPeer(storeHandle, String(targetDisk.dockedTo), `startInstance ${newInstanceId} ${targetDisk.id} --cause cross-engine-cmd`)
        } else {
            // Local: use existing processInstance flow
            log(`copyApp: registering new instance ${newInstanceId} on disk '${targetDisk.name}' (${targetDisk.id})`)
            // engine#497: the copy's own op may register (and start) its marked folder
            if (resumable) {
                await processInstance(storeHandle, targetDisk, newInstanceId, { inFlightOpId: opId })
                setOperationArgs(storeHandle, opId, { phase: 'registered' })
                await clearInFlight(targetRoot, newInstanceId, opId)
                markerWritten = false
                setOperationArgs(storeHandle, opId, { phase: 'done' })
            } else {
                await processInstance(storeHandle, targetDisk, newInstanceId)
            }
        }

        if (!journal) updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            ...(anyResumable ? { error: null } : {}),
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`copyApp: done — new instance ${newInstanceId} on '${targetDisk.name}' (${targetDisk.id})`))

    } catch (e: any) {
        // Don't overwrite Cancelled status (set by cancelOperation before SIGTERM completes)
        copyError = e instanceof Error ? e : new Error(String(e))
        const currentStatus = storeHandle.doc()?.operationDB?.[opId]?.status
        if (markerWritten && journal) {
            // engine#497 (a): the copy step of a cross-Engine move; the move parks its own op
        } else if (markerWritten && crossResumable) {
            // engine#497 (a): the partial copy stays on the peer under its marker; this Engine
            // resumes the op and pushes again into the same folder (nothing is deleted there)
            if (currentStatus !== 'Cancelled') await parkCrossCopyMove(storeHandle, opId, String(sourceDisk.id), String(targetDisk.id), String(targetDisk.dockedTo), e)
        } else if (markerWritten) {
            // engine#497 (Koen's rule; r36 delete-on-failure withdrawn for local copies): the
            // partial copy stays, under its marker, and the op resumes at the next boot or dock
            if (currentStatus !== 'Cancelled') await parkCopyMove(storeHandle, opId, [String(sourceDisk.id), String(targetDisk.id)], e)
        } else if (currentStatus !== 'Cancelled' && !journal) {
            updateOperation(storeHandle, opId, {
                status: 'Failed',
                error: e.message ?? String(e),
                completedAt: Date.now() as Timestamp,
            })
        }
        console.error(chalk.red(`copyApp: failed — ${e.message ?? e}${markerWritten ? ` (the partial copy instances/${newInstanceId} is kept under its in-flight marker; the operation resumes)` : ''}`))
        // Remove the partial copy unless a *new* id was already registered (fresh
        // id, so the folder holds only what this op wrote). When preserveId, the
        // existing instanceDB[id] is the source row — still delete only the target
        // folder, never the source, never the store row (engine#381).
        const registeredFresh = !preserveId && storeHandle.doc()?.instanceDB?.[newInstanceId]
        if (createdInstanceDest && !registeredFresh) {
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
        endUsageSkip('move')
        // Always restart the source if we stopped it and the success path did not
        // engine#497 stage 3 (c), Koen Q2: a cross-Engine move's source stays stopped once its target is marked
        if (wasRunning && !sourceRestarted && ((copyError && !(journal && markerWritten)) || !opts.keepSourceStopped)) await restartSource('after a failed copy')
    }
    if (copyError && opts.rethrow) throw copyError
    return copyError ? null : newInstanceId
}

// ── moveApp ───────────────────────────────────────────────────────────────────

/**
 * engine#497: finish a resumed local move that registered the instance on the target
 * before the Engine stopped: start it there if it ran before, remove the source folder
 * (and the app master when no other instance on the source needs it), clear the marker.
 */
const finishRegisteredMove = async (storeHandle: DocHandle<Store>, opId: string, args: Record<string, string>): Promise<void> => {
    const store = storeHandle.doc()
    const id = String(args.instanceId) as InstanceID
    const sourceDisk = getDisk(store, args.sourceDiskId as DiskID) as Disk | undefined
    const targetDisk = getDisk(store, args.targetDiskId as DiskID) as Disk | undefined
    if (!sourceDisk?.device) throw new Error(`moveApp: source disk ${args.sourceDiskId} is not docked; the move resumes when it is`)
    if (!targetDisk?.device) throw new Error(`moveApp: target disk ${args.targetDiskId} is not docked; the move resumes when it is`)
    const instance = getInstance(store, id)
    if (!instance || String(instance.storedOn) !== String(targetDisk.id)) {
        throw new Error(`moveApp: instance ${id} is not registered on '${targetDisk.name}' (${targetDisk.id}); cannot finish the move`)
    }
    const lockKeys = [instanceKey(id), diskKey(sourceDisk.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(lockKeys, 'moveApp')) {
        throw new Error(`moveApp: resource locked — another operation is already running on instance '${id}' or one of its disks`)
    }
    beginUsageSkip('move')
    try {
        updateOperation(storeHandle, opId, { status: 'Running' })
        const helperIssue = await resumeHelperProblem('moveApp on this Engine (resumable move, engine#497)')
        if (helperIssue) throw new Error(`HELPER_OUTDATED: ${helperIssue}`)
        log(`moveApp: resuming operation ${opId} after registration: finishing the move of ${id} to '${targetDisk.name}'`)
        const sourceRoot = await appDataRoot(sourceDisk)
        const targetRoot = await appDataRoot(targetDisk)
        if (args.wasRunning === '1' && instance.status !== 'Running') {
            log(`moveApp: starting moved instance ${id} on '${targetDisk.name}'`)
            await startInstance(storeHandle, instance, targetDisk, 'post-move', { inFlightOpId: opId })
        }
        const sourceMountRoot = await diskMountRoot(sourceDisk)
        if (await fs.pathExists(`${sourceMountRoot}/instances/${id}`)) {
            log(`moveApp: removing source instance directory ${sourceMountRoot}/instances/${id} (idea-app-data delete)`)
            try {
                await deleteInstanceData(sourceRoot, id)
            } catch (e: any) {
                log(chalk.yellow(`moveApp: could not remove ${sourceMountRoot}/instances/${id}: ${e.message}. Remove the leftover folder by hand.`))
            }
        }
        const appId = String(instance.instanceOf)
        const appMasterSrc = `${sourceMountRoot}/apps/${appId}`
        const stillNeedsAppMaster = getInstancesOfDisk(storeHandle.doc(), sourceDisk).some(i => i.instanceOf === appId)
        if (!stillNeedsAppMaster && await fs.pathExists(appMasterSrc)) {
            log(`moveApp: removing app master ${appMasterSrc} (no other instances on source disk)`)
            await fs.remove(childPathInside(`${sourceMountRoot}/apps`, appId))
        }
        await clearInFlight(targetRoot, id, opId)
        setOperationArgs(storeHandle, opId, { phase: 'done' })
        updateOperation(storeHandle, opId, { status: 'Done', progressPercent: 100, error: null, completedAt: Date.now() as Timestamp })
        log(chalk.green(`moveApp: done — instance ${id} moved to '${targetDisk.name}' (${targetDisk.id}); resumed after registration`))
    } catch (e: any) {
        if (storeHandle.doc()?.operationDB?.[opId]?.status !== 'Cancelled') {
            await parkCopyMove(storeHandle, opId, [String(sourceDisk.id), String(targetDisk.id)], e)
        }
        console.error(chalk.red(`moveApp: failed — ${e.message ?? e} (the operation resumes)`))
        if (e instanceof MoveError) throw e
        throw new MoveError('COPY_FAILED', moveFailedText(e?.message ?? String(e)))
    } finally {
        resourceLock.releaseAll(lockKeys)
        endUsageSkip('move')
    }
}

/** Options for moveApp (engine#497). */
export interface MoveAppOptions {
    /**
     * Internal only (not on the CLI): boot recovery re-runs an interrupted local moveApp
     * inside its original Operation, so that op ends Done or Failed and is not retried again.
     */
    recoveredOpId?: string
}

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
    opts: MoveAppOptions = {},
): Promise<MoveResult | void> => {
    const store = storeHandle.doc()

    // A target disk on another Engine is a cross-Engine move (idea#79): copy,
    // verify on the target, then quarantine the source. See MoveAppRemote.ts.
    const { localEngineId: localId } = await import('./Engine.js')
    const tgt = getDisk(store, targetDiskId) as Disk | undefined
    if (tgt?.dockedTo && String(tgt.dockedTo) !== String(localId)) {
        const { moveAppCrossEngine } = await import('./MoveAppRemote.js')
        // engine#497 stage 3 (a): a resumable cross-Engine move resumes in its own op
        const recovered = opts.recoveredOpId ? store?.operationDB?.[opts.recoveredOpId] : undefined
        if (recovered?.move && recovered.args?.crossResume === '1') {
            return moveAppCrossEngine(storeHandle, instanceName, sourceDiskId, targetDiskId, cause, {}, { recoveredOpId: opts.recoveredOpId })
        }
        // engine#497: an interrupted local move whose target is now on another Engine is
        // not turned into a cross-Engine move by recovery; the operator re-issues it.
        if (opts.recoveredOpId) throw new Error(`moveApp: the target disk ${targetDiskId} is now docked to another Engine; the interrupted local move is not retried, re-issue the move`)
        return moveAppCrossEngine(storeHandle, instanceName, sourceDiskId, targetDiskId, cause)
    }

    // engine#497: a resumed move that already registered the instance on the target only
    // finishes (start there, remove the source, clear the marker)
    const resumedArgs = (opts.recoveredOpId ? store?.operationDB?.[opts.recoveredOpId]?.args : undefined) as Record<string, string> | undefined
    if (opts.recoveredOpId && resumedArgs?.phase) {
        const storedOnNow = store?.instanceDB?.[(resumedArgs.instanceId ?? '') as InstanceID]?.storedOn
        if (resumedArgs.phase === 'registered' || String(storedOnNow ?? '') === String(resumedArgs.targetDiskId)) {
            return finishRegisteredMove(storeHandle, opts.recoveredOpId, resumedArgs)
        }
    }

    const v = await validate(store, instanceName, sourceDiskId, targetDiskId, 'move')
    // Validation refusals throw (idea#168 r29@97), so the command trace or
    // crash-recovery retry ends as error instead of silently succeeding.
    if (typeof v === 'string') throw new Error(`moveApp: ${v}`)
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc, sourceRoot, targetRoot } = v


    // Acquire per-resource locks: instance + both disks
    const moveLockKeys = [instanceKey(instance.id), diskKey(sourceDisk.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(moveLockKeys, 'moveApp')) {
        throw new Error(`moveApp: resource locked — another operation is already running on instance '${instanceName}' or one of its disks. Retry when it completes.`)
    }

    const opId = opts.recoveredOpId ?? createOperation(storeHandle, 'moveApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
        instanceName: String(instance.name),
    }, cause, { type: 'instance', id: instance.id })
    beginUsageSkip('move')

    let wasRunning = resumedArgs?.wasRunning === '1'
    // engine#497 (Koen's rule): set once instances/<id>.idea-op-in-flight is written on the
    // target. The idea#168 removal of a partial target is withdrawn for local moves: a
    // failure keeps the partial copy under its marker and parks the op to resume.
    let markerWritten = false

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
        const helperIssue = await resumeHelperProblem('moveApp on this Engine (resumable move, engine#497)')
        if (helperIssue) throw new Error(`HELPER_OUTDATED: ${helperIssue}`)
        if (resumedArgs?.phase) log(`moveApp: resuming operation ${opId} (phase ${resumedArgs.phase}) into instances/${instance.id} on '${targetDisk.name}'`)

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
        let needed = await directoryBytes(appMasterSrc) + await instanceDataBytes(sourceRoot, instance.id)
        // engine#497: a resumed move only needs what is not on the target yet
        if (resumedArgs?.phase) {
            try { needed = Math.max(0, needed - await instanceDataBytes(targetRoot, instance.id)) } catch { /* nothing copied yet */ }
        }
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

        // engine#497: record the target and write its in-flight marker before the first byte
        const { localEngineId: engineIdNow } = await import('./Engine.js')
        setOperationArgs(storeHandle, opId, { targetInstanceId: String(instance.id), phase: 'copying', wasRunning: wasRunning ? '1' : '0' })
        await markInFlight(targetRoot, instance.id, opId, String(engineIdNow))
        markerWritten = true

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
        await rsyncInstanceData({ kind: 'copy', srcRoot: sourceRoot, srcId: instance.id, dstRoot: targetRoot, dstId: instance.id, opId },
            ({ progressPercent }) => {
                updateOperation(storeHandle, opId, { progressPercent: 25 + Math.round(progressPercent * 0.30) })
            }, opId)
        // engine#497: the source is removed only after the target verified
        await verifyCopyOrThrow(sourceRoot, String(instance.id), targetRoot, String(instance.id), 'moveApp')
        setOperationArgs(storeHandle, opId, { phase: 'verified' })

        // 5b. rsync service image tars needed by this instance
        //     services/ holds the Docker image tars that startInstance loads via
        //     `docker image load`. Without them the moved instance cannot start.
        //     Names come from serviceImageTarName (repo:tag, not @sha256; idea#445).
        setMoveStep(4)
        const sourceMountRootMove = await diskMountRoot(sourceDisk)
        const moveServicesSrcDir = `${sourceMountRootMove}/services`
        const moveServicesDestDir = `${targetMountRoot}/services`
        if (instance.serviceImages?.length) {
            let servicesDone = 0
            for (const serviceImage of instance.serviceImages) {
                const tarName = serviceImageTarName(serviceImage as string)
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

        // 6. Register on target disk (storedOn set here). A previously running instance is started just below (idea#474).
        //    This MUST succeed before we touch the source record — if cancelled before
        //    this point the source record is untouched and the operator can retry cleanly.
        setMoveStep(5)
        // idea#468: take down the source compose project (no -v) after the copy
        // succeeded and BEFORE processInstance, which may auto-start the same
        // instance id on the target (same compose project name). Named volumes
        // stay, so a failed register can still restart the source. A down
        // failure is logged and does not fail the move or roll it back.
        try {
            await composeDownAt(instanceSrc, instance.id)
        } catch (e: any) {
            log(`moveApp: compose down of source project ${instance.id} failed: ${e?.message ?? e}; volumes were not removed, continuing`)
        }

        log(`moveApp: registering instance ${instance.id} on disk '${targetDisk.name}' (${targetDisk.id})`)
        // kc8 step 104: claim the id explicitly (moveFrom). Without it the engine#381
        // guard refused the claim, storedOn stayed on the source while the instance
        // was started from the target, and ejecting the target never stopped it.
        await processInstance(storeHandle, targetDisk, instance.id, { moveFrom: sourceDisk.id, inFlightOpId: opId })
        const storedOnNow = storeHandle.doc()?.instanceDB?.[instance.id]?.storedOn
        if (String(storedOnNow) !== String(targetDisk.id)) {
            throw new Error(`moveApp: instance ${instance.id} was not registered on '${targetDisk.name}' (${targetDisk.id}); storedOn is ${storedOnNow ?? 'none'}`)
        }
        setOperationArgs(storeHandle, opId, { phase: 'registered' })

        // idea#474: processInstance does not auto-start a just-stopped instance
        // (shouldAutoStart skips status Stopped). If it was running before the
        // move, start it on the target — running in, running out. Do this
        // before the source folder is removed, so a failed start can still
        // leave the source data in place.
        if (wasRunning) {
            const moved = getInstance(storeHandle.doc(), instance.id)
            if (moved) {
                log(`moveApp: starting moved instance '${instanceName}' on '${targetDisk.name}'`)
                await startInstance(storeHandle, moved, targetDisk, 'post-move', { inFlightOpId: opId })
            }
        }

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
            await fs.remove(childPathInside(`${sourceMountRootMove}/apps`, appId))
        } else {
            log(`moveApp: keeping app master ${appMasterSrc} (other instances still use it)`)
        }

        // engine#497: the marker goes only after success
        await clearInFlight(targetRoot, instance.id, opId)
        markerWritten = false
        setOperationArgs(storeHandle, opId, { phase: 'done' })

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            error: null,
            completedAt: Date.now() as Timestamp,
        })
        try { await pruneUnusedInstanceNetworks(instance.id) } catch (e: any) {
            log(`moveApp: network prune for ${instance.id}: ${e?.message ?? e}`)
        }
        log(chalk.green(`moveApp: done — instance ${instance.id} moved to '${targetDisk.name}' (${targetDisk.id})`))

    } catch (e: any) {
        // Don't overwrite Cancelled status (set by cancelOperation before SIGTERM completes)
        const currentStatus = storeHandle.doc()?.operationDB?.[opId]?.status
        if (markerWritten) {
            // engine#497 (Koen's rule; the idea#168 removal of the partial target is withdrawn
            // for local moves): the partial copy stays under its marker; the op resumes later
            if (currentStatus !== 'Cancelled') await parkCopyMove(storeHandle, opId, [String(sourceDisk.id), String(targetDisk.id)], e)
        } else if (currentStatus !== 'Cancelled') {
            updateOperation(storeHandle, opId, {
                status: 'Failed',
                error: e.message ?? String(e),
                completedAt: Date.now() as Timestamp,
            })
        }
        console.error(chalk.red(`moveApp: failed — ${e.message ?? e}${markerWritten ? ` (the partial copy on '${targetDisk.name}' is kept under its in-flight marker; the operation resumes)` : ''}`))

        const stillOnSource = String(storeHandle.doc()?.instanceDB?.[instance.id]?.storedOn) === String(sourceDisk.id)

        // On failure, restart the source only if we stopped it and it is still
        // registered there (idea#474: after a successful register, a later
        // start-on-target failure must not start the old source project).
        // engine#497 stage 3 (c): not while the move is in flight under its marker (parked to
        // resume): the source stays stopped until the move resumes, and is started again by
        // restartMoveSourceAfterGiveUp only if the move gives up (RESUME_GAVE_UP).
        if (wasRunning && stillOnSource && !markerWritten) {
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
        // idea#475: rethrow so the command trace ends as error (not ok) with a
        // leading result code in the same style as a cross-Engine move.
        if (e instanceof MoveError) throw e
        const reason = e?.message ?? String(e)
        throw new MoveError('COPY_FAILED', moveFailedText(reason))
    } finally {
        resourceLock.releaseAll(moveLockKeys)
        endUsageSkip('move')
    }
}

/**
 * engine#497 stage 3 (c): a resumable local move gave up (RESUME_GAVE_UP). If it had stopped
 * the source (args.wasRunning) and the instance is still stored on the source disk, docked
 * here, start it there again. If the source disk is not docked here, nothing is started now:
 * the op is terminal, so the next dock of the source disk auto-starts it as usual.
 */
export const restartMoveSourceAfterGiveUp = async (storeHandle: DocHandle<Store>, op: { id: string, args?: Record<string, string>, move?: any, error?: string | null }): Promise<void> => {
    const args = (op.args ?? {}) as Record<string, string>
    // engine#497 stage 3 (a): a cross-Engine move records its end on op.move first
    if (op.move) {
        const { crossMoveGaveUp } = await import('./MoveAppRemote.js')
        await crossMoveGaveUp(storeHandle, op)
    }
    if (args.wasRunning !== '1') return
    const store = storeHandle.doc()
    const instance = getInstance(store, String(args.instanceId ?? '') as InstanceID)
    if (!instance || String(instance.storedOn) !== String(args.sourceDiskId)) return
    const sourceDisk = getDisk(store, args.sourceDiskId as DiskID) as Disk | undefined
    const { localEngineId } = await import('./Engine.js')
    if (!sourceDisk?.device || String(sourceDisk.dockedTo) !== String(localEngineId)) {
        log(`moveApp: operation ${op.id} gave up; source disk ${args.sourceDiskId} is not docked here, so '${instance.name}' starts at its next dock`)
        return
    }
    log(`moveApp: operation ${op.id} gave up; starting the source instance '${instance.name}' (${instance.id}) on '${sourceDisk.name}' again`)
    await startInstance(storeHandle, instance, sourceDisk, 'post-move')
}
resumeGaveUpHooks.moveApp = restartMoveSourceAfterGiveUp

// recoverInterruptedOperations moved to Operations.ts
export { recoverInterruptedOperations } from './Operations.js'
