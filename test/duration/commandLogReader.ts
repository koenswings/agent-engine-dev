/**
 * r86k: main-thread side of commandLogWorker.mjs. One worker per pool Engine; every request has a
 * real wall-clock timeout (the main loop is no longer blocked by the CommandLog sync, so it fires).
 * The CommandLog doc is never opened on the walker's main-thread Repos.
 */
import { Worker } from 'node:worker_threads'
import type { DurationCommandTrace } from './actions.js'

export const COMMAND_LOG_WORKER_URL = new URL('./commandLogWorker.mjs', import.meta.url)

export class CommandLogReader {
    private worker: Worker
    private nextId = 1
    private pending = new Map<number, { resolve: (t: DurationCommandTrace[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
    private dead: Error | null = null
    readyMs: number | null = null

    constructor(readonly engine: string, readonly wsUrl: string, readonly docUrl: string, log: (s: string) => void = console.log) {
        this.worker = new Worker(COMMAND_LOG_WORKER_URL, {
            workerData: { wsUrl, docUrl, peerId: `duration-cl-${engine}-${Date.now()}` },
            execArgv: [], // plain .mjs: no tsx loader needed in the worker
        })
        this.worker.unref()
        this.worker.on('message', (m: { id?: number; event?: string; ms?: number; traces?: DurationCommandTrace[]; error?: string }) => {
            if (m.event === 'ready') {
                this.readyMs = m.ms ?? null
                log(JSON.stringify({ event: 'command_log_synced_off_thread', engine, docUrl, ms: m.ms }))
                return
            }
            const p = m.id != null ? this.pending.get(m.id) : undefined
            if (!p) return
            this.pending.delete(m.id!)
            clearTimeout(p.timer)
            if (m.error) p.reject(new Error(m.error))
            else p.resolve(m.traces ?? [])
        })
        const fail = (e: Error) => {
            this.dead = e
            for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e) }
            this.pending.clear()
        }
        this.worker.on('error', e => fail(e instanceof Error ? e : new Error(String(e))))
        this.worker.on('exit', code => { if (!this.dead) fail(new Error(`CommandLog worker for ${engine} exited (${code})`)) })
    }

    get alive(): boolean { return this.dead === null }

    list(timeoutMs = 5_000): Promise<DurationCommandTrace[]> {
        if (this.dead) return Promise.reject(this.dead)
        const id = this.nextId++
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`CommandLog ${this.docUrl} of ${this.engine}: off-thread read timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
            this.worker.postMessage({ id })
        })
    }

    async close(): Promise<void> {
        if (this.dead) return
        const exited = new Promise<void>(r => this.worker.once('exit', () => r()))
        this.worker.postMessage({ type: 'shutdown' })
        const t = setTimeout(() => { void this.worker.terminate() }, 2_000)
        await exited
        clearTimeout(t)
    }
}
