/**
 * store-startup-guard.test.ts — engine#567 (b): startup guard and self-heal of the store doc.
 *
 * kind-panda: all chunks of the store doc were 0 bytes, the doc loaded as {}, and
 * cleanupPhantomEngines threw on Object.keys(store.engineDB): 817 pm2 restarts.
 * createServerStore now checks the chunk files first and falls back:
 *   1. all chunks 0 bytes        -> quarantined, rebuilt from store-template.json, SAME doc ID
 *   2. a garbage chunk           -> quarantined, the doc loads from the good chunks (no data lost)
 *   3. a truncated snapshot      -> (throws on load without the guard) quarantined -> template
 *   4. a doc without engineDB    -> the template is MERGED in: engineDB is the template's own
 *                                   map object (same Automerge object id), never a new `{}`
 *   5. a doc folder with no chunk files -> template (not a wait for a peer)
 *   6. store-template.json is byte-identical afterwards in every case
 *   7. createOrUpdateEngine / cleanupPhantomEngines / getRunningEngines on a {} doc:
 *      no throw and nothing written (no engineDB created)
 *   8. command log: 0-byte chunks or invalid content -> quarantined / fresh log
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { next as A } from '@automerge/automerge'
import { Repo, DocumentId, generateAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'
import { Store, createServerStore, getRunningEngines } from '../../src/data/Store.js'
import { createOrUpdateEngine, cleanupPhantomEngines, localEngineId } from '../../src/data/Engine.js'
import { DurableNodeFSStorageAdapter } from '../../src/data/DurableStorageAdapter.js'
import { StoreSelfHeal, chunkProblem, missingStoreMaps, publishStoreSelfHeal, templateRootHashes, storeGenesisPath, readStoreGenesis, recordStoreGenesis, descendsFromTemplate } from '../../src/data/StoreHealth.js'
import { quarantineRootFor, resetQuarantineDirsForTest } from '../../src/data/StoreQuarantine.js'
import { createCommandLogStore, localDay } from '../../src/data/CommandLogStore.js'
import { isCommandLogContent } from '../../src/data/StoreScope.js'

const TRACKED_TEMPLATE = path.join(process.cwd(), 'store-identity/store-template.json')
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

let tmp: string, dataDir: string, templatePath: string, docId: DocumentId, templateSha: string
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-test-guard-'))
    dataDir = path.join(tmp, 'store-data')
    fs.mkdirSync(dataDir)
    templatePath = path.join(tmp, 'store-template.json')
    fs.copyFileSync(TRACKED_TEMPLATE, templatePath)
    templateSha = sha(templatePath)
    docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
    resetQuarantineDirsForTest()
})
afterEach(async () => {
    // a Repo saves storage-adapter-id in the background (not awaited by shutdown): let it land before the folder goes
    await new Promise(r => setTimeout(r, 100))
    expect(sha(templatePath), 'store-template.json is never modified').toBe(templateSha)
    expect(sha(TRACKED_TEMPLATE), 'the tracked template is untouched').toBe(templateSha)
    fs.rmSync(tmp, { recursive: true, force: true })
})

const docDir = () => path.join(dataDir, docId.slice(0, 2), docId.slice(2))
const allFiles = (d: string): string[] => !fs.existsSync(d) ? [] :
    fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? allFiles(path.join(d, e.name)) : [path.join(d, e.name)])
const chunkFiles = () => allFiles(docDir()).filter(f => /\/(snapshot|incremental)\//.test(f))
/** The doc as persisted (all usable chunk files), read straight from store-data. */
const diskDoc = (): any => chunkFiles().reduce((d, f) => { const b = fs.readFileSync(f); return b.length ? A.loadIncremental(d, b) : d }, A.init<any>())

/** One Engine start: open the store with the durable adapter, run fn, flush, shut down. */
const open = async <T>(fn: (h: any, repo: Repo, heal: StoreSelfHeal | null) => Promise<T> | T): Promise<T> => {
    const repo = new Repo({ storage: new DurableNodeFSStorageAdapter(dataDir), network: [] })
    const healed: { v: StoreSelfHeal | null } = { v: null }
    const h = await createServerStore(repo, docId, dataDir, templatePath, { onSelfHeal: x => { healed.v = x } })
    const out = await fn(h, repo, healed.v)
    await repo.flush()
    await repo.storageId()   // the Repo saves storage-adapter-id in the background: let it finish before the folder goes
    await repo.shutdown()
    return out
}

