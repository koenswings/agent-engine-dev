/**
 * store-identity-guard.test.ts — refuse a mismatched store-identity (engine#391)
 *
 * At startup, before opening the repo, the Engine refuses when store-data already
 * holds Automerge documents and the identity is unusable or names a document that
 * is not in store-data. A refuse writes nothing. Empty store-data (fresh install /
 * image first boot) and a matching identity start normally.
 *
 *   1. empty store-data + missing identity: the #391 guard lets the normal create
 *      path run (with IDEA_ALLOW_STORE_URL_FALLBACK)
 *   2. matching identity (healthy Engine, or pre-seeded store-data that contains
 *      the store-url's document) starts
 *   3. missing, empty, invalid, or nested identity with non-empty data refuses
 *   4. a usable identity whose document id is not in non-empty store-data refuses
 *   5. --allow-new-store / IDEA_ALLOW_NEW_STORE=1 starts a mismatch
 *   6. a refuse leaves store-identity and store-data byte-for-byte unchanged
 *   7. image first boot: empty store-data + shipped store-url starts; a pre-seeded
 *      store-data that contains the shipped document starts
 *   8. the override is not set in pm2.config.cjs or the image first-boot path
 *
 * Everything runs in a private temp folder: nothing touches the repo's
 * store-identity/ or a live Engine. store-template.json is only copied, never written.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fs } from 'zx'
import { Repo } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { Store, createServerStore } from '../../src/data/Store.js'
import {
    FLEET_STORE_URL,
    STORE_IDENTITY_MISMATCH,
    STORE_IDENTITY_MISMATCH_HINT,
    STORE_IDENTITY_OVERRIDE_ENV,
    STORE_IDENTITY_OVERRIDE_FLAG,
    StoreIdentityMismatchError,
    assertStoreIdentityMatchesData,
    inspectStoreIdentity,
    listStoreDataDocumentIds,
    prepareStoreIdentity,
    storeDataIsNonEmpty,
    storeDocIdFromUrl,
    storeDocumentDir,
    storeIdentityOverrideAllowed,
    storeIdentityPaths,
    StoreIdentityPaths,
} from '../../src/data/StoreIdentity.js'

const ROOT = process.cwd()
const TRACKED_URL = path.join(ROOT, 'store-identity/store-url.txt')
const TRACKED_TEMPLATE = path.join(ROOT, 'store-identity/store-template.json')
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let tmp: string
let identityDir: string
let paths: StoreIdentityPaths
let dataDir: string

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-storeid-guard-'))
    identityDir = path.join(tmp, 'store-identity')
    await fs.ensureDir(identityDir)
    await fs.copy(TRACKED_TEMPLATE, path.join(identityDir, 'store-template.json'))
    paths = storeIdentityPaths(identityDir)
    dataDir = path.join(tmp, 'store-data')
    await fs.ensureDir(dataDir)
})
afterEach(async () => { await fs.remove(tmp) })

const writeUrl = async (url: string) => { await fs.writeFile(paths.urlPath, url) }

/** Seed store-data with one Automerge document under `url` (the identity's or another). */
const seedStoreData = async (url: string): Promise<string> => {
    const storeDocId = storeDocIdFromUrl(url)
    const repo = new Repo({ storage: new NodeFSStorageAdapter(dataDir), network: [] })
    const handle = await createServerStore(repo, storeDocId, dataDir, paths.templatePath)
    await repo.flush()
    const id = handle.documentId
    await repo.shutdown()
    return id
}

/** The store part of startEngine after the #391 guard: prepare the identity, then open the store. */
const startStore = async (allowFallback = true) => {
    const { storeDocId, restored } = await prepareStoreIdentity(paths, { allowFallback })
    const repo = new Repo({ storage: new NodeFSStorageAdapter(dataDir), network: [] })
    const handle = await createServerStore(repo, storeDocId, dataDir, paths.templatePath)
    await repo.flush()
    const result = { storeDocId, restored, documentId: handle.documentId, doc: handle.doc() as Store }
    await repo.shutdown()
    return result
}

