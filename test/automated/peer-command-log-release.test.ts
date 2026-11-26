/**
 * engine#581: other Engines' command logs leave the Repo cache when no client reads
 * them (src/data/PeerCommandLogRelease.ts). Real Repos: an Engine-like Repo with
 * NodeFS storage and a WS server, and a storage-less Console-like client.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { WebSocketServer } from 'ws'
import { Repo, DocumentId, PeerId } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { WebSocketClientAdapter, WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { markOwnCommandLog } from '../../src/data/StoreScope.js'
import { peerCommandLogIds, releaseFromCache, sweepPeerCommandLogs, startPeerCommandLogRelease, PEER_COMMAND_LOG_IDLE_MS, PEER_COMMAND_LOG_SWEEP_MS } from '../../src/data/PeerCommandLogRelease.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()!() } catch { /* closed */ } } })

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idea-cmdlog-release-'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (cond: () => boolean, ms = 10_000, what = 'condition') => {
    const end = Date.now() + ms
    while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await sleep(25) }
}
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})
const peerLog = (engineId: string, n = 3) => ({ engineId, storeTag: 't', traces: Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, { command: `c${i}` }])), recentTraceIds: Array.from({ length: n }, (_, i) => `t${i}`) })
const has = (repo: Repo, id: string) => id in (repo.handles as any)

/** An Engine-like Repo with storage; docs seeded through a first Repo on the same dir (as on disk after an earlier fetch). */
const engine = async (seed: Record<string, any>, withServer = false) => {
    const dir = tmp()
    const s = new Repo({ network: [], storage: new NodeFSStorageAdapter(dir) })
    const ids: Record<string, DocumentId> = {}
    for (const [k, v] of Object.entries(seed)) ids[k] = s.create<any>(v).documentId
    await s.flush(); await s.shutdown()
    let port = 0, wss: WebSocketServer | undefined
    const network: any[] = []
    if (withServer) {
        port = await freePort()
        wss = new WebSocketServer({ port })
        network.push(new WebSocketServerAdapter(wss as any))
    }
    const repo = new Repo({ network, storage: new NodeFSStorageAdapter(dir), peerId: 'engine-test' as PeerId, sharePolicy: async () => false })
    cleanups.push(async () => { await repo.shutdown(); wss?.close(); fs.rmSync(dir, { recursive: true, force: true }) })
    return { repo, ids, port, dir }
}

