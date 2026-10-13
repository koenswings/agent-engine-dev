/**
 * r66 FAIL@60 (infra_undock_fixtures): a MUTATING ssh to idea03 got "Connection reset by 100.126.117.80 port 22"
 * after the Engine ejects; mutating calls had no transport handling (a blind retry could run them twice).
 *
 * r67 contract for every mutating remote verb:
 *  1. Warm the transport first: an SSH ControlMaster per host (ControlPersist), established with retries — no
 *     remote command runs while establishing it.
 *  2. Run the command ONCE behind a start gate: the remote shell prints a gate token and waits for "GO" on
 *     stdin; the walker sends GO only after it has read the token. A failure before GO was sent (connect, kex,
 *     mux, gate timeout, or the remote exiting 97 = no GO received) provably never started the command →
 *     retried within the SSH retry deadline, logged `ssh_mutate_retry`.
 *  3. A transport failure (exit 255) AFTER GO may have run it → never re-run blindly. The verb's read-only
 *     verify (sshRead: stage2-dock status / findmnt / store) decides: done → continue (`ssh_mutate_recovered`);
 *     not done / unknown → fail loud (single-shot, never re-issued — Steve's r67 CLEAR).
 *  A remote command that ran and exited non-zero is never retried (unchanged).
 */
import { isSshTransportFailure, sshStderrLine, sshRetryPolicy, backoffFor, SSH_TRANSPORT_STDERR } from './sshRetry.js'

export const GATE_TOKEN = '__IDEA_MUTATE_GATE__'
export const GATE_NO_GO_EXIT = 97

/** Remote wrapper: print the gate, wait for GO (≤ gateSec), then run cmd. cmd's stdin is /dev/null. */
export const gatedRemote = (cmd: string, gateSec = 60): string =>
    `printf '%s\\n' ${GATE_TOKEN}; IFS= read -r -t ${gateSec} g; [ "$g" = GO ] || exit ${GATE_NO_GO_EXIT}; ( ${cmd} ) </dev/null`

export const stripGate = (stdout: string): string => stdout.split('\n').filter(l => l.trim() !== GATE_TOKEN).join('\n')

export interface GatedResult { code: number | null; stdout: string; stderr: string; sentGo: boolean; timedOut?: boolean }
export type VerifyOutcome = 'done' | 'not_done' | 'unknown'
export interface MutateSpec {
    /** Short verb name for logs, e.g. "stage2-dock undock duration-kolibri-grade5a-001". */
    verb: string
    /** Informational (audit): the verb converges on a state status can see. Never used to re-issue. */
    idempotent: boolean
    /** Read-only outcome check (use sshRead / store). Absent → ambiguous = unknown → fail loud. */
    verify?: () => Promise<VerifyOutcome>
}
export interface MutateResult { stdout: string; recoveredByVerify: boolean; reissued: boolean; preStartRetries: number }
export interface MutateIo {
    ensureMaster: (host: string) => Promise<void>
    runGated: (host: string, gated: string) => Promise<GatedResult>
    sleep: (ms: number) => Promise<void>
    now: () => number
    log: (line: string) => void
    env?: NodeJS.ProcessEnv
}

export const gateSecs = (env: NodeJS.ProcessEnv = process.env): number => {
    const v = Number(env.DURATION_SSH_GATE_S)
    return env.DURATION_SSH_GATE_S?.trim() && Number.isFinite(v) && v >= 5 ? v : 60
}

const asErr = (r: GatedResult) => ({ exitCode: r.code ?? 255, stderr: r.stderr, message: r.stderr })
const line1 = (r: GatedResult) => sshStderrLine(asErr(r)) || (r.timedOut ? 'gate timeout (no gate token)' : `exit ${r.code}`)

/** Was the command provably NOT started? (failed before GO, or the remote never received GO). */
export const failedBeforeStart = (r: GatedResult): boolean => !r.sentGo || r.code === GATE_NO_GO_EXIT

/** Transport-looking failure after GO (the command may have run). */
export const ambiguousAfterStart = (r: GatedResult): boolean =>
    r.sentGo && r.code !== 0 && r.code !== GATE_NO_GO_EXIT && (r.code === 255 || r.code == null) &&
    (isSshTransportFailure(asErr(r)) || SSH_TRANSPORT_STDERR.test(r.stderr) || r.code == null)

/** One mutate with pre-start retries; returns the final GatedResult (code 0, a remote failure, or ambiguous). */
const runOnceGated = async (host: string, cmd: string, spec: MutateSpec, io: MutateIo, phase: string): Promise<{ r: GatedResult; retries: number }> => {
    const pol = sshRetryPolicy(io.env)
    const t0 = io.now()
    let retries = 0
    for (;;) {
        await io.ensureMaster(host)
        const r = await io.runGated(host, gatedRemote(cmd, gateSecs(io.env)))
        if (r.code === 0 || !failedBeforeStart(r)) return { r, retries }
        const elapsed = io.now() - t0
        if (elapsed >= pol.deadlineMs) {
            throw new Error(
                `ssh mutate ${spec.verb} on ${host}: transport never reached the command start in ${elapsed}ms ` +
                `(${retries + 1} attempts; last: ${line1(r)}). The command was NOT run.`,
            )
        }
        const wait = Math.min(backoffFor(pol, retries), Math.max(0, pol.deadlineMs - elapsed))
        retries++
        io.log(JSON.stringify({ event: 'ssh_mutate_retry', host, verb: spec.verb, phase, attempt: retries, elapsed_ms: elapsed, wait_ms: wait, before_start: true, stderr: line1(r) }))
        await io.sleep(wait)
    }
}

export const sshMutate = async (host: string, cmd: string, spec: MutateSpec, io: MutateIo): Promise<MutateResult> => {
    let { r, retries } = await runOnceGated(host, cmd, spec, io, 'first')
    if (r.code === 0) return { stdout: stripGate(r.stdout), recoveredByVerify: false, reissued: false, preStartRetries: retries }
    if (!ambiguousAfterStart(r)) {
        const e = new Error(`ssh mutate ${spec.verb} on ${host}: remote exit ${r.code}: ${r.stderr.trim().slice(0, 400)}`) as Error & { exitCode?: number | null; stderr?: string }
        e.exitCode = r.code; e.stderr = r.stderr
        throw e
    }
    // Steve's r67 CLEAR: single-shot. After an ambiguous drop, a read-only status re-check decides; never re-run.
    const outcome: VerifyOutcome = spec.verify ? await spec.verify().catch(() => 'unknown' as const) : 'unknown'
    io.log(JSON.stringify({ event: 'ssh_mutate_ambiguous', host, verb: spec.verb, stderr: line1(r), verify: outcome }))
    if (outcome === 'done') {
        io.log(JSON.stringify({ event: 'ssh_mutate_recovered', host, verb: spec.verb, how: 'recovered-by-verify' }))
        return { stdout: '', recoveredByVerify: true, reissued: false, preStartRetries: retries }
    }
    throw new Error(
        `ssh mutate ${spec.verb} on ${host}: the transport dropped after the command may have started (${line1(r)}); ` +
        `read-only status re-check says ${outcome}. Single-shot: not re-run. No soft-pass.`,
    )
}
