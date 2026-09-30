/**
 * Duration-test action dispatcher (Phase 1–2).
 *
 * Locked Intent keys (Steve Design Review / idea#166) — see ACTIONS.md.
 * Infra uses Engine eject/dock commands via FleetOps (physical USB stubbed).
 * Usage/operator Intents are no-op stubs until Pixel wires Playwright.
 */

import type {
    DurationOptions,
    FleetOps,
    Layer,
    SemanticStoreView,
    SettleReady,
    StoreMode,
    WalkerState,
} from './types.js'
import { waitForConvergence } from './convergence.js'

export const HUB_ACTIONS = [
    'return_to_start',
    'enter_infra_fleet_walk',
    'open_console_as_teacher',
    'open_console_as_learner',
    'open_console_as_operator',
] as const

export const INFRA_ACTIONS = [
    'infra_undock_fixtures',
    'infra_dock_fixture',
    'infra_move_disk',
    'infra_reboot_engine',
] as const

/** Phase 1–2 stubbed usage/operator Intents that may appear in YAML. */
export const UI_STUB_ACTIONS = [
    'open_kolibri_as_teacher',
    'open_kolibri_as_learner',
    'open_nextcloud_as_learner',
    'open_nextcloud_as_teacher',
    'open_wikipedia_as_learner',
    'open_wikipedia_as_teacher',
    'stay_on_learner_overview',
    'stay_on_teacher_overview',
    'keep_watching',
    'next_resource',
    'exit_lesson',
    'open_disk_inventory',
    'open_instance_controls',
    'eject_disk',
    'stay_on_overview',
] as const

export type KnownAction =
    | (typeof HUB_ACTIONS)[number]
    | (typeof INFRA_ACTIONS)[number]
    | (typeof UI_STUB_ACTIONS)[number]
    | string

export interface ActionResult {
    ok: boolean
    message?: string
    /** Updated walker fields after the action. */
    dockedEngine?: string | null
    layer?: Layer | null
    /** When return_to_start: force next current to start (runner also sets). */
    forceState?: string
}

export interface ActionContext {
    opts: DurationOptions
    walker: WalkerState
    from: string
    to: string
    action: string
    excludeEngines: string[]
    poolEngines: string[]
    fixtureDisk: string
}

const pickPoolEngine = (ctx: ActionContext, preferDifferentFrom?: string | null): string => {
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    if (pool.length === 0) {
        throw new Error('No pool engines available (all excluded — golden-only fleet?)')
    }
    if (preferDifferentFrom) {
        const other = pool.find(e => e !== preferDifferentFrom)
        if (other) return other
    }
    // Deterministic pick via walker step for reproducibility with seeded RNG.
    const idx = Math.floor(ctx.opts.rng!() * pool.length) % pool.length
    return pool[idx]!
}

const assertNotGolden = (ctx: ActionContext, engineId: string, what: string): void => {
    if (ctx.excludeEngines.includes(engineId)) {
        throw new Error(`${what}: refused engine '${engineId}' (exclude_engines / golden)`)
    }
}

const settleParticipants = async (ctx: ActionContext, engines: string[]): Promise<void> => {
    const timeout = ctx.opts.settleTimeoutMs ?? (ctx.opts.fast ? 2000 : 15_000)
    const result = await waitForConvergence(ctx.opts.ops, engines, timeout)
    if (!result.ok) {
        throw new Error(`settle gate failed: ${result.reason ?? 'unknown'}`)
    }
}

const infraUndockFixtures = async (ctx: ActionContext): Promise<ActionResult> => {
    const engines = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    await ctx.opts.ops.undockFixtures(engines, ctx.fixtureDisk)
    await settleParticipants(ctx, engines)
    return { ok: true, message: 'fixtures undocked', dockedEngine: null, layer: 'infra' }
}

