/**
 * MoveAppRemote.ts — moveApp to a disk on another Engine (idea#79, engine#381).
 *
 * A move keeps the same instance id (and its Backup Disk link). In one moveApp op:
 *   1. Copying  — the existing cross-Engine copyApp path with an internal dstId
 *                 equal to the source id (not on the CLI), journaled into this op.
 *                 No second instanceDB row; storedOn stays on the source until verify.
 *   2. Checking — the target Engine runs verifyMoveTarget against the folder on
 *                 operation.args.targetDiskId (not storedOn). Size must match, and
 *                 when the source was running the port-ready registry must reach
 *                 stable. The verdict is written into Operation.move.verify.
 *                 While it waits, the target broadcasts ephemeral idea/progress
 *                 Checking messages about once a second (never stored; idea#498 option 3).
 *   3. Removing — only when move.verified was recorded: storedOn flips to the
 *                 target disk, then only the source folder is quarantined (helper
 *                 v4; never rm). removeInstance is not used, so the store row is kept.
 * Copy or verify failure does not flip storedOn or touch the source folder
 * (MOVE FAILED: … source kept). COPY_FAILED is only used when the copy itself
 * did not finish (no cleanupMoveTarget). After the target folder exists, a
 * pre-flip failure (including a failed source-size measurement after the copy)
 * also has the target Engine stop any Checking container and quarantine
 * the target folder (engine#388; never rm; storedOn stays on the source).
 * The source marks the operation terminal (Failed, or Done for SOURCE_CHANGED)
 * before sending cleanupMoveTarget, and waits up to CLEANUP_TIMEOUT_MS (60 s).
 * The target refuses a late or duplicate cleanup unless that op is the latest
 * moveApp for the instance and is in a terminal non-success state.
 * SOURCE_CHANGED (source started or written to) keeps that code and a
 * MOVE STOPPED: …; source kept text. Other pre-flip errors use SOURCE_KEPT
 * (not MOVED). SOURCE_NOT_REMOVED / MOVED, source not removed: … is only used
 * after storedOn has flipped and removeSource fails. Restart recovery never
 * removes the source (Operations.recoverInterruptedOperations): if not
 * verified, only an unverified target folder is cleaned up; if verified, storedOn
 * is flipped if needed and a leftover source folder is not claimed.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { Store, getDisk, getInstance, getEngine } from './Store.js'
import { Disk, appDataRoot, diskMountRoot } from './Disk.js'
import { Instance, startInstance } from './Instance.js'
import { CHECKING_PROGRESS_INTERVAL_MS, checkingProgressMessage, clearPortReadyProgress, getPortReadyProgress } from './PortReadyProgress.js'
import { InstanceID, InstanceName, DiskID, EngineID, OperationCause, Timestamp, Command } from './CommonTypes.js'
import { createOperation, updateOperation } from './Operations.js'
import { attachTraceResult } from './SummariseDisk.js'
import { sendCommand } from '../utils/commandUtils.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { instanceDataBytes, helperAtLeast, deleteInstanceData, deleteRemoteInstanceData, remoteInstanceFolderExists } from '../utils/appDataHelper.js'
import { REMOVE_HELPER_MIN, RemoveError, quarantineInstanceOnDisk } from './RemoveInstance.js'
import { getEngineAddress } from './Network.js'
import { fs } from 'zx'
import {
    MOVE_CROSS_ENGINE_CAPABILITY, MOVE_STEPS, MOVE_STEP_INDEX, MoveError, MoveProgress, MoveResult,
    MOVE_FAILURE_CODES, MoveRefusalCode, MoveVerify, VerifyCode, MoveFailureCode, moveFailedText, movedText, sourceNotRemovedText, sourceKeptText, withTargetCleanupText, sizesMatch,
} from './MoveAppShapes.js'

export interface MoveDeps {
    localEngineId: () => Promise<string>
    validate: (store: Store, name: InstanceName, src: DiskID, tgt: DiskID) => Promise<{ instance: Instance, sourceDisk: Disk, targetDisk: Disk } | string>
    helperProblem: () => Promise<string | null>
    sourceBytes: (disk: Disk, id: InstanceID) => Promise<number>
    copy: (storeHandle: DocHandle<Store>, instanceId: InstanceID, src: DiskID, tgt: DiskID, cause: OperationCause, opId: string) => Promise<InstanceID>
    requestVerify: (storeHandle: DocHandle<Store>, targetEngineId: string, command: string) => void
    requestStart: (storeHandle: DocHandle<Store>, targetEngineId: string, command: string) => void
    /** Ask the target Engine to stop the Checking container and quarantine the target folder (engine#388). */
    requestCleanup: (storeHandle: DocHandle<Store>, targetEngineId: string, command: string) => void
    /** True when instances/<id> already exists on the target disk (local folder or remote size). */
    targetFolderExists: (store: Store, disk: Disk, id: InstanceID) => Promise<boolean>
    startSource: (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk) => Promise<void>
    removeSource: (storeHandle: DocHandle<Store>, instanceId: InstanceID, engineId: string, sourceDiskId: DiskID) => Promise<{ quarantinePath: string }>
    verifyTimeoutMs: number
    /** How long the source waits for the target to report move.targetCleanup (default CLEANUP_TIMEOUT_MS). Does not change verify timing. */
    cleanupTimeoutMs: number
    /** Fallback poll while waiting for Operation.move.verify; the source prefers the store change event (idea#498). */
    pollMs: number
    broadcast?: (msg: object) => void
}


