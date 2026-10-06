/**
 * automergeTimeoutGuard — process-level guard for the duration walker (r30).
 *
 * Why: with mDNS ON the pool Engines (store 3zoqd) share the LAN with production
 * idea02 (store 4GQmE…). Engine repos use `sharePolicy: () => true`
 * (src/repo.ts:26), so an Engine relays every doc it holds (its own store +
 * CommandLog, and foreign docs it received from idea02) to the walker's
 * RealFleetOps repo clients. In automerge-repo 2.3.0-alpha.0,
 * CollectionSynchronizer.receiveMessage → `void docSynchronizer.beginSync(...)`
 * (dist/synchronizer/CollectionSynchronizer.js:94, also :106 addDocument and :130
 * addPeer); beginSync awaits `handle.whenReady()` without a catch when a peer
 * "has" the doc (dist/synchronizer/DocSynchronizer.js:175-177). whenReady is the
 * ONLY user of withTimeout (dist/DocHandle.js:264), so a doc that never gets
 * ready within 60 s rejects with `TimeoutError: withTimeout: timed out after
 * 60000ms` that nobody awaits → unhandledRejection (cover-all r30 died @9).
 *
 * The TimeoutError carries no doc id (created in a bare setTimeout). We wrap
 * DocHandle.prototype.whenReady to annotate that exact error with the handle's
 * documentId/url/state (rethrown unchanged otherwise), and track, per walker
 * repo, which peer last sent sync traffic for each doc (networkSubsystem
 * 'message' events) to report peer id + via-host.
 *
 * Policy (handleUnhandledRejection):
 *   - not the automerge withTimeout class        → fail loud (exit 2)
 *   - withTimeout on an OWN STORE doc (3zoqd…)    → fail loud (exit 2): real sync bug
 *   - withTimeout, docId known, own CommandLog    → tolerated, class 'own'
 *   - withTimeout, docId known, not own           → tolerated, class 'foreign'
 *   - withTimeout, docId not determinable         → tolerated, class 'unknown', docId null
 * Each tolerated event is logged as JSON `automerge_find_timeout_tolerated`;
 * timeoutSummary() reports counts by class / docId at walk end.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { TimeoutError } from '@automerge/automerge-repo/helpers/withTimeout.js'

/** Production fleet store doc id (Engine src/data/StoreIdentity.ts:18 FLEET_STORE_URL). */
export const PRODUCTION_FLEET_STORE_DOC_ID = '4GQmEZehPDfryGDxkFo9XixbvmAC'

export type TimeoutClass = 'own' | 'foreign' | 'unknown'
export type OwnRole = 'store' | 'commandLog'

export interface TimeoutAnnotation {
    documentId: string
    url: string | null
    state: string | null
    awaitStates: string[]
}

export const ANNOTATION_KEY = '__durationAutomergeTimeout'

const WITH_TIMEOUT_RE = /^withTimeout: timed out after \d+ms$/

interface DocSeen { peerId: string; via: string; lastType: string; lastAt: number }

interface GuardState {
    own: Map<string, { role: OwnRole; via: Set<string> }>
    seen: Map<string, DocSeen>
    peerVia: Map<string, string>
    counts: Map<string, { class: TimeoutClass; role: OwnRole | null; knownAs: string | null; count: number }>
    unknownCount: number
    total: number
}

const state: GuardState = {
    own: new Map(),
    seen: new Map(),
    peerVia: new Map(),
    counts: new Map(),
    unknownCount: 0,
    total: 0,
}

/** Test helper: forget all registrations, tracking and counts. */
export const resetTimeoutGuard = (): void => {
    state.own.clear(); state.seen.clear(); state.peerVia.clear(); state.counts.clear()
    state.unknownCount = 0; state.total = 0
}

/** Strip an `automerge:` prefix so URLs and documentIds compare equal. */
export const toDocumentId = (urlOrId: string): string =>
    urlOrId.trim().replace(/^automerge:/, '').split('#')[0]!

/** Register one of the walker's OWN docs (store doc per host, or a pool CommandLog). */
export const registerOwnDoc = (urlOrId: string, role: OwnRole, via: string): void => {
    const id = toDocumentId(urlOrId)
    if (!id) return
    const cur = state.own.get(id)
    if (cur) {
        if (role === 'store') cur.role = 'store' // store wins over commandLog
        cur.via.add(via)
    } else {
        state.own.set(id, { role, via: new Set([via]) })
    }
}

