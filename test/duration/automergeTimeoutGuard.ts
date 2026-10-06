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
 *
 * r32 refinement (per-engine own-store check): the walker opens ONE Repo per pool
 * Engine (RealFleetOps.connect), so a withTimeout on 3zoqd belongs to exactly one
 * Engine's Repo. The whenReady annotation now records which tracked Repo owns the
 * timed-out handle (`ownerVia`). An OWN STORE timeout is then split:
 *   - owning Engine's WS is open (or was open when RealFleetOps gave up on it),
 *     or no other Engine currently serves the store      → own_store_fatal, exit 2
 *   - owning Engine's WS never completed a handshake / is closed, and at least one
 *     other Engine serves the store                       → engine_unreachable, exit 4
 *     ("engine idea04 unreachable for Ns (WS ws://…:4321, last error …)") —
 *     NOT counted as a sync timeout.
 * Per-Engine WS facts (attempts, handshakes, closes, last error, last store-ready)
 * are recorded via trackRepo / noteEngineWs / noteEngineStoreReady and included in
 * the summary so "WS down" is never ambiguous again.
 *
 * r32 connection model (RealFleetOps keeps ONE Repo per Engine and closes it before
 * any retry): a timeout on a handle of a Repo the walker already ABANDONED (closed
 * after a failed attempt, or replaced after reboot) is tolerated and counted as
 * `abandonedAttempts` — RealFleetOps already judged that attempt (unreachable →
 * probe/preflight result; WS-up stall → reportOwnStoreStall exit 2). The own-store
 * FATAL for a real stall is raised by RealFleetOps itself after the per-host doc wait
 * (reportOwnStoreStall), not by the library's 60 s timer.
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
    /** Logical Engine id of the walker Repo that owns the handle (null if not a tracked Repo). */
    ownerVia?: string | null
    /** Index of that Repo in the guard's tracked-repo list (null if not a tracked Repo). */
    ownerIndex?: number | null
}

export const ANNOTATION_KEY = '__durationAutomergeTimeout'

const WITH_TIMEOUT_RE = /^withTimeout: timed out after \d+ms$/

/** Exit code for "one pool Engine unreachable" (distinct from 1 = walk failures, 2 = fatal). */
export const EXIT_ENGINE_UNREACHABLE = 4

interface DocSeen { peerId: string; via: string; lastType: string; lastAt: number }

/** Per-Engine WS facts, aggregated over every Repo the walker opened to that Engine. */
export interface EngineLink {
    via: string
    url: string | null
    /** Repos opened to this Engine (RealFleetOps "Connecting …" lines). */
    attempts: number
    /** automerge-repo handshakes completed (networkSubsystem 'peer'). */
    opens: number
    /** handshakes lost (networkSubsystem 'peer-disconnected'). */
    closes: number
    /** raw socket errors seen (ECONNREFUSED, EHOSTUNREACH, …). */
    socketErrors: number
    firstAttemptAt: number | null
    lastOpenAt: number | null
    lastCloseAt: number | null
    lastStoreReadyAt: number | null
    lastError: string | null
}

interface TrackedRepoEntry {
    repo: TrackableRepo
    via: string
    openPeers: Set<string>
    abandoned: boolean
    /** RealFleetOps gave up on this Repo while its WS handshake was still open (sync stall). */
    openWhenAbandoned: boolean
    abandonReason: string | null
    storeReady: boolean
}

interface GuardState {
    own: Map<string, { role: OwnRole; via: Set<string> }>
    seen: Map<string, DocSeen>
    peerVia: Map<string, string>
    counts: Map<string, { class: TimeoutClass; role: OwnRole | null; knownAs: string | null; count: number }>
    unknownCount: number
    total: number
    engines: Map<string, EngineLink>
    repos: TrackedRepoEntry[]
    engineUnreachable: number
    abandonedAttempts: number
}

const state: GuardState = {
    own: new Map(),
    seen: new Map(),
    peerVia: new Map(),
    counts: new Map(),
    unknownCount: 0,
    total: 0,
    engines: new Map(),
    repos: [],
    engineUnreachable: 0,
    abandonedAttempts: 0,
}

/** Test helper: forget all registrations, tracking and counts. */
export const resetTimeoutGuard = (): void => {
    state.own.clear(); state.seen.clear(); state.peerVia.clear(); state.counts.clear()
    state.unknownCount = 0; state.total = 0
    state.engines.clear(); state.repos.length = 0; state.engineUnreachable = 0; state.abandonedAttempts = 0
}

