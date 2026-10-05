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
    return {
        ok: false,
        elapsedMs: Date.now() - start,
        reason: `stores did not converge within ${timeoutMs}ms across [${engineIds.join(', ')}]`,
        views,
    }
}
