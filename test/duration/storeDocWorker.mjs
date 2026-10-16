// r86l: one store-doc connection in its own worker (kept for tests / DURATION_DOC_HOST=per-link).
// The walker uses the shared doc host (docHostWorker.mjs) by default since r86p.
import { parentPort, workerData } from 'node:worker_threads'
import { startStoreDocSession } from './storeDocSession.mjs'

// The library's bare 60 s whenReady timeouts reject unawaited; never let them kill the worker.
process.on('unhandledRejection', (r) => { try { parentPort.postMessage({ event: 'rejection', message: r instanceof Error ? `${r.name}: ${r.message}` : String(r) }) } catch { /* gone */ } })
await startStoreDocSession(workerData, { post: (m) => parentPort.postMessage(m), onMessage: (fn) => parentPort.on('message', fn), exit: (c) => process.exit(c) })
