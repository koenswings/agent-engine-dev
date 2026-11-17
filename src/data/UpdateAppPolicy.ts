/**
 * UpdateAppPolicy.ts — pure rules for updateApp v1, local swap (agent-engine-dev#230).
 *
 * No I/O here: the command (UpdateApp.ts, next increment) feeds facts in and acts on
 * the decisions. Agreed rules (#230 comment 6469233119):
 *  - No move-aside metadata field and no Kolibri special case.
 *  - Rollback after a failed step at or after Snapshot ALWAYS restores the pre-update
 *    data snapshot as well as the old bundle/image, never just the old image.
 *  - Health gate: during healthTimeout, `starting` and `unhealthy` are "not ready yet";
 *    fail only on container exit, crash-loop or timeout.
 *  - healthTimeout per App: kolibri 900 s, nextcloud 300 s, default 600 s (table in
 *    AppHealthTimeout.ts, shared with the start-time port-ready check, idea#437).
 *  - An App without valid SHA256SUMS is never offered an update (NO_SUMS).
 */
import { appIdentity } from './AppIdParse.js'
import { APP_HEALTH_TIMEOUT_S } from './AppHealthTimeout.js'
import { isUpgrade, isMajorChange, isUnversioned, parseVersion } from './Version.js'

/**
 * engine#456 (Console contract agreed with Pixel, 2026-11-17): a fixed list of 12 steps keyed on
 * names (totalSteps 12). LoadImages runs for every App; Prepare, Verify, Work and Settle run only
 * when the NEW bundle declares them in x-app.update (a step that is not declared is skipped).
 */
export type UpdateStep = 'Fetch' | 'Check' | 'Backup' | 'Snapshot' | 'Swap' | 'LoadImages' | 'Prepare' | 'Start' | 'Health' | 'Verify' | 'Work' | 'Settle'
export const UPDATE_STEPS: readonly UpdateStep[] = ['Fetch', 'Check', 'Backup', 'Snapshot', 'Swap', 'LoadImages', 'Prepare', 'Start', 'Health', 'Verify', 'Work', 'Settle']

export type UpdateRefusal =
    | 'NOT_DOCKED' | 'BUSY' | 'SOURCE_MISSING' | 'DIFFERENT_APP' | 'NOT_NEWER'
    | 'MAJOR_NOT_ALLOWED' | 'NEEDS_BACKUP' | 'NO_SPACE' | 'NO_SUMS'
    | 'NOT_FOUND' | 'AMBIGUOUS' | 'HELPER_OUTDATED' | 'TRANSFER_FAILED'
    // idea#448: the backup updateApp takes itself before a major update
    | 'BAD_BACKUP_SPEC' | 'HOOK_FAILED' | 'BACKUP_FAILED'
    // idea#448: the new bundle ships a path the snapshot and rollback leave out
    | 'BUNDLE_CONTAINS_EXCLUDED'
    // idea#396: a snapshot / estimate exclude token is refused (helper v14 rules)
    | 'INVALID_EXCLUDE'
    // idea#479: id checked before any compose or Docker action
    | 'INVALID_INSTANCE_ID'
    // engine#456: x-app.update names a stage key this Engine does not know
    | 'UPDATE_STAGES_UNSUPPORTED'
    // engine#456: a declared prepare / verify / work / settle has the wrong shape (refused at Check)
    | 'UPDATE_CONTRACT_INVALID'
    // engine#456: the instance has a committed update whose work / settle has not finished
    | 'UPDATE_PENDING'
    // engine#456: step outcomes. PREPARE_FAILED / VERIFY_FAILED roll back (the result is ROLLED_BACK);
    // MIGRATIONS_PENDING / SETTLE_FAILED end the operation after the point of no return (no rollback).
    | 'PREPARE_FAILED' | 'VERIFY_FAILED' | 'MIGRATIONS_PENDING' | 'SETTLE_FAILED'
    // engine#469: the temporary pre-update backup on the system disk (no Backup Disk linked)
    | 'TEMP_BACKUP_NO_SPACE' | 'TEMP_BACKUP_FAILED'

