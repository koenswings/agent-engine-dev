/**
 * r32 (cover-all-d398c40-r32 / path-a-ready-r33 IDEA04-WS.md): RealFleetOps WS connection
 * model against a real automerge-repo WebSocketServerAdapter on localhost (fake Engine).
 *
 *  - ONE reused connection per host across probes / reads (like a Console tab);
 *  - close-before-retry: never two sockets to one engine at once, old one closed first;
 *  - unreachable host → "engine X unreachable for Ns" (not a sync timeout / stall);
 *  - slow (8 s) initial sync passes within the per-host doc wait;
 *  - WS up + doc never ready → own-store stall handler (the FATAL path), not "unreachable";
 *  - reconnectEngine (reboot_engine) closes the old socket and opens a fresh one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { Repo, type PeerId } from '@automerge/automerge-repo'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import {
    DEFAULT_DOC_WAIT_MS,
    MAX_DOC_WAIT_MS,
    MIN_DOC_WAIT_MS,
    RealFleetOps,
    StoreSyncStallError,
    TrackedWebSocketClientAdapter,
} from '../duration/realFleetOps.js'
import { resetTimeoutGuard, setGuardIo, timeoutSummary } from '../duration/automergeTimeoutGuard.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface FakeEngine {
    port: number
    docUrl: string
    /** WS connections accepted (any kind). */
    connections: number
    /** Currently open WS connections, and the max ever open at once. */
    openNow: number
    maxOpen: number
    closes: number
    sockets: WebSocket[]
    close(): Promise<void>
}

/**
 * A fake Engine: http server + automerge server Repo holding a store doc.
 * `silentFirst`: the first N connections are accepted but never get the automerge
 * handshake (looks like a stalled Engine) — exercises close-before-retry.
 * `syncDelayMs`: delay every server → client repo message (slow Pi sync).
 */
