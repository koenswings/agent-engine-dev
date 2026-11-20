/**
 * store-scoped-peering.test.ts: an Engine only peers with Engines of its OWN store
 * and only shares its own store's documents (2026-10-08 cross-store leak: idea02
 * held the pool's store 3zoqd and the pool held idea02's 4GQm; SUMMARY.md in
 * duration-evidence/tailscale-isolation-20261008).
 *
 * Real Engine repos (src/repo.ts startAutomergeServer: threaded WS server, NodeFS
 * storage) on loopback ports, linked through the production paths:
 *   - mDNS: discoverEngines (TXT parse + selectStorePeers) -> manageDiscoveredPeers
 *     -> connectEngine, fed with the TXT record startAdvertising publishes
 *     (engineTxtRecord). Only the multicast transport is replaced.
 *   - static peers: startStaticPeers -> connectEngine (a name resolved like
 *     MagicDNS resolves a bare name to a Tailscale address).
 *   - inbound: the threaded WS server's join check.
 * Asserted:
 *   - same store: Engines sync both ways (mDNS and static);
 *   - different store: refused in BOTH directions over mDNS (TXT check, and the
 *     handshake check when the TXT lies) and over static peers; neither side ends
 *     up with the other's store doc in memory or on disk; refusals are logged
 *     with the peer address, its store and ours;
 *   - a foreign store doc already on disk / loaded here is never announced or
 *     served (to our own Engines or to Consoles) and is left untouched;
 *   - engine#471 (a): command logs are not pushed between our own Engines; a
 *     Console (or an Engine) asking for one still gets it, relayed, and live;
 *   - mixed versions: an old Engine (no store tag in its peerId) is refused
 *     whether it dials us or we dial it; nothing it announces is accepted.
 * Loopback note: connectEngine never dials 127.0.0.1/localhost (self), so the
 * Engines are dialled on 127.0.0.2 (same loopback interface on Linux).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { removeTestDir } from '../harness/removeTestDir.js'
import net from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { WebSocketServer } from 'ws'
import { Repo, DocHandle, DocumentId, PeerId, cbor } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { WebSocketClientAdapter, WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { next as A } from '@automerge/automerge'
import { startAutomergeServer } from '../../src/repo.js'
import { ThreadedWebSocketServerAdapter } from '../../src/wsServerThread.js'
import { connectEngine, manageDiscoveredPeers, network, refusedPeers, REFUSED_PEER_BACKOFF_MS } from '../../src/data/Network.js'
import { startStaticPeers } from '../../src/data/StaticPeers.js'
import { discoverEngines, engineTxtRecord, parseEngineDevice, selectStorePeers } from '../../src/monitors/mdnsMonitor.js'
import {
    storeTag, enginePeerId, parseEnginePeerId, peerVerdict, describeRefusal, refusalMessage, parseRefusalMessage,
    isForeignStoreDocContent, RefusalLog,
    markOwnCommandLog, isOwnCommandLog, shareCommandLogWith, isCommandLogContent,
    archivedCommandLogIds, isOwnArchivedCommandLog, isRefusedDoc,
} from '../../src/data/StoreScope.js'
import { guardOutgoing, StoreScopedWebSocketClientAdapter } from '../../src/data/StoreScopedClientAdapter.js'
import { config } from '../../src/data/Config.js'
import { localEngineId } from '../../src/data/Engine.js'
import { EngineID, Hostname, IPAddress, PortNumber } from '../../src/data/CommonTypes.js'
import { Store } from '../../src/data/Store.js'

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
// Every temp dir is removed after the file (PR #248 re-run on idea04 left 18 /tmp/idea-storescope-*).
const tempDirs: string[] = []
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `idea-storescope-${p}-`)); tempDirs.push(d); return d }
/** NodeFS storage path of a doc (as createServerStore checks it). */
const onDisk = (dir: string, id: string) => fs.existsSync(path.join(dir, id.slice(0, 2), id.slice(2)))
/**
 * Does `dir` hold any of the doc's DATA (snapshot or incremental chunks)? Leak checks use this,
 * not onDisk: a repo that itself asks for an id (and gets "unavailable") may write a tiny
 * sync-state/<storageId> marker under that id — its own bookkeeping, no foreign content. On a
 * loaded Pi that marker landed before the check (on-Pi triage idea04 2026-10-25; reproduced on
 * the box under CPU starvation, the only file was a 2-byte sync-state).
 */
const docDataOnDisk = (dir: string, id: string) => {
    const base = path.join(dir, id.slice(0, 2), id.slice(2))
    return ['snapshot', 'incremental'].some(k => { try { return fs.readdirSync(path.join(base, k)).length > 0 } catch { return false } })
}

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
const startEngine = async (name: string, storeId: DocumentId, seed: Record<string, Uint8Array>, load: string[] = [storeId], commandLogArchiveDir?: string): Promise<TestEngine> => {
    const dir = tmp(name)
    const s = new Repo({ network: [], storage: new NodeFSStorageAdapter(dir) })
    for (const [docId, bin] of Object.entries(seed)) s.import(bin, { docId: docId as DocumentId })
    await s.flush()
    const port = await freePort()
    const repo = await startAutomergeServer(dir, port as PortNumber, { storeDocId: storeId, engineId: `ENGINE_${name}`, commandLogArchiveDir })
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

/** Capture print/log output (console.info/console.error) during fn. */
const captureLogs = () => {
    const lines: string[] = []
    const oi = console.info, oe = console.error
    console.info = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); }
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); }
    return { lines, restore: () => { console.info = oi; console.error = oe } }
}

/** Assert that two Engines of different stores did not exchange anything. */
const expectIsolated = (x: TestEngine, y: TestEngine) => {
    expect(isEnginePeerOf(x, y), `${x.name} must not be peered with ${y.name}`).toBe(false)
    expect(isEnginePeerOf(y, x), `${y.name} must not be peered with ${x.name}`).toBe(false)
    expect(hasDoc(x, y.storeId), `${x.name} must not hold ${y.name}'s store doc`).toBe(false)
    expect(hasDoc(y, x.storeId), `${y.name} must not hold ${x.name}'s store doc`).toBe(false)
    expect(docDataOnDisk(x.dir, y.storeId)).toBe(false)
    expect(docDataOnDisk(y.dir, x.storeId)).toBe(false)
}

