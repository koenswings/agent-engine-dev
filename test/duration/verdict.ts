/**
 * r86j (cover-all-stage2-a350976-r86j): the walker hung in step 116 with its Node event loop
 * blocked (a synchronous Automerge sync apply of store 3zoqd), so no in-process timer could fire
 * (120 s doc wait, 150 s per-Pi post-op timeout), and the process later died with no verdict.
 *
 * Two guarantees here:
 *  1. writeVerdict(): every exit path writes RESULT.txt (PASS/FAIL + reason + step) and a
 *     {"event":"duration_verdict"} line straight into run.log with sync fs calls (works from
 *     signal handlers and from the watchdog thread, which cannot use the blocked main thread's stdout).
 *  2. startLoopWatchdog(): a worker thread (its own event loop) watches a heartbeat the main
 *     thread bumps every second. If the main loop is blocked longer than stallMs, the worker
 *     writes FAIL "event loop blocked …" with the current step and the walker's memory, then
 *     SIGKILLs the process. Lags above lagLogMs are recorded in LOOPLAG.jsonl as evidence.
 */
import { appendFileSync, closeSync, fsyncSync, mkdtempSync, openSync, renameSync, writeFileSync, writeSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

export type VerdictStatus = 'PASS' | 'FAIL'
export interface Verdict { status: VerdictStatus; reason: string; step: number | null; source: string }

/** Shared state: [0]=heartbeat ms (low 32 bits not enough → Float64), [1]=current step, [2]=verdict written flag. */
const sab = new SharedArrayBuffer(8 * 3)
const f64 = new Float64Array(sab)
let evidenceDir: string | null = null
let written = false

export const setVerdictDir = (dir: string | null | undefined): void => { evidenceDir = dir?.trim() || null }
export const setCurrentStep = (step: number | null | undefined): void => {
    if (typeof step === 'number' && Number.isFinite(step)) f64[1] = step
}
export const currentStep = (): number | null => (f64[1] > 0 ? f64[1] : null)
export const verdictWritten = (): boolean => written || f64[2] === 1

export const formatVerdictLine = (v: Verdict, ts = new Date()): string =>
    JSON.stringify({ event: 'duration_verdict', ts: ts.toISOString(), ...v }) + '\n'

const writeFileDurable = (path: string, body: string): void => {
    const tmp = `${path}.tmp`
    const fd = openSync(tmp, 'w')
    try { writeSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
}

/**
 * Write the run's verdict once (first writer wins; a later PASS never overwrites a FAIL).
 * Sync only. Returns false when a verdict already exists or no evidence dir is set.
 */
export const writeVerdict = (v: Omit<Verdict, 'step'> & { step?: number | null }, dir = evidenceDir): boolean => {
    if (verdictWritten()) return false
    written = true
    f64[2] = 1
    const full: Verdict = { status: v.status, reason: v.reason, source: v.source, step: v.step ?? currentStep() }
    const line = formatVerdictLine(full)
    if (!dir) { try { process.stderr.write(line) } catch { /* ignore */ } return false }
    try {
        writeFileDurable(join(dir, 'RESULT.txt'), `${full.status} step=${full.step ?? '?'} source=${full.source}\n${full.reason}\n`)
    } catch { /* still try the log */ }
    try { appendFileSync(join(dir, 'run.log'), line) } catch { /* ignore */ }
    return true
}

export const resultExists = (dir: string): boolean => existsSync(join(dir, 'RESULT.txt'))

/** For tests only. */
export const _resetVerdictState = (): void => { written = false; f64[0] = 0; f64[1] = 0; f64[2] = 0; evidenceDir = null }

export interface WatchdogOpts {
    dir: string | null
    /** Main-loop block that is fatal (default DURATION_LOOP_STALL_MS or 150 s). */
    stallMs?: number
    /** Lags at or above this are recorded in LOOPLAG.jsonl (default 5 s). */
    lagLogMs?: number
    /** Heartbeat period (default 1 s). */
    beatMs?: number
    /** Test hook: do not SIGKILL, post 'stalled' to the parent instead. */
    noKill?: boolean
    /** r86l soft RSS guard: FAIL loud when the walker's VmRSS reaches this (default DURATION_RSS_LIMIT_MB or 3000 MB; idea02 has 3.8 GB). 0 = off. */
    rssLimitMb?: number
    /** r86l soft RSS guard: FAIL loud when the host's MemAvailable drops below this (default DURATION_MEM_AVAIL_MIN_MB or 300 MB). 0 = off. */
    memAvailMinMb?: number
    /** r86l: write a process RSS sample to LOOPLAG.jsonl this often, lag or not (default DURATION_RSS_SAMPLE_MS or 30 s). */
    rssSampleMs?: number
}

/** r86l: thresholds from env (idea02 ~3.8 GB RAM; r86l reached 2.0 GB RSS with 674 MB available). */
export const rssGuardDefaults = (env: NodeJS.ProcessEnv = process.env): { rssLimitMb: number; memAvailMinMb: number; rssSampleMs: number } => {
    const n = (v: string | undefined, d: number) => { const x = Number(v); return v !== undefined && v !== '' && Number.isFinite(x) && x >= 0 ? x : d }
    return {
        rssLimitMb: n(env.DURATION_RSS_LIMIT_MB, 3000),
        memAvailMinMb: n(env.DURATION_MEM_AVAIL_MIN_MB, 300),
        rssSampleMs: n(env.DURATION_RSS_SAMPLE_MS, 30_000),
    }
}

const WORKER_SRC = `
const { workerData, parentPort } = require('node:worker_threads')
const fs = require('node:fs'); const path = require('node:path')
const f64 = new Float64Array(workerData.sab)
const { dir, stallMs, lagLogMs, noKill, rssLimitKb, memAvailMinKb, rssSampleMs } = workerData
let worst = 0, lastLogged = 0, lastSample = 0
const mem = () => { try { const s = fs.readFileSync('/proc/' + process.pid + '/status', 'utf8'); const g = k => (s.match(new RegExp(k + ':\\\\s+(\\\\d+)')) || [])[1]; return { rssKb: +g('VmRSS') || null, hwmKb: +g('VmHWM') || null, swapKb: +g('VmSwap') || null } } catch { return {} } }
const sysMem = () => { try { const s = fs.readFileSync('/proc/meminfo', 'utf8'); const g = k => +((s.match(new RegExp(k + ':\\\\s+(\\\\d+)')) || [])[1]); return { memAvailKb: g('MemAvailable'), swapFreeKb: g('SwapFree') } } catch { return {} } }
const fail = (source, reason, step) => {
  f64[2] = 1
  const line = JSON.stringify({ event: 'duration_verdict', ts: new Date().toISOString(), status: 'FAIL', reason, step, source }) + '\\n'
  if (dir) {
    try { const t = path.join(dir, 'RESULT.txt.tmp'); const fd = fs.openSync(t, 'w'); fs.writeSync(fd, 'FAIL step=' + (step ?? '?') + ' source=' + source + '\\n' + reason + '\\n'); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(t, path.join(dir, 'RESULT.txt')) } catch {}
    try { fs.appendFileSync(path.join(dir, 'run.log'), line) } catch {}
  }
  if (noKill) parentPort.postMessage({ stalled: true, source, reason })
  else process.kill(process.pid, 'SIGKILL')
}
const tick = () => {
  const hb = f64[0]; if (!hb) return
  const lag = Date.now() - hb
  const m = mem(), sm = sysMem()
  // r86l: periodic RSS sample + soft RSS guard (here, so both work while the main loop is blocked).
  if (rssSampleMs > 0 && Date.now() - lastSample >= rssSampleMs) {
    lastSample = Date.now()
    if (dir) try { fs.appendFileSync(path.join(dir, 'LOOPLAG.jsonl'), JSON.stringify({ ts: new Date().toISOString(), kind: 'rss', lagMs: lag, step: f64[1] || null, ...m, ...sm }) + '\\n') } catch {}
  }
  if (f64[2] !== 1 && ((rssLimitKb > 0 && m.rssKb >= rssLimitKb) || (memAvailMinKb > 0 && sm.memAvailKb > 0 && sm.memAvailKb < memAvailMinKb))) {
    const step = f64[1] || null
    const what = rssLimitKb > 0 && m.rssKb >= rssLimitKb
      ? 'walker RSS ' + Math.round(m.rssKb / 1024) + ' MB reached the soft limit ' + Math.round(rssLimitKb / 1024) + ' MB'
      : 'host MemAvailable ' + Math.round(sm.memAvailKb / 1024) + ' MB below the floor ' + Math.round(memAvailMinKb / 1024) + ' MB'
    fail('rss-guard', what + ' at step ' + (step ?? '?') + ': failing loud before the OOM killer ' + JSON.stringify({ lagMs: lag, ...m, ...sm }), step)
    return
  }
  if (lag >= lagLogMs && lag - lastLogged >= lagLogMs) {
    lastLogged = lag; worst = Math.max(worst, lag)
    if (dir) try { fs.appendFileSync(path.join(dir, 'LOOPLAG.jsonl'), JSON.stringify({ ts: new Date().toISOString(), lagMs: lag, step: f64[1] || null, ...m, ...sm }) + '\\n') } catch {}
  } else if (lag < lagLogMs) lastLogged = 0
  if (lag >= stallMs && f64[2] !== 1) {
    const step = f64[1] || null
    fail('loop-watchdog', 'walker event loop blocked ' + Math.round(lag / 1000) + 's (limit ' + Math.round(stallMs / 1000) + 's) at step ' + (step ?? '?') + ': no in-process timer can fire; killed by loop watchdog ' + JSON.stringify({ ...m, ...sm }), step)
  }
}
setInterval(tick, Math.min(1000, Math.max(50, Math.floor(lagLogMs / 2))))
`

/** Start the out-of-thread loop watchdog. Returns a stop function. */
export const startLoopWatchdog = (o: WatchdogOpts): { stop: () => Promise<void>; worker: Worker } => {
    const stallMs = o.stallMs ?? Number(process.env.DURATION_LOOP_STALL_MS ?? 150_000)
    const lagLogMs = o.lagLogMs ?? 5_000
    const beatMs = o.beatMs ?? 1_000
    const g = rssGuardDefaults()
    const rssLimitKb = Math.round((o.rssLimitMb ?? g.rssLimitMb) * 1024)
    const memAvailMinKb = Math.round((o.memAvailMinMb ?? g.memAvailMinMb) * 1024)
    const rssSampleMs = o.rssSampleMs ?? g.rssSampleMs
    f64[0] = Date.now()
    const beat = setInterval(() => { f64[0] = Date.now() }, beatMs)
    beat.unref()
    // A .cjs file, not eval: eval workers inherit the parent's module mode (ESM / tsx) and lose require.
    const file = join(mkdtempSync(join(tmpdir(), 'duration-loop-watchdog-')), 'watchdog.cjs')
    writeFileSync(file, WORKER_SRC)
    const worker = new Worker(file, { workerData: { sab, dir: o.dir, stallMs, lagLogMs, noKill: !!o.noKill, rssLimitKb, memAvailMinKb, rssSampleMs }, execArgv: [] })
    worker.on('error', e => { try { process.stderr.write(`[duration] loop watchdog error: ${e instanceof Error ? e.message : String(e)}\n`) } catch { /* ignore */ } })
    worker.unref()
    return {
        worker,
        stop: async () => { clearInterval(beat); f64[0] = 0; await worker.terminate() },
    }
}

/** Busy-wait the main thread (tests: simulates a blocking Automerge apply). */
export const blockMainThread = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }

let guardsInstalled = false
/**
 * Signals / exit: write FAIL with a reason if no verdict exists yet. SIGTERM/SIGHUP/SIGINT
 * (host shutdown, pkill, terminal) then exit 2. 'exit' without a verdict → FAIL "exited code X".
 */
export const installVerdictGuards = (): void => {
    if (guardsInstalled) return
    guardsInstalled = true
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
        process.on(sig, () => {
            writeVerdict({ status: 'FAIL', reason: `walker received ${sig} (host shutdown/reboot, kill or lost terminal) before a verdict`, source: 'signal' })
            process.exit(2)
        })
    }
    process.on('exit', code => {
        writeVerdict({ status: 'FAIL', reason: `walker exited with code ${code} without a verdict`, source: 'exit' })
    })
}

/**
 * r86l: per-thread memory into LOOPLAG.jsonl from the main thread (now free: no Automerge apply here).
 * RSS is per process; each Automerge worker reports its own isolate heap / external / arrayBuffers.
 */
export interface ThreadMem { thread: string; heapUsedMb: number; externalMb: number; arrayBuffersMb: number; ageMs?: number }
export const startMemSampler = (dir: string | null, threads: () => ThreadMem[], everyMs = rssGuardDefaults().rssSampleMs): (() => void) => {
    if (!dir || everyMs <= 0) return () => {}
    const mb = (b: number) => Math.round(b / 1048576)
    const t = setInterval(() => {
        const m = process.memoryUsage()
        const row = {
            ts: new Date().toISOString(), kind: 'threads', step: currentStep(),
            main: { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) },
            workers: (() => { try { return threads() } catch { return [] } })(),
        }
        try { appendFileSync(join(dir, 'LOOPLAG.jsonl'), JSON.stringify(row) + '\n') } catch { /* ignore */ }
    }, everyMs)
    t.unref()
    return () => clearInterval(t)
}
