/**
 * store-durability.test.ts — changes reach disk while the Engine runs, not only at a clean stop (r34 DURABILITY).
 *
 * The Engine's repo (src/repo.ts startAutomergeServer) runs in a child process,
 * makes 10 changes to a doc loaded from NodeFS storage, then waits SETTLE_MS and
 * is SIGKILLed (no SIGTERM handler, no repo.flush(): a crash or power cut). A new
 * Repo on the same directory must load all 10 changes.
 * On cf231e8 (automerge-repo 2.3.0-alpha.0) it loads n = 0: the throttled save in
 * Repo.ts:166-168 keeps re-saving the doc as it was at the first change. It passes
 * with automerge-repo 2.3.1 alone and with the backstop flush alone.
 *
 * The second block covers the backstop flush (startPeriodicFlush in src/repo.ts):
 * it writes nothing while the docs are unchanged, and shutdownRepo stops it.
 */
import { describe, it, expect, vi } from 'vitest'
import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import fs from 'fs'
import net from 'net'
import { Repo, DocumentId, StorageAdapterInterface, StorageKey, Chunk } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { fileURLToPath } from 'url'
import { startPeriodicFlush, stopPeriodicFlush } from '../../src/repo.js'
import { shutdownRepo } from '../../src/data/CommandLogStore.js'

// Compiled run (script/test-run.sh -> dist-test/): node on the .js; from source: tsx on the .ts.
const compiled = import.meta.url.endsWith('.js')
const childCmd = (): [string, string[]] => {
    const f = fileURLToPath(new URL(`../harness/durabilityChild.${compiled ? 'js' : 'ts'}`, import.meta.url))
    return compiled ? [process.execPath, [f]] : ['npx', ['tsx', f]]
}

const CHANGES = 10
const SETTLE_MS = Number(process.env.DURABILITY_SETTLE_MS ?? 7_000) // > STORE_FLUSH_INTERVAL_MS

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})

const seed = async (dir: string): Promise<DocumentId> => {
    const repo = new Repo({ storage: new NodeFSStorageAdapter(dir) })
    const h = repo.create<{ n: number }>({ n: 0 })
    await repo.flush()
    await repo.shutdown()
    return h.documentId
}

const load = async (dir: string, id: DocumentId): Promise<number> => {
    const repo = new Repo({ storage: new NodeFSStorageAdapter(dir) })
    const h = await repo.find<{ n: number }>(id)
    const n = h.doc().n
    await repo.shutdown()
    return n
}

describe('store durability without a clean shutdown', () => {
    it(`all ${CHANGES} changes survive a SIGKILL ${SETTLE_MS} ms after the last one`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-durability-'))
        const id = await seed(dir)
        const [cmd, args] = childCmd()
        const child = spawn(cmd, [...args, dir, String(await freePort()), id, String(CHANGES)], { stdio: ['ignore', 'pipe', 'inherit'] })
        await new Promise<void>((resolve, reject) => {
            let buf = ''
            child.stdout!.on('data', d => { buf += d; if (buf.includes(`{"wrote":${CHANGES}}`)) resolve() })
            child.once('exit', c => reject(new Error(`child exited early (${c})`)))
        })
        await new Promise(r => setTimeout(r, SETTLE_MS))
        child.kill('SIGKILL')
        await new Promise(r => child.once('exit', r))
        expect(await load(dir, id)).toBe(CHANGES)
    }, 60_000)
})

/** In-memory storage that counts the chunks written (snapshot/incremental only, not sync-state). */
class CountingStorage implements StorageAdapterInterface {
    data = new Map<string, Uint8Array>()
    docWrites = 0
    async load(key: StorageKey) { return this.data.get(key.join('/')) }
    async save(key: StorageKey, d: Uint8Array) {
        if (key[1] === 'snapshot' || key[1] === 'incremental') this.docWrites++
        this.data.set(key.join('/'), d)
    }
    async remove(key: StorageKey) { this.data.delete(key.join('/')) }
    async loadRange(prefix: StorageKey): Promise<Chunk[]> {
        const p = prefix.join('/')
        return [...this.data].filter(([k]) => k.startsWith(p)).map(([k, d]) => ({ key: k.split('/'), data: d }))
    }
    async removeRange(prefix: StorageKey) {
        const p = prefix.join('/')
        for (const k of [...this.data.keys()]) if (k.startsWith(p)) this.data.delete(k)
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('backstop periodic flush (startPeriodicFlush)', () => {
    it('writes nothing while the docs are unchanged, and the next change once', async () => {
        const storage = new CountingStorage()
        const repo = new Repo({ storage })
        const h = repo.create<{ n: number }>({ n: 0 })
        repo.create<{ other: boolean }>({ other: true })
        await repo.flush()
        await sleep(300) // let the library's own throttled saves settle
        const stop = startPeriodicFlush(repo, 50)
        const before = storage.docWrites
        await sleep(400) // ~8 ticks, nothing changed
        expect(storage.docWrites).toBe(before)
        h.change(d => { d.n = 1 })
        await sleep(400)
        expect(storage.docWrites - before).toBe(1) // one incremental, whoever wrote it first
        await stop()
        await repo.shutdown()
    })

    it('shutdownRepo stops it: no flush tick runs afterwards', async () => {
        const repo = new Repo({ storage: new CountingStorage() })
        repo.create<{ n: number }>({ n: 0 })
        const flush = vi.spyOn(repo, 'flush')
        startPeriodicFlush(repo, 30)
        await sleep(200)
        expect(flush.mock.calls.length).toBeGreaterThan(0) // it was running
        await shutdownRepo(repo)
        const after = flush.mock.calls.length
        await sleep(200)
        expect(flush.mock.calls.length).toBe(after)
        await stopPeriodicFlush(repo) // already stopped: no-op
    })
})