/** True when a keep-id move to `diskId` is in flight for `instanceId` (storedOn still names the source). */
export const isInFlightKeepIdMove = (store: Store, instanceId: string, diskId: string): boolean => {
    for (const op of Object.values(store.operationDB ?? {})) {
        if (!op || op.kind !== 'moveApp' || !op.move) continue
        if (op.move.verified === true || op.move.sourceRemoved === true) continue
        if (op.status === 'Done' || op.status === 'Failed') continue
        if (String(op.args?.targetDiskId ?? '') !== String(diskId)) continue
        const src = String(op.move.sourceInstanceId ?? op.args?.instanceId ?? '')
        const tgt = String(op.move.targetInstanceId ?? '')
        if (src === String(instanceId) || (tgt && tgt === String(instanceId))) return true
    }
    return false
}

const occupyingTarget = (store: Store, instanceId: InstanceID, targetDisk: Disk, targetEngineId: string): string | null => {
    const row = getInstance(store, instanceId)
    if (!row?.storedOn) return null
    if (String(row.storedOn) === String(targetDisk.id)) return String(targetDisk.name ?? targetDisk.id)
    const on = getDisk(store, row.storedOn as DiskID)
    if (on && String(on.dockedTo) === String(targetEngineId)) return String(on.name ?? on.id)
    return null
}

export const defaultTargetFolderExists = async (_store: Store, disk: Disk, id: InstanceID): Promise<boolean> => {
    const { localEngineId } = await import('./Engine.js')
    const root = await appDataRoot(disk)
    if (String(disk.dockedTo) === String(localEngineId)) {
        try {
            const mount = await diskMountRoot(disk)
            if (await fs.pathExists(`${mount}/instances/${id}`)) return true
        } catch { /* fall through */ }
        return false
    }
    try {
        const host = getEngineAddress(disk.dockedTo as EngineID)
        if (!host) return false
        return await remoteInstanceFolderExists(host, String(disk.dockedTo), root, String(id))
    } catch {
        return false
    }
}

/** After a recorded verify, flip storedOn to the target (if not already) and clear the source Engine's port. */
export const flipStoredOnAfterVerify = (storeHandle: DocHandle<Store>, instanceId: string, targetDiskId: string): void => {
    storeHandle.change(doc => {
        const inst = doc.instanceDB[instanceId as InstanceID]
        if (!inst) return
        inst.storedOn = targetDiskId as DiskID
        inst.port = 0 as any
        inst.portZip = null
        inst.metrics = null
    })
}

/** Best-effort: delete only an unverified target folder. Never touches the source or instanceDB. */
export const cleanupUnverifiedMoveTarget = async (storeHandle: DocHandle<Store>, op: { args?: Record<string, string>, move?: { targetInstanceId?: string | null, sourceInstanceId?: string } }): Promise<void> => {
    const id = String(op.move?.targetInstanceId ?? op.move?.sourceInstanceId ?? op.args?.instanceId ?? '')
    const tgt = String(op.args?.targetDiskId ?? '')
    if (!id || !tgt) return
    const disk = getDisk(storeHandle.doc(), tgt as DiskID)
    if (!disk) return
    const root = await appDataRoot(disk)
    const { localEngineId } = await import('./Engine.js')
    try {
        if (String(disk.dockedTo) === String(localEngineId)) {
            await deleteInstanceData(root, id)
        } else if (disk.dockedTo) {
            const host = getEngineAddress(disk.dockedTo as EngineID)
            if (host) await deleteRemoteInstanceData(host, String(disk.dockedTo), root, id)
        }
        log(`moveApp recovery: removed unverified target folder ${id} on ${tgt}`)
    } catch (e: any) {
        log(`moveApp recovery: could not remove unverified target folder ${id} on ${tgt}: ${e?.message ?? e}`)
    }
}

/**
 * How long the source waits for the target to report move.targetCleanup.
 * compose down uses docker's default 10 s stop timeout, then leftover-container
 * cleanup and a same-filesystem helper rename. engine#387 saw a source
 * quarantine take 30.5 s; 60 s covers a slow stop plus Automerge confirmation
 * without holding a VERIFY_* report for 6 min (engine#388 follow-up). A late
 * cleanup after this bound is refused if a newer moveApp exists. Does not
 * change verify timing.
 */
export const CLEANUP_TIMEOUT_MS = 60 * 1000

/** Default copyApp hooks ephemeral byte progress registered by moveAppCrossEngine (per opId). */
const copyByteProgressByOp = new Map<string, (p: CopyByteProgress, force?: boolean) => void>()

