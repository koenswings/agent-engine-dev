/**
 * backupMethod.ts — parse x-app.backup method/hooks (idea#444)
 *
 * Methods: `stop` (default, today's short stop) and `hook`. `live` and `none`
 * fail closed until an App needs them (Steve, idea#444).
 *
 * `fallback: stop|fail` (default `stop`) applies when method is `hook` and the
 * preHook fails or times out. `stop` then takes the existing short-stop path
 * (HOOK_FALLBACK). `fail` refuses the backup without stopping the instance.
 *
 * Hooks run as argv (no shell):
 *   timeout --signal=TERM --kill-after=10s <hookTimeout>
 *     docker compose exec -T [--user <user>] -- <service> <command…>
 * from the instance directory, while backupInstance already holds the instance
 * lock. No helper bump (stay on v8).
 */

import { spawn } from 'node:child_process'

/** Default hookTimeout in seconds (idea PR #389 §9). */
export const DEFAULT_HOOK_TIMEOUT_S = 300

const SERVICE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const USER_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

export type BackupMethod = 'stop' | 'hook'
export type BackupFallback = 'stop' | 'fail'

export interface BackupHookDecl {
    service: string
    command: string[]
    user?: string
}

export interface BackupSpec {
    method: BackupMethod
    fallback: BackupFallback
    preHook: BackupHookDecl | null
    postHook: BackupHookDecl | null
    hookTimeout: number
}

export const defaultBackupSpec = (): BackupSpec => ({
    method: 'stop',
    fallback: 'stop',
    preHook: null,
    postHook: null,
    hookTimeout: DEFAULT_HOOK_TIMEOUT_S,
})

export const backupMethodError = (why: string): Error =>
    new Error(`x-app.backup ${why}`)

const parseCommand = (raw: unknown, which: string): string[] => {
    if (typeof raw === 'string') {
        if (!raw) throw backupMethodError(`${which}.command is empty`)
        if (raw.includes('\0')) throw backupMethodError(`${which}.command contains a NUL`)
        if (/[\n\r]/.test(raw)) throw backupMethodError(`${which}.command contains a newline`)
        return [raw]
    }
    if (Array.isArray(raw)) {
        if (raw.length === 0) throw backupMethodError(`${which}.command is an empty list`)
        const out: string[] = []
        for (const item of raw) {
            if (typeof item !== 'string') throw backupMethodError(`${which}.command entries must be strings`)
            if (!item) throw backupMethodError(`${which}.command contains an empty word`)
            if (item.includes('\0')) throw backupMethodError(`${which}.command contains a NUL`)
            if (/[\n\r]/.test(item)) throw backupMethodError(`${which}.command contains a newline`)
            out.push(item)
        }
        return out
    }
    throw backupMethodError(`${which}.command must be a string or a list of strings`)
}

const parseService = (raw: unknown, which: string): string => {
    if (typeof raw !== 'string' || !raw) throw backupMethodError(`${which}.service is required`)
    if (raw.startsWith('-')) throw backupMethodError(`${which}.service '${raw}' looks like an option`)
    if (raw.includes('..')) throw backupMethodError(`${which}.service '${raw}' is not allowed`)
    if (!SERVICE_TOKEN.test(raw)) throw backupMethodError(`${which}.service '${raw}' is not a compose service name`)
    return raw
}

const parseUser = (raw: unknown, which: string): string | undefined => {
    if (raw === undefined || raw === null || raw === '') return undefined
    const s = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : raw
    if (typeof s !== 'string') throw backupMethodError(`${which}.user must be a uid or username`)
    if (s.startsWith('-')) throw backupMethodError(`${which}.user '${s}' looks like an option`)
    if (s.includes('..')) throw backupMethodError(`${which}.user '${s}' is not allowed`)
    if (!USER_TOKEN.test(s)) throw backupMethodError(`${which}.user '${s}' is not a uid or username`)
    return s
}

export const parseBackupHookDecl = (raw: unknown, which: string): BackupHookDecl => {
    if (raw === undefined || raw === null) throw backupMethodError(`${which} is required`)
    if (typeof raw !== 'object' || Array.isArray(raw)) throw backupMethodError(`${which} is not a mapping`)
    const o = raw as Record<string, unknown>
    const service = parseService(o.service, which)
    const command = parseCommand(o.command, which)
    const user = parseUser(o.user, which)
    const hook: BackupHookDecl = { service, command }
    if (user !== undefined) hook.user = user
    return hook
}

