/**
 * Hook invocation (idea#411 contract §4): listed `docker compose exec -T`,
 * unlisted `docker exec -i … sh -s`, caps, fail-open, one at a time.
 */
import { spawn } from 'node:child_process'
import {
    DAY_FILE_CAP,
    MAX_TIMEOUT_S,
    SAMPLE_STDOUT_CAP,
    STDERR_CAP,
    USAGE_SCHEMA_DAY,
    addDays,
    engineHostname,
    formatRfc3339,
    kitLocalDay,
    usageRoot,
} from './paths.js'
import { hookPayloadFields, validateDayHook, validateSampleHook } from './schema.js'
import { applyOfficeMerge, resolveDemo } from './merge.js'
import { appendSample, correctedBootsSinceLastSync, readPresenceSince, writeDayFile } from './store.js'
import { usageLog } from './log.js'
import type {
    ClockInfo,
    DayFile,
    ExecResult,
    HookStatus,
    SampleRecord,
    SkipReason,
    UsageHookDecl,
    UsageMode,
    UsageTarget,
} from './types.js'

export function clampTimeoutS(n: unknown): number {
    const x = Number(n)
    if (!Number.isFinite(x) || x < 1) return 1
    return Math.min(Math.floor(x), MAX_TIMEOUT_S)
}

export function parseHookDecl(raw: unknown): UsageHookDecl | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.service !== 'string' || !o.service) return null
    let command: string[]
    if (typeof o.command === 'string' && o.command) command = [o.command]
    else if (Array.isArray(o.command) && o.command.length > 0 && o.command.every(x => typeof x === 'string')) {
        command = o.command as string[]
    } else return null
    const timeoutS = Number(o.timeoutS)
    if (!Number.isInteger(timeoutS) || timeoutS < 1) return null
    return { service: o.service, command, timeoutS }
}

export function listedArgv(opts: {
    timeoutS: number
    service: string
    command: string[]
    mode: UsageMode
    day?: string
}): string[] {
    const timeout = clampTimeoutS(opts.timeoutS)
    const env = ['-e', `IDEA_USAGE_MODE=${opts.mode}`]
    if (opts.mode === 'day' && opts.day) env.push('-e', `IDEA_USAGE_DAY=${opts.day}`)
    const modeArgs = opts.mode === 'day' ? ['day', opts.day as string] : ['sample']
    return [
        'timeout', '--signal=TERM', '--kill-after=10s', String(timeout),
        'nice', '-n', '15',
        'ionice', '-c3',
        'docker', 'compose', 'exec', '-T',
        ...env,
        opts.service,
        ...opts.command,
        ...modeArgs,
    ]
}

export function unlistedArgv(opts: {
    timeoutS: number
    container: string
    mode: UsageMode
    day?: string
}): string[] {
    const timeout = clampTimeoutS(opts.timeoutS)
    const env = ['-e', `IDEA_USAGE_MODE=${opts.mode}`]
    if (opts.mode === 'day' && opts.day) env.push('-e', `IDEA_USAGE_DAY=${opts.day}`)
    const modeArgs = opts.mode === 'day' ? ['day', opts.day as string] : ['sample']
    return [
        'timeout', '--signal=TERM', '--kill-after=10s', String(timeout),
        'nice', '-n', '15',
        'ionice', '-c3',
        'docker', 'exec', '-i',
        ...env,
        opts.container,
        'sh', '-s', '--',
        ...modeArgs,
    ]
}

export function parseHookStdout(raw: string, cap: number): { ok: true; value: unknown } | { ok: false; reason: 'oversize' | 'invalid' } {
    if (Buffer.byteLength(raw, 'utf8') > cap) return { ok: false, reason: 'oversize' }
    if (raw.length > 0 && raw.charCodeAt(0) === 0xFEFF) return { ok: false, reason: 'invalid' }
    try {
        const value = JSON.parse(raw.trim())
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid' }
        return { ok: true, value }
    } catch {
        return { ok: false, reason: 'invalid' }
    }
}