const runGuard = (opts?: { allowNewStore?: boolean, env?: NodeJS.ProcessEnv, argv?: readonly string[] }) =>
    assertStoreIdentityMatchesData({
        identityDir,
        dataDir,
        allowNewStore: opts?.allowNewStore,
        env: opts?.env ?? {},
        argv: opts?.argv ?? ['node', 'index.js'],
    })

/** Path, type, mode, and file/link bytes: a refuse must leave this unchanged. */
const treeBytes = async (root: string): Promise<string> => {
    if (!await fs.pathExists(root)) return `${path.basename(root)}:ABSENT\n`
    const lines: string[] = []
    const walk = async (dir: string, rel: string) => {
        const names = (await fs.readdir(dir)).sort()
        for (const name of names) {
            const abs = path.join(dir, name)
            const rec = rel ? `${rel}/${name}` : name
            const st = await fs.lstat(abs)
            const mode = (st.mode & 0o777).toString(8)
            if (st.isSymbolicLink()) {
                lines.push(`${rec} symlink ${mode} ${await fs.readlink(abs)}`)
            } else if (st.isDirectory()) {
                lines.push(`${rec} dir ${mode}`)
                await walk(abs, rec)
            } else if (st.isFile()) {
                const hash = crypto.createHash('sha256').update(await fs.readFile(abs)).digest('hex')
                lines.push(`${rec} file ${mode} ${st.size} ${hash}`)
            } else {
                lines.push(`${rec} other ${mode}`)
            }
        }
    }
    const st = await fs.lstat(root)
    const mode = (st.mode & 0o777).toString(8)
    if (st.isSymbolicLink()) {
        lines.push(`. symlink ${mode} ${await fs.readlink(root)}`)
    } else if (st.isDirectory()) {
        lines.push(`. dir ${mode}`)
        await walk(root, '')
    } else if (st.isFile()) {
        const hash = crypto.createHash('sha256').update(await fs.readFile(root)).digest('hex')
        lines.push(`. file ${mode} ${st.size} ${hash}`)
    }
    return lines.join('\n') + '\n'
}

const snapshotBoth = async () => ({
    identity: await treeBytes(identityDir),
    data: await treeBytes(dataDir),
})

const expectRefuseUnchanged = async () => {
    const before = await snapshotBoth()
    let err: StoreIdentityMismatchError | null = null
    try { runGuard() } catch (e) { err = e as StoreIdentityMismatchError }
    expect(err).to.be.instanceOf(StoreIdentityMismatchError)
    expect(err!.code).to.equal(STORE_IDENTITY_MISMATCH)
    expect(err!.message).to.include(STORE_IDENTITY_MISMATCH)
    expect(err!.message).to.include(STORE_IDENTITY_MISMATCH_HINT)
    expect(err!.message).to.match(/store-identity:/)
    expect(err!.message).to.match(/store-data:/)
    expect(err!.message).to.match(/store-url:/)
    expect(err!.message).to.match(/documents in store-data:/)
    const after = await snapshotBoth()
    expect(after.identity, 'store-identity bytes unchanged').to.equal(before.identity)
    expect(after.data, 'store-data bytes unchanged').to.equal(before.data)
    return err!
}

