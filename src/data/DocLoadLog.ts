/**
 * DocLoadLog.ts (engine#549 follow-up, PR #553 Pi proof): a per-document load log, to
 * classify main-thread stalls after peers connect (idea04: ~59 s right after its client
 * connections on #553). OFF by default; on with the environment variable
 * IDEA_DOC_LOAD_LOG=1 (set it in the pm2 app env; no NODE_ENV or testMode involved).
 *
 * Lines (print, the always-on logger, only when enabled):
 *   [doc-load] id=<docId> kind=<store|foreign-store|command-log|other> owner=<engineId|-> bytes=<stored bytes> ms=<loadDoc ms> changes=<n> source=local-storage trigger=<peer-sync|local> from=<engineId|client|-> storage=<peer storageId|->
 *     a doc read from this Engine's own store-data (FS read + Automerge load). trigger=peer-sync
 *     when the first sync/request message for a doc not yet in memory came from a peer (that
 *     message caused the load); trigger=local for this Engine's own repo.find.
 *   [doc-sync] id=<docId> kind=... owner=... bytes=<sync message bytes> ms=<receiveSyncMessage ms> changes=<n> source=peer from=<engineId|client> storage=<storageId|->
 *     a sync message applied to a loaded doc (the doc content arriving from a peer). Logged
 *     when ms >= IDEA_DOC_LOAD_LOG_MIN_SYNC_MS (default 10), so the many tiny heads-only
 *     messages do not flood the log; doc loads are always logged.
 * The peer attribution of a [doc-sync] is the last message seen for that doc before it was
 * applied (messages for one doc are applied in order, so this is exact unless two peers'
 * messages for the same doc interleave while its load is pending).
 */
import type { Repo } from '@automerge/automerge-repo'
import { print } from '../utils/utils.js'
import { isCommandLogContent, isForeignStoreDocContent, parseEnginePeerId } from './StoreScope.js'

export const DOC_LOAD_LOG_ENV = 'IDEA_DOC_LOAD_LOG'
export const DOC_LOAD_LOG_MIN_SYNC_MS_ENV = 'IDEA_DOC_LOAD_LOG_MIN_SYNC_MS'

export const docLoadLogEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
    /^(1|true|yes|on)$/i.test(String(env[DOC_LOAD_LOG_ENV] ?? '').trim())

const minSyncMs = (env: NodeJS.ProcessEnv): number => {
    const n = Number(env[DOC_LOAD_LOG_MIN_SYNC_MS_ENV])
    return Number.isFinite(n) && n >= 0 && String(env[DOC_LOAD_LOG_MIN_SYNC_MS_ENV] ?? '') !== '' ? n : 10
}

export interface DocLoadLogOptions {
    storeDocId: string
    env?: NodeJS.ProcessEnv
    /** Where lines go (tests). Default: print. */
    sink?: (line: string) => void
}

const bareId = (id: string) => String(id).replace(/^automerge:/, '')

/** kind and owner of a doc's content (store doc id compared first; content otherwise). */
export const docKind = (storeDocId: string, docId: string, doc: unknown): { kind: string, owner: string } => {
    if (bareId(docId) === bareId(storeDocId)) return { kind: 'store', owner: '-' }
    try {
        if (isForeignStoreDocContent(storeDocId, docId, doc)) return { kind: 'foreign-store', owner: '-' }
        if (isCommandLogContent(doc)) {
            const owner = (doc as any)?.engineId
            return { kind: 'command-log', owner: typeof owner === 'string' && owner ? owner : 'unowned' }
        }
    } catch { /* unreadable: other */ }
    return { kind: doc === undefined ? 'unknown' : 'other', owner: '-' }
}

/**
 * Install the log on `repo` when enabled (IDEA_DOC_LOAD_LOG). Returns true when installed.
 * Wraps, on this Repo instance only: storageSubsystem.loadDocData (stored bytes),
 * storageSubsystem.loadDoc (timing + content), synchronizer.receiveMessage (which peer's
 * message triggered a load / carried a sync); listens to the Repo's own 'doc-metrics'
 * receive-sync-message events (automerge-repo times A.receiveSyncMessage itself).
 */
