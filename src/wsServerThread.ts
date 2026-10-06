/**
 * wsServerThread.ts — keep the Engine's Automerge WS server responsive while it syncs (IDEA04-WS).
 *
 * Problem (r33, IDEA04-WS.md; reproduced by test/automated/ws-concurrent-sync.test.ts):
 * a fresh peer's full sync of the large store doc is synchronous Automerge work
 * on the main thread (generateSyncMessage of the whole doc, plus the JS<->wasm
 * round trip of a sync state that lists every change hash sent): a few hundred
 * ms on x86, seconds on a Pi 4. With the stock WebSocketServerAdapter on the
 * main thread, a classroom of peers connecting at once stalls the event loop
 * for N times that, and while it is stalled:
 *   - new sockets are not accepted and joins are not answered; the client's
 *     WebSocketClientAdapter declares itself ready after 1 s anyway, its find()
 *     sees no peer and the doc goes 'unavailable';
 *   - pongs are not read before the next keepalive tick (5 s default), so the
 *     adapter terminates every socket at once.
 *
 * ThreadedWebSocketServerAdapter is a drop-in NetworkAdapter for the Repo that
 * runs the stock WebSocketServerAdapter in a worker thread
 * (wsServerThreadWorker.ts). The worker owns the sockets, the handshake and
 * the keepalive, so they no longer depend on the main thread. The Repo side is
 * unchanged: the same 'peer-candidate' / 'peer-disconnected' / 'message' events
 * arrive, in the same order. They are handed to the Repo one event per
 * event-loop turn (setImmediate), so one peer's long sync does not run back to
 * back with the next one and the main thread still gets to its own timers and
 * sockets (HTTP monitor, outbound Engine connections) in between.
 *
 * If the worker dies it is restarted (after RESTART_DELAY_MS) and its peers are
 * reported disconnected; clients reconnect on their own.
 */

import { Worker } from 'worker_threads'
import { next as A } from '@automerge/automerge'
import { NetworkAdapter, Message, PeerId, PeerMetadata } from '@automerge/automerge-repo'
import { log, error } from './utils/utils.js'
import type { WsServerThreadData } from './wsServerThreadWorker.js'

const RESTART_DELAY_MS = 1000

export type QueuedEvent = { event: 'peer-candidate' | 'peer-disconnected' | 'message', payload: any }

/**
 * Start the worker module next to this one: .js when compiled (the Engine runs
 * dist/src/index.js). When run from source under tsx (dev scripts), the .ts
 * worker is loaded through tsx's ESM API, since loader hooks registered on the
 * main thread do not apply inside workers.
 */
const startWorker = (workerData: WsServerThreadData): Worker => {
    if (!import.meta.url.endsWith('.ts')) return new Worker(new URL('./wsServerThreadWorker.js', import.meta.url), { workerData })
    const tsUrl = new URL('./wsServerThreadWorker.ts', import.meta.url).href
    const boot = `import('tsx/esm/api').then(m => m.register()).then(() => import(${JSON.stringify(tsUrl)}))`
    return new Worker(boot, { eval: true, workerData })
}

/** A sync/request message that carries changes must be applied even if its sender has left. */
export const carriesChanges = (msg: any): boolean => {
    if ((msg?.type !== 'sync' && msg?.type !== 'request') || !msg.data) return false
    try { return A.decodeSyncMessage(msg.data).changes.length > 0 } catch { return true }
}

/** The queue without `peerId`'s messages that carry no changes (see #dropQueuedFrom). */
export const pruneDepartedMessages = (queue: QueuedEvent[], peerId: PeerId): QueuedEvent[] =>
    queue.filter(e => !(e.event === 'message' && e.payload?.senderId === peerId && !carriesChanges(e.payload)))

export class ThreadedWebSocketServerAdapter extends NetworkAdapter {
    readonly port: number
    readonly keepAliveIntervalMs: number
    /** Resolves when the server first listens; rejects if the first listen fails (e.g. EADDRINUSE). */
    readonly listening: Promise<void>

    #worker!: Worker
    #closed = false
    #connectArgs?: { peerId: PeerId, peerMetadata?: PeerMetadata }
    #peers = new Set<PeerId>()
    #queue: QueuedEvent[] = []
    #scheduled = false
    #ready = false
    #readyResolve!: () => void
    #readyPromise = new Promise<void>(resolve => { this.#readyResolve = resolve })
    #listeningSettled = false
    #listeningResolve!: () => void
    #listeningReject!: (e: Error) => void

