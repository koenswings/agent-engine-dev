/**
 * sync-outdated-doc.test.ts (engine#512): the Automerge "outdated document" exit.
 *
 * idea04 11-17 16:54:30: the #168 watchdog dropped two healthy peer links after a 65 s
 * startup stall; a peer's sync reply then hit the CLOSING socket, the stock client
 * adapter THREW "Websocket not ready (2)" inside DocHandle.update(), the store handle
 * kept the outdated pre-receive doc, and the next store write (writeLastSeen) killed
 * startup. Covered here, one block per part of the fix:
 *   1. StoreScopedWebSocketClientAdapter.send() drops instead of throwing, and a Repo
 *      whose socket closes mid-sync keeps a writable, up-to-date doc.
 *   2. WsLiveness does not count our own event-loop stall as the peer's silence (fake
 *      clock and a real ws link with the main thread blocked); the loop-stall monitor
 *      names the stall.
 *   3. StaleDocGuard: a stale STORE doc exits cleanly with code 75 (also in a real child
 *      process); any other stale doc is evicted and resyncs; a held doc is only logged.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Repo, DocHandle, Message, PeerId, cbor } from '@automerge/automerge-repo'
import { StoreScopedWebSocketClientAdapter } from '../../src/data/StoreScopedClientAdapter.js'
import { WsLiveness } from '../../src/data/WsLiveness.js'
import { storeTag, enginePeerId } from '../../src/data/StoreScope.js'
import { startLoopStallMonitor } from '../../src/monitors/loopStallMonitor.js'
import {
    installStaleDocGuard, isDocOutdated, isHandleStale, isOutdatedDocError,
    staleStoreExit, resetStaleStoreExit, STALE_STORE_EXIT_CODE, StaleDocGuard,
} from '../../src/data/StaleDocGuard.js'
import { PairAdapter, link, pump } from '../harness/pairAdapter.js'
import { armStaleStoreTestHook, TEST_STALE_STORE_ENV, TEST_STALE_STORE_DELAY_ENV } from '../../src/data/StaleStoreTestHook.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean, ms: number) => {
    const t0 = Date.now()
    while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(10) }
    return true
}
const STORE_ID = '2VroEUvDkmYsDAwE5oG9YeFNadWH'
const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* block the loop */ } }

// ── 1. send() never throws ─────────────────────────────────────────────────────

/** The production adapter without a real dial: the test plays the socket. */
class TestClientAdapter extends StoreScopedWebSocketClientAdapter {
    override connect(peerId: PeerId): void { this.peerId = peerId }
}
const fakeSocket = (readyState: number) => {
    const sent: Message[] = []
    return { readyState, sent, send(b: ArrayBuffer) { sent.push(cbor.decode(new Uint8Array(b)) as Message) }, close() {}, addEventListener() {}, removeEventListener() {} }
}
const admitted = (socket: ReturnType<typeof fakeSocket>) => {
    const a = new TestClientAdapter('ws://127.0.0.2:4321', { ownTag: storeTag(STORE_ID), onRefused: () => {}, retryInterval: 600_000, pingMs: 1e9, deadMs: 1e9 })
    a.peerId = enginePeerId(STORE_ID, 'ENGINE_B') as PeerId
    ;(a as any).socket = socket
    a.peerCandidate(enginePeerId(STORE_ID, 'ENGINE_A') as PeerId, {})
    expect(a.admitted).toBe(true)
    return a
}
const syncMsg = (a: StoreScopedWebSocketClientAdapter) => ({ type: 'sync', senderId: a.peerId, targetId: 'idea-engine/x/ENGINE_A/1', documentId: 'doc1', data: new Uint8Array([1, 2, 3]) }) as unknown as Message

