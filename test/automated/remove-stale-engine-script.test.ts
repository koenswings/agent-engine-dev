/**
 * remove-stale-engine-script.test.ts: script/remove-stale-engine.mjs under
 * store-scoped peering (#156/#157).
 *
 * The script keeps a local copy (NodeFS storage), so an Engine treats it as an
 * Engine-like peer and refuses it unless it carries the Engine's store tag. It now
 * reads store-url.txt and connects as idea-engine/<storeTag>/TOOL_remove-stale-engine/<s>.
 *   - its tag derivation is identical to StoreScope.storeTag (no drift);
 *   - against a real Engine repo of the SAME store it is admitted and removes the entry;
 *   - pointed at another store's store-url.txt it is refused, exits 2 with a clear
 *     message, and changes nothing.
 */

import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { Repo, DocumentId } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { next as A } from '@automerge/automerge'
import { startAutomergeServer } from '../../src/repo.js'
import { ThreadedWebSocketServerAdapter } from '../../src/wsServerThread.js'
import { storeTag, parseEnginePeerId, peerVerdict } from '../../src/data/StoreScope.js'
import { PortNumber } from '../../src/data/CommonTypes.js'

// dist-test/test/automated/ (compiled) or test/automated/ (source) -> repo root
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = [path.resolve(here, '../../..'), path.resolve(here, '../..')].find(r => fs.existsSync(path.join(r, 'script', 'remove-stale-engine.mjs')))!
const SCRIPT = path.join(repoRoot, 'script', 'remove-stale-engine.mjs')
const loadScript = async (): Promise<any> => import(pathToFileURL(SCRIPT).href)

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `idea-rmstale-${p}-`))
const newDocId = (): DocumentId => new Repo({ network: [] }).create({}).documentId

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()!() } catch { /* closed */ } } })

const startEngine = async (storeId: DocumentId, bin: Uint8Array) => {
    const dir = tmp('engine')
    const seed = new Repo({ network: [], storage: new NodeFSStorageAdapter(dir) })
    seed.import(bin, { docId: storeId })
    await seed.flush()
    const port = await freePort()
    const repo = await startAutomergeServer(dir, port as PortNumber, { storeDocId: storeId, engineId: 'ENGINE_rmstale' })
    const server = repo.networkSubsystem.adapters[0] as unknown as ThreadedWebSocketServerAdapter
    cleanups.push(() => server.close())
    await server.listening
    const store = await repo.find<any>(storeId)
    await store.whenReady()
    return { repo, port, server, store }
}

const runScript = (args: string[], env: Record<string, string>): Promise<{ code: number | null, out: string }> => new Promise(resolve => {
    const cwd = tmp('cwd')
    const p = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, ...env } })
    let out = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
    const t = setTimeout(() => p.kill('SIGKILL'), 30_000)
    p.on('close', code => { clearTimeout(t); resolve({ code, out }) })
})
const urlFile = (storeId: string) => {
    const f = path.join(tmp('id'), 'store-url.txt')
    fs.writeFileSync(f, `automerge:${storeId}\n`)
    return f
}

describe('remove-stale-engine.mjs presents the store tag', () => {
    it('derives the tag and peerId exactly like the Engine (StoreScope.ts)', async () => {
        const s = await loadScript()
        for (const id of ['3zoqdSVsEtj4ygNJPNcDyKWvdxo6', '4GQmEZehPDfryGDxkFo9XixbvmAC', '6f8mAbCdEfGh', newDocId()]) {
            expect(s.storeTag(id)).toBe(storeTag(id))
            expect(s.storeTag(`automerge:${id}`)).toBe(storeTag(id))
            const pid = s.toolPeerId(id)
            expect(parseEnginePeerId(pid)).toEqual({ storeTag: storeTag(id), engineId: 'TOOL_remove-stale-engine' })
            expect(peerVerdict(storeTag(id), pid, { isEphemeral: false })).toMatchObject({ admit: true, kind: 'same-store' })
        }
        const f = urlFile('3zoqdSVsEtj4ygNJPNcDyKWvdxo6')
        expect(s.readStoreDocId(f)).toBe('3zoqdSVsEtj4ygNJPNcDyKWvdxo6')
        expect(() => s.readStoreDocId('/nonexistent/store-url.txt')).toThrow(/not found/)
    })

    it('same store: admitted by a real Engine and removes the stale entry', async () => {
        const X = newDocId()
        const e = await startEngine(X, A.save(A.from<any>({ engineDB: { ENGINE_keep: { id: 'ENGINE_keep' }, ENGINE_stale: { id: 'ENGINE_stale' } } })))
        const r = await runScript(['ENGINE_stale'], { IDEA_STORE_URL_FILE: urlFile(X), IDEA_WS_URL: `ws://127.0.0.1:${e.port}`, IDEA_SYNC_WAIT_MS: '1500' })
        expect(r.code, r.out).toBe(0)
        expect(r.out).toContain(`(store ${storeTag(X)})`)
        expect(e.store.doc().engineDB.ENGINE_stale).toBeUndefined()
        expect(e.store.doc().engineDB.ENGINE_keep).toBeDefined()
        expect(e.server.refusals).toHaveLength(0)
    }, 60_000)

    it("another store's store-url.txt: refused by the Engine, exits 2, changes nothing", async () => {
        const X = newDocId(), Y = newDocId()
        const e = await startEngine(X, A.save(A.from<any>({ engineDB: { ENGINE_stale: { id: 'ENGINE_stale' } } })))
        const r = await runScript(['ENGINE_stale'], { IDEA_STORE_URL_FILE: urlFile(Y), IDEA_WS_URL: `ws://127.0.0.1:${e.port}`, IDEA_SYNC_WAIT_MS: '500' })
        expect(r.code, r.out).toBe(2)
        expect(r.out).toMatch(/Could not load the store.*refuses peers of another store/s)
        expect(e.store.doc().engineDB.ENGINE_stale).toBeDefined()
        expect(e.server.refusals.map(x => x.verdict)).toContainEqual(expect.objectContaining({ kind: 'foreign-store', theirTag: storeTag(Y) }))
    }, 60_000)
})
