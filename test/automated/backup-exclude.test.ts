/**
 * backup-exclude.test.ts — x-app.backup.exclude (agent-engine-dev#241)
 *
 *   - validateBackupExclude / backupExcludeOfCompose / readBackupExclude: good and bad entries
 *   - borgCreateArgs: --exclude <rel> pairs; no excludes gives exactly the old argv
 *   - the root helper idea-app-data borg-create (sandboxed, fake borg): the borg argv
 *     with and without excludes, the same refusals as the Engine, the confinement
 *     refusal (a symlink out of the instance folder), the pair/count checks
 *   - a real borg create through the helper when /usr/bin/borg is installed: borg list
 *     omits the excluded files and keeps the rest
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { fs, os, path } from 'zx'
import {
    validateBackupExclude, backupExcludeOfCompose, readBackupExclude, backupExcludeProblem,
    BACKUP_EXCLUDE_MAX, BACKUP_EXCLUDE_MAX_LEN,
} from '../../src/data/BackupExclude.js'
import { borgCreateArgs } from '../../src/utils/appDataHelper.js'
import { makeAppDataSandbox, AppDataSandbox, HELPER_SOURCE } from '../harness/appDataSandbox.js'

const ARCHIVE = '2026-10-18T10-18-00-123Z'

const GOOD = [
    'data/kolibri/content/storage',
    'data/*.zim',
    'data/**/cache',
    'content/databases/my-db.sqlite3-wal',
    '.cache',
    'a_b/C-d.1',
]
const BAD: [unknown, RegExp][] = [
    ['/data', /absolute/],
    ['../etc', /'\.\.' segment/],
    ['data/../../etc', /'\.\.' segment/],
    ['data/..', /'\.\.' segment/],
    ['./data', /'\.' segment/],
    ['data//x', /empty path segment/],
    ['data/', /empty path segment/],
    ['', /empty/],
    ['-rf', /starts with '-'/],
    ['data x', /character outside/],
    ['data;rm', /character outside/],
    ['data/$HOME', /character outside/],
    ['data/[ab]', /character outside/],
    ['data/?x', /character outside/],
    ['dätä', /character outside/],
    ['a'.repeat(BACKUP_EXCLUDE_MAX_LEN + 1), /longer than/],
    [42, /not a string/],
    [null, /not a string/],
]

describe('x-app.backup.exclude validation (BackupExclude.ts)', () => {
    it('accepts relative paths and globs from the allowed charset', () => {
        for (const g of GOOD) expect(backupExcludeProblem(g), g).toBeNull()
        expect(validateBackupExclude(GOOD)).toEqual(GOOD)
        expect(backupExcludeProblem('a'.repeat(BACKUP_EXCLUDE_MAX_LEN))).toBeNull()
    })

    it('refuses every bad entry with a reason; one bad entry refuses the whole list (nothing silently dropped)', () => {
        for (const [b, re] of BAD) {
            expect(backupExcludeProblem(b), String(b)).toMatch(re)
            expect(() => validateBackupExclude(['data/ok', b]), String(b)).toThrow(/x-app\.backup\.exclude is invalid/)
        }
        expect(() => validateBackupExclude(['/a', '../b'])).toThrow(/'\/a' is absolute.*'\.\.\/b' has a '\.\.' segment/)
    })

    it('refuses a non-list and more than the maximum count; no list means no excludes; duplicates collapse', () => {
        expect(validateBackupExclude(undefined)).toEqual([])
        expect(validateBackupExclude(null)).toEqual([])
        expect(validateBackupExclude([])).toEqual([])
        expect(() => validateBackupExclude('data/x')).toThrow(/must be a list/)
        expect(() => validateBackupExclude({ a: 1 })).toThrow(/must be a list/)
        const many = Array.from({ length: BACKUP_EXCLUDE_MAX + 1 }, (_, i) => `d${i}`)
        expect(() => validateBackupExclude(many)).toThrow(new RegExp(`at most ${BACKUP_EXCLUDE_MAX}`))
        expect(validateBackupExclude(many.slice(0, BACKUP_EXCLUDE_MAX))).toHaveLength(BACKUP_EXCLUDE_MAX)
        expect(validateBackupExclude(['a', 'a', 'b'])).toEqual(['a', 'b'])
    })

    it('reads x-app.backup.exclude from a compose document', () => {
        expect(backupExcludeOfCompose({ services: {} })).toEqual([])
        expect(backupExcludeOfCompose({ 'x-app': { filesMount: {} } })).toEqual([])
        expect(backupExcludeOfCompose({ 'x-app': { backup: {} } })).toEqual([])
        expect(backupExcludeOfCompose({ 'x-app': { backup: { exclude: ['data/*.zim'] } } })).toEqual(['data/*.zim'])
        expect(() => backupExcludeOfCompose({ 'x-app': { backup: ['data'] } })).toThrow(/x-app\.backup must be a mapping/)
        expect(() => backupExcludeOfCompose({ 'x-app': { backup: { exclude: ['/data'] } } })).toThrow(/absolute/)
    })

    it('readBackupExclude: from the instance compose.yaml file; missing file = none; bad YAML or bad list throws naming the file', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bx-'))
        try {
            const f = path.join(dir, 'compose.yaml')
            expect(await readBackupExclude(f)).toEqual([])
            await fs.writeFile(f, 'services: {}\nx-app:\n  backup:\n    exclude:\n      - data/kolibri/content/storage\n      - "data/*.zim"\n')
            expect(await readBackupExclude(f)).toEqual(['data/kolibri/content/storage', 'data/*.zim'])
            await fs.writeFile(f, 'x-app:\n  backup:\n    exclude:\n      - ../../etc\n')
            await expect(readBackupExclude(f)).rejects.toThrow(new RegExp(`${f}: x-app\\.backup\\.exclude is invalid`))
            await fs.writeFile(f, 'x-app: [unclosed\n')
            await expect(readBackupExclude(f)).rejects.toThrow(/could not read x-app\.backup\.exclude/)
        } finally {
            await fs.remove(dir)
        }
    })
})

