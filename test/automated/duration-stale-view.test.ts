/**
 * r65 FAIL@43 copy_app: the walker's cached store view showed no copyApp Operation for ≥66 s while a fresh
 * connection showed it (started +0.85 s after Confirm, Done in 25 s). r66: stale-view guard (forced
 * reconnect + re-read, every one counted and reported), op-start wait ≥ 60 s, post-check clock from Confirm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { waitOperationTerminal, opAppearBudgetMs, MIN_OP_APPEAR_MS } from '../duration/opWait.js'
import { verifyCopyOperation } from '../duration/actions.js'
import { reconnectEvents, resetReconnectEvents, renderReconnectsMd, writeReconnectsMd, reconnectLine, staleViewMs } from '../duration/staleView.js'
import { buildRunSummary, formatRunSummaryLine } from '../duration/runSummary.js'

const CONFIRM = 1791673954723
const OP = { id: '1cvror3eafnj1tqgdhb', kind: 'copyApp', status: 'Done', startedAt: CONFIRM + 846, completedAt: CONFIRM + 26_176, args: { instanceId: 'kolibri-grade5a-001', targetDiskId: 'duration-nextcloud-grade5a-001' } }
const conn = (heads: string[], ops: Record<string, unknown>) => ({ host: '100.99.231.94', storeHandle: { heads: () => heads, doc: () => ({ operationDB: ops }) } })

/** A RealFleetOps whose cached conns are frozen; a forced reconnect yields `fresh(engine)`. */
const fleet = (engines: string[], fresh: (e: string) => ReturnType<typeof conn>) => {
    const f = Object.create(RealFleetOps.prototype) as RealFleetOps & Record<string, unknown>
    const conns = new Map(engines.map(e => [e, conn(['aaaaaaaa11'], {})]))
    Object.assign(f, {
        conns, viewSeen: new Map(), assertNotExcluded: () => {},
        connect: vi.fn(async (e: string, force = false) => { if (force) conns.set(e, fresh(e)); return conns.get(e) }),
        engineHttpUp: vi.fn(async () => true),
    })
    return f
}
let logs: string[] = []
beforeEach(() => { resetReconnectEvents(); logs = []; vi.spyOn(console, 'log').mockImplementation((l: string) => { logs.push(String(l)) }) })
afterEach(() => vi.restoreAllMocks())

describe('stale-view guard', () => {
    it('r65 replay: frozen cached view, fresh connection sees the op → Done after ONE forced reconnect, counted and reported', async () => {
        const f = fleet(['idea01'], () => conn(['bbbbbbbb22'], { [OP.id]: OP }))
        let t = CONFIRM
        const r = await waitOperationTerminal({ kind: 'copyApp', instanceId: 'kolibri-grade5a-001', sinceMs: CONFIRM }, {
            engines: ['idea01'], listOperations: e => f.listOperations(e), refresh: (e, why) => f.refreshView(e, why),
            sleep: async ms => { t += ms }, now: () => t,
        }, 900_000, opAppearBudgetMs({}))
        expect(r.status).toBe('Done')
        expect(r.elapsedMs).toBeGreaterThanOrEqual(60_000)
        const ev = reconnectEvents()
        expect(ev).toHaveLength(1)
        expect(ev[0]).toMatchObject({ engine: 'idea01', foundNew: true, beforeHeads: 'aaaaaaaa', afterHeads: 'bbbbbbbb' })
        expect(ev[0]!.reason).toMatch(/copyApp wait saw no Operation for kolibri-grade5a-001 after \d+ms/)
        expect(logs.some(l => /"event":"stale_view_reconnect","n":1,"engine":"idea01".*"found_new":true/.test(l))).toBe(true)
        expect(reconnectLine()).toMatch(/Stale-view reconnects: 1 \(found new data: 1, failed: 0\) — idea01×1\. .*possible sync bug/)
    })
    it('a truly missing op still fails (NotSeen) after the reconnect, which is counted with found_new=false', async () => {
        const f = fleet(['idea01', 'idea03', 'idea04'], () => conn(['aaaaaaaa11'], {}))
        let t = CONFIRM
        const r = await waitOperationTerminal({ kind: 'copyApp', instanceId: 'kolibri-grade5a-001', sinceMs: CONFIRM }, {
            engines: ['idea01', 'idea03', 'idea04'], listOperations: e => f.listOperations(e), refresh: (e, why) => f.refreshView(e, why),
            sleep: async ms => { t += ms }, now: () => t,
        }, 900_000, 60_000)
        expect(r.status).toBe('NotSeen')
        expect(reconnectEvents().map(e => [e.engine, e.foundNew])).toEqual([['idea01', false], ['idea03', false], ['idea04', false]])
    })
    it('a failed reconnect is still counted (found_new=null, error kept)', async () => {
        const f = fleet(['idea01'], () => { throw new Error('ws handshake timeout') })
        expect(await f.refreshView('idea01', 'test')).toBeNull()
        expect(reconnectEvents()[0]).toMatchObject({ engine: 'idea01', foundNew: null, error: 'ws handshake timeout' })
    })
    it('doc unchanged for DURATION_STALE_VIEW_MS while the Pi is up → listOperations forces a counted reconnect', async () => {
        const f = fleet(['idea01'], () => conn(['cccccccc33'], { [OP.id]: OP }))
        const now = vi.spyOn(Date, 'now')
        now.mockReturnValue(1_000_000)
        expect(await f.listOperations('idea01')).toEqual([])
        now.mockReturnValue(1_000_000 + staleViewMs({}) + 1)
        expect((await f.listOperations('idea01')).map(r => r.id)).toEqual([OP.id])
        expect(reconnectEvents()[0]!.reason).toMatch(/doc unchanged 120s while idea01 is up/)
        // Pi down → no reconnect
        resetReconnectEvents()
        const g = fleet(['idea01'], () => conn(['dd'], {}))
        ;((g as unknown as { engineHttpUp: ReturnType<typeof vi.fn> }).engineHttpUp).mockResolvedValue(false)
        now.mockReturnValue(1)
        await g.listOperations('idea01')
        now.mockReturnValue(1 + 500_000)
        await g.listOperations('idea01')
        expect(reconnectEvents()).toHaveLength(0)
    })
})

