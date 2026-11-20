/**
 * Step 91 (random-mixed bf8ef1a-7cbaf60 Markov, seed 42, infra_reboot_engine on idea03):
 * "RealFleetOps: idea03 WS not up after pm2 restart (waited 150000ms)" after 194 s, while the WS was OPEN every
 * time: the Engine's event loop was blocked ~63 s of its first ~75 s ([loop-stall] lines), and the walker's
 * fresh first sync of the big store doc needs 25–37 s; a 45 s doc wait ended each of 3 attempts mid-sync.
 *
 *  - post-restart store-ready gets REBOOT_DOC_WAIT_MS (120 s), also over a global DURATION_DOC_WAIT_MS=45000;
 *  - the abort text says WHICH stage failed (store not ready over an open WS vs WS not up) with real counters;
 *  - WS-up and store-ready are measured apart; the failure stays loud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stallIt } from '../harness/stallGuard.js'
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { Repo, type PeerId } from '@automerge/automerge-repo'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { PM2_RECONNECT_TIMEOUT_MS, REBOOT_DOC_WAIT_MS, RealFleetOps } from '../duration/realFleetOps.js'
import { resetTimeoutGuard, setGuardIo } from '../duration/automergeTimeoutGuard.js'
import type { SettleReady } from '../duration/types.js'

const HOSTS = { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' }
const savedEnv = { ...process.env }
beforeEach(() => {
    resetTimeoutGuard()
    setGuardIo({ log: () => {}, error: () => {}, exit: code => { throw new Error(`unexpected exit ${code}`) } })
    process.env.DURATION_ENGINE_HTTP_PORT = '1'
})
afterEach(() => {
    setGuardIo(null)
    process.env = { ...savedEnv }
    vi.restoreAllMocks()
})

const inWindow = (o: RealFleetOps, id: string) => (o as unknown as { rebootWindow: Set<string> }).rebootWindow.add(id)

describe('step 91: post-restart store-ready budget', () => {
    it('inside the reboot window the doc wait is 120 s even with the run\'s global DURATION_DOC_WAIT_MS=45000', () => {
        process.env.DURATION_DOC_WAIT_MS = '45000'
        process.env.DURATION_DOC_WAIT_MS_IDEA04 = '120000'
        const o = new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        expect(o.docWaitMsFor('idea03')).toBe(45_000) // outside a window: unchanged
        inWindow(o, 'idea03')
        expect(o.docWaitMsFor('idea03')).toBe(REBOOT_DOC_WAIT_MS)
        expect(REBOOT_DOC_WAIT_MS).toBe(120_000)
        expect(o.docWaitMsFor('idea01')).toBe(45_000) // another engine, no window
    })
    it('a bigger per-host value is never lowered; env and opts can change the reboot wait; pinned test waits stay pinned', () => {
        process.env.DURATION_REBOOT_DOC_WAIT_MS = '90000'
        const o = new RealFleetOps({ poolEngines: ['idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        inWindow(o, 'idea03'); inWindow(o, 'idea04')
        expect(o.docWaitMsFor('idea03')).toBe(90_000)
        expect(o.docWaitMsFor('idea04')).toBe(120_000) // idea04's own 120 s stays
        delete process.env.DURATION_REBOOT_DOC_WAIT_MS
        const o2 = new RealFleetOps({ poolEngines: ['idea03'], hosts: HOSTS, storeMode: 'shared', rebootDocWaitMs: 70_000 })
        inWindow(o2, 'idea03')
        expect(o2.docWaitMsFor('idea03')).toBe(70_000)
        const o3 = new RealFleetOps({ poolEngines: ['idea03'], hosts: HOSTS, storeMode: 'shared', docWaitMs: 1_000 })
        inWindow(o3, 'idea03')
        expect(o3.docWaitMsFor('idea03')).toBe(1_000)
    })
    it('the pm2-restart wait budget covers Engine bring-up (~75 s) + a fresh sync (25–37 s) with room for a second attempt', () => {
        expect(PM2_RECONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * REBOOT_DOC_WAIT_MS)
    })
})

describe('step 91: accurate abort label', () => {
    const msg = (r: SettleReady) =>
        new RealFleetOps({ poolEngines: ['idea03'], hosts: HOSTS, storeMode: 'shared' }).reconnectFailureMessage('idea03', r, 'pm2 restart', 300_000)
    it('store not ready over an open WS is NOT labelled "WS not up"', () => {
        const m = msg({
            wsUp: false, storeSynced: false, failure: 'store-not-ready', waitedMs: 194_000, attempts: 3, wsUpAfterMs: 2_400,
            detail: 'engine idea03: store sync stall (WS ws://x up): store not ready 63s after connect',
        })
        expect(m).toMatch(/idea03 store not ready after pm2 restart \(WS was open but the store doc never synced/)
        expect(m).toContain('waited 194000ms of the 300000ms budget, 3 attempt(s)')
        expect(m).toContain('WS first open 2400ms after the wait began')
        expect(m).toContain('store not ready 63s after connect')
        expect(m).not.toMatch(/WS not up/)
    })
    it('a WS that never opened keeps the "WS not up" label, now with counters', () => {
        const m = msg({ wsUp: false, storeSynced: false, failure: 'ws-unreachable', waitedMs: 150_000, attempts: 4, wsUpAfterMs: null, detail: 'engine idea03 unreachable' })
        expect(m).toMatch(/idea03 WS not up after pm2 restart \(waited 150000ms of the 300000ms budget, 4 attempt\(s\), WS first open never/)
    })
    it('rebootEngine --fast aborts loudly with the accurate label and reports the measurement', async () => {
        const o = new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        const anyO = o as unknown as Record<string, unknown>
        anyO.ssh = async () => ''
        anyO.sshMutate = async (h: string, c: string) => ({ stdout: await (anyO.ssh as (h: string, c: string) => Promise<string>)(h, c), recoveredByVerify: false, reissued: false, preStartRetries: 0 })
        anyO.disconnect = async () => {}
        anyO.stopDurationFixtureContainers = async () => {}
        anyO.waitReady = async (): Promise<SettleReady> => ({
            wsUp: false, storeSynced: false, failure: 'store-not-ready', waitedMs: 194_738, attempts: 3, wsUpAfterMs: 2_300, storeReadyAfterMs: null,
            detail: 'store not ready 63s after connect',
        })
        const lines: string[] = []
        vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lines.push(String(l)) })
        await expect(o.rebootEngine('idea03', true)).rejects.toThrow(/idea03 store not ready after pm2 restart \(WS was open/)
        const ev = lines.map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).find(e => e?.event === 'reboot_reconnect_measured')
        expect(ev).toMatchObject({ engine: 'idea03', kind: 'pm2-restart', ok: false, failure: 'store-not-ready', wsUpAfterMs: 2300, storeReadyAfterMs: null, attempts: 3 })
        expect(ev!.docWaitMs).toBe(REBOOT_DOC_WAIT_MS) // the wait that applied inside the window
    })
})

interface FakeEngine { port: number; docUrl: string; close(): Promise<void> }
const startFakeEngine = async (syncDelayMs: number): Promise<FakeEngine> => {
    const server = http.createServer()
    const amWss = new WebSocketServer({ noServer: true })
    const adapter = new WebSocketServerAdapter(amWss as never)
    const send = adapter.send.bind(adapter)
    adapter.send = (m: Parameters<typeof send>[0]) => {
        if ((m as { type?: string }).type === 'peer') return send(m) // handshake fast, store sync slow (Engine bring-up)
        setTimeout(() => { try { send(m) } catch { /* closed */ } }, syncDelayMs)
    }
    const repo = new Repo({ network: [adapter], peerId: `fake-engine-${Date.now()}` as PeerId, sharePolicy: async () => false })
    const handle = repo.create({ engineDB: {}, instanceDB: {}, diskDB: {}, appDB: {}, networkDB: {}, userDB: {} })
    const sockets: WebSocket[] = []
    server.on('upgrade', (req, socket, head) => {
        amWss.handleUpgrade(req, socket, head, ws => { sockets.push(ws); amWss.emit('connection', ws, req) })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    return {
        port: (server.address() as net.AddressInfo).port, docUrl: handle.url,
        close: async () => {
            for (const s of sockets) { try { s.terminate() } catch { /* ignore */ } }
            await repo.shutdown().catch(() => {})
            amWss.close()
            await new Promise<void>(r => server.close(() => r()))
        },
    }
}
const makeOps = (fe: FakeEngine, extra: Partial<ConstructorParameters<typeof RealFleetOps>[0]>) => new RealFleetOps({
    poolEngines: ['idea01'], hosts: { idea01: '127.0.0.1' }, enginePort: fe.port, storeUrls: { idea01: fe.docUrl },
    wsHandshakeTimeoutMs: 2_000, onOwnStoreStall: () => {}, ...extra,
})

describe('step 91: WS up vs store ready over a real (fake-Engine) WS', () => {
    stallIt('a store that syncs after the old per-attempt wait is reached with the reboot doc wait; WS-up is measured apart', async () => {
        const fe = await startFakeEngine(2_500) // slow bring-up: handshake at once, store sync 2.5 s later
        const ops = makeOps(fe, { docWaitMs: 1_000, rebootDocWaitMs: 12_000 }) // old behaviour = 1 s attempt, retried from scratch
        try {
            const r = await ops.reconnectEngine('idea01', 20_000)
            expect(r.wsUp).toBe(true)
            expect(r.failure).toBeUndefined()
            expect(r.attempts).toBe(1)
            expect(r.wsUpAfterMs).not.toBeNull()
            expect(r.storeReadyAfterMs!).toBeGreaterThanOrEqual(r.wsUpAfterMs!)
            expect(r.storeReadyAfterMs!).toBeGreaterThanOrEqual(2_000) // store-ready came after WS-up, measured separately
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 40_000)

    stallIt('a store that never syncs fails loud: failure=store-not-ready, WS-up time recorded, never "WS not up"', async () => {
        const fe = await startFakeEngine(60_000)
        const ops = makeOps(fe, { docWaitMs: 1_000, rebootDocWaitMs: 1_500 })
        try {
            const r = await ops.reconnectEngine('idea01', 3_000)
            expect(r.wsUp).toBe(false)
            expect(r.failure).toBe('store-not-ready')
            expect(r.attempts).toBeGreaterThanOrEqual(1)
            expect(r.wsUpAfterMs).not.toBeNull()
            expect(r.storeReadyAfterMs).toBeNull()
            expect(r.detail).toMatch(/WS open/)
            const m = ops.reconnectFailureMessage('idea01', r, 'pm2 restart', 3_000)
            expect(m).toMatch(/store not ready after pm2 restart/)
            expect(m).not.toMatch(/WS not up/)
        } finally {
            await ops.close()
            await fe.close()
        }
    }, 40_000)

    stallIt('no listener at all: failure=ws-unreachable (label stays "WS not up")', async () => {
        const s = net.createServer()
        await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()))
        const port = (s.address() as net.AddressInfo).port
        await new Promise<void>(r => s.close(() => r()))
        const ops = new RealFleetOps({
            poolEngines: ['idea01'], hosts: { idea01: '127.0.0.1' }, enginePort: port,
            storeUrls: { idea01: 'automerge:2VroEUvDkmYsDAwE5oG9YeFNadWH' }, wsHandshakeTimeoutMs: 500, docWaitMs: 1_000,
            onOwnStoreStall: () => {},
        })
        try {
            const r = await ops.reconnectEngine('idea01', 2_000)
            expect(r.wsUp).toBe(false)
            expect(r.failure).toBe('ws-unreachable')
            expect(r.wsUpAfterMs).toBeNull()
            expect(ops.reconnectFailureMessage('idea01', r, 'pm2 restart', 2_000)).toMatch(/WS not up after pm2 restart/)
        } finally {
            await ops.close()
        }
    }, 40_000)
})
