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
import { fs, $ } from 'zx'
import { log } from '../utils/utils.js'
import {
    AppDataRunner, runAppData, helperAtLeast, RESUME_HELPER_MIN, CROSS_RESUME_HELPER_MIN,
    markInFlightArgs, clearInFlightArgs, verifyCopyArgs, parseVerifyCopy,
    verifySendArgs, remoteMarkInFlightSshArgs, remoteClearInFlightSshArgs,
} from '../utils/appDataHelper.js'
import type { Store } from './Store.js'

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

// ── engine#497 stage 3 (a): cross-Engine resume (helper v23) ─────────────────
//
// Koen 2026-11-17, Q1 option A: the SOURCE Engine owns the op and the resume. It marks the
// target id on the peer through the peer's gate (the marker's engineId is the gate's peer id,
// so it names the source Engine), pushes into that folder with its op id, checks the result
// against the source (verify-send, a dry run on both sides) and clears the marker only after
// success. An interruption keeps the partial folder under its marker on the peer; the source
// pushes again into the same folder and id. Nothing is deleted on the peer.

/** Advertised by an Engine whose app-data helper and gate are v23+ (a peer that can be resumed into). */
export const CROSS_ENGINE_RESUME_CAPABILITY = 'crossEngineResume'

/** True when the Engine record counts `crossEngineResume` (same rule as the Console: this boot's list). */
export const engineCanResume = (store: Store | undefined, engineId: string): boolean => {
    const e = (store?.engineDB as any)?.[engineId]
    if (!e || !Array.isArray(e.capabilities) || !e.capabilities.includes(CROSS_ENGINE_RESUME_CAPABILITY)) return false
    return e.capabilitiesBootedAt === undefined || e.capabilitiesBootedAt === e.lastBooted
}

/** The peer side of a resumable cross-Engine copy; tests replace these. */
export const peerInFlight: {
    mark: (host: string, peerEngineId: string, root: string, id: string, opId: string) => Promise<void>
    clear: (host: string, peerEngineId: string, root: string, id: string, opId: string) => Promise<void>
    verify: (srcRoot: string, srcId: string, host: string, peerEngineId: string, dstRoot: string, dstId: string, opId: string) => Promise<{ differences: number, diffs: string[] }>
    helperProblem: (what: string) => Promise<string | null>
} = {
    mark: async (host, peer, root, id, opId) => { await $`${remoteMarkInFlightSshArgs(host, peer, root, id, opId)}` },
    clear: async (host, peer, root, id, opId) => { await $`${remoteClearInFlightSshArgs(host, peer, root, id, opId)}` },
    verify: async (srcRoot, srcId, host, peer, dstRoot, dstId, opId) =>
        parseVerifyCopy(await runAppData(verifySendArgs(srcRoot, srcId, host, peer, dstRoot, dstId, opId))),
    helperProblem: (what) => helperAtLeast(CROSS_RESUME_HELPER_MIN, what),
}

/** Mark instances/<id> on the peer for this op, before its first byte (the peer writes engineId = this Engine). */
export const markPeerInFlight = async (host: string, peerEngineId: string, root: string, id: string, opId: string): Promise<void> => {
    await peerInFlight.mark(host, peerEngineId, root, id, opId)
    log(`in-flight: marked instances/${id} on ${root} of Engine ${peerEngineId} for operation ${opId}`)
}

/** Clear this op's marker on the peer (absent is ok). */
export const clearPeerInFlight = async (host: string, peerEngineId: string, root: string, id: string, opId: string): Promise<void> => {
    await peerInFlight.clear(host, peerEngineId, root, id, opId)
    log(`in-flight: cleared the marker of instances/${id} on ${root} of Engine ${peerEngineId} (operation ${opId})`)
}

/** VERIFY_FAILED unless the folder on the peer matches its source (verify-send). */
export const verifyPeerCopyOrThrow = async (srcRoot: string, srcId: string, host: string, peerEngineId: string, dstRoot: string, dstId: string, opId: string, who: string): Promise<void> => {
    const v = await peerInFlight.verify(srcRoot, srcId, host, peerEngineId, dstRoot, dstId, opId)
    if (v.differences > 0) {
        throw new Error(`VERIFY_FAILED: the copy instances/${dstId} on ${dstRoot} of Engine ${peerEngineId} differs from its source in ${v.differences} item(s)` +
            `${v.diffs.length ? `: ${v.diffs.join('; ')}` : ''}`)
    }
    log(`${who}: the copy instances/${dstId} on ${dstRoot} of Engine ${peerEngineId} matches its source (idea-app-data verify-send)`)
}

/**
 * A failure of a cross-Engine transfer that is an interruption (the peer or the link went away),
 * not a real failure: ssh exit 255 (zx reports `exit code: 255`, rsync `exited with code 255`), rsync's connection codes (10 socket, 12 stream, 30/35 timeouts),
 * a signal, or a connection error text. Such a failure is never counted (RESUME_WAITING).
 */
export const PEER_LINK_FAILURE = /exited with code (10|12|30|35|255)\b|exit code[: ]*(10|12|30|35|255)\b|stopped by SIG|Connection (refused|reset|closed|timed out)|closed by remote host|Broken pipe|No route to host|Network is unreachable|connection unexpectedly closed|not currently reachable|Host is down/i
export const isPeerLinkFailure = (text: string): boolean => PEER_LINK_FAILURE.test(String(text ?? ''))
