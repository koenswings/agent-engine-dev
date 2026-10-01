/**
 * Duration-test action dispatcher (Phase 1–4 / idea#168).
 *
 * Locked Intent keys (Steve Design Review / idea#166) — see ACTIONS.md.
 * Infra uses Engine eject/dock commands via FleetOps (physical USB stubbed).
 * Usage/operator Intents: StubUiDriver (Fake CI) or PlaywrightUiDriver → Pixel getIntent.
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
import { finalizeRecordedFrame, framePath } from './recordWalk.js'

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

/**
 * Usage/operator Intent keys present in unified.yaml.
 * Pixel-registered + deferred + Pixel-missing — Fake StubUiDriver no-ops all;
 * live --ui needs Pixel adapters for deferred/missing before those edges are real.
 */
export const UI_STUB_ACTIONS = [
    // Pixel-registered (58 @ Console#134 128f2d3)
    'open_kolibri_as_teacher',
    'open_kolibri_as_learner',
    'open_nextcloud_as_learner',
    'open_nextcloud_as_teacher',
    'stay_on_learner_overview',
    'stay_on_teacher_overview',
    'open_disk_inventory',
    'open_instance_controls',
    'eject_disk',
    'stay_on_overview',
    'open_video',
    'open_exercise',
    'confirm_eject',
    'cancel_eject',
    'erase_disk',
    'confirm_erase',
    'cancel_erase',
    'start_instance',
    'stop_instance',
    'open_account',
    'close_account',
    'open_settings',
    'close_settings',
    'sign_in',
    'make_files_disk',
    'add_files_role',
    'install_app',
    'start_after_install',
    'stay_on_disk',
    'make_backup_disk',
    'restore_from_backup',
    'open_app',
    'backup_instance',
    'back_to_disk',
    'back_to_overview',
    'log_out',
    'notice_usb_dock',
    'retry_login_first_time_setup',
    'change_password',
    'add_operator',
    'remove_operator',
    'copy_app',
    'move_app',
    // Part B leftovers + leave/back (registered @ 128f2d3)
    'files_role_added',
    'backup_configured_restored',
    'done_redistribute',
    'stay_on_source_disk',
    'open_copied_instance',
    'switch_engine',
    'reboot_engine',
    'back_to_console',
    'leave_kolibri',
    'leave_nextcloud_as_teacher',
    'leave_nextcloud_as_learner',
    // Deferred (Pixel clear message)
    'open_wikipedia_as_learner',
    'open_wikipedia_as_teacher',
    'keep_watching',
    'next_resource',
    'exit_lesson',
    // Pixel-missing — Fake no-op; keep on YAML (do not drop edges)
    'create_class',
    'enroll_learners',
    'build_lesson',
    'create_quiz',
    'read_reports',
    'preview_as_learner',
    'browse_classes',
    'finish_exercise',
    'next_video',
    'share_to_class',
    'done_sharing',
    'back_to_console_from_share',
    'open_file_drop',
    'after_upload',
    'leave_file_drop',
    'open_collab_doc',
    'close_doc',
    'keep_editing',
    'browse_folders',
    'search_browse_wikipedia',
    'leave_wikipedia_as_learner',
    'leave_wikipedia_as_teacher',
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
    /** Primary infra dock target (Kid kolibri pack by default). */
    fixtureDisk: string
    /** Instance id for primary fixture (kolibri-grade5a-001). */
    fixtureInstance: string
    /** All infra-eligible fixture disk ids (kolibri + nextcloud). */
    fixtureDisks: string[]
    /** diskId → instanceId for semantic store. */
    fixtureInstances: Record<string, string>
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
    for (const diskId of ctx.fixtureDisks) {
        await ctx.opts.ops.undockFixtures(engines, diskId)
    }
    await settleParticipants(ctx, engines)
    return { ok: true, message: `fixtures undocked (${ctx.fixtureDisks.join(', ')})`, dockedEngine: null, layer: 'infra' }
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
        for (const diskId of ctx.fixtureDisks) {
            await ctx.opts.ops.undockFixtures(engines, diskId)
        }
        await settleParticipants(ctx, engines)
    }
    // Phase 3: dismiss Console modals via Pixel return_to_start when Playwright is live.
    let uiMsg = ''
    if (ctx.opts.uiDriver && ctx.opts.uiDriver.kind === 'playwright') {
        const recDir = ctx.opts.recordWalkDir
        const stepNum = ctx.walker.step + 1
        const shotPath = recDir ? framePath(recDir, stepNum, 'return_to_start') : undefined
        const ui = await ctx.opts.uiDriver.runIntent({
            action: 'return_to_start',
            diskId: ctx.fixtureDisk,
            instanceId: ctx.fixtureInstance,
            engineId: ctx.poolEngines[0],
            screenshotPath: shotPath,
        })
        if (recDir && shotPath) {
            finalizeRecordedFrame({
                dir: recDir,
                step: stepNum,
                action: 'return_to_start',
                path: shotPath,
            })
        }
        if (!ui.ok) {
            return {
                ok: false,
                message: `return_to_start UI failed: ${ui.message ?? 'unknown'}`,
                dockedEngine: null,
                layer: null,
                forceState: 'start',
            }
        }
        uiMsg = `; ${ui.message ?? 'UI cleared'}`
    }
    return {
        ok: true,
        message: `cleared layer context; next sample from start${uiMsg}`,
        dockedEngine: null,
        layer: null,
        forceState: 'start',
    }
}