export const ownDocRole = (urlOrId: string): OwnRole | null =>
    state.own.get(toDocumentId(urlOrId))?.role ?? null

/** Record which peer sent sync traffic for which doc (for peer id / via in events). */
export const noteDocMessage = (documentId: string, peerId: string, via: string, type = 'sync'): void => {
    if (!documentId) return
    state.seen.set(documentId, { peerId, via, lastType: type, lastAt: Date.now() })
}

/** Minimal shape of the repo bits we listen on (Repo.networkSubsystem is an EventEmitter). */
export interface TrackableRepo {
    networkSubsystem: {
        on(event: 'message', fn: (msg: { senderId?: string; documentId?: string; type?: string }) => void): unknown
        on(event: 'peer', fn: (p: { peerId: string }) => void): unknown
    }
}

/** Track a walker repo client: its peers and the docs they send (via = logical host id). */
export const trackRepo = (repo: TrackableRepo, via: string): void => {
    try {
        repo.networkSubsystem.on('peer', ({ peerId }) => { state.peerVia.set(String(peerId), via) })
        repo.networkSubsystem.on('message', msg => {
            if (msg?.documentId && msg.senderId) noteDocMessage(String(msg.documentId), String(msg.senderId), via, String(msg.type ?? 'sync'))
        })
    } catch {
        // tracking is best-effort; classification still works from the annotation
    }
}

/** True only for automerge-repo's own withTimeout TimeoutError (instance or its exact shape+origin). */
export const isAutomergeWithTimeout = (reason: unknown): reason is Error => {
    if (!(reason instanceof Error)) return false
    if (!WITH_TIMEOUT_RE.test(reason.message)) return false
    if (reason instanceof TimeoutError) return true
    // A second automerge-repo copy (different module instance): same class name AND
    // the stack must come from that library's helpers/withTimeout.js.
    return reason.name === 'TimeoutError'
        && typeof reason.stack === 'string'
        && /@automerge[\\/]automerge-repo[\\/]dist[\\/]helpers[\\/]withTimeout\.js/.test(reason.stack)
}

export const getTimeoutAnnotation = (reason: unknown): TimeoutAnnotation | null => {
    const a = (reason as Record<string, unknown> | null)?.[ANNOTATION_KEY]
    return a && typeof a === 'object' && typeof (a as TimeoutAnnotation).documentId === 'string'
        ? a as TimeoutAnnotation : null
}

const PATCHED = Symbol.for('duration.automergeTimeoutGuard.whenReadyPatched')

/**
 * Wrap DocHandle.prototype.whenReady so a withTimeout rejection carries the doc id.
 * Behaviour is otherwise unchanged (same resolution, same error object rethrown).
 */
export const installWhenReadyAnnotation = (proto: object = DocHandle.prototype): void => {
    const p = proto as Record<string | symbol, unknown>
    if (p[PATCHED]) return
    const original = p.whenReady as (this: unknown, ...args: unknown[]) => Promise<void>
    if (typeof original !== 'function') return
    p.whenReady = async function patchedWhenReady(this: DocHandle<unknown>, ...args: unknown[]): Promise<void> {
        try {
            return await original.apply(this, args)
        } catch (e) {
            if (isAutomergeWithTimeout(e) && !getTimeoutAnnotation(e)) {
                let st: string | null = null
                let url: string | null = null
                try { st = String(this.state) } catch { /* ignore */ }
                try { url = String(this.url) } catch { /* ignore */ }
                const ann: TimeoutAnnotation = {
                    documentId: String(this.documentId),
                    url,
                    state: st,
                    awaitStates: Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : [String(args[0] ?? 'ready')],
                }
                try { Object.defineProperty(e, ANNOTATION_KEY, { value: ann, enumerable: false }) } catch { /* frozen */ }
            }
            throw e
        }
    }
    p[PATCHED] = true
}

export interface ClassifiedTimeout {
    tolerate: boolean
    event: Record<string, unknown>
}

