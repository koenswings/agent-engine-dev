/**
 * AppHealthTimeout.ts — the one per-App health/ready timeout table (idea#437).
 *
 * Shared by updateApp's Health step (UpdateAppPolicy.ts) and the start-time
 * port-ready check (Instance.ts runInstance → assertInstancePortReady), so the
 * two can never drift apart (Steve, idea#437 decision 3:
 * https://github.com/koenswings/idea/issues/437#issuecomment-6848057574).
 *
 * A valid `x-app.healthTimeout` (seconds, > 0) in the instance compose wins;
 * otherwise the per-App default: Kolibri 900 s, Nextcloud 300 s, others 600 s.
 * Pure: no I/O, no imports.
 */

/** Default for any App not in APP_HEALTH_TIMEOUT_S (seconds). */
export const DEFAULT_HEALTH_TIMEOUT_S = 600

/** Per-App defaults (seconds), keyed by lower-case App name. */
export const APP_HEALTH_TIMEOUT_S: Readonly<Record<string, number>> = Object.freeze({ kolibri: 900, nextcloud: 300 })

/** x-app.healthTimeout (seconds) wins when valid; else the per-App default. */
export const healthTimeoutSeconds = (appName: string, declared?: unknown): number => {
    const n = Number(declared)
    if (declared !== undefined && declared !== null && Number.isFinite(n) && n > 0) return n
    return APP_HEALTH_TIMEOUT_S[String(appName ?? '').toLowerCase()] ?? DEFAULT_HEALTH_TIMEOUT_S
}
