/**
 * TempBackups.ts — Engine.tempBackups and deleteTempBackup (idea#374 / engine#469)
 *
 * The Engine publishes the temporary pre-update backups on its system disk as
 * Engine.tempBackups (whole-list replace) and lets Ops remove one with
 * `deleteTempBackup <instanceId> <stamp>`. Deleting is Koen's explicit exception
 * to quarantine-not-delete, limited to the #469 naming and location
 * (`/.idea-temp-backups/<instanceId>/<stamp>`). The helper verbs are v18
 * (TEMP_BACKUP_HELPER_MIN); this module does not bump the helper.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { localEngineId, type TempBackupPublic } from './Engine.js'
import { log } from '../utils/utils.js'
import { attachTraceResult } from './SummariseDisk.js'
import {
    TEMP_BACKUP_HELPER_MIN, TEMP_BACKUPS_DIR, helperAtLeast, runAppData,
    tempBackupsArgs, parseTempBackups, tempBackupDeleteArgs, tempBackupPath,
} from '../utils/appDataHelper.js'

export type { TempBackupPublic }

export const DELETE_TEMP_BACKUP_USAGE = 'Usage: deleteTempBackup <instanceId> <stamp>'

const IN_FLIGHT_UPDATE = new Set(['Pending', 'Running'])

export type TempBackupErrorCode =
    | 'NOT_FOUND'         // unknown, or nothing at that id/stamp under the temp-backup root
    | 'IN_USE'            // this backup is the one an in-flight updateApp created
    | 'UPDATE_PENDING'    // the instance has updatePending, or a Pending/Running updateApp
    | 'BAD_PATH'          // the path is outside /.idea-temp-backups/, or the tokens are not a #469 name
    | 'HELPER_OUTDATED'   // app-data helper older than TEMP_BACKUP_HELPER_MIN (v18)
    | 'DELETE_FAILED'     // the helper could not remove a backup that passed the checks

export class TempBackupError extends Error {
    constructor(public code: TempBackupErrorCode, text: string) { super(`${code}: ${text}`) }
}

export interface DeleteTempBackupResult {
    instanceId: string
    stamp: string
    path: string
    sizeBytes: number
    complete: boolean
    deleted: true
}

export interface TempBackupDeps {
    helperProblem: () => Promise<string | null>
    list: () => Promise<TempBackupPublic[]>
    remove: (instanceId: string, stamp: string) => Promise<void>
}

const publicEntries = (raw: { instanceId: string, stamp: string, sizeBytes: number, complete: boolean }[]): TempBackupPublic[] =>
    raw.map(e => ({ instanceId: e.instanceId, stamp: e.stamp, path: tempBackupPath(e.instanceId, e.stamp), sizeBytes: e.sizeBytes, complete: e.complete }))

export const defaultTempBackupDeps = (): TempBackupDeps => ({
    helperProblem: () => helperAtLeast(TEMP_BACKUP_HELPER_MIN, 'listing or deleting a temporary pre-update backup on the system disk'),
    list: async () => publicEntries(parseTempBackups(await runAppData(tempBackupsArgs())).backups),
    remove: async (instanceId, stamp) => { await runAppData(tempBackupDeleteArgs(instanceId, stamp)) },
})

/** True when `path` is exactly the #469 folder for these tokens, under the temp-backup root. */
export const isTempBackupLocation = (instanceId: string, stamp: string, path: string): boolean => {
    let expected: string
    try { expected = tempBackupPath(instanceId, stamp) } catch { return false }
    if (path !== expected) return false
    const root = `${TEMP_BACKUPS_DIR}/`
    return expected.startsWith(root) && !expected.slice(root.length).includes('..') && !expected.includes('//')
}

/** Build and check the folder path; throws BAD_PATH when the tokens or path are not a #469 backup. */
export const checkedTempBackupPath = (instanceId: string, stamp: string): string => {
    let path: string
    try { path = tempBackupPath(instanceId, stamp) } catch (e) {
        throw new TempBackupError('BAD_PATH', `'${instanceId}' '${stamp}' is not a temporary pre-update backup name under ${TEMP_BACKUPS_DIR} (${(e as Error).message})`)
    }
    if (!isTempBackupLocation(instanceId, stamp, path)) {
        throw new TempBackupError('BAD_PATH', `path ${path} is not a temporary pre-update backup under ${TEMP_BACKUPS_DIR}`)
    }
    return path
}

const sameEntry = (a: TempBackupPublic, b: TempBackupPublic): boolean =>
    a.instanceId === b.instanceId && a.stamp === b.stamp && a.path === b.path && a.sizeBytes === b.sizeBytes && a.complete === b.complete

const listsEqual = (a: TempBackupPublic[] | undefined, b: TempBackupPublic[]): boolean =>
    !!a && a.length === b.length && a.every((e, i) => sameEntry(e, b[i]))

export const writeTempBackups = (storeHandle: DocHandle<Store>, list: TempBackupPublic[]): void => {
    storeHandle.change(doc => {
        const e = doc.engineDB[localEngineId]
        if (!e) return
        if (!listsEqual(e.tempBackups, list)) e.tempBackups = list.map(x => ({ ...x }))
    })
}

