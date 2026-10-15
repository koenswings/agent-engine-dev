/**
 * Semantic store equality + waitForConvergence.
 * Compares instanceDB / diskDB / engineDB fields — NEVER raw Automerge blob serialisation.
 */

import type { FleetOps, SemanticDisk, SemanticEngine, SemanticInstance, SemanticStoreView } from './types.js'

const sortKeys = <T>(obj: Record<string, T>): string[] => Object.keys(obj).sort()

const instanceKey = (i: SemanticInstance): string =>
    `${i.id}|${i.status}|${i.diskId ?? ''}|${i.name ?? ''}`

const diskKey = (d: SemanticDisk): string =>
    `${d.id}|${d.dockedTo ?? ''}|${d.name ?? ''}|${d.device ?? ''}`

const engineKey = (e: SemanticEngine): string =>
    `${e.id}|${e.hostname ?? ''}`

/** Field-level equality of two semantic store views (order-independent). */
export const semanticStoresEqual = (a: SemanticStoreView, b: SemanticStoreView): boolean => {
    const aInst = sortKeys(a.instanceDB).map(k => instanceKey(a.instanceDB[k]!))
    const bInst = sortKeys(b.instanceDB).map(k => instanceKey(b.instanceDB[k]!))
    if (aInst.length !== bInst.length || aInst.some((v, i) => v !== bInst[i])) return false

    const aDisk = sortKeys(a.diskDB).map(k => diskKey(a.diskDB[k]!))
    const bDisk = sortKeys(b.diskDB).map(k => diskKey(b.diskDB[k]!))
    if (aDisk.length !== bDisk.length || aDisk.some((v, i) => v !== bDisk[i])) return false

    const aEng = sortKeys(a.engineDB).map(k => engineKey(a.engineDB[k]!))
    const bEng = sortKeys(b.engineDB).map(k => engineKey(b.engineDB[k]!))
    if (aEng.length !== bEng.length || aEng.some((v, i) => v !== bEng[i])) return false

    return true
}

const fmtVal = (v: unknown): string => {
    if (v === undefined) return '<absent>'
    if (v === null) return 'null'
    if (v === '') return '""'
    return String(v)
}

/**
 * Field-level dump of semantic divergences across Engine views.
 * Format: `db id=<id> field=<field> <engineId>=<val> …`
 */
export const formatSemanticDivergence = (views: SemanticStoreView[]): string => {
    if (views.length < 2) {
        return 'semantic fields diverge (need ≥2 views)'
    }

    const lines: string[] = []
    const engineLabel = (v: SemanticStoreView): string => v.engineId

    const allIds = (pick: (v: SemanticStoreView) => Record<string, unknown>): string[] => {
        const ids = new Set<string>()
        for (const v of views) {
            for (const id of Object.keys(pick(v))) ids.add(id)
        }
        return [...ids].sort()
    }

    const pushFieldDiff = (
        db: string,
        id: string,
        field: string,
        values: { engine: string; value: unknown }[],
    ): void => {
        const rendered = values.map(x => `${x.engine}=${fmtVal(x.value)}`).join(' ')
        const distinct = new Set(values.map(x => fmtVal(x.value)))
        if (distinct.size <= 1) return
        lines.push(`${db} id=${id} field=${field} ${rendered}`)
    }

    for (const id of allIds(v => v.instanceDB)) {
        const presence = views.map(v => ({
            engine: engineLabel(v),
            value: v.instanceDB[id] ? 'present' : 'absent',
        }))
        pushFieldDiff('instanceDB', id, '<presence>', presence)
        if (presence.every(p => p.value === 'absent')) continue
        if (presence.some(p => p.value === 'absent')) continue // presence line covers it
        for (const field of ['status', 'diskId', 'name'] as const) {
            pushFieldDiff(
                'instanceDB',
                id,
                field,
                views.map(v => ({
                    engine: engineLabel(v),
                    value: v.instanceDB[id]?.[field],
                })),
            )
        }
    }

    for (const id of allIds(v => v.diskDB)) {
        const presence = views.map(v => ({
            engine: engineLabel(v),
            value: v.diskDB[id] ? 'present' : 'absent',
        }))
        pushFieldDiff('diskDB', id, '<presence>', presence)
        if (presence.every(p => p.value === 'absent')) continue
        if (presence.some(p => p.value === 'absent')) continue
        for (const field of ['dockedTo', 'name', 'device'] as const) {
            pushFieldDiff(
                'diskDB',
                id,
                field,
                views.map(v => ({
                    engine: engineLabel(v),
                    value: v.diskDB[id]?.[field],
                })),
            )
        }
    }

    for (const id of allIds(v => v.engineDB)) {
        const presence = views.map(v => ({
            engine: engineLabel(v),
            value: v.engineDB[id] ? 'present' : 'absent',
        }))
        pushFieldDiff('engineDB', id, '<presence>', presence)
        if (presence.every(p => p.value === 'absent')) continue
        if (presence.some(p => p.value === 'absent')) continue
        for (const field of ['hostname'] as const) {
            pushFieldDiff(
                'engineDB',
                id,
                field,
                views.map(v => ({
                    engine: engineLabel(v),
                    value: v.engineDB[id]?.[field],
                })),
            )
        }
    }

    if (lines.length === 0) {
        return 'semantic fields diverge (no field-level diff found)'
    }
    return `semantic fields diverge: ${lines.join('; ')}`
}

