/**
 * wsSyncClientWorker.ts — one fresh WebSocket client (a classroom device) in its own thread.
 *
 * Used by ws-concurrent-sync.test.ts. Each worker has its own event loop, like a
 * separate device, so one client's Automerge load never delays another client's
 * pong. It builds a fresh Repo (no storage, no shared heads) with a
 * WebSocketClientAdapter, does repo.find(docId) and waits for 'ready', then
 * posts a result and exits.
 *
 * Protocol: the worker loads its modules (including the Automerge wasm) and
 * posts { type: 'ready' }; it connects only when the parent posts { type: 'go' }.
 * The parent sends 'go' to all workers at once, so the clients are booted
 * devices connecting at the same instant, and thread start-up (10 wasm
 * instantiations competing for the cores) is not part of the measurement.
 */

import { parentPort, workerData } from 'worker_threads'
import { Repo, DocumentId, PeerId } from '@automerge/automerge-repo'
import { next as A } from '@automerge/automerge'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'

export interface WsSyncClientInput {
    url: string, docId: string, index: number, timeoutMs: number, retryIntervalMs: number
    /**
     * Keep waiting for 'ready' when the handle goes 'unavailable' (it does when
     * the only peer drops) instead of failing like a plain find() does. Used to
     * check that a client converges after a reconnect.
     */
    tolerateUnavailable?: boolean
}
export interface WsSyncClientResult {
    index: number
    ok: boolean
    elapsedMs: number
    state: string
    error?: string
    /** WS handshake done (socket 'open'), ms after start */
    openMs?: number
    /** server answered our join ('peer' message), ms after start */
    peerMs?: number
    peerConnects: number
    peerDisconnects: number
    firstDisconnectMs?: number
    /** the handle was seen in state 'unavailable' at some point */
    sawUnavailable?: boolean
}

const run = async (input: WsSyncClientInput): Promise<WsSyncClientResult> => {
    const t0 = performance.now()
    const since = () => Math.round(performance.now() - t0)
    const adapter = new WebSocketClientAdapter(input.url, input.retryIntervalMs)
    let openMs: number | undefined, peerMs: number | undefined
    const onOpen = adapter.onOpen
    adapter.onOpen = () => { openMs ??= since(); onOpen() }
    const repo = new Repo({ network: [adapter], peerId: `wsconc-client-${input.index}-${Date.now()}` as PeerId })
    let peerConnects = 0, peerDisconnects = 0, firstDisconnectMs: number | undefined
    adapter.on('peer-candidate', () => { peerConnects++; peerMs ??= since() })
    adapter.on('peer-disconnected', () => { peerDisconnects++; firstDisconnectMs ??= since() })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${input.timeoutMs} ms`)), input.timeoutMs) })
    let state = 'none'
    let sawUnavailable = false
    try {
        if (input.tolerateUnavailable) {
            const handle = await Promise.race([repo.find(input.docId as DocumentId, { allowableStates: ['ready', 'unavailable', 'requesting'] }), timeout])
            const deadline = performance.now() + input.timeoutMs
            while (!handle.isReady() && performance.now() < deadline) {
                if (handle.state === 'unavailable') sawUnavailable = true
                await new Promise(r => setTimeout(r, 25))
            }
            state = handle.state
            return { index: input.index, ok: handle.isReady(), elapsedMs: since(), state, error: handle.isReady() ? undefined : `not ready after ${input.timeoutMs} ms`, openMs, peerMs, peerConnects, peerDisconnects, firstDisconnectMs, sawUnavailable }
        }
        const handle = await Promise.race([repo.find(input.docId as DocumentId), timeout])
        await Promise.race([handle.whenReady(), timeout])
        state = handle.state
        return { index: input.index, ok: handle.isReady(), elapsedMs: since(), state, openMs, peerMs, peerConnects, peerDisconnects, firstDisconnectMs }
    } catch (e) {
        const h = repo.handles[input.docId as DocumentId]
        state = h?.state ?? state
        return { index: input.index, ok: false, elapsedMs: since(), state, error: e instanceof Error ? e.message : String(e), openMs, peerMs, peerConnects, peerDisconnects, firstDisconnectMs }
    } finally {
        clearTimeout(timer)
    }
}

if (parentPort && workerData) {
    A.save(A.from({ warm: true })) // wasm instantiated and exercised before 'ready'
    parentPort.once('message', () => void run(workerData as WsSyncClientInput).then(result => {
        parentPort!.postMessage(result)
        // The result is posted; leave without a close handshake (a socket that is
        // still connecting would raise an error on close). Exits this thread only.
        process.exit(0)
    }))
    parentPort.postMessage({ type: 'ready' })
}
