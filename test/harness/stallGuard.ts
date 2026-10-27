/**
 * idea#332 option (b): tell a whole-process / whole-box freeze apart from a real test failure.
 *
 * The shared box sometimes freezes every process at once (seen: 460 s and 133 s; in one run the
 * monotonic clock stopped while the wall clock jumped, in others both clocks ran on while every
 * thread starved). A time-sensitive test caught in such a freeze fails with
 * `ENVIRONMENT STALL (Ns): inconclusive — <original error>` instead of a plain timeout.
 *
 * Detector: a dedicated heartbeat worker thread ticks every HEARTBEAT_MS. Each tick takes
 * max(wall gap, monotonic gap); a gap over GAP_MIN_MS adds to a shared counter. The main thread
 * also checks its own wall-vs-monotonic drift over the test (catches a paused VM even if the
 * heartbeat has not ticked yet). A main-thread-only block does NOT count: the heartbeat thread keeps
 * ticking, so a test that blocks its own loop still fails as a normal failure.
 *
 * Never turns a failure into a pass: a passing body passes, a failing body always fails.
 */
import { Worker } from 'node:worker_threads'
import { it } from 'vitest'

export const STALL_MARKER = 'ENVIRONMENT STALL'
export const HEARTBEAT_MS = 100
export const GAP_MIN_MS = 2_000
export const STALL_THRESHOLD_MS = 5_000
/** Extra vitest timeout so the guard's own deadline always reports first, even after a freeze. */
export const GUARD_GRACE_MS = 15_000

const HEARTBEAT_SRC = `
const { workerData, parentPort } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')
const acc = new Int32Array(workerData.sab)
let w = Date.now(), m = performance.now()
setInterval(() => {
    const w2 = Date.now(), m2 = performance.now()
    const gap = Math.max(w2 - w, m2 - m) - ${HEARTBEAT_MS}
    w = w2; m = m2
    if (gap > ${GAP_MIN_MS}) Atomics.add(acc, 0, Math.round(gap))
    Atomics.add(acc, 1, 1)
}, ${HEARTBEAT_MS})
parentPort.on('message', msg => {
    if (msg && msg.freezeMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, msg.freezeMs)
})
`

let hb: { worker: Worker; acc: Int32Array } | null = null
const heartbeat = () => {
    if (!hb) {
        const sab = new SharedArrayBuffer(8)
        const worker = new Worker(HEARTBEAT_SRC, { eval: true, workerData: { sab } })
        worker.unref()
        hb = { worker, acc: new Int32Array(sab) }
    }
    return hb
}

/** Test hook: freeze the heartbeat thread for ms (simulates the box freezing that thread too). */
export const _freezeHeartbeat = (ms: number) => heartbeat().worker.postMessage({ freezeMs: ms })

export interface Clock { wall: () => number; mono: () => number }
const realClock: Clock = { wall: () => Date.now(), mono: () => performance.now() }

export interface StallMark { stalledMs: () => Promise<number> }

/** Start measuring; stalledMs() = environment stall accumulated since the mark. */
export const markStall = (clock: Clock = realClock): StallMark => {
    const h = heartbeat()
    const acc0 = Atomics.load(h.acc, 0)
    const w0 = clock.wall(), m0 = clock.mono()
    return {
        stalledMs: async () => {
            const drift = Math.abs((clock.wall() - w0) - (clock.mono() - m0))
            // let the heartbeat tick at least twice after a resume so it records the gap
            const ticks = Atomics.load(h.acc, 1)
            for (let i = 0; i < 20 && Atomics.load(h.acc, 1) < ticks + 2; i++) await new Promise(r => setTimeout(r, HEARTBEAT_MS))
            return Math.max(drift, Atomics.load(h.acc, 0) - acc0)
        },
    }
}

export const stallMessage = (stalledMs: number, original: string) =>
    `${STALL_MARKER} (${Math.round(stalledMs / 1000)}s): inconclusive — the process/box froze during this test; original error: ${original}`

/**
 * Run body under a deadline of timeoutMs. On failure, if the environment stalled ≥ STALL_THRESHOLD_MS,
 * rethrow as ENVIRONMENT STALL; otherwise rethrow unchanged (a deadline gives `Test timed out in Nms`).
 */
export const runStallGuarded = async (body: () => Promise<unknown> | unknown, timeoutMs: number, clock?: Clock): Promise<void> => {
    const mark = markStall(clock)
    let timer: NodeJS.Timeout | undefined
    try {
        await Promise.race([
            Promise.resolve().then(body),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Test timed out in ${timeoutMs}ms`)), timeoutMs) }),
        ])
    } catch (e) {
        const stalled = await mark.stalledMs()
        const msg = e instanceof Error ? e.message : String(e)
        if (stalled >= STALL_THRESHOLD_MS) throw new Error(stallMessage(stalled, msg), { cause: e })
        throw e
    } finally {
        clearTimeout(timer)
    }
}

/** `it` for time-sensitive tests: same body and budget, plus environment-stall classification. */
export const stallIt = (name: string, body: () => Promise<unknown> | unknown, timeoutMs: number) =>
    it(name, () => runStallGuarded(body, timeoutMs), timeoutMs + GUARD_GRACE_MS)
