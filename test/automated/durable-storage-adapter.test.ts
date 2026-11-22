/**
 * durable-storage-adapter.test.ts — engine#567 (a): durable chunk writes.
 *
 * kind-panda (18 Oct 2026): a power cut seconds after a compaction left only new
 * 0-byte chunks (NodeFS writeFile without fsync; StorageSubsystem removed the old
 * chunks right after) and the store loaded as {}. DurableNodeFSStorageAdapter:
 *   1. save: temp file in the target folder -> write -> fsync -> rename -> fsync folder
 *   2. compaction: every remove(old) starts only after save(new snapshot) resolved
 *   3. a 0-byte chunk is skipped on load and moved to <store-data>-quarantine/<stamp>/
 *   4. same layout as NodeFSStorageAdapter (both ways); leftover temp files of an
 *      interrupted save are quarantined, our own in-flight ones ignored
 *   5. the root cause, pinned: the stock adapter loads 0-byte chunks as {} (READY)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { Repo, DocumentId } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { DurableNodeFSStorageAdapter, DurableIo, nodeIo } from '../../src/data/DurableStorageAdapter.js'
import { quarantineRootFor, resetQuarantineDirsForTest } from '../../src/data/StoreQuarantine.js'

let tmp: string
let base: string
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-test-durable-'))
    base = path.join(tmp, 'store-data')
    resetQuarantineDirsForTest()
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** nodeIo that records every operation (and can delay renames). */
const recordingIo = (events: string[], renameDelayMs = 0): DurableIo => ({
    ...nodeIo,
    open: async (p, flags) => {
        const fh = await nodeIo.open(p, flags)
        const name = flags === 'r' ? `dir:${path.relative(base, p) || '.'}` : `file:${path.basename(p)}`
        events.push(`open ${flags} ${name}`)
        return {
            writeFile: async (d) => { events.push(`write ${name}`); await fh.writeFile(d) },
            sync: async () => { events.push(`sync ${name}`); await fh.sync() },
            close: async () => { events.push(`close ${name}`); await fh.close() },
        }
    },
    rename: async (a, b) => {
        if (renameDelayMs) await new Promise(r => setTimeout(r, renameDelayMs))
        events.push(`rename ${path.basename(a)} -> ${path.relative(base, b)}`)
        await nodeIo.rename(a, b)
    },
    unlink: async (p) => { events.push(`unlink ${path.relative(base, p)}`); await nodeIo.unlink(p) },
})

const allFiles = (d: string): string[] => {
    if (!fs.existsSync(d)) return []
    return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? allFiles(path.join(d, e.name)) : [path.join(d, e.name)])
}

describe('DurableNodeFSStorageAdapter.save (engine#567 a)', () => {
    it('writes a temp file in the target folder, fsyncs it, renames it, then fsyncs the folder', async () => {
        const events: string[] = []
        const a = new DurableNodeFSStorageAdapter(base, recordingIo(events))
        await a.save(['3Vvvigx8bKcuwKALqMVz85GhDqrk', 'snapshot', 'abc'], new Uint8Array([1, 2, 3]))
        const target = path.join(base, '3V', 'vvigx8bKcuwKALqMVz85GhDqrk', 'snapshot', 'abc')
        expect(Array.from(fs.readFileSync(target))).toEqual([1, 2, 3])
        const tmpName = events.find(e => e.startsWith('open w '))!.slice('open w file:'.length)
        expect(tmpName).toMatch(new RegExp(`^\\.tmp-${process.pid}-\\d+-abc$`))
        const idx = (s: string) => { const i = events.indexOf(s); expect(i, `${s} in ${events.join(' | ')}`).toBeGreaterThanOrEqual(0); return i }
        const write = idx(`write file:${tmpName}`)
        const sync = idx(`sync file:${tmpName}`)
        const close = idx(`close file:${tmpName}`)
        const rename = idx(`rename ${tmpName} -> 3V/vvigx8bKcuwKALqMVz85GhDqrk/snapshot/abc`)
        const dirSync = events.lastIndexOf('sync dir:3V/vvigx8bKcuwKALqMVz85GhDqrk/snapshot')
        expect(write).toBeLessThan(sync)
        expect(sync).toBeLessThan(close)
        expect(close).toBeLessThan(rename)
        expect(rename).toBeLessThan(dirSync)
        // new folders: their parents were fsynced too (the entries survive a power cut)
        expect(events).toContain('sync dir:3V')
        expect(events).toContain('sync dir:3V/vvigx8bKcuwKALqMVz85GhDqrk')
        // no temp file left behind
        expect(allFiles(base).filter(f => path.basename(f).startsWith('.'))).toEqual([])
    })

    it('a second save into an existing folder does not re-sync the parents, only the target folder', async () => {
        const events: string[] = []
        const a = new DurableNodeFSStorageAdapter(base, recordingIo(events))
        await a.save(['3Vvvigx8bKcuwKALqMVz85GhDqrk', 'incremental', 'one'], new Uint8Array([1]))
        events.length = 0
        await a.save(['3Vvvigx8bKcuwKALqMVz85GhDqrk', 'incremental', 'two'], new Uint8Array([2]))
        expect(events.filter(e => e.startsWith('sync dir:'))).toEqual(['sync dir:3V/vvigx8bKcuwKALqMVz85GhDqrk/incremental'])
    })
})

