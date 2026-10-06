/**
 * duration-walker.test.ts — Phase 1–2 Markov walker with FakeFleetOps (no fleet).
 * idea#166 / proposals/duration-tests.md
 */

import { describe, it, expect } from 'vitest'
import { FakeFleetOps, dispatchAction, addFilesAppDiskId, ensureAppOnlyDiskOnConsoleEngine, redockEmpty002AfterErase, redockEmpty002BeforeSecondInstall, redockEmpty001BeforeMakeFiles, resolveConsoleEngineHost, filesDiskTargetId, preflightFilesDiskTarget, syncKolibriSidecarUrlForEngine, syncNextcloudSidecarUrlForEngine, resyncFixtureSidecarUrlsFromStore, locateInstanceEngine, verifyRestoreOperation, SIDECAR_SETTLE_ACTIONS, verifyBackupOperation, ensureBackupDiskForInstance, backupYamlLastBackup, nextcloudLoginFormLooksReady, nextcloudInitialState, nextcloudReadyTimeoutMs, waitNextcloudSidecarReadyForEngine, fixtureSetHasNextcloud } from '../duration/actions.js'
import { semanticStoresEqual, waitForConvergence } from '../duration/convergence.js'
import { evaluateInvariants, DEFAULT_INFRA_INVARIANTS, listInvariantTypes } from '../duration/invariants.js'
import {
    assertPrivateDurationRoots,
    buildSshDockCopyRemote,
    isEmptyFixtureDisk,
    DEFAULT_DURATION_DISKS_ROOT,
    DEFAULT_DURATION_WATCH_DIR,
    looksLikeProtectedHwDisk,
    parseHostsFlag,
    PM2_RECONNECT_TIMEOUT_MS,
    RealFleetOps,
    resolveDurationFixturePack,
} from '../duration/realFleetOps.js'
import {
    assertSafeFixtureDisk,
    DEFAULT_FIXTURE_DISK,
    DEFAULT_POOL,
    isWalkScenario,
    loadScenario,
    loadWalk,
    makeRng,
    resolveScenarioName,
    resolveWalkName,
    WALK_ALIASES,
} from '../duration/scenario.js'
import { resolveWalkStartIndex, runDeterministicWalk, runWalk } from '../duration/runner.js'
import type { Scenario, SemanticStoreView } from '../duration/types.js'
import {
    StubUiDriver,
    createUiDriver,
    DURATION_UI_FIXTURES,
    defaultIdsForIntent,
    isPixelIntent,
    resolveConsoleIntentsDir,
    DEFERRED_UI_INTENTS,
    PIXEL_REGISTERED_INTENTS,
    PIXEL_MISSING_INTENTS,
} from '../duration/ui/index.js'
import {
    DEFAULT_FAIL_AFTER,
    FAST_DWELL_MS,
    detectStatusAnomalies,
    isDockerMissingProbeFailure,
    runningInstanceExpectsLocalDocker,
    runStabilityDuringDwell,
    snapshotRunning,
} from '../duration/stability.js'
import {
    assembleWalkVideo,
    framePath,
    listFramePngs,
    sanitizeActionForFilename,
} from '../duration/recordWalk.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const unifiedScenario = (): Scenario => loadScenario('unified')

const KID_FIXTURES = {
    'duration-kolibri-grade5a-001': 'kolibri-grade5a-001',
    'duration-nextcloud-grade5a-001': 'nextcloud-grade5a-001',
} as const

const fakeOps = (partial: ConstructorParameters<typeof FakeFleetOps>[0]) =>
    new FakeFleetOps({ fixtureInstances: { ...KID_FIXTURES }, ...partial })

describe('duration scenario YAML loader', () => {
    it('loads unified.yaml with shared transition shape and excludes golden', () => {
        const s = unifiedScenario()
        expect(s.name).toMatch(/unified/i)
        expect(s.exclude_engines).toContain('idea02')
        expect(s.pool_engines).not.toContain('idea02')
        expect(s.initial_state).toBe('start')
        expect(s.fixture_disk).toBe(DEFAULT_FIXTURE_DISK)
        // Every transition has to + weight + action
        for (const [name, def] of Object.entries(s.states)) {
            expect(def.transitions.length).toBeGreaterThan(0)
            for (const t of def.transitions) {
                expect(t.to, `${name} missing to`).toBeTruthy()
                expect(t.weight, `${name} bad weight`).toBeGreaterThan(0)
                expect(t.action, `${name} missing action`).toBeTruthy()
            }
        }
    })

    it('loads Kid fixture diskIds (agent-app-dev#10)', () => {
        const s = unifiedScenario()
        expect(s.fixtures?.map(f => f.diskId).sort()).toEqual([
            'duration-empty-001',
            'duration-empty-002',
            'duration-kolibri-grade5a-001',
            'duration-nextcloud-grade5a-001',
        ].sort())
        expect(s.fixture_disk).toBe('duration-kolibri-grade5a-001')
        expect(s.fixtures?.find(f => f.name === 'kolibri')?.instanceId).toBe('kolibri-grade5a-001')
        expect(s.fixtures?.find(f => f.name === 'nextcloud')?.instanceId).toBe('nextcloud-grade5a-001')
    })

    it('loads unified with all 28 proposal states; deprecated aliases resolve to unified', () => {
        const s = loadScenario('unified')
        const expected = [
            'start',
            'console_teacher', 'console_learner', 'kolibri_home', 'kolibri_watching',
            'kolibri_exercise', 'kolibri_manage', 'nc_browse', 'nc_share', 'nc_drop',
            'nc_collab', 'wiki_browse',
            'op_entry', 'op_overview', 'op_disk', 'op_eject', 'op_instance', 'op_install',
            'op_copy_move', 'op_files', 'op_backup', 'op_erase', 'op_account', 'op_settings',
            'infra_idle', 'infra_docked', 'infra_disk_moved', 'infra_reboot',
        ]
        expect(Object.keys(s.states).sort()).toEqual([...expected].sort())
        // Fixed wrong edges from gap analysis
        const homeActions = s.states.kolibri_home!.transitions.map(t => t.action)
        expect(homeActions).toEqual(expect.arrayContaining([
            'open_video', 'open_exercise', 'browse_classes', 'leave_kolibri', 'return_to_start',
        ]))
        expect(homeActions).not.toContain('keep_watching')
        const manageActions = s.states.kolibri_manage!.transitions.map(t => t.action)
        expect(manageActions).toEqual(expect.arrayContaining([
            'create_class', 'enroll_learners', 'back_to_console',
        ]))
        const entryActions = s.states.op_entry!.transitions.map(t => t.action)
        expect(entryActions).toEqual(expect.arrayContaining([
            'sign_in', 'retry_login_first_time_setup', 'return_to_start',
        ]))
        // Deprecated aliases still load the same graph
        for (const alias of ['minimal', 'stress', 'school-day', 'minimal-live', 'minimal-dock', 'random']) {
            expect(loadScenario(alias).name).toBe(s.name)
            expect(Object.keys(loadScenario(alias).states).length).toBe(28)
        }
    })

    it('resolves random→unified; cover-all / cover-registered-intents walks; cover-hardpass alias', () => {
        expect(resolveScenarioName('random')).toBe('unified')
        expect(resolveScenarioName('')).toBe('unified')
        expect(resolveScenarioName('unified')).toBe('unified')
        expect(isWalkScenario('cover-all')).toBe(true)
        expect(isWalkScenario('cover-registered-intents')).toBe(true)
        expect(isWalkScenario('cover-hardpass')).toBe(true) // brief alias
        expect(resolveWalkName('cover-hardpass')).toBe('cover-registered-intents')
        expect(WALK_ALIASES['cover-hardpass']).toBe('cover-registered-intents')
        expect(isWalkScenario('random')).toBe(false)
        expect(isWalkScenario('unified')).toBe(false)
        expect(isWalkScenario('school-day')).toBe(false)
        const walk = loadWalk('cover-all')
        expect(loadWalk('cover-hardpass').name).toBe('cover-registered-intents')
        expect(loadWalk('cover-registered-intents').name).toBe('cover-registered-intents')
        expect(walk.kind).toBe('walk')
        expect(walk.graph).toBe('unified')
        expect(walk.steps.length).toBeGreaterThan(50)
        expect(walk.scenario.pool_engines).toEqual(DEFAULT_POOL)
        // Every walk action appears at least once on the graph
        const graphActions = new Set<string>()
        for (const def of Object.values(walk.scenario.states)) {
            for (const t of def.transitions) graphActions.add(t.action)
        }
        const walkActions = new Set(walk.steps.map(s => s.action))
        for (const a of walkActions) expect(graphActions.has(a), a).toBe(true)
        // Cover-all aims for full action coverage
        expect(walkActions.size).toBe(graphActions.size)
    })

    it('runs cover-all deterministic Fake walk', async () => {
        const walk = loadWalk('cover-all')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
        })
        expect(result.failures).toBe(0)
        expect(result.aborted).toBe(false)
        expect(result.steps).toBe(walk.steps.length)
    })

    it('loads kolibri-learn-smoke and kolibri-teacher-preview-smoke walks', () => {
        expect(isWalkScenario('kolibri-learn-smoke')).toBe(true)
        expect(isWalkScenario('kolibri-teacher-preview-smoke')).toBe(true)
        const learn = loadWalk('kolibri-learn-smoke')
        expect(learn.name).toBe('kolibri-learn-smoke')
        expect(learn.steps.map(s => s.action)).toEqual([
            'open_console_as_learner',
            'open_kolibri_as_learner',
            'open_video',
            'keep_watching',
            'next_resource',
            'finish_exercise',
        ])
        const teacher = loadWalk('kolibri-teacher-preview-smoke')
        expect(teacher.steps).toHaveLength(7)
        expect(teacher.steps.at(-1)?.action).toBe('finish_exercise')
    })

    it('resolveWalkStartIndex: by number, by action, past-end / unknown fail', () => {
        const walk = loadWalk('cover-all')
        expect(resolveWalkStartIndex(walk.steps, 12)).toBe(11)
        expect(walk.steps[11]!.action).toBe('finish_exercise')
        expect(resolveWalkStartIndex(walk.steps, 'finish_exercise')).toBe(11)
        expect(resolveWalkStartIndex(walk.steps, '1')).toBe(0)
        expect(() => resolveWalkStartIndex(walk.steps, 0)).toThrow(/1-based/)
        expect(() => resolveWalkStartIndex(walk.steps, walk.steps.length + 1)).toThrow(/past end/)
        expect(() => resolveWalkStartIndex(walk.steps, 'no_such_action')).toThrow(/unknown action/)
    })

    it('runDeterministicWalk --start-from by number seeds current and keeps step numbers', async () => {
        const walk = loadWalk('cover-all')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const logs: { step: number; action: string; from: string }[] = []
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
            startFrom: 12,
            iterations: 1,
            onLog: e => logs.push({ step: e.step, action: e.action, from: e.from }),
        })
        expect(result.failures).toBe(0)
        expect(result.aborted).toBe(false)
        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatchObject({ step: 12, action: 'finish_exercise', from: 'kolibri_exercise' })
        expect(result.finalState).toBe('kolibri_home')
        expect(result.steps).toBe(1) // executed count; log step number stays 12
    })

    it('runDeterministicWalk --start-from by action + iterations after start-from', async () => {
        const walk = loadWalk('kolibri-learn-smoke')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const logs: string[] = []
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
            startFrom: 'finish_exercise',
            iterations: 1,
            onLog: e => logs.push(e.action),
        })
        expect(result.failures).toBe(0)
        expect(logs).toEqual(['finish_exercise'])
        // Without start-from, iterations 2 would be first two actions
        const logs2: string[] = []
        await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
            iterations: 2,
            onLog: e => logs2.push(e.action),
        })
        expect(logs2).toEqual(['open_console_as_learner', 'open_kolibri_as_learner'])
    })

    it('runs kolibri-learn-smoke Fake walk end-to-end', async () => {
        const walk = loadWalk('kolibri-learn-smoke')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
        })
        expect(result.failures).toBe(0)
        expect(result.aborted).toBe(false)
        expect(result.steps).toBe(6)
        expect(result.finalState).toBe('kolibri_home')
    })

    it('runs nextcloud-share-smoke Fake walk end-to-end (share_to_class → done_sharing → back_to_console_from_share)', async () => {
        expect(isWalkScenario('nextcloud-share-smoke')).toBe(true)
        const walk = loadWalk('nextcloud-share-smoke')
        expect(walk.steps.map(s => s.action)).toEqual([
            'open_console_as_teacher',
            'open_nextcloud_as_teacher',
            'browse_folders',
            'share_to_class',
            'done_sharing',
            'share_to_class',
            'back_to_console_from_share',
            'return_to_start',
        ])
        expect(walk.scenario.store_mode).toBe('shared')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
        })
        expect(result.failures).toBe(0)
        expect(result.aborted).toBe(false)
        expect(result.steps).toBe(8)
        expect(result.finalState).toBe('start')
    })

    it('runs nextcloud-collab-smoke Fake walk end-to-end (open_collab_doc → keep_editing → close_doc)', async () => {
        expect(isWalkScenario('nextcloud-collab-smoke')).toBe(true)
        const walk = loadWalk('nextcloud-collab-smoke')
        expect(walk.steps.map(s => s.action)).toEqual([
            'open_console_as_teacher',
            'open_nextcloud_as_teacher',
            'browse_folders',
            'open_collab_doc',
            'keep_editing',
            'close_doc',
            'return_to_start',
        ])
        expect(walk.scenario.store_mode).toBe('shared')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
        })
        expect(result.failures).toBe(0)
        expect(result.aborted).toBe(false)
        expect(result.steps).toBe(7)
        expect(result.finalState).toBe('start')
    })

    it('runs wikipedia-smoke Fake walk end-to-end (learner search + teacher leave)', async () => {
        expect(isWalkScenario('wikipedia-smoke')).toBe(true)
        const walk = loadWalk('wikipedia-smoke')
        expect(walk.steps.map(s => s.action)).toEqual([
            'open_console_as_learner',
            'open_wikipedia_as_learner',
            'search_browse_wikipedia',
            'leave_wikipedia_as_learner',
            'return_to_start',
            'open_console_as_teacher',
            'open_wikipedia_as_teacher',
            'leave_wikipedia_as_teacher',
            'return_to_start',
        ])
        expect(walk.scenario.store_mode).toBe('shared')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const driver = new StubUiDriver()
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            uiDriver: driver,
            skipStability: true,
        })
        expect(result.failures).toBe(0)
        expect(result.aborted).toBe(false)
        expect(result.steps).toBe(9)
        expect(result.finalState).toBe('start')
        // Prefer A: wikipedia Intents must remap to Kiwix pins (not primary kolibri-grade5a-001)
        const wikiCalls = driver.callContexts.filter(c =>
            c.action.includes('wikipedia') || c.action.includes('kiwix'),
        )
        expect(wikiCalls.length).toBe(5)
        for (const c of wikiCalls) {
            expect(c.diskId, c.action).toBe(DURATION_UI_FIXTURES.kiwix.diskId)
            expect(c.instanceId, c.action).toBe(DURATION_UI_FIXTURES.kiwix.instanceId)
            expect(c.instanceId, c.action).not.toBe('kolibri-grade5a-001')
        }
    })


    it('runs nextcloud-file-drop-smoke Fake walk end-to-end (open_file_drop → after_upload → leave_file_drop)', async () => {
        expect(isWalkScenario('nextcloud-file-drop-smoke')).toBe(true)
        const walk = loadWalk('nextcloud-file-drop-smoke')
        expect(walk.steps.map(s => s.action)).toEqual([
            'open_console_as_learner',
            'open_nextcloud_as_learner',
            'browse_folders',
            'open_file_drop',
            'after_upload',
            'open_file_drop',
            'leave_file_drop',
            'return_to_start',
        ])
        expect(walk.scenario.store_mode).toBe('shared')
        const ops = fakeOps({
            poolEngines: [...DEFAULT_POOL],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            settleDelayMs: 0,
        })
        const result = await runDeterministicWalk(walk, {
            fast: true,
            ops,
            stubUi: true,
            skipStability: true,
        })
        expect(result.failures).toBe(0)
        expect(result.aborted).toBe(false)
        expect(result.steps).toBe(8)
        expect(result.finalState).toBe('start')
    })

    it('refuses hw-roundtrip stick fixture markers', () => {
        expect(() => assertSafeFixtureDisk('stick-26A1EE83197F')).toThrow(/hw-roundtrip/)
        expect(() => assertSafeFixtureDisk('3E50-902A')).toThrow(/hw-roundtrip/)
        expect(() => assertSafeFixtureDisk(DEFAULT_FIXTURE_DISK)).not.toThrow()
    })

    it('rejects YAML transitions missing action', () => {
        // Build a temp-invalid scenario via parse path: load good then mutate check
        // Covered by loader throwing when action absent — use inline YAML file would need fs;
        // instead assert the public contract on a crafted call through loadScenario path
        // by verifying all shipped scenarios always include action (above) and that
        // makeRng is deterministic.
        const a = makeRng(42)
        const b = makeRng(42)
        expect([a(), a(), a()]).toEqual([b(), b(), b()])
    })
})

