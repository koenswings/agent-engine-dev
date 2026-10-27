/**
 * r86l (cover-all-stage2-942b95f-r86l): FAIL step=42 source=loop-watchdog, loop blocked 150 s, walker
 * RSS 2.04 GB with 674 MB available on idea02. copy_app was Done in 25.7 s and the (r86k) off-thread
 * CommandLog readers synced fine; the block was the next main-thread store-doc connect to idea01
 * ("Connecting idea01 … doc 3zoqd"): the full first sync of the store applied on the walker's main
 * thread. Steve: move ALL walker Automerge into worker threads; RSS sampling + soft RSS guard.
 * These tests pin:
 *  - the store doc is synced in a worker; the main thread holds a JSON snapshot only and its event
 *    loop stays responsive during a heavy first sync;
 *  - writes go to the worker as JSON ops (a list push stays a push) under a wall-clock timeout,
 *    and a failed write still ends in StoreWriteError via changeStore;
 *  - the soft RSS guard FAILs loud (RESULT.txt source=rss-guard) and RSS samples land in LOOPLAG.jsonl.
 */
import { PI_TIMING_FACTOR } from '../harness/hostEnv.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stallIt } from '../harness/stallGuard.js'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { Repo, type PeerId, type DocHandle } from '@automerge/automerge-repo'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { RealFleetOps, StoreWriteError } from '../duration/realFleetOps.js'
import { diffOps, liveStoreLinks } from '../duration/storeDocLink.js'
import { resetTimeoutGuard, setGuardIo } from '../duration/automergeTimeoutGuard.js'
import { _resetVerdictState, setCurrentStep, startLoopWatchdog, startMemSampler } from '../duration/verdict.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const startEngine = async (seed: (d: Record<string, any>) => void) => {
    const server = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    const repo = new Repo({ network: [new WebSocketServerAdapter(wss as never)], peerId: `fake-engine-${Date.now()}` as PeerId, sharePolicy: async () => false })
    const handle = repo.create<Record<string, any>>({ engineDB: {}, instanceDB: {}, diskDB: {}, appDB: {}, networkDB: {}, userDB: {}, operationDB: {} })
    handle.change(d => seed(d))
    const sockets: any[] = []
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => { sockets.push(ws); wss.emit('connection', ws, req) }))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    return {
        port: (server.address() as net.AddressInfo).port, handle: handle as DocHandle<Record<string, any>>, docUrl: handle.url,
        close: async () => { for (const s of sockets) { try { s.terminate() } catch { /* */ } } await repo.shutdown().catch(() => {}); wss.close(); await new Promise<void>(r => server.close(() => r())) },
    }
}

const mkOps = (port: number, docUrl: string) => new RealFleetOps({
    poolEngines: ['idea01'], hosts: { idea01: '127.0.0.1' }, enginePort: port, storeUrls: { idea01: docUrl },
    wsHandshakeTimeoutMs: 3_000, docWaitMs: 30_000, onOwnStoreStall: () => {}, storeInWorker: true,
})

beforeEach(() => {
    resetTimeoutGuard()
    setGuardIo({ log: () => {}, error: () => {}, exit: code => { throw new Error(`unexpected exit ${code}`) } })
    process.env.DURATION_ENGINE_HTTP_PORT = '1'
})
afterEach(() => { setGuardIo(null); _resetVerdictState() })

describe('r86l: JSON ops for store writes', () => {
    it('a command push stays a list push; deletes and sets are minimal', () => {
        const a = { engineDB: { E: { commands: ['x'] } }, instanceDB: { i1: { s: 1 }, i2: { s: 2 } }, diskDB: { d: { diskTypes: ['app'] } } }
        const b = structuredClone(a)
        b.engineDB.E.commands.push('ejectDisk d')
        delete (b.instanceDB as any).i1
        b.diskDB.d.diskTypes = ['empty']
        expect(diffOps(a, b)).toEqual([
            { op: 'push', path: ['engineDB', 'E', 'commands'], values: ['ejectDisk d'] },
            { op: 'del', path: ['instanceDB', 'i1'] },
            { op: 'set', path: ['diskDB', 'd', 'diskTypes'], value: ['empty'] },
        ])
        expect(diffOps(a, structuredClone(a))).toEqual([])
    })
})

