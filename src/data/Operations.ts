/**
 * Operations.ts — shared helpers for operationDB lifecycle management
 *
 * All long-running operations (copyApp, moveApp, backupApp, restoreApp,
 * startApp, stopApp, upgradeApp, upgradeEngine) create and update Operation
 * records here.  recoverInterruptedOperations() is called at startup to handle
 * any ops left Running/Pending by a crash.
 */

import { chalk } from 'zx'
import { ChildProcess } from 'child_process'
import { log, print } from '../utils/utils.js'
import {
    EngineID, Timestamp,
    Operation, OperationKind, OperationStatus, OperationCause, OperationSubject
} from './CommonTypes.js'
import { Store } from './Store.js'
import { localEngineId } from './Engine.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'
import { getCommandLogHandle, addTrace, closeTrace } from './CommandLogStore.js'
import { runWithTrace, flushTrace } from '../utils/CommandLogger.js'
import { engineCanResume, isPeerLinkFailure } from './InFlight.js'
import { config } from './Config.js'
import { entryLogText } from './CommandKey.js'

// ── Recovery strategy per operation kind ─────────────────────────────────────

/**
 * What to do when an interrupted operation is found at startup.
 *
 * - 'retry': re-run the operation (safe only for idempotent ops like rsync-based ones)
 * - 'fail':  mark as Failed and let the operator re-issue manually
 */
export type RecoveryStrategy = 'retry' | 'fail'

export const RECOVERY_STRATEGY: Record<OperationKind, RecoveryStrategy> = {
    copyApp:       'retry',   // rsync-based — idempotent
    moveApp:       'retry',   // rsync-based — idempotent
    backupApp:     'retry',   // BorgBackup — idempotent; lock file already guards double-run
    restoreApp:    'fail',    // restore may have partially written target — safer to fail
    upgradeApp:    'fail',    // legacy kind, never issued: superseded by updateApp (#230); kept so old store Operations still parse (idea#76)
    updateApp:     'fail',    // #230: recoverInterruptedUpdates rolls back from the .pre-update snapshot first
    upgradeEngine: 'fail',    // not yet implemented
    startApp:      'fail',    // partial start state unknown — operator must re-issue
    stopApp:       'fail',    // partial stop state unknown — operator must re-issue
    flashCard:     'fail',    // idea#201: never retried; Failed 'INTERRUPTED: ...'
    initialiseDisk:'fail',    // idea#201: operator re-issues
    makeBackupDisk:'fail',    // idea#404: no resume; operator re-issues after an unplug
    setupDemo:     'fail',    // engine#369: INTERRUPTED; press again to resume
    removeDemo:    'fail',
}

// ── Operation CRUD ────────────────────────────────────────────────────────────

export const createOperation = (
    storeHandle: DocHandle<Store>,
    kind: OperationKind,
    args: Record<string, string>,
    cause: OperationCause,
    subject?: OperationSubject | null,
): string => {
    const id = uuid()
    const op: Operation = {
        id,
        kind,
        args,
        cause,
        subject: subject ?? null,
        engineId: localEngineId,
        status: 'Pending',
        progressPercent: null,
        currentStep: null,
        totalSteps: null,
        stepLabel: null,
        startedAt: Date.now() as Timestamp,
        completedAt: null,
        error: null,
    }
    storeHandle.change(doc => {
        if (!doc.operationDB) (doc as any).operationDB = {}
        doc.operationDB[id] = op
    })
    return id
}

export const updateOperation = (
    storeHandle: DocHandle<Store>,
    id: string,
    patch: Partial<Pick<Operation, 'status' | 'progressPercent' | 'currentStep' | 'totalSteps' | 'stepLabel' | 'completedAt' | 'error' | 'safeToRemove' | 'restartFailed'>>
): void => {
    // Log a step-advance marker before mutating the store.
    // Uses console.log directly (not log()) so it always lands in the CommandLog trace
    // regardless of verbosity level, and is visible in the Console log panel.
    if (patch.currentStep != null) {
        const op = storeHandle.doc()?.operationDB?.[id]
        if (op && patch.currentStep !== op.currentStep) {
            const total = patch.totalSteps ?? op.totalSteps ?? '?'
            const step  = patch.currentStep + 1
            const label = patch.stepLabel ?? op.stepLabel ?? ''
            const line  = label ? `  Step ${step}/${total}  │  ${label}  ` : `  Step ${step}/${total}  `
            const bar   = '─'.repeat(line.length)
            print(`┌${bar}┐`)
            print(`│${line}│`)
            print(`└${bar}┘`)
        }
    }
    // Store design 2026-10-13: progress is written only when the step (or status,
    // or anything else) changes. A patch that only moves progressPercent inside the
    // same step (rsync percentages, 1-2k changes/day kept forever) is not stored.
    if (isProgressOnly(patch)) return
    storeHandle.change(doc => {
        const op = doc.operationDB?.[id]
        if (!op) return
        if (patch.status !== undefined) op.status = patch.status
        if (patch.progressPercent !== undefined) op.progressPercent = patch.progressPercent
        if (patch.currentStep !== undefined) op.currentStep = patch.currentStep
        if (patch.totalSteps !== undefined) op.totalSteps = patch.totalSteps
        if (patch.stepLabel !== undefined) op.stepLabel = patch.stepLabel
        if (patch.completedAt !== undefined) op.completedAt = patch.completedAt
        if (patch.error !== undefined) op.error = patch.error
        if (patch.safeToRemove !== undefined) op.safeToRemove = patch.safeToRemove
        if (patch.restartFailed !== undefined) op.restartFailed = patch.restartFailed
        // Clear step progress when operation reaches a terminal state
        if (patch.status === 'Done' || patch.status === 'Failed' || patch.status === 'Cancelled') {
            op.currentStep = null
            op.totalSteps = null
            op.stepLabel = null
        }
    })
}

/** True when `patch` only carries progressPercent (no step, status or other field). */
export const isProgressOnly = (patch: Record<string, unknown>): boolean => {
    const keys = Object.keys(patch).filter(k => patch[k] !== undefined)
    return keys.length > 0 && keys.every(k => k === 'progressPercent')
}

// ── Archiving finished operations (store design 2026-10-13) ──────────────────

/** Finished operations older than this move out of the store into the CommandLog. */
export const OPERATION_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Operations per archive trace (one CommandLog trace each). */
export const OPERATION_ARCHIVE_BATCH = 100
const FINISHED: ReadonlySet<string> = new Set(['Done', 'Failed', 'Cancelled'])

/**
 * This Engine's finished operations (Done/Failed/Cancelled) whose completedAt
 * (or startedAt when missing) is older than `ageMs` on this Engine's clock.
 * Only our own: each Engine archives the ops it ran, so no two Engines archive
 * the same record.
 */