describe('engine#512 part 1: StoreScopedWebSocketClientAdapter.send drops instead of throwing', () => {
    for (const state of [0, 2, 3]) {
        it(`readyState ${state}: no throw, nothing written, counted`, () => {
            const s = fakeSocket(state)
            const a = admitted(s)
            expect(() => { a.send(syncMsg(a)); a.send(syncMsg(a)) }).not.toThrow()
            expect(s.sent).toHaveLength(0)
            expect(a.droppedSends).toBe(2)
        })
    }
    it('OPEN: sent as before', () => {
        const s = fakeSocket(1)
        const a = admitted(s)
        a.send(syncMsg(a))
        expect(s.sent).toHaveLength(1)
        expect(a.droppedSends).toBe(0)
    })
    it('a send that throws for any other reason is dropped too (zero-length data)', () => {
        const s = fakeSocket(1)
        const a = admitted(s)
        const m = { ...syncMsg(a), data: new Uint8Array(0) } as unknown as Message
        expect(() => a.send(m)).not.toThrow()
        expect(a.droppedSends).toBe(1)
    })
    it('the library adapter itself still throws (why the override exists)', async () => {
        const { WebSocketClientAdapter } = await import('@automerge/automerge-repo-network-websocket')
        const a = new WebSocketClientAdapter('ws://127.0.0.1:1', 600_000)
        Object.assign(a, { peerId: 'me', socket: { readyState: 2, send: () => {} } })
        expect(() => a.send(syncMsg(a as any))).toThrow(/Websocket not ready \(2\)/)
    })

    it('Repo: the socket closes while a sync that applies changes arrives → the doc stays writable and current', async () => {
        // A: plain in-memory peer. B: the production client adapter on a socket the test controls.
        const pa = new PairAdapter()
        const peerA = enginePeerId(STORE_ID, 'ENGINE_A') as PeerId, peerB = enginePeerId(STORE_ID, 'ENGINE_B') as PeerId
        const repoA = new Repo({ network: [pa], peerId: peerA })
        const socket = fakeSocket(1)
        const ab = new TestClientAdapter('ws://127.0.0.2:4321', { ownTag: storeTag(STORE_ID), onRefused: () => {}, retryInterval: 600_000, pingMs: 1e9, deadMs: 1e9 })
        const repoB = new Repo({ network: [ab], peerId: peerB })
        ;(ab as any).socket = socket
        ab.peerCandidate(peerA, {})
        pa.announce(peerB)
        const moveAll = async (rounds = 2000) => {
            let quiet = 0
            for (let i = 0; i < rounds && quiet < 50; i++) {
                await sleep(5)
                const toB = pa.out.splice(0), toA = socket.sent.splice(0)
                if (!toB.length && !toA.length) { quiet++; continue }
                quiet = 0
                for (const m of toB) ab.receiveMessage(cbor.encode(m))
                for (const m of toA) pa.deliver(m)
            }
        }
        const hA = repoA.create<{ n: number, log: string[] }>({ n: 0, log: [] })
        const found = repoB.find<{ n: number, log: string[] }>(hA.url)
        await moveAll()
        const hB = await found
        expect(hB.doc().n).toBe(0)

        // The watchdog just dropped the socket (CLOSING) while A's change is on its way in.
        socket.readyState = 2
        hA.change(d => { d.n = 1; d.log.push('from A') })
        await moveAll()
        expect(ab.droppedSends).toBeGreaterThan(0)        // B's reply was dropped, not thrown
        expect(isHandleStale(hB)).toBe(false)
        expect(hB.doc().n).toBe(1)                         // the change applied and the handle kept it
        expect(() => hB.change(d => { d.log.push('from B') })).not.toThrow()

        // Reconnect: everything converges.
        socket.readyState = 1
        hA.change(d => { d.n = 2 })
        await moveAll()
        expect(hB.doc().n).toBe(2)
        expect(hA.doc().log).toEqual(['from A', 'from B'])
        await repoA.shutdown().catch(() => {}); await repoB.shutdown().catch(() => {})
    })
})

// ── 2. startup stalls do not drop healthy links ─────────────────────────────────