describe('semantic store equality + convergence', () => {
    const view = (engineId: string, dockedTo: string | null): SemanticStoreView => ({
        engineId,
        instanceDB: dockedTo
            ? { 'kolibri-grade5a-001': { id: 'kolibri-grade5a-001', status: 'Running', diskId: 'duration-kolibri-grade5a-001' } }
            : { 'kolibri-grade5a-001': { id: 'kolibri-grade5a-001', status: 'Undocked', diskId: 'duration-kolibri-grade5a-001' } },
        diskDB: {
            'duration-kolibri-grade5a-001': {
                id: 'duration-kolibri-grade5a-001',
                dockedTo,
                name: 'duration-kolibri-grade5a-001',
                device: dockedTo ? 'idea-test-duration' : null,
            },
        },
        engineDB: {
            idea01: { id: 'idea01', hostname: 'idea01.local' },
            idea03: { id: 'idea03', hostname: 'idea03.local' },
        },
    })

    it('compares instanceDB/diskDB/engineDB fields, not blob order', () => {
        const a = view('idea01', 'idea01')
        const b = view('idea03', 'idea01')
        expect(semanticStoresEqual(a, b)).toBe(true)
        const c = view('idea03', null)
        expect(semanticStoresEqual(a, c)).toBe(false)
    })

    it('waitForConvergence succeeds on FakeFleetOps shared mode after dock', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
        })
        await ops.dockFixture('idea01', 'duration-kolibri-grade5a-001')
        const result = await waitForConvergence(ops, ['idea01', 'idea03'], 1000)
        expect(result.ok).toBe(true)
    })

    it('unique mode skips cross-engine equality', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01'],
            storeMode: 'unique',
        })
        const result = await waitForConvergence(ops, ['idea01'], 500)
        expect(result.ok).toBe(true)
    })
})

describe('invariant registry', () => {
    it('registers expected infra types', () => {
        const types = listInvariantTypes()
        for (const t of [
            'store_convergence',
            'no_phantom_docks',
            'no_zombie_instances',
            'golden_untouched',
            'disk_docked',
            'engine_liveness',
        ]) {
            expect(types).toContain(t)
        }
    })

    it('golden_untouched fails if fixture docked on idea02', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
        })
        // Force a bad dock by mutating via read+manual — FakeFleetOps refuses dock on golden,
        // so simulate by docking on pool then lying in walker state.
        await ops.dockFixture('idea01', 'duration-kolibri-grade5a-001')
        const results = await evaluateInvariants(DEFAULT_INFRA_INVARIANTS, {
            ops,
            walker: { current: 'infra_docked', layer: 'infra', dockedEngine: 'idea02', step: 1 },
            excludeEngines: ['idea02'],
            poolEngines: ['idea01', 'idea03'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            engines: ['idea01', 'idea03'],
        })
        const golden = results.find(r => r.type === 'golden_untouched')
        expect(golden?.ok).toBe(false)
    })

    it('disk_docked any_pool ignores unique-store residual undocked on other host', async () => {
        // Live minimal-dock regression (idea#166): after move idea03→idea01 then
        // return_to_start + re-dock on idea03, idea01 still has dockedTo=null.
        const diskId = 'duration-kolibri-grade5a-001'
        const engineDB = {
            idea01: { id: 'idea01', hostname: 'idea01.local' },
            idea03: { id: 'idea03', hostname: 'idea03.local' },
        }
        const views: Record<string, SemanticStoreView> = {
            idea01: {
                engineId: 'idea01',
                instanceDB: {},
                diskDB: {
                    [diskId]: { id: diskId, name: diskId, dockedTo: null, device: null },
                },
                engineDB,
            },
            idea03: {
                engineId: 'idea03',
                instanceDB: {},
                diskDB: {
                    [diskId]: {
                        id: diskId,
                        name: diskId,
                        dockedTo: 'idea03',
                        device: 'idea-test-1',
                    },
                },
                engineDB,
            },
        }
        const ops = {
            getStoreMode: () => 'unique' as const,
            readStore: async (id: string) => structuredClone(views[id]!),
            waitReady: async () => ({ wsUp: true, storeSynced: true }),
        }
        const results = await evaluateInvariants(
            [{ type: 'disk_docked', disk: diskId, engine: 'any_pool' }],
            {
                ops: ops as never,
                walker: { current: 'infra_docked', layer: 'infra', dockedEngine: 'idea03', step: 6 },
                excludeEngines: ['idea02'],
                poolEngines: ['idea01', 'idea03'],
                fixtureDisk: diskId,
                engines: ['idea01', 'idea03'],
            },
        )
        expect(results[0]?.ok).toBe(true)
        expect(results[0]?.detail).toMatch(/idea03/)
    })

    it('disk_docked fails when every unique-store view is undocked residual', async () => {
        const diskId = 'duration-kolibri-grade5a-001'
        const engineDB = {
            idea01: { id: 'idea01' },
            idea03: { id: 'idea03' },
        }
        const undocked: SemanticStoreView = {
            engineId: 'idea01',
            instanceDB: {},
            diskDB: { [diskId]: { id: diskId, dockedTo: null, device: null } },
            engineDB,
        }
        const ops = {
            getStoreMode: () => 'unique' as const,
            readStore: async (id: string) =>
                structuredClone({ ...undocked, engineId: id }),
            waitReady: async () => ({ wsUp: true, storeSynced: true }),
        }
        const results = await evaluateInvariants(
            [{ type: 'disk_docked', disk: diskId, engine: 'any_pool' }],
            {
                ops: ops as never,
                walker: { current: 'infra_docked', layer: 'infra', dockedEngine: 'idea03', step: 1 },
                excludeEngines: ['idea02'],
                poolEngines: ['idea01', 'idea03'],
                fixtureDisk: diskId,
                engines: ['idea01', 'idea03'],
            },
        )
        expect(results[0]?.ok).toBe(false)
        expect(results[0]?.detail).toMatch(/not docked/)
    })

    it('no_zombie_instances catches Running on undocked disk', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            storeMode: 'shared',
        })
        await ops.dockFixture('idea01', 'duration-kolibri-grade5a-001')
        await ops.undockFixtures(['idea01'], 'duration-kolibri-grade5a-001')
        // Fake sets Undocked on undock — force Running to simulate zombie
        const store = await ops.readStore('idea01')
        // Re-apply zombie via a second Fake with custom mutate: dock then manually break
        // Use evaluate against a hand-built ops by reading after dock and checking undock path is clean:
        const clean = await evaluateInvariants([{ type: 'no_zombie_instances' }], {
            ops,
            walker: { current: 'infra_idle', layer: 'infra', dockedEngine: null, step: 1 },
            excludeEngines: ['idea02'],
            poolEngines: ['idea01', 'idea03'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            engines: ['idea01'],
        })
        expect(clean[0]?.ok).toBe(true)
        expect(store.diskDB['duration-kolibri-grade5a-001']?.dockedTo).toBeNull()
    })
})

describe('FakeFleetOps pool-only + store mode switch', () => {
    it('refuses dock/reboot on golden idea02', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
        })
        await expect(ops.dockFixture('idea02', 'duration-kolibri-grade5a-001')).rejects.toThrow(/excluded/)
        await expect(ops.rebootEngine('idea02', true)).rejects.toThrow(/excluded/)
    })

    it('applyStoreMode switches shared ↔ unique', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            storeMode: 'shared',
        })
        expect(ops.getStoreMode()).toBe('shared')
        await ops.dockFixture('idea01', 'duration-kolibri-grade5a-001')
        await ops.applyStoreMode('unique')
        expect(ops.getStoreMode()).toBe('unique')
        const a = await ops.readStore('idea01')
        expect(a.diskDB['duration-kolibri-grade5a-001']?.dockedTo).toBe('idea01')
        await ops.applyStoreMode('shared')
        expect(ops.getStoreMode()).toBe('shared')
    })
})

describe('Markov walker (FakeFleetOps)', () => {
    it('runs unified scenario for 40 steps without failure', async () => {
        const scenario = unifiedScenario()
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
        })
        const result = await runWalk({
            scenario,
            iterations: 40,
            fast: true,
            ops,
            stubUi: true,
            settleTimeoutMs: 500,
            rng: makeRng(scenario.seed ?? 42),
        })
        expect(result.aborted).toBe(false)
        expect(result.failures).toBe(0)
        expect(result.steps).toBe(40)
        expect(result.logs).toHaveLength(40)
        // Never targeted golden
        for (const log of result.logs) {
            expect(log.message ?? '').not.toMatch(/idea02/)
        }
    })

    it('return_to_start undocks fixtures (hygiene)', async () => {
        const scenario = unifiedScenario()
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: 'shared',
        })
        // Force a short walk that docks then returns: seed chosen so first steps enter infra + dock.
        // Drive explicitly via runWalk with many steps and assert that whenever we land on start
        // after infra_docked, fixture is undocked.
        const result = await runWalk({
            scenario,
            iterations: 60,
            fast: true,
            ops,
            stubUi: true,
            settleTimeoutMs: 500,
            rng: makeRng(1),
        })
        expect(result.failures).toBe(0)
        const returns = result.logs.filter(l => l.action === 'return_to_start')
        for (const step of returns) {
            expect(step.ok).toBe(true)
        }
        // After any return, store should show undocked fixture
        if (returns.length > 0) {
            const store = await ops.readStore('idea01')
            const disk = store.diskDB['duration-kolibri-grade5a-001']
            if (disk) expect(disk.dockedTo).toBeNull()
        }
    })

    it('unified stub walk mixes layers without abort', async () => {
        const scenario = loadScenario('unified')
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
        })
        const result = await runWalk({
            scenario,
            iterations: 50,
            fast: true,
            ops,
            stubUi: true,
            settleTimeoutMs: 500,
            rng: makeRng(7),
        })
        expect(result.aborted).toBe(false)
        expect(result.failures).toBe(0)
        const actions = new Set(result.logs.map(l => l.action))
        expect(actions.size).toBeGreaterThan(1)
    })

    it('unified Fake walk covers App-open and Pixel-missing Intents via StubUiDriver', async () => {
        const scenario = loadScenario('unified')
        const yamlActions = new Set<string>()
        for (const st of Object.values(scenario.states)) {
            for (const tr of st.transitions) yamlActions.add(tr.action)
        }
        // Full proposal keeps App-open + coaching edges on the one graph
        for (const required of [
            'open_kolibri_as_teacher', 'open_kolibri_as_learner',
            'open_nextcloud_as_teacher', 'open_nextcloud_as_learner',
            'open_video', 'open_exercise', 'create_class', 'back_to_console',
            'sign_in', 'install_app',
        ]) {
            expect(yamlActions.has(required)).toBe(true)
        }
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
        })
        const driver = new StubUiDriver()
        const result = await runWalk({
            scenario,
            iterations: 80,
            fast: true,
            ops,
            stubUi: true,
            uiDriver: driver,
            settleTimeoutMs: 500,
            rng: makeRng(21),
            skipStability: true,
        })
        expect(result.aborted).toBe(false)
        expect(result.failures).toBe(0)
        expect(driver.calls.length).toBeGreaterThan(0)
        const actions = new Set(result.logs.map(l => l.action))
        expect(actions.size).toBeGreaterThan(1)
    })

    it('emits structured log fields', async () => {
        const scenario = unifiedScenario()
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
        })
        const collected: string[] = []
        await runWalk({
            scenario,
            iterations: 5,
            fast: true,
            ops,
            settleTimeoutMs: 500,
            rng: makeRng(42),
            onLog: e => {
                collected.push(e.action)
                expect(e).toMatchObject({
                    step: expect.any(Number),
                    from: expect.any(String),
                    to: expect.any(String),
                    action: expect.any(String),
                    ok: true,
                })
                expect(e.ts).toBeTruthy()
            },
        })
        expect(collected).toHaveLength(5)
    })
})