/** Error text starts with the code; the two rollback outcomes use the console#168 wording. */
export const ROLLED_BACK_PREFIX = 'ROLLED BACK:'
export const ROLLBACK_FAILED_PREFIX = 'ROLLBACK FAILED:'
/**
 * engine#456 (Q6, mirrors #468's RESTORE_START_FAILED): the data was restored but the old version
 * did not start. The instance is left Stopped with this statusCondition prefix.
 */
export const ROLLBACK_START_FAILED_PREFIX = 'ROLLBACK START FAILED:'

export class UpdateAppError extends Error {
    /** engine#442: the old version could not be restarted after a pre-swap failure. */
    restartFailed?: true
    /** Published on the command-log trace so the Console can pick its wording. */
    traceResult?: { restartFailed: true }
    constructor(public code: UpdateRefusal | 'ROLLED_BACK' | 'ROLLBACK_FAILED' | 'ROLLBACK_START_FAILED', text: string, opts?: { restartFailed?: true }) {
        super(code === 'ROLLED_BACK' ? `${ROLLED_BACK_PREFIX} ${text}`
            : code === 'ROLLBACK_FAILED' ? `${ROLLBACK_FAILED_PREFIX} ${text}`
            : code === 'ROLLBACK_START_FAILED' ? `${ROLLBACK_START_FAILED_PREFIX} ${text}`
            : `${code}: ${text}`)
        if (opts?.restartFailed) {
            this.restartFailed = true
            this.traceResult = { restartFailed: true }
        }
    }
}

/** Version rules live in Version.ts (idea#76); re-exported for existing callers. */
export { parseVersion, compareVersions, isUnversioned, isUpgrade, isMajorChange } from './Version.js'

/** The per-App timeout table lives in AppHealthTimeout.ts, shared with the start-time port-ready check (idea#437). */
export { healthTimeoutSeconds, APP_HEALTH_TIMEOUT_S, DEFAULT_HEALTH_TIMEOUT_S } from './AppHealthTimeout.js'

export interface CheckFacts {
    diskDocked: boolean
    busy: boolean
    currentAppId: string
    newAppId: string
    /**
     * engine#480: the instance's live compose x-app. When it produced currentAppId, its name and
     * version are the instance's identity (kiwix / release-1.0), not a split of the id.
     */
    currentXApp?: unknown
    /** engine#480: the new bundle's compose x-app, same rule for newAppId. */
    newXApp?: unknown
    sourcePresent: boolean
    sumsValid: boolean
    allowMajor: boolean
    /** ms since the last Borg backup; null if never */
    backupAgeMs: number | null
    /** disks that lack space (name), empty when all fit */
    shortDisks: string[]
    /** x-app.updatesFrom of the NEW bundle (idea#76); absent = no extra rule */
    updatesFrom?: unknown
    /**
     * idea#448: a Backup Disk linked to the instance is docked here, so updateApp takes the
     * required backup itself (hook before the stop, or Borg inside the Snapshot stop).
     * engine#469: also true when no such disk is docked; updateApp then takes a temporary
     * backup on the system disk (this operation only).
     */
    backupPlanned?: boolean
    /**
     * idea#403: the live compose's x-app.backup.method. 'none' declares there is nothing to
     * back up, so a major update never refuses NEEDS_BACKUP for it.
     */
    backupMethod?: 'stop' | 'hook' | 'none'
    /**
     * engine#456: the new bundle's x-app.update. Absent, null, or {} means no stages.
     * A declared prepare / verify / work / settle must have the agreed shape (parseUpdateContract).
     */
    xAppUpdate?: unknown
    /** engine#456: the service names of the NEW bundle's compose (a step's service must be one of them). */
    newServices?: string[]
}

/**
 * x-app.updatesFrom (idea#76, idea#351 §4.4): when the new bundle declares it, a major update is
 * only allowed from a listed major. Absent or not a list: no extra rule. An unversioned current
 * version (kit SHA/date, #301) has no major and is not restricted by it — so a SHA kit can still
 * take tagged 1.7 (idea#374). engine#456 separately refuses an unversioned source to 2.0+
 * (unversionedMayTakeTarget), regardless of updatesFrom.
 */
export const majorAllowedByUpdatesFrom = (fromVersion: string, updatesFrom: unknown): boolean => {
    if (!Array.isArray(updatesFrom)) return true
    const x = parseVersion(fromVersion)
    if (!x) return true
    return updatesFrom.some(m => Number(m) === (x[0] ?? 0))
}

