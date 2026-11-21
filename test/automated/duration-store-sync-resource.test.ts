/**
 * engine#564 (Markov c3b30b6 step 91): main-thread resource samples while a store sync is in flight.
 * The sampler starts with the first in-flight sync, logs every interval, and stops when none is left.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    StoreSyncResourceSampler,
    memAvailableMb,
    sampleStoreSyncResources,
    storeSyncSampleMs,
} from '../duration/storeSyncResource.js'

afterEach(() => { vi.useRealTimers() })

describe('store sync resource sampler', () => {
    it('starts on the first in-flight sync, samples every interval, stops when none is left', () => {
        vi.useFakeTimers()
        const lines: string[] = []
        const s = new StoreSyncResourceSampler({ intervalMs: 10_000, log: l => lines.push(l) })
        const a = {}, b = {}
        expect(s.running).toBe(false)
        s.begin(a, { engine: 'idea03', startedAt: Date.now() })
        expect(s.running).toBe(true)
        vi.advanceTimersByTime(9_999)
        expect(lines).toHaveLength(0)
        vi.advanceTimersByTime(1)
        expect(lines).toHaveLength(1)
        s.begin(b, { engine: 'idea04', startedAt: Date.now() })
        vi.advanceTimersByTime(10_000)
        expect(JSON.parse(lines[1]!).inFlight.map((x: { engine: string }) => x.engine)).toEqual(['idea03', 'idea04'])
        s.end(a)
        expect(s.running).toBe(true)
        s.end(b)
        s.end(b) // idempotent
        expect(s.running).toBe(false)
        vi.advanceTimersByTime(60_000)
        expect(lines).toHaveLength(2)
        expect(s.samples).toBe(2)
    })

    it('interval 0 turns sampling off', () => {
        vi.useFakeTimers()
        const lines: string[] = []
        const s = new StoreSyncResourceSampler({ intervalMs: 0, log: l => lines.push(l) })
        s.begin({}, { engine: 'idea03', startedAt: Date.now() })
        expect(s.running).toBe(false)
        vi.advanceTimersByTime(60_000)
        expect(lines).toHaveLength(0)
    })

    it('a throwing sample never breaks the sync', () => {
        const s = new StoreSyncResourceSampler({ intervalMs: 10_000, log: () => {}, sample: () => { throw new Error('boom') } })
        const k = {}
        s.begin(k, { engine: 'idea03', startedAt: Date.now() })
        expect(() => s.tick()).not.toThrow()
        s.end(k)
    })

    it('a sample line is greppable and carries walker memory, MemAvailable, loadavg and per-link host state', () => {
        const now = Date.now()
        const line = sampleStoreSyncResources([{ engine: 'idea03', startedAt: now - 25_000, hostBlockedMs: () => 279_000, workerHeapMb: () => 95 }], now)
        expect(line.event).toBe('store_sync_resource')
        expect(line.inFlight).toEqual([{ engine: 'idea03', sinceMs: 25_000, hostBlockedMs: 279_000, workerHeapMb: 95 }])
        for (const k of ['rssMb', 'heapUsedMb', 'heapTotalMb', 'externalMb', 'freeMemMb']) expect(typeof line[k]).toBe('number')
        expect(line.loadavg).toHaveLength(3)
        expect(JSON.stringify(line)).toMatch(/^\{"event":"store_sync_resource"/)
    })

    it('parses MemAvailable (MB) and tolerates a missing /proc', () => {
        expect(memAvailableMb(() => 'MemTotal:  3884000 kB\nMemFree:  100000 kB\nMemAvailable:  1048576 kB\n')).toBe(1024)
        expect(memAvailableMb(() => { throw new Error('ENOENT') })).toBeNull()
        expect(memAvailableMb(() => 'MemTotal: 1 kB\n')).toBeNull()
    })

    it('DURATION_STORE_SYNC_SAMPLE_MS: default 10 s, 0 = off, junk = default', () => {
        expect(storeSyncSampleMs({})).toBe(10_000)
        expect(storeSyncSampleMs({ DURATION_STORE_SYNC_SAMPLE_MS: '0' })).toBe(0)
        expect(storeSyncSampleMs({ DURATION_STORE_SYNC_SAMPLE_MS: '5000' })).toBe(5_000)
        expect(storeSyncSampleMs({ DURATION_STORE_SYNC_SAMPLE_MS: 'x' })).toBe(10_000)
    })
})