const enterInfra = async (ctx: ActionContext): Promise<ActionResult> => {
    // Entering infra: ensure fixtures undocked so infra_idle is honest.
    const engines = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    for (const diskId of ctx.fixtureDisks) {
        await ctx.opts.ops.undockFixtures(engines, diskId)
    }
    await settleParticipants(ctx, engines)
    return { ok: true, message: 'entered infra fleet walk', dockedEngine: null, layer: 'infra' }
}

const layerForUiAction = (action: string, fallback: Layer | null): Layer => {
    if (
        action.startsWith('open_disk') ||
        action.startsWith('open_instance') ||
        action === 'eject_disk' ||
        action === 'stay_on_overview' ||
        action.startsWith('confirm_') ||
        action.startsWith('cancel_') ||
        action.startsWith('erase_') ||
        action === 'start_instance' ||
        action === 'stop_instance' ||
        action === 'make_files_disk' ||
        action === 'add_files_role' ||
        action === 'open_account' ||
        action === 'close_account' ||
        action === 'open_settings' ||
        action === 'close_settings' ||
        action === 'sign_in' ||
        action === 'open_console_as_operator' ||
        action === 'retry_login_first_time_setup' ||
        action === 'notice_usb_dock' ||
        action === 'install_app' ||
        action === 'start_after_install' ||
        action === 'stay_on_disk' ||
        action === 'make_backup_disk' ||
        action === 'restore_from_backup' ||
        action === 'backup_configured_restored' ||
        action === 'files_role_added' ||
        action === 'copy_app' ||
        action === 'move_app' ||
        action === 'done_redistribute' ||
        action === 'stay_on_source_disk' ||
        action === 'open_copied_instance' ||
        action === 'open_app' ||
        action === 'backup_instance' ||
        action === 'back_to_disk' ||
        action === 'back_to_overview' ||
        action === 'add_operator' ||
        action === 'remove_operator' ||
        action === 'change_password' ||
        action === 'log_out' ||
        action === 'switch_engine' ||
        action === 'reboot_engine'
    ) {
        return 'operator'
    }
    if (
        action.startsWith('open_console') ||
        action.startsWith('open_kolibri') ||
        action.startsWith('open_nextcloud') ||
        action.startsWith('open_wikipedia') ||
        action.startsWith('stay_on_') ||
        action === 'open_video' ||
        action === 'open_exercise' ||
        action === 'keep_watching' ||
        action === 'next_resource' ||
        action === 'exit_lesson' ||
        action === 'create_class' ||
        action === 'enroll_learners' ||
        action === 'build_lesson' ||
        action === 'create_quiz' ||
        action === 'read_reports' ||
        action === 'preview_as_learner' ||
        action === 'back_to_console' ||
        action === 'browse_classes' ||
        action === 'leave_kolibri' ||
        action === 'finish_exercise' ||
        action === 'next_video' ||
        action === 'share_to_class' ||
        action === 'done_sharing' ||
        action === 'back_to_console_from_share' ||
        action === 'open_file_drop' ||
        action === 'after_upload' ||
        action === 'leave_file_drop' ||
        action === 'open_collab_doc' ||
        action === 'close_doc' ||
        action === 'keep_editing' ||
        action === 'browse_folders' ||
        action.startsWith('leave_nextcloud') ||
        action === 'search_browse_wikipedia' ||
        action.startsWith('leave_wikipedia')
    ) {
        return 'usage'
    }
    return fallback ?? 'usage'
}

/**
 * Dispatch a usage/operator Intent via UiDriver (Phase 3).
 * StubUiDriver when stubUi≠false / no driver; PlaywrightUiDriver when --ui.
 */
