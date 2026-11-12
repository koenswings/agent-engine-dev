/**
 * borg-list-real.test.ts — helper v9 `borg-list <bdev> <id>` against a real borg.
 *
 * On borg 1.x `borg info --json REPO` (no archive selector) prints repository
 * info only, with no "archives" key, so the 2-arg inventory needs
 * `--glob-archives '*'`. idea03 (borg 1.4.0) failed listBackup / verifyBackup
 * with "borg-list JSON has no archives list" and backup cleanup could never
 * list archives. The fake borg hid this; this test runs the real binary
 * (IDEA_TEST_BORG, else /usr/bin/borg; skipped when neither runs).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { fs, path } from 'zx'
import { parseBorgListJson } from '../../src/utils/backupCleanup.js'
import { borgListArgs } from '../../src/utils/appDataHelper.js'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

const BORG = process.env.IDEA_TEST_BORG || '/usr/bin/borg'
const borgVersion = (() => { try { return execFileSync(BORG, ['--version'], { encoding: 'utf8' }).trim() } catch { return '' } })()

describe.skipIf(!borgVersion)(`helper borg-list inventory with a real borg (${borgVersion || 'not installed'})`, () => {
    let sb: AppDataSandbox | undefined
    afterEach(async () => { if (sb) await fs.remove(sb.tmp); sb = undefined })

    it('2-arg borg-list prints every archive with stats; the Engine parser reads names, times and sizes', async () => {
        sb = await makeAppDataSandbox({ realBorg: true, borgPath: BORG })
        const box = sb
        const run = async (args: string[]) => {
            const r = await box.run(args, { BORG_BASE_DIR: path.join(box.tmp, 'borg-base') })
            if (r.exitCode !== 0) throw new Error(`idea-app-data ${args[0]} failed (${r.exitCode}): ${r.stderr}`)
            return r.stdout
        }
        const app = await box.addDisk('sdb1')
        const bk = await box.addDisk('sdc1', { backup: true })
        const src = path.join(app, 'instances', 'inst-1')
        await fs.ensureDir(path.join(src, 'data'))
        await fs.writeFile(path.join(src, 'data', 'a.txt'), 'hello')
        await fs.ensureDir(path.join(bk, 'backups', 'inst-1'))
        await run(['borg-init', 'sdc1', 'inst-1'])
        const names = ['2026-11-12T02-14-50-000Z', '2026-11-12T02-16-00-000Z', '2026-11-12T02-16-01-000Z']
        for (const n of names) {
            await run(['borg-create', 'sdc1', 'inst-1', n, 'sdb1'])
            await new Promise(r => setTimeout(r, 1100))   // archive times are second-granular
        }
        const out = await run(borgListArgs('sdc1', 'inst-1'))
        const parsed = JSON.parse(out)
        expect(Array.isArray(parsed.archives), `borg-list printed: ${out.slice(0, 400)}`).toBe(true)
        const archives = parseBorgListJson(out)
        expect(archives.map(a => a.name)).toEqual(names)
        for (const a of archives) expect(a.originalSize).toBeGreaterThan(0)
        // and the 3-arg member list still works on the same repo
        const members = await run(borgListArgs('sdc1', 'inst-1', names[2]))
        expect(members).toMatch(/instances\/inst-1\/data\/a\.txt/)
    }, 60_000)
})
