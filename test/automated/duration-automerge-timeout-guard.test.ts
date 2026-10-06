/**
 * duration-automerge-timeout-guard.test.ts — r30: the walker tolerates ONLY
 * automerge-repo withTimeout rejections on foreign / unknown / own-CommandLog docs,
 * and fails loud (exit 2) on its OWN store doc and on anything else.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DocHandle, generateAutomergeUrl, parseAutomergeUrl, type DocumentId } from '@automerge/automerge-repo'
import { TimeoutError } from '@automerge/automerge-repo/helpers/withTimeout.js'
import {
    ANNOTATION_KEY,
    PRODUCTION_FLEET_STORE_DOC_ID,
    getTimeoutAnnotation,
    handleUncaughtException,
    handleUnhandledRejection,
    installWhenReadyAnnotation,
    isAutomergeWithTimeout,
    noteDocMessage,
    registerOwnDoc,
    resetTimeoutGuard,
    timeoutSummary,
    toDocumentId,
    trackRepo,
    type GuardIo,
} from '../duration/automergeTimeoutGuard.js'

const newDocId = (): DocumentId => parseAutomergeUrl(generateAutomergeUrl()).documentId

/** A REAL library timeout: a handle that never becomes ready, short timeoutDelay. */
const realTimeoutFor = async (documentId: string): Promise<unknown> => {
    installWhenReadyAnnotation()
    const handle = new DocHandle(documentId as DocumentId, { timeoutDelay: 20 })
    try {
        await handle.whenReady()
    } catch (e) {
        return e
    }
    throw new Error('expected whenReady to time out')
}

const fakeIo = () => {
    const logs: string[] = []
    const errors: unknown[][] = []
    const exits: number[] = []
    const io: GuardIo = { log: l => logs.push(l), error: (...a) => errors.push(a), exit: c => exits.push(c) }
    const events = () => logs.map(l => JSON.parse(l) as Record<string, unknown>)
    return { io, logs, errors, exits, events }
}

beforeEach(() => resetTimeoutGuard())

describe('automergeTimeoutGuard — match is narrow', () => {
    it('matches the real automerge-repo withTimeout TimeoutError', async () => {
        const e = await realTimeoutFor(newDocId())
        expect(e).toBeInstanceOf(TimeoutError)
        expect(isAutomergeWithTimeout(e)).toBe(true)
    })

    it('does not match look-alikes or other errors', () => {
        expect(isAutomergeWithTimeout(new Error('withTimeout: timed out after 60000ms'))).toBe(false)
        const fakeNamed = new Error('withTimeout: timed out after 60000ms'); fakeNamed.name = 'TimeoutError'
        expect(isAutomergeWithTimeout(fakeNamed)).toBe(false) // no automerge-repo origin in stack
        expect(isAutomergeWithTimeout(new TimeoutError('something else timed out'))).toBe(false)
        expect(isAutomergeWithTimeout(new TimeoutError('withTimeout: timed out after 60000ms; extra'))).toBe(false)
        expect(isAutomergeWithTimeout('withTimeout: timed out after 60000ms')).toBe(false)
        expect(isAutomergeWithTimeout(undefined)).toBe(false)
    })

    it('accepts a second automerge-repo copy only by exact message + library stack origin', () => {
        const e = new Error('withTimeout: timed out after 60000ms'); e.name = 'TimeoutError'
        e.stack = 'TimeoutError: withTimeout: timed out after 60000ms\n    at Timeout.<anonymous> (file:///x/node_modules/.pnpm/@automerge+automerge-repo@2.5.2/node_modules/@automerge/automerge-repo/dist/helpers/withTimeout.js:9:45)'
        expect(isAutomergeWithTimeout(e)).toBe(true)
    })
})