describe('PeerCommandLogRelease (engine#581)', () => {
    it('releases an idle peer command log, keeps own logs and the store doc, and the copy loads again from storage', async () => {
        const { repo, ids } = await engine({ store: { engineDB: {}, instanceDB: {} }, own: peerLog('ENGINE_me'), peer: peerLog('ENGINE_peer', 5) })
        markOwnCommandLog(repo, ids.own)
        for (const id of Object.values(ids)) await (await repo.find<any>(id)).whenReady()
        expect(peerCommandLogIds(repo)).toEqual([ids.peer])
        let t = 1_000_000
        const lines: string[] = []
        const seen = new Map<string, number>()
        const opts = { now: () => t, sink: (l: string) => lines.push(l) }
        expect(await sweepPeerCommandLogs(repo, seen, opts)).toEqual([])     // first seen
        t += PEER_COMMAND_LOG_IDLE_MS - 1
        expect(await sweepPeerCommandLogs(repo, seen, opts)).toEqual([])     // not idle long enough
        t += 1
        expect(await sweepPeerCommandLogs(repo, seen, opts)).toEqual([ids.peer])
        expect(has(repo, ids.peer)).toBe(false)
        expect(has(repo, ids.own) && has(repo, ids.store)).toBe(true)
        expect(lines.join('\n')).toMatch(/\[cmdlog-release\] released 1 peer command log\(s\) idle >= 10 min; 0 still loaded/)
        t += 10 * PEER_COMMAND_LOG_IDLE_MS
        expect(await sweepPeerCommandLogs(repo, seen, opts)).toEqual([])     // own log and store doc never released
        // offline-first: still in store-data, served again on the next find
        const again = await repo.find<any>(ids.peer); await again.whenReady()
        expect(Object.keys(again.doc().traces)).toHaveLength(5)
        expect(again.doc().engineId).toBe('ENGINE_peer')
    })

    it('keeps a peer command log while a storage-less client syncs it; releases it once the client has been gone for idleMs', async () => {
        const { repo, ids, port } = await engine({ peer: peerLog('ENGINE_peer') }, true)
        const client = new Repo({ network: [new WebSocketClientAdapter(`ws://127.0.0.1:${port}`, 500)], peerId: 'console-test' as PeerId })
        cleanups.push(() => client.shutdown())
        await until(() => client.peers.length > 0, 10_000, 'client connected')
        const ch = await client.find<any>(ids.peer); await ch.whenReady()
        expect(ch.doc().engineId).toBe('ENGINE_peer')
        expect(has(repo, ids.peer)).toBe(true)
        let t = 0
        const seen = new Map<string, number>()
        const opts = { now: () => t, sink: () => undefined }
        await sweepPeerCommandLogs(repo, seen, opts)
        t += 5 * PEER_COMMAND_LOG_IDLE_MS
        expect(await sweepPeerCommandLogs(repo, seen, opts)).toEqual([])     // client on it: kept
        expect(seen.get(ids.peer)).toBe(t)
        await client.shutdown()
        await until(() => repo.peers.length === 0, 10_000, 'client gone')
        t += PEER_COMMAND_LOG_IDLE_MS - 1
        expect(await sweepPeerCommandLogs(repo, seen, opts)).toEqual([])
        t += 1
        expect(await sweepPeerCommandLogs(repo, seen, opts)).toEqual([ids.peer])
        expect(has(repo, ids.peer)).toBe(false)
    })

    it('a change received while loaded is on disk after the release (flush before removeFromCache)', async () => {
        const { repo, ids, dir } = await engine({ peer: peerLog('ENGINE_peer') })
        const h = await repo.find<any>(ids.peer); await h.whenReady()
        h.change((d: any) => { d.traces.late = { command: 'late' }; d.recentTraceIds.push('late') })
        let t = 0
        const seen = new Map<string, number>()
        await sweepPeerCommandLogs(repo, seen, { now: () => t })
        t += PEER_COMMAND_LOG_IDLE_MS
        expect(await sweepPeerCommandLogs(repo, seen, { now: () => t, sink: () => undefined })).toEqual([ids.peer])
        await sleep(1_000)
        const r2 = new Repo({ network: [], storage: new NodeFSStorageAdapter(dir) })
        cleanups.push(() => r2.shutdown())
        const h2 = await r2.find<any>(ids.peer); await h2.whenReady()
        expect(h2.doc().traces.late).toEqual({ command: 'late' })
    })

    it('the stored copy survives the release (plain repo.removeFromCache would save the empty unloaded doc over it)', async () => {
        const { repo, ids, dir } = await engine({ peer: peerLog('ENGINE_peer', 4) })
        await (await repo.find<any>(ids.peer)).whenReady()
        await repo.flush([ids.peer])
        await releaseFromCache(repo, ids.peer)
        expect(has(repo, ids.peer)).toBe(false)
        await sleep(1_000)                                                  // past the Repo's save debounce
        const r2 = new Repo({ network: [], storage: new NodeFSStorageAdapter(dir) })
        cleanups.push(() => r2.shutdown())
        const h2 = await r2.find<any>(ids.peer); await h2.whenReady()
        expect(Object.keys(h2.doc().traces)).toHaveLength(4)
        expect(h2.doc().engineId).toBe('ENGINE_peer')
        await releaseFromCache(repo, 'not-loaded')                          // no handle: no-op
    })

    it('startPeerCommandLogRelease sweeps on its interval and stop() ends it; defaults are 10 min idle, 1 min sweep', async () => {
        expect(PEER_COMMAND_LOG_IDLE_MS).toBe(600_000)
        expect(PEER_COMMAND_LOG_SWEEP_MS).toBe(60_000)
        const { repo, ids } = await engine({ peer: peerLog('ENGINE_peer') })
        await (await repo.find<any>(ids.peer)).whenReady()
        const stop = startPeerCommandLogRelease(repo, { idleMs: 0, sweepMs: 50, sink: () => undefined })
        await until(() => !has(repo, ids.peer), 5_000, 'released by the timer')
        await stop()
    })
})