const infraDockFixture = async (ctx: ActionContext): Promise<ActionResult> => {
    const engine = ctx.walker.dockedEngine && !ctx.excludeEngines.includes(ctx.walker.dockedEngine)
        ? ctx.walker.dockedEngine
        : pickPoolEngine(ctx)
    assertNotGolden(ctx, engine, 'infra_dock_fixture')
    await ctx.opts.ops.dockFixture(engine, ctx.fixtureDisk)
    await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
    return { ok: true, message: `docked ${ctx.fixtureDisk} on ${engine}`, dockedEngine: engine, layer: 'infra' }
}

const infraMoveDisk = async (ctx: ActionContext): Promise<ActionResult> => {
    const from = ctx.walker.dockedEngine ?? pickPoolEngine(ctx)
    assertNotGolden(ctx, from, 'infra_move_disk(from)')
    const to = pickPoolEngine(ctx, from)
    assertNotGolden(ctx, to, 'infra_move_disk(to)')
    if (from === to) {
        // Single-engine pool: treat as re-dock settle (document limitation).
        await ctx.opts.ops.dockFixture(to, ctx.fixtureDisk)
    } else {
        await ctx.opts.ops.moveDisk(from, to, ctx.fixtureDisk)
    }
    await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
    return {
        ok: true,
        message: from === to ? `re-docked on sole pool engine ${to}` : `moved ${ctx.fixtureDisk} ${from}→${to}`,
        dockedEngine: to,
        layer: 'infra',
    }
}

const infraRebootEngine = async (ctx: ActionContext): Promise<ActionResult> => {
    // Prefer rebooting a non-dock-holder when possible; never golden.
    const engine = pickPoolEngine(ctx)
    assertNotGolden(ctx, engine, 'infra_reboot_engine')
    await ctx.opts.ops.rebootEngine(engine, ctx.opts.fast)
    await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
    return {
        ok: true,
        message: `${ctx.opts.fast ? 'pm2 restart' : 'reboot'} ${engine}`,
        layer: 'infra',
        dockedEngine: ctx.walker.dockedEngine,
    }
}

/**
 * Return to start: clear layer context; if leaving infra_docked with a fixture
 * still docked, undock first (return-to-start hygiene).
 */
const returnToStart = async (ctx: ActionContext): Promise<ActionResult> => {
    if (ctx.walker.dockedEngine) {
        const engines = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
        await ctx.opts.ops.undockFixtures(engines, ctx.fixtureDisk)
        await settleParticipants(ctx, engines)
    }
    return {
        ok: true,
        message: 'cleared layer context; next sample from start',
        dockedEngine: null,
        layer: null,
        forceState: 'start',
    }
}

const enterInfra = async (ctx: ActionContext): Promise<ActionResult> => {
    // Entering infra: ensure fixtures undocked so infra_idle is honest.
    const engines = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    await ctx.opts.ops.undockFixtures(engines, ctx.fixtureDisk)
    await settleParticipants(ctx, engines)
    return { ok: true, message: 'entered infra fleet walk', dockedEngine: null, layer: 'infra' }
}

const uiStub = async (ctx: ActionContext, layer: Layer): Promise<ActionResult> => {
    if (ctx.opts.stubUi === false) {
        return { ok: false, message: `UI Intent '${ctx.action}' not wired (Phase 3)` }
    }
    return { ok: true, message: `UI stub: ${ctx.action}`, layer }
}

