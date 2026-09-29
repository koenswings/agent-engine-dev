/**
 * ownStore.ts — is this checkout a Pi that deliberately keeps its own store? (idea#155)
 *
 * Every Engine normally opens the shared fleet store, whose URL is the tracked
 * store-identity/store-url.txt (idea#120). A Pi kept off the fleet store (idea04,
 * and idea03 for review deploys) has its own URL written into the store-url.txt
 * of its configured store identity folder (config.settings.storeIdentityFolder).
 * That local file is the setting that gives it its own store, so it is what this
 * check reads.
 *
 * ownStoreSkipReason() returns a skip reason only when ALL of these hold:
 *   - the configured store-url.txt is tracked by git and git can read its HEAD version;
 *   - the committed version is exactly FLEET_STORE_URL (so the fleet URL check
 *     would pass on a clean checkout: there is no real mismatch to hide);
 *   - the local file holds a well-formed automerge URL that differs from it.
 * Anything else (no git, untracked file, missing, empty or malformed local file,
 * or a committed URL that differs from FLEET_STORE_URL) returns null, so the fleet
 * URL test runs and still fails on a real mismatch.
 */

import path from 'path'
import { execFileSync } from 'child_process'
import { fs } from 'zx'
import { FLEET_STORE_URL, storeIdentityPaths } from '../../src/data/StoreIdentity.js'

const AUTOMERGE_URL = /^automerge:[1-9A-HJ-NP-Za-km-z]+$/

/** The HEAD version of `filePath` in the git checkout at `root`, trimmed; null if git can't give it. */
export const readCommittedFile = (root: string, filePath: string): string | null => {
    const rel = path.relative(path.resolve(root), path.resolve(root, filePath))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    try {
        return execFileSync('git', ['-C', root, 'show', `HEAD:${rel.split(path.sep).join('/')}`],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return null
    }
}

/**
 * The reason to skip the fleet store URL test in the checkout at `root`, or null
 * to run it. `urlPath` defaults to store-url.txt in the configured store identity folder.
 */
export const ownStoreSkipReason = (root: string = process.cwd(), urlPath: string = storeIdentityPaths().urlPath): string | null => {
    const localPath = path.resolve(root, urlPath)
    if (!fs.existsSync(localPath)) return null
    const local = fs.readFileSync(localPath, 'utf-8').trim()
    if (!AUTOMERGE_URL.test(local) || local === FLEET_STORE_URL) return null
    const committed = readCommittedFile(root, localPath)
    if (committed !== FLEET_STORE_URL) return null
    return `own-store Pi: ${path.relative(path.resolve(root), localPath)} holds ${local}, not the committed fleet URL ${FLEET_STORE_URL} (idea#155)`
}

/**
 * Call at the start of the fleet store URL test: on an own-store Pi it skips the
 * test with the reason (ctx.skip throws, so nothing after it runs); otherwise it
 * returns and the test runs as usual.
 */
export const skipIfOwnStore = (
    ctx: { skip: (note: string) => never },
    root: string = process.cwd(),
    urlPath: string = storeIdentityPaths().urlPath,
): void => {
    const reason = ownStoreSkipReason(root, urlPath)
    if (reason) ctx.skip(reason)
}
