/**
 * pairAdapter.ts (engine#512): an in-memory NetworkAdapter for wiring two Repos in a test
 * without sockets, with a switch that makes send() THROW the way the stock
 * WebSocketClientAdapter does on a CLOSING socket ("Websocket not ready (2)").
 *
 * Messages are queued (out) and moved by pump(); nothing is delivered on its own, so a
 * test decides exactly which message arrives when.
 */
import { NetworkAdapter, Message, PeerId, PeerMetadata } from '@automerge/automerge-repo'

export class PairAdapter extends NetworkAdapter {
    out: Message[] = []
    /** true = send() throws like the stock client adapter on a non-OPEN socket. */
    broken = false
    sendThrows = 0
    isReady(): boolean { return true }
    whenReady(): Promise<void> { return Promise.resolve() }
    connect(peerId: PeerId, peerMetadata?: PeerMetadata): void { this.peerId = peerId; this.peerMetadata = peerMetadata }
    send(message: Message): void {
        if (this.broken) { this.sendThrows++; throw new Error('Websocket not ready (2)') }
        this.out.push(message)
    }
    disconnect(): void { /* nothing */ }
    announce(remote: PeerId): void { this.emit('peer-candidate', { peerId: remote, peerMetadata: {} }) }
    deliver(message: Message): void { this.emit('message', message) }
}

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

/** Link two adapters (both Repos must already be constructed with them; the Repo connects them a tick later). */
export const link = async (a: PairAdapter, b: PairAdapter): Promise<void> => {
    for (let i = 0; i < 200 && !(a.peerId && b.peerId); i++) await tick(1)
    if (!a.peerId || !b.peerId) throw new Error('PairAdapter: the Repos never connected their adapters')
    a.announce(b.peerId!)
    b.announce(a.peerId!)
}

/**
 * Move queued messages a -> b and b -> a until both queues stay empty for a few rounds
 * (or `rounds` is reached). `filter` may hold back a message (return false: dropped).
 */
export const pump = async (a: PairAdapter, b: PairAdapter, opts: { rounds?: number, filter?: (m: Message, from: 'a' | 'b') => boolean } = {}): Promise<void> => {
    let quiet = 0
    for (let i = 0; i < (opts.rounds ?? 2000) && quiet < 50; i++) {   // quiet: > the Repo's 100 ms sync debounce
        await tick()
        const fromA = a.out.splice(0)
        const fromB = b.out.splice(0)
        if (!fromA.length && !fromB.length) { quiet++; continue }
        quiet = 0
        for (const m of fromA) if (!opts.filter || opts.filter(m, 'a')) b.deliver(m)
        for (const m of fromB) if (!opts.filter || opts.filter(m, 'b')) a.deliver(m)
    }
}