export const dispatchAction = async (ctx: ActionContext): Promise<ActionResult> => {
    switch (ctx.action) {
        case 'return_to_start':
            return returnToStart(ctx)
        case 'enter_infra_fleet_walk':
            return enterInfra(ctx)
        case 'infra_undock_fixtures':
            return infraUndockFixtures(ctx)
        case 'infra_dock_fixture':
            return infraDockFixture(ctx)
        case 'infra_move_disk':
            return infraMoveDisk(ctx)
        case 'infra_reboot_engine':
            return infraRebootEngine(ctx)
        case 'open_console_as_teacher':
            return uiStub(ctx, 'usage')
        case 'open_console_as_learner':
            return uiStub(ctx, 'usage')
        case 'open_console_as_operator':
            return uiStub(ctx, 'operator')
        default:
            // Unknown or deeper usage/operator Intent — stub in Phase 1–2.
            if ((UI_STUB_ACTIONS as readonly string[]).includes(ctx.action)) {
                const layer: Layer = ctx.action.startsWith('open_disk') ||
                    ctx.action.startsWith('open_instance') ||
                    ctx.action === 'eject_disk' ||
                    ctx.action === 'stay_on_overview'
                    ? 'operator'
                    : 'usage'
                return uiStub(ctx, layer)
            }
            if (ctx.opts.stubUi !== false) {
                return {
                    ok: true,
                    message: `unknown Intent stubbed: ${ctx.action}`,
                    layer: ctx.walker.layer,
                }
            }
            return { ok: false, message: `unknown action '${ctx.action}'` }
    }
}

// ── FakeFleetOps (no Pis required) ──────────────────────────────────────────

export interface FakeFleetOptions {
    poolEngines: string[]
    excludeEngines?: string[]
    storeMode?: StoreMode
    /** Artificial settle delay ms (0 for unit tests). */
    settleDelayMs?: number
    /** Engines that start with WS down until reboot/dock brings them up. */
    initiallyDown?: string[]
}

/**
 * In-memory fleet for walker unit/integration tests.
 * Simulates eject/dock via semantic store mutations; physical USB is skipped.
 */
export class FakeFleetOps implements FleetOps {
    private mode: StoreMode
    private readonly pool: string[]
    private readonly exclude: string[]
    private readonly ready = new Map<string, boolean>()
    private readonly stores = new Map<string, SemanticStoreView>()
    private readonly settleDelayMs: number
    /** Shared backing store when mode=shared; per-engine copies when unique. */
    private shared: SemanticStoreView | null = null

    constructor(opts: FakeFleetOptions) {
        this.pool = [...opts.poolEngines]
        this.exclude = [...(opts.excludeEngines ?? ['idea02'])]
        this.mode = opts.storeMode ?? (this.pool.length >= 2 ? 'shared' : 'unique')
        this.settleDelayMs = opts.settleDelayMs ?? 0
        const down = new Set(opts.initiallyDown ?? [])
        const engineDB: SemanticStoreView['engineDB'] = {}
        for (const id of this.pool) {
            engineDB[id] = { id, hostname: `${id}.local` }
            this.ready.set(id, !down.has(id))
        }
        // Golden appears in engineDB for phantom checks but is never a dock target.
        for (const g of this.exclude) {
            engineDB[g] = { id: g, hostname: `${g}.local` }
            this.ready.set(g, true)
        }
        const base: SemanticStoreView = {
            engineId: 'shared',
            instanceDB: {},
            diskDB: {},
            engineDB: { ...engineDB },
        }
        if (this.mode === 'shared') {
            this.shared = structuredClone(base)
            for (const id of this.pool) {
                this.stores.set(id, this.viewFor(id, this.shared))
            }
        } else {
            for (const id of this.pool) {
                this.stores.set(id, {
                    engineId: id,
                    instanceDB: {},
                    diskDB: {},
                    engineDB: { ...engineDB },
                })
            }
        }
    }

    private viewFor(engineId: string, shared: SemanticStoreView): SemanticStoreView {
        return {
            engineId,
            instanceDB: shared.instanceDB,
            diskDB: shared.diskDB,
            engineDB: shared.engineDB,
        }
    }

    private mutate(mutator: (doc: SemanticStoreView) => void): void {
        if (this.mode === 'shared' && this.shared) {
            mutator(this.shared)
            for (const id of this.pool) {
                this.stores.set(id, this.viewFor(id, this.shared))
            }
        } else {
            for (const id of this.pool) {
                const doc = this.stores.get(id)
                if (doc) mutator(doc)
            }
        }
    }

