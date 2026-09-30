/**
 * Invariant type registry + evaluation (Phase 2).
 * Primary focus: infra layer. Semantic field checks only.
 */

import { semanticStoresEqual } from './convergence.js'
import type { FleetOps, InvariantSpec, SemanticStoreView, WalkerState } from './types.js'

export interface InvariantContext {
    ops: FleetOps
    walker: WalkerState
    excludeEngines: string[]
    poolEngines: string[]
    fixtureDisk: string
    engines: string[]
}

export interface InvariantResult {
    type: string
    ok: boolean
    detail?: string
}

type Evaluator = (
    spec: InvariantSpec,
    ctx: InvariantContext,
    views: SemanticStoreView[],
) => Promise<InvariantResult> | InvariantResult

const evalStoreConvergence: Evaluator = (_spec, ctx, views) => {
    if (ctx.ops.getStoreMode() !== 'shared' || views.length < 2) {
        return { type: 'store_convergence', ok: true, detail: 'skipped (unique or single engine)' }
    }
    const [first, ...rest] = views
    const ok = !!first && rest.every(v => semanticStoresEqual(first, v))
    return {
        type: 'store_convergence',
        ok,
        detail: ok ? 'semantic instanceDB/diskDB/engineDB match' : 'semantic fields diverge',
    }
}

const evalNoPhantomDocks: Evaluator = (_spec, _ctx, views) => {
    for (const view of views) {
        const engineIds = new Set(Object.keys(view.engineDB))
        for (const disk of Object.values(view.diskDB)) {
            if (disk.dockedTo && !engineIds.has(disk.dockedTo)) {
                return {
                    type: 'no_phantom_docks',
                    ok: false,
                    detail: `disk ${disk.id} dockedTo ${disk.dockedTo} missing from engineDB on ${view.engineId}`,
                }
            }
        }
    }
    return { type: 'no_phantom_docks', ok: true }
}

const evalNoZombieInstances: Evaluator = (_spec, _ctx, views) => {
    for (const view of views) {
        for (const inst of Object.values(view.instanceDB)) {
            if (inst.status !== 'Running' && inst.status !== 'Starting') continue
            const disk = inst.diskId ? view.diskDB[inst.diskId] : undefined
            if (!disk || disk.dockedTo === null) {
                return {
                    type: 'no_zombie_instances',
                    ok: false,
                    detail: `instance ${inst.id} is ${inst.status} but disk ${inst.diskId ?? '?'} is Undocked/missing on ${view.engineId}`,
                }
            }
        }
    }
    return { type: 'no_zombie_instances', ok: true }
}

const evalGoldenUntouched: Evaluator = (_spec, ctx, views) => {
    for (const golden of ctx.excludeEngines) {
        if (ctx.walker.dockedEngine === golden) {
            return { type: 'golden_untouched', ok: false, detail: `fixture docked on excluded ${golden}` }
        }
        for (const view of views) {
            for (const disk of Object.values(view.diskDB)) {
                if (disk.id === ctx.fixtureDisk && disk.dockedTo === golden) {
                    return {
                        type: 'golden_untouched',
                        ok: false,
                        detail: `fixture ${ctx.fixtureDisk} dockedTo golden ${golden}`,
                    }
                }
            }
        }
    }
    return { type: 'golden_untouched', ok: true }
}

const evalDiskDocked: Evaluator = (spec, ctx, views) => {
    const diskId = String(spec.disk ?? ctx.fixtureDisk)
    const engineWant = spec.engine
    for (const view of views) {
        const disk = view.diskDB[diskId]
        if (!disk) continue
        if (disk.dockedTo === null) {
            return { type: 'disk_docked', ok: false, detail: `${diskId} not docked on ${view.engineId}` }
        }
        if (engineWant === 'any_pool') {
            if (!ctx.poolEngines.includes(disk.dockedTo) || ctx.excludeEngines.includes(disk.dockedTo)) {
                return {
                    type: 'disk_docked',
                    ok: false,
                    detail: `${diskId} dockedTo ${disk.dockedTo} not in pool`,
                }
            }
            return { type: 'disk_docked', ok: true, detail: `docked to pool ${disk.dockedTo}` }
        }
        if (typeof engineWant === 'string' && disk.dockedTo !== engineWant) {
            return {
                type: 'disk_docked',
                ok: false,
                detail: `${diskId} dockedTo ${disk.dockedTo}, expected ${engineWant}`,
            }
        }
        return { type: 'disk_docked', ok: true }
    }
    return { type: 'disk_docked', ok: false, detail: `disk ${diskId} not found in any view` }
}

const evalInstanceStatus: Evaluator = (spec, _ctx, views) => {
    const instanceId = String(spec.instance ?? '')
    const expected = String(spec.expected ?? '')
    if (!instanceId || !expected) {
        return { type: 'instance_status', ok: false, detail: 'missing instance or expected' }
    }
    for (const view of views) {
        const inst = view.instanceDB[instanceId]
        if (!inst) continue
        if (inst.status !== expected) {
            return {
                type: 'instance_status',
                ok: false,
                detail: `${instanceId} is ${inst.status}, expected ${expected} on ${view.engineId}`,
            }
        }
        return { type: 'instance_status', ok: true }
    }
    return { type: 'instance_status', ok: false, detail: `instance ${instanceId} not found` }
}

const evalEngineLiveness: Evaluator = async (_spec, ctx) => {
    for (const id of ctx.engines) {
        const ready = await ctx.ops.waitReady(id, 2000)
        if (!ready.wsUp) {
            return { type: 'engine_liveness', ok: false, detail: `${id} WS down` }
        }
    }
    return { type: 'engine_liveness', ok: true }
}

const REGISTRY: Record<string, Evaluator> = {
    store_convergence: evalStoreConvergence,
    no_phantom_docks: evalNoPhantomDocks,
    no_zombie_instances: evalNoZombieInstances,
    golden_untouched: evalGoldenUntouched,
    disk_docked: evalDiskDocked,
    instance_status: evalInstanceStatus,
    engine_liveness: evalEngineLiveness,
}

export const DEFAULT_INFRA_INVARIANTS: InvariantSpec[] = [
    { type: 'store_convergence' },
    { type: 'no_phantom_docks' },
    { type: 'no_zombie_instances' },
    { type: 'golden_untouched' },
    { type: 'engine_liveness' },
]

export const evaluateInvariants = async (
    specs: InvariantSpec[],
    ctx: InvariantContext,
): Promise<InvariantResult[]> => {
    const views = await Promise.all(ctx.engines.map(id => ctx.ops.readStore(id)))
    const results: InvariantResult[] = []
    for (const spec of specs) {
        const ev = REGISTRY[spec.type]
        if (!ev) {
            results.push({ type: spec.type, ok: false, detail: `unknown invariant type '${spec.type}'` })
            continue
        }
        results.push(await ev(spec, ctx, views))
    }
    return results
}

export const listInvariantTypes = (): string[] => Object.keys(REGISTRY)
