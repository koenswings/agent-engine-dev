/**
 * idea-app-data-in-flight.test.ts — helper v20 (engine#497 stage 2, Koen's rule): the
 * in-flight marker next to an instance folder, copy resuming into its own half-written
 * folder only under that marker, verify-copy, and borg-break-lock.
 *
 * Same sandbox as idea-app-data-script.test.ts (test/harness/appDataSandbox.ts): the
 * test user plays root, fake or real rsync, fake borg. Never touches /disks.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox, REAL_RSYNC } from '../harness/appDataSandbox.js'
import {
    copyArgs, markInFlightArgs, clearInFlightArgs, verifyCopyArgs, borgBreakLockArgs, parseVerifyCopy, checkOpId, RESUME_HELPER_MIN, APP_DATA_HELPER_VERSION,
} from '../../src/utils/appDataHelper.js'
import { parseInFlightMarker, isInFlightMarkerName, inFlightMarkerPath, inFlightRefusal } from '../../src/data/InFlight.js'

const created: AppDataSandbox[] = []
const sandbox = async (o: Parameters<typeof makeAppDataSandbox>[0] = {}) => {
    const s = await makeAppDataSandbox(o)
    created.push(s)
    return s
}
afterEach(async () => { for (const s of created.splice(0)) await fs.remove(s.tmp) })

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/^refused: /m)
    expect(r.stderr).toMatch(re)
}

const OP = 'Ab3dEf5hJk7mNp9qRs1'
const OTHER = 'Zz9yXw8vUt7sRq6pOn5'
const ENGINE = 'idea01'
const hasRealRsync = fs.existsSync(REAL_RSYNC)

describe('idea-app-data v20: the in-flight marker (engine#497)', () => {
    it('is version 24 (engine#503 and engine#506 build on v20), and the Engine needs v20 to resume', () => {
        expect(APP_DATA_HELPER_VERSION).toBe('24')
        expect(RESUME_HELPER_MIN).toBe(20)
    })

    it('mark-in-flight writes instances/<id>.idea-op-in-flight next to the folder (never inside), 0644, opId and engineId', async () => {
        const sb = await sandbox()
        const dst = await sb.addDisk('sdc1')
        const r = await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])
        expect(r.exitCode, r.stderr).toBe(0)
        const marker = path.join(dst, 'instances', 'new1.idea-op-in-flight')
        const st = await fs.lstat(marker)
        expect(st.isFile()).toBe(true)
        expect(st.mode & 0o777).toBe(0o644)
        expect(st.uid).toBe(process.getuid!())
        const body = await fs.readFile(marker, 'utf8')
        expect(parseInFlightMarker(body)).toEqual({ opId: OP, engineId: ENGINE })
        expect(body).toMatch(/^created=\d{4}-\d\d-\d\dT/m)
        // nothing inside the (absent) instance folder, no temp file left
        expect(await fs.pathExists(path.join(dst, 'instances', 'new1'))).toBe(false)
        expect((await fs.readdir(path.join(dst, 'instances'))).sort()).toEqual(['new1.idea-op-in-flight'])
        expect(isInFlightMarkerName('new1.idea-op-in-flight')).toBe(true)
        expect(inFlightMarkerPath(dst, 'new1')).toBe(marker)
    })

    it('the same op again is ok; another op is refused IN_FLIGHT; bad op and Engine ids are refused', async () => {
        const sb = await sandbox()
        await sb.addDisk('sdc1')
        expect((await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])).exitCode).toBe(0)
        const again = await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])
        expect(again.exitCode, again.stderr).toBe(0)
        expect(again.stdout).toMatch(/already marks operation/)
        refused(await sb.run(['mark-in-flight', 'sdc1', 'new1', OTHER, ENGINE]), new RegExp(`IN_FLIGHT: .* already marks operation ${OP}`))
        refused(await sb.run(['mark-in-flight', 'sdc1', 'new2', '-rf', ENGINE]), /operation id '-rf' does not match/)
        refused(await sb.run(['mark-in-flight', 'sdc1', 'new2', 'a/b', ENGINE]), /operation id 'a\/b' does not match/)
        refused(await sb.run(['mark-in-flight', 'sdc1', 'new2', OP, '../x']), /engine/i)
        refused(await sb.run(['mark-in-flight', 'sdc1', 'New2', OP, ENGINE]), /id/)
    })

    it('clear-in-flight removes only its own op\'s marker; absent is ok', async () => {
        const sb = await sandbox()
        const dst = await sb.addDisk('sdc1')
        const marker = path.join(dst, 'instances', 'new1.idea-op-in-flight')
        const absent = await sb.run(['clear-in-flight', 'sdc1', 'new1', OP])
        expect(absent.exitCode, absent.stderr).toBe(0)
        expect(absent.stdout).toMatch(/nothing to clear/)
        await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])
        refused(await sb.run(['clear-in-flight', 'sdc1', 'new1', OTHER]), new RegExp(`IN_FLIGHT: .* marks operation ${OP}, not ${OTHER}`))
        expect(await fs.pathExists(marker)).toBe(true)
        expect((await sb.run(['clear-in-flight', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        expect(await fs.pathExists(marker)).toBe(false)
    })

    it('a symlinked marker is not a marker: mark and clear refuse it, copy does not resume under it', async () => {
        const sb = await sandbox()
        const src = await sb.addDisk('sdb1')
        const dst = await sb.addDisk('sdc1')
        await sb.addInstance(src, 'inst1')
        const decoy = path.join(sb.tmp, 'decoy')
        await fs.writeFile(decoy, `opId=${OP}\nengineId=${ENGINE}\n`)
        await fs.symlink(decoy, path.join(dst, 'instances', 'new1.idea-op-in-flight'))
        refused(await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE]), /not a root-owned regular file/)
        refused(await sb.run(['clear-in-flight', 'sdc1', 'new1', OP]), /not a root-owned regular file/)
        await fs.ensureDir(path.join(dst, 'instances', 'new1'))
        await fs.writeFile(path.join(dst, 'instances', 'new1', 'partial'), 'x')
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1', OP]), /no in-flight marker for operation/)
        expect(await fs.pathExists(decoy)).toBe(true)
    })
})

describe('idea-app-data v20: copy resumes only under its own marker (prepare_dst guard)', () => {
    const partial = async (sb: AppDataSandbox) => {
        const src = await sb.addDisk('sdb1')
        const dst = await sb.addDisk('sdc1')
        await sb.addInstance(src, 'inst1')
        const target = path.join(dst, 'instances', 'new1')
        await fs.ensureDir(path.join(target, 'data'))
        await fs.writeFile(path.join(target, 'compose.yaml'), 'services: {}\n')
        return { src, dst, target }
    }

    it('a non-empty target without a marker is refused, with or without an op id (as v19)', async () => {
        const sb = await sandbox()
        await partial(sb)
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1']), /already exists and is not empty$/m)
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1', OP]), new RegExp(`no in-flight marker for operation ${OP}`))
        expect((await sb.calls('rsync')).length).toBe(0)
    })

    it('a marker of another op is refused; without an op id even our marker is refused', async () => {
        const sb = await sandbox()
        await partial(sb)
        expect((await sb.run(['mark-in-flight', 'sdc1', 'new1', OTHER, ENGINE])).exitCode).toBe(0)
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1', OP]), new RegExp(`marker names operation ${OTHER}, not ${OP}`))
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1']), /already exists and is not empty/)
        expect((await sb.calls('rsync')).length).toBe(0)
    })

    it('the matching marker lets the copy continue into the same folder (journaled), rsync without --delete', async () => {
        const sb = await sandbox()
        const { target } = await partial(sb)
        expect((await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])).exitCode).toBe(0)
        const r = await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1', OP])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stderr).toMatch(new RegExp(`resume: .*new1 is not empty; continuing operation ${OP}`))
        const [call] = await sb.calls('rsync')
        expect(call.argv).not.toContain('--delete')
        expect(await fs.readFile(path.join(target, 'data', 'sessions', 's1'), 'utf8')).toBe('session\n')
        expect(await sb.journalText()).toMatch(new RegExp(`resume into .*new1 for operation ${OP}`))
        // the marker stays: the Engine clears it only after the whole op succeeded
        expect(await fs.pathExists(`${target}.idea-op-in-flight`)).toBe(true)
    })

    it('an empty or absent target with an op id copies as before', async () => {
        const sb = await sandbox()
        const src = await sb.addDisk('sdb1')
        await sb.addDisk('sdc1')
        await sb.addInstance(src, 'inst1')
        const r = await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new9', OP])
        expect(r.exitCode, r.stderr).toBe(0)
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new8', 'bad/op']), /operation id 'bad\/op' does not match/)
    })

    it.skipIf(!hasRealRsync)('power cut mid-copy, then resume with real rsync: complete files are kept, the rest is copied, verify-copy finds 0 differences', async () => {
        const sb = await sandbox({ realRsync: true })
        const src = await sb.addDisk('sdb1')
        const dst = await sb.addDisk('sdc1')
        const inst = await sb.addInstance(src, 'inst1')
        await fs.writeFile(path.join(inst, 'data', 'big.bin'), Buffer.alloc(256 * 1024, 7))
        await fs.writeFile(path.join(inst, 'data', 'other.txt'), 'other\n')
        // what a killed copy left: the marker, then some complete and one missing file
        expect((await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])).exitCode).toBe(0)
        const target = path.join(dst, 'instances', 'new1')
        await fs.ensureDir(path.join(target, 'data'))
        await fs.copy(path.join(inst, 'compose.yaml'), path.join(target, 'compose.yaml'), { preserveTimestamps: true })
        const before = await sb.run(['verify-copy', 'sdb1', 'inst1', 'sdc1', 'new1'])
        expect(before.exitCode, before.stderr).toBe(0)
        expect(parseVerifyCopy(before.stdout).differences).toBeGreaterThan(0)
        const r = await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1', OP])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(await fs.readFile(path.join(target, 'data', 'other.txt'), 'utf8')).toBe('other\n')
        expect((await fs.stat(path.join(target, 'data', 'big.bin'))).size).toBe(256 * 1024)
        const after = await sb.run(['verify-copy', 'sdb1', 'inst1', 'sdc1', 'new1'])
        expect(after.exitCode, after.stderr).toBe(0)
        expect(parseVerifyCopy(after.stdout)).toEqual({ differences: 0, diffs: [] })
        expect((await sb.run(['clear-in-flight', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        expect((await fs.readdir(path.join(dst, 'instances'))).sort()).toEqual(['new1'])
    })
})

describe('idea-app-data v20: verify-copy', () => {
    it.skipIf(!hasRealRsync)('is read-only and lists what differs (up to 10 diff= lines)', async () => {
        const sb = await sandbox({ realRsync: true })
        const src = await sb.addDisk('sdb1')
        const dst = await sb.addDisk('sdc1')
        const inst = await sb.addInstance(src, 'inst1')
        expect((await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1'])).exitCode).toBe(0)
        const same = await sb.run(['verify-copy', 'sdb1', 'inst1', 'sdc1', 'new1'])
        expect(same.stdout.trim()).toBe('differences=0')
        await fs.writeFile(path.join(inst, 'data', 'changed.txt'), 'new on the source\n')
        const diff = await sb.run(['verify-copy', 'sdb1', 'inst1', 'sdc1', 'new1'])
        const v = parseVerifyCopy(diff.stdout)
        expect(v.differences).toBeGreaterThan(0)
        expect(v.diffs.join('\n')).toMatch(/changed\.txt/)
        expect(await fs.pathExists(path.join(dst, 'instances', 'new1', 'data', 'changed.txt'))).toBe(false)
        const call = (await sb.calls('rsync')).at(-1)!
        expect(call.argv).toContain('-n')
        expect(call.argv).not.toContain('--delete')
    })

    it('refuses an absent folder and the same folder', async () => {
        const sb = await sandbox()
        const src = await sb.addDisk('sdb1')
        await sb.addDisk('sdc1')
        await sb.addInstance(src, 'inst1')
        refused(await sb.run(['verify-copy', 'sdb1', 'inst1', 'sdc1', 'new1']), /destination instance folder/)
        refused(await sb.run(['verify-copy', 'sdb1', 'inst1', 'sdb1', 'inst1']), /source and destination are the same folder/)
    })
})

describe('idea-app-data v20: borg-break-lock', () => {
    it('runs borg break-lock -- <repo> on an existing repository only', async () => {
        const sb = await sandbox()
        await sb.addDisk('sdc1', { backup: true })
        refused(await sb.run(['borg-break-lock', 'sdc1', 'inst1']), /repository folder/)
        expect((await sb.run(['borg-init', 'sdc1', 'inst1'])).exitCode).toBe(0)
        const r = await sb.run(['borg-break-lock', 'sdc1', 'inst1'])
        expect(r.exitCode, r.stderr).toBe(0)
        const call = (await sb.calls('borg')).at(-1)!
        expect(call.argv[0]).toBe('break-lock')
        expect(call.argv.slice(1, -1)).toEqual(['--'])
        expect(call.argv.at(-1)).toMatch(/\/backups\/inst1$/)
        refused(await sb.run(['borg-break-lock', 'sdc1', '../x']), /id/)
    })
})

describe('Engine argv for helper v20 (engine#497)', () => {
    it('builds the new verbs and the optional copy op id, and checks op ids', () => {
        expect(copyArgs('sdb1', 'inst1', 'sdc1', 'new1')).toEqual(['copy', 'sdb1', 'inst1', 'sdc1', 'new1'])
        expect(copyArgs('sdb1', 'inst1', 'sdc1', 'new1', OP)).toEqual(['copy', 'sdb1', 'inst1', 'sdc1', 'new1', OP])
        expect(markInFlightArgs('sdc1', 'new1', OP, ENGINE)).toEqual(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])
        expect(clearInFlightArgs('sdc1', 'new1', OP)).toEqual(['clear-in-flight', 'sdc1', 'new1', OP])
        expect(verifyCopyArgs('sdb1', 'inst1', 'sdc1', 'new1')).toEqual(['verify-copy', 'sdb1', 'inst1', 'sdc1', 'new1'])
        expect(borgBreakLockArgs('sdc1', 'inst1')).toEqual(['borg-break-lock', 'sdc1', 'inst1'])
        expect(() => checkOpId('-x')).toThrow(/not an operation id/)
        expect(() => checkOpId('a b')).toThrow(/not an operation id/)
        expect(parseVerifyCopy('differences=2\ndiff=>f+++++++++ a\ndiff=>f.st...... b\n')).toEqual({ differences: 2, diffs: ['>f+++++++++ a', '>f.st...... b'] })
        expect(() => parseVerifyCopy('nothing')).toThrow(/no differences=/)
    })

    it('inFlightRefusal: no marker allows; the owning op allows; anyone else is refused', async () => {
        const sb = await sandbox()
        const dst = await sb.addDisk('sdc1')
        expect(await inFlightRefusal(dst, 'new1')).toBeNull()
        await sb.run(['mark-in-flight', 'sdc1', 'new1', OP, ENGINE])
        expect(await inFlightRefusal(dst, 'new1', OP)).toBeNull()
        expect(await inFlightRefusal(dst, 'new1')).toMatch(new RegExp(`IN_FLIGHT: instances/new1 is being copied by operation ${OP} of Engine ${ENGINE}`))
        expect(await inFlightRefusal(dst, 'new1', OTHER)).toMatch(/IN_FLIGHT/)
    })
})
