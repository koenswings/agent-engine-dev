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

const redockEmpty002Fresh = (
    ctx: ActionContext,
    label: string,
    noteSuffix: string,
    opts?: { purgeStoreInstances?: boolean },
): Promise<string> =>
    redockEmptyFresh(ctx, DURATION_UI_FIXTURES.empty2.diskId, label, noteSuffix, opts)

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

/** Poll budget for NC login-form readiness after dock. Default 180s (re-dock >30s). */
export const nextcloudReadyTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env.DURATION_NEXTCLOUD_READY_MS?.trim()
    if (raw && /^\d+$/.test(raw)) return Math.max(1_000, Number(raw))
    return 180_000
}

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
    const deadline = Date.now() + budget
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
                    return `DURATION_NEXTCLOUD_URL=${base} (login form ready)`
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
    if (from === to) {
        // Single-engine pool: treat as re-dock settle (document limitation).
        await ctx.opts.ops.dockFixture(to, ctx.fixtureDisk)
    } else {
        await ctx.opts.ops.moveDisk(from, to, ctx.fixtureDisk)
    }
    await settleParticipants(ctx, ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e)))
    const kolibriUrl = syncKolibriSidecarUrlForEngine(to, hostMapFromOps(ctx.opts.ops))
    const moveMsg =
        from === to ? `re-docked on sole pool engine ${to}` : `moved ${ctx.fixtureDisk} ${from}→${to}`
    return {
        ok: true,
        message: `${moveMsg}; DURATION_KOLIBRI_URL=${kolibriUrl}`,
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
                : (ctx.walker.dockedEngine ?? ctx.poolEngines[0]),
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
        // Prefer A r22: Kolibri restored onto the Console engine → walker follows it.
        ...(addFilesDockedEngine ? { dockedEngine: addFilesDockedEngine } : {}),
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