describe('store identity vs store-data at startup (engine#391)', () => {
    it('empty store-data plus a missing identity: the guard allows the normal create path', async () => {
        await fs.remove(identityDir)
        expect(storeDataIsNonEmpty(dataDir)).to.be.false
        expect(inspectStoreIdentity(identityDir).usable).to.be.false
        expect(() => runGuard()).to.not.throw()
        await fs.ensureDir(identityDir)
        await fs.copy(TRACKED_TEMPLATE, paths.templatePath)
        const started = await startStore(true)
        expect(started.restored).to.be.true
        expect(started.documentId).to.equal(storeDocIdFromUrl(FLEET_STORE_URL))
        expect(listStoreDataDocumentIds(dataDir)).to.include(started.documentId)
    })

    it('a matching identity starts (healthy Engine)', async () => {
        const other = new Repo({ network: [] }).create<Store>({} as Store).url
        await writeUrl(other)
        const id = await seedStoreData(other)
        expect(id).to.equal(storeDocIdFromUrl(other))
        expect(() => runGuard()).to.not.throw()
        const started = await startStore(false)
        expect(started.restored).to.be.false
        expect(started.documentId).to.equal(id)
        expect(await fs.readFile(paths.urlPath, 'utf8')).to.equal(other)
    })

    it('missing identity with non-empty store-data refuses and writes nothing', async () => {
        await seedStoreData(FLEET_STORE_URL)
        await fs.remove(identityDir)
        const err = await expectRefuseUnchanged()
        expect(err.message).to.match(/store-url: missing/)
        expect(err.message).to.include(storeDocIdFromUrl(FLEET_STORE_URL))
    })

    it('missing store-url.txt with non-empty store-data refuses and writes nothing', async () => {
        await seedStoreData(FLEET_STORE_URL)
        expect(fs.existsSync(paths.urlPath)).to.be.false
        const err = await expectRefuseUnchanged()
        expect(err.message).to.match(/store-url: missing/)
    })

    it('empty store-url.txt with non-empty store-data refuses and writes nothing', async () => {
        await seedStoreData(FLEET_STORE_URL)
        await fs.writeFile(paths.urlPath, '  \n')
        const err = await expectRefuseUnchanged()
        expect(err.message).to.match(/store-url: missing/)
    })

    it('an invalid store-url.txt with non-empty store-data refuses and writes nothing', async () => {
        await seedStoreData(FLEET_STORE_URL)
        await fs.writeFile(paths.urlPath, 'not-a-store-url\n')
        const err = await expectRefuseUnchanged()
        expect(err.message).to.match(/store-url: not-a-store-url/)
    })

    it('a bare document id (no automerge: prefix) with non-empty store-data is invalid and refuses', async () => {
        const id = await seedStoreData(FLEET_STORE_URL)
        await fs.writeFile(paths.urlPath, id)
        const err = await expectRefuseUnchanged()
        expect(err.message).to.include(`store-url: ${id}`)
    })

    it('a nested store-identity/store-identity with non-empty store-data refuses, even if store-url.txt looks valid', async () => {
        const nestedTarget = path.join(tmp, 'real-identity')
        await fs.ensureDir(nestedTarget)
        await fs.writeFile(path.join(nestedTarget, 'store-url.txt'), FLEET_STORE_URL)
        await writeUrl(FLEET_STORE_URL)
        await fs.symlink(nestedTarget, path.join(identityDir, 'store-identity'))
        await seedStoreData(FLEET_STORE_URL)
        const err = await expectRefuseUnchanged()
        expect(inspectStoreIdentity(identityDir).reason).to.match(/nested/)
        expect(err.message).to.include(FLEET_STORE_URL)
        expect(fs.existsSync(path.join(identityDir, 'store-identity'))).to.be.true
    })

    it('store-identity as a regular file with non-empty store-data refuses', async () => {
        await seedStoreData(FLEET_STORE_URL)
        await fs.remove(identityDir)
        await fs.writeFile(identityDir, 'not-a-dir')
        const err = await expectRefuseUnchanged()
        expect(err.message).to.match(/store-url: missing/)
    })

    it('a mismatched document id with non-empty store-data refuses and writes nothing', async () => {
        const present = new Repo({ network: [] }).create<Store>({} as Store).url
        const other = new Repo({ network: [] }).create<Store>({} as Store).url
        expect(other).to.not.equal(present)
        await writeUrl(other)
        const presentId = await seedStoreData(present)
        const err = await expectRefuseUnchanged()
        expect(err.message).to.include(`store-url: ${other}`)
        expect(err.message).to.match(new RegExp(`documents in store-data: ${presentId}$`, 'm'))
        expect(listStoreDataDocumentIds(dataDir)).to.deep.equal([presentId])
    })

    it('--allow-new-store starts a mismatched identity', async () => {
        const present = new Repo({ network: [] }).create<Store>({} as Store).url
        const other = new Repo({ network: [] }).create<Store>({} as Store).url
        await writeUrl(other)
        await seedStoreData(present)
        expect(() => runGuard({ argv: ['node', 'index.js', STORE_IDENTITY_OVERRIDE_FLAG] })).to.not.throw()
        const started = await startStore(false)
        expect(started.documentId).to.equal(storeDocIdFromUrl(other))
        expect(listStoreDataDocumentIds(dataDir)).to.include.members([
            storeDocIdFromUrl(present),
            storeDocIdFromUrl(other),
        ])
    })

    it('IDEA_ALLOW_NEW_STORE=1 starts a mismatched identity; other values do not', async () => {
        const present = new Repo({ network: [] }).create<Store>({} as Store).url
        const other = new Repo({ network: [] }).create<Store>({} as Store).url
        await writeUrl(other)
        await seedStoreData(present)
        expect(storeIdentityOverrideAllowed({ IDEA_ALLOW_NEW_STORE: '1' }, ['node'])).to.be.true
        expect(storeIdentityOverrideAllowed({ IDEA_ALLOW_NEW_STORE: 'true' }, ['node'])).to.be.true
        expect(storeIdentityOverrideAllowed({}, ['node'])).to.be.false
        expect(storeIdentityOverrideAllowed({ IDEA_ALLOW_NEW_STORE: '0' }, ['node'])).to.be.false
        expect(storeIdentityOverrideAllowed({ IDEA_ALLOW_NEW_STORE: 'false' }, ['node'])).to.be.false
        expect(() => runGuard({ env: { IDEA_ALLOW_NEW_STORE: '0' } })).to.throw(StoreIdentityMismatchError)
        expect(() => runGuard({ env: { [STORE_IDENTITY_OVERRIDE_ENV]: '1' } })).to.not.throw()
        const started = await startStore(false)
        expect(started.documentId).to.equal(storeDocIdFromUrl(other))
    })
})

