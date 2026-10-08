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
 *   { type: 'refused', peerId, remote, verdict, ownTag }   a join refused by the store check
 *
 * Store-scoped peering (StoreScope.ts): when our own peerId is an Engine peerId
 * (`idea-engine/<storeTag>/...`, always the case for the Engine, src/repo.ts),
 * every join is checked BEFORE the stock adapter sees it. A peer of another store,
 * or a non-ephemeral peer without a store tag (an old Engine), gets an
 * `idea-store-refused ours=<tag> kind=<kind>` error and its socket is closed: no
 * peer-candidate, no 'peer' reply, none of its messages reach the Repo. Messages on
 * a socket that has not completed an admitted join are dropped too (the stock
 * adapter would forward them with whatever senderId they claim).
 */

import { parentPort, workerData } from 'worker_threads'
import { WebSocketServer } from 'ws'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { cbor } from '@automerge/automerge-repo'
import { parseEnginePeerId, peerVerdict, refusalMessage, PeerVerdict } from './data/StoreScope.js'

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

export interface StoreRefusal { peerId?: string, remote: string, verdict: PeerVerdict, ownTag: string }

/**
 * The stock server adapter with the store check on each socket's join (see header).
 * ownTag undefined (our own peerId is not an Engine peerId: tests/tools that run a
 * plain server) = no check, the stock behaviour.
 */
export class StoreScopedWebSocketServerAdapter extends WebSocketServerAdapter {
    ownTag?: string
    #admitted = new WeakSet<object>()
    readonly #onRefused: (r: StoreRefusal) => void
    readonly #wss: WebSocketServer

    constructor(server: WebSocketServer, keepAliveInterval: number, onRefused: (r: StoreRefusal) => void) {
        super(server, keepAliveInterval)
        this.#wss = server
        this.#onRefused = onRefused
    }

    override connect(peerId: any, peerMetadata?: any): void {
        this.ownTag = parseEnginePeerId(peerId)?.storeTag
        super.connect(peerId, peerMetadata)
        this.#wss.on('connection', (socket: any, req: any) => {
            socket.ideaRemote = `${req?.socket?.remoteAddress ?? '?'}:${req?.socket?.remotePort ?? '?'}`
        })
    }

    override receiveMessage(messageBytes: Uint8Array, socket: any): void {
        if (!this.ownTag || this.#admitted.has(socket)) return super.receiveMessage(messageBytes, socket)
        let message: any
        try { message = cbor.decode(new Uint8Array(messageBytes as any)) } catch { socket.close(); return }
        if (message?.type !== 'join') return   // nothing before the join is processed
        const verdict = peerVerdict(this.ownTag, message.senderId, message.peerMetadata)
        if (!verdict.admit) {
            try {
                socket.send(cbor.encode({ type: 'error', senderId: this.peerId, targetId: message.senderId,
                    message: refusalMessage(this.ownTag, verdict.kind) }))
            } catch { /* socket already closing */ }
            try { socket.close(4403, 'store mismatch') } catch { /* ignore */ }
            this.#onRefused({ peerId: message.senderId, remote: socket.ideaRemote ?? '?', verdict, ownTag: this.ownTag })
            return
        }
        this.#admitted.add(socket)
        super.receiveMessage(messageBytes, socket)
    }
}

if (parentPort) {
    const port = parentPort
    const { port: listenPort, keepAliveIntervalMs } = workerData as WsServerThreadData
    const post = (m: unknown) => port.postMessage(m)
    const logError = (message: string) => post({ type: 'log', level: 'error', message })

    // Same policy as the Engine's main thread (start.ts): log and keep serving.
    process.on('uncaughtException', (err: Error) => logError(`[ws-server-thread uncaughtException] ${err.stack ?? err.message}`))
    process.on('unhandledRejection', (reason: any) => logError(`[ws-server-thread unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}`))

    let adapter: StoreScopedWebSocketServerAdapter | undefined

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
                    adapter = new StoreScopedWebSocketServerAdapter(wss, STOCK_KEEPALIVE_OFF, (r) => post({ type: 'refused', ...r }))
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
