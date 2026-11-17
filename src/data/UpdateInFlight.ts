/**
 * UpdateInFlight.ts — the update-in-flight marker of an updateApp that runs x-app.update steps
 * (engine#456 Q4, Steve 2026-11-17).
 *
 * Between Swap and a passed verify the instance folder holds the NEW compose on a tree that may
 * not be prepared yet. If the App Disk is docked on another Engine after a crash in that window,
 * a plain start would run the new image's entrypoint (e.g. `occ upgrade`) on an unprepared tree.
 * So updateApp writes instances/<id>/.idea-update-in-flight ("opId=…", "engineId=…") before
 * Swap, and removes it at the point of no return (verify passed). While it exists, no start of
 * that instance runs except the one of the owning operation; the owning Engine's boot recovery
 * rolls the update back (restore-snapshot moves the marker aside with the replaced files).
 *
 * Written only for a bundle that declares x-app.update: an App without it keeps today's path.
 * The marker lives inside the instance folder (written as the Engine user, like the Swap) and
 * starts with `.idea-`, so copyBundle never copies one from a bundle.
 */
import { fs, path } from 'zx'
import { log } from '../utils/utils.js'
import { parseInFlightMarker } from './InFlight.js'

export const UPDATE_IN_FLIGHT_FILE = '.idea-update-in-flight'

export const updateInFlightPath = (instanceDir: string): string => path.join(instanceDir, UPDATE_IN_FLIGHT_FILE)

/** The marker of an instance folder, or null when there is none. An unreadable marker still blocks. */
export const readUpdateInFlight = async (instanceDir: string): Promise<{ opId: string, engineId: string | null } | null> => {
    const p = updateInFlightPath(instanceDir)
    const st = await fs.lstat(p).catch(() => null)
    if (!st) return null
    try { return parseInFlightMarker(String(await fs.readFile(p, 'utf-8'))) } catch { return { opId: '', engineId: null } }
}

/**
 * Why the instance in `instanceDir` must not be started now, or null. Allowed when there is no
 * marker, or when `ownOpId` is the update operation that wrote it.
 */
export const updateInFlightRefusal = async (instanceDir: string, instanceId: string, ownOpId?: string): Promise<string | null> => {
    const m = await readUpdateInFlight(instanceDir)
    if (!m) return null
    if (ownOpId && m.opId === ownOpId) return null
    return `UPDATE_IN_FLIGHT: instances/${instanceId} is in the middle of an update (operation ${m.opId || '(unreadable marker)'}` +
        `${m.engineId ? ` of Engine ${m.engineId}` : ''}); it is not started until that Engine recovers it (engine#456)`
}

/** Write the marker for this operation (atomic: same-folder temp file, then rename). */
export const writeUpdateInFlight = async (instanceDir: string, opId: string, engineId: string): Promise<void> => {
    const p = updateInFlightPath(instanceDir)
    const tmp = `${p}.tmp-${process.pid}`
    await fs.writeFile(tmp, `opId=${opId}\nengineId=${engineId}\n`)
    await fs.rename(tmp, p)
    log(`updateApp: wrote ${p} (operation ${opId})`)
}

/**
 * Remove the marker when it names this operation (absent is fine). A marker of another
 * operation is left alone. This is the Engine's own control file, not App data.
 */
export const clearUpdateInFlight = async (instanceDir: string, opId: string): Promise<boolean> => {
    const m = await readUpdateInFlight(instanceDir)
    if (!m) return false
    if (m.opId !== opId) {
        log(`updateApp: ${updateInFlightPath(instanceDir)} names operation ${m.opId || '(unreadable)'}, not ${opId}; left in place`)
        return false
    }
    await fs.unlink(updateInFlightPath(instanceDir))
    log(`updateApp: removed ${updateInFlightPath(instanceDir)} (operation ${opId})`)
    return true
}