const runUiIntent = async (ctx: ActionContext, layerHint: Layer): Promise<ActionResult> => {
    const layer = layerForUiAction(ctx.action, layerHint)
    const driver = ctx.opts.uiDriver
    const recDir = ctx.opts.recordWalkDir
    const stepNum = ctx.walker.step + 1
    const shotPath = recDir ? framePath(recDir, stepNum, ctx.action) : undefined
    if (!driver) {
        if (ctx.opts.stubUi === false) {
            return { ok: false, message: `UI Intent '${ctx.action}' requires uiDriver (pass --ui)` }
        }
        if (recDir && shotPath) {
            finalizeRecordedFrame({
                dir: recDir,
                step: stepNum,
                action: ctx.action,
                path: shotPath,
                skipped: true,
                skipReason: 'no_ui_driver',
            })
        }
        // Backward-compatible no-driver stub (unit tests that omit uiDriver).
        return { ok: true, message: `UI stub: ${ctx.action}`, layer }
    }
    const defaults = {
        diskId: ctx.fixtureDisk,
        instanceId: ctx.fixtureInstance,
    }
    // Prefer pack-specific ids when Intent names the app.
    let diskId = defaults.diskId
    let instanceId = defaults.instanceId
    if (ctx.action.includes('nextcloud')) {
        const nc = Object.entries(ctx.fixtureInstances).find(([d]) => d.includes('nextcloud'))
        if (nc) {
            diskId = nc[0]
            instanceId = nc[1]
        }
    } else if (ctx.action.includes('kolibri') || ctx.action === 'open_video' || ctx.action === 'open_exercise') {
        const k = Object.entries(ctx.fixtureInstances).find(([d]) => d.includes('kolibri'))
        if (k) {
            diskId = k[0]
            instanceId = k[1]
        }
    }
    const result = await driver.runIntent({
        action: ctx.action,
        diskId,
        instanceId,
        engineId: ctx.walker.dockedEngine ?? ctx.poolEngines[0],
        screenshotPath: shotPath,
    })
    if (recDir && shotPath) {
        if (driver.kind === 'stub') {
            finalizeRecordedFrame({
                dir: recDir,
                step: stepNum,
                action: ctx.action,
                path: shotPath,
                skipped: true,
                skipReason: 'stub_ui_no_page',
            })
        } else {
            finalizeRecordedFrame({
                dir: recDir,
                step: stepNum,
                action: ctx.action,
                path: shotPath,
            })
        }
    }
    return {
        ok: result.ok,
        message: result.message ?? `${result.mode}: ${ctx.action}`,
        layer,
    }
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
            return runUiIntent(ctx, 'usage')
        case 'open_console_as_learner':
            return runUiIntent(ctx, 'usage')
        case 'open_console_as_operator':
            return runUiIntent(ctx, 'operator')
        default:
            // Usage/operator Intents → UiDriver (stub or Playwright).
            if ((UI_STUB_ACTIONS as readonly string[]).includes(ctx.action)) {
                return runUiIntent(ctx, layerForUiAction(ctx.action, ctx.walker.layer))
            }
            // return_to_start already handled; infra handled above.
            // Unknown: try UI driver when present, else stub/fail.
            if (ctx.opts.uiDriver) {
                return runUiIntent(ctx, ctx.walker.layer ?? 'usage')
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
    /** Kid pack diskId → instanceId map. */
    fixtureInstances?: Record<string, string>
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
    /** diskId → instanceId (Kid packs). */
    private fixtureInstanceMap: Record<string, string>

    constructor(opts: FakeFleetOptions) {
        this.pool = [...opts.poolEngines]
        this.exclude = [...(opts.excludeEngines ?? ['idea02'])]
        this.mode = opts.storeMode ?? (this.pool.length >= 2 ? 'shared' : 'unique')
        this.settleDelayMs = opts.settleDelayMs ?? 0
        this.fixtureInstanceMap = { ...(opts.fixtureInstances ?? {}) }
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
            const instId = this.fixtureInstanceMap[diskId] ?? `${diskId}-main`
            doc.instanceDB[instId] = {
                id: instId,
                status: 'Running',
                diskId,
                name: instId,
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


    async probeStability(engineIds: string[]): Promise<import('./types.js').FleetStabilityProbe> {
        const engines: import('./types.js').FleetStabilityProbe['engines'] = []
        let ok = true
        for (const id of engineIds) {
            const wsUp = !!this.ready.get(id)
            // Fake: no docker — treat Running instances as dockerOk when WS up.
            let dockerOk: boolean | undefined = undefined
            if (wsUp) {
                const view = this.stores.get(id)
                const running = view
                    ? Object.values(view.instanceDB).filter(i => i.status === 'Running')
                    : []
                dockerOk = true // in-memory always "containers match" when WS up
                void running
            } else {
                dockerOk = false
                ok = false
            }
            engines.push({ id, wsUp, dockerOk })
            if (!wsUp) ok = false
        }
        return { ok, detail: ok ? 'fake probe ok' : 'fake probe: WS down', engines }
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
