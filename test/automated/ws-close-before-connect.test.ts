/**
 * ws-close-before-connect.test.ts (idea#332): disconnecting the outgoing Engine WS
 * link while its socket is still CONNECTING must not throw or leave an unhandled
 * 'error' event ("WebSocket was closed before the connection was established").
 */
import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { StoreScopedWebSocketClientAdapter } from '../../src/data/StoreScopedClientAdapter.js'

describe('StoreScopedWebSocketClientAdapter close-before-connect (idea#332)', () => {
    let srv: net.Server | undefined
    const held: net.Socket[] = []
    afterEach(async () => {
        for (const s of held) s.destroy()
        held.length = 0
        await new Promise<void>(r => srv ? srv.close(() => r()) : r())
        srv = undefined
    })

    it('disconnect while CONNECTING (server never answers the upgrade) → no uncaught error', async () => {
        // A TCP server that accepts but never answers the HTTP upgrade: the socket stays CONNECTING.
        srv = net.createServer(s => { held.push(s) })
        await new Promise<void>(r => srv!.listen(0, '127.0.0.1', () => r()))
        const port = (srv.address() as net.AddressInfo).port

        const uncaught: unknown[] = []
        const onUncaught = (e: unknown) => { uncaught.push(e) }
        process.on('uncaughtException', onUncaught)
        try {
            const a = new StoreScopedWebSocketClientAdapter(`ws://127.0.0.1:${port}`, { ownTag: 't', onRefused: () => {}, retryInterval: 60_000, pingMs: 1e9, deadMs: 1e9 })
            a.connect('client-1' as any, {} as any)
            const sock: any = a.socket
            await new Promise(r => setTimeout(r, 100))
            expect(sock.readyState).toBe(0)   // still CONNECTING
            expect(() => a.disconnect()).not.toThrow()
            expect(a.socket).toBeUndefined()
            await new Promise(r => setTimeout(r, 300))   // ws emits the abort error on a later tick
            expect(uncaught.map(e => (e as Error)?.message ?? String(e))).toEqual([])
            expect(sock.readyState).toBe(3)   // CLOSED: the abort error was handled and 'close' followed
            expect(() => a.disconnect()).not.toThrow()   // idempotent
        } finally {
            process.off('uncaughtException', onUncaught)
        }
        expect(uncaught).toEqual([])
    })
    it('redials while CONNECTING, then disconnect → previous sockets closed, no uncaught error', async () => {
        srv = net.createServer(s => { held.push(s) })
        await new Promise<void>(r => srv!.listen(0, '127.0.0.1', () => r()))
        const port = (srv.address() as net.AddressInfo).port
        const uncaught: unknown[] = []
        const onUncaught = (e: unknown) => { uncaught.push(e) }
        process.on('uncaughtException', onUncaught)
        const seen: any[] = []
        try {
            const a = new StoreScopedWebSocketClientAdapter(`ws://127.0.0.1:${port}`, { ownTag: 't', onRefused: () => {}, retryInterval: 80, pingMs: 1e9, deadMs: 1e9 })
            a.connect('client-1' as any, {} as any)
            for (let i = 0; i < 15; i++) { if (a.socket && !seen.includes(a.socket)) seen.push(a.socket); await new Promise(r => setTimeout(r, 25)) }
            expect(seen.length).toBeGreaterThanOrEqual(2)   // the retry timer redialled while CONNECTING
            a.disconnect()
            await new Promise(r => setTimeout(r, 300))
        } finally {
            process.off('uncaughtException', onUncaught)
        }
        expect(uncaught.map(e => (e as Error)?.message ?? String(e))).toEqual([])
        for (const s of seen) expect(s.readyState).toBe(3)   // none left dangling in CONNECTING
    })
})
