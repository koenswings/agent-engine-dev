/**
 * command-log-immutable-string.test.ts: engine#471 (b). The long command-log text
 * fields (args, result, errorMessage, error, logs[].message) are written as
 * Automerge ImmutableString; logs written before hold plain strings and must
 * still read the same. Short fields (traceId, command, status, errorCode, level,
 * recentTraceIds, storeTag) stay plain strings.
 *
 * Temp folders only; never store-identity/.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'os'
import { fs, path } from 'zx'
import { spawnSync } from 'child_process'
import { Repo, isImmutableString as repoIsImmutable } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import * as A311 from '@automerge/automerge'
import {
    CommandLogStore, CommandTrace, createCommandLogStore, rotateCommandLog, setCommandLogHandle,
    addTrace, closeTrace, flushLogs, commandLogText, commandLogJson, isLogImmutable, logStr, shutdownRepo,
} from '../../src/data/CommandLogStore.js'
import { readSummaryFromTrace, attachTraceResult, rememberOwnSummaryTrace } from '../../src/data/SummariseDisk.js'
import { REDACTED } from '../../src/utils/redact.js'

let dir = ''
const urlFile = () => path.join(dir, 'store-identity', 'command-log-url.txt')
const archiveDir = () => path.join(dir, 'store-identity', 'command-log-archive')
const at = (s: string) => () => new Date(s)
const running = (id: string, command = 'test', args = '["a"]') => ({
    traceId: id, command, args, startedAt: Date.now(), completedAt: null,
    status: 'running' as const, errorMessage: null,
})
const HASH = '$2b$10$abcdefghijklmnopqrstuuG0b5x1y2z3A4B5C6D7E8F9G0H1I2J3K'

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-471b-')) })
afterEach(async () => { setCommandLogHandle(null); await fs.remove(dir) })

const freshLog = async (repo = new Repo({ network: [] })) => {
    const h = await createCommandLogStore(repo, { urlFile: urlFile(), now: at('2026-11-16T10:00:00') })
    return { repo, h }
}

describe('command-log text fields as ImmutableString (engine#471 b)', () => {
    it('add/flush/close write the long fields as ImmutableString; the short ones stay plain strings', async () => {
        const { h } = await freshLog()
        addTrace(h, running('t1'))
        flushLogs(h, 't1', [{ level: 'warn', message: 'hello', timestamp: 1 }])
        closeTrace(h, 't1', 'error', 'boom', '{"code":7}', 'E_CODE')
        const t = h.doc()!.traces['t1']
        for (const v of [t.args, t.errorMessage, t.error, t.result, t.logs[0].message]) {
            expect(repoIsImmutable(v), String(v)).toBe(true)
        }
        expect(commandLogJson(t.args)).toEqual(['a'])
        expect(commandLogText(t.errorMessage)).toBe('boom')
        expect(commandLogText(t.error)).toBe('boom')
        expect(commandLogJson(t.result)).toEqual({ code: 7 })
        expect(commandLogText(t.logs[0].message)).toBe('hello')
        for (const v of [t.traceId, t.command, t.status, t.errorCode, t.logs[0].level, h.doc()!.recentTraceIds[0]]) {
            expect(typeof v).toBe('string')
        }
        // result is always JSON text, never an object
        expect(typeof commandLogText(t.result)).toBe('string')
    })

    it('mixed doc: an old plain-string log and new traces both read correctly', async () => {
        const repo = new Repo({ network: [] })
        // A log written before engine#471: every field plain text (automerge 3 default)
        const legacy: CommandLogStore = {
            traces: {
                old1: { traceId: 'old1', command: 'summariseDisk', args: '["d1"]', startedAt: Date.now(), completedAt: Date.now(),
                    status: 'ok', errorMessage: null, result: JSON.stringify({ targetId: 'd1', apps: [] }),
                    logs: [{ level: 'log', message: 'old line', timestamp: 1 }] },
                old2: { traceId: 'old2', command: 'eraseDisk', args: '[]', startedAt: 1, completedAt: null,
                    status: 'error', errorMessage: 'old failure', error: 'old failure', logs: [] },
                old3: { traceId: 'old3', command: 'summariseDisk', args: '[]', startedAt: Date.now(), completedAt: Date.now(),
                    status: 'ok', errorMessage: null, result: '', logs: [] },
            },
            recentTraceIds: ['old1', 'old2', 'old3'],
        }
        const h = repo.import<CommandLogStore>(A311.save(A311.from(legacy as any)))
        await h.whenReady()
        setCommandLogHandle(h)
        expect(typeof h.doc()!.traces['old1'].result).toBe('string')   // really the old format

        addTrace(h, running('new1', 'summariseDisk', '["d2"]'))
        attachTraceResult({ targetId: 'd2', apps: [] }, 'new1')
        closeTrace(h, 'new1', 'ok')
        expect(repoIsImmutable(h.doc()!.traces['new1'].result)).toBe(true)

        // readSummaryFromTrace on both kinds; '' result -> null on both kinds
        // (engine#582: only traces this Engine wrote count; a foreign one is ignored)
        expect(readSummaryFromTrace({} as any, 'old1', 'd1')).toBeNull()
        for (const id of ['old1', 'new1', 'old3', 'new3']) rememberOwnSummaryTrace(id)
        expect(readSummaryFromTrace({} as any, 'old1', 'd1')?.targetId).toBe('d1')
        expect(readSummaryFromTrace({} as any, 'new1', 'd2')?.targetId).toBe('d2')
        expect(readSummaryFromTrace({} as any, 'old3', 'd1')).toBeNull()
        addTrace(h, running('new3', 'summariseDisk'))
        closeTrace(h, 'new3', 'ok', undefined, '')
        expect(readSummaryFromTrace({} as any, 'new3', 'd1')).toBeNull()

        // error -> ok guard keeps the old failure; an error close without a message reuses the old text
        closeTrace(h, 'old2', 'ok')
        expect(h.doc()!.traces['old2'].status).toBe('error')
        closeTrace(h, 'old2', 'error')
        const o2 = h.doc()!.traces['old2']
        expect(commandLogText(o2.errorMessage)).toBe('old failure')
        expect(commandLogText(o2.error)).toBe('old failure')

        // readers take both
        expect(commandLogText(h.doc()!.traces['old1'].logs[0].message)).toBe('old line')
        expect(commandLogJson(h.doc()!.traces['old1'].args)).toEqual(['d1'])
        expect(commandLogText(null)).toBeNull()
        expect(commandLogJson('')).toBeNull()
    })

    it('rotation carries a running trace with all five fields as ImmutableString; the archive loads the same values', async () => {
        const storageDir = path.join(dir, 'store-data')
        const repo = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const { h: old } = await freshLog(repo)
        addTrace(old, running('carry', 'test', '{"x":1}'))
        flushLogs(old, 'carry', [{ level: 'log', message: 'line 1', timestamp: 1 }])
        old.change(d => {
            d.traces['carry'].errorMessage = logStr('partial')
            d.traces['carry'].error = logStr('partial')
            d.traces['carry'].result = logStr('{"r":2}')
        })
        const fresh = await rotateCommandLog(repo, { urlFile: urlFile(), archiveDir: archiveDir(), now: at('2026-11-17T00:01:00') })
        const t = fresh.doc()!.traces['carry']
        for (const v of [t.args, t.errorMessage, t.error, t.result, t.logs[0].message]) expect(repoIsImmutable(v)).toBe(true)
        expect(commandLogJson(t.args)).toEqual({ x: 1 })
        expect(commandLogText(t.errorMessage)).toBe('partial')
        expect(commandLogJson(t.result)).toEqual({ r: 2 })
        expect(commandLogText(t.logs[0].message)).toBe('line 1')
        expect(t.status).toBe('running')

        const files = await fs.readdir(archiveDir())
        expect(files.length).toBe(1)
        const archived = A311.load<CommandLogStore>(await fs.readFile(path.join(archiveDir(), files[0])))
        const a = archived.traces['carry']
        expect(A311.isImmutableString(a.args)).toBe(true)
        expect(commandLogText(a.args)).toBe('{"x":1}')
        expect(commandLogText(a.logs[0].message)).toBe('line 1')
        expect(JSON.parse(JSON.stringify(archived)).traces.carry.result).toBe('{"r":2}')   // JSON dumps still serialise as text
        await shutdownRepo(repo)
    })

    it('cross-version: a 3.1.1 ImmutableString is accepted as ImmutableString inside the repo (3.2.x)', async () => {
        const { h } = await freshLog()
        addTrace(h, running('x'))
        h.change(d => { d.traces['x'].result = new A311.ImmutableString('{"v":1}') as any })
        const r = h.doc()!.traces['x'].result
        expect(repoIsImmutable(r)).toBe(true)
        expect(A311.isImmutableString(r)).toBe(true)
        expect(isLogImmutable(r)).toBe(true)
        expect(commandLogText(r)).toBe('{"v":1}')
        // and the Console's tolerant check (symbol, survives two bundled copies)
        expect((r as any)[Symbol.for('_am_immutableString')]).toBe(true)
    })

    it('redaction is applied before wrapping (errorMessage, result, log lines)', async () => {
        const { h } = await freshLog()
        addTrace(h, running('r'))
        closeTrace(h, 'r', 'error', `bad ${HASH}`, JSON.stringify({ passwordHashLike: HASH }))
        const t = h.doc()!.traces['r']
        expect(repoIsImmutable(t.errorMessage)).toBe(true)
        expect(commandLogText(t.errorMessage)).toBe(`bad ${REDACTED}`)
        expect(commandLogText(t.error)).toBe(`bad ${REDACTED}`)
        expect(commandLogText(t.result)).not.toContain('$2b$')
    })

    it('memory: a 4000-entry log loads in a fresh process with far less wasm memory than the text form', async () => {
        const N = 4000
        const line = (i: number) => `[${i}] ` + 'x'.repeat(180)
        const build = (wrap: boolean): Uint8Array => {
            let d = A311.from<any>({ traces: {}, recentTraceIds: [] })
            d = A311.change(d, (doc: any) => {
                doc.traces.t = { traceId: 't', command: 'c', args: wrap ? new A311.ImmutableString('[]') : '[]', status: 'running', logs: [] }
                doc.recentTraceIds.push('t')
            })
            for (let b = 0; b < N; b += 200) {
                d = A311.change(d, (doc: any) => {
                    for (let i = b; i < b + 200; i++) {
                        doc.traces.t.logs.push({ level: 'log', message: wrap ? new A311.ImmutableString(line(i)) : line(i), timestamp: i })
                    }
                })
            }
            return A311.save(d)
        }
        const imm = path.join(dir, 'imm.automerge'), txt = path.join(dir, 'txt.automerge')
        await fs.writeFile(imm, build(true))
        await fs.writeFile(txt, build(false))
        // Fresh process each: wasm memory never shrinks, so measure how far `external` (the wasm heap) grows for one load.
        // Box measurement: about 2 MB as ImmutableString vs about 90 MB as text.
        const script = `
            const A = await import('@automerge/automerge');
            const fs = await import('fs');
            const before = process.memoryUsage().external;
            const d = A.load(fs.readFileSync(process.argv[1]));
            const n = d.traces.t.logs.length;
            const after = process.memoryUsage().external;
            process.stdout.write(JSON.stringify({ n, grownMB: (after - before) / 1048576 }));`
        const run = (file: string) => {
            const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf-8', cwd: process.cwd() })
            if (r.status !== 0) throw new Error(r.stderr)
            return JSON.parse(r.stdout) as { n: number, grownMB: number }
        }
        const a = run(imm), b = run(txt)
        expect(a.n).toBe(N)
        expect(b.n).toBe(N)
        expect(a.grownMB, `ImmutableString log grew wasm by ${a.grownMB} MB (text form ${b.grownMB} MB)`).toBeLessThan(30)
        expect(a.grownMB).toBeLessThan(b.grownMB)
    }, 60_000)
})
