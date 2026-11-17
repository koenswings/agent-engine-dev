/**
 * idea#168 Markov 2 (random-9040e73-markov-20261116b@16): eject_disk + confirm_eject@10-11 ejected the Kolibri
 * fixture disk (Engine log: stopInstance kolibri, then ejectDisk duration-kolibri-grade5a-001), then the walk drew
 * copy_app@16, whose preflight refused "source disk … is not docked on any pool engine". Only infra_dock_fixture
 * re-docks it, so a random walk can legitimately reach that state. Steps needing an absent fixture disk/instance
 * are now not drawable (resample). Deterministic walks (cover-all) never consult the guard and still fail loud.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeFleetOps, preflightCopyMoveSamePi, randomStepPrecondition, readPoolSnapshot, stage2FixtureAbsent } from '../duration/actions.js'
import { pickDrawableTransition, runDeterministicWalk, runWalk } from '../duration/runner.js'
import { makeRng } from '../duration/scenario.js'
import type { Scenario, WalkerState } from '../duration/types.js'

const POOL = ['idea01', 'idea03', 'idea04']
const KOL = 'duration-kolibri-grade5a-001'
const NC = 'duration-nextcloud-grade5a-001'
const FIXTURES = { [KOL]: 'kolibri-grade5a-001', [NC]: 'nextcloud-grade5a-001' }
const walkerOf = (over: Partial<WalkerState> = {}): WalkerState => ({ current: 'op_instance', layer: 'operator', dockedEngine: null, step: 15, ...over })

type Disk = { id: string; dockedTo: string | null }
type Inst = { id: string; status: string; diskId: string | null; port?: number }
const disk = (id: string, dockedTo: string | null): Disk => ({ id, dockedTo })
const inst = (id: string, diskId: string, status = 'Running', port?: number): Inst => ({ id, diskId, status, ...(port ? { port } : {}) })

/** Pool store after the run-2 walk: Kolibri disk ejected (no dockedTo), its instance Undocked. */
const storeOf = (kolibriDocked: boolean, kolibriStatus = 'Running') => ({
    diskDB: {
        [KOL]: disk(KOL, kolibriDocked ? 'idea01' : null),
        [NC]: disk(NC, 'idea03'),
        'duration-empty-001': disk('duration-empty-001', 'idea03'),
        'duration-empty-002': disk('duration-empty-002', 'idea04'),
    },
    instanceDB: {
        'kolibri-grade5a-001': inst('kolibri-grade5a-001', KOL, kolibriDocked ? kolibriStatus : 'Undocked', 18080),
        'nextcloud-grade5a-001': inst('nextcloud-grade5a-001', NC, 'Running', 61820),
        'kiwix-ideaa-001': inst('kiwix-ideaa-001', NC, 'Running', 18380),
    },
})
const liveOps = (store: ReturnType<typeof storeOf>, extra: Record<string, unknown> = {}) => ({
    stage: 2,
    findDockedEngine: async (id: string) => (store.diskDB as Record<string, Disk>)[id]?.dockedTo ?? null,
    readStore: async (engineId: string) => ({ engineId, engineDB: {}, ...store }),
    ...extra,
})
const ctxOf = (ops: unknown, walker = walkerOf()) =>
    ({ opts: { ops }, walker, poolEngines: POOL, excludeEngines: ['idea02'], fixtureInstance: 'kolibri-grade5a-001', fixtureInstances: FIXTURES, fixtureDisk: KOL }) as never

let saved: Record<string, string | undefined> = {}
const KEYS = ['DURATION_COPY_INSTANCE_ID', 'DURATION_COPY_TARGET_DISK', 'DURATION_COPY_SOURCE_DISK', 'DURATION_START_INSTANCE_ID', 'DURATION_BACKUP_SOURCE_INSTANCE']
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

