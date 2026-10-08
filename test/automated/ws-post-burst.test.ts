/**
 * ws-post-burst.test.ts — the Engine's WS server after a burst of short-lived clients (r34 POST-BURST-CPU).
 *
 * Fleet symptom (r34 WS-PROBE.md, cf231e8 on idea04): after 6 fresh clients got the
 * store and left, the main thread stayed at ~100% for ~2 min and a new client got
 * no sync message for 25-60 s. Two causes:
 *   1. sharePolicy `async () => true` (src/repo.ts): every connecting peer is sent
 *      a sync of EVERY doc the Engine holds (r34 probes: 6 unrequested docs each),
 *      and a storage-less client answers them all -> full syncs of the command log,
 *      the golden doc, ... per client, most of them after it has already left.
 *   2. ThreadedWebSocketServerAdapter hands queued messages of a peer whose socket
 *      is gone to the Repo anyway; each costs a full receive+generate on the main
 *      thread for a reply nobody receives.
 *
 * The server is startAutomergeServer() with the synthetic store doc plus two extra
 * docs (a command-log-like list and a smaller doc), loaded from NodeFS storage.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import path from 'path'
import net from 'net'
import fs from 'fs'
import { Worker } from 'worker_threads'
import { performance } from 'perf_hooks'
import { Repo, DocumentId, PeerId } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { next as A } from '@automerge/automerge'
import { startAutomergeServer } from '../../src/repo.js'
import { enginePeerId } from '../../src/data/StoreScope.js'
import { pruneDepartedMessages, QueuedEvent } from '../../src/wsServerThread.js'
import { PortNumber } from '../../src/data/CommonTypes.js'
import { largeStoreDoc } from '../harness/largeStoreDoc.js'
import type { WsSyncClientInput, WsSyncClientResult } from '../harness/wsSyncClientWorker.js'

const BURST = Number(process.env.POSTBURST_CLIENTS ?? 10)

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})

const extraDoc = (changes: number): Uint8Array => {
    let d = A.from<any>({ logs: [] })
    for (let i = 0; i < changes; i++) d = A.change(d, (x: any) => { x.logs.push({ ts: 1791000000000 + i, msg: `step ${i}: docker compose pull kolibri ... ok` }) })
    return A.save(d)
}

/** One fresh storage-less client in its own thread; resolves with its result (it exits right after 'ready'). */
const runClient = (input: WsSyncClientInput): Promise<WsSyncClientResult> => new Promise(resolve => {
    const w = new Worker(new URL('../harness/wsSyncClientWorker.js', import.meta.url), { workerData: input })
    w.on('message', (m: any) => { if (m?.type === 'ready') w.postMessage({ type: 'go' }); else resolve(m) })
    w.once('error', e => resolve({ index: input.index, ok: false, elapsedMs: -1, state: 'worker-error', error: String(e), peerConnects: 0, peerDisconnects: 0 }))
})

/** In-process client; records the documentIds of every message the server sends it. */
const inProcessClient = async (url: string, docId: DocumentId, storageDir?: string, peerId?: string) => {
    const adapter = new WebSocketClientAdapter(url, 2_000)
    const seen = new Set<string>()
    adapter.on('message', (m: any) => { if (m?.documentId) seen.add(m.documentId) })
    const repo = new Repo({ network: [adapter], storage: storageDir ? new NodeFSStorageAdapter(storageDir) : undefined, peerId: (peerId ?? `postburst-${Math.random().toString(36).slice(2)}`) as PeerId })
    const handle = await repo.find(docId)
    await handle.whenReady()
    return { seen, close: async () => { try { await repo.shutdown() } catch { /* already disconnected */ } } }
}

describe('Automerge WS server after a burst of short-lived clients (r34 POST-BURST-CPU)', () => {
    let dataDir: string
    let repo: Repo
    let url: string
    let mainId: DocumentId
    const extraIds: DocumentId[] = []

    beforeAll(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-postburst-'))
        const seed = new Repo({ network: [], storage: new NodeFSStorageAdapter(dataDir) })
        mainId = seed.import(largeStoreDoc()).documentId
        extraIds.push(seed.import(extraDoc(6_000)).documentId, seed.import(extraDoc(1_000)).documentId)
        await seed.flush()
        const port = await freePort()
        repo = await startAutomergeServer(dataDir, port as PortNumber, { storeDocId: mainId, engineId: 'ENGINE_postburst' })
        for (const id of [mainId, ...extraIds]) await (await repo.find(id)).whenReady()
        url = `ws://127.0.0.1:${port}`
    }, 180_000)

    afterAll(async () => {
        const adapter: any = repo?.networkSubsystem.adapters[0]
        if (typeof adapter?.close === 'function') await adapter.close()
        // dataDir is left in os.tmpdir(): throttled sync-state saves may still be writing into it.
    })

    it('a storage-less client (Console, probe) is sent only the doc it asked for', async () => {
        const c = await inProcessClient(url, mainId)
        await new Promise(r => setTimeout(r, 1_500)) // give unsolicited syncs time to arrive
        await c.close()
        expect([...c.seen]).toEqual([mainId])
    }, 60_000)

    it('a peer with storage (another Engine of the same store) still gets every doc announced', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-postburst-peer-'))
        // Store-scoped peering (StoreScope.ts): an Engine peer carries its store tag in its peerId
        const c = await inProcessClient(url, mainId, dir, enginePeerId(mainId, 'ENGINE_postburst-peer'))
        const until = Date.now() + 10_000
        while (!extraIds.every(id => c.seen.has(id)) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
        await c.close()
        expect(extraIds.every(id => c.seen.has(id))).toBe(true)
    }, 60_000)

    it(`after ${BURST} clients connect, sync and leave at once, a new client is ready promptly`, async () => {
        const input = (index: number): WsSyncClientInput => ({ url, docId: mainId, index, timeoutMs: 60_000, retryIntervalMs: 2_000 })
        const warm = await runClient(input(999))
        expect(warm.ok).toBe(true)
        const burst = await Promise.all(Array.from({ length: BURST }, (_, i) => runClient(input(i))))
        expect(burst.every(r => r.ok)).toBe(true)
        let last = performance.eventLoopUtilization()
        const t0 = performance.now()
        const next = await runClient(input(1000))
        const elu = performance.eventLoopUtilization(performance.eventLoopUtilization(), last).utilization
        const budget = Math.max(2_500, 2 * warm.elapsedMs)
        console.log(`[post-burst] warm single ${warm.elapsedMs} ms; burst ${burst.map(r => r.elapsedMs).join(', ')} ms; next client ${next.elapsedMs} ms (budget ${budget}); server ELU meanwhile ${elu.toFixed(2)}; wall ${Math.round(performance.now() - t0)} ms`)
        expect(next.ok).toBe(true)
        expect(next.elapsedMs).toBeLessThanOrEqual(budget)
    }, 180_000)
})