/**
 * engine#456: an unversioned (SHA or date) instance may be offered and allowed only the
 * first tagged major (0.x or 1.x, including Nextcloud 1.7-31.0.1). Never 2.0+.
 * Versioned sources are unchanged. This does not recategorise SHA → 1.x: it stays a
 * major (isMajorChange), so --allow-major and the NEEDS_BACKUP path still apply.
 */
// Unversioned (SHA/date) sources may take only the first tagged major; < 2 so apps still on 0.x aren't blocked (Steve, #463)
export const unversionedMayTakeTarget = (fromVersion: string, toVersion: string): boolean => {
    if (!isUnversioned(fromVersion)) return true
    const y = parseVersion(toVersion)
    if (!y) return false
    return (y[0] ?? 0) < 2
}

/** Stages the NC35 contract names. The interim Check refuses a hop that declares any of these. */
export const UPDATE_STAGE_KEYS = ['prepare', 'verify', 'work', 'settle'] as const
export type UpdateStageKey = typeof UPDATE_STAGE_KEYS[number]

/**
 * Declared x-app.update stages on a bundle. `update: null` and a missing key are absent;
 * `update: {}` has no stages; a known stage whose value is null is not declared.
 */
export const declaredUpdateStages = (update: unknown): UpdateStageKey[] => {
    if (update == null || typeof update !== 'object' || Array.isArray(update)) return []
    const o = update as Record<string, unknown>
    return UPDATE_STAGE_KEYS.filter(k => o[k] != null)
}

/** engine#456 (Q5): every step timeout (and settle's interval) is required and must be 1 s – 6 h. */
export const UPDATE_STEP_MIN_S = 1
export const UPDATE_STEP_MAX_S = 6 * 60 * 60

/** One declared step: prepare / verify / work take {service, user?, command, timeout}; settle adds interval. */
export interface UpdateStepSpec {
    service: string
    /** docker --user / -u exactly as written ("0", "33", "www-data", "33:33"); absent = the image default */
    user?: string
    /** one absolute path inside the container; argv is exactly [command] */
    command: string
    /** seconds, 1 s – 6 h */
    timeout: number
    /** settle only: seconds between runs, 1 s – 6 h and not above timeout */
    interval?: number
}
export type UpdateContract = Partial<Record<UpdateStageKey, UpdateStepSpec>>

const STEP_FIELDS = new Set(['service', 'user', 'command', 'timeout', 'interval'])
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$/
const ABS_COMMAND_RE = /^\/[A-Za-z0-9_.\/@+-]+$/

const boundedSeconds = (v: unknown): boolean =>
    typeof v === 'number' && Number.isInteger(v) && v >= UPDATE_STEP_MIN_S && v <= UPDATE_STEP_MAX_S

/**
 * engine#456 §1: parse and check x-app.update of the NEW bundle. Absent, null and {} mean no
 * steps (today's path). An unknown stage key refuses UPDATE_STAGES_UNSUPPORTED; a declared step
 * with the wrong shape, a service not in the new compose (when `services` is given), a command that
 * is not one absolute path, or a missing / out-of-range timeout or interval refuses
 * UPDATE_CONTRACT_INVALID. Pure; nothing is stopped or changed when it refuses.
 */