export const operationsToArchive = (store: Store | undefined, engineId: string, now: number, ageMs = OPERATION_ARCHIVE_AGE_MS): Operation[] => {
    const out: Operation[] = []
    for (const op of Object.values(store?.operationDB ?? {}) as Operation[]) {
        if (!op || String(op.engineId) !== engineId || !FINISHED.has(String(op.status))) continue
        const at = Number(op.completedAt ?? op.startedAt)
        if (Number.isFinite(at) && at > 0 && now - at > ageMs) out.push(op)
    }
    return out.sort((a, b) => Number(a.completedAt ?? a.startedAt) - Number(b.completedAt ?? b.startedAt))
}

/**
 * Move old finished operations into the CommandLog (a closed 'archiveOperations'
 * trace per batch; result = JSON array of the records), then delete them from
 * operationDB. Nothing is deleted when there is no CommandLog. Returns how many
 * were archived.
 */
export const archiveOldOperations = async (
    storeHandle: DocHandle<Store>,
    opts: { engineId?: string, now?: number, ageMs?: number, commandLog?: DocHandle<any> | null } = {},
): Promise<number> => {
    const cl = opts.commandLog === undefined ? getCommandLogHandle() : opts.commandLog
    if (!cl) return 0
    const engineId = opts.engineId ?? String(localEngineId)
    const now = opts.now ?? Date.now()
    const ops = operationsToArchive(storeHandle.doc(), engineId, now, opts.ageMs)
    let archived = 0
    for (let i = 0; i < ops.length; i += OPERATION_ARCHIVE_BATCH) {
        const batch = ops.slice(i, i + OPERATION_ARCHIVE_BATCH)
        const traceId = `archive-ops-${now}-${i / OPERATION_ARCHIVE_BATCH}`
        addTrace(cl, {
            traceId, command: 'archiveOperations', args: JSON.stringify([engineId, batch.length]),
            startedAt: now, completedAt: now, status: 'ok', errorMessage: null,
            result: JSON.stringify(batch.map(op => JSON.parse(JSON.stringify(op)))),
        })
        storeHandle.change(doc => { for (const op of batch) delete (doc.operationDB as any)[op.id] })
        archived += batch.length
    }
    if (archived) print(`archived ${archived} finished operation(s) older than ${Math.round((opts.ageMs ?? OPERATION_ARCHIVE_AGE_MS) / 86_400_000)} days into the CommandLog`)
    return archived
}

// ── Active process registry ──────────────────────────────────────────────

/**
 * Maps operationId → the rsync ChildProcess currently running for it.
 * Populated by rsyncDirectory when an opId is provided; cleared on close/error.
 * Used by cancelOperation to SIGTERM in-flight rsyncs (Phase 2).
 */
const _activeProcesses = new Map<string, ChildProcess>()

export const registerProcess = (opId: string, proc: ChildProcess): void => {
    _activeProcesses.set(opId, proc)
    log(`registerProcess: registered process for op ${opId} (pid ${proc.pid})`)
}

/** SIGTERM the process registered for `opId` (e.g. a thermal pause of a Fetch); false when none. */
export const killRegisteredProcess = (opId: string): boolean => {
    const proc = _activeProcesses.get(opId)
    if (!proc) return false
    proc.kill('SIGTERM')
    return true
}

export const deregisterProcess = (opId: string): void => {
    _activeProcesses.delete(opId)
    log(`deregisterProcess: cleared process for op ${opId}`)
}

// ── Cancel operation ────────────────────────────────────────────────────────

/**
 * Cancel an operation by ID.
 *
 * Behaviour:
 *  - Pending:   splice the matching command from engine.commands[], mark Cancelled
 *  - Running:   SIGTERM the registered rsync process, mark Cancelled (process close handler
 *               fires the rejection which the operation try/catch handles)
 *  - Failed:    mark Cancelled (lock already released at failure time)
 *  - Done / Cancelled: no-op
 *
 * Returns an error string on failure, undefined on success.
 */
export const cancelOperation = (
    storeHandle: DocHandle<Store>,
    opId: string
): string | undefined => {
    const store = storeHandle.doc()
    const op = store.operationDB?.[opId]
    if (!op) return `Operation '${opId}' not found`

    if (op.status === 'Done' || op.status === 'Cancelled') {
        log(`cancelOperation: op ${opId} is already ${op.status} — no-op`)
        return undefined
    }

    if (op.status === 'Running') {
        const proc = _activeProcesses.get(opId)
        if (!proc) {
            return `Operation '${opId}' is Running but no cancellable process is registered — it may be in a non-rsync phase`
        }
        log(`cancelOperation: sending SIGTERM to pid ${proc.pid} for op ${opId}`)
        proc.kill('SIGTERM')
        // Mark Cancelled immediately — the process close handler will reject the rsync
        // promise, which the operation try/catch will catch (status is already Cancelled).
        storeHandle.change(doc => {
            const o = doc.operationDB?.[opId]
            if (o) {
                o.status = 'Cancelled' as OperationStatus
                o.completedAt = Date.now() as Timestamp
            }
        })
        log(`cancelOperation: op ${opId} (${op.kind}) marked Cancelled (SIGTERM sent)`)
        return undefined
    }

    // Pending: remove from the engine command queue
    if (op.status === 'Pending') {
        storeHandle.change(doc => {
            const eng = doc.engineDB[op.engineId as any]
            if (eng?.commands) {
                // Scan queue for a command whose opId is referenced in the operation args.
                // Commands are strings like "copyApp <instanceName> <srcDiskId> <tgtDiskId>".
                // We match by checking if any arg value appears in the command string AND
                // the op's args values are a subset of the command tokens.
                const queue = eng.commands as string[]
                // Match by disk IDs stored in operation args — these appear verbatim
                // in the command string (e.g. "copyApp <name> <srcDiskId> <tgtDiskId>").
                // instanceId is an internal ID that does NOT appear in the command string.
                const diskArgs = Object.entries(op.args)
                    .filter(([k]) => k.toLowerCase().includes('disk'))
                    .map(([, v]) => v)
                const idx = diskArgs.length > 0
                    ? queue.findIndex(cmd => diskArgs.every(v => cmd.includes(v)))
                    : -1
                if (idx !== -1) {
                    log(`cancelOperation: splicing command at index ${idx} from engine ${op.engineId} queue`)
                    ;(eng.commands as any[]).splice(idx, 1)
                } else {
                    log(`cancelOperation: command not found in queue for op ${opId} — may have already started`)
                }
            }
        })
    }

    // Pending or Failed: mark Cancelled
    storeHandle.change(doc => {
        const o = doc.operationDB?.[opId]
        if (o) {
            o.status = 'Cancelled' as OperationStatus
            o.completedAt = Date.now() as Timestamp
        }
    })

    log(`cancelOperation: op ${opId} (${op.kind}) marked Cancelled`)
    return undefined
}