const defaultDeps: MoveDeps = {
    localEngineId: async () => String((await import('./Engine.js')).localEngineId),
    validate: async (store, name, src, tgt) => {
        const { validate } = await import('./CopyMoveApp.js')
        return validate(store, name, src, tgt, 'copy')
    },
    helperProblem: () => helperAtLeast(REMOVE_HELPER_MIN, 'moveApp to another Engine'),
    sourceBytes: async (disk, id) => instanceDataBytes(await appDataRoot(disk), String(id)),
    copy: async (storeHandle, instanceId, src, tgt, cause, opId) => {
        const { copyApp } = await import('./CopyMoveApp.js')
        const onByteProgress = copyByteProgressByOp.get(opId)
        const id = await copyApp(storeHandle, instanceId as unknown as InstanceName, src, tgt, cause, {
            journalOpId: opId, keepName: true, rethrow: true, keepSourceStopped: true, dstId: instanceId,
            onByteProgress: onByteProgress ? (p) => onByteProgress(p) : undefined,
        })
        if (!id) throw new Error('the copy did not finish')
        return id
    },
    requestVerify: (storeHandle, engineId, command) => sendCommand(storeHandle, engineId as EngineID, command as Command),
    requestStart: (storeHandle, engineId, command) => sendCommand(storeHandle, engineId as EngineID, command as Command),
    requestCleanup: (storeHandle, engineId, command) => sendCommand(storeHandle, engineId as EngineID, command as Command),
    targetFolderExists: defaultTargetFolderExists,
    startSource: (storeHandle, instance, disk) => startInstance(storeHandle, instance, disk, 'post-move'),
    removeSource: async (storeHandle, instanceId, _engineId, sourceDiskId) => {
        const disk = getDisk(storeHandle.doc(), sourceDiskId)
        if (!disk) throw new RemoveError('NOT_FOUND', `source disk '${sourceDiskId}' not found`)
        // The copy already stopped the source and SOURCE_CHANGED re-checks it;
        // compose down -t 0 avoids waiting out a stop timeout on a stopped container.
        return quarantineInstanceOnDisk(disk, instanceId, { composeTimeoutSec: 0 })
    },
    verifyTimeoutMs: 6 * 60 * 1000,
    cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
    pollMs: 250,
}

/** Map a copyApp validate() refusal text to a refusal code. */
export const refusalCode = (text: string): MoveRefusalCode => {
    if (/ambiguous/i.test(text)) return 'AMBIGUOUS'
    if (/not found|not docked/i.test(text)) return 'NOT_FOUND'
    if (/docked to a remote engine/i.test(text)) return 'SOURCE_REMOTE'
    if (/not currently reachable/i.test(text)) return 'TARGET_UNREACHABLE'
    if (/key|peer access|accepted/i.test(text)) return 'PEER_ACCESS'
    if (/already exists/i.test(text)) return 'TARGET_EXISTS'
    return 'INVALID'
}

/** True when the Engine record counts the capability (same rule as the Console). */
export const engineHasCapability = (store: Store, engineId: string, cap: string): boolean => {
    const e = getEngine(store, engineId as EngineID) as any
    if (!e || !Array.isArray(e.capabilities) || !e.capabilities.includes(cap)) return false
    return e.capabilitiesBootedAt === undefined || e.capabilitiesBootedAt === e.lastBooted
}

const patchMove = (storeHandle: DocHandle<Store>, opId: string, patch: Partial<MoveProgress>) => {
    storeHandle.change(doc => {
        const op = doc.operationDB?.[opId] as any
        if (!op?.move) return
        for (const [k, v] of Object.entries(patch)) op.move[k] = v === undefined ? null : v
    })
}

const setPhase = (storeHandle: DocHandle<Store>, opId: string, phase: 'copying' | 'checking' | 'removing') => {
    const step = MOVE_STEP_INDEX[phase]
    patchMove(storeHandle, opId, { phase })
    updateOperation(storeHandle, opId, { status: 'Running', currentStep: step, totalSteps: MOVE_STEPS.length, stepLabel: MOVE_STEPS[step] })
}

const finish = (storeHandle: DocHandle<Store>, opId: string, result: MoveResult, failed: boolean) => {
    patchMove(storeHandle, opId, { phase: failed ? 'failed' : 'done', code: result.code, resultText: result.text })
    updateOperation(storeHandle, opId, {
        status: failed ? 'Failed' : 'Done',
        error: result.code === 'MOVED' ? null : result.text,
        progressPercent: failed ? null : 100,
        completedAt: Date.now() as Timestamp,
    })
}

export const MOVE_PROGRESS_TYPE = 'idea/progress' as const
/** Copying idea/progress is throttled to about once a second (engine#387). */
export const COPY_PROGRESS_INTERVAL_MS = 1_000

export type CopyByteProgress = { bytesDone: number, bytesTotal: number }

/** Emit Copying idea/progress at most once per interval, plus the first and a forced last. */
export const throttledCopyProgress = (
    emit: (msg: object) => void,
    opId: string,
    intervalMs: number = COPY_PROGRESS_INTERVAL_MS,
    now: () => number = Date.now,
): ((p: CopyByteProgress, force?: boolean) => void) => {
    let lastAt = 0
    return (p, force = false) => {
        const t = now()
        const complete = p.bytesTotal > 0 && p.bytesDone >= p.bytesTotal
        if (!force && !complete && lastAt !== 0 && t - lastAt < intervalMs) return
        lastAt = t
        emit({ type: MOVE_PROGRESS_TYPE, opId, step: 'Copying', bytesDone: p.bytesDone, bytesTotal: p.bytesTotal })
    }
}


export interface MoveProgressMsg {
    type: typeof MOVE_PROGRESS_TYPE
    opId: string
    step: string
    bytesDone: number
    bytesTotal: number
    /** Ephemeral Checking payload (idea#498 option 3); never stored. */
    checking?: {
        phase: 'starting' | 'stabilising' | 'stable'
        label: string
        stableElapsedMs: number
        stableTargetMs: number
    }
}

