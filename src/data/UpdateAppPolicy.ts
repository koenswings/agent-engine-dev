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
 *  - healthTimeout per App: kolibri 900 s, nextcloud 300 s, default 600 s.
 *  - An App without valid SHA256SUMS is never offered an update (NO_SUMS).
 */
import { parseAppId } from './App.js'

export type UpdateStep = 'Fetch' | 'Check' | 'Snapshot' | 'Swap' | 'Start' | 'Health'
export const UPDATE_STEPS: readonly UpdateStep[] = ['Fetch', 'Check', 'Snapshot', 'Swap', 'Start', 'Health']

export type UpdateRefusal =
    | 'NOT_DOCKED' | 'BUSY' | 'SOURCE_MISSING' | 'DIFFERENT_APP' | 'NOT_NEWER'
    | 'MAJOR_NOT_ALLOWED' | 'NEEDS_BACKUP' | 'NO_SPACE' | 'NO_SUMS'
    | 'NOT_FOUND' | 'AMBIGUOUS' | 'HELPER_OUTDATED' | 'TRANSFER_FAILED'

/** Error text starts with the code; the two rollback outcomes use the console#168 wording. */
export const ROLLED_BACK_PREFIX = 'ROLLED BACK:'
export const ROLLBACK_FAILED_PREFIX = 'ROLLBACK FAILED:'

export class UpdateAppError extends Error {
    constructor(public code: UpdateRefusal | 'ROLLED_BACK' | 'ROLLBACK_FAILED', text: string) {
        super(code === 'ROLLED_BACK' ? `${ROLLED_BACK_PREFIX} ${text}` : code === 'ROLLBACK_FAILED' ? `${ROLLBACK_FAILED_PREFIX} ${text}` : `${code}: ${text}`)
    }
}

/** Numeric version parts from "1.2.3", "v1.2", or tool output like "kolibri, version 0.19.5"; null if none. */
export const parseVersion = (raw: string | null | undefined): number[] | null => {
    const m = String(raw ?? '').match(/(\d+(?:\.\d+)*)/)
    return m ? m[1].split('.').map(n => Number(n)) : null
}

/** <0, 0, >0 like a comparator; null when either side can't be read. */
export const compareVersions = (a: string, b: string): number | null => {
    const x = parseVersion(a), y = parseVersion(b)
    if (!x || !y) return null
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0)
        if (d !== 0) return d
    }
    return 0
}

const DEFAULT_HEALTH_TIMEOUT_S = 600
const HEALTH_TIMEOUT_S: Record<string, number> = { kolibri: 900, nextcloud: 300 }

/** x-app.healthTimeout (seconds) wins when valid; else the per-App default. */
export const healthTimeoutSeconds = (appName: string, declared?: unknown): number => {
    const n = Number(declared)
    if (declared !== undefined && declared !== null && Number.isFinite(n) && n > 0) return n
    return HEALTH_TIMEOUT_S[appName.toLowerCase()] ?? DEFAULT_HEALTH_TIMEOUT_S
}

export interface CheckFacts {
    diskDocked: boolean
    busy: boolean
    currentAppId: string
    newAppId: string
    sourcePresent: boolean
    sumsValid: boolean
    allowMajor: boolean
    /** ms since the last Borg backup; null if never */
    backupAgeMs: number | null
    /** disks that lack space (name), empty when all fit */
    shortDisks: string[]
}

export const BACKUP_MAX_AGE_MS = 60 * 60 * 1000

/** First refusal in the agreed order, or null when the update may go ahead. */
export const checkUpdate = (f: CheckFacts): UpdateAppError | null => {
    if (!f.diskDocked) return new UpdateAppError('NOT_DOCKED', 'the App Disk is not docked to this Engine')
    if (f.busy) return new UpdateAppError('BUSY', 'another operation is running on this instance')
    if (!f.sourcePresent) return new UpdateAppError('SOURCE_MISSING', `bundle ${f.newAppId} was not found on the source`)
    if (!f.sumsValid) return new UpdateAppError('NO_SUMS', `bundle ${f.newAppId} has no valid SHA256SUMS`)
    const cur = parseAppId(f.currentAppId), nxt = parseAppId(f.newAppId)
    if (cur.name !== nxt.name) return new UpdateAppError('DIFFERENT_APP', `${f.newAppId} is not a version of ${cur.name}`)
    const cmp = compareVersions(nxt.version, cur.version)
    if (cmp === null || cmp <= 0) return new UpdateAppError('NOT_NEWER', `${nxt.version} is not newer than ${cur.version}`)
    const major = (parseVersion(nxt.version)![0] ?? 0) !== (parseVersion(cur.version)![0] ?? 0)
    if (major && !f.allowMajor) return new UpdateAppError('MAJOR_NOT_ALLOWED', `${cur.version} -> ${nxt.version} is a major update; pass --allow-major`)
    if (major && (f.backupAgeMs === null || f.backupAgeMs > BACKUP_MAX_AGE_MS)) return new UpdateAppError('NEEDS_BACKUP', 'Dock a Backup Disk and make a backup first')
    if (f.shortDisks.length) return new UpdateAppError('NO_SPACE', `not enough free space on ${f.shortDisks.join(', ')}`)
    return null
}

/** True when the App may be offered an update at all (updateAvailable). */
export const offerable = (f: Pick<CheckFacts, 'currentAppId' | 'newAppId' | 'sumsValid'>): boolean => {
    if (!f.sumsValid) return false
    const cur = parseAppId(f.currentAppId), nxt = parseAppId(f.newAppId)
    if (cur.name !== nxt.name) return false
    const cmp = compareVersions(nxt.version, cur.version)
    return cmp !== null && cmp > 0
}

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