// ── Startup crash recovery ────────────────────────────────────────────────────

/**
 * engine#477: how a queued command is matched to the Operation it created.
 * `command` is the queued command's first word, `ref` says what its first argument
 * names: the op's instance (id or name), its disk (id or name), or a raw target id
 * (flash / initialise / Backup Disk candidate). removeDemo's arguments are its
 * instance ids as a set (the bare form has none). null: no queued command creates
 * this kind (legacy upgradeApp, not-implemented upgradeEngine).
 */
type ReplayRef = 'instance' | 'disk' | 'target' | 'instanceList'
export const QUEUED_COMMAND_OF: Record<OperationKind, { command: string; ref: ReplayRef; arg?: string } | null> = {
    copyApp:        { command: 'copyApp', ref: 'instance' },
    moveApp:        { command: 'moveApp', ref: 'instance' },
    backupApp:      { command: 'backupApp', ref: 'instance' },
    restoreApp:     { command: 'restoreApp', ref: 'instance' },
    updateApp:      { command: 'updateApp', ref: 'instance' },
    startApp:       { command: 'startInstance', ref: 'instance' },
    stopApp:        { command: 'stopInstance', ref: 'instance' },
    flashCard:      { command: 'flashCard', ref: 'target', arg: 'candidateId' },
    initialiseDisk: { command: 'initialiseDisk', ref: 'target', arg: 'candidateId' },
    makeBackupDisk: { command: 'makeBackupDisk', ref: 'target', arg: 'targetId' },
    setupDemo:      { command: 'setupDemo', ref: 'disk', arg: 'targetDiskId' },
    removeDemo:     { command: 'removeDemo', ref: 'instanceList', arg: 'instanceIds' },
    upgradeApp:     null,
    upgradeEngine:  null,
}

/** Operation states boot recovery leaves as final: the op's command must not run again. */
const SETTLED: readonly OperationStatus[] = ['Done', 'Failed', 'Cancelled']

const queuedMatchesOp = (store: Store | undefined, op: Operation, tokens: string[]): boolean => {
    const spec = QUEUED_COMMAND_OF[op.kind]
    if (!spec || tokens[0] !== spec.command) return false
    const args = (op.args ?? {}) as Record<string, string>
    if (spec.ref === 'instanceList') {
        const want = String(args[spec.arg!] ?? '').split(',').filter(Boolean).sort()
        const got = tokens.slice(1).filter(t => !t.startsWith('--')).sort()
        return want.length === got.length && want.every((v, i) => v === got[i])
    }
    const refs = new Set<string>()
    if (spec.ref === 'instance') {
        const id = String(args.instanceId ?? '')
        if (id) refs.add(id)
        if (args.instanceName) refs.add(String(args.instanceName))
        const name = id ? store?.instanceDB?.[id as any]?.name : undefined
        if (name) refs.add(String(name))
    } else {
        const id = String(args[spec.arg!] ?? '')
        if (id) refs.add(id)
        const name = id ? (store?.diskDB?.[id as any] as any)?.name : undefined
        if (spec.ref === 'disk' && name) refs.add(String(name))
    }
    return refs.size > 0 && refs.has(tokens[1] ?? '')
}

/**
 * engine#477 (generalises engine#469 Pi proof step 8): a queued command leaves
 * engineDB[x].commands only when it finishes, so the command of an operation the Engine
 * died in is still queued at boot and the startup replay would run it again (an updateApp
 * took a second temporary backup and rolled back again, on every boot; a flashCard would
 * re-flash a card on its own after a power cut).
 *
 * Rule, for every Operation kind: once boot recovery has left the op in a final state
 * (Done, Failed or Cancelled, read back from the store), remove the first queued command
 * that created it (QUEUED_COMMAND_OF), the one that was running. A later identical command
 * someone queued on purpose stays. An op that is not in the store removes nothing.
 *
 * engine#497: an op recovery is retrying (Pending/Running) is owned by recovery, which
 * re-runs it inside the same op; pass { retryOwned: true } so its queued command goes
 * too and the startup replay cannot run it a second time. Without retryOwned a
 * Pending/Running op keeps its command. Returns the removed command, or null.
 */
export const dropInterruptedCommand = (
    storeHandle: DocHandle<Store>,
    op: Operation | null | undefined,
    opts: { retryOwned?: boolean } = {},
): string | null => {
    if (!op?.id) return null
    const store = storeHandle.doc()
    const current = store?.operationDB?.[op.id]
    if (!current) return null
    if (!SETTLED.includes(current.status) && !opts.retryOwned) return null
    if (!QUEUED_COMMAND_OF[current.kind]) return null
    const engineId = current.engineId ?? op.engineId
    if (!engineId) return null
    let removed: string | null = null
    storeHandle.change(doc => {
        const list = doc.engineDB[engineId as any]?.commands as unknown[] | undefined
        if (!list) return
        const i = list.findIndex(c => queuedMatchesOp(store, current, (typeof c === 'string' ? c : String(c ?? '')).trim().split(/\s+/)))
        if (i === -1) return
        removed = String(list[i])
        list.splice(i, 1)
    })
    if (removed) log(`recovery: ${op.id.slice(0, 8)} ${current.kind} (${current.status}): removed its queued command '${entryLogText(removed)}' so the startup replay does not run it again${opts.retryOwned ? ' (boot recovery retries it in this op)' : ''}`)
    return removed
}

/** Text a retried op carries while boot recovery re-runs it (engine#497). */
export const RETRY_MARKER = 'Retrying after interrupted run'

// ── engine#497 stage 2: resumable operations (Koen's rule) ───────────────────
//
// An interrupted local copyApp / moveApp (in-flight marker next to the target folder)
// or backupApp (its own .backup-in-progress lock) RESUMES inside the original op: on
// every boot and when its disks dock again. An interruption (power cut, Engine stop,
// a disk going away) is never counted. A real failure increments args.resumeFailures;
// at RESUME_LIMIT the op goes Failed with RESUME_GAVE_UP and its partial target and
// marker are kept for the operator. Such an op records args.phase (isResumableOp).

/** Real failures after which a resumable op gives up (engine#497). */
export const RESUME_LIMIT = 3
/** Waiting for its disks (interrupted, not counted). */
export const RESUME_WAITING = 'RESUME_WAITING'
/** A counted failure; resumes at the next boot or dock. */
export const RESUME_PENDING = 'RESUME_PENDING'
/** RESUME_LIMIT real failures: Failed, the partial target and its marker are kept. */
export const RESUME_GAVE_UP = 'RESUME_GAVE_UP'
const RESUME_TEXT = /^RESUME_(WAITING|PENDING|GAVE_UP)\b/
const RESUMABLE_KINDS: readonly OperationKind[] = ['copyApp', 'moveApp', 'backupApp']