/** Wait for Operation.move.verify: Automerge change event first, pollMs (default 250) as fallback (idea#498). */
export const waitForMoveVerify = (
    storeHandle: DocHandle<Store>,
    opId: string,
    opts: { timeoutMs: number, pollMs: number },
): Promise<MoveVerify | null> => new Promise(resolve => {
    let settled = false
    const read = (): MoveVerify | null => (storeHandle.doc().operationDB?.[opId] as any)?.move?.verify ?? null
    const finish = (v: MoveVerify | null) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        try { storeHandle.off('change', onChange) } catch { /* typings */ }
        resolve(v)
    }
    const onChange = () => { const v = read(); if (v) finish(v) }
    const poll = setInterval(() => { const v = read(); if (v) finish(v) }, Math.max(1, opts.pollMs))
    const timer = setTimeout(() => finish(null), opts.timeoutMs)
    storeHandle.on('change', onChange)
    const already = read()
    if (already) finish(already)
})

/** Wait for Operation.move.targetCleanup after a pre-flip cleanup request (engine#388). */
export const waitForTargetCleanup = (
    storeHandle: DocHandle<Store>,
    opId: string,
    opts: { timeoutMs: number, pollMs: number },
): Promise<{ status: 'quarantined' | 'failed', detail: string | null } | null> => new Promise(resolve => {
    let settled = false
    const read = (): { status: 'quarantined' | 'failed', detail: string | null } | null => {
        const move = (storeHandle.doc().operationDB?.[opId] as any)?.move
        const status = move?.targetCleanup
        if (status !== 'quarantined' && status !== 'failed') return null
        return { status, detail: move.targetCleanupDetail ?? null }
    }
    const finish = (v: { status: 'quarantined' | 'failed', detail: string | null } | null) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        try { storeHandle.off('change', onChange) } catch { /* typings */ }
        resolve(v)
    }
    const onChange = () => { const v = read(); if (v) finish(v) }
    const poll = setInterval(() => { const v = read(); if (v) finish(v) }, Math.max(1, opts.pollMs))
    const timer = setTimeout(() => finish(null), opts.timeoutMs)
    storeHandle.on('change', onChange)
    const already = read()
    if (already) finish(already)
})