export function runArgv(spec: {
    argv: string[]
    cwd?: string
    stdin?: string
    stdoutCap: number
    stderrCap: number
    timeoutMs: number
}): Promise<ExecResult> {
    return new Promise(resolve => {
        if (spec.argv.length === 0) {
            resolve({ stdout: '', stderr: 'empty argv', exitCode: 127, timedOut: false })
            return
        }
        let settled = false
        const done = (r: ExecResult) => { if (!settled) { settled = true; resolve(r) } }
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
            cwd: spec.cwd,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutLen = 0
        let oversize = false
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
            setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 10_000)
        }, spec.timeoutMs)
        child.stdout.on('data', (c: Buffer) => {
            const next = stdoutLen + c.length
            if (next > spec.stdoutCap) {
                const remain = Math.max(0, spec.stdoutCap - stdoutLen)
                if (remain > 0) stdoutChunks.push(c.subarray(0, remain))
                stdoutLen = next
                oversize = true
                child.kill('SIGTERM')
                return
            }
            stdoutChunks.push(c)
            stdoutLen = next
        })
        child.stderr.on('data', (c: Buffer) => {
            const have = Buffer.concat(stderrChunks).length
            const remain = spec.stderrCap - have
            if (remain > 0) stderrChunks.push(c.subarray(0, remain))
        })
        child.stdin.on('error', () => { /* EPIPE if the child exits early */ })
        if (spec.stdin != null) child.stdin.write(spec.stdin)
        child.stdin.end()
        child.on('error', err => {
            clearTimeout(timer)
            done({ stdout: '', stderr: String(err), exitCode: 127, timedOut: false })
        })
        child.on('close', code => {
            clearTimeout(timer)
            done({
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                exitCode: code ?? 1,
                timedOut,
                oversizeStdout: oversize,
            })
        })
    })
}

export function hookArgvFor(target: UsageTarget, mode: UsageMode, day?: string): { argv: string[]; cwd?: string; stdin?: string; timeoutS: number } | null {
    if (!target.hook) return null
    const timeoutS = clampTimeoutS(target.hook.timeoutS)
    if (target.kind === 'listed') {
        return {
            argv: listedArgv({ timeoutS, service: target.hook.service, command: target.hook.command, mode, day }),
            cwd: target.cwd,
            timeoutS,
        }
    }
    return {
        argv: unlistedArgv({ timeoutS, container: target.containerId, mode, day }),
        stdin: target.hookScript ?? '',
        timeoutS,
    }
}

export interface ClockDeps {
    now?: () => Date
    hostname?: () => string
    ntpSynced?: () => boolean
    presence?: () => ClockInfo
}

export function collectionClock(deps: ClockDeps = {}, root = usageRoot()): { collectedAt: string; clock: ClockInfo; engine: string; now: Date } {
    const now = (deps.now ?? (() => new Date()))()
    if (deps.presence) {
        return { collectedAt: formatRfc3339(now), clock: deps.presence(), engine: (deps.hostname ?? engineHostname)(), now }
    }
    const today = kitLocalDay(now)
    const history = readPresenceSince(addDays(today, -14), today, root)
    return {
        collectedAt: formatRfc3339(now),
        clock: {
            synced: deps.ntpSynced ? deps.ntpSynced() : false,
            correctedBoots: correctedBootsSinceLastSync(history),
        },
        engine: (deps.hostname ?? engineHostname)(),
        now,
    }
}

export function buildDayRecord(opts: {
    target: UsageTarget
    day: string
    hookStatus: HookStatus
    skipReason?: SkipReason
    hookBody?: Record<string, unknown>
    clock: ClockInfo
    collectedAt: string
    engine: string
}): DayFile {
    const demo = resolveDemo(opts.hookBody?.demo, opts.target.name)
    const payload = opts.hookBody ? hookPayloadFields(opts.hookBody) : {}
    const record: DayFile = {
        schema: USAGE_SCHEMA_DAY,
        engine: opts.engine,
        day: opts.day,
        app: (typeof opts.hookBody?.app === 'string' ? opts.hookBody.app : opts.target.app) || opts.target.app,
        instance: opts.target.instanceId,
        name: opts.target.name,
        demo,
        listed: opts.target.listed,
        clock: opts.clock,
        collectedAt: opts.collectedAt,
        hookStatus: opts.hookStatus,
        ...payload,
    }
    if (opts.hookStatus === 'skipped' && opts.skipReason) record.skipReason = opts.skipReason
    return record
}

export type ExecHook = (spec: { argv: string[]; cwd?: string; stdin?: string; timeoutS: number; mode: UsageMode; day?: string }) => Promise<ExecResult>

export async function defaultExecHook(spec: { argv: string[]; cwd?: string; stdin?: string; timeoutS: number }): Promise<ExecResult> {
    const cap = spec.argv.includes('sample') && !spec.argv.includes('day') ? SAMPLE_STDOUT_CAP : DAY_FILE_CAP
    return runArgv({
        argv: spec.argv,
        cwd: spec.cwd,
        stdin: spec.stdin,
        stdoutCap: cap,
        stderrCap: STDERR_CAP,
        timeoutMs: (spec.timeoutS + 15) * 1000,
    })
}

