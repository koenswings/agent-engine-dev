/**
 * r70 (r69 FAIL@43 copy_app): the walker froze (box_pause ~1131 s, 04:46:07Z→05:05:09Z) right as the Engine
 * restarted the copy source (container StartedAt 04:46:07.297Z; Engine log: create → 'Pauzed' (Instance.ts:1272,
 * the transient between `compose create` and `compose up`) → Running after the 10 s port check) and finished
 * copyApp at 04:46:20Z. On wake only idea04 was force-refreshed; idea01's frozen view still said 'Pauzed', so the
 * post-use check failed. The live store and docker show it Running.
 *
 * After a copyApp/moveApp Done: force-refresh EVERY pool engine view, then wait (bounded) until the sources and
 * the instances the op created are Running, judged by the view of the engine their disk is docked to. Re-refresh
 * all views every refreshEveryMs while waiting. On timeout: fail with a per-engine field dump.
 */
import type { SemanticStoreView } from './types.js'

export interface PostOpSettleIo {
    engines: string[]
    readStore: (e: string) => Promise<SemanticStoreView>
    /** Force reconnect + re-read of one engine's view (counted in RECONNECTS.md). Absent on fake ops. */
    refresh?: (e: string, why: string) => Promise<unknown>
    sleep: (ms: number) => Promise<void>
    now: () => number
    log: (line: string) => void
}
export interface PostOpSettleResult { ok: boolean; note: string; waitedMs: number; targets: string[]; dump?: string }

export const postOpSettleBudgetMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const n = Number(env.DURATION_POST_OP_SETTLE_MS)
    return Number.isFinite(n) && n > 0 ? n : 300_000
}

/** Instance ids present in any pool view (baseline before Confirm, to find the op's new instances). */
export const poolInstanceIds = async (io: Pick<PostOpSettleIo, 'engines' | 'readStore'>): Promise<Set<string>> => {
    const ids = new Set<string>()
    for (const e of io.engines) { try { for (const id of Object.keys((await io.readStore(e)).instanceDB)) ids.add(id) } catch { /* next */ } }
    return ids
}

type Seen = { id: string; status: string | null; engine: string | null; perEngine: Record<string, string> }

/**
 * r86h (r86g @102: the post-op refresh sat 305 s on idea03 and 550 s on idea04 — 878 s for one step):
 * every per-Pi refresh and store read is bounded. On a timeout the Pi is reconnected (refresh) once more;
 * still not answering → the settle fails loud naming the Pi. Never an unbounded wait on one Pi.
 */
export const postOpPiTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const n = Number(env.DURATION_POST_OP_PI_TIMEOUT_MS)
    return Number.isFinite(n) && n > 0 ? n : 150_000
}
const TIMED_OUT = Symbol('timeout')
const within = async <T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
    let t: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([p, new Promise<typeof TIMED_OUT>(r => { t = setTimeout(() => r(TIMED_OUT), ms) })])
    } finally { if (t) clearTimeout(t) }
}
class PiNotAnswering extends Error {}

