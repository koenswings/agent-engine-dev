/**
 * wsServerThreadWorker.ts — the Engine's Automerge WebSocket server, run in a worker thread (IDEA04-WS).
 *
 * Started by ThreadedWebSocketServerAdapter (wsServerThread.ts). This thread owns
 * the listening socket and every client socket, and runs the stock
 * WebSocketServerAdapter: the WS upgrade, the join -> 'peer' handshake, the
 * keepalive ping/pong and CBOR (de)coding all happen here, so they keep working
 * while the main thread is busy with a long synchronous Automerge sync.
 * Repo-facing adapter events are forwarded to the main thread, and the main
 * thread's outgoing messages are sent from here.
 *
 * Messages from the main thread:
 *   { type: 'connect', peerId, peerMetadata }  start listening and accept peers
 *   { type: 'send', message }                  send a repo message to a peer
 *   { type: 'disconnect' }                     terminate all client sockets (Repo shutdown)
 * Messages to the main thread:
 *   { type: 'listening' } | { type: 'ready' } | { type: 'server-error', message }
 *   { type: 'event', event: 'peer-candidate' | 'peer-disconnected' | 'message', payload }
 *   { type: 'log', level: 'log' | 'error', message }
 */

import { parentPort, workerData } from 'worker_threads'
import { WebSocketServer } from 'ws'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'

export interface WsServerThreadData { port: number, keepAliveIntervalMs: number }

const FORWARDED_EVENTS = ['peer-candidate', 'peer-disconnected', 'message'] as const

/** setInterval's maximum: effectively switches off the stock adapter's own keepalive. */
const STOCK_KEEPALIVE_OFF = 0x7fffffff

interface TrackedSocket {
    isAlive?: boolean          // set by the stock adapter on pong, and by us on any message
    lastBufferedAmount?: number
    bufferedAmount: number
    readyState: number
    ping(): void
    terminate(): void
    on(event: string, cb: (...a: any[]) => void): void
}

/**
 * Keepalive that does not drop a peer we are still streaming a sync to.
 *
 * The stock keepalive pings every interval and terminates a socket whose pong
 * has not been read by the next tick. A ping is queued BEHIND whatever we are
 * already sending on that socket, so while a large full-doc sync message is
 * still crossing a slow link (box -> DERP relay -> Pi), the client cannot even
 * see the ping in time and is terminated mid-sync; it reconnects, the full sync
 * restarts and the same thing happens again (r33: 4 handshakes, never ready).
 *
 * Here a socket counts as alive for a tick if any of these happened since the
 * previous tick: a pong, any message from the peer, or our send backlog to it
 * (bufferedAmount) went down, i.e. the peer is still taking our data.
 */
const startKeepalive = (wss: WebSocketServer, intervalMs: number): NodeJS.Timeout => {
    wss.on('connection', (socket: TrackedSocket) => {
        socket.isAlive = true
        socket.lastBufferedAmount = 0
        socket.on('message', () => { socket.isAlive = true })
    })
    const timer = setInterval(() => {
        wss.clients.forEach((ws) => {
            const socket = ws as unknown as TrackedSocket
            const buffered = socket.bufferedAmount
            const draining = buffered < (socket.lastBufferedAmount ?? 0)
            socket.lastBufferedAmount = buffered
            if (socket.isAlive || draining) {
                socket.isAlive = false
                socket.ping()
            } else {
                socket.terminate()
            }
        })
    }, intervalMs)
    wss.on('close', () => clearInterval(timer))
    return timer
}

if (parentPort) {
    const port = parentPort
    const { port: listenPort, keepAliveIntervalMs } = workerData as WsServerThreadData
    const post = (m: unknown) => port.postMessage(m)
    const logError = (message: string) => post({ type: 'log', level: 'error', message })

    // Same policy as the Engine's main thread (start.ts): log and keep serving.
    process.on('uncaughtException', (err: Error) => logError(`[ws-server-thread uncaughtException] ${err.stack ?? err.message}`))
    process.on('unhandledRejection', (reason: any) => logError(`[ws-server-thread unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}`))

    let adapter: WebSocketServerAdapter | undefined

    port.on('message', (m: any) => {
        try {
            switch (m?.type) {
                case 'connect': {
                    if (adapter) return
                    // Listen only once the adapter has its peerId: a join that arrived
                    // before connect() would hit the adapter's peerId assertion.
                    const wss = new WebSocketServer({ port: listenPort })
                    wss.on('error', (err) => post({ type: 'server-error', message: err.message }))
                    wss.on('listening', () => post({ type: 'listening' }))
                    // Our keepalive (startKeepalive) replaces the stock one, which
                    // would terminate a peer whose pong is stuck behind its own sync.
                    adapter = new WebSocketServerAdapter(wss, STOCK_KEEPALIVE_OFF)
                    startKeepalive(wss, keepAliveIntervalMs)
                    for (const event of FORWARDED_EVENTS) {
                        adapter.on(event, (payload: unknown) => post({ type: 'event', event, payload }))
                    }
                    void adapter.whenReady().then(() => post({ type: 'ready' }))
                    adapter.connect(m.peerId, m.peerMetadata)
                    break
                }
                case 'send':
                    adapter?.send(m.message)
                    break
                case 'disconnect':
                    adapter?.disconnect()
                    break
            }
        } catch (e) {
            logError(`[ws-server-thread] ${m?.type} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
        }
    })
}
