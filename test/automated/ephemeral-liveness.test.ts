/**
 * ephemeral-liveness.test.ts: store design (Koen decision 2026-10-13), Engine side.
 *   - Liveness: hb broadcast (never stored), lastRun stored at boot + at most hourly,
 *     peers' pings remembered on our clock;
 *   - PeerAccess: the 7-day stale rule uses max(stored lastRun, live ping);
 *   - dockerMetricsMonitor: metricsMessage shape;
 *   - Operations: progress-only patches are not stored; finished ops older than
 *     7 days move into the CommandLog (own Engine only; kept when no CommandLog).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { next as A } from '@automerge/automerge'
import {
    startLiveness, writeLastSeen, notePing, peerLiveSeen, clearPeerPings, hbMessage,
    LAST_SEEN_INTERVAL_MS, HB_TYPE, METRICS_TYPE,
} from '../../src/data/Liveness.js'
import { computePeerSet, PEER_STALE_MS } from '../../src/data/PeerAccess.js'
import { metricsMessage } from '../../src/monitors/dockerMetricsMonitor.js'
import {
    updateOperation, isProgressOnly, operationsToArchive, archiveOldOperations, OPERATION_ARCHIVE_AGE_MS,
} from '../../src/data/Operations.js'

const DAY = 86_400_000
const T0 = 1_791_000_000_000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const newStore = (extra: any = {}): DocHandle<any> => {
    const repo = new Repo({ network: [] })
    return repo.create<any>({ engineDB: { ENGINE_me: { id: 'ENGINE_me', hostname: 'me', lastBooted: T0, lastRun: T0 } }, operationDB: {}, instanceDB: {}, diskDB: {}, appDB: {}, userDB: {}, ...extra })
}
const changes = (h: DocHandle<any>) => A.getAllChanges(h.doc()).length

beforeEach(() => clearPeerPings())

describe('Liveness (hb ephemeral, lastRun hourly)', () => {
    it('writeLastSeen: writes when missing/forced/an hour old, not every tick', () => {
        const h = newStore()
        expect(writeLastSeen(h, 'ENGINE_me', T0 + 30_000)).toBe(false)
        expect(writeLastSeen(h, 'ENGINE_me', T0 + LAST_SEEN_INTERVAL_MS - 1)).toBe(false)
        expect(writeLastSeen(h, 'ENGINE_me', T0 + LAST_SEEN_INTERVAL_MS)).toBe(true)
        expect(h.doc().engineDB.ENGINE_me.lastRun).toBe(T0 + LAST_SEEN_INTERVAL_MS)
        expect(writeLastSeen(h, 'ENGINE_me', T0 + LAST_SEEN_INTERVAL_MS + 5, undefined, true)).toBe(true)
        // a clock that went backwards (no RTC) re-writes instead of waiting an hour
        expect(writeLastSeen(h, 'ENGINE_me', T0)).toBe(true)
        expect(writeLastSeen(h, 'ENGINE_nobody', T0)).toBe(false)
    })

    it('startLiveness: broadcasts hb every interval without changing the doc; a day of beats = 24 stored writes max', async () => {
        const h = newStore()
        const sent: any[] = []
        const orig = h.broadcast.bind(h)
        ;(h as any).broadcast = (m: any) => { sent.push(m); orig(m) }
        let clock = T0
        const before = changes(h)
        const stop = startLiveness(h, 'ENGINE_me', { hbIntervalMs: 20, now: () => (clock += 10_000) })
        await sleep(150)
        stop()
        expect(sent.length).toBeGreaterThanOrEqual(3)
        expect(sent[0]).toMatchObject({ type: HB_TYPE, v: 1, engineId: 'ENGINE_me', bootedAt: T0 })
        expect(changes(h)).toBe(before)   // < 1 h of simulated beats: nothing stored
        // simulate a day of 10 s beats
        let writes = 0
        for (let t = T0; t < T0 + DAY; t += 10_000) if (writeLastSeen(h, 'ENGINE_me', t)) writes++
        expect(writes).toBeLessThanOrEqual(24)
    })

    it('notePing remembers hb and metrics from peers on our clock; ignores anything else', () => {
        expect(notePing({ type: HB_TYPE, engineId: 'ENGINE_b' }, 5)).toBe(true)
        expect(notePing({ type: METRICS_TYPE, engineId: 'ENGINE_c', instances: {} }, 7)).toBe(true)
        expect(notePing({ type: 'x', engineId: 'ENGINE_d' }, 9)).toBe(false)
        expect(notePing(null)).toBe(false)
        expect(peerLiveSeen('ENGINE_b')).toBe(5)
        expect(peerLiveSeen('ENGINE_c')).toBe(7)
        expect(peerLiveSeen('ENGINE_d')).toBeUndefined()
    })

    it('hbMessage carries bootedAt from the store', () => {
        expect(hbMessage(newStore(), 'ENGINE_me', 42)).toEqual({ type: HB_TYPE, v: 1, engineId: 'ENGINE_me', now: 42, bootedAt: T0 })
    })
})

describe('PeerAccess stale rule with live pings (7 days kept)', () => {
    const key = (c: string) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${c.repeat(43).slice(0, 43)} x`
    const store = (lastRun: number) => ({
        engineDB: {
            ENGINE_me: { id: 'ENGINE_me', lastRun: T0 },
            ENGINE_b: { id: 'ENGINE_b', lastRun, peerAccess: { sshKey: key('B'), hostKey: key('H') } },
        },
    } as any)
    it('a stored lastRun older than 7 days: dropped without a ping, kept with a recent ping', () => {
        const now = T0 + 8 * DAY
        expect(computePeerSet(store(T0), 'ENGINE_me', now).peers).toHaveLength(0)
        expect(computePeerSet(store(T0), 'ENGINE_me', now, PEER_STALE_MS, () => now - 10_000).peers.map(p => p.engineId)).toEqual(['ENGINE_b'])
    })
    it('short threshold (peer-verify): a stopped peer drops once its pings stop, though lastRun is fresh-ish', () => {
        const now = T0 + 10 * 60_000
        const stale = 3 * 60_000
        expect(computePeerSet(store(T0), 'ENGINE_me', now, stale, () => now - 5_000).peers).toHaveLength(1)
        expect(computePeerSet(store(T0), 'ENGINE_me', now, stale, () => now - 4 * 60_000).peers).toHaveLength(0)
    })
})

describe('metrics message', () => {
    it('shape the Console reads (live.ts)', () => {
        const m = { cpuPercent: 1, memUsageBytes: 2, memLimitBytes: 3, memPercent: 4, netRxBytes: 5, netTxBytes: 6, blockReadBytes: 7, blockWriteBytes: 8, sampledAt: 9 }
        expect(metricsMessage('ENGINE_me', 9, { i1: m })).toEqual({ type: 'idea/metrics', v: 1, engineId: 'ENGINE_me', sampledAt: 9, instances: { i1: m } })
    })
})

describe('Operations: progress on step change only, archive into the CommandLog', () => {
    const op = (id: string, extra: any = {}) => ({ id, kind: 'copyApp', args: {}, cause: 'console-command', subject: null, engineId: 'ENGINE_me', status: 'Done', progressPercent: 100, currentStep: null, totalSteps: null, stepLabel: null, startedAt: T0, completedAt: T0, error: null, ...extra })

    it('isProgressOnly', () => {
        expect(isProgressOnly({ progressPercent: 5 })).toBe(true)
        expect(isProgressOnly({ progressPercent: 5, currentStep: 1 })).toBe(false)
        expect(isProgressOnly({ status: 'Done' })).toBe(false)
        expect(isProgressOnly({ progressPercent: 5, stepLabel: undefined })).toBe(true)
        expect(isProgressOnly({})).toBe(false)
    })

    it('updateOperation: percent-only patches are not stored; step/status patches are (with their percent)', () => {
        const h = newStore({ operationDB: { o1: op('o1', { status: 'Running', progressPercent: 0, currentStep: 0 }) } })
        const n = changes(h)
        for (let p = 1; p < 50; p++) updateOperation(h as any, 'o1', { progressPercent: p })
        expect(changes(h)).toBe(n)
        updateOperation(h as any, 'o1', { currentStep: 1, stepLabel: 'next', progressPercent: 50 })
        expect(h.doc().operationDB.o1).toMatchObject({ currentStep: 1, progressPercent: 50 })
        updateOperation(h as any, 'o1', { status: 'Done', progressPercent: 100, completedAt: T0 as any })
        expect(h.doc().operationDB.o1).toMatchObject({ status: 'Done', progressPercent: 100 })
        expect(changes(h)).toBe(n + 2)
    })

    it('operationsToArchive: own finished ops older than 7 days only', () => {
        const now = T0 + OPERATION_ARCHIVE_AGE_MS + 1
        const s: any = { operationDB: {
            old: op('old'), oldFailed: op('oldFailed', { status: 'Failed' }), oldCancelled: op('oldCancelled', { status: 'Cancelled' }),
            fresh: op('fresh', { completedAt: now - 1000 }), running: op('running', { status: 'Running', completedAt: null }),
            other: op('other', { engineId: 'ENGINE_b' }), noCompleted: op('noCompleted', { completedAt: null }),
        } }
        expect(operationsToArchive(s, 'ENGINE_me', now).map(o => o.id).sort()).toEqual(['noCompleted', 'old', 'oldCancelled', 'oldFailed'])
    })

    it('archiveOldOperations: records go to CommandLog traces in batches, then leave the store; nothing without a CommandLog', async () => {
        const ops: any = {}
        for (let i = 0; i < 150; i++) ops[`o${i}`] = op(`o${i}`)
        ops.keep = op('keep', { completedAt: T0 + OPERATION_ARCHIVE_AGE_MS })
        const h = newStore({ operationDB: ops })
        const now = T0 + OPERATION_ARCHIVE_AGE_MS + 1
        expect(await archiveOldOperations(h as any, { engineId: 'ENGINE_me', now, commandLog: null })).toBe(0)
        expect(Object.keys(h.doc().operationDB)).toHaveLength(151)
        const cl = new Repo({ network: [] }).create<any>({ traces: {}, recentTraceIds: [] })
        expect(await archiveOldOperations(h as any, { engineId: 'ENGINE_me', now, commandLog: cl })).toBe(150)
        expect(Object.keys(h.doc().operationDB)).toEqual(['keep'])
        const traces = Object.values(cl.doc().traces) as any[]
        expect(traces).toHaveLength(2)
        expect(traces.every(t => t.command === 'archiveOperations' && t.status === 'ok')).toBe(true)
        const archived = traces.flatMap(t => JSON.parse(t.result))
        expect(archived).toHaveLength(150)
        expect(archived[0]).toMatchObject({ kind: 'copyApp', status: 'Done', engineId: 'ENGINE_me' })
        // idempotent: a second sweep finds nothing
        expect(await archiveOldOperations(h as any, { engineId: 'ENGINE_me', now, commandLog: cl })).toBe(0)
    })
})