/** Classify an automerge withTimeout rejection (caller checked isAutomergeWithTimeout). */
export const classifyTimeout = (reason: Error): ClassifiedTimeout => {
    const ann = getTimeoutAnnotation(reason)
    const docId = ann?.documentId ?? null
    const own = docId ? state.own.get(docId) : undefined
    const seen = docId ? state.seen.get(docId) : undefined
    const cls: TimeoutClass = docId === null ? 'unknown' : own ? 'own' : 'foreign'
    const role: OwnRole | null = own?.role ?? null
    const knownAs = docId === PRODUCTION_FLEET_STORE_DOC_ID && !own ? 'production-fleet-store (idea02)' : null
    const event: Record<string, unknown> = {
        ts: new Date().toISOString(),
        class: cls,
        role,
        docId,
        url: ann?.url ?? null,
        handleState: ann?.state ?? null,
        awaitStates: ann?.awaitStates ?? null,
        peerId: seen?.peerId ?? null,
        via: seen?.via ?? (own ? [...own.via].join(',') : null),
        lastMessageType: seen?.lastType ?? null,
        knownAs,
        message: reason.message,
        ownDocsKnown: {
            store: [...state.own.values()].filter(o => o.role === 'store').length,
            commandLog: [...state.own.values()].filter(o => o.role === 'commandLog').length,
        },
    }
    return { tolerate: !(cls === 'own' && role === 'store'), event }
}

const bump = (c: ClassifiedTimeout): void => {
    state.total++
    const docId = (c.event.docId as string | null) ?? null
    if (docId === null) { state.unknownCount++; return }
    const cur = state.counts.get(docId)
    if (cur) cur.count++
    else state.counts.set(docId, {
        class: c.event.class as TimeoutClass,
        role: (c.event.role as OwnRole | null) ?? null,
        knownAs: (c.event.knownAs as string | null) ?? null,
        count: 1,
    })
}

export const timeoutSummary = (): Record<string, unknown> => {
    const byClass: Record<TimeoutClass, number> = { own: 0, foreign: 0, unknown: state.unknownCount }
    const byDocId: Record<string, unknown> = {}
    for (const [id, v] of state.counts) {
        byClass[v.class] += v.count
        byDocId[id] = { ...v }
    }
    return { event: 'automerge_find_timeout_summary', total: state.total, byClass, byDocId, unknownCount: state.unknownCount }
}

export interface GuardIo {
    log: (line: string) => void
    error: (...args: unknown[]) => void
    exit: (code: number) => void
}

const defaultIo: GuardIo = {
    log: line => console.log(line),
    error: (...a) => console.error(...a),
    exit: code => process.exit(code),
}

/** unhandledRejection policy. Returns 'tolerated' | 'fatal'. */
export const handleUnhandledRejection = (reason: unknown, io: GuardIo = defaultIo): 'tolerated' | 'fatal' => {
    if (isAutomergeWithTimeout(reason)) {
        const c = classifyTimeout(reason)
        bump(c)
        if (c.tolerate) {
            io.log(JSON.stringify({ event: 'automerge_find_timeout_tolerated', count: state.total, ...c.event }))
            return 'tolerated'
        }
        io.log(JSON.stringify({ event: 'automerge_find_timeout_own_store_fatal', ...c.event }))
        io.error(
            `[duration] FATAL: automerge withTimeout on the walker's OWN store doc ${String(c.event.docId)} ` +
            `(via ${String(c.event.via)}, peer ${String(c.event.peerId)}, state ${String(c.event.handleState)}). ` +
            `This is a real store sync failure, not a relayed foreign doc — not tolerated.`,
        )
        io.log(JSON.stringify(timeoutSummary()))
        io.exit(2)
        return 'fatal'
    }
    io.error('[duration] unhandledRejection', reason)
    io.log(JSON.stringify(timeoutSummary()))
    io.exit(2)
    return 'fatal'
}

/** uncaughtException policy: always fail loud with exit 2 (Node's default would exit 1 = "walk failures"). */
export const handleUncaughtException = (err: unknown, io: GuardIo = defaultIo): void => {
    io.error('[duration] uncaughtException', err)
    io.log(JSON.stringify(timeoutSummary()))
    io.exit(2)
}

/** Install the whenReady annotation and both process handlers (idempotent). */
let installed = false
export const installProcessGuards = (io: GuardIo = defaultIo): void => {
    installWhenReadyAnnotation()
    if (installed) return
    installed = true
    process.on('unhandledRejection', reason => { handleUnhandledRejection(reason, io) })
    process.on('uncaughtException', err => { handleUncaughtException(err, io) })
}
