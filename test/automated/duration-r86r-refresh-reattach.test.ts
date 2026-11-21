/**
 * r86q (cover-all-stage2-f702e6a-r86q) FAIL@42: after copyApp the store-host thread was blocked (58 s); the
 * stale-view guard (refreshView) then called connect(forceNew) → a fresh Repo = full first sync of 3zoqd on
 * the blocked thread → no outcome in 63 s → fatal. r86r (Steve): refreshView re-syncs the EXISTING link
 * through the f702e6a reattach path; a slow-but-recovering host gets more time (bounded); never a fresh sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealFleetOps, freshRecheckMs, storeSyncCapMs } from '../duration/realFleetOps.js'
import { reconnectEvents, resetReconnectEvents } from '../duration/staleView.js'

type FakeLink = { alive: boolean; heads: string[]; lastReattachError: string | null; reattach: ReturnType<typeof vi.fn>; hostState: () => string; doc: () => unknown }

const mkLink = (script: Array<{ ok: boolean; blocked: boolean; heads?: string[]; err?: string }>): FakeLink => {
    let blocked = false
    const l: FakeLink = {
        alive: true, heads: ['aaaaaaaa11'], lastReattachError: null, doc: () => ({ operationDB: {} }),
        hostState: () => blocked ? '; store-host thread unresponsive for 40s (event loop blocked)' : '',
        reattach: vi.fn(async () => {
            const s = script.shift() ?? { ok: false, blocked: true, err: 'no answer' }
            blocked = s.blocked
            if (s.heads) l.heads = s.heads
            l.lastReattachError = s.ok ? null : (s.err ?? 'did not answer reattach')
            return s.ok
        }),
    }
    return l
}

const fleet = (link: FakeLink) => {
    const f = Object.create(RealFleetOps.prototype) as RealFleetOps & Record<string, unknown>
    const c = { host: '10.99.0.11', link, storeHandle: { heads: () => link.heads, doc: () => link.doc() } }
    const conns = new Map([['idea01', c]])
    const connect = vi.fn(async () => { throw new Error('connect(forceNew) must not be used for an alive link') })
    Object.assign(f, { conns, viewSeen: new Map(), assertNotExcluded: () => {}, connect })
    return { f, connect }
}

let logs: string[] = []
beforeEach(() => {
    resetReconnectEvents(); logs = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => { logs.push(String(l)) })
    process.env.DURATION_REFRESH_REATTACH_MS = '2000'
    process.env.DURATION_REFRESH_REATTACH_SLICE_MS = '10'
})
afterEach(() => { vi.restoreAllMocks(); delete process.env.DURATION_REFRESH_REATTACH_MS; delete process.env.DURATION_REFRESH_REATTACH_SLICE_MS })

describe('r86r: refreshView re-syncs the existing store link', () => {
    it('healthy link: one reattach, no fresh connection, counted with mode=reattach', async () => {
        const link = mkLink([{ ok: true, blocked: false, heads: ['bbbbbbbb22'] }])
        const { f, connect } = fleet(link)
        expect(await f.refreshView('idea01', 'copyApp wait saw no Operation')).toBe(true)
        expect(connect).not.toHaveBeenCalled()
        expect(link.reattach).toHaveBeenCalledTimes(1)
        expect(reconnectEvents()[0]).toMatchObject({ engine: 'idea01', foundNew: true, mode: 'reattach', reason: 'copyApp wait saw no Operation' })
        expect(logs.some(l => /"event":"stale_view_reconnect".*"mode":"reattach"/.test(l))).toBe(true)
    })
    it('r86q replay: host blocked but recovering → waits it out (more slices), doc ready, never a full first sync', async () => {
        const link = mkLink([{ ok: false, blocked: true }, { ok: false, blocked: true }, { ok: true, blocked: false, heads: ['cccccccc33'] }])
        const { f, connect } = fleet(link)
        expect(await f.refreshView('idea01', 'stale view')).toBe(true)
        expect(link.reattach).toHaveBeenCalledTimes(3)
        expect(connect).not.toHaveBeenCalled()
        expect(logs.filter(l => /stale_view_reattach_slice.*"host_blocked":true/.test(l))).toHaveLength(2)
    })
    it('host stays blocked past the bound → loud, counted failure (foundNew=null), still no fresh sync', async () => {
        process.env.DURATION_REFRESH_REATTACH_MS = '80'
        const link = mkLink([])
        link.reattach.mockImplementation(async () => { await new Promise(r => setTimeout(r, 15)); link.lastReattachError = 'did not answer reattach'; return false })
        ;(link as { hostState: () => string }).hostState = () => '; store-host thread unresponsive for 90s (event loop blocked)'
        const { f, connect } = fleet(link)
        const t0 = Date.now()
        expect(await f.refreshView('idea01', 'stale view')).toBeNull()
        expect(Date.now() - t0).toBeLessThan(1_000)
        expect(connect).not.toHaveBeenCalled()
        const ev = reconnectEvents()[0]!
        expect(ev).toMatchObject({ foundNew: null, mode: 'failed' })
        expect(ev.error).toMatch(/did not complete within 80ms and the store host is still blocked.*NOT replaced by a fresh full sync/)
    })
    it('responsive host but WS stays down → logged fallback to a fresh connection (mode=fresh)', async () => {
        const link = mkLink([{ ok: false, blocked: false, err: 'reattach: no WS peer, handle ready after 10ms' }])
        const { f, connect } = fleet(link)
        connect.mockImplementation(async () => ({ storeHandle: { heads: () => ['dddddddd44'] } }) as never)
        expect(await f.refreshView('idea01', 'stale view')).toBe(true)
        expect(connect).toHaveBeenCalledWith('idea01', true)
        expect(logs.some(l => /stale_view_refresh_fallback.*no WS peer/.test(l))).toBe(true)
        expect(reconnectEvents()[0]).toMatchObject({ mode: 'fresh', foundNew: true })
    })
    it('dead link → fresh connection as before', async () => {
        const link = mkLink([]); link.alive = false
        const { f, connect } = fleet(link)
        connect.mockImplementation(async () => ({ storeHandle: { heads: () => ['eeeeeeee55'] } }) as never)
        expect(await f.refreshView('idea01', 'stale view')).toBe(true)
        expect(link.reattach).not.toHaveBeenCalled()
        expect(connect).toHaveBeenCalledWith('idea01', true)
    })
    it('reattach records the sync round of the link (engine#557)', async () => {
        const link = mkLink([{ ok: true, blocked: false, heads: ['bbbbbbbb22'] }]) as FakeLink & { lastSyncRound?: string }
        link.lastSyncRound = 'answered'
        const { f } = fleet(link)
        expect(await f.refreshView('idea01', 'stale view')).toBe(true)
        expect(reconnectEvents()[0]).toMatchObject({ mode: 'reattach', syncRound: 'answered' })
        expect(logs.some(l => /"mode":"reattach","sync_round":"answered"/.test(l))).toBe(true)
    })
})

describe('engine#557: refreshView(fresh) — the convergence re-check is always a fresh link', () => {
    afterEach(() => { delete process.env.DURATION_FRESH_RECHECK_MS })
    it('alive link: no reattach, connect(forceNew) replaces it, recorded mode=fresh', async () => {
        const link = mkLink([{ ok: true, blocked: false }])
        const { f, connect } = fleet(link)
        connect.mockImplementation(async () => ({ storeHandle: { heads: () => ['ffffffff66'] } }) as never)
        expect(await f.refreshView('idea04', 'convergence: only idea04 off the majority', { fresh: true })).toBe(true)
        expect(link.reattach).not.toHaveBeenCalled()
        expect(connect).toHaveBeenCalledWith('idea04', true)
        expect(reconnectEvents()[0]).toMatchObject({ engine: 'idea04', mode: 'fresh', foundNew: true })
    })
    it('fresh link not ready within DURATION_FRESH_RECHECK_MS → null, recorded mode=failed with the bound', async () => {
        process.env.DURATION_FRESH_RECHECK_MS = '60'
        const link = mkLink([])
        const { f, connect } = fleet(link)
        connect.mockImplementation(() => new Promise(() => {}) as never)
        const t0 = Date.now()
        expect(await f.refreshView('idea04', 'convergence', { fresh: true })).toBeNull()
        expect(Date.now() - t0).toBeLessThan(1_000)
        const ev = reconnectEvents()[0]!
        expect(ev).toMatchObject({ foundNew: null, mode: 'failed' })
        expect(ev.error).toMatch(/fresh re-check: fresh link to idea04 not ready within 60ms/)
    })
    it('freshRecheckMs: default 180 s, env override, junk ignored', () => {
        expect(freshRecheckMs({})).toBe(180_000)
        expect(freshRecheckMs({ DURATION_FRESH_RECHECK_MS: '90000' })).toBe(90_000)
        expect(freshRecheckMs({ DURATION_FRESH_RECHECK_MS: 'x' })).toBe(180_000)
    })
})

describe('engine#560: storeSyncCapMs', () => {
    it('default 300 s, env override, junk ignored', () => {
        expect(storeSyncCapMs({})).toBe(300_000)
        expect(storeSyncCapMs({ DURATION_STORE_SYNC_CAP_MS: '240000' })).toBe(240_000)
        expect(storeSyncCapMs({ DURATION_STORE_SYNC_CAP_MS: '0' })).toBe(300_000)
    })
})
