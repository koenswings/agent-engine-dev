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
    flushLogs, pruneCommandLogArchives, liveCommandLogHandle, shutdownRepo,
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

    it('prunes archives older than the retention window and ignores other files', async () => {
        await fs.ensureDir(archiveDir())
        for (const n of ['command-log-2026-09-01-a.automerge', 'command-log-2026-09-28-b.automerge',
                         'command-log-2026-09-29-c.automerge', 'command-log-unknown-d.automerge', 'notes.txt']) {
            await fs.writeFile(path.join(archiveDir(), n), 'x')
        }
        const removed = await pruneCommandLogArchives(archiveDir(), 14, new Date('2026-10-13T00:00:05'))
        expect(removed.sort()).toEqual(['command-log-2026-09-01-a.automerge', 'command-log-2026-09-28-b.automerge'])
        expect((await fs.readdir(archiveDir())).sort()).toEqual(
            ['command-log-2026-09-29-c.automerge', 'command-log-unknown-d.automerge', 'notes.txt'])
    })

    it('start.ts starts the rotation timer', () => {
        expect(fs.readFileSync(path.join(process.cwd(), 'src/start.ts'), 'utf-8')).toContain('startCommandLogRotation(repo)')
    })
})
