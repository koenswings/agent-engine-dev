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
import { DURATION_UI_FIXTURES } from './ui/fixtures.js'

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
    // Pixel-registered (65 @ Console#134 ba0cfa1)
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
    // Part B leftovers + leave/back (registered @ ba0cfa1; back_to_console hardened)
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
    // Coaching registered @ ba0cfa1; remaining Kolibri navigation is Pixel-missing
    'create_class',
    'enroll_learners',
    'build_lesson',
    'create_quiz',
    'read_reports',
    'preview_as_learner',
    'browse_classes',
    // Pixel-missing — Fake no-op; keep on YAML (do not drop edges)
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


/**
 * Prefer A r32: late install_app soft-returns while Engine installApp auto-starts
 * the new empty-002 instance. start_after_install then races Start locked under
 * title="Operation in progress" / UI "Starting containers" (~468ms, no wait).
 *
 * Engine settle before Pixel Intent: poll store until a non-grade5a instance on
 * duration-empty-002 is Running (Starting→Running). Fake dock creates
 * duration-empty-002-main Running after redock — returns immediately.
 * If no empty-002 instance appears (stub / install still soft), proceed so Pixel
 * waitForInstallAppSettled / discover can loud-fail. If Starting stuck past budget
 * on live → loud-fail (do not race Intent).
 * Does not wait after early install_app (would starve EmptyDiskPanel make_files).
 */
export const waitEmpty002PostInstallRunning = async (
    ctx: ActionContext,
): Promise<string> => {
    const diskId = DURATION_UI_FIXTURES.empty2.diskId
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    if (pool.length === 0) {
        return 'post-install settle skipped (no pool engines)'
    }
    // RealFleetOps exposes findDockedEngine; Fake does not.
    const opsAny = ctx.opts.ops as FleetOps & { findDockedEngine?: unknown }
    const isLive = typeof opsAny.findDockedEngine === 'function'
    // Fake: synthetic empty-002-main already Running after redock — short budget.
    // Live: installApp + compose start can take minutes even under --fast dwell.
    const budget = isLive
        ? (ctx.opts.fast ? 120_000 : 5 * 60_000)
        : (ctx.opts.fast ? 800 : 3_000)
    const deadline = Date.now() + budget
    let lastIds: string[] = []
    let sawStarting: { id: string; status: string } | null = null

    while (Date.now() < deadline) {
        lastIds = []
        for (const eng of pool) {
            let view: SemanticStoreView
            try {
                view = await ctx.opts.ops.readStore(eng)
            } catch {
                continue
            }
            for (const inst of Object.values(view.instanceDB)) {
                if (inst.diskId !== diskId) continue
                if (/grade5a/i.test(inst.id) || /grade5a/i.test(inst.name ?? '')) continue
                lastIds.push(`${inst.id}:${inst.status}`)
                const st = (inst.status ?? '').trim()
                if (st === 'Running') {
                    return `post-install settle: ${inst.id} Running on ${diskId} (${eng})`
                }
                if (/^Starting/i.test(st) || st === 'Starting') {
                    sawStarting = { id: inst.id, status: st }
                }
            }
        }
        await new Promise<void>(r => setTimeout(r, Math.min(500, Math.max(50, deadline - Date.now()))))
    }

    if (sawStarting) {
        throw new Error(
            `waitEmpty002PostInstallRunning: instance ${sawStarting.id} still ` +
                `${sawStarting.status} on ${diskId} after ${budget}ms ` +
                `(seen=[${lastIds.join(', ')}]). installApp auto-start did not reach Running. ` +
                `Prefer A r32: do not call start_after_install while Operation in progress. No soft-pass.`,
        )
    }
    // No empty-002 post-install instance yet — Pixel Intent may still be settling install.
    return (
        `post-install settle: no non-grade5a instance on ${diskId} within ${budget}ms ` +
        `(seen=[${lastIds.join(', ')}]); proceeding to start_after_install Intent`
    )
}

/**
 * Shared Prefer A empty-002 fresh re-dock (Kid pack always rm+cp via dockFixture).
 * Force undock-then-dock so RealFleetOps empty always-fresh-copy runs (dockFixture
 * no-ops when already on the same engine). Does NOT change DURATION_EMPTY_DISK_ID
 * (=001); Pixel ensureEmptyDiskPanel discovers any empty-badge row. Never idea02.
 * FakeFleetOps: undock pool-wide + synthetic dockFixture (CRI stays green).
 * purgeStoreInstances (BeforeSecondInstall + BeforeErase / Prefer A r36/r37): FS
 * wipe is not enough — Automerge instanceDB rows with storedOn=empty-002 survive;
 * Console hasInstancesOn keys off store → still shows app / no EmptyDiskPanel.
 * AfterErase must NOT purge (erase already cleared instances).
 */
