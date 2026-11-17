/**
 * StoreScopedClientAdapter.ts: the Engine's outgoing Engine-to-Engine WS link,
 * checked against the store (see StoreScope.ts).
 *
 * A stock WebSocketClientAdapter that, before the Repo learns about the remote
 * side, checks the remote peerId from the server's `peer` handshake reply:
 *   - same store: passed on as usual (peer-candidate), syncs.
 *   - another store, or an old Engine without a store tag: refused. The Repo never
 *     sees the peer, so nothing is announced, sent or requested; every message
 *     that arrives on the socket anyway (an old Engine announces all its docs right
 *     after the handshake) is dropped; the socket is closed and the adapter stops
 *     redialling. onRefused tells Network.ts, which drops the connection and backs off.
 *   - a server that refuses US (it sent an `idea-store-refused` error) is handled
 *     the same way, with its store tag from the message.
 * Messages before an admitted handshake are dropped as well.
 *
 * Also: a sync/request for a foreign store doc (docGuard) is never sent; it goes out
 * as `doc-unavailable` instead, and such a message from the peer is not processed.
 *
 * engine#512: send() never throws. automerge-repo 2.3.1 answers a sync message INSIDE
 * handle.update(), after A.receiveSyncMessage has advanced the doc; the stock adapter
 * throws `Websocket not ready (n)` when the socket is CONNECTING/CLOSING/CLOSED (e.g. just
 * dropped by the #168 watchdog), the throw escapes the update callback and the DocHandle
 * keeps the pre-receive doc, which Automerge has marked outdated: every later sync and
 * every local change on that doc then fails with "Attempting to change an outdated
 * document" until the process restarts (idea04 16:54:30, idea01 since 12:05 on 11-17).
 * Such a send is dropped instead (logged once per socket, counted in droppedSends).
 * Automerge sync is idempotent: the sync state resets on peer-disconnected and the
 * peer resyncs after the reconnect, so nothing is lost.
 */

import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { cbor, Message, PeerId, PeerMetadata } from '@automerge/automerge-repo'
import { parseRefusalMessage, peerVerdict, PeerVerdict } from './StoreScope.js'
import { WsLiveness, wsDeadMs, wsPingMs } from './WsLiveness.js'
import { log } from '../utils/utils.js'
import { createEphemeralSendDedupe } from '../utils/ephemeralDedupe.js'

export interface ClientRefusal {
    url: string
    /** 'local': we refused the server; 'remote': the server refused us. */
    by: 'local' | 'remote'
    verdict: PeerVerdict
    remotePeerId?: string
}

export interface StoreScopedClientOptions {
    ownTag: string
    onRefused: (r: ClientRefusal) => void
    /** true = the doc is another fleet's store doc: never send or accept it. */
    docGuard?: (documentId: string) => boolean
    retryInterval?: number
    /** #168 dead-socket watchdog timings (default IDEA_WS_PING_MS / IDEA_WS_DEAD_MS). */
    pingMs?: number
    deadMs?: number
}

/** Small messages are peeked before the stock adapter sees them (handshake/error replies are tiny). */
const PEEK_MAX_BYTES = 4096

const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSED = 3

/**
 * idea#332: the stock adapter strips its own 'error' listener before it closes or
 * abandons a socket. Closing a ws socket that is still CONNECTING makes ws emit
 * 'WebSocket was closed before the connection was established' on the next tick,
 * and with no listener left that 'error' event is an uncaught exception (it failed
 * the idea04 test:full run). Give the socket we let go of a listener that logs the
 * error instead, once.
 */
const guardReleasedSocket = (socket: any, url: string): void => {
    if (!socket || socket.readyState === WS_CLOSED || socket.__ideaReleaseGuard) return
    socket.__ideaReleaseGuard = true
    const onError = (e: any) => {
        log(`WS ${url}: error on a released socket (readyState ${socket.readyState}): ${e?.message ?? e?.error?.message ?? e}`, 2)
    }
    if (typeof socket.on === 'function') socket.on('error', onError)
    else socket.addEventListener?.('error', onError)
}

export const guardOutgoing = (message: Message, docGuard: ((id: string) => boolean) | undefined): Message | undefined => {
    const docId = (message as any).documentId
    if (!docGuard || !docId) return message
    if ((message.type === 'sync' || message.type === 'request') && docGuard(String(docId))) {
        return { type: 'doc-unavailable', senderId: message.senderId, targetId: message.targetId, documentId: docId } as Message
    }
    return message
}

export class StoreScopedWebSocketClientAdapter extends WebSocketClientAdapter {
    readonly ownTag: string
    #onRefused: (r: ClientRefusal) => void
    #docGuard?: (documentId: string) => boolean
    #admitted = false
    refusal?: ClientRefusal
    /** #168: sockets dropped by the watchdog because nothing was heard. */
    forcedReconnects = 0
    /** engine#512: sends dropped because the socket was not OPEN (or the send itself threw). */
    droppedSends = 0
    /** The socket the last drop was logged for: one log line per socket, not per message. */
    #dropLoggedFor: unknown = undefined
    #liveness: WsLiveness

