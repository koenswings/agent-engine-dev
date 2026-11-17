/**
 * InFlight.ts — the in-flight marker of a resumable local copy/move (engine#497, helper v20).
 *
 * Koen's rule: an interrupted copy RESUMES inside its original operation, into the same
 * folder and id; a partial target is kept and marked, never deleted. The marker is the
 * sibling file instances/<id>.idea-op-in-flight (never inside the instance folder). The
 * app-data helper writes it as root ("opId=…", "engineId=…") before the first byte and the
 * op removes it only after success. While it exists, no Engine registers or starts that
 * instance folder; only the owning op (same opId) continues into it.
 */
import { fs } from 'zx'
import { log } from '../utils/utils.js'
import {
    AppDataRunner, runAppData, helperAtLeast, RESUME_HELPER_MIN,
    markInFlightArgs, clearInFlightArgs, verifyCopyArgs, parseVerifyCopy,
} from '../utils/appDataHelper.js'

export const IN_FLIGHT_SUFFIX = '.idea-op-in-flight'

/** A marker file name in instances/ (not an instance folder; dock scans skip it). */
export const isInFlightMarkerName = (name: string): boolean => name.endsWith(IN_FLIGHT_SUFFIX)

/** The marker of instances/<id> under a disk mount root ('' for the system disk). */
export const inFlightMarkerPath = (mountRoot: string, instanceId: string): string =>
    `${mountRoot}/instances/${instanceId}${IN_FLIGHT_SUFFIX}`

export interface InFlightMarker {
    /** the operation that owns the folder ('' when the marker cannot be read) */
    opId: string
    engineId: string | null
}

/** Parse the marker body: opId=… and engineId=… lines. */
export const parseInFlightMarker = (text: string): InFlightMarker => {
    const field = (k: string) => text.split('\n').map(l => l.trim()).find(l => l.startsWith(`${k}=`))?.slice(k.length + 1) ?? null
    return { opId: field('opId') ?? '', engineId: field('engineId') }
}

/** The marker of instances/<id>, or null when there is none. An unreadable marker still blocks. */
export const readInFlightMarker = async (mountRoot: string, instanceId: string): Promise<InFlightMarker | null> => {
    const p = inFlightMarkerPath(mountRoot, instanceId)
    let exists = false
    try { exists = !!(await fs.lstat(p)) } catch { exists = false }
    if (!exists) return null
    try {
        return parseInFlightMarker(String(await fs.readFile(p, 'utf-8')))
    } catch {
        return { opId: '', engineId: null }
    }
}

/**
 * Why instances/<id> must not be registered or started now, or null. Allowed when there
 * is no marker, or when `ownOpId` is the operation that owns it.
 */
export const inFlightRefusal = async (mountRoot: string, instanceId: string, ownOpId?: string): Promise<string | null> => {
    const m = await readInFlightMarker(mountRoot, instanceId)
    if (!m) return null
    if (ownOpId && m.opId === ownOpId) return null
    return `IN_FLIGHT: instances/${instanceId} is being copied by operation ${m.opId || '(unreadable marker)'}` +
        `${m.engineId ? ` of Engine ${m.engineId}` : ''}; only that operation resumes it (engine#497)`
}

/** Helper runs for the marker; tests replace these. */
export const inFlightHelper: {
    run: AppDataRunner
    atLeast: (min: number, what: string) => Promise<string | null>
} = {
    run: (args) => runAppData(args),
    atLeast: (min, what) => helperAtLeast(min, what),
}

/** null when the helper can resume copies (v20); else the HELPER_OUTDATED text. */
export const resumeHelperProblem = (what: string): Promise<string | null> => inFlightHelper.atLeast(RESUME_HELPER_MIN, what)

/** Write instances/<id>.idea-op-in-flight for this op (root, through the helper). Same op again is ok. */
export const markInFlight = async (root: string, instanceId: string, opId: string, engineId: string): Promise<void> => {
    await inFlightHelper.run(markInFlightArgs(root, instanceId, opId, engineId))
    log(`in-flight: marked instances/${instanceId} on ${root} for operation ${opId}`)
}

/** Remove the marker, only when it names this op (absent is ok). */
export const clearInFlight = async (root: string, instanceId: string, opId: string): Promise<void> => {
    await inFlightHelper.run(clearInFlightArgs(root, instanceId, opId))
    log(`in-flight: cleared the marker of instances/${instanceId} on ${root} (operation ${opId})`)
}

/** Compare the copy with its source (helper verify-copy, a read-only rsync dry run). */
export const verifyInstanceCopy = async (srcRoot: string, srcId: string, dstRoot: string, dstId: string): Promise<{ differences: number, diffs: string[] }> =>
    parseVerifyCopy(await inFlightHelper.run(verifyCopyArgs(srcRoot, srcId, dstRoot, dstId)))
