/**
 * Shared clock-trusted flag for idea#396 (preUpdateGate / 24 h quarantine).
 * The backup scheduler binds the real evaluator at start; callers never import
 * backupScheduler, so there is no module cycle with UpdateApp.
 */
let readTrusted: () => boolean = () => false

export const bindEngineClockTrusted = (fn: () => boolean): void => { readTrusted = fn }

export const engineClockTrusted = (): boolean => {
    try { return !!readTrusted() } catch { return false }
}

/** Test seam. */
export const resetEngineClockTrustedForTests = (): void => { readTrusted = () => false }
