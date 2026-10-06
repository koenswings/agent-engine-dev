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

/**
 * Poll fleet stores until semantic equality (shared mode) or local ready (unique mode).
 * Engine-owned settle gate that UI Interactions will await later.
 */
export const waitForConvergence = async (
    ops: FleetOps,
    engineIds: string[],
    timeoutMs: number,
    opts?: { pollMs?: number; requireShared?: boolean },
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

    while (Date.now() - start < timeoutMs) {
        const views = await Promise.all(engineIds.map(id => ops.readStore(id)))
        const [first, ...rest] = views
        if (first && rest.every(v => semanticStoresEqual(first, v))) {
            return { ok: true, elapsedMs: Date.now() - start, views }
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