/** A store seeded from the template with two Engines, persisted in several chunks. */
const seedStore = async () => {
    await open(async (h, repo) => {
        h.change((d: Store) => { (d.engineDB as any).e1 = { id: 'e1', hostname: 'a' } })
        await repo.flush()
        h.change((d: Store) => { (d.engineDB as any).e2 = { id: 'e2', hostname: 'b' } })
    })
    expect(chunkFiles().length).toBeGreaterThan(0)
}

const templateEngineDbObjId = () => A.getObjectId((A.load(fs.readFileSync(TRACKED_TEMPLATE)) as any).engineDB)

describe('createServerStore startup guard (engine#567 b)', () => {
    it('all chunks 0 bytes: quarantined (moved, not deleted), rebuilt from the template under the SAME doc ID', async () => {
        await seedStore()
        const files = chunkFiles()
        for (const f of files) fs.truncateSync(f, 0)
        const r = await open((h, _repo, heal) => ({ id: h.documentId, doc: JSON.parse(JSON.stringify(h.doc())), heal }))
        expect(r.id).toBe(docId)
        expect(Object.keys(r.doc).sort()).toEqual(['appDB', 'diskDB', 'engineDB', 'instanceDB'])
        expect(r.heal?.source).toBe('template')
        expect(r.heal?.quarantined).toBe(files.length)
        expect(readStoreGenesis(storeGenesisPath(dataDir), docId)?.descendsFromTemplate, 'recorded at the first good load').toBe(true)
        const q = allFiles(quarantineRootFor(dataDir))
        expect(q.length).toBe(files.length)
        expect(q.every(f => fs.statSync(f).size === 0)).toBe(true)
        expect(r.heal?.quarantineDir && q.every(f => f.startsWith(r.heal!.quarantineDir!))).toBe(true)
        // the rebuilt doc was flushed: the next start loads it from usable chunks, no heal
        expect(chunkFiles().length).toBeGreaterThan(0)
        const again = await open((_h, _r, heal) => heal)
        expect(again).toBeNull()
    })

    it('a garbage chunk next to good ones: only it is quarantined, the doc keeps all its data', async () => {
        await seedStore()
        const inc = path.join(docDir(), 'incremental')
        fs.mkdirSync(inc, { recursive: true })
        fs.writeFileSync(path.join(inc, 'garbage'), crypto.randomBytes(200))
        const r = await open((h, _repo, heal) => ({ engines: Object.keys(h.doc().engineDB).sort(), heal }))
        expect(r.engines).toEqual(['e1', 'e2'])
        expect(r.heal?.source).toBe('chunks')
        expect(r.heal?.quarantined).toBe(1)
        expect(allFiles(quarantineRootFor(dataDir)).map(f => path.basename(f))).toEqual(['garbage'])
    })

    it('a truncated snapshot (which makes the load throw without the guard) is quarantined; with nothing usable left -> template', async () => {
        await open(async () => undefined)   // template doc, one snapshot
        const snaps = chunkFiles()
        expect(snaps.length).toBe(1)
        const b = fs.readFileSync(snaps[0])
        fs.writeFileSync(snaps[0], b.subarray(0, Math.floor(b.length / 2)))
        expect(() => A.loadIncremental(A.init(), fs.readFileSync(snaps[0]))).toThrow()
        expect(chunkProblem(fs.readFileSync(snaps[0]))).toMatch(/corrupt chunk/)
        const r = await open((h, _repo, heal) => ({ id: h.documentId, missing: missingStoreMaps(h.doc()), heal }))
        expect(r.id).toBe(docId)
        expect(r.missing).toEqual([])
        expect(r.heal?.source).toBe('template')
    })

    it('a template-born doc without engineDB: the template is merged in; engineDB is the template\'s own map (never a new {})', async () => {
        // template genesis, then engineDB deleted (descends from the template, so the merge is safe)
        let born = A.load<any>(fs.readFileSync(TRACKED_TEMPLATE))
        born = A.change(born, d => { d.foo = 1; delete d.engineDB })
        const dir = path.join(docDir(), 'snapshot')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'born'), A.save(born))
        const r = await open((h, _repo, heal) => ({
            foo: h.doc().foo, missing: missingStoreMaps(h.doc()), heal,
        }))
        expect(r.foo, 'the loaded content is kept').toBe(1)
        expect(r.heal?.source).toBe('template-merge')
        expect(r.heal?.reason).toContain('engineDB')
        expect(allFiles(quarantineRootFor(dataDir))).toEqual([])
    })

    it('a doc with its own genesis and no maps (a stray chunk): the template heal is REFUSED, nothing is merged or written', async () => {
        const stray = A.change(A.init<any>(), d => { d.foo = 1 })
        const dir = path.join(docDir(), 'snapshot')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'stray'), A.save(stray))
        const r = await open((h, _repo, heal) => {
            h.change((d: any) => { d.engineDB = {} })   // any write is skipped while refused
            return { foo: h.doc().foo, view: h.doc(), heal }
        })
        expect(r.foo).toBe(1)
        expect(Object.isFrozen(r.view.engineDB) && Object.keys(r.view.engineDB)).toEqual([])   // read-only default
        const disk = diskDoc()
        expect(Object.keys(disk), 'nothing written: no map created').toEqual(['foo'])
        expect(A.hasHeads(disk, templateRootHashes(fs.readFileSync(TRACKED_TEMPLATE))), 'no template merge').toBe(false)
        expect(r.heal?.source).toBe('refused')
        expect(r.heal?.reason).toMatch(/does not descend/)
        expect(fs.existsSync(storeGenesisPath(dataDir)), 'a refused doc records no genesis').toBe(false)
    })

    it('a healthy store merges nothing and reports no heal; the template merge would be a no-op anyway', async () => {
        await seedStore()
        const r = await open((h, _repo, heal) => ({ engines: Object.keys(h.doc().engineDB).sort(), heal, obj: A.getObjectId(h.doc().engineDB) }))
        expect(r.heal).toBeNull()
        expect(r.engines).toEqual(['e1', 'e2'])
        expect(r.obj).toBe(templateEngineDbObjId())
    })

    it('a doc folder without chunk files is created from the template (no wait for a peer)', async () => {
        fs.mkdirSync(path.join(docDir(), 'snapshot'), { recursive: true })
        const r = await open((h, _repo, heal) => ({ missing: missingStoreMaps(h.doc()), heal }))
        expect(r.missing).toEqual([])
        expect(r.heal).toBeNull()
    }, 15_000)

    it('publishStoreSelfHeal writes only on this Engine\'s own entry and never creates engineDB or the entry', async () => {
        const repo = new Repo({ network: [] })
        const empty = repo.create<any>({})
        const heal: StoreSelfHeal = { at: 1, source: 'template', reason: 'x', quarantined: 2, quarantineDir: '/q' }
        expect(publishStoreSelfHeal(empty, 'e1', heal)).toBe(false)
        expect(empty.doc()).toEqual({})
        const full = repo.create<any>({ engineDB: { e1: { id: 'e1' } } })
        expect(publishStoreSelfHeal(full, 'e1', heal)).toBe(true)
        expect(full.doc().engineDB.e1.lastStoreSelfHeal).toEqual(heal)
        expect(publishStoreSelfHeal(full, 'e9', heal)).toBe(false)
        expect(Object.keys(full.doc().engineDB)).toEqual(['e1'])
        await repo.shutdown()
    })
})

