/**
 * Start / readiness budgets for the duration walk (idea#168 Stage 1).
 *
 * With skipImageLoad: false the Engine loads each service image from the App Disk's
 * services/<image>.tar before `docker compose up` (Kolibri tar 1.62 GB; Nextcloud 2.02 GB
 * + MariaDB 0.49 GB). On a Pi that adds roughly 1–3 min to every instance start (dock,
 * install, copy, restore). The old budgets assumed cached images. Every budget here is
 * an upper bound (a healthy start returns as soon as it is up) and can be set by env;
 * the measured durations are logged as `instance_start_measured` events so the budgets
 * can be tuned from real runs.
 */

/** Parse a non-negative integer ms env value; below `min` it is raised to `min`. */
export const envMs = (env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1_000): number => {
    const raw = env[key]?.trim()
    if (raw && /^\d+$/.test(raw)) return Math.max(min, Number(raw))
    return fallback
}

/** Live: an instance (auto-)start incl. tar image load until store Running. Was fast 120 s / 300 s. */
export const DEFAULT_INSTANCE_START_MS = { fast: 300_000, normal: 600_000 } as const
/** Nextcloud login form after a dock (image load + first boot + MariaDB). Was 180 s. */
export const DEFAULT_NEXTCLOUD_READY_MS = 420_000
/** copyApp Operation end (rsync + target start incl. image load). Was fast 120 s / 600 s. */
export const DEFAULT_COPY_DONE_MS = { fast: 300_000, normal: 900_000 } as const
/** RealFleetOps: disk docked in the store after a (re)dock or moveDisk. Was 120 s. */
export const DEFAULT_DOCK_WAIT_MS = 300_000

export const instanceStartBudgetMs = (o: { fast: boolean; live: boolean }, env: NodeJS.ProcessEnv = process.env): number =>
    o.live
        ? envMs(env, 'DURATION_INSTANCE_START_MS', o.fast ? DEFAULT_INSTANCE_START_MS.fast : DEFAULT_INSTANCE_START_MS.normal)
        : (o.fast ? 800 : 3_000) // Fake: synthetic instances are Running at once

export const copyDoneBudgetMs = (fast: boolean, env: NodeJS.ProcessEnv = process.env): number =>
    envMs(env, 'DURATION_COPY_DONE_MS', fast ? DEFAULT_COPY_DONE_MS.fast : DEFAULT_COPY_DONE_MS.normal, 0)

export const dockWaitMs = (env: NodeJS.ProcessEnv = process.env): number =>
    envMs(env, 'DURATION_DOCK_WAIT_MS', DEFAULT_DOCK_WAIT_MS, 10_000)

export type StartMeasured = {
    /** What started: post_install_start | nextcloud_ready | copy_op | restore_op | dock */
    what: string
    engine?: string | null
    instanceId?: string | null
    diskId?: string | null
    /** Measured duration (ms). */
    ms: number
    /** Budget it was measured against (ms). */
    budgetMs?: number
    /** Engine Operation duration (completedAt - startedAt) when known. */
    opMs?: number | null
}

/** One JSON line per measured start (`event: instance_start_measured`). */
export const logStartMeasured = (m: StartMeasured, sink: (line: string) => void = l => console.log(l)): void => {
    sink(JSON.stringify({ event: 'instance_start_measured', ts: new Date().toISOString(), ...m }))
}
