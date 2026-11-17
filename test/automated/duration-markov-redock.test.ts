/**
 * idea#168 Markov 3 (random-9040e73-markov-20261117c@15): eject_disk + confirm_eject@10-11 ejected the Kolibri
 * fixture disk; back_to_disk@15 then waited 15 s for [data-testid="disk-duration-kolibri-grade5a-001"]. Root-cause
 * fix: a Stage 2 random walk re-docks what confirm_eject took away (and every fixture when it leaves the infra
 * layer) and waits for the store before it draws again. Cover-all never re-docks and stays fail-loud.
 *
 * The last block is the 2000-draw seed-42 dry run: the real unified graph, the real draw guards
 * (randomStepPrecondition) and the real re-dock (stage2MarkovRedock) over a modelled Stage 2 store, with each
 * drawn step checked against what its Console intent needs (disk card / instance row / running App).
 */
import { describe, expect, it } from 'vitest'
import { FakeFleetOps, markovRedockAfter, markovRedockBefore, randomStepPrecondition, readPoolSnapshot, stage2MarkovRedock, noteStepPreconditionProgress } from '../duration/actions.js'
import { pickDrawableTransition, runDeterministicWalk, runWalk } from '../duration/runner.js'
import { loadScenario, makeRng } from '../duration/scenario.js'
import { STAGE2_FIXTURES, STAGE2_ROLE_MAP } from '../duration/stage2.js'
import type { Scenario, WalkerState } from '../duration/types.js'

const POOL = ['idea01', 'idea03', 'idea04']
const KOL = 'duration-kolibri-grade5a-001'
const NC = 'duration-nextcloud-grade5a-001'
const KI = 'kolibri-grade5a-001'
const NCI = 'nextcloud-grade5a-001'
const KXI = 'kiwix-ideaa-001'
const FIXTURE_DISKS = [KOL, NC]
const FIXTURES = { [KOL]: KI, [NC]: NCI }

type Disk = { id: string; dockedTo: string | null; diskTypes?: string[] }
type Inst = { id: string; status: string; diskId: string | null; port?: number }

/** Modelled Stage 2 pool store (one shared doc): six partitions, three fixture instances. */
class Stage2Model {
    stage = 2
    disks: Record<string, Disk> = {}
    insts: Record<string, Inst> = {}
    docks: string[] = []
    /** Live store lag (Markov 4): a Console eject reaches the shared store only after N more store reads. */
    pending: { disk: string; reads: number } | null = null
    reads = 0
    constructor() {
        for (const f of STAGE2_FIXTURES) this.disks[f.diskId] = { id: f.diskId, dockedTo: f.host, diskTypes: [...(f.diskTypes ?? [])] }
        this.insts[KI] = { id: KI, status: 'Running', diskId: KOL, port: 18080 }
        this.insts[NCI] = { id: NCI, status: 'Running', diskId: NC, port: 61820 }
        this.insts[KXI] = { id: KXI, status: 'Running', diskId: NC, port: 18380 }
    }
    tick() {
        this.reads++
        if (this.pending && --this.pending.reads <= 0) { const d = this.pending.disk; this.pending = null; this.undock(d) }
    }
    /** What a Console confirm_eject does: the Engine ejects, the store sees it `lag` reads later. */
    consoleEject(lag: number) { const t = this.ejectTarget(); if (t) { if (lag <= 0) this.undock(t); else this.pending = { disk: t, reads: lag } } }
    async readStore(engineId: string) { this.tick(); return { engineId, engineDB: {}, diskDB: structuredClone(this.disks), instanceDB: structuredClone(this.insts) } }
    async findDockedEngine(id: string) { this.tick(); return this.disks[id]?.dockedTo ?? null }
    undock(id: string) {
        const d = this.disks[id]
        if (!d) return
        d.dockedTo = null
        for (const i of Object.values(this.insts)) if (i.diskId === id) i.status = 'Undocked'
    }
    async dockFixture(engineId: string, id: string) {
        this.docks.push(id)
        const d = this.disks[id]!
        d.dockedTo = engineId
        if (d.diskTypes?.[0] === 'empty' || d.diskTypes?.[0] === 'backup') d.diskTypes = ['empty']
        for (const i of Object.values(this.insts)) if (i.diskId === id) i.status = 'Running'
    }
    async undockFixtures(_e: string[], id: string) { this.undock(id) }
    /** Console eject_disk target (Console 3d81cfd pickEjectDiskIdOnTree): preferred = ctx disk (Kolibri), then NC, Empty-001, … */
    ejectTarget(): string | null {
        for (const id of [KOL, NC, 'duration-empty-001', 'duration-empty-002', 'duration-empty-003', 'duration-add-files-001']) {
            if (this.disks[id]?.dockedTo) return id
        }
        return null
    }
}

