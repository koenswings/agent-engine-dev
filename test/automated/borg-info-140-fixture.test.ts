/**
 * borg-info-140-fixture.test.ts (idea#450, helper v10)
 *
 * Real borg 1.4.0 `info --json` output, captured on the box (paths, host and user
 * sanitised), in test/fixtures/borg-1.4.0/:
 *   info-json-repo.json            `borg info --json -- REPO`: repository info only, NO "archives" key
 *   info-json-glob-archives.json   `borg info --json --glob-archives '*' -- REPO`: archives[] with stats
 * The fake borg prints the first without an archive selector and the second with one,
 * so these tests run without a real borg binary (borg-list-real.test.ts covers that).
 * They prove the v9 call shape fails on borg 1.4 output and the v10 helper + parser work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { fileURLToPath } from 'url'
import { parseBorgListJson } from '../../src/utils/backupCleanup.js'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

// tests run from dist-test/test/automated; the fixtures stay in the source tree
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/borg-1.4.0')
const REPO_ONLY = fs.readFileSync(path.join(FIXTURES, 'info-json-repo.json'), 'utf8')
const GLOB = fs.readFileSync(path.join(FIXTURES, 'info-json-glob-archives.json'), 'utf8')
const NAMES = ['2026-11-12T02-14-50-000Z', '2026-11-12T02-16-00-000Z', '2026-11-12T02-16-01-000Z']
const V9_CALL = `run_child $BORG info --json -- "$REPO"`
const V10_CALL = `run_child $BORG info --json --glob-archives '*' -- "$REPO"`

describe('borg 1.4.0 info --json fixtures (idea#450)', () => {
    it('the repo-level fixture is real borg 1.4 output with no archives key, and the parser refuses it', () => {
        const d = JSON.parse(REPO_ONLY)
        expect(Object.keys(d).sort()).toEqual(['cache', 'encryption', 'repository', 'security_dir'])
        expect(d).not.toHaveProperty('archives')
        expect(() => parseBorgListJson(REPO_ONLY)).toThrow(/did not return an archives list/)
    })

    it('the --glob-archives fixture parses: 3 archives with names, times and original sizes', () => {
        const archives = parseBorgListJson(GLOB)
        expect(archives.map(a => a.name)).toEqual(NAMES)
        for (const a of archives) expect(a.originalSize).toBeGreaterThan(0)
    })
})

describe('helper borg-list on borg 1.4.0 output: v9 call shape fails, v10 works (idea#450)', () => {
    let sb: AppDataSandbox
    let repo: string
    const env = { FAKE_BORG_INFO_REPO: REPO_ONLY, FAKE_BORG_INFO: GLOB }
    beforeEach(async () => {
        sb = await makeAppDataSandbox()
        const bk = await sb.addDisk('sdc1', { backup: true })
        repo = path.join(bk, 'backups', 'inst-1')
        await fs.ensureDir(repo)
        await fs.writeFile(path.join(repo, 'config'), '[repository]\n')
    })
    afterEach(async () => { await fs.remove(sb.tmp) })

    it('v10 helper: borg-list runs info --json --glob-archives * and its output parses', async () => {
        expect(await fs.readFile(sb.script, 'utf8')).toContain(V10_CALL)
        const r = await sb.run(['borg-list', 'sdc1', 'inst-1'], env)
        expect(r.exitCode, r.stderr).toBe(0)
        const [info] = await sb.calls('borg')
        expect(info.argv).toEqual(['info', '--json', '--glob-archives', '*', '--', repo])
        expect(parseBorgListJson(r.stdout).map(a => a.name)).toEqual(NAMES)
    })

    it('the v9 call shape (info --json -- REPO) gets the repo-level output and the parser throws', async () => {
        const src = await fs.readFile(sb.script, 'utf8')
        expect(src).toContain(V10_CALL)
        await fs.writeFile(sb.script, src.replace(V10_CALL, V9_CALL))
        const r = await sb.run(['borg-list', 'sdc1', 'inst-1'], env)
        expect(r.exitCode, r.stderr).toBe(0)
        const [info] = await sb.calls('borg')
        expect(info.argv).toEqual(['info', '--json', '--', repo])
        expect(JSON.parse(r.stdout)).toEqual(JSON.parse(REPO_ONLY))
        expect(() => parseBorgListJson(r.stdout)).toThrow(/did not return an archives list/)
    })
})
