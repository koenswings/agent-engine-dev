/**
 * updateApp test hook (engine#449): force a pre-swap failure and a failed
 * restart of the old version, so duration e2e can reach restartFailed.
 *
 * Honoured only when config.settings.testMode is true (IDEA_TEST_MODE=true,
 * or testMode in config). Read per call, not at import. Never set by an
 * install script, image or pm2 ecosystem file.
 */
import { config } from './Config.js'

export const TEST_FAIL_UPDATE_RESTART_ENV = 'IDEA_TEST_FAIL_UPDATE_RESTART'
/** Thrown from the post-failure restart when the hook is armed. */
export const TEST_FAIL_UPDATE_RESTART_MESSAGE = 'test hook: forced restart failure'
/** Thrown after the Snapshot stop so the update fails pre-swap. */
export const TEST_FAIL_UPDATE_FAILURE_MESSAGE = 'test hook: forced update failure'

/** The armed instance id, or null when unset or testMode is off. */
export const testFailUpdateRestartId = (
    env: NodeJS.ProcessEnv = process.env,
    testMode: boolean = config.settings.testMode,
): string | null => {
    const raw = env[TEST_FAIL_UPDATE_RESTART_ENV]
    if (raw === undefined || raw.trim() === '') return null
    if (!testMode) return null
    return raw.trim()
}

export const shouldFailUpdateRestart = (
    instanceId: string,
    env: NodeJS.ProcessEnv = process.env,
    testMode: boolean = config.settings.testMode,
): boolean => testFailUpdateRestartId(env, testMode) === instanceId

/**
 * When the env var is set and testMode is off, the hook is ignored. Call once
 * at Engine boot.
 */
export const warnIfTestFailUpdateRestartIgnored = (
    logLine: (msg: string) => void,
    env: NodeJS.ProcessEnv = process.env,
    testMode: boolean = config.settings.testMode,
): void => {
    const raw = env[TEST_FAIL_UPDATE_RESTART_ENV]
    if (raw === undefined || raw.trim() === '') return
    if (testMode) return
    logLine(`${TEST_FAIL_UPDATE_RESTART_ENV} is set but testMode is off; the hook is ignored`)
}
