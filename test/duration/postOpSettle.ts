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

export const settleAfterLongOp = async (
    action: string, sources: string[], baseline: Set<string> | null, io: PostOpSettleIo,
    budgetMs = postOpSettleBudgetMs(), pollMs = 3_000, refreshEveryMs = 60_000,
): Promise<PostOpSettleResult> => {
    const t0 = io.now()
    const refreshAll = async (why: string) => { if (io.refresh) for (const e of io.engines) { try { await io.refresh(e, why) } catch { /* counted by refresh */ } } }
    await refreshAll(`${action}: post-op settle (all pool engines)`)
    let lastRefresh = io.now()
    let seen: Seen[] = []
    let targets: string[] = []
    for (;;) {
        const views: Record<string, SemanticStoreView | null> = {}
        for (const e of io.engines) { try { views[e] = await io.readStore(e) } catch { views[e] = null } }
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
        if (io.now() - lastRefresh >= refreshEveryMs) { await refreshAll(`${action}: post-op settle still waiting`); lastRefresh = io.now() }
        await io.sleep(pollMs)
    }
}
