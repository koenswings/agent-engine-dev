/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * r70 (r69 FAIL@43): copyApp Done, but the walker's idea01 view had frozen at the source's mid-start 'Pauzed'
 * (box_pause 04:46:07Z–05:05:09Z); only idea04 was refreshed. After copy/move Done every pool view is refreshed and
 * the sources + the op's new instances must be Running (bounded, dump on timeout).
 */
import { describe, expect, it } from 'vitest'
import { settleAfterLongOp, poolInstanceIds, postOpSettleBudgetMs, type PostOpSettleIo } from '../duration/postOpSettle.js'
import { POST_OP_SETTLE_ACTIONS, postOpIo } from '../duration/actions.js'
import type { SemanticStoreView } from '../duration/types.js'

const SRC = 'kolibri-grade5a-001', COPY = 'fj96e5d7mrvrixl7qk1'
const KD = 'duration-kolibri-grade5a-001', ND = 'duration-nextcloud-grade5a-001'
const POOL = ['idea01', 'idea03', 'idea04']
const view = (e: string, inst: Record<string, string>): SemanticStoreView => ({
    engineId: e,
    instanceDB: Object.fromEntries(Object.entries(inst).map(([id, status]) => [id, { id, status, diskId: id === SRC ? KD : ND }])),
    diskDB: { [KD]: { id: KD, dockedTo: 'idea01' }, [ND]: { id: ND, dockedTo: 'idea03' } } as any,
    engineDB: {},
})

/** Per-engine views; a frozen engine keeps its stale view until refreshed. */
const fleet = (fresh: Record<string, string>, stale: Record<string, Record<string, string>>) => {
    const frozen = new Set(Object.keys(stale))
    const refreshed: string[] = []
    const logs: string[] = []
    let t = 0
    const io: PostOpSettleIo = {
        engines: POOL,
        readStore: async e => view(e, frozen.has(e) ? stale[e]! : fresh),
        refresh: async e => { refreshed.push(e); frozen.delete(e); return true },
        sleep: async ms => { t += ms },
        now: () => t,
        log: l => logs.push(l),
    }
    return { io, refreshed, logs, setFresh: (k: string, v: string) => { fresh[k] = v } }
}

describe('settleAfterLongOp (unit)', () => {
    it('r69 replay: idea01 view frozen at Pauzed → refresh ALL pool engines → Running → pass', async () => {
        const f = fleet({ [SRC]: 'Running', [COPY]: 'Running' }, { idea01: { [SRC]: 'Pauzed' } })
        const r = await settleAfterLongOp('copy_app', [SRC], new Set([SRC]), f.io)
        expect(r.ok).toBe(true)
        expect(f.refreshed).toEqual(POOL)
        expect(r.targets).toEqual([COPY])
        expect(r.note).toMatch(/kolibri-grade5a-001 Running on idea01, fj96e5d7mrvrixl7qk1 Running on idea03/)
    })
    it('old behaviour (no refresh of idea01) would fail: without refresh the stale Pauzed times out with a dump', async () => {
        const f = fleet({ [SRC]: 'Running' }, { idea01: { [SRC]: 'Pauzed' } })
        delete (f.io as any).refresh
        const r = await settleAfterLongOp('copy_app', [SRC], null, f.io, 10_000, 3_000)
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/not all Running within 10000ms .*kolibri-grade5a-001=Pauzed@idea01 views=\{"idea01":"Pauzed","idea03":"Running","idea04":"Running"\}/)
        expect(f.logs.some(l => /"event":"post_op_settle".*"ok":false.*"dump"/.test(l))).toBe(true)
    })
    it('new instance Starting → Running within the budget: waits, then passes', async () => {
        const fresh: Record<string, string> = { [SRC]: 'Running', [COPY]: 'Starting' }
        const f = fleet(fresh, {})
        let polls = 0
        const read = f.io.readStore
        f.io.readStore = async e => { if (e === 'idea04' && ++polls === 3) fresh[COPY] = 'Running'; return read(e) }
        const r = await settleAfterLongOp('copy_app', [SRC], new Set([SRC]), f.io, 60_000, 3_000)
        expect(r.ok).toBe(true)
        expect(r.waitedMs).toBeGreaterThan(0); expect(r.waitedMs).toBeLessThan(60_000)
    })
    it('a target that never runs fails at the budget, re-refreshing views while waiting', async () => {
        const f = fleet({ [SRC]: 'Running', [COPY]: 'Error' }, {})
        const r = await settleAfterLongOp('move_app', [SRC], new Set([SRC]), f.io, 130_000, 10_000, 60_000)
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/fj96e5d7mrvrixl7qk1=Error@idea03/)
        expect(f.refreshed.length).toBe(9) // initial + 2 re-refreshes × 3 engines
    })
    it('baseline from all pool views; budget env', async () => {
        const f = fleet({ [SRC]: 'Running' }, {})
        expect([...await poolInstanceIds(f.io)]).toEqual([SRC])
        expect(postOpSettleBudgetMs({})).toBe(300_000)
        expect(postOpSettleBudgetMs({ DURATION_POST_OP_SETTLE_MS: '900000' })).toBe(900_000)
        expect([...POST_OP_SETTLE_ACTIONS].sort()).toEqual(['copy_app', 'move_app'])
    })
})

describe('smoke: postOpIo over a live-like ops object (real timers)', () => {
    it('refreshView on every pool engine (never idea02), real sleeps, passes once the frozen view is refreshed', async () => {
        const refreshed: string[] = []
        let frozen = true
        const ops = {
            readStore: async (e: string) => view(e, e === 'idea01' && frozen ? { [SRC]: 'Pauzed' } : { [SRC]: 'Running' }),
            refreshView: async (e: string) => { refreshed.push(e); if (e === 'idea01') frozen = false; return true },
        }
        const ctx = { poolEngines: [...POOL, 'idea02'], excludeEngines: ['idea02'], opts: { ops } } as any
        const t0 = Date.now()
        const r = await settleAfterLongOp('copy_app', [SRC], null, postOpIo(ctx), 2_000, 50)
        expect(r.ok).toBe(true)
        expect(refreshed).toEqual(POOL)
        expect(Date.now() - t0).toBeLessThan(1_000)
    })
})
