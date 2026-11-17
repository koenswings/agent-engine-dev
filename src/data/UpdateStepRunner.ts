/**
 * UpdateStepRunner.ts — runs one x-app.update step of an updateApp (engine#456 §1, §3, §10).
 *
 *  - prepare: a one-off container on the swapped compose,
 *    `docker compose run --rm --no-deps --no-TTY --pull never [--user U] <service>`, with a
 *    generated override that sets `entrypoint: [command]` and `command: []`, so argv is exactly
 *    [command]. No --service-ports (no ports published); it uses the instance's existing ./data.
 *    The App's own containers stay down and the image entrypoint never runs.
 *  - verify / work / settle: `docker compose exec -T [-u U] <service> sh -c '<pid wrapper>' <command>`
 *    in the running service. The wrapper records the in-container pid so a timeout can signal it.
 *  - Env: the Engine adds only IDEA_UPDATE_FROM / IDEA_UPDATE_TO (x-app.version values, Q7), with
 *    -e on run and exec. Env values are never logged (the logged line names the command only).
 *  - Timeout (per step, 1 s – 6 h, no shared timer): SIGTERM to the step, SIGKILL 10 s later; the
 *    prepare container is removed, the exec'd process is killed. Logged as "timed out after N s".
 *  - Output: stdout and stderr are captured. The last line that STARTS with `ERROR:` or `not yet:`
 *    (at most 200 characters) is the step's note; the last 20 lines go to the Engine log.
 *
 * Everything runs from the disk: `--pull never`, no network is used.
 */
import { spawn } from 'node:child_process'
import { fs, os, path, YAML } from 'zx'
import { log } from '../utils/utils.js'
import type { UpdateStageKey, UpdateStepSpec } from './UpdateAppPolicy.js'

/** SIGTERM first; SIGKILL this long after (engine#456 §3). */
export const STEP_KILL_GRACE_MS = 10_000
/** A step note (ERROR: / not yet: line) is cut to this many characters. */
export const STEP_NOTE_MAX = 200
/** Lines of step output that go to the Engine log. */
export const STEP_LOG_LINES = 20
/** Output lines kept in memory per run (the note is tracked separately, over all lines). */
const KEEP_LINES = 200
const MAX_LINE = 2000

export interface StepContext {
    /** the instance folder (the swapped compose.yaml is in it) */
    instanceDir: string
    /** the compose project of the instance */
    project: string
    /** extra compose files after compose.yaml (the Files / USB override of Start), absolute */
    extraComposeFiles: string[]
    /** x-app.version before and after the update (IDEA_UPDATE_FROM / IDEA_UPDATE_TO) */
    fromVersion: string
    toVersion: string
}

export interface StepRun {
    /** process exit code; null when it was killed by a signal or never started */
    exitCode: number | null
    timedOut: boolean
    /** the last line starting with ERROR: or not yet: (≤ 200 characters), or null */
    note: string | null
    /** the last output lines (≤ 200) */
    lines: string[]
    durationMs: number
    /** docker could not be started at all */
    spawnError?: string
}

export interface StepRunnerDeps {
    /** the docker CLI (tests point this at a fake) */
    dockerBin: string
    sleep: (ms: number) => Promise<void>
    killGraceMs: number
    /** where the generated prepare override is written */
    tmpDir: () => string
}

export const defaultStepRunnerDeps = (): StepRunnerDeps => ({
    dockerBin: 'docker',
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    killGraceMs: STEP_KILL_GRACE_MS,
    tmpDir: () => os.tmpdir(),
})

/** The last line that starts with `ERROR:` or `not yet:`, cut to 200 characters; null when none. */
export const stepNote = (lines: string[]): string | null => {
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].replace(/\r$/, '')
        if (l.startsWith('ERROR:') || l.startsWith('not yet:')) return l.slice(0, STEP_NOTE_MAX)
    }
    return null
}

/** The pid file the exec wrapper writes inside the container. */
export const stepPidFile = (kind: UpdateStageKey): string => `/tmp/.idea-update-${kind}.pid`

/** The prepare container's name (one per instance; a leftover of a killed run is removed first). */
export const prepareContainerName = (project: string): string => `${project}-idea-update-prepare`

const composeBase = (ctx: StepContext): string[] =>
    ['compose', '-p', ctx.project, '-f', path.join(ctx.instanceDir, 'compose.yaml'), ...ctx.extraComposeFiles.flatMap(f => ['-f', f])]

const envArgs = (ctx: StepContext): string[] =>
    ['-e', `IDEA_UPDATE_FROM=${ctx.fromVersion}`, '-e', `IDEA_UPDATE_TO=${ctx.toVersion}`]