describe('r86l: store doc synced off the main thread', () => {
    stallIt('heavy first sync: main loop stays responsive; reads see the snapshot; a write reaches the Engine', async () => {
        // ~4k operationDB rows with history: a first sync that costs real WASM time.
        const fe = await startEngine(d => {
            d.engineDB.E1 = { id: 'E1', hostname: 'idea01', commands: [] }
            for (let i = 0; i < 4000; i++) d.operationDB[`op${i}`] = { id: `op${i}`, kind: 'copyApp', status: 'Done', args: { a: `x${i}`.repeat(8) } }
        })
        for (let k = 0; k < 20; k++) fe.handle.change(d => { for (let i = k; i < 4000; i += 20) d.operationDB[`op${i}`].status = `s${k}` })
        const ops = mkOps(fe.port, fe.docUrl)
        let maxLag = 0
        let last = performance.now()
        const tick = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 10); last = now }, 10)
        try {
            const view = await ops.readStore('idea01')
            clearInterval(tick)
            expect(Object.keys((await ops.listOperations('idea01')))).toHaveLength(4000)
            expect(view).toBeTruthy()
            expect(ops.isWsOpen('idea01')).toBe(true)
            // 250 ms on the box; a Pi 4 under the full parallel suite measured 304 ms (on-Pi triage
            // idea04 2026-10-25). A main-thread first sync costs seconds there, so 2x still catches it.
            expect(maxLag).toBeLessThan(250 * PI_TIMING_FACTOR)
            console.log(JSON.stringify({ event: 'r86l_test_main_lag', maxLagMs: Math.round(maxLag) }))
            // write: ejectDisk-like push through changeStore
            const conn = (ops as any).conns.get('idea01')
            await ops.changeStore('idea01', conn, 'test push', s => { (s.engineDB as any).E1.commands.push('ejectDisk duration-empty-001') })
            for (let i = 0; i < 50 && fe.handle.doc()!.engineDB.E1.commands.length === 0; i++) await sleep(50)
            expect([...fe.handle.doc()!.engineDB.E1.commands]).toEqual(['ejectDisk duration-empty-001'])
            // engine-side change reaches the main-thread snapshot
            fe.handle.change(d => { d.engineDB.E1.lastRun = 42 })
            for (let i = 0; i < 60 && (ops as any).conns.get('idea01').storeHandle.doc()?.engineDB.E1.lastRun !== 42; i++) await sleep(50)
            expect((ops as any).conns.get('idea01').storeHandle.doc()?.engineDB.E1.lastRun).toBe(42)
            const mem = ops.threadMem()
            expect(Array.isArray(mem)).toBe(true)
        } finally {
            clearInterval(tick)
            await ops.close()
            await fe.close()
        }
        expect(liveStoreLinks.size).toBe(0)
    }, 60_000)

    stallIt('a write the worker cannot make (Engine gone) ends in StoreWriteError, never a silent warn', async () => {
        const fe = await startEngine(d => { d.engineDB.E1 = { id: 'E1', hostname: 'idea01', commands: [] } })
        const ops = mkOps(fe.port, fe.docUrl)
        try {
            await ops.readStore('idea01')
            const conn = (ops as any).conns.get('idea01')
            await fe.close() // Engine down: WS drops, reconnect cannot sync
            for (let i = 0; i < 40 && ops.isWsOpen('idea01'); i++) await sleep(50)
            ;(ops as any).wsHandshakeTimeoutMs = 500
            ;(ops as any).docWaitOpt = 15_000
            await expect(ops.changeStore('idea01', conn, 'ejectDisk duration-empty-001', s => { (s.engineDB as any).E1.commands.push('x') }))
                .rejects.toBeInstanceOf(StoreWriteError)
        } finally {
            await ops.close()
        }
    }, 60_000)
})

describe('r86l: RSS sampling + soft RSS guard', () => {
    it('RSS above the soft limit → FAIL source=rss-guard with step and memory', async () => {
        const d = mkdtempSync(join(tmpdir(), 'r86l-'))
        writeFileSync(join(d, 'run.log'), '')
        setCurrentStep(43)
        const wd = startLoopWatchdog({ dir: d, stallMs: 60_000, lagLogMs: 5_000, beatMs: 50, noKill: true, rssLimitMb: 1, memAvailMinMb: 0, rssSampleMs: 100 })
        const m = await new Promise<{ source: string; reason: string }>(r => wd.worker.on('message', r))
        await wd.stop()
        expect(m.source).toBe('rss-guard')
        expect(m.reason).toMatch(/walker RSS \d+ MB reached the soft limit 1 MB at step 43/)
        expect(readFileSync(join(d, 'RESULT.txt'), 'utf8')).toMatch(/^FAIL step=43 source=rss-guard/)
        expect(readFileSync(join(d, 'LOOPLAG.jsonl'), 'utf8')).toMatch(/"kind":"rss".*"rssKb":\d+/)
    }, 15_000)

    it('no breach: periodic rss rows only, no verdict; thread sampler writes main + workers', async () => {
        const d = mkdtempSync(join(tmpdir(), 'r86l-'))
        const wd = startLoopWatchdog({ dir: d, stallMs: 60_000, lagLogMs: 5_000, beatMs: 50, noKill: true, rssLimitMb: 100_000, memAvailMinMb: 0, rssSampleMs: 100 })
        const stop = startMemSampler(d, () => [{ thread: 'store:idea01', heapUsedMb: 5, externalMb: 1, arrayBuffersMb: 1 }], 100)
        await sleep(1_300) // watchdog ticks once a second
        stop(); await wd.stop()
        const rows = readFileSync(join(d, 'LOOPLAG.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
        expect(rows.some(r => r.kind === 'rss' && r.rssKb > 0)).toBe(true)
        expect(rows.find(r => r.kind === 'threads')).toMatchObject({ main: { rssMb: expect.any(Number) }, workers: [{ thread: 'store:idea01' }] })
        expect(() => readFileSync(join(d, 'RESULT.txt'))).toThrow()
    }, 15_000)
})