describe('automergeTimeoutGuard — whenReady annotation', () => {
    it('annotates the real timeout with the handle documentId/url/state, same error class', async () => {
        const id = newDocId()
        const e = await realTimeoutFor(id)
        const ann = getTimeoutAnnotation(e)
        expect(ann?.documentId).toBe(id)
        expect(ann?.url).toBe(`automerge:${id}`)
        expect(ann?.awaitStates).toEqual(['ready'])
        expect(Object.keys(e as object)).not.toContain(ANNOTATION_KEY) // non-enumerable
        expect((e as Error).message).toMatch(/^withTimeout: timed out after 20ms$/)
    })

    it('install is idempotent and leaves resolution unchanged', async () => {
        installWhenReadyAnnotation(); installWhenReadyAnnotation()
        const h = new DocHandle(newDocId(), { timeoutDelay: 1000 })
        h.update(d => d)
        h.doneLoading()
        await expect(h.whenReady()).resolves.toBeUndefined()
    })

    it('toDocumentId strips automerge: and heads', () => {
        expect(toDocumentId('automerge:abc#h1')).toBe('abc')
        expect(toDocumentId(' abc ')).toBe('abc')
    })
})

describe('automergeTimeoutGuard — policy', () => {
    it('foreign doc (relayed production store) → tolerated, logged with docId + peerId + via', async () => {
        registerOwnDoc('automerge:3zoqdSVsEtj4ygNJPNcDyKWvdxo6', 'store', 'idea01')
        noteDocMessage(PRODUCTION_FLEET_STORE_DOC_ID, 'peer-engine-idea03', 'idea03')
        const f = fakeIo()
        const out = handleUnhandledRejection(await realTimeoutFor(PRODUCTION_FLEET_STORE_DOC_ID), f.io)
        expect(out).toBe('tolerated')
        expect(f.exits).toEqual([])
        const [ev] = f.events()
        expect(ev).toMatchObject({
            event: 'automerge_find_timeout_tolerated',
            class: 'foreign',
            docId: PRODUCTION_FLEET_STORE_DOC_ID,
            peerId: 'peer-engine-idea03',
            via: 'idea03',
            knownAs: 'production-fleet-store (idea02)',
            count: 1,
        })
    })

    it('OWN store doc (3zoqd) → NOT tolerated: fatal event, clear message, exit 2', async () => {
        const own = '3zoqdSVsEtj4ygNJPNcDyKWvdxo6'
        registerOwnDoc(`automerge:${own}`, 'store', 'idea03')
        noteDocMessage(own, 'peer-engine-idea03', 'idea03')
        const f = fakeIo()
        const out = handleUnhandledRejection(await realTimeoutFor(own), f.io)
        expect(out).toBe('fatal')
        expect(f.exits).toEqual([2])
        expect(f.events()[0]).toMatchObject({ event: 'automerge_find_timeout_own_store_fatal', class: 'own', role: 'store', docId: own })
        expect(String(f.errors[0]?.[0])).toMatch(/OWN store doc 3zoqd.*not tolerated/)
        expect(f.events().at(-1)).toMatchObject({ event: 'automerge_find_timeout_summary', byClass: { own: 1 } })
    })

    it('a store id registered later as commandLog stays store (fatal)', async () => {
        const id = newDocId()
        registerOwnDoc(id, 'store', 'idea01'); registerOwnDoc(id, 'commandLog', 'idea03')
        const f = fakeIo()
        expect(handleUnhandledRejection(await realTimeoutFor(id), f.io)).toBe('fatal')
        expect(f.exits).toEqual([2])
    })

    it('own pool CommandLog → tolerated, class own, role commandLog', async () => {
        const cl = newDocId()
        registerOwnDoc(`automerge:${cl}`, 'commandLog', 'idea04')
        const f = fakeIo()
        expect(handleUnhandledRejection(await realTimeoutFor(cl), f.io)).toBe('tolerated')
        expect(f.events()[0]).toMatchObject({ class: 'own', role: 'commandLog', docId: cl, via: 'idea04', peerId: null })
    })

    it('doc id not determinable → tolerated, docId null, class unknown, counted', () => {
        const f = fakeIo()
        const bare = new TimeoutError('withTimeout: timed out after 60000ms') // no annotation
        expect(handleUnhandledRejection(bare, f.io)).toBe('tolerated')
        expect(handleUnhandledRejection(bare, f.io)).toBe('tolerated')
        expect(f.exits).toEqual([])
        expect(f.events()[1]).toMatchObject({ event: 'automerge_find_timeout_tolerated', class: 'unknown', docId: null, count: 2 })
        expect(timeoutSummary()).toMatchObject({ total: 2, unknownCount: 2, byClass: { own: 0, foreign: 0, unknown: 2 } })
    })

    it('unrelated rejections still exit 2 (incl. a non-library look-alike)', () => {
        for (const reason of [new Error('boom'), 'string reason', undefined, Object.assign(new Error('withTimeout: timed out after 60000ms'), { name: 'TimeoutError' })]) {
            const f = fakeIo()
            expect(handleUnhandledRejection(reason, f.io)).toBe('fatal')
            expect(f.exits).toEqual([2])
            expect(f.errors[0]?.[0]).toBe('[duration] unhandledRejection')
        }
    })

    it('uncaughtException always exits 2', () => {
        const f = fakeIo()
        handleUncaughtException(new Error('sync throw'), f.io)
        expect(f.exits).toEqual([2])
    })

    it('summary counts by class and docId', async () => {
        const f = fakeIo()
        const foreign = newDocId(); const cl = newDocId()
        registerOwnDoc(cl, 'commandLog', 'idea01')
        handleUnhandledRejection(await realTimeoutFor(foreign), f.io)
        handleUnhandledRejection(await realTimeoutFor(foreign), f.io)
        handleUnhandledRejection(await realTimeoutFor(cl), f.io)
        handleUnhandledRejection(new TimeoutError('withTimeout: timed out after 60000ms'), f.io)
        const s = timeoutSummary() as { total: number; byClass: Record<string, number>; byDocId: Record<string, { count: number; class: string }> }
        expect(s.total).toBe(4)
        expect(s.byClass).toEqual({ own: 1, foreign: 2, unknown: 1 })
        expect(s.byDocId[foreign]).toMatchObject({ class: 'foreign', count: 2 })
        expect(s.byDocId[cl]).toMatchObject({ class: 'own', role: 'commandLog', count: 1 })
    })

    it('trackRepo records the sending peer per doc from networkSubsystem messages', async () => {
        const ns = new EventEmitter()
        trackRepo({ networkSubsystem: ns as never }, 'idea04')
        const doc = newDocId()
        ns.emit('peer', { peerId: 'engine-peer-1' })
        ns.emit('message', { type: 'sync', senderId: 'engine-peer-1', documentId: doc })
        const f = fakeIo()
        handleUnhandledRejection(await realTimeoutFor(doc), f.io)
        expect(f.events()[0]).toMatchObject({ class: 'foreign', docId: doc, peerId: 'engine-peer-1', via: 'idea04', lastMessageType: 'sync' })
    })
})