describe('engine#512 part 2: WsLiveness does not count our own event-loop stall as silence', () => {
    const sock = () => { const s: any = { readyState: 1, pings: 0, killed: 0, ping() { s.pings++ }, terminate() { s.killed++ }, close() {} }; return s }
    it('a 65 s stall (one late tick) does not drop the link; it pings instead', () => {
        let t = 0
        const s = sock(); let dead = 0
        const w = new WsLiveness({ pingMs: 5_000, deadMs: 15_000, label: 't', now: () => t, onDead: () => dead++ })
        w.attach(s)
        t = 5_000; w.tick()                       // normal tick, peer answered last at 0
        t = 70_000; w.tick()                      // loop resumes after 65 s: the timer runs before the socket is read
        expect(s.killed).toBe(0); expect(dead).toBe(0); expect(w.stalls).toBe(1)
        expect(w.lastHeardAgeMs).toBeLessThan(15_000)
        w.detach()
    })
    it('a really silent peer is still dropped once deadMs of normal running passed', () => {
        let t = 0
        const s = sock(); let dead = 0
        const w = new WsLiveness({ pingMs: 5_000, deadMs: 15_000, label: 't', now: () => t, onDead: () => dead++ })
        w.attach(s)
        t = 5_000; w.tick()
        t = 70_000; w.tick()                      // stall credited
        for (t = 75_000; t <= 90_000 && !s.killed; t += 5_000) w.tick()
        expect(s.killed).toBe(1); expect(dead).toBe(1)
        expect(t).toBeLessThanOrEqual(90_000)     // 15 s of normal running after the stall (+ the one ping interval)
        w.detach()
    })
    it('without a stall the #168 rule is unchanged', () => {
        let t = 0
        const s = sock()
        const w = new WsLiveness({ pingMs: 5_000, deadMs: 15_000, label: 't', now: () => t })
        w.attach(s)
        for (t = 5_000; t <= 15_000; t += 5_000) w.tick()
        expect(s.killed).toBe(1); expect(w.stalls).toBe(0)
        w.detach()
    })

    let wss: WebSocketServer | undefined
    let a: StoreScopedWebSocketClientAdapter | undefined
    afterEach(async () => {
        try { a?.disconnect() } catch { /* */ }
        for (const c of wss?.clients ?? []) c.terminate()
        await new Promise<void>(r => wss ? wss.close(() => r()) : r())
        wss = undefined; a = undefined
    })
    it('real ws: blocking the main thread 4x deadMs does not drop a live link', async () => {
        wss = new WebSocketServer({ port: 0, autoPong: true } as any)
        await new Promise(r => wss!.once('listening', r))
        let conns = 0
        wss.on('connection', () => { conns++ })
        const port = (wss.address() as any).port
        a = new StoreScopedWebSocketClientAdapter(`ws://127.0.0.1:${port}`, { ownTag: 't', onRefused: () => {}, retryInterval: 100, pingMs: 50, deadMs: 300 })
        a.connect('client-1' as any, {} as any)
        expect(await until(() => conns >= 1 && (a as any).socket?.readyState === 1, 3000)).toBe(true)
        await sleep(200)
        busy(1_200)                               // the startup stall: no timer, no socket read
        await sleep(400)
        expect(a.forcedReconnects).toBe(0)
        expect(conns).toBe(1)
    })
    it('the loop-stall monitor names a blocked loop and the log line around it', () => {
        let t = 0; let line = 'STARTING HEARTBEAT GENERATION'
        const lines: string[] = []
        const m = startLoopStallMonitor({ intervalMs: 500, thresholdMs: 2_000, now: () => t, lastLine: () => line, report: l => lines.push(l) })
        t = 500; expect(m.tick()).toBe(0)
        line = 'Processing disk duration-empty-003'
        t = 60_500; expect(m.tick()).toBe(59_500)
        m.stop()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/\[loop-stall\] event loop blocked ~59500 ms .*STARTING HEARTBEAT GENERATION.*Processing disk duration-empty-003/)
        expect(m.stalls).toBe(1); expect(m.maxStallMs).toBe(59_500)
    })
})

// ── 3. a stale doc never leaves a half-alive Engine ─────────────────────────────

/** Two Repos; B's adapter throws on send while A's change arrives: B's handle is poisoned. */
const poisonedPair = async () => {
    const pa = new PairAdapter(), pb = new PairAdapter()
    const repoA = new Repo({ network: [pa], peerId: 'a' as PeerId })
    const repoB = new Repo({ network: [pb], peerId: 'b' as PeerId })
    await link(pa, pb)
    const hA = repoA.create<{ n: number }>({ n: 0 })
    const found = repoB.find<{ n: number }>(hA.url)
    await pump(pa, pb)
    const hB = await found
    pb.broken = true
    hA.change(d => { d.n = 1 })
    await pump(pa, pb)
    pb.broken = false
    return { pa, pb, repoA, repoB, hA, hB }
}