describe('Markov 2: copy_app after the Kolibri fixture disk was ejected', () => {
    it('the run-2 state: copy_app is not drawable (the preflight would refuse it)', async () => {
        const ops = liveOps(storeOf(false))
        const reason = await randomStepPrecondition(ctxOf(ops), 'copy_app', {}, 'op_copy_move')
        expect(reason).toMatch(/kolibri-grade5a-001 Undocked .*not docked on a pool engine/)
        // the dispatcher's own preflight still fails loud on the same state (cover-all path unchanged)
        await expect(preflightCopyMoveSamePi({ ...(ctxOf(ops) as object), action: 'copy_app' } as never, 'copy_app', {}, {}))
            .rejects.toThrow(/source disk duration-kolibri-grade5a-001 is not docked on any pool engine/)
    })
    it('Kolibri docked: copy_app drawable', async () => {
        expect(await randomStepPrecondition(ctxOf(liveOps(storeOf(true))), 'copy_app', {}, 'op_copy_move')).toBeNull()
    })
    it('copy_app with no other docked disk: not drawable', async () => {
        const s = storeOf(true)
        for (const id of [NC, 'duration-empty-001', 'duration-empty-002']) s.diskDB[id as keyof typeof s.diskDB]!.dockedTo = null
        expect(await randomStepPrecondition(ctxOf(liveOps(s)), 'copy_app', {}, 'op_copy_move')).toMatch(/no docked target disk/)
    })
})

describe('audit: every step that needs the fixture disk / instance', () => {
    const ejected = () => ctxOf(liveOps(storeOf(false)))
    it('instance steps on the ejected fixture are not drawable (no hollow pass)', async () => {
        for (const a of ['start_instance', 'stop_instance', 'rename_instance', 'open_app', 'backup_instance']) {
            expect(await stage2FixtureAbsent(ejected(), a, 'op_instance', {}), a).toMatch(/kolibri-grade5a-001 Undocked/)
        }
    })
    it('Kolibri App steps not drawable; Nextcloud / Kiwix on their docked disk still drawable', async () => {
        expect(await stage2FixtureAbsent(ejected(), 'open_kolibri_as_learner', 'kolibri_home', {})).toMatch(/kolibri .*not Running/)
        expect(await stage2FixtureAbsent(ejected(), 'open_kolibri_as_teacher', 'kolibri_manage', {})).toMatch(/kolibri/)
        expect(await stage2FixtureAbsent(ejected(), 'open_nextcloud_as_learner', 'nc_browse', {})).toBeNull()
        expect(await stage2FixtureAbsent(ejected(), 'open_wikipedia_as_teacher', 'wiki_browse', {})).toBeNull()
    })
    it('a stopped App cannot be opened; stop/start/copy of it still can', async () => {
        const ctx = ctxOf(liveOps(storeOf(true, 'Stopped')))
        expect(await stage2FixtureAbsent(ctx, 'open_kolibri_as_learner', 'kolibri_home', {})).toMatch(/Stopped .*not Running/)
        expect(await stage2FixtureAbsent(ctx, 'open_app', 'op_instance', {})).toMatch(/not Running/)
        for (const a of ['start_instance', 'stop_instance', 'copy_app']) expect(await stage2FixtureAbsent(ctx, a, 'op_instance', {}), a).toBeNull()
    })
    it('restore_from_backup needs the instance it restores live (pinAppsForStep)', async () => {
        expect(await stage2FixtureAbsent(ejected(), 'restore_from_backup', 'op_backup', {})).toMatch(/absent/)
        expect(await stage2FixtureAbsent(ctxOf(liveOps(storeOf(true))), 'restore_from_backup', 'op_backup', {})).toBeNull()
    })
    it('move_app: the recorded copy must sit on a docked disk', async () => {
        const s = storeOf(true)
        ;(s.instanceDB as Record<string, Inst>)['kolibri-copy'] = inst('kolibri-copy', 'duration-empty-002', 'Undocked', 18081)
        s.diskDB['duration-empty-002'].dockedTo = null
        const walker = walkerOf({ stage2CopyInstanceId: 'kolibri-copy' })
        expect(await stage2FixtureAbsent(ctxOf(liveOps(s), walker), 'move_app', 'op_copy_move', {})).toMatch(/kolibri-copy Undocked/)
        s.diskDB['duration-empty-002'].dockedTo = 'idea03'
        ;(s.instanceDB as Record<string, Inst>)['kolibri-copy']!.status = 'Running'
        expect(await stage2FixtureAbsent(ctxOf(liveOps(s), walker), 'move_app', 'op_copy_move', {})).toBeNull()
    })
    it('infra_move_disk needs the fixture disk docked', async () => {
        expect(await stage2FixtureAbsent(ejected(), 'infra_move_disk', 'infra_disk_moved', {})).toMatch(/infra_dock_fixture first/)
        expect(await stage2FixtureAbsent(ctxOf(liveOps(storeOf(true))), 'infra_move_disk', 'infra_disk_moved', {})).toBeNull()
    })
    it('steps that do not need the fixture (navigation, re-dock, eject, other disks) stay drawable', async () => {
        for (const a of ['return_to_start', 'back_to_overview', 'eject_disk', 'confirm_eject', 'infra_dock_fixture', 'install_app', 'make_backup_disk', 'erase_disk', 'open_instance_controls', 'notice_usb_dock']) {
            expect(await stage2FixtureAbsent(ejected(), a, 'op_overview', {}), a).toBeNull()
        }
    })
    it('a fixture docked only on idea02 (excluded) does not count', async () => {
        const s = storeOf(true)
        s.diskDB[KOL].dockedTo = 'idea02'
        expect(await stage2FixtureAbsent(ctxOf(liveOps(s)), 'copy_app', 'op_copy_move', {})).toMatch(/not docked on a pool engine/)
    })
    it('unreadable store: no guess, the step itself judges', async () => {
        const ops = { stage: 2, findDockedEngine: async () => null, readStore: async () => { throw new Error('down') } }
        expect(await stage2FixtureAbsent(ctxOf(ops), 'copy_app', 'op_copy_move', {})).toBeNull()
    })
    it('Stage 1 / Fake ops: unchanged', async () => {
        const s = storeOf(false)
        const { stage: _s, ...stage1 } = liveOps(s)
        expect(await stage2FixtureAbsent(ctxOf(stage1), 'copy_app', 'op_copy_move', {})).toBeNull()
        expect(await stage2FixtureAbsent(ctxOf({ stage: 2, readStore: liveOps(s).readStore }), 'copy_app', 'op_copy_move', {})).toBeNull()
    })
    it('readPoolSnapshot: the live row wins over another engine\'s Undocked copy', async () => {
        const live = storeOf(true)
        const stale = storeOf(false)
        const ops = { readStore: async (e: string) => ({ engineId: e, engineDB: {}, ...(e === 'idea01' ? stale : live) }) }
        const snap = await readPoolSnapshot({ opts: { ops }, poolEngines: POOL, excludeEngines: ['idea02'] } as never)
        expect(snap.instances.get('kolibri-grade5a-001')?.status).toBe('Running')
        expect(snap.docked.get(KOL)).toBe('idea01')
    })
})