/**
 * Re-read the helper's `temp-backups` list and write Engine.tempBackups. Returns
 * the list, or null when the helper is too old or the list failed (the stored
 * field is left as it was, so a failed boot refresh never publishes an empty
 * list over leftovers).
 */
export const refreshTempBackups = async (
    storeHandle: DocHandle<Store>,
    deps: Partial<TempBackupDeps> = {},
): Promise<TempBackupPublic[] | null> => {
    const d = { ...defaultTempBackupDeps(), ...deps }
    const problem = await d.helperProblem()
    if (problem) {
        log(`tempBackups: not refreshed: ${problem}`)
        return null
    }
    try {
        const list = await d.list()
        writeTempBackups(storeHandle, list)
        return list
    } catch (e) {
        log(`tempBackups: list failed: ${(e as Error).message}`)
        return null
    }
}

const inFlightUpdatesFor = (store: Store, instanceId: string) =>
    Object.values(store.operationDB ?? {}).filter(o =>
        o.kind === 'updateApp'
        && IN_FLIGHT_UPDATE.has(String(o.status))
        && String(o.args?.instanceId ?? '') === instanceId
        && (!o.engineId || String(o.engineId) === String(localEngineId)))

/** Why deleteTempBackup is refused, or the matching list entry. */
export const checkDeleteTempBackup = (
    store: Store,
    instanceId: string,
    stamp: string,
    listed: TempBackupPublic[],
): { ok: true, entry: TempBackupPublic } | { ok: false, error: TempBackupError } => {
    let path: string
    try { path = checkedTempBackupPath(instanceId, stamp) } catch (e) {
        return { ok: false, error: e as TempBackupError }
    }
    const entry = listed.find(b => b.instanceId === instanceId && b.stamp === stamp)
    if (!entry) {
        return { ok: false, error: new TempBackupError('NOT_FOUND', `temporary pre-update backup '${instanceId}' '${stamp}' is not on this Engine`) }
    }
    if (!isTempBackupLocation(instanceId, stamp, entry.path) || entry.path !== path) {
        return { ok: false, error: new TempBackupError('BAD_PATH', `path ${entry.path} is not a temporary pre-update backup under ${TEMP_BACKUPS_DIR}`) }
    }
    const inst = store.instanceDB?.[instanceId as keyof typeof store.instanceDB] as { updatePending?: unknown } | undefined
    const inflight = inFlightUpdatesFor(store, instanceId)
    const used = inflight.find(o => o.args?.tempBackupStamp === stamp)
    if (used) {
        return { ok: false, error: new TempBackupError('IN_USE', `temporary pre-update backup ${path} is in use by an in-flight update of ${instanceId}; wait until the update has finished`) }
    }
    if (inst?.updatePending || inflight.length) {
        return { ok: false, error: new TempBackupError('UPDATE_PENDING', `instance ${instanceId} has an update in progress; wait until the update has finished`) }
    }
    return { ok: true, entry }
}

/**
 * deleteTempBackup <instanceId> <stamp>. Removes only a #469 temp backup on this
 * Engine's system disk, then refreshes Engine.tempBackups. The instance id is the
 * exact folder name (no name fallback), so a leftover of a removed App can still
 * be deleted.
 */
export const deleteTempBackup = async (
    storeHandle: DocHandle<Store>,
    instanceId: string,
    stamp: string,
    deps: Partial<TempBackupDeps> = {},
): Promise<DeleteTempBackupResult> => {
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')
    const id = String(instanceId ?? '').trim()
    const st = String(stamp ?? '').trim()
    if (!id || !st) throw new TempBackupError('NOT_FOUND', `${DELETE_TEMP_BACKUP_USAGE}`)
    const path = checkedTempBackupPath(id, st)
    const d = { ...defaultTempBackupDeps(), ...deps }
    const problem = await d.helperProblem()
    if (problem) throw new TempBackupError('HELPER_OUTDATED', problem)
    let listed: TempBackupPublic[]
    try { listed = await d.list() } catch (e) {
        throw new TempBackupError('DELETE_FAILED', `could not list temporary pre-update backups: ${(e as Error).message}`)
    }
    const check = checkDeleteTempBackup(storeHandle.doc(), id, st, listed)
    if (!check.ok) throw check.error
    try {
        await d.remove(id, st)
    } catch (e) {
        await refreshTempBackups(storeHandle, d).catch(err => log(`tempBackups: refresh after a failed delete: ${(err as Error).message}`))
        throw new TempBackupError('DELETE_FAILED', `removing the temporary pre-update backup ${path} failed: ${(e as Error).message}`)
    }
    await refreshTempBackups(storeHandle, d).catch(err => log(`tempBackups: refresh after delete failed: ${(err as Error).message}`))
    const result: DeleteTempBackupResult = {
        instanceId: id, stamp: st, path, sizeBytes: check.entry.sizeBytes, complete: check.entry.complete, deleted: true,
    }
    attachTraceResult(result)
    log(`deleteTempBackup: removed ${path} (${result.sizeBytes} bytes)`)
    return result
}
