/**
 * command-log-rotation.test.ts — idea#183: a fresh CommandLog doc per local day.
 *
 * Temp folders only; never store-identity/.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'os'
import { fs, path } from 'zx'
import { Repo } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import {
    CommandLogStore, createCommandLogStore, rotateCommandLog, startCommandLogRotation,
    getCommandLogHandle, setCommandLogHandle, getCommandLogDay, localDay, addTrace, closeTrace,
    flushLogs, capCommandLogArchives, listCommandLogArchives, liveCommandLogHandle, shutdownRepo,
    COMMAND_LOG_CARRY_GRACE_MS,
} from '../../src/data/CommandLogStore.js'

let dir = ''
const urlFile = () => path.join(dir, 'store-identity', 'command-log-url.txt')
const dayFile = () => path.join(dir, 'store-identity', 'command-log-day.txt')
const archiveDir = () => path.join(dir, 'store-identity', 'command-log-archive')
const at = (s: string) => () => new Date(s)
const trace = (id: string, startedAt = Date.now()) => ({
    traceId: id, command: 'test', args: '[]', startedAt, completedAt: null,
    status: 'running' as const, errorMessage: null,
})

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-183-')) })
afterEach(async () => { setCommandLogHandle(null); await fs.remove(dir) })

describe('CommandLog daily rotation (idea#183)', () => {
    it('localDay uses the local timezone date', () => {
        expect(localDay(new Date(2026, 9, 13, 0, 0, 1))).toBe('2026-10-13')
        expect(localDay(new Date(2026, 9, 12, 23, 59, 59))).toBe('2026-10-12')
    })

    it('a fresh doc records today in command-log-day.txt and is not rotated again', async () => {
        const repo = new Repo({ network: [] })
        const h = await createCommandLogStore(repo, { urlFile: urlFile(), now: at('2026-10-13T10:00:00') })
        expect((await fs.readFile(dayFile(), 'utf-8')).trim()).toBe('2026-10-13')
        expect(getCommandLogDay()).toBe('2026-10-13')
        expect(getCommandLogHandle()).toBe(h)
        expect(fs.existsSync(archiveDir())).toBe(false)
    })

    it('rotates at startup when the stored doc is from an earlier day, archives and removes the old doc', async () => {
        const storageDir = path.join(dir, 'store-data')
        const repo1 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const old = await createCommandLogStore(repo1, { urlFile: urlFile(), now: at('2026-10-12T10:00:00') })
        addTrace(old, trace('done-long-ago', 1))
        closeTrace(old, 'done-long-ago', 'ok')
        old.change(d => { d.traces['done-long-ago'].completedAt = 1 })
        await shutdownRepo(repo1)
        setCommandLogHandle(null)

        const repo2 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const h = await createCommandLogStore(repo2, { urlFile: urlFile(), now: at('2026-10-13T00:01:00'), timeoutMs: 5_000 })
        expect(h.url).not.toBe(old.url)
        expect(h.doc()!.recentTraceIds).toEqual([])
        expect((await fs.readFile(urlFile(), 'utf-8')).trim()).toBe(h.url)
        expect((await fs.readFile(dayFile(), 'utf-8')).trim()).toBe('2026-10-13')
        const files = await fs.readdir(archiveDir())
        expect(files).toEqual([`command-log-2026-10-12-${old.documentId}.automerge`])
        const archived = A.load<CommandLogStore>(await fs.readFile(path.join(archiveDir(), files[0])))
        expect(archived.recentTraceIds).toEqual(['done-long-ago'])
        await shutdownRepo(repo2)
        // Old doc no longer in storage
        const docDir = path.join(storageDir, old.documentId.slice(0, 2), old.documentId.slice(2))
        const left = fs.existsSync(docDir) ? (await fs.readdir(docDir, { recursive: true } as any)) as string[] : []
        expect(left.filter(n => !fs.statSync(path.join(docDir, n)).isDirectory())).toEqual([])
    })

    it('a doc without a day file (pre-rotation Engine) is rotated at startup', async () => {
        const storageDir = path.join(dir, 'store-data')
        const repo1 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const old = await createCommandLogStore(repo1, { urlFile: urlFile() })
        await shutdownRepo(repo1)
        await fs.remove(dayFile())
        setCommandLogHandle(null)
        const repo2 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const h = await createCommandLogStore(repo2, { urlFile: urlFile(), timeoutMs: 5_000 })
        expect(h.url).not.toBe(old.url)
        expect((await fs.readdir(archiveDir()))[0]).toMatch(/^command-log-unknown-/)
        await shutdownRepo(repo2)
    })

    it('carries running traces and recently closed ones; old-handle writes land in the new doc', async () => {
        const repo = new Repo({ network: [] })
        const now = new Date('2026-10-13T00:00:30')
        const old = await createCommandLogStore(repo, { urlFile: urlFile(), now: at('2026-10-12T23:00:00'), archiveDir: archiveDir() })
        addTrace(old, trace('stale'));   closeTrace(old, 'stale', 'ok')
        old.change(d => { d.traces['stale'].completedAt = now.getTime() - COMMAND_LOG_CARRY_GRACE_MS - 1 })
        addTrace(old, trace('recent'));  closeTrace(old, 'recent', 'error', 'boom')
        old.change(d => { d.traces['recent'].completedAt = now.getTime() - 1000 })
        addTrace(old, trace('running'))
        flushLogs(old, 'running', [{ level: 'log', message: 'before', timestamp: 1 }])

        const fresh = await rotateCommandLog(repo, { urlFile: urlFile(), now: () => now, archiveDir: archiveDir() })
        expect(getCommandLogHandle()).toBe(fresh)
        expect(fresh.doc()!.recentTraceIds).toEqual(['recent', 'running'])
        expect(fresh.doc()!.traces['recent'].errorMessage).toBe('boom')
        expect(liveCommandLogHandle(old)).toBe(fresh)

        // The command that started before midnight finishes through its old handle
        flushLogs(old, 'running', [{ level: 'log', message: 'after', timestamp: 2 }])
        closeTrace(old, 'running', 'ok')
        const t = fresh.doc()!.traces['running']
        expect(t.status).toBe('ok')
        expect(t.logs.map(l => l.message)).toEqual(['before', 'after'])
        // New commands through the old handle too
        addTrace(old, trace('new-after-midnight'))
        expect(fresh.doc()!.traces['new-after-midnight']).toBeTruthy()
    })

    it('concurrent rotations share one new doc', async () => {
        const repo = new Repo({ network: [] })
        await createCommandLogStore(repo, { urlFile: urlFile(), now: at('2026-10-12T23:00:00'), archiveDir: archiveDir() })
        const opts = { urlFile: urlFile(), now: at('2026-10-13T00:00:10'), archiveDir: archiveDir() }
        const [a, b] = await Promise.all([rotateCommandLog(repo, opts), rotateCommandLog(repo, opts)])
        expect(a).toBe(b)
        expect((await fs.readdir(archiveDir())).length).toBe(1)
    })

    it('the rotation timer rotates once when the local date changes', async () => {
        const repo = new Repo({ network: [] })
        let clock = new Date('2026-10-12T23:59:59')
        const first = await createCommandLogStore(repo, { urlFile: urlFile(), now: () => clock, archiveDir: archiveDir() })
        const stop = startCommandLogRotation(repo, { urlFile: urlFile(), now: () => clock, archiveDir: archiveDir(), intervalMs: 20 })
        try {
            await new Promise(r => setTimeout(r, 80))
            expect(getCommandLogHandle()).toBe(first)
            clock = new Date('2026-10-13T00:00:01')
            const deadline = Date.now() + 3_000
            while (getCommandLogHandle() === first && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
            const second = getCommandLogHandle()
            expect(second).not.toBe(first)
            await new Promise(r => setTimeout(r, 120))
            expect(getCommandLogHandle()).toBe(second)
            expect(getCommandLogDay()).toBe('2026-10-13')
        } finally { stop() }
    })

    const put = async (name: string, bytes: number, mtime?: string) => {
        await fs.ensureDir(archiveDir())
        await fs.writeFile(path.join(archiveDir(), name), Buffer.alloc(bytes, 1))
        if (mtime) { const t = new Date(mtime); await fs.utimes(path.join(archiveDir(), name), t, t) }
    }

    it('size cap: under or at the cap nothing is deleted, whatever the age', async () => {
        await put('command-log-2020-01-01-old.automerge', 400)
        await put('command-log-2026-10-12-b.automerge', 600)
        expect(await capCommandLogArchives(archiveDir(), 1000)).toEqual([])
        expect((await fs.readdir(archiveDir())).length).toBe(2)
    })

    it('size cap: deletes the oldest archives one at a time until the total is under the cap; other files untouched', async () => {
        await put('command-log-2026-10-10-c.automerge', 300)
        await put('command-log-2026-09-01-a.automerge', 300)
        await put('command-log-2026-10-01-b.automerge', 300)
        await put('command-log-2026-10-12-d.automerge', 300)
        await put('notes.txt', 5000)
        const removed = await capCommandLogArchives(archiveDir(), 700)
        expect(removed).toEqual(['command-log-2026-09-01-a.automerge', 'command-log-2026-10-01-b.automerge'])
        expect((await fs.readdir(archiveDir())).sort()).toEqual(
            ['command-log-2026-10-10-c.automerge', 'command-log-2026-10-12-d.automerge', 'notes.txt'])
    })

    it('size cap: same day sorts by mtime; an undated archive sorts by its mtime day', async () => {
        await put('command-log-2026-10-12-new.automerge', 100, '2026-10-12T20:00:00')
        await put('command-log-2026-10-12-early.automerge', 100, '2026-10-12T01:00:00')
        await put('command-log-unknown-x.automerge', 100, '2026-10-11T12:00:00')
        expect((await listCommandLogArchives(archiveDir())).map(f => f.name)).toEqual([
            'command-log-unknown-x.automerge', 'command-log-2026-10-12-early.automerge', 'command-log-2026-10-12-new.automerge'])
        expect(await capCommandLogArchives(archiveDir(), 150)).toEqual(['command-log-unknown-x.automerge', 'command-log-2026-10-12-early.automerge'])
    })

    it('size cap: each deletion is logged', async () => {
        await put('command-log-2026-10-01-a.automerge', 100)
        await put('command-log-2026-10-02-b.automerge', 100)
        const lines: string[] = []
        const orig = console.info
        console.info = (...a: any[]) => { lines.push(a.join(' ')) }
        try { await capCommandLogArchives(archiveDir(), 50) } finally { console.info = orig }
        const del = lines.filter(l => /deleted oldest archive/.test(l))
        expect(del.length).toBe(2)
        expect(del[0]).toContain('command-log-2026-10-01-a.automerge')
        expect(del[1]).toContain('command-log-2026-10-02-b.automerge')
    })

    it('size cap: a check that deletes nothing logs one line with the total and the cap', async () => {
        await put('command-log-2026-10-01-a.automerge', 100)
        await put('command-log-2026-10-02-b.automerge', 200)
        const lines: string[] = []
        const orig = console.info
        console.info = (...a: any[]) => { lines.push(a.join(' ')) }
        try { expect(await capCommandLogArchives(archiveDir(), 1000)).toEqual([]) } finally { console.info = orig }
        expect(lines.filter(l => /command-log archive/.test(l))).toEqual(
            ['[commandLog] command-log archive 300 bytes under cap 1000, nothing deleted'])
        expect(lines.filter(l => /deleted oldest archive/.test(l))).toEqual([])
    })

    it('size cap: a real rotation under the cap logs the check line', async () => {
        const lines: string[] = []
        const orig = console.info
        console.info = (...a: any[]) => { lines.push(a.join(' ')) }
        try {
            const repo = new Repo({ network: [] })
            await createCommandLogStore(repo, { urlFile: urlFile(), now: at('2026-10-12T10:00:00') })
            await rotateCommandLog(repo, { urlFile: urlFile(), now: at('2026-10-13T00:01:00'), archiveMaxBytes: 1_000_000_000 })
        } finally { console.info = orig }
        expect(lines.filter(l => /bytes under cap 1000000000, nothing deleted/.test(l)).length).toBe(1)
    })

    it('size cap is enforced by a real rotation (small cap on a fixture), the new archive is kept', async () => {
        await put('command-log-2026-09-01-a.automerge', 5000)
        await put('command-log-2026-09-02-b.automerge', 5000)
        const repo = new Repo({ network: [] })
        const old = await createCommandLogStore(repo, { urlFile: urlFile(), now: at('2026-10-12T10:00:00') })
        const h = await rotateCommandLog(repo, { urlFile: urlFile(), now: at('2026-10-13T00:01:00'), archiveMaxBytes: 6000 })
        expect(h.url).not.toBe(old.url)
        expect((await fs.readdir(archiveDir())).sort()).toEqual(
            ['command-log-2026-09-02-b.automerge', `command-log-2026-10-12-${old.documentId}.automerge`])
    })

    it('default cap is 1 GB from settings.commandLogArchiveMaxBytes', async () => {
        const { commandLogArchiveMaxBytes, COMMAND_LOG_ARCHIVE_DEFAULT_MAX_BYTES } = await import('../../src/data/Config.js')
        expect(COMMAND_LOG_ARCHIVE_DEFAULT_MAX_BYTES).toBe(1_000_000_000)
        expect(commandLogArchiveMaxBytes()).toBe(1_000_000_000)
    })

    it('start.ts starts the rotation timer', () => {
        expect(fs.readFileSync(path.join(process.cwd(), 'src/start.ts'), 'utf-8')).toContain('startCommandLogRotation(repo)')
    })
})
