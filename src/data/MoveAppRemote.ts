/**
 * MoveAppRemote.ts — moveApp to a disk on another Engine (idea#79).
 *
 * A move is a copy followed by a delete, in one moveApp operation:
 *   1. Copying  — the existing cross-Engine copyApp path, journaled into this op.
 *   2. Checking — the target Engine runs verifyMoveTarget: the copy is registered
 *                 on a disk docked to it, its instance data size matches, and it
 *                 starts healthy when the source was running. The verdict is
 *                 written into Operation.move.verify.
 *   3. Removing — only when move.verified was recorded: removeInstance (helper v4
 *                 quarantine; never rm) on the source.
 * Copy or verify failure deletes nothing (MOVE FAILED: … source kept). A failed
 * removal after a good copy is MOVED, source not removed: … Restart recovery
 * never removes the source (Operations.recoverInterruptedOperations).
 */

import { DocHandle } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { Store, getDisk, getInstance, getEngine } from './Store.js'
import { Disk, appDataRoot } from './Disk.js'
import { Instance, startInstance } from './Instance.js'
import { InstanceID, InstanceName, DiskID, EngineID, OperationCause, Timestamp, Command } from './CommonTypes.js'
import { createOperation, updateOperation } from './Operations.js'
import { attachTraceResult } from './SummariseDisk.js'
import { sendCommand } from '../utils/commandUtils.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { instanceDataBytes, helperAtLeast } from '../utils/appDataHelper.js'
import { REMOVE_HELPER_MIN, RemoveError, removeInstance } from './RemoveInstance.js'
import {
    MOVE_CROSS_ENGINE_CAPABILITY, MOVE_STEPS, MOVE_STEP_INDEX, MoveError, MoveProgress, MoveResult,
    MOVE_FAILURE_CODES, MoveRefusalCode, MoveVerify, VerifyCode, MoveFailureCode, moveFailedText, movedText, sourceNotRemovedText, sizesMatch,
} from './MoveAppShapes.js'

export interface MoveDeps {
    localEngineId: () => Promise<string>
    validate: (store: Store, name: InstanceName, src: DiskID, tgt: DiskID) => Promise<{ instance: Instance, sourceDisk: Disk, targetDisk: Disk } | string>
    helperProblem: () => Promise<string | null>
    sourceBytes: (disk: Disk, id: InstanceID) => Promise<number>
    copy: (storeHandle: DocHandle<Store>, instanceId: InstanceID, src: DiskID, tgt: DiskID, cause: OperationCause, opId: string) => Promise<InstanceID>
    requestVerify: (storeHandle: DocHandle<Store>, targetEngineId: string, command: string) => void
    startSource: (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk) => Promise<void>
    removeSource: (storeHandle: DocHandle<Store>, instanceId: InstanceID, engineId: string) => Promise<{ quarantinePath: string }>
    verifyTimeoutMs: number
    pollMs: number
}

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
        const id = await copyApp(storeHandle, instanceId as unknown as InstanceName, src, tgt, cause, { journalOpId: opId, keepName: true, rethrow: true, keepSourceStopped: true })
        if (!id) throw new Error('the copy did not finish')
        return id
    },
    requestVerify: (storeHandle, engineId, command) => sendCommand(storeHandle, engineId as EngineID, command as Command),
    startSource: (storeHandle, instance, disk) => startInstance(storeHandle, instance, disk, 'post-move'),
    removeSource: (storeHandle, instanceId, engineId) => removeInstance(storeHandle, String(instanceId), engineId),
    verifyTimeoutMs: 6 * 60 * 1000,
    pollMs: 2000,
}

