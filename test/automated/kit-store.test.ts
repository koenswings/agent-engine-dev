/**
 * kit-store.test.ts — Engine images ship the kit store (idea#452)
 *
 * Koen, 2026-11-12: new Engine images ship on the kit store 3Vvv… that the
 * Zimbabwe kits share, not the unused 4GQm… default. An image carries the
 * git-tracked store-identity/ files byte-for-byte, so the committed
 * store-url.txt and FLEET_STORE_URL decide which store a flashed Pi joins.
 *
 *   1. FLEET_STORE_URL is the kit store, and the committed store-url.txt (git HEAD,
 *      so this also holds on a pool Pi whose local file is 2VroE) is the same value
 *   2. Neither is the dev pool store (2VroE), the retired 4GQm or 3zoqd
 *   3. The idea#120 fallback: without store-url.txt startup refuses and names the
 *      kit store; with IDEA_ALLOW_STORE_URL_FALLBACK it writes the kit store and the
 *      store-url.restored marker (peer access fails closed until Ops confirms)
 *   4. A pool Pi's own store-url.txt (2VroE) is used as it is, never replaced
 *
 * Cases 3 and 4 run in a private temp folder; nothing touches the repo's store-identity/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { fs } from 'zx'
import {
    FLEET_STORE_URL,
    prepareStoreIdentity,
    restoredMarkerPath,
    storeDocIdFromUrl,
    StoreIdentityPaths,
} from '../../src/data/StoreIdentity.js'
import { readCommittedFile } from '../harness/ownStore.js'

const KIT_STORE_URL = 'automerge:3Vvvigx8bKcuwKALqMVz85GhDqrk'
const POOL_STORE_URL = 'automerge:2VroEUvDkmYsDAwE5oG9YeFNadWH'
const RETIRED = ['automerge:4GQmEZehPDfryGDxkFo9XixbvmAC', 'automerge:3zoqd']
const REPO = process.cwd()
const TRACKED_URL = path.join(REPO, 'store-identity', 'store-url.txt')
const TRACKED_TEMPLATE = path.join(REPO, 'store-identity', 'store-template.json')

/** The committed store-url.txt; the working file when git can't give it (e.g. a source tarball). */
const committedStoreUrl = (): string =>
    readCommittedFile(REPO, TRACKED_URL) ?? fs.readFileSync(TRACKED_URL, 'utf-8').trim()

describe('Engine images ship the kit store (idea#452)', () => {
    it('FLEET_STORE_URL is the kit store 3Vvv…', () => {
        expect(FLEET_STORE_URL).to.equal(KIT_STORE_URL)
    })

    it('the committed store-identity/store-url.txt is the kit store (what an image ships)', () => {
        expect(committedStoreUrl()).to.equal(KIT_STORE_URL)
        expect(committedStoreUrl()).to.equal(FLEET_STORE_URL)
    })

    it('the shipped store is neither the dev pool store nor a retired one', () => {
        for (const url of [FLEET_STORE_URL, committedStoreUrl()]) {
            expect(url).to.not.equal(POOL_STORE_URL)
            for (const old of RETIRED) expect(url.startsWith(old), `${url} is retired ${old}`).to.be.false
        }
    })
})

describe('idea#120 fallback with the kit store (idea#452)', () => {
    let tmp: string
    let paths: StoreIdentityPaths
    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-kitstore-'))
        await fs.copy(TRACKED_TEMPLATE, path.join(tmp, 'store-template.json'))
        paths = { urlPath: path.join(tmp, 'store-url.txt'), templatePath: path.join(tmp, 'store-template.json') }
    })
    afterEach(async () => { await fs.remove(tmp) })

    it('missing store-url.txt, fallback off (the default): refuses to start, names the kit store, writes nothing', async () => {
        await expect(prepareStoreIdentity(paths, { allowFallback: false }))
            .rejects.toThrow(new RegExp(`refusing to start.*${KIT_STORE_URL}`, 's'))
        expect(fs.existsSync(paths.urlPath)).to.be.false
        expect(fs.existsSync(restoredMarkerPath(paths))).to.be.false
    })

    it('missing store-url.txt, fallback on: writes the kit store and the store-url.restored marker', async () => {
        const r = await prepareStoreIdentity(paths, { allowFallback: true })
        expect(r.restored).to.be.true
        expect(r.fallback, 'peer access fails closed until Ops confirms the store').to.be.true
        expect(r.storeDocId).to.equal(storeDocIdFromUrl(KIT_STORE_URL))
        expect(await fs.readFile(paths.urlPath, 'utf8')).to.equal(KIT_STORE_URL)
        expect(await fs.readFile(restoredMarkerPath(paths), 'utf8')).to.equal(KIT_STORE_URL + '\n')
    })

    it("a pool Pi's own store-url.txt (2VroE) is used as it is, fallback on or off", async () => {
        await fs.writeFile(paths.urlPath, POOL_STORE_URL + '\n')
        for (const allowFallback of [false, true]) {
            const r = await prepareStoreIdentity(paths, { allowFallback })
            expect(r.restored).to.be.false
            expect(r.fallback).to.be.false
            expect(r.storeDocId).to.equal(storeDocIdFromUrl(POOL_STORE_URL))
            expect(await fs.readFile(paths.urlPath, 'utf8')).to.equal(POOL_STORE_URL + '\n')
        }
    })
})
