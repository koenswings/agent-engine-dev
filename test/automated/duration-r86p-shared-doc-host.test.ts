/**
 * r86o (cover-all-stage2-20228d3-r86o): FAIL step=42 source=rss-guard — idea02 MemAvailable 297 MB
 * (floor 300 MB), walker RSS 2.52 GB. LOOPLAG threads: 2 store + 3 CommandLog workers, each holding its
 * own Automerge WASM (external 535-549 MB each, CommandLog idea03 200 MB, idea04 46 MB).
 * Steve: stop paying ~550 MB of WASM per link; target walker RSS < 1.2 GB; do NOT lower the floor.
 * r86p: every store link and CommandLog reader runs as a channel on ONE shared doc-host worker.
 * These tests pin: one host thread for all links (incl. a store-link replacement), sessions still
 * sync/read/write, closing a channel leaves the others alive, the host is recycled when idle, and a
 * walk-shaped soak (3 Engines × store + CommandLog, link churn) keeps the walker RSS under 1.2 GB.
 */
import { afterAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { Repo, type PeerId } from '@automerge/automerge-repo'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { StoreDocLink } from '../duration/storeDocLink.js'
import { CommandLogReader } from '../duration/commandLogReader.js'
import { DocHost, sharedDocHost, sharedCommandLogHost } from '../duration/docHost.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const MB = 1048576

const startEngine = async (name: string, ops: number, clTraces: number) => {
    const server = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    const repo = new Repo({ network: [new WebSocketServerAdapter(wss as never)], peerId: `fake-${name}-${Date.now()}` as PeerId, sharePolicy: async () => false })
    const store = repo.create<Record<string, any>>({ engineDB: {}, instanceDB: {}, diskDB: {}, appDB: {}, networkDB: {}, userDB: {}, operationDB: {} })
    store.change(d => {
        d.engineDB[name] = { id: name, hostname: name, commands: [] }
        for (let i = 0; i < ops; i++) d.operationDB[`op${i}`] = { id: `op${i}`, kind: 'copyApp', status: 'Done', args: { a: `x${i}`.repeat(8) } }
    })
    for (let k = 0; k < 10; k++) store.change(d => { for (let i = k; i < ops; i += 10) d.operationDB[`op${i}`].status = `s${k}` })
    const cl = repo.create<Record<string, any>>({ traces: {}, recentTraceIds: [] })
    for (let b = 0; b < clTraces; b += 50) cl.change(d => {
        for (let i = b; i < Math.min(clTraces, b + 50); i++) {
            d.traces[`t${i}`] = { traceId: `t${i}`, command: 'copyApp', args: `kolibri disk-${i}`, status: 'ok', startedAt: i, completedAt: i + 1, logs: Array.from({ length: 6 }, (_, j) => ({ msg: `line ${j} of ${i} `.repeat(4) })) }
            d.recentTraceIds.push(`t${i}`)
        }
    })
    const sockets: any[] = []
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => { sockets.push(ws); wss.emit('connection', ws, req) }))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    return {
        name, url: `ws://127.0.0.1:${port}`, store, cl,
        /** Engine-side WS close of every open socket (the client adapter reconnects itself). */
        /** Stop reading every open socket without closing it: the walker's peer stays listed and its
         *  socket stays OPEN, but nothing (no ping) is answered any more — a stale peer, as in the pool. */
        freezeSockets: () => { for (const s of sockets) { try { (s as any)._socket.pause() } catch { /* */ } } },
        dropSockets: () => { for (const s of sockets.splice(0)) { try { s.terminate() } catch { /* */ } } },
        close: async () => { for (const s of sockets) { try { s.terminate() } catch { /* */ } } await repo.shutdown().catch(() => {}); wss.close(); await new Promise<void>(r => server.close(() => r())) },
    }
}

const openStore = (e: { name: string; url: string; store: { documentId: string } }) =>
    new StoreDocLink({ logicalId: e.name, url: e.url, docId: String(e.store.documentId), deadline: Date.now() + 60_000, handshakeMs: 10_000, log: () => {} })

const listSoon = async (r: CommandLogReader, min: number) => {
    const until = Date.now() + 60_000
    while (Date.now() < until) {
        try { const t = await r.list(5_000); if (t.length >= min) return t } catch { /* not synced yet */ }
        await sleep(200)
    }
    throw new Error(`CommandLog of ${r.engine} not readable`)
}

afterAll(async () => { await sharedDocHost.stop(); await sharedCommandLogHost.stop() })

