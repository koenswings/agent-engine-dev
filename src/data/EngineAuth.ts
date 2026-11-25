/**
 * EngineAuth.ts — Engine sign-in startup (engine#582).
 *
 * At startup, once the store is ready:
 *   1. the auth folder exists (0700) and has its secret;
 *   2. the store's userDB accounts are imported once (Operators.importOperatorsOnce),
 *      also after setup or the CLI created operators.json first (this Engine's
 *      accounts win). When the store maps have not arrived yet (fresh store waiting
 *      for peer sync), the import waits (syncEngineAuth runs again from the
 *      maps-arrived hook). A loaded store without userDB (made from
 *      store-template.json) has nothing to import: that is recorded and the import ends.
 *   3. with no operators, setup opens with a fresh setup code (SetupCode.ts).
 */

import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import { ensureAuthFolder } from './AuthFolder.js'
import { authSecret } from './AuthSecret.js'
import { authFolder, config } from './Config.js'
import { importOperatorsOnce, finishImportWithNothing, listOperators, readOperatorsFile } from './Operators.js'
import { closeSetup, openSetup, setupOpen } from './SetupCode.js'
import { log } from '../utils/utils.js'

/** The store's top-level maps are there (loaded from disk, made from the template, or synced). */
const storeLoaded = (store: Store): boolean => {
    const e = (store as any).engineDB
    return !!e && typeof e === 'object'
}

export interface EngineAuthState { operators: number, imported: string[], setupOpen: boolean, waitingForStore: boolean }

/** Run (or re-run) the startup steps. Safe to call more than once. */
export const syncEngineAuth = (
    storeHandle: DocHandle<Store> | null | undefined,
    opts: { dir?: string, tty?: boolean } = {},
): EngineAuthState => {
    const dir = ensureAuthFolder(opts.dir ?? authFolder())
    authSecret(dir)
    let imported: string[] = []
    let waitingForStore = false
    const done = readOperatorsFile(dir)?.importedFromStore
    if (!done || done.none) {
        const store = storeHandle?.doc() as Store | undefined
        const userDB = (store as any)?.userDB
        if (store && userDB && typeof userDB === 'object') {
            imported = importOperatorsOnce(store, dir).imported
        } else if (!done && store && storeLoaded(store)) {
            finishImportWithNothing(dir)
        } else if (!done) {
            waitingForStore = true
        }
    }
    const operators = listOperators(dir).length
    if (operators > 0 && setupOpen()) closeSetup()
    if (operators === 0 && !setupOpen()) {
        if (waitingForStore) log('[auth] store accounts not synced yet: setup opens now, an import follows when they arrive')
        openSetup({ dir, tty: opts.tty ?? !config.settings.testMode })
    }
    return { operators, imported, setupOpen: setupOpen(), waitingForStore }
}

/** Import still possible: never ran, or ran when the store had no userDB. */
export const storeImportPending = (dir: string = authFolder()): boolean => {
    const done = readOperatorsFile(dir)?.importedFromStore
    return !done || !!done.none
}

/**
 * Run syncEngineAuth when the store's userDB arrives or changes by peer sync, while
 * the import is still pending (engine#582). Returns a function that stops watching.
 */
export const watchStoreAccounts = (storeHandle: DocHandle<Store>, opts: { dir?: string } = {}): (() => void) => {
    const dir = opts.dir ?? authFolder()
    const onChange = ({ patches }: { patches: { path: (string | number)[] }[] }): void => {
        if (!patches.some(p => p.path[0] === 'userDB')) return
        if (!storeImportPending(dir)) { stop(); return }
        try { syncEngineAuth(storeHandle, { dir }) } catch (e) { log(`[auth] account import after a store change failed: ${e}`) }
        if (!storeImportPending(dir)) stop()
    }
    const stop = (): void => { storeHandle.off('change', onChange as any) }
    if (storeImportPending(dir)) storeHandle.on('change', onChange as any)
    return stop
}
