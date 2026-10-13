/**
 * r59 (r58 FAIL@58): after a step that docks / redocks / moves / copies / reboots / restores, every
 * instance on a docked disk must have left Undocked (and Starting) and — when it runs — have a port in the
 * store BEFORE the harness pins App URLs or uses Apps. r58: the NC disk carried 3 instances (Kolibri copy,
 * Kiwix, Nextcloud); the Engine starts them one after another, and the resync read nextcloud-grade5a-001
 * while it was still Undocked → "no port in the store".
 *
 * Bounded (DURATION_INSTANCE_SETTLE_MS, default 300 s). Never hides a real start failure: Error fails at
 * once, and a timeout (stuck Starting / Undocked / no port) fails — both with a field dump. Read-only:
 * the store is only read; no user action is retried.
 */
import type { SemanticStoreView } from './types.js'

export const DEFAULT_INSTANCE_SETTLE_MS = 300_000

export const instanceSettleBudgetMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env.DURATION_INSTANCE_SETTLE_MS?.trim()
    return raw && /^\d+$/.test(raw) ? Math.max(1_000, Number(raw)) : DEFAULT_INSTANCE_SETTLE_MS
}

export interface InstanceRow { engine: string; id: string; name?: string; status: string; port?: number; diskId: string | null }
export type SettleVerdict =
    | { kind: 'settled'; rows: InstanceRow[] }
    | { kind: 'waiting'; rows: InstanceRow[]; pending: InstanceRow[] }
    | { kind: 'error'; rows: InstanceRow[]; failed: InstanceRow[] }

/**
 * Settled per instance (on a disk docked on the engine whose view is read — that engine is authoritative
 * for its own disks):
 *   Running / Pauzed → needs a port;  Stopped / Docked → settled (an operator-stopped or never-started
 *   instance has no live port);  Undocked / Starting / '' → still waiting;  Error → fail now;
 *   Missing → ignored (directory moved away, e.g. move_app source).
 */
export const evaluateInstances = (views: Record<string, SemanticStoreView>, diskFilter?: string[]): SettleVerdict => {
    const rows: InstanceRow[] = []
    for (const [engine, view] of Object.entries(views)) {
        const dockedHere = new Set(
            Object.values(view.diskDB ?? {}).filter(d => d && d.dockedTo === engine).map(d => d.id),
        )
        for (const inst of Object.values(view.instanceDB ?? {})) {
            if (!inst?.diskId || !dockedHere.has(inst.diskId)) continue
            if (diskFilter && !diskFilter.includes(inst.diskId)) continue
            rows.push({ engine, id: inst.id, name: inst.name, status: String(inst.status ?? ''), port: inst.port, diskId: inst.diskId })
        }
    }
    const failed = rows.filter(r => r.status === 'Error')
    if (failed.length) return { kind: 'error', rows, failed }
    const pending = rows.filter(r => {
        if (r.status === 'Missing' || r.status === 'Stopped' || r.status === 'Docked') return false
        if (r.status === 'Running' || r.status === 'Pauzed') return !r.port
        return true // Undocked, Starting, '' or unknown
    })
    return pending.length ? { kind: 'waiting', rows, pending } : { kind: 'settled', rows }
}

export const dumpRows = (rows: InstanceRow[]): string =>
    rows.length
        ? rows.map(r => `${r.id}${r.name ? `(${r.name})` : ''} status=${r.status || "''"} port=${r.port ?? '-'} disk=${r.diskId} on ${r.engine}`).join('; ')
        : 'no instances on docked disks'

export interface SettleDeps {
    engines: string[]
    readStore: (engine: string) => Promise<SemanticStoreView>
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    pollMs?: number
}

/** Wait until evaluateInstances is settled; throw on Error (at once) or timeout, with the dump. */
export const waitInstancesSettled = async (
    label: string,
    deps: SettleDeps,
    budgetMs = instanceSettleBudgetMs(),
    diskFilter?: string[],
): Promise<string> => {
    const now = deps.now ?? Date.now
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    const poll = deps.pollMs ?? 3_000
    const t0 = now()
    let last: SettleVerdict | null = null
    let lastErr = ''
    for (;;) {
        const views: Record<string, SemanticStoreView> = {}
        lastErr = ''
        for (const e of deps.engines) {
            try {
                views[e] = await deps.readStore(e)
            } catch (err) {
                lastErr = `${e}: ${err instanceof Error ? err.message : String(err)}`
            }
        }
        last = evaluateInstances(views, diskFilter)
        if (last.kind === 'error') {
            throw new Error(
                `${label}: instance start FAILED (status Error) — ${dumpRows(last.failed)}. All instances: ${dumpRows(last.rows)}. No soft-pass, no retry`,
            )
        }
        if (last.kind === 'settled' && !lastErr) {
            const ms = now() - t0
            return `instances settled after ${ms}ms (${last.rows.length}: ${dumpRows(last.rows)})`
        }
        if (now() - t0 >= budgetMs) {
            const pend = last.kind === 'waiting' ? dumpRows(last.pending) : `store unreadable (${lastErr})`
            throw new Error(
                `${label}: instances did not settle within ${budgetMs}ms (DURATION_INSTANCE_SETTLE_MS) — pending: ${pend}. ` +
                    `All instances: ${dumpRows(last.rows)}. A stuck Starting/Undocked/no-port instance is a real start failure. No soft-pass`,
            )
        }
        await sleep(poll)
    }
}

/**
 * Steps after which the harness waits (Stage 2). Audit (r59): dock / redock / move / copy / reboot /
 * restore / start / role-change steps of cover-all (step numbers in parentheses).
 */
export const SETTLE_AFTER_ACTIONS: ReadonlySet<string> = new Set([
    'infra_dock_fixture', // 58, 61
    'infra_reboot_engine', // 59
    'infra_move_disk', // 62
    'copy_app', // 43, 116
    'move_app', // 102
    'restore_from_backup', // 100
    'reboot_engine', // 128
    'start_after_install', // 115
    'start_instance', // 109
    'backup_instance', // 98, 112 (may co-locate the app disk with its Backup Disk)
    'make_backup_disk', // 95
    'make_files_disk', // 91
    'add_files_role', // 93 (add-files disk re-docked on the Console engine)
    'cancel_eject', // 107
    'notice_usb_dock', // 55
    'confirm_erase', // 105 (shared empty re-docked fresh)
])
