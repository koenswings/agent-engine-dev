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
import { parse as parseYaml } from 'yaml'
import { finalizeRecordedFrame, framePath } from './recordWalk.js'
import { DURATION_UI_FIXTURES } from './ui/fixtures.js'
import { copyDoneBudgetMs, DEFAULT_NEXTCLOUD_READY_MS, envMs, instanceStartBudgetMs, logStartMeasured } from './startBudgets.js'

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
    // Live: installApp + compose start (+ services/*.tar image load with skipImageLoad:false)
    // can take minutes even under --fast dwell. DURATION_INSTANCE_START_MS (startBudgets.ts).
    const budget = instanceStartBudgetMs({ fast: !!ctx.opts.fast, live: isLive })
    const t0 = Date.now()
    const deadline = t0 + budget
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
                    const ms = Date.now() - t0
                    if (isLive) logStartMeasured({ what: 'post_install_start', engine: eng, instanceId: inst.id, diskId, ms, budgetMs: budget })
                    return `post-install settle: ${inst.id} Running on ${diskId} (${eng}) after ${ms}ms (budget ${budget}ms)`
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
 * Prefer A r23 FAIL@91: after ejectDisk, unique-store may still show dockedTo until
 * Automerge settles. Poll / waitDiskUndocked until findDockedEngine is null so
 * dockFixture cannot no-op a same-engine fresh redock on stale state.
 * Fail loud if undock does not clear within budget.
 */
const waitUndockedBeforeRedock = async (
    ops: {
        waitDiskUndocked?: (id: string, timeoutMs?: number) => Promise<void>
        findDockedEngine?: (id: string) => Promise<string | null>
    },
    diskId: string,
    label: string,
    timeoutMs = 60_000,
): Promise<void> => {
    if (typeof ops.waitDiskUndocked === 'function') {
        await ops.waitDiskUndocked(diskId, timeoutMs)
        return
    }
    if (typeof ops.findDockedEngine !== 'function') return
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const still = await ops.findDockedEngine(diskId)
        if (!still) return
        await new Promise<void>(r => setTimeout(r, 50))
    }
    throw new Error(
        `${label}: ${diskId} still docked after eject within ${timeoutMs}ms ` +
            `(unique-store Automerge lag). Prefer A — fail loud before dockFixture no-op.`,
    )
}

/**
 * Shared Prefer A empty-pack fresh re-dock (Kid pack always rm+cp via dockFixture;
 * empty/empty-002 also strip non-META so createFilesDisk is not refused by README.md).
 * Force undock-then-dock so RealFleetOps empty always-fresh-copy runs (dockFixture
 * no-ops when already on the same engine). After undock, wait until store clears
 * dockedTo (Prefer A r23) before dockFixture — unique-store eject is async.
 * Does NOT change DURATION_EMPTY_DISK_ID (=001); Pixel ensureEmptyDiskPanel discovers
 * any empty-badge row. Never idea02.
 * FakeFleetOps: undock pool-wide + synthetic dockFixture (CRI stays green).
 * purgeStoreInstances (BeforeSecondInstall + BeforeErase + BeforeMakeFiles /
 * Prefer A r36/r37/r20): FS wipe is not enough — Automerge instanceDB rows with
 * storedOn=diskId survive; Console hasInstancesOn keys off store → still shows
 * app / no EmptyDiskPanel. AfterErase must NOT purge (erase already cleared instances).
 */
const redockEmptyFresh = async (
    ctx: ActionContext,
    diskId: string,
    label: string,
    noteSuffix: string,
    opts?: { purgeStoreInstances?: boolean; targetEngine?: string },
): Promise<string> => {
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    if (pool.length === 0) {
        throw new Error(`${label}: no pool engines available`)
    }
    // Explicit target (Prefer A r21: Console's engine for empty-001) wins; else prefer
    // existing dock holder, else Console host pool[0] (Path A empty dock pattern).
    const engine =
        opts?.targetEngine ??
        (ctx.walker.dockedEngine && !ctx.excludeEngines.includes(ctx.walker.dockedEngine)
            ? ctx.walker.dockedEngine
            : null) ?? pool[0]!
    assertNotGolden(ctx, engine, label)
    if (isNeverEngine(engine)) {
        throw new Error(`${label}: refused engine '${engine}' (never idea02)`)
    }

    const opsAny = ctx.opts.ops as FleetOps & {
        findDockedEngine?: (id: string) => Promise<string | null>
        waitDiskUndocked?: (id: string, timeoutMs?: number) => Promise<void>
    }
    if (typeof opsAny.findDockedEngine === 'function') {
        const already = await opsAny.findDockedEngine(diskId)
        if (already) {
            await ctx.opts.ops.undockFixtures([already], diskId)
            // Prefer A r23: wait until undock clears BEFORE dockFixture (same-engine
            // redock otherwise no-ops on stale dockedTo=idea01).
            await waitUndockedBeforeRedock(opsAny, diskId, label)
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
    if (opts?.targetEngine && typeof opsAny.findDockedEngine === 'function') {
        // Prefer A r21: dockFixture must not have redirected the empty pack elsewhere.
        const landed = await opsAny.findDockedEngine(diskId)
        if (landed !== engine) {
            throw new Error(
                `${label}: ${diskId} landed on ${landed ?? 'nowhere'} not ${engine} ` +
                    `(Console's engine). Prefer A — fail loud; never idea02.`,
            )
        }
    }
    return `re-docked ${diskId} on ${engine} ${noteSuffix}`
}

/** Prefer A: hosts the harness must never touch, regardless of exclude_engines. */
const NEVER_ENGINES = new Set(['idea02'])
const isNeverEngine = (engine: string): boolean => NEVER_ENGINES.has(engine)

const hostnameOfUrl = (raw: string | undefined): string | null => {
    const v = raw?.trim()
    if (!v) return null
    try {
        return new URL(v.includes('://') ? v : `http://${v}`).hostname.toLowerCase()
    } catch {
        return null
    }
}

/**
 * Prefer A r21: the pool engine that serves the Console under test (Path A: idea01).
 * Order: DURATION_SWITCH_ENGINE_HOST → DURATION_CONSOLE_URL hostname (logical name or
 * --hosts IP/hostname reverse-mapped) → pool[0]. Candidates must be in the pool, not
 * excluded, never idea02. NEVER walker.dockedEngine — that follows Kolibri after
 * infra_move_disk (idea03 in cover-all r21), which is not where the Console's
 * EmptyDiskPanel lives.
 */
export const resolveConsoleEngineHost = (
    ctx: Pick<ActionContext, 'poolEngines' | 'excludeEngines'> & { opts: { ops: FleetOps } },
    env: NodeJS.ProcessEnv = process.env,
): string => {
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e) && !isNeverEngine(e))
    if (pool.length === 0) {
        throw new Error('resolveConsoleEngineHost: no pool engines (excluded / never idea02)')
    }
    const hostMap = hostMapFromOps(ctx.opts.ops) ?? {}
    const toLogical = (cand: string | null | undefined): string | null => {
        const c = cand?.trim().toLowerCase()
        if (!c) return null
        const direct = pool.find(e => e.toLowerCase() === c)
        if (direct) return direct
        const viaHost = pool.find(e => (hostMap[e] ?? '').trim().toLowerCase() === c)
        return viaHost ?? null
    }
    return (
        toLogical(env.DURATION_SWITCH_ENGINE_HOST) ??
        toLogical(hostnameOfUrl(env.DURATION_CONSOLE_URL)) ??
        pool[0]!
    )
}

const redockEmpty002Fresh = async (
    ctx: ActionContext,
    label: string,
    noteSuffix: string,
    opts?: { purgeStoreInstances?: boolean },
): Promise<string> => {
    const note = await redockEmptyFresh(ctx, DURATION_UI_FIXTURES.empty2.diskId, label, noteSuffix, opts)
    // idea#168: empty-002 is a fresh Empty pack again.
    ctx.walker.empty002HoldsApp = false
    return note
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
 * instances). idea#168: hooked BEFORE install_app whenever walker.empty002HoldsApp
 * (set by a successful start_after_install, cleared by any empty-002 re-dock) — no
 * longer tied to open_copied_instance, so cover-all-skip-copy gets it too.
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

/**
 * Prefer A r20 FAIL@92: cover-all install_app@88 dirties empty-001 (apps/instances/
 * services + Kid README.md). Pixel make_files_disk then createFilesDisk-refuses
 * ("has other files") but soft-passes on Nextcloud's tree files badge. Re-dock
 * empty-001 fresh (strip non-META) + purge store before make_files_disk Intent.
 * Does NOT move Kolibri back — files_role_added targets this Files Disk, not Grade5A.
 */
export const redockEmpty001BeforeMakeFiles = async (ctx: ActionContext): Promise<string> => {
    // Prefer A r21 FAIL@91: walker.dockedEngine was idea03 (Kolibri after infra_move_disk)
    // so empty-001 was dock-copied onto idea03 while the Console under test is idea01.
    // Always land empty-001 on the Console's engine.
    const target = resolveConsoleEngineHost(ctx)
    return redockEmptyFresh(
        ctx,
        filesDiskTargetId(),
        'redockEmpty001BeforeMakeFiles',
        `before make_files_disk (Console engine ${target}; Empty fresh pack + store purge; createFilesDisk-clean)`,
        { purgeStoreInstances: true, targetEngine: target },
    )
}

/**
 * Prefer A r21: the disk make_files_disk converts — DURATION_EMPTY_DISK_ID or
 * duration-empty-001. Never empty-002 / Grade5A (r21 UI fell through to "Empty Disk 002").
 */
export const filesDiskTargetId = (env: NodeJS.ProcessEnv = process.env): string =>
    env.DURATION_EMPTY_DISK_ID?.trim() || DURATION_UI_FIXTURES.empty.diskId

/**
 * Prefer A r21: before the make_files_disk Intent, wait until the Console engine's
 * store shows the target docked there as a pure Empty disk, and (live) that its slot
 * is a real ext4 mount — Eng 8d98718 createFilesDisk runs `findmnt -no FSTYPE <root>`
 * and refuses anything else ("filesystem: unknown" for a plain dir). Fail loud here
 * instead of letting the Intent fall through to another Empty Disk.
 * DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT=1 skips only the ext4 probe (post-check
 * still fails loud if the files role does not land).
 */
export const preflightFilesDiskTarget = async (
    ctx: ActionContext,
    diskId: string,
    engine: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
    const opsLive = ctx.opts.ops as FleetOps & { findDockedEngine?: unknown }
    // Live only: Console EmptyDiskPanel needs zero instances on the disk. FakeFleetOps
    // dockFixture always seeds a synthetic <disk>-main instance, so skip there.
    const requireNoInstances = typeof opsLive.findDockedEngine === 'function'
    const budget = ctx.opts.fast ? 30_000 : 60_000
    const deadline = Date.now() + budget
    let last = 'unread'
    for (;;) {
        try {
            const view = await ctx.opts.ops.readStore(engine)
            const disk = view.diskDB[diskId]
            const types = disk?.diskTypes ?? []
            const insts = Object.values(view.instanceDB).filter(i => i.diskId === diskId)
            last = `dockedTo=${disk?.dockedTo ?? 'none'} diskTypes=[${types.join(', ')}] instances=${insts.length}`
            const typesOk = types.length === 1 && types[0] === 'empty'
            if (disk?.dockedTo && typesOk && (!requireNoInstances || insts.length === 0)) break
        } catch (e) {
            last = `readStore failed: ${e instanceof Error ? e.message : String(e)}`
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `preflight: ${diskId} not a clean Empty disk on Console engine ${engine} within ${budget}ms ` +
                    `(${last}). Prefer A — fail loud; do not let make_files_disk pick another Empty Disk.`,
            )
        }
        await sleep(400)
    }
    const opsAny = ctx.opts.ops as FleetOps & {
        probeFixtureFsType?: (
            engineId: string,
            diskId: string,
        ) => Promise<{ device: string; dest: string; fsType: string } | null>
    }
    if (typeof opsAny.probeFixtureFsType !== 'function') {
        return `preflight ${diskId} Empty on ${engine} (${last})`
    }
    const skipExt4 = /^(1|true|yes)$/i.test(env.DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT?.trim() ?? '')
    const probe = await opsAny.probeFixtureFsType(engine, diskId)
    const fsNote = probe ? `${probe.dest} fs=${probe.fsType || 'unknown'}` : 'slot not found'
    if (!skipExt4 && probe?.fsType !== 'ext4') {
        throw new Error(
            `preflight: ${diskId} on ${engine} slot ${fsNote} — Engine createFilesDisk requires an ext4 ` +
                `mount at the disk root (findmnt -no FSTYPE); a plain dir reads 'unknown' and is refused ` +
                `("not an ext4 disk"). Atlas Path A: back ${probe?.dest ?? `${engine}:<duration-disks>/idea-test-3`} ` +
                `with a pi-owned ext4 mount (loop image), then re-run. Prefer A — fail loud.`,
        )
    }
    return `preflight ${diskId} Empty on ${engine} (${last}; ${fsNote}${skipExt4 ? '; ext4 preflight skipped' : ''})`
}

