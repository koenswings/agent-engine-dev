/**
 * idea#168 Markov 9040e73@8: `--scenario random` drew move_app before any copy_app had recorded a
 * disposable instance and aborted before the Intent (DURATION_COPY_INSTANCE_ID unset). In the Markov
 * draw a step whose precondition is an earlier step's result is now not drawable; the walker resamples
 * among the other edges. Deterministic walks (cover-all) are unchanged and still fail loud.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeFleetOps, noteStepPreconditionProgress, randomStepPrecondition, stage2MoveAppPins } from '../duration/actions.js'
import { pickDrawableTransition, runDeterministicWalk, runWalk } from '../duration/runner.js'
import { makeRng } from '../duration/scenario.js'
import type { Scenario, Transition, WalkerState } from '../duration/types.js'

const POOL = ['idea01', 'idea03', 'idea04']
const walkerOf = (over: Partial<WalkerState> = {}): WalkerState => ({ current: 'start', layer: null, dockedEngine: null, step: 7, ...over })

const guardCtx = (ops: unknown, walker: WalkerState = walkerOf()) =>
    ({ opts: { ops }, walker, poolEngines: POOL, excludeEngines: ['idea02'], fixtureInstance: 'kolibri-grade5a-001' }) as never

const backupView = (disks: Record<string, unknown>) => ({ engineId: 'idea03', diskDB: disks, instanceDB: {}, engineDB: {}, appDB: {} })
const liveOps = (disks: Record<string, unknown>) => ({ probeBackupDisk: async () => null, readStore: async () => backupView(disks) })
const BACKUP_DISK = { 'duration-empty-003': { id: 'duration-empty-003', dockedTo: 'idea03', diskTypes: ['backup'], backupLinks: ['kolibri-grade5a-001'] } }

let savedCopyEnv: string | undefined
beforeEach(() => { savedCopyEnv = process.env.DURATION_COPY_INSTANCE_ID; delete process.env.DURATION_COPY_INSTANCE_ID })
afterEach(() => { if (savedCopyEnv === undefined) delete process.env.DURATION_COPY_INSTANCE_ID; else process.env.DURATION_COPY_INSTANCE_ID = savedCopyEnv })

describe('randomStepPrecondition: move_app needs the recorded copy (Stage 2)', () => {
    it('Stage 2, no recorded copy, no env override: not drawable', async () => {
        expect(await randomStepPrecondition(guardCtx({ stage: 2 }), 'move_app', {})).toMatch(/no copy_app instance recorded/)
    })
    it('Stage 2 with a recorded copy or DURATION_COPY_INSTANCE_ID: drawable', async () => {
        expect(await randomStepPrecondition(guardCtx({ stage: 2 }, walkerOf({ stage2CopyInstanceId: 'abc' })), 'move_app', {})).toBeNull()
        expect(await randomStepPrecondition(guardCtx({ stage: 2 }), 'move_app', { DURATION_COPY_INSTANCE_ID: 'mine' })).toBeNull()
    })
    it('Stage 1 / Fake: drawable (the Stage 2 throw does not apply)', async () => {
        expect(await randomStepPrecondition(guardCtx({}), 'move_app', {})).toBeNull()
    })
    it('steps without an earlier-result precondition are always drawable', async () => {
        for (const a of ['copy_app', 'open_copied_instance', 'install_app', 'erase_disk', 'stay_on_overview']) {
            expect(await randomStepPrecondition(guardCtx({ stage: 2 }), a, {})).toBeNull()
        }
    })
    it('the cover-all fail-loud check itself is unchanged', () => {
        const ctx = { action: 'move_app', walker: { step: 8, stage2CopyInstanceId: null }, opts: { ops: { stage: 2 } } } as never
        expect(() => stage2MoveAppPins(ctx, {})).toThrow(/no step-43 copy recorded.*never fall back to the Kolibri fixture/)
    })
})

describe('randomStepPrecondition: backup steps (live only)', () => {
    it('no docked Backup Disk: backup_instance, backup_schedule, restore_from_backup not drawable', async () => {
        const ctx = guardCtx(liveOps({}))
        for (const a of ['backup_instance', 'backup_schedule', 'restore_from_backup']) {
            expect(await randomStepPrecondition(ctx, a, {})).toMatch(/make_backup_disk first/)
        }
    })
    it('backup_instance needs the disk to link the instance', async () => {
        const other = { b: { id: 'b', dockedTo: 'idea03', diskTypes: ['backup'], backupLinks: ['someone-else'] } }
        expect(await randomStepPrecondition(guardCtx(liveOps(other)), 'backup_instance', {})).toMatch(/linked to kolibri-grade5a-001/)
        expect(await randomStepPrecondition(guardCtx(liveOps(other)), 'backup_schedule', {})).toBeNull()
    })
    it('a Backup Disk docked on idea02 (excluded) does not count', async () => {
        const golden = { b: { id: 'b', dockedTo: 'idea02', diskTypes: ['backup'] } }
        expect(await randomStepPrecondition(guardCtx(liveOps(golden)), 'backup_schedule', {})).toMatch(/no docked Backup Disk/)
    })
    it('docked linked Backup Disk: backup_instance + backup_schedule drawable; restore waits for a backup_instance', async () => {
        const walker = walkerOf()
        const ctx = guardCtx(liveOps(BACKUP_DISK), walker)
        expect(await randomStepPrecondition(ctx, 'backup_instance', {})).toBeNull()
        expect(await randomStepPrecondition(ctx, 'backup_schedule', {})).toBeNull()
        expect(await randomStepPrecondition(ctx, 'restore_from_backup', {})).toMatch(/no backup_instance archive/)
        noteStepPreconditionProgress(walker, 'backup_instance')
        expect(await randomStepPrecondition(ctx, 'restore_from_backup', {})).toBeNull()
    })
    it('Fake ops (no Backup Disk probe): unchanged, always drawable', async () => {
        for (const a of ['backup_instance', 'backup_schedule', 'restore_from_backup']) {
            expect(await randomStepPrecondition(guardCtx({ readStore: async () => backupView({}) }), a, {})).toBeNull()
        }
    })
})

describe('pickDrawableTransition', () => {
    const T: Transition[] = [
        { to: 'a', weight: 5, action: 'copy_app' },
        { to: 'a', weight: 90, action: 'move_app' },
        { to: 'b', weight: 5, action: 'stay_on_overview' },
    ]
    const blockMove = async (a: string) => (a === 'move_app' ? 'no copy' : null)
    it('never draws a blocked edge and reports it', async () => {
        const rng = makeRng(42)
        for (let i = 0; i < 200; i++) {
            const r = await pickDrawableTransition('op_disk', T, rng, blockMove)
            expect(r.transition.action).not.toBe('move_app')
            expect(r.blocked).toEqual([{ action: 'move_app', reason: 'no copy' }])
        }
    })
    it('nothing blocked: same draws as before (one rng call per step)', async () => {
        const a = makeRng(7), b = makeRng(7)
        for (let i = 0; i < 100; i++) {
            const r = await pickDrawableTransition('op_disk', T, a, async () => null)
            const x = b() * 100
            const want = x <= 5 ? 'copy_app' : x <= 95 ? 'move_app' : 'stay_on_overview'
            expect(r.transition.action).toBe(want)
            expect(r.blocked).toEqual([])
        }
    })
    it('every edge blocked: fail loud', async () => {
        await expect(pickDrawableTransition('op_copy', [T[1]!], makeRng(1), blockMove)).rejects.toThrow(/no drawable transition from 'op_copy'.*move_app: no copy/)
    })
})

describe('runWalk (Markov) resamples instead of aborting; deterministic walk still fails loud', () => {
    const scenario = (states: Scenario['states']): Scenario => ({
        name: 'markov-precondition', seed: 3, exclude_engines: ['idea02'], pool_engines: POOL, store_mode: 'shared',
        fixture_disk: 'duration-kolibri-grade5a-001', fixtures: [], states, initial_state: 'start',
    })
    const graph = scenario({
        start: { layer: 'operator', transitions: [
            { to: 'start', weight: 95, action: 'move_app' },
            { to: 'start', weight: 5, action: 'stay_on_overview' },
        ] },
    })
    const stage2Ops = () => Object.assign(new FakeFleetOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' }), { stage: 2 })
    const opts = { fast: true, stubUi: true, skipStability: true, settleTimeoutMs: 200 } as const

    it('Stage 2 without a recorded copy: move_app is never drawn and the walk does not abort', async () => {
        const r = await runWalk({ ...opts, scenario: graph, iterations: 30, ops: stage2Ops(), rng: makeRng(3) })
        expect(r.aborted).toBe(false)
        expect(r.failures).toBe(0)
        expect(r.steps).toBe(30)
        expect(r.logs.every(l => l.action === 'stay_on_overview')).toBe(true)
        expect(r.logs[0]!.message).toMatch(/Markov: not drawable yet: move_app \(no copy_app instance recorded/)
    })
    it('Stage 2 with DURATION_COPY_INSTANCE_ID set: move_app is drawable again', async () => {
        process.env.DURATION_COPY_INSTANCE_ID = 'operator-pick'
        const r = await runWalk({ ...opts, scenario: graph, iterations: 30, ops: stage2Ops(), rng: makeRng(3) })
        expect(r.logs.some(l => l.action === 'move_app')).toBe(true)
        expect(r.logs.every(l => !/not drawable/.test(l.message ?? ''))).toBe(true)
    })
    it('Fake (Stage 1): the seeded draw sequence is unchanged', async () => {
        const ops = new FakeFleetOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
        const r = await runWalk({ ...opts, scenario: graph, iterations: 30, ops, rng: makeRng(3) })
        const rng = makeRng(3)
        const want = Array.from({ length: 30 }, () => (rng() * 100 <= 95 ? 'move_app' : 'stay_on_overview'))
        expect(r.logs.map(l => l.action)).toEqual(want)
    })
    it('a state whose only edges are blocked aborts loud (no silent fallback)', async () => {
        const only = scenario({ start: { layer: 'operator', transitions: [{ to: 'start', weight: 1, action: 'move_app' }] } })
        const r = await runWalk({ ...opts, scenario: only, iterations: 5, ops: stage2Ops(), rng: makeRng(3) })
        expect(r.aborted).toBe(true)
        expect(r.abortReason).toMatch(/no drawable transition from 'start'/)
        expect(r.logs).toHaveLength(0)
    })
    it('deterministic walks never use the guard (the explicit step runs as written)', async () => {
        const walk = { kind: 'walk', name: 'w', scenario: graph, steps: [{ from: 'start', to: 'start', action: 'move_app' }] } as never
        const r = await runDeterministicWalk(walk, { ...opts, ops: stage2Ops(), rng: makeRng(3) })
        expect(r.logs.map(l => l.action)).toEqual(['move_app'])
        expect(r.logs[0]!.message ?? '').not.toMatch(/not drawable/)
    })
})