/**
 * An op that resumes in place: a local copy/move or a backup that recorded args.phase, or
 * (engine#497 stage 3 (a)) a cross-Engine copy/move that recorded args.crossResume '1'.
 * A cross-Engine move of an older Engine (op.move without crossResume) is not resumable.
 */
export const isResumableOp = (op: Operation | null | undefined): boolean =>
    !!op && RESUMABLE_KINDS.includes(op.kind) && !!op.args?.phase && (!op.move || op.args?.crossResume === '1')

/** A resumable op waiting for its next boot or dock (Pending, RESUME_WAITING / RESUME_PENDING). */
export const isParkedOp = (op: Operation | null | undefined): boolean =>
    !!op && op.status === 'Pending' && /^RESUME_(WAITING|PENDING)\b/.test(String(op.error ?? ''))

/** Set (string) or delete (null) fields of Operation.args. */
export const setOperationArgs = (storeHandle: DocHandle<Store>, id: string, patch: Record<string, string | null>): void => {
    storeHandle.change(doc => {
        const op = doc.operationDB?.[id]
        if (!op) return
        if (!op.args) (op as any).args = {}
        for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete op.args[k]
            else op.args[k] = v
        }
    })
}

let engineStopping = false
/** start.ts SIGINT/SIGTERM: what fails from now on is an interruption, never a counted failure. */
export const markEngineStopping = (): void => { engineStopping = true }
export const isEngineStopping = (): boolean => engineStopping
/** Tests only. */
export const resetEngineStoppingForTests = (): void => { engineStopping = false }

const stripResumePrefixes = (reason: string): string => {
    let r = String(reason ?? '').trim()
    for (;;) {
        const next = r.replace(/^(RESUME_(WAITING|PENDING|GAVE_UP)( \(\d+\/\d+\))?|Retry failed|COPY_FAILED|MOVE FAILED):\s*/, '')
        if (next === r) return r || 'unknown error'
        r = next
    }
}

export type ParkOutcome = 'left' | 'waiting' | 'pending' | 'gaveUp' | 'refused'

/**
 * engine#582 / engine#595: the target Engine no longer accepts this Engine's permission: a
 * grantCheck refusal (GRANT_EXPIRED / GRANT_INVALID) or its helper's transfer-ticket refusal
 * ("refused: GRANT_EXPIRED: …", e.g. after that Engine restarted). Never an interruption and
 * never resumed: a new permission is needed, so the op ends.
 */
export const grantRefusalCode = (reason: string): 'GRANT_EXPIRED' | 'GRANT_INVALID' | null => {
    const r = String(reason ?? '')
    if (/\bGRANT_INVALID\b/.test(r)) return 'GRANT_INVALID'
    return /\bGRANT_EXPIRED\b/.test(r) ? 'GRANT_EXPIRED' : null
}

/**
 * End a resumable op the target Engine refused (grantRefusalCode): Failed `<code>: <reason>`,
 * args.errorCode, and the kind's gave-up hook (a move starts its source again). The partial
 * copy stays on the target under its in-flight marker (deleting it there needs a permission too).
 */
export const failRefusedResumableOp = (storeHandle: DocHandle<Store>, id: string, code: string, reason: string): void => {
    const op = storeHandle.doc()?.operationDB?.[id]
    if (!op) return
    const why = stripResumePrefixes(reason).replace(/^(GRANT_EXPIRED|GRANT_INVALID):\s*/, '')
    setOperationArgs(storeHandle, id, { errorCode: code })
    updateOperation(storeHandle, id, { status: 'Failed', error: `${code}: ${why}`, completedAt: Date.now() as Timestamp })
    log(chalk.red(`resume: ${id.slice(0, 8)} ${op.kind}: the target Engine refused this Engine's permission (${code}): ${why}; not resumed`))
    runGaveUpHook(storeHandle, id)
}

/**
 * engine#497 stage 3 (c): what a kind does once its op gave up (RESUME_GAVE_UP). moveApp
 * registers one (CopyMoveApp.ts) that starts the source again if the move had stopped it.
 * Runs in the background; its errors are logged, never thrown into the op.
 */
export type ResumeGaveUpHook = (storeHandle: DocHandle<Store>, op: Operation) => Promise<void>
export const resumeGaveUpHooks: Partial<Record<OperationKind, ResumeGaveUpHook>> = {}

const runGaveUpHook = (storeHandle: DocHandle<Store>, id: string): void => {
    const op = storeHandle.doc()?.operationDB?.[id]
    const hook = op ? resumeGaveUpHooks[op.kind] : undefined
    if (!op || !hook) return
    void hook(storeHandle, op).catch((e: any) => log(chalk.red(`resume: ${id.slice(0, 8)} ${op.kind}: after giving up: ${e?.message ?? e}`)))
}

/**
 * Close a run of a resumable op that did not finish. `interrupted` (its disks are gone):
 * Pending RESUME_WAITING, not counted. Otherwise a real failure: args.resumeFailures + 1,
 * Pending `RESUME_PENDING (n/3): <reason>`, and at RESUME_LIMIT Failed
 * `RESUME_GAVE_UP: <reason>`. A Cancelled op, or one whose Engine is stopping, is left as it is.
 */
export const parkResumableOp = (
    storeHandle: DocHandle<Store>,
    id: string,
    reason: string,
    opts: { interrupted?: boolean } = {},
): ParkOutcome => {
    const op = storeHandle.doc()?.operationDB?.[id]
    if (!op || op.status === 'Cancelled' || op.status === 'Done' || engineStopping) return 'left'
    const why = stripResumePrefixes(reason)
    const refused = grantRefusalCode(why)
    if (refused) {
        failRefusedResumableOp(storeHandle, id, refused, why)
        return 'refused'
    }
    if (opts.interrupted) {
        updateOperation(storeHandle, id, { status: 'Pending', error: `${RESUME_WAITING}: ${why}`, completedAt: null })
        log(chalk.yellow(`resume: ${id.slice(0, 8)} ${op.kind} interrupted (${why}); it resumes when its disks are docked (not counted)`))
        return 'waiting'
    }
    const n = (Number(op.args?.resumeFailures ?? 0) || 0) + 1
    setOperationArgs(storeHandle, id, { resumeFailures: String(n) })
    if (n < RESUME_LIMIT) {
        updateOperation(storeHandle, id, { status: 'Pending', error: `${RESUME_PENDING} (${n}/${RESUME_LIMIT}): ${why}`, completedAt: null })
        log(chalk.yellow(`resume: ${id.slice(0, 8)} ${op.kind} failed (${n}/${RESUME_LIMIT}): ${why}; it resumes at the next boot or dock`))
        return 'pending'
    }
    updateOperation(storeHandle, id, { status: 'Failed', error: `${RESUME_GAVE_UP}: ${why}`, completedAt: Date.now() as Timestamp })
    log(chalk.red(`resume: ${id.slice(0, 8)} ${op.kind} gave up after ${n} failures: ${why}; the partial target and its marker are kept`))
    runGaveUpHook(storeHandle, id)
    return 'gaveUp'
}