/** An ephemeral client (Console-like: storage-less, random peerId). */
const consoleClient = (port: number) => {
    const adapter = new WebSocketClientAdapter(`ws://127.0.0.1:${port}`, 1_000)
    const seen = new Set<string>()
    adapter.on('message', (m: any) => { if (m?.documentId && m.type === 'sync') seen.add(m.documentId) })
    const repo = new Repo({ network: [adapter], peerId: `console-${Math.random().toString(36).slice(2)}` as PeerId })
    clients.push(async () => { try { await repo.shutdown() } catch { /* closed */ } })
    return { repo, seen }
}
const findWithTimeout = async (repo: Repo, id: DocumentId, ms = 8_000): Promise<'ready' | 'unavailable' | 'timeout'> => {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), ms)
    try { const h = await repo.find(id, { signal: c.signal }); await h.whenReady(); return 'ready' }
    catch (e: any) { return /unavailable/i.test(String(e?.message ?? e)) ? 'unavailable' : 'timeout' }
    finally { clearTimeout(t) }
}

afterEach(stopAll)
afterAll(async () => {
    await stopAll()
    await sleep(1_000)   // let throttled sync-state saves land first
    for (const d of tempDirs) await removeTestDir(d)
})

// ── pure units ──────────────────────────────────────────────────────────────

