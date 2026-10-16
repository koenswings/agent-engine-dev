/**
 * ephemeral-relay.test.ts: automerge-repo ephemeral messages (DocHandle.broadcast)
 * pass through the Engine's threaded WS server and store-scope rules, and are
 * forwarded across peers (store-design PROPOSAL.md, Koen decision 2026-10-13).
 *
 * Real Engine repos (src/repo.ts startAutomergeServer) on loopback, chained
 * a <- b <- c through the production connectEngine (b dials a, c dials b), and a
 * storage-less Console client on c. Asserted:
 *   - a broadcast on a's store handle reaches b, c and the Console on c (2 relays);
 *   - a broadcast from the Console on c reaches a (relay the other way);
 *   - each message is delivered once per receiver (dedupe by sender/session/count);
 *   - an Engine of ANOTHER store never receives our store's ephemeral messages;
 *   - nothing is stored: the store doc's heads do not change.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import net from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { Repo, DocHandle, DocumentId, PeerId } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { next as A } from '@automerge/automerge'
import { startAutomergeServer } from '../../src/repo.js'
import { ThreadedWebSocketServerAdapter } from '../../src/wsServerThread.js'
import { connectEngine, network, refusedPeers } from '../../src/data/Network.js'
import { parseEnginePeerId } from '../../src/data/StoreScope.js'
import { EngineID, Hostname, IPAddress, PortNumber } from '../../src/data/CommonTypes.js'

const PEER_IP = '127.0.0.2' as IPAddress

// ── helpers ─────────────────────────────────────────────────────────────────

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (cond: () => boolean, timeoutMs = 15_000, what = 'condition') => {
    const end = Date.now() + timeoutMs
    while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await sleep(50) }
}
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `idea-ephrelay-${p}-`))

/** A store doc (Store shape) as a saved binary. */
const storeBinary = (label: string): Uint8Array =>
    A.save(A.from<any>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {}, label }))
const newDocId = (): DocumentId => new Repo({ network: [] }).create({}).documentId

interface TestEngine { name: string, repo: Repo, port: number, dir: string, storeId: DocumentId, store: DocHandle<any>, server: ThreadedWebSocketServerAdapter }
const engines: TestEngine[] = []
const clients: Array<() => Promise<void> | void> = []

/**
 * Start a real Engine repo of store `storeId` seeded with `seed` (docId -> binary)
 * in its storage, and load its own store doc, as start.ts does.
 */
const startEngine = async (name: string, storeId: DocumentId, seed: Record<string, Uint8Array>, load: string[] = [storeId]): Promise<TestEngine> => {
    const dir = tmp(name)
    const s = new Repo({ network: [], storage: new NodeFSStorageAdapter(dir) })
    for (const [docId, bin] of Object.entries(seed)) s.import(bin, { docId: docId as DocumentId })
    await s.flush()
    const port = await freePort()
    const repo = await startAutomergeServer(dir, port as PortNumber, { storeDocId: storeId, engineId: `ENGINE_${name}` })
    const server = repo.networkSubsystem.adapters[0] as unknown as ThreadedWebSocketServerAdapter
    await server.listening
    let store: DocHandle<any> | undefined
    for (const id of load) { const h = await repo.find<any>(id as DocumentId); await h.whenReady(); if (id === storeId) store = h }
    const e = { name, repo, port, dir, storeId, store: store!, server }
    engines.push(e)
    return e
}

const stopAll = async () => {
    while (clients.length) { try { await clients.pop()!() } catch { /* closed */ } }
    for (const e of engines.splice(0)) {
        for (const ad of e.repo.networkSubsystem.adapters as any[]) {
            try { if (typeof ad.close === 'function') await ad.close(); else ad.disconnect?.() } catch { /* closed */ }
        }
    }
    for (const k of Object.keys(network.connections)) delete (network.connections as any)[k]
    refusedPeers.clear()
}

const peersOf = (e: TestEngine) => e.repo.peers.map(String)
const hasDoc = (e: TestEngine, id: string) => id in (e.repo.handles as any)
const isEnginePeerOf = (e: TestEngine, other: TestEngine) => peersOf(e).some(p => parseEnginePeerId(p)?.engineId === `ENGINE_${other.name}`)

/** An ephemeral client (Console-like: storage-less, random peerId). */
const consoleClient = (port: number) => {
    const adapter = new WebSocketClientAdapter(`ws://127.0.0.1:${port}`, 1_000)
    const seen = new Set<string>()
    adapter.on('message', (m: any) => { if (m?.documentId && m.type === 'sync') seen.add(m.documentId) })
    const repo = new Repo({ network: [adapter], peerId: `console-${Math.random().toString(36).slice(2)}` as PeerId })
    clients.push(async () => { try { await repo.shutdown() } catch { /* closed */ } })
    return { repo, seen }
}

