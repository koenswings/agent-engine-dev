/**
 * store-identity.test.ts — startup with a missing store-url.txt (idea#120)
 *
 * All Engines share one Automerge store: its URL is the tracked
 * store-identity/store-url.txt, its initial content store-template.json.
 *
 *   1. FLEET_STORE_URL matches the tracked store-url.txt. Skipped, with the reason,
 *      on a Pi that deliberately keeps its own store (idea#155, test/harness/ownStore.ts);
 *      it still runs, and fails on a real mismatch, everywhere else
 *   2. Start with no store-url.txt: the file is written with the fleet URL, the
 *      store opens under the fleet document ID, store-template.json is byte-for-byte
 *      unchanged; a second start reuses the file and the stored document
 *   3. An existing store-url.txt with a different ID (an isolated Engine such as
 *      idea03) is used as it is and never rewritten
 *   4. A missing template stops startup with a clear error and writes nothing
 *   5. No module-load reads of store-url.txt; startup never writes the template
 *
 * Everything runs in a private temp folder (copy of the template, own store data):
 * nothing touches the repo's store-identity/ or a live Engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { fs } from 'zx'
import { Repo } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { Store, createServerStore } from '../../src/data/Store.js'
import {
    FLEET_STORE_URL,
    prepareStoreIdentity,
    readStoreDocId,
    storeDocIdFromUrl,
    storeIdentityPaths,
    writeFileAtomic,
    StoreIdentityPaths,
} from '../../src/data/StoreIdentity.js'
import { skipIfOwnStore } from '../harness/ownStore.js'

const ROOT = process.cwd()
const TRACKED_URL = path.join(ROOT, 'store-identity/store-url.txt')
const TRACKED_TEMPLATE = path.join(ROOT, 'store-identity/store-template.json')
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let tmp: string
let paths: StoreIdentityPaths
let dataDir: string

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-storeid-'))
    const identityDir = path.join(tmp, 'store-identity')
    await fs.ensureDir(identityDir)
    await fs.copy(TRACKED_TEMPLATE, path.join(identityDir, 'store-template.json'))
    paths = storeIdentityPaths(identityDir)
    dataDir = path.join(tmp, 'store-data')
    await fs.ensureDir(dataDir)
})
afterEach(async () => { await fs.remove(tmp) })

/** The store part of startEngine: prepare the identity, then open the store. */
const startStore = async () => {
    const { storeDocId, restored } = await prepareStoreIdentity(paths)
    const repo = new Repo({ storage: new NodeFSStorageAdapter(dataDir), network: [] })
    const handle = await createServerStore(repo, storeDocId, dataDir, paths.templatePath)
    await repo.flush()
    const result = { storeDocId, restored, documentId: handle.documentId, doc: handle.doc() as Store }
    await repo.shutdown()
    return result
}

