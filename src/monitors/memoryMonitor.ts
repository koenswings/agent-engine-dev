/**
 * engine#471: hourly memory line in the Engine log.
 *
 * idea01 reached ~1.75 GB RSS with a V8 heap of only ~158 MiB: the rest is
 * native. Automerge runs in WebAssembly, and its linear memory is counted in
 * process.memoryUsage().external (not arrayBuffers) and never shrinks. A box
 * harness (3 Engine repos on loopback) showed that every Engine loads the
 * command-log docs its peers announce, and that one busy day's command log
 * (all of its strings are Automerge text, one op per character) takes several
 * hundred MB of wasm memory once loaded. This line lets a Pi run show which
 * field grows and how many documents, and how many command logs, are loaded.
 *
 * Read-only: process.memoryUsage() plus a count over repo.handles. It never
 * calls into Automerge (no save, no getAllChanges), so it allocates nothing in
 * wasm memory itself.
 */
import { log } from '../utils/utils.js'

/** Once an hour (plus one line at start). */
export const MEMORY_LOG_INTERVAL_MS = 60 * 60 * 1000

const MIB = 1024 * 1024

export interface MemorySnapshot {
    rss: number
    heapUsed: number
    heapTotal: number
    external: number
    arrayBuffers: number
    /** Documents in the Repo's cache (any state). */
    docs: number
    /** Of those, loaded (ready). */
    docsReady: number
    /** Loaded documents shaped like a command log ({ traces, recentTraceIds }). */
    commandLogs: number
    /** Whether this Engine's own current command log is among them. */
    ownCommandLogLoaded: boolean
}

/** Minimal view of a Repo: only its handle cache is read. */
export interface HandleCacheView {
    handles: Record<string, { isReady?: () => boolean, doc?: () => unknown, documentId?: string }>
}

/** A loaded doc with the command-log shape (CommandLogStore.ts). */
export const isCommandLogShape = (doc: unknown): boolean => {
    const d = doc as any
    return !!d && typeof d === 'object' && typeof d.traces === 'object' && d.traces !== null && Array.isArray(d.recentTraceIds)
}

export const memorySnapshot = (
    repo: HandleCacheView,
    ownCommandLogId?: string | null,
    usage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
): MemorySnapshot => {
    const m = usage()
    let docs = 0, docsReady = 0, commandLogs = 0, ownCommandLogLoaded = false
    for (const [id, h] of Object.entries(repo.handles ?? {})) {
        docs++
        let ready = false
        try { ready = !!h?.isReady?.() } catch { ready = false }
        if (!ready) continue
        docsReady++
        let doc: unknown
        try { doc = h.doc?.() } catch { doc = undefined }
        if (isCommandLogShape(doc)) {
            commandLogs++
            if (ownCommandLogId && String(id) === String(ownCommandLogId)) ownCommandLogLoaded = true
        }
    }
    return {
        rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers,
        docs, docsReady, commandLogs, ownCommandLogLoaded,
    }
}

const mib = (n: number): string => `${Math.round(n / MIB)}MiB`

/**
 * One grep-able line, e.g.
 * `[memory] rss=1706MiB heapUsed=121MiB heapTotal=158MiB external=1480MiB arrayBuffers=3MiB docs=6 ready=6 commandLogs=4 ownCommandLog=yes uptime=8.0h`
 * external minus arrayBuffers is mostly Automerge's wasm memory.
 */
export const formatMemoryLine = (s: MemorySnapshot, uptimeSec: number): string =>
    `[memory] rss=${mib(s.rss)} heapUsed=${mib(s.heapUsed)} heapTotal=${mib(s.heapTotal)} external=${mib(s.external)} arrayBuffers=${mib(s.arrayBuffers)}` +
    ` docs=${s.docs} ready=${s.docsReady} commandLogs=${s.commandLogs} ownCommandLog=${s.ownCommandLogLoaded ? 'yes' : 'no'} uptime=${(uptimeSec / 3600).toFixed(1)}h`

export interface MemoryMonitorOptions {
    intervalMs?: number
    /** Doc id of this Engine's current command log (read on every tick: it rotates daily). */
    ownCommandLogId?: () => string | null | undefined
    sink?: (line: string) => void
    usage?: () => NodeJS.MemoryUsage
    uptime?: () => number
}

/** Log one line now and then every intervalMs. Returns a stop function. The timer does not keep the process alive. */
export const startMemoryMonitor = (repo: HandleCacheView, opts: MemoryMonitorOptions = {}): (() => void) => {
    const sink = opts.sink ?? ((line: string) => log(line, 1))
    const uptime = opts.uptime ?? (() => process.uptime())
    const tick = () => {
        try {
            sink(formatMemoryLine(memorySnapshot(repo, opts.ownCommandLogId?.() ?? null, opts.usage), uptime()))
        } catch (e) {
            sink(`[memory] snapshot failed: ${e instanceof Error ? e.message : e}`)
        }
    }
    tick()
    const t = setInterval(tick, opts.intervalMs ?? MEMORY_LOG_INTERVAL_MS)
    t.unref?.()
    return () => clearInterval(t)
}
