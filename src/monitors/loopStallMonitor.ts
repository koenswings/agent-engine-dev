/**
 * loopStallMonitor.ts (engine#512): log when the Engine's main event loop was blocked.
 *
 * While the main thread runs one long synchronous task (Automerge work on the large
 * store doc, a big storage load, a sync-heavy dock pass at start), nothing else runs:
 * no timers, no socket reads, no pongs. That is what starved the Engine's outgoing
 * peer links into the #168 watchdog's 65 s drop on idea04 (11-17 16:54:30). WsLiveness
 * no longer counts such a stall as the peer's silence; this monitor makes the stall
 * itself visible, with the log lines around it, so the blocking step can be named
 * from the pm2 log (Pi proof of engine#512).
 *
 * A tick every `intervalMs`; a tick later than `intervalMs + thresholdMs` logs one line:
 *   [loop-stall] event loop blocked ~N ms (last log before: "..."; at resume: "...")
 * Never throws, never writes to a doc, unref'd (does not keep the process alive).
 */
import { lastLogLine, log } from '../utils/utils.js'

export interface LoopStallOptions {
    intervalMs?: number
    thresholdMs?: number
    now?: () => number
    lastLine?: () => string
    report?: (line: string) => void
}

export interface LoopStallMonitor {
    /** One step (exported for tests). Returns the stall in ms when one was logged, else 0. */
    tick(): number
    stop(): void
    readonly stalls: number
    readonly maxStallMs: number
}

const clip = (s: string): string => {
    const one = s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim()
    return one.length > 160 ? `${one.slice(0, 157)}...` : one
}

export const startLoopStallMonitor = (opts: LoopStallOptions = {}): LoopStallMonitor => {
    const intervalMs = opts.intervalMs ?? 500
    const thresholdMs = opts.thresholdMs ?? 2_000
    const now = opts.now ?? Date.now
    const lastLine = opts.lastLine ?? lastLogLine
    const report = opts.report ?? ((line: string) => log(line))
    let last = now()
    let lineBefore = lastLine()
    let stalls = 0
    let maxStallMs = 0
    const tick = (): number => {
        const t = now()
        const blocked = t - last - intervalMs
        last = t
        const lineNow = lastLine()
        let logged = 0
        if (blocked > thresholdMs) {
            stalls++
            maxStallMs = Math.max(maxStallMs, blocked)
            report(`[loop-stall] event loop blocked ~${blocked} ms (last log before: "${clip(lineBefore)}"; at resume: "${clip(lineNow)}") (engine#512)`)
            logged = blocked
        }
        lineBefore = lineNow
        return logged
    }
    const timer = setInterval(() => { try { tick() } catch { /* never */ } }, intervalMs)
    ;(timer as any).unref?.()
    return {
        tick,
        stop: () => clearInterval(timer),
        get stalls() { return stalls },
        get maxStallMs() { return maxStallMs },
    }
}