/**
 * Prefer A r20: after Pixel make_files_disk ok, confirm store diskTypes includes
 * 'files' on the Empty→Files target. Pixel settle can soft-pass on a foreign
 * [data-role=files] badge (Nextcloud) while createFilesDisk refused dirty root.
 * StubUiDriver skips (Fake has no Engine createFilesDisk). Never idea02.
 */
const assertFilesRoleOnDisk = async (
    ctx: ActionContext,
    diskId: string,
    label: 'make_files_disk' | 'add_files_role' = 'make_files_disk',
): Promise<string> => {
    // Prefer A r21: the Console's engine (where empty-001 was re-docked), not
    // walker.dockedEngine (follows Kolibri after infra_move_disk).
    const engine = resolveConsoleEngineHost(ctx)
    const budget = 30_000
    const deadline = Date.now() + budget
    let lastTypes: string[] = []
    while (Date.now() < deadline) {
        const view = await ctx.opts.ops.readStore(engine)
        const disk = view.diskDB[diskId]
        lastTypes = disk?.diskTypes ?? []
        if (lastTypes.includes('files')) {
            return `store files role on ${diskId} (${lastTypes.join(',')})`
        }
        await sleep(400)
    }
    const why = label === 'add_files_role'
        ? `(createFilesDisk refused the Apps disk root, or Pixel matched a foreign files badge). ` +
          `Prefer A — fail loud; no soft-pass.`
        : `(createFilesDisk refused dirty root, or Pixel matched a foreign files badge). ` +
          `Prefer A — fail loud; do not assert Kolibri Grade5A.`
    throw new Error(
        `${label} soft-pass: disk ${diskId} on ${engine} diskTypes=[${lastTypes.join(', ')}] ` +
            `lack 'files' within ${budget}ms ${why}`,
    )
}

/**
 * Prefer A r22 FAIL@93 (cover-all-6e4ce29-r22): add_files_role is a DIFFERENT Intent
 * from make_files_disk (Add Files on an Apps disk vs Files-from-Empty) — it is never
 * "already satisfied" by the make_files_disk Files Disk (empty-001), and the harness
 * never soft-passes it. Its target is an app-only disk (diskTypes app[/backup], no
 * files): DURATION_ADD_FILES_DISK_ID (dedicated app-only fixture) else the primary
 * Kid fixture (Kolibri Grade5A, explicitly restored onto the Console engine — this is
 * an explicit restore, not a silent Grade5A remap). Refuses Empty packs and the
 * make_files_disk Files Disk (they never offer Add Files).
 */
export const addFilesAppDiskId = (
    ctx: Pick<ActionContext, 'fixtureDisk'>,
    env: NodeJS.ProcessEnv = process.env,
): string => {
    const id = env.DURATION_ADD_FILES_DISK_ID?.trim() || ctx.fixtureDisk
    const filesId = env.DURATION_FILES_DISK_ID?.trim()
    if (!id) {
        throw new Error('add_files_role: no app-only disk id (DURATION_ADD_FILES_DISK_ID / fixtureDisk unset). Prefer A — fail loud.')
    }
    if (/empty/i.test(id) || (filesId && id === filesId)) {
        throw new Error(
            `add_files_role: '${id}' is not an app-only disk (Empty pack / make_files_disk Files Disk ` +
                `never offers Add Files). Set DURATION_ADD_FILES_DISK_ID to an Apps disk. Prefer A — fail loud.`,
        )
    }
    return id
}

/**
 * Prefer A r22 FAIL@93: where diskId is docked right now. Live → findDockedEngine;
 * Fake → scan pool stores for dockedTo.
 */
const locateDockedEngine = async (ctx: ActionContext, diskId: string): Promise<string | null> => {
    const opsAny = ctx.opts.ops as FleetOps & { findDockedEngine?: (id: string) => Promise<string | null> }
    if (typeof opsAny.findDockedEngine === 'function') return opsAny.findDockedEngine(diskId)
    for (const eng of ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))) {
        try {
            const view = await ctx.opts.ops.readStore(eng)
            const docked = view.diskDB[diskId]?.dockedTo
            if (docked) return docked
        } catch {
            /* try next */
        }
    }
    return null
}

/**
 * Prefer A r22 FAIL@93: before add_files_role, make sure an app-only disk is docked
 * on the Console's engine (Path A idea01). cover-all infra_move_disk@62 moved Kolibri
 * Grade5A idea01→idea03, leaving idea01 with Empty Disk (files, from make_files_disk
 * @91), Empty Disk 002, Nextcloud (app+files) and System — no DiskView offers
 * [data-testid="add-files"]. Explicit restore: moveDisk(<holder>→Console engine)
 * (or dockFixture when undocked), live findDockedEngine must confirm landing, then
 * the Console engine store must show diskTypes app[/backup] with no files/empty/
 * system/upgrade (Eng 8d98718 createFilesDisk allowed set), and (live) the slot
 * must be an ext4 mount whose root holds only META.yaml/lost+found/apps/services/
 * instances(/BACKUP.yaml/backups) — createFilesDisk refuses anything else. Fail loud
 * on every miss: no soft-pass, no remap onto the make_files_disk Files Disk, never
 * idea02. DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT=1 skips only the ext4/root probe
 * (post-Intent store check still fails loud).
 */