const walkerOf = (over: Partial<WalkerState> = {}): WalkerState => ({ current: 'op_overview', layer: 'operator', dockedEngine: null, step: 11, ...over })
const ctxOf = (model: Stage2Model, walker = walkerOf()) => ({
    opts: { ops: model, fast: true, settleTimeoutMs: 50 }, walker, from: 'op_eject', to: 'op_overview', action: 'confirm_eject',
    poolEngines: POOL, excludeEngines: ['idea02'], fixtureDisk: KOL, fixtureInstance: KI, fixtureDisks: FIXTURE_DISKS, fixtureInstances: FIXTURES,
}) as never
/** infra_dock_fixture stand-in (its own Stage 2 path is covered by the infra tests): docks every undocked fixture home. */
const dockFixtures = (model: Stage2Model) => async () => {
    const docked: string[] = []
    for (const d of FIXTURE_DISKS) if (!model.disks[d]!.dockedTo) { await model.dockFixture(STAGE2_FIXTURES.find(f => f.diskId === d)!.host, d); docked.push(d) }
    return { ok: true, message: `Stage 2 homes: docked ${docked.join(', ') || 'none'}`, layer: 'infra' as const }
}
const FAST = { waitMs: 50, ejectWaitMs: 40, pollMs: 5, log: () => {} }
const EJECT = { afterEject: true, leavingInfra: false }
const INFRA_EXIT = { afterEject: false, leavingInfra: true }