describe('engine#512 part 3: stale doc guard', () => {
    afterEach(() => resetStaleStoreExit())
    const guards: StaleDocGuard[] = []
    afterEach(() => { for (const g of guards.splice(0)) g.stop() })

    it('mechanism (automerge-repo 2.3.1): a throwing reply-send inside handle.update leaves the handle outdated', async () => {
        const { pb, hB, repoA, repoB } = await poisonedPair()
        expect(pb.sendThrows).toBeGreaterThan(0)
        expect(isHandleStale(hB)).toBe(true)
        expect(isDocOutdated(hB.doc())).toBe(true)
        let thrown: unknown
        try { hB.change(d => { d.n = 5 }) } catch (e) { thrown = e }
        expect(isOutdatedDocError(thrown)).toBe(true)
        await repoA.shutdown().catch(() => {}); await repoB.shutdown().catch(() => {})
    })

    it('store doc stale → onStaleStore once (receive path, local write and sweep all lead there)', async () => {
        const { pa, pb, repoA, repoB, hA, hB } = await poisonedPair()
        const reasons: string[] = []
        const g = installStaleDocGuard(repoB, { storeDocId: hB.documentId, onStaleStore: r => reasons.push(r), sweepMs: 0 })
        guards.push(g)
        g.watchStoreHandle(hB)
        // the next sync from the peer fails on the outdated doc → fatal path
        hA.change(d => { d.n = 2 })
        await pump(pa, pb)
        expect(reasons).toHaveLength(1)
        expect(reasons[0]).toMatch(new RegExp(`doc ${hB.documentId}, receiving a sync message from a`))
        // a local write (writeLastSeen) also reports it; still one call in total
        expect(() => hB.change(d => { d.n = 9 })).toThrow(/outdated document/)
        g.sweep()
        expect(reasons).toHaveLength(1)
        expect(g.stats.staleStore).toBe(1)
        await repoA.shutdown().catch(() => {}); await repoB.shutdown().catch(() => {})
    })

    it('store doc stale on a local write first (the 16:54:30 startup path) → onStaleStore', async () => {
        const { repoA, repoB, hB } = await poisonedPair()
        const reasons: string[] = []
        const g = installStaleDocGuard(repoB, { storeDocId: `automerge:${hB.documentId}`, onStaleStore: r => reasons.push(r), sweepMs: 0 })
        guards.push(g)
        g.watchStoreHandle(hB)
        expect(() => hB.change(d => { d.n = 9 })).toThrow(/outdated document/)
        expect(reasons).toHaveLength(1)
        expect(reasons[0]).toMatch(/a local write to the store: Attempting to change an outdated document/)
        await repoA.shutdown().catch(() => {}); await repoB.shutdown().catch(() => {})
    })

    it('a healthy store doc never triggers it', async () => {
        const pa = new PairAdapter(), pb = new PairAdapter()
        const repoA = new Repo({ network: [pa], peerId: 'a' as PeerId })
        const repoB = new Repo({ network: [pb], peerId: 'b' as PeerId })
        await link(pa, pb)
        const hA = repoA.create<{ n: number }>({ n: 0 })
        const found = repoB.find<{ n: number }>(hA.url)
        await pump(pa, pb)
        const hB = await found
        const reasons: string[] = []
        const g = installStaleDocGuard(repoB, { storeDocId: hB.documentId, onStaleStore: r => reasons.push(r), sweepMs: 0 })
        guards.push(g); g.watchStoreHandle(hB)
        hA.change(d => { d.n = 1 }); hB.change(d => { d.n = 2 })
        await pump(pa, pb)
        g.sweep()
        expect(reasons).toHaveLength(0)
        expect(hA.doc().n).toBe(hB.doc().n)
        await repoA.shutdown().catch(() => {}); await repoB.shutdown().catch(() => {})
    })

    it('another doc stale → evicted, reloaded on the next message and resynced; the store is untouched', async () => {
        const { pa, pb, repoA, repoB, hA, hB } = await poisonedPair()
        const reasons: string[] = []
        const g = installStaleDocGuard(repoB, { storeDocId: STORE_ID, onStaleStore: r => reasons.push(r), sweepMs: 0 })
        guards.push(g)
        g.sweep()
        expect(await until(() => g.stats.evicted === 1, 3000)).toBe(true)
        expect(repoB.handles[hB.documentId]).toBeUndefined()
        hA.change(d => { d.n = 3 })
        await pump(pa, pb)
        const again = await repoB.find<{ n: number }>(hA.url)
        await pump(pa, pb)
        expect(again).not.toBe(hB)
        expect(isHandleStale(again)).toBe(false)
        expect(again.doc().n).toBe(3)
        again.change(d => { d.n = 4 })
        await pump(pa, pb)
        expect(hA.doc().n).toBe(4)
        expect(reasons).toHaveLength(0)
        await repoA.shutdown().catch(() => {}); await repoB.shutdown().catch(() => {})
    })

    it('a stale doc the Engine holds (its own command log) is logged, not evicted', async () => {
        const { repoA, repoB, hB } = await poisonedPair()
        const g = installStaleDocGuard(repoB, { storeDocId: STORE_ID, onStaleStore: () => {}, isPinned: id => id === hB.documentId, sweepMs: 0 })
        guards.push(g)
        g.sweep(); g.sweep()
        await sleep(50)
        expect(repoB.handles[hB.documentId]).toBe(hB)
        expect(g.stats.pinned).toBe(2); expect(g.stats.evicted).toBe(0)
        await repoA.shutdown().catch(() => {}); await repoB.shutdown().catch(() => {})
    })

    it('staleStoreExit: clean shutdown first, then exit(75); idempotent', async () => {
        const order: string[] = []
        const p = staleStoreExit('test', { shutdown: async () => { order.push('shutdown') }, exit: c => order.push(`exit ${c}`) })
        await staleStoreExit('second', { exit: c => order.push(`second exit ${c}`) })
        await p
        expect(order).toEqual(['shutdown', `exit ${STALE_STORE_EXIT_CODE}`])
    })
    it('staleStoreExit: a hanging shutdown still exits(75) after the timeout', async () => {
        const codes: number[] = []
        await staleStoreExit('test', { shutdown: () => new Promise(() => {}), exit: c => codes.push(c), timeoutMs: 100 })
        expect(codes).toEqual([75])
    })

    it('real process: a stale store doc ends the process with code 75 (what pm2 restarts on)', () => {
        const child = path.join(path.dirname(fileURLToPath(import.meta.url)), '../harness/staleStoreChild.js')
        const r = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 60_000 })
        expect(r.stderr + r.stdout).toMatch(/\[stale-store\] FATAL: the main store doc is outdated/)
        expect(r.stdout).toContain('shutdown ran')
        expect(r.status).toBe(STALE_STORE_EXIT_CODE)
    }, 70_000)
})