export const parseBackupSpec = (xapp: unknown): BackupSpec => {
    const spec = defaultBackupSpec()
    if (xapp === undefined || xapp === null) return spec
    if (typeof xapp !== 'object' || Array.isArray(xapp)) {
        throw new Error('x-app is not a mapping')
    }
    const backup = (xapp as { backup?: unknown }).backup
    if (backup === undefined || backup === null) return spec
    if (typeof backup !== 'object' || Array.isArray(backup)) {
        throw new Error('x-app.backup is not a mapping')
    }
    const b = backup as Record<string, unknown>

    if (b.method !== undefined && b.method !== null) {
        if (b.method === 'stop' || b.method === 'hook') spec.method = b.method
        else if (b.method === 'live' || b.method === 'none') {
            throw backupMethodError(`method '${b.method}' is not implemented (idea#444); only 'stop' (default) and 'hook' are supported`)
        } else {
            throw backupMethodError(`method '${String(b.method)}' is not allowed (use 'stop' or 'hook')`)
        }
    }

    if (b.fallback !== undefined && b.fallback !== null) {
        if (b.fallback === 'stop' || b.fallback === 'fail') spec.fallback = b.fallback
        else throw backupMethodError(`fallback '${String(b.fallback)}' is not allowed (use 'stop' or 'fail')`)
    }

    if (b.hookTimeout !== undefined && b.hookTimeout !== null) {
        const n = typeof b.hookTimeout === 'number' ? b.hookTimeout : Number(b.hookTimeout)
        if (!Number.isInteger(n) || n < 1 || n > 86400) {
            throw backupMethodError('hookTimeout must be a positive integer number of seconds (max 86400)')
        }
        spec.hookTimeout = n
    }

    if (b.preHook !== undefined && b.preHook !== null) spec.preHook = parseBackupHookDecl(b.preHook, 'preHook')
    if (b.postHook !== undefined && b.postHook !== null) spec.postHook = parseBackupHookDecl(b.postHook, 'postHook')

    if (spec.method === 'hook' && !spec.preHook) {
        throw backupMethodError("method is 'hook' but preHook is missing")
    }
    return spec
}

/** Fail closed if a declared hook names a service that is not in compose `services`. */
export const assertHookServicesExist = (compose: unknown, spec: BackupSpec): void => {
    const hooks = [spec.preHook, spec.postHook].filter((h): h is BackupHookDecl => !!h)
    if (!hooks.length) return
    const services = (compose && typeof compose === 'object' && !Array.isArray(compose))
        ? (compose as { services?: unknown }).services
        : undefined
    const names = (services && typeof services === 'object' && !Array.isArray(services))
        ? new Set(Object.keys(services as object))
        : new Set<string>()
    for (const hook of hooks) {
        if (!names.has(hook.service)) {
            throw backupMethodError(`hook service '${hook.service}' is not a compose service`)
        }
    }
}

export interface BackupHookRunSpec {
    cwd: string
    timeoutS: number
    service: string
    command: string[]
    user?: string
    /**
     * idea#448 pre-update backup: run the hook declared in the NEW bundle's compose
     * against the live compose project. `docker compose -p <project>
     * --project-directory <projectDir> -f <composeFile> exec ...`, so the running
     * containers of instance <project> are used and the live .env is read.
     */
    compose?: { project: string, projectDir: string, file: string }
}

export interface BackupHookRunResult {
    code: number
    timedOut: boolean
    stderr: string
}

/**
 * argv for a backup hook. `timeout` bounds the exec; `--` stops option injection
 * into `docker compose exec`.
 */
export const backupHookArgv = (spec: BackupHookRunSpec): string[] => {
    const timeout = Number.isInteger(spec.timeoutS) && spec.timeoutS >= 1 ? spec.timeoutS : DEFAULT_HOOK_TIMEOUT_S
    const argv = [
        'timeout', '--signal=TERM', '--kill-after=10s', String(timeout),
        'docker', 'compose',
    ]
    if (spec.compose) argv.push('-p', spec.compose.project, '--project-directory', spec.compose.projectDir, '-f', spec.compose.file)
    argv.push('exec', '-T')
    if (spec.user !== undefined) argv.push('--user', spec.user)
    argv.push('--', spec.service, ...spec.command)
    return argv
}

export const defaultRunBackupHook = (spec: BackupHookRunSpec): Promise<BackupHookRunResult> =>
    new Promise((resolve, reject) => {
        const argv = backupHookArgv(spec)
        const proc = spawn(argv[0], argv.slice(1), {
            cwd: spec.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stderr = ''
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
        const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }, (spec.timeoutS + 15) * 1000)
        proc.on('error', (err) => {
            clearTimeout(killer)
            reject(new Error(`backup hook could not start (${argv[0]}): ${err.message}`))
        })
        proc.on('close', (code, signal) => {
            clearTimeout(killer)
            const timedOut = code === 124 || signal === 'SIGTERM' || signal === 'SIGKILL'
            resolve({ code: code ?? 1, timedOut, stderr })
        })
    })

/** Tests replace `run`. Production uses `defaultRunBackupHook`. */
export const backupHookRunner: { run: (spec: BackupHookRunSpec) => Promise<BackupHookRunResult> } = {
    run: defaultRunBackupHook,
}