    listPoolEngines(): string[] {
        return this.pool.filter(e => !this.exclude.includes(e))
    }

    getStoreMode(): StoreMode {
        return this.mode
    }

    async applyStoreMode(mode: StoreMode): Promise<void> {
        if (mode === this.mode) return
        // Snapshot current semantic state then switch policy.
        const snapshot = this.stores.get(this.pool[0]!) ?? {
            engineId: 'shared',
            instanceDB: {},
            diskDB: {},
            engineDB: {},
        }
        this.mode = mode
        if (mode === 'shared') {
            this.shared = structuredClone({
                engineId: 'shared',
                instanceDB: { ...snapshot.instanceDB },
                diskDB: { ...snapshot.diskDB },
                engineDB: { ...snapshot.engineDB },
            })
            for (const id of this.pool) {
                this.stores.set(id, this.viewFor(id, this.shared))
            }
        } else {
            this.shared = null
            for (const id of this.pool) {
                this.stores.set(id, structuredClone({
                    engineId: id,
                    instanceDB: { ...snapshot.instanceDB },
                    diskDB: { ...snapshot.diskDB },
                    engineDB: { ...snapshot.engineDB },
                }))
            }
        }
    }

    async dockFixture(engineId: string, diskId: string): Promise<void> {
        if (this.exclude.includes(engineId)) {
            throw new Error(`FakeFleetOps: refused dock on excluded ${engineId}`)
        }
        this.mutate(doc => {
            doc.diskDB[diskId] = {
                id: diskId,
                name: diskId,
                dockedTo: engineId,
                device: 'idea-test-duration',
            }
            // Fixture instance becomes Running when docked (semantic smoke).
            const instId = `${diskId}-main`
            doc.instanceDB[instId] = {
                id: instId,
                status: 'Running',
                diskId,
                name: 'duration-main',
            }
        })
        this.ready.set(engineId, true)
        if (this.settleDelayMs) await sleep(this.settleDelayMs)
    }

    async undockFixtures(_engineIds: string[], diskId: string): Promise<void> {
        this.mutate(doc => {
            const disk = doc.diskDB[diskId]
            if (disk) {
                disk.dockedTo = null
                disk.device = null
            }
            for (const inst of Object.values(doc.instanceDB)) {
                if (inst.diskId === diskId) {
                    inst.status = 'Undocked'
                }
            }
        })
        if (this.settleDelayMs) await sleep(this.settleDelayMs)
    }

    async moveDisk(fromEngine: string, toEngine: string, diskId: string): Promise<void> {
        if (this.exclude.includes(toEngine) || this.exclude.includes(fromEngine)) {
            throw new Error(`FakeFleetOps: refused move involving excluded engine`)
        }
        await this.undockFixtures([fromEngine], diskId)
        await this.dockFixture(toEngine, diskId)
    }

    async rebootEngine(engineId: string, _fast: boolean): Promise<void> {
        if (this.exclude.includes(engineId)) {
            throw new Error(`FakeFleetOps: refused reboot of excluded ${engineId}`)
        }
        this.ready.set(engineId, false)
        if (this.settleDelayMs) await sleep(this.settleDelayMs)
        this.ready.set(engineId, true)
        if (this.settleDelayMs) await sleep(this.settleDelayMs)
    }

    async waitReady(engineId: string, timeoutMs: number): Promise<SettleReady> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (this.ready.get(engineId)) {
                return { wsUp: true, storeSynced: true }
            }
            await sleep(5)
        }
        return { wsUp: !!this.ready.get(engineId), storeSynced: false }
    }

    async readStore(engineId: string): Promise<SemanticStoreView> {
        const view = this.stores.get(engineId)
        if (!view) {
            // Golden / unknown: empty view with engine present.
            return {
                engineId,
                instanceDB: {},
                diskDB: {},
                engineDB: { [engineId]: { id: engineId } },
            }
        }
        // Return a clone so tests can mutate safely.
        return structuredClone(view)
    }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