const startFakeEngine = async (opts: { silentFirst?: number; syncDelayMs?: number } = {}): Promise<FakeEngine> => {
    const server = http.createServer()
    const amWss = new WebSocketServer({ noServer: true })
    const silentWss = new WebSocketServer({ noServer: true })
    const adapter = new WebSocketServerAdapter(amWss as never)
    if (opts.syncDelayMs) {
        const send = adapter.send.bind(adapter)
        // Delay every repo message except the WS handshake reply ('peer'): handshake is
        // fast, the full store sync is slow (as on idea04's Pi 4).
        adapter.send = (m: Parameters<typeof send>[0]) => {
            if ((m as { type?: string }).type === 'peer') return send(m)
            setTimeout(() => { try { send(m) } catch { /* closed */ } }, opts.syncDelayMs)
        }
    }
    const repo = new Repo({ network: [adapter], peerId: `fake-engine-${Date.now()}` as PeerId, sharePolicy: async () => false })
    const handle = repo.create({ engineDB: {}, instanceDB: {}, diskDB: {}, appDB: {}, networkDB: {}, userDB: {} })
    const fe: FakeEngine = {
        port: 0, docUrl: handle.url, connections: 0, openNow: 0, maxOpen: 0, closes: 0, sockets: [],
        close: async () => {
            for (const s of fe.sockets) { try { s.terminate() } catch { /* ignore */ } }
            await repo.shutdown().catch(() => {})
            amWss.close(); silentWss.close()
            await new Promise<void>(r => server.close(() => r()))
        },
    }
    let n = 0
    server.on('upgrade', (req, socket, head) => {
        const silent = n++ < (opts.silentFirst ?? 0)
        const wss = silent ? silentWss : amWss
        wss.handleUpgrade(req, socket, head, ws => {
            fe.connections++; fe.openNow++; fe.maxOpen = Math.max(fe.maxOpen, fe.openNow); fe.sockets.push(ws)
            ws.on('close', () => { fe.openNow--; fe.closes++ })
            wss.emit('connection', ws, req)
        })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    fe.port = (server.address() as net.AddressInfo).port
    return fe
}

const freePort = async (): Promise<number> => {
    const s = net.createServer()
    await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as net.AddressInfo).port
    await new Promise<void>(r => s.close(() => r()))
    return port
}

const makeOps = (port: number, docUrl: string, extra: Partial<ConstructorParameters<typeof RealFleetOps>[0]> = {}) => {
    const stalls: string[] = []
    const ops = new RealFleetOps({
        poolEngines: ['idea01'],
        hosts: { idea01: '127.0.0.1' },
        enginePort: port,
        storeUrls: { idea01: docUrl },
        wsHandshakeTimeoutMs: 2_000,
        docWaitMs: 15_000,
        onOwnStoreStall: (engine, _doc, detail) => { stalls.push(`${engine}: ${detail}`) },
        ...extra,
    })
    return { ops, stalls }
}

const guardLines: string[] = []
const savedEnv = { ...process.env }
beforeEach(() => {
    resetTimeoutGuard()
    guardLines.length = 0
    setGuardIo({ log: l => guardLines.push(l), error: () => {}, exit: code => { throw new Error(`unexpected exit ${code}`) } })
    process.env.DURATION_ENGINE_HTTP_PORT = '1' // own CommandLog lookup fails fast (no HTTP server)
})
afterEach(() => {
    setGuardIo(null)
    process.env = { ...savedEnv }
})

describe('RealFleetOps WS model — fake Engine (r32)', () => {
    it('reuses ONE connection per host across N probes and reads', async () => {
        const fe = await startFakeEngine()
        const { ops, stalls } = makeOps(fe.port, fe.docUrl)
        try {
            for (let i = 0; i < 5; i++) {
                const p = await ops.probeStability(['idea01'])
                expect(p.ok).toBe(true)
                expect(p.engines[0]).toMatchObject({ id: 'idea01', wsUp: true })
                await ops.readStore('idea01')
                expect((await ops.waitReady('idea01', 2_000)).wsUp).toBe(true)
            }
            // concurrent callers share the in-flight / cached connection
            await Promise.all([ops.readStore('idea01'), ops.readStore('idea01'), ops.probeStability(['idea01'])])
            expect(ops.getConnectionCount('idea01')).toBe(1)
            expect(fe.connections).toBe(1)
            expect(fe.maxOpen).toBe(1)
            expect(stalls).toEqual([])
        } finally {
            await ops.close()
            await fe.close()
        }
    })

    it('close-before-retry: a stalled handshake is closed before the next attempt (never 2 sockets at once)', async () => {
        const fe = await startFakeEngine({ silentFirst: 2 })
        const { ops, stalls } = makeOps(fe.port, fe.docUrl, { wsHandshakeTimeoutMs: 1_000 })
        try {
            const ready = await ops.waitReady('idea01', 20_000)
            expect(ready.wsUp).toBe(true)
            expect(fe.connections).toBe(3) // 2 silent attempts + the good one
            expect(fe.maxOpen).toBe(1) // old socket closed before each retry
            expect(fe.closes).toBe(2)
            expect(ops.getConnectionCount('idea01')).toBe(3)
            expect(stalls).toEqual([])
            // Closed adapters never reconnect on their own (no leaked sockets later).
            await sleep(2_500)
            expect(fe.connections).toBe(3)
            expect(fe.openNow).toBe(1)
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 40_000)

    it('unreachable host → "engine X unreachable for Ns" result, not a sync timeout or stall', async () => {
        const port = await freePort()
        const { ops, stalls } = makeOps(port, 'automerge:3zoqdSVsEtj4ygNJPNcDyKWvdxo6', { wsHandshakeTimeoutMs: 1_000 })
        try {
            const p = await ops.probeStability(['idea01'])
            expect(p.ok).toBe(false)
            expect(p.engines[0]).toMatchObject({ id: 'idea01', wsUp: false })
            expect(p.detail).toMatch(new RegExp(`idea01: WS down — engine idea01 unreachable for \\d+s \\(WS ws://127\\.0\\.0\\.1:${port}, last error `))
            const pf = await ops.preflightEngines(2_500)
            expect(pf.ok).toBe(false)
            expect(pf.engines[0]!.message).toMatch(/^engine idea01 unreachable for \d+s/)
            expect(stalls).toEqual([])
            const events = guardLines.map(l => JSON.parse(l) as { event: string })
            expect(events.some(e => e.event === 'engine_unreachable')).toBe(true)
            expect(events.some(e => e.event === 'automerge_find_timeout_own_store_fatal')).toBe(false)
            expect(timeoutSummary()).toMatchObject({ total: 0, byClass: { own: 0 } })
        } finally {
            await ops.close()
        }
    }, 30_000)

    it('a slow (8 s) initial sync passes within the doc wait (no WS-down, no stall)', async () => {
        const fe = await startFakeEngine({ syncDelayMs: 8_000 })
        const { ops, stalls } = makeOps(fe.port, fe.docUrl, { docWaitMs: undefined })
        try {
            const t0 = Date.now()
            const p = await ops.probeStability(['idea01'])
            expect(Date.now() - t0).toBeGreaterThanOrEqual(7_500)
            expect(p.ok).toBe(true)
            expect(p.engines[0]).toMatchObject({ wsUp: true })
            expect(ops.getConnectionCount('idea01')).toBe(1)
            expect(fe.connections).toBe(1)
            expect(stalls).toEqual([])
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 40_000)

    it('WS up but the store never becomes ready → own-store stall handler (FATAL path), distinct from unreachable', async () => {
        const fe = await startFakeEngine({ syncDelayMs: 60_000 })
        const { ops, stalls } = makeOps(fe.port, fe.docUrl, { docWaitMs: 1_500 })
        try {
            await expect(ops.readStore('idea01')).rejects.toBeInstanceOf(StoreSyncStallError)
            expect(stalls).toHaveLength(1)
            expect(stalls[0]).toMatch(/^idea01: store .* not ready \d+s after connect \(doc wait 1500ms, WS open/)
            expect(guardLines.map(l => JSON.parse(l).event)).not.toContain('engine_unreachable')
            expect(fe.openNow).toBe(0) // the stalled connection was closed
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 30_000)

    it('reconnectEngine (reboot_engine) closes the old socket and opens a fresh one', async () => {
        const fe = await startFakeEngine()
        const { ops } = makeOps(fe.port, fe.docUrl)
        try {
            expect((await ops.waitReady('idea01', 5_000)).wsUp).toBe(true)
            const first = fe.sockets[0]!
            const r = await ops.reconnectEngine('idea01', 10_000)
            expect(r.wsUp).toBe(true)
            expect(first.readyState).toBe(first.CLOSED)
            expect(fe.connections).toBe(2)
            expect(fe.maxOpen).toBe(1)
            expect(fe.openNow).toBe(1)
            expect(ops.getConnectionCount('idea01')).toBe(2)
            // subsequent probes reuse the fresh connection
            await ops.probeStability(['idea01'])
            expect(fe.connections).toBe(2)
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 30_000)

    it('a stall inside the reboot window (reconnectEngine) is retried, not the own-store FATAL', async () => {
        const fe = await startFakeEngine({ syncDelayMs: 60_000 })
        const { ops, stalls } = makeOps(fe.port, fe.docUrl, { docWaitMs: 1_000 })
        try {
            const r = await ops.reconnectEngine('idea01', 3_000)
            expect(r.wsUp).toBe(false)
            expect(stalls).toEqual([])
            expect(fe.maxOpen).toBe(1)
            expect(fe.openNow).toBe(0)
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 30_000)

    it('a dropped socket is re-established by the SAME connection (no new Repo)', async () => {
        const fe = await startFakeEngine()
        const { ops } = makeOps(fe.port, fe.docUrl)
        try {
            expect((await ops.waitReady('idea01', 5_000)).wsUp).toBe(true)
            fe.sockets[0]!.terminate() // real disconnect
            await sleep(200)
            expect(ops.isWsOpen('idea01')).toBe(false)
            const r = await ops.waitReady('idea01', 3_000)
            expect(r.wsUp).toBe(true)
            expect(ops.getConnectionCount('idea01')).toBe(1) // adapter reconnected itself
            expect(fe.connections).toBe(2)
            expect(fe.openNow).toBe(1)
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 30_000)
})

describe('RealFleetOps doc wait config (r32)', () => {
    const ops = () => new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: 'a', idea03: 'b', idea04: 'c' } })
    it('defaults: 15 s, idea04 (Pi 4) 30 s', () => {
        delete process.env.DURATION_DOC_WAIT_MS; delete process.env.DURATION_DOC_WAIT_MS_BY_HOST; delete process.env.DURATION_DOC_WAIT_MS_IDEA04
        expect(DEFAULT_DOC_WAIT_MS).toBeGreaterThanOrEqual(15_000)
        expect(ops().docWaitMsFor('idea01')).toBe(15_000)
        expect(ops().docWaitMsFor('idea04')).toBe(30_000)
    })
    it('env overrides: global, by-host map, per-host var; floored at 15 s and capped below automerge 60 s', () => {
        process.env.DURATION_DOC_WAIT_MS = '20000'
        expect(ops().docWaitMsFor('idea01')).toBe(20_000)
        expect(ops().docWaitMsFor('idea04')).toBe(30_000) // host default beats the global value
        process.env.DURATION_DOC_WAIT_MS_BY_HOST = 'idea04=25000, idea03=5000'
        expect(ops().docWaitMsFor('idea04')).toBe(25_000)
        expect(ops().docWaitMsFor('idea03')).toBe(MIN_DOC_WAIT_MS)
        process.env.DURATION_DOC_WAIT_MS_IDEA04 = '120000'
        expect(ops().docWaitMsFor('idea04')).toBe(MAX_DOC_WAIT_MS)
    })
    it('TrackedWebSocketClientAdapter never connects again after disconnect()', () => {
        const a = new TrackedWebSocketClientAdapter('ws://127.0.0.1:1', 2000, 'idea01')
        a.disconnect()
        a.connect('p' as PeerId)
        expect(a.socket).toBeUndefined()
    })
})
