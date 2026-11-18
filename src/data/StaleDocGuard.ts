/**
 * StaleDocGuard.ts (engine#512): no silent half-alive Engine on an outdated Automerge doc.
 *
 * automerge-repo 2.3.1 can leave a DocHandle holding a doc that Automerge 3 considers
 * outdated (DocSynchronizer answers a sync message inside handle.update(); when that
 * answer throws, the handle keeps the pre-receive doc). From then on every incoming sync
 * and every local handle.change on that doc throws "Attempting to change an outdated
 * document" until the process restarts. The send that triggered it no longer throws
 * (StoreScopedClientAdapter.send), but this guard is the defence in depth:
 *
 *   - the main STORE doc goes stale (detected on a local write, a failed receive, or the
 *     periodic sweep): log it loudly and exit cleanly with STALE_STORE_EXIT_CODE (75) so
 *     pm2 restarts the Engine. A restart loads the store from disk, the peers resend what
 *     was lost, and boot recovery picks up in-flight operations. Never run on with a
 *     frozen store (ops would stop updating while the Engine looks alive).
 *   - any OTHER doc goes stale (peers' command logs, the 13 docs idea01 refused on 11-17):
 *     log it and evict the handle from the Repo cache (repo.removeFromCache). The next
 *     message for that doc loads it again from disk and resyncs it with the peer. A doc
 *     the Engine itself holds a handle to (isPinned: its own command log) is not evicted
 *     (its holder would keep the stale handle); it is logged and counted.
 *
 * Detection of "outdated": Automerge marks a superseded doc by setting `heads` on its
 * internal state (Symbol.for('_am_meta')); that is exactly the check _change and
 * receiveSyncMessage make before they throw. A read-only probe, no write.
 */
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { error, log } from '../utils/utils.js'

/** EX_TEMPFAIL: "temporary failure, try again" (pm2 restarts on any non-zero code). */
export const STALE_STORE_EXIT_CODE = 75

const AM_STATE = Symbol.for('_am_meta')

export const isOutdatedDocError = (e: unknown): boolean =>
    /outdated document/i.test(String((e as any)?.message ?? e ?? ''))

/** True when `doc` is an Automerge doc that has been superseded (any change/sync on it throws). */
export const isDocOutdated = (doc: unknown): boolean => {
    if (!doc || typeof doc !== 'object') return false
    try {
        const state: any = Reflect.get(doc as object, AM_STATE)
        return !!(state && state.heads)
    } catch { return false }
}

/** The handle's doc is outdated (false for a handle that is not ready). */
export const isHandleStale = (handle: DocHandle<any> | undefined): boolean => {
    if (!handle) return false
    try { return handle.isReady() && isDocOutdated(handle.doc()) } catch { return false }
}

const bareId = (id: unknown): string => String(id ?? '').replace(/^automerge:/, '')

let staleStoreExitStarted = false
/** True once a stale-store exit is under way (index.ts then leaves the exit to it). */
export const staleStoreExitPending = (): boolean => staleStoreExitStarted
/** Tests only. */
export const resetStaleStoreExit = (): void => { staleStoreExitStarted = false }

export interface StaleStoreExitOptions {
    /** Close servers, flush the Repo (start.ts shutdownProcedure). Bounded by timeoutMs. */
    shutdown?: () => Promise<void>
    exit?: (code: number) => void
    timeoutMs?: number
}

/**
 * The fatal path: one loud line, a bounded clean shutdown, then exit(75) for pm2.
 * Idempotent: a second call while the first runs does nothing.
 */
