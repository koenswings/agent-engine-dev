/**
 * first-sync-gate.test.ts — engine#543: the Engine's instance bring-up waits (bounded) for the first
 * peer's store sync to be served, the startup store log prints counts instead of the whole store, and
 * checkAndSetUndockedApps writes all its Starting marks in ONE doc change.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { next as A } from '@automerge/automerge'
import {
    startFirstSyncGate, firstSyncWaitSettings, logFirstSyncOutcome, yieldToEventLoop,
    FIRST_SYNC_MAX_WAIT_MS, FIRST_SYNC_NO_PEER_GRACE_MS,
} from '../../src/data/FirstSyncGate.js'
import { describeStoreCounts, Store } from '../../src/data/Store.js'
import { checkAndSetUndockedApps } from '../../src/data/UndockedApps.js'
import { EngineID, InstanceID } from '../../src/data/CommonTypes.js'
import { readFileSync } from 'fs'

const DOC = 'store-doc-1'

/** A fake repo + manual clock/timers so the bounds are tested without real waiting. */
const rig = (heads: string[] = ['h1', 'h2']) => {
    const em = new EventEmitter()
    const repo = {
        peerId: 'engine-self', peers: [] as string[],
        synchronizer: { on: (e: string, f: any) => em.on(e, f), off: (e: string, f: any) => em.off(e, f) },
    }
    let t = 0
    const timers: Array<{ at: number; fn: () => void; dead?: boolean }> = []
    const setTimer = (fn: () => void, ms: number) => { const x = { at: t + ms, fn }; timers.push(x); return x }
    const clearTimer = (x: any) => { x.dead = true }
    const advance = (ms: number) => {
        const to = t + ms
        for (;;) {
            const next = timers.filter(x => !x.dead && x.at <= to).sort((a, b) => a.at - b.at)[0]
            if (!next) break
            next.dead = true; t = next.at; next.fn()
        }
        t = to
    }
    let cur = heads
    const gate = startFirstSyncGate(repo, { storeDocId: DOC, heads: () => cur, now: () => t, setTimer, clearTimer })
    const emit = (peerId: string, sharedHeads: string[], documentId = DOC) => em.emit('sync-state', { peerId, documentId, syncState: { sharedHeads } })
    return { repo, gate, emit, advance, setHeads: (h: string[]) => { cur = h }, listeners: () => em.listenerCount('sync-state') }
}