afterEach(stopAll)

/** Collect ephemeral messages a handle receives. */
const inbox = (h: DocHandle<any>) => {
    const got: any[] = []
    h.on('ephemeral-message', (e: any) => got.push(e.message))
    return got
}
const tagged = (got: any[], tag: string) => got.filter(m => m?.tag === tag)

describe('ephemeral messages through real Engine repos (WS worker + store scope)', () => {
    let X: DocumentId, Y: DocumentId, bx: Uint8Array, by: Uint8Array
    beforeAll(() => { X = newDocId(); Y = newDocId(); bx = storeBinary('store X'); by = storeBinary('store Y') })

    const chain = async () => {
        const a = await startEngine('a', X, { [X]: bx })
        const b = await startEngine('b', X, { [X]: bx })
        const c = await startEngine('c', X, { [X]: bx })
        // one connection table per process (ip:port): use distinct loopback addresses
        await connectEngine(b.repo, PEER_IP, 'idea-a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
        await connectEngine(c.repo, '127.0.0.3' as IPAddress, 'idea-b' as Hostname, 'ENGINE_b' as EngineID, X, b.port as PortNumber)
        await until(() => isEnginePeerOf(a, b) && isEnginePeerOf(b, c), 15_000, 'chain a-b-c peered')
        // the store doc is synced along the chain (so every hop has the doc's peers)
        a.store.change((d: any) => { d.label = 'from a' })
        await until(() => c.store.doc().label === 'from a', 15_000, 'a -> c sync')
        return { a, b, c }
    }

    it('a broadcast on Engine a reaches b, c and a Console on c (relayed twice), once each, never stored', async () => {
        const { a, b, c } = await chain()
        const con = consoleClient(c.port)
        const ch = await con.repo.find<any>(X); await ch.whenReady()
        await until(() => peersOf(c).some(p => p.startsWith('console-')), 10_000, 'console on c')
        const inB = inbox(b.store), inC = inbox(c.store), inCon = inbox(ch), inA = inbox(a.store)
        const headsBefore = A.getHeads(c.store.doc()).join()
        await sleep(500)
        for (let i = 0; i < 3; i++) { a.store.broadcast({ tag: 'hb', engineId: 'ENGINE_a', n: i }); await sleep(100) }
        await until(() => tagged(inCon, 'hb').length >= 3, 15_000, 'console got 3 hb from a')
        await sleep(1_000) // let any duplicate arrive
        expect(tagged(inB, 'hb').map(m => m.n)).toEqual([0, 1, 2])
        expect(tagged(inC, 'hb').map(m => m.n)).toEqual([0, 1, 2])
        expect(tagged(inCon, 'hb').map(m => m.n)).toEqual([0, 1, 2])
        expect(tagged(inA, 'hb')).toHaveLength(0) // the sender does not get its own message back
        expect(A.getHeads(c.store.doc()).join()).toBe(headsBefore)
        expect(A.getHeads(a.store.doc()).join()).toBe(headsBefore)
    }, 90_000)

    it('a broadcast from the Console on c reaches Engine a (relayed the other way)', async () => {
        const { a, c } = await chain()
        const con = consoleClient(c.port)
        const ch = await con.repo.find<any>(X); await ch.whenReady()
        const inA = inbox(a.store)
        await sleep(500)
        ch.broadcast({ tag: 'ping', from: 'console' })
        await until(() => tagged(inA, 'ping').length === 1, 15_000, 'a got the console ping')
    }, 90_000)

    it('an Engine of another store, peered with nobody of ours, never receives our ephemeral messages', async () => {
        const { a, b } = await chain()
        const y = await startEngine('y', Y, { [Y]: by })
        // y tries to join b: refused by store scope
        await connectEngine(y.repo, '127.0.0.4' as IPAddress, 'idea-b' as Hostname, 'ENGINE_b' as EngineID, Y, b.port as PortNumber).catch(() => undefined)
        await sleep(2_000)
        const inY = inbox(y.store)
        a.store.broadcast({ tag: 'hb', engineId: 'ENGINE_a', n: 99 })
        await sleep(2_000)
        expect(inY).toHaveLength(0)
        expect(isEnginePeerOf(b, y)).toBe(false)
        expect(hasDoc(y, X)).toBe(false)
    }, 90_000)
})