/** The disks a resumable op needs docked here before it resumes. */
export const resumeDisksOf = (store: Store | undefined, op: Operation): string[] => {
    const a = (op.args ?? {}) as Record<string, string>
    const ids = op.kind === 'backupApp'
        ? [a.backupDiskId, store?.instanceDB?.[a.instanceId as any]?.storedOn]
        : [a.sourceDiskId, a.targetDiskId]
    return Array.from(new Set(ids.filter(Boolean).map(String)))
}

/** Disks that docked (finished their dock pass) on this Engine since it started. */
const dockedThisBoot = new Set<string>()

/**
 * engine#497 stage 3 (a): how this Engine reaches a peer now (its address in the network
 * connections, or undefined). CopyMoveApp.ts wires it to Network.getEngineAddress; tests replace it.
 */
/**
 * How this Engine reaches a peer for a parked-op resume (engine#497 / #511 B2).
 * `address` is the sync gate (a live WS address). `reachable` is the liveness
 * probe: production requires a fresh heartbeat (when one has been seen) plus a
 * successful TCP connect to the Engine port. When `reachable` is omitted, a
 * truthy `address` is enough (tests).
 */
export const peerResumeProbe: {
    address: (engineId: string) => string | undefined
    reachable?: (engineId: string) => boolean | Promise<boolean>
} = { address: () => undefined }

/**
 * The target disk of a cross-Engine copy/move is ready on a peer: docked there, the peer is
 * connected now and advertises crossEngineResume (this boot). Only the op's target may be on a
 * peer; its source is always on this Engine.
 */
export const peerTargetReady = (store: Store | undefined, op: Operation, diskId: string, engineId: EngineID = localEngineId): boolean => {
    const a = (op.args ?? {}) as Record<string, string>
    if (a.crossEngine !== 'true' || String(a.targetDiskId) !== String(diskId)) return false
    const d = store?.diskDB?.[diskId as any] as any
    if (!d?.device || !d.dockedTo || String(d.dockedTo) === String(engineId)) return false
    return !!peerResumeProbe.address(String(d.dockedTo)) && engineCanResume(store, String(d.dockedTo))
}

/**
 * engine#511 Finding 2: this Engine's system disk while `systemDiskSkip` is set: the record says it
 * is docked here (device set, 'system' marker), but the USB monitor skips it, so no dock pass ever
 * reports it. Without systemDiskSkip the system disk docks through processDisk like any disk.
 */
export const skippedSystemDiskHere = (d: any, engineId: EngineID = localEngineId, systemDiskSkip: boolean = !!config.settings.systemDiskSkip): boolean =>
    systemDiskSkip && !!d?.device && String(d.dockedTo) === String(engineId) && (d.diskTypes ?? []).includes('system')

/**
 * Ready when every disk the op needs that is (or was) on this Engine has finished a dock pass
 * here since the Engine started. Boot recovery runs before the USB monitor docks anything, so
 * a resumable op always waits for its dock pass (the source App is started by that pass and
 * stopped again by the resumed copy, never in the middle of it). A disk docked to another
 * Engine holds it back too (only the owning Engine resumes). A disk unknown to the store
 * does not: the op's own validation refuses it, which counts as a real failure.
 */
export const resumeGate = (store: Store | undefined, op: Operation, engineId: EngineID = localEngineId): { ready: boolean, waitingFor: string[] } => {
    const waitingFor = resumeDisksOf(store, op).filter(id => {
        const d = store?.diskDB?.[id as any] as any
        if (!d) return false
        // docked to another Engine: only this Engine resumes its op, when the disk is back here
        // (engine#497 (a): or, for a cross-Engine op's target, when it is ready on a peer)
        if (peerTargetReady(store, op, id, engineId)) return false
        // engine#511 Finding 2: with systemDiskSkip this Engine's own system disk never gets a dock
        // pass (so never noteDiskDocked), yet it is always present. It counts as docked here, so an
        // op that needs it resumes at boot / on a peer reconnect instead of waiting for ever.
        if (skippedSystemDiskHere(d, engineId)) return false
        return !(dockedThisBoot.has(id) && d.device && String(d.dockedTo) === String(engineId))
    })
    return { ready: waitingFor.length === 0, waitingFor }
}

const diskLabel = (store: Store | undefined, id: string): string => {
    const name = (store?.diskDB?.[id as any] as any)?.name
    return name ? `'${name}' (${id})` : id
}

let resumeHandlers: Partial<Record<OperationKind, RetryHandler>> | null = null
/** Resumable ops being re-run now (by boot recovery or a dock), never twice at once. */
const activeResumes = new Set<string>()

/** Tests only: forget the docked disks, handlers and active resumes of this Engine run. */
export const resetResumeStateForTests = (): void => {
    dockedThisBoot.clear()
    activeResumes.clear()
    resumeHandlers = null
    peerSeen.clear()
    peerTriedAt.clear()
    peerProbeRetry.clear()
}

/**
 * Run a recovery retry handler inside the op (engine#497) in its own trace, and close the op
 * from the result. A resumable op that the handler parked (RESUME_…) is left as parked; one
 * the handler did not park is parked here (a real failure counts, a missing disk does not).
 */