const linkFor = (via: string, url?: string | null): EngineLink => {
    let l = state.engines.get(via)
    if (!l) {
        l = {
            via, url: url ?? null, attempts: 0, opens: 0, closes: 0, socketErrors: 0,
            firstAttemptAt: null, lastOpenAt: null, lastCloseAt: null, lastStoreReadyAt: null, lastError: null,
        }
        state.engines.set(via, l)
    }
    if (url) l.url = url
    return l
}

/** Number of currently open handshakes to this Engine over the walker's live (non-abandoned) Repos. */
export const engineOpenNow = (via: string): number =>
    state.repos.filter(r => r.via === via && !r.abandoned).reduce((n, r) => n + r.openPeers.size, 0)

/** Engines (other than `except`) whose live Repo has an open WS AND a ready store doc. */
export const enginesServingStore = (except?: string): string[] =>
    [...new Set(state.repos
        .filter(r => r.via !== except && !r.abandoned && r.storeReady && r.openPeers.size > 0)
        .map(r => r.via))].sort()

export const getEngineLink = (via: string): EngineLink | null => {
    const l = state.engines.get(via)
    return l ? { ...l } : null
}

/** Raw WS / connect facts from RealFleetOps (socket error text, handshake timeout, …). */
export const noteEngineWs = (via: string, kind: 'socket-error' | 'error', detail: string, url?: string): void => {
    const l = linkFor(via, url)
    if (kind === 'socket-error') l.socketErrors++
    l.lastError = detail
}

/** RealFleetOps: the store doc became ready via this Engine's Repo. */
export const noteEngineStoreReady = (repo: TrackableRepo, via: string): void => {
    linkFor(via).lastStoreReadyAt = Date.now()
    const e = state.repos.find(r => r.repo === repo)
    if (e) e.storeReady = true
}

/**
 * RealFleetOps gave up on this Repo (connect failed; it is being shut down). Timeouts
 * from its handles are judged by whether its WS was open at that moment.
 */
export const abandonRepo = (repo: TrackableRepo, reason: string): void => {
    const e = state.repos.find(r => r.repo === repo)
    if (!e) return
    if (e.abandoned) return
    e.openWhenAbandoned = e.openPeers.size > 0
    e.abandoned = true
    e.abandonReason = reason
    e.storeReady = false
    if (reason) linkFor(e.via).lastError = reason
}

const secondsSince = (t: number | null): number | null => t === null ? null : Math.round((Date.now() - t) / 1000)

/** One-line description of an Engine's WS state (used in probe details and fatal messages). */
export const describeEngineLink = (via: string): string => {
    const l = state.engines.get(via)
    if (!l) return `${via}: no WS attempts recorded`
    const openNow = engineOpenNow(via)
    const since = l.lastStoreReadyAt ?? l.firstAttemptAt
    return `WS ${l.url ?? '?'}: open now ${openNow}, attempts ${l.attempts}, handshakes ${l.opens}, closes ${l.closes}, ` +
        `socket errors ${l.socketErrors}, store ready ${l.lastStoreReadyAt ? `${secondsSince(l.lastStoreReadyAt)}s ago` : 'never'}, ` +
        `no store for ${secondsSince(since) ?? '?'}s, last error ${l.lastError ?? 'none'}`
}

/** "engine idea04 unreachable for 85s (WS ws://…:4321, last error …)" */
export const formatEngineUnreachable = (via: string): string => {
    const l = state.engines.get(via)
    const since = l ? (l.lastStoreReadyAt ?? l.lastCloseAt ?? l.firstAttemptAt) : null
    return `engine ${via} unreachable for ${secondsSince(since) ?? '?'}s ` +
        `(WS ${l?.url ?? '?'}, last error ${l?.lastError ?? 'none'}; ` +
        `attempts ${l?.attempts ?? 0}, handshakes ${l?.opens ?? 0}, closes ${l?.closes ?? 0}, socket errors ${l?.socketErrors ?? 0})`
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
        on(event: 'peer-disconnected', fn: (p: { peerId: string }) => void): unknown
    }
    /** Repo.handles (documentId → DocHandle); used to find which Repo owns a timed-out handle. */
    handles?: Record<string, unknown>
}