describe('storage-less clients still get docs their Engine relays (Console remote command logs)', () => {
    // The Console finds another Engine's command log by URL through the Engine it is
    // connected to (agent-console-dev src/store/engine.ts commandLogFor). Here only
    // Engine B has the doc; Engine A is connected to B as an Engine peer (like
    // connectEngine in src/data/Network.ts) and must fetch it from B on request.
    let a: Repo, b: Repo, urlA: string, onlyOnB: DocumentId

    beforeAll(async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-postburst-a-'))
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-postburst-b-'))
        const seedB = new Repo({ network: [], storage: new NodeFSStorageAdapter(dirB) })
        onlyOnB = seedB.import(extraDoc(200)).documentId
        await seedB.flush()
        const [portA, portB] = [await freePort(), await freePort()]
        // Both Engines in one store (store-scoped peering: A and B must share a store to sync)
        const storeId = seedB.create({ engineDB: {} }).documentId
        b = await startAutomergeServer(dirB, portB as PortNumber, { storeDocId: storeId, engineId: 'ENGINE_b' })
        await (await b.find(onlyOnB)).whenReady()
        a = await startAutomergeServer(dirA, portA as PortNumber, { storeDocId: storeId, engineId: 'ENGINE_a' })
        a.networkSubsystem.addNetworkAdapter(new WebSocketClientAdapter(`ws://127.0.0.1:${portB}`, 2_000))
        urlA = `ws://127.0.0.1:${portA}`
        // Wait until A is peered with B (the client's request must find an Engine to ask).
        const until = Date.now() + 20_000
        while (a.peers.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 100))
    }, 60_000)

    afterAll(async () => {
        for (const r of [a, b]) {
            for (const ad of (r?.networkSubsystem.adapters ?? []) as any[]) {
                try { if (typeof ad.close === 'function') await ad.close(); else ad.disconnect?.() } catch { /* already closed */ }
            }
        }
    })

    it('a doc only Engine B has is found through Engine A', async () => {
        const c = await inProcessClient(urlA, onlyOnB)
        await c.close()
        expect(c.seen.has(onlyOnB)).toBe(true)
    }, 30_000)

    it('a doc no Engine has ends unavailable instead of hanging', async () => {
        const adapter = new WebSocketClientAdapter(urlA, 2_000)
        const repo = new Repo({ network: [adapter] })
        const missing = new Repo({ network: [] }).create({ nobody: 'has me' }).documentId
        const t0 = Date.now()
        await expect(repo.find(missing)).rejects.toThrow(/unavailable/)
        expect(Date.now() - t0).toBeLessThan(15_000)
        try { await repo.shutdown() } catch { /* already disconnected */ }
    }, 30_000)
})

describe('pruneDepartedMessages', () => {
    const changeMsg = (): Uint8Array => {
        const d = A.change(A.init<any>(), (x: any) => { x.edit = 1 })
        const [, msg] = A.generateSyncMessage(d, A.initSyncState())
        const [, s2] = A.receiveSyncMessage(A.init<any>(), A.initSyncState(), msg!)
        const [, reply] = A.generateSyncMessage(A.init<any>(), s2)
        const [, s3] = A.receiveSyncMessage(d, A.initSyncState(), reply!)
        return A.generateSyncMessage(d, s3)[1]! // carries the change
    }
    const emptyMsg = (): Uint8Array => A.generateSyncMessage(A.init<any>(), A.initSyncState())[1]!
    const m = (senderId: string, type: string, data?: Uint8Array): QueuedEvent => ({ event: 'message', payload: { type, senderId, targetId: 'srv', documentId: 'doc', data } })

    it('drops the departed peer\'s change-less messages, keeps its edits and everyone else\'s', () => {
        expect(A.decodeSyncMessage(changeMsg()).changes.length).toBeGreaterThan(0)
        const q: QueuedEvent[] = [
            m('gone', 'sync', emptyMsg()), m('gone', 'request', emptyMsg()), m('gone', 'ephemeral', new Uint8Array([1])),
            m('gone', 'sync', changeMsg()), m('other', 'sync', emptyMsg()),
            { event: 'peer-disconnected', payload: { peerId: 'other' } },
        ]
        const out = pruneDepartedMessages(q, 'gone' as PeerId)
        expect(out.map(e => `${e.event}:${e.payload.senderId ?? e.payload.peerId}:${e.payload.type ?? ''}`)).toEqual([
            'message:gone:sync', 'message:other:sync', 'peer-disconnected:other:',
        ])
    })
})