describe('store identity at startup (idea#120)', () => {
    it('FLEET_STORE_URL matches the tracked store-identity/store-url.txt', (ctx) => {
        skipIfOwnStore(ctx)
        expect(fs.readFileSync(TRACKED_URL, 'utf8').trim()).to.equal(FLEET_STORE_URL)
    })

    it('no store-url.txt: writes the fleet URL, keeps the template, and a second start reuses it', async () => {
        const templateBefore = await fs.readFile(paths.templatePath)
        expect(fs.existsSync(paths.urlPath)).to.be.false

        const first = await startStore()
        expect(first.restored, 'first start restores the file').to.be.true
        expect(await fs.readFile(paths.urlPath, 'utf8')).to.equal(FLEET_STORE_URL)
        expect(first.storeDocId).to.equal(storeDocIdFromUrl(FLEET_STORE_URL))
        expect(first.documentId, 'the store opens under the fleet document ID').to.equal(storeDocIdFromUrl(FLEET_STORE_URL))
        expect(Object.keys(first.doc).sort(), 'seeded from the template').to.include.members(['appDB', 'diskDB', 'engineDB', 'instanceDB'])
        expect((await fs.readFile(paths.templatePath)).equals(templateBefore), 'template bytes unchanged').to.be.true
        expect((await fs.readFile(paths.templatePath)).equals(await fs.readFile(TRACKED_TEMPLATE)), 'still the tracked template').to.be.true
        const docPath = path.join(dataDir, first.storeDocId.slice(0, 2), first.storeDocId.slice(2))
        expect(fs.existsSync(docPath), 'the store document was saved').to.be.true
        expect((await fs.readdir(paths.urlPath.replace(/store-url\.txt$/, ''))).filter(f => f.endsWith('.tmp')), 'no temp file left').to.deep.equal([])

        const mtime = (await fs.stat(paths.urlPath)).mtimeMs
        const second = await startStore()
        expect(second.restored, 'second start reuses the file').to.be.false
        expect(second.documentId).to.equal(first.documentId)
        expect(await fs.readFile(paths.urlPath, 'utf8')).to.equal(FLEET_STORE_URL)
        expect((await fs.stat(paths.urlPath)).mtimeMs, 'file not rewritten').to.equal(mtime)
        expect((await fs.readFile(paths.templatePath)).equals(templateBefore)).to.be.true
    })

    it('an existing store-url.txt with its own store ID is used as it is and never rewritten', async () => {
        const other = new Repo({ network: [] }).create<Store>({} as Store).url
        expect(other).to.not.equal(FLEET_STORE_URL)
        const content = `${other}\n`
        await fs.writeFile(paths.urlPath, content)
        const templateBefore = await fs.readFile(paths.templatePath)

        const started = await startStore()
        expect(started.restored).to.be.false
        expect(started.storeDocId).to.equal(storeDocIdFromUrl(other))
        expect(started.documentId).to.equal(storeDocIdFromUrl(other))
        expect(await fs.readFile(paths.urlPath, 'utf8'), 'file content unchanged').to.equal(content)
        expect((await fs.readFile(paths.templatePath)).equals(templateBefore)).to.be.true
    })

    it('a missing template stops startup with a clear error and writes nothing', async () => {
        await fs.remove(paths.templatePath)
        await expect(prepareStoreIdentity(paths)).rejects.toThrow(/store-template\.json.*missing.*restore it from git/s)
        expect(fs.existsSync(paths.urlPath), 'no store-url.txt written').to.be.false
        expect(fs.existsSync(paths.templatePath), 'no template created').to.be.false
    })

    it('readStoreDocId gives a clear error for a missing or empty file', async () => {
        expect(() => readStoreDocId(paths.urlPath)).to.throw(/not found/)
        await fs.writeFile(paths.urlPath, '  \n')
        expect(() => readStoreDocId(paths.urlPath)).to.throw(/empty/)
    })

    it('writeFileAtomic replaces the file and leaves no temp file', async () => {
        const f = path.join(tmp, 'x.txt')
        await writeFileAtomic(f, 'one')
        await writeFileAtomic(f, 'two')
        expect(await fs.readFile(f, 'utf8')).to.equal('two')
        expect((await fs.readdir(tmp)).filter(n => n.endsWith('.tmp'))).to.deep.equal([])
    })

    it('no module-load reads of store-url.txt; startup never writes the template', () => {
        expect(src('src/data/Network.ts')).to.not.match(/readFileSync\(/)
        expect(src('src/data/Commands.ts')).to.not.match(/store-url\.txt/)
        expect(src('src/start.ts')).to.not.match(/initialiseServerStore|writeFile/)
        expect(src('src/start.ts')).to.match(/prepareStoreIdentity\(storeIdentity\)/)
        for (const f of ['src/start.ts', 'src/data/Store.ts', 'src/data/StoreIdentity.ts']) {
            expect(src(f), `${f} must not create a store with repo.create or write the template`).to.not.match(/repo\.create|writeFile\([^)]*[Tt]emplate/)
        }
    })
})