export const moveAppCrossEngine = async (
    storeHandle: DocHandle<Store>,
    instanceName: InstanceName,
    sourceDiskId: DiskID,
    targetDiskId: DiskID,
    cause: OperationCause = 'console-command',
    deps: Partial<MoveDeps> = {},
): Promise<MoveResult> => {
    const d = { ...defaultDeps, ...deps }
    const refuse = (code: MoveRefusalCode, reason: string): never => {
        const text = moveFailedText(reason)
        throw new MoveError(code, text, { code, text, sourceInstanceId: String(instanceName), targetInstanceId: null, targetEngineId: '', quarantinePath: null })
    }

    // ── Refusals: nothing has happened yet ──────────────────────────────────
    const v = await d.validate(storeHandle.doc(), instanceName, sourceDiskId, targetDiskId)
    if (typeof v === 'string') refuse(refusalCode(v), v)
    const { instance, sourceDisk, targetDisk } = v as Exclude<typeof v, string>
    const targetEngineId = String(targetDisk.dockedTo)
    const engineId = await d.localEngineId()
    const targetEngine = getEngine(storeHandle.doc(), targetEngineId as EngineID)
    const targetName = String((targetEngine as any)?.hostname ?? targetEngineId)
    if (!engineHasCapability(storeHandle.doc(), targetEngineId, MOVE_CROSS_ENGINE_CAPABILITY)) {
        refuse('TARGET_OUTDATED', `Engine ${targetName} cannot receive a move yet; update it first`)
    }
    const helper = await d.helperProblem()
    if (helper) refuse('HELPER_OUTDATED', helper)
    if (resourceLock.isLocked(instanceKey(instance.id)) || resourceLock.isLocked(diskKey(targetDisk.id))) {
        refuse('BUSY', `another operation is running on '${instance.name}' or the target disk; retry when it completes`)
    }
    const alreadyOn = occupyingTarget(storeHandle.doc(), instance.id, targetDisk, targetEngineId)
    if (alreadyOn) refuse('TARGET_EXISTS', `instance ${instance.id} already exists on ${alreadyOn}`)
    if (await d.targetFolderExists(storeHandle.doc(), targetDisk, instance.id)) {
        refuse('TARGET_EXISTS', `instance ${instance.id} already exists on ${targetDisk.name}`)
    }

    const expectRunning = instance.status === 'Running' || instance.status === 'Starting'
    const move: MoveProgress = {
        phase: 'copying', targetEngineId, sourceInstanceId: String(instance.id), targetInstanceId: null,
        expectedBytes: null, expectRunning, verify: null, verified: false, sourceRemoved: false,
        quarantinePath: null, targetCleanup: null, targetCleanupDetail: null, code: null, resultText: null,
    }
    const opId = createOperation(storeHandle, 'moveApp', {
        instanceId: String(instance.id), sourceDiskId: String(sourceDisk.id), targetDiskId: String(targetDisk.id), crossEngine: 'true',
        instanceName: String(instance.name),
    }, cause, { type: 'instance', id: String(instance.id) })
    storeHandle.change(doc => { const op = doc.operationDB?.[opId] as any; if (op) op.move = { ...move } })

    const result = (code: MoveResult['code'], text: string, targetInstanceId: string | null, quarantinePath: string | null = null): MoveResult =>
        ({ code, text, sourceInstanceId: String(instance.id), targetInstanceId, targetEngineId, quarantinePath })
    // On a failed move the source comes back as it was (the copy kept it stopped)
    const restartIfNeeded = async () => {
        if (!expectRunning) return
        const src = getInstance(storeHandle.doc(), instance.id)
        if (!src || src.status === 'Running' || src.status === 'Starting') return
        try { await d.startSource(storeHandle, src, sourceDisk) } catch (e: any) { log(`moveApp: could not restart the source '${instance.name}': ${e?.message ?? e}`) }
    }
    const fail = (code: MoveResult['code'], reason: string, targetInstanceId: string | null): MoveResult => {
        const r = result(code, moveFailedText(reason), targetInstanceId)
        log(`moveApp: ${r.text}`)
        finish(storeHandle, opId, r, true)
        return r
    }
    let targetInstanceId: InstanceID | undefined
    // engine#388: on a pre-flip failure, ask the target to stop any Checking
    // container and quarantine its folder. Never runs after storedOn flips, and
    // never points at a folder whose row already says it is stored on the target.
    const cleanupTargetCopy = async (): Promise<'quarantined' | 'failed'> => {
        const record = (status: 'quarantined' | 'failed', detail: string) => {
            patchMove(storeHandle, opId, { targetCleanup: status, targetCleanupDetail: detail })
            return status
        }
        const row = getInstance(storeHandle.doc(), instance.id)
        if (row && String(row.storedOn) === String(targetDisk.id)) {
            return record('failed', 'the instance is already stored on the target')
        }
        if (!targetInstanceId) {
            return record('failed', 'no target copy to clean up')
        }
        try {
            d.requestCleanup(storeHandle, targetEngineId, `cleanupMoveTarget ${opId} ${targetInstanceId} ${targetDisk.id}`)
        } catch (e: any) {
            return record('failed', e?.message ?? String(e))
        }
        const seen = await waitForTargetCleanup(storeHandle, opId, { timeoutMs: d.cleanupTimeoutMs, pollMs: d.pollMs })
        if (!seen) return record('failed', `timed out waiting for ${targetName} to confirm the target cleanup`)
        return seen.status
    }
    const failAfterCleanup = async (code: MoveResult['code'], reason: string, targetId: string | null): Promise<MoveResult> => {
        const base = moveFailedText(reason)
        // Mark terminal non-success before asking the target to clean up, so a
        // late or duplicate cleanup can tell this op from a newer or successful one.
        finish(storeHandle, opId, result(code, base, targetId), true)
        const cleanup = await cleanupTargetCopy()
        await restartIfNeeded()
        const r = result(code, withTargetCleanupText(base, cleanup, targetName), targetId)
        log(`moveApp: ${r.text}`)
        finish(storeHandle, opId, r, true)
        return r
    }

    // ── 1. Copying ─────────────────────────────────────────────────────────
    setPhase(storeHandle, opId, 'copying')
    // idea#498: ephemeral progress at the start of Copying so the Console is not
    // blank for the 5–8 s before journaled copyApp steps (those are not stored
    // on the moveApp operation; percent-only patches are dropped).
    const emit = d.broadcast ?? ((msg: object) => { try { storeHandle.broadcast(msg as any) } catch { /* no peers */ } })
    emit({ type: MOVE_PROGRESS_TYPE, opId, step: MOVE_STEPS[0], bytesDone: 0, bytesTotal: 0 })
    const emitCopyBytes = throttledCopyProgress(emit, opId)
    copyByteProgressByOp.set(opId, emitCopyBytes)
    // The source must not be started or written to from here until it is removed
    // (idea#79 call 3): the copy stops it and keeps it stopped; the remove step
    // re-checks lastStarted, status and size against this baseline.
    const startedBaseline = Number(getInstance(storeHandle.doc(), instance.id)?.lastStarted ?? 0)
    let baselineBytes: number
    try {
        targetInstanceId = await d.copy(storeHandle, instance.id, sourceDisk.id, targetDisk.id, cause, opId)
    } catch (e: any) {
        await restartIfNeeded()
        return fail('COPY_FAILED', `the copy to ${targetName} failed (${e?.message ?? e})`, null)
    } finally {
        copyByteProgressByOp.delete(opId)
    }
    try {
        patchMove(storeHandle, opId, { targetInstanceId: String(targetInstanceId) })
        // Measured with the source stopped, right after the copy
        baselineBytes = await d.sourceBytes(sourceDisk, instance.id)
        patchMove(storeHandle, opId, { expectedBytes: baselineBytes })
    } catch (e: any) {
        return failAfterCleanup('SOURCE_KEPT', e?.message ?? String(e), String(targetInstanceId))
    }

    // ── 2. Checking (on the target) ───────────────────────────────────────────
    setPhase(storeHandle, opId, 'checking')
    if (expectRunning) {
        d.requestStart(storeHandle, targetEngineId, `startInstance ${targetInstanceId} ${targetDisk.id} --cause cross-engine-cmd`)
    }
    d.requestVerify(storeHandle, targetEngineId, `verifyMoveTarget ${opId} ${targetInstanceId} ${baselineBytes} ${expectRunning}`)
    const verdict = await waitForMoveVerify(storeHandle, opId, { timeoutMs: d.verifyTimeoutMs, pollMs: d.pollMs })
    if (!verdict) return failAfterCleanup('VERIFY_TIMEOUT', `${targetName} did not confirm the copy in time`, String(targetInstanceId))
    if (!verdict.ok) return failAfterCleanup(verdict.code ?? 'VERIFY_FAILED', `the copy on ${targetName} did not check out (${verdict.detail ?? 'no detail'})`, String(targetInstanceId))
    // The one gate for removing the source: recorded before any removal step
    patchMove(storeHandle, opId, { verified: true })

    // ── 3. Removing the old copy (quarantine, never rm) ─────────────────────
    setPhase(storeHandle, opId, 'removing')
    const removeStarted = Date.now()
    const removeTimed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
        const t0 = Date.now()
        try { return await fn() }
        finally { log(`moveApp remove: ${step} ${Date.now() - t0}ms (since step start ${Date.now() - removeStarted}ms)`) }
    }
    try {
        const verifiedNow = (storeHandle.doc().operationDB?.[opId] as any)?.move?.verified === true
        if (!verifiedNow) throw new Error('verify was not recorded')
        const src = getInstance(storeHandle.doc(), instance.id)
        if (!src) throw new MoveError('SOURCE_CHANGED', 'the source instance record is gone')
        if (src.status === 'Running' || src.status === 'Starting' || Number(src.lastStarted ?? 0) !== startedBaseline) {
            throw new MoveError('SOURCE_CHANGED', `the source was started during the move (status ${src.status}); it may hold newer data than the copy`)
        }
        const nowBytes = await removeTimed('sourceBytes', () => d.sourceBytes(sourceDisk, instance.id))
        if (nowBytes !== baselineBytes) {
            throw new MoveError('SOURCE_CHANGED', `the source was written to during the move (${baselineBytes} → ${nowBytes} bytes); it may hold newer data than the copy`)
        }
        // Flip storedOn only after verify and SOURCE_CHANGED checks; then quarantine
        // the source folder (not the store row). The target adopts port/status after.
        const flipAt = Date.now()
        flipStoredOnAfterVerify(storeHandle, String(instance.id), String(targetDisk.id))
        log(`moveApp remove: flipStoredOn ${Date.now() - flipAt}ms (since step start ${Date.now() - removeStarted}ms)`)
        const removed = await removeTimed('removeSource', () => d.removeSource(storeHandle, instance.id, engineId, sourceDisk.id))
        patchMove(storeHandle, opId, { sourceRemoved: true, quarantinePath: removed.quarantinePath })
        if (expectRunning) {
            const startAt = Date.now()
            d.requestStart(storeHandle, targetEngineId, `startInstance ${targetInstanceId} ${targetDisk.id} --cause post-move`)
            log(`moveApp remove: requestStart ${Date.now() - startAt}ms (since step start ${Date.now() - removeStarted}ms)`)
        }
        const r = result('MOVED', movedText(targetName), String(targetInstanceId), removed.quarantinePath)
        log(`moveApp: ${r.text}; the old copy is quarantined at ${removed.quarantinePath}`)
        const finishAt = Date.now()
        finish(storeHandle, opId, r, false)
        log(`moveApp remove: finish ${Date.now() - finishAt}ms (since step start ${Date.now() - removeStarted}ms)`)
        return r
    } catch (e: any) {
        const flipped = String(getInstance(storeHandle.doc(), instance.id)?.storedOn ?? '') === String(targetDisk.id)
        const why = e instanceof RemoveError ? `${e.code}: ${e.message}` : (e?.message ?? String(e))
        // After the flip, only source removal failed: the app is on the target.
        if (flipped) {
            const r = result('SOURCE_NOT_REMOVED', sourceNotRemovedText(why), String(targetInstanceId))
            log(`moveApp: ${r.text}`)
            finish(storeHandle, opId, r, false)
            return r
        }
        // Pre-flip: mark terminal, then stop and quarantine the target copy; keep the source authoritative.
        const changed = e instanceof MoveError && e.code === 'SOURCE_CHANGED'
        const code = changed ? 'SOURCE_CHANGED' : 'SOURCE_KEPT'
        const base = changed ? sourceKeptText(why) : moveFailedText(why)
        finish(storeHandle, opId, result(code, base, String(targetInstanceId)), !changed)
        const cleanup = await cleanupTargetCopy()
        await restartIfNeeded()
        const r = result(code, withTargetCleanupText(base, cleanup, targetName), String(targetInstanceId))
        log(`moveApp: ${r.text}`)
        finish(storeHandle, opId, r, !changed)
        return r
    }
}

