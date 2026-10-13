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
import { DocHost, sharedDocHost } from '../duration/docHost.js'

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

afterAll(async () => { await sharedDocHost.stop() })

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
            expect(sharedDocHost.openChannels).toBe(6)
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
            expect(sharedDocHost.openChannels).toBe(6)
        } finally {
            clearInterval(timer)
            for (const l of links) await l.close()
            for (const r of readers) await r.close()
            for (const e of engines) await e.close()
        }
        console.log(JSON.stringify({ event: 'r86p_soak', peakRssMb: Math.round(peak / MB) }))
        expect(peak).toBeLessThan(1200 * MB)
    }, 240_000)
})