export async function runDayHook(opts: {
    target: UsageTarget
    day: string
    root?: string
    exec?: ExecHook
    clock?: ClockDeps
    skipReason?: SkipReason | null
}): Promise<DayFile> {
    const root = opts.root ?? usageRoot()
    const { collectedAt, clock, engine } = collectionClock(opts.clock, root)
    const stamp = { clock, collectedAt, engine, day: opts.day, target: opts.target }

    if (opts.skipReason) {
        const rec = buildDayRecord({ ...stamp, hookStatus: 'skipped', skipReason: opts.skipReason })
        writeDayFile(rec, root)
        return rec
    }
    if (!opts.target.hook) {
        const hookStatus = opts.target.listed ? 'no-hook' : 'unlisted-no-hook'
        const rec = buildDayRecord({ ...stamp, hookStatus })
        writeDayFile(rec, root)
        return rec
    }
    const argvSpec = hookArgvFor(opts.target, 'day', opts.day)
    const exec = opts.exec ?? defaultExecHook
    let result: ExecResult
    try {
        result = await exec({ ...argvSpec!, mode: 'day', day: opts.day })
    } catch (e) {
        usageLog(`hook threw for ${opts.target.instanceId}: ${e instanceof Error ? e.message : String(e)}`)
        const rec = buildDayRecord({ ...stamp, hookStatus: 'failed' })
        writeDayFile(rec, root)
        return rec
    }
    if (result.stderr) usageLog(`hook stderr ${opts.target.instanceId}: ${result.stderr.replace(/\n/g, ' ').slice(0, STDERR_CAP)}`)
    if (result.timedOut) {
        const rec = buildDayRecord({ ...stamp, hookStatus: 'timeout' })
        writeDayFile(rec, root)
        return rec
    }
    if (result.oversizeStdout || result.exitCode !== 0) {
        const rec = buildDayRecord({ ...stamp, hookStatus: result.oversizeStdout ? 'invalid' : 'failed' })
        writeDayFile(rec, root)
        return rec
    }
    const parsed = parseHookStdout(result.stdout, DAY_FILE_CAP)
    if (!parsed.ok) {
        const rec = buildDayRecord({ ...stamp, hookStatus: 'invalid' })
        writeDayFile(rec, root)
        return rec
    }
    const checked = validateDayHook(parsed.value, opts.day)
    if (!checked.ok) {
        usageLog(`invalid day hook for ${opts.target.instanceId}: ${checked.error}`)
        const rec = buildDayRecord({ ...stamp, hookStatus: 'invalid' })
        writeDayFile(rec, root)
        return rec
    }
    let rec = buildDayRecord({ ...stamp, hookStatus: 'ok', hookBody: checked.value })
    rec = applyOfficeMerge(rec, root)
    writeDayFile(rec, root)
    return rec
}

export async function runSampleHook(opts: {
    target: UsageTarget
    root?: string
    exec?: ExecHook
    clock?: ClockDeps
    skipReason?: SkipReason | null
}): Promise<SampleRecord | null> {
    const root = opts.root ?? usageRoot()
    if (opts.skipReason || !opts.target.hook) return null
    const argvSpec = hookArgvFor(opts.target, 'sample')
    const exec = opts.exec ?? defaultExecHook
    let result: ExecResult
    try {
        result = await exec({ ...argvSpec!, mode: 'sample' })
    } catch (e) {
        usageLog(`sample hook threw for ${opts.target.instanceId}: ${e instanceof Error ? e.message : String(e)}`)
        return null
    }
    if (result.stderr) usageLog(`sample stderr ${opts.target.instanceId}: ${result.stderr.replace(/\n/g, ' ').slice(0, STDERR_CAP)}`)
    if (result.timedOut || result.exitCode !== 0 || result.oversizeStdout) return null
    const parsed = parseHookStdout(result.stdout, SAMPLE_STDOUT_CAP)
    if (!parsed.ok) return null
    const checked = validateSampleHook(parsed.value)
    if (!checked.ok) {
        usageLog(`invalid sample hook for ${opts.target.instanceId}: ${checked.error}`)
        return null
    }
    if (checked.value.supported === false) return null
    const { collectedAt } = collectionClock(opts.clock, root)
    const record: SampleRecord = { ...checked.value, collectedAt }
    const day = kitLocalDay((opts.clock?.now ?? (() => new Date()))())
    appendSample(day, opts.target.instanceId, record, root)
    return record
}
