/**
 * idea-app-data-temp-backup.test.ts — helper v18 temp-backup-* verbs (engine#469).
 *
 * The temporary pre-update backup lives only under <system>/.idea-temp-backups/<id>/<stamp>/.
 * temp-backup-delete is Koen's exception to quarantine-not-delete, so its refusals (symlinks,
 * bad tokens, anything outside that subtree) are checked like #415 clean-verify. Fake borg for
 * argv and refusals; the real borg (IDEA_TEST_BORG, else /usr/bin/borg) for create → restore →
 * delete end to end. Same sandbox as idea-app-data-script.test.ts (never root, never /disks).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'
import { tempBackupCreateArgs, tempBackupDeleteArgs, tempBackupRestoreArgs, tempBackupEstimateArgs, tempBackupsArgs, parseTempBackupCreate, parseTempBackupEstimate, parseTempBackups } from '../../src/utils/appDataHelper.js'

const STAMP = '20261116T080000Z'
const ARCH = '2026-11-16T08-00-00-000Z-stop'
const created: AppDataSandbox[] = []
const sandbox = async (o: Parameters<typeof makeAppDataSandbox>[0] = {}) => { const s = await makeAppDataSandbox(o); created.push(s); return s }
afterEach(async () => { for (const s of created.splice(0)) await fs.remove(s.tmp) })

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(re)
}
const tb = (s: AppDataSandbox, id = 'inst-1', stamp = STAMP) => path.join(s.sys, '.idea-temp-backups', id, stamp)

describe('idea-app-data v18 temp-backup verbs: argument checks', () => {
    it('wrong argument counts and bad tokens are refused before anything is touched', async () => {
        const sb = await sandbox()
        refused(await sb.run(['temp-backup-delete', 'inst-1']), /temp-backup-delete takes exactly 2 argument/)
        refused(await sb.run(['temp-backup-delete', 'inst-1', STAMP, 'x']), /takes exactly 2 argument/)
        refused(await sb.run(['temp-backup-restore', 'system', 'inst-1']), /takes exactly 3 argument/)
        refused(await sb.run(['temp-backup-create', 'system', 'inst-1', STAMP]), /takes at least 4 argument/)
        refused(await sb.run(['temp-backup-estimate', 'system']), /takes at least 2 argument/)
        refused(await sb.run(['temp-backups', 'x']), /takes exactly 0 argument/)
        refused(await sb.run(['temp-backup-delete', '../inst-1', STAMP]), /instance id/)
        refused(await sb.run(['temp-backup-delete', 'inst-1', '../../etc']), /stamp/)
        refused(await sb.run(['temp-backup-delete', 'inst-1', '-rf']), /looks like an option/)
        refused(await sb.run(['temp-backup-create', 'system', 'inst-1', STAMP, 'not-an-archive']), /archive name/)
        refused(await sb.run(['temp-backup-create', '/etc', 'inst-1', STAMP, ARCH]), /root '\/etc'/)
        expect(await fs.pathExists(path.join(sb.sys, '.idea-temp-backups'))).toBe(false)
    })
})

describe('idea-app-data v18 temp-backup-create / estimate / list (fake borg)', () => {
    it('creates a verified Borg repo on the system disk with SOURCE, ARCHIVE, EXCLUDE and COMPLETE last', async () => {
        const sb = await sandbox()
        const app = await sb.addDisk('sdb1')
        await sb.addInstance(app, 'inst-1')
        await fs.ensureDir(path.join(app, 'instances', 'inst-1', 'data', 'keys'))
        const r = await sb.run(tempBackupCreateArgs('sdb1', 'inst-1', STAMP, ARCH, ['keys']))
        expect(r.exitCode, r.stderr).toBe(0)
        const res = parseTempBackupCreate(r.stdout)
        expect(res.path).toBe(tb(sb))
        expect((await fs.readFile(path.join(tb(sb), 'SOURCE'), 'utf8')).trim()).toBe(path.join(app, 'instances', 'inst-1'))
        expect((await fs.readFile(path.join(tb(sb), 'ARCHIVE'), 'utf8')).trim()).toBe(ARCH)
        expect((await fs.readFile(path.join(tb(sb), 'EXCLUDE'), 'utf8')).trim()).toBe('data/keys')
        expect(await fs.readFile(path.join(tb(sb), 'COMPLETE'), 'utf8')).toMatch(/^complete .* archive=2026-11-16T08-00-00-000Z-stop/)
        for (const p of [path.join(sb.sys, '.idea-temp-backups'), path.join(sb.sys, '.idea-temp-backups', 'inst-1'), tb(sb)]) {
            expect((await fs.stat(p)).mode & 0o777, p).toBe(0o700)
        }
        const borg = (await sb.calls('borg')).map(c => c.argv)
        expect(borg.map(a => a[0])).toEqual(['init', 'create', 'check'])
        expect(borg[0]).toEqual(['init', '--encryption=none', '--', `${tb(sb)}/repo`])
        expect(borg[1].slice(0, 3)).toEqual(['create', '--numeric-ids', '--patterns-from'])
        expect(borg[1].slice(-2)).toEqual([`${tb(sb)}/repo::${ARCH}`, path.join(app, 'instances', 'inst-1')])
        expect(borg[2]).toEqual(['check', '--', `${tb(sb)}/repo`])
        expect(await sb.journalText()).toMatch(/temp-backup-create: .* complete/)
        // the list shows it
        const l = await sb.run(tempBackupsArgs())
        expect(l.exitCode, l.stderr).toBe(0)
        expect(parseTempBackups(l.stdout).backups).toEqual([{ instanceId: 'inst-1', stamp: STAMP, sizeBytes: expect.any(Number), complete: true }])
        // a second create with the same stamp is refused, never overwritten
        refused(await sb.run(tempBackupCreateArgs('sdb1', 'inst-1', STAMP, ARCH)), /already exists/)
    })
    it('TEMP_BACKUP_NO_SPACE (exit 3) before anything is written; running containers are refused', async () => {
        const sb = await sandbox()
        const app = await sb.addDisk('sdb1')
        await sb.addInstance(app, 'inst-1')
        const r = await sb.run(tempBackupCreateArgs('sdb1', 'inst-1', STAMP, ARCH), { FAKE_DF_AVAIL_KB: '1000' })
        expect(r.exitCode, r.stderr).toBe(3)
        expect(r.stderr).toMatch(/^TEMP_BACKUP_NO_SPACE: the temporary backup needs \d+ bytes \(\d+ KB folder \+ 1048576 KB margin; 0 KB excluded\), free 1024000 bytes on the system disk$/m)
        expect(await fs.pathExists(path.join(sb.sys, '.idea-temp-backups'))).toBe(false)
        expect(await sb.calls('borg')).toEqual([])
        refused(await sb.run(tempBackupCreateArgs('sdb1', 'inst-1', STAMP, ARCH), { FAKE_DOCKER_PS: 'abc123' }), /RUNNING: the containers of inst-1 are still running/)
        expect(await fs.pathExists(path.join(sb.sys, '.idea-temp-backups'))).toBe(false)
    })
    it('a failed borg run leaves the folder without COMPLETE (the Engine removes it); restore refuses it', async () => {
        const sb = await sandbox()
        const app = await sb.addDisk('sdb1')
        await sb.addInstance(app, 'inst-1')
        const r = await sb.run(tempBackupCreateArgs('sdb1', 'inst-1', STAMP, ARCH), { FAKE_BORG_EXIT: '2' })
        expect(r.exitCode).toBe(2)
        expect(await fs.pathExists(path.join(tb(sb), 'COMPLETE'))).toBe(false)
        expect(parseTempBackups((await sb.run(tempBackupsArgs())).stdout).backups[0].complete).toBe(false)
        refused(await sb.run(tempBackupRestoreArgs('sdb1', 'inst-1', STAMP)), /no COMPLETE marker/)
    })
    it('estimate is read-only: net of the backup excludes, system free space, same filesystem flag', async () => {
        const sb = await sandbox()
        const app = await sb.addDisk('sdb1')
        await sb.addInstance(app, 'inst-1')
        await fs.outputFile(path.join(app, 'instances', 'inst-1', 'data', 'keys', 'big'), Buffer.alloc(64 * 1024))
        const all = parseTempBackupEstimate((await sb.run(tempBackupEstimateArgs('sdb1', 'inst-1'))).stdout)
        const r = await sb.run(tempBackupEstimateArgs('sdb1', 'inst-1', ['keys']), { FAKE_DF_AVAIL_KB: '777' })
        expect(r.exitCode, r.stderr).toBe(0)
        const net = parseTempBackupEstimate(r.stdout)
        expect(net.freeBytes).toBe(777 * 1024)
        expect(net.netBytes).toBeLessThan(all.netBytes)
        expect(net.sameFilesystem).toBe(true)   // the sandbox's /disks and system root share the temp filesystem
        expect(await fs.pathExists(path.join(sb.sys, '.idea-temp-backups'))).toBe(false)
        expect(() => tempBackupEstimateArgs('sdb1', 'inst-1', ['../../etc'])).toThrow(/not allowed/)
        refused(await sb.run(['temp-backup-estimate', 'sdb1', 'inst-1', '../../etc']), /exclude/)
    })
    it('temp-backups with nothing there prints TOTAL 0', async () => {
        const sb = await sandbox()
        const r = await sb.run(tempBackupsArgs())
        expect(r.exitCode).toBe(0)
        expect(parseTempBackups(r.stdout)).toEqual({ backups: [], totalBytes: 0 })
    })
})

describe('idea-app-data v18 temp-backup-delete (rm -rf only inside .idea-temp-backups)', () => {
    const make = async (sb: AppDataSandbox, id = 'inst-1', stamp = STAMP) => {
        const t = tb(sb, id, stamp)
        await fs.ensureDir(path.join(t, 'repo', 'data'))
        await fs.writeFile(path.join(t, 'repo', 'data', 'seg'), 'x')
        await fs.writeFile(path.join(t, 'COMPLETE'), 'complete')
        for (const p of [path.join(sb.sys, '.idea-temp-backups'), path.join(sb.sys, '.idea-temp-backups', id), t]) await fs.chmod(p, 0o700)
        return t
    }
    it('removes exactly that backup; siblings and other instances stay; the empty id folder goes; a retry is exit 0', async () => {
        const sb = await sandbox()
        const t = await make(sb)
        const sib = await make(sb, 'inst-1', '20261116T090000Z')
        const other = await make(sb, 'inst-2')
        const r = await sb.run(tempBackupDeleteArgs('inst-1', STAMP))
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe(`removed ${t}`)
        expect(await fs.pathExists(t)).toBe(false)
        expect(await fs.pathExists(sib)).toBe(true)
        expect(await fs.pathExists(other)).toBe(true)
        expect(await sb.journalText()).toMatch(/temp-backup-delete: removed /)
        expect((await sb.run(tempBackupDeleteArgs('inst-1', '20261116T090000Z'))).exitCode).toBe(0)
        expect(await fs.pathExists(path.join(sb.sys, '.idea-temp-backups', 'inst-1'))).toBe(false)
        const again = await sb.run(tempBackupDeleteArgs('inst-1', STAMP))
        expect(again.exitCode).toBe(0)
        expect(again.stderr).toMatch(/nothing to delete/)
    })
    it('refuses a symlinked base, instance folder or backup, and never follows it', async () => {
        const sb = await sandbox()
        const victim = path.join(sb.tmp, 'victim')
        await fs.outputFile(path.join(victim, STAMP, 'keep.txt'), 'precious')
        // instance folder is a symlink to elsewhere
        await fs.ensureDir(path.join(sb.sys, '.idea-temp-backups'))
        await fs.chmod(path.join(sb.sys, '.idea-temp-backups'), 0o700)
        await fs.symlink(victim, path.join(sb.sys, '.idea-temp-backups', 'inst-1'))
        refused(await sb.run(tempBackupDeleteArgs('inst-1', STAMP)), /is a symlink/)
        expect(await fs.readFile(path.join(victim, STAMP, 'keep.txt'), 'utf8')).toBe('precious')
        // the backup itself is a symlink
        await fs.remove(path.join(sb.sys, '.idea-temp-backups', 'inst-1'))
        await fs.ensureDir(path.join(sb.sys, '.idea-temp-backups', 'inst-2'))
        await fs.chmod(path.join(sb.sys, '.idea-temp-backups', 'inst-2'), 0o700)
        await fs.symlink(path.join(victim, STAMP), path.join(sb.sys, '.idea-temp-backups', 'inst-2', STAMP))
        refused(await sb.run(tempBackupDeleteArgs('inst-2', STAMP)), /is a symlink/)
        expect(await fs.readFile(path.join(victim, STAMP, 'keep.txt'), 'utf8')).toBe('precious')
        // the base is a symlink
        await fs.remove(path.join(sb.sys, '.idea-temp-backups'))
        await fs.ensureDir(path.join(victim, 'inst-3', STAMP))
        await fs.symlink(victim, path.join(sb.sys, '.idea-temp-backups'))
        refused(await sb.run(tempBackupDeleteArgs('inst-3', STAMP)), /is a symlink/)
        expect(await fs.pathExists(path.join(victim, 'inst-3', STAMP))).toBe(true)
    })
    it('refuses a group/other-writable folder (not the root-only layout the create made)', async () => {
        const sb = await sandbox()
        const t = await make(sb)
        await fs.chmod(t, 0o777)
        refused(await sb.run(tempBackupDeleteArgs('inst-1', STAMP)), /must be owned by root and not group\/other writable/)
        expect(await fs.pathExists(t)).toBe(true)
    })
})

const BORG = process.env.IDEA_TEST_BORG || '/usr/bin/borg'
const borgVersion = (() => { try { return execFileSync(BORG, ['--version'], { encoding: 'utf8' }).trim() } catch { return '' } })()

describe.skipIf(!borgVersion)(`idea-app-data v18 temp backup end to end with a real borg (${borgVersion || 'not installed'})`, () => {
    it('create → the update breaks the folder → restore (excluded identity kept, replaced folder quarantined) → delete', async () => {
        const sb = await sandbox({ realBorg: true, borgPath: BORG })
        const env = { BORG_BASE_DIR: path.join(sb.tmp, 'borg-base') }
        const app = await sb.addDisk('sdb1')
        const inst = path.join(app, 'instances', 'inst-1')
        await fs.outputFile(path.join(inst, 'data', 'db.sql'), 'v1 data\n')
        await fs.outputFile(path.join(inst, 'data', 'keys', 'id'), 'identity\n')
        await fs.outputFile(path.join(inst, 'compose.yaml'), 'x-app: {version: "1.0"}\n')
        const c = await sb.run(tempBackupCreateArgs('sdb1', 'inst-1', STAMP, ARCH, ['keys']), env)
        expect(c.exitCode, c.stderr).toBe(0)
        // the failed update changed the data and the identity was rotated in place
        await fs.writeFile(path.join(inst, 'data', 'db.sql'), 'broken by 2.0\n')
        await fs.writeFile(path.join(inst, 'compose.yaml'), 'x-app: {version: "2.0"}\n')
        await fs.writeFile(path.join(inst, 'data', 'keys', 'id'), 'identity-now\n')
        const r = await sb.run(tempBackupRestoreArgs('sdb1', 'inst-1', STAMP), env)
        expect(r.exitCode, r.stderr).toBe(0)
        const aside = r.stdout.trim().split('\n').pop()!
        expect(aside).toMatch(new RegExp(`^${app}/\\.idea-quarantine/inst-1-before-temp-restore-\\d{8}T\\d+Z$`))
        expect(await fs.readFile(path.join(inst, 'data', 'db.sql'), 'utf8')).toBe('v1 data\n')
        expect(await fs.readFile(path.join(inst, 'compose.yaml'), 'utf8')).toMatch(/1\.0/)
        expect(await fs.readFile(path.join(inst, 'data', 'keys', 'id'), 'utf8')).toBe('identity-now\n')   // excluded: carried over, never rolled back
        expect(await fs.readFile(path.join(aside, 'data', 'db.sql'), 'utf8')).toBe('broken by 2.0\n')
        expect(await fs.pathExists(path.join(tb(sb), 'COMPLETE'))).toBe(true)   // the restore keeps the temporary backup
        const d = await sb.run(tempBackupDeleteArgs('inst-1', STAMP))
        expect(d.exitCode, d.stderr).toBe(0)
        expect(await fs.pathExists(tb(sb))).toBe(false)
        expect(await fs.pathExists(inst)).toBe(true)
    }, 60_000)
})
