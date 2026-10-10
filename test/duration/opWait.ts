/**
 * r63 FAIL@43 (copy_app): the Console Intent's post-Confirm settle (~120 s) tried to Start/unlock the
 * source while the Engine copyApp still held its ResourceLock ("Operation in progress"); the copy itself
 * (≈498 MB service-image rsync) finished fine minutes later. The harness now hands the Intent a
 * `waitOperation` hook: after Confirm the Intent waits until the Operation (copyApp / moveApp /
 * restoreApp) for that instance is terminal in the store, THEN does its single post-op Start/settle.
 * Done → ok; Failed/Cancelled → fail at once with a dump; budget → fail with a dump. Read-only.
 */
import { copyDoneBudgetMs, envMs } from './startBudgets.js'

export type WaitOpKind = 'copyApp' | 'moveApp' | 'restoreApp' | 'backupApp'
export interface WaitOpQuery { kind: WaitOpKind; instanceId?: string; sinceMs: number }
export interface WaitOpResult {
    /** Done: terminal OK. Error: Failed/Cancelled. Timeout: not terminal in budget. NotSeen: no Operation appeared. */
    status: 'Done' | 'Error' | 'Timeout' | 'NotSeen'
    detail: string
    opId?: string
    elapsedMs: number
}
export type WaitOperationFn = (q: WaitOpQuery) => Promise<WaitOpResult>

export interface OpRow {
    id: string; kind: string; status: string; startedAt: number | null; completedAt?: number | null
    error?: string | null; args?: Record<string, string>
}
export interface OpWaitIo {
    listOperations: (engine: string) => Promise<OpRow[]>
    engines: string[]
    sleep: (ms: number) => Promise<void>
    now: () => number
    log?: (line: string) => void
    /** r66 stale-view guard: force a reconnect + re-read of this engine's store view (counted by the caller). */
    refresh?: (engine: string, reason: string) => Promise<boolean | null>
}

/** Budget per kind: copy/move DURATION_COPY_DONE_MS (fast 300 s / 900 s), restore DURATION_RESTORE_DONE_MS (default = copy). */
export const opDoneBudgetMs = (kind: WaitOpKind, fast: boolean, env: NodeJS.ProcessEnv = process.env): number => {
    const copy = copyDoneBudgetMs(fast, env)
    if (kind === 'restoreApp') return envMs(env, 'DURATION_RESTORE_DONE_MS', copy, 0)
    if (kind === 'backupApp') return envMs(env, 'DURATION_BACKUP_DONE_MS', copy, 0)
    return copy
}
/** r66: how long an Operation may take to appear after Confirm (DURATION_OP_APPEAR_MS; default and floor 60 s). */
export const MIN_OP_APPEAR_MS = 60_000
/** Explicit env values below 60 s are honoured (unit tests) but logged loudly. */
export const opAppearBudgetMs = (env: NodeJS.ProcessEnv = process.env): number => opStartBudget(env, 'DURATION_OP_APPEAR_MS')
export const opStartBudget = (env: NodeJS.ProcessEnv, key: string): number => {
    const raw = env[key]?.trim()
    if (!raw || !/^\d+$/.test(raw)) return MIN_OP_APPEAR_MS
    const v = Number(raw)
    if (v < MIN_OP_APPEAR_MS) console.warn(`[duration] ${key}=${v}ms is below the ${MIN_OP_APPEAR_MS}ms op-start minimum (r65 FAIL@43)`)
    return v
}

const fmt = (r: OpRow & { engine: string }, now: number) =>
    `${r.engine}:${r.kind}#${r.id} status=${r.status} instance=${r.args?.instanceId ?? '?'} ` +
    `started=${r.startedAt ?? '?'} (${r.startedAt ? now - r.startedAt : '?'}ms ago) completed=${r.completedAt ?? '-'} error=${r.error ?? '-'}`

export const waitOperationTerminal = async (
    q: WaitOpQuery, io: OpWaitIo, budgetMs: number, appearMs: number, pollMs = 2_000, slackMs = 5_000,
): Promise<WaitOpResult> => {
    const t0 = io.now()
    let rows: (OpRow & { engine: string })[] = []
    let errs: string[] = []
    let lastStatus = ''
    let refreshed = false
    for (;;) {
        rows = []; errs = []
        for (const e of io.engines) {
            try {
                for (const r of await io.listOperations(e)) {
                    if (r.kind !== q.kind) continue
                    if ((r.startedAt ?? 0) < q.sinceMs - slackMs) continue
                    if (q.instanceId && r.args?.instanceId && r.args.instanceId !== q.instanceId) continue
                    rows.push({ ...r, engine: e })
                }
            } catch (err) { errs.push(`${e}: ${err instanceof Error ? err.message : String(err)}`) }
        }
        // Dedupe the same op seen through several peers' store copies; newest first.
        const byId = new Map<string, OpRow & { engine: string }>()
        for (const r of rows) {
            const prev = byId.get(r.id)
            const rank = (s: string) => (s === 'Done' || s === 'Failed' || s === 'Cancelled' ? 2 : 1)
            if (!prev || rank(r.status) > rank(prev.status)) byId.set(r.id, r)
        }
        const ops = [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        const now = io.now(), elapsedMs = now - t0
        const op = ops[0]
        const dump = () => `ops=[${ops.map(r => fmt(r, now)).join('; ') || 'none'}]${errs.length ? ` readErrors=[${errs.join('; ')}]` : ''}`
        if (op) {
            if (op.status !== lastStatus) {
                io.log?.(JSON.stringify({ event: 'op_wait', kind: q.kind, instanceId: q.instanceId, opId: op.id, engine: op.engine, status: op.status, elapsed_ms: elapsedMs }))
                lastStatus = op.status
            }
            if (op.status === 'Done') return { status: 'Done', detail: fmt(op, now), opId: op.id, elapsedMs }
            if (op.status === 'Failed' || op.status === 'Cancelled') {
                return { status: 'Error', detail: `${q.kind} ${op.status}: ${op.error ?? 'no error text'} | ${dump()}`, opId: op.id, elapsedMs }
            }
        } else if (elapsedMs >= appearMs && io.refresh && !refreshed) {
            // r66: before declaring NotSeen, distrust the cached view once: reconnect every engine and re-read.
            refreshed = true
            for (const e of io.engines) await io.refresh(e, `${q.kind} wait saw no Operation for ${q.instanceId ?? 'any'} after ${elapsedMs}ms`)
            continue
        } else if (elapsedMs >= appearMs) {
            return { status: 'NotSeen', detail: `no ${q.kind} Operation for ${q.instanceId ?? 'any instance'} since ${q.sinceMs} within ${appearMs}ms | ${dump()}`, elapsedMs }
        }
        if (elapsedMs >= budgetMs) {
            return { status: 'Timeout', detail: `${q.kind} not terminal within ${budgetMs}ms | ${dump()}`, opId: op?.id, elapsedMs }
        }
        await io.sleep(pollMs)
    }
}

/** Actions whose Console Intent gets a waitOperation hook (post-op Start only after the Operation ends). */
export const WAIT_OP_ACTIONS: Record<string, WaitOpKind> = {
    copy_app: 'copyApp',
    move_app: 'moveApp',
    restore_from_backup: 'restoreApp',
}
