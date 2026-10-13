// r86l: the walker's store-doc (3zoqd) Automerge Repo OFF the main thread.
// r86l FAIL@42 (loop-watchdog 150 s, rss 2.0 GB): after copy_app the main thread opened a fresh
// store-doc connection to idea01 ("Connecting idea01 … doc 3zoqd") and the full first sync ran
// (Automerge WASM receiveSyncMessage) on the walker's main thread, so no timer could fire.
// One worker = one connection attempt to ONE Engine: own Repo + WS, handshake, wait for the store doc
// (same rules as RealFleetOps.awaitStoreDoc), then keep it synced and post JSON snapshots to the main
// thread (throttled). Writes arrive as JSON ops (set / del / push) and are applied in handle.change.
import { parentPort, workerData } from 'node:worker_threads'
import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'

const { url, docId, logicalId, deadline, handshakeMs, peerId, snapshotMs = 500, memEveryMs = 15_000 } = workerData
const post = (m) => { try { parentPort.postMessage(m) } catch { /* parent gone */ } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Same behaviour as TrackedWebSocketClientAdapter (realFleetOps.ts): socket errors are reported, never
// thrown; a send on a socket that is not OPEN is dropped (r86g outdated-document wedge); closed for good.
class Adapter extends WebSocketClientAdapter {
    closedForGood = false
    droppedSends = 0
    constructor() {
        super(url, 2000)
        this.onError = (event) => {
            const err = event?.error
            post({ event: 'ws', kind: 'socket-error', detail: `socket ${err?.code ?? err?.message ?? 'error'}` })
        }
    }
    connect(p, meta) { if (!this.closedForGood) super.connect(p, meta) }
    send(message) {
        const s = this.socket
        if (s && s.readyState !== 1) {
            this.droppedSends++
            post({ event: 'ws', kind: 'error', detail: `send dropped: socket readyState ${s.readyState} (not OPEN)`, dropped: this.droppedSends })
            return
        }
        super.send(message)
    }
    disconnect() {
        this.closedForGood = true
        try { this.socket?.on?.('error', () => {}) } catch { /* ignore */ }
        super.disconnect()
    }
}

// The library's bare 60 s whenReady timeouts reject unawaited; never let them kill the worker.
process.on('unhandledRejection', (r) => post({ event: 'rejection', message: r instanceof Error ? `${r.name}: ${r.message}` : String(r) }))

const adapter = new Adapter()
const repo = new Repo({ network: [adapter], peerId })
const ns = repo.networkSubsystem
let peers = 0
ns.on('peer', () => { peers = repo.peers.length; post({ event: 'peers', n: peers }) })
ns.on('peer-disconnected', () => { peers = repo.peers.length; post({ event: 'peers', n: peers }) })

const memTimer = setInterval(() => {
    const m = process.memoryUsage()
    post({ event: 'mem', heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers })
}, memEveryMs)

let handle = null
const snapshot = () => {
    const t0 = performance.now()
    const json = JSON.stringify(handle.doc())
    return { json, heads: handle.heads?.() ?? null, ms: Math.round(performance.now() - t0) }
}
let snapTimer = null
const scheduleSnapshot = () => {
    if (snapTimer) return
    snapTimer = setTimeout(() => { snapTimer = null; try { post({ event: 'snapshot', ...snapshot() }) } catch (e) { post({ event: 'rejection', message: `snapshot: ${e?.message ?? e}` }) } }, snapshotMs)
}

const handshake = () => new Promise((resolve) => {
    if (repo.peers.length > 0) return resolve(true)
    const t = setTimeout(() => { ns.off('peer', on); resolve(false) }, handshakeMs)
    const on = () => { clearTimeout(t); ns.off('peer', on); resolve(true) }
    ns.on('peer', on)
})

const awaitDoc = async () => {
    let syncMsgs = 0, drops = 0, docUnavailable = false
    const onMsg = (m) => {
        if (m?.documentId !== docId) return
        if (m.type === 'doc-unavailable') docUnavailable = true
        else if (m.type === 'sync' || m.type === 'request') { syncMsgs++; docUnavailable = false }
    }
    const onPeer = () => { docUnavailable = false }
    const onDrop = () => { drops++ }
    ns.on('message', onMsg); ns.on('peer', onPeer); ns.on('peer-disconnected', onDrop)
    try {
        handle = repo.findWithProgress(docId).handle
        const summary = () => `${syncMsgs} sync msg(s) for the doc, ${drops} WS drop(s), handle ${handle.state}`
        let unavailableSince = null
        while (Date.now() < deadline) {
            if (handle.isReady()) return { kind: 'ready' }
            if (repo.peers.length > 0 && docUnavailable && handle.state === 'unavailable') {
                unavailableSince ??= Date.now()
                if (Date.now() - unavailableSince >= 1_500) return { kind: 'doc-unavailable', detail: `engine answered doc-unavailable; ${summary()}` }
            } else unavailableSince = null
            await sleep(100)
        }
        if (handle.isReady()) return { kind: 'ready' }
        if (repo.peers.length === 0) return { kind: 'ws-closed', detail: summary() }
        return { kind: 'stall', detail: docUnavailable ? `engine answered doc-unavailable; ${summary()}` : summary() }
    } finally {
        ns.off('message', onMsg); ns.off('peer', onPeer); ns.off('peer-disconnected', onDrop)
    }
}

// JSON ops from the main thread (see storeDocLink.ts diffOps). Paths are key arrays from the doc root.
const walk = (root, path) => { let o = root; for (const k of path) { if (o == null) return undefined; o = o[k] } return o }
const applyOps = (d, ops) => {
    for (const op of ops) {
        const parent = walk(d, op.path.slice(0, -1))
        const key = op.path[op.path.length - 1]
        if (op.op === 'push') { const arr = walk(d, op.path); if (!Array.isArray(arr)) throw new Error(`push on non-list ${op.path.join('.')}`); arr.push(...op.values) }
        else if (parent == null) throw new Error(`no parent for ${op.path.join('.')}`)
        else if (op.op === 'del') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key] }
        else parent[key] = op.value
    }
}

let closing = false
parentPort.on('message', (m) => {
    if (m?.type === 'shutdown') {
        closing = true
        clearInterval(memTimer)
        if (snapTimer) clearTimeout(snapTimer)
        Promise.resolve().then(() => repo.shutdown()).catch(() => {}).finally(() => setTimeout(() => process.exit(0), 200))
        return
    }
    if (m?.type === 'change') {
        try {
            if (!handle?.isReady()) throw new Error(`store doc not ready (handle ${handle?.state ?? 'none'})`)
            if (repo.peers.length === 0) throw new Error('Websocket not ready (no peer): write not sent')
            handle.change((d) => applyOps(d, m.ops))
            post({ id: m.id, ok: true, ...snapshot() })
        } catch (e) {
            post({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
        }
    }
})

const started = Date.now()
const ok = await handshake()
if (!ok) post({ event: 'outcome', kind: 'unreachable', detail: `no WS handshake within ${handshakeMs}ms`, tookMs: Date.now() - started })
else {
    const out = await awaitDoc()
    if (out.kind === 'ready' && !closing) {
        handle.on('change', scheduleSnapshot)
        post({ event: 'outcome', kind: 'ready', tookMs: Date.now() - started, ...snapshot() })
    } else post({ event: 'outcome', ...out, tookMs: Date.now() - started })
}