describe('Engine image and kit first boot (engine#391)', () => {
    it('empty store-data plus the shipped store-url starts (image / kit first boot)', async () => {
        const shipped = (await fs.readFile(TRACKED_URL, 'utf8')).trim()
        expect(shipped).to.equal(FLEET_STORE_URL)
        await writeUrl(shipped + '\n')
        expect(listStoreDataDocumentIds(dataDir)).to.deep.equal([])
        expect(() => runGuard()).to.not.throw()
        const started = await startStore(false)
        expect(started.restored).to.be.false
        expect(started.documentId).to.equal(storeDocIdFromUrl(shipped))
        expect(Object.keys(started.doc).sort()).to.include.members(['appDB', 'diskDB', 'engineDB', 'instanceDB'])
        expect(listStoreDataDocumentIds(dataDir)).to.include(started.documentId)
        expect((await fs.readFile(paths.templatePath)).equals(await fs.readFile(TRACKED_TEMPLATE)), 'template unchanged').to.be.true
    })

    it('pre-seeded store-data that contains the store-url document starts', async () => {
        const shipped = (await fs.readFile(TRACKED_URL, 'utf8')).trim()
        await writeUrl(shipped)
        const id = await seedStoreData(shipped)
        expect(id).to.equal(storeDocIdFromUrl(shipped))
        expect(fs.existsSync(storeDocumentDir(dataDir, id))).to.be.true
        const identityBefore = await fs.readFile(paths.urlPath)
        const templateBefore = await fs.readFile(paths.templatePath)
        expect(() => runGuard()).to.not.throw()
        const started = await startStore(false)
        expect(started.documentId).to.equal(id)
        expect((await fs.readFile(paths.urlPath)).equals(identityBefore)).to.be.true
        expect((await fs.readFile(paths.templatePath)).equals(templateBefore)).to.be.true
    })

    it('sanitiseRootfs still removes store-data, so a built image first-boots on empty data', async () => {
        const image = await fs.readFile(path.join(ROOT, 'src/install/engineImage.ts'), 'utf8')
        expect(image).to.match(/ENGINE_RUNTIME_PATHS = \['store-data'/)
        expect(src('docs/ENGINE_IMAGE.md')).to.match(/Sanitise has already removed\n`store-data`/)
        expect(src('docs/ENGINE_IMAGE.md')).to.match(/STORE_IDENTITY_MISMATCH/)
    })
})

describe('engine#391 wiring, override and logging', () => {
    it('start.ts runs the guard before any mkdir or prepareStoreIdentity, and index.ts exits 1', () => {
        const start = src('src/start.ts')
        const guardAt = start.indexOf('assertStoreIdentityMatchesData({ identityDir: STORE_IDENTITY_PATH, dataDir: STORE_DATA_PATH })')
        const mkdirDataAt = start.indexOf('Creating the store data folder')
        const mkdirIdAt = start.indexOf('Creating the store identity folder')
        const prepareAt = start.indexOf('prepareStoreIdentity(storeIdentity)')
        expect(guardAt, 'start.ts must call assertStoreIdentityMatchesData').to.be.greaterThan(0)
        expect(mkdirDataAt).to.be.greaterThan(guardAt)
        expect(mkdirIdAt).to.be.greaterThan(guardAt)
        expect(prepareAt).to.be.greaterThan(guardAt)
        const index = src('src/index.ts')
        expect(index).to.match(/process\.exit\(1\)/)
        expect(index).to.match(/Error starting engine/)
    })

    it('pm2.config.cjs and the image first-boot path never set the override', () => {
        const files = [
            'pm2.config.cjs',
            'script/build_image_assets/idea-engine-firstboot',
            'src/install/engineImage.ts',
            'src/install/engineRootfs.ts',
            'src/install/engineImageCli.ts',
        ]
        for (const f of files) {
            const body = src(f)
            expect(body, f).to.not.match(/IDEA_ALLOW_NEW_STORE/)
            expect(body, f).to.not.match(/--allow-new-store/)
        }
        expect(STORE_IDENTITY_OVERRIDE_FLAG).to.equal('--allow-new-store')
        expect(STORE_IDENTITY_OVERRIDE_ENV).to.equal('IDEA_ALLOW_NEW_STORE')
    })

    it('the refusal message names resolved paths and the documents in store-data', async () => {
        const present = new Repo({ network: [] }).create<Store>({} as Store).url
        const other = new Repo({ network: [] }).create<Store>({} as Store).url
        await writeUrl(other)
        const presentId = await seedStoreData(present)
        try { runGuard() } catch (e) {
            const msg = (e as Error).message
            expect(msg).to.include(path.resolve(identityDir))
            expect(msg).to.include(path.resolve(dataDir))
            expect(msg).to.include(`store-url: ${other}`)
            expect(msg).to.include(`documents in store-data: ${presentId}`)
            return
        }
        expect.fail('expected a refusal')
    })

    it('assertStoreIdentityMatchesData logs at error level before throwing', () => {
        const body = src('src/data/StoreIdentity.ts')
        expect(body).to.match(/error\(message\)\s*\n\s*throw new StoreIdentityMismatchError\(message\)/)
        expect(src('src/utils/utils.ts')).to.match(/export const error = \(msg:string\):void => \{\s*\n\s*console\.error/)
    })
})
