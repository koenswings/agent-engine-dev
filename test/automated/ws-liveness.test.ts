/**
 * ws-liveness.test.ts (#168): the outgoing Engine WS link drops a silently dead
 * socket and redials; a live link is left alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import { WsLiveness } from '../../src/data/WsLiveness.js'
import { StoreScopedWebSocketClientAdapter } from '../../src/data/StoreScopedClientAdapter.js'

const until = async (f: () => boolean, ms: number) => {
    const t0 = Date.now()
    while (!f()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 20)) }
    return true
}

describe('WsLiveness unit', () => {
    const sock = () => { const s: any = { readyState: 1, pings: 0, killed: 0, ping() { s.pings++ }, terminate() { s.killed++ }, close() {} }; return s }
    it('pings while heard recently; terminates once silent for deadMs', () => {
        let t = 0
        const s = sock(); let dead = 0
        const w = new WsLiveness({ pingMs: 1e9, deadMs: 100, label: 't', now: () => t, onDead: () => dead++ })
        w.attach(s)
        t = 50; w.tick(); expect(s.pings).toBe(1); expect(s.killed).toBe(0)
        t = 100; w.tick(); expect(s.killed).toBe(1); expect(dead).toBe(1)
        w.detach()
    })
    it('a connecting socket is never terminated', () => {
        let t = 0
        const s = sock(); s.readyState = 0
        const w = new WsLiveness({ pingMs: 1e9, deadMs: 10, label: 't', now: () => t })
        w.attach(s); t = 1000; w.tick(); expect(s.killed).toBe(0); w.detach()
    })
})

describe('StoreScopedWebSocketClientAdapter liveness (real ws)', () => {
    let wss: WebSocketServer | undefined
    let a: StoreScopedWebSocketClientAdapter | undefined
    afterEach(async () => {
        try { a?.disconnect() } catch { /* */ }
        await new Promise<void>(r => wss ? wss.close(() => r()) : r())
        for (const c of wss?.clients ?? []) c.terminate()
        wss = undefined; a = undefined
    })
    const start = async (autoPong: boolean) => {
        wss = new WebSocketServer({ port: 0, autoPong } as any)
        await new Promise(r => wss!.once('listening', r))
        let conns = 0
        wss.on('connection', () => { conns++ })
        const port = (wss.address() as any).port
        a = new StoreScopedWebSocketClientAdapter(`ws://127.0.0.1:${port}`, { ownTag: 't', onRefused: () => {}, retryInterval: 100, pingMs: 50, deadMs: 300 })
        a.connect('client-1' as any, {} as any)
        return () => conns
    }
    it('silent server (no pong, no messages) → socket dropped and redialled', async () => {
        const conns = await start(false)
        expect(await until(() => conns() >= 2, 3000)).toBe(true)
        expect(a!.forcedReconnects).toBeGreaterThanOrEqual(1)
    })
    it('live server (answers pings) → no forced reconnect', async () => {
        const conns = await start(true)
        await new Promise(r => setTimeout(r, 900))
        expect(conns()).toBe(1)
        expect(a!.forcedReconnects).toBe(0)
        expect(a!.lastHeardAgeMs).toBeLessThan(300)
    })
})