/** argv of `docker compose run` for prepare (override file given). */
export const prepareArgs = (spec: UpdateStepSpec, ctx: StepContext, overridePath: string): string[] => [
    ...composeBase(ctx), '-f', overridePath,
    'run', '--rm', '--no-deps', '--no-TTY', '--pull', 'never', '--name', prepareContainerName(ctx.project),
    ...(spec.user !== undefined ? ['--user', spec.user] : []),
    ...envArgs(ctx), spec.service,
]

/** The override that makes argv exactly [command] for prepare. */
export const prepareOverride = (spec: UpdateStepSpec): string =>
    YAML.stringify({ services: { [spec.service]: { entrypoint: [spec.command], command: [] } } })

/** sh -c wrapper: record the in-container pid, then exec the command (same pid). */
export const EXEC_WRAPPER = 'echo $$ > "$1" 2>/dev/null; shift; exec "$@"'

/** argv of `docker compose exec` for verify / work / settle. */
export const execArgs = (kind: UpdateStageKey, spec: UpdateStepSpec, ctx: StepContext): string[] => [
    ...composeBase(ctx), 'exec', '-T',
    ...(spec.user !== undefined ? ['-u', spec.user] : []),
    ...envArgs(ctx), spec.service,
    'sh', '-c', EXEC_WRAPPER, 'idea-update-step', stepPidFile(kind), spec.command,
]

/** argv that signals the exec'd step inside the container (same user, so it may signal its own process). */
export const execSignalArgs = (kind: UpdateStageKey, spec: UpdateStepSpec, ctx: StepContext, signal: 'TERM' | 'KILL'): string[] => [
    ...composeBase(ctx), 'exec', '-T',
    ...(spec.user !== undefined ? ['-u', spec.user] : []),
    spec.service, 'sh', '-c', `p=$(cat ${stepPidFile(kind)} 2>/dev/null) && [ -n "$p" ] && kill -${signal} "$p"`,
]

interface Spawned { code: Promise<number | null>, kill: (sig: NodeJS.Signals) => void, error: () => string | undefined }

const spawnDocker = (d: StepRunnerDeps, args: string[], cwd: string, onLine?: (line: string) => void): Spawned => {
    let spawnErr: string | undefined
    const env = { ...process.env }
    // -f names every file; a COMPOSE_FILE in the Engine's env must not add or replace one
    delete env.COMPOSE_FILE
    const child = spawn(d.dockerBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const feed = (stream: NodeJS.ReadableStream | null) => {
        if (!stream || !onLine) return
        let buf = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
            buf += chunk
            let i: number
            while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
            if (buf.length > MAX_LINE * 4) { onLine(buf.slice(0, MAX_LINE)); buf = '' }
        })
        stream.on('end', () => { if (buf) onLine(buf); buf = '' })
    }
    feed(child.stdout); feed(child.stderr)
    const code = new Promise<number | null>(resolve => {
        child.on('error', e => { spawnErr = e.message; resolve(null) })
        child.on('close', (c) => resolve(c))
    })
    return { code, kill: (sig) => { try { child.kill(sig) } catch { /* already gone */ } }, error: () => spawnErr }
}

/** Run a short docker command to completion; resolves with its exit code (never throws). */
const dockerQuick = async (d: StepRunnerDeps, args: string[], cwd: string): Promise<number | null> =>
    spawnDocker(d, args, cwd).code

const settledWithin = async (p: Promise<unknown>, ms: number, d: StepRunnerDeps): Promise<boolean> => {
    let done = false
    void p.then(() => { done = true })
    const step = 100
    for (let waited = 0; waited < ms && !done; waited += step) await d.sleep(Math.min(step, ms - waited))
    return done
}

/**
 * Run one declared step with its own timer. Never throws for a step failure: the caller maps
 * exit codes, timeouts and notes to PREPARE_FAILED / VERIFY_FAILED / MIGRATIONS_PENDING /
 * SETTLE_FAILED. `timeoutS` defaults to the declared timeout (settle passes what is left).
 */
