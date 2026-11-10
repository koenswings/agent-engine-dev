/**
 * idea-usage-export.test.ts — the forced command for field usage pull (idea#412)
 *
 * The script is invoked directly (sshd runs it as pi; it does not need root).
 * IDEA_USAGE_ROOT points at a temp tree so tests never touch /var/lib/idea/usage.
 * No real keys. Wire format: idea#411 docs/USAGE-CONTRACT.md §7.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path, os } from 'zx'
import { spawn } from 'child_process'

const SCRIPT = path.resolve('script/build_image_assets/idea-usage-export')

interface RunResult { exitCode: number | null, stdout: string, stderr: string }

const run = (opts: { args?: string[], env?: Record<string, string | undefined>, root: string, engine?: string }): Promise<RunResult> =>
    new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, IDEA_USAGE_ROOT: opts.root, IDEA_USAGE_ENGINE: opts.engine ?? 'test-engine' }
        if (opts.env) {
            for (const [k, v] of Object.entries(opts.env)) {
                if (v === undefined) delete env[k]
                else env[k] = v
            }
        }
        const proc = spawn(SCRIPT, opts.args ?? [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', d => { stdout += d })
        proc.stderr.on('data', d => { stderr += d })
        proc.on('error', reject)
        proc.on('close', exitCode => resolve({ exitCode, stdout, stderr }))
    })

const lines = (stdout: string) => stdout.split('\n').filter(Boolean).map(l => JSON.parse(l))

let root = ''
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-usage-export-'))
})
afterEach(async () => { await fs.remove(root) })

const writeOn = async () => {
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ usageMonitoring: 'on' }) + '\n')
}

const writeDay = async (day: string, instance: string, extra: Record<string, unknown> = {}) => {
    const dir = path.join(root, day)
    await fs.ensureDir(dir)
    await fs.writeFile(path.join(dir, `${instance}.json`), JSON.stringify({
        schema: 'idea-usage-day/1', day, app: 'kolibri', instance, ...extra,
    }) + '\n')
}

describe('idea-usage-export: argument checks', () => {
    it('rejects anything but since YYYY-MM-DD and archive-and-clear --before YYYY-MM-DD', async () => {
        const bad = [
            [],
            ['id'],
            ['since'],
            ['since', '2026-13-01'],
            ['since', '2026-02-30'],
            ['since', 'yesterday'],
            ['since', '2026-11-01', 'extra'],
            ['archive-and-clear'],
            ['archive-and-clear', '2026-11-01'],
            ['archive-and-clear', '--before'],
            ['archive-and-clear', '--before', '2026-11-01', 'x'],
            ['since', '2026-11-01;id'],
        ]
        for (const args of bad) {
            const r = await run({ root, args })
            expect(r.exitCode, JSON.stringify(args) + r.stderr).toBe(2)
            expect(r.stdout).toBe('')
            expect(r.stderr).toBe('invalid arguments\n')
        }
    })

    it('rejects shell metacharacters and empty SSH_ORIGINAL_COMMAND with no argv', async () => {
        for (const cmd of ['since 2026-11-01; rm -rf /', 'since 2026-11-01 && id', '$(id)', '`id`', 'since 2026-11-01 | cat']) {
            const r = await run({ root, args: [], env: { SSH_ORIGINAL_COMMAND: cmd } })
            expect(r.exitCode, cmd).toBe(2)
            expect(r.stdout).toBe('')
            expect(r.stderr).toBe('invalid arguments\n')
        }
        const empty = await run({ root, args: [], env: { SSH_ORIGINAL_COMMAND: '' } })
        expect(empty.exitCode).toBe(2)
        expect(empty.stdout).toBe('')
        expect(empty.stderr).toBe('invalid arguments\n')
    })

    it('accepts the two verbs via argv and via SSH_ORIGINAL_COMMAND', async () => {
        await writeOn()
        const viaArgv = await run({ root, args: ['since', '2026-11-01'] })
        expect(viaArgv.exitCode, viaArgv.stderr).toBe(0)
        expect(lines(viaArgv.stdout).at(-1)).toMatchObject({ type: 'end', since: '2026-11-01' })
        const viaEnv = await run({ root, args: ['ignored'], env: { SSH_ORIGINAL_COMMAND: 'archive-and-clear --before 2026-11-01' } })
        expect(viaEnv.exitCode, viaEnv.stderr).toBe(0)
        expect(lines(viaEnv.stdout)).toEqual([expect.objectContaining({ type: 'archived', before: '2026-11-01', days: 0, files: 0 })])
        const viaEq = await run({ root, args: ['archive-and-clear', '--before=2026-11-01'] })
        expect(viaEq.exitCode, viaEq.stderr).toBe(0)
        expect(lines(viaEq.stdout)).toEqual([expect.objectContaining({ type: 'archived', before: '2026-11-01', days: 0, files: 0 })])
    })
})

describe('idea-usage-export: disabled path', () => {
    it('missing settings.json (default off) returns disabled and does not modify files', async () => {
        await fs.ensureDir(path.join(root, '2026-10-01'))
        await fs.writeFile(path.join(root, '2026-10-01', 'inst.json'), '{"schema":"idea-usage-day/1"}\n')
        const r = await run({ root, args: ['since', '2026-01-01'] })
        expect(r.exitCode).toBe(10)
        expect(r.stdout).toBe('')
        expect(r.stderr).toBe('disabled\n')
        expect(await fs.pathExists(path.join(root, '2026-10-01', 'inst.json'))).toBe(true)
        expect(await fs.pathExists(path.join(root, '.archive'))).toBe(false)
    })

    it('usageMonitoring off leaves files untouched for both verbs', async () => {
        await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ usageMonitoring: 'off' }) + '\n')
        await writeDay('2026-10-01', 'kolibri-1')
        const since = await run({ root, args: ['since', '2026-01-01'] })
        expect(since.exitCode).toBe(10)
        expect(since.stdout).toBe('')
        expect(since.stderr).toBe('disabled\n')
        const archive = await run({ root, args: ['archive-and-clear', '--before', '2026-11-01'] })
        expect(archive.exitCode).toBe(10)
        expect(archive.stdout).toBe('')
        expect(archive.stderr).toBe('disabled\n')
        expect(await fs.pathExists(path.join(root, '2026-10-01', 'kolibri-1.json'))).toBe(true)
        expect(await fs.pathExists(path.join(root, '.archive'))).toBe(false)
        expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).toBe(JSON.stringify({ usageMonitoring: 'off' }) + '\n')
    })
})

describe('idea-usage-export: since ordering', () => {
    it('prints presence, then day files by instance, then samples, by day ascending, then end', async () => {
        await writeOn()
        await writeDay('2026-11-10', 'kolibri-a', { kept: false })
        await fs.writeFile(path.join(root, '2026-11-10', 'presence.ndjson'), JSON.stringify({ schema: 'idea-usage-presence/1', ts: 'old' }) + '\n')

        await writeDay('2026-11-12', 'nextcloud-z', { n: 2 })
        await writeDay('2026-11-12', 'kolibri-a', { n: 1 })
        await fs.writeFile(path.join(root, '2026-11-12', 'presence.ndjson'),
            JSON.stringify({ schema: 'idea-usage-presence/1', ts: 'p1' }) + '\n' +
            JSON.stringify({ schema: 'idea-usage-presence/1', ts: 'p2' }) + '\n')
        await fs.writeFile(path.join(root, '2026-11-12', 'nextcloud-z.samples.ndjson'),
            JSON.stringify({ schema: 'idea-usage-sample/1', app: 'nextcloud', i: 1 }) + '\n' +
            JSON.stringify({ schema: 'idea-usage-sample/1', app: 'nextcloud', i: 2 }) + '\n')
        await fs.writeFile(path.join(root, '2026-11-12', 'kolibri-a.samples.ndjson'),
            JSON.stringify({ schema: 'idea-usage-sample/1', app: 'kolibri', i: 0 }) + '\n')

        await writeDay('2026-11-11', 'kolibri-a', { n: 0 })

        const archived = path.join(root, '.archive', '2026-11-01-stamp', '2026-11-20')
        await fs.ensureDir(archived)
        await fs.writeFile(path.join(archived, 'hidden.json'), JSON.stringify({ schema: 'idea-usage-day/1', day: '2026-11-20' }) + '\n')

        const r = await run({ root, args: ['since', '2026-11-11'] })
        expect(r.exitCode, r.stderr).toBe(0)
        const out = lines(r.stdout)
        expect(out.map((o: { type: string, day?: string, instance?: string }) =>
            o.type === 'end' ? 'end' : o.type === 'presence' ? `${o.day}:presence` : `${o.day}:${o.type}:${o.instance}`,
        )).toEqual([
            '2026-11-11:day:kolibri-a',
            '2026-11-12:presence',
            '2026-11-12:presence',
            '2026-11-12:day:kolibri-a',
            '2026-11-12:day:nextcloud-z',
            '2026-11-12:sample:kolibri-a',
            '2026-11-12:sample:nextcloud-z',
            '2026-11-12:sample:nextcloud-z',
            'end',
        ])
        expect(out.at(-1)).toEqual({
            type: 'end',
            schema: 'idea-usage-export/1',
            since: '2026-11-11',
            engine: 'test-engine',
            usageMonitoring: 'on',
            counts: { day: 3, sample: 3, presence: 2 },
            errors: 0,
        })
        expect(out.some((o: { day?: string }) => o.day === '2026-11-10' || o.day === '2026-11-20')).toBe(false)
    })

    it('an empty range is only the end marker; unreadable records increment errors', async () => {
        await writeOn()
        const empty = await run({ root, args: ['since', '2026-12-01'] })
        expect(empty.exitCode, empty.stderr).toBe(0)
        expect(lines(empty.stdout)).toEqual([expect.objectContaining({
            type: 'end', since: '2026-12-01', counts: { day: 0, sample: 0, presence: 0 }, errors: 0,
        })])

        await writeDay('2026-12-02', 'good')
        await fs.writeFile(path.join(root, '2026-12-02', 'bad.json'), 'not-json\n')
        const partial = await run({ root, args: ['since', '2026-12-02'] })
        expect(partial.exitCode, partial.stderr).toBe(0)
        const out = lines(partial.stdout)
        expect(out.filter((o: { type: string }) => o.type === 'day')).toHaveLength(1)
        expect(out.at(-1)).toMatchObject({ type: 'end', counts: { day: 1, sample: 0, presence: 0 }, errors: 1 })
    })
})

describe('idea-usage-export: archive-and-clear is strictly-before', () => {
    it('moves only earlier live day directories into .archive/<before>-<utc>/ and leaves settings.json', async () => {
        await writeOn()
        await writeDay('2026-10-31', 'old')
        await writeDay('2026-11-01', 'boundary')
        await writeDay('2026-11-02', 'keep')
        const settings = await fs.readFile(path.join(root, 'settings.json'), 'utf8')
        const r = await run({ root, args: ['archive-and-clear', '--before', '2026-11-01'] })
        expect(r.exitCode, r.stderr).toBe(0)
        const archived = lines(r.stdout)
        expect(archived).toEqual([expect.objectContaining({
            type: 'archived', schema: 'idea-usage-export/1', before: '2026-11-01', days: 1,
        })])
        expect(archived[0].files).toBeGreaterThanOrEqual(1)
        expect(await fs.pathExists(path.join(root, '2026-10-31'))).toBe(false)
        expect(await fs.pathExists(path.join(root, '2026-11-01', 'boundary.json'))).toBe(true)
        expect(await fs.pathExists(path.join(root, '2026-11-02', 'keep.json'))).toBe(true)
        expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).toBe(settings)
        const stamps = (await fs.readdir(path.join(root, '.archive'))).filter(n => n.startsWith('2026-11-01-'))
        expect(stamps).toHaveLength(1)
        expect(await fs.pathExists(path.join(root, '.archive', stamps[0], '2026-10-31', 'old.json'))).toBe(true)

        const since = await run({ root, args: ['since', '2026-10-01'] })
        const days = lines(since.stdout).filter((o: { type: string }) => o.type === 'day').map((o: { day: string }) => o.day)
        expect(days).toEqual(['2026-11-01', '2026-11-02'])
    })
})