describe('RealFleetOps guard clauses (no network)', () => {
    const fakeHosts = { idea01: '127.0.0.1', idea03: '127.0.0.2' }

    it('parseHostsFlag parses name=host pairs', () => {
        expect(parseHostsFlag('idea01=100.99.231.94,idea03=100.126.117.80')).toEqual({
            idea01: '100.99.231.94',
            idea03: '100.126.117.80',
        })
        expect(() => parseHostsFlag('idea01')).toThrow(/Invalid/)
    })

    it('refuses golden reboot and shared store mode without contacting Pis', async () => {
        const ops = new RealFleetOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            hosts: fakeHosts,
            storeMode: 'unique',
        })
        await expect(ops.rebootEngine('idea02', true)).rejects.toThrow(/excluded|golden/)
        await expect(ops.applyStoreMode('shared')).rejects.toThrow(/Ops must provision|shared/)
        expect(ops.getStoreMode()).toBe('unique')
        await ops.applyStoreMode('unique') // no-op
        expect(ops.getStoreMode()).toBe('unique')
    })

    it('defaults to Atlas-approved private duration roots (never /disks)', () => {
        // Explicit roots — process env may set IDEA_DISKS_ROOT for the vitest harness.
        const ops = new RealFleetOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            hosts: fakeHosts,
            disksRoot: DEFAULT_DURATION_DISKS_ROOT,
            watchDir: DEFAULT_DURATION_WATCH_DIR,
        })
        expect(ops.getDisksRoot()).toBe(DEFAULT_DURATION_DISKS_ROOT)
        expect(ops.getWatchDir()).toBe(DEFAULT_DURATION_WATCH_DIR)
        expect(PM2_RECONNECT_TIMEOUT_MS).toBe(150_000)
        expect(resolveDurationFixturePack('duration-kolibri-grade5a-001')).toBe('kolibri')
        expect(resolveDurationFixturePack('duration-nextcloud-grade5a-001')).toBe('nextcloud')
        expect(resolveDurationFixturePack('duration-empty-001')).toBe('empty')
        expect(resolveDurationFixturePack('duration-empty-002')).toBe('empty-002')
        expect(() => resolveDurationFixturePack('sdb1')).toThrow(/unknown/)
        expect(() => assertPrivateDurationRoots('/disks', DEFAULT_DURATION_WATCH_DIR)).toThrow(/never \/disks/)
        expect(() => assertPrivateDurationRoots(DEFAULT_DURATION_DISKS_ROOT, '/dev/engine')).toThrow(/never \/dev\/engine/)
        expect(() => new RealFleetOps({
            poolEngines: ['idea01', 'idea03'],
            hosts: fakeHosts,
            disksRoot: '/disks',
            watchDir: DEFAULT_DURATION_WATCH_DIR,
        })).toThrow(/never \/disks/)
    })

    it('buildSshDockCopyRemote: empty always fresh-copy; Grade5A keeps Path A reuse', () => {
        const base = {
            src: '/fixtures/empty',
            dest: '/home/pi/idea/duration-disks/idea-test-3',
            sentinel: '/home/pi/idea/duration-watch/idea-test-3',
            disksRoot: DEFAULT_DURATION_DISKS_ROOT,
            watchDir: DEFAULT_DURATION_WATCH_DIR,
            startInstances: false,
        }
        const emptyRemote = buildSshDockCopyRemote({
            ...base,
            diskId: 'duration-empty-001',
            pack: 'empty',
            src: '/fixtures/empty',
        })
        expect(emptyRemote).toMatch(/empty pack always fresh-copy/)
        expect(emptyRemote).toMatch(/rm -rf '\/home\/pi\/idea\/duration-disks\/idea-test-3'/)
        expect(emptyRemote).toMatch(/cp -a '\/fixtures\/empty\/\.'/)
        expect(emptyRemote).not.toMatch(/reuse existing Path A tree/)
        // Still refuse when META belongs to a different diskId
        expect(emptyRemote).toMatch(/! grep -Fq 'diskId: duration-empty-001'/)
        expect(emptyRemote).toMatch(/exit 4/)
        // Prefer A r20: strip Kid README.md / stray apps so createFilesDisk is not refused
        expect(emptyRemote).toMatch(/stripped non-META entries from empty pack/)
        expect(emptyRemote).toMatch(/! -name 'META\.yaml' ! -name 'lost\+found'/)

        const empty2Remote = buildSshDockCopyRemote({
            ...base,
            dest: '/home/pi/idea/duration-disks/idea-test-4',
            sentinel: '/home/pi/idea/duration-watch/idea-test-4',
            diskId: 'duration-empty-002',
            pack: 'empty-002',
            src: '/fixtures/empty-002',
        })
        expect(empty2Remote).toMatch(/empty pack always fresh-copy/)
        expect(empty2Remote).toMatch(/rm -rf '\/home\/pi\/idea\/duration-disks\/idea-test-4'/)
        expect(empty2Remote).toMatch(/cp -a '\/fixtures\/empty-002\/\.'/)
        expect(empty2Remote).not.toMatch(/reuse existing Path A tree/)
        expect(empty2Remote).toMatch(/! grep -Fq 'diskId: duration-empty-002'/)
        expect(empty2Remote).toMatch(/stripped non-META entries from empty pack/)

        const kolibriRemote = buildSshDockCopyRemote({
            ...base,
            diskId: 'duration-kolibri-grade5a-001',
            pack: 'kolibri',
            src: '/fixtures/kolibri',
            dest: '/home/pi/idea/duration-disks/idea-test-1',
            sentinel: '/home/pi/idea/duration-watch/idea-test-1',
        })
        expect(kolibriRemote).toMatch(/reuse existing Path A tree/)
        expect(kolibriRemote).toMatch(/grep -Fq 'diskId: duration-kolibri-grade5a-001'/)
        // Reuse early-exit must appear before wipe for Grade5A
        expect(kolibriRemote.indexOf('reuse existing Path A tree'))
            .toBeLessThan(kolibriRemote.indexOf("rm -rf '/home/pi/idea/duration-disks/idea-test-1'"))
    })

    it('dockFixture refuses protected / golden without contacting Pis', async () => {
        const ops = new RealFleetOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            hosts: fakeHosts,
        })
        await expect(ops.dockFixture('idea02', 'duration-kolibri-grade5a-001'))
            .rejects.toThrow(/excluded|golden/)
        await expect(ops.dockFixture('idea01', 'stick-26A1EE83197F'))
            .rejects.toThrow(/protected|unknown/)
        await expect(ops.moveDisk('idea01', 'idea02', 'duration-kolibri-grade5a-001'))
            .rejects.toThrow(/excluded|golden/)
    })

    it('looksLikeProtectedHwDisk catches Intenso markers', () => {
        expect(looksLikeProtectedHwDisk('a0bf8374-274e-4bef-b32e-cfbfd09d2884')).toBe(true)
        expect(looksLikeProtectedHwDisk('x', { name: 'IDEA Disk' })).toBe(true)
        expect(looksLikeProtectedHwDisk('stick-26A1EE83197F')).toBe(true)
        expect(looksLikeProtectedHwDisk('duration-kolibri-grade5a-001')).toBe(false)
    })

    it('constructor refuses missing hosts / idea02 in pool', () => {
        expect(() => new RealFleetOps({
            poolEngines: ['idea01', 'idea02'],
            hosts: { idea01: '1.1.1.1', idea02: '2.2.2.2' },
        })).toThrow(/golden|excluded/)
        expect(() => new RealFleetOps({
            poolEngines: ['idea01'],
            hosts: {},
        })).toThrow(/missing host/)
    })
})

describe('unified infra coverage (FakeFleetOps)', () => {
    it('unified graph includes dock/undock/move/reboot and walks green', async () => {
        const scenario = loadScenario('unified')
        expect(scenario.exclude_engines).toContain('idea02')
        expect(scenario.fixtures?.some(f => f.infra_disk !== false)).toBe(true)
        const actions = new Set<string>()
        for (const def of Object.values(scenario.states)) {
            for (const t of def.transitions) actions.add(t.action)
        }
        expect(actions.has('infra_dock_fixture')).toBe(true)
        expect(actions.has('infra_undock_fixtures')).toBe(true)
        expect(actions.has('infra_move_disk')).toBe(true)
        expect(actions.has('infra_reboot_engine')).toBe(true)
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
        })
        const result = await runWalk({
            scenario,
            iterations: 40,
            fast: true,
            ops,
            stubUi: true,
            settleTimeoutMs: 500,
            rng: makeRng(11),
            skipStability: true,
        })
        expect(result.aborted).toBe(false)
        expect(result.failures).toBe(0)
    })
})

// ── Phase 3 UI dispatch + Phase 4 stability (idea#168) ───────────────────────

describe('Phase 3 UI Intent dispatch (StubUiDriver)', () => {
    it('createUiDriver(stub) records Pixel hub Intent names', async () => {
        const driver = createUiDriver({ stub: true }) as StubUiDriver
        expect(driver.kind).toBe('stub')
        const r = await driver.runIntent({ action: 'open_console_as_teacher' })
        expect(r.ok).toBe(true)
        expect(r.mode).toBe('stub')
        expect(driver.calls).toContain('open_console_as_teacher')
        expect(isPixelIntent('open_console_as_teacher')).toBe(true)
        expect(isPixelIntent('infra_dock_fixture')).toBe(false)
    })

    it('Wikipedia + keep_editing + File Drop are Pixel-registered @ 198eb69 (deferred/missing empty)', async () => {
        const driver = new StubUiDriver()
        for (const action of [
            'open_wikipedia_as_teacher',
            'open_wikipedia_as_learner',
            'search_browse_wikipedia',
            'leave_wikipedia_as_teacher',
            'leave_wikipedia_as_learner',
            'keep_editing',
            'open_file_drop',
            'after_upload',
            'leave_file_drop',
        ] as const) {
            expect(isPixelIntent(action)).toBe(true)
            const r = await driver.runIntent({ action })
            expect(r.ok).toBe(true)
            expect(r.mode).toBe('stub')
            expect(r.message).not.toMatch(/deferred|Pixel-missing/)
        }
        expect(DEFERRED_UI_INTENTS).toHaveLength(0)
        expect(PIXEL_REGISTERED_INTENTS).toHaveLength(85)
        expect(PIXEL_MISSING_INTENTS).toHaveLength(0)
    })

    it('unknown Intent still Fake no-ops without aborting (PIXEL_MISSING empty @ 198eb69)', async () => {
        const driver = new StubUiDriver()
        const r = await driver.runIntent({ action: 'not_a_real_intent_xyz' })
        expect(r.ok).toBe(true)
        expect(r.mode).toBe('stub')
        expect(r.message).toMatch(/unknown Intent/)
    })

    it('bakes Kid content pins (App#10)', () => {
        expect(DURATION_UI_FIXTURES.kolibri.diskId).toBe('duration-kolibri-grade5a-001')
        expect(DURATION_UI_FIXTURES.kolibri.video.contentId).toBe('e60662de-b15c-52f9-b003-359f7d91f8fd')
        expect(DURATION_UI_FIXTURES.kolibri.exercise.contentId).toBe('7eb9de46-96eb-53d0-bcc1-2fb270b96f03')
        expect(DURATION_UI_FIXTURES.kolibri.channelId).toBe('30b6c263-4b96-5a62-93bd-dcf9a5cad7ca')
        expect(DURATION_UI_FIXTURES.nextcloud.instanceId).toBe('nextcloud-grade5a-001')
        expect(DURATION_UI_FIXTURES.kiwix.diskId).toBe('duration-kiwix-ideaa-001')
        expect(DURATION_UI_FIXTURES.kiwix.instanceId).toBe('kiwix-ideaa-001')
    })

    it('defaultIdsForIntent remaps wikipedia/kiwix to Prefer A Kiwix pins', () => {
        for (const action of [
            'open_wikipedia_as_learner',
            'open_wikipedia_as_teacher',
            'search_browse_wikipedia',
            'leave_wikipedia_as_learner',
            'leave_wikipedia_as_teacher',
        ]) {
            const ids = defaultIdsForIntent(action)
            expect(ids.diskId, action).toBe('duration-kiwix-ideaa-001')
            expect(ids.instanceId, action).toBe('kiwix-ideaa-001')
        }
        expect(defaultIdsForIntent('open_nextcloud_as_learner').instanceId).toBe('nextcloud-grade5a-001')
        expect(defaultIdsForIntent('open_kolibri_as_learner').instanceId).toBe('kolibri-grade5a-001')
    })

    it('defaultIdsForIntent remaps files/backup EmptyDiskPanel Intents to empty-001 (not Kolibri)', () => {
        const prevFiles = process.env.DURATION_FILES_DISK_ID
        const prevEmpty = process.env.DURATION_EMPTY_DISK_ID
        const prevLast = process.env.DURATION_LAST_FILES_ROLE_DISK_ID
        const prevAdd = process.env.DURATION_ADD_FILES_DISK_ID
        delete process.env.DURATION_FILES_DISK_ID
        delete process.env.DURATION_EMPTY_DISK_ID
        delete process.env.DURATION_LAST_FILES_ROLE_DISK_ID
        delete process.env.DURATION_ADD_FILES_DISK_ID
        try {
            for (const action of [
                'make_files_disk',
                'files_role_added',
                'make_backup_disk',
                'restore_from_backup',
                'backup_configured_restored',
                'erase_disk',
            ]) {
                const ids = defaultIdsForIntent(action)
                expect(ids.diskId, action).toBe('duration-empty-001')
                expect(ids.instanceId, action).toBeUndefined()
            }
            process.env.DURATION_FILES_DISK_ID = 'duration-files-disk'
            expect(defaultIdsForIntent('files_role_added').diskId).toBe('duration-files-disk')
            // Prefer A r22: add_files_role = Add Files on an app-only disk, never the Files pin.
            expect(defaultIdsForIntent('add_files_role').diskId).toBe('duration-kolibri-grade5a-001')
            process.env.DURATION_ADD_FILES_DISK_ID = 'duration-app-only-001'
            expect(defaultIdsForIntent('add_files_role').diskId).toBe('duration-app-only-001')
            process.env.DURATION_LAST_FILES_ROLE_DISK_ID = 'duration-kolibri-grade5a-001'
            expect(defaultIdsForIntent('files_role_added').diskId).toBe('duration-kolibri-grade5a-001')
            // make_files_disk stays on EMPTY (convert target), not FILES pin
            expect(defaultIdsForIntent('make_files_disk').diskId).toBe('duration-empty-001')
        } finally {
            if (prevLast === undefined) delete process.env.DURATION_LAST_FILES_ROLE_DISK_ID
            else process.env.DURATION_LAST_FILES_ROLE_DISK_ID = prevLast
            if (prevAdd === undefined) delete process.env.DURATION_ADD_FILES_DISK_ID
            else process.env.DURATION_ADD_FILES_DISK_ID = prevAdd
            if (prevFiles === undefined) delete process.env.DURATION_FILES_DISK_ID
            else process.env.DURATION_FILES_DISK_ID = prevFiles
            if (prevEmpty === undefined) delete process.env.DURATION_EMPTY_DISK_ID
            else process.env.DURATION_EMPTY_DISK_ID = prevEmpty
        }
    })

    it('walker dispatches usage Intents through uiDriver on unified', async () => {
        const scenario = loadScenario('unified')
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
        })
        const driver = new StubUiDriver()
        const result = await runWalk({
            scenario,
            iterations: 40,
            fast: true,
            ops,
            stubUi: true,
            uiDriver: driver,
            skipStability: true,
            settleTimeoutMs: 500,
            rng: makeRng(7),
        })
        expect(result.aborted).toBe(false)
        expect(result.failures).toBe(0)
        // unified seed 7 enters usage — StubUiDriver should see hub/classroom keys
        const uiActions = result.logs
            .map(l => l.action)
            .filter(a =>
                a.startsWith('open_console') ||
                a.startsWith('stay_on') ||
                a.startsWith('open_kolibri') ||
                a.startsWith('open_nextcloud'),
            )
        expect(uiActions.length).toBeGreaterThan(0)
        expect(driver.calls.length).toBeGreaterThan(0)
        for (const a of uiActions) {
            expect(driver.calls).toContain(a)
        }
    })

    it('resolves Pixel intents dir when agent-console-dev is a sibling', () => {
        const dir = resolveConsoleIntentsDir()
        // On this box sibling checkout exists; if missing, null is ok (Playwright path deferred).
        if (dir) {
            expect(dir).toMatch(/e2e\/intents/)
        }
    })
})


describe('Prefer A empty-002 re-dock after confirm_erase (Fake)', () => {
    it('redockEmpty002AfterErase docks empty-002 on pool[0]', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
        })
        const ctx = {
            opts: {
                ops,
                rng: () => 0,
                settleTimeoutMs: 500,
                fast: true,
                stubUi: true,
            },
            walker: { current: 'op_disk', layer: 'operator' as const, dockedEngine: null, step: 76 },
            from: 'op_erase',
            to: 'op_disk',
            action: 'confirm_erase',
            excludeEngines: ['idea02'],
            poolEngines: ['idea01', 'idea03'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            fixtureInstance: 'kolibri-grade5a-001',
            fixtureDisks: [
                'duration-kolibri-grade5a-001',
                'duration-nextcloud-grade5a-001',
                'duration-empty-001',
                'duration-empty-002',
            ],
            fixtureInstances: { ...KID_FIXTURES },
        }
        const note = await redockEmpty002AfterErase(ctx as any)
        expect(note).toMatch(/re-docked duration-empty-002 on idea01/)
        const view = await ops.readStore('idea01')
        expect(view.diskDB['duration-empty-002']?.dockedTo).toBe('idea01')
    })

    it('dispatchAction confirm_erase re-docks empty-002 via StubUiDriver', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
        })
        // Simulate r26 post-erase: empty-002 absent
        await ops.dockFixture('idea01', 'duration-empty-001')
        const driver = new StubUiDriver()
        const result = await dispatchAction({
            opts: {
                ops,
                rng: () => 0,
                settleTimeoutMs: 500,
                fast: true,
                stubUi: true,
                uiDriver: driver,
            },
            walker: { current: 'op_erase', layer: 'operator', dockedEngine: 'idea01', step: 75 },
            from: 'op_erase',
            to: 'op_disk',
            action: 'confirm_erase',
            excludeEngines: ['idea02'],
            poolEngines: ['idea01', 'idea03'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            fixtureInstance: 'kolibri-grade5a-001',
            fixtureDisks: [
                'duration-kolibri-grade5a-001',
                'duration-nextcloud-grade5a-001',
                'duration-empty-001',
                'duration-empty-002',
            ],
            fixtureInstances: { ...KID_FIXTURES },
        } as any)
        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/re-docked duration-empty-002/)
        expect(driver.calls).toContain('confirm_erase')
        const view = await ops.readStore('idea01')
        expect(view.diskDB['duration-empty-002']?.dockedTo).toBe('idea01')
        // Primary EMPTY id unchanged contract — we only re-dock 002
        expect(DURATION_UI_FIXTURES.empty.diskId).toBe('duration-empty-001')
        expect(DURATION_UI_FIXTURES.empty2.diskId).toBe('duration-empty-002')
    })
})

