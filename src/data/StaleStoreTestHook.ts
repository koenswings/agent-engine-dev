/**
 * StaleStoreTestHook.ts (engine#512): a one-shot switch for the Pi proof that the
 * stale-store exit really ends in a pm2 restart.
 *
 * Since StoreScopedClientAdapter.send no longer throws, a store doc can no longer be
 * poisoned on purpose from outside. This hook marks the running Engine's store doc
 * outdated the same way Automerge does (it sets `heads` on the doc's internal state,
 * which is all "outdated" is), then makes the store write the 11-17 crash died on
 * (writeLastSeen). StaleDocGuard must then log [stale-store] FATAL and exit with 75.
 *
 * Armed only when BOTH are true (never set by an install script, image or pm2 file):
 *   - env IDEA_TEST_STALE_STORE_ONCE=<marker file path>, and
 *   - that marker file exists.
 * It fires once: the marker is renamed to `<marker>.fired` before anything else, so the
 * Engine pm2 restarts afterwards starts normally even with the env still set.
 * IDEA_TEST_STALE_STORE_DELAY_MS (default 20000) = how long after startup it fires.
 */
import { DocHandle } from '@automerge/automerge-repo'
import fs from 'fs'
import { error, log } from '../utils/utils.js'

export const TEST_STALE_STORE_ENV = 'IDEA_TEST_STALE_STORE_ONCE'
export const TEST_STALE_STORE_DELAY_ENV = 'IDEA_TEST_STALE_STORE_DELAY_MS'

const AM_STATE = Symbol.for('_am_meta')

/** Mark the handle's current doc outdated (what A.receiveSyncMessage does to the doc it supersedes). */
export const markDocOutdatedForTest = (handle: DocHandle<any>): void => {
    const state: any = Reflect.get(handle.doc() as object, AM_STATE)
    if (!state?.handle) throw new Error('not an Automerge doc')
    state.heads = state.handle.getHeads()
}

/** Returns the armed marker path, or null. Fires once (see the header). */
export const armStaleStoreTestHook = (
    handle: DocHandle<any>,
    storeWrite: () => void,
    env: NodeJS.ProcessEnv = process.env,
): string | null => {
    const marker = env[TEST_STALE_STORE_ENV]?.trim()
    if (!marker) return null
    if (!fs.existsSync(marker)) { log(`${TEST_STALE_STORE_ENV} is set but ${marker} does not exist; the stale-store test hook is not armed`); return null }
    const n = Number(env[TEST_STALE_STORE_DELAY_ENV])
    const delayMs = Number.isFinite(n) && n >= 0 ? n : 20_000
    error(`[stale-store] TEST HOOK armed (${TEST_STALE_STORE_ENV}=${marker}): the store doc is marked outdated in ${delayMs} ms (engine#512 Pi proof)`)
    setTimeout(() => {
        try { fs.renameSync(marker, `${marker}.fired`) } catch (e) { error(`[stale-store] TEST HOOK: could not consume ${marker} (${e}); not firing`); return }
        error(`[stale-store] TEST HOOK firing: marking the store doc outdated, then writing lastRun`)
        try { markDocOutdatedForTest(handle); storeWrite() } catch (e) { log(`[stale-store] TEST HOOK: the store write threw as expected: ${e instanceof Error ? e.message : String(e)}`) }
    }, delayMs)
    return marker
}