export interface ConvergenceResult {
    ok: boolean
    elapsedMs: number
    reason?: string
    views?: SemanticStoreView[]
}

/** Order-independent key of a semantic view (same fields as semanticStoresEqual). */
export const semanticViewKey = (v: SemanticStoreView): string =>
    [
        sortKeys(v.instanceDB).map(k => instanceKey(v.instanceDB[k]!)).join(','),
        sortKeys(v.diskDB).map(k => diskKey(v.diskDB[k]!)).join(','),
        sortKeys(v.engineDB).map(k => engineKey(v.engineDB[k]!)).join(','),
    ].join('#')

/** Index of the single view that differs from an agreeing majority (≥2 others), else null. */
export const loneOutlier = (views: SemanticStoreView[]): number | null => {
    if (views.length < 3) return null
    const keys = views.map(semanticViewKey)
    const off = keys.map((k, i) => keys.filter((o, j) => j !== i && o === k).length === 0 ? i : -1).filter(i => i >= 0)
    if (off.length !== 1) return null
    const others = keys.filter((_, i) => i !== off[0])
    return others.every(k => k === others[0]) ? off[0]! : null
}

/**
 * Poll fleet stores until semantic equality (shared mode) or local ready (unique mode).
 * Engine-owned settle gate that UI Interactions will await later.
 */
export const waitForConvergence = async (
    ops: FleetOps,
    engineIds: string[],
    timeoutMs: number,
    opts?: { pollMs?: number; requireShared?: boolean; staleAfterMs?: number; refreshExtraMs?: number },
): Promise<ConvergenceResult> => {
    const pollMs = opts?.pollMs ?? 50
    const start = Date.now()
    const mode = ops.getStoreMode()
    const requireShared = opts?.requireShared ?? mode === 'shared'

    if (engineIds.length === 0) {
        return { ok: true, elapsedMs: 0 }
    }

    // Always wait for WS/ready on each participant first.
    for (const id of engineIds) {
        const remaining = Math.max(1, timeoutMs - (Date.now() - start))
        const ready = await ops.waitReady(id, remaining)
        if (!ready.wsUp) {
            return {
                ok: false,
                elapsedMs: Date.now() - start,
                reason: `engine ${id} WS not up within settle timeout`,
            }
        }
    }

    if (!requireShared || engineIds.length < 2) {
        // Unique-doc / single-Pi: local settle only (no cross-engine equality).
        return { ok: true, elapsedMs: Date.now() - start }
    }

    // r80 FAIL@57: the walker's cached view of one Pi lagged (idea04 still showed the pre-undock
    // state while idea01/idea03 and idea04's own Engine had the undock). Stale-view guard: a view
    // that is the ONLY one off the majority and has not changed for staleAfterMs is force-refreshed
    // (fresh connection, recorded in RECONNECTS.md), at most once per engine per wait, and the wait
    // gets ONE bounded extra window for that refresh. Real divergence (fresh views still differ,
    // no majority, or refresh failed) still fails with the field dump. Never a soft-pass.
    const staleAfterMs = opts?.staleAfterMs ?? Math.min(30_000, Math.max(1, Math.floor(timeoutMs / 4)))
    const extraMs = opts?.refreshExtraMs ?? 120_000
    const refreshed = new Set<string>()
    const lastKey = new Map<string, { key: string; since: number }>()
    let deadline = start + timeoutMs
    let extended = false
    while (Date.now() < deadline) {
        const views = await Promise.all(engineIds.map(id => ops.readStore(id)))
        const [first, ...rest] = views
        if (first && rest.every(v => semanticStoresEqual(first, v))) {
            return { ok: true, elapsedMs: Date.now() - start, views }
        }
        const lagger = loneOutlier(views)
        const now = Date.now()
        engineIds.forEach((id, i) => {
            const key = semanticViewKey(views[i]!)
            const prev = lastKey.get(id)
            if (!prev || prev.key !== key) lastKey.set(id, { key, since: now })
        })
        if (lagger !== null && ops.refreshView) {
            const id = engineIds[lagger]!
            const since = lastKey.get(id)!.since
            if (!refreshed.has(id) && now - since >= staleAfterMs) {
                refreshed.add(id)
                await ops.refreshView(id, `convergence: only ${id} off the majority, view unchanged ${Math.round((now - since) / 1000)}s`)
                if (!extended) {
                    extended = true
                    deadline = Math.max(deadline, Date.now() + Math.min(extraMs, timeoutMs))
                }
                continue
            }
        }
        await new Promise(r => setTimeout(r, pollMs))
    }

    const views = await Promise.all(engineIds.map(id => ops.readStore(id)))
    const dump = formatSemanticDivergence(views)
    return {
        ok: false,
        elapsedMs: Date.now() - start,
        reason: `stores did not converge within ${timeoutMs}ms across [${engineIds.join(', ')}]: ${dump}`,
        views,
    }
}