describe('StoreScope units', () => {
    const X = '3zoqdSVsEtj4ygNJPNcDyKWvdxo6'
    const Y = '4GQmEZehPDfryGDxkFo9XixbvmAC'

    it('storeTag: readable prefix + hash; automerge: prefix ignored; distinct per store', () => {
        expect(storeTag(X)).toMatch(/^3zoqd-[0-9a-f]{12}$/)
        expect(storeTag(`automerge:${X}`)).toBe(storeTag(X))
        expect(storeTag(Y)).toMatch(/^4GQmE-/)
        expect(storeTag(Y)).not.toBe(storeTag(X))
        expect(storeTag(X)).not.toContain(X)   // the full id (a write capability) is never published
        // two ids with the same 5-char prefix still differ
        expect(storeTag('3zoqdAAAA')).not.toBe(storeTag('3zoqdBBBB'))
    })

    it('enginePeerId round-trips; anything else is not an Engine peerId', () => {
        const p = enginePeerId(X, 'ENGINE_abc123')
        expect(p).toMatch(/^idea-engine\/3zoqd-[0-9a-f]{12}\/ENGINE_abc123\/[0-9a-f]{8}$/)
        expect(parseEnginePeerId(p)).toEqual({ storeTag: storeTag(X), engineId: 'ENGINE_abc123' })
        expect(enginePeerId(X, 'ENGINE_a')).not.toBe(enginePeerId(X, 'ENGINE_a'))   // per-run session
        for (const bad of ['peer-abc', 'idea-engine/x/y', `idea-engine/${storeTag(X)}//s1`, `other/${storeTag(X)}/E/s1`, undefined, '']) {
            expect(parseEnginePeerId(bad as any)).toBeUndefined()
        }
    })

    it('peerVerdict: same store admitted, other store refused, old Engine (no tag, storage) refused, Console admitted', () => {
        const own = storeTag(X)
        expect(peerVerdict(own, enginePeerId(X, 'ENGINE_b'), { isEphemeral: false })).toMatchObject({ admit: true, kind: 'same-store' })
        expect(peerVerdict(own, enginePeerId(Y, 'ENGINE_c'), { isEphemeral: false })).toMatchObject({ admit: false, kind: 'foreign-store', theirTag: storeTag(Y), engineId: 'ENGINE_c' })
        // even if it claims to be ephemeral, another store's Engine is refused
        expect(peerVerdict(own, enginePeerId(Y, 'ENGINE_c'), { isEphemeral: true }).admit).toBe(false)
        expect(peerVerdict(own, 'peer-oldengine', { isEphemeral: false, storageId: 's' })).toMatchObject({ admit: false, kind: 'legacy-engine' })
        expect(peerVerdict(own, 'peer-oldengine', undefined)).toMatchObject({ admit: false, kind: 'legacy-engine' })
        expect(peerVerdict(own, 'peer-console', { isEphemeral: true })).toMatchObject({ admit: true, kind: 'client' })
    })

    it('refusal messages and log lines name the peer, its store and ours', () => {
        const own = storeTag(X)
        const v = peerVerdict(own, enginePeerId(Y, 'ENGINE_c'), {})
        const line = describeRefusal(v, own, 'pid', 'inbound from 192.168.0.180:51234')
        expect(line).toContain('REFUSED')
        expect(line).toContain('192.168.0.180')
        expect(line).toContain(`theirs ${storeTag(Y)}`)
        expect(line).toContain(`ours ${own}`)
        expect(describeRefusal(peerVerdict(own, 'peer-x', {}), own, 'peer-x', 'outbound to 10.0.0.1:4321')).toMatch(/no store id.*peer-x.*ours/)
        expect(parseRefusalMessage(refusalMessage(own, 'foreign-store'))).toEqual({ theirTag: own, kind: 'foreign-store' })
        expect(parseRefusalMessage('unsupported protocol version')).toBeUndefined()
    })

    it('isForeignStoreDocContent: another store doc is foreign; ours and non-store docs are not', () => {
        expect(isForeignStoreDocContent(X, Y, { engineDB: {}, diskDB: {} })).toBe(true)
        expect(isForeignStoreDocContent(X, X, { engineDB: {} })).toBe(false)
        expect(isForeignStoreDocContent(`automerge:${X}`, X, { engineDB: {} })).toBe(false)
        expect(isForeignStoreDocContent(X, 'cmdlog', { traces: {}, recentTraceIds: [] })).toBe(false)
        expect(isForeignStoreDocContent(X, 'n', null)).toBe(false)
    })

    it('guardOutgoing turns a sync/request for a foreign doc into doc-unavailable; others pass', () => {
        const g = (id: string) => id === 'foreign'
        const sync = { type: 'sync', senderId: 's', targetId: 't', documentId: 'foreign', data: new Uint8Array([1]) } as any
        expect(guardOutgoing(sync, g)).toEqual({ type: 'doc-unavailable', senderId: 's', targetId: 't', documentId: 'foreign' })
        expect(guardOutgoing({ ...sync, type: 'request' }, g)!.type).toBe('doc-unavailable')
        expect(guardOutgoing({ ...sync, documentId: 'own' }, g)!.type).toBe('sync')
        expect(guardOutgoing(sync, undefined)).toBe(sync)
    })

    it('RefusalLog: first refusal logged, repeats suppressed and counted', () => {
        let t = 0
        const out: string[] = []
        const l = new RefusalLog(s => out.push(s), 1000, () => t)
        expect(l.report('k', 'refused A')).toBe(true)
        t = 10; l.report('k', 'refused A'); t = 20; l.report('k', 'refused A')
        l.report('other', 'refused B')
        t = 1500; l.report('k', 'refused A')
        expect(out).toEqual(['refused A', 'refused B', 'refused A (2 more refusal(s) of this peer since the last log line)'])
    })

    it('parseEngineDevice reads the store tag from a real ciao answer (TXT in answers) and from additionals; no TXT -> undefined', () => {
        // Shape captured from a real ciao advert + node-dns-sd browse on a loopback-only host
        const rdata = { name: 'probe', id: 'ENGINE_probe', version: '1', store: 'abcde-0123456789ab' }
        const real = { address: '127.0.0.1', service: { port: 49999, protocol: 'tcp', type: 'engine' }, packet: {
            answers: [{ type: 'PTR', rdata: 'probe-1._engine._tcp.local' }, { type: 'SRV', rdata: { port: 49999, target: 'probe-1.local' } }, { type: 'TXT', rdata }, { type: 'A', rdata: '127.0.0.1' }],
            additionals: [{ type: 'NSEC', rdata: '0d 70' }],
        } }
        expect(parseEngineDevice(real)).toEqual({ address: '127.0.0.1', hostname: 'probe', engineId: 'ENGINE_probe', port: 49999, store: 'abcde-0123456789ab' })
        const old = { address: '10.0.0.9', service: { port: 4321 }, packet: { answers: [], additionals: [{ type: 'TXT', rdata: { name: 'idea02', id: 'ENGINE_2', version: '1.0' } }] } }
        expect(parseEngineDevice(old)).toEqual({ address: '10.0.0.9', hostname: 'idea02', engineId: 'ENGINE_2', port: 4321, store: undefined })
        expect(parseEngineDevice({ address: '10.0.0.8', packet: { answers: [], additionals: [] } })).toBeUndefined()
    })

    it('mDNS TXT carries the store tag; selectStorePeers keeps only our store, logs the rest', () => {
        const own = storeTag(X)
        expect(engineTxtRecord('idea01', 'ENGINE_1', '1.0', own)).toEqual({ name: 'idea01', id: 'ENGINE_1', version: '1.0', store: own })
        const logged: string[] = []
        const sel = selectStorePeers([
            { address: '10.0.0.1' as IPAddress, hostname: 'same' as Hostname, engineId: 'ENGINE_same' as EngineID, store: own },
            { address: '10.0.0.2' as IPAddress, hostname: 'other' as Hostname, engineId: 'ENGINE_other' as EngineID, store: storeTag(Y), port: 4321 },
            { address: '10.0.0.3' as IPAddress, hostname: 'old' as Hostname, engineId: 'ENGINE_old' as EngineID },
            { address: '10.0.0.4' as IPAddress, hostname: 'me' as Hostname, engineId: 'ENGINE_me' as EngineID, store: own },
        ], 'ENGINE_me', own, (_k, l) => logged.push(l))
        expect([...sel.keys()]).toEqual(['10.0.0.1'])
        expect(logged).toHaveLength(2)
        expect(logged[0]).toMatch(/REFUSED mDNS peer other .*10\.0\.0\.2:4321.*theirs 4GQmE-.*ours 3zoqd-/)
        expect(logged[1]).toMatch(/REFUSED mDNS peer old .*10\.0\.0\.3.*no store id/)
    })
})

// ── real Engines ────────────────────────────────────────────────────────────

