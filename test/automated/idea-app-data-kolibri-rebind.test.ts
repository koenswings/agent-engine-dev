/**
 * idea-app-data-kolibri-rebind.test.ts — helper v21 (engine#503, Steve's decision): the
 * morango id rebind of a Kolibri copy runs as root in the helper, because the container
 * owns data/kolibri/db.sqlite3 (root:root 0644) and pi cannot write it.
 *
 * Same sandbox as idea-app-data-script.test.ts (test/harness/appDataSandbox.ts): the
 * test user plays root, docker is a fake (FAKE_DOCKER_PS = running containers), and the
 * real /usr/bin/python3 + sqlite3 update a real SQLite file. Never touches /disks.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { execFileSync } from 'child_process'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'
import { rebindKolibriMorangoInstanceId } from '../../src/data/InstanceCopy.js'
import { appDataErrorMessage } from '../../src/utils/appDataHelper.js'

const PYTHON = '/usr/bin/python3'
const hasPython = fs.existsSync(PYTHON)
const OLD = '7705696a8ba0933d79d8a80069ba13d2'
const OTHER = '11111111111111111111111111111111'

const created: AppDataSandbox[] = []
const sandbox = async () => {
    const s = await makeAppDataSandbox()
    created.push(s)
    return s
}
afterEach(async () => { for (const s of created.splice(0)) await fs.remove(s.tmp) })

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/^refused: /m)
    expect(r.stderr).toMatch(re)
}

const py = (code: string, ...args: string[]) => execFileSync(PYTHON, ['-c', code, ...args], { encoding: 'utf8' }).trim()

/** A minimal Kolibri 0.15 morango_instanceidmodel: one current row and one old one. */
const makeDb = (db: string, withCurrent = true) => py(`
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("""create table morango_instanceidmodel (
  id char(32) primary key, platform text, hostname text, sysversion text,
  counter integer, current bool, db_path varchar(1000), database_id char(32),
  system_id varchar(100), node_id varchar(20))""")
c.execute("insert into morango_instanceidmodel values (?,?,?,?,?,?,?,?,?,?)",
  (sys.argv[2],"Linux","idea01","py",0,1 if sys.argv[3]=="1" else 0,"/x","dbid","sys","node"))
c.execute("insert into morango_instanceidmodel values (?,?,?,?,?,?,?,?,?,?)",
  (sys.argv[4],"Linux","idea01","py",0,0,"/x","dbid","sys","node"))
c.commit(); c.close()
`, db, OLD, withCurrent ? '1' : '0', OTHER)

const rows = (db: string) => JSON.parse(py(`
import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1])
print(json.dumps(sorted([[r[0], r[1]] for r in c.execute("select id,current from morango_instanceidmodel")])))
`, db)) as [string, number][]

/** A Kolibri copy as copyApp leaves it: db.sqlite3 (0640 here, to see the mode kept), stale pid/cache, both markers. */
const addKolibriCopy = async (sb: AppDataSandbox, dev: string, id: string, o: { current?: boolean } = {}) => {
    const root = await sb.addDisk(dev)
    const inst = await sb.addInstance(root, id)
    const home = path.join(inst, 'data', 'kolibri')
    await fs.ensureDir(home)
    const db = path.join(home, 'db.sqlite3')
    makeDb(db, o.current ?? true)
    await fs.chmod(db, 0o640)
    await fs.writeFile(path.join(home, 'server.pid'), '12345\n')
    await fs.ensureDir(path.join(home, 'process_cache'))
    await fs.writeFile(path.join(home, 'process_cache', 'cache.db'), 'x')
    await fs.writeFile(path.join(inst, '.idea-rebind-morango'), 'r40\n')
    await fs.writeFile(path.join(home, '.idea-rebind-morango'), 'r40\n')
    return { root, inst, home, db }
}

