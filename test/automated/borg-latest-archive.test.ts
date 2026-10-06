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
 *   - latestArchiveFromInfo / extractLatestArchive with a fake app-data runner
 *   - a real borg round trip through the app-data root helper (idea-app-data, run
 *     unprivileged in a sandbox; skipped when borg is not installed)
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { fs, path } from 'zx'
import { latestArchiveFromInfo, extractLatestArchive } from '../../src/monitors/backupMonitor.js'
import type { AppDataRunner } from '../../src/utils/appDataHelper.js'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

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

describe('extractLatestArchive (fake app-data runner)', () => {
    it('asks the helper for the newest archive (borg-info), then borg-extract of that one (never ::latest) onto the target root', async () => {
        const calls: string[][] = []
        const run: AppDataRunner = async (args) => {
            calls.push(args)
            return args[0] === 'borg-info' ? info('2026-10-06T02-00-00-000Z', '/disks/sda1/instances/inst-1') : ''
        }
        const name = await extractLatestArchive('sdb1', 'inst-1', 'sdc1', run)
        expect(name).toBe('2026-10-06T02-00-00-000Z')
        expect(calls).toEqual([
            ['borg-info', 'sdb1', 'inst-1'],
            ['borg-extract', 'sdb1', 'inst-1', '2026-10-06T02-00-00-000Z', '3', 'sdc1'],
        ])
        expect(calls.flat().some(a => a.includes('latest'))).toBe(false)
    })
    it('restoring onto the system disk passes the system root token', async () => {
        const calls: string[][] = []
        const run: AppDataRunner = async (args) => { calls.push(args); return args[0] === 'borg-info' ? info('2026-10-06T02-00-00-000Z', '/instances/inst-1') : '' }
        await extractLatestArchive('sdb1', 'inst-1', 'system', run)
        expect(calls[1]).toEqual(['borg-extract', 'sdb1', 'inst-1', '2026-10-06T02-00-00-000Z', '1', 'system'])
    })
    it('a helper failure propagates (restore fails loud)', async () => {
        const run: AppDataRunner = async () => { throw new Error('idea-app-data borg-info refused: repository folder is not a folder') }
        await expect(extractLatestArchive('sdb1', 'inst-1', 'sdc1', run)).rejects.toThrow('refused: repository folder')
    })
    it('an archive name the helper would refuse never reaches it', async () => {
        const calls: string[][] = []
        const run: AppDataRunner = async (args) => { calls.push(args); return info('latest', '/disks/sda1/instances/inst-1') }
        await expect(extractLatestArchive('sdb1', 'inst-1', 'sdc1', run)).rejects.toThrow(/archive/)
        expect(calls.length).toBe(1)
    })
})

const hasBorg = (() => { try { execFileSync('/usr/bin/borg', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe.skipIf(!hasBorg)('extractLatestArchive (real borg round trip through idea-app-data)', () => {
    let sb: AppDataSandbox | undefined
    afterEach(async () => { if (sb) await fs.remove(sb.tmp); sb = undefined })

    it('backs up twice and restores the newest archive into <target>/instances/<id>, numeric owners and modes kept', async () => {
        sb = await makeAppDataSandbox({ realBorg: true })
        const box = sb
        const run: AppDataRunner = async (args) => {
            const r = await box.run(args)
            if (r.exitCode !== 0) throw new Error(`idea-app-data ${args[0]} failed (${r.exitCode}): ${r.stderr}`)
            return r.stdout
        }
        const app = await box.addDisk('sdb1')
        const bk = await box.addDisk('sdc1', { backup: true })
        const target = await box.addDisk('sdd1')
        const src = path.join(app, 'instances', 'inst-1')
        await fs.ensureDir(path.join(src, 'db'))
        await fs.writeFile(path.join(src, 'db', 'secret'), 'old', { mode: 0o600 })
        await fs.ensureDir(path.join(bk, 'backups', 'inst-1'))   // the Engine creates the repo folder as pi
        await run(['borg-init', 'sdc1', 'inst-1'])
        await run(['borg-create', 'sdc1', 'inst-1', '2026-10-06T01-00-00-000Z', 'sdb1'])
        await new Promise(r => setTimeout(r, 1100))   // archive times are second-granular
        await fs.writeFile(path.join(src, 'db', 'secret'), 'new')
        await run(['borg-create', 'sdc1', 'inst-1', '2026-10-06T02-00-00-000Z', 'sdb1'])

        // a stale copy on the target is replaced, not merged
        await fs.ensureDir(path.join(target, 'instances', 'inst-1'))
        await fs.writeFile(path.join(target, 'instances', 'inst-1', 'stale'), 'x')

        const name = await extractLatestArchive('sdc1', 'inst-1', 'sdd1', run)
        expect(name).toBe('2026-10-06T02-00-00-000Z')
        const restored = path.join(target, 'instances', 'inst-1')
        expect(await fs.readFile(path.join(restored, 'db', 'secret'), 'utf8')).toBe('new')
        expect((await fs.stat(path.join(restored, 'db', 'secret'))).mode & 0o777).toBe(0o600)
        expect((await fs.stat(path.join(restored, 'db', 'secret'))).uid).toBe((await fs.stat(path.join(src, 'db', 'secret'))).uid)
        expect(await fs.pathExists(path.join(restored, 'stale'))).toBe(false)
        expect(await fs.readdir(path.join(target, 'instances'))).toEqual(['inst-1'])
        expect(await fs.pathExists(path.join(target, '.idea-app-data-staging'))).toBe(false)

        const borgCalls = (await box.journalText()).split('\n').filter(l => l.includes('sub=borg-')).map(l => l.match(/sub=(\S+)/)![1])
        expect(borgCalls).toEqual(['borg-init', 'borg-create', 'borg-create', 'borg-info', 'borg-extract'])
    }, 60_000)
})