describe('r86p: one shared doc-host worker for all walker Automerge links', () => {
    it('store links + CommandLog readers share ONE host thread; read, write and replace a link', async () => {
        delete process.env.DURATION_DOC_HOST
        const engines = await Promise.all(['idea01', 'idea03', 'idea04'].map(n => startEngine(n, 300, 60)))
        const startsBefore = sharedDocHost.starts
        const links = engines.map(openStore)
        const readers = engines.map(e => new CommandLogReader(e.name, e.url, e.cl.url, () => {}))
        try {
            for (const l of links) expect((await l.outcome()).kind).toBe('ready')
            for (const r of readers) expect((await listSoon(r, 60)).length).toBe(60)
            expect(sharedDocHost.starts - startsBefore).toBeLessThanOrEqual(1)
            // r86q: store links on one host, CommandLog readers on their own (separate threads)
            expect(sharedDocHost.openChannels).toBe(3)
            expect(sharedCommandLogHost.openChannels).toBe(3)
            expect(sharedCommandLogHost.threadId).not.toBe(sharedDocHost.threadId)
            expect((links[0].doc() as any)?.engineDB?.idea01?.hostname).toBe('idea01')
            // a write still reaches the Engine
            await links[1].change(s => { (s as any).engineDB.idea03.commands.push('ejectDisk d1') })
            for (let i = 0; i < 50 && engines[1].store.doc()?.engineDB?.idea03?.commands?.length !== 1; i++) await sleep(100)
            expect(engines[1].store.doc()?.engineDB?.idea03?.commands).toEqual(['ejectDisk d1'])
            // replace idea01's link (walk: reconnect after copy_app): others stay alive, same host thread
            const tid = sharedDocHost.threadId
            await links[0].close('replaced')
            expect(links[2].alive).toBe(true)
            links[0] = openStore(engines[0])
            expect((await links[0].outcome()).kind).toBe('ready')
            expect(sharedDocHost.threadId).toBe(tid)
            expect(readers.every(r => r.alive)).toBe(true)
        } finally {
            for (const l of links) await l.close()
            for (const r of readers) await r.close()
            for (const e of engines) await e.close()
        }
        expect(sharedDocHost.openChannels).toBe(0)
        expect(sharedCommandLogHost.openChannels).toBe(0)
    }, 120_000)

    it('the host is recycled once idle and restarts on the next open', async () => {
        const host = new DocHost(undefined, 50)
        const e = await startEngine('idea01', 10, 2)
        try {
            const ch = host.open('commandLog', { wsUrl: e.url, docUrl: e.cl.url, peerId: 'p1', memEveryMs: 0 })
            const exited = new Promise<number>(r => ch.once('exit', r))
            ch.postMessage({ type: 'shutdown' })
            await exited
            await sleep(300)
            expect(host.running).toBe(false)
            host.open('commandLog', { wsUrl: e.url, docUrl: e.cl.url, peerId: 'p2', memEveryMs: 0 })
            expect(host.running).toBe(true)
            expect(host.starts).toBe(2)
        } finally { await host.stop(); await e.close() }
    }, 30_000)

    it('soak: 3 Engines × (store + CommandLog), 6 link churns — walker RSS stays under 1.2 GB', async () => {
        delete process.env.DURATION_DOC_HOST
        const engines = await Promise.all(['idea01', 'idea03', 'idea04'].map((n, i) => startEngine(n, 1500, [500, 150, 40][i])))
        const links = engines.map(openStore)
        const readers = engines.map(e => new CommandLogReader(e.name, e.url, e.cl.url, () => {}))
        let peak = 0
        const sample = () => { peak = Math.max(peak, process.memoryUsage().rss) }
        const timer = setInterval(sample, 100)
        try {
            for (const l of links) expect((await l.outcome()).kind).toBe('ready')
            await Promise.all(readers.map((r, i) => listSoon(r, [500, 150, 40][i])))
            for (let k = 0; k < 6; k++) {
                const i = k % 3
                await links[i].close('churn')
                links[i] = openStore(engines[i])
                expect((await links[i].outcome()).kind).toBe('ready')
                engines[i].cl.change(d => { d.traces[`c${k}`] = { traceId: `c${k}`, command: 'moveApp', status: 'ok', startedAt: k } })
                sample()
            }
            expect(sharedDocHost.openChannels + sharedCommandLogHost.openChannels).toBe(6)
        } finally {
            clearInterval(timer)
            for (const l of links) await l.close()
            for (const r of readers) await r.close()
            for (const e of engines) await e.close()
        }
        console.log(JSON.stringify({ event: 'r86p_soak', peakRssMb: Math.round(peak / MB) }))
        expect(peak).toBeLessThan(1200 * MB)
    }, 240_000)

    it('r86q: WS close + reconnect on the shared host — the existing handle re-attaches, doc ready again, worker answers', async () => {
        delete process.env.DURATION_DOC_HOST
        const e = await startEngine('idea01', 300, 5)
        const other = await startEngine('idea03', 50, 1)
        const link = openStore(e)
        const bystander = openStore(other)
        const peers: number[] = []
        try {
            expect((await link.outcome()).kind).toBe('ready')
            expect((await bystander.outcome()).kind).toBe('ready')
            expect(await link.reattach(5_000)).toBe(true) // healthy link: answers at once
            e.dropSockets() // Engine-side close (r86p: idea01 WS closed during copyApp)
            for (let i = 0; i < 50 && link.peerCount > 0; i++) await sleep(50)
            expect(link.peerCount).toBe(0)
            peers.push(link.peerCount)
            // the Engine changes the store while the walker is disconnected
            e.store.change(d => { d.engineDB.idea01.commands.push('copyApp kolibri') })
            // re-attach the SAME session (no new Repo, no fresh doc wait): adapter reconnects (2 s), handle re-syncs
            const t0 = Date.now()
            expect(await link.reattach(20_000)).toBe(true)
            expect(link.lastReattachError).toBeNull()
            expect(Date.now() - t0).toBeLessThan(15_000)
            expect(link.alive).toBe(true)
            expect(link.peerCount).toBeGreaterThan(0)
            for (let i = 0; i < 50 && (link.doc() as any)?.engineDB?.idea01?.commands?.length !== 1; i++) await sleep(100)
            expect((link.doc() as any).engineDB.idea01.commands).toEqual(['copyApp kolibri'])
            // writes go through the re-attached handle
            await link.change(s => { (s as any).engineDB.idea01.commands.push('ejectDisk d2') })
            for (let i = 0; i < 50 && e.store.doc()?.engineDB?.idea01?.commands?.length !== 2; i++) await sleep(100)
            expect(e.store.doc()?.engineDB?.idea01?.commands).toEqual(['copyApp kolibri', 'ejectDisk d2'])
            expect(bystander.alive).toBe(true)
            expect(sharedDocHost.unresponsiveMs()).toBeLessThan(5_000)
        } finally {
            await link.close(); await bystander.close(); await e.close(); await other.close()
        }
    }, 60_000)

    it('r86q: reattach always answers — false with a reason when the Engine stays down', async () => {
        const e = await startEngine('idea04', 20, 1)
        const link = openStore(e)
        try {
            expect((await link.outcome()).kind).toBe('ready')
            await e.close()
            const t0 = Date.now()
            expect(await link.reattach(1_500)).toBe(false)
            expect(Date.now() - t0).toBeLessThan(4_000)
            expect(link.lastReattachError).toMatch(/reattach: no WS peer/)
        } finally { await link.close() }
    }, 30_000)

    it('c2cbdb0: a listed peer whose socket does not answer a ping is not a reattach', async () => {
        const e = await startEngine('idea03', 20, 1)
        const link = openStore(e)
        try {
            expect((await link.outcome()).kind).toBe('ready')
            expect(await link.reattach(5_000)).toBe(true) // live socket answers the ping
            e.freezeSockets() // peer still in repo.peers, socket still OPEN, but no pong comes back
            expect(link.peerCount).toBeGreaterThan(0)
            expect(await link.reattach(1_500)).toBe(false) // before c2cbdb0: true on the stale peer entry
            expect(link.lastReattachError).toMatch(/reattach: /)
        } finally { await link.close(); await e.close() }
    }, 30_000)

    it('r86q: a blocked host thread is named (heartbeat), not reported as a plain sync stall', async () => {
        const host = new DocHost(new URL('data:text/javascript,' + encodeURIComponent(
            "import { parentPort } from 'node:worker_threads'; parentPort.on('message', m => { if (m?.type === 'ping') parentPort.postMessage({ pong: m.t }); if (m?.type === 'block') { const u = Date.now() + 2500; while (Date.now() < u); } })")), 50, 100, 'test-host')
        try {
            host.open('store', {})
            await sleep(300)
            expect(host.unresponsiveMs()).toBeLessThan(1_000)
            host.send({ type: 'block' })
            await sleep(1_500)
            expect(host.unresponsiveMs()).toBeGreaterThan(1_000)
            await sleep(1_500)
            expect(host.unresponsiveMs()).toBeLessThan(1_000)
        } finally { await host.stop() }
    }, 20_000)
})