export const staleStoreExit = (reason: string, opts: StaleStoreExitOptions = {}): Promise<void> => {
    if (staleStoreExitStarted) return Promise.resolve()
    staleStoreExitStarted = true
    const exit = opts.exit ?? ((code: number) => process.exit(code))
    error(`[stale-store] FATAL: the main store doc is outdated (Automerge "outdated document"): ${reason}. ` +
        `This Engine can no longer write or receive store changes. Exiting with code ${STALE_STORE_EXIT_CODE} ` +
        `so pm2 restarts it; the store reloads from disk and the peers resync it (engine#512)`)
    return new Promise<void>(resolve => {
        let done = false
        const finish = () => { if (done) return; done = true; resolve(); exit(STALE_STORE_EXIT_CODE) }
        const timer = setTimeout(() => { log(`[stale-store] shutdown did not finish in ${opts.timeoutMs ?? 10_000} ms; exiting anyway`); finish() }, opts.timeoutMs ?? 10_000)
        Promise.resolve()
            .then(() => opts.shutdown?.())
            .catch(e => log(`[stale-store] shutdown before exit failed: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => { clearTimeout(timer); finish() })
    })
}

export interface StaleDocGuardOptions {
    storeDocId: string
    /** Fatal path for the store doc (start.ts: staleStoreExit with the shutdown procedure). */
    onStaleStore: (reason: string) => void
    /** Docs the Engine itself holds a handle to (not evicted, only logged). */
    isPinned?: (documentId: string) => boolean
    /** Periodic sweep of all ready handles (default 15 s; 0 = off). */
    sweepMs?: number
}

export interface StaleDocGuard {
    /** Probe one doc now (after an error, or from tests). Returns true when it was stale. */
    check(documentId: string, context: string, err?: unknown): boolean
    /** Wrap the store handle's change() so a stale-store write takes the fatal path. */
    watchStoreHandle(handle: DocHandle<any>): void
    /** Probe every ready handle now. */
    sweep(): void
    stop(): void
    readonly stats: { staleStore: number, staleOther: number, evicted: number, pinned: number }
}

/** Install the guard on the Engine's Repo (start.ts, right after the Repo is created). */
export const installStaleDocGuard = (repo: Repo, opts: StaleDocGuardOptions): StaleDocGuard => {
    const storeId = bareId(opts.storeDocId)
    const stats = { staleStore: 0, staleOther: 0, evicted: 0, pinned: 0 }
    const evicting = new Set<string>()
    const pinnedLogged = new Set<string>()
    let storeFatal = false

    const storeStale = (context: string, err?: unknown) => {
        if (storeFatal) return
        storeFatal = true
        stats.staleStore++
        const why = err ? `${context}: ${err instanceof Error ? err.message : String(err)}` : context
        try { opts.onStaleStore(`doc ${storeId}, ${why}`) } catch (e) { error(`[stale-store] exit handler threw: ${e}`) }
    }

    const otherStale = (id: string, context: string) => {
        if (evicting.has(id)) return
        stats.staleOther++
        if (opts.isPinned?.(id)) {
            stats.pinned++
            if (!pinnedLogged.has(id)) {
                pinnedLogged.add(id)
                error(`[stale-doc] doc ${id} (held by this Engine) is outdated after ${context}; it cannot be reloaded while held, so it stays frozen until the Engine restarts (engine#512)`)
            }
            return
        }
        evicting.add(id)
        error(`[stale-doc] doc ${id} is outdated after ${context}; evicting it from the Repo cache so it reloads from disk and resyncs with its peers on the next message (engine#512)`)
        repo.removeFromCache(id as any)
            .then(() => { stats.evicted++; log(`[stale-doc] doc ${id} evicted; it resyncs on the next message`) })
            .catch(e => log(`[stale-doc] evicting doc ${id} failed: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => evicting.delete(id))
    }

    const check = (documentId: string, context: string, err?: unknown): boolean => {
        const id = bareId(documentId)
        if (!id) return false
        const handle = (repo.handles as Record<string, DocHandle<any>>)[id]
        const stale = isHandleStale(handle) || (id === storeId && isOutdatedDocError(err))
        if (!stale) return false
        if (id === storeId) storeStale(context, err)
        else otherStale(id, context)
        return true
    }

    // Every incoming sync/request/ephemeral goes through synchronizer.receiveMessage; the
    // Repo logs and swallows its errors ("error receiving message"). Probe the doc after
    // any error there: the poisoning error itself is the send's, not "outdated".
    const sync: any = repo.synchronizer
    const originalReceive = sync.receiveMessage
    sync.receiveMessage = async function (message: any) {
        try {
            return await originalReceive.call(sync, message)
        } catch (err) {
            try { if (message?.documentId) check(message.documentId, `receiving a ${message.type} message from ${message.senderId}`, err) } catch { /* never mask */ }
            throw err
        }
    }

    const watchStoreHandle = (handle: DocHandle<any>) => {
        const h: any = handle
        if (h.__ideaStaleGuard) return
        h.__ideaStaleGuard = true
        const originalChange = h.change
        h.change = function (...args: any[]) {
            try {
                return originalChange.apply(h, args)
            } catch (err) {
                if (isOutdatedDocError(err) || isHandleStale(handle)) storeStale('a local write to the store', err)
                throw err
            }
        }
    }

    const sweep = () => {
        for (const [id, handle] of Object.entries(repo.handles as Record<string, DocHandle<any>>)) {
            if (isHandleStale(handle)) check(id, 'the periodic stale-doc sweep')
        }
    }
    const sweepMs = opts.sweepMs ?? 15_000
    const timer = sweepMs > 0 ? setInterval(() => { try { sweep() } catch { /* never */ } }, sweepMs) : undefined
    ;(timer as any)?.unref?.()

    return {
        check, watchStoreHandle, sweep,
        stop: () => { if (timer) clearInterval(timer); sync.receiveMessage = originalReceive },
        get stats() { return { ...stats } },
    }
}