/** Map a copyApp validate() refusal text to a refusal code. */
export const refusalCode = (text: string): MoveRefusalCode => {
    if (/ambiguous/i.test(text)) return 'AMBIGUOUS'
    if (/not found|not docked/i.test(text)) return 'NOT_FOUND'
    if (/docked to a remote engine/i.test(text)) return 'SOURCE_REMOTE'
    if (/not currently reachable/i.test(text)) return 'TARGET_UNREACHABLE'
    if (/key|peer access|accepted/i.test(text)) return 'PEER_ACCESS'
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

    const expectRunning = instance.status === 'Running' || instance.status === 'Starting'
    const move: MoveProgress = {
        phase: 'copying', targetEngineId, sourceInstanceId: String(instance.id), targetInstanceId: null,
        expectedBytes: null, expectRunning, verify: null, verified: false, sourceRemoved: false,
        quarantinePath: null, code: null, resultText: null,
    }
    const opId = createOperation(storeHandle, 'moveApp', {
        instanceId: String(instance.id), sourceDiskId: String(sourceDisk.id), targetDiskId: String(targetDisk.id), crossEngine: 'true',
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

    // ── 1. Copying ─────────────────────────────────────────────────────────
    setPhase(storeHandle, opId, 'copying')
    // The source must not be started or written to from here until it is removed
    // (idea#79 call 3): the copy stops it and keeps it stopped; the remove step
    // re-checks lastStarted, status and size against this baseline.
    const startedBaseline = Number(getInstance(storeHandle.doc(), instance.id)?.lastStarted ?? 0)
    let targetInstanceId: InstanceID
    let baselineBytes: number
    try {
        targetInstanceId = await d.copy(storeHandle, instance.id, sourceDisk.id, targetDisk.id, cause, opId)
        patchMove(storeHandle, opId, { targetInstanceId: String(targetInstanceId) })
        // Measured with the source stopped, right after the copy
        baselineBytes = await d.sourceBytes(sourceDisk, instance.id)
        patchMove(storeHandle, opId, { expectedBytes: baselineBytes })
    } catch (e: any) {
        await restartIfNeeded()
        return fail('COPY_FAILED', `the copy to ${targetName} failed (${e?.message ?? e})`, null)
    }

    // ── 2. Checking (on the target) ───────────────────────────────────────────
    setPhase(storeHandle, opId, 'checking')
    d.requestVerify(storeHandle, targetEngineId, `verifyMoveTarget ${opId} ${targetInstanceId} ${baselineBytes} ${expectRunning}`)
    const deadline = Date.now() + d.verifyTimeoutMs
    let verdict: MoveVerify | null = null
    while (Date.now() < deadline) {
        verdict = (storeHandle.doc().operationDB?.[opId] as any)?.move?.verify ?? null
        if (verdict) break
        await sleep(d.pollMs)
    }
    if (!verdict) { await restartIfNeeded(); return fail('VERIFY_TIMEOUT', `${targetName} did not confirm the copy in time`, String(targetInstanceId)) }
    if (!verdict.ok) { await restartIfNeeded(); return fail(verdict.code ?? 'VERIFY_FAILED', `the copy on ${targetName} did not check out (${verdict.detail ?? 'no detail'})`, String(targetInstanceId)) }
    // The one gate for removing the source: recorded before any removal step
    patchMove(storeHandle, opId, { verified: true })

    // ── 3. Removing the old copy (quarantine, never rm) ─────────────────────
    setPhase(storeHandle, opId, 'removing')
    try {
        const verifiedNow = (storeHandle.doc().operationDB?.[opId] as any)?.move?.verified === true
        if (!verifiedNow) throw new Error('verify was not recorded')
        const src = getInstance(storeHandle.doc(), instance.id)
        if (!src) throw new MoveError('SOURCE_CHANGED', 'the source instance record is gone')
        if (src.status === 'Running' || src.status === 'Starting' || Number(src.lastStarted ?? 0) !== startedBaseline) {
            throw new MoveError('SOURCE_CHANGED', `the source was started during the move (status ${src.status}); it may hold newer data than the copy`)
        }
        const nowBytes = await d.sourceBytes(sourceDisk, instance.id)
        if (nowBytes !== baselineBytes) {
            throw new MoveError('SOURCE_CHANGED', `the source was written to during the move (${baselineBytes} → ${nowBytes} bytes); it may hold newer data than the copy`)
        }
        const removed = await d.removeSource(storeHandle, instance.id, engineId)
        patchMove(storeHandle, opId, { sourceRemoved: true, quarantinePath: removed.quarantinePath })
        const r = result('MOVED', movedText(targetName), String(targetInstanceId), removed.quarantinePath)
        log(`moveApp: ${r.text}; the old copy is quarantined at ${removed.quarantinePath}`)
        finish(storeHandle, opId, r, false)
        return r
    } catch (e: any) {
        const changed = e instanceof MoveError && e.code === 'SOURCE_CHANGED'
        const why = e instanceof RemoveError ? `${e.code}: ${e.message}` : (e?.message ?? String(e))
        const r = result(changed ? 'SOURCE_CHANGED' : 'SOURCE_NOT_REMOVED', sourceNotRemovedText(why), String(targetInstanceId))
        log(`moveApp: ${r.text}`)
        finish(storeHandle, opId, r, false)
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
}

const defaultVerifyDeps: VerifyDeps = {
    localEngineId: async () => String((await import('./Engine.js')).localEngineId),
    targetBytes: async (disk, id) => instanceDataBytes(await appDataRoot(disk), String(id)),
    timeoutMs: 5 * 60 * 1000,
    pollMs: 2000,
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
    const write = (v: MoveVerify) => {
        storeHandle.change(doc => { const op = doc.operationDB?.[opId] as any; if (op?.move) op.move.verify = { ...v } })
        return v
    }
    const bad = (code: VerifyCode, detail: string) => write({ ok: false, code, bytes: null, detail, at: Date.now() })
    const deadline = Date.now() + d.timeoutMs
    let inst = getInstance(storeHandle.doc(), instanceId as InstanceID)
    const wantRunning = expectRunning === 'true'
    // Wait for the record (and, when the source ran, a healthy start)
    while (Date.now() < deadline) {
        inst = getInstance(storeHandle.doc(), instanceId as InstanceID)
        if (inst && inst.status === 'Error') break
        if (inst && (!wantRunning || inst.status === 'Running')) break
        await new Promise(r => setTimeout(r, d.pollMs))
    }
    if (!inst) return bad('VERIFY_NOT_FOUND', 'the copy is not registered')
    const disk = getDisk(storeHandle.doc(), inst.storedOn as DiskID)
    if (!disk || String(disk.dockedTo) !== me) return bad('VERIFY_NOT_FOUND', 'the copy is not on a disk docked to this Engine')
    if (inst.status === 'Error') return bad('VERIFY_NOT_RUNNING', 'the copy failed to start')
    if (wantRunning && inst.status !== 'Running') return bad('VERIFY_NOT_RUNNING', `the copy did not start (status ${inst.status})`)
    let bytes: number
    try { bytes = await d.targetBytes(disk, inst.id) } catch (e: any) { return bad('VERIFY_FAILED', `cannot size the copy (${e?.message ?? e})`) }
    const expected = Number(expectedBytes)
    if (!Number.isFinite(expected) || !sizesMatch(expected, bytes)) {
        const v = write({ ok: false, code: 'VERIFY_SIZE', bytes, detail: `size ${bytes} bytes, expected ${expectedBytes}`, at: Date.now() })
        return v
    }
    log(`verifyMoveTarget: copy ${instanceId} checks out (${bytes} bytes)`)
    return write({ ok: true, code: null, bytes, detail: null, at: Date.now() })
}
