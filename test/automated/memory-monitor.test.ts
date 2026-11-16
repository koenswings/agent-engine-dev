/**
 * engine#471: the hourly [memory] line (src/monitors/memoryMonitor.ts).
 * Pure: fake process.memoryUsage and fake / in-memory repos; no network, no timers left running.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import {
    MEMORY_LOG_INTERVAL_MS, formatMemoryLine, isCommandLogShape, memorySnapshot, startMemoryMonitor,
} from '../../src/monitors/memoryMonitor.js'

const MIB = 1024 * 1024
const usage = (): NodeJS.MemoryUsage => ({
    rss: 1706 * MIB, heapUsed: 121 * MIB, heapTotal: 158 * MIB, external: 1480 * MIB, arrayBuffers: 3 * MIB,
})
const fakeHandle = (doc: unknown, ready = true) => ({ isReady: () => ready, doc: () => doc })

afterEach(() => { vi.useRealTimers() })

describe('memoryMonitor (engine#471)', () => {
    it('isCommandLogShape: { traces, recentTraceIds } only', () => {
        expect(isCommandLogShape({ traces: {}, recentTraceIds: [] })).toBe(true)
        expect(isCommandLogShape({ traces: {}, recentTraceIds: [], storeTag: 'x' })).toBe(true)
        expect(isCommandLogShape({ engineDB: {}, instanceDB: {} })).toBe(false)
        expect(isCommandLogShape({ traces: null, recentTraceIds: [] })).toBe(false)
        expect(isCommandLogShape({ traces: {}, recentTraceIds: {} })).toBe(false)
        expect(isCommandLogShape(undefined)).toBe(false)
        expect(isCommandLogShape('traces')).toBe(false)
    })

    it('memorySnapshot counts docs, ready docs, command logs and our own log; reads memoryUsage once', () => {
        const u = vi.fn(usage)
        const repo = { handles: {
            store: fakeHandle({ engineDB: {} }),
            ownLog: fakeHandle({ traces: {}, recentTraceIds: [] }),
            peerLog: fakeHandle({ traces: { t: {} }, recentTraceIds: ['t'] }),
            pending: fakeHandle(undefined, false),
            broken: { isReady: () => true, doc: () => { throw new Error('gone') } },
        } }
        const s = memorySnapshot(repo, 'ownLog', u)
        expect(u).toHaveBeenCalledTimes(1)
        expect(s).toMatchObject({ docs: 5, docsReady: 4, commandLogs: 2, ownCommandLogLoaded: true, rss: 1706 * MIB, external: 1480 * MIB })
        expect(memorySnapshot(repo, 'otherLog', u).ownCommandLogLoaded).toBe(false)
        expect(memorySnapshot(repo, null, u).ownCommandLogLoaded).toBe(false)
        expect(memorySnapshot({ handles: {} }, null, u)).toMatchObject({ docs: 0, docsReady: 0, commandLogs: 0 })
    })

    it('formatMemoryLine: one grep-able line in MiB with doc counts and uptime', () => {
        const s = memorySnapshot({ handles: { a: fakeHandle({ traces: {}, recentTraceIds: [] }) } }, 'a', usage)
        expect(formatMemoryLine(s, 8 * 3600)).toBe(
            '[memory] rss=1706MiB heapUsed=121MiB heapTotal=158MiB external=1480MiB arrayBuffers=3MiB docs=1 ready=1 commandLogs=1 ownCommandLog=yes uptime=8.0h')
    })

    it('works on a real Repo: store doc + command log, own log id read on every tick', async () => {
        const repo = new Repo({ network: [] })
        const store = repo.create<any>({ engineDB: {}, instanceDB: {} })
        const logA = repo.create<any>({ traces: {}, recentTraceIds: [] })
        let own: string = logA.documentId
        const lines: string[] = []
        vi.useFakeTimers()
        const stop = startMemoryMonitor(repo, { ownCommandLogId: () => own, sink: l => lines.push(l), usage, uptime: () => 60 })
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/^\[memory\] rss=1706MiB .* docs=2 ready=2 commandLogs=1 ownCommandLog=yes uptime=0\.0h$/)
        expect(store.isReady()).toBe(true)
        const logB = repo.create<any>({ traces: {}, recentTraceIds: [] })   // daily rotation
        own = logB.documentId
        vi.advanceTimersByTime(MEMORY_LOG_INTERVAL_MS)
        expect(lines).toHaveLength(2)
        expect(lines[1]).toContain('docs=3 ready=3 commandLogs=2 ownCommandLog=yes')
        stop()
        vi.advanceTimersByTime(3 * MEMORY_LOG_INTERVAL_MS)
        expect(lines).toHaveLength(2)
        await repo.shutdown()
    })

    it('a failing snapshot logs one line instead of throwing; default interval is one hour', () => {
        expect(MEMORY_LOG_INTERVAL_MS).toBe(3_600_000)
        const lines: string[] = []
        const stop = startMemoryMonitor({ handles: {} }, { sink: l => lines.push(l), usage: () => { throw new Error('boom') } })
        stop()
        expect(lines).toEqual(['[memory] snapshot failed: boom'])
    })
})