    constructor(port: number, keepAliveIntervalMs: number) {
        super()
        this.port = port
        this.keepAliveIntervalMs = keepAliveIntervalMs
        this.listening = new Promise<void>((resolve, reject) => { this.#listeningResolve = resolve; this.#listeningReject = reject })
        this.listening.catch(() => { /* reported via error(); callers may await it */ })
        this.#spawn()
    }

    /** Same meaning as the stock server adapter: ready once the first client has connected. */
    isReady(): boolean { return this.#ready }
    whenReady(): Promise<void> { return this.#readyPromise }

    /** Repo events waiting to be handed to the Repo (diagnostics/tests). */
    get pendingEvents(): number { return this.#queue.length }

    connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
        this.peerId = peerId
        this.peerMetadata = peerMetadata
        this.#connectArgs = { peerId, peerMetadata }
        this.#worker.postMessage({ type: 'connect', peerId, peerMetadata })
    }

    send(message: Message): void {
        if ('data' in message && message.data?.byteLength === 0) throw new Error('Tried to send a zero-length message')
        this.#worker.postMessage({ type: 'send', message })
    }

    disconnect(): void {
        this.#worker.postMessage({ type: 'disconnect' })
    }

    /** Stop the server thread (tests; the Engine just exits). */
    async close(): Promise<void> {
        this.#closed = true
        await this.#worker.terminate()
    }

    #spawn(): void {
        const data: WsServerThreadData = { port: this.port, keepAliveIntervalMs: this.keepAliveIntervalMs }
        const worker = startWorker(data)
        this.#worker = worker
        worker.on('message', (m: any) => this.#onWorkerMessage(m))
        worker.on('error', (err) => error(`WebSocket server thread error: ${err.stack ?? err.message}`))
        worker.on('exit', (code) => {
            if (this.#closed || worker !== this.#worker) return
            error(`WebSocket server thread exited (code ${code}); restarting in ${RESTART_DELAY_MS} ms`)
            for (const peerId of this.#peers) this.#enqueue({ event: 'peer-disconnected', payload: { peerId } })
            setTimeout(() => {
                if (this.#closed) return
                this.#spawn()
                if (this.#connectArgs) this.#worker.postMessage({ type: 'connect', ...this.#connectArgs })
            }, RESTART_DELAY_MS)
        })
    }

    #onWorkerMessage(m: any): void {
        switch (m?.type) {
            case 'event':
                if (m.event === 'peer-disconnected') this.#dropQueuedFrom(m.payload?.peerId)
                this.#enqueue({ event: m.event, payload: m.payload })
                break
            case 'ready':
                if (!this.#ready) { this.#ready = true; this.#readyResolve() }
                break
            case 'listening':
                if (!this.#listeningSettled) { this.#listeningSettled = true; this.#listeningResolve() }
                break
            case 'server-error':
                error(`WebSocket server error on port ${this.port}: ${m.message}`)
                if (!this.#listeningSettled) { this.#listeningSettled = true; this.#listeningReject(new Error(m.message)) }
                break
            case 'log':
                (m.level === 'error' ? error : log)(m.message)
                break
        }
    }

    /**
     * r34 POST-BURST-CPU: the peer's socket is gone. Its messages still waiting in
     * the queue would each cost a receiveSyncMessage + generateSyncMessage on the
     * main thread (seconds for a full sync on a Pi 4) for a reply nobody can
     * receive; after a burst of short-lived clients that kept idea04's main thread
     * at 100% for ~2 min while new clients got nothing. Drop them, EXCEPT sync
     * messages that carry changes: those may hold the peer's last edits and must
     * still be applied to the doc.
     */
    #dropQueuedFrom(peerId: PeerId | undefined): void {
        if (!peerId) return
        const before = this.#queue.length
        this.#queue = pruneDepartedMessages(this.#queue, peerId)
        const dropped = before - this.#queue.length
        if (dropped > 0) this.droppedFromDeparted += dropped
    }

    /** Messages dropped because their sender had disconnected (diagnostics/tests). */
    droppedFromDeparted = 0

    #enqueue(e: QueuedEvent): void {
        this.#queue.push(e)
        if (!this.#scheduled) { this.#scheduled = true; setImmediate(this.#drainOne) }
    }

    #drainOne = (): void => {
        const next = this.#queue.shift()
        try {
            if (next) {
                if (next.event === 'peer-candidate') this.#peers.add(next.payload.peerId)
                else if (next.event === 'peer-disconnected') this.#peers.delete(next.payload.peerId)
                this.emit(next.event as any, next.payload)
            }
        } finally {
            if (this.#queue.length > 0) setImmediate(this.#drainOne)
            else this.#scheduled = false
        }
    }
}