describe('compaction removes old chunks only after the new snapshot is durable (engine#567 a)', () => {
    it('every unlink of an old chunk comes after the rename + folder fsync of the new snapshot', async () => {
        const events: string[] = []
        const a = new DurableNodeFSStorageAdapter(base, recordingIo(events, 30))   // slow renames
        const repo = new Repo({ storage: a, network: [] })
        const h = repo.create<{ n: number, s?: string }>({ n: 0 })
        await repo.flush()
        for (let i = 1; i <= 4; i++) { h.change(d => { d.n = i }); await repo.flush() }
        await repo.shutdown()
        const unlinks = events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith('unlink '))
        expect(unlinks.length, 'small docs compact on every save, so old chunks were removed').toBeGreaterThan(0)
        for (const [e, i] of unlinks) {
            // the snapshot written by the same compaction: the last snapshot rename before this unlink
            const before = events.slice(0, i)
            const r = before.map((x, j) => [x, j] as const).filter(([x]) => /^rename .* -> .*\/snapshot\//.test(x)).pop()
            expect(r, `a snapshot rename precedes ${e}`).toBeTruthy()
            const snapDir = r![0].split(' -> ')[1].split('/').slice(0, -1).join('/')
            const dirSync = before.lastIndexOf(`sync dir:${snapDir}`)
            expect(dirSync, `folder fsync of ${snapDir} before ${e}`).toBeGreaterThan(r![1])
        }
        // the doc still loads in full
        const repo2 = new Repo({ storage: new DurableNodeFSStorageAdapter(base), network: [] })
        expect((await repo2.find<{ n: number }>(h.documentId)).doc().n).toBe(4)
        await repo2.shutdown()
    })
})

/** Seed a doc with the given adapter class, return its id and folder. */
const seed = async (storage: any): Promise<{ id: DocumentId, dir: string }> => {
    const repo = new Repo({ storage, network: [] })
    const h = repo.create<{ engineDB: Record<string, unknown> }>({ engineDB: { e1: { id: 'e1' } } })
    await repo.flush()
    h.change(d => { d.engineDB.e2 = { id: 'e2' } })
    await repo.flush()
    await repo.shutdown()
    return { id: h.documentId, dir: path.join(base, h.documentId.slice(0, 2), h.documentId.slice(2)) }
}