describe('draw guard keyed by edge; runWalk resamples; deterministic walk still fails loud', () => {
    it('pickDrawableTransition passes the target state', async () => {
        const seen: string[] = []
        await pickDrawableTransition('s', [{ to: 'kolibri_home', weight: 1, action: 'x' }, { to: 'nc_browse', weight: 1, action: 'x' }], makeRng(1),
            async (a, t) => { seen.push(`${a}>${t}`); return t === 'kolibri_home' ? 'no kolibri' : null })
        expect(seen).toEqual(['x>kolibri_home', 'x>nc_browse'])
    })
    const scenario: Scenario = {
        name: 'markov2', seed: 3, exclude_engines: ['idea02'], pool_engines: POOL, store_mode: 'shared',
        fixture_disk: KOL, fixtures: [], initial_state: 'op_instance',
        states: { op_instance: { layer: 'operator', transitions: [
            { to: 'op_instance', weight: 95, action: 'copy_app' },
            { to: 'op_instance', weight: 5, action: 'stay_on_overview' },
        ] } },
    }
    const ejectedOps = () => {
        const fake = new FakeFleetOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        return Object.assign(fake, liveOps(storeOf(false)))
    }
    const opts = { fast: true, stubUi: true, skipStability: true, settleTimeoutMs: 200 } as const
    it('Markov with the Kolibri disk ejected: copy_app never drawn, no abort', async () => {
        const r = await runWalk({ ...opts, scenario, iterations: 20, ops: ejectedOps() as never, rng: makeRng(3) })
        expect(r.aborted).toBe(false)
        expect(r.logs.every(l => l.action === 'stay_on_overview')).toBe(true)
        expect(r.logs[0]!.message).toMatch(/Markov: not drawable yet: copy_app \(.*kolibri-grade5a-001 Undocked/)
    })
    it('deterministic walk: copy_app still runs as written (guard never consulted)', async () => {
        const walk = { kind: 'walk', name: 'w', scenario, steps: [{ from: 'op_instance', to: 'op_instance', action: 'copy_app' }] } as never
        const r = await runDeterministicWalk(walk, { ...opts, ops: ejectedOps() as never, rng: makeRng(3) })
        expect(r.logs.map(l => l.action)).toEqual(['copy_app'])
        expect(r.logs[0]!.message ?? '').not.toMatch(/not drawable/)
    })
})