describe('borgCreateArgs with excludes', () => {
    it('no excludes: exactly the old five words', () => {
        const old = ['borg-create', 'sdc1', 'inst-1', ARCHIVE, 'sdb1']
        expect(borgCreateArgs('sdc1', 'inst-1', ARCHIVE, 'sdb1')).toEqual(old)
        expect(borgCreateArgs('sdc1', 'inst-1', ARCHIVE, 'sdb1', [])).toEqual(old)
    })
    it('each entry becomes --exclude <rel>, in order', () => {
        expect(borgCreateArgs('sdc1', 'inst-1', ARCHIVE, 'system', ['data/a', 'data/*.zim'])).toEqual(
            ['borg-create', 'sdc1', 'inst-1', ARCHIVE, 'system', '--exclude', 'data/a', '--exclude', 'data/*.zim'])
    })
    it('a bad entry never reaches the helper', () => {
        expect(() => borgCreateArgs('sdc1', 'inst-1', ARCHIVE, 'sdb1', ['../x'])).toThrow(/'\.\.' segment/)
        expect(() => borgCreateArgs('sdc1', 'inst-1', ARCHIVE, 'sdb1', ['/etc'])).toThrow(/absolute/)
    })
})

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/^refused: /m)
    expect(r.stderr).toMatch(re)
}

