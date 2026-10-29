/**
 * MoveAppShapes.ts — the cross-Engine moveApp contract (idea#79). See SHAPES.md
 * at the repo root of PR "moveApp across Engines" for the Console-facing summary.
 *
 * A cross-Engine move is a copy followed by a delete:
 *   1. copying  — the existing cross-Engine copyApp path (ensure-dirs, receive-app,
 *                 send/receive, receive-files, receive-service on the peer helper)
 *   2. checking — the target Engine verifies the copy (registered on its disk,
 *                 instance data size matches, healthy when the source was running)
 *                 and records the verdict in this operation
 *   3. removing — only after a recorded, complete verify: the source is removed with
 *                 the safe removeInstance (helper v4 quarantine, never rm)
 */

/** Engine capability: this Engine can move an App to a disk on another Engine. */
export const MOVE_CROSS_ENGINE_CAPABILITY = 'moveAppCrossEngine'

export type MovePhase = 'copying' | 'checking' | 'removing' | 'done' | 'failed'

/** Step labels written to Operation.stepLabel (currentStep 0..2, totalSteps 3). */
export const MOVE_STEPS = ['Copying', 'Checking', 'Removing the old copy'] as const
export const MOVE_STEP_INDEX: Record<'copying' | 'checking' | 'removing', number> = { copying: 0, checking: 1, removing: 2 }

/**
 * Every moveApp code (idea#79), one list. Where they live:
 *   - Operation.move.code       — every Done and Failed outcome
 *   - CommandTrace.errorCode    — refusals and failed outcomes (trace status 'error')
 *   - CommandTrace.result.code  — every outcome and refusal (MoveResult JSON)
 * Refusals happen before any operation exists; outcomes after it started.
 */
export const MOVE_REFUSAL_CODES = [
    'NOT_FOUND',          // instance or disk not found / not docked
    'AMBIGUOUS',          // instance name matches several instances
    'SOURCE_REMOTE',      // the source disk is not docked to this Engine
    'TARGET_UNREACHABLE', // the target Engine is not connected
    'PEER_ACCESS',        // the two Engines have not accepted each other's key
    'TARGET_OUTDATED',    // the target Engine does not advertise moveAppCrossEngine
    'HELPER_OUTDATED',    // this Engine's idea-app-data helper is older than v4
    'BUSY',               // the instance or target disk is locked by another operation
    'INVALID',            // other validation refusal (same disk, external links, ...)
] as const
export const MOVE_FAILURE_CODES = [
    'COPY_FAILED',        // the copy failed
    'VERIFY_NOT_FOUND',   // the copy is not registered, or not on a disk docked to the target
    'VERIFY_NOT_RUNNING', // the source was running but the copy did not reach Running
    'VERIFY_SIZE',        // the copy's instance data size does not match
    'VERIFY_TIMEOUT',     // the target did not report a verdict in time
    'VERIFY_FAILED',      // fallback only: the target could not check (e.g. sizing error) or sent no code
    'INTERRUPTED',        // the Engine restarted before verify was recorded
] as const
export const MOVE_DONE_CODES = [
    'MOVED',              // copied, verified, source quarantined
    'SOURCE_NOT_REMOVED', // copied and verified, but removing the source failed (or restart after verify)
    'SOURCE_CHANGED',     // copied and verified, but the source was started or written to during the move: kept
] as const
export const MOVE_CODES = [...MOVE_REFUSAL_CODES, ...MOVE_FAILURE_CODES, ...MOVE_DONE_CODES] as const

export type MoveRefusalCode = typeof MOVE_REFUSAL_CODES[number]
export type MoveFailureCode = typeof MOVE_FAILURE_CODES[number]
export type MoveDoneCode = typeof MOVE_DONE_CODES[number]
export type MoveOutcomeCode = MoveFailureCode | MoveDoneCode
export type VerifyCode = 'VERIFY_NOT_FOUND' | 'VERIFY_NOT_RUNNING' | 'VERIFY_SIZE' | 'VERIFY_FAILED'

export type MoveCode = MoveRefusalCode | MoveOutcomeCode

/** The target Engine's verdict, written into Operation.move.verify by verifyMoveTarget. */
export interface MoveVerify {
    ok: boolean
    /** null when ok */
    code: VerifyCode | null
    /** instance data bytes measured on the target (helper size) */
    bytes: number | null
    /** why it failed, in plain words; null when ok */
    detail: string | null
    at: number
}

/** Operation.move — present on cross-Engine moveApp operations only. */
export interface MoveProgress {
    phase: MovePhase
    targetEngineId: string
    sourceInstanceId: string
    /** the instance id on the target (a fresh id, set once copying registered it) */
    targetInstanceId: string | null
    /** source instance data bytes measured before the copy */
    expectedBytes: number | null
    /** true when the source was Running/Starting: the target must start healthy */
    expectRunning: boolean
    verify: MoveVerify | null
    /** true only after verify.ok was recorded — the one gate for removing the source */
    verified: boolean
    sourceRemoved: boolean
    /** where removeInstance quarantined the source folder */
    quarantinePath: string | null
    code: MoveCode | null
    /** final text: MOVED to …, MOVE FAILED: … source kept, MOVED, source not removed: … */
    resultText: string | null
}

/** Result attached to the moveApp command trace (CommandTrace.result). */
export interface MoveResult {
    code: MoveCode
    text: string
    sourceInstanceId: string
    targetInstanceId: string | null
    targetEngineId: string
    quarantinePath: string | null
}

// ── Failure texts (idea#79 approach comment) ───────────────────────────────────
export const movedText = (engineName: string): string => `MOVED to ${engineName}`
export const moveFailedText = (reason: string): string => `MOVE FAILED: ${reason.replace(/[.;\s]+$/, '')}; source kept`
export const sourceNotRemovedText = (reason: string): string => `MOVED, source not removed: ${reason.replace(/[.;\s]+$/, '')}`

export class MoveError extends Error {
    /** published as CommandTrace.result when the command fails (commandUtils.handleCommand) */
    traceResult?: MoveResult
    constructor(public code: MoveCode, message: string, traceResult?: MoveResult) { super(message); this.name = 'MoveError'; this.traceResult = traceResult }
}

/** Instance data may change a little after the target starts (logs, sessions). */
export const VERIFY_TOLERANCE_BYTES = 1024 * 1024
export const VERIFY_TOLERANCE_RATIO = 0.01
export const sizesMatch = (expected: number, actual: number): boolean =>
    Math.abs(actual - expected) <= Math.max(VERIFY_TOLERANCE_BYTES, expected * VERIFY_TOLERANCE_RATIO)
