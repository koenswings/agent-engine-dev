/**
 * r86l: main-thread side of storeDocWorker.mjs (Steve 03:0x: ALL walker Automerge off the main thread).
 * The main thread keeps only a plain-JSON snapshot of the store doc (posted by the worker, throttled)
 * and talks to the worker with messages under real wall-clock timeouts — those timers can fire,
 * because no Automerge sync apply runs here any more. Writes are computed on a clone of the snapshot
 * and shipped as JSON ops (set / del / push), applied by the worker inside handle.change.
 */
import { Worker } from 'node:worker_threads'
import type { Store } from '../../src/data/Store.js'
import { sharedDocHost, perLinkWorkers, type WorkerLike } from './docHost.js'

export const STORE_DOC_WORKER_URL = new URL('./storeDocWorker.mjs', import.meta.url)

export type JsonOp =
    | { op: 'set'; path: string[]; value: unknown }
    | { op: 'del'; path: string[] }
    | { op: 'push'; path: string[]; values: unknown[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Minimal ops turning `a` into `b` (plain JSON). A list that only grew is a push (keeps concurrent Engine edits). */
export const diffOps = (a: unknown, b: unknown, path: string[] = []): JsonOp[] => {
    if (same(a, b)) return []
    if (isObj(a) && isObj(b)) {
        const ops: JsonOp[] = []
        for (const k of Object.keys(a)) if (!(k in b)) ops.push({ op: 'del', path: [...path, k] })
        for (const k of Object.keys(b)) {
            if (!(k in a)) ops.push({ op: 'set', path: [...path, k], value: b[k] })
            else ops.push(...diffOps(a[k], b[k], [...path, k]))
        }
        return ops
    }
    if (Array.isArray(a) && Array.isArray(b) && b.length > a.length && a.every((x, i) => same(x, b[i]))) {
        return [{ op: 'push', path, values: b.slice(a.length) }]
    }
    if (path.length === 0) throw new Error('diffOps: cannot replace the doc root')
    return [{ op: 'set', path, value: b }]
}

export type StoreOutcome =
    | { kind: 'ready'; tookMs: number }
    | { kind: 'doc-unavailable' | 'ws-closed' | 'stall' | 'unreachable'; detail: string; tookMs: number }

export interface WorkerMem { heapUsed: number; external: number; arrayBuffers: number; at: number }

export interface StoreDocLinkOpts {
    logicalId: string
    url: string
    docId: string
    deadline: number
    handshakeMs: number
    /** Extra wall-clock time past `deadline` before the main thread gives up on a silent worker. */
    backstopMs?: number
    onWs?: (kind: 'socket-error' | 'error', detail: string) => void
    onPeers?: (n: number) => void
    log?: (s: string) => void
}

/** All live links (RSS sampling reads their worker memory). */
export const liveStoreLinks = new Set<StoreDocLink>()

export class StoreDocLink {
    private worker: WorkerLike
    private snap: Store | undefined
    private snapHeads: string[] | null = null
    private nextId = 1
    private pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
    private peerWaiters = new Set<() => void>()
    private dead: Error | null = null
    private outcomeP: Promise<StoreOutcome>
    peerCount = 0
    mem: WorkerMem | null = null
    snapshots = 0
    lastSnapshotParseMs = 0
    readonly logicalId: string

    constructor(readonly o: StoreDocLinkOpts) {
        this.logicalId = o.logicalId
        const log = o.log ?? console.log
        const data = {
                url: o.url, docId: o.docId, logicalId: o.logicalId, deadline: o.deadline, handshakeMs: o.handshakeMs,
                peerId: `duration-${o.logicalId}-${Date.now()}`,
                snapshotMs: Number(process.env.DURATION_STORE_SNAPSHOT_MS ?? 500),
                memEveryMs: Number(process.env.DURATION_WORKER_MEM_MS ?? 15_000),
        }
        // r86p: all links share one doc-host thread (one Automerge WASM) unless DURATION_DOC_HOST=per-link.
        this.worker = perLinkWorkers() ? new Worker(STORE_DOC_WORKER_URL, { workerData: data, execArgv: [] }) : sharedDocHost.open('store', data)
        this.worker.unref()
        liveStoreLinks.add(this)
        let settle!: (o: StoreOutcome) => void
        this.outcomeP = new Promise(r => { settle = r })
        const backstop = setTimeout(() => {
            settle({ kind: 'stall', detail: `store worker gave no outcome ${Math.round(((o.backstopMs ?? 15_000) + Math.max(0, o.deadline - Date.now())) / 1000)}s (wall clock, main thread free)`, tookMs: -1 })
        }, Math.max(0, o.deadline - Date.now()) + (o.backstopMs ?? 15_000))
        backstop.unref()
        this.worker.on('message', (m: Record<string, unknown>) => {
            if (typeof m.id === 'number') {
                const p = this.pending.get(m.id)
                if (!p) return
                this.pending.delete(m.id)
                clearTimeout(p.timer)
                if (m.ok) { this.take(m); p.resolve() } else p.reject(new Error(String(m.error)))
                return
            }
            switch (m.event) {
                case 'outcome':
                    clearTimeout(backstop)
                    if (m.kind === 'ready') this.take(m)
                    settle(m.kind === 'ready'
                        ? { kind: 'ready', tookMs: Number(m.tookMs) }
                        : { kind: m.kind as 'stall', detail: String(m.detail), tookMs: Number(m.tookMs) })
                    break
                case 'snapshot': this.take(m); break
                case 'peers':
                    this.peerCount = Number(m.n) || 0
                    o.onPeers?.(this.peerCount)
                    if (this.peerCount > 0) { for (const w of this.peerWaiters) w(); this.peerWaiters.clear() }
                    break
                case 'ws': o.onWs?.(m.kind as 'error', String(m.detail)); break
                case 'mem': this.mem = { heapUsed: Number(m.heapUsed), external: Number(m.external), arrayBuffers: Number(m.arrayBuffers), at: Date.now() }; break
                case 'rejection': log(JSON.stringify({ event: 'store_worker_rejection', engine: o.logicalId, message: m.message })); break
            }
        })
        const fail = (e: Error) => {
            if (this.dead) return
            this.dead = e
            this.snap = undefined
            if (this.peerCount) o.onPeers?.(0)
            this.peerCount = 0
            liveStoreLinks.delete(this)
            clearTimeout(backstop)
            settle({ kind: 'stall', detail: e.message, tookMs: -1 })
            for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e) }
            this.pending.clear()
        }
        this.worker.on('error', e => fail(e instanceof Error ? e : new Error(String(e))))
        this.worker.on('exit', code => fail(new Error(`store worker for ${o.logicalId} exited (${code})`)))
    }

    private take(m: Record<string, unknown>): void {
        if (typeof m.json !== 'string') return
        const t0 = performance.now()
        this.snap = JSON.parse(m.json) as Store
        this.lastSnapshotParseMs = performance.now() - t0
        this.snapHeads = Array.isArray(m.heads) ? (m.heads as string[]) : null
        this.snapshots++
    }

    outcome(): Promise<StoreOutcome> { return this.outcomeP }
    get alive(): boolean { return this.dead === null }

    /** DocHandle-like surface used by RealFleetOps (plain JSON snapshot; undefined until ready / after death). */
    doc(): Store | undefined { return this.dead ? undefined : this.snap }
    heads(): string[] | null { return this.snapHeads }

    /** Wall-clock bounded write. Rejects (→ changeStore reconnect + StoreWriteError) on worker error or timeout. */
    change(fn: (s: Store) => void, timeoutMs = Number(process.env.DURATION_STORE_WRITE_TIMEOUT_MS ?? 15_000)): Promise<void> {
        if (this.dead) return Promise.reject(this.dead)
        if (!this.snap) return Promise.reject(new Error(`store doc of ${this.logicalId} not ready`))
        const before = this.snap
        const draft = structuredClone(before)
        fn(draft)
        const ops = diffOps(before, draft)
        if (!ops.length) return Promise.resolve()
        const id = this.nextId++
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`store write to ${this.logicalId} not acknowledged by its worker within ${timeoutMs}ms`))
            }, timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
            this.worker.postMessage({ type: 'change', id, ops })
        })
    }

    /** True once the worker's Repo has an open WS peer; false after `ms` (wall clock). */
    waitPeer(ms: number): Promise<boolean> {
        if (this.peerCount > 0) return Promise.resolve(true)
        if (this.dead) return Promise.resolve(false)
        return new Promise(resolve => {
            const done = () => { clearTimeout(t); resolve(true) }
            const t = setTimeout(() => { this.peerWaiters.delete(done); resolve(false) }, ms)
            this.peerWaiters.add(done)
        })
    }

    /** Called once with the reason when the walker closes this link (timeout-guard bookkeeping). */
    onClose: ((reason: string) => void) | null = null

    async close(reason = 'closed by walker'): Promise<void> {
        this.onClose?.(reason)
        this.onClose = null
        liveStoreLinks.delete(this)
        if (this.dead) return
        const exited = new Promise<void>(r => this.worker.once('exit', () => r()))
        this.worker.postMessage({ type: 'shutdown' })
        const t = setTimeout(() => { void this.worker.terminate() }, 2_500)
        await exited
        clearTimeout(t)
    }
}