// ── the one-shot Pi-proof hook ──────────────────────────────────────────────────

describe('engine#512: stale-store test hook (Pi proof switch)', () => {
    afterEach(() => resetStaleStoreExit())
    it('not armed without the env var, or when the marker file is missing', async () => {
        const repo = new Repo({ network: [] })
        const h = repo.create<{ n: number }>({ n: 0 })
        expect(armStaleStoreTestHook(h, () => {}, {})).toBeNull()
        expect(armStaleStoreTestHook(h, () => {}, { [TEST_STALE_STORE_ENV]: path.join(os.tmpdir(), `nope-${Date.now()}`) })).toBeNull()
        await repo.shutdown().catch(() => {})
    })
    it('fires once: consumes the marker, marks the store outdated, the write hits the guard → exit 75 path', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-512-hook-'))
        const marker = path.join(dir, 'stale-once')
        fs.writeFileSync(marker, '')
        const repo = new Repo({ network: [] })
        const h = repo.create<{ n: number }>({ n: 0 })
        const reasons: string[] = []
        const g = installStaleDocGuard(repo, { storeDocId: h.documentId, onStaleStore: r => reasons.push(r), sweepMs: 0 })
        g.watchStoreHandle(h)
        expect(armStaleStoreTestHook(h, () => { h.change(d => { d.n = 1 }) }, { [TEST_STALE_STORE_ENV]: marker, [TEST_STALE_STORE_DELAY_ENV]: '10' })).toBe(marker)
        expect(await until(() => reasons.length === 1, 3000)).toBe(true)
        expect(reasons[0]).toMatch(/a local write to the store: Attempting to change an outdated document/)
        expect(fs.existsSync(marker)).toBe(false)
        expect(fs.existsSync(`${marker}.fired`)).toBe(true)
        // a restart with the env still set does not fire again
        expect(armStaleStoreTestHook(h, () => {}, { [TEST_STALE_STORE_ENV]: marker })).toBeNull()
        g.stop()
        fs.rmSync(dir, { recursive: true, force: true })
        await repo.shutdown().catch(() => {})
    })
})