/**
 * The moveApp command's trace for a cross-Engine outcome (idea#79): a failure
 * throws, so the trace ends as 'error' with errorCode + errorMessage + result;
 * Done outcomes attach the result (result.code, result.text).
 */
export const moveCommandOutcome = (result: MoveResult): void => {
    if ((MOVE_FAILURE_CODES as readonly string[]).includes(result.code)) throw new MoveError(result.code, result.text, result)
    attachTraceResult(result)
}

// ── verifyMoveTarget (runs on the TARGET Engine) ─────────────────────────────

export interface VerifyDeps {
    localEngineId: () => Promise<string>
    targetBytes: (disk: Disk, id: InstanceID) => Promise<number>
    timeoutMs: number
    pollMs: number
    /** Ephemeral Checking idea/progress (never stored). Default: storeHandle.broadcast. */
    broadcast?: (msg: object) => void
    /** How often to emit Checking progress while waiting. Default 1000; do not use this as the verify poll. */
    progressIntervalMs?: number
}

const defaultVerifyDeps: VerifyDeps = {
    localEngineId: async () => String((await import('./Engine.js')).localEngineId),
    targetBytes: async (disk, id) => instanceDataBytes(await appDataRoot(disk), String(id)),
    timeoutMs: 5 * 60 * 1000,
    pollMs: 2000,
    progressIntervalMs: CHECKING_PROGRESS_INTERVAL_MS,
}

