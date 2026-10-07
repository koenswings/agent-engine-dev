/**
 * ws-server-thread.test.ts — ThreadedWebSocketServerAdapter basics (IDEA04-WS).
 *
 *   - a Repo on the threaded server syncs a doc to a client and back
 *   - a client disconnect reaches the server Repo as a peer disconnect
 *   - a port already in use: 'listening' rejects (and the error is logged as before)
 */

import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import { Repo, PeerId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { ThreadedWebSocketServerAdapter } from '../../src/wsServerThread.js'

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})
const until = async (cond: () => boolean, timeoutMs = 10_000) => {
    const end = Date.now() + timeoutMs
    while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)) }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

describe('ThreadedWebSocketServerAdapter', () => {
    it('syncs a doc server -> client and client -> server; disconnects reach the server Repo', async () => {
        const port = await freePort()
        const adapter = new ThreadedWebSocketServerAdapter(port, 30_000)
        cleanups.push(() => adapter.close())
        const server = new Repo({ network: [adapter], sharePolicy: async () => true })
        await adapter.listening
        const h = server.create<{ n: number, from?: string }>({ n: 1 })

        const clientAdapter = new WebSocketClientAdapter(`ws://127.0.0.1:${port}`, 500)
        const client = new Repo({ network: [clientAdapter], peerId: 'wsthread-client' as PeerId })
        cleanups.push(() => { try { clientAdapter.disconnect() } catch { /* already closed */ } })
        const ch = await client.find<{ n: number, from?: string }>(h.url)
        expect(ch.doc().n).toBe(1)
        expect(adapter.isReady()).toBe(true)

        ch.change(d => { d.from = 'client' })
        await until(() => h.doc().from === 'client')
        h.change(d => { d.n = 2 })
        await until(() => ch.doc().n === 2)

        expect(server.peers).toContain('wsthread-client')
        clientAdapter.disconnect()
        await until(() => !server.peers.includes('wsthread-client' as PeerId))
    }, 30_000)

    it('a port already in use makes listening reject', async () => {
        const blocker = net.createServer()
        await new Promise<void>(r => blocker.listen(0, () => r()))
        cleanups.push(() => new Promise<void>(r => blocker.close(() => r())))
        const port = (blocker.address() as net.AddressInfo).port
        const adapter = new ThreadedWebSocketServerAdapter(port, 30_000)
        cleanups.push(() => adapter.close())
        new Repo({ network: [adapter] })
        await expect(adapter.listening).rejects.toThrow(/EADDRINUSE/)
    }, 30_000)
})