export const parseUpdateContract = (update: unknown, services?: string[]): { ok: true, contract: UpdateContract } | { ok: false, error: UpdateAppError } => {
    const bad = (why: string) => ({ ok: false as const, error: new UpdateAppError('UPDATE_CONTRACT_INVALID', `x-app.update ${why}; nothing was stopped or changed`) })
    if (update == null) return { ok: true, contract: {} }
    if (typeof update !== 'object' || Array.isArray(update)) return bad('must be a map of prepare / verify / work / settle')
    const o = update as Record<string, unknown>
    const unknown = Object.keys(o).filter(k => !(UPDATE_STAGE_KEYS as readonly string[]).includes(k))
    if (unknown.length) {
        return { ok: false, error: new UpdateAppError('UPDATE_STAGES_UNSUPPORTED', `this Engine does not run x-app.update stage ${unknown.join(', ')} (it runs ${UPDATE_STAGE_KEYS.join(', ')}); nothing was stopped or changed`) }
    }
    const contract: UpdateContract = {}
    for (const k of UPDATE_STAGE_KEYS) {
        const v = o[k]
        if (v == null) continue
        if (typeof v !== 'object' || Array.isArray(v)) return bad(`${k} must be a map {service, user?, command, timeout${k === 'settle' ? ', interval' : ''}}`)
        const s = v as Record<string, unknown>
        const extra = Object.keys(s).filter(f => !STEP_FIELDS.has(f) || (f === 'interval' && k !== 'settle'))
        if (extra.length) return bad(`${k} has unknown field ${extra.join(', ')}`)
        if (typeof s.service !== 'string' || !s.service) return bad(`${k}.service is missing`)
        if (services && !services.includes(s.service)) return bad(`${k}.service ${s.service} is not a service of the new compose`)
        let user: string | undefined
        if (s.user != null) {
            user = typeof s.user === 'number' && Number.isInteger(s.user) && s.user >= 0 ? String(s.user) : typeof s.user === 'string' ? s.user : ''
            if (!USER_RE.test(user)) return bad(`${k}.user must be a user name or id (optionally :group)`)
        }
        if (typeof s.command !== 'string' || !ABS_COMMAND_RE.test(s.command) || s.command.split('/').includes('..')) return bad(`${k}.command must be one absolute path`)
        if (s.timeout == null) return bad(`${k}.timeout is required (seconds, ${UPDATE_STEP_MIN_S} s – 6 h)`)
        if (!boundedSeconds(s.timeout)) return bad(`${k}.timeout must be whole seconds from ${UPDATE_STEP_MIN_S} to ${UPDATE_STEP_MAX_S} (6 h)`)
        const spec: UpdateStepSpec = { service: s.service, command: s.command, timeout: s.timeout as number }
        if (user !== undefined) spec.user = user
        if (k === 'settle') {
            if (s.interval == null) return bad('settle.interval is required (seconds)')
            if (!boundedSeconds(s.interval)) return bad(`settle.interval must be whole seconds from ${UPDATE_STEP_MIN_S} to ${UPDATE_STEP_MAX_S} (6 h)`)
            if ((s.interval as number) > spec.timeout) return bad('settle.interval must not be above settle.timeout')
            spec.interval = s.interval as number
        }
        contract[k] = spec
    }
    return { ok: true, contract }
}

/** True when the contract declares any step. */
export const contractHasSteps = (c: UpdateContract): boolean => UPDATE_STAGE_KEYS.some(k => !!c[k])

export const BACKUP_MAX_AGE_MS = 60 * 60 * 1000

/**
 * idea#448: true when this update needs a fresh backup (a major upgrade, idea#76: an
 * unversioned SHA to a tag stays major, and no backup in the last hour).
 */
export const backupIsDue = (currentAppId: string, newAppId: string, backupAgeMs: number | null, currentXApp?: unknown, newXApp?: unknown): boolean => {
    const cur = appIdentity(currentAppId, currentXApp).version, nxt = appIdentity(newAppId, newXApp).version
    if (!isUpgrade(cur, nxt) || !isMajorChange(cur, nxt)) return false
    return backupAgeMs === null || backupAgeMs > BACKUP_MAX_AGE_MS
}

/** createAppId(undefined, undefined) stringifies missing x-app.name / x-app.version as "undefined". */
const isMissingAppField = (value: string): boolean => value === '' || value === 'undefined'

const showAppField = (value: string): string => isMissingAppField(value) ? '(missing)' : value

/**
 * Why updateApp should refuse DIFFERENT_APP: missing or mismatched x-app.name
 * and/or x-app.version, with the instance's actual values and the bundle's expected ones.
 * createOrUpdateInstance sets instanceOf from those compose fields, so a bundle
 * without them becomes `undefined-undefined` (seen on idea04 during #311).
 * engine#480: name and version come from the x-app that built each id when given (appIdentity).
 */