describe('defensive startup reads on a {} store doc (engine#567 b)', () => {
    it('createOrUpdateEngine returns undefined, cleanupPhantomEngines does not throw, nothing is written', async () => {
        const repo = new Repo({ network: [] })
        const h = repo.create<any>({})
        const headsBefore = A.getHeads(h.doc())
        await expect(createOrUpdateEngine(h, localEngineId)).resolves.toBeUndefined()
        expect(() => cleanupPhantomEngines(h)).not.toThrow()
        expect(getRunningEngines(h.doc() as Store)).toEqual([])
        expect(h.doc()).toEqual({})
        expect(A.getHeads(h.doc()), 'no change at all, so no engineDB = {}').toEqual(headsBefore)
        await repo.shutdown()
    })

    it('cleanupPhantomEngines with engineDB but no diskDB does not throw and writes nothing', async () => {
        const repo = new Repo({ network: [] })
        const h = repo.create<any>({ engineDB: { x: { id: 'x', hostname: os.hostname() } } })
        const headsBefore = A.getHeads(h.doc())
        expect(() => cleanupPhantomEngines(h)).not.toThrow()
        expect(A.getHeads(h.doc())).toEqual(headsBefore)
        await repo.shutdown()
    })
})

describe('command log guard (engine#567 b)', () => {
    const seedLog = async (content: any): Promise<string> => {
        const repo = new Repo({ storage: new DurableNodeFSStorageAdapter(dataDir), network: [] })
        const h = repo.create<any>(content)
        await repo.flush()
        await repo.shutdown()
        return h.url
    }
    const loadLog = async (url: string) => {
        const urlFile = path.join(tmp, 'command-log-url.txt')
        fs.writeFileSync(urlFile, url)
        fs.writeFileSync(path.join(tmp, 'command-log-day.txt'), localDay(new Date()))   // no startup rotation
        const repo = new Repo({ storage: new DurableNodeFSStorageAdapter(dataDir), network: [] })
        const t0 = Date.now()
        const h = await createCommandLogStore(repo, { urlFile, timeoutMs: 8_000, storeDataDir: dataDir, archiveDir: path.join(tmp, 'archive') })
        const out = { url: h.url, valid: isCommandLogContent(h.doc()), ms: Date.now() - t0, urlFile: fs.readFileSync(urlFile, 'utf8').trim() }
        await repo.flush()
        await repo.shutdown()
        return out
    }

    it('all chunks 0 bytes: quarantined and a fresh log is created at once (no load timeout)', async () => {
        const url = await seedLog({ traces: { t: { a: 1 } }, recentTraceIds: ['t'] })
        const id = url.slice('automerge:'.length)
        const files = allFiles(path.join(dataDir, id.slice(0, 2), id.slice(2))).filter(f => /\/(snapshot|incremental)\//.test(f))
        for (const f of files) fs.truncateSync(f, 0)
        const r = await loadLog(url)
        expect(r.valid).toBe(true)
        expect(r.url).not.toBe(url)
        expect(r.urlFile).toBe(r.url)
        expect(r.ms).toBeLessThan(5_000)
        expect(allFiles(quarantineRootFor(dataDir)).length).toBe(files.length)
    }, 20_000)

    it('a log that loads with invalid content ({}-like) is replaced by a fresh one', async () => {
        const url = await seedLog({ foo: 1 })
        const r = await loadLog(url)
        expect(r.valid).toBe(true)
        expect(r.url).not.toBe(url)
    }, 20_000)

    it('a valid log is kept', async () => {
        const url = await seedLog({ traces: {}, recentTraceIds: [] })
        const r = await loadLog(url)
        expect(r.url).toBe(url)
    }, 20_000)
})


describe('genesis guard: no template heal on a store with its own genesis (engine#567, 2VroE finding)', () => {
    /** A store like idea04's 2VroE: its own root change creates the maps (not the template's). */
    const ownGenesis = () => A.from<any>({
        engineDB: { e1: { id: 'e1', hostname: 'a' }, e2: { id: 'e2', hostname: 'b' } },
        diskDB: { d1: { id: 'd1' } }, instanceDB: { i1: { id: 'i1' } },
        appDB: Object.fromEntries(Array.from({ length: 57 }, (_, i) => [`app${i}`, { id: `app${i}` }])),
    })
    const seedOwn = async () => {
        const full = ownGenesis()
        const dir = path.join(docDir(), 'snapshot')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'own'), A.save(full))
        const r = await open((_h, _r, heal) => heal)   // first good load: records descendsFromTemplate=false
        expect(r).toBeNull()
        expect(readStoreGenesis(storeGenesisPath(dataDir), docId)?.descendsFromTemplate).toBe(false)
        return full
    }

    it('descendsFromTemplate: yes for a template-born doc, no for an own genesis, unknown for an empty doc', () => {
        const roots = templateRootHashes(fs.readFileSync(TRACKED_TEMPLATE))
        expect(roots.length).toBe(1)
        expect(descendsFromTemplate(A.change(A.load<any>(fs.readFileSync(TRACKED_TEMPLATE)), d => { d.x = 1 }), roots)).toBe('yes')
        expect(descendsFromTemplate(ownGenesis(), roots)).toBe('no')
        expect(descendsFromTemplate(A.init(), roots)).toBe('unknown')
    })

    it('all chunks 0 bytes on an own-genesis store: STORE_HEAL_REFUSED, no template, no throw, the marker is set, writes skipped', async () => {
        await seedOwn()
        for (const f of chunkFiles()) fs.truncateSync(f, 0)
        const r = await open((h, _repo, heal) => {
            h.change((d: any) => { d.engineDB = {} })
            expect(() => Object.keys(h.doc().engineDB[localEngineId] ?? {}), 'plain reads do not throw').not.toThrow()
            return { heal, id: h.documentId }
        })
        expect(r.id).toBe(docId)
        expect(Object.keys(diskDoc()), 'no map created, no template merged').toEqual([])
        expect(r.heal?.source).toBe('refused')
        expect(r.heal?.quarantined).toBeGreaterThan(0)
        expect(r.heal?.reason).toMatch(/does not descend.*recorded in store-genesis.json/)
        expect(allFiles(quarantineRootFor(dataDir)).length).toBeGreaterThan(0)
    })

    it('all chunks 0 bytes and NO genesis record: refused as unknown (never a template heal on a guess)', async () => {
        await seedOwn()
        fs.renameSync(storeGenesisPath(dataDir), storeGenesisPath(dataDir) + '.moved')
        for (const f of chunkFiles()) fs.truncateSync(f, 0)
        const heal = await open((_h, _r, heal) => heal)
        expect(heal?.source).toBe('refused')
        expect(heal?.reason).toMatch(/is not known to descend/)
    })

    it('a lost snapshot with incrementals left: refused; the remaining chunks are kept and used', async () => {
        const full = await seedOwn()
        await open(async (h) => { h.change((d: any) => { d.engineDB.e1.hostname = 'a2' }) })   // an incremental on top
        const snaps = allFiles(path.join(docDir(), 'snapshot'))
        for (const f of snaps) fs.writeFileSync(f, fs.readFileSync(f).subarray(0, 40))   // truncated
        const r = await open((h, _repo, heal) => ({ heal }))
        expect(r.heal?.source).toBe('refused')
        expect(Object.keys(diskDoc()).filter(k => k !== 'foo')).toEqual([])
        expect(chunkFiles().length, 'the usable incremental chunks stay in store-data').toBeGreaterThan(0)
        expect(full).toBeTruthy()
    })

    it('a refused doc merged with the full original (peer sync) keeps ALL data: appDB 57 stays 57', async () => {
        const full = await seedOwn()
        for (const f of chunkFiles()) fs.truncateSync(f, 0)
        await open(async (h) => {
            h.change((d: any) => { d.engineDB = {}; d.appDB = {} })   // skipped
        })
        const refusedBytes = A.save(diskDoc())
        const merged = A.merge(A.clone(full), A.load<any>(refusedBytes))
        expect(Object.keys(merged.appDB).length).toBe(57)
        expect(Object.keys(merged.engineDB).sort()).toEqual(['e1', 'e2'])
        expect(A.getConflicts(merged, 'appDB'), 'one appDB object, no competing map').toBeUndefined()
        // the old behaviour (template rebuild) gives competing top-level maps: one of each pair is hidden
        const templ = A.load<any>(fs.readFileSync(TRACKED_TEMPLATE))
        const hidden = A.merge(A.clone(full), templ)
        expect(Object.keys(A.getConflicts(hidden, 'appDB') ?? {}).length).toBe(2)
        expect(Object.keys(A.getConflicts(hidden, 'engineDB') ?? {}).length).toBe(2)
    })

    it('when peer sync brings the maps, writes are enabled again and onStoreMapsArrived runs', async () => {
        const full = await seedOwn()
        for (const f of chunkFiles()) fs.truncateSync(f, 0)
        const repo = new Repo({ storage: new DurableNodeFSStorageAdapter(dataDir), network: [] })
        let arrived = 0
        const h: any = await createServerStore(repo, docId, dataDir, templatePath, { onStoreMapsArrived: () => { arrived++ } })
        h.change((d: any) => { d.x = 1 })
        expect(h.doc().x).toBeUndefined()
        repo.import(A.save(full), { docId })   // what a peer's sync delivers
        await new Promise(r => setTimeout(r, 50))
        expect(arrived).toBe(1)
        expect(Object.keys(h.doc().appDB).length).toBe(57)
        h.change((d: any) => { d.engineDB.e1.hostname = 'z' })
        expect(h.doc().engineDB.e1.hostname).toBe('z')
        await repo.flush(); await repo.storageId(); await repo.shutdown()
    })

    it('store-genesis.json is written once and never overwritten', async () => {
        await seedOwn()
        const f = storeGenesisPath(dataDir)
        const before = fs.readFileSync(f, 'utf8')
        expect(recordStoreGenesis(f, { docId, descendsFromTemplate: true, templateRoots: [], recordedAt: 1 })).toBe(false)
        await open(async () => undefined)
        expect(fs.readFileSync(f, 'utf8')).toBe(before)
        expect(readStoreGenesis(f, 'otherDoc')).toBeNull()
    })

    it('a template-born store still heals from the template when all chunks are 0 bytes', async () => {
        await seedStore()
        expect(readStoreGenesis(storeGenesisPath(dataDir), docId)?.descendsFromTemplate).toBe(true)
        for (const f of chunkFiles()) fs.truncateSync(f, 0)
        const r = await open((h, _repo, heal) => ({ missing: missingStoreMaps(h.doc()), heal }))
        expect(r.heal?.source).toBe('template')
        expect(r.missing).toEqual([])
    })
})
