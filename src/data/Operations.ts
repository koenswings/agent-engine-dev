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