describe('stage2MarkovRedock', () => {
    it('Markov 3 state: confirm_eject took the Kolibri disk → re-docked, store shows it docked, instance back', async () => {
        const m = new Stage2Model()
        const before = await readPoolSnapshot(ctxOf(m))
        m.undock(KOL)
        const r = await stage2MarkovRedock(ctxOf(m), before, EJECT, { ...FAST, dockFixtures: dockFixtures(m) })
        expect(r.ok).toBe(true)
        expect(r.note).toMatch(/Markov re-dock \[duration-kolibri-grade5a-001\] docked again in the store/)
        expect(m.disks[KOL]!.dockedTo).toBe('idea01')
        expect(m.insts[KI]!.status).toBe('Running')
    })
    it('nothing undocked: no-op (no dock call)', async () => {
        const m = new Stage2Model()
        const before = await readPoolSnapshot(ctxOf(m))
        const r = await stage2MarkovRedock(ctxOf(m), before, EJECT, { ...FAST, dockFixtures: dockFixtures(m) })
        expect(r.ok).toBe(true)
        expect(r.note).toMatch(/nothing to re-dock \(confirm_eject: no docked disk left the store within \d+ms/)
        expect(m.docks).toEqual([])
    })
    it('an ejected Empty (Backup Disk) is re-docked on its home Pi, reset, and the walk forgets the backup', async () => {
        const m = new Stage2Model()
        m.disks[STAGE2_ROLE_MAP.backup]!.diskTypes = ['backup']
        const walker = walkerOf({ backupTaken: true, empty002HoldsApp: true })
        const before = await readPoolSnapshot(ctxOf(m, walker))
        m.undock(STAGE2_ROLE_MAP.backup)
        const r = await stage2MarkovRedock(ctxOf(m, walker), before, EJECT, FAST)
        expect(r.ok).toBe(true)
        expect(r.note).toMatch(/duration-empty-002 re-docked on idea04 \(reset to Empty\)/)
        expect(walker.backupTaken).toBe(false)
        expect(walker.empty002HoldsApp).toBe(false)
    })
    it('leaving the infra layer with fixtures undocked: re-docks them', async () => {
        const m = new Stage2Model()
        m.undock(KOL); m.undock(NC)
        const r = await stage2MarkovRedock(ctxOf(m), null, INFRA_EXIT, { ...FAST, dockFixtures: dockFixtures(m) })
        expect(r.ok).toBe(true)
        expect(m.disks[KOL]!.dockedTo).toBe('idea01')
        expect(m.disks[NC]!.dockedTo).toBe('idea03')
    })
    it('store never shows it docked: fails loud', async () => {
        const m = new Stage2Model()
        const before = await readPoolSnapshot(ctxOf(m))
        m.undock(KOL)
        const r = await stage2MarkovRedock(ctxOf(m), before, EJECT, { ...FAST, dockFixtures: async () => ({ ok: true, message: 'lied' }) })
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/store still shows duration-kolibri-grade5a-001 not docked.*No soft-pass/)
    })
    it('dock refused: fails loud', async () => {
        const m = new Stage2Model()
        const before = await readPoolSnapshot(ctxOf(m))
        m.undock(KOL)
        const r = await stage2MarkovRedock(ctxOf(m), before, EJECT, { ...FAST, dockFixtures: async () => { throw new Error('dock helper down') } })
        expect(r).toMatchObject({ ok: false })
        expect(r.note).toMatch(/dock helper down.*No soft-pass/)
    })
    it('a disk that only ever was on idea02 is not "re-docked" onto the pool', async () => {
        const m = new Stage2Model()
        m.disks['golden'] = { id: 'golden', dockedTo: 'idea02' }
        const before = await readPoolSnapshot(ctxOf(m))
        m.disks['golden']!.dockedTo = null
        const r = await stage2MarkovRedock(ctxOf(m), before, EJECT, FAST)
        expect(r.ok).toBe(true)
        expect(r.note).toMatch(/nothing to re-dock/)
        expect(m.docks).toEqual([])
    })
    it('Markov 4: the eject reaches the store several reads later → polled, then re-docked (the #494 single read missed it)', async () => {
        const m = new Stage2Model()
        const before = await readPoolSnapshot(ctxOf(m))
        m.consoleEject(7) // > one pool read (3 engines): a single "after" snapshot still shows Kolibri docked
        const lines: string[] = []
        const r = await stage2MarkovRedock(ctxOf(m), before, EJECT, { ...FAST, ejectWaitMs: 1_000, log: l => lines.push(l), dockFixtures: dockFixtures(m) })
        expect(r.ok).toBe(true)
        expect(r.note).toMatch(/confirm_eject: store shows \[duration-kolibri-grade5a-001\] gone after \d+ms \([3-9] read\(s\)\)/)
        expect(lines.some(l => /re-docking \[duration-kolibri-grade5a-001\]/.test(l))).toBe(true)
        expect(m.disks[KOL]!.dockedTo).toBe('idea01')
    })
    it('no readable snapshot before confirm_eject: falls back to the fixture disks, logged', async () => {
        const m = new Stage2Model()
        m.undock(KOL)
        const r = await stage2MarkovRedock(ctxOf(m), null, EJECT, { ...FAST, dockFixtures: dockFixtures(m) })
        expect(r.ok).toBe(true)
        expect(r.note).toMatch(/no readable store snapshot before confirm_eject.*fallback: fixture disks not docked \[duration-kolibri-grade5a-001\]/)
        expect(m.disks[KOL]!.dockedTo).toBe('idea01')
    })
    it('Fake / Stage 1 ops: never re-docks', async () => {
        const ops = new FakeFleetOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        const ctx = { ...(ctxOf(new Stage2Model()) as object), opts: { ops } } as never
        expect(await stage2MarkovRedock(ctx, null, INFRA_EXIT, FAST)).toEqual({ ok: true, note: null })
    })
})

