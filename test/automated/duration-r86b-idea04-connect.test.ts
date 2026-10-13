/**
 * r86b (cover-all-stage2-8c5a0e4-r86b) died before step 1: the walk-start preflight opened the
 * idea01/idea03/idea04 store connects at once, and idea04 (the only Pi 4) gave "sync stall: not ready
 * 55s after connect". Atlas: idea04 runs each new client's first full sync on its main thread (~4.7 s extra
 * per concurrent client, blocked 14.9 s with 3 clients; 11.2 MB in 2,032 unmerged files). Fix: idea04 gets
 * a 120 s store-ready wait, and the walk-start connects go one Pi at a time, a few seconds apart.
 * A stall after the wait still fails loud.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RealFleetOps, IDEA04_DOC_WAIT_MS, DEFAULT_CONNECT_STAGGER_MS, connectStaggerMs, StoreSyncStallError } from '../duration/realFleetOps.js'

const mk = () => new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: 'a', idea03: 'b', idea04: 'c' } })
const saved = { ...process.env }
afterEach(() => { for (const k of ['DURATION_DOC_WAIT_MS_IDEA04', 'DURATION_CONNECT_STAGGER_MS', 'DURATION_DOC_WAIT_MS', 'DURATION_DOC_WAIT_MS_BY_HOST']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

describe('r86b: idea04 store-ready 120 s + staggered walk-start connects', () => {
    it('idea04 waits 120 s by default; the launcher value 120000 is honoured; Pi 5s unchanged', () => {
        delete process.env.DURATION_DOC_WAIT_MS_IDEA04
        expect(IDEA04_DOC_WAIT_MS).toBe(120_000)
        expect(mk().docWaitMsFor('idea04')).toBe(120_000)
        process.env.DURATION_DOC_WAIT_MS_IDEA04 = '120000'
        expect(mk().docWaitMsFor('idea04')).toBe(120_000)
        process.env.DURATION_DOC_WAIT_MS = '45000'
        expect(mk().docWaitMsFor('idea01')).toBe(45_000)
    })
    it('stagger default 3 s, env override', () => {
        delete process.env.DURATION_CONNECT_STAGGER_MS
        expect(connectStaggerMs()).toBe(DEFAULT_CONNECT_STAGGER_MS)
        expect(DEFAULT_CONNECT_STAGGER_MS).toBeGreaterThanOrEqual(2_000)
        expect(connectStaggerMs({ DURATION_CONNECT_STAGGER_MS: '5000' })).toBe(5_000)
    })
    it('preflight connects one Pi at a time, spaced by the stagger (never concurrent)', async () => {
        process.env.DURATION_CONNECT_STAGGER_MS = '50'
        const ops = mk()
        let active = 0, maxActive = 0
        const starts: number[] = []
        ;(ops as unknown as { connect: (id: string) => Promise<unknown> }).connect = async () => {
            starts.push(Date.now()); active++; maxActive = Math.max(maxActive, active)
            await new Promise(r => setTimeout(r, 20)); active--
            return {}
        }
        const r = await ops.preflightEngines(1_000)
        expect(r.ok).toBe(true)
        expect(r.engines.map(e => e.id)).toEqual(['idea01', 'idea03', 'idea04'])
        expect(maxActive).toBe(1)
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(65)
        expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(65)
    })
    it('still fail-loud: a stall on idea04 fails the preflight with the stall message (no soft-pass)', async () => {
        process.env.DURATION_CONNECT_STAGGER_MS = '0'
        const ops = mk()
        ;(ops as unknown as { connect: (id: string) => Promise<unknown> }).connect = async (id: string) => {
            if (id === 'idea04') throw new StoreSyncStallError('idea04', 'ws://c:4321', 'store 3zoqd not ready 121s after connect (doc wait 120000ms)')
            return {}
        }
        const r = await ops.preflightEngines(1_000)
        expect(r.ok).toBe(false)
        const bad = r.engines.find(e => e.id === 'idea04')!
        expect(bad.ok).toBe(false)
        expect(bad.message).toContain('not ready 121s')
    })
})