describe('automergeTimeoutGuard — real process exit codes', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const guardJs = fileURLToPath(new URL('../duration/automergeTimeoutGuard.js', import.meta.url))
    const guardPath = fs.existsSync(guardJs) ? guardJs : guardJs.replace(/\.js$/, '.ts')
    const run = (body: string) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const g = await import(${JSON.stringify(guardPath)}); g.installProcessGuards(); ${body}`], { cwd: here, encoding: 'utf8', timeout: 30_000 })

    it('an unrelated unhandled rejection kills the process with exit 2', () => {
        const r = run(`Promise.reject(new Error('unrelated boom')); setTimeout(() => {}, 2000)`)
        expect(r.status).toBe(2)
        expect(r.stderr).toMatch(/unhandledRejection/)
    })

    it('a foreign-doc automerge timeout is tolerated and the process keeps running (exit 0)', () => {
        const r = run(`
            const { DocHandle } = await import('@automerge/automerge-repo');
            const h = new DocHandle('${PRODUCTION_FLEET_STORE_DOC_ID}', { timeoutDelay: 20 });
            void h.whenReady();
            setTimeout(() => { console.log('still-alive'); process.exit(0) }, 300)`)
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/"event":"automerge_find_timeout_tolerated".*"class":"foreign"/)
        expect(r.stdout).toMatch(/still-alive/)
    })

    it('an own-store-doc automerge timeout exits 2', () => {
        const r = run(`
            const { DocHandle } = await import('@automerge/automerge-repo');
            g.registerOwnDoc('automerge:3zoqdSVsEtj4ygNJPNcDyKWvdxo6', 'store', 'idea01');
            const h = new DocHandle('3zoqdSVsEtj4ygNJPNcDyKWvdxo6', { timeoutDelay: 20 });
            void h.whenReady();
            setTimeout(() => process.exit(0), 2000)`)
        expect(r.status).toBe(2)
        expect(r.stderr).toMatch(/OWN store doc 3zoqd/)
    })
})