/** Track a walker repo client: its peers, handshakes/closes and the docs they send (via = logical host id). */
export const trackRepo = (repo: TrackableRepo, via: string, url?: string): void => {
    const link = linkFor(via, url)
    link.attempts++
    link.firstAttemptAt ??= Date.now()
    const entry: TrackedRepoEntry = {
        repo, via, openPeers: new Set(), abandoned: false, openWhenAbandoned: false, abandonReason: null, storeReady: false,
    }
    state.repos.push(entry)
    try {
        repo.networkSubsystem.on('peer', ({ peerId }) => {
            state.peerVia.set(String(peerId), via)
            entry.openPeers.add(String(peerId))
            link.opens++
            link.lastOpenAt = Date.now()
        })
        repo.networkSubsystem.on('peer-disconnected', ({ peerId }) => {
            if (entry.openPeers.delete(String(peerId))) {
                link.closes++
                link.lastCloseAt = Date.now()
            }
        })
        repo.networkSubsystem.on('message', msg => {
            if (msg?.documentId && msg.senderId) noteDocMessage(String(msg.documentId), String(msg.senderId), via, String(msg.type ?? 'sync'))
        })
    } catch {
        // tracking is best-effort; classification still works from the annotation
    }
}

/** The tracked Repo whose handle cache holds exactly this handle (null for stand-alone handles). */
const ownerEntryOf = (handle: unknown, documentId: string): TrackedRepoEntry | null => {
    for (const e of state.repos) {
        try {
            if (e.repo.handles?.[documentId] === handle) return e
        } catch { /* ignore */ }
    }
    return null
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
                const documentId = String(this.documentId)
                const owner = ownerEntryOf(this, documentId)
                const ann: TimeoutAnnotation = {
                    documentId,
                    url,
                    state: st,
                    awaitStates: Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : [String(args[0] ?? 'ready')],
                    ownerVia: owner?.via ?? null,
                    ownerIndex: owner ? state.repos.indexOf(owner) : null,
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
    /** For non-tolerated own-store timeouts: a real stall (exit 2) or one Engine unreachable (exit 4). */
    verdict?: 'own_store_fatal' | 'engine_unreachable' | 'abandoned_attempt'
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
    // Which Engine's Repo owns the timed-out handle: exact owner if known, else last sender.
    const ownerVia = ann?.ownerVia ?? null
    const ownerEntry = typeof ann?.ownerIndex === 'number' ? state.repos[ann.ownerIndex] ?? null : null
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
    if (!(cls === 'own' && role === 'store')) return { tolerate: true, event }

    if (ownerEntry?.abandoned) {
        // The walker already closed this Repo and judged the attempt; not a sync timeout.
        event.engine = ownerEntry.via
        event.abandoned = true
        event.abandonReason = ownerEntry.abandonReason
        return { tolerate: true, verdict: 'abandoned_attempt', event }
    }

    // OWN STORE: per-Engine verdict. Default (no WS facts for the owner) stays fatal.
    const engineVia = ownerVia ?? (seen?.via ?? null)
    const link = engineVia ? state.engines.get(engineVia) : undefined
    const ownerWsOpen = ownerEntry
        ? (ownerEntry.abandoned ? ownerEntry.openWhenAbandoned : ownerEntry.openPeers.size > 0)
        : (engineVia ? engineOpenNow(engineVia) > 0 : true)
    const servedBy = enginesServingStore(engineVia ?? undefined)
    event.engine = engineVia
    event.ownerWsOpen = ownerWsOpen
    event.storeServedBy = servedBy
    if (engineVia) event.engineLink = describeEngineLink(engineVia)
    const unreachable = !!link && !ownerWsOpen && servedBy.length > 0
    return { tolerate: false, verdict: unreachable ? 'engine_unreachable' : 'own_store_fatal', event }
}

const bump = (c: ClassifiedTimeout): void => {
    if (c.verdict === 'engine_unreachable') { state.engineUnreachable++; return } // not a sync timeout
    if (c.verdict === 'abandoned_attempt') { state.abandonedAttempts++; return } // already judged by RealFleetOps
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
    const engines: Record<string, unknown> = {}
    for (const [via, l] of state.engines) engines[via] = { ...l, openNow: engineOpenNow(via) }
    return {
        event: 'automerge_find_timeout_summary', total: state.total, byClass, byDocId, unknownCount: state.unknownCount,
        engineUnreachable: state.engineUnreachable, abandonedAttempts: state.abandonedAttempts, engines,
    }
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

/** IO used by reportOwnStoreStall (tests swap it; process guards use defaultIo). */
let activeIo: GuardIo = defaultIo
export const setGuardIo = (io: GuardIo | null): void => { activeIo = io ?? defaultIo }

/**
 * r32: the REAL own-store stall verdict, raised by RealFleetOps after the per-host doc
 * wait: the Engine's WS is up (handshake open) but the store doc never became ready.
 * Logs `automerge_find_timeout_own_store_fatal` (reason sync_stall) and exits 2.
 */
export const reportOwnStoreStall = (via: string, docId: string, detail: string, io: GuardIo = activeIo): void => {
    const event = {
        event: 'automerge_find_timeout_own_store_fatal',
        reason: 'sync_stall',
        ts: new Date().toISOString(),
        class: 'own',
        role: 'store',
        docId,
        engine: via,
        detail,
        engineLink: describeEngineLink(via),
        storeServedBy: enginesServingStore(via),
    }
    io.log(JSON.stringify(event))
    io.error(
        `[duration] FATAL: own store ${docId} stalled on engine ${via}: ${detail}. ` +
        `The WS is up but the doc never became ready — a real store sync failure, not tolerated.`,
    )
    io.log(JSON.stringify(timeoutSummary()))
    io.exit(2)
}

/**
 * r32: "engine X unreachable" event (distinct class from sync timeouts). Logged by
 * RealFleetOps whenever an attempt to an Engine fails without a usable WS. Not fatal by
 * itself: preflight exits 4, probes fail the step, the CLI maps that to exit 4.
 */
export const reportEngineUnreachable = (via: string, io: GuardIo = activeIo): string => {
    const message = formatEngineUnreachable(via)
    state.engineUnreachable++
    io.log(JSON.stringify({ event: 'engine_unreachable', class: 'engine_unreachable', engine: via, message, link: getEngineLink(via) }))
    return message
}

/** unhandledRejection policy. Returns 'tolerated' | 'fatal'. */
export const handleUnhandledRejection = (reason: unknown, io: GuardIo = defaultIo): 'tolerated' | 'fatal' => {
    if (isAutomergeWithTimeout(reason)) {
        const c = classifyTimeout(reason)
        bump(c)
        if (c.tolerate) {
            io.log(JSON.stringify({
                event: 'automerge_find_timeout_tolerated',
                count: c.verdict === 'abandoned_attempt' ? state.abandonedAttempts : state.total,
                ...(c.verdict ? { verdict: c.verdict } : {}),
                ...c.event,
            }))
            return 'tolerated'
        }
        if (c.verdict === 'engine_unreachable') {
            const via = String(c.event.engine)
            const msg = formatEngineUnreachable(via)
            io.log(JSON.stringify({ event: 'engine_unreachable_fatal', message: msg, link: getEngineLink(via), ...c.event }))
            io.error(
                `[duration] FATAL: ${msg}. Store ${String(c.event.docId)} is served by ` +
                `${(c.event.storeServedBy as string[]).join(', ')}; this is an unreachable Engine, not a store sync timeout.`,
            )
            io.log(JSON.stringify(timeoutSummary()))
            io.exit(EXIT_ENGINE_UNREACHABLE)
            return 'fatal'
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

/** "engine idea04 unreachable for 85s (WS ws://…, last error …)" — see formatEngineUnreachable. */
export const ENGINE_UNREACHABLE_RE = /engine \S+ unreachable for \S+s \(WS /

/**
 * Exit codes: 0 ok; 1 walk failures; 4 the walk failed because a pool Engine was
 * unreachable (last failing step / abort reason carries the unreachable message) —
 * distinct from 2 (own-store sync stall / harness crash).
 */
export const walkExitCode = (result: {
    failures: number; aborted: boolean; abortReason?: string
    logs?: Array<{ ok: boolean; message?: string; probes?: { ok: boolean; detail?: string }[]; invariants?: { ok: boolean; detail?: string }[] }>
}): number => {
    if (!(result.failures > 0 || result.aborted)) return 0
    const lastFail = [...(result.logs ?? [])].reverse().find(l => !l.ok)
    const evidence = [
        result.abortReason ?? '',
        lastFail?.message ?? '',
        ...(lastFail?.probes ?? []).filter(p => !p.ok).map(p => p.detail ?? ''),
        ...(lastFail?.invariants ?? []).filter(i => !i.ok).map(i => i.detail ?? ''),
    ].join('\n')
    return ENGINE_UNREACHABLE_RE.test(evidence) ? EXIT_ENGINE_UNREACHABLE : 1
}