const redockEmpty002Fresh = async (
    ctx: ActionContext,
    label: string,
    noteSuffix: string,
    opts?: { purgeStoreInstances?: boolean },
): Promise<string> => {
    const diskId = DURATION_UI_FIXTURES.empty2.diskId
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    if (pool.length === 0) {
        throw new Error(`${label}: no pool engines available`)
    }
    // Prefer existing dock holder, else Console host pool[0] (Path A empty dock pattern).
    const engine =
        (ctx.walker.dockedEngine && !ctx.excludeEngines.includes(ctx.walker.dockedEngine)
            ? ctx.walker.dockedEngine
            : null) ?? pool[0]!
    assertNotGolden(ctx, engine, label)

    const opsAny = ctx.opts.ops as FleetOps & {
        findDockedEngine?: (id: string) => Promise<string | null>
    }
    if (typeof opsAny.findDockedEngine === 'function') {
        const already = await opsAny.findDockedEngine(diskId)
        if (already) {
            await ctx.opts.ops.undockFixtures([already], diskId)
        }
    } else {
        // Fake / no findDockedEngine: undock pool-wide (idempotent if absent).
        await ctx.opts.ops.undockFixtures(pool, diskId)
    }
    if (opts?.purgeStoreInstances) {
        await ctx.opts.ops.purgeInstancesStoredOn(engine, diskId)
    }
    await ctx.opts.ops.dockFixture(engine, diskId)
    await settleParticipants(ctx, pool)
    return `re-docked ${diskId} on ${engine} ${noteSuffix}`
}

/**
 * Prefer A r26/r27 live safety net: Path A confirm_erase of empty-002 undocks
 * idea-test-4 mid-walk (disk ABSENT / META-only sparse) so late install_app has
 * empty-badge rows=0. Re-dock Kid pack empty-002/ fresh onto Console host
 * pool[0] (or walker.dockedEngine). Path A should still prefer erase republish
 * Empty — this is the Engine mid-walk mitigation.
 */
export const redockEmpty002AfterErase = async (ctx: ActionContext): Promise<string> =>
    redockEmpty002Fresh(ctx, 'redockEmpty002AfterErase', 'after confirm_erase (Empty fresh pack)')

/**
 * Prefer A r35/r36 live safety net: late install_app@85 + start_after_install@86 fills
 * duration-empty-002 with kolibri (app disk). copy_app@87 / open_copied@88 /
 * back_to_disk@89 then second install_app@90 needs EmptyDiskPanel again (empty-001
 * is backup). Mirror AfterErase undock+dockFixture, PLUS purgeStoreInstances (r36):
 * Automerge instanceDB rows with storedOn=empty-002 survive FS wipe; Console
 * hasInstancesOn keys off store (AfterErase does not need this — erase cleared
 * instances). Hooked after open_copied_instance.
 */
export const redockEmpty002BeforeSecondInstall = async (ctx: ActionContext): Promise<string> =>
    redockEmpty002Fresh(
        ctx,
        'redockEmpty002BeforeSecondInstall',
        'before second late install_app (Empty fresh pack + store purge)',
        { purgeStoreInstances: true },
    )

/**
 * Prefer A r37 live safety net: second late install_app@90 fills empty-002 with
 * kolibri again (app disk). stay_on_disk@91 then erase_disk@92 needs EmptyDiskPanel
 * (empty-001 remains backup; empty-badge rows=0 otherwise). Mirror
 * BeforeSecondInstall: undock+dockFixture + purgeStoreInstances. Hooked after
 * stay_on_disk (only CRI occurrence; precedes late erase). Do not regress
 * AfterErase (no purge) or BeforeSecondInstall.
 */
export const redockEmpty002BeforeErase = async (ctx: ActionContext): Promise<string> =>
    redockEmpty002Fresh(
        ctx,
        'redockEmpty002BeforeErase',
        'before late erase_disk (Empty fresh pack + store purge)',
        { purgeStoreInstances: true },
    )

