// r86k: one CommandLog reader in its own worker (kept for DURATION_DOC_HOST=per-link and tests).
import { parentPort, workerData } from 'node:worker_threads'
import { startCommandLogSession } from './commandLogSession.mjs'

startCommandLogSession(workerData, { post: (m) => parentPort.postMessage(m), onMessage: (fn) => parentPort.on('message', fn), exit: (c) => process.exit(c) })