/**
 * verifyMoveTarget <opId> <instanceId> <expectedBytes> <expectRunning>: check the
 * copy on this Engine and write the verdict into the source's moveApp operation.
 */
export const verifyMoveTarget = async (
    storeHandle: DocHandle<Store>, opId: string, instanceId: string, expectedBytes: string, expectRunning: string,
    deps: Partial<VerifyDeps> = {},
): Promise<MoveVerify> => {
    const d = { ...defaultVerifyDeps, ...deps }
    const me = await d.localEngineId()
    const emit = d.broadcast ?? ((msg: object) => { try { storeHandle.broadcast(msg as any) } catch { /* no peers */ } })
    const intervalMs = d.progressIntervalMs ?? CHECKING_PROGRESS_INTERVAL_MS
    let stopped = false
    let sentStable = false
    let timer: ReturnType<typeof setInterval> | undefined
    const stopTicks = () => {
        stopped = true
        if (timer !== undefined) clearInterval(timer)
    }
    const tick = () => {
        // After 'stable' is sent once, nothing more goes out for this op (Pixel / idea#498).
        if (stopped || sentStable) return
        const msg = checkingProgressMessage(opId, getPortReadyProgress(instanceId))
        if (msg.checking.phase === 'stable') sentStable = true
        emit(msg)
        if (sentStable) stopTicks()
    }
    tick()
    timer = setInterval(tick, Math.max(1, intervalMs))
    if (sentStable) stopTicks()
    const stopProgress = (flushStable = false) => {
        if (flushStable && !sentStable) {
            const msg = checkingProgressMessage(opId, getPortReadyProgress(instanceId))
            if (msg.checking.phase === 'stable') {
                sentStable = true
                if (!stopped) emit(msg)
            }
        }
        stopTicks()
    }
    const write = (v: MoveVerify) => {
        stopProgress(v.ok === true)
        storeHandle.change(doc => { const op = doc.operationDB?.[opId] as any; if (op?.move) op.move.verify = { ...v } })
        return v
    }
    try {
        const bad = (code: VerifyCode, detail: string) => write({ ok: false, code, bytes: null, detail, at: Date.now() })
        const deadline = Date.now() + d.timeoutMs
        let inst = getInstance(storeHandle.doc(), instanceId as InstanceID)
        const wantRunning = expectRunning === 'true'
        // Judge the folder on the operation's target disk, not storedOn (engine#381:
        // the source stays authoritative until after this verdict is recorded).
        const targetDiskId = (storeHandle.doc().operationDB?.[opId] as any)?.args?.targetDiskId
        const disk = getDisk(storeHandle.doc(), targetDiskId as DiskID)
        if (!disk || String(disk.dockedTo) !== me) return bad('VERIFY_NOT_FOUND', 'the copy is not on a disk docked to this Engine')
        // Wait: when the source ran, for a stable port-ready on the target (not
        // inst.status — a deferred start must not write Running onto the shared row).
        while (Date.now() < deadline) {
            inst = getInstance(storeHandle.doc(), instanceId as InstanceID)
            if (wantRunning) {
                if (getPortReadyProgress(instanceId)?.stableReached) break
                if (inst?.status === 'Error') break
            } else {
                break
            }
            await new Promise(r => setTimeout(r, d.pollMs))
        }
        if (!inst) return bad('VERIFY_NOT_FOUND', 'the copy is not registered')
        if (wantRunning && !getPortReadyProgress(instanceId)?.stableReached) {
            if (inst.status === 'Error') return bad('VERIFY_NOT_RUNNING', 'the copy failed to start')
            return bad('VERIFY_NOT_RUNNING', `the copy did not start (status ${inst.status})`)
        }
        let bytes: number
        try { bytes = await d.targetBytes(disk, instanceId as InstanceID) } catch (e: any) { return bad('VERIFY_FAILED', `cannot size the copy (${e?.message ?? e})`) }
        const expected = Number(expectedBytes)
        if (!Number.isFinite(expected) || !sizesMatch(expected, bytes)) {
            const v = write({ ok: false, code: 'VERIFY_SIZE', bytes, detail: `size ${bytes} bytes, expected ${expectedBytes}`, at: Date.now() })
            return v
        }
        log(`verifyMoveTarget: copy ${instanceId} checks out (${bytes} bytes)`)
        return write({ ok: true, code: null, bytes, detail: null, at: Date.now() })
    } finally {
        stopProgress(false)
        clearPortReadyProgress(instanceId)
    }
}

// ── cleanupMoveTarget (runs on the TARGET Engine, engine#388) ────────────────