export const appIdentityProblems = (currentAppId: string, newAppId: string, currentXApp?: unknown, newXApp?: unknown): string | null => {
    const cur = appIdentity(currentAppId, currentXApp), nxt = appIdentity(newAppId, newXApp)
    const problems: string[] = []
    if (isMissingAppField(cur.name) || isMissingAppField(nxt.name)) {
        problems.push(`x-app.name is missing (actual: ${showAppField(cur.name)}, expected: ${showAppField(nxt.name)})`)
    } else if (cur.name !== nxt.name) {
        problems.push(`x-app.name mismatch (actual: ${cur.name}, expected: ${nxt.name})`)
    }
    if (isMissingAppField(cur.version) || isMissingAppField(nxt.version)) {
        problems.push(`x-app.version is missing (actual: ${showAppField(cur.version)}, expected: ${showAppField(nxt.version)})`)
    } else if (cur.name !== nxt.name && cur.version !== nxt.version) {
        problems.push(`x-app.version mismatch (actual: ${cur.version}, expected: ${nxt.version})`)
    }
    return problems.length ? problems.join('; ') : null
}

/** First refusal in the agreed order, or null when the update may go ahead. */
export const checkUpdate = (f: CheckFacts): UpdateAppError | null => {
    if (!f.diskDocked) return new UpdateAppError('NOT_DOCKED', 'the App Disk is not docked to this Engine')
    if (f.busy) return new UpdateAppError('BUSY', 'another operation is running on this instance')
    if (!f.sourcePresent) return new UpdateAppError('SOURCE_MISSING', `bundle ${f.newAppId} was not found on the source`)
    if (!f.sumsValid) return new UpdateAppError('NO_SUMS', `bundle ${f.newAppId} has no valid SHA256SUMS`)
    const identity = appIdentityProblems(f.currentAppId, f.newAppId, f.currentXApp, f.newXApp)
    if (identity) return new UpdateAppError('DIFFERENT_APP', identity)
    const cur = appIdentity(f.currentAppId, f.currentXApp), nxt = appIdentity(f.newAppId, f.newXApp)
    if (!isUpgrade(cur.version, nxt.version)) return new UpdateAppError('NOT_NEWER', `${nxt.version} is not newer than ${cur.version}`)
    // engine#456: before anything stops, the declared steps must have the agreed shape
    const contract = parseUpdateContract(f.xAppUpdate, f.newServices)
    if (!contract.ok) return contract.error
    if (!unversionedMayTakeTarget(cur.version, nxt.version)) {
        return new UpdateAppError(
            'MAJOR_NOT_ALLOWED',
            `unversioned ${cur.version} can only update to the first tagged major (1.x), not ${nxt.version}`,
        )
    }
    const major = isMajorChange(cur.version, nxt.version)
    if (major && !f.allowMajor) return new UpdateAppError('MAJOR_NOT_ALLOWED', `${cur.version} -> ${nxt.version} is a major update; pass --allow-major`)
    if (major && !majorAllowedByUpdatesFrom(cur.version, f.updatesFrom)) {
        return new UpdateAppError('MAJOR_NOT_ALLOWED', `version ${nxt.version} cannot update directly from major ${parseVersion(cur.version)?.[0]}; supported: ${(f.updatesFrom as unknown[]).join(', ') || 'none'}`)
    }
    if (major && f.backupMethod !== 'none' && (f.backupAgeMs === null || f.backupAgeMs > BACKUP_MAX_AGE_MS) && !f.backupPlanned)
        return new UpdateAppError('NEEDS_BACKUP', 'Dock a Backup Disk linked to this instance (updateApp then takes the backup itself), or make a backup first')
    if (f.shortDisks.length) return new UpdateAppError('NO_SPACE', `not enough free space on ${f.shortDisks.join(', ')}`)
    return null
}

/** True when the App may be offered an update at all (updateAvailable). */
export const offerable = (f: Pick<CheckFacts, 'currentAppId' | 'newAppId' | 'sumsValid' | 'updatesFrom' | 'xAppUpdate' | 'currentXApp' | 'newXApp'>): boolean => {
    if (!f.sumsValid) return false
    const cur = appIdentity(f.currentAppId, f.currentXApp), nxt = appIdentity(f.newAppId, f.newXApp)
    if (cur.name !== nxt.name) return false
    if (!isUpgrade(cur.version, nxt.version)) return false
    // engine#456: staged bundles are offered; Check validates their x-app.update before anything stops
    if (!unversionedMayTakeTarget(cur.version, nxt.version)) return false
    return !isMajorChange(cur.version, nxt.version) || majorAllowedByUpdatesFrom(cur.version, f.updatesFrom)
}

