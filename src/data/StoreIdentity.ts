import path from 'path'
import crypto from 'crypto'
import { fs } from 'zx'
import { DocumentId } from '@automerge/automerge-repo'
import { config } from './Config.js'
import { log } from '../utils/utils.js'

/**
 * The shared fleet store (idea#120).
 *
 * Every Engine opens the same Automerge document, so they all merge into one
 * store (AGENTS.md, docs/ARCHITECTURE.md). Its URL is tracked in
 * store-identity/store-url.txt; this constant is the same value, so an Engine
 * whose store-url.txt is missing can write it back. A test checks that the two
 * match. The document's initial content comes from store-template.json, which is
 * never written by the Engine.
 */
export const FLEET_STORE_URL = 'automerge:4GQmEZehPDfryGDxkFo9XixbvmAC'

export interface StoreIdentityPaths {
    urlPath: string
    templatePath: string
}

/** store-url.txt and store-template.json in the given identity folder (default: config). */
export const storeIdentityPaths = (identityDir: string = './' + config.settings.storeIdentityFolder): StoreIdentityPaths => ({
    urlPath: path.join(identityDir, 'store-url.txt'),
    templatePath: path.join(identityDir, 'store-template.json'),
})

/** `automerge:<id>` (surrounding whitespace ignored) → `<id>`. */
export const storeDocIdFromUrl = (url: string): DocumentId =>
    url.trim().replace(/^automerge:/, '') as DocumentId

/**
 * Write `content` to `filePath` atomically: write a temp file in the same folder,
 * then rename it over the target, so a crash never leaves a half-written file.
 */
export const writeFileAtomic = async (filePath: string, content: string): Promise<void> => {
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
    try {
        await fs.writeFile(tmp, content, { flag: 'wx' })
        await fs.rename(tmp, filePath)
    } catch (e) {
        await fs.remove(tmp).catch(() => {})
        throw e
    }
}

/**
 * Read the store document ID from store-url.txt. Throws a clear error when the
 * file is missing or empty. Called when needed, never at module load (idea#120).
 */
export const readStoreDocId = (urlPath: string = storeIdentityPaths().urlPath): DocumentId => {
    if (!fs.existsSync(urlPath)) {
        throw new Error(`Store URL file ${urlPath} not found. The Engine writes it at startup; is the Engine initialised on this machine?`)
    }
    const id = storeDocIdFromUrl(fs.readFileSync(urlPath, 'utf-8'))
    if (!id) throw new Error(`Store URL file ${urlPath} is empty. Delete it so the Engine restores the fleet store URL, or restore it from git.`)
    return id
}

/**
 * store-url.restored, next to store-url.txt: written when the Engine restored a
 * missing store-url.txt with the fleet store URL. While it exists and still names
 * the URL in store-url.txt, peer access fails closed (data/PeerAccess.ts): the
 * Engine cannot tell it is in its own store, so it publishes no Engine key and
 * authorizes no peer. Ops confirms the store by deleting the file; changing
 * store-url.txt makes it stale, and it is removed at the next start.
 */
export const restoredMarkerPath = (paths: StoreIdentityPaths): string =>
    path.join(path.dirname(paths.urlPath), 'store-url.restored')

/**
 * Startup check of the store identity folder (idea#120):
 *   - store-template.json must exist; it is never created or written here. If it
 *     is missing the Engine stops with a clear error (restore it from git).
 *   - store-url.txt missing → written atomically with FLEET_STORE_URL.
 *   - store-url.txt present → used as it is, whatever it contains (an isolated
 *     Engine may deliberately use its own store, e.g. idea03); never rewritten.
 *   - fallback: true while store-url.restored (see restoredMarkerPath) names the
 *     URL in use, i.e. the Engine runs on a store URL it restored itself.
 */
export const prepareStoreIdentity = async (paths: StoreIdentityPaths = storeIdentityPaths()): Promise<{ storeDocId: DocumentId, restored: boolean, fallback: boolean }> => {
    if (!fs.existsSync(paths.templatePath)) {
        throw new Error(
            `Store template ${paths.templatePath} is missing. Every Engine must start from the shared ` +
            `store-template.json (never regenerate it): restore it from git, e.g. ` +
            `'git checkout -- store-identity/store-template.json'.`)
    }
    let restored = false
    if (!fs.existsSync(paths.urlPath)) {
        log(`Store URL file ${paths.urlPath} not found. Writing the fleet store URL ${FLEET_STORE_URL}.`)
        await writeFileAtomic(paths.urlPath, FLEET_STORE_URL)
        await fs.remove(restoredMarkerPath(paths))
        await writeFileAtomic(restoredMarkerPath(paths), FLEET_STORE_URL + '\n')
        restored = true
    }
    const storeDocId = readStoreDocId(paths.urlPath)
    let fallback = false
    const marker = restoredMarkerPath(paths)
    if (fs.existsSync(marker)) {
        if (storeDocIdFromUrl(fs.readFileSync(marker, 'utf-8')) === storeDocId) {
            fallback = true
        } else {
            log(`store-url.txt no longer holds the URL the Engine restored; removing ${marker}`)
            await fs.remove(marker)
        }
    }
    return { storeDocId, restored, fallback }
}
