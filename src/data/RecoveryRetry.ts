/**
 * Boot-recovery retry handlers (engine#497).
 *
 * recoverInterruptedOperations (Operations.ts) retries an interrupted copyApp, moveApp
 * or backupApp. Each handler re-runs the work inside the interrupted Operation itself
 * (copyApp/moveApp recoveredOpId, backupInstance existingOpId), so that op ends Done or
 * Failed and is never left Pending to be retried again on the next boot. A handler
 * rejects on failure. recoverInterruptedOperations runs it inside the recovery trace,
 * so backupInstance rethrows its error instead of closing its own trace and resolving.
 * Kept out of start.ts so the real handlers can be tested.
 */
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import type { OperationKind } from './CommonTypes.js'
import type { RetryHandler } from './Operations.js'
import { copyApp, moveApp } from './CopyMoveApp.js'
import { backupInstance } from '../monitors/backupMonitor.js'

export const bootRetryHandlers: Partial<Record<OperationKind, RetryHandler>> = {
    copyApp: async (args, handle: DocHandle<Store>, opId) => {
        await copyApp(handle, args.instanceId as any, args.sourceDiskId as any, args.targetDiskId as any, 'crash-recovery', { recoveredOpId: opId })
    },
    moveApp: async (args, handle: DocHandle<Store>, opId) => {
        await moveApp(handle, args.instanceId as any, args.sourceDiskId as any, args.targetDiskId as any, 'crash-recovery', { recoveredOpId: opId })
    },
    backupApp: async (args, handle: DocHandle<Store>, opId) => {
        const backupDisk = handle.doc()?.diskDB?.[args.backupDiskId as any]
        if (!backupDisk) throw new Error(`Backup Disk ${args.backupDiskId} is not known to this Engine; the interrupted backup is not retried`)
        await backupInstance(handle, args.instanceId as any, backupDisk as any, opId, 'crash-recovery')
    },
    // restoreApp: strategy 'fail', no retry handler
}