const infraUndockFixtures = async (ctx: ActionContext): Promise<ActionResult> => {
    const engines = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    for (const diskId of ctx.fixtureDisks) {
        await ctx.opts.ops.undockFixtures(engines, diskId)
    }
    await settleParticipants(ctx, engines)
    return { ok: true, message: `fixtures undocked (${ctx.fixtureDisks.join(', ')})`, dockedEngine: null, layer: 'infra' }
}

const infraDockFixture = async (ctx: ActionContext): Promise<ActionResult> => {
    // Prefer Atlas/Kid pre-docked engine (Path A) — RealFleetOps.findDockedEngine when live.
    const opsAny = ctx.opts.ops as FleetOps & { findDockedEngine?: (diskId: string) => Promise<string | null> }
    if (typeof opsAny.findDockedEngine === 'function') {
        const existing = await opsAny.findDockedEngine(ctx.fixtureDisk)
        if (existing && !ctx.excludeEngines.includes(existing)) {
            await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
            return {
                ok: true,
                message: `fixture ${ctx.fixtureDisk} already docked on ${existing} (no-op)`,
                dockedEngine: existing,
                layer: 'infra',
            }
        }
    }
    // Path A re-dock after undock: prefer Console host pool[0] (idea01), never RNG —
    // unique-store inventory is empty if fixtures land on idea03/idea04.
    let engine: string
    if (ctx.walker.dockedEngine && !ctx.excludeEngines.includes(ctx.walker.dockedEngine)) {
        engine = ctx.walker.dockedEngine
    } else if (ctx.opts.preserveDockedOnReturn) {
        const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
        if (pool.length === 0) {
            throw new Error('No pool engines available (all excluded — golden-only fleet?)')
        }
        engine = pool[0]!
    } else {
        engine = pickPoolEngine(ctx)
    }
    assertNotGolden(ctx, engine, 'infra_dock_fixture')
    await ctx.opts.ops.dockFixture(engine, ctx.fixtureDisk)
    // Sibling fixtures (nextcloud) on the same engine so inventory sees both packs.
    const siblings = ctx.fixtureDisks.filter(d => d !== ctx.fixtureDisk)
    for (const diskId of siblings) {
        await ctx.opts.ops.dockFixture(engine, diskId)
    }
    await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
    const sibMsg = siblings.length ? ` (+ ${siblings.join(', ')})` : ''
    return { ok: true, message: `docked ${ctx.fixtureDisk}${sibMsg} on ${engine}`, dockedEngine: engine, layer: 'infra' }
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
 * Return to start: clear layer context. Default: undock if leaving infra_docked
 * (return-to-start hygiene). Path A (`preserveDockedOnReturn` / `--start-instances`):
 * keep fixtures docked for subsequent operator Kid-disk Intents.
 */
const returnToStart = async (ctx: ActionContext): Promise<ActionResult> => {
    // Default hygiene: undock when leaving infra_docked. Path A (`--start-instances`
    // → preserveDockedOnReturn) keeps fixtures so cover-registered-intents can dock-before-inventory
    // then open_disk_inventory on Kid testids without remapping to demo disks.
    if (ctx.walker.dockedEngine && !ctx.opts.preserveDockedOnReturn) {
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
            const keptFail = Boolean(ctx.opts.preserveDockedOnReturn && ctx.walker.dockedEngine)
            return {
                ok: false,
                message: `return_to_start UI failed: ${ui.message ?? 'unknown'}`,
                dockedEngine: keptFail ? ctx.walker.dockedEngine : null,
                layer: null,
                forceState: 'start',
            }
        }
        uiMsg = `; ${ui.message ?? 'UI cleared'}`
    }
    const kept = Boolean(ctx.opts.preserveDockedOnReturn && ctx.walker.dockedEngine)
    return {
        ok: true,
        message: kept
            ? `cleared layer context; fixtures preserved for Path A${uiMsg}`
            : `cleared layer context; next sample from start${uiMsg}`,
        dockedEngine: kept ? ctx.walker.dockedEngine : null,
        layer: null,
        forceState: 'start',
    }
}

