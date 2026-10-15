/**
 * r62 FAIL@32: one `ssh` to idea03 got "Connection reset by 100.126.117.80 port 22" (exit 255) in the
 * read-only post-step verifySidecarOwner probe. Transient TRANSPORT failures of READ-ONLY probes are
 * retried with a short backoff; everything else is not:
 *   - only ssh exit 255 whose stderr looks like a transport failure (reset/refused/closed/timed out/
 *     kex_exchange/Broken pipe/Could not resolve/No route/Network unreachable) is retried;
 *   - a remote command that ran and returned its own non-zero code is never retried;
 *   - retry is opt-in per call (RealFleetOps.sshRead); mutating calls use plain ssh (no retry), because
 *     a reset after the remote side ran would run them twice.
 * Every retry is logged (host, attempt, stderr line); exhaustion fails with every attempt listed.
 */
export const SSH_TRANSPORT_STDERR =
    /connection (reset|refused|closed|timed out)|kex_exchange_identification|broken pipe|could not resolve hostname|no route to host|network is unreachable|operation timed out|connection to \S+ closed by remote host|ssh_exchange_identification|timeout, server .* not responding/i

export interface SshFailureLike { exitCode?: number | null; stderr?: string; message?: string }

/** First meaningful stderr line (drops the known-hosts warning). */
export const sshStderrLine = (e: unknown): string => {
    const f = e as SshFailureLike
    const text = String(f?.stderr ?? f?.message ?? e ?? '')
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^Warning: Permanently added/.test(l))
    return lines.find(l => SSH_TRANSPORT_STDERR.test(l)) ?? lines[0] ?? ''
}

export const isSshTransportFailure = (e: unknown): boolean => {
    const f = e as SshFailureLike
    if (f?.exitCode !== 255) return false
    return SSH_TRANSPORT_STDERR.test(String(f.stderr ?? f.message ?? ''))
}

export interface SshRetryPolicy {
    /** Total budget from the first attempt; no new attempt starts after it (r62: ~6 min Tailscale relay outage). */
    deadlineMs: number
    /** Waits before retry 1, 2, …; the last value repeats, capped at capMs. */
    backoffMs: number[]
    capMs: number
}

/**
 * DURATION_SSH_RETRY_DEADLINE_MS (default 480000 = 8 min), DURATION_SSH_RETRY_BACKOFF_MS
 * (default "2000,4000,8000,16000,30000"), DURATION_SSH_RETRY_CAP_MS (default 30000).
 */
export const sshRetryPolicy = (env: NodeJS.ProcessEnv = process.env): SshRetryPolicy => {
    const num = (v: string | undefined, d: number) => { const n = Number(v); return v != null && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d }
    const raw = (env.DURATION_SSH_RETRY_BACKOFF_MS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n >= 0)
    return {
        deadlineMs: num(env.DURATION_SSH_RETRY_DEADLINE_MS, 480_000),
        backoffMs: raw.length ? raw : [2000, 4000, 8000, 16000, 30000],
        capMs: num(env.DURATION_SSH_RETRY_CAP_MS, 30_000),
    }
}
export const backoffFor = (p: SshRetryPolicy, retryIndex: number): number =>
    Math.min(p.backoffMs[Math.min(retryIndex, p.backoffMs.length - 1)] ?? 0, p.capMs)

export interface SshRetryIo {
    sleep: (ms: number) => Promise<void>
    log: (line: string) => void
    now?: () => number
    /** Wall clock, only to report a box pause (wall advanced much more than monotonic). */
    wall?: () => number
}

export const withSshRetry = async <T>(
    host: string, what: string, run: () => Promise<T>, policy: SshRetryPolicy, io: SshRetryIo,
): Promise<T> => {
    // r68 (r67 FAIL@23): the budget is MONOTONIC time — a frozen box (VM pause) must not use up the deadline.
    const now = io.now ?? (() => performance.now())
    const wall = io.wall ?? (() => Date.now())
    const t0 = now()
    const w0 = wall()
    const tries: string[] = []
    for (let attempt = 1; ; attempt++) {
        try {
            const out = await run()
            if (attempt > 1) io.log(JSON.stringify({ event: 'ssh_retry_ok', host, what, attempt, elapsed_ms: now() - t0 }))
            return out
        } catch (e) {
            if (!isSshTransportFailure(e)) throw e // remote ran and failed, or not a transport error: never retried
            const line = sshStderrLine(e)
            const elapsed = Math.round(now() - t0)
            const pausedMs = Math.max(0, Math.round(wall() - w0 - elapsed))
            if (pausedMs > 20_000) io.log(JSON.stringify({ event: 'box_pause_detected', host, what, attempt, wall_elapsed_ms: elapsed + pausedMs, mono_elapsed_ms: elapsed, paused_ms: pausedMs }))
            tries.push(`#${attempt} @${elapsed}ms${pausedMs > 20_000 ? ` (+${pausedMs}ms box pause)` : ''}: exit 255 ${line}`)
            const wait = backoffFor(policy, attempt - 1)
            // At least one retry after any transport failure; then the monotonic deadline decides.
            if (attempt >= 2 && elapsed + wait > policy.deadlineMs) {
                io.log(JSON.stringify({ event: 'ssh_retry_exhausted', host, what, attempts: attempt, elapsed_ms: elapsed, deadline_ms: policy.deadlineMs, stderr: line }))
                throw new Error(
                    `ssh ${host} (${what}): transport failure on all ${attempt} attempt(s) within ${policy.deadlineMs}ms ` +
                    `(DURATION_SSH_RETRY_DEADLINE_MS) — ${tries.join('; ')}`,
                    { cause: e },
                )
            }
            io.log(JSON.stringify({ event: 'ssh_retry', host, what, attempt, elapsed_ms: elapsed, next_in_ms: wait, stderr: line }))
            await io.sleep(wait)
        }
    }
}
