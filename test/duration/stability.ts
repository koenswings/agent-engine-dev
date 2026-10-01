/**
 * Phase 4 stability monitoring during dwell (idea#168 / proposals/duration-tests.md §7).
 *
 * Every ~30s (or compressed under --fast): WS ping + optional docker/status probe.
 * Fail the walk after `failAfter` consecutive probe failures (default 3).
 */
import type { FleetOps, SemanticStoreView } from './types.js'

export interface StabilityProbeSample {
    ts: string
    ok: boolean
    detail?: string
    engines: { id: string; wsUp: boolean; dockerOk?: boolean; statusAnomaly?: string }[]
}

export interface StabilityProbeOptions {
    ops: FleetOps
    engines: string[]
    /** Interval between probes during dwell (default 30_000; --fast → 50). */
    intervalMs: number
    /** Consecutive failures before walk aborts (default 3). */
    failAfter: number
    /** Total dwell window for this inter-transition gap. */
    dwellMs: number
    onProbe?: (sample: StabilityProbeSample) => void
}

export interface StabilityProbeResult {
    ok: boolean
    samples: StabilityProbeSample[]
    consecutiveFailures: number
    abortReason?: string
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Snapshot Running instances from semantic views — used by Fake + Real to detect
 * unexpected status flips during dwell.
 */
export const snapshotRunning = (views: SemanticStoreView[]): Map<string, string> => {
    const map = new Map<string, string>()
    for (const v of views) {
        for (const inst of Object.values(v.instanceDB)) {
            map.set(`${v.engineId}:${inst.id}`, inst.status)
        }
    }
    return map
}

export const detectStatusAnomalies = (
    before: Map<string, string>,
    after: Map<string, string>,
): string[] => {
    const anomalies: string[] = []
    for (const [key, prev] of before) {
        const next = after.get(key)
        if (next === undefined) continue
        // Unexpected: Running → Error / Missing / Crash without an action.
        if (prev === 'Running' && next !== 'Running' && next !== 'Undocked' && next !== 'Stopped') {
            anomalies.push(`${key} ${prev}→${next}`)
        }
    }
    return anomalies
}

/**
 * Run probes for `dwellMs`, sampling every `intervalMs`.
 * Returns ok:false when consecutive failures hit failAfter.
 */
export const runStabilityDuringDwell = async (
    opts: StabilityProbeOptions,
): Promise<StabilityProbeResult> => {
    const samples: StabilityProbeSample[] = []
    let consecutive = 0
    const deadline = Date.now() + Math.max(0, opts.dwellMs)

    // Baseline semantic statuses (best-effort).
    let baseline = new Map<string, string>()
    try {
        const views = await Promise.all(opts.engines.map(id => opts.ops.readStore(id)))
        baseline = snapshotRunning(views)
    } catch {
        baseline = new Map()
    }

    // Always take at least one probe when dwell > 0; under --fast dwell may be tiny.
    const doProbe = async (): Promise<StabilityProbeSample> => {
        if (opts.ops.probeStability) {
            const raw = await opts.ops.probeStability(opts.engines)
            // Re-check semantic anomalies on top of adapter probe.
            let anomaly: string | undefined
            try {
                const views = await Promise.all(opts.engines.map(id => opts.ops.readStore(id)))
                const now = snapshotRunning(views)
                const a = detectStatusAnomalies(baseline, now)
                if (a.length) anomaly = a.join('; ')
            } catch { /* ignore */ }
            const engines = raw.engines.map(e => ({
                ...e,
                statusAnomaly: e.statusAnomaly ?? anomaly,
            }))
            const ok = raw.ok && !anomaly
            return {
                ts: new Date().toISOString(),
                ok,
                detail: ok ? raw.detail : (raw.detail ?? anomaly ?? 'probe failed'),
                engines,
            }
        }

        // Fallback: waitReady-only when adapter has no probeStability.
        const engines: StabilityProbeSample['engines'] = []
        let ok = true
        for (const id of opts.engines) {
            const ready = await opts.ops.waitReady(id, Math.min(2000, opts.intervalMs))
            engines.push({ id, wsUp: ready.wsUp })
            if (!ready.wsUp) ok = false
        }
        return {
            ts: new Date().toISOString(),
            ok,
            detail: ok ? 'ws ok' : 'ws down',
            engines,
        }
    }

    if (opts.dwellMs <= 0) {
        return { ok: true, samples, consecutiveFailures: 0 }
    }

    // First probe immediately, then every interval until dwell ends.
    while (true) {
        const sample = await doProbe()
        samples.push(sample)
        opts.onProbe?.(sample)
        if (sample.ok) {
            consecutive = 0
        } else {
            consecutive++
            if (consecutive >= opts.failAfter) {
                return {
                    ok: false,
                    samples,
                    consecutiveFailures: consecutive,
                    abortReason: `stability probe failed ${consecutive}× consecutively: ${sample.detail ?? 'unknown'}`,
                }
            }
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await sleep(Math.min(opts.intervalMs, remaining))
        if (Date.now() >= deadline) break
    }

    return { ok: true, samples, consecutiveFailures: consecutive }
}

/** Default dwell / probe timings. */
export const DEFAULT_PROBE_INTERVAL_MS = 30_000
export const DEFAULT_FAIL_AFTER = 3
/** Compressed dwell under --fast (still allows ≥1 probe). */
export const FAST_DWELL_MS = 80
export const FAST_PROBE_INTERVAL_MS = 40
/** Real-time default dwell between transitions when not --fast. */
export const DEFAULT_DWELL_MS = 30_000