export const installDocLoadLog = (repo: Repo, opts: DocLoadLogOptions): boolean => {
    const env = opts.env ?? process.env
    if (!docLoadLogEnabled(env)) return false
    const sink = opts.sink ?? ((line: string) => print(line))
    const minMs = minSyncMs(env)
    const r = repo as any
    const peerOf = (peerId: string | undefined) => {
        if (!peerId) return { from: '-', storage: '-' }
        const parsed = parseEnginePeerId(peerId)
        const storage = r.peerMetadataByPeerId?.[peerId]?.storageId ?? '-'
        return { from: parsed?.engineId ?? 'client', storage: String(storage) }
    }
    /** first peer message for a doc that was not in memory: it triggers the load */
    const loadTrigger = new Map<string, string>()
    /** last peer message (sender, bytes) per doc: attribution of the next applied sync */
    const lastMessage = new Map<string, { senderId: string, bytes: number }>()
    const storedBytes = new Map<string, number>()
    /** numChanges from the storage subsystem's own 'doc-loaded' metric (emitted inside loadDoc) */
    const loadedChanges = new Map<string, number>()

    const sync = r.synchronizer
    if (sync && typeof sync.receiveMessage === 'function') {
        const orig = sync.receiveMessage.bind(sync)
        sync.receiveMessage = (message: any) => {
            const id = message?.documentId ? bareId(message.documentId) : undefined
            if (id && message.senderId) {
                if (!(id in (r.handles ?? {})) && !loadTrigger.has(id) && (message.type === 'sync' || message.type === 'request')) loadTrigger.set(id, message.senderId)
                lastMessage.set(id, { senderId: message.senderId, bytes: message.data?.byteLength ?? 0 })
            }
            return orig(message)
        }
    }

    const ss = r.storageSubsystem
    if (ss && typeof ss.loadDoc === 'function') {
        const origData = ss.loadDocData.bind(ss)
        ss.loadDocData = async (documentId: string) => {
            const bin = await origData(documentId)
            storedBytes.set(bareId(documentId), bin ? bin.byteLength : 0)
            return bin
        }
        const origLoad = ss.loadDoc.bind(ss)
        ss.loadDoc = async (documentId: string) => {
            const id = bareId(documentId)
            const t0 = performance.now()
            const doc = await origLoad(documentId)
            const ms = performance.now() - t0
            const trigger = loadTrigger.get(id)
            loadTrigger.delete(id)
            const { kind, owner } = doc ? docKind(opts.storeDocId, id, doc) : { kind: 'not-in-storage', owner: '-' }
            const p = peerOf(trigger)
            const changes = loadedChanges.get(id) ?? '-'
            loadedChanges.delete(id)
            sink(`[doc-load] id=${id} kind=${kind} owner=${owner} bytes=${storedBytes.get(id) ?? 0} ms=${Math.round(ms)} changes=${changes} source=local-storage trigger=${trigger ? 'peer-sync' : 'local'} from=${p.from} storage=${p.storage}`)
            storedBytes.delete(id)
            return doc
        }
    }

    repo.on('doc-metrics' as any, (event: any) => {
        if (event?.type === 'doc-loaded' && event.documentId) { loadedChanges.set(bareId(event.documentId), event.numChanges); return }
        if (event?.type !== 'receive-sync-message') return
        const ms = Number(event.durationMillis ?? 0)
        if (ms < minMs) return
        const id = bareId(event.documentId)
        let doc: unknown
        try { const h = r.handles?.[id]; doc = h?.isReady?.() ? h.doc() : undefined } catch { doc = undefined }
        const { kind, owner } = docKind(opts.storeDocId, id, doc)
        const m = lastMessage.get(id)
        const p = peerOf(m?.senderId)
        sink(`[doc-sync] id=${id} kind=${kind} owner=${owner} bytes=${m?.bytes ?? 0} ms=${Math.round(ms)} changes=${event.numChanges ?? '-'} source=peer from=${p.from} storage=${p.storage}`)
    })
    sink(`[doc-load] per-document load log ON (${DOC_LOAD_LOG_ENV}); [doc-sync] lines from ${minMs} ms`)
    return true
}
