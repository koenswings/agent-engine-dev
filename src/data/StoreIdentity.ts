import path from 'path'
import crypto from 'crypto'
import { fs } from 'zx'
import { DocumentId, isValidAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'
import { config } from './Config.js'
import { error, log } from '../utils/utils.js'

/**
 * The shared fleet store (idea#120): the kit store (idea#452).
 *
 * Every field Engine opens the same Automerge document, so they all merge into one
 * store (AGENTS.md, docs/ARCHITECTURE.md). Since idea#452 (Koen, 2026-11-12) this
 * is the kit store 3Vvv… that the Zimbabwe kits (kind-panda, happy-zebra,
 * sunny-robin) share, so a Pi flashed from an Engine image joins the kits. It
 * replaces 4GQm…, which no deployed Engine uses. Its URL is tracked in
 * store-identity/store-url.txt (the file an Engine image ships); this constant is
 * the same value, and a test checks that the two match. The dev pool (2VroE…) and
 * production keep their own store in their local store-url.txt, which a deploy
 * keeps. The document's initial content comes from store-template.json, which is
 * never written by the Engine.
 */
export const FLEET_STORE_URL = 'automerge:3Vvvigx8bKcuwKALqMVz85GhDqrk'

/**
 * Known live or retired fleet store document IDs (engine#362). Full IDs:
 *   - 2VroEUvDkmYsDAwE5oG9YeFNadWH  dev pool (fleet-state, deploy-engine-pi)
 *   - 3Vvvigx8bKcuwKALqMVz85GhDqrk  kit store (FLEET_STORE_URL, store-url.txt)
 *   - 6f8m5KxzARv9xwv4Lw18LgVUJzu  production (fleet-state, deploy-engine-pi)
 *   - 4GQmEZehPDfryGDxkFo9XixbvmAC  retired previous default (idea#452); not the
 *     store-template.json document ID (the template is a content snapshot
 *     imported under whatever ID is in store-url.txt).
 * A testMode or IDEA_WATCH_DIR Engine must not open these: startup reconcile
 * used to publish undock of real disks into the shared store (idea03, 13 Nov 2026).
 */
export const KNOWN_FLEET_STORE_IDS: readonly string[] = [
    '2VroEUvDkmYsDAwE5oG9YeFNadWH',
    '3Vvvigx8bKcuwKALqMVz85GhDqrk',
    '6f8m5KxzARv9xwv4Lw18LgVUJzu',
    '4GQmEZehPDfryGDxkFo9XixbvmAC',
]

export const isKnownFleetStoreId = (idOrUrl: string): boolean =>
    KNOWN_FLEET_STORE_IDS.includes(storeDocIdFromUrl(idOrUrl))

/**
 * Refuse to start a test/fixture Engine on a known fleet store (engine#362).
 * Call after the store URL is known and before the Automerge server opens it.
 * `testMode` / `watchDirSet` must be passed explicitly (official tests set
 * IDEA_WATCH_DIR globally).
 */
export const refuseFleetStoreInIsolatedMode = (
    storeDocId: string,
    opts: { testMode: boolean, watchDirSet: boolean },
): void => {
    if (!opts.testMode && !opts.watchDirSet) return
    if (!isKnownFleetStoreId(storeDocId)) return
    const id = storeDocIdFromUrl(storeDocId)
    const why = opts.testMode && opts.watchDirSet
        ? 'testMode is on and IDEA_WATCH_DIR is set'
        : opts.testMode ? 'testMode is on' : 'IDEA_WATCH_DIR is set'
    throw new Error(
        `Refusing to start: ${why}, but the configured store is a known fleet store automerge:${id}. ` +
        `A test or fixture Engine must use an isolated store, not the dev pool (2VroE), kit (3Vvv), ` +
        `production (6f8m), or retired (4GQm) store. Point store-identity/store-url.txt ` +
        `(or settings.storeIdentityFolder) at a scratch document. (engine#362)`)
}

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
 *   - store-url.txt missing → startup stops with a clear error (engine#193), unless
 *     IDEA_ALLOW_STORE_URL_FALLBACK=true: then written atomically with FLEET_STORE_URL.
 *   - store-url.txt present → used as it is, whatever it contains (an isolated
 *     Engine may deliberately use its own store, e.g. idea03); never rewritten.
 *   - fallback: true while store-url.restored (see restoredMarkerPath) names the
 *     URL in use, i.e. the Engine runs on a store URL it restored itself.
 *
 * start.ts runs assertStoreIdentityMatchesData (engine#391) before this, so a
 * missing or unusable identity is not repaired when store-data already holds
 * other documents.
 */
/**
 * Env flag that lets the Engine write the fleet store URL into a missing
 * store-url.txt (engine#193). Off by default: without the file the Engine refuses
 * to start, so a dev/pool Pi that lost its file never silently joins the kit store
 * (the field Engines' store, idea#452).
 */
export const STORE_URL_FALLBACK_ENV = 'IDEA_ALLOW_STORE_URL_FALLBACK'

export const storeUrlFallbackAllowed = (env: NodeJS.ProcessEnv = process.env): boolean =>
    env[STORE_URL_FALLBACK_ENV] === 'true' || env[STORE_URL_FALLBACK_ENV] === '1'

export const prepareStoreIdentity = async (
    paths: StoreIdentityPaths = storeIdentityPaths(),
    opts: { allowFallback?: boolean } = {},
): Promise<{ storeDocId: DocumentId, restored: boolean, fallback: boolean }> => {
    const allowFallback = opts.allowFallback ?? storeUrlFallbackAllowed()
    if (!fs.existsSync(paths.templatePath)) {
        throw new Error(
            `Store template ${paths.templatePath} is missing. Every Engine must start from the shared ` +
            `store-template.json (never regenerate it): restore it from git, e.g. ` +
            `'git checkout -- store-identity/store-template.json'.`)
    }
    let restored = false
    if (!fs.existsSync(paths.urlPath)) {
        if (!allowFallback) {
            throw new Error(
                `Store URL file ${paths.urlPath} is missing: refusing to start (engine#193). ` +
                `Without it the Engine would join the fleet (kit) store ${FLEET_STORE_URL}. Restore the file ` +
                `(e.g. 'git checkout -- store-identity/store-url.txt', or the pool's store URL), or set ` +
                `${STORE_URL_FALLBACK_ENV}=true to write the fleet store URL deliberately.`)
        }
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

/** engine#391: startup refusal when store-identity does not belong to store-data. */
export const STORE_IDENTITY_MISMATCH = 'STORE_IDENTITY_MISMATCH'

/** CLI flag that skips the engine#391 store-identity guard. Never set by the image or pm2 config. */
export const STORE_IDENTITY_OVERRIDE_FLAG = '--allow-new-store'

/** Env override for the engine#391 guard. Official value is `1`. Never set by the image or pm2 config. */
export const STORE_IDENTITY_OVERRIDE_ENV = 'IDEA_ALLOW_NEW_STORE'

export const STORE_IDENTITY_MISMATCH_HINT =
    'Refusing to start: this store-identity does not belong to this store-data. Fix the link, or start with --allow-new-store if this is intended.'

export class StoreIdentityMismatchError extends Error {
    readonly code = STORE_IDENTITY_MISMATCH
    constructor(message: string) {
        super(message)
        this.name = 'StoreIdentityMismatchError'
    }
}

/** True when `--allow-new-store` is on the command line or `IDEA_ALLOW_NEW_STORE=1`. */
export const storeIdentityOverrideAllowed = (
    env: NodeJS.ProcessEnv = process.env,
    argv: readonly string[] = process.argv,
): boolean =>
    env[STORE_IDENTITY_OVERRIDE_ENV] === '1' || env[STORE_IDENTITY_OVERRIDE_ENV] === 'true'
    || argv.includes(STORE_IDENTITY_OVERRIDE_FLAG)

/** Automerge NodeFS path for a document: <store-data>/<first two id chars>/<rest>. */
export const storeDocumentDir = (dataDir: string, docId: string): string =>
    path.join(dataDir, docId.slice(0, 2), docId.slice(2))

const directoryHasFiles = (dir: string): boolean => {
    const walk = (d: string): boolean => {
        for (const name of fs.readdirSync(d)) {
            const p = path.join(d, name)
            let st
            try { st = fs.lstatSync(p) } catch { continue }
            if (st.isFile()) return true
            if (st.isDirectory() && walk(p)) return true
        }
        return false
    }
    try { return walk(dir) } catch { return false }
}

/**
 * Document ids that already have Automerge data under store-data (engine#391).
 * Uses the same <aa>/<rest> layout as createServerStore / NodeFSStorageAdapter.
 * Missing, unreadable, or empty directories do not count; only dirs that hold a file.
 */
export const listStoreDataDocumentIds = (dataDir: string): string[] => {
    let root: string
    try {
        if (!fs.existsSync(dataDir)) return []
        const st = fs.statSync(dataDir)
        if (!st.isDirectory()) return []
        root = fs.realpathSync(dataDir)
    } catch {
        return []
    }
    const ids: string[] = []
    let prefixes: string[]
    try { prefixes = fs.readdirSync(root) } catch { return [] }
    for (const prefix of prefixes) {
        if (prefix.length !== 2 || prefix.startsWith('.')) continue
        const prefixDir = path.join(root, prefix)
        let pst
        try { pst = fs.statSync(prefixDir) } catch { continue }
        if (!pst.isDirectory()) continue
        let restNames: string[]
        try { restNames = fs.readdirSync(prefixDir) } catch { continue }
        for (const rest of restNames) {
            if (!rest || rest.startsWith('.')) continue
            const docDir = path.join(prefixDir, rest)
            let dst
            try { dst = fs.statSync(docDir) } catch { continue }
            if (!dst.isDirectory()) continue
            if (!directoryHasFiles(docDir)) continue
            ids.push(prefix + rest)
        }
    }
    return ids.sort()
}

/** True when store-data holds any Automerge document data. */
export const storeDataIsNonEmpty = (dataDir: string): boolean =>
    listStoreDataDocumentIds(dataDir).length > 0

const resolveExistingPath = (p: string): string => {
    try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

export type StoreIdentityInspection = {
    usable: boolean
    /** The trimmed store-url, or "missing" when the file is absent or empty. */
    storeUrl: string
    docId: DocumentId | null
    /** Why the identity is unusable, when it is. */
    reason: string | null
}

/**
 * Inspect store-identity without writing (engine#391).
 * Unusable when the dir or store-url.txt is missing, empty, or not a valid
 * `automerge:` URL; when the path is not a real directory or a symlink to one;
 * or when a nested `store-identity/store-identity` is present (the `ln -sfn` footgun).
 */
export const inspectStoreIdentity = (identityDir: string): StoreIdentityInspection => {
    const urlPath = path.join(identityDir, 'store-url.txt')
    const missing = (reason: string, storeUrl: string = 'missing'): StoreIdentityInspection =>
        ({ usable: false, storeUrl, docId: null, reason })

    let lst
    try { lst = fs.lstatSync(identityDir) } catch {
        return missing('store-identity is missing')
    }
    if (lst.isSymbolicLink()) {
        let target: string
        try { target = fs.realpathSync(identityDir) } catch {
            return missing('store-identity is a broken symlink')
        }
        let tst
        try { tst = fs.statSync(target) } catch {
            return missing('store-identity is a broken symlink')
        }
        if (!tst.isDirectory()) return missing('store-identity is not a directory')
    } else if (!lst.isDirectory()) {
        return missing('store-identity is not a directory')
    }

    const readUrl = (): { storeUrl: string, docId: DocumentId | null, urlReason: string | null } => {
        if (!fs.existsSync(urlPath)) return { storeUrl: 'missing', docId: null, urlReason: 'store-url.txt is missing' }
        let raw: string
        try { raw = fs.readFileSync(urlPath, 'utf8') } catch {
            return { storeUrl: 'missing', docId: null, urlReason: 'store-url.txt is unreadable' }
        }
        const trimmed = raw.trim()
        if (!trimmed) return { storeUrl: 'missing', docId: null, urlReason: 'store-url.txt is empty' }
        if (!isValidAutomergeUrl(trimmed)) {
            return { storeUrl: trimmed, docId: null, urlReason: 'store-url.txt is not a valid automerge: URL' }
        }
        return { storeUrl: trimmed, docId: parseAutomergeUrl(trimmed).documentId, urlReason: null }
    }

    const nested = path.join(identityDir, 'store-identity')
    try {
        fs.lstatSync(nested)
        const url = readUrl()
        return { usable: false, storeUrl: url.storeUrl, docId: null,
            reason: 'store-identity is nested (store-identity/store-identity)' }
    } catch { /* no nested entry */ }

    const url = readUrl()
    if (url.urlReason) return missing(url.urlReason, url.storeUrl)
    return { usable: true, storeUrl: url.storeUrl, docId: url.docId, reason: null }
}

const formatMismatchMessage = (
    identityDir: string,
    dataDir: string,
    storeUrl: string,
    docIds: string[],
): string => {
    const docs = docIds.length ? docIds.join(', ') : '(none)'
    return [
        `${STORE_IDENTITY_MISMATCH}: ${STORE_IDENTITY_MISMATCH_HINT}`,
        `store-identity: ${resolveExistingPath(identityDir)}`,
        `store-data: ${resolveExistingPath(dataDir)}`,
        `store-url: ${storeUrl}`,
        `documents in store-data: ${docs}`,
    ].join('\n')
}

export type AssertStoreIdentityOptions = {
    identityDir: string
    dataDir: string
    /** When true, skip the guard. Defaults to --allow-new-store / IDEA_ALLOW_NEW_STORE. */
    allowNewStore?: boolean
    env?: NodeJS.ProcessEnv
    argv?: readonly string[]
}

/**
 * engine#391: before opening the repo, refuse to start when store-data already
 * holds Automerge documents and the identity is unusable or names a document
 * that is not among them. Read-only: no writes to store-data or store-identity.
 *
 * Does not refuse when store-data is empty (fresh install / image first boot)
 * or when the URL's document is present in store-data.
 */
export const assertStoreIdentityMatchesData = (opts: AssertStoreIdentityOptions): void => {
    const allow = opts.allowNewStore ?? storeIdentityOverrideAllowed(opts.env ?? process.env, opts.argv ?? process.argv)
    if (allow) return

    const docIds = listStoreDataDocumentIds(opts.dataDir)
    if (docIds.length === 0) return

    const identity = inspectStoreIdentity(opts.identityDir)
    const matches = identity.usable && identity.docId !== null && docIds.includes(identity.docId)
    if (matches) return

    const message = formatMismatchMessage(opts.identityDir, opts.dataDir, identity.storeUrl, docIds)
    error(message)
    throw new StoreIdentityMismatchError(message)
}
