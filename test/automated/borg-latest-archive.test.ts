/**
 * borg-latest-archive.test.ts (idea#168)
 *
 * restoreApp ran `borg extract <repo>::latest`, but backupInstance names
 * archives by ISO timestamp and borg 1.x has no `latest` alias ("Archive latest
 * does not exist"). Also, borg stores the absolute source path without its
 * leading '/', so extracting in <mount root>/instances/ produced
 * instances/disks/sdX/instances/<id>/. extractLatestArchive picks the newest
 * archive explicitly and strips the stored prefix.
 *
 *   - latestArchiveFromInfo / extractLatestArchive with a fake borg runner
 *   - a real borg round trip (skipped when borg is not installed)
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { fs, os, path } from 'zx'
import { latestArchiveFromInfo, extractLatestArchive, BorgRunner } from '../../src/monitors/backupMonitor.js'

const info = (name: string, source: string) => JSON.stringify({
    archives: [{ name, command_line: ['/usr/bin/borg', 'create', `/disks/sdb1/backups/inst-1::${name}`, source] }],
})

describe('latestArchiveFromInfo', () => {
    it('App Disk source: the newest archive name and the prefix depth up to instances/', () => {
        expect(latestArchiveFromInfo(info('2026-10-06T01-14-00-000Z', '/disks/sda1/instances/inst-1'), 'inst-1'))
            .toEqual({ name: '2026-10-06T01-14-00-000Z', stripComponents: 3 })
    })
    it('system disk source (/instances/<id>) and a trailing slash', () => {
        expect(latestArchiveFromInfo(info('a1', '/instances/inst-1/'), 'inst-1')).toEqual({ name: 'a1', stripComponents: 1 })
    })
    it('a test mount root of any depth', () => {
        expect(latestArchiveFromInfo(info('a1', '/tmp/idea-test-x/disks/idea-test-3/instances/inst-1'), 'inst-1').stripComponents).toBe(5)
    })
    it('no archives: a clear error', () => {
        expect(() => latestArchiveFromInfo(JSON.stringify({ archives: [] }), 'inst-1')).toThrow('No backup archives found in the repository')
    })
    it('an archive without instances/<id>: a clear error', () => {
        expect(() => latestArchiveFromInfo(info('a1', '/disks/sda1/instances/other'), 'inst-1')).toThrow('Archive a1 does not contain instances/inst-1')
    })
})

describe('extractLatestArchive (fake borg)', () => {
    it('asks borg for the newest archive, then extracts that one (never ::latest) in instancesDir', async () => {
        const calls: { args: string[], cwd?: string }[] = []
        const run: BorgRunner = async (args, cwd) => {
            calls.push({ args, cwd })
            return args[0] === 'info' ? info('2026-10-06T02-00-00-000Z', '/disks/sda1/instances/inst-1') : ''
        }
        const name = await extractLatestArchive('/disks/sdb1/backups/inst-1', '/disks/sdc1/instances', 'inst-1', run)
        expect(name).toBe('2026-10-06T02-00-00-000Z')
        expect(calls).toEqual([
            { args: ['info', '--json', '--last', '1', '/disks/sdb1/backups/inst-1'], cwd: undefined },
            { args: ['extract', '--strip-components', '3', '/disks/sdb1/backups/inst-1::2026-10-06T02-00-00-000Z'], cwd: '/disks/sdc1/instances' },
        ])
        expect(calls.flatMap(c => c.args).some(a => a.endsWith('::latest'))).toBe(false)
    })
    it('a borg failure propagates (restore fails loud)', async () => {
        const run: BorgRunner = async () => { throw new Error('Repository does not exist') }
        await expect(extractLatestArchive('/x', '/y', 'inst-1', run)).rejects.toThrow('Repository does not exist')
    })
})

const hasBorg = (() => { try { execFileSync('borg', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe.skipIf(!hasBorg)('extractLatestArchive (real borg round trip)', () => {
    let tmp = ''
    afterEach(async () => { if (tmp) await fs.remove(tmp) })

    it('restores the newest of two timestamped archives into instances/<id>', async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'borg-latest-'))
        const env = { ...process.env, BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: 'yes' }
        const src = path.join(tmp, 'disks', 'sda1', 'instances', 'inst-1')
        const repo = path.join(tmp, 'repo')
        const target = path.join(tmp, 'target', 'instances')
        await fs.ensureDir(src); await fs.ensureDir(target)
        const borg = (args: string[], cwd?: string) => execFileSync('borg', args, { env, cwd, encoding: 'utf8' })
        borg(['init', '--encryption=none', repo])
        await fs.writeFile(path.join(src, 'data.txt'), 'old')
        borg(['create', `${repo}::2026-10-06T01-00-00-000Z`, src])
        await new Promise(r => setTimeout(r, 1100))   // archive times are second-granular
        await fs.writeFile(path.join(src, 'data.txt'), 'new')
        borg(['create', `${repo}::2026-10-06T02-00-00-000Z`, src])

        // The old command fails: borg 1.x has no 'latest' alias
        expect(() => execFileSync('borg', ['extract', `${repo}::latest`], { env, cwd: target, stdio: 'pipe' })).toThrow()

        const name = await extractLatestArchive(repo, target, 'inst-1', async (args, cwd) => borg(args, cwd))
        expect(name).toBe('2026-10-06T02-00-00-000Z')
        expect(await fs.readFile(path.join(target, 'inst-1', 'data.txt'), 'utf8')).toBe('new')
        expect(await fs.pathExists(path.join(target, 'tmp'))).toBe(false)
    }, 60_000)
})
