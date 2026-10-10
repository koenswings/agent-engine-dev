/**
 * r60 FAIL@59: after a pm2 restart the store keeps this engine's PRE-restart instance state until the
 * Engine re-processes each disk (~26 s on idea03). The harness read that stale "Running" and probed
 * 1.5 s before the Engine got to the Nextcloud disk. For a restarted Pi we now wait, bounded, until
 *   (2) every disk docked on that Pi has lastDocked > the restart time (Pi clock), and
 *   (3) every Running instance on those disks has all its compose containers Up in `docker ps`.
 * Error on any of those instances fails at once; the timeout fails with a field dump. Nothing is retried.
 */
import type { SemanticStoreView } from './types.js'

export const DEFAULT_RESTART_RECONCILE_MS = 180_000

export const restartReconcileBudgetMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const v = Number(env.DURATION_RESTART_RECONCILE_MS)
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_RESTART_RECONCILE_MS
}

/** One `docker ps -a` row: compose project (= instance id), container name, State. */
export interface DockerRow { project: string; name: string; state: string }

/** `docker ps -a --format '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.State}}'` (read-only). */
export const DOCKER_PS_CMD = `docker ps -a --format '{{.Label "com.docker.compose.project"}}\\t{{.Names}}\\t{{.State}}'`

export const parseDockerPs = (out: string): DockerRow[] =>
    out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [project = '', name = '', state = ''] = l.split('\t')
        return { project: project.trim(), name: name.trim(), state: state.trim().toLowerCase() }
    })

export interface ReconcileEval {
    done: boolean
    /** Fatal (instance in Error): fail at once. */
    error: string | null
    pending: string[]
    /** Every disk/instance on the Pi with what was seen — the dump on timeout. */
    fields: string[]
}

export const evaluateRestartReconcile = (
    view: SemanticStoreView, engineId: string, restartAtMs: number, docker: DockerRow[],
): ReconcileEval => {
    const pending: string[] = [], fields: string[] = []
    let error: string | null = null
    const disks = Object.values(view.diskDB).filter(d => d.dockedTo === engineId)
    const diskIds = new Set(disks.map(d => d.id))
    for (const d of disks) {
        const ok = (d.lastDocked ?? 0) > restartAtMs
        fields.push(`disk ${d.id} lastDocked=${d.lastDocked ?? 'absent'} restartAt=${restartAtMs}${ok ? '' : ' (not reconciled)'}`)
        if (!ok) pending.push(`disk ${d.id} not re-processed since restart`)
    }
    for (const i of Object.values(view.instanceDB)) {
        if (!i.diskId || !diskIds.has(i.diskId)) continue
        const rows = docker.filter(r => r.project === i.id)
        const up = rows.filter(r => r.state === 'running')
        fields.push(`instance ${i.id} status=${i.status} disk=${i.diskId} port=${i.port ?? 'none'} containers=[${rows.map(r => `${r.name}:${r.state}`).join(', ') || 'none'}]`)
        if (i.status === 'Error') { error ??= `${i.id} is Error on ${engineId}`; continue }
        if (i.status === 'Running') {
            if (!rows.length) pending.push(`${i.id} Running but no containers`)
            else if (up.length !== rows.length) pending.push(`${i.id} Running but containers not all Up (${rows.filter(r => r.state !== 'running').map(r => `${r.name}:${r.state}`).join(', ')})`)
        } else if (i.status === 'Starting' || i.status === 'Undocked') {
            pending.push(`${i.id} ${i.status}`)
        }
    }
    return { done: !error && pending.length === 0, error, pending, fields }
}

export interface RestartReconcileIo {
    readStore: () => Promise<SemanticStoreView>
    dockerPs: () => Promise<string>
    sleep: (ms: number) => Promise<void>
    now: () => number
}

/** Poll until the restarted Pi is reconciled. Returns a one-line note; throws on Error or timeout (with dump). */
export const waitRestartReconciled = async (
    engineId: string, restartAtMs: number, io: RestartReconcileIo, budgetMs = restartReconcileBudgetMs(), pollMs = 2000,
): Promise<string> => {
    const start = io.now()
    let last: ReconcileEval | null = null, lastErr = ''
    for (;;) {
        try {
            last = evaluateRestartReconcile(await io.readStore(), engineId, restartAtMs, parseDockerPs(await io.dockerPs()))
            lastErr = ''
            if (last.error) {
                throw Object.assign(new Error(`restart reconcile on ${engineId}: ${last.error} | ${last.fields.join('; ')}`), { fatal: true })
            }
            if (last.done) return `restart reconciled on ${engineId} after ${io.now() - start}ms (${last.fields.length} fields)`
        } catch (e) {
            if ((e as { fatal?: boolean }).fatal) throw e
            lastErr = e instanceof Error ? e.message : String(e)
        }
        if (io.now() - start >= budgetMs) {
            throw new Error(
                `restart reconcile on ${engineId}: not done within ${budgetMs}ms (DURATION_RESTART_RECONCILE_MS) — ` +
                `pending: ${last?.pending.join('; ') ?? 'unread'}${lastErr ? ` | last error: ${lastErr}` : ''} | ` +
                `${last?.fields.join('; ') ?? ''}`,
            )
        }
        await io.sleep(pollMs)
    }
}
