/**
 * Operations.ts — shared helpers for operationDB lifecycle management
 *
 * Design: design/copy-move-app.md (Operation store type)
 * Group R: Interrupted task recovery
 *
 * All long-running commands (copyApp, moveApp, backupApp, restoreApp, installApp)
 * create and update Operation records here. recoverInterruptedOperations() is called
 * at startup to handle any ops left Running/Pending by a crash.
 */

import { chalk } from 'zx'
import { ChildProcess } from 'child_process'
import { log } from '../utils/utils.js'
import {
    EngineID, Timestamp,
    Operation, OperationKind, OperationStatus
} from './CommonTypes.js'
import { Store } from './Store.js'
import { localEngineId } from './Engine.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'

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
    upgradeApp:    'fail',    // not yet implemented
    upgradeEngine: 'fail',    // not yet implemented
}

// ── Operation CRUD ────────────────────────────────────────────────────────────

export const createOperation = (
    storeHandle: DocHandle<Store>,
    kind: OperationKind,
    args: Record<string, string>
): string => {
    const id = uuid()
    const op: Operation = {
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
    storeHandle.change(doc => {
        if (!doc.operationDB) (doc as any).operationDB = {}
        doc.operationDB[id] = op
    })
    return id
}

export const updateOperation = (
    storeHandle: DocHandle<Store>,
    id: string,
    patch: Partial<Pick<Operation, 'status' | 'progressPercent' | 'completedAt' | 'error'>>
): void => {
    storeHandle.change(doc => {
        const op = doc.operationDB?.[id]
        if (!op) return
        if (patch.status !== undefined) op.status = patch.status
        if (patch.progressPercent !== undefined) op.progressPercent = patch.progressPercent
        if (patch.completedAt !== undefined) op.completedAt = patch.completedAt
        if (patch.error !== undefined) op.error = patch.error
    })
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
 * Called during engine startup. Scans operationDB for any operation left in
 * Running or Pending state (caused by a crash or reboot mid-operation).
 *
 * Per-kind strategy (RECOVERY_STRATEGY):
 *   - 'retry': re-queues the operation by calling the provided retry handler
 *   - 'fail':  marks as Failed; operator must re-issue manually
 *
 * The retry handler map is passed in from start.ts to avoid circular imports.
 * Each handler receives the original operation args and the storeHandle.
 */
export const recoverInterruptedOperations = async (
    storeHandle: DocHandle<Store>,
    retryHandlers: Partial<Record<OperationKind, (args: Record<string, string>, storeHandle: DocHandle<Store>) => Promise<void>>>
): Promise<void> => {
    const store = storeHandle.doc()
    if (!store.operationDB) return

    const interrupted = Object.values(store.operationDB).filter(
        op => op.status === 'Running' || op.status === 'Pending'
    )
    if (interrupted.length === 0) return

    log(`recoverInterruptedOperations: ${interrupted.length} interrupted operation(s) found`)

    for (const op of interrupted) {
        const strategy = RECOVERY_STRATEGY[op.kind] ?? 'fail'
        const handler = retryHandlers[op.kind]

        if (strategy === 'retry' && handler) {
            log(chalk.blue(`  ${op.id.slice(0, 8)} ${op.kind}: retrying (idempotent)`))
            // Mark as Pending before retry so it's visible in the store
            updateOperation(storeHandle, op.id, {
                status: 'Pending',
                error: 'Retrying after interrupted run',
            })
            // Fire-and-forget: retry runs in background; startup continues
            handler(op.args, storeHandle).catch(err => {
                log(chalk.red(`  ${op.id.slice(0, 8)} ${op.kind}: retry failed — ${err.message}`))
                updateOperation(storeHandle, op.id, {
                    status: 'Failed',
                    error: `Retry failed: ${err.message}`,
                    completedAt: Date.now() as Timestamp,
                })
            })
        } else {
            log(chalk.yellow(`  ${op.id.slice(0, 8)} ${op.kind}: marking Failed (strategy: ${strategy}${strategy === 'retry' ? ', no handler' : ''})`))
            updateOperation(storeHandle, op.id, {
                status: 'Failed',
                error: strategy === 'retry'
                    ? 'Engine restarted while operation was in progress — re-issue to retry'
                    : 'Engine restarted while operation was in progress — re-issue manually',
                completedAt: Date.now() as Timestamp,
            })
        }
    }
}
