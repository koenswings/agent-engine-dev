/**
 * durabilityChild.ts — the Engine's repo (startAutomergeServer) in a child process
 * for store-durability.test.ts. Loads <docId> from <dataDir>, then makes <changes>
 * changes 100 ms apart (n := 1..changes), prints {"wrote":k} after each and stays
 * alive until the parent SIGKILLs it (no shutdown hook runs, like a power cut).
 * Usage: tsx durabilityChild.ts <dataDir> <port> <docId> <changes>
 */
import { startAutomergeServer } from '../../src/repo.js'
import { DocumentId } from '@automerge/automerge-repo'

const [dataDir, port, docId, changes] = process.argv.slice(2)
const repo = await startAutomergeServer(dataDir, Number(port) as any)
const handle = await repo.find<{ n: number }>(docId as DocumentId)
let k = 0
const t = setInterval(() => {
    handle.change(d => { d.n = ++k })
    process.stdout.write(JSON.stringify({ wrote: k }) + '\n')
    if (k >= Number(changes)) clearInterval(t)
}, 100)
setInterval(() => {}, 60_000) // stay alive until SIGKILL