describe('store-scoped peering between real Engine repos', () => {
    let X: DocumentId, Y: DocumentId, bx: Uint8Array, by: Uint8Array
    const savedPort = config.settings.port
    let cwd: string, idDir: string

    beforeAll(() => {
        X = newDocId(); Y = newDocId()
        bx = storeBinary('store X'); by = storeBinary('store Y (another fleet)')
        // discoverEngines/manageDiscoveredPeers read store-identity/store-url.txt from the cwd
        cwd = process.cwd()
        idDir = tmp('cwd')
        fs.mkdirSync(path.join(idDir, config.settings.storeIdentityFolder), { recursive: true })
        process.chdir(idDir)
    })
    afterAll(() => { process.chdir(cwd); config.settings.port = savedPort })
    const actAs = (storeId: string) => fs.writeFileSync(path.join(idDir, config.settings.storeIdentityFolder, 'store-url.txt'), `automerge:${storeId}`)

    /** node-dns-sd shaped answer for an Engine advertising `txt`. */
    const mdnsAnswer = (e: TestEngine, txt: Record<string, string>) => ({
        address: PEER_IP, modelName: e.name, service: { port: e.port },
        packet: { additionals: [{ type: 'TXT', rdata: txt }] },
    })
    const txtOf = (e: TestEngine, store?: string) => {
        const t: Record<string, string> = engineTxtRecord(e.name, `ENGINE_${e.name}`, '1.0', store ?? storeTag(e.storeId))
        if (store === '') delete t.store   // an old Engine: no store key at all
        return t
    }
    /** One mDNS browse round on `e` that "hears" `others`; mDNS peers are dialled on settings.port. */
    const mdnsRound = async (e: TestEngine, answers: any[], port: number) => {
        actAs(e.storeId)
        config.settings.port = port
        e.store.change((d: any) => { d.engineDB[localEngineId] ??= { id: localEngineId, hostname: 'local' } })
        await discoverEngines(e.store as DocHandle<Store>, e.repo, async () => answers)
    }

    it('same store over mDNS: discovered, dialled and synced both ways', async () => {
        const a = await startEngine('a', X, { [X]: bx })
        const c = await startEngine('c', X, { [X]: bx })
        a.store.change((d: any) => { d.label = 'edited on a' })
        await mdnsRound(c, [mdnsAnswer(a, txtOf(a))], a.port)
        await until(() => c.store.doc().label === 'edited on a', 15_000, 'a -> c sync')
        c.store.change((d: any) => { d.fromC = true })
        await until(() => a.store.doc().fromC === true, 15_000, 'c -> a sync')
        expect(isEnginePeerOf(a, c) && isEnginePeerOf(c, a)).toBe(true)
        expect(network.connections[`${PEER_IP}:${a.port}` as IPAddress]).toBeDefined()
    }, 60_000)

    it('different store over mDNS: not dialled on the TXT tag, in both directions; logged', async () => {
        const a = await startEngine('a', X, { [X]: bx })
        const b = await startEngine('b', Y, { [Y]: by })
        const cap = captureLogs()
        try {
            await mdnsRound(a, [mdnsAnswer(b, txtOf(b))], b.port)   // a hears b
            await mdnsRound(b, [mdnsAnswer(a, txtOf(a))], a.port)   // b hears a
            await sleep(1_500)
        } finally { cap.restore() }
        expectIsolated(a, b)
        expect(network.connections[`${PEER_IP}:${b.port}` as IPAddress]).toBeUndefined()
        expect(network.connections[`${PEER_IP}:${a.port}` as IPAddress]).toBeUndefined()
        expect(a.server.refusals).toHaveLength(0)    // never even dialled
        expect(cap.lines.some(l => l.includes(`REFUSED mDNS peer b`) && l.includes(`theirs ${storeTag(Y)}`) && l.includes(`ours ${storeTag(X)}`))).toBe(true)
        expect(cap.lines.some(l => l.includes(`REFUSED mDNS peer a`) && l.includes(`theirs ${storeTag(X)}`) && l.includes(`ours ${storeTag(Y)}`))).toBe(true)
    }, 60_000)

    it('different store over mDNS with a TXT that claims our store: refused at the handshake, both directions', async () => {
        const a = await startEngine('a', X, { [X]: bx })
        const b = await startEngine('b', Y, { [Y]: by })
        const cap = captureLogs()
        try {
            await mdnsRound(a, [mdnsAnswer(b, txtOf(b, storeTag(X)))], b.port)   // b's TXT lies: a dials b
            await mdnsRound(b, [mdnsAnswer(a, txtOf(a, storeTag(Y)))], a.port)   // a's TXT lies: b dials a
            await until(() => refusedPeers.has(`${PEER_IP}:${b.port}`) && refusedPeers.has(`${PEER_IP}:${a.port}`), 10_000, 'both refusals')
            await sleep(1_500)
        } finally { cap.restore() }
        expectIsolated(a, b)
        // each server refused the other's join (inbound check) ...
        expect(a.server.refusals.map(r => r.verdict)).toContainEqual(expect.objectContaining({ kind: 'foreign-store', theirTag: storeTag(Y) }))
        expect(b.server.refusals.map(r => r.verdict)).toContainEqual(expect.objectContaining({ kind: 'foreign-store', theirTag: storeTag(X) }))
        // ... and the diallers dropped the link and back off
        expect(refusedPeers.get(`${PEER_IP}:${b.port}`)!.until).toBeGreaterThan(Date.now() + REFUSED_PEER_BACKOFF_MS - 60_000)
        expect(network.connections[`${PEER_IP}:${b.port}` as IPAddress]).toBeUndefined()
        const inbound = cap.lines.filter(l => l.includes('REFUSED peer inbound from'))
        expect(inbound.some(l => l.includes(`theirs ${storeTag(Y)}`) && l.includes(`ours ${storeTag(X)}`))).toBe(true)
        expect(inbound.some(l => l.includes(`theirs ${storeTag(X)}`) && l.includes(`ours ${storeTag(Y)}`))).toBe(true)
        expect(cap.lines.some(l => l.includes(`REFUSED peer outbound to ${PEER_IP}:${b.port}`))).toBe(true)
        // the refused peer is not redialled on the next discovery rounds
        const refusalsBefore = a.server.refusals.length + b.server.refusals.length
        await mdnsRound(a, [mdnsAnswer(b, txtOf(b, storeTag(X)))], b.port)
        await sleep(1_000)
        expect(b.server.refusals.length + a.server.refusals.length).toBe(refusalsBefore)
    }, 60_000)

    it('static peers (a name resolving like a Tailscale address): same store syncs, other store refused both ways', async () => {
        const a = await startEngine('a', X, { [X]: bx })
        const b = await startEngine('b', Y, { [Y]: by })
        const c = await startEngine('c', X, { [X]: bx })
        // One process holds all three Engines but Network.ts keeps one connection table per
        // process (keyed ip:port), so c and b reach a on different loopback addresses.
        const resolve = async (host: string) => ({ 'idea-a': PEER_IP, 'idea-a-ts': '127.0.0.3', 'idea-b': PEER_IP } as Record<string, string>)[host]
        const startFor = (e: TestEngine, raw: string) => {
            const h = startStaticPeers(e.repo, e.store as DocHandle<Store>, {
                raw, defaultPort: 4321, checkIntervalMs: 500, baseDelayMs: 200,
                // production connect (StaticPeers.ts default) with this Engine's own store id
                deps: { resolve, isSelf: () => false, log: () => {},
                    connect: (addr, host, eid, port) => connectEngine(e.repo, addr, host, eid, e.storeId, port) },
            })!
            clients.push(() => h.stop())
        }
        a.store.change((d: any) => { d.label = 'static a' })
        startFor(c, `idea-a:${a.port}`)          // same store
        startFor(a, `idea-b:${b.port}`)          // a -> b (foreign)
        startFor(b, `idea-a-ts:${a.port}`)       // b -> a (foreign)
        await until(() => c.store.doc().label === 'static a', 15_000, 'static same-store sync')
        await until(() => refusedPeers.has(`${PEER_IP}:${b.port}`), 10_000, 'a refuses b')
        await until(() => refusedPeers.has(`127.0.0.3:${a.port}`), 10_000, 'b refuses a')
        await until(() => a.server.refusals.some(r => r.verdict.theirTag === storeTag(Y)), 10_000, 'a refuses b inbound')
        await until(() => b.server.refusals.some(r => r.verdict.theirTag === storeTag(X)), 10_000, 'b refuses a inbound')
        await sleep(1_500)
        expectIsolated(a, b)
        expectIsolated(c, b)
        expect(isEnginePeerOf(a, c)).toBe(true)
    }, 60_000)

    it('a foreign store doc already here (loaded, or only on disk) is never announced or served, and is left untouched', async () => {
        const L = newDocId()   // a command log of our fleet written before engine#471 (no engineId, owner unknown): not pushed since engine#549
        // a holds a copy of store Y (relayed before the fix): one loaded, Y2 only on disk
        const Y2 = newDocId()
        const a = await startEngine('a', X, { [X]: bx, [Y]: by, [Y2]: by, [L]: A.save(A.from<any>({ traces: {}, recentTraceIds: [] })) }, [X, Y, L])
        const yHeads = A.getHeads((await a.repo.find<any>(Y)).doc())
        const c = await startEngine('c', X, { [X]: bx })
        await connectEngine(c.repo, PEER_IP, 'a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
        await until(() => isEnginePeerOf(c, a), 10_000, 'c peered with a')
        await sleep(1_500)
        expect(hasDoc(c, L), 'engine#549: an unowned command log is not pushed to another Engine').toBe(false)
        expect(hasDoc(c, Y), 'foreign store doc must not be announced to our own Engine').toBe(false)
        // asked for explicitly: unavailable, from our own Engine and from a Console.
        // (automerge-repo's find() waits until every adapter is ready; the threaded server
        // is ready after its first inbound client, so let a Console touch c first.)
        expect(await findWithTimeout(consoleClient(c.port).repo, X)).toBe('ready')
        expect(await findWithTimeout(c.repo, Y)).toBe('unavailable')
        const con = consoleClient(a.port)
        expect(await findWithTimeout(con.repo, X)).toBe('ready')
        expect(await findWithTimeout(con.repo, Y)).toBe('unavailable')
        expect(await findWithTimeout(con.repo, Y2)).toBe('unavailable')     // dormant copy on disk
        expect(con.seen.has(Y) || con.seen.has(Y2)).toBe(false)
        expect(docDataOnDisk(c.dir, Y)).toBe(false)
        // a's copies are untouched (not deleted, not changed)
        expect(A.getHeads((await a.repo.find<any>(Y)).doc())).toEqual(yHeads)
        await a.repo.flush()
        expect(onDisk(a.dir, Y) && onDisk(a.dir, Y2)).toBe(true)
    }, 90_000)

    it('engine#471 (a): command logs are not pushed between Engines, but are still fetched on demand (also relayed for a Console)', async () => {
        const OWN = newDocId()     // a's own log
        const OTHER = newDocId()   // b's log, a copy that a fetched earlier
        const P = newDocId()       // any other doc of our fleet: still shared generously
        const log = (engineId: string) => A.save(A.from<any>({ traces: {}, recentTraceIds: [], engineId }))
        {
            const a = await startEngine('a', X, { [X]: bx, [OWN]: log('ENGINE_a'), [OTHER]: log('ENGINE_b'), [P]: A.save(A.from<any>({ label: 'p' })) }, [X, OWN, OTHER, P])
            markOwnCommandLog(a.repo, OWN)   // as createCommandLogStore does for a's log (before any peer connects)
            const c = await startEngine('c', X, { [X]: bx })
            await connectEngine(c.repo, PEER_IP, 'a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
            await until(() => isEnginePeerOf(c, a), 10_000, 'c peered with a')
            await until(() => hasDoc(c, P), 10_000, 'plain fleet doc shared')
            await sleep(1_500)
            expect(hasDoc(c, OWN), "a's own command log must not be pushed to another Engine").toBe(false)
            expect(hasDoc(c, OTHER), "b's log must not be passed on to c (only kept in sync with b)").toBe(false)
            // a Console on c asks for a's log (url from a's /api/command-log-url): c fetches it from a and answers
            expect(await findWithTimeout(consoleClient(c.port).repo, X)).toBe('ready')
            const con = consoleClient(c.port)
            expect(await findWithTimeout(con.repo, OWN)).toBe('ready')
            expect(await findWithTimeout(c.repo, OTHER)).toBe('ready')   // an Engine asking explicitly also gets it
            // live: a's next write reaches the Console through c
            const ah = await a.repo.find<any>(OWN)
            ah.change((d: any) => { d.recentTraceIds.push('t-live') })
            const ch = await con.repo.find<any>(OWN)
            await until(() => (ch.doc()?.recentTraceIds ?? []).includes('t-live'), 10_000, 'live update relayed to the Console')
        }
    }, 90_000)

    it('engine#549 (1\'): nothing unowned is pushed on connect; asked for, it is still answered (Console through another Engine, and an Engine)', async () => {
        const U1 = newDocId(), U2 = newDocId()   // archived logs from before engine#471: no engineId
        const P = newDocId()                     // a plain fleet doc: still shared generously
        const unowned = (t: string) => A.save(A.from<any>({ traces: { [t]: { id: t } }, recentTraceIds: [t] }))
        const a = await startEngine('a', X, { [X]: bx, [U1]: unowned('t1'), [U2]: unowned('t2'), [P]: A.save(A.from<any>({ label: 'p' })) }, [X, U1, U2, P])
        const c = await startEngine('c', X, { [X]: bx })
        await connectEngine(c.repo, PEER_IP, 'a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
        await until(() => isEnginePeerOf(c, a), 10_000, 'c peered with a')
        await until(() => hasDoc(c, P), 10_000, 'plain fleet doc shared')
        await sleep(1_500)
        expect(hasDoc(c, U1) || hasDoc(c, U2), 'no unowned command log pushed on connect').toBe(false)
        expect(docDataOnDisk(c.dir, U1) || docDataOnDisk(c.dir, U2)).toBe(false)
        // a Console on c asks for U1: c relays the request to a, which answers
        expect(await findWithTimeout(consoleClient(c.port).repo, X)).toBe('ready')
        const con = consoleClient(c.port)
        expect(await findWithTimeout(con.repo, U1)).toBe('ready')
        expect((await con.repo.find<any>(U1)).doc().recentTraceIds).toEqual(['t1'])
        expect(await findWithTimeout(c.repo, U2)).toBe('ready')   // an Engine asking explicitly gets it too
    }, 90_000)

    it('engine#549 (1\'): the Console relayed view of another Engine\'s current log still resyncs after the Engines reconnect (owned-to-owner push kept)', async () => {
        const OWN = newDocId()   // a's current log, stamped with its engineId
        const a = await startEngine('a', X, { [X]: bx, [OWN]: A.save(A.from<any>({ traces: {}, recentTraceIds: [], engineId: 'ENGINE_a' })) }, [X, OWN])
        markOwnCommandLog(a.repo, OWN)
        const c = await startEngine('c', X, { [X]: bx })
        await connectEngine(c.repo, PEER_IP, 'a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
        await until(() => isEnginePeerOf(c, a), 10_000, 'c peered with a')
        expect(await findWithTimeout(consoleClient(c.port).repo, X)).toBe('ready')
        const con = consoleClient(c.port)
        expect(await findWithTimeout(con.repo, OWN)).toBe('ready')
        const ah = await a.repo.find<any>(OWN)
        const ch = await con.repo.find<any>(OWN)
        ah.change((d: any) => { d.recentTraceIds.push('before') })
        await until(() => (ch.doc()?.recentTraceIds ?? []).includes('before'), 10_000, 'live before the reconnect')
        // the link c -> a drops and the client adapter redials (as after a network blip)
        const adapter = network.connections[`${PEER_IP}:${a.port}` as IPAddress]!.adapter as any
        adapter.socket.close()
        await until(() => !isEnginePeerOf(c, a), 10_000, 'c lost a')
        await until(() => isEnginePeerOf(c, a), 20_000, 'c peered with a again')
        ah.change((d: any) => { d.recentTraceIds.push('after') })
        await until(() => (ch.doc()?.recentTraceIds ?? []).includes('after'), 15_000, 'Console view resynced after the reconnect')
    }, 90_000)

    it('engine#549 (2\'): the owner never reloads its own archived command logs that a peer still holds; archive files unchanged', async () => {
        const ARCH = newDocId()     // a's archived log, stamped (owned-to-owner push would send it back)
        const LEGACY = newDocId()   // a's archived log from before engine#471 (no engineId)
        const archDir = tmp('archive')
        const stamped = A.save(A.from<any>({ traces: {}, recentTraceIds: ['x'], engineId: 'ENGINE_a' }))
        const legacy = A.save(A.from<any>({ traces: {}, recentTraceIds: ['y'] }))
        const f1 = path.join(archDir, `command-log-2026-11-15-${ARCH}.automerge`)
        const f2 = path.join(archDir, `command-log-unknown-${LEGACY}.automerge`)
        fs.writeFileSync(f1, stamped); fs.writeFileSync(f2, legacy)
        fs.writeFileSync(path.join(archDir, 'notes.txt'), 'not an archive')
        const before = [fs.readFileSync(f1), fs.readFileSync(f2)]
        const mtimes = [fs.statSync(f1).mtimeMs, fs.statSync(f2).mtimeMs]
        // c (a peer) holds loaded copies of both, as idea01/idea04 did
        const c = await startEngine('c', X, { [X]: bx, [ARCH]: stamped, [LEGACY]: legacy }, [X, ARCH, LEGACY])
        const a = await startEngine('a', X, { [X]: bx }, [X], archDir)
        expect(isOwnArchivedCommandLog(a.repo, ARCH) && isOwnArchivedCommandLog(a.repo, LEGACY)).toBe(true)
        expect(isRefusedDoc(a.repo as any, X, ARCH)).toBe(true)
        expect(isOwnArchivedCommandLog(c.repo, ARCH), 'per Engine (Repo)').toBe(false)
        // both directions: c dials a (a's server guard) and a dials c (a's client guard)
        await connectEngine(c.repo, PEER_IP, 'a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
        await connectEngine(a.repo, PEER_IP, 'c' as Hostname, 'ENGINE_c' as EngineID, X, c.port as PortNumber)
        await until(() => isEnginePeerOf(c, a) && isEnginePeerOf(a, c), 10_000, 'a and c peered')
        // c announces its loaded docs again to the redialled peer: still nothing reaches a
        c.store.change((d: any) => { d.label = 'touched on c' })
        await until(() => a.store.doc().label === 'touched on c', 10_000, 'store still syncs')
        await sleep(2_000)
        expect(hasDoc(a, ARCH) || hasDoc(a, LEGACY), 'own archived logs not loaded on the owner').toBe(false)
        await a.repo.flush()
        expect(docDataOnDisk(a.dir, ARCH) || docDataOnDisk(a.dir, LEGACY), 'nothing written to store-data').toBe(false)
        // asked for by exact id (a Console on a): unavailable, not loaded
        expect(await findWithTimeout(consoleClient(a.port).repo, X)).toBe('ready')
        expect(await findWithTimeout(consoleClient(a.port).repo, ARCH, 4_000)).not.toBe('ready')
        expect(hasDoc(a, ARCH) && (a.repo.handles as any)[ARCH].isReady()).toBe(false)
        // archives on disk unchanged
        expect(fs.readFileSync(f1).equals(before[0]) && fs.readFileSync(f2).equals(before[1])).toBe(true)
        expect([fs.statSync(f1).mtimeMs, fs.statSync(f2).mtimeMs]).toEqual(mtimes)
        expect(fs.readdirSync(archDir).sort()).toEqual([path.basename(f2), path.basename(f1), 'notes.txt'].sort())
        // c's copies are untouched
        expect((await c.repo.find<any>(ARCH)).doc().recentTraceIds).toEqual(['x'])
    }, 90_000)

    it('engine#549: kits meet, separate and meet again: the shared store converges both ways; command logs stay on demand', async () => {
        const LA = newDocId(), LC = newDocId(), U = newDocId()
        const owned = (e: string) => A.save(A.from<any>({ traces: {}, recentTraceIds: [], engineId: e }))
        const a = await startEngine('a', X, { [X]: bx, [LA]: owned('ENGINE_a'), [U]: A.save(A.from<any>({ traces: {}, recentTraceIds: [] })) }, [X, LA, U])
        markOwnCommandLog(a.repo, LA)
        const c = await startEngine('c', X, { [X]: bx, [LC]: owned('ENGINE_c') }, [X, LC])
        markOwnCommandLog(c.repo, LC)
        const key = `${PEER_IP}:${a.port}` as IPAddress
        // meet
        await connectEngine(c.repo, PEER_IP, 'a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
        await until(() => isEnginePeerOf(c, a) && isEnginePeerOf(a, c), 10_000, 'kits met')
        a.store.change((d: any) => { d.fromA = 1 }); c.store.change((d: any) => { d.fromC = 1 })
        await until(() => a.store.doc().fromC === 1 && c.store.doc().fromA === 1, 15_000, 'store converged on meeting')
        // separate: each kit keeps working on the shared store
        ;(network.connections[key]!.adapter as any).disconnect()
        delete (network.connections as any)[key]
        await until(() => !isEnginePeerOf(c, a) && !isEnginePeerOf(a, c), 10_000, 'kits separated')
        a.store.change((d: any) => { d.whileApartA = 'a' }); c.store.change((d: any) => { d.whileApartC = 'c' })
        await sleep(500)
        expect(a.store.doc().whileApartC).toBeUndefined()
        // meet again
        await connectEngine(c.repo, PEER_IP, 'a' as Hostname, 'ENGINE_a' as EngineID, X, a.port as PortNumber)
        await until(() => a.store.doc().whileApartC === 'c' && c.store.doc().whileApartA === 'a', 15_000, 'store converged after meeting again')
        await sleep(1_000)
        expect(hasDoc(c, LA) || hasDoc(a, LC) || hasDoc(c, U), 'no command log pushed between the kits').toBe(false)
        // what a Console needs stays reachable on demand: the other kit's current log through the Engine it is connected to
        expect(await findWithTimeout(consoleClient(c.port).repo, X)).toBe('ready')
        expect(await findWithTimeout(consoleClient(c.port).repo, LA)).toBe('ready')
    }, 90_000)

    it('engine#549: archive file names -> document ids; other names ignored', () => {
        const id = '3iD2EAQRP7xEkBfM4ka5ic5GvWq9'
        expect(archivedCommandLogIds([
            `command-log-2026-11-15-${id}.automerge`, 'command-log-unknown-41RpatCHWCaWxEb3LJnwvcnEcfXy.automerge',
            'notes.txt', `command-log-2026-11-15-${id}.automerge.tmp`, 'command-log-x-short.automerge',
        ])).toEqual([id, '41RpatCHWCaWxEb3LJnwvcnEcfXy'])
    })

    it('engine#471 (a) / engine#549: shareCommandLogWith: own log never, another Engine\'s only with its owner, unowned (no engineId) never', () => {
        expect(shareCommandLogWith({ engineId: 'ENGINE_a' }, 'ENGINE_a', 'ENGINE_b')).toBe(false)
        expect(shareCommandLogWith({ engineId: 'ENGINE_b' }, 'ENGINE_a', 'ENGINE_b')).toBe(true)
        expect(shareCommandLogWith({ engineId: 'ENGINE_b' }, 'ENGINE_a', 'ENGINE_c')).toBe(false)
        expect(shareCommandLogWith({ engineId: 'ENGINE_b' }, 'ENGINE_a', undefined)).toBe(false)
        expect(shareCommandLogWith({ engineId: 'odd id' }, 'ENGINE_a', 'odd_id')).toBe(true)   // peerId character rule
        expect(shareCommandLogWith({}, 'ENGINE_a', 'ENGINE_c')).toBe(false)               // engine#549: owner unknown, not pushed
        expect(shareCommandLogWith({ engineId: '' }, 'ENGINE_a', 'ENGINE_c')).toBe(false)
        expect(isCommandLogContent({ traces: {}, recentTraceIds: [] })).toBe(true)
        expect(isCommandLogContent({ engineDB: {} })).toBe(false)
        const r1 = {}, r2 = {}
        markOwnCommandLog(r1, 'automerge:abc')
        expect(isOwnCommandLog(r1, 'abc')).toBe(true)
        expect(isOwnCommandLog(r2, 'abc'), 'per Engine (Repo), not per process').toBe(false)
    })

    it('mixed versions: an old Engine (no store tag) is refused whether it dials us or we dial it', async () => {
        const a = await startEngine('a', X, { [X]: bx })
        // old Engine = stock automerge-repo with storage, random peerId, share-everything policy;
        // it even holds OUR store X (an old Engine of the same fleet) plus a doc of its own
        const oldDir = tmp('old')
        const seed = new Repo({ network: [], storage: new NodeFSStorageAdapter(oldDir) })
        seed.import(bx, { docId: X })
        const O = seed.import(A.save(A.from<any>({ engineDB: { ENGINE_old: {} }, oldOnly: true }))).documentId
        await seed.flush()
        const oldPort = await freePort()
        const wss = new WebSocketServer({ port: oldPort })
        clients.push(() => new Promise<void>(r => wss.close(() => r())))
        const oldServer = new WebSocketServerAdapter(wss as any)
        const old = new Repo({ network: [oldServer], storage: new NodeFSStorageAdapter(oldDir), sharePolicy: async () => true })
        const oldX = await old.find<any>(X); await oldX.whenReady()
        oldX.change((d: any) => { d.oldEdit = true })
        await (await old.find(O)).whenReady()

        const cap = captureLogs()
        try {
            // we dial the old Engine: its 'peer' reply has no store tag -> refused; nothing it announces is taken
            await connectEngine(a.repo, PEER_IP, 'old' as Hostname, 'ENGINE_old' as EngineID, X, oldPort as PortNumber)
            await until(() => refusedPeers.get(`${PEER_IP}:${oldPort}`)?.verdict.kind === 'legacy-engine', 10_000, 'old server refused')
            // the old Engine dials us (stock client): refused at our server
            const oldClient = new WebSocketClientAdapter(`ws://127.0.0.1:${a.port}`, 500)
            old.networkSubsystem.addNetworkAdapter(oldClient)
            clients.push(() => { try { oldClient.disconnect() } catch { /* closed */ } })
            await until(() => a.server.refusals.some(r => r.verdict.kind === 'legacy-engine'), 10_000, 'old client refused')
            await sleep(2_000)
        } finally { cap.restore() }
        expect(a.store.doc().oldEdit).toBeUndefined()          // its edits to our store did not get in
        expect(hasDoc(a, O)).toBe(false)
        expect(docDataOnDisk(a.dir, O)).toBe(false)
        expect(peersOf(a).some(p => !p.startsWith('idea-engine/'))).toBe(false)
        expect(cap.lines.some(l => l.includes('REFUSED peer') && l.includes('no store id') && l.includes(`ours ${storeTag(X)}`))).toBe(true)
        // the old Engine redials every 500 ms here: the refusal is logged once, not per attempt
        const inboundLines = cap.lines.filter(l => l.includes('REFUSED peer inbound from'))
        expect(a.server.refusals.filter(r => r.verdict.kind === 'legacy-engine').length).toBeGreaterThan(1)
        expect(inboundLines.length).toBe(1)
    }, 60_000)

    it("the Engine's own peerId carries its store tag; a Console (storage-less) still connects and gets only what it asks for", async () => {
        const a = await startEngine('a', X, { [X]: bx })
        expect(parseEnginePeerId(String(a.repo.networkSubsystem.peerId))).toEqual({ storeTag: storeTag(X), engineId: 'ENGINE_a' })
        const con = consoleClient(a.port)
        expect(await findWithTimeout(con.repo, X)).toBe('ready')
        expect(a.server.refusals).toHaveLength(0)
    }, 30_000)

    it('a socket that skips the join cannot write: its sync message (carrying a change) is not applied', async () => {
        const a = await startEngine('a', X, { [X]: bx })
        // Build a sync message that carries a change to our store doc X
        let d1 = A.change(A.load<any>(bx), (d: any) => { d.sneaky = true })
        let d2 = A.load<any>(bx)
        let s1 = A.initSyncState(), s2 = A.initSyncState()
        let withChange: Uint8Array | undefined
        for (let i = 0; i < 10 && !withChange; i++) {
            let m1: Uint8Array | null; [s1, m1] = A.generateSyncMessage(d1, s1)
            if (m1 && A.decodeSyncMessage(m1).changes.length > 0) { withChange = m1; break }
            if (m1) [d2, s2] = A.receiveSyncMessage(d2, s2, m1)
            let m2: Uint8Array | null; [s2, m2] = A.generateSyncMessage(d2, s2)
            if (m2) [d1, s1] = A.receiveSyncMessage(d1, s1, m2)
        }
        expect(withChange).toBeDefined()
        const ws = new (await import('ws')).default(`ws://127.0.0.1:${a.port}`)
        await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })
        const got: any[] = []
        ws.on('message', (d: any) => got.push(cbor.decode(new Uint8Array(d))))
        ws.send(cbor.encode({ type: 'sync', senderId: 'sneaky', targetId: String(a.repo.networkSubsystem.peerId), documentId: X, data: withChange }))
        await sleep(1_500)
        ws.close()
        expect(a.store.doc().sneaky).toBeUndefined()
        expect(got).toHaveLength(0)
        expect(peersOf(a)).not.toContain('sneaky')
    }, 30_000)

    it('StoreScopedWebSocketClientAdapter never redials a server that refused it', async () => {
        const b = await startEngine('b', Y, { [Y]: by })
        const refusals: any[] = []
        const ad = new StoreScopedWebSocketClientAdapter(`ws://127.0.0.1:${b.port}`, { ownTag: storeTag(X), onRefused: r => refusals.push(r), retryInterval: 200 })
        const r = new Repo({ network: [ad], peerId: enginePeerId(X, 'ENGINE_probe') as PeerId, storage: new NodeFSStorageAdapter(tmp('probe')) })
        clients.push(async () => { try { await r.shutdown() } catch { /* closed */ } })
        await until(() => refusals.length > 0, 10_000, 'refusal')
        await sleep(1_500)
        expect(refusals).toHaveLength(1)
        expect(refusals[0]).toMatchObject({ by: 'remote', verdict: { kind: 'foreign-store', theirTag: storeTag(Y) } })
        expect(b.server.refusals).toHaveLength(1)   // one attempt only, no redial loop
    }, 30_000)
})