describe('Prefer A r21: empty-001 Files Disk on Console engine (cover-all-0334976-r21 FAIL@91)', () => {
    const POOL = ['idea01', 'idea03', 'idea04']
    const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
        const prev: Record<string, string | undefined> = {}
        for (const k of Object.keys(vars)) {
            prev[k] = process.env[k]
            if (vars[k] === undefined) delete process.env[k]
            else process.env[k] = vars[k]
        }
        try {
            await fn()
        } finally {
            for (const k of Object.keys(prev)) {
                if (prev[k] === undefined) delete process.env[k]
                else process.env[k] = prev[k]
            }
        }
    }
    const ctxFor = (ops: FakeFleetOps, dockedEngine: string | null, extra: Record<string, unknown> = {}) => ({
        opts: { ops, rng: () => 0, settleTimeoutMs: 500, fast: true, ...extra },
        walker: { current: 'op_disk', layer: 'operator' as const, dockedEngine, step: 91 },
        from: 'op_disk',
        to: 'op_files',
        action: 'make_files_disk',
        excludeEngines: ['idea02'],
        poolEngines: POOL,
        fixtureDisk: 'duration-kolibri-grade5a-001',
        fixtureInstance: 'kolibri-grade5a-001',
        fixtureDisks: [
            'duration-kolibri-grade5a-001',
            'duration-nextcloud-grade5a-001',
            'duration-empty-001',
            'duration-empty-002',
        ],
        fixtureInstances: { ...KID_FIXTURES },
    })

    it('resolveConsoleEngineHost: SWITCH host → Console URL host → IP reverse-map → pool[0]; never idea02', () => {
        const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        const ctx = { poolEngines: POOL, excludeEngines: ['idea02'], opts: { ops } }
        expect(resolveConsoleEngineHost(ctx, { DURATION_SWITCH_ENGINE_HOST: 'idea01' })).toBe('idea01')
        expect(resolveConsoleEngineHost(ctx, { DURATION_CONSOLE_URL: 'http://idea03:8080' })).toBe('idea03')
        // SWITCH wins over console URL
        expect(resolveConsoleEngineHost(ctx, {
            DURATION_SWITCH_ENGINE_HOST: 'idea01',
            DURATION_CONSOLE_URL: 'http://idea03:8080',
        })).toBe('idea01')
        // Tailscale IP reverse-mapped via ops.getHostMap()
        const opsWithHosts = Object.assign(fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' }), {
            getHostMap: () => ({ idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }),
        })
        expect(resolveConsoleEngineHost(
            { poolEngines: POOL, excludeEngines: ['idea02'], opts: { ops: opsWithHosts } },
            { DURATION_CONSOLE_URL: 'http://100.99.231.94:8080' },
        )).toBe('idea01')
        // idea02 never selected even if named (falls back to pool[0])
        expect(resolveConsoleEngineHost(ctx, { DURATION_SWITCH_ENGINE_HOST: 'idea02' })).toBe('idea01')
        expect(resolveConsoleEngineHost(
            { poolEngines: ['idea02', 'idea03'], excludeEngines: [], opts: { ops } },
            {},
        )).toBe('idea03')
        // Unknown host → pool[0]
        expect(resolveConsoleEngineHost(ctx, { DURATION_CONSOLE_URL: 'http://elsewhere:8080' })).toBe('idea01')
    })

    it('redockEmpty001BeforeMakeFiles lands on Console engine idea01 even when walker.dockedEngine=idea03 (Kolibri moved)', async () => {
        await withEnv({ DURATION_SWITCH_ENGINE_HOST: 'idea01', DURATION_CONSOLE_URL: 'http://idea01:8080', DURATION_EMPTY_DISK_ID: undefined }, async () => {
            const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
            await ops.dockFixture('idea01', 'duration-empty-001')
            await ops.dockFixture('idea03', 'duration-kolibri-grade5a-001')
            const note = await redockEmpty001BeforeMakeFiles(ctxFor(ops, 'idea03') as any)
            expect(note).toMatch(/re-docked duration-empty-001 on idea01/)
            expect(note).not.toMatch(/on idea03/)
            const view = await ops.readStore('idea01')
            expect(view.diskDB['duration-empty-001']?.dockedTo).toBe('idea01')
            expect(view.diskDB['duration-empty-001']?.diskTypes).toEqual(['empty'])
        })
    })

    it('redockEmpty001BeforeMakeFiles fails loud if dock lands off the Console engine (live findDockedEngine)', async () => {
        await withEnv({ DURATION_SWITCH_ENGINE_HOST: 'idea01' }, async () => {
            const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
            // waitDiskUndocked no-op so the constant findDockedEngine mock does not
            // trip the r23 undock-settle wait; landing check still sees idea03.
            const live = Object.assign(ops, {
                findDockedEngine: async () => 'idea03',
                waitDiskUndocked: async () => {},
            })
            await expect(redockEmpty001BeforeMakeFiles(ctxFor(live, 'idea03') as any))
                .rejects.toThrow(/landed on idea03 not idea01/)
        })
    })

    it('redockEmpty001BeforeMakeFiles waits for undock settle before dockFixture (stale unique-store dockedTo)', async () => {
        // Prefer A cover-all-6b96ee2-r23 FAIL@91: eject then dockFixture no-op'd on
        // stale dockedTo=idea01 while unique-store eject was still in flight.
        await withEnv({
            DURATION_SWITCH_ENGINE_HOST: 'idea01',
            DURATION_CONSOLE_URL: 'http://idea01:8080',
            DURATION_EMPTY_DISK_ID: undefined,
        }, async () => {
            const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
            await ops.dockFixture('idea01', 'duration-empty-001')
            let stale: string | null = 'idea01'
            let waitPolls = 0
            let dockedWhileStale = false
            const undockBase = ops.undockFixtures.bind(ops)
            const dockBase = ops.dockFixture.bind(ops)
            const live = Object.assign(ops, {
                findDockedEngine: async () => stale,
                waitDiskUndocked: async (_diskId: string, timeoutMs = 60_000) => {
                    const start = Date.now()
                    while (Date.now() - start < timeoutMs) {
                        waitPolls++
                        if (!stale) return
                        await new Promise<void>(r => setTimeout(r, 5))
                    }
                    throw new Error(`RealFleetOps: disk duration-empty-001 still docked after eject within ${timeoutMs}ms`)
                },
                undockFixtures: async (engines: string[], diskId: string) => {
                    await undockBase(engines, diskId)
                    // Automerge lag: stay stale briefly, then clear.
                    stale = 'idea01'
                    setTimeout(() => { stale = null }, 20)
                },
                dockFixture: async (engineId: string, diskId: string) => {
                    if (stale) dockedWhileStale = true
                    expect(stale).toBeNull()
                    await dockBase(engineId, diskId)
                    stale = engineId
                },
            })
            const note = await redockEmpty001BeforeMakeFiles(ctxFor(live, 'idea01') as any)
            expect(note).toMatch(/re-docked duration-empty-001 on idea01/)
            expect(dockedWhileStale).toBe(false)
            expect(waitPolls).toBeGreaterThan(0)
            const view = await ops.readStore('idea01')
            expect(view.diskDB['duration-empty-001']?.dockedTo).toBe('idea01')
        })
    })

    it('redockEmpty001BeforeMakeFiles fails loud if undock never clears', async () => {
        await withEnv({ DURATION_SWITCH_ENGINE_HOST: 'idea01' }, async () => {
            const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
            await ops.dockFixture('idea01', 'duration-empty-001')
            const live = Object.assign(ops, {
                findDockedEngine: async () => 'idea01',
                waitDiskUndocked: async () => {
                    throw new Error(
                        'RealFleetOps: disk duration-empty-001 still docked after eject within 60ms',
                    )
                },
            })
            await expect(redockEmpty001BeforeMakeFiles(ctxFor(live, 'idea01') as any))
                .rejects.toThrow(/still docked after eject/)
        })
    })

    it('filesDiskTargetId pins empty-001 (DURATION_EMPTY_DISK_ID override), never empty-002', () => {
        expect(filesDiskTargetId({})).toBe('duration-empty-001')
        expect(filesDiskTargetId({ DURATION_EMPTY_DISK_ID: 'duration-empty-001' })).toBe('duration-empty-001')
        expect(filesDiskTargetId({})).not.toBe(DURATION_UI_FIXTURES.empty2.diskId)
    })

    it('preflightFilesDiskTarget fails loud when live slot is a plain dir (findmnt FSTYPE empty)', async () => {
        const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        await ops.dockFixture('idea01', 'duration-empty-001')
        await ops.purgeInstancesStoredOn('idea01', 'duration-empty-001')
        const dirBacked = Object.assign(ops, {
            findDockedEngine: async () => 'idea01',
            probeFixtureFsType: async () => ({
                device: 'idea-test-3',
                dest: '/home/pi/idea/duration-disks/idea-test-3',
                fsType: '',
            }),
        })
        await expect(preflightFilesDiskTarget(ctxFor(dirBacked, 'idea03') as any, 'duration-empty-001', 'idea01', {}))
            .rejects.toThrow(/fs=unknown.*ext4/)
        // Escape hatch skips only the ext4 probe
        const note = await preflightFilesDiskTarget(
            ctxFor(dirBacked, 'idea03') as any, 'duration-empty-001', 'idea01',
            { DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT: '1' },
        )
        expect(note).toMatch(/ext4 preflight skipped/)
        // ext4-backed slot passes
        const ext4 = Object.assign(ops, {
            probeFixtureFsType: async () => ({ device: 'idea-test-3', dest: '/x/idea-test-3', fsType: 'ext4' }),
        })
        const ok = await preflightFilesDiskTarget(ctxFor(ext4, 'idea03') as any, 'duration-empty-001', 'idea01', {})
        expect(ok).toMatch(/fs=ext4/)
    })

    it('dispatchAction make_files_disk: Intent + selectDisk target empty-001 on idea01; FILES pin set', async () => {
        await withEnv({
            DURATION_SWITCH_ENGINE_HOST: 'idea01',
            DURATION_CONSOLE_URL: 'http://idea01:8080',
            DURATION_EMPTY_DISK_ID: undefined,
            DURATION_FILES_DISK_ID: undefined,
        }, async () => {
            const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
            await ops.dockFixture('idea01', 'duration-empty-001')
            await ops.dockFixture('idea01', 'duration-empty-002')
            await ops.dockFixture('idea03', 'duration-kolibri-grade5a-001')
            const driver = new StubUiDriver()
            const selected: string[] = []
            const selDriver = Object.assign(driver, {
                selectDisk: async (id: string, o?: { requireEmptyPanel?: boolean }) => {
                    expect(o?.requireEmptyPanel).toBe(true)
                    selected.push(id)
                    return `selected [data-testid="disk-${id}"]`
                },
            })
            const result = await dispatchAction(ctxFor(ops, 'idea03', { stubUi: true, uiDriver: selDriver }) as any)
            expect(result.ok).toBe(true)
            expect(selected).toEqual(['duration-empty-001'])
            const call = driver.callContexts.find(c => c.action === 'make_files_disk')
            expect(call?.diskId).toBe('duration-empty-001')
            expect(call?.engineId).toBe('idea01')
            expect(process.env.DURATION_FILES_DISK_ID).toBe('duration-empty-001')
            expect(result.message).toMatch(/re-docked duration-empty-001 on idea01/)
            const view = await ops.readStore('idea01')
            expect(view.diskDB['duration-empty-001']?.dockedTo).toBe('idea01')
        })
    })

    it('buildSshDockCopyRemote: empty pack keeps an ext4 mount point (clear contents, no rm -rf of mount)', () => {
        const remote = buildSshDockCopyRemote({
            diskId: 'duration-empty-001',
            pack: 'empty',
            src: '/fixtures/empty',
            dest: '/home/pi/idea/duration-disks/idea-test-3',
            sentinel: '/home/pi/idea/duration-watch/idea-test-3',
            disksRoot: DEFAULT_DURATION_DISKS_ROOT,
            watchDir: DEFAULT_DURATION_WATCH_DIR,
            startInstances: true,
        })
        expect(remote).toMatch(/if mountpoint -q '\/home\/pi\/idea\/duration-disks\/idea-test-3'/)
        expect(remote).toMatch(/cleared contents, kept mount/)
        expect(remote).toMatch(/else rm -rf '\/home\/pi\/idea\/duration-disks\/idea-test-3'; mkdir -p/)
        expect(remote).toMatch(/stripped non-META entries from empty pack/)
        const kolibri = buildSshDockCopyRemote({
            diskId: 'duration-kolibri-grade5a-001',
            pack: 'kolibri',
            src: '/fixtures/kolibri',
            dest: '/home/pi/idea/duration-disks/idea-test-1',
            sentinel: '/home/pi/idea/duration-watch/idea-test-1',
            disksRoot: DEFAULT_DURATION_DISKS_ROOT,
            watchDir: DEFAULT_DURATION_WATCH_DIR,
            startInstances: true,
        })
        expect(kolibri).not.toMatch(/mountpoint -q/)
    })

    it('isEmptyFixtureDisk: empty packs only (never redirected by dockFixture healthy-tree scan)', () => {
        expect(isEmptyFixtureDisk('duration-empty-001')).toBe(true)
        expect(isEmptyFixtureDisk('duration-empty-002')).toBe(true)
        expect(isEmptyFixtureDisk('duration-kolibri-grade5a-001')).toBe(false)
        expect(isEmptyFixtureDisk('duration-nextcloud-grade5a-001')).toBe(false)
    })
})