export const settleAfterLongOp = async (
    action: string, sources: string[], baseline: Set<string> | null, io: PostOpSettleIo,
    budgetMs = postOpSettleBudgetMs(), pollMs = 3_000, refreshEveryMs = 60_000, piTimeoutMs = postOpPiTimeoutMs(),
): Promise<PostOpSettleResult> => {
    const t0 = io.now()
    /** Bounded refresh: one retry on timeout; returns false if the Pi still did not answer. */
    const refreshOne = async (e: string, why: string): Promise<boolean> => {
        if (!io.refresh) return true
        for (let attempt = 1; attempt <= 2; attempt++) {
            const r = await within(io.refresh(e, attempt === 1 ? why : `${why} (retry after ${piTimeoutMs}ms timeout)`).catch(() => null), piTimeoutMs)
            if (r !== TIMED_OUT) return true
            io.log(JSON.stringify({ event: 'post_op_pi_timeout', action, engine: e, op: 'refresh', attempt, timeout_ms: piTimeoutMs }))
        }
        return false
    }
    const refreshAll = async (why: string) => {
        for (const e of io.engines) if (!(await refreshOne(e, why))) throw new PiNotAnswering(`${e} store refresh did not answer within ${piTimeoutMs}ms (twice)`)
    }
    /** Bounded read: on timeout reconnect that Pi and read once more; still nothing → PiNotAnswering. */
    const readOne = async (e: string): Promise<SemanticStoreView | null> => {
        const first = await within(io.readStore(e).catch(() => null), piTimeoutMs)
        if (first !== TIMED_OUT) return first
        io.log(JSON.stringify({ event: 'post_op_pi_timeout', action, engine: e, op: 'read', attempt: 1, timeout_ms: piTimeoutMs }))
        if (!(await refreshOne(e, `${action}: post-op settle read timed out`))) throw new PiNotAnswering(`${e} store read timed out and the reconnect did not answer within ${piTimeoutMs}ms`)
        const second = await within(io.readStore(e).catch(() => null), piTimeoutMs)
        if (second === TIMED_OUT) throw new PiNotAnswering(`${e} store read timed out twice (${piTimeoutMs}ms each, reconnect in between)`)
        return second
    }
    const notAnswering = (err: PiNotAnswering): PostOpSettleResult => {
        const waited = io.now() - t0
        io.log(JSON.stringify({ event: 'post_op_settle', action, ok: false, waited_ms: waited, pi_timeout_ms: piTimeoutMs, reason: err.message }))
        return { ok: false, waitedMs: waited, targets: [], note: `post-op settle: ${err.message} (DURATION_POST_OP_PI_TIMEOUT_MS) — Pi not answering, fail loud` }
    }
    try {
        await refreshAll(`${action}: post-op settle (all pool engines)`)
    } catch (e) { if (e instanceof PiNotAnswering) return notAnswering(e); throw e }
    let lastRefresh = io.now()
    let seen: Seen[] = []
    let targets: string[] = []
    for (;;) {
        const views: Record<string, SemanticStoreView | null> = {}
        try {
            for (const e of io.engines) views[e] = await readOne(e)
        } catch (e) { if (e instanceof PiNotAnswering) return notAnswering(e); throw e }
        const all = new Set<string>()
        for (const v of Object.values(views)) if (v) for (const id of Object.keys(v.instanceDB)) all.add(id)
        targets = baseline ? [...all].filter(id => !baseline.has(id)).sort() : []
        seen = [...sources, ...targets].map(id => {
            const perEngine: Record<string, string> = {}
            let diskId: string | null = null
            for (const [e, v] of Object.entries(views)) {
                const i = v?.instanceDB[id]
                if (i) { perEngine[e] = i.status; diskId ??= i.diskId }
            }
            let engine: string | null = null
            for (const v of Object.values(views)) { const d = diskId ? v?.diskDB[diskId] : undefined; if (d?.dockedTo) { engine = d.dockedTo; break } }
            const status = engine && views[engine]?.instanceDB[id] ? views[engine]!.instanceDB[id]!.status : null
            return { id, status, engine, perEngine }
        })
        const waited = io.now() - t0
        if (seen.every(s => s.status === 'Running')) {
            const note = `post-op settle: ${seen.map(s => `${s.id} Running on ${s.engine}`).join(', ')} after ${waited}ms (all ${io.engines.length} pool views refreshed)`
            io.log(JSON.stringify({ event: 'post_op_settle', action, ok: true, waited_ms: waited, sources, targets }))
            return { ok: true, note, waitedMs: waited, targets }
        }
        if (waited >= budgetMs) {
            const dump = JSON.stringify(seen)
            io.log(JSON.stringify({ event: 'post_op_settle', action, ok: false, waited_ms: waited, budget_ms: budgetMs, dump: seen }))
            return { ok: false, waitedMs: waited, targets, dump,
                note: `post-op settle: not all Running within ${budgetMs}ms (DURATION_POST_OP_SETTLE_MS): ${seen.map(s => `${s.id}=${s.status ?? 'missing'}@${s.engine ?? '-'} views=${JSON.stringify(s.perEngine)}`).join('; ')}` }
        }
        if (io.now() - lastRefresh >= refreshEveryMs) {
            try { await refreshAll(`${action}: post-op settle still waiting`) } catch (e) { if (e instanceof PiNotAnswering) return notAnswering(e); throw e }
            lastRefresh = io.now()
        }
        await io.sleep(pollMs)
    }
}
