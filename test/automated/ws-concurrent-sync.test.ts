/**
 * ws-concurrent-sync.test.ts — store sync over the Engine's WS server under slow/crowded conditions (IDEA04-WS, r33).
 *
 * Fleet symptoms on d398c40 (IDEA04-WS.md, cover-all-d398c40-r33):
 *   - a classroom of fresh peers connecting at once: 6 concurrent -> 0/6 ready;
 *   - ONE client to idea04 (Pi 4) over the box's DERP link: 4 handshakes,
 *     4 closes, 3 WS drops, 'handle unavailable', never ready in 40 s.
 *
 * The server under test is the Engine's own startAutomergeServer() (src/repo.ts),
 * with a synthetic store doc comparable to production 3zoqd
 * (test/harness/largeStoreDoc.ts: ~96k changes, ~360 KB saved, ~0.6 MB full
 * sync on the wire) loaded from NodeFS storage like the Engine does at boot.
 * Clients are fresh Repos (no storage), each in its own worker thread (own
 * event loop, like a separate device), booted before the measurement starts.
 *
 * 1. Slow host, ONE client: the client reaches the server through a throttled
 *    link (test/harness/throttledProxy.ts, 40 KB/s down, so the full sync takes
 *    ~15 s on the wire), and every message the server receives costs it
 *    SLOW_HOST_STALL_MS of synchronous main-thread work (a Pi 4 needs seconds
 *    for a full sync of the real doc). Must be ready within SLOW_BUDGET_MS with
 *    ZERO WS drops.
 *    d398c40: the 5 s keepalive's ping is queued behind the full-sync message,
 *    the pong cannot come back in time, the server terminates the socket, the
 *    client reconnects and the full sync restarts: never ready, drops > 0.
 * 2. Link drop in the middle of the sync: the first connection is cut after
 *    200 KB of the sync. The client reconnects on its own and must still get
 *    the doc ready (its handle goes 'unavailable' while it has no peer: that is
 *    automerge-repo client behaviour, so this client keeps waiting instead of
 *    failing on the first 'unavailable' like a plain find() would).
 * 3. CLIENTS (10) fresh clients at the same instant, direct (no proxy). All must
 *    be ready within READY_BUDGET_MS.
 *    d398c40: the server's main thread syncs them back to back; meanwhile it
 *    neither accepts sockets nor answers joins, and a client that has no
 *    'peer' reply 1 s after connecting declares the doc unavailable: 3-5/10.
 *
 * Budgets: one fresh client needs ~2 s here, 10 at once ~5-6 s, the slow
 * single-client case ~15-20 s. The budgets are 2-4x that; the bug does not make
 * clients slow, it makes them fail (unavailable / dropped and never ready), so
 * a generous budget still catches it. Per-client timings and the server's
 * event-loop delay are printed for diagnosis.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import path from 'path'
import net from 'net'
import { fs } from 'zx'
import { Worker } from 'worker_threads'
import { monitorEventLoopDelay } from 'perf_hooks'
import { Repo, DocumentId, generateAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { startAutomergeServer } from '../../src/repo.js'
import { PortNumber } from '../../src/data/CommonTypes.js'
import { largeStoreDoc } from '../harness/largeStoreDoc.js'
import { startThrottledProxy } from '../harness/throttledProxy.js'
import type { WsSyncClientInput, WsSyncClientResult } from '../harness/wsSyncClientWorker.js'

const CLIENTS = Number(process.env.WSCONC_CLIENTS ?? 10)
const HEARTBEATS = process.env.WSCONC_HEARTBEATS ? Number(process.env.WSCONC_HEARTBEATS) : undefined
const READY_BUDGET_MS = Number(process.env.WSCONC_BUDGET_MS ?? 30_000)
const SLOW_BUDGET_MS = 60_000
const SLOW_LINK_BYTES_PER_SEC = 40 * 1024
const SLOW_HOST_STALL_MS = 1_500
const DROP_AFTER_BYTES = 200 * 1024
// Clients retry like the Console/walker clients do (WebSocketClientAdapter retry 2 s).
const CLIENT_RETRY_MS = 2_000

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})

/** Wait until something accepts TCP connections on the port (the server may listen asynchronously). */
const waitListening = async (port: number, timeoutMs = 10_000): Promise<void> => {
    const until = Date.now() + timeoutMs
    for (;;) {
        const ok = await new Promise<boolean>(r => {
            const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true) })
            s.once('error', () => r(false))
        })
        if (ok) return
        if (Date.now() > until) throw new Error(`nothing listening on ${port} after ${timeoutMs} ms`)
        await new Promise(r => setTimeout(r, 50))
    }
}