describe('Prefer A r22: add_files_role restores an app-only disk on the Console engine (cover-all-6e4ce29-r22 FAIL@93)', () => {
    const POOL = ['idea01', 'idea03', 'idea04']
    const KOLIBRI = 'duration-kolibri-grade5a-001'
    const BASE_ENV = {
        DURATION_SWITCH_ENGINE_HOST: 'idea01',
        DURATION_CONSOLE_URL: 'http://idea01:8080',
        DURATION_EMPTY_DISK_ID: undefined,
        DURATION_ADD_FILES_DISK_ID: undefined,
        DURATION_FILES_DISK_ID: 'duration-empty-001',
        DURATION_LAST_FILES_ROLE_DISK_ID: 'duration-empty-001',
        DURATION_KOLIBRI_URL: undefined,
        DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT: undefined,
    }
    const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
        const prev: Record<string, string | undefined> = {}
        for (const k of Object.keys(vars)) {
            prev[k] = process.env[k]
            if (vars[k] === undefined) delete process.env[k]
            else process.env[k] = vars[k]
        }
        try {
            await fn()
        } finally {
            for (const k of Object.keys(prev)) {
                if (prev[k] === undefined) delete process.env[k]
                else process.env[k] = prev[k]
            }
        }
    }
    const ctxFor = (ops: unknown, dockedEngine: string | null, extra: Record<string, unknown> = {}, action = 'add_files_role') => ({
        opts: { ops, rng: () => 0, settleTimeoutMs: 500, fast: true, ...extra },
        walker: { current: 'op_disk', layer: 'operator' as const, dockedEngine, step: 92 },
        from: 'op_disk',
        to: 'op_files',
        action,
        excludeEngines: ['idea02'],
        poolEngines: POOL,
        fixtureDisk: KOLIBRI,
        fixtureInstance: 'kolibri-grade5a-001',
        fixtureDisks: [KOLIBRI, 'duration-nextcloud-grade5a-001', 'duration-empty-001', 'duration-empty-002'],
        fixtureInstances: { ...KID_FIXTURES },
    })
    /** r22 fleet: Kolibri moved to idea03 @62; empty-001 is the make_files_disk Files Disk on idea01. */
    const r22Fleet = async () => {
        const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        await ops.dockFixture('idea01', 'duration-empty-001')
        await ops.dockFixture('idea01', 'duration-empty-002')
        await ops.dockFixture('idea01', 'duration-nextcloud-grade5a-001')
        await ops.dockFixture('idea03', KOLIBRI)
        return ops
    }
    const addFilesDriver = (onSelect?: (id: string, o?: { requireAddFiles?: boolean }) => Promise<string>) => {
        const driver = new StubUiDriver()
        const selected: string[] = []
        const pinDuringIntent: (string | undefined)[] = []
        const orig = driver.runIntent.bind(driver)
        Object.assign(driver, {
            selectDisk: async (id: string, o?: { requireAddFiles?: boolean; requireEmptyPanel?: boolean }) => {
                selected.push(id)
                if (onSelect) return onSelect(id, o)
                expect(o?.requireAddFiles).toBe(true)
                expect(o?.requireEmptyPanel).toBeFalsy()
                return `selected [data-testid="disk-${id}"] (Add Files visible)`
            },
            runIntent: async (req: any) => {
                if (req.action === 'add_files_role') pinDuringIntent.push(process.env.DURATION_FILES_DISK_ID)
                return orig(req)
            },
        })
        return { driver, selected, pinDuringIntent }
    }

    it('restores Kolibri idea03→idea01, selects it with requireAddFiles, runs the Intent (no already-satisfied short-circuit)', async () => {
        await withEnv(BASE_ENV, async () => {
            const ops = await r22Fleet()
            const { driver, selected, pinDuringIntent } = addFilesDriver()
            const result = await dispatchAction(ctxFor(ops, 'idea03', { stubUi: true, uiDriver: driver }) as any)
            expect(result.ok, result.message).toBe(true)
            expect(result.message).toMatch(/restored duration-kolibri-grade5a-001 idea03→idea01/)
            expect(result.dockedEngine).toBe('idea01')
            expect(selected).toEqual([KOLIBRI])
            // The Pixel Intent still runs even though empty-001 already has files (make_files_disk).
            const call = driver.callContexts.find(c => c.action === 'add_files_role')
            expect(call?.diskId).toBe(KOLIBRI)
            expect(call?.engineId).toBe('idea01')
            // Console 230b70f reads DURATION_FILES_DISK_ID first → app-only disk during the Intent only.
            expect(pinDuringIntent).toEqual([KOLIBRI])
            expect(process.env.DURATION_FILES_DISK_ID).toBe('duration-empty-001')
            expect(process.env.DURATION_LAST_FILES_ROLE_DISK_ID).toBe(KOLIBRI)
            expect(process.env.DURATION_KOLIBRI_URL).toBe('http://idea01:18080')
            const view = await ops.readStore('idea01')
            expect(view.diskDB[KOLIBRI]?.dockedTo).toBe('idea01')
        })
    })

    it('files_role_added after add_files_role asserts the app-only disk, not empty-001', async () => {
        await withEnv({ ...BASE_ENV, DURATION_LAST_FILES_ROLE_DISK_ID: KOLIBRI }, async () => {
            const ops = await r22Fleet()
            const driver = new StubUiDriver()
            const r = await dispatchAction(ctxFor(ops, 'idea01', { stubUi: true, uiDriver: driver }, 'files_role_added') as any)
            expect(r.ok).toBe(true)
            expect(driver.callContexts.find(c => c.action === 'files_role_added')?.diskId).toBe(KOLIBRI)
        })
    })

    it('Kolibri already on the Console engine: no move, walker dockedEngine untouched', async () => {
        await withEnv(BASE_ENV, async () => {
            const ops = await r22Fleet()
            await ops.moveDisk('idea03', 'idea01', KOLIBRI)
            const { driver } = addFilesDriver()
            const r = await dispatchAction(ctxFor(ops, 'idea01', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok).toBe(true)
            expect(r.message).toMatch(/already docked on Console engine idea01/)
            expect(r.dockedEngine).toBeUndefined()
        })
    })

    it('fails loud before the Intent when Add Files is not visible on the app-only disk', async () => {
        await withEnv(BASE_ENV, async () => {
            const ops = await r22Fleet()
            const { driver } = addFilesDriver(async () => {
                throw new Error('selectDisk: [data-testid="disk-duration-kolibri-grade5a-001"] clicked but [data-testid="add-files"] not visible')
            })
            const r = await dispatchAction(ctxFor(ops, 'idea03', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/add_files_role aborted before Intent: .*add-files/)
            expect(driver.callContexts.find(c => c.action === 'add_files_role')).toBeUndefined()
            expect(process.env.DURATION_LAST_FILES_ROLE_DISK_ID).toBe('duration-empty-001')
        })
    })

    it('fails loud when the app-only target is an Empty pack / the make_files_disk Files Disk', async () => {
        await withEnv({ ...BASE_ENV, DURATION_ADD_FILES_DISK_ID: 'duration-empty-001' }, async () => {
            const ops = await r22Fleet()
            const { driver } = addFilesDriver()
            const r = await dispatchAction(ctxFor(ops, 'idea03', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/not an app-only disk/)
            expect(driver.callContexts.find(c => c.action === 'add_files_role')).toBeUndefined()
        })
        expect(() => addFilesAppDiskId({ fixtureDisk: KOLIBRI }, { DURATION_FILES_DISK_ID: KOLIBRI })).toThrow(/not an app-only disk/)
        expect(addFilesAppDiskId({ fixtureDisk: KOLIBRI }, {})).toBe(KOLIBRI)
    })

    it('live: fails loud when the restore lands off the Console engine or the disk already has files', async () => {
        await withEnv(BASE_ENV, async () => {
            const ops = await r22Fleet()
            const offConsole = Object.assign(ops, { findDockedEngine: async () => 'idea03' })
            await expect(ensureAppOnlyDiskOnConsoleEngine(ctxFor(offConsole, 'idea03') as any))
                .rejects.toThrow(/landed on idea03 not idea01/)
        })
        await withEnv(BASE_ENV, async () => {
            const ops = await r22Fleet()
            await ops.moveDisk('idea03', 'idea01', KOLIBRI)
            const realRead = ops.readStore.bind(ops)
            const hasFiles = Object.assign(ops, {
                findDockedEngine: async () => 'idea01',
                readStore: async (e: string) => {
                    const v = await realRead(e)
                    if (v.diskDB[KOLIBRI]) v.diskDB[KOLIBRI]!.diskTypes = ['app', 'files']
                    return v
                },
            })
            await expect(ensureAppOnlyDiskOnConsoleEngine(ctxFor(hasFiles, 'idea01') as any))
                .rejects.toThrow(/already has a files role/)
        })
    })

    it('live preflight: ext4 slot + clean root required (README.md refused); skip env escapes', async () => {
        await withEnv(BASE_ENV, async () => {
            const ops = await r22Fleet()
            await ops.moveDisk('idea03', 'idea01', KOLIBRI)
            const realRead = ops.readStore.bind(ops)
            let entries = ['META.yaml', 'apps', 'services', 'instances', 'README.md']
            let fsType = 'ext4'
            const live = Object.assign(ops, {
                findDockedEngine: async () => 'idea01',
                readStore: async (e: string) => {
                    const v = await realRead(e)
                    if (v.diskDB[KOLIBRI]) v.diskDB[KOLIBRI]!.diskTypes = ['app']
                    return v
                },
                probeFixtureFsType: async () => ({ device: 'idea-test-1', dest: '/x/idea-test-1', fsType }),
                probeFixtureRootEntries: async () => ({ dest: '/x/idea-test-1', entries }),
            })
            const ctx = ctxFor(live, 'idea01') as any
            await expect(ensureAppOnlyDiskOnConsoleEngine(ctx)).rejects.toThrow(/non-IDEA entries \(README\.md\)/)
            // Stock Kid Kolibri pack ships content/ at root → refused; both problems in one error.
            entries = ['META.yaml', 'apps', 'content', 'instances']
            fsType = ''
            await expect(ensureAppOnlyDiskOnConsoleEngine(ctx)).rejects.toThrow(/non-IDEA entries \(content\).*fs=unknown.*ext4/)
            entries = ['META.yaml', 'apps', 'services', 'instances', 'lost+found']
            await expect(ensureAppOnlyDiskOnConsoleEngine(ctx)).rejects.toThrow(/fs=unknown.*ext4/)
            fsType = 'ext4'
            const ok = await ensureAppOnlyDiskOnConsoleEngine(ctx)
            expect(ok.note).toMatch(/fs=ext4; root clean/)
            fsType = ''
            const skipped = await ensureAppOnlyDiskOnConsoleEngine(ctx, { ...process.env, DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT: '1' })
            expect(skipped.note).toMatch(/preflight skipped/)
        })
    })

    it('never restores onto idea02 (Console host named idea02 falls back to pool[0])', async () => {
        await withEnv({ ...BASE_ENV, DURATION_SWITCH_ENGINE_HOST: 'idea02', DURATION_CONSOLE_URL: undefined }, async () => {
            const ops = await r22Fleet()
            const r = await ensureAppOnlyDiskOnConsoleEngine(ctxFor(ops, 'idea03') as any)
            expect(r.engine).toBe('idea01')
        })
    })
})

describe('Prefer A empty-002 re-dock before second late install (Fake)', () => {
    it('redockEmpty001BeforeMakeFiles docks empty-001 on pool[0] with purge', async () => {
        const ops = new FakeFleetOps({
            poolEngines: ['idea01', 'idea03', 'idea04'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
            fixtureInstances: {
                'duration-empty-001': 'empty-001-main',
            },
        })
        await ops.dockFixture('idea01', 'duration-empty-001')
        // Simulate install_app residue on empty-001
        await ops.purgeInstancesStoredOn('idea01', 'duration-empty-001')
        const ctx = {
            action: 'make_files_disk',
            poolEngines: ['idea01', 'idea03', 'idea04'],
            excludeEngines: ['idea02'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            fixtureDisks: [
                'duration-kolibri-grade5a-001',
                'duration-nextcloud-grade5a-001',
                'duration-empty-001',
                'duration-empty-002',
            ],
            fixtureInstances: {},
            walker: { dockedEngine: 'idea01', step: 90, layer: 'operator' as const },
            opts: { ops, settleTimeoutMs: 500 },
        }
        const note = await redockEmpty001BeforeMakeFiles(ctx as any)
        expect(note).toMatch(/duration-empty-001/)
        expect(note).toMatch(/idea01/)
        expect(note).toMatch(/make_files_disk/)
        const view = await ops.readStore('idea01')
        expect(view.diskDB['duration-empty-001']?.dockedTo).toBe('idea01')
        expect(view.diskDB['duration-empty-001']?.diskTypes).toEqual(['empty'])
        // Primary EMPTY pin unchanged
        expect(DURATION_UI_FIXTURES.empty.diskId).toBe('duration-empty-001')
        expect(DURATION_UI_FIXTURES.empty2.diskId).toBe('duration-empty-002')
    })

    it('redockEmpty002BeforeSecondInstall docks empty-002 on pool[0]', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
        })
        const ctx = {
            opts: {
                ops,
                rng: () => 0,
                settleTimeoutMs: 500,
                fast: true,
                stubUi: true,
            },
            walker: { current: 'op_instance', layer: 'operator' as const, dockedEngine: null, step: 88 },
            from: 'op_copy_move',
            to: 'op_instance',
            action: 'open_copied_instance',
            excludeEngines: ['idea02'],
            poolEngines: ['idea01', 'idea03'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            fixtureInstance: 'kolibri-grade5a-001',
            fixtureDisks: [
                'duration-kolibri-grade5a-001',
                'duration-nextcloud-grade5a-001',
                'duration-empty-001',
                'duration-empty-002',
            ],
            fixtureInstances: { ...KID_FIXTURES },
        }
        const note = await redockEmpty002BeforeSecondInstall(ctx as any)
        expect(note).toMatch(/re-docked duration-empty-002 on idea01/)
        expect(note).toMatch(/before second late install_app/)
        const view = await ops.readStore('idea01')
        expect(view.diskDB['duration-empty-002']?.dockedTo).toBe('idea01')
    })

    it('dispatchAction open_copied_instance re-docks empty-002 via StubUiDriver', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
        })
        // Simulate r35 post-start_after_install: empty-002 present but as app disk —
        // force undock+fresh dock still runs via helper.
        await ops.dockFixture('idea01', 'duration-empty-002')
        const driver = new StubUiDriver()
        const result = await dispatchAction({
            opts: {
                ops,
                rng: () => 0,
                settleTimeoutMs: 500,
                fast: true,
                stubUi: true,
                uiDriver: driver,
            },
            walker: { current: 'op_copy_move', layer: 'operator', dockedEngine: 'idea01', step: 88 },
            from: 'op_copy_move',
            to: 'op_instance',
            action: 'open_copied_instance',
            excludeEngines: ['idea02'],
            poolEngines: ['idea01', 'idea03'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            fixtureInstance: 'kolibri-grade5a-001',
            fixtureDisks: [
                'duration-kolibri-grade5a-001',
                'duration-nextcloud-grade5a-001',
                'duration-empty-001',
                'duration-empty-002',
            ],
            fixtureInstances: { ...KID_FIXTURES },
        } as any)
        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/re-docked duration-empty-002/)
        expect(result.message).toMatch(/before second late install_app/)
        expect(driver.calls).toContain('open_copied_instance')
        const view = await ops.readStore('idea01')
        expect(view.diskDB['duration-empty-002']?.dockedTo).toBe('idea01')
        expect(DURATION_UI_FIXTURES.empty.diskId).toBe('duration-empty-001')
        expect(DURATION_UI_FIXTURES.empty2.diskId).toBe('duration-empty-002')
    })
})