describe('runner wiring: Markov re-docks after confirm_eject; deterministic walks never do', () => {
    const scen: Scenario = {
        name: 'redock', seed: 1, exclude_engines: ['idea02'], pool_engines: POOL, store_mode: 'shared',
        fixture_disk: KOL, fixtures: [], initial_state: 'op_eject',
        states: {
            op_eject: { layer: 'operator', transitions: [{ to: 'op_overview', weight: 1, action: 'confirm_eject' }] },
            op_overview: { layer: 'operator', transitions: [{ to: 'op_eject', weight: 1, action: 'eject_disk' }] },
        },
    }
    /**
     * Stage 2 model behind the REAL runner loop (runWalk). The UI stub cannot click, so the Console eject is
     * confirmed right after the runner's before-snapshot (store reads 1-3) and reaches the store `lag` reads
     * later, like the live shared store (Markov 4: confirm_eject returned before the store saw the eject).
     */
    const modelOps = (lag: number) => {
        const m = new Stage2Model()
        const fake = new FakeFleetOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        let started = false
        const ops = Object.assign(fake, {
            stage: 2,
            findDockedEngine: (id: string) => m.findDockedEngine(id),
            dockFixture: (e: string, id: string) => m.dockFixture(e, id),
            undockFixtures: (e: string[], id: string) => m.undockFixtures(e, id),
            stage2DockedAndMounted: async (e: string, id: string) => (await m.findDockedEngine(id)) === e,
            readStore: async (e: string) => {
                // reads 1-3 = the runner's before-snapshot; the Console eject is confirmed right after it.
                if (!started && m.reads === 3) { started = true; m.consoleEject(lag) }
                return m.readStore(e)
            },
        })
        return { m, ops }
    }
    const opts = { fast: true, stubUi: true, skipStability: true, settleTimeoutMs: 50 } as const
    const redockOpts = { waitMs: 200, ejectWaitMs: 2_000, pollMs: 2, log: () => {} }
    for (const lag of [0, 7, 40]) {
        it(`real runner loop, store lag ${lag} reads: confirm_eject → re-dock fires, Kolibri docked before the next draw`, async () => {
            const { m, ops } = modelOps(lag)
            const r = await runWalk({ ...opts, scenario: scen, iterations: 2, ops: ops as never, rng: makeRng(1), markovRedock: redockOpts })
            expect(r.aborted).toBe(false)
            expect(m.docks).toContain(KOL)
            expect(m.disks[KOL]!.dockedTo).toBe('idea01')
            expect(r.logs[0]!.action).toBe('confirm_eject')
            expect(r.logs[0]!.message).toMatch(/Markov re-dock \[duration-kolibri-grade5a-001\] docked again in the store/)
            expect(r.logs[1]!.action).toBe('eject_disk')
        })
    }
    it('real runner loop: eject never reaches the store → logged "nothing to re-dock" with the reason', async () => {
        const { ops } = modelOps(1_000_000)
        const r = await runWalk({ ...opts, scenario: scen, iterations: 1, ops: ops as never, rng: makeRng(1), markovRedock: { ...redockOpts, ejectWaitMs: 30 } })
        expect(r.logs[0]!.message).toMatch(/Markov re-dock after confirm_eject: nothing to re-dock \(confirm_eject: no docked disk left the store/)
    })
    it('deterministic walk: confirm_eject runs as written, no re-dock', async () => {
        const { m, ops } = modelOps(0)
        const walk = { kind: 'walk', name: 'w', scenario: scen, steps: [{ from: 'op_eject', to: 'op_overview', action: 'confirm_eject' }] } as never
        const r = await runDeterministicWalk(walk, { ...opts, ops: ops as never, rng: makeRng(1) })
        expect(m.docks).toEqual([])
        expect(r.logs[0]!.message ?? '').not.toMatch(/re-dock/)
    })
})

// ── 2000-draw seed-42 dry run over the real graph ───────────────────────────────────────────────

/** What each drawn step's Console intent (3d81cfd e2e/intents) needs on screen / in the store. null = ok. */
const intentNeeds = (m: Stage2Model, walker: WalkerState, action: string, to: string): string | null => {
    const docked = (d: string) => !!m.disks[d]?.dockedTo
    const running = (i: string) => m.insts[i]?.status === 'Running' && docked(m.insts[i]!.diskId ?? '')
    const live = (i: string) => !!m.insts[i] && m.insts[i]!.status !== 'Undocked' && docked(m.insts[i]!.diskId ?? '')
    switch (action) {
        case 'open_disk_inventory': return docked(KOL) || docked(NC) ? null : 'no grade5a disk card'
        case 'back_to_disk': case 'stay_on_disk': case 'stay_on_source_disk': return docked(KOL) ? null : `disk card ${KOL} missing`
        case 'eject_disk': return m.ejectTarget() ? null : 'no ejectable disk card'
        case 'open_instance_controls': return live(KI) || live(NCI) ? null : 'no grade5a instance row'
        case 'start_instance': case 'stop_instance': case 'rename_instance': case 'backup_instance': return live(KI) ? null : `instance row ${KI} missing`
        case 'open_app': return running(KI) ? null : `${KI} not Running`
        case 'copy_app': return live(KI) ? null : `copy source ${KI} absent`
        case 'move_app': return walker.stage2CopyInstanceId && live(walker.stage2CopyInstanceId) ? null : 'no live copy to move'
        case 'infra_move_disk': return docked(KOL) ? null : `${KOL} not docked`
    }
    if (/^leave_/.test(action) || action === 'return_to_start') return null
    if (/kolibri/.test(action) || /^kolibri_/.test(to)) return running(KI) ? null : `${KI} not Running`
    if (/nextcloud/.test(action) || /^nc_/.test(to)) return running(NCI) ? null : `${NCI} not Running`
    if (/wikipedia/.test(action) || /^wiki_/.test(to)) return running(KXI) ? null : `${KXI} not Running`
    return null
}

/** The store change each step makes (Engine + harness), as far as the guards and intents can see it. */
const applyEffect = (m: Stage2Model, walker: WalkerState, action: string): void => {
    switch (action) {
        case 'confirm_eject': m.consoleEject(7); break // lands in the store 7 reads later (Markov 4)
        case 'stop_instance': if (m.insts[KI]!.status !== 'Undocked') m.insts[KI]!.status = 'Stopped'; break
        case 'start_instance': if (m.insts[KI]!.status !== 'Undocked') m.insts[KI]!.status = 'Running'; break
        case 'make_backup_disk': m.disks[STAGE2_ROLE_MAP.backup]!.diskTypes = ['backup']; break
        case 'copy_app':
            m.insts['kolibri-copy'] = { id: 'kolibri-copy', status: 'Running', diskId: NC, port: 18081 }
            walker.stage2CopyInstanceId = 'kolibri-copy'
            break
        case 'move_app': m.insts['kolibri-copy']!.diskId = STAGE2_ROLE_MAP.moveApp; break
        case 'infra_undock_fixtures': for (const d of FIXTURE_DISKS) m.undock(d); break
        case 'infra_dock_fixture':
            for (const d of FIXTURE_DISKS) if (!m.disks[d]!.dockedTo) void m.dockFixture(STAGE2_FIXTURES.find(f => f.diskId === d)!.host, d)
            break
    }
}

const dryRun = async (redock: boolean) => {
        const scenario = loadScenario('unified')
        const m = new Stage2Model()
        const walker: WalkerState = { current: scenario.initial_state, layer: null, dockedEngine: null, step: 0 }
        const rng = makeRng(42)
        const problems: string[] = []
        const counts: Record<string, number> = {}
        let redocks = 0, blockedDraws = 0
        for (let i = 0; i < 2000; i++) {
            const from = walker.current
            const state = scenario.states[from]!
            const base = { opts: { ops: m, fast: true, settleTimeoutMs: 50 }, walker, poolEngines: POOL, excludeEngines: ['idea02'], fixtureInstance: KI, fixtureInstances: FIXTURES, fixtureDisk: KOL }
            let picked
            try {
                picked = await pickDrawableTransition(from, state.transitions, rng, (a, t) => randomStepPrecondition(base as never, a, {}, t))
            } catch (e) {
                problems.push(`draw ${i + 1} @${from}: ${(e as Error).message}`)
                break
            }
            if (picked.blocked.length) blockedDraws++
            const { action, to } = picked.transition
            counts[action] = (counts[action] ?? 0) + 1
            const need = intentNeeds(m, walker, action, to)
            if (need) problems.push(`draw ${i + 1} ${from} --${action}--> ${to}: ${need}`)
            const ctx = { ...base, from, to, action, fixtureDisks: FIXTURE_DISKS } as never
            // the runner's own hooks (runner.ts calls exactly these two around dispatchAction)
            const before = await markovRedockBefore(ctx, redock)
            applyEffect(m, walker, action)
            walker.current = to
            walker.layer = scenario.states[to]?.layer ?? null
            walker.step = i + 1
            noteStepPreconditionProgress(walker, action)
            const r = await markovRedockAfter(ctx, redock, before, { from: state.layer ?? null, to: scenario.states[to]?.layer ?? null }, { ...FAST, ejectWaitMs: 1_000, dockFixtures: dockFixtures(m) })
            if (!r.ok) problems.push(`draw ${i + 1} re-dock: ${r.note}`)
            if (r.note && /docked again/.test(r.note)) redocks++
            if (!redock) for (let k = 0; k < 8; k++) m.tick() // control: let the eject land anyway
            // outside the infra layer every partition is docked again before the next draw
            if (walker.layer !== 'infra') {
                const missing = Object.values(m.disks).filter(d => !d.dockedTo).map(d => d.id)
                if (missing.length) problems.push(`draw ${i + 1} after ${action}: undocked outside infra: ${missing.join(', ')}`)
            }
        }
        const tag = redock ? 'dry-run seed 42' : 'control (no re-dock)'
        console.log(`[${tag}] draws=2000 confirm_eject=${counts.confirm_eject ?? 0} redocks=${redocks} drawsWithBlockedEdges=${blockedDraws} ` +
            `copy_app=${counts.copy_app ?? 0} back_to_disk=${counts.back_to_disk ?? 0} infra_undock=${counts.infra_undock_fixtures ?? 0} problems=${problems.length}`)
        for (const p of problems.slice(0, redock ? 40 : 5)) console.log(`[${tag}] ${p}`)
        return { problems, counts }
}

describe('dry run: seed 42, 2000 draws, unified graph, Stage 2 model', () => {
    it('with the re-dock: no abort, no "no drawable transition", every drawn step finds what its intent needs', async () => {
        const { problems, counts } = await dryRun(true)
        expect(problems).toEqual([])
        expect(counts.confirm_eject ?? 0).toBeGreaterThan(0)
    })
    it('control without the re-dock: the checker catches the Markov 3 failure class', async () => {
        const { problems } = await dryRun(false)
        expect(problems.some(p => /undocked outside infra|disk card duration-kolibri-grade5a-001 missing/.test(p))).toBe(true)
    })
})