export const ensureAppOnlyDiskOnConsoleEngine = async (
    ctx: ActionContext,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ diskId: string; engine: string; note: string; movedFixture: boolean }> => {
    const diskId = addFilesAppDiskId(ctx, env)
    const engine = resolveConsoleEngineHost(ctx, env)
    assertNotGolden(ctx, engine, 'add_files_role(restore app-only disk)')
    if (isNeverEngine(engine)) {
        throw new Error(`add_files_role: refused Console engine '${engine}' (never idea02)`)
    }
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    const opsAny = ctx.opts.ops as FleetOps & {
        findDockedEngine?: (id: string) => Promise<string | null>
        probeFixtureFsType?: (
            engineId: string,
            diskId: string,
        ) => Promise<{ device: string; dest: string; fsType: string } | null>
        probeFixtureRootEntries?: (
            engineId: string,
            diskId: string,
        ) => Promise<{ dest: string; entries: string[] } | null>
    }
    const isLive = typeof opsAny.findDockedEngine === 'function'

    const holder = await locateDockedEngine(ctx, diskId)
    let moveNote: string
    let moved = false
    if (holder === engine) {
        moveNote = `${diskId} already docked on Console engine ${engine}`
    } else {
        if (holder && (ctx.excludeEngines.includes(holder) || isNeverEngine(holder))) {
            throw new Error(
                `add_files_role: ${diskId} docked on excluded/never engine '${holder}'; refuse to move. Prefer A — never idea02.`,
            )
        }
        if (holder) {
            await ctx.opts.ops.moveDisk(holder, engine, diskId)
            moveNote = `restored ${diskId} ${holder}→${engine} (Console engine) before add_files_role`
        } else {
            await ctx.opts.ops.dockFixture(engine, diskId)
            moveNote = `docked ${diskId} on ${engine} (Console engine) before add_files_role`
        }
        moved = true
        await settleParticipants(ctx, pool)
        if (isLive) {
            const landed = await opsAny.findDockedEngine!(diskId)
            if (landed !== engine) {
                throw new Error(
                    `add_files_role: restore of ${diskId} landed on ${landed ?? 'nowhere'} not ${engine} ` +
                        `(Console engine; RealFleetOps healthy-tree redirect?). Prefer A — fail loud; never idea02.`,
                )
            }
        }
    }

    // Store: app-only on the Console engine (Add Files offered only without files role).
    const budget = isLive ? (ctx.opts.fast ? 60_000 : 120_000) : 2_000
    const deadline = Date.now() + budget
    let last = 'unread'
    for (;;) {
        try {
            const view = await ctx.opts.ops.readStore(engine)
            const disk = view.diskDB[diskId]
            const types = disk?.diskTypes ?? []
            last = `dockedTo=${disk?.dockedTo ?? 'none'} diskTypes=[${types.join(', ')}]`
            if (types.includes('files')) {
                throw new Error(
                    `add_files_role: ${diskId} on ${engine} already has a files role (${last}) — ` +
                        `DiskView will not offer Add Files. Re-dock a fresh app-only pack (Atlas Path A). Prefer A — fail loud, no soft-pass.`,
                )
            }
            const forbidden = types.filter(t => t === 'empty' || t === 'system' || t === 'upgrade')
            if (forbidden.length) {
                throw new Error(
                    `add_files_role: ${diskId} on ${engine} is not an app-only disk (${last}). Prefer A — fail loud.`,
                )
            }
            // Fake dock leaves diskTypes unset for app packs; live must show 'app'.
            const appOk = isLive ? types.includes('app') : true
            if (disk?.dockedTo && appOk) break
        } catch (e) {
            if (e instanceof Error && e.message.startsWith('add_files_role:')) throw e
            last = `readStore failed: ${e instanceof Error ? e.message : String(e)}`
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `add_files_role: no app-only disk on Console engine ${engine} within ${budget}ms ` +
                    `(${diskId}: ${last}). Prefer A — fail loud; no soft-pass / no remap onto the make_files_disk Files Disk.`,
            )
        }
        await sleep(400)
    }

    // Live: Eng 8d98718 createFilesDisk needs only role entries in the root (META.yaml,
    // lost+found, apps/services/instances, BACKUP.yaml/backups) AND an ext4 root. Kid
    // app packs (kolibri, kolibri-form3, kiwix) ship `content/` at the root, so stock
    // Kolibri Grade5A is refused ("has other files on it (content)") — report every
    // problem in one loud error so Atlas/Kid can fix the fixture in one pass.
    let fsNote = ''
    const skip = /^(1|true|yes)$/i.test(env.DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT?.trim() ?? '')
    if (skip) {
        fsNote = '; ext4/root preflight skipped'
    } else {
        const problems: string[] = []
        if (typeof opsAny.probeFixtureRootEntries === 'function') {
            const root = await opsAny.probeFixtureRootEntries(engine, diskId)
            if (root) {
                const allowed = new Set(['META.yaml', 'lost+found', 'apps', 'services', 'instances', 'BACKUP.yaml', 'backups'])
                const others = root.entries.filter(e => !allowed.has(e)).sort()
                if (others.length) {
                    problems.push(
                        `root ${root.dest} has non-IDEA entries (${others.join(', ')}) — createFilesDisk refuses ` +
                            `("has other files on it")`,
                    )
                } else {
                    fsNote += '; root clean'
                }
            }
        }
        if (typeof opsAny.probeFixtureFsType === 'function') {
            const probe = await opsAny.probeFixtureFsType(engine, diskId)
            const fs = probe ? `${probe.dest} fs=${probe.fsType || 'unknown'}` : 'slot not found'
            if (probe?.fsType !== 'ext4') {
                problems.push(`slot ${fs} — createFilesDisk requires an ext4 mount at the disk root ("not an ext4 disk")`)
            } else {
                fsNote = `; ${fs}${fsNote}`
            }
        }
        if (problems.length) {
            throw new Error(
                `add_files_role preflight: app-only ${diskId} on ${engine} cannot take a files role on Eng 8d98718: ` +
                    `${problems.join('; ')}. Atlas/Kid Path A: provide an app-only disk whose root is only ` +
                    `META.yaml/apps/services/instances on a pi-owned ext4 mount (DURATION_ADD_FILES_DISK_ID), ` +
                    `or fix the Kolibri slot. Prefer A — fail loud; no soft-pass / no Grade5A remap.`,
            )
        }
    }

    if (diskId === ctx.fixtureDisk && moved && /kolibri/i.test(diskId)) {
        syncKolibriSidecarUrlForEngine(engine, hostMapFromOps(ctx.opts.ops), env)
    }
    return {
        diskId,
        engine,
        note: `${moveNote}; app-only ${diskId} on ${engine} (${last}${fsNote})`,
        movedFixture: moved && diskId === ctx.fixtureDisk,
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
    // Prefer Atlas/Kid pre-docked engine (Path A) — RealFleetOps.findDockedEngine when live.
    const opsAny = ctx.opts.ops as FleetOps & { findDockedEngine?: (diskId: string) => Promise<string | null> }
    if (typeof opsAny.findDockedEngine === 'function') {
        const existing = await opsAny.findDockedEngine(ctx.fixtureDisk)
        if (existing && !ctx.excludeEngines.includes(existing)) {
            await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
            const kolibriUrl = syncKolibriSidecarUrlForEngine(existing, hostMapFromOps(ctx.opts.ops))
            const ncReady = await maybeWaitNextcloudAfterDock(ctx, existing)
            const ncMsg = ncReady ? `; ${ncReady}` : ''
            return {
                ok: true,
                message: `fixture ${ctx.fixtureDisk} already docked on ${existing} (no-op); DURATION_KOLIBRI_URL=${kolibriUrl}${ncMsg}`,
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
    const kolibriUrl = syncKolibriSidecarUrlForEngine(engine, hostMapFromOps(ctx.opts.ops))
    const ncReady = await maybeWaitNextcloudAfterDock(ctx, engine)
    const ncMsg = ncReady ? `; ${ncReady}` : ''
    return {
        ok: true,
        message: `docked ${ctx.fixtureDisk}${sibMsg} on ${engine}; DURATION_KOLIBRI_URL=${kolibriUrl}${ncMsg}`,
        dockedEngine: engine,
        layer: 'infra',
    }
}


/**
 * Prefer A cover-all-230b70f-r15 FAIL@70: Console Path B `resolveSidecarUrl` uses the
 * Console page hostname (idea01) unless `DURATION_KOLIBRI_URL` is set. After
 * `infra_move_disk` moves the kolibri fixture to idea03, Path B still probed
 * idea01:18080 → ECONNREFUSED. Engine owns follow-host: point env at the dock host.
 * Host from RealFleetOps.getHostMap() (Tailscale IP) when live; else logical id.
 */
export const syncKolibriSidecarUrlForEngine = (
    engineId: string,
    hosts: Record<string, string> | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string => {
    const authority = (hosts?.[engineId]?.trim() || engineId).replace(/\/$/, '')
    const portRaw = env.DURATION_KOLIBRI_PORT?.trim()
    const port = portRaw && /^\d+$/.test(portRaw) ? portRaw : '18080'
    const url = `http://${authority}:${port}`
    env.DURATION_KOLIBRI_URL = url
    return url
}

/**
 * Prefer A cover-all-230b70f-r16 FAIL@65 / r17 FAIL@58: after infra_dock_fixture
 * re-docks NC, poll readiness then set DURATION_NEXTCLOUD_URL. Unlike Kolibri
 * (Path B may need Tailscale IP from hostMap), Nextcloud trusted_domains includes
 * the Engine logical id (idea01) but not the Tailscale IP — probe by hostname.
 * `hosts` is accepted for call-site parity with Kolibri but ignored for the URL.
 * Honors DURATION_NEXTCLOUD_URL / DURATION_NEXTCLOUD_PORT when already set.
 */
export const syncNextcloudSidecarUrlForEngine = (
    engineId: string,
    _hosts: Record<string, string> | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string => {
    const existing = env.DURATION_NEXTCLOUD_URL?.trim()
    if (existing) {
        const url = existing.replace(/\/$/, '')
        env.DURATION_NEXTCLOUD_URL = url
        return url
    }
    // Logical engine id / hostname — not hosts[engineId] Tailscale IP (r17 FAIL@58).
    const authority = engineId.replace(/\/$/, '')
    const portRaw = env.DURATION_NEXTCLOUD_PORT?.trim()
    const port = portRaw && /^\d+$/.test(portRaw) ? portRaw : '18280'
    const url = `http://${authority}:${port}`
    env.DURATION_NEXTCLOUD_URL = url
    return url
}

/** Poll budget for NC login-form readiness after dock. Default 420 s (was 180 s; services/*.tar load, startBudgets.ts). */
export const nextcloudReadyTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
    envMs(env, 'DURATION_NEXTCLOUD_READY_MS', DEFAULT_NEXTCLOUD_READY_MS)

/**
 * Decode a Nextcloud `initial-state-<app>-<key>` hidden input value (base64 JSON).
 * Returns null when the input is absent or undecodable. Attribute order agnostic.
 */
export const nextcloudInitialState = (html: string, app: string, key: string): string | null => {
    const id = `initial-state-${app}-${key}`
    const tagRe = /<input\b[^>]*>/gi
    for (const m of html.matchAll(tagRe)) {
        const tag = m[0]
        const idMatch = /\bid=["']([^"']+)["']/i.exec(tag)
        if (!idMatch || idMatch[1] !== id) continue
        const valMatch = /\bvalue=["']([^"']*)["']/i.exec(tag)
        if (!valMatch) return null
        try {
            return Buffer.from(valMatch[1], 'base64').toString('utf8').trim()
        } catch {
            return null
        }
    }
    return null
}

/**
 * True when HTML looks like a ready Nextcloud login page. Two paths (OR):
 *
 * A) Vue client-rendered login (NC 31 on idea01:18280): server HTML has
 *    `<body id="body-login">` + `initial-state-core-hideLoginForm` whose base64
 *    value decodes to `false` (ZmFsc2U=). The form inputs are built by core-login.js,
 *    so they never appear in the HTTP body. cover-all-230b70f-r19 FAIL@58
 *    infra_dock_fixture burned the full 180s budget on a healthy NC because only (B)
 *    existed. Fixture: test/duration/fixtures/nextcloud-login-vue.html
 *    (Atlas Path A evidence path-a-ready-r19).
 *
 * B) Classic server-rendered form (Console NC_SELECTORS signals):
 *    user + password + submit.
 *
 * Used by Engine harness HTTP poll — no Playwright.
 */
export const nextcloudLoginFormLooksReady = (html: string): boolean => {
    const bodyLogin = /<body\b[^>]*\bid=["']body-login["']/i.test(html)
    if (bodyLogin && nextcloudInitialState(html, 'core', 'hideLoginForm') === 'false') {
        return true
    }
    const hasUser =
        /name=["']user["']|id=["']user["']|data-login-form-input-user/i.test(html)
    const hasPassword =
        /name=["']password["']|id=["']password["']|data-login-form-input-password/i.test(html)
    const hasSubmit = /type=["']submit["']|data-login-form-submit/i.test(html)
    return hasUser && hasPassword && hasSubmit
}

export type WaitNextcloudSidecarOpts = {
    hosts?: Record<string, string>
    env?: NodeJS.ProcessEnv
    /** Skip network poll (FakeFleetOps / non-live). */
    skip?: boolean
    /** Inject fetch for unit tests. */
    fetchImpl?: typeof fetch
    /** Inject sleep for unit tests. */
    sleepImpl?: (ms: number) => Promise<void>
}

/**
 * Poll GET http://<engineId>:18280/login until body looks like NC login form.
 * Sets DURATION_NEXTCLOUD_URL to logical hostname (not Tailscale IP — r17 FAIL@58
 * trusted_domains). Loud-fail citing r16 FAIL@65. No Playwright — Node fetch only.
 */
export const waitNextcloudSidecarReadyForEngine = async (
    engineId: string,
    opts: WaitNextcloudSidecarOpts = {},
): Promise<string> => {
    const env = opts.env ?? process.env
    const base = syncNextcloudSidecarUrlForEngine(engineId, opts.hosts, env)
    if (opts.skip) {
        return `DURATION_NEXTCLOUD_URL=${base} (wait skipped)`
    }
    const budget = nextcloudReadyTimeoutMs(env)
    const t0 = Date.now()
    const deadline = t0 + budget
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch
    const sleepImpl = opts.sleepImpl ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    const loginUrl = `${base.replace(/\/$/, '')}/login`
    let last = 'no-attempt'
    while (Date.now() < deadline) {
        try {
            const resp = await fetchImpl(loginUrl, {
                redirect: 'follow',
                signal: AbortSignal.timeout(5_000),
            })
            const status = resp.status
            if (status >= 200 && status < 400) {
                const html = await resp.text()
                if (nextcloudLoginFormLooksReady(html)) {
                    const ms = Date.now() - t0
                    logStartMeasured({ what: 'nextcloud_ready', engine: engineId, ms, budgetMs: budget })
                    return `DURATION_NEXTCLOUD_URL=${base} (login form ready after ${ms}ms, budget ${budget}ms)`
                }
                last = `HTTP ${status} login-form incomplete (body-login+hideLoginForm=false | user/password/submit)`
            } else {
                last = `HTTP ${status}`
            }
        } catch (err) {
            last = err instanceof Error ? err.message : String(err)
        }
        await sleepImpl(1_000)
    }
    throw new Error(
        `Nextcloud sidecar not ready: ${loginUrl} within ${budget}ms (last=${last}). ` +
            `cover-all-230b70f-r16 FAIL@65 open_nextcloud_as_teacher — NC still booting after ` +
            `infra_dock_fixture; Engine must poll :18280 login form (mirror Kolibri ` +
            `waitForSidecarHttpReady). Set DURATION_NEXTCLOUD_READY_MS / DURATION_NEXTCLOUD_URL|PORT.`,
    )
}

/** True when Nextcloud Grade5A (or any nextcloud disk) is among fixtures. */
export const fixtureSetHasNextcloud = (
    fixtureDisk: string,
    fixtureDisks: string[],
): boolean => {
    const all = [fixtureDisk, ...fixtureDisks]
    return all.some(d => /nextcloud/i.test(d))
}

/**
 * After dock+settle: when NC is in the fixture set and ops are live (RealFleetOps),
 * wait until :18280 login form is ready. Fake / non-live → sync URL only, no poll.
 */
const maybeWaitNextcloudAfterDock = async (
    ctx: ActionContext,
    engineId: string,
): Promise<string | null> => {
    if (!fixtureSetHasNextcloud(ctx.fixtureDisk, ctx.fixtureDisks)) return null
    const opsAny = ctx.opts.ops as FleetOps & { findDockedEngine?: unknown }
    const isLive = typeof opsAny.findDockedEngine === 'function'
    return waitNextcloudSidecarReadyForEngine(engineId, {
        hosts: hostMapFromOps(ctx.opts.ops),
        skip: !isLive,
    })
}

const hostMapFromOps = (ops: FleetOps): Record<string, string> | undefined => {
    const anyOps = ops as FleetOps & { getHostMap?: () => Record<string, string> }
    if (typeof anyOps.getHostMap === 'function') return anyOps.getHostMap()
    return undefined
}

const infraMoveDisk = async (ctx: ActionContext): Promise<ActionResult> => {
    const from = ctx.walker.dockedEngine ?? pickPoolEngine(ctx)
    assertNotGolden(ctx, from, 'infra_move_disk(from)')
    const to = pickPoolEngine(ctx, from)
    assertNotGolden(ctx, to, 'infra_move_disk(to)')
    // idea#168 r35@62: the move duration is logged explicitly (success and failure).
    const moveStartedAt = Date.now()
    try {
        if (from === to) {
            // Single-engine pool: treat as re-dock settle (document limitation).
            await ctx.opts.ops.dockFixture(to, ctx.fixtureDisk)
        } else {
            await ctx.opts.ops.moveDisk(from, to, ctx.fixtureDisk)
        }
    } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        const ms = Date.now() - moveStartedAt
        console.log(`[infra_move_disk] ${ctx.fixtureDisk} ${from}→${to}: FAILED after ${ms}ms`)
        throw new Error(
            `infra_move_disk: target ${to} could not take ${ctx.fixtureDisk} (${from}→${to}): ${err}. ` +
                `No soft-pass; no fallback host. infra_move_disk move_ms=${ms}.`,
        )
    }
    const moveMs = Date.now() - moveStartedAt
    console.log(`[infra_move_disk] ${ctx.fixtureDisk} ${from}→${to}: moved in ${moveMs}ms`)
    await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
    // cover-all-980e735-r29 FAIL@97: @62 "moved idea01→idea03" while the disk was
    // re-docked on idea01. Verify disk AND fixture instance host == target in the
    // store before passing; then derive the sidecar URLs from that verified host.
    const landed = await locateDockedEngine(ctx, ctx.fixtureDisk)
    if (landed !== to) {
        throw new Error(
            `infra_move_disk: ${ctx.fixtureDisk} requested on target ${to} (${from}→${to}) but the store ` +
                `shows it docked on ${landed ?? 'no pool engine'}. No soft-pass; refusing to record a different host.`,
        )
    }
    const inst = await locateInstanceEngine(ctx, ctx.fixtureInstance, ctx.fixtureDisk)
    if (!inst.live || inst.engine !== to) {
        throw new Error(
            `infra_move_disk: ${ctx.fixtureInstance} host in store is ${inst.live ? inst.engine : 'none (not docked/Undocked)'} ` +
                `(disk ${inst.diskId}), not target ${to}. No soft-pass.`,
        )
    }
    const urls = await resyncFixtureSidecarUrlsFromStore(ctx)
    const moveMsg =
        from === to
            ? `re-docked on sole pool engine ${to}`
            : `moved ${ctx.fixtureDisk} ${from}→${to} in ${moveMs}ms (move_ms=${moveMs}; store-verified: disk + ${ctx.fixtureInstance} on ${to})`
    return {
        ok: true,
        message: `${moveMsg}; ${urls}`,
        dockedEngine: to,
        layer: 'infra',
    }
}

/**
 * cover-all-980e735-r29 FAIL@97: return the pool engine whose store shows instanceId
 * on a docked disk (unique store: other engines keep an Undocked copy of the row).
 * Falls back to fallbackDiskId when no store has a live row. Never returns an
 * excluded (golden idea02) engine.
 */
export const locateInstanceEngine = async (
    ctx: ActionContext,
    instanceId: string,
    fallbackDiskId: string,
): Promise<{ engine: string | null; diskId: string; live: boolean }> => {
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    let diskId = fallbackDiskId
    let live = false
    for (const eng of pool) {
        try {
            const view = await ctx.opts.ops.readStore(eng)
            const inst = view.instanceDB[instanceId]
            if (inst?.diskId && inst.status !== 'Undocked') {
                diskId = inst.diskId
                live = true
                break
            }
        } catch {
            /* try next */
        }
    }
    const engine = await locateDockedEngine(ctx, diskId)
    if (!engine || ctx.excludeEngines.includes(engine)) return { engine: null, diskId, live: false }
    return { engine, diskId, live }
}

/** Intents whose Console implementation polls a sidecar URL after Confirm. */
export const SIDECAR_SETTLE_ACTIONS = new Set(['restore_from_backup', 'move_app', 'copy_app'])

/** True when url's hostname is a pool engine id or its host-map address (harness-managed). */
const isHarnessManagedUrl = (
    url: string | undefined,
    pool: string[],
    hosts: Record<string, string> | undefined,
): boolean => {
    if (!url?.trim()) return true
    try {
        const h = new URL(url.trim()).hostname
        return pool.includes(h) || Object.values(hosts ?? {}).includes(h)
    } catch {
        return false
    }
}

/**
 * cover-all-980e735-r29 FAIL@97: DURATION_KOLIBRI_URL stayed on idea03 from @62 while
 * the store had kolibri-grade5a-001 Running on idea01, so the restore settle polled a
 * host with nothing on :18080. Before every sidecar-settle Intent, re-read the live
 * host of the Kolibri (and Nextcloud) fixture instance from the store and point the
 * env at it. Nextcloud is only rewritten when its URL is harness-managed (unset or a
 * pool hostname/IP), so manual overrides survive. Never points at an excluded engine.
 */
export const resyncFixtureSidecarUrlsFromStore = async (
    ctx: ActionContext,
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    const hosts = hostMapFromOps(ctx.opts.ops)
    const notes: string[] = []
    const entries = Object.entries(ctx.fixtureInstances)
    const kolibri =
        entries.find(([d]) => /kolibri/i.test(d)) ??
        (/kolibri/i.test(ctx.fixtureDisk) ? ([ctx.fixtureDisk, ctx.fixtureInstance] as const) : undefined)
    if (kolibri) {
        const [diskId, instId] = kolibri
        const { engine } = await locateInstanceEngine(ctx, instId, diskId)
        const prev = env.DURATION_KOLIBRI_URL
        if (engine) {
            const url = syncKolibriSidecarUrlForEngine(engine, hosts, env)
            notes.push(
                `DURATION_KOLIBRI_URL=${url} (store: ${instId} on ${engine}` +
                    `${prev && prev.replace(/\/$/, '') !== url ? `; was ${prev}` : ''})`,
            )
        } else {
            notes.push(`${instId} not docked on any pool engine; DURATION_KOLIBRI_URL unchanged (${prev ?? 'unset'})`)
        }
    }
    const nc = entries.find(([d]) => /nextcloud/i.test(d))
    if (nc) {
        const [diskId, instId] = nc
        const { engine } = await locateInstanceEngine(ctx, instId, diskId)
        const prev = env.DURATION_NEXTCLOUD_URL
        if (engine && isHarnessManagedUrl(prev, pool, hosts)) {
            const portRaw = env.DURATION_NEXTCLOUD_PORT?.trim()
            const port = portRaw && /^\d+$/.test(portRaw) ? portRaw : '18280'
            // Logical hostname, not Tailscale IP (NC trusted_domains, r17 FAIL@58).
            const url = `http://${engine}:${port}`
            env.DURATION_NEXTCLOUD_URL = url
            notes.push(
                `DURATION_NEXTCLOUD_URL=${url} (store: ${instId} on ${engine}` +
                    `${prev && prev.replace(/\/$/, '') !== url ? `; was ${prev}` : ''})`,
            )
        } else if (engine) {
            notes.push(`DURATION_NEXTCLOUD_URL=${prev} kept (manual override)`)
        }
    }
    return notes.join('; ')
}

export type DurationOperationRow = {
    id: string
    kind: string
    status: string
    startedAt: number | null
    completedAt?: number | null
    error?: string | null
    args?: Record<string, string>
}

/**
 * cover-all-980e735-r29 FAIL@97: Eng 8d98718 rejected `restoreApp kolibri Duration Tests —
 * Add Files App` ("Too many arguments", space-split disk name): no Operation, no instance,
 * no container. With a correct sidecar URL the Console settle would have seen the
 * untouched original instance and passed. Require, on live ops:
 *   1. a restoreApp Operation started after Confirm that ended Done (pool engines only);
 *   2. its instance in the store, storedOn the op's targetDiskId, Running, on a docked disk;
 *   3. a running container for that instance on the host the store reports (when
 *      ops.listInstanceContainers exists).
 * Returns null when unavailable (Fake ops / stub). `reason` is machine-checkable.
 */
export const verifyRestoreOperation = async (
    ctx: ActionContext,
    sinceMs: number,
    slackMs = 60_000,
): Promise<{ ok: boolean; reason: 'ok' | 'never_started' | 'not_done' | 'no_instance' | 'no_container'; note: string } | null> => {
    const opsAny = ctx.opts.ops as FleetOps & {
        listOperations?: (engineId: string) => Promise<DurationOperationRow[]>
        listInstanceContainers?: (engineId: string, instanceId: string) => Promise<string[]>
    }
    if (typeof opsAny.listOperations !== 'function') return null
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))
    const found: (DurationOperationRow & { engine: string })[] = []
    const readErrors: string[] = []
    for (const eng of pool) {
        try {
            const rows = await opsAny.listOperations(eng)
            for (const r of rows) {
                if (r.kind !== 'restoreApp') continue
                if (typeof r.startedAt !== 'number' || r.startedAt < sinceMs - slackMs) continue
                found.push({ ...r, engine: eng })
            }
        } catch (e) {
            readErrors.push(`${eng}: ${e instanceof Error ? e.message : String(e)}`)
        }
    }
    const errNote = readErrors.length ? ` (store read errors: ${readErrors.join('; ')})` : ''
    if (!found.length) {
        return {
            ok: false,
            reason: 'never_started',
            note:
                `restore op never started: no restoreApp Operation since Confirm on any pool engine${errNote}. ` +
                `Engine rejected the command before execution? (r29: Eng 8d98718 split ` +
                `"restoreApp <instance> <targetDiskName>" on spaces → "Too many arguments"). ` +
                `Engine/Console restore bug — no soft-pass.`,
        }
    }
    const done = found.find(r => r.status === 'Done')
    if (!done) {
        const desc = found
            .map(r => `${r.id}@${r.engine}=${r.status}${r.error ? ` (${r.error})` : ''}`)
            .join(', ')
        return { ok: false, reason: 'not_done', note: `restore op did not end Done: ${desc}. No soft-pass.` }
    }
    const instId = done.args?.instanceId
    const targetDiskId = done.args?.targetDiskId
    if (!instId || !targetDiskId) {
        return {
            ok: false,
            reason: 'no_instance',
            note: `restore op ${done.id} Done on ${done.engine} but carries no instanceId/targetDiskId args. No soft-pass.`,
        }
    }
    const host = await locateDockedEngine(ctx, targetDiskId)
    let instNote = 'unread'
    let instOk = false
    if (host && !ctx.excludeEngines.includes(host)) {
        try {
            const view = await ctx.opts.ops.readStore(host)
            const row = view.instanceDB[instId]
            instNote = row ? `${instId} status=${row.status} storedOn=${row.diskId}` : `${instId} absent`
            instOk = !!row && row.diskId === targetDiskId && row.status === 'Running'
        } catch (e) {
            instNote = `readStore(${host}) failed: ${e instanceof Error ? e.message : String(e)}`
        }
    } else {
        instNote = `target disk ${targetDiskId} not docked on any pool engine`
    }
    if (!instOk) {
        return {
            ok: false,
            reason: 'no_instance',
            note:
                `restore op ${done.id} Done on ${done.engine} but no restored instance Running on ` +
                `${targetDiskId}@${host ?? 'nowhere'} (${instNote}). No soft-pass.`,
        }
    }
    let ctrNote = 'container check unavailable'
    if (typeof opsAny.listInstanceContainers === 'function') {
        let names: string[] = []
        try {
            names = await opsAny.listInstanceContainers(host!, instId)
        } catch (e) {
            ctrNote = `docker ps failed: ${e instanceof Error ? e.message : String(e)}`
        }
        if (!names.length) {
            return {
                ok: false,
                reason: 'no_container',
                note:
                    `restore op ${done.id} Done and ${instId} Running on ${targetDiskId}@${host} in the store, ` +
                    `but no running container ${instId}-* on ${host} (${ctrNote}). No soft-pass.`,
            }
        }
        ctrNote = `container ${names.join(',')} on ${host}`
    }
    const opMs = typeof done.completedAt === 'number' && typeof done.startedAt === 'number' ? done.completedAt - done.startedAt : null
    if (opMs != null) logStartMeasured({ what: 'restore_op', engine: done.engine, instanceId: instId, diskId: targetDiskId, ms: opMs, opMs })
    return {
        ok: true,
        reason: 'ok',
        note: `restore op ${done.id} Done on ${done.engine}${opMs != null ? ` in ${opMs}ms` : ''}; ${instId} Running on ${targetDiskId}@${host}; ${ctrNote}`,
    }
}

// ── r30: backup_instance must leave a real archive before restore_from_backup ──────

export type BackupDiskProbe = { dest: string; backupYaml: string | null; repoEntries: string[] | null }

/**
 * r36@98: one Engine CommandLog trace (read-only). Eng handleCommand writes a trace for
 * every queued command, also for a refusal before execution ("Too many arguments",
 * "Instance … ambiguous"), so a refused command is visible even without an Operation.
 * `args` is the trace's JSON string (named object, or the token array on a parse refusal).
 */
export type DurationCommandTrace = {
    traceId: string
    command: string
    args: string
    status: string
    startedAt: number | null
    completedAt: number | null
    errorMessage: string | null
}

type BackupOps = FleetOps & {
    listOperations?: (engineId: string) => Promise<DurationOperationRow[]>
    probeBackupDisk?: (engineId: string, diskId: string, instanceId: string) => Promise<BackupDiskProbe | null>
    listCommandTraces?: (engineId: string) => Promise<DurationCommandTrace[]>
}

/** Tokens of a trace's args: a JSON array as is, a named object's values (arrays flattened). */
export const traceArgTokens = (args: string): string[] => {
    let v: unknown
    try {
        v = JSON.parse(args)
    } catch {
        return args ? [args] : []
    }
    const flat = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(flat) : x == null ? [] : [String(x)])
    if (Array.isArray(v)) return flat(v)
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(flat)
    return v == null ? [] : [String(v)]
}

/**
 * r36@98: why a backupApp the Console sent never became an Operation, from the Engine's
 * own CommandLog trace. Eng backupApp takes exactly `<instanceIdOrName> <backupDiskIdOrName>`
 * (space-split): more tokens means the Console sent display names with spaces, i.e. a
 * Console build without the r30 id contract (Console c981361: `backupApp <instanceId>
 * <backupDiskId>`). Returns '' when the trace is not a refusal.
 */
export const diagnoseBackupTrace = (t: DurationCommandTrace, expect: { instanceId: string }): string => {
    if (t.status !== 'error') return ''
    const tokens = traceArgTokens(t.args)
    const err = (t.errorMessage ?? '').trim()
    if (/too many arguments/i.test(err) || tokens.length > 2) {
        return (
            `the Console sent ${tokens.length} space-separated tokens (${JSON.stringify(tokens)}), but Engine backupApp ` +
            `takes exactly <instanceId> <backupDiskId>: display names with spaces were sent instead of ids. ` +
            `The Console the Engine serves predates the r30 id contract (Console c981361+ sends ` +
            `"backupApp ${expect.instanceId} <backupDiskId>") — check the deployed Console build (console_deploy_preflight)`
        )
    }
    if (/ambiguous/i.test(err)) {
        return `the instance/disk argument was a non-unique name (${JSON.stringify(tokens)}); a Console with the r30 id contract sends ids`
    }
    if (/not found|not (currently )?docked|not docked to this engine/i.test(err)) {
        return `the Engine could not resolve ${JSON.stringify(tokens)} on the engine the Console addressed (stale engine/disk?)`
    }
    return `Engine refused ${JSON.stringify(tokens)}`
}

/** Eng backupMonitor LOCK_FILE: present while (or after a failed) borg create. */
export const BACKUP_IN_PROGRESS_MARKER = '.backup-in-progress'

/**
 * BACKUP.yaml `links[].lastBackup` for instanceId. `undefined` = no BACKUP.yaml / no link
 * for the instance; a number otherwise (0 = configured, never backed up).
 */
export const backupYamlLastBackup = (raw: string | null, instanceId: string): number | undefined => {
    if (raw == null) return undefined
    let doc: unknown
    try {
        doc = parseYaml(raw)
    } catch {
        return undefined
    }
    const links = (doc as { links?: unknown } | null)?.links
    if (!Array.isArray(links)) return undefined
    const link = links.find(l => (l as { instanceId?: unknown })?.instanceId === instanceId) as
        | { lastBackup?: unknown }
        | undefined
    if (!link) return undefined
    const n = Number(link.lastBackup ?? 0)
    return Number.isFinite(n) ? n : 0
}

/** Live harness capability: read-only Backup Disk probe (RealFleetOps). Fake walks skip. */
export const hasBackupProbe = (ctx: ActionContext): boolean =>
    typeof (ctx.opts.ops as BackupOps).probeBackupDisk === 'function'

/**
 * r30 preflight before the backup_instance Intent (live only). Console 0760c01
 * InstanceRow shows `backup-instance-<id>` only for a Backup Disk that is docked on the
 * SAME engine as the instance's disk and links the instance (InstanceList
 * resolveBackupDisks), and Eng backupInstance writes borg on the local device. After a
 * real infra_move_disk@62 Kolibri sits on idea03 while make_backup_disk@95 configured
 * empty-00x on the Console engine — co-locate by moving the APP disk to the Backup Disk's
 * engine (verified moveDisk; never the Backup Disk: an empty-pack re-dock wipes
 * BACKUP.yaml). Returns the Backup Disk + its BACKUP.yaml lastBackup before the Intent.
 */
export const ensureBackupDiskForInstance = async (
    ctx: ActionContext,
    instanceId: string,
    appDiskId: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{
    backupDiskId: string
    engine: string
    priorLastBackup: number
    movedTo: string | null
    note: string
}> => {
    const ops = ctx.opts.ops as BackupOps
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e) && !isNeverEngine(e))
    const inst = await locateInstanceEngine(ctx, instanceId, appDiskId)
    if (!inst.engine || !inst.live) {
        throw new Error(
            `backup_instance: ${instanceId} is not live on any pool engine (disk ${inst.diskId}: ` +
                `${inst.engine ? `docked on ${inst.engine}, instance Undocked` : 'not docked'}). No soft-pass.`,
        )
    }
    // Backup Disks linked to the instance, docked on a pool engine (shared store: any view).
    const candidates: { id: string; engine: string }[] = []
    const seen = new Set<string>()
    for (const eng of pool) {
        let view: SemanticStoreView
        try {
            view = await ctx.opts.ops.readStore(eng)
        } catch {
            continue
        }
        for (const d of Object.values(view.diskDB)) {
            if (seen.has(d.id) || !d.dockedTo || !d.diskTypes?.includes('backup')) continue
            if (!pool.includes(d.dockedTo)) continue
            if (d.backupLinks && !d.backupLinks.includes(instanceId)) continue
            seen.add(d.id)
            candidates.push({ id: d.id, engine: d.dockedTo })
        }
    }
    if (!candidates.length) {
        throw new Error(
            `backup_instance: no docked Backup Disk linked to ${instanceId} on any pool engine ` +
                `(${pool.join(', ')}) — make_backup_disk must link it first; Console shows Back up only ` +
                `for a linked Backup Disk on the instance's engine. No soft-pass.`,
        )
    }
    const pinned = env.DURATION_BACKUP_DISK_ID?.trim()
    const chosen =
        candidates.find(c => c.engine === inst.engine) ??
        candidates.find(c => c.id === pinned) ??
        candidates[0]!
    let movedTo: string | null = null
    let moveNote = `${instanceId} on ${inst.engine} with Backup Disk ${chosen.id}`
    if (chosen.engine !== inst.engine) {
        assertNotGolden(ctx, chosen.engine, 'backup_instance(co-locate app disk)')
        try {
            await ctx.opts.ops.moveDisk(inst.engine, chosen.engine, inst.diskId)
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            throw new Error(
                `backup_instance: could not co-locate ${inst.diskId} ${inst.engine}→${chosen.engine} ` +
                    `(Backup Disk ${chosen.id} lives there): ${err}. No soft-pass.`,
            )
        }
        await settleParticipants(ctx, [inst.engine, chosen.engine])
        const after = await locateInstanceEngine(ctx, instanceId, inst.diskId)
        if (after.engine !== chosen.engine || !after.live) {
            throw new Error(
                `backup_instance: co-locate ${inst.diskId} ${inst.engine}→${chosen.engine} did not land ` +
                    `(store: ${instanceId} on ${after.engine ?? 'none'}${after.live ? '' : ', not live'}). No soft-pass.`,
            )
        }
        movedTo = chosen.engine
        moveNote = `co-located ${inst.diskId} ${inst.engine}→${chosen.engine} (store-verified) with Backup Disk ${chosen.id}`
    }
    let priorLastBackup = 0
    if (typeof ops.probeBackupDisk === 'function') {
        const probe = await ops.probeBackupDisk(chosen.engine, chosen.id, instanceId)
        if (!probe) {
            throw new Error(
                `backup_instance: Backup Disk ${chosen.id} on ${chosen.engine} has no known idea-test-N slot ` +
                    `(cannot verify the archive afterwards). No soft-pass.`,
            )
        }
        const lb = backupYamlLastBackup(probe.backupYaml, instanceId)
        if (lb === undefined) {
            throw new Error(
                `backup_instance: Backup Disk ${chosen.id}@${chosen.engine} ${probe.dest}/BACKUP.yaml ` +
                    `${probe.backupYaml == null ? 'missing' : `has no link for ${instanceId}`} — ` +
                    `Eng backupInstance only bumps lastBackup for linked instances. No soft-pass.`,
            )
        }
        priorLastBackup = lb
    }
    return {
        backupDiskId: chosen.id,
        engine: chosen.engine,
        priorLastBackup,
        movedTo,
        note: `${moveNote}; BACKUP.yaml lastBackup before=${priorLastBackup}`,
    }
}

// ── copy_app must really copy (no soft-pass on "Intent ok") ─────────────────────────

export type CopyCheckReason = 'ok' | 'refused' | 'never_started' | 'not_done'

/**
 * After the copy_app Intent reports ok (Console Confirm + settle), the Engine must have run
 * a copyApp Operation since the Intent started and it must end Done. Bounded waits:
 * DURATION_COPY_START_MS (fast 5 s / 30 s) for it to appear, DURATION_COPY_DONE_MS (fast
 * 300 s / 900 s, startBudgets.ts: the target start loads services/*.tar) for it to end. Failed/Cancelled, a timeout, or no Operation (a refused
 * copyApp CommandLog trace is quoted) → not ok, Engine error verbatim. r36@43: copyApp
 * Failed "rsync exited with code 23 … Permission denied (13)" while the step passed.
 * Prefers rows for the expected instance; otherwise judges every copyApp row since the
 * click (the Console Intent may drag another instance than the walker's guess).
 * Returns null without a live operationDB reader (Fake ops).
 */
export const verifyCopyOperation = async (
    ctx: ActionContext,
    sinceMs: number,
    expect: { instanceId?: string },
    opts: { startBudgetMs?: number; doneBudgetMs?: number; pollMs?: number; slackMs?: number; traceSlackMs?: number } = {},
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; reason: CopyCheckReason; note: string } | null> => {
    const ops = ctx.opts.ops as BackupOps
    if (typeof ops.listOperations !== 'function') return null
    const envMs = (k: string): number | undefined => {
        const raw = env[k]?.trim()
        return raw && /^\d+$/.test(raw) ? Number(raw) : undefined
    }
    const startBudget = opts.startBudgetMs ?? envMs('DURATION_COPY_START_MS') ?? (ctx.opts.fast ? 5_000 : 30_000)
    const doneBudget = opts.doneBudgetMs ?? copyDoneBudgetMs(!!ctx.opts.fast, env)
    const pollMs = opts.pollMs ?? 1_000
    const slackMs = opts.slackMs ?? 5_000
    const traceSlackMs = opts.traceSlackMs ?? 5_000
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e) && !isNeverEngine(e))
    const terminal = (st: string) => st === 'Done' || st === 'Failed' || st === 'Cancelled'
    const t0 = Date.now()
    let rows: (DurationOperationRow & { engine: string })[] = []
    let readErrors: string[] = []
    let refusal: (DurationCommandTrace & { engine: string }) | undefined
    const scan = async () => {
        rows = []
        readErrors = []
        for (const eng of pool) {
            try {
                for (const r of await ops.listOperations!(eng)) {
                    if (r.kind !== 'copyApp') continue
                    if (typeof r.startedAt !== 'number' || r.startedAt < sinceMs - slackMs) continue
                    if (!rows.some(x => x.id === r.id)) rows.push({ ...r, engine: eng })
                }
            } catch (e) {
                readErrors.push(`${eng}: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
        if (!rows.length && typeof ops.listCommandTraces === 'function') {
            for (const eng of pool) {
                try {
                    const t = (await ops.listCommandTraces(eng)).find(
                        x => x.command === 'copyApp' && x.status === 'error' && typeof x.startedAt === 'number' && x.startedAt >= sinceMs - traceSlackMs,
                    )
                    if (t) refusal = { ...t, engine: eng }
                } catch {
                    // CommandLog unreadable: the Operation check still decides
                }
            }
        }
    }
    const judged = () => {
        const mine = expect.instanceId ? rows.filter(r => r.args?.instanceId === expect.instanceId) : []
        return mine.length ? mine : rows
    }
    for (;;) {
        await scan()
        const elapsed = Date.now() - t0
        const rs = judged()
        if (rs.some(r => r.status === 'Done')) break
        if (rs.length && rs.every(r => terminal(r.status))) break
        if (!rs.length && refusal) break
        if (!rs.length && elapsed >= startBudget) break
        if (elapsed >= startBudget + doneBudget) break
        await sleep(pollMs)
    }
    const desc = (rs: typeof rows) =>
        rs.map(r => `${r.id}@${r.engine}=${r.status}${r.args?.instanceId ? ` inst=${r.args.instanceId}` : ''}` +
            `${r.args?.targetDiskId ? ` → ${r.args.targetDiskId}` : ''}${r.error ? ` (error: ${r.error})` : ''}`).join(', ')
    const errNote = readErrors.length ? ` (store read errors: ${readErrors.join('; ')})` : ''
    const rs = judged()
    if (!rs.length) {
        if (refusal) {
            return {
                ok: false,
                reason: 'refused',
                note:
                    `copy op never started: Engine ${refusal.engine} refused "copyApp" (trace ${refusal.traceId} ` +
                    `status=error: ${refusal.errorMessage ?? 'no message'}; args ${refusal.args}), no copyApp Operation${errNote}. No soft-pass.`,
            }
        }
        return {
            ok: false,
            reason: 'never_started',
            note:
                `copy op never started: no copyApp Operation on any pool engine (${pool.join(', ')}) within ` +
                `${Date.now() - t0}ms (budget ${startBudget}ms) after the copy Confirm${errNote}. No soft-pass.`,
        }
    }
    const done = rs.find(r => r.status === 'Done')
    if (!done) {
        const still = rs.some(r => !terminal(r.status))
        return {
            ok: false,
            reason: 'not_done',
            note:
                `copy op did not end Done: ${desc(rs)}${still ? ` after ${Date.now() - t0}ms (budget ${startBudget + doneBudget}ms)` : ''}` +
                `${errNote}. No soft-pass.`,
        }
    }
    const opMs = typeof done.completedAt === 'number' && typeof done.startedAt === 'number' ? done.completedAt - done.startedAt : null
    logStartMeasured({ what: 'copy_op', engine: done.engine, instanceId: done.args?.instanceId ?? null, diskId: done.args?.targetDiskId ?? null, ms: Date.now() - t0, budgetMs: startBudget + doneBudget, opMs })
    return {
        ok: true,
        reason: 'ok',
        note: `copy op ${done.id} Done on ${done.engine}${done.args?.instanceId ? ` (${done.args.instanceId} → ${done.args.targetDiskId ?? '?'})` : ''}` +
            `${opMs != null ? ` in ${opMs}ms` : ''}`,
    }
}

// ── r30: move_app must stay on one Pi (Eng 8d98718 refuses cross-engine moveApp) ──

/** Console 0760c01 e2e/intents/copyMoveApp.ts pickTargetDiskId preference order. */
export const COPY_MOVE_TARGET_PREFERENCE = [
    DURATION_UI_FIXTURES.nextcloud.diskId,
    DURATION_UI_FIXTURES.kolibri.diskId,
    'duration-empty-001',
] as const

/**
 * r30: predict what the Console copy_app / move_app Intent will drag, mirroring Console
 * 0760c01 copyMoveApp.ts: instance = DURATION_COPY_INSTANCE_ID || ctx instance || Kolibri;
 * source = the instance's storedOn (the Intent reads data-source-disk-id; DOM wins over
 * the env/ctx guess); target = DURATION_COPY_TARGET_DISK || (guessed source is Nextcloud
 * ? Kolibri : Nextcloud) when docked and ≠ source, else pickTargetDiskId preference
 * (Nextcloud, Kolibri, empty-001, then any other non-system docked disk). Hosts come
 * from a fresh store read, never from walker.dockedEngine.
 */
export const predictCopyMovePair = async (
    ctx: ActionContext,
    ids: { instanceId?: string; diskId?: string },
    env: NodeJS.ProcessEnv = process.env,
): Promise<{
    instanceId: string
    sourceDiskId: string
    sourceEngine: string | null
    targetDiskId: string | null
    targetEngine: string | null
}> => {
    const kolibri = DURATION_UI_FIXTURES.kolibri
    const nc = DURATION_UI_FIXTURES.nextcloud.diskId
    const instanceId = env.DURATION_COPY_INSTANCE_ID?.trim() || ids.instanceId || kolibri.instanceId
    const guessSource = env.DURATION_COPY_SOURCE_DISK?.trim() || ids.diskId || kolibri.diskId
    const defaultTarget = env.DURATION_COPY_TARGET_DISK?.trim() || (guessSource === nc ? kolibri.diskId : nc)
    const docked = new Map<string, string>() // diskId → engine, insertion = store order
    let storedOn: string | null = null
    for (const eng of ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e))) {
        let view: SemanticStoreView
        try {
            view = await ctx.opts.ops.readStore(eng)
        } catch {
            continue
        }
        for (const d of Object.values(view.diskDB)) {
            if (d.dockedTo && !docked.has(d.id)) docked.set(d.id, d.dockedTo)
        }
        const inst = view.instanceDB[instanceId]
        if (!storedOn && inst?.diskId && inst.status !== 'Undocked') storedOn = inst.diskId
    }
    const sourceDiskId = storedOn ?? guessSource
    const others = [...docked.keys()].filter(id => id !== sourceDiskId && !/system/i.test(id))
    let targetDiskId: string | null =
        defaultTarget !== sourceDiskId && docked.has(defaultTarget) ? defaultTarget : null
    if (!targetDiskId) {
        targetDiskId = COPY_MOVE_TARGET_PREFERENCE.find(id => others.includes(id)) ?? others[0] ?? null
    }
    return {
        instanceId,
        sourceDiskId,
        sourceEngine: docked.get(sourceDiskId) ?? null,
        targetDiskId,
        targetEngine: targetDiskId ? (docked.get(targetDiskId) ?? null) : null,
    }
}

/**
 * r30 preflight before move_app / copy_app (live only). Eng 8d98718 moveApp refuses a
 * target disk on another engine (CopyMoveApp.ts:399-405 — logs "Cross-engine move is not
 * supported" and returns, no Operation). copyApp supports cross-engine targets (Phase 2:
 * rsync over SSH + remote startInstance; CopyMoveApp.ts:94-103/197-201), so copy_app only
 * reports the pair. Throws (move_app) naming both Pis and both disks.
 */
export const preflightCopyMoveSamePi = async (
    ctx: ActionContext,
    op: 'move_app' | 'copy_app',
    ids: { instanceId?: string; diskId?: string },
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
    const pair = await predictCopyMovePair(ctx, ids, env)
    const { instanceId, sourceDiskId, sourceEngine, targetDiskId, targetEngine } = pair
    if (!sourceEngine) {
        throw new Error(
            `${op} preflight: ${instanceId} source disk ${sourceDiskId} is not docked on any pool engine ` +
                `(store re-read). No soft-pass.`,
        )
    }
    if (!targetDiskId || !targetEngine) {
        throw new Error(
            `${op} preflight: no docked target disk ≠ ${sourceDiskId} for ${instanceId} ` +
                `(store re-read; Console needs ≥2 docked disks). No soft-pass.`,
        )
    }
    for (const e of [sourceEngine, targetEngine]) {
        if (ctx.excludeEngines.includes(e) || isNeverEngine(e)) {
            throw new Error(`${op} preflight: ${instanceId} pair touches excluded engine ${e} — never idea02. No soft-pass.`)
        }
    }
    const desc = `${instanceId} on ${sourceEngine} (disk ${sourceDiskId}) -> ${targetDiskId} on ${targetEngine}`
    if (sourceEngine !== targetEngine) {
        if (op === 'move_app') {
            throw new Error(
                `move_app preflight: cross-engine move ${desc}; Engine refuses cross-engine moveApp ` +
                    `(Eng 8d98718 CopyMoveApp.ts:399-405 "Cross-engine move is not supported"). ` +
                    `Co-locate both disks on one Pi first. No soft-pass.`,
            )
        }
        return `${op} preflight: cross-engine copy ${desc} (Eng 8d98718 copyApp Phase 2 supports it)`
    }
    return `${op} preflight: same Pi ${desc} (store re-read)`
}

// ── r30: reboot_engine must really reboot (lastBooted advances, queue drains, reconnect) ──

export type EngineStateRow = { liveId: string; lastBooted: number | null; lastRun: number | null; commands: string[] }

type RebootOps = FleetOps & {
    readEngineState?: (viaEngine: string, targetEngine: string) => Promise<EngineStateRow | null>
    reconnectEngine?: (engineId: string, timeoutMs: number) => Promise<SettleReady>
}

/** Live harness capability for the reboot_engine checks (RealFleetOps). Fake walks skip. */
export const hasRebootProbe = (ctx: ActionContext): boolean =>
    typeof (ctx.opts.ops as RebootOps).readEngineState === 'function'

const envBudget = (env: NodeJS.ProcessEnv, key: string, dflt: number): number => {
    const raw = env[key]?.trim()
    return raw && /^\d+$/.test(raw) ? Number(raw) : dflt
}

/** Console src/store/remoteConfirm.ts: reboot confirm budget 10 * MIN. */
export const REBOOT_CONFIRM_DEFAULT_MS = 10 * 60_000

const queueHead = (st: EngineStateRow | null): string =>
    !st ? 'unread' : st.commands.length ? JSON.stringify(st.commands[0]) : 'empty'

/**
 * Read targetEngine's record through the pool (target first, then the others — shared
 * store replicates it; a rebooting target's own socket is dead). Highest lastBooted wins.
 */
const readEngineStateAnyVia = async (ctx: ActionContext, target: string): Promise<EngineStateRow | null> => {
    const ops = ctx.opts.ops as RebootOps
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e) && !isNeverEngine(e))
    const order = [target, ...pool.filter(e => e !== target)]
    let best: EngineStateRow | null = null
    for (const via of order) {
        try {
            const st = await ops.readEngineState!(via, target)
            if (st && (best == null || (st.lastBooted ?? 0) > (best.lastBooted ?? 0))) best = st
        } catch {
            /* via engine down (e.g. the target itself mid-reboot) — try next */
        }
    }
    return best
}

/** Reboot target: same engine id the Console Intent gets; never golden, must be a pool engine. */
export const resolveRebootTarget = (ctx: ActionContext, engineHint: string | undefined): string => {
    const engine = engineHint ?? ctx.poolEngines[0]
    if (!engine) throw new Error('reboot_engine: no target engine (empty pool)')
    assertNotGolden(ctx, engine, 'reboot_engine')
    if (isNeverEngine(engine)) throw new Error(`reboot_engine: refused engine '${engine}' (never idea02)`)
    if (!ctx.poolEngines.includes(engine)) {
        throw new Error(`reboot_engine: target '${engine}' is not a pool engine (${ctx.poolEngines.join(', ')}). No soft-pass.`)
    }
    return engine
}

/**
 * r30 pre-click (live): record lastBooted + commands queue. Eng 8902b67 storeMonitor
 * processes queue[0] only and skips bare (no-argument) commands without splicing them,
 * so a bare head never drains and would mask this reboot — fail loud before clicking.
 */
export const preflightRebootEngine = async (
    ctx: ActionContext,
    engine: string,
): Promise<{ before: EngineStateRow; note: string }> => {
    const before = await readEngineStateAnyVia(ctx, engine)
    if (!before) {
        throw new Error(`reboot_engine preflight: no engineDB record for ${engine} in any pool store. No soft-pass.`)
    }
    if (before.lastBooted == null) {
        throw new Error(`reboot_engine preflight: ${engine} (${before.liveId}) has no lastBooted in the store. No soft-pass.`)
    }
    const head = before.commands[0]
    if (head != null && !String(head).includes(' ')) {
        throw new Error(
            `reboot_engine preflight: ${engine} (${before.liveId}) command queue head is a stale bare command ` +
                `${JSON.stringify(head)} (queue length ${before.commands.length}) — Eng 8902b67 storeMonitor skips ` +
                `bare commands without draining them, so a new reboot would be masked. Clear it first. No soft-pass.`,
        )
    }
    return {
        before,
        note: `reboot_engine target ${engine} (${before.liveId}) lastBooted before=${before.lastBooted}; queue head=${queueHead(before)}`,
    }
}

export type RebootCheckReason = 'ok' | 'not_rebooted' | 'queue_not_drained' | 'no_reconnect' | 'console_not_reconnected'

/**
 * r30 post-Intent (live): Console c981361 reboot_engine only proves the confirm dialog
 * was accepted. Require (1) engine.lastBooted strictly advances within
 * DURATION_REBOOT_CONFIRM_MS (default 10 min, Console remoteConfirm.ts reboot), (2) the
 * engine's command queue head is empty afterwards (no leftover bare `reboot`) within
 * DURATION_REBOOT_QUEUE_DRAIN_MS, (3) a FRESH harness WS + store sync to the engine and
 * the pool settle gate, (4) when the UI driver can, the Console NetworkTree row for the
 * engine is back online with the status bar connected (DURATION_REBOOT_RECONNECT_MS;
 * DURATION_REBOOT_ALLOW_RELOAD=1 permits one reload). Returns null without a live probe.
 */
export const verifyRebootEngine = async (
    ctx: ActionContext,
    engine: string,
    before: EngineStateRow,
    opts: { confirmMs?: number; drainMs?: number; reconnectMs?: number; pollMs?: number } = {},
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; reason: RebootCheckReason; note: string } | null> => {
    const ops = ctx.opts.ops as RebootOps
    if (typeof ops.readEngineState !== 'function') return null
    const confirmMs = opts.confirmMs ?? envBudget(env, 'DURATION_REBOOT_CONFIRM_MS', REBOOT_CONFIRM_DEFAULT_MS)
    const drainMs = opts.drainMs ?? envBudget(env, 'DURATION_REBOOT_QUEUE_DRAIN_MS', 60_000)
    const reconnectMs = opts.reconnectMs ?? envBudget(env, 'DURATION_REBOOT_RECONNECT_MS', 180_000)
    const pollMs = opts.pollMs ?? envBudget(env, 'DURATION_REBOOT_POLL_MS', 2_000)
    const b = before.lastBooted ?? 0

    // 1. lastBooted advances
    const t0 = Date.now()
    let last: EngineStateRow | null = null
    for (;;) {
        last = await readEngineStateAnyVia(ctx, engine)
        if (last && (last.lastBooted ?? 0) > b) break
        if (Date.now() - t0 >= confirmMs) {
            return {
                ok: false,
                reason: 'not_rebooted',
                note:
                    `reboot_engine: ${engine} lastBooted did not advance within ${confirmMs}ms ` +
                    `(before=${b}, last=${last?.lastBooted ?? 'unread'}); queue head=${queueHead(last)}. ` +
                    `Console confirm accepted but the Engine never rebooted (bare "reboot" skipped by storeMonitor?). No soft-pass.`,
            }
        }
        await sleep(pollMs)
    }
    const advancedAfter = Date.now() - t0
    const after = last.lastBooted

    // 2. queue head empty
    const t1 = Date.now()
    for (;;) {
        if (last && last.commands.length === 0) break
        if (Date.now() - t1 >= drainMs) {
            return {
                ok: false,
                reason: 'queue_not_drained',
                note:
                    `reboot_engine: ${engine} rebooted (lastBooted ${b}→${after}) but its command queue head is ` +
                    `still ${queueHead(last)} after ${drainMs}ms (queue length ${last?.commands.length ?? '?'}) — ` +
                    `leftover command would block the queue. No soft-pass.`,
            }
        }
        await sleep(pollMs)
        last = await readEngineStateAnyVia(ctx, engine)
    }

    // 3. fresh WS + settle
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e) && !isNeverEngine(e))
    let wsNote = 'reconnect probe unavailable'
    if (typeof ops.reconnectEngine === 'function') {
        const ready = await ops.reconnectEngine(engine, reconnectMs)
        if (!ready.wsUp) {
            return {
                ok: false,
                reason: 'no_reconnect',
                note: `reboot_engine: ${engine} rebooted (lastBooted ${b}→${after}) but the harness could not open a fresh WS to it within ${reconnectMs}ms. No soft-pass.`,
            }
        }
        wsNote = `fresh WS up${ready.storeSynced ? ' + store synced' : ''}`
    }
    try {
        await settleParticipants(ctx, pool)
    } catch (e) {
        return {
            ok: false,
            reason: 'no_reconnect',
            note: `reboot_engine: ${engine} rebooted (lastBooted ${b}→${after}) but the pool did not settle afterwards: ${e instanceof Error ? e.message : String(e)}. No soft-pass.`,
        }
    }

    // 4. Console UI reconnect
    let uiNote = 'Console UI check unavailable (driver)'
    const driver = ctx.opts.uiDriver
    if (driver && typeof driver.waitEngineOnline === 'function') {
        try {
            uiNote = await driver.waitEngineOnline(engine, {
                timeoutMs: reconnectMs,
                allowReload: /^(1|true|yes)$/i.test(env.DURATION_REBOOT_ALLOW_RELOAD?.trim() ?? ''),
            })
        } catch (e) {
            return {
                ok: false,
                reason: 'console_not_reconnected',
                note: `reboot_engine: ${engine} rebooted (lastBooted ${b}→${after}) but ${e instanceof Error ? e.message : String(e)}. No soft-pass.`,
            }
        }
    }
    return {
        ok: true,
        reason: 'ok',
        note:
            `reboot_engine: ${engine} lastBooted ${b}→${after} after ${advancedAfter}ms; queue empty; ` +
            `${wsNote}; pool settled; ${uiNote}`,
    }
}

export type BackupCheckReason =
    | 'ok'
    | 'never_started'
    | 'refused'
    | 'wrong_instance'
    | 'not_done'
    | 'last_backup_not_bumped'
    | 'no_archive'

/**
 * r30: after the backup_instance Intent (Console clicks Back up and returns), poll the
 * pool engines' operationDB for a backupApp Operation started after the click and wait
 * for it to end. Reads only the resolved Operation args (Eng backupMonitor.ts:110-113:
 * instanceId + backupDiskId) — independent of whether the Console sent names (Eng
 * 8d98718) or ids (fix/restore-backup-disk-id). r36@98: without an Operation, the
 * Engine CommandLog trace tells a refusal ("Too many arguments" → the served Console sent
 * names) from a command that never arrived; a refusal ends the wait at once. Then the Backup Disk must really hold
 * the archive restore_from_backup will look for: BACKUP.yaml lastBackup for the
 * instance > 0 and > its pre-Intent value, `backups/<instanceId>/config` (the Borg repo
 * Eng restoreApp requires) and no `.backup-in-progress` marker. Returns null without a
 * live operationDB reader (Fake ops / stub).
 */
export const verifyBackupOperation = async (
    ctx: ActionContext,
    sinceMs: number,
    expect: { instanceId: string; priorLastBackup?: number },
    opts: { startBudgetMs?: number; doneBudgetMs?: number; pollMs?: number; slackMs?: number; traceSlackMs?: number } = {},
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; reason: BackupCheckReason; note: string } | null> => {
    const ops = ctx.opts.ops as BackupOps
    if (typeof ops.listOperations !== 'function') return null
    const envMs = (k: string): number | undefined => {
        const raw = env[k]?.trim()
        return raw && /^\d+$/.test(raw) ? Number(raw) : undefined
    }
    const startBudget = opts.startBudgetMs ?? envMs('DURATION_BACKUP_START_MS') ?? (ctx.opts.fast ? 5_000 : 30_000)
    const doneBudget = opts.doneBudgetMs ?? envMs('DURATION_BACKUP_DONE_MS') ?? (ctx.opts.fast ? 30_000 : 600_000)
    const pollMs = opts.pollMs ?? 1_000
    const slackMs = opts.slackMs ?? 60_000
    const pool = ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e) && !isNeverEngine(e))
    const want = expect.instanceId
    // CommandLog traces: Engine clocks vs the walker's — a few seconds of slack only, so an
    // older backupApp trace (an earlier walk) is not taken for this click.
    const traceSlackMs = opts.traceSlackMs ?? 5_000
    const t0 = Date.now()
    let rows: (DurationOperationRow & { engine: string })[] = []
    let readErrors: string[] = []
    let traces: (DurationCommandTrace & { engine: string })[] = []
    let traceErrors: string[] = []
    const canReadTraces = typeof ops.listCommandTraces === 'function'
    const scan = async () => {
        rows = []
        readErrors = []
        for (const eng of pool) {
            try {
                for (const r of await ops.listOperations!(eng)) {
                    if (r.kind !== 'backupApp') continue
                    if (typeof r.startedAt !== 'number' || r.startedAt < sinceMs - slackMs) continue
                    if (!rows.some(x => x.id === r.id)) rows.push({ ...r, engine: eng })
                }
            } catch (e) {
                readErrors.push(`${eng}: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
    }
    const scanTraces = async () => {
        if (!canReadTraces) return
        traces = []
        traceErrors = []
        for (const eng of pool) {
            try {
                for (const t of await ops.listCommandTraces!(eng)) {
                    if (t.command !== 'backupApp') continue
                    if (typeof t.startedAt !== 'number' || t.startedAt < sinceMs - traceSlackMs) continue
                    if (!traces.some(x => x.traceId === t.traceId)) traces.push({ ...t, engine: eng })
                }
            } catch (e) {
                traceErrors.push(`${eng}: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
        traces.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    }
    const refusal = () => traces.find(t => t.status === 'error')
    const desc = (rs: typeof rows) =>
        rs.map(r => `${r.id}@${r.engine}=${r.status}${r.args?.instanceId ? ` inst=${r.args.instanceId}` : ''}${r.error ? ` (${r.error})` : ''}`).join(', ')
    const terminal = (st: string) => st === 'Done' || st === 'Failed' || st === 'Cancelled'
    for (;;) {
        await scan()
        if (!rows.length) await scanTraces()
        const mine = rows.filter(r => r.args?.instanceId === want)
        const elapsed = Date.now() - t0
        if (mine.some(r => r.status === 'Done')) break
        if (mine.length && mine.every(r => terminal(r.status))) break
        // r36@98: the Engine already refused the command (error trace, no Operation) —
        // no Operation can follow, so do not wait out the start budget.
        if (!rows.length && refusal()) break
        if (!rows.length && elapsed >= startBudget) break
        if (rows.length && !mine.length && rows.every(r => terminal(r.status)) && elapsed >= startBudget) break
        if (elapsed >= startBudget + doneBudget) break
        await sleep(pollMs)
    }
    const errNote = readErrors.length ? ` (store read errors: ${readErrors.join('; ')})` : ''
    if (!rows.length) {
        const waited = Date.now() - t0
        const refused = refusal()
        if (refused) {
            const at = refused.startedAt != null ? ` ${refused.startedAt - sinceMs >= 0 ? '+' : ''}${refused.startedAt - sinceMs}ms after the Intent started` : ''
            return {
                ok: false,
                reason: 'refused',
                note:
                    `backup op never started: Engine ${refused.engine} refused "backupApp" before execution${at} ` +
                    `(trace ${refused.traceId} status=error: ${refused.errorMessage ?? 'no message'}; ` +
                    `args ${refused.args}), no backupApp Operation${errNote}: ` +
                    `${diagnoseBackupTrace(refused, { instanceId: want })}. No soft-pass.`,
            }
        }
        const traceNote = !canReadTraces
            ? 'Engine CommandLog not readable by this harness — cannot tell a refusal from a command that never arrived'
            : traces.length
              ? `backupApp trace(s) ${traces.map(t => `${t.traceId}@${t.engine}=${t.status}`).join(', ')} without an Operation`
              : `and no backupApp command trace on any pool engine (${pool.join(', ')}): the Console never delivered ` +
                `the command (Back up opened the Backup Disk picker? addressed to a non-pool engine? Console offline?)`
        const traceErrNote = traceErrors.length ? ` (CommandLog read errors: ${traceErrors.join('; ')})` : ''
        return {
            ok: false,
            reason: 'never_started',
            note:
                `backup op never started: no backupApp Operation since the Back up click on any pool engine ` +
                `within ${waited}ms (budget ${startBudget}ms)${errNote}; ${traceNote}${traceErrNote}. No soft-pass.`,
        }
    }
    const mine = rows.filter(r => r.args?.instanceId === want)
    if (!mine.length) {
        return {
            ok: false,
            reason: 'wrong_instance',
            note:
                `backup op backed up the wrong instance: ${desc(rows)}; expected ${want}. The Engine resolved ` +
                `the instance argument to another instance (a name shared with a copy_app clone, sent by a ` +
                `Console without the r30 id contract?). No soft-pass.`,
        }
    }
    const done = mine.find(r => r.status === 'Done')
    if (!done) {
        return {
            ok: false,
            reason: 'not_done',
            note: `backup op did not end Done: ${desc(mine)} after ${Date.now() - t0}ms. No soft-pass.`,
        }
    }
    const backupDiskId = done.args?.backupDiskId
    if (!backupDiskId) {
        return {
            ok: false,
            reason: 'no_archive',
            note: `backup op ${done.id} Done on ${done.engine} but carries no backupDiskId arg. No soft-pass.`,
        }
    }
    const host = await locateDockedEngine(ctx, backupDiskId)
    if (!host || ctx.excludeEngines.includes(host) || isNeverEngine(host)) {
        return {
            ok: false,
            reason: 'no_archive',
            note: `backup op ${done.id} Done but Backup Disk ${backupDiskId} is not docked on a pool engine (${host ?? 'nowhere'}). No soft-pass.`,
        }
    }
    if (typeof ops.probeBackupDisk !== 'function') {
        return {
            ok: false,
            reason: 'no_archive',
            note: `backup op ${done.id} Done but no Backup Disk probe available to verify the archive on ${backupDiskId}@${host}. No soft-pass.`,
        }
    }
    let probe: BackupDiskProbe | null = null
    try {
        probe = await ops.probeBackupDisk(host, backupDiskId, want)
    } catch (e) {
        return {
            ok: false,
            reason: 'no_archive',
            note: `backup op ${done.id} Done but probing ${backupDiskId}@${host} failed: ${e instanceof Error ? e.message : String(e)}. No soft-pass.`,
        }
    }
    if (!probe) {
        return {
            ok: false,
            reason: 'no_archive',
            note: `backup op ${done.id} Done but Backup Disk ${backupDiskId}@${host} has no known idea-test-N slot. No soft-pass.`,
        }
    }
    const lb = backupYamlLastBackup(probe.backupYaml, want)
    const prior = expect.priorLastBackup ?? 0
    if (lb === undefined || lb <= 0 || lb <= prior) {
        const now =
            lb === undefined
                ? probe.backupYaml == null
                    ? 'BACKUP.yaml missing'
                    : `BACKUP.yaml has no link for ${want}`
                : lb <= 0
                  ? `BACKUP.yaml lastBackup for ${want} still 0`
                  : `BACKUP.yaml lastBackup for ${want} not bumped (${lb} ≤ before ${prior})`
        return {
            ok: false,
            reason: 'last_backup_not_bumped',
            note: `backup op ${done.id} Done but Backup Disk ${backupDiskId}@${host} ${probe.dest}: ${now}. No soft-pass.`,
        }
    }
    const repo = probe.repoEntries
    if (!repo || !repo.includes('config') || repo.includes(BACKUP_IN_PROGRESS_MARKER)) {
        const why = !repo
            ? `backups/${want}/ missing`
            : !repo.includes('config')
              ? `backups/${want}/config missing (entries: ${repo.join(', ') || 'none'})`
              : `backups/${want}/${BACKUP_IN_PROGRESS_MARKER} still present (borg create unfinished/failed)`
        return {
            ok: false,
            reason: 'no_archive',
            note:
                `no archive for ${want} on Backup Disk ${backupDiskId}@${host} ${probe.dest}: ${why} — ` +
                `restore_from_backup would fail "No docked Backup Disk with archives". No soft-pass.`,
        }
    }
    return {
        ok: true,
        reason: 'ok',
        note:
            `backup op ${done.id} Done on ${done.engine}; ${want} archived on ${backupDiskId}@${host} ` +
            `(BACKUP.yaml lastBackup=${lb} > ${prior}; backups/${want}/config present)`,
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
    let instanceId: string | undefined = defaults.instanceId
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
    } else if (
        ctx.action === 'make_files_disk' ||
        ctx.action === 'add_files_role' ||
        ctx.action === 'files_role_added' ||
        ctx.action === 'make_backup_disk' ||
        ctx.action === 'restore_from_backup' ||
        ctx.action === 'backup_configured_restored' ||
        ctx.action === 'erase_disk' ||
        ctx.action === 'install_app' ||
        ctx.action === 'start_after_install'
    ) {
        // Prefer A r20: EmptyDiskPanel / Files-role Intents — never hard-code moved Kolibri.
        const filesId = process.env.DURATION_FILES_DISK_ID?.trim()
        const lastFilesRoleId = process.env.DURATION_LAST_FILES_ROLE_DISK_ID?.trim()
        const emptyId =
            process.env.DURATION_EMPTY_DISK_ID?.trim() || DURATION_UI_FIXTURES.empty.diskId
        if (ctx.action === 'files_role_added' && (lastFilesRoleId || filesId)) {
            // Prefer A r22: assert on the disk that most recently gained a files role
            // (make_files_disk → empty-001; add_files_role → app-only disk).
            diskId = lastFilesRoleId || filesId || emptyId
        } else if (
            filesId &&
            (ctx.action === 'backup_configured_restored' ||
                ctx.action === 'restore_from_backup')
        ) {
            diskId = filesId
        } else {
            // add_files_role target is resolved below (app-only disk restore, r22).
            diskId = emptyId
        }
        instanceId = undefined
    }
    let preStartSettleNote: string | null = null
    // Prefer A r35 → idea#168: before an install_app while empty-002 still holds the app a
    // previous start_after_install left there, re-dock empty-002 Empty (+ store purge) so the
    // Console offers EmptyDiskPanel again (empty-001 is the backup disk by then). Used to hang
    // off open_copied_instance (cover-all @117); now keyed on the real precondition so
    // cover-all (@119) and cover-all-skip-copy (@116) both get it before the second install.
    if (ctx.action === 'install_app' && ctx.walker.empty002HoldsApp) {
        try {
            preStartSettleNote = await redockEmpty002BeforeSecondInstall(ctx)
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `install_app aborted before Intent: empty-002 re-dock failed: ${err}`,
                layer,
            }
        }
    }
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
    // Prefer A r20: fresh-clean empty-001 before make_files_disk (install_app may have dirtied it).
    if (ctx.action === 'make_files_disk') {
        try {
            // Prefer A r21: always convert the pinned empty (empty-001), by testid.
            diskId = filesDiskTargetId()
            const consoleEngine = resolveConsoleEngineHost(ctx)
            const note = await redockEmpty001BeforeMakeFiles(ctx)
            const pre = await preflightFilesDiskTarget(ctx, diskId, consoleEngine)
            // Pin the Files Disk id before the Intent so Pixel + later steps share it.
            process.env.DURATION_FILES_DISK_ID = diskId
            let selNote = ''
            if (typeof driver.selectDisk === 'function') {
                // Select disk-<id> row + EmptyDiskPanel so Pixel ensureEmptyDiskPanel
                // never falls through to "first Empty Disk" (r21: Empty Disk 002).
                selNote = await driver.selectDisk(diskId, {
                    timeoutMs: ctx.opts.fast ? 60_000 : 120_000,
                    requireEmptyPanel: true,
                })
            }
            const notes = [note, pre, selNote].filter(Boolean).join('; ')
            preStartSettleNote = preStartSettleNote ? `${preStartSettleNote}; ${notes}` : notes
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `make_files_disk aborted before Intent: ${err}`,
                layer,
            }
        }
    }
    // Prefer A r22 FAIL@93: add_files_role ≠ make_files_disk. Never "already satisfied"
    // by the make_files_disk Files Disk; never soft-pass. Restore an app-only disk onto
    // the Console engine (Kolibri back from infra_move_disk@62, or
    // DURATION_ADD_FILES_DISK_ID), open its DiskView, require a visible Add Files.
    let addFilesDockedEngine: string | undefined
    if (ctx.action === 'add_files_role') {
        try {
            const app = await ensureAppOnlyDiskOnConsoleEngine(ctx)
            diskId = app.diskId
            if (app.movedFixture) addFilesDockedEngine = app.engine
            let selNote = ''
            if (typeof driver.selectDisk === 'function') {
                selNote = await driver.selectDisk(app.diskId, {
                    timeoutMs: ctx.opts.fast ? 60_000 : 120_000,
                    requireAddFiles: true,
                })
            }
            const notes = [app.note, selNote].filter(Boolean).join('; ')
            preStartSettleNote = preStartSettleNote ? `${preStartSettleNote}; ${notes}` : notes
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `add_files_role aborted before Intent: ${err}`,
                layer,
                // Walker follows Kolibri if the restore moved it before failing later.
                ...(addFilesDockedEngine ? { dockedEngine: addFilesDockedEngine } : {}),
            }
        }
    }
    // r30: backup_instance must have a linked Backup Disk on the instance's engine (Console
    // shows Back up only then); co-locate the app disk if needed and remember BACKUP.yaml
    // lastBackup so the post-check can prove a NEW archive. Live only (Fake walks skip).
    let backupPre: Awaited<ReturnType<typeof ensureBackupDiskForInstance>> | null = null
    let backupDockedEngine: string | undefined
    if (ctx.action === 'backup_instance' && hasBackupProbe(ctx)) {
        try {
            backupPre = await ensureBackupDiskForInstance(ctx, instanceId ?? ctx.fixtureInstance, ctx.fixtureDisk)
            const notes = [backupPre.note]
            if (backupPre.movedTo) {
                backupDockedEngine = backupPre.movedTo
                const urls = await resyncFixtureSidecarUrlsFromStore(ctx).catch(
                    e => `sidecar URL resync failed: ${e instanceof Error ? e.message : String(e)}`,
                )
                if (urls) notes.push(urls)
            }
            preStartSettleNote = [preStartSettleNote, ...notes].filter(Boolean).join('; ')
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `backup_instance aborted before Intent: ${err}`,
                layer,
            }
        }
    }
    // r30: move_app must stay on one Pi (Eng refuses cross-engine moveApp); copy_app
    // reports its pair. Live only (findDockedEngine) — Fake walks skip.
    if (
        (ctx.action === 'move_app' || ctx.action === 'copy_app') &&
        typeof (ctx.opts.ops as FleetOps & { findDockedEngine?: unknown }).findDockedEngine === 'function'
    ) {
        try {
            const note = await preflightCopyMoveSamePi(ctx, ctx.action, { instanceId, diskId })
            preStartSettleNote = preStartSettleNote ? `${preStartSettleNote}; ${note}` : note
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return {
                ok: false,
                message: `${ctx.action} aborted before Intent: ${err}`,
                layer,
            }
        }
    }
    // r30: reboot_engine — target must be a pool engine (never idea02); live: record
    // lastBooted + queue, refuse a stale bare queue head before clicking.
    let rebootTarget: string | undefined
    let rebootBefore: EngineStateRow | null = null
    if (ctx.action === 'reboot_engine' && hasRebootProbe(ctx)) {
        try {
            rebootTarget = resolveRebootTarget(ctx, backupDockedEngine ?? ctx.walker.dockedEngine ?? undefined)
            const pre = await preflightRebootEngine(ctx, rebootTarget)
            rebootBefore = pre.before
            preStartSettleNote = preStartSettleNote ? `${preStartSettleNote}; ${pre.note}` : pre.note
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            return { ok: false, message: `reboot_engine aborted before Intent: ${err}`, layer }
        }
    }
    // r29 FAIL@97: re-read the Kolibri/NC host from the store before any Intent that
    // polls a sidecar after Confirm (relocation steps may have moved — or not moved — it).
    if (SIDECAR_SETTLE_ACTIONS.has(ctx.action)) {
        try {
            const note = await resyncFixtureSidecarUrlsFromStore(ctx)
            if (note) preStartSettleNote = preStartSettleNote ? `${preStartSettleNote}; ${note}` : note
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            preStartSettleNote = `${preStartSettleNote ? `${preStartSettleNote}; ` : ''}sidecar URL resync failed: ${err}`
        }
    }
    const intentStartedAt = Date.now()
    // Console 230b70f add_files_role clicks DURATION_FILES_DISK_ID before diskId — point
    // it at the app-only disk for this Intent only; restore the make_files_disk pin after
    // (backup/restore Intents still key off it).
    const prevFilesPin = process.env.DURATION_FILES_DISK_ID
    if (ctx.action === 'add_files_role' && diskId) process.env.DURATION_FILES_DISK_ID = diskId
    let result: Awaited<ReturnType<typeof driver.runIntent>>
    try {
        result = await driver.runIntent({
            action: ctx.action,
            diskId,
            instanceId,
            engineId: ctx.action === 'make_files_disk' || ctx.action === 'add_files_role'
                ? resolveConsoleEngineHost(ctx)
                : (rebootTarget ?? backupDockedEngine ?? ctx.walker.dockedEngine ?? ctx.poolEngines[0]),
            screenshotPath: shotPath,
        })
    } finally {
        if (ctx.action === 'add_files_role') {
            if (prevFilesPin === undefined) delete process.env.DURATION_FILES_DISK_ID
            else process.env.DURATION_FILES_DISK_ID = prevFilesPin
        }
    }
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
    // r29 FAIL@97: a restore that the Engine never executed must not pass on a healthy
    // pre-existing sidecar. Live only; on Intent failure append the diagnosis.
    if (ctx.action === 'restore_from_backup') {
        const check = await verifyRestoreOperation(ctx, intentStartedAt)
        if (check && !check.ok) {
            // Lead with the restore verdict, not the Console's generic sidecar timeout.
            return {
                ok: false,
                message:
                    `restore_from_backup: ${check.note}` +
                    (result.ok ? ' (Console Intent reported ok)' : ` (Console Intent: ${message})`),
                layer,
            }
        }
        if (check) message = `${message}; ${check.note}`
    }
    // r30: backup_instance must leave a real archive for restore_from_backup (op Done +
    // BACKUP.yaml lastBackup bumped + backups/<id>/config). Live only.
    if (ctx.action === 'backup_instance') {
        const check = await verifyBackupOperation(ctx, intentStartedAt, {
            instanceId: instanceId ?? ctx.fixtureInstance,
            priorLastBackup: backupPre?.priorLastBackup,
        })
        if (check && !check.ok) {
            return {
                ok: false,
                message:
                    `backup_instance: ${check.note}` +
                    (result.ok ? ' (Console Intent reported ok)' : ` (Console Intent: ${message})`),
                layer,
                ...(backupDockedEngine ? { dockedEngine: backupDockedEngine } : {}),
            }
        }
        if (check) message = `${message}; ${check.note}`
    }
    // copy_app: "Intent ok" is not enough — the copyApp Operation must end Done (live only).
    if (ctx.action === 'copy_app' && result.ok) {
        const check = await verifyCopyOperation(ctx, intentStartedAt, {
            instanceId: process.env.DURATION_COPY_INSTANCE_ID?.trim() || instanceId || ctx.fixtureInstance,
        })
        if (check && !check.ok) {
            return { ok: false, message: `copy_app: ${check.note} (Console Intent reported ok)`, layer }
        }
        if (check) message = `${message}; ${check.note}`
    }
    // r30: reboot_engine must really reboot the target and come back (live only).
    if (ctx.action === 'reboot_engine' && rebootTarget && rebootBefore) {
        if (!result.ok) {
            const st = await readEngineStateAnyVia(ctx, rebootTarget).catch(() => null)
            return {
                ok: false,
                message: `${message}; reboot_engine: ${rebootTarget} queue head=${queueHead(st)} lastBooted=${st?.lastBooted ?? 'unread'} (before=${rebootBefore.lastBooted})`,
                layer,
            }
        }
        const check = await verifyRebootEngine(ctx, rebootTarget, rebootBefore)
        if (check && !check.ok) {
            return { ok: false, message: `${check.note} (Console Intent reported ok)`, layer }
        }
        if (check) message = `${message}; ${check.note}`
    }
    // Prefer A r20: pin Files Disk under test + fail loud if Pixel soft-passed on dirty empty.
    if (result.ok && ctx.action === 'make_files_disk') {
        const filesDiskId = diskId ?? filesDiskTargetId()
        process.env.DURATION_FILES_DISK_ID = filesDiskId
        process.env.DURATION_LAST_FILES_ROLE_DISK_ID = filesDiskId
        if (driver.kind === 'playwright') {
            try {
                const note = await assertFilesRoleOnDisk(ctx, filesDiskId)
                message = `${message}; ${note}`
            } catch (e) {
                const err = e instanceof Error ? e.message : String(e)
                return {
                    ok: false,
                    message: `make_files_disk reported ok but files role missing: ${err}`,
                    layer,
                }
            }
        } else {
            message = `${message}; DURATION_FILES_DISK_ID=${filesDiskId} (stub; skip store assert)`
        }
    }
    // Prefer A r22: add_files_role must really land a files role on the app-only disk.
    if (result.ok && ctx.action === 'add_files_role' && diskId) {
        process.env.DURATION_LAST_FILES_ROLE_DISK_ID = diskId
        if (driver.kind === 'playwright') {
            try {
                const note = await assertFilesRoleOnDisk(ctx, diskId, 'add_files_role')
                message = `${message}; ${note}`
            } catch (e) {
                const err = e instanceof Error ? e.message : String(e)
                return {
                    ok: false,
                    message: `add_files_role reported ok but files role missing: ${err}`,
                    layer,
                    ...(addFilesDockedEngine ? { dockedEngine: addFilesDockedEngine } : {}),
                }
            }
        } else {
            message = `${message}; add_files_role on app-only ${diskId} (stub; skip store assert)`
        }
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
    // idea#168: start_after_install left a running app on empty-002 (late install).
    // The next install_app re-docks empty-002 Empty first (redockEmpty002BeforeSecondInstall,
    // pre-Intent hook above) — works with or without copy_app/open_copied_instance.
    if (result.ok && ctx.action === 'start_after_install') {
        ctx.walker.empty002HoldsApp = true
        message = `${message}; empty-002 now holds the late-installed app (next install_app re-docks it Empty)`
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
        // Prefer A r22: Kolibri restored onto the Console engine → walker follows it.
        // r30: likewise when backup_instance co-located Kolibri with the Backup Disk.
        ...(addFilesDockedEngine ?? backupDockedEngine
            ? { dockedEngine: addFilesDockedEngine ?? backupDockedEngine }
            : {}),
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
                diskTypes: /empty/i.test(diskId) ? ['empty'] : undefined,
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
            const disk = doc.diskDB[diskId]
            if (disk && /empty/i.test(diskId)) {
                disk.diskTypes = ['empty']
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