describe('copy post-check: budget wiring, clock from Confirm, guard', () => {
    const ctx = (ops: object) => ({ action: 'copy_app', poolEngines: ['idea01', 'idea02', 'idea03'], excludeEngines: [], opts: { fast: true, ops } }) as never
    it('op-start wait: default 60 s; explicit lower values are honoured but warned; run.sh sets them explicitly', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(MIN_OP_APPEAR_MS).toBe(60_000)
        expect(opAppearBudgetMs({})).toBe(60_000)
        expect(opAppearBudgetMs({ DURATION_OP_APPEAR_MS: '5000' })).toBe(5_000)
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DURATION_OP_APPEAR_MS=5000ms is below the 60000ms/))
        expect(opAppearBudgetMs({ DURATION_OP_APPEAR_MS: '120000' })).toBe(120_000)
    })
    it('truly missing op: clock starts at Confirm (70 s ago) → one counted reconnect, then never_started with budget 60000ms', async () => {
        const refreshView = vi.fn(async (_e: string, _r: string) => false)
        const r = await verifyCopyOperation(ctx({ listOperations: async () => [], refreshView }), CONFIRM, { instanceId: 'kolibri-grade5a-001' },
            { startClockMs: Date.now() - 70_000, doneBudgetMs: 1_000, pollMs: 1 }, {})
        expect(r).toMatchObject({ ok: false, reason: 'never_started' })
        expect(r!.note).toMatch(/within 7\d{4}ms \(budget 60000ms\) after the copy Confirm/)
        expect(refreshView).toHaveBeenCalledTimes(2) // idea01 + idea03, never idea02
        expect(refreshView.mock.calls.map(c => (c as unknown[])[0])).toEqual(['idea01', 'idea03'])
    })
    it('r65 replay in the post-check: nothing in the frozen view, op visible after the forced reconnect → ok', async () => {
        let fresh = false
        const r = await verifyCopyOperation(ctx({
            listOperations: async () => (fresh ? [{ ...OP, startedAt: Date.now() - 60_000 }] : []),
            refreshView: async () => { fresh = true; return true },
        }), Date.now() - 66_000, { instanceId: 'kolibri-grade5a-001' }, { startClockMs: Date.now() - 66_000, pollMs: 1 })
        expect(r).toMatchObject({ ok: true, reason: 'ok' })
    })
})

