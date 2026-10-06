/**
 * throttledProxy.ts — a TCP proxy that models a slow server->client link (WS concurrency tests).
 *
 * The box reaches the Pis through a DERP relay (~150 ms RTT, limited
 * throughput), and a fresh peer's full store sync is ~0.6 MB on the wire. This
 * proxy forwards client->server bytes at once and server->client bytes at
 * `downBytesPerSec`, in order, so a WS ping the server queues after a large
 * message reaches the client only after that message (and its pong returns
 * that much later).
 *
 * When the server side closes or resets the connection, the client side is cut
 * at once and bytes still queued in the proxy are lost, as data still in flight
 * (sender buffers, relay) is lost when a server terminates a socket on a slow
 * link. (On loopback the kernel would otherwise buffer the whole sync and
 * deliver it after the server's close, hiding the drop.)
 *
 * `dropAfterDownBytes` (optional) destroys the FIRST connection once that many
 * server->client bytes have been forwarded: a link drop in the middle of a sync.
 */

import net from 'net'

export interface ThrottledProxyOptions {
    targetPort: number
    downBytesPerSec: number
    dropAfterDownBytes?: number
}

export interface ThrottledProxy {
    port: number
    connections: number
    drops: number
    close(): Promise<void>
}

const TICK_MS = 20

export const startThrottledProxy = (opts: ThrottledProxyOptions): Promise<ThrottledProxy> => new Promise((resolve, reject) => {
    const perTick = Math.max(1, Math.floor(opts.downBytesPerSec * TICK_MS / 1000))
    const sockets = new Set<net.Socket>()
    const state = { connections: 0, drops: 0 }
    const server = net.createServer((client) => {
        const index = state.connections++
        const upstream = net.connect(opts.targetPort, '127.0.0.1')
        sockets.add(client); sockets.add(upstream)
        const queue: Buffer[] = []
        let queued = 0, forwarded = 0, closed = false
        const shutdown = () => {
            if (closed) return
            closed = true
            clearInterval(timer)
            client.destroy(); upstream.destroy()
            sockets.delete(client); sockets.delete(upstream)
        }
        const timer = setInterval(() => {
            let budget = perTick
            while (budget > 0 && queue.length > 0) {
                const head = queue[0]
                const chunk = head.length <= budget ? head : head.subarray(0, budget)
                if (chunk === head) queue.shift(); else queue[0] = head.subarray(budget)
                client.write(chunk)
                budget -= chunk.length; queued -= chunk.length; forwarded += chunk.length
                if (index === 0 && opts.dropAfterDownBytes !== undefined && forwarded >= opts.dropAfterDownBytes) {
                    state.drops++
                    shutdown()
                    return
                }
            }
        }, TICK_MS)
        upstream.on('data', (d: Buffer) => { queue.push(d); queued += d.length })
        client.on('data', (d: Buffer) => upstream.write(d))
        client.on('close', shutdown); upstream.on('close', shutdown)
        client.on('error', shutdown); upstream.on('error', shutdown)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo
        resolve({
            port,
            get connections() { return state.connections },
            get drops() { return state.drops },
            close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
        })
    })
})