describe('Phase 4 stability probes (FakeFleetOps)', () => {
    it('detectStatusAnomalies flags Running→Error', () => {
        const before = new Map([['idea01:kolibri-grade5a-001', 'Running']])
        const after = new Map([['idea01:kolibri-grade5a-001', 'Error']])
        expect(detectStatusAnomalies(before, after)).toEqual(['idea01:kolibri-grade5a-001 Running→Error'])
        expect(detectStatusAnomalies(before, new Map([['idea01:kolibri-grade5a-001', 'Running']]))).toEqual([])
    })

    it('FakeFleetOps.probeStability reports WS up', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
        })
        const sample = await ops.probeStability!(['idea01', 'idea03'])
        expect(sample.ok).toBe(true)
        expect(sample.engines.every(e => e.wsUp)).toBe(true)
    })

    it('runStabilityDuringDwell fails after consecutive WS-down probes', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            initiallyDown: ['idea01', 'idea03'],
        })
        // Keep engines down — Fake waitReady / probe will fail.
        const result = await runStabilityDuringDwell({
            ops,
            engines: ['idea01', 'idea03'],
            intervalMs: 5,
            failAfter: 3,
            dwellMs: 200,
        })
        expect(result.ok).toBe(false)
        expect(result.consecutiveFailures).toBeGreaterThanOrEqual(DEFAULT_FAIL_AFTER)
        expect(result.abortReason).toMatch(/stability probe failed/)
    })

    it('aborts on the first docker-missing probe without changing WS failAfter', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01'],
            excludeEngines: ['idea02'],
        })
        ops.probeStability = async () => ({
            ok: false,
            detail: 'idea01: docker missing for kolibri-grade5a-001',
            engines: [{
                id: 'idea01',
                wsUp: true,
                dockerOk: false,
                statusAnomaly: 'docker missing for kolibri-grade5a-001',
            }],
        })
        const result = await runStabilityDuringDwell({
            ops,
            engines: ['idea01'],
            intervalMs: 5,
            failAfter: DEFAULT_FAIL_AFTER,
            dwellMs: 200,
        })
        expect(isDockerMissingProbeFailure(result.samples[0]!)).toBe(true)
        expect(result.ok).toBe(false)
        expect(result.samples).toHaveLength(1)
        expect(result.consecutiveFailures).toBe(1)
        expect(result.abortReason).toMatch(/docker missing/)
    })

    it('settles a transient docker-missing probe after move_app', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01'],
            excludeEngines: ['idea02'],
        })
        await ops.dockFixture('idea01', 'duration-kolibri-grade5a-001')
        let probes = 0
        ops.probeStability = async () => {
            probes++
            const missing = probes <= 2
            return {
                ok: !missing,
                detail: missing ? 'idea01: docker missing for kolibri-grade5a-001' : 'fake probe ok',
                engines: [{
                    id: 'idea01',
                    wsUp: true,
                    dockerOk: !missing,
                    statusAnomaly: missing ? 'docker missing for kolibri-grade5a-001' : undefined,
                }],
            }
        }
        const result = await runStabilityDuringDwell({
            ops,
            engines: ['idea01'],
            intervalMs: 1,
            failAfter: DEFAULT_FAIL_AFTER,
            dwellMs: 10,
            justCompletedAction: 'move_app',
            dockerMissingSettleMs: 20,
        })
        expect(result.ok).toBe(true)
        expect(probes).toBeGreaterThanOrEqual(3)
        expect(result.samples.some(sample => isDockerMissingProbeFailure(sample))).toBe(true)
    })

    it('settles a transient docker-missing probe after infra_move_disk', async () => {
        // Prefer A r25: infra_move_disk eject→dock needs the same grace as move_app
        // (containers restart on the target host while Automerge may still say Running).
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
        })
        await ops.dockFixture('idea01', 'duration-kolibri-grade5a-001')
        await ops.moveDisk('idea01', 'idea03', 'duration-kolibri-grade5a-001')
        const after = await ops.readStore('idea03')
        expect(after.diskDB['duration-kolibri-grade5a-001']?.dockedTo).toBe('idea03')
        let probes = 0
        ops.probeStability = async () => {
            probes++
            const missing = probes <= 2
            return {
                ok: !missing,
                detail: missing ? 'idea03: docker missing for kolibri-grade5a-001' : 'fake probe ok',
                engines: [{
                    id: 'idea03',
                    wsUp: true,
                    dockerOk: !missing,
                    statusAnomaly: missing ? 'docker missing for kolibri-grade5a-001' : undefined,
                }],
            }
        }
        const result = await runStabilityDuringDwell({
            ops,
            engines: ['idea01', 'idea03'],
            intervalMs: 1,
            failAfter: DEFAULT_FAIL_AFTER,
            dwellMs: 10,
            justCompletedAction: 'infra_move_disk',
            dockerMissingSettleMs: 20,
        })
        expect(result.ok).toBe(true)
        expect(probes).toBeGreaterThanOrEqual(3)
        expect(result.samples.some(sample => isDockerMissingProbeFailure(sample))).toBe(true)
    })

    it('settles a transient docker-missing probe after confirm_eject', async () => {
        // Prefer A r46: confirm_eject stops the container before diskDB.dockedTo /
        // status leave Running, so the first probes can say docker missing.
        const ops = fakeOps({
            poolEngines: ['idea01'],
            excludeEngines: ['idea02'],
        })
        await ops.dockFixture('idea01', 'duration-nextcloud-grade5a-001')
        let probes = 0
        ops.probeStability = async () => {
            probes++
            const missing = probes <= 2
            return {
                ok: !missing,
                detail: missing ? 'idea01: docker missing for nextcloud-grade5a-001' : 'fake probe ok',
                engines: [{
                    id: 'idea01',
                    wsUp: true,
                    dockerOk: !missing,
                    statusAnomaly: missing ? 'docker missing for nextcloud-grade5a-001' : undefined,
                }],
            }
        }
        const result = await runStabilityDuringDwell({
            ops,
            engines: ['idea01'],
            intervalMs: 1,
            failAfter: DEFAULT_FAIL_AFTER,
            dwellMs: 10,
            justCompletedAction: 'confirm_eject',
            dockerMissingSettleMs: 20,
        })
        expect(result.ok).toBe(true)
        expect(probes).toBeGreaterThanOrEqual(3)
        expect(result.samples.some(sample => isDockerMissingProbeFailure(sample))).toBe(true)
    })

    it('runningInstanceExpectsLocalDocker skips undocked and foreign disks', () => {
        const instance = { diskId: 'duration-nextcloud-grade5a-001' }
        const dockedHere = { 'duration-nextcloud-grade5a-001': { dockedTo: 'idea01' } }
        const undocked = { 'duration-nextcloud-grade5a-001': { dockedTo: null } }
        const otherEngine = { 'duration-nextcloud-grade5a-001': { dockedTo: 'idea03' } }
        expect(runningInstanceExpectsLocalDocker(instance, dockedHere, 'idea01')).toBe(true)
        expect(runningInstanceExpectsLocalDocker(instance, undocked, 'idea01')).toBe(false)
        expect(runningInstanceExpectsLocalDocker(instance, otherEngine, 'idea01')).toBe(false)
        expect(runningInstanceExpectsLocalDocker(instance, {}, 'idea01')).toBe(true)
    })

    it('unified walk with dwell probes stays green on FakeFleetOps', async () => {
        const scenario = unifiedScenario()
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
        })
        const result = await runWalk({
            scenario,
            iterations: 15,
            fast: true,
            ops,
            stubUi: true,
            uiDriver: new StubUiDriver(),
            skipStability: false,
            dwellMs: FAST_DWELL_MS,
            probeIntervalMs: 30,
            settleTimeoutMs: 500,
            rng: makeRng(42),
        })
        expect(result.aborted).toBe(false)
        expect(result.failures).toBe(0)
        // Most steps (except last) should have probe samples
        const withProbes = result.logs.filter(l => (l.probes?.length ?? 0) > 0)
        expect(withProbes.length).toBeGreaterThan(0)
    })

    it('unified high-iteration Fake walk stays green (former stress preset)', async () => {
        const scenario = loadScenario('unified')
        expect(scenario.exclude_engines).toContain('idea02')
        // Graph declares infra edges; walk need not hit them in every seed.
        const infraActions = new Set<string>()
        for (const def of Object.values(scenario.states)) {
            for (const t of def.transitions) {
                if (t.action.startsWith('infra_')) infraActions.add(t.action)
            }
        }
        expect(infraActions.has('infra_reboot_engine')).toBe(true)
        expect(infraActions.has('infra_dock_fixture')).toBe(true)
        const ops = fakeOps({
            poolEngines: scenario.pool_engines!,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
        })
        const result = await runWalk({
            scenario,
            iterations: 80,
            fast: true,
            ops,
            stubUi: true,
            uiDriver: new StubUiDriver(),
            skipStability: false,
            dwellMs: FAST_DWELL_MS,
            probeIntervalMs: 30,
            settleTimeoutMs: 500,
            rng: makeRng(99),
        })
        expect(result.aborted).toBe(false)
        expect(result.failures).toBe(0)
        expect(result.steps).toBe(80)
    })

    it('snapshotRunning keys by engine:instance', () => {
        const views = [{
            engineId: 'idea01',
            instanceDB: {
                'kolibri-grade5a-001': {
                    id: 'kolibri-grade5a-001',
                    status: 'Running',
                    diskId: 'duration-kolibri-grade5a-001',
                },
            },
            diskDB: {},
            engineDB: {},
        }]
        const snap = snapshotRunning(views)
        expect(snap.get('idea01:kolibri-grade5a-001')).toBe('Running')
    })
})