describe('FirstSyncGate (engine#543)', () => {
    it('resolves "served" as soon as a remote peer shares exactly our heads', async () => {
        const r = rig()
        const p = r.gate.whenServed()
        r.advance(1200)
        r.emit('walker-1', ['h1'])               // partial sync: not served yet
        r.advance(100)
        r.emit('walker-1', ['h2', 'h1'])          // caught up (order irrelevant)
        const o = await p
        expect(o).toMatchObject({ result: 'served', peerId: 'walker-1', waitedMs: 1300 })
    })

    it('a sync that finished BEFORE whenServed was called still counts (states are recorded from the start)', async () => {
        const r = rig()
        r.emit('peer-a', ['h1', 'h2'])
        expect(await r.gate.whenServed()).toMatchObject({ result: 'served', peerId: 'peer-a', waitedMs: 0 })
    })

    it('ignores our own peer id, other documents, and empty heads', async () => {
        const r = rig()
        const p = r.gate.whenServed({ maxWaitMs: 10_000, noPeerGraceMs: 10_000 })
        r.emit('engine-self', ['h1', 'h2'])
        r.emit('walker-1', ['h1', 'h2'], 'some-command-log')
        r.emit('walker-2', [])
        r.advance(10_000)
        expect((await p).result).toBe('timeout')
    })

    it('does not count a peer that is behind (shared heads differ from ours)', async () => {
        const r = rig(['h3'])
        const p = r.gate.whenServed({ maxWaitMs: 5000, noPeerGraceMs: 1000 })
        r.emit('walker-1', ['h1'])
        r.advance(5000)
        expect((await p).result).toBe('timeout')
    })

    it('no peer connected and none syncing: goes on after the grace period ("no-peer")', async () => {
        const r = rig()
        const p = r.gate.whenServed()
        r.advance(FIRST_SYNC_NO_PEER_GRACE_MS - 1)
        r.advance(1)
        expect(await p).toMatchObject({ result: 'no-peer', waitedMs: FIRST_SYNC_NO_PEER_GRACE_MS })
    })

    it('a connected peer that never catches up keeps us waiting until maxWaitMs, then goes on ("timeout")', async () => {
        const r = rig()
        r.repo.peers.push('walker-1')
        const p = r.gate.whenServed()
        r.advance(FIRST_SYNC_NO_PEER_GRACE_MS + 1000)   // grace passed but a peer is connected: still waiting
        r.advance(FIRST_SYNC_MAX_WAIT_MS)
        expect(await p).toMatchObject({ result: 'timeout', waitedMs: FIRST_SYNC_MAX_WAIT_MS + FIRST_SYNC_NO_PEER_GRACE_MS + 1000 - 0 > 0 ? FIRST_SYNC_MAX_WAIT_MS : 0 })
    })

    it('maxWaitMs 0 never waits ("skipped")', async () => {
        const r = rig()
        expect(await r.gate.whenServed({ maxWaitMs: 0 })).toEqual({ result: 'skipped', waitedMs: 0 })
    })

    it('stop() detaches the listener', () => {
        const r = rig()
        expect(r.listeners()).toBe(1)
        r.gate.stop()
        expect(r.listeners()).toBe(0)
    })

    it('settings: testMode / IDEA_WATCH_DIR never wait; env overrides; bad values fall back', () => {
        expect(firstSyncWaitSettings({}, {})).toEqual({ maxWaitMs: FIRST_SYNC_MAX_WAIT_MS, noPeerGraceMs: FIRST_SYNC_NO_PEER_GRACE_MS })
        expect(firstSyncWaitSettings({}, { testMode: true }).maxWaitMs).toBe(0)
        expect(firstSyncWaitSettings({}, { watchDirSet: true }).maxWaitMs).toBe(0)
        expect(firstSyncWaitSettings({ IDEA_FIRST_SYNC_WAIT_MS: '0' }, {}).maxWaitMs).toBe(0)
        expect(firstSyncWaitSettings({ IDEA_FIRST_SYNC_WAIT_MS: '1500', IDEA_FIRST_SYNC_NO_PEER_GRACE_MS: '200' }, {})).toEqual({ maxWaitMs: 1500, noPeerGraceMs: 200 })
        expect(firstSyncWaitSettings({ IDEA_FIRST_SYNC_WAIT_MS: 'abc', IDEA_FIRST_SYNC_NO_PEER_GRACE_MS: '-5' }, {})).toEqual({ maxWaitMs: FIRST_SYNC_MAX_WAIT_MS, noPeerGraceMs: FIRST_SYNC_NO_PEER_GRACE_MS })
    })

    it('logs one [first-sync] line per outcome', () => {
        const lines: string[] = []
        logFirstSyncOutcome({ result: 'served', waitedMs: 1234, peerId: 'walker-1' }, m => lines.push(m))
        logFirstSyncOutcome({ result: 'timeout', waitedMs: 45000 }, m => lines.push(m))
        expect(lines[0]).toContain('[first-sync] served after 1234 ms')
        expect(lines[0]).toContain('walker-1')
        expect(lines[1]).toContain('timeout after 45000 ms')
    })

    it('yieldToEventLoop lets an already-queued I/O-phase callback run first', async () => {
        const order: string[] = []
        setImmediate(() => order.push('queued'))
        await yieldToEventLoop()
        order.push('after-yield')
        expect(order).toEqual(['queued', 'after-yield'])
    })

    it('real Automerge: the sharedHeads of a finished sync equal A.getHeads of the Engine doc, and A.getHeads reads a Repo handle doc (what start.ts uses)', () => {
        type D = { n: number; items: Record<string, number> }
        let engine = A.from<D>({ n: 1, items: {} })
        for (let i = 0; i < 5; i++) engine = A.change(engine, d => { d.items['k' + i] = i })
        let peer = A.init<D>()
        let sEngine = A.initSyncState(), sPeer = A.initSyncState()
        let seen: readonly string[] = []
        for (let i = 0; i < 20; i++) {
            const [s1, m1] = A.generateSyncMessage(engine, sEngine); sEngine = s1
            if (m1) { const r = A.receiveSyncMessage(peer, sPeer, m1); peer = r[0]; sPeer = r[1] }
            const [s2, m2] = A.generateSyncMessage(peer, sPeer); sPeer = s2
            if (m2) { const r = A.receiveSyncMessage(engine, sEngine, m2); engine = r[0]; sEngine = r[1]; seen = sEngine.sharedHeads }
            if (!m1 && !m2) break
        }
        const heads = A.getHeads(engine)
        expect(heads.length).toBeGreaterThan(0)
        expect([...seen].sort()).toEqual([...heads].sort())
        // the Repo's own handle doc is read with the same call in start.ts
        const h = new Repo({ network: [], storage: undefined }).create<D>({ n: 1, items: {} })
        h.change(d => { d.items.a = 1 })
        const rh = A.getHeads(h.doc() as any)
        expect(rh.length).toBe(1)
        expect(rh[0]).toMatch(/^[0-9a-f]{64}$/)
    })
})