/** x-app.healthCheck {path, expect?} (idea#351 §4.3); null when absent or malformed. */
export const parseHealthCheck = (v: unknown): { path: string, expect?: string } | null => {
    if (!v || typeof v !== 'object') return null
    const p = (v as any).path, e = (v as any).expect
    if (typeof p !== 'string' || !p.startsWith('/')) return null
    return typeof e === 'string' && e.length ? { path: p, expect: e } : { path: p }
}

/** A probe answer passes on 2xx/3xx and, when `expect` is given, a body containing it. */
export const healthBodyOk = (r: { status: number, body: string } | null, expect?: string): boolean =>
    !!r && r.status >= 200 && r.status < 400 && (!expect || r.body.includes(expect))

/** Fallback gate (no x-app.healthCheck, idea#351 §4.3): any HTTP answer below 500 on the main URL means up (login redirects and 401 are fine). */
export const fallbackUp = (r: { status: number } | null): boolean => !!r && r.status < 500
/** Fallback gate timeout when the App declares no healthTimeout and has no agreed per-App default; pending Kid's measured timings (idea#351 §10.1). */
export const FALLBACK_HEALTH_TIMEOUT_S = 300
/** Timeout for the fallback gate: declared x-app.healthTimeout, else the agreed per-App default (#230), else 300 s. */
export const fallbackHealthTimeoutSeconds = (appName: string, declared?: unknown): number => {
    const n = Number(declared)
    if (declared !== undefined && declared !== null && Number.isFinite(n) && n > 0) return n
    return APP_HEALTH_TIMEOUT_S[String(appName ?? '').toLowerCase()] ?? FALLBACK_HEALTH_TIMEOUT_S
}

/** Rough snapshot copy rate until Kid's measured timings (idea#351 §10.1). */
export const SNAPSHOT_BYTES_PER_MIN = 1024 ** 3
/** estimatedMinutes = snapshot copy estimate + health timeout (same-Engine source: no transfer). */
export const estimateUpdateMinutes = (dataBytes: number, healthTimeoutS: number): number =>
    Math.max(1, Math.ceil(dataBytes / SNAPSHOT_BYTES_PER_MIN + healthTimeoutS / 60))

export type ContainerHealth = 'starting' | 'healthy' | 'unhealthy' | 'none' | 'exited' | 'restarting'
export interface HealthSample { state: ContainerHealth; restartCount: number; elapsedMs: number; bodyOk?: boolean }
export type GateVerdict = { verdict: 'wait' } | { verdict: 'pass' } | { verdict: 'fail'; why: string }

export const CRASH_LOOP_RESTARTS = 3

/** One poll of the health gate. `starting`/`unhealthy` are not ready yet, never a failure by themselves. */
export const healthGate = (s: HealthSample, timeoutS: number): GateVerdict => {
    if (s.state === 'exited') return { verdict: 'fail', why: 'the primary container exited' }
    if (s.restartCount >= CRASH_LOOP_RESTARTS || (s.state === 'restarting' && s.restartCount > 0 && s.restartCount >= CRASH_LOOP_RESTARTS))
        return { verdict: 'fail', why: `crash-loop (${s.restartCount} restarts)` }
    if ((s.state === 'healthy' || s.state === 'none') && s.bodyOk !== false) return { verdict: 'pass' }
    if (s.elapsedMs >= timeoutS * 1000) return { verdict: 'fail', why: `not healthy after ${timeoutS} s` }
    return { verdict: 'wait' }
}

export interface RollbackPlan { restoreBundle: boolean; restoreData: boolean; startOld: boolean }

/** What a rollback must do after `failedAt` failed. Data is ALWAYS restored once a snapshot exists. */
export const rollbackPlan = (failedAt: UpdateStep): RollbackPlan => {
    const idx = UPDATE_STEPS.indexOf(failedAt)
    const touched = idx >= UPDATE_STEPS.indexOf('Snapshot')
    return { restoreBundle: idx >= UPDATE_STEPS.indexOf('Swap'), restoreData: touched, startOld: touched }
}
