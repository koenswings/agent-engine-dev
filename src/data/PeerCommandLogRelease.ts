/**
 * PeerCommandLogRelease.ts (engine#581): release other Engines' command logs from
 * this Engine's Repo cache once nobody is reading them.
 *
 * A Console reads another Engine's command log on demand through the Engine it is
 * connected to (StoreScope.shareCommandLogWith). That Engine, and every peer that
 * answers its request from a stored copy, then kept the doc in repo.handles for the
 * life of the process, so a long-running Engine held ~60 peer command logs (idea04,
 * idea01: ~2 GB RSS). Automerge's wasm memory never shrinks, but memory of a
 * released doc is reused for the next load instead of growing further.
 *
 * Every sweep, a loaded doc with the command-log shape is a candidate when it is NOT:
 *   - one of this Engine's own command logs (current or rotated, isOwnCommandLog);
 *   - synced with a storage-less client right now (a Console or CLI reading it:
 *     the DocSynchronizer has that peer), the live relayed view (idea#168 r86i).
 * A candidate idle for idleMs (no client on it for that long, counted from when it
 * was first seen) is flushed to storage and removed from the cache
 * (releaseFromCache: repo.removeFromCache of automerge-repo 2.5.6, made safe). The copy stays in store-data, so
 * it is served again offline and is loaded again on the next request, then synced
 * with its owner as before. The store doc and other docs are never touched.
 */
import type { DocumentId, PeerId, Repo } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { isCommandLogContent, isOwnCommandLog } from './StoreScope.js'

/** Release a peer command log after it has had no client for this long. */
export const PEER_COMMAND_LOG_IDLE_MS = 10 * 60 * 1000
/** How often the cache is checked. */
export const PEER_COMMAND_LOG_SWEEP_MS = 60 * 1000

export interface PeerCommandLogReleaseOptions {
    idleMs?: number
    sweepMs?: number
    now?: () => number
    sink?: (line: string) => void
}

/** Peers of the Repo that are storage-less clients (Console, CLI, probes), not Engines. */
const clientPeers = (repo: Repo): PeerId[] => {
    const meta = (repo as any).peerMetadataByPeerId ?? {}
    return (repo.peers ?? []).filter(p => meta[p]?.isEphemeral === true)
}

/** Is a storage-less client syncing this doc right now? */
const hasClientOn = (repo: Repo, documentId: string, clients: PeerId[]): boolean => {
    if (!clients.length) return false
    const ds = (repo as any).synchronizer?.docSynchronizers?.[documentId]
    if (!ds || typeof ds.hasPeer !== 'function') return false
    return clients.some(p => { try { return ds.hasPeer(p) } catch { return false } })
}

/**
 * repo.removeFromCache (automerge-repo 2.5.6) unloads the handle, which swaps its
 * doc for an empty A.init() and emits 'heads-changed'. The Repo's own save
 * listener is still attached at that moment, so ~100 ms later it saves the EMPTY
 * doc as a full snapshot and removes the real chunks: the copy on disk is wiped
 * (box repro: snapshot replaced by the empty-doc hash, reload gives {}). Removing
 * the handle's listeners first (save, sync; nothing else listens to a peer's
 * command log) keeps the stored copy intact. Flush before calling this.
 */
export const releaseFromCache = async (repo: Repo, documentId: string): Promise<void> => {
    const handle = (repo.handles as Record<string, any>)[documentId]
    if (!handle) return
    handle.removeAllListeners?.()
    await repo.removeFromCache(documentId as DocumentId)
}

/** Loaded command logs of other Engines (ids). Reads only the handle cache. */
export const peerCommandLogIds = (repo: Repo): string[] => {
    const ids: string[] = []
    for (const [id, h] of Object.entries((repo.handles ?? {}) as Record<string, any>)) {
        if (isOwnCommandLog(repo, id)) continue
        let ready = false
        try { ready = !!h?.isReady?.() } catch { ready = false }
        if (!ready) continue
        let doc: unknown
        try { doc = h.doc() } catch { doc = undefined }
        if (isCommandLogContent(doc)) ids.push(id)
    }
    return ids
}

/**
 * One sweep. `lastInterest` maps doc id -> last time a client was on it (or first
 * seen). Returns the ids released in this sweep.
 */
export const sweepPeerCommandLogs = async (
    repo: Repo,
    lastInterest: Map<string, number>,
    opts: { idleMs?: number, now?: () => number, sink?: (line: string) => void } = {},
): Promise<string[]> => {
    const now = (opts.now ?? Date.now)()
    const idleMs = opts.idleMs ?? PEER_COMMAND_LOG_IDLE_MS
    const sink = opts.sink ?? ((line: string) => log(line))
    const ids = peerCommandLogIds(repo)
    const present = new Set(ids)
    for (const id of [...lastInterest.keys()]) if (!present.has(id)) lastInterest.delete(id)
    const clients = clientPeers(repo)
    const released: string[] = []
    for (const id of ids) {
        if (hasClientOn(repo, id, clients) || !lastInterest.has(id)) { lastInterest.set(id, now); continue }
        if (now - lastInterest.get(id)! < idleMs) continue
        try {
            await repo.flush([id as DocumentId])
            // a client may have asked for it while the flush ran
            if (hasClientOn(repo, id, clientPeers(repo))) { lastInterest.set(id, now); continue }
            await releaseFromCache(repo, id)
            lastInterest.delete(id)
            released.push(id)
        } catch (e) {
            sink(`[cmdlog-release] could not release ${id}: ${e instanceof Error ? e.message : e}`)
        }
    }
    if (released.length) sink(`[cmdlog-release] released ${released.length} peer command log(s) idle >= ${Math.round(idleMs / 60000)} min; ${ids.length - released.length} still loaded`)
    return released
}

/** Sweep every sweepMs. Returns stop(), which waits for a running sweep. The timer does not keep the process alive. */
export const startPeerCommandLogRelease = (repo: Repo, opts: PeerCommandLogReleaseOptions = {}): (() => Promise<void>) => {
    const lastInterest = new Map<string, number>()
    let running: Promise<unknown> | null = null
    const t = setInterval(() => {
        if (running) return
        running = sweepPeerCommandLogs(repo, lastInterest, opts)
            .catch(e => (opts.sink ?? ((l: string) => log(l)))(`[cmdlog-release] sweep failed: ${e instanceof Error ? e.message : e}`))
            .finally(() => { running = null })
    }, opts.sweepMs ?? PEER_COMMAND_LOG_SWEEP_MS)
    t.unref?.()
    return async () => { clearInterval(t); await running }
}