describe('startup store log (engine#543)', () => {
    it('describeStoreCounts prints counts, never content', () => {
        const s = describeStoreCounts({ engineDB: { a: { secret: 'X'.repeat(50) }, b: {} }, diskDB: { d: {} }, appDB: {}, instanceDB: { i1: {}, i2: {}, i3: {} } })
        expect(s).toBe('2 engine(s), 1 disk(s), 0 app(s), 3 instance(s)')
        expect(s).not.toContain('secret')
        expect(describeStoreCounts(undefined)).toBe('0 engine(s), 0 disk(s), 0 app(s), 0 instance(s)')
    })

    it('Store.ts no longer dumps the whole store through deepPrint', () => {
        const src = readFileSync('src/data/Store.ts', 'utf8')
        expect(src).not.toMatch(/deepPrint\s*\(/)
        expect(src).toContain('describeStoreCounts(handle.doc())')
    })

    it('start.ts holds the dock pass for the first sync (before the USB monitor) and observes from before the store loads', () => {
        const src = readFileSync('src/start.ts', 'utf8')
        const gate = src.indexOf('startFirstSyncGate(')
        const load = src.indexOf('await createServerStore(')
        const wait = src.indexOf('firstSync.whenServed(')
        const usb = src.indexOf('enableUsbDeviceMonitor(storeHandle)')
        expect(gate).toBeGreaterThan(0)
        expect(gate).toBeLessThan(load)
        expect(wait).toBeGreaterThan(load)
        expect(wait).toBeLessThan(usb)
    })
})

describe('checkAndSetUndockedApps: one write for all Starting marks (engine#543)', () => {
    const E = 'engine-idea03' as EngineID
    const disk = { id: 'd1', name: 'd1', device: 'sdb1', created: 0, lastDocked: 0, dockedTo: E, diskTypes: ['app'], backupConfig: null }
    const inst = (id: string, status: string) => ({
        id, instanceOf: 'kolibri', name: id, status, statusCondition: 'x', port: 8080, serviceImages: [], created: 0,
        lastBackup: null, lastStarted: 1, storedOn: 'd1', currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
    })
    const make = async (n: number): Promise<DocHandle<Store>> => {
        const instanceDB: Record<string, unknown> = {}
        for (let i = 0; i < n; i++) instanceDB['i' + i] = inst('i' + i, 'Running')
        const h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, appDB: {}, userDB: {}, operationDB: {}, diskDB: { d1: disk } as any, instanceDB: instanceDB as any,
        } as any)
        await h.whenReady()
        return h
    }

    it('8 Running instances with containers → all Starting, written with a single storeHandle.change', async () => {
        const h = await make(8)
        const change = vi.spyOn(h, 'change')
        await checkAndSetUndockedApps(h, E, async () => true, { systemDiskSkip: false })
        expect(change).toHaveBeenCalledTimes(1)
        for (let i = 0; i < 8; i++) {
            expect(String(h.doc().instanceDB[('i' + i) as InstanceID].status)).toBe('Starting')
            expect(h.doc().instanceDB[('i' + i) as InstanceID].statusCondition).toBeNull()
        }
    })

    it('docker not answering → still marked Starting (one write); no containers → Undocked as before; nothing to mark → no write', async () => {
        const h = await make(3)
        const change = vi.spyOn(h, 'change')
        await checkAndSetUndockedApps(h, E, async (id) => { if (id === 'i0') throw new Error('docker down'); return id === 'i1' }, { systemDiskSkip: false })
        const st = (id: string) => String(h.doc().instanceDB[id as InstanceID].status)
        expect(st('i0')).toBe('Starting')     // docker not answering
        expect(st('i1')).toBe('Starting')     // container found
        expect(st('i2')).toBe('Undocked')     // no container (its own write, unchanged)
        expect(change).toHaveBeenCalledTimes(2)   // 1 Undocked + 1 batched Starting

        const h2 = await make(2)
        const c2 = vi.spyOn(h2, 'change')
        await checkAndSetUndockedApps(h2, E, async () => false, { systemDiskSkip: false })
        expect(c2).toHaveBeenCalledTimes(2)       // both Undocked, no Starting batch
    })

    it('the guards still hold inside the batch: an instance that is no longer Running when the batch is written is left alone', async () => {
        const h = await make(2)
        let first = true
        await checkAndSetUndockedApps(h, E, async (id) => {
            if (id === 'i1' && first) { first = false; h.change(d => { d.instanceDB['i0' as InstanceID].status = 'Stopped' as any }) }
            return true
        }, { systemDiskSkip: false })
        const st = (id: string) => String(h.doc().instanceDB[id as InstanceID].status)
        expect(st('i0')).toBe('Stopped')
        expect(st('i1')).toBe('Starting')
    })

    it('the operation-log decisions (shouldAutoStart / userStopInForce) are taken on the snapshot and give the same results: an operator stop in force keeps an instance out of Starting, and a stop with no container → Stopped', async () => {
        const h = await make(3)
        h.change(d => {
            d.operationDB['op-stop-i0' as any] = { id: 'op-stop-i0', kind: 'stopApp', status: 'Done', cause: 'console-command', startedAt: 100, subject: { type: 'instance', id: 'i0' }, args: {} } as any
            d.operationDB['op-stop-i1' as any] = { id: 'op-stop-i1', kind: 'stopApp', status: 'Done', cause: 'console-command', startedAt: 100, subject: { type: 'instance', id: 'i1' }, args: {} } as any
            d.instanceDB['i0' as InstanceID].lastStarted = 50 as any   // stop after the last start: in force
            d.instanceDB['i1' as InstanceID].lastStarted = 50 as any
        })
        // i0: Running, container found, operator stop in force → shouldAutoStart says no → stays Running (not Starting)
        // i1: Running, no container, operator stop in force → Stopped (not Undocked)
        // i2: Running, container found, nothing in force → Starting
        await checkAndSetUndockedApps(h, E, async (id) => id !== 'i1', { systemDiskSkip: false })
        const st = (id: string) => String(h.doc().instanceDB[id as InstanceID].status)
        expect(st('i0')).toBe('Running')
        expect(st('i1')).toBe('Stopped')
        expect(st('i2')).toBe('Starting')
    })
})