describe('reconnect summary', () => {
    const evs = [
        { engine: 'idea01', at: Date.UTC(2026, 9, 10, 23, 13, 4), reason: 'copyApp wait saw no Operation for kolibri-grade5a-001 after 60010ms', foundNew: true, beforeHeads: 'aaaaaaaa', afterHeads: 'bbbbbbbb', tookMs: 812 },
        { engine: 'idea03', at: Date.UTC(2026, 9, 10, 23, 13, 5), reason: 'same', foundNew: false, beforeHeads: 'cc', afterHeads: 'cc', tookMs: 400 },
        { engine: 'idea04', at: Date.UTC(2026, 9, 10, 23, 13, 6), reason: 'same', foundNew: null, beforeHeads: 'dd', afterHeads: 'n/a', tookMs: 15_000, error: 'timeout' },
    ]
    it('RECONNECTS.md lists every reconnect with Pi, CEST time, reason and found-new', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rc-'))
        const md = readFileSync(writeReconnectsMd(dir, evs), 'utf8')
        expect(md).toBe(renderReconnectsMd(evs))
        expect(md).toMatch(/Stale-view reconnects: 3 \(found new data: 1, failed: 1\) — idea01×1, idea03×1, idea04×1/)
        expect(md).toMatch(/\| 1 \| idea01 \| 2026-10-11T01:13:04 \| copyApp wait saw no Operation for kolibri-grade5a-001 after 60010ms \| YES \| 812 \| aaaaaaaa → bbbbbbbb \|/)
        expect(md).toMatch(/\| 2 \| idea03 \| 2026-10-11T01:13:05 \| same \| no \|/)
        expect(md).toMatch(/\| 3 \| idea04 \| .* \| reconnect FAILED: timeout \|/)
        expect(renderReconnectsMd([])).toMatch(/Stale-view reconnects: 0/)
    })
    it('duration_summary carries the count and times; the summary line shows them', () => {
        const s = buildRunSummary({ walk: null, result: { steps: 43, failures: 1, aborted: true, abortReason: 'x', logs: [] }, recoveries: { total: 0, failed: 0, byKind: {} }, reconnects: evs })
        expect(s.reconnects).toMatchObject({ count: 3, found_new: 1, failed: 1, byEngine: { idea01: 1, idea03: 1, idea04: 1 } })
        expect(s.reconnects!.times[0]).toBe('idea01@2026-10-10T23:13:04.000Z')
        expect(formatRunSummaryLine(s)).toMatch(/stale-view reconnects: 3 \(found new 1, failed 1; idea01@2026-10-10T23:13:04\.000Z/)
    })
})

describe('r65 lookup among ~1,500 finished ops (Atlas clue) — not the cause', () => {
    // Shape copied from the live operationDB row 1cvror3eafnj1tqgdhb (numbers in epoch ms, kind/args.instanceId).
    const kinds = ['startApp', 'stopApp', 'copyApp', 'moveApp', 'backupApp', 'restoreApp']
    const old = Array.from({ length: 1519 }, (_, i) => ({
        id: `old${i}`, kind: kinds[i % kinds.length]!, status: i % 50 ? 'Done' : 'Failed', startedAt: CONFIRM - 86_400_000 + i * 50_000,
        completedAt: CONFIRM - 86_400_000 + i * 50_000 + 20_000, error: null, args: { instanceId: 'kolibri-grade5a-001', sourceDiskId: 'duration-kolibri-grade5a-001', targetDiskId: 'duration-nextcloud-grade5a-001' },
    }))
    it('the new copyApp is found first among 1,519 older ops in any order (opWait and post-check)', async () => {
        for (const rows of [[...old, OP], [OP, ...old], [...old.slice(0, 700), OP, ...old.slice(700)]]) {
            const r = await waitOperationTerminal({ kind: 'copyApp', instanceId: 'kolibri-grade5a-001', sinceMs: CONFIRM }, {
                engines: ['idea01'], listOperations: async () => rows, sleep: async () => {}, now: () => CONFIRM + 1_000,
            }, 900_000, 60_000)
            expect(r).toMatchObject({ status: 'Done', opId: OP.id })
            const v = await verifyCopyOperation({ action: 'copy_app', poolEngines: ['idea01'], excludeEngines: [], opts: { fast: true, ops: { listOperations: async () => rows } } } as never,
                CONFIRM, { instanceId: 'kolibri-grade5a-001' }, { pollMs: 1 })
            expect(v).toMatchObject({ ok: true })
            expect(v!.note).toContain(OP.id)
        }
    })
})