describe('idea-app-data borg-create --exclude (fake borg)', () => {
    let sb: AppDataSandbox
    let app: string
    let bk: string
    let repo: string
    let src: string
    beforeEach(async () => {
        sb = await makeAppDataSandbox()
        app = await sb.addDisk('sdb1')
        bk = await sb.addDisk('sdc1', { backup: true })
        src = await sb.addInstance(app, 'inst1')
        repo = path.join(bk, 'backups', 'inst1')
        await fs.ensureDir(repo)
        await fs.writeFile(path.join(repo, 'config'), '[repository]\n')
    })
    afterEach(async () => { await fs.remove(sb.tmp) })

    it('the source keeps the old borg create line for the no-exclude case', async () => {
        const text = await fs.readFile(HELPER_SOURCE, 'utf8')
        expect(text).toContain('run_child $BORG create --numeric-ids -- "$REPO::$4" "$SRC"\n')
        expect(text).toContain('run_child $BORG create --numeric-ids "${EXCL_ARGS[@]}" -- "$REPO::$4" "$SRC"\n')
    })

    it('no excludes: borg argv byte-identical to before (create --numeric-ids -- <repo>::<archive> <src>)', async () => {
        const r = await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1'])
        expect(r.exitCode, r.stderr).toBe(0)
        const calls = await sb.calls('borg')
        expect(calls.map(c => c.argv)).toEqual([['create', '--numeric-ids', '--', `${repo}::${ARCHIVE}`, src]])
        expect(calls[0].argv.join('\0')).toBe(['create', '--numeric-ids', '--', `${repo}::${ARCHIVE}`, src].join('\0'))
    })

    it('excludes: each becomes --exclude sh:<SRC>/<rel> before --, in order', async () => {
        const r = await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1',
            '--exclude', 'data/sessions', '--exclude', 'data/*.zim', '--exclude', 'not/there/yet'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect((await sb.calls('borg')).map(c => c.argv)).toEqual([[
            'create', '--numeric-ids',
            '--exclude', `sh:${src}/data/sessions`,
            '--exclude', `sh:${src}/data/*.zim`,
            '--exclude', `sh:${src}/not/there/yet`,
            '--', `${repo}::${ARCHIVE}`, src,
        ]])
    })

    it('re-checks every entry with the Engine rules and refuses before borg runs', async () => {
        for (const [b, re] of [
            ['/etc', /does not match|absolute/], ['../x', /'\.\.' segment/], ['data/../../x', /'\.\.' segment/],
            ['./x', /'\.' segment/], ['data//x', /empty path segment/], ['data/', /empty path segment/],
            ['-rf', /starts with '-'/], ['a b', /does not match/], ['a;b', /does not match/], ['a$b', /does not match/],
            ['a'.repeat(201), /does not match/], ['', /does not match/],
        ] as [string, RegExp][]) {
            refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--exclude', b]), re)
        }
        expect(await sb.calls('borg')).toEqual([])
    })

    it('confinement: refuses an entry whose folder part resolves outside the instance folder (symlink)', async () => {
        const outside = path.join(sb.tmp, 'outside')
        await fs.ensureDir(outside)
        await fs.symlink(outside, path.join(src, 'data', 'escape'))
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--exclude', 'data/escape']), /resolves outside the source instance folder/)
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--exclude', 'data/escape/*.zim']), /resolves outside the source instance folder/)
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--exclude', 'data/escape/x']), /resolves outside/)
        expect(await sb.calls('borg')).toEqual([])
        // a symlink that stays inside the instance folder is fine
        const r = await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--exclude', 'data/link-inside'])
        expect(r.exitCode, r.stderr).toBe(0)
    })

    it('refuses an odd tail, a word other than --exclude, and more than 32 excludes', async () => {
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--exclude']), /takes exactly 4 argument/)
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--include', 'x']), /expected --exclude, got '--include'/)
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', '--exclude', 'a', '--patterns-from', '/etc/x']), /expected --exclude/)
        const many = Array.from({ length: 33 }, (_, i) => ['--exclude', `d${i}`]).flat()
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', ...many]), /at most 32/)
        expect(await sb.calls('borg')).toEqual([])
        const ok = Array.from({ length: 32 }, (_, i) => ['--exclude', `d${i}`]).flat()
        expect((await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1', ...ok])).exitCode).toBe(0)
    })
})

const hasBorg = (() => { try { execFileSync('/usr/bin/borg', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe.skipIf(!hasBorg)('idea-app-data borg-create --exclude (real borg)', () => {
    let sb: AppDataSandbox | undefined
    afterEach(async () => { if (sb) await fs.remove(sb.tmp); sb = undefined })

    it('borg list omits the excluded folder and glob matches and keeps everything else', async () => {
        sb = await makeAppDataSandbox({ realBorg: true })
        const box = sb
        const app = await box.addDisk('sdb1')
        const bk = await box.addDisk('sdc1', { backup: true })
        const src = path.join(app, 'instances', 'inst-1')
        await fs.ensureDir(path.join(src, 'data', 'kolibri', 'content', 'storage', 'ab'))
        await fs.writeFile(path.join(src, 'data', 'kolibri', 'content', 'storage', 'ab', 'big.mp4'), 'video')
        await fs.writeFile(path.join(src, 'data', 'kolibri', 'db.sqlite3'), 'db')
        await fs.writeFile(path.join(src, 'data', 'wikipedia.zim'), 'zim')
        await fs.writeFile(path.join(src, 'data', 'library.xml'), 'xml')
        await fs.writeFile(path.join(src, 'compose.yaml'), 'services: {}\n')
        const repo = path.join(bk, 'backups', 'inst-1')
        await fs.ensureDir(repo)
        const run = async (args: string[]) => {
            const r = await box.run(args)
            if (r.exitCode !== 0) throw new Error(`idea-app-data ${args[0]} failed (${r.exitCode}): ${r.stderr}`)
        }
        await run(['borg-init', 'sdc1', 'inst-1'])
        await run(['borg-create', 'sdc1', 'inst-1', ARCHIVE, 'sdb1', '--exclude', 'data/kolibri/content/storage', '--exclude', 'data/*.zim'])
        const env = { ...process.env, BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: 'yes', BORG_RELOCATED_REPO_ACCESS_IS_OK: 'yes', BORG_BASE_DIR: path.join(box.tmp, 'borg-base') }
        const list = execFileSync('/usr/bin/borg', ['list', '--short', `${repo}::${ARCHIVE}`], { env, encoding: 'utf8' })
            .split('\n').filter(Boolean)
        const rel = src.replace(/^\//, '')
        expect(list).toContain(`${rel}/data/kolibri/db.sqlite3`)
        expect(list).toContain(`${rel}/data/library.xml`)
        expect(list).toContain(`${rel}/compose.yaml`)
        expect(list.filter(l => l.includes('content/storage'))).toEqual([])
        expect(list.filter(l => l.endsWith('.zim'))).toEqual([])

        // no excludes: everything is there
        const ARCHIVE2 = '2026-10-18T10-19-00-123Z'
        await run(['borg-create', 'sdc1', 'inst-1', ARCHIVE2, 'sdb1'])
        const all = execFileSync('/usr/bin/borg', ['list', '--short', `${repo}::${ARCHIVE2}`], { env, encoding: 'utf8' })
        expect(all).toContain(`${rel}/data/kolibri/content/storage/ab/big.mp4`)
        expect(all).toContain(`${rel}/data/wikipedia.zim`)
    }, 60_000)
})