    constructor(url: string, opts: StoreScopedClientOptions) {
        super(url, opts.retryInterval ?? 5000)
        this.ownTag = opts.ownTag
        this.#onRefused = opts.onRefused
        this.#docGuard = opts.docGuard
        this.#liveness = new WsLiveness({ pingMs: opts.pingMs ?? wsPingMs(), deadMs: opts.deadMs ?? wsDeadMs(), label: url, onDead: () => { this.forcedReconnects++ } })
    }

    /** #168: every (re)connect gets a fresh socket; watch it for silence. */
    override connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
        // idea#332: on a redial the stock connect() drops the previous socket (often still
        // CONNECTING) without closing it and without an error listener. Guard and close it.
        const previous: any = this.socket
        if (previous && this.peerId) {
            guardReleasedSocket(previous, this.url)
            if (previous.readyState === WS_CONNECTING) {
                try { previous.terminate ? previous.terminate() : previous.close() } catch (e: any) {
                    log(`WS ${this.url}: closing the previous connecting socket failed: ${e?.message ?? e}`, 2)
                }
            }
        }
        super.connect(peerId, peerMetadata)
        if (this.socket && !this.refusal) this.#liveness.attach(this.socket as any)
    }

    /** ms since anything (message, ping, pong) arrived on the current socket. */
    get lastHeardAgeMs(): number { return this.#liveness.lastHeardAgeMs }

    /** True once the server's handshake passed the store check. */
    get admitted(): boolean { return this.#admitted }

    override peerCandidate(remotePeerId: PeerId, peerMetadata: PeerMetadata): void {
        if (this.refusal) return
        const verdict = peerVerdict(this.ownTag, remotePeerId, peerMetadata)
        if (!verdict.admit) { this.#refuse({ url: this.url, by: 'local', verdict, remotePeerId }); return }
        this.#admitted = true
        super.peerCandidate(remotePeerId, peerMetadata)
    }

    override receiveMessage(messageBytes: Uint8Array): void {
        if (this.refusal) return
        if (!this.#admitted || messageBytes.byteLength <= PEEK_MAX_BYTES) {
            let m: any
            try { m = cbor.decode(new Uint8Array(messageBytes)) } catch { return }
            if (m?.type === 'error') {
                const r = parseRefusalMessage(m.message)
                if (r) {
                    this.#refuse({ url: this.url, by: 'remote', remotePeerId: m.senderId,
                        verdict: { admit: false, kind: r.kind === 'foreign-store' ? 'foreign-store' : 'legacy-engine', theirTag: r.theirTag } })
                    return
                }
            } else if (m?.type !== 'peer' && !this.#admitted) {
                return   // nothing but the handshake before the store check passed
            }
            if (this.#admitted && m?.documentId && this.#docGuard?.(String(m.documentId))) return
        }
        super.receiveMessage(messageBytes)
    }

    override emit(event: any, ...args: any[]): boolean {
        // Last line of defence: no message reaches the Repo from a refused/unverified server.
        if (event === 'message' && (!this.#admitted || this.refusal)) return false
        return (super.emit as any)(event, ...args)
    }

    #ephemeralDedupe = createEphemeralSendDedupe()

    override send(message: Message): void {
        if (this.refusal) return
        if (message.type !== 'join' && !this.#admitted) return
        const out = guardOutgoing(message, this.#docGuard)
        if (!out) return
        // engine#512: never throw from here (see the header). A missing socket is already a
        // silent no-op in the stock adapter; a socket that is not OPEN is dropped here.
        const socket: any = this.socket
        if (socket && socket.readyState !== WS_OPEN) { this.#dropSend(out, `socket not open (readyState ${socket.readyState})`); return }
        if (!this.#ephemeralDedupe.shouldSend(out)) return
        try { super.send(out) } catch (e: any) { this.#dropSend(out, e?.message ?? String(e)) }
    }

    #dropSend(message: Message, why: string): void {
        this.droppedSends++
        const socket = this.socket ?? null
        if (this.#dropLoggedFor === socket) return
        this.#dropLoggedFor = socket
        const doc = (message as any).documentId ? ` doc ${(message as any).documentId}` : ''
        log(`WS ${this.url}: dropping ${message.type}${doc} and further sends on this socket: ${why}; the peer resyncs after the reconnect (engine#512, ${this.droppedSends} dropped so far)`)
    }

    /** Idempotent: removeNetworkAdapter calls it again after a refusal already closed the socket. */
    override disconnect(): void {
        this.#liveness.detach()
        if (!this.socket || !this.peerId) return
        // idea#332: close-before-connect must not surface as an uncaught 'error'.
        guardReleasedSocket(this.socket, this.url)
        super.disconnect()
    }

    #refuse(r: ClientRefusal): void {
        if (this.refusal) return
        this.refusal = r
        this.#admitted = false
        ;(this as any).retryInterval = 0   // the stock onClose must not redial
        try { this.disconnect() } catch { /* socket already gone */ }
        this.#onRefused(r)
    }
}