const enterInfra = async (ctx: ActionContext): Promise<ActionResult> => {
    // Entering infra: ensure fixtures undocked so infra_idle is honest.
    // Path A (`preserveDockedOnReturn` / `--start-instances`): keep Atlas/Kid
    // pre-docked fixtures so infra_dock_fixture can no-op without destructive re-copy.
    const engines = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    if (!ctx.opts.preserveDockedOnReturn) {
        for (const diskId of ctx.fixtureDisks) {
            await ctx.opts.ops.undockFixtures(engines, diskId)
        }
        await settleParticipants(ctx, engines)
        return { ok: true, message: 'entered infra fleet walk', dockedEngine: null, layer: 'infra' }
    }
    const opsAny = ctx.opts.ops as FleetOps & { findDockedEngine?: (diskId: string) => Promise<string | null> }
    let kept: string | null = null
    if (typeof opsAny.findDockedEngine === 'function') {
        kept = await opsAny.findDockedEngine(ctx.fixtureDisk)
    }
    await settleParticipants(ctx, engines)
    return {
        ok: true,
        message: kept
            ? `entered infra fleet walk (Path A keep dock on ${kept})`
            : 'entered infra fleet walk (Path A; no undock)',
        dockedEngine: kept,
        layer: 'infra',
    }
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
    } else if (ctx.action.includes('wikipedia') || ctx.action.includes('kiwix')) {
        // Prefer A / Kid App#11: open_wikipedia_* / search_browse_wikipedia / leave_wikipedia_*
        // must target Kiwix (kiwix-ideaa-001), never primary kolibri-grade5a-001.
        // Kiwix is not infra_disk yet (unified.yaml deferred) so fixtureInstances often
        // lacks a kiwix entry — fall back to seeded Prefer A pin.
        const kx = Object.entries(ctx.fixtureInstances).find(
            ([d]) => d.includes('kiwix') || d.includes('wikipedia'),
        )
        if (kx) {
            diskId = kx[0]
            instanceId = kx[1]
        } else {
            diskId = DURATION_UI_FIXTURES.kiwix.diskId
            instanceId = DURATION_UI_FIXTURES.kiwix.instanceId
        }
    } else if (ctx.action.includes('kolibri') || ctx.action === 'open_video' || ctx.action === 'open_exercise') {
        const k = Object.entries(ctx.fixtureInstances).find(([d]) => d.includes('kolibri'))
        if (k) {
            diskId = k[0]
            instanceId = k[1]
        }
    }
    let preStartSettleNote: string | null = null
    // Prefer A r32: settle empty-002 auto-start before start_after_install Intent.
    if (ctx.action === 'start_after_install') {
        try {
            preStartSettleNote = await waitEmpty002PostInstallRunning(ctx)
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `start_after_install aborted before Intent: ${err}`,
                layer,
            }
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
    let message = result.message ?? `${result.mode}: ${ctx.action}`
    if (preStartSettleNote) {
        message = `${message}; ${preStartSettleNote}`
    }
    // Prefer A r26: after successful confirm_erase, re-dock empty-002 Empty for late install_app.
    if (result.ok && ctx.action === 'confirm_erase') {
        try {
            const note = await redockEmpty002AfterErase(ctx)
            message = `${message}; ${note}`
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `confirm_erase ok but empty-002 re-dock failed: ${err}`,
                layer,
            }
        }
    }
    // Prefer A r35: after open_copied_instance, re-dock empty-002 Empty before second
    // late install_app (start_after_install left empty-002 as app disk; empty-001 is backup).
    if (result.ok && ctx.action === 'open_copied_instance') {
        try {
            const note = await redockEmpty002BeforeSecondInstall(ctx)
            message = `${message}; ${note}`
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `open_copied_instance ok but empty-002 re-dock failed: ${err}`,
                layer,
            }
        }
    }
    // Prefer A r37: after stay_on_disk (precedes late erase), re-dock empty-002 Empty
    // before erase_disk (second late install_app left empty-002 as app disk again).
    if (result.ok && ctx.action === 'stay_on_disk') {
        try {
            const note = await redockEmpty002BeforeErase(ctx)
            message = `${message}; ${note}`
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `stay_on_disk ok but empty-002 re-dock failed: ${err}`,
                layer,
            }
        }
    }
    return {
        ok: result.ok,
        message,
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

    /**
     * Prefer A r36: drop synthetic instanceDB rows for diskId so Fake hasInstancesOn
     * semantics stay Empty after BeforeSecondInstall redock (CRI stays green).
     */
    async purgeInstancesStoredOn(_engineId: string, diskId: string): Promise<void> {
        this.mutate(doc => {
            for (const id of Object.keys(doc.instanceDB)) {
                const inst = doc.instanceDB[id]
                if (inst && inst.diskId === diskId) {
                    delete doc.instanceDB[id]
                }
            }
        })
        if (this.settleDelayMs) await sleep(this.settleDelayMs)
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