export interface CleanupMoveTargetDeps {
    localEngineId: () => Promise<string>
    /** Compose-down and quarantine the folder on this disk; must not touch instanceDB. */
    stopAndQuarantine: (disk: Disk, id: InstanceID) => Promise<{ quarantinePath: string }>
}

const defaultCleanupDeps: CleanupMoveTargetDeps = {
    localEngineId: async () => String((await import('./Engine.js')).localEngineId),
    stopAndQuarantine: (disk, id) => quarantineInstanceOnDisk(disk, id),
}

const MOVE_SUCCESS_CODES: ReadonlySet<string> = new Set(['MOVED', 'SOURCE_NOT_REMOVED'])

/** True when this operation is a moveApp of `instanceId` (source or target id). */
export const isMoveAppForInstance = (op: any, instanceId: string): boolean => {
    if (!op || op.kind !== 'moveApp') return false
    const src = String(op.move?.sourceInstanceId ?? op.args?.instanceId ?? '')
    const tgt = String(op.move?.targetInstanceId ?? '')
    return src === String(instanceId) || (tgt !== '' && tgt === String(instanceId))
}

/** Failed, or Done with a non-success code (SOURCE_CHANGED). Not MOVED / SOURCE_NOT_REMOVED. */
export const isTerminalNonSuccessMove = (op: any): boolean => {
    if (op?.status !== 'Done' && op?.status !== 'Failed') return false
    return !MOVE_SUCCESS_CODES.has(String(op.move?.code ?? ''))
}

/** Latest moveApp for this instance, by startedAt, then operation id. */
export const latestMoveAppOpId = (store: Store, instanceId: string): string | null => {
    let best: { id: string, at: number } | null = null
    for (const [key, op] of Object.entries(store.operationDB ?? {})) {
        if (!isMoveAppForInstance(op, instanceId)) continue
        const id = String((op as any)?.id ?? key)
        const at = Number((op as any)?.startedAt ?? 0)
        if (!best || at > best.at || (at === best.at && id > best.id)) best = { id, at }
    }
    return best?.id ?? null
}

/**
 * cleanupMoveTarget <opId> <instanceId> <targetDiskId>: stop the Checking
 * container and quarantine the target instance folder. Writes the result into
 * Operation.move.targetCleanup. Does not change the instance row (storedOn,
 * lastBackup, status stay as they are). Refuses if the row already says this
 * id is stored on the target disk, so a flipped move cannot quarantine the
 * live copy. Only operates on a disk docked to this Engine.
 * Late-safe (engine#388 follow-up): unless `opId` is the latest moveApp for
 * this instance and is already in a terminal non-success state, the target
 * logs the refusal and records nothing destructive, so a late or duplicate
 * cleanup cannot quarantine a folder a newer move created or a successful
 * move owns. The source marks the op terminal before sending this command.
 */
export const cleanupMoveTarget = async (
    storeHandle: DocHandle<Store>, opId: string, instanceId: string, targetDiskId: string,
    deps: Partial<CleanupMoveTargetDeps> = {},
): Promise<{ status: 'quarantined' | 'failed', detail: string }> => {
    const d = { ...defaultCleanupDeps, ...deps }
    const write = (status: 'quarantined' | 'failed', detail: string) => {
        storeHandle.change(doc => {
            const op = doc.operationDB?.[opId] as any
            if (!op?.move) return
            op.move.targetCleanup = status
            op.move.targetCleanupDetail = detail
        })
        return { status, detail }
    }
    const refuseQuietly = (detail: string) => {
        log(`cleanupMoveTarget: refused ${instanceId} on ${targetDiskId} for ${opId}: ${detail}`)
        return { status: 'failed' as const, detail }
    }
    const me = await d.localEngineId()
    const disk = getDisk(storeHandle.doc(), targetDiskId as DiskID)
    if (!disk || String(disk.dockedTo) !== me) {
        return write('failed', 'the target disk is not docked to this Engine')
    }
    const row = getInstance(storeHandle.doc(), instanceId as InstanceID)
    if (row && String(row.storedOn) === String(targetDiskId)) {
        return write('failed', 'the instance is stored on the target; the copy was left in place')
    }
    const store = storeHandle.doc()
    const op = (store.operationDB as any)?.[opId]
    if (!op || op.kind !== 'moveApp') {
        return refuseQuietly('no such moveApp operation')
    }
    const latest = latestMoveAppOpId(store, instanceId)
    const thisId = String(op.id ?? opId)
    if (latest !== String(opId) && latest !== thisId) {
        return refuseQuietly('a newer moveApp exists for this instance')
    }
    if (!isTerminalNonSuccessMove(op)) {
        if (MOVE_SUCCESS_CODES.has(String(op.move?.code ?? ''))) {
            return refuseQuietly('the move already succeeded; the copy was left in place')
        }
        return refuseQuietly('the moveApp operation is not in a terminal non-success state')
    }
    try {
        const { quarantinePath } = await d.stopAndQuarantine(disk, instanceId as InstanceID)
        log(`cleanupMoveTarget: quarantined ${instanceId} on ${targetDiskId} at ${quarantinePath}`)
        return write('quarantined', quarantinePath)
    } catch (e: any) {
        const detail = e?.message ?? String(e)
        log(`cleanupMoveTarget: could not quarantine ${instanceId} on ${targetDiskId}: ${detail}`)
        return write('failed', detail)
    }
}
