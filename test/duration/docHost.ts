/**
 * r86p: main-thread side of docHostWorker.mjs — ONE worker thread (one Automerge WASM instance) for
 * every walker store-doc link and CommandLog reader, instead of one worker (~550 MB WASM) per link.
 * r86o FAIL@42: 5 per-link workers → walker RSS 2.5 GB, idea02 MemAvailable 297 MB (rss-guard).
 *
 * DocChannel exposes the Worker surface StoreDocLink / CommandLogReader use (postMessage, on/once
 * message|error|exit, terminate, unref), so both classes are unchanged apart from how they spawn.
 * The host thread is started on the first open and terminated once no channel is left (idle grace),
 * which returns its WASM memory to the OS between bursts. DURATION_DOC_HOST=per-link restores r86l.
 */
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'

export const DOC_HOST_WORKER_URL = new URL('./docHostWorker.mjs', import.meta.url)

export type SessionKind = 'store' | 'commandLog'

export interface WorkerLike {
    postMessage(m: unknown): void
    on(ev: 'message', fn: (m: any) => void): this
    on(ev: 'error', fn: (e: Error) => void): this
    on(ev: 'exit', fn: (code: number) => void): this
    once(ev: 'exit', fn: (code: number) => void): this
    terminate(): Promise<number>
    unref(): void
}

export class DocChannel extends EventEmitter implements WorkerLike {
    exited = false
    constructor(readonly host: DocHost, readonly ch: number, readonly kind: SessionKind) { super() }
    postMessage(msg: unknown): void { if (!this.exited) this.host.send({ ch: this.ch, msg }) }
    /** Force-close: the session is asked to shut down and the channel exits at once (code 1). */
    terminate(): Promise<number> {
        if (!this.exited) { this.host.send({ ch: this.ch, msg: { type: 'shutdown' } }); this.host.closed(this, 1) }
        return Promise.resolve(1)
    }
    unref(): void { /* the host worker is unref'd */ }
}

export class DocHost {
    private worker: Worker | null = null
    private nextCh = 1
    private readonly chans = new Map<number, DocChannel>()
    private idleTimer: NodeJS.Timeout | null = null
    /** Host threads started so far (tests: the host is shared, and recycled only when idle). */
    starts = 0
    constructor(private readonly url: URL = DOC_HOST_WORKER_URL, private readonly idleMs = Number(process.env.DURATION_DOC_HOST_IDLE_MS ?? 30_000)) {}

    get openChannels(): number { return this.chans.size }
    get running(): boolean { return this.worker !== null }
    get threadId(): number | null { return this.worker?.threadId ?? null }

    open(kind: SessionKind, data: unknown): DocChannel {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
        const w = this.ensure()
        const c = new DocChannel(this, this.nextCh++, kind)
        this.chans.set(c.ch, c)
        w.postMessage({ ch: c.ch, type: 'open', kind, data })
        return c
    }

    send(m: unknown): void { this.worker?.postMessage(m) }

    closed(c: DocChannel, code: number): void {
        if (c.exited) return
        c.exited = true
        this.chans.delete(c.ch)
        c.emit('exit', code)
        if (this.chans.size === 0 && this.worker && !this.idleTimer) {
            this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.chans.size === 0) void this.stop() }, this.idleMs)
            this.idleTimer.unref()
        }
    }

    async stop(): Promise<void> {
        const w = this.worker
        this.worker = null
        if (w) await w.terminate()
    }

    private ensure(): Worker {
        if (this.worker) return this.worker
        const w = new Worker(this.url, { execArgv: [] })
        this.starts++
        w.unref()
        w.on('message', (m: { ch: number; msg?: unknown; exit?: number }) => {
            const c = this.chans.get(m.ch)
            if (!c) return
            if (m.exit !== undefined) this.closed(c, m.exit)
            else c.emit('message', m.msg)
        })
        const die = (e: Error, code: number) => {
            if (this.worker === w) this.worker = null
            for (const c of [...this.chans.values()]) { if (c.listenerCount('error')) c.emit('error', e); this.closed(c, code) }
        }
        w.on('error', e => die(e instanceof Error ? e : new Error(String(e)), 1))
        w.on('exit', code => {
            if (this.chans.size) die(new Error(`doc host worker exited (${code})`), code)
            else if (this.worker === w) this.worker = null
        })
        this.worker = w
        return w
    }
}

/** The walker's one shared host. */
export const sharedDocHost = new DocHost()

export const perLinkWorkers = (): boolean => process.env.DURATION_DOC_HOST === 'per-link'