export const runUpdateStep = async (
    kind: UpdateStageKey, spec: UpdateStepSpec, ctx: StepContext,
    opts: { timeoutS?: number } = {}, deps: Partial<StepRunnerDeps> = {},
): Promise<StepRun> => {
    const d: StepRunnerDeps = { ...defaultStepRunnerDeps(), ...deps }
    const timeoutS = opts.timeoutS ?? spec.timeout
    const lines: string[] = []
    let note: string | null = null
    const onLine = (raw: string) => {
        const l = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw
        lines.push(l)
        if (lines.length > KEEP_LINES) lines.shift()
        const n = stepNote([l])
        if (n) note = n
    }
    let overridePath: string | null = null
    const t0 = Date.now()
    log(`updateApp: ${ctx.project}: ${kind}: running ${spec.command} in ${spec.service}${spec.user !== undefined ? ` as ${spec.user}` : ''} (timeout ${timeoutS} s)`)
    try {
        let args: string[]
        if (kind === 'prepare') {
            // a leftover one-off container of a killed earlier run would block --name
            const name = prepareContainerName(ctx.project)
            if (await dockerQuick(d, ['container', 'inspect', '--format', '{{.Name}}', name], ctx.instanceDir) === 0) {
                log(`updateApp: ${ctx.project}: removing the leftover prepare container ${name}`)
                await dockerQuick(d, ['rm', '-f', name], ctx.instanceDir)
            }
            overridePath = path.join(d.tmpDir(), `idea-update-${ctx.project}-prepare-${process.pid}-${t0}.yaml`)
            await fs.writeFile(overridePath, prepareOverride(spec))
            args = prepareArgs(spec, ctx, overridePath)
        } else {
            args = execArgs(kind, spec, ctx)
        }
        const run = spawnDocker(d, args, ctx.instanceDir, onLine)
        let timedOut = false
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutS * 1000) })
        const first = await Promise.race([run.code.then(() => 'exit' as const), timeout])
        if (timer) clearTimeout(timer)
        if (first === 'timeout') {
            timedOut = true
            log(`updateApp: ${ctx.project}: ${kind} timed out after ${timeoutS} s; sending SIGTERM`)
            if (kind === 'prepare') await dockerQuick(d, ['kill', '--signal', 'TERM', prepareContainerName(ctx.project)], ctx.instanceDir)
            else await dockerQuick(d, execSignalArgs(kind, spec, ctx, 'TERM'), ctx.instanceDir)
            if (!await settledWithin(run.code, d.killGraceMs, d)) {
                log(`updateApp: ${ctx.project}: ${kind} still running ${Math.round(d.killGraceMs / 1000)} s after SIGTERM; sending SIGKILL`)
                if (kind === 'prepare') await dockerQuick(d, ['kill', '--signal', 'KILL', prepareContainerName(ctx.project)], ctx.instanceDir)
                else await dockerQuick(d, execSignalArgs(kind, spec, ctx, 'KILL'), ctx.instanceDir)
                if (!await settledWithin(run.code, d.killGraceMs, d)) run.kill('SIGKILL')
            }
            if (kind === 'prepare') await dockerQuick(d, ['rm', '-f', prepareContainerName(ctx.project)], ctx.instanceDir)
        }
        const exitCode = await run.code
        const r: StepRun = { exitCode: timedOut ? null : exitCode, timedOut, note, lines: [...lines], durationMs: Date.now() - t0 }
        const se = run.error()
        if (se) r.spawnError = se
        logStepTail(ctx.project, kind, r, timeoutS)
        return r
    } finally {
        if (overridePath) await fs.unlink(overridePath).catch(() => undefined)
    }
}

const logStepTail = (project: string, kind: UpdateStageKey, r: StepRun, timeoutS: number): void => {
    const tail = r.lines.slice(-STEP_LOG_LINES)
    log(`updateApp: ${project}: ${kind} ${describeStepRun({ ...r, timeoutS })} (ran ${Math.round(r.durationMs / 1000)} s; last ${tail.length} output line(s):`)
    for (const l of tail) log(`updateApp: ${project}: ${kind} | ${l}`)
}

/** Plain-words outcome of one run: "timed out after N s", "exited N", or the 126/127 wording. */
export const describeStepRun = (r: Pick<StepRun, 'exitCode' | 'timedOut' | 'spawnError' | 'durationMs'> & { timeoutS?: number }): string => {
    if (r.spawnError) return `could not run docker: ${r.spawnError}`
    if (r.timedOut) return `timed out${r.timeoutS !== undefined ? ` after ${r.timeoutS} s` : ''}`
    if (r.exitCode === 126 || r.exitCode === 127) return `command not found or not executable in container (exit ${r.exitCode})`
    if (r.exitCode === null) return 'was killed by a signal'
    return `exited ${r.exitCode}`
}

/** The failure text of a step: what happened, then its last ERROR: / not yet: line when there is one. */
export const stepFailureText = (kind: UpdateStageKey, spec: UpdateStepSpec, r: StepRun, timeoutS: number = spec.timeout): string => {
    const how = describeStepRun({ ...r, timeoutS })
    return `${kind} ${spec.command} ${how}${r.note ? `: ${r.note}` : ''}`
}