describe.skipIf(!hasPython)('idea-app-data v21: kolibri-rebind (engine#503)', () => {
    it('mints a fresh 32-hex id for the current row only, keeps owner and mode, quarantines the stale pid/cache and the markers, deletes nothing', async () => {
        const sb = await sandbox()
        const { root, inst, home, db } = await addKolibriCopy(sb, 'sdb2', 'k1')
        const before = await fs.stat(db)
        const r = await sb.run(['kolibri-rebind', 'sdb2', 'k1'])
        expect(r.exitCode, r.stderr).toBe(0)
        const prev = r.stdout.match(/^previousId=(.*)$/m)?.[1]
        const next = r.stdout.match(/^morangoId=(.*)$/m)?.[1]
        expect(prev).toBe(OLD)
        expect(next).toMatch(/^[0-9a-f]{32}$/)
        expect(next).not.toBe(OLD)
        expect(rows(db)).toEqual([[OTHER, 0], [next!, 1]].sort())
        const after = await fs.stat(db)
        expect(after.mode & 0o7777).toBe(0o640)
        expect([after.uid, after.gid, after.ino]).toEqual([before.uid, before.gid, before.ino])
        // nothing deleted: all four items are in <root>/.idea-quarantine
        const q = path.join(root, '.idea-quarantine')
        const names = (await fs.readdir(q)).sort()
        expect(names.map(n => n.replace(/-\d{8}T\d+Z$/, ''))).toEqual(
            ['k1-kolibri-process_cache', 'k1-kolibri-server.pid', 'k1-rebind-marker', 'k1-rebind-marker-data'])
        expect(await fs.readFile(path.join(q, names.find(n => n.startsWith('k1-kolibri-server.pid'))!), 'utf8')).toBe('12345\n')
        expect(await fs.readFile(path.join(q, names.find(n => n.startsWith('k1-kolibri-process_cache'))!, 'cache.db'), 'utf8')).toBe('x')
        expect((r.stdout.match(/^quarantined=/gm) ?? []).length).toBe(4)
        for (const p of [path.join(home, 'server.pid'), path.join(home, 'process_cache'), path.join(inst, '.idea-rebind-morango'), path.join(home, '.idea-rebind-morango')]) {
            expect(await fs.pathExists(p), p).toBe(false)
        }
        // the rest of the instance is untouched
        expect(await fs.readFile(path.join(inst, 'data', 'sessions', 's1'), 'utf8')).toBe('session\n')
        const j = await sb.journalText()
        expect(j).toMatch(new RegExp(`kolibri-rebind: .*db\\.sqlite3 morango id ${OLD} -> ${next}`))
        expect(j).toMatch(/user=pi sub=kolibri-rebind args=kolibri-rebind sdb2 k1 exit=0/)
        // a second run (a restart without a marker would not call it, but it is safe): another fresh id
        const again = await sb.run(['kolibri-rebind', 'sdb2', 'k1'])
        expect(again.exitCode, again.stderr).toBe(0)
        expect(again.stdout).toMatch(new RegExp(`^previousId=${next}$`, 'm'))
    })

    it('no current row: nothing changes (morangoId=none); no Kolibri db: kolibriDb=absent and the marker is still consumed', async () => {
        const sb = await sandbox()
        const { db } = await addKolibriCopy(sb, 'sdb2', 'k1', { current: false })
        const r = await sb.run(['kolibri-rebind', 'sdb2', 'k1'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout).toMatch(/^previousId=none$/m)
        expect(r.stdout).toMatch(/^morangoId=none$/m)
        expect(rows(db)).toEqual([[OLD, 0], [OTHER, 0]].sort())

        const root = await sb.addDisk('sdc1')
        const inst = await sb.addInstance(root, 'plain1')
        await fs.writeFile(path.join(inst, '.idea-rebind-morango'), 'r40\n')
        const a = await sb.run(['kolibri-rebind', 'sdc1', 'plain1'])
        expect(a.exitCode, a.stderr).toBe(0)
        expect(a.stdout).toMatch(/^kolibriDb=absent$/m)
        expect(await fs.pathExists(path.join(inst, '.idea-rebind-morango'))).toBe(false)
        expect((await fs.readdir(path.join(root, '.idea-quarantine')))[0]).toMatch(/^plain1-rebind-marker-/)
    })

    it('refuses while a container of the instance runs, and changes nothing', async () => {
        const sb = await sandbox()
        const { home, db } = await addKolibriCopy(sb, 'sdb2', 'k1')
        refused(await sb.run(['kolibri-rebind', 'sdb2', 'k1'], { FAKE_DOCKER_PS: 'abc123' }), /RUNNING: the containers of k1 are still running/)
        expect(rows(db)).toEqual([[OLD, 1], [OTHER, 0]].sort())
        expect(await fs.pathExists(path.join(home, 'server.pid'))).toBe(true)
        expect(await fs.pathExists(path.join(home, '.idea-rebind-morango'))).toBe(true)
    })

    it('refuses a symlinked or hard-linked db, a symlinked data/kolibri and a db that is not a file', async () => {
        const sb = await sandbox()
        const { root, home, db } = await addKolibriCopy(sb, 'sdb2', 'k1')
        const outside = path.join(sb.tmp, 'outside.sqlite3')
        makeDb(outside)
        // symlinked db.sqlite3
        await fs.move(db, path.join(home, 'real.sqlite3'))
        await fs.symlink(outside, db)
        refused(await sb.run(['kolibri-rebind', 'sdb2', 'k1']), /is not the exact path|not a regular file/)
        expect(rows(outside)).toEqual([[OLD, 1], [OTHER, 0]].sort())
        await fs.remove(db)
        // hard link to a file outside the instance
        await fs.link(outside, db)
        refused(await sb.run(['kolibri-rebind', 'sdb2', 'k1']), /has 2 hard links/)
        expect(rows(outside)).toEqual([[OLD, 1], [OTHER, 0]].sort())
        await fs.remove(db)
        // a folder named db.sqlite3
        await fs.ensureDir(db)
        refused(await sb.run(['kolibri-rebind', 'sdb2', 'k1']), /not a regular file/)
        // data/kolibri itself a symlink to somewhere else
        const inst2 = await sb.addInstance(root, 'k2')
        const elsewhere = path.join(sb.tmp, 'elsewhere')
        await fs.ensureDir(elsewhere)
        await fs.copy(outside, path.join(elsewhere, 'db.sqlite3'))
        await fs.symlink(elsewhere, path.join(inst2, 'data', 'kolibri'))
        refused(await sb.run(['kolibri-rebind', 'sdb2', 'k2']), /is not the exact path/)
        expect(rows(path.join(elsewhere, 'db.sqlite3'))).toEqual([[OLD, 1], [OTHER, 0]].sort())
        // nothing was quarantined by any refusal
        expect(await fs.pathExists(path.join(root, '.idea-quarantine'))).toBe(false)
    })

    it('refuses bad tokens, a missing instance folder and a db that is not SQLite', async () => {
        const sb = await sandbox()
        const { home, db } = await addKolibriCopy(sb, 'sdb2', 'k1')
        for (const id of ['../k1', '-rf', 'K1', 'a/b', '']) refused(await sb.run(['kolibri-rebind', 'sdb2', id]), /instance id/)
        for (const root of ['/disks/sdb2', '..', 'SDB2']) refused(await sb.run(['kolibri-rebind', root, 'k1']), /root '.*' is not|unknown root/)
        refused(await sb.run(['kolibri-rebind', 'sdb2', 'missing1']), /instance folder .* is not a folder/)
        refused(await sb.run(['kolibri-rebind', 'sdb2']), /kolibri-rebind takes exactly 2 argument/)
        await fs.writeFile(db, 'not a database at all, just text that is long enough to not be empty')
        const bad = await sb.run(['kolibri-rebind', 'sdb2', 'k1'])
        refused(bad, /cannot update the morango id in .*db\.sqlite3: /)
        // the Engine reports the helper's refusal line
        expect(appDataErrorMessage('kolibri-rebind', bad.exitCode, null, bad.stderr)).toMatch(/^idea-app-data kolibri-rebind refused: cannot update the morango id/)
        expect(await fs.readFile(db, 'utf8')).toMatch(/^not a database/)
        // the stale pid was moved aside before the failed update (quarantine, never deleted); the markers stay
        expect(await fs.pathExists(path.join(home, '.idea-rebind-morango'))).toBe(true)
    })

    it('a peer cannot reach it through idea-peer-gate', async () => {
        const sb = await sandbox()
        const { db } = await addKolibriCopy(sb, 'sdb2', 'k1')
        const r = await sb.runGate(['ENGINE_gge6zxyl6ftmnri4qx6'], 'sudo -n /usr/local/sbin/idea-app-data kolibri-rebind sdb2 k1')
        expect(r.exitCode).toBe(2)
        expect(r.stderr).toMatch(/^refused: /)
        expect(rows(db)).toEqual([[OLD, 1], [OTHER, 0]].sort())
    })

    it('Engine → helper end to end: rebindKolibriMorangoInstanceId returns the id the helper wrote', async () => {
        const sb = await sandbox()
        const { db } = await addKolibriCopy(sb, 'sdb2', 'k1')
        const id = await rebindKolibriMorangoInstanceId('sdb2', 'k1', {
            helperAtLeast: async () => null,
            run: async (args) => {
                const r = await sb.run(args)
                if (r.exitCode !== 0) throw new Error(appDataErrorMessage(args[0], r.exitCode, null, r.stderr))
                return r.stdout
            },
        })
        expect(id).toMatch(/^[0-9a-f]{32}$/)
        expect(rows(db)).toEqual([[OTHER, 0], [id!, 1]].sort())
    })
})
