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
 */

import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { cbor, Message, PeerId, PeerMetadata } from '@automerge/automerge-repo'
import { parseRefusalMessage, peerVerdict, PeerVerdict } from './StoreScope.js'

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
}

/** Small messages are peeked before the stock adapter sees them (handshake/error replies are tiny). */
const PEEK_MAX_BYTES = 4096

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

    constructor(url: string, opts: StoreScopedClientOptions) {
        super(url, opts.retryInterval ?? 5000)
        this.ownTag = opts.ownTag
        this.#onRefused = opts.onRefused
        this.#docGuard = opts.docGuard
    }

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

    override send(message: Message): void {
        if (this.refusal) return
        if (message.type !== 'join' && !this.#admitted) return
        const out = guardOutgoing(message, this.#docGuard)
        if (out) super.send(out)
    }

    /** Idempotent: removeNetworkAdapter calls it again after a refusal already closed the socket. */
    override disconnect(): void {
        if (!this.socket || !this.peerId) return
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
