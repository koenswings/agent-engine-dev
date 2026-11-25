/**
 * CommandSource.ts — who asked for a command (engine#582).
 *
 * Recorded on every command trace (CommandTrace.source) and in the local audit
 * log, so the command history shows where each command came from.
 *
 *   operator — a signed-in operator through the Engine HTTP API
 *   peer     — another Engine, with a grant this Engine issued
 *   cli      — the local command line on this Pi
 *   engine   — this Engine's own scheduling (startup actions, self-dispatch)
 *   queue    — an entry found in this Engine's store command queue whose writer
 *              is not known (the queue path before signed entries)
 */

export type CommandSourceKind = 'operator' | 'peer' | 'cli' | 'engine' | 'queue'

export interface CommandSource {
    kind: CommandSourceKind
    /** Operator username (kind 'operator'). */
    operator?: string
    /** First 8 hex characters of the session id hash (kind 'operator'). */
    session?: string
    /** Remote address the request came from, when it came over HTTP. */
    remoteAddr?: string
    /** Engine whose relay forwarded the request. */
    viaEngineId?: string
    /** Engine that sent the request (kind 'peer'). */
    peerEngineId?: string
}

const KINDS: readonly CommandSourceKind[] = ['operator', 'peer', 'cli', 'engine', 'queue']

/**
 * A copy with only the known, defined, string fields: Automerge refuses
 * `undefined` values, and the trace must never carry anything else.
 */
export const cleanCommandSource = (s: CommandSource | null | undefined): CommandSource | undefined => {
    if (!s || !KINDS.includes(s.kind)) return undefined
    const out: CommandSource = { kind: s.kind }
    for (const k of ['operator', 'session', 'remoteAddr', 'viaEngineId', 'peerEngineId'] as const) {
        const v = s[k]
        if (typeof v === 'string' && v !== '') out[k] = v.slice(0, 200)
    }
    return out
}

/** Sources that come from outside this Pi (not the local CLI or the Engine itself). */
export const isRemoteSource = (s: CommandSource | null | undefined): boolean =>
    !!s && (s.kind === 'operator' || s.kind === 'peer' || s.kind === 'queue')