interface ClientWorker { result: Promise<WsSyncClientResult>, go: () => void }

/** Start a client worker; resolves once it is booted (modules + wasm loaded) and waiting for go(). */
const startClient = (input: WsSyncClientInput): Promise<ClientWorker> => new Promise((resolveBooted) => {
    const w = new Worker(new URL('../harness/wsSyncClientWorker.js', import.meta.url), { workerData: input })
    let settle!: (r: WsSyncClientResult) => void
    const result = new Promise<WsSyncClientResult>(r => { let done = false; settle = (x) => { if (!done) { done = true; r(x) } } })
    const fail = (state: string, error?: string) => settle({ index: input.index, ok: false, elapsedMs: -1, state, error, peerConnects: 0, peerDisconnects: 0 })
    const handle: ClientWorker = { result, go: () => w.postMessage({ type: 'go' }) }
    w.on('message', (m: any) => { if (m?.type === 'ready') resolveBooted(handle); else settle(m as WsSyncClientResult) })
    w.once('error', (e) => { fail('worker-error', String(e)); resolveBooted(handle) })
    w.once('exit', (code) => { fail(`worker-exit-${code}`); resolveBooted(handle) })
})

/** Busy-wait: synchronous main-thread work, like a slow CPU doing Automerge sync. */
const burn = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }

describe('Automerge WS server: slow and crowded store sync (IDEA04-WS)', () => {
    let dataDir: string
    let repo: Repo
    let port: number
    let docId: DocumentId
    let docBytes = 0

    beforeAll(async () => {
        const bin = largeStoreDoc(HEARTBEATS ? { heartbeats: HEARTBEATS } : {})
        docBytes = bin.byteLength
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-wsconc-'))
        docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
        // Seed the Engine's storage folder with the doc, then boot the server from it
        // exactly as start.ts does (startAutomergeServer + find + whenReady).
        const seed = new Repo({ network: [], storage: new NodeFSStorageAdapter(dataDir) })
        seed.import(bin, { docId })
        await seed.flush()
        port = await freePort()
        repo = await startAutomergeServer(dataDir, port as PortNumber)
        const handle = await repo.find(docId)
        await handle.whenReady()
        await waitListening(port)
    }, 180_000)

    afterAll(async () => {
        const adapter: any = repo?.networkSubsystem.adapters[0]
        if (typeof adapter?.close === 'function') await adapter.close()              // threaded server (fix)
        else await new Promise<void>(r => adapter?.server ? adapter.server.close(() => r()) : r()) // stock adapter
        if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
    })

    it('slow host + slow link: ONE client gets the store ready with zero WS drops', async () => {
        const proxy = await startThrottledProxy({ targetPort: port, downBytesPerSec: SLOW_LINK_BYTES_PER_SEC })
        const stall = (msg: any) => { if (msg?.documentId === docId && msg?.type !== 'ephemeral') burn(SLOW_HOST_STALL_MS) }
        repo.networkSubsystem.on('message', stall)
        try {
            const client = await startClient({ url: `ws://127.0.0.1:${proxy.port}`, docId, index: 0, timeoutMs: SLOW_BUDGET_MS, retryIntervalMs: CLIENT_RETRY_MS })
            client.go()
            const r = await client.result
            console.log(`ws-slow-single: ${JSON.stringify({ docBytes, ...r, proxyConnections: proxy.connections, linkBytesPerSec: SLOW_LINK_BYTES_PER_SEC, stallMs: SLOW_HOST_STALL_MS })}`)
            expect(r.peerDisconnects, 'WS drops during the sync').toBe(0)
            expect(proxy.connections, 'TCP connections (1 = no reconnect)').toBe(1)
            expect(r.ok, `client not ready: ${r.state} ${r.error ?? ''}`).toBe(true)
            // The link really was slow: this is a >= 10 s sync, not a fast one.
            expect(r.elapsedMs).toBeGreaterThanOrEqual(10_000)
        } finally {
            repo.networkSubsystem.off('message', stall)
            await proxy.close()
        }
    }, SLOW_BUDGET_MS + 30_000)

    it('link drop in the middle of the sync: the client reconnects and converges', async () => {
        const proxy = await startThrottledProxy({ targetPort: port, downBytesPerSec: 4 * 1024 * 1024, dropAfterDownBytes: DROP_AFTER_BYTES })
        try {
            const client = await startClient({ url: `ws://127.0.0.1:${proxy.port}`, docId, index: 0, timeoutMs: READY_BUDGET_MS, retryIntervalMs: CLIENT_RETRY_MS, tolerateUnavailable: true })
            client.go()
            const r = await client.result
            console.log(`ws-reconnect: ${JSON.stringify({ ...r, proxyConnections: proxy.connections, proxyDrops: proxy.drops })}`)
            expect(proxy.drops, 'the forced mid-sync drop happened').toBe(1)
            expect(proxy.connections, 'the client reconnected').toBeGreaterThanOrEqual(2)
            expect(r.ok, `client not ready after reconnect: ${r.state} ${r.error ?? ''}`).toBe(true)
        } finally {
            await proxy.close()
        }
    }, READY_BUDGET_MS + 30_000)

    it(`${CLIENTS} simultaneous fresh clients all get the store doc ready`, async () => {
        const clients = await Promise.all(Array.from({ length: CLIENTS }, (_, index) => startClient({
            url: `ws://127.0.0.1:${port}`, docId, index, timeoutMs: READY_BUDGET_MS, retryIntervalMs: CLIENT_RETRY_MS,
        })))
        const lag = monitorEventLoopDelay({ resolution: 10 })
        lag.enable()
        const t0 = performance.now()
        clients.forEach(c => c.go())
        const results = await Promise.all(clients.map(c => c.result))
        const wallMs = Math.round(performance.now() - t0)
        lag.disable()
        const ready = results.filter(r => r.ok)
        const summary = {
            docBytes, clients: CLIENTS, ready: ready.length, wallMs, budgetMs: READY_BUDGET_MS,
            serverLoopDelayMs: { max: Math.round(lag.max / 1e6), p99: Math.round(lag.percentile(99) / 1e6), mean: Math.round(lag.mean / 1e6) },
            readyMs: ready.map(r => r.elapsedMs).sort((a, b) => a - b),
            peerReplyMs: results.map(r => r.peerMs ?? -1).sort((a, b) => a - b),
            failures: results.filter(r => !r.ok).map(r => ({ i: r.index, state: r.state, error: r.error, atMs: r.elapsedMs, openMs: r.openMs, peerMs: r.peerMs, disconnects: r.peerDisconnects, firstDisconnectMs: r.firstDisconnectMs })),
            totalDisconnects: results.reduce((n, r) => n + r.peerDisconnects, 0),
        }
        console.log(`ws-concurrent-sync: ${JSON.stringify(summary)}`)
        expect(summary.failures).toEqual([])
        expect(ready.length).toBe(CLIENTS)
    }, READY_BUDGET_MS + 30_000)
})
