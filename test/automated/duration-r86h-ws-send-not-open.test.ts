/**
 * r86g: 121× "Attempting to change an outdated document" on the walker's idea01/idea03 repos. The first
 * error was "Websocket not ready (2)", thrown by WebSocketClientAdapter.send() from inside
 * DocSynchronizer's handle.update() (receiveSyncMessage, then the reply). The handle kept the outdated
 * pre-receive doc, and every later sync failed, so the view froze until a reconnect. A send on a
 * socket that is not OPEN is now dropped. The sync protocol re-sends after the reconnect.
 */
import { describe, expect, it } from 'vitest'
import { next as A } from '@automerge/automerge'
import { TrackedWebSocketClientAdapter } from '../duration/realFleetOps.js'

const msg = { type: 'sync', senderId: 'me', targetId: 'eng', documentId: 'doc', data: new Uint8Array([1, 2, 3]) } as never

describe('r86h: TrackedWebSocketClientAdapter.send never throws on a non-OPEN socket', () => {
    for (const state of [0, 2, 3]) {
        it(`readyState ${state}: dropped and counted, no throw (would wedge the DocHandle)`, () => {
            const a = new TrackedWebSocketClientAdapter('ws://127.0.0.1:1', 2000, 'idea01')
            const sent: unknown[] = []
            Object.assign(a, { peerId: 'me', socket: { readyState: state, send: (b: unknown) => sent.push(b) } })
            expect(() => a.send(msg)).not.toThrow()
            expect(a.droppedSends).toBe(1)
            expect(sent).toHaveLength(0)
        })
    }
    it('OPEN socket: sends as before', () => {
        const a = new TrackedWebSocketClientAdapter('ws://127.0.0.1:1', 2000, 'idea01')
        const sent: unknown[] = []
        Object.assign(a, { peerId: 'me', socket: { readyState: 1, send: (b: unknown) => sent.push(b) } })
        a.send(msg)
        expect(sent).toHaveLength(1)
        expect(a.droppedSends).toBe(0)
    })
    it('the library adapter itself still throws (why the override exists)', async () => {
        const { WebSocketClientAdapter } = await import('@automerge/automerge-repo-network-websocket')
        const a = new WebSocketClientAdapter('ws://127.0.0.1:1', 2000)
        Object.assign(a, { peerId: 'me', socket: { readyState: 2, send: () => {} } })
        expect(() => a.send(msg)).toThrow(/Websocket not ready \(2\)/)
    })
    it('mechanism: once receiveSyncMessage has run, the old doc object is outdated (what the handle kept)', () => {
        const engine = A.change(A.init<{ n: number }>(), d => { d.n = 1 })
        let es = A.initSyncState(), ws = A.initSyncState()
        let walker = A.init<{ n: number }>()
        let m: Uint8Array | null
        ;[es, m] = A.generateSyncMessage(engine, es)
        const [advanced] = A.receiveSyncMessage(walker, ws, m!)
        expect(() => A.receiveSyncMessage(walker, ws, m!)).toThrow(/outdated document/)
        expect(advanced).toBeDefined()
        walker = advanced
    })
})