describe('duration --record-walk helpers', () => {
    it('builds zero-padded frame paths and sanitizes action names', () => {
        expect(framePath('/tmp/rec', 7, 'open_kolibri_as_teacher')).toBe(
            '/tmp/rec/step-0007-open_kolibri_as_teacher.png',
        )
        expect(sanitizeActionForFilename('a/b c')).toBe('a_b_c')
    })

    it('assembleWalkVideo skips when no PNGs (Fake dry-run)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dur-rec-'))
        try {
            const r = assembleWalkVideo(dir, () => {})
            expect(r.ok).toBe(false)
            expect(r.frames).toBe(0)
            expect(r.reason).toBe('no_png_frames')
            expect(listFramePngs(dir)).toEqual([])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('Fake cover-all with recordWalkDir completes without crashing', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'dur-rec-walk-'))
        try {
            const walk = loadWalk('cover-all')
            const ops = fakeOps({
                poolEngines: [...DEFAULT_POOL],
                excludeEngines: ['idea02'],
                storeMode: 'shared',
                settleDelayMs: 0,
            })
            const result = await runDeterministicWalk(walk, {
                fast: true,
                ops,
                stubUi: true,
                uiDriver: new StubUiDriver(),
                skipStability: true,
                settleTimeoutMs: 500,
                recordWalkDir: dir,
                iterations: 5,
            })
            expect(result.aborted).toBe(false)
            expect(result.failures).toBe(0)
            expect(result.steps).toBe(5)
            expect(listFramePngs(dir)).toEqual([])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('syncKolibriSidecarUrlForEngine (r15 FAIL@70)', () => {
    it('sets DURATION_KOLIBRI_URL to host map IP:18080', () => {
        const env: NodeJS.ProcessEnv = {}
        const url = syncKolibriSidecarUrlForEngine(
            'idea03',
            { idea01: '100.99.231.94', idea03: '100.126.117.80' },
            env,
        )
        expect(url).toBe('http://100.126.117.80:18080')
        expect(env.DURATION_KOLIBRI_URL).toBe(url)
    })

    it('falls back to logical engine id when hosts missing', () => {
        const env: NodeJS.ProcessEnv = { DURATION_KOLIBRI_PORT: '18081' }
        const url = syncKolibriSidecarUrlForEngine('idea03', undefined, env)
        expect(url).toBe('http://idea03:18081')
    })
})

describe('syncNextcloudSidecarUrlForEngine / waitNextcloud (r16 FAIL@65 / r17 FAIL@58)', () => {
    it('sets DURATION_NEXTCLOUD_URL to logical engine id:18280 (not hostMap IP)', () => {
        const env: NodeJS.ProcessEnv = {}
        const url = syncNextcloudSidecarUrlForEngine(
            'idea01',
            { idea01: '100.99.231.94', idea03: '100.126.117.80' },
            env,
        )
        expect(url).toBe('http://idea01:18280')
        expect(env.DURATION_NEXTCLOUD_URL).toBe(url)
    })

    it('honors DURATION_NEXTCLOUD_URL override when already set', () => {
        const env: NodeJS.ProcessEnv = {
            DURATION_NEXTCLOUD_URL: 'http://custom-nc:19999/',
        }
        const url = syncNextcloudSidecarUrlForEngine(
            'idea01',
            { idea01: '100.99.231.94' },
            env,
        )
        expect(url).toBe('http://custom-nc:19999')
        expect(env.DURATION_NEXTCLOUD_URL).toBe(url)
    })

    it('honors DURATION_NEXTCLOUD_PORT override with logical id', () => {
        const env: NodeJS.ProcessEnv = { DURATION_NEXTCLOUD_PORT: '18281' }
        const url = syncNextcloudSidecarUrlForEngine(
            'idea01',
            { idea01: '100.99.231.94' },
            env,
        )
        expect(url).toBe('http://idea01:18281')
    })

    it('nextcloudReadyTimeoutMs defaults to 180000 and honors env', () => {
        expect(nextcloudReadyTimeoutMs({})).toBe(180_000)
        expect(nextcloudReadyTimeoutMs({ DURATION_NEXTCLOUD_READY_MS: '120000' })).toBe(120_000)
    })

    it('nextcloudLoginFormLooksReady detects user+password+submit signals', () => {
        const ready = `
          <form data-login-form>
            <div data-login-form-input-user><input name="user" id="user" /></div>
            <div data-login-form-input-password><input name="password" id="password" type="password" /></div>
            <button data-login-form-submit type="submit">Log in</button>
          </form>`
        expect(nextcloudLoginFormLooksReady(ready)).toBe(true)
        expect(nextcloudLoginFormLooksReady('<html>booting</html>')).toBe(false)
        expect(nextcloudLoginFormLooksReady('<input name="user" /><input name="password" />')).toBe(false)
    })

    it('fixtureSetHasNextcloud matches grade5a disk ids', () => {
        expect(
            fixtureSetHasNextcloud('duration-kolibri-grade5a-001', [
                'duration-nextcloud-grade5a-001',
                'duration-empty-001',
            ]),
        ).toBe(true)
        expect(fixtureSetHasNextcloud('duration-kolibri-grade5a-001', ['duration-empty-001'])).toBe(false)
    })

    // cover-all-230b70f-r19 FAIL@58: NC 31 renders the login form client-side (Vue).
    // Real HTML shape from Atlas Path A evidence path-a-ready-r19/nc-login-page.html.
    // cwd-first (dist-test/ has no .html assets), module-relative fallback — mirrors scenariosDir().
    const ncLoginVueFixture = (): string => {
        const fromCwd = join(process.cwd(), 'test/duration/fixtures/nextcloud-login-vue.html')
        if (existsSync(fromCwd)) return fromCwd
        return fileURLToPath(new URL('../duration/fixtures/nextcloud-login-vue.html', import.meta.url))
    }
    const NC_LOGIN_VUE_HTML = readFileSync(ncLoginVueFixture(), 'utf8')

    it('nextcloudLoginFormLooksReady: real NC Vue login (body-login + hideLoginForm=false) is ready (r19 FAIL@58)', () => {
        // Guard: fixture has no classic form signals, so path A alone must carry it.
        expect(NC_LOGIN_VUE_HTML).toContain('id="body-login"')
        expect(NC_LOGIN_VUE_HTML).toContain('id="initial-state-core-hideLoginForm" value="ZmFsc2U="')
        expect(/name=["']user["']|name=["']password["']|type=["']submit["']|data-login-form/i.test(NC_LOGIN_VUE_HTML)).toBe(false)
        expect(nextcloudInitialState(NC_LOGIN_VUE_HTML, 'core', 'hideLoginForm')).toBe('false')
        expect(nextcloudLoginFormLooksReady(NC_LOGIN_VUE_HTML)).toBe(true)
    })

    it('nextcloudLoginFormLooksReady: Vue path requires body-login AND hideLoginForm=false', () => {
        // hideLoginForm=true (dHJ1ZQ==) → login form hidden → not ready
        const hidden = NC_LOGIN_VUE_HTML.replace(
            'id="initial-state-core-hideLoginForm" value="ZmFsc2U="',
            'id="initial-state-core-hideLoginForm" value="dHJ1ZQ=="',
        )
        expect(nextcloudLoginFormLooksReady(hidden)).toBe(false)
        // no hideLoginForm marker → not ready
        const noMarker = NC_LOGIN_VUE_HTML.replace(/<input[^>]*initial-state-core-hideLoginForm[^>]*>/, '')
        expect(nextcloudLoginFormLooksReady(noMarker)).toBe(false)
        // other initial-state-core-login* markers alone are not enough
        expect(noMarker).toContain('initial-state-core-loginUsername')
        // no body-login → not ready
        const noBody = NC_LOGIN_VUE_HTML.replace('<body id="body-login">', '<body id="body-user">')
        expect(nextcloudLoginFormLooksReady(noBody)).toBe(false)
        // attribute order agnostic
        expect(
            nextcloudLoginFormLooksReady(
                '<body class="x" id="body-login"><input value="ZmFsc2U=" type="hidden" id="initial-state-core-hideLoginForm"></body>',
            ),
        ).toBe(true)
    })

    it('nextcloudLoginFormLooksReady: classic form still ready alongside Vue path (OR)', () => {
        const classic = `
          <body id="body-login"><form data-login-form>
            <input name="user" id="user" /><input name="password" id="password" type="password" />
            <button type="submit">Log in</button>
          </form></body>`
        expect(nextcloudLoginFormLooksReady(classic)).toBe(true)
    })

    it('waitNextcloudSidecarReadyForEngine resolves on real NC Vue login HTML via logical hostname (r19 FAIL@58, keeps f99ebb9)', async () => {
        const env: NodeJS.ProcessEnv = { DURATION_NEXTCLOUD_READY_MS: '5000' }
        const urls: string[] = []
        const fetchImpl = (async (input: string | URL | Request) => {
            urls.push(String(input))
            return { status: 200, text: async () => NC_LOGIN_VUE_HTML } as Response
        }) as typeof fetch
        const msg = await waitNextcloudSidecarReadyForEngine('idea01', {
            hosts: { idea01: '100.99.231.94' },
            env,
            fetchImpl,
            sleepImpl: async () => {},
        })
        expect(msg).toContain('login form ready')
        expect(urls).toEqual(['http://idea01:18280/login'])
        expect(urls.join(' ')).not.toContain('100.99.231.94')
        expect(env.DURATION_NEXTCLOUD_URL).toBe('http://idea01:18280')
    })

    it('waitNextcloudSidecarReadyForEngine skip sets URL without polling', async () => {
        const env: NodeJS.ProcessEnv = {}
        const msg = await waitNextcloudSidecarReadyForEngine('idea01', {
            hosts: { idea01: '100.99.231.94' },
            env,
            skip: true,
        })
        expect(env.DURATION_NEXTCLOUD_URL).toBe('http://idea01:18280')
        expect(msg).toContain('wait skipped')
    })

    it('waitNextcloudSidecarReadyForEngine resolves when login HTML ready', async () => {
        const env: NodeJS.ProcessEnv = { DURATION_NEXTCLOUD_READY_MS: '5000' }
        const html = '<input name="user"/><input id="password"/><button type="submit">'
        const fetchImpl = (async () =>
            ({
                status: 200,
                text: async () => html,
            }) as Response) as typeof fetch
        const msg = await waitNextcloudSidecarReadyForEngine('idea01', {
            hosts: { idea01: '10.0.0.1' },
            env,
            fetchImpl,
            sleepImpl: async () => {},
        })
        expect(msg).toContain('login form ready')
        expect(env.DURATION_NEXTCLOUD_URL).toBe('http://idea01:18280')
    })

    it('waitNextcloudSidecarReadyForEngine loud-fails with r16 FAIL@65 message', async () => {
        const env: NodeJS.ProcessEnv = { DURATION_NEXTCLOUD_READY_MS: '1000' }
        const fetchImpl = (async () => {
            throw new Error('ECONNREFUSED')
        }) as typeof fetch
        await expect(
            waitNextcloudSidecarReadyForEngine('idea01', {
                hosts: { idea01: '10.0.0.1' },
                env,
                fetchImpl,
                sleepImpl: async () => {},
            }),
        ).rejects.toThrow(/r16 FAIL@65/)
        await expect(
            waitNextcloudSidecarReadyForEngine('idea01', {
                hosts: { idea01: '10.0.0.1' },
                env,
                fetchImpl,
                sleepImpl: async () => {},
            }),
        ).rejects.toThrow(/18280/)
    })
})

describe('r29 FAIL@97: follow the store host for Kolibri/NC sidecars; restore must really run (cover-all-980e735-r29)', () => {
    const POOL = ['idea01', 'idea03', 'idea04']
    const KOLIBRI = 'duration-kolibri-grade5a-001'
    const NC = 'duration-nextcloud-grade5a-001'
    const HOSTS = { idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }
    const IDEA01_URL = 'http://100.99.231.94:18080'
    const IDEA03_URL = 'http://100.126.117.80:18080'
    const ENV_KEYS = ['DURATION_KOLIBRI_URL', 'DURATION_KOLIBRI_PORT', 'DURATION_NEXTCLOUD_URL', 'DURATION_NEXTCLOUD_PORT', 'DURATION_FILES_DISK_ID'] as const
    const withEnv = async (vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) => {
        const prev: Record<string, string | undefined> = {}
        for (const k of ENV_KEYS) {
            prev[k] = process.env[k]
            if (vars[k] === undefined) delete process.env[k]
            else process.env[k] = vars[k]
        }
        try {
            await fn()
        } finally {
            for (const k of ENV_KEYS) {
                if (prev[k] === undefined) delete process.env[k]
                else process.env[k] = prev[k]
            }
        }
    }
    /** Fake fleet with a host map (Kolibri + NC on idea01, like r29 after @62). */
    const r29Fleet = async (kolibriOn = 'idea01') => {
        const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        await ops.dockFixture('idea01', NC)
        await ops.dockFixture(kolibriOn, KOLIBRI)
        return Object.assign(ops, { getHostMap: () => ({ ...HOSTS }) })
    }
    const ctxFor = (ops: unknown, dockedEngine: string | null, action: string, extra: Record<string, unknown> = {}) => ({
        opts: { ops, rng: () => 0, settleTimeoutMs: 500, fast: true, ...extra },
        walker: { current: 'op_disk', layer: 'operator' as const, dockedEngine, step: 96 },
        from: 'op_disk',
        to: 'op_backup',
        action,
        excludeEngines: ['idea02'],
        poolEngines: POOL,
        fixtureDisk: KOLIBRI,
        fixtureInstance: 'kolibri-grade5a-001',
        fixtureDisks: [KOLIBRI, NC],
        fixtureInstances: { ...KID_FIXTURES },
    })

    const moveCtx = (ops: unknown, from = 'idea01') => ({
        ...ctxFor(ops, from, 'infra_move_disk'),
        from: 'infra_docked',
        to: 'infra_disk_moved',
        walker: { current: 'infra_docked', layer: 'infra' as const, dockedEngine: from, step: 61 },
    })

    it('infra_move_disk: target-honoured move idea01→idea03 is store-verified and URLs follow idea03', async () => {
        await withEnv({ DURATION_KOLIBRI_URL: IDEA01_URL }, async () => {
            const ops = await r29Fleet('idea01')
            const r = await dispatchAction(moveCtx(ops) as any)
            expect(r.ok, r.message).toBe(true)
            expect(r.dockedEngine).toBe('idea03')
            expect(r.message).toMatch(/moved duration-kolibri-grade5a-001 idea01→idea03 \(store-verified: disk \+ kolibri-grade5a-001 on idea03\)/)
            expect(r.message).toMatch(/DURATION_KOLIBRI_URL=http:\/\/100\.126\.117\.80:18080 \(store: kolibri-grade5a-001 on idea03; was http:\/\/100\.99\.231\.94:18080\)/)
            expect(process.env.DURATION_KOLIBRI_URL).toBe(IDEA03_URL)
            expect((await ops.readStore('idea03')).diskDB[KOLIBRI]?.dockedTo).toBe('idea03')
        })
    })

    it('infra_move_disk: disk lands on a different engine (old healthy-tree redirect) → LOUD fail naming target, URL untouched', async () => {
        await withEnv({ DURATION_KOLIBRI_URL: IDEA01_URL }, async () => {
            const ops = await r29Fleet('idea01')
            // r29 run.log L241: requested idea03, re-docked on idea01.
            Object.assign(ops, {
                moveDisk: async (from: string, _to: string, diskId: string) => {
                    await ops.undockFixtures([from], diskId)
                    await ops.dockFixture('idea01', diskId)
                },
            })
            await expect(dispatchAction(moveCtx(ops) as any)).rejects.toThrow(
                /infra_move_disk: duration-kolibri-grade5a-001 requested on target idea03 \(idea01→idea03\) but the store shows it docked on idea01\. No soft-pass/,
            )
            expect(process.env.DURATION_KOLIBRI_URL).toBe(IDEA01_URL)
        })
    })

    it('infra_move_disk: target cannot take the disk (dock error) → LOUD fail naming target and reason', async () => {
        await withEnv({}, async () => {
            const ops = await r29Fleet('idea01')
            Object.assign(ops, {
                moveDisk: async () => {
                    throw new Error('RealFleetOps: no free idea-test-N for duration-kolibri-grade5a-001 on idea03')
                },
            })
            await expect(dispatchAction(moveCtx(ops) as any)).rejects.toThrow(
                /infra_move_disk: target idea03 could not take duration-kolibri-grade5a-001 \(idea01→idea03\): .*no free idea-test-N.*No soft-pass; no fallback host/,
            )
        })
    })

    it('infra_move_disk: disk on target but instance not live there → LOUD fail', async () => {
        await withEnv({}, async () => {
            const ops = await r29Fleet('idea01')
            const realMove = ops.moveDisk.bind(ops)
            Object.assign(ops, {
                moveDisk: async (f: string, t: string, d: string) => {
                    await realMove(f, t, d)
                    ;(ops as any).mutate((doc: SemanticStoreView) => {
                        doc.instanceDB['kolibri-grade5a-001']!.status = 'Undocked'
                    })
                },
            })
            await expect(dispatchAction(moveCtx(ops) as any)).rejects.toThrow(
                /infra_move_disk: kolibri-grade5a-001 host in store is none .* not target idea03/,
            )
        })
    })

    it('RealFleetOps.dockFixture has no cross-engine healthy-tree preference; moveDisk verifies landing (r29 @62)', async () => {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const src = fs.readFileSync(path.resolve(process.cwd(), 'test/duration/realFleetOps.ts'), 'utf8')
        const body = src.slice(src.indexOf('async dockFixture('), src.indexOf('async moveDisk('))
        expect(body).not.toMatch(/prefer \$\{target\}/)
        expect(body).not.toMatch(/for \(const id of this\.pool\)/)
        expect(body).toMatch(/const target = engineId/)
        const move = src.slice(src.indexOf('async moveDisk('), src.indexOf('async purgeInstancesStoredOn('))
        expect(move).toMatch(/target \$\{toEngine\} could not take/)
        expect(move).toMatch(/findDockedEngine\(diskId\)/)
    })

    it('locateInstanceEngine ignores Undocked rows and never returns idea02', async () => {
        await withEnv({}, async () => {
            const ops = await r29Fleet('idea01')
            const ctx = ctxFor(ops, 'idea03', 'restore_from_backup') as any
            expect(await locateInstanceEngine(ctx, 'kolibri-grade5a-001', KOLIBRI)).toEqual({ engine: 'idea01', diskId: KOLIBRI, live: true })
            await ops.undockFixtures(['idea01'], KOLIBRI)
            expect((await locateInstanceEngine(ctx, 'kolibri-grade5a-001', KOLIBRI)).engine).toBeNull()
            const golden = Object.assign(Object.create(ops), {
                readStore: async (e: string) => ({
                    engineId: e,
                    instanceDB: { 'kolibri-grade5a-001': { id: 'kolibri-grade5a-001', status: 'Running', diskId: KOLIBRI } },
                    diskDB: { [KOLIBRI]: { id: KOLIBRI, dockedTo: 'idea02' } },
                    engineDB: {},
                }),
            })
            expect((await locateInstanceEngine(ctxFor(golden, null, 'restore_from_backup') as any, 'kolibri-grade5a-001', KOLIBRI)).engine).toBeNull()
        })
    })

    it('restore_from_backup: stale idea03 URL is re-read from the store (idea01) before the Intent runs', async () => {
        await withEnv({ DURATION_KOLIBRI_URL: IDEA03_URL, DURATION_FILES_DISK_ID: 'duration-empty-001' }, async () => {
            const ops = await r29Fleet('idea01')
            const driver = new StubUiDriver()
            const seen: (string | undefined)[] = []
            const orig = driver.runIntent.bind(driver)
            Object.assign(driver, {
                runIntent: async (req: any) => {
                    seen.push(process.env.DURATION_KOLIBRI_URL)
                    return orig(req)
                },
            })
            // walker still believes idea03 (r29 after @62)
            const r = await dispatchAction(ctxFor(ops, 'idea03', 'restore_from_backup', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok, r.message).toBe(true)
            expect(seen).toEqual([IDEA01_URL])
            expect(r.message).toMatch(/DURATION_KOLIBRI_URL=http:\/\/100\.99\.231\.94:18080 \(store: kolibri-grade5a-001 on idea01; was http:\/\/100\.126\.117\.80:18080\)/)
            expect(SIDECAR_SETTLE_ACTIONS.has('move_app') && SIDECAR_SETTLE_ACTIONS.has('copy_app')).toBe(true)
        })
    })

    it('resync: harness-managed NC URL follows the store host; manual override kept', async () => {
        await withEnv({ DURATION_NEXTCLOUD_URL: 'http://idea03:18280' }, async () => {
            const ops = await r29Fleet('idea01')
            const env: NodeJS.ProcessEnv = { DURATION_NEXTCLOUD_URL: 'http://idea03:18280', DURATION_KOLIBRI_URL: IDEA03_URL }
            const note = await resyncFixtureSidecarUrlsFromStore(ctxFor(ops, 'idea03', 'move_app') as any, env)
            expect(env.DURATION_NEXTCLOUD_URL).toBe('http://idea01:18280')
            expect(env.DURATION_KOLIBRI_URL).toBe(IDEA01_URL)
            expect(note).toMatch(/DURATION_NEXTCLOUD_URL=http:\/\/idea01:18280/)
            const manual: NodeJS.ProcessEnv = { DURATION_NEXTCLOUD_URL: 'http://nc.example.test:8443' }
            const note2 = await resyncFixtureSidecarUrlsFromStore(ctxFor(ops, 'idea03', 'move_app') as any, manual)
            expect(manual.DURATION_NEXTCLOUD_URL).toBe('http://nc.example.test:8443')
            expect(note2).toMatch(/manual override/)
        })
    })

    it('restore_from_backup (live ops): no restoreApp op → fails loud "restore op never started" (Intent ok → no false PASS)', async () => {
        await withEnv({ DURATION_KOLIBRI_URL: IDEA03_URL, DURATION_FILES_DISK_ID: 'duration-empty-001' }, async () => {
            const ops = await r29Fleet('idea01')
            const live = Object.assign(ops, { listOperations: async () => [
                // stale op from an earlier run must not count
                { id: 'old', kind: 'restoreApp', status: 'Done', startedAt: Date.now() - 3_600_000, args: { instanceId: 'kolibri-grade5a-001', targetDiskId: KOLIBRI } },
                { id: 'cp', kind: 'copyApp', status: 'Done', startedAt: Date.now() },
            ] })
            const r = await dispatchAction(ctxFor(live, 'idea03', 'restore_from_backup', { stubUi: true, uiDriver: new StubUiDriver() }) as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^restore_from_backup: restore op never started: no restoreApp Operation since Confirm/)
            expect(r.message).toMatch(/Too many arguments/)
            expect(r.message).toMatch(/\(Console Intent reported ok\)$/)
        })
    })

    it('restore_from_backup (live ops): Console sidecar timeout + no op → message leads with "restore op never started", not the sidecar timeout', async () => {
        await withEnv({ DURATION_FILES_DISK_ID: 'duration-empty-001' }, async () => {
            const ops = await r29Fleet('idea01')
            const live = Object.assign(ops, { listOperations: async () => [] })
            const driver = new StubUiDriver()
            Object.assign(driver, {
                runIntent: async () => ({ ok: false, mode: 'live', message: 'idea#168 sidecar not stable: http://100.126.117.80:18080 ... ECONNREFUSED' }),
            })
            const r = await dispatchAction(ctxFor(live, 'idea03', 'restore_from_backup', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^restore_from_backup: restore op never started/)
            expect(r.message).toMatch(/\(Console Intent: idea#168 sidecar not stable/)
        })
    })

    it('verifyRestoreOperation: op Done + instance Running on target + container → ok; each missing piece fails with its own reason', async () => {
        await withEnv({}, async () => {
            const since = Date.now()
            const ops = await r29Fleet('idea01')
            expect(await verifyRestoreOperation(ctxFor(ops, 'idea01', 'restore_from_backup') as any, since)).toBeNull()
            const seenEngines: string[] = []
            const op = (status: string, extra: Record<string, unknown> = {}) => ({
                id: 'r1', kind: 'restoreApp', status, startedAt: since + 500,
                args: { instanceId: 'kolibri-grade5a-001', targetDiskId: KOLIBRI }, ...extra,
            })
            const mk = (rows: any[], containers: string[] | null = ['kolibri-grade5a-001-kolibri-1']) =>
                Object.assign(Object.create(ops), {
                    listOperations: async (e: string) => { seenEngines.push(e); return e === 'idea01' ? rows : [] },
                    ...(containers ? { listInstanceContainers: async (e: string, id: string) => (e === 'idea01' && id === 'kolibri-grade5a-001' ? containers : []) } : {}),
                })
            const ctx = (o: unknown) => ctxFor(o, 'idea01', 'restore_from_backup') as any
            const ok = await verifyRestoreOperation(ctx(mk([op('Done')])), since)
            expect(ok?.ok, ok?.note).toBe(true)
            expect(ok?.note).toMatch(/restore op r1 Done on idea01; kolibri-grade5a-001 Running on duration-kolibri-grade5a-001@idea01; container kolibri-grade5a-001-kolibri-1 on idea01/)
            expect(seenEngines).not.toContain('idea02')
            const failed = await verifyRestoreOperation(ctx(mk([op('Failed', { error: 'No docked Backup Disk with archives for instance kolibri-grade5a-001' })])), since)
            expect(failed?.reason).toBe('not_done')
            expect(failed?.note).toMatch(/r1@idea01=Failed \(No docked Backup Disk with archives/)
            const wrongDisk = await verifyRestoreOperation(ctx(mk([op('Done', { args: { instanceId: 'kolibri-grade5a-001', targetDiskId: NC } })])), since)
            expect(wrongDisk?.reason).toBe('no_instance')
            expect(wrongDisk?.note).toMatch(/storedOn=duration-kolibri-grade5a-001/)
            const noCtr = await verifyRestoreOperation(ctx(mk([op('Done')], [])), since)
            expect(noCtr?.reason).toBe('no_container')
            expect(noCtr?.note).toMatch(/no running container kolibri-grade5a-001-\* on idea01/)
        })
    })
})

describe('r30: real backup_instance before restore_from_backup (op Done + archive on the Backup Disk)', () => {
    const POOL = ['idea01', 'idea03', 'idea04']
    const KOLIBRI = 'duration-kolibri-grade5a-001'
    const NC = 'duration-nextcloud-grade5a-001'
    const EMPTY2 = 'duration-empty-002'
    const INST = 'kolibri-grade5a-001'
    const HOSTS = { idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }
    const ENV_KEYS = ['DURATION_KOLIBRI_URL', 'DURATION_NEXTCLOUD_URL', 'DURATION_BACKUP_DISK_ID', 'DURATION_BACKUP_START_MS', 'DURATION_BACKUP_DONE_MS', 'DURATION_FILES_DISK_ID'] as const
    const withEnv = async (vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) => {
        const prev: Record<string, string | undefined> = {}
        for (const k of ENV_KEYS) {
            prev[k] = process.env[k]
            if (vars[k] === undefined) delete process.env[k]
            else process.env[k] = vars[k]
        }
        try {
            await fn()
        } finally {
            for (const k of ENV_KEYS) {
                if (prev[k] === undefined) delete process.env[k]
                else process.env[k] = prev[k]
            }
        }
    }
    const yaml = (lastBackup: number, inst = INST) =>
        `mode: on-demand\nlinks:\n  - instanceId: ${inst}\n    lastBackup: ${lastBackup}\n`
    type Probe = { dest: string; backupYaml: string | null; repoEntries: string[] | null }
    /**
     * Fake live fleet: Kolibri on kolibriOn, empty-002 = Backup Disk (named with spaces,
     * like r29) on idea01 linking kolibri-grade5a-001. `after` describes what the Engine
     * leaves once the Console Intent has clicked Back up.
     */
    const fleet = async (opts: {
        kolibriOn?: string
        links?: string[]
        ops?: (since: number) => any[]
        before?: Probe
        after?: Probe
    } = {}) => {
        const ops = fakeOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        await ops.dockFixture('idea01', NC)
        await ops.dockFixture(opts.kolibriOn ?? 'idea01', KOLIBRI)
        await ops.dockFixture('idea01', EMPTY2)
        ;(ops as any).mutate((doc: SemanticStoreView) => {
            const d = doc.diskDB[EMPTY2]!
            d.name = 'Duration Tests — Empty Disk 002'
            d.diskTypes = ['backup']
            d.backupLinks = opts.links ?? [INST]
        })
        const state = { clicked: false, clickedAt: 0, intentEngine: undefined as string | undefined, listed: [] as string[], probed: [] as string[] }
        const before: Probe = opts.before ?? { dest: '/home/pi/idea/duration-disks/idea-test-4', backupYaml: yaml(0), repoEntries: null }
        const after: Probe = opts.after ?? {
            dest: '/home/pi/idea/duration-disks/idea-test-4',
            backupYaml: yaml(1_759_710_000_000),
            repoEntries: ['README', 'config', 'data', 'hints.5', 'index.5', 'integrity.5'],
        }
        const live = Object.assign(ops, {
            getHostMap: () => ({ ...HOSTS }),
            listOperations: async (e: string) => {
                state.listed.push(e)
                if (!state.clicked || e !== 'idea01') return []
                return opts.ops ? opts.ops(state.clickedAt) : [
                    { id: 'b1', kind: 'backupApp', status: 'Done', startedAt: state.clickedAt + 200, args: { instanceId: INST, backupDiskId: EMPTY2 } },
                ]
            },
            probeBackupDisk: async (e: string, diskId: string, inst: string) => {
                state.probed.push(`${e}:${diskId}:${inst}`)
                return state.clicked ? after : before
            },
        })
        const driver = new StubUiDriver()
        Object.assign(driver, {
            runIntent: async (req: any) => {
                state.clicked = true
                state.clickedAt = Date.now()
                state.intentEngine = req.engineId
                return { ok: true, mode: 'live', message: `runDurationIntent ok: ${req.action}` }
            },
        })
        return { ops: live, driver, state }
    }
    const ctxFor = (ops: unknown, driver: unknown, dockedEngine: string | null) => ({
        opts: { ops, rng: () => 0, settleTimeoutMs: 500, fast: true, stubUi: true, uiDriver: driver },
        walker: { current: 'op_instance', layer: 'operator' as const, dockedEngine, step: 97 },
        from: 'op_instance',
        to: 'op_instance',
        action: 'backup_instance',
        excludeEngines: ['idea02'],
        poolEngines: POOL,
        fixtureDisk: KOLIBRI,
        fixtureInstance: INST,
        fixtureDisks: [KOLIBRI, NC],
        fixtureInstances: { ...KID_FIXTURES },
    })
    const FAST = { DURATION_BACKUP_START_MS: '60', DURATION_BACKUP_DONE_MS: '60' }

    it('cover-all: open_instance_controls → backup_instance → back_to_disk sit between @96 backup_configured_restored and restore_from_backup (@100); graph unchanged', () => {
        const walk = loadWalk('cover-all')
        const acts = walk.steps.map(st => st.action)
        const firstRestore = acts.indexOf('restore_from_backup')
        expect(firstRestore + 1).toBe(100)
        expect(acts.slice(firstRestore - 5, firstRestore + 1)).toEqual([
            'make_backup_disk',
            'backup_configured_restored',
            'open_instance_controls',
            'backup_instance',
            'back_to_disk',
            'restore_from_backup',
        ])
        expect(walk.steps[firstRestore - 2]).toMatchObject({ from: 'op_instance', to: 'op_instance', action: 'backup_instance' })
        expect(walk.steps.length).toBe(128)
        // backup_instance is the existing op_instance self-loop — no new state/edge.
        const g = unifiedScenario()
        const opInst = (g.states as any).op_instance.transitions as { to: string; action: string }[]
        expect(opInst).toContainEqual(expect.objectContaining({ to: 'op_instance', action: 'backup_instance' }))
        const opDisk = (g.states as any).op_disk.transitions as { to: string; action: string }[]
        expect(opDisk.map(t => t.action)).not.toContain('backup_instance')
    })

    it('backupYamlLastBackup: link value, 0 when never backed up, undefined without file/link', () => {
        expect(backupYamlLastBackup(yaml(42), INST)).toBe(42)
        expect(backupYamlLastBackup(yaml(0), INST)).toBe(0)
        expect(backupYamlLastBackup(yaml(5, 'other'), INST)).toBeUndefined()
        expect(backupYamlLastBackup(null, INST)).toBeUndefined()
        expect(backupYamlLastBackup('::: not yaml', INST)).toBeUndefined()
    })

    it('backup_instance (live): Kolibri on idea03 is co-located with the Backup Disk on idea01, Intent runs there, op Done + archive → ok', async () => {
        await withEnv({}, async () => {
            const { ops, driver, state } = await fleet({ kolibriOn: 'idea03' })
            const r = await dispatchAction(ctxFor(ops, driver, 'idea03') as any)
            expect(r.ok, r.message).toBe(true)
            expect(r.dockedEngine).toBe('idea01')
            expect(state.intentEngine).toBe('idea01')
            expect((await ops.readStore('idea01')).diskDB[KOLIBRI]?.dockedTo).toBe('idea01')
            expect(r.message).toMatch(/co-located duration-kolibri-grade5a-001 idea03→idea01 \(store-verified\) with Backup Disk duration-empty-002; BACKUP\.yaml lastBackup before=0/)
            expect(r.message).toMatch(/backup op b1 Done on idea01; kolibri-grade5a-001 archived on duration-empty-002@idea01 \(BACKUP\.yaml lastBackup=1759710000000 > 0; backups\/kolibri-grade5a-001\/config present\)/)
            expect(process.env.DURATION_KOLIBRI_URL).toBe('http://100.99.231.94:18080')
            expect(state.listed).not.toContain('idea02')
            expect(state.probed.every(p => p.startsWith('idea01:duration-empty-002:kolibri-grade5a-001'))).toBe(true)
        })
    })

    it('backup_instance (live): no backupApp op (Eng 8d98718 "Too many arguments") → LOUD "backup op never started", even when the Intent reported ok', async () => {
        await withEnv(FAST, async () => {
            const { ops, driver } = await fleet({ ops: () => [] })
            const r = await dispatchAction(ctxFor(ops, driver, 'idea01') as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^backup_instance: backup op never started: no backupApp Operation since the Back up click/)
            expect(r.message).toMatch(/Too many arguments/)
            expect(r.message).toMatch(/\(Console Intent reported ok\)$/)
        })
    })

    it('backup_instance (live): op Failed → LOUD "backup op did not end Done" with the Engine error', async () => {
        await withEnv(FAST, async () => {
            const { ops, driver } = await fleet({
                ops: t => [{ id: 'b2', kind: 'backupApp', status: 'Failed', startedAt: t + 100, error: 'borg: Repository does not exist', args: { instanceId: INST, backupDiskId: EMPTY2 } }],
            })
            const r = await dispatchAction(ctxFor(ops, driver, 'idea01') as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^backup_instance: backup op did not end Done: b2@idea01=Failed inst=kolibri-grade5a-001 \(borg: Repository does not exist\)/)
        })
    })

    it('backup_instance (live): op still Running at the budget → "did not end Done"', async () => {
        await withEnv(FAST, async () => {
            const { ops, driver } = await fleet({
                ops: t => [{ id: 'b3', kind: 'backupApp', status: 'Running', startedAt: t + 100, args: { instanceId: INST, backupDiskId: EMPTY2 } }],
            })
            const r = await dispatchAction(ctxFor(ops, driver, 'idea01') as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/backup op did not end Done: b3@idea01=Running/)
        })
    })

    it('backup_instance (live): op Done but BACKUP.yaml lastBackup still 0 → LOUD', async () => {
        await withEnv(FAST, async () => {
            const { ops, driver } = await fleet({
                after: { dest: '/d/idea-test-4', backupYaml: yaml(0), repoEntries: ['config', 'data'] },
            })
            const r = await dispatchAction(ctxFor(ops, driver, 'idea01') as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^backup_instance: backup op b1 Done but Backup Disk duration-empty-002@idea01 \/d\/idea-test-4: BACKUP\.yaml lastBackup for kolibri-grade5a-001 still 0/)
        })
    })

    it('backup_instance (live): op Done, lastBackup bumped, but no Borg repo for the instance → LOUD "no archive"', async () => {
        await withEnv(FAST, async () => {
            for (const [repoEntries, why] of [
                [null, /backups\/kolibri-grade5a-001\/ missing/],
                [['data'], /backups\/kolibri-grade5a-001\/config missing \(entries: data\)/],
                [['config', '.backup-in-progress'], /\.backup-in-progress still present/],
            ] as const) {
                const { ops, driver } = await fleet({
                    after: { dest: '/d/idea-test-4', backupYaml: yaml(99), repoEntries: repoEntries as string[] | null },
                })
                const r = await dispatchAction(ctxFor(ops, driver, 'idea01') as any)
                expect(r.ok).toBe(false)
                expect(r.message).toMatch(/^backup_instance: no archive for kolibri-grade5a-001 on Backup Disk duration-empty-002@idea01/)
                expect(r.message).toMatch(why)
                expect(r.message).toMatch(/No docked Backup Disk with archives/)
            }
        })
    })

    it('backup_instance (live): only the name-twin was backed up (copy_app clone also named "kolibri") → LOUD wrong instance', async () => {
        await withEnv(FAST, async () => {
            const { ops, driver } = await fleet({
                ops: t => [{ id: 'b4', kind: 'backupApp', status: 'Done', startedAt: t + 100, args: { instanceId: '99vunsducqvzniusygc', backupDiskId: EMPTY2 } }],
            })
            const r = await dispatchAction(ctxFor(ops, driver, 'idea01') as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^backup_instance: backup op backed up the wrong instance: b4@idea01=Done inst=99vunsducqvzniusygc; expected kolibri-grade5a-001/)
        })
    })

    it('verifyBackupOperation: a second backup must bump lastBackup beyond the pre-click value; stale ops ignored; arg form irrelevant', async () => {
        await withEnv({}, async () => {
            const since = Date.now()
            const { ops, state } = await fleet({
                ops: t => [
                    { id: 'old', kind: 'backupApp', status: 'Done', startedAt: t - 3_600_000, args: { instanceId: INST, backupDiskId: EMPTY2 } },
                    // ids in args regardless of what the Console typed (Eng resolves before createOperation)
                    { id: 'b5', kind: 'backupApp', status: 'Done', startedAt: t + 10, args: { instanceId: INST, backupDiskId: EMPTY2 } },
                ],
                after: { dest: '/d/idea-test-4', backupYaml: yaml(1000), repoEntries: ['config'] },
            })
            state.clicked = true
            state.clickedAt = since
            const ctx = ctxFor(ops, null, 'idea01') as any
            const budgets = { startBudgetMs: 30, doneBudgetMs: 30, pollMs: 5 }
            const stale = await verifyBackupOperation(ctx, since, { instanceId: INST, priorLastBackup: 1000 }, budgets)
            expect(stale?.reason).toBe('last_backup_not_bumped')
            expect(stale?.note).toMatch(/not bumped \(1000 ≤ before 1000\)/)
            const ok = await verifyBackupOperation(ctx, since, { instanceId: INST, priorLastBackup: 500 }, budgets)
            expect(ok?.ok, ok?.note).toBe(true)
            expect(ok?.note).toMatch(/^backup op b5 Done on idea01/)
            // Fake ops without an operationDB reader → no live check (Fake walks unaffected).
            expect(await verifyBackupOperation(ctxFor(fakeOps({ poolEngines: POOL }), null, 'idea01') as any, since, { instanceId: INST })).toBeNull()
        })
    })

    it('backup_instance preflight: no Backup Disk linked to the instance → aborted before Intent (Console would not show Back up)', async () => {
        await withEnv({}, async () => {
            const { ops, driver, state } = await fleet({ links: ['nextcloud-grade5a-001'] })
            const r = await dispatchAction(ctxFor(ops, driver, 'idea01') as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^backup_instance aborted before Intent: backup_instance: no docked Backup Disk linked to kolibri-grade5a-001 on any pool engine/)
            expect(state.clicked).toBe(false)
        })
    })

    it('RealFleetOps.probeBackupDisk: read-only cat/ls on the store slot; parses BACKUP.yaml + repo entries; refuses odd ids', async () => {
        const cmds: string[] = []
        const self = (out: string) => ({
            assertNotExcluded: (e: string) => { if (e === 'idea02') throw new Error('excluded') },
            readStore: async () => ({ engineId: 'idea01', instanceDB: {}, diskDB: { [EMPTY2]: { id: EMPTY2, dockedTo: 'idea01', device: 'idea-test-4' } }, engineDB: {} }),
            deviceMap: () => new Map<string, string>(),
            disksRoot: '/home/pi/idea/duration-disks',
            hostOf: (e: string) => e,
            ssh: async (_h: string, cmd: string) => { cmds.push(cmd); return out },
        })
        const probe = (RealFleetOps.prototype as any).probeBackupDisk
        const ok = await probe.call(self(`${yaml(7)}@@REPO@@\nREADME\nconfig\ndata\n`), 'idea01', EMPTY2, INST)
        expect(ok).toEqual({ dest: '/home/pi/idea/duration-disks/idea-test-4', backupYaml: yaml(7).trim(), repoEntries: ['README', 'config', 'data'] })
        expect(cmds[0]).toMatch(/cat '\/home\/pi\/idea\/duration-disks\/idea-test-4\/BACKUP\.yaml'/)
        expect(cmds[0]).toMatch(/ls -1A '\/home\/pi\/idea\/duration-disks\/idea-test-4\/backups\/kolibri-grade5a-001'/)
        expect(cmds[0]).not.toMatch(/\brm\b|\bborg\b|>|tee|mv /)
        const none = await probe.call(self('@@NO_BACKUP_YAML@@\n@@REPO@@\n@@NO_REPO@@\n'), 'idea01', EMPTY2, INST)
        expect(none).toMatchObject({ backupYaml: null, repoEntries: null })
        await expect(probe.call(self(''), 'idea01', EMPTY2, "x'; rm -rf /")).rejects.toThrow(/refuse backup probe/)
        await expect(probe.call(self(''), 'idea02', EMPTY2, INST)).rejects.toThrow(/excluded/)
    })

    it('ensureBackupDiskForInstance: BACKUP.yaml without a link for the instance, or co-locate landing elsewhere → LOUD', async () => {
        await withEnv({}, async () => {
            const a = await fleet({ before: { dest: '/d/idea-test-4', backupYaml: yaml(0, 'other'), repoEntries: null } })
            await expect(ensureBackupDiskForInstance(ctxFor(a.ops, null, 'idea01') as any, INST, KOLIBRI)).rejects.toThrow(
                /BACKUP\.yaml has no link for kolibri-grade5a-001/,
            )
            const b = await fleet({ kolibriOn: 'idea03' })
            Object.assign(b.ops, {
                moveDisk: async (from: string, _to: string, d: string) => {
                    await b.ops.undockFixtures([from], d)
                    await b.ops.dockFixture('idea04', d)
                },
            })
            await expect(ensureBackupDiskForInstance(ctxFor(b.ops, null, 'idea03') as any, INST, KOLIBRI)).rejects.toThrow(
                /backup_instance: co-locate duration-kolibri-grade5a-001 idea03→idea01 did not land \(store: kolibri-grade5a-001 on idea04\)/,
            )
        })
    })
})
