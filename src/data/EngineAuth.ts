/**
 * EngineAuth.ts — Engine sign-in startup (engine#582).
 *
 * At startup, once the store is ready:
 *   1. the auth folder exists (0700) and has its secret;
 *   2. operators.json is created on the first start of this build, importing the
 *      store's userDB accounts once (Operators.importOperatorsOnce). When the store
 *      maps have not arrived yet (fresh store waiting for peer sync), the import
 *      waits for them (call syncEngineAuth again from the maps-arrived hook);
 *   3. with no operators, setup opens with a fresh setup code (SetupCode.ts).
 */

import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import { ensureAuthFolder } from './AuthFolder.js'
import { authSecret } from './AuthSecret.js'
import { authFolder, config } from './Config.js'
import { importOperatorsOnce, listOperators, readOperatorsFile } from './Operators.js'
import { closeSetup, openSetup, setupOpen } from './SetupCode.js'
import { log } from '../utils/utils.js'

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
    if (!readOperatorsFile(dir)) {
        const store = storeHandle?.doc() as Store | undefined
        if (store && (store as any).userDB && typeof (store as any).userDB === 'object') {
            imported = importOperatorsOnce(store, dir).imported
        } else {
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
