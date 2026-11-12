/**
 * foreign-command-log.test.ts (#158): a command log stamped with another fleet's
 * storeTag is foreign (never announced or served); ours and untagged ones are not;
 * logs this Engine creates are stamped, and an old untagged own log is backfilled.
 */
import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { fs } from 'zx'
import { Repo } from '@automerge/automerge-repo'
import { isForeignCommandLogContent, isForeignStoreDoc, isForeignStoreDocContent, storeTag } from '../../src/data/StoreScope.js'
import { createCommandLogStore } from '../../src/data/CommandLogStore.js'

const OURS = 'automerge:ourStoreDocAAAA'
const THEIRS = 'automerge:theirStoreDocBB'
const log = (tag?: string) => ({ traces: {}, recentTraceIds: [], ...(tag ? { storeTag: tag } : {}) })

describe('foreign command logs (#158)', () => {
    it('another fleet tag → foreign; our tag or no tag → not', () => {
        expect(isForeignCommandLogContent(OURS, log(storeTag(THEIRS)))).toBe(true)
        expect(isForeignCommandLogContent(OURS, log(storeTag(OURS)))).toBe(false)
        expect(isForeignCommandLogContent(OURS, log())).toBe(false)
        expect(isForeignCommandLogContent(OURS, { traces: {}, storeTag: storeTag(THEIRS) })).toBe(false) // not a command log
        expect(isForeignStoreDocContent(OURS, 'someDoc', log(storeTag(THEIRS)))).toBe(true)
    })

    it('a loaded foreign log is caught by the share/send guard, even when asked for by exact id', async () => {
        const repo = new Repo({ network: [] })
        const foreign = repo.create(log(storeTag(THEIRS)))
        const own = repo.create(log(storeTag(OURS)))
        await foreign.whenReady(); await own.whenReady()
        expect(isForeignStoreDoc(repo as any, OURS, foreign.documentId)).toBe(true)
        expect(isForeignStoreDoc(repo as any, OURS, own.documentId)).toBe(false)
    })

    it('new logs are stamped; an untagged own log is backfilled on load', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cl158-'))
        const urlFile = path.join(dir, 'command-log-url.txt')
        const repo = new Repo({ network: [] })
        const fresh = await createCommandLogStore(repo, { urlFile, storeTag: storeTag(OURS), timeoutMs: 500 })
        expect(fresh.doc().storeTag).toBe(storeTag(OURS))

        const old = repo.create(log())
        await old.whenReady()
        await fs.writeFile(urlFile, old.url)
        const { localDay } = await import('../../src/data/CommandLogStore.js')
        await fs.writeFile(path.join(dir, 'command-log-day.txt'), localDay(new Date()))
        const loaded = await createCommandLogStore(repo, { urlFile, storeTag: storeTag(OURS), timeoutMs: 500 })
        expect(loaded.documentId).toBe(old.documentId)
        expect(loaded.doc().storeTag).toBe(storeTag(OURS))
        await fs.remove(dir)
    })
})
