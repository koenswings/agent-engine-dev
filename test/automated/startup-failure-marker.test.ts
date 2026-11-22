/**
 * startup-failure-marker.test.ts — engine#567 (c): persistent startup-failure marker.
 *
 *   1. recordStartupFailure counts failed starts in logs/engine-startup-failure.json
 *      (count, firstAt kept, lastAt, redacted error), atomically (no temp file left)
 *   2. a corrupt marker starts a new record instead of throwing
 *   3. takeStartupFailure (next good start) archives the file (renamed, not deleted)
 *      and returns the record with recoveredAt; no marker -> null
 *   4. publishStartupFailure writes Engine.lastStartupFailure on this Engine's own
 *      entry only; never creates engineDB or the entry
 *   5. wiring: index.ts records before exit(1) but not on the engine#512 stale exit;
 *      start.ts takes + publishes it at the end of startEngine
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { Repo } from '@automerge/automerge-repo'
import { recordStartupFailure, takeStartupFailure, publishStartupFailure, STARTUP_FAILURE_FILE } from '../../src/data/StartupFailure.js'

let tmp: string, file: string
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-test-startfail-'))
    file = path.join(tmp, 'logs', STARTUP_FAILURE_FILE)
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('startup-failure marker (engine#567 c)', () => {
    it('counts failed starts, keeps firstAt, updates lastAt and the error, atomically', () => {
        const a = recordStartupFailure(new TypeError("Cannot convert undefined or null to object"), { file, now: 1000 })
        const b = recordStartupFailure(new Error('second'), { file, now: 5000 })
        expect(a).toMatchObject({ count: 1, firstAt: 1000, lastAt: 1000 })
        const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(onDisk).toEqual(b)
        expect(onDisk).toEqual({ count: 2, firstAt: 1000, lastAt: 5000, error: 'Error: second' })
        expect(fs.readdirSync(path.dirname(file))).toEqual([STARTUP_FAILURE_FILE])
    })

    it('caps the error at 500 characters and redacts secrets', () => {
        const r = recordStartupFailure(new Error('x'.repeat(2000)), { file, now: 1 })
        expect(r!.error.length).toBe(500)
    })

    it('a corrupt marker starts a new record (never throws)', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, '{not json')
        expect(recordStartupFailure('boom', { file, now: 7 })).toEqual({ count: 1, firstAt: 7, lastAt: 7, error: 'boom' })
    })

    it('takeStartupFailure archives the marker (renamed, not deleted) and returns it with recoveredAt', () => {
        expect(takeStartupFailure({ file, now: 1 })).toBeNull()
        recordStartupFailure(new Error('e'), { file, now: 1000 })
        recordStartupFailure(new Error('e'), { file, now: 2000 })
        const now = new Date(2026, 10, 22, 10, 30, 5).getTime()
        const rec = takeStartupFailure({ file, now })
        expect(rec).toEqual({ count: 2, firstAt: 1000, lastAt: 2000, error: 'Error: e', recoveredAt: now })
        expect(fs.existsSync(file)).toBe(false)
        expect(fs.readdirSync(path.dirname(file))).toEqual(['engine-startup-failure-20261122T103005.json'])
        // the next failure starts a new count
        expect(recordStartupFailure(new Error('again'), { file, now: now + 1 })!.count).toBe(1)
    })

    it('publishStartupFailure writes only on this Engine\'s own entry', async () => {
        const repo = new Repo({ network: [] })
        const rec = { count: 817, firstAt: 1, lastAt: 2, error: 'TypeError: x', recoveredAt: 3 }
        const empty = repo.create<any>({})
        expect(publishStartupFailure(empty, 'e1', rec)).toBe(false)
        expect(empty.doc()).toEqual({})
        const h = repo.create<any>({ engineDB: { e1: { id: 'e1' } } })
        expect(publishStartupFailure(h, 'e1', rec)).toBe(true)
        expect(h.doc().engineDB.e1.lastStartupFailure).toEqual(rec)
        expect(publishStartupFailure(h, 'e2', rec)).toBe(false)
        expect(Object.keys(h.doc().engineDB)).toEqual(['e1'])
        await repo.shutdown()
    })

    it('wiring: index.ts records before exit(1), not on the engine#512 stale exit; start.ts publishes at the end of startEngine', () => {
        const idx = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8')
        const stale = idx.indexOf('if (staleStoreExitPending()) return;')
        const rec = idx.indexOf('recordStartupFailure(error);')
        const exit = idx.indexOf('process.exit(1)')
        expect(stale).toBeGreaterThan(0)
        expect(rec).toBeGreaterThan(stale)
        expect(exit).toBeGreaterThan(rec)
        const start = fs.readFileSync(path.join(process.cwd(), 'src/start.ts'), 'utf8')
        const take = start.indexOf('const startupFailure = takeStartupFailure()')
        expect(take).toBeGreaterThan(start.indexOf('enableTimeMonitor(heartbeatIntervalMs'))
        expect(start.indexOf('publishStartupFailure(storeHandle, String(localEngineId), startupFailure)')).toBeGreaterThan(take)
    })
})