const chunkFiles = (dir: string): string[] => allFiles(dir).filter(f => /\/(snapshot|incremental)\//.test(f))

describe('0-byte chunks on load (engine#567 a)', () => {
    it('ROOT CAUSE pinned: the stock NodeFS adapter loads all-0-byte chunks as an empty, READY doc', async () => {
        const { id, dir } = await seed(new NodeFSStorageAdapter(base))
        for (const f of chunkFiles(dir)) fs.truncateSync(f, 0)
        const repo = new Repo({ storage: new NodeFSStorageAdapter(base), network: [] })
        const h = await repo.find<any>(id)
        expect(h.isReady()).toBe(true)
        expect(h.doc()).toEqual({})
        await repo.shutdown()
    })

    it('the durable adapter skips a 0-byte chunk and moves it to <store-data>-quarantine/<stamp>/ (not deleted)', async () => {
        const { id, dir } = await seed(new DurableNodeFSStorageAdapter(base))
        const files = chunkFiles(dir)
        expect(files.length).toBeGreaterThan(0)
        for (const f of files) fs.truncateSync(f, 0)
        const a = new DurableNodeFSStorageAdapter(base)
        const chunks = await a.loadRange([id, 'snapshot'])
        const incs = await a.loadRange([id, 'incremental'])
        expect([...chunks, ...incs].every(c => c.data === undefined)).toBe(true)
        expect(chunkFiles(dir)).toEqual([])
        const q = allFiles(quarantineRootFor(base))
        expect(q.length).toBe(files.length)
        for (const f of q) {
            expect(fs.statSync(f).size).toBe(0)
            expect(path.relative(quarantineRootFor(base), f)).toMatch(new RegExp(`^\\d{8}T\\d{6}-${process.pid}/${id.slice(0, 2)}/${id.slice(2)}/(snapshot|incremental)/`))
        }
        expect(path.dirname(quarantineRootFor(base))).toBe(path.dirname(path.resolve(base)))
    })

    it('a 0-byte incremental next to a good snapshot: the doc loads from the good chunk', async () => {
        const { id, dir } = await seed(new DurableNodeFSStorageAdapter(base))
        const incDir = path.join(dir, 'incremental')
        fs.mkdirSync(incDir, { recursive: true })
        fs.writeFileSync(path.join(incDir, 'deadbeef'), '')
        const repo = new Repo({ storage: new DurableNodeFSStorageAdapter(base), network: [] })
        const doc = (await repo.find<any>(id)).doc()
        expect(Object.keys(doc.engineDB).sort()).toEqual(['e1', 'e2'])
        await repo.shutdown()
        expect(fs.existsSync(path.join(incDir, 'deadbeef'))).toBe(false)
    })
})

describe('layout compatibility and temp files (engine#567 a)', () => {
    it('data written by NodeFSStorageAdapter loads with the durable adapter, and the other way round', async () => {
        const one = await seed(new NodeFSStorageAdapter(base))
        const r1 = new Repo({ storage: new DurableNodeFSStorageAdapter(base), network: [] })
        expect(Object.keys((await r1.find<any>(one.id)).doc().engineDB).sort()).toEqual(['e1', 'e2'])
        await r1.shutdown()
        const two = await seed(new DurableNodeFSStorageAdapter(base))
        const r2 = new Repo({ storage: new NodeFSStorageAdapter(base), network: [] })
        expect(Object.keys((await r2.find<any>(two.id)).doc().engineDB).sort()).toEqual(['e1', 'e2'])
        await r2.shutdown()
    })

    it('a leftover temp file of another process is quarantined; one of this process is ignored; neither is read as a chunk', async () => {
        const { id, dir } = await seed(new DurableNodeFSStorageAdapter(base))
        const snap = path.join(dir, 'snapshot')
        const stale = path.join(snap, '.tmp-999999-1-abc')
        const own = path.join(snap, `.tmp-${process.pid}-77-abc`)
        fs.writeFileSync(stale, 'partial')
        fs.writeFileSync(own, 'in flight')
        const a = new DurableNodeFSStorageAdapter(base)
        const chunks = await a.loadRange([id, 'snapshot'])
        expect(chunks.map(c => c.key[c.key.length - 1]).some(k => k.startsWith('.'))).toBe(false)
        expect(fs.existsSync(stale)).toBe(false)
        expect(fs.existsSync(own)).toBe(true)
        expect(allFiles(quarantineRootFor(base)).map(f => path.basename(f))).toEqual(['.tmp-999999-1-abc'])
    })

    it('removeRange removes the folder; remove of a missing key does not throw', async () => {
        const { id, dir } = await seed(new DurableNodeFSStorageAdapter(base))
        const a = new DurableNodeFSStorageAdapter(base)
        await a.remove([id, 'snapshot', 'nope'])
        await a.removeRange([id, 'snapshot'])
        expect(fs.existsSync(path.join(dir, 'snapshot'))).toBe(false)
    })
})
