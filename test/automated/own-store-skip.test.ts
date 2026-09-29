/**
 * own-store-skip.test.ts — the fleet store URL test on own-store Pis (idea#155)
 *
 * store-identity.test.ts checks that FLEET_STORE_URL matches store-url.txt. A Pi
 * that deliberately keeps its own store (idea04) has its own URL in that file, so
 * the check is skipped there with a clear reason; everywhere else it still runs.
 *
 *   1. Shared-store config (store-url.txt as committed): the test runs
 *   2. Own-store config (a different, well-formed URL in the configured store-url.txt,
 *      committed file = FLEET_STORE_URL): the test is skipped, and the reason names
 *      the file and both URLs
 *   3. A real mismatch is never skipped: committed URL ≠ FLEET_STORE_URL, or a
 *      missing, empty or malformed local file, or no git / an untracked file
 *   4. The configured store identity folder is the one read
 *   5. store-identity.test.ts guards only the fleet URL test, with skipIfOwnStore
 *
 * Every case runs on a throwaway git repo in a temp folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fs } from 'zx'
import { Repo } from '@automerge/automerge-repo'
import { FLEET_STORE_URL, storeIdentityPaths } from '../../src/data/StoreIdentity.js'
import { config } from '../../src/data/Config.js'
import { ownStoreSkipReason, readCommittedFile, skipIfOwnStore } from '../harness/ownStore.js'

const OWN_URL = new Repo({ network: [] }).create({}).url
let root: string

const git = (...args: string[]): string =>
    execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf-8' })

/** A checkout whose committed store-identity/store-url.txt holds `committed`. */
const makeCheckout = async (committed: string, folder = 'store-identity') => {
    await fs.outputFile(path.join(root, folder, 'store-url.txt'), committed)
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
}
const urlFile = (folder = 'store-identity') => path.join(root, folder, 'store-url.txt')
const setLocal = (content: string, folder = 'store-identity') => fs.writeFile(urlFile(folder), content)

/** The guard as the fleet URL test uses it: 'ran' or the skip note. */
const runGuard = (folder = 'store-identity'): string => {
    const ctx = { skip: (note: string): never => { throw Object.assign(new Error('skipped'), { note }) } }
    try {
        skipIfOwnStore(ctx, root, urlFile(folder))
        return 'ran'
    } catch (e) {
        return (e as { note: string }).note
    }
}

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-ownstore-')) })
afterEach(async () => { await fs.remove(root) })

describe('fleet store URL test on own-store Pis (idea#155)', () => {
    it('shared-store config: store-url.txt as committed means the test runs', async () => {
        await makeCheckout(FLEET_STORE_URL)
        expect(ownStoreSkipReason(root, urlFile())).to.equal(null)
        expect(runGuard()).to.equal('ran')
        await setLocal(`${FLEET_STORE_URL}\n`)
        expect(runGuard(), 'a trailing newline is still the fleet URL').to.equal('ran')
    })

    it('own-store config: its own URL in store-url.txt means the test is skipped with a clear reason', async () => {
        await makeCheckout(FLEET_STORE_URL)
        await setLocal(`${OWN_URL}\n`)
        const note = runGuard()
        expect(note).to.not.equal('ran')
        expect(note).to.match(/^own-store Pi: /)
        expect(note).to.include('store-identity/store-url.txt')
        expect(note).to.include(OWN_URL)
        expect(note).to.include(FLEET_STORE_URL)
        expect(note).to.include('idea#155')
        expect(ownStoreSkipReason(root, urlFile())).to.equal(note)
    })

    it('a real mismatch is never skipped: the committed URL differs from FLEET_STORE_URL', async () => {
        await makeCheckout(OWN_URL)
        expect(runGuard(), 'clean checkout with a wrong committed URL').to.equal('ran')
        const other = new Repo({ network: [] }).create({}).url
        await setLocal(other)
        expect(runGuard(), 'wrong committed URL plus a local override').to.equal('ran')
    })

    it('a missing, empty or malformed local store-url.txt is never treated as an own store', async () => {
        await makeCheckout(FLEET_STORE_URL)
        for (const bad of ['', '  \n', 'automerge:', 'not-a-url', `${OWN_URL} extra`, 'automerge:0OIl']) {
            await setLocal(bad)
            expect(runGuard(), JSON.stringify(bad)).to.equal('ran')
        }
        await fs.remove(urlFile())
        expect(runGuard(), 'missing file').to.equal('ran')
    })

    it('without git, or with an untracked store-url.txt, the test runs', async () => {
        await fs.outputFile(urlFile(), OWN_URL)
        expect(readCommittedFile(root, urlFile()), 'not a git checkout').to.equal(null)
        expect(runGuard(), 'not a git checkout').to.equal('ran')

        git('init', '-q')
        await fs.outputFile(path.join(root, 'README'), 'x')
        git('add', 'README')
        git('commit', '-q', '-m', 'init')
        expect(readCommittedFile(root, urlFile()), 'untracked').to.equal(null)
        expect(runGuard(), 'untracked').to.equal('ran')
        expect(readCommittedFile(root, path.join(os.tmpdir(), 'outside.txt')), 'outside the checkout').to.equal(null)
    })

    it('reads the store-url.txt of the configured store identity folder', async () => {
        expect(storeIdentityPaths().urlPath).to.equal(path.join(config.settings.storeIdentityFolder, 'store-url.txt'))
        await makeCheckout(FLEET_STORE_URL, 'custom-identity')
        await setLocal(OWN_URL, 'custom-identity')
        expect(runGuard('custom-identity')).to.include('custom-identity/store-url.txt')
    })

    it('store-identity.test.ts guards only the fleet URL test, with skipIfOwnStore', () => {
        const s = fs.readFileSync(path.join(process.cwd(), 'test/automated/store-identity.test.ts'), 'utf8')
        const guards = s.match(/skipIfOwnStore\(ctx\)/g) ?? []
        expect(guards, 'exactly one guard').to.have.lengthOf(1)
        const fleetTest = s.slice(s.indexOf("it('FLEET_STORE_URL matches"), s.indexOf("it('no store-url.txt"))
        expect(fleetTest).to.match(/^it\('FLEET_STORE_URL matches[^\n]*\(ctx\) => \{\n\s*skipIfOwnStore\(ctx\)\n/)
        expect(fleetTest).to.include('.to.equal(FLEET_STORE_URL)')
        expect(s, 'no other skips in the file').to.not.match(/\.(skip|skipIf|runIf|todo|only)\(/)
    })
})
