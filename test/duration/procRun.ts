/**
 * r67 FAIL@23: one read attempt (sidecar-owner docker ps on idea03) lasted 795 s of wall time although the
 * attempt kill was 120 s and ssh's own ServerAlive limit 30 s. Neither monotonic timer fired: the box VM was
 * frozen (dmesg "crng reseeded due to virtual machine fork" at 03:04:08 inside the window), and the retry
 * deadline was measured in WALL time, so after the resume the single attempt already "used" 795 s > 480 s and
 * no retry was made.
 *
 * Every walker-side ssh process now runs here: own process group (detached), SIGKILL to the whole group at the
 * limit, and the promise resolves at once on the kill (never waits for a stdio 'close' that may not come).
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface ProcResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; killedGroup: boolean; pid: number | undefined }
export interface ProcOpts {
    timeoutMs: number
    onStdout?: (all: string, child: ChildProcess) => void
    /** Kill early unless `unless()` is true by then (mutate start gate). */
    earlyKill?: { ms: number; unless: () => boolean }
    env?: NodeJS.ProcessEnv
}

const killGroup = (child: ChildProcess): boolean => {
    if (child.pid == null) return false
    try { process.kill(-child.pid, 'SIGKILL'); return true } catch { /* group gone */ }
    try { child.kill('SIGKILL') } catch { /* gone */ }
    return false
}

export const runProcess = (cmd: string, args: string[], o: ProcOpts): Promise<ProcResult> => new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: o.env ?? process.env })
    let stdout = '', stderr = '', done = false
    const finish = (r: Omit<ProcResult, 'stdout' | 'stderr' | 'pid'>) => {
        if (done) return
        done = true
        clearTimeout(t)
        if (ek) clearTimeout(ek)
        resolve({ ...r, stdout, stderr, pid: child.pid })
    }
    const kill = (why: string) => {
        const g = killGroup(child)
        stderr += `${stderr && !stderr.endsWith('\n') ? '\n' : ''}${why}`
        // Resolve now: a killed group's pipes may stay open (grandchildren, frozen links) — never wait for 'close'.
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy()
        finish({ code: null, timedOut: true, killedGroup: g })
    }
    const t = setTimeout(() => kill(`walker killed the process group after ${o.timeoutMs}ms`), o.timeoutMs)
    const ek = o.earlyKill ? setTimeout(() => { if (!o.earlyKill!.unless()) kill(`walker killed the process group: no start gate within ${o.earlyKill!.ms}ms`) }, o.earlyKill.ms) : undefined
    child.stdout!.on('data', d => { stdout += String(d); o.onStdout?.(stdout, child) })
    child.stderr!.on('data', d => { stderr += String(d) })
    child.stdin!.on('error', () => {})
    child.on('error', e => { stderr += String(e); finish({ code: 255, timedOut: false, killedGroup: false }) })
    child.on('exit', code => {
        // 'exit' (not 'close'): a grandchild holding the pipes must not keep us waiting. Flush briefly.
        setTimeout(() => finish({ code, timedOut: false, killedGroup: false }), 50)
    })
})

/** Monotonic ms (not affected by wall-clock jumps after a VM pause). */
export const monoNow = (): number => performance.now()

/**
 * r68: log every box freeze (wall clock advanced ≥ thresholdMs more than monotonic between ticks) as
 * `box_pause` in run.log, so a VM pause is visible evidence, not a mystery timeout. Returns a stop function.
 */
export const startPauseMonitor = (log: (line: string) => void = l => console.log(l), tickMs = 5_000, thresholdMs = 20_000,
    clocks: { mono: () => number; wall: () => number } = { mono: monoNow, wall: () => Date.now() }): (() => void) => {
    let m = clocks.mono(), w = clocks.wall()
    const check = () => {
        const m2 = clocks.mono(), w2 = clocks.wall()
        const gap = (w2 - w) - (m2 - m)
        if (gap >= thresholdMs) log(JSON.stringify({ event: 'box_pause', at: new Date(w2).toISOString(), paused_ms: Math.round(gap), since: new Date(w).toISOString() }))
        m = m2; w = w2
    }
    const t = setInterval(check, tickMs)
    t.unref()
    return Object.assign(() => clearInterval(t), { check })
}
