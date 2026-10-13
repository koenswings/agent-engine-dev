// r86k: read-only CommandLog reader OFF the walker's main thread.
// r86k FAIL@42/43: the first listCommandTraces of copy_app's op wait synced every pool Engine's
// CommandLog doc (idea01: 4 MB of history, 531 files; appended to while copyApp runs) on the main
// thread. Automerge's receiveSyncMessage (WASM) ran there for 150 s, so no timer could fire.
// This worker owns its own Repo + WS to ONE Engine, keeps the CommandLog handle synced, and answers
// { id } requests with compact traces (no log lines). It never changes the doc.
// r86p: session body shared by the per-reader worker and the shared doc host (docHostWorker.mjs).
import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'

export function startCommandLogSession(workerData, io) {
    const { wsUrl, docUrl, peerId } = workerData
    const post = (m) => { try { io.post(m) } catch { /* parent gone */ } }
    const repo = new Repo({ network: [new WebSocketClientAdapter(wsUrl, 2000)], peerId })
    let handle = null
    const getHandle = () => {
        if (!handle) handle = repo.findWithProgress(docUrl).handle
        return handle
    }
    // Start syncing at once so the (slow) first sync runs before the first request needs it.
    const started = Date.now()
    const kick = setInterval(() => {
        try {
            const h = getHandle()
            if (h.isReady()) { clearInterval(kick); post({ event: 'ready', ms: Date.now() - started }) }
            else if (h.state === 'unavailable') handle = null // peer not up yet: ask again
        } catch { handle = null }
    }, 250)

    // r86l: per-worker memory for LOOPLAG.jsonl (RealFleetOps.threadMem).
    const memTimer = setInterval(() => {
        const m = process.memoryUsage()
        post({ event: 'mem', heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers })
    }, Number(workerData.memEveryMs ?? 15_000)).unref()

    const compact = (doc) => Object.entries(doc?.traces ?? {}).map(([id, raw]) => {
        const t = raw ?? {}
        return {
            traceId: String(t.traceId ?? id),
            command: String(t.command ?? ''),
            args: typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? null),
            status: String(t.status ?? ''),
            startedAt: typeof t.startedAt === 'number' ? t.startedAt : null,
            completedAt: typeof t.completedAt === 'number' ? t.completedAt : null,
            errorMessage: t.errorMessage == null ? null : String(t.errorMessage),
        }
    })

    io.onMessage((m) => {
        if (m?.type === 'shutdown') {
            clearInterval(kick)
            clearInterval(memTimer)
            Promise.resolve(repo.shutdown?.()).catch(() => {}).finally(() => io.exit(0))
            return
        }
        const id = m?.id
        try {
            const h = getHandle()
            if (!h.isReady()) { post({ id, error: `CommandLog ${docUrl} not synced yet (${Math.round((Date.now() - started) / 1000)}s, off-thread)` }); return }
            post({ id, traces: compact(h.doc()) })
        } catch (e) {
            post({ id, error: e instanceof Error ? e.message : String(e) })
        }
    })
}