const runRecoveryRetry = (
    storeHandle: DocHandle<Store>,
    op: Operation,
    handler: RetryHandler,
): Promise<void> => {
    const cmdLogHandle = getCommandLogHandle()
    const traceId = crypto.randomUUID()
    const traceArgs = JSON.stringify({ ...op.args, recoveredOpId: op.id })
    if (cmdLogHandle) addTrace(cmdLogHandle, { traceId, command: op.kind, args: traceArgs, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
    activeResumes.add(op.id)
    const current = () => storeHandle.doc()?.operationDB?.[op.id]
    const statusNow = () => current()?.status
    const parkedByRun = () => RESUME_TEXT.test(String(current()?.error ?? ''))
    // Fire-and-forget: the retry runs in background; startup continues. It runs inside
    // this trace, so the handler's errors reach us (backupInstance rethrows inside a
    // trace) and the op is closed from the result, never left Pending without a reason.
    return runWithTrace({ traceId, command: op.kind, args: traceArgs }, () => handler(op.args, storeHandle, op.id)).then(async () => {
        if (engineStopping) return
        const st = statusNow()
        if ((st === 'Pending' || st === 'Running') && !(isResumableOp(current()) && parkedByRun())) {
            updateOperation(storeHandle, op.id, { status: 'Done', progressPercent: 100, error: null, completedAt: Date.now() as Timestamp })
        } else if (st === 'Done' && current()?.error === RETRY_MARKER) {
            updateOperation(storeHandle, op.id, { error: null })
        }
        const bad = statusNow() === 'Failed' || isParkedOp(current())
        const why = bad ? String(current()?.error ?? 'retry failed') : undefined
        if (bad) log(chalk.red(`  ${op.id.slice(0, 8)} ${op.kind}: retry failed — ${why}`))
        if (cmdLogHandle) { await flushTrace(traceId); closeTrace(cmdLogHandle, traceId, bad ? 'error' : 'ok', why) }
    }).catch(async err => {
        const msg = err?.message ?? String(err)
        log(chalk.red(`  ${op.id.slice(0, 8)} ${op.kind}: retry failed — ${msg}`))
        if (engineStopping) {
            // an interruption: boot recovery picks the op up again
        } else if (isResumableOp(current())) {
            if (!parkedByRun() && statusNow() !== 'Cancelled') {
                const gate = resumeGate(storeHandle.doc(), current()!)
                parkResumableOp(storeHandle, op.id, msg, { interrupted: !gate.ready || isPeerLinkFailure(msg) })
            }
        } else if (statusNow() !== 'Cancelled') {
            updateOperation(storeHandle, op.id, {
                status: 'Failed',
                error: `Retry failed: ${msg}`,
                completedAt: Date.now() as Timestamp,
            })
        }
        const text = String(current()?.error ?? `Retry failed: ${msg}`)
        if (cmdLogHandle) { await flushTrace(traceId); closeTrace(cmdLogHandle, traceId, 'error', text) }
    }).finally(() => { activeResumes.delete(op.id) })
}

/**
 * engine#497: resume this Engine's parked resumable ops that need `diskId` (all of them
 * without one) and whose disks are all docked here now. Called when a disk finished its
 * dock pass (noteDiskDocked). Returns the ids it started.
 */
export const resumeParkedOps = (storeHandle: DocHandle<Store>, diskId?: string, engineId: EngineID = localEngineId): string[] => {
    if (!resumeHandlers) return []
    const store = storeHandle.doc()
    const started: string[] = []
    for (const op of Object.values(store?.operationDB ?? {})) {
        if (!op || !isResumableOp(op) || !isParkedOp(op)) continue
        if (String(op.engineId) !== String(engineId) || activeResumes.has(op.id)) continue
        if (op.kind === 'backupApp' && op.cause === 'scheduled-backup') continue
        if (diskId && !resumeDisksOf(store, op).includes(String(diskId))) continue
        if (!resumeGate(store, op, engineId).ready) continue
        const handler = resumeHandlers[op.kind]
        if (!handler) continue
        log(chalk.blue(`resume: ${op.id.slice(0, 8)} ${op.kind}: its disks are docked; resuming it in the same operation (was: ${op.error})`))
        updateOperation(storeHandle, op.id, { status: 'Pending', error: RETRY_MARKER })
        void runRecoveryRetry(storeHandle, op, handler)
        started.push(op.id)
    }
    return started
}

/**
 * engine#497 stage 3 (a): why a failed cross-Engine run counts as an interruption on the peer side
 * (the target disk left its Engine, that Engine is not connected, or the link to it failed), or
 * null when it is a real failure.
 */
export const peerInterruption = (store: Store | undefined, targetDiskId: string, targetEngineId: string, reason: string): string | null => {
    const d = store?.diskDB?.[targetDiskId as any] as any
    const label = d?.name ? `'${d.name}' (${targetDiskId})` : targetDiskId
    if (!d?.device || !d.dockedTo) return `target disk ${label} is no longer docked`
    if (String(d.dockedTo) !== String(targetEngineId)) return `target disk ${label} is no longer docked to Engine ${targetEngineId}`
    if (!peerResumeProbe.address(String(targetEngineId))) return `Engine ${targetEngineId} is not connected`
    if (isPeerLinkFailure(reason)) return `the link to Engine ${targetEngineId} failed`
    return null
}

// ── engine#497 stage 3 (a): resume when a peer target comes back ─────────────
//
// The target disk of a cross-Engine op docks on the PEER, so noteDiskDocked never fires here.
// The source Engine watches the store (and a timer) instead. A parked op whose target is ready
// on a peer resumes when:
//   - it is RESUME_WAITING (an interruption, never counted): at most once per PEER_RESUME_RETRY_MS;
//   - it is RESUME_PENDING (a counted failure): only when the peer rebooted or the disk re-docked
//     there since this Engine last looked (lastBooted / lastDocked / address changed), like a dock.
// engine#511e: a failed liveness probe does not consume that peer change. It re-arms a bounded
// retry (15 s, 30 s, 60 s, capped at the liveness window). After the last backoff the op waits
// for the next peer change. Either kind therefore resumes on its own once the target Engine is
// really back, without a further dock or boot.

/** How often a RESUME_WAITING cross-Engine op is tried again while its peer target is ready. */
export const PEER_RESUME_RETRY_MS = 60_000
/** Cap on a failed-probe retry delay; matches the resume liveness window (PEER_CLOCK_STALE_MS). */
export const PEER_PROBE_RETRY_CAP_MS = 60_000
/** Backoff after a failed liveness probe, before waiting for the next peer change (engine#511e). */
export const PEER_PROBE_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000].map(ms => Math.min(ms, PEER_PROBE_RETRY_CAP_MS))
const peerSeen = new Map<string, string>()
const peerTriedAt = new Map<string, number>()
/** Failed-probe backoff: not written to peerSeen, so a later live probe can still use `changed`. */
const peerProbeRetry = new Map<string, { key: string, fails: number, triedAt: number }>()
const peerProbeBackoffMs = (fails: number): number | undefined =>
    fails > 0 && fails <= PEER_PROBE_BACKOFF_MS.length ? PEER_PROBE_BACKOFF_MS[fails - 1] : undefined

const peerKeyOf = (store: Store | undefined, op: Operation): string => {
    const d = store?.diskDB?.[String(op.args?.targetDiskId ?? '') as any] as any
    const e = d?.dockedTo ? (store?.engineDB as any)?.[String(d.dockedTo)] : undefined
    return `${d?.dockedTo ?? '-'}|${e?.lastBooted ?? '-'}|${d?.lastDocked ?? '-'}|${d?.dockedTo ? peerResumeProbe.address(String(d.dockedTo)) ?? '-' : '-'}`
}

/** Resume this Engine's parked cross-Engine ops whose peer target is ready (see above). Returns the ids it started. */
export const resumePeerParkedOps = async (storeHandle: DocHandle<Store>, now: number = Date.now(), engineId: EngineID = localEngineId): Promise<string[]> => {
    if (!resumeHandlers) return []
    const store = storeHandle.doc()
    const started: string[] = []
    for (const op of Object.values(store?.operationDB ?? {})) {
        if (!op || op.args?.crossEngine !== 'true' || !isResumableOp(op) || !isParkedOp(op)) continue
        if (String(op.engineId) !== String(engineId) || activeResumes.has(op.id)) continue
        const key = peerKeyOf(store, op)
        const prev = peerSeen.get(op.id)
        const changed = prev !== undefined && prev !== key
        const rec = peerProbeRetry.get(op.id)
        // A new peer key resets the failed-probe backoff so a later boot or dock gets a fresh schedule
        if (rec && rec.key !== key) peerProbeRetry.delete(op.id)
        const backoff = peerProbeRetry.get(op.id)
        if (!resumeGate(store, op, engineId).ready) {
            peerSeen.set(op.id, key)
            continue
        }
        const waiting = String(op.error ?? '').startsWith(RESUME_WAITING)
        const due = now - (peerTriedAt.get(op.id) ?? 0) >= PEER_RESUME_RETRY_MS
        const retryAfter = backoff ? peerProbeBackoffMs(backoff.fails) : undefined
        const probeRetryDue = retryAfter !== undefined && now - backoff!.triedAt >= retryAfter
        // First look at a new peer key, or a WAITING interval while not in probe backoff,
        // or a scheduled retry after a failed probe (PENDING or WAITING).
        const firstShot = changed && !backoff
        const waitingDue = waiting && due && !backoff
        if (!firstShot && !waitingDue && !probeRetryDue) {
            peerSeen.set(op.id, key)
            continue
        }
        const handler = resumeHandlers[op.kind]
        if (!handler) continue
        // engine#511 B2: do not log "its target is ready" or start the retry until a
        // liveness probe succeeds. A stale connections[] address / store dockedTo is not enough.
        if (peerResumeProbe.reachable) {
            const targetEngineId = String((store?.diskDB as any)?.[String(op.args?.targetDiskId)]?.dockedTo ?? op.args?.targetEngineId ?? '')
            let live = false
            try { live = !!(await peerResumeProbe.reachable(targetEngineId)) } catch { live = false }
            if (!live) {
                // engine#511e: do not consume peerSeen/changed; re-arm 15 s, 30 s, 60 s, then wait for the next peer change
                const fails = (backoff?.fails ?? 0) + 1
                peerProbeRetry.set(op.id, { key, fails, triedAt: now })
                continue
            }
        }
        peerSeen.set(op.id, key)
        peerProbeRetry.delete(op.id)
        peerTriedAt.set(op.id, now)
        log(chalk.blue(`resume: ${op.id.slice(0, 8)} ${op.kind}: its target is ready on Engine ${String((store?.diskDB as any)?.[String(op.args?.targetDiskId)]?.dockedTo)}; resuming it in the same operation (was: ${op.error})`))
        updateOperation(storeHandle, op.id, { status: 'Pending', error: RETRY_MARKER })
        void runRecoveryRetry(storeHandle, op, handler)
        started.push(op.id)
    }
    return started
}

/**
 * Start the watch for resumePeerParkedOps: on every store change (throttled to once a second)
 * and every PEER_RESUME_RETRY_MS. Returns a stop function.
 */
export const watchPeerResumes = (storeHandle: DocHandle<Store>, intervalMs: number = PEER_RESUME_RETRY_MS): (() => void) => {
    let last = 0
    const run = () => {
        const now = Date.now()
        if (now - last < 1000) return
        last = now
        try { void resumePeerParkedOps(storeHandle, now).catch((e: any) => log(chalk.red(`resume: peer watch: ${e?.message ?? e}`))) } catch (e: any) { log(chalk.red(`resume: peer watch: ${e?.message ?? e}`)) }
    }
    storeHandle.on('change', run)
    const timer = setInterval(run, Math.max(1000, intervalMs))
    timer.unref?.()
    return () => { clearInterval(timer); try { storeHandle.off('change', run) } catch { /* typings */ } }
}

/** A disk finished its dock pass on this Engine: resume the parked ops that waited for it. */
export const noteDiskDocked = (storeHandle: DocHandle<Store>, diskId: string): string[] => {
    dockedThisBoot.add(String(diskId))
    return resumeParkedOps(storeHandle, String(diskId))
}

/** A disk left this Engine: ops that need it wait for its next dock pass. */
export const noteDiskUndocked = (diskId: string): void => { dockedThisBoot.delete(String(diskId)) }

/**
 * A boot-recovery retry handler. It re-runs the op inside the same Operation
 * (recoveredOpId / existingOpId), so the op itself ends Done or Failed (engine#497).
 * It must reject on failure; recoverInterruptedOperations then closes the op Failed.
 */
export type RetryHandler = (args: Record<string, string>, storeHandle: DocHandle<Store>, opId: string) => Promise<void>

/**
 * Called during engine startup. Scans operationDB for any operation left in
 * Running or Pending state (caused by a crash or reboot mid-operation).
 *
 * Per-kind strategy (RECOVERY_STRATEGY):
 *   - 'retry': re-queues the operation by calling the provided retry handler
 *   - 'fail':  marks as Failed; operator must re-issue manually
 *
 * The retry handler map is passed in from start.ts (RecoveryRetry.ts) to avoid circular
 * imports. Each handler receives the original operation args, the storeHandle and the
 * operation id; it re-runs the work inside that operation (engine#497).
 */
export const recoverInterruptedOperations = async (
    storeHandle: DocHandle<Store>,
    retryHandlers: Partial<Record<OperationKind, RetryHandler>>,
    engineId: EngineID = localEngineId,
): Promise<void> => {
    const store = storeHandle.doc()
    // engine#497: the same handlers resume parked ops when their disks dock (noteDiskDocked)
    resumeHandlers = retryHandlers
    if (!store.operationDB) return

    // operationDB is shared by all Engines. Only this Engine's own operations
    // (Operation.engineId, set by createOperation) were interrupted by this
    // restart; another Engine's Running/Pending op is still running there, and an
    // op without an engineId has an unknown owner. Both are left alone.
    const unfinished = Object.values(store.operationDB).filter(
        op => op && (op.status === 'Running' || op.status === 'Pending')
    )
    const interrupted = unfinished.filter(op => op.engineId && String(op.engineId) === String(engineId))
    const others = unfinished.length - interrupted.length
    if (others > 0) log(`recoverInterruptedOperations: leaving ${others} unfinished operation(s) of other (or unknown) Engines alone`)
    if (interrupted.length === 0) return

    log(`recoverInterruptedOperations: ${interrupted.length} interrupted operation(s) found`)

    for (const op of interrupted) {
        // engine#595: parked by an earlier run after the target Engine refused this Engine's
        // permission (it restarted): never resumed, a new permission is needed
        const refusedCode = isParkedOp(op) ? grantRefusalCode(String(op.error ?? '')) : null
        if (refusedCode) {
            dropInterruptedCommand(storeHandle, op)
            failRefusedResumableOp(storeHandle, op.id, refusedCode, String(op.error ?? ''))
            continue
        }
        // idea#79: an interrupted cross-Engine move is never retried and never
        // removes the source; only a recorded verify means the copy is good.
        if (op.kind === 'moveApp' && op.move && !isResumableOp(op)) {
            const verified = op.move.verified === true
            const { cleanupUnverifiedMoveTarget, flipStoredOnAfterVerify } = await import('./MoveAppRemote.js')
            if (!verified) {
                await cleanupUnverifiedMoveTarget(storeHandle, op as any)
            } else {
                const id = String(op.move.sourceInstanceId ?? op.args?.instanceId ?? '')
                const tgt = String(op.args?.targetDiskId ?? '')
                if (id && tgt) flipStoredOnAfterVerify(storeHandle, id, tgt)
            }
            const text = verified
                ? 'MOVED, source not removed: the Engine restarted before the old copy was removed'
                : 'MOVE FAILED: the Engine restarted during the move; source kept'
            log(chalk.yellow(`  ${op.id.slice(0, 8)} moveApp (cross-Engine): ${text}`))
            storeHandle.change(doc => {
                const m = (doc.operationDB?.[op.id] as any)?.move
                if (m) { m.phase = verified ? 'done' : 'failed'; m.code = verified ? 'SOURCE_NOT_REMOVED' : 'INTERRUPTED'; m.resultText = text }
            })
            updateOperation(storeHandle, op.id, { status: verified ? 'Done' : 'Failed', error: text, completedAt: Date.now() as Timestamp })
            dropInterruptedCommand(storeHandle, op)
            continue
        }
        // idea#400 (Steve, Q2): a scheduled backup is never retried after a restart.
        // The .backup-in-progress is recorded as INTERRUPTED at dock and cleared if
        // stale (engine#429); the next slot, or an immediate dock backup, then runs.
        const scheduledBackup = op.kind === 'backupApp' && op.cause === 'scheduled-backup'
        const strategy = scheduledBackup ? 'fail' : (RECOVERY_STRATEGY[op.kind] ?? 'fail')
        const handler = retryHandlers[op.kind]
        const cmdLogHandle = getCommandLogHandle()
        const traceId = crypto.randomUUID()
        const traceArgs = JSON.stringify({ ...op.args, recoveredOpId: op.id })

        if (strategy === 'retry' && handler && isResumableOp(op)) {
            // engine#497 stage 2: resumes in the same op once its disks have docked in this
            // boot (the dock pass runs after recovery). Not counted: this is an interruption.
            dropInterruptedCommand(storeHandle, op, { retryOwned: true })
            if (activeResumes.has(op.id)) continue
            const gate = resumeGate(store, op, engineId)
            if (!gate.ready) {
                const waitText = `resumes when ${gate.waitingFor.map(id => diskLabel(store, id)).join(' and ')} ${gate.waitingFor.length > 1 ? 'have' : 'has'} docked (interrupted by an Engine restart)`
                log(chalk.blue(`  ${op.id.slice(0, 8)} ${op.kind}: resumable (phase ${op.args?.phase}); ${waitText}`))
                updateOperation(storeHandle, op.id, { status: 'Pending', error: `${RESUME_WAITING}: ${waitText}`, completedAt: null })
                continue
            }
            log(chalk.blue(`  ${op.id.slice(0, 8)} ${op.kind}: resuming (phase ${op.args?.phase}) in the same operation`))
            updateOperation(storeHandle, op.id, { status: 'Pending', error: RETRY_MARKER })
            void runRecoveryRetry(storeHandle, op, handler)
        } else if (strategy === 'retry' && handler) {
            log(chalk.blue(`  ${op.id.slice(0, 8)} ${op.kind}: retrying (idempotent) in the same operation`))
            // Mark as Pending before retry so it's visible in the store
            updateOperation(storeHandle, op.id, {
                status: 'Pending',
                error: RETRY_MARKER,
            })
            // engine#497: recovery owns this re-run. Its queued command goes now, so the
            // startup replay does not run the same copy/move/backup a second time.
            dropInterruptedCommand(storeHandle, op, { retryOwned: true })
            void runRecoveryRetry(storeHandle, op, handler)
        } else {
            log(chalk.yellow(`  ${op.id.slice(0, 8)} ${op.kind}: marking Failed (strategy: ${strategy}${strategy === 'retry' ? ', no handler' : ''})`))
            const base = strategy === 'retry'
                ? 'Engine restarted while operation was in progress — re-issue to retry'
                : 'Engine restarted while operation was in progress — re-issue manually'
            // idea#201 §10: client-card operations carry a code the Console can map
            const isCardOp = op.kind === 'flashCard' || op.kind === 'initialiseDisk'
            const isDemoOp = op.kind === 'setupDemo' || op.kind === 'removeDemo'
            const message = scheduledBackup
                ? 'INTERRUPTED: Engine restarted during a scheduled backup — not retried; a stale lock is cleared at dock or the next scheduled run (engine#429)'
                : (isCardOp || isDemoOp) ? `INTERRUPTED: ${base}` : base
            if (cmdLogHandle) {
                addTrace(cmdLogHandle, { traceId, command: op.kind, args: traceArgs, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
                closeTrace(cmdLogHandle, traceId, 'error', message, null, isDemoOp ? 'INTERRUPTED' : undefined)
            }
            if (isDemoOp) {
                const { markDemoInterrupted } = await import('./DemoApps.js')
                markDemoInterrupted(storeHandle, op.id, message)
            }
            updateOperation(storeHandle, op.id, {
                status: 'Failed',
                error: message,
                ...(op.kind === 'flashCard' ? { safeToRemove: false } : {}),
                completedAt: Date.now() as Timestamp,
            })
            dropInterruptedCommand(storeHandle, op)
        }
    }
}
