/**
 * engine#564 (Markov c3b30b6 step 91, idea03 pm2 restart): the shared store-host thread was blocked 279 s during
 * a first store sync, and the evidence could not say why (payload size vs walker memory/CPU). While any store
 * sync is in flight, this samples the walker's resources on the MAIN thread (the host thread may be the one that
 * is blocked) every 10 s and logs one greppable `store_sync_resource` line; it stops when no sync is in flight.
 */
import os from 'node:os'
import { readFileSync } from 'node:fs'

export interface InFlightSync {
    engine: string
    startedAt: number
    /** ms since the doc-host thread last answered its heartbeat (null: per-link worker / unknown). */
    hostBlockedMs?: () => number | null
    /** last heap report of the session's worker/host (null until one arrived). */
    workerHeapMb?: () => number | null
}

/** MemAvailable from /proc/meminfo in MB (null where there is no /proc, e.g. macOS). */
export const memAvailableMb = (read: () => string = () => readFileSync('/proc/meminfo', 'utf8')): number | null => {
    try {
        const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(read())
        return m ? Math.round(Number(m[1]) / 1024) : null
    } catch { return null }
}

const MB = 1048576

export const sampleStoreSyncResources = (syncs: readonly InFlightSync[], now = Date.now()): Record<string, unknown> => {
    const mu = process.memoryUsage()
    return {
        event: 'store_sync_resource',
        at: new Date(now).toISOString(),
        inFlight: syncs.map(s => ({
            engine: s.engine,
            sinceMs: now - s.startedAt,
            hostBlockedMs: s.hostBlockedMs?.() ?? null,
            workerHeapMb: s.workerHeapMb?.() ?? null,
        })),
        rssMb: Math.round(mu.rss / MB),
        heapUsedMb: Math.round(mu.heapUsed / MB),
        heapTotalMb: Math.round(mu.heapTotal / MB),
        externalMb: Math.round(mu.external / MB),
        freeMemMb: Math.round(os.freemem() / MB),
        memAvailableMb: memAvailableMb(),
        loadavg: os.loadavg().map(n => Math.round(n * 100) / 100),
    }
}

export interface SamplerOpts {
    intervalMs?: number
    log?: (s: string) => void
    sample?: (syncs: readonly InFlightSync[]) => Record<string, unknown>
}

/** Interval in ms (DURATION_STORE_SYNC_SAMPLE_MS, default 10 s; 0 turns sampling off). */
export const storeSyncSampleMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env.DURATION_STORE_SYNC_SAMPLE_MS
    const n = raw === undefined || raw === '' ? 10_000 : Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 10_000
}

export class StoreSyncResourceSampler {
    private readonly syncs = new Map<object, InFlightSync>()
    private timer: NodeJS.Timeout | null = null
    samples = 0

    constructor(private readonly o: SamplerOpts = {}) {}

    private get intervalMs(): number { return this.o.intervalMs ?? storeSyncSampleMs() }

    get running(): boolean { return this.timer !== null }
    get inFlight(): number { return this.syncs.size }

    /** A store sync started (idempotent per key). Starts the sampler if it is the first one in flight. */
    begin(key: object, s: InFlightSync): void {
        this.syncs.set(key, s)
        if (this.timer || this.intervalMs <= 0) return
        this.timer = setInterval(() => this.tick(), this.intervalMs)
        this.timer.unref()
    }

    /** That sync ended (ready, failed, closed); stops the sampler when none is left. Safe to call twice. */
    end(key: object): void {
        this.syncs.delete(key)
        if (this.syncs.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null }
    }

    tick(): void {
        if (this.syncs.size === 0) return
        const list = [...this.syncs.values()]
        try {
            const line = (this.o.sample ?? sampleStoreSyncResources)(list)
            this.samples++
            ;(this.o.log ?? console.log)(JSON.stringify(line))
        } catch { /* a sample must never break a sync */ }
    }
}

/** The walker's one sampler (all store links). */
export const storeSyncSampler = new StoreSyncResourceSampler()
