/**
 * BackupResults.ts — Instance.lastResult / backupHistory (idea#400 PR B)
 *
 * One result per backup attempt, manual or automatic (Steve, Q5: a manual
 * backupApp writes them too; it never moves the schedule's lastRun). Written in
 * the same store change as the rest of the attempt's outcome, never per tick.
 * backupHistory keeps the newest BACKUP_HISTORY_LENGTH entries, oldest first,
 * trimmed in place (splice) so Automerge keeps the existing list objects.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import {
    BACKUP_HISTORY_LENGTH, BackupMethodUsed, BackupResult, BackupResultCode, InstanceID, Timestamp,
} from './CommonTypes.js'

/** Apply one result to an instance record inside a store change. */
export const applyBackupResult = (inst: { lastResult?: BackupResult | null, backupHistory?: BackupResult[] | null }, r: BackupResult): void => {
    inst.lastResult = { time: r.time, method: r.method, result: r.result }
    if (!Array.isArray(inst.backupHistory)) inst.backupHistory = []
    inst.backupHistory.push({ time: r.time, method: r.method, result: r.result })
    const extra = inst.backupHistory.length - BACKUP_HISTORY_LENGTH
    if (extra > 0) inst.backupHistory.splice(0, extra)
}

/** Record a result for an instance that is in the store. Returns false when it is not. */
export const recordBackupResult = (
    storeHandle: DocHandle<Store>, instanceId: InstanceID | string, method: BackupMethodUsed, result: BackupResultCode, time: number = Date.now(),
): boolean => {
    let found = false
    storeHandle.change(doc => {
        const inst = doc.instanceDB?.[instanceId as InstanceID]
        if (!inst) return
        applyBackupResult(inst, { time: time as Timestamp, method, result })
        found = true
    })
    return found
}

/**
 * Precedence when one attempt has several outcomes (Steve, #347 call 2): the first listed wins.
 * BACKUP_DISK_FULL, APP_DISK_NOT_DOCKED and INTERRUPTED are single-outcome failures and never compete.
 */
export const BACKUP_RESULT_PRECEDENCE: readonly BackupResultCode[] =
    ['FAILED', 'SKIPPED_LOCKED', 'HOOK_FALLBACK', 'HOOK_POST_WARNING', 'HELPER_OUTDATED', 'OK']

/** The highest-precedence code of `codes` (OK when empty). */
export const pickResultCode = (codes: readonly BackupResultCode[]): BackupResultCode => {
    for (const c of BACKUP_RESULT_PRECEDENCE) if (codes.includes(c)) return c
    return codes.find(c => !BACKUP_RESULT_PRECEDENCE.includes(c)) ?? 'OK'
}

/** The code for a backup that completed: the App was briefly stopped, a postHook warning, cleanup skipped on an old helper, else OK. */
export const successResultCode = (o: { hookFallback: boolean, hookWarning: boolean, cleanupHelperOutdated: boolean }): BackupResultCode =>
    pickResultCode([
        ...(o.hookFallback ? ['HOOK_FALLBACK' as const] : []),
        ...(o.hookWarning ? ['HOOK_POST_WARNING' as const] : []),
        ...(o.cleanupHelperOutdated ? ['HELPER_OUTDATED' as const] : []),
        'OK',
    ])

/** The code for a backup that failed, from its error text (leading tokens first). */
export const failureResultCode = (message: string): BackupResultCode => {
    const m = message.trimStart()
    if (m.startsWith('BACKUP_DISK_FULL')) return 'BACKUP_DISK_FULL'
    if (m.startsWith('HELPER_OUTDATED')) return 'HELPER_OUTDATED'
    if (m.startsWith('INTERRUPTED')) return 'INTERRUPTED'
    if (/App Disk for instance .* is not docked/.test(m)) return 'APP_DISK_NOT_DOCKED'
    return 'FAILED'
}

/** Direct commands with a waiting caller (Console, CLI, a Console command forwarded by another Engine): a held lock refuses with BUSY and records nothing. Every other cause records SKIPPED_LOCKED (Steve, #347 call 4). */
export const MANUAL_BACKUP_CAUSES: readonly string[] = ['console-command', 'cli-command', 'cross-engine-cmd']
export const isManualBackupCause = (cause: string): boolean => MANUAL_BACKUP_CAUSES.includes(cause)
