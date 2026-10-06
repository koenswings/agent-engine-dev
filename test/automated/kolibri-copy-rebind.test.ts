/**
 * r40: Kolibri copy must mint a fresh morango instance id so host-network
 * zeroconf does not NonUniqueNameException when original + copy both advertise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs } from 'zx'
import path from 'path'
import os from 'os'
import { createRequire } from 'module'
import {
  rebindKolibriMorangoInstanceId,
  instanceDirLooksLikeKolibri,
} from '../../src/data/InstanceCopy.js'

const require = createRequire(import.meta.url)

describe('rebindKolibriMorangoInstanceId (r40)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-kolibri-rebind-'))
  })
  afterEach(async () => {
    await fs.remove(dir)
  })

  it('no-ops when there is no Kolibri db', async () => {
    expect(await rebindKolibriMorangoInstanceId(dir)).to.equal(null)
    expect(await instanceDirLooksLikeKolibri(dir)).to.equal(false)
  })

  it('rewrites the current morango id and clears stale pid/cache', async () => {
    const home = path.join(dir, 'data', 'kolibri')
    await fs.ensureDir(home)
    await fs.writeFile(path.join(home, 'server.pid'), '12345\n')
    await fs.writeFile(path.join(home, 'process_cache'), 'x')
    const dbPath = path.join(home, 'db.sqlite3')
    // Minimal schema matching Kolibri 0.15 morango_instanceidmodel
    const { execFileSync } = await import('child_process')
    execFileSync('python3', ['-c', `
import sqlite3
c=sqlite3.connect(${JSON.stringify(dbPath)})
c.execute("""create table morango_instanceidmodel (
  id char(32) primary key, platform text, hostname text, sysversion text,
  counter integer, current bool, db_path varchar(1000), database_id char(32),
  system_id varchar(100), node_id varchar(20))""")
c.execute("insert into morango_instanceidmodel values (?,?,?,?,?,?,?,?,?,?)",
  ("7705696a8ba0933d79d8a80069ba13d2","Linux","idea01","py",0,1,"/x","dbid","sys","node"))
c.commit(); c.close()
`])
    expect(await instanceDirLooksLikeKolibri(dir)).to.equal(true)
    const newId = await rebindKolibriMorangoInstanceId(dir)
    expect(newId).to.match(/^[0-9a-f]{32}$/)
    expect(newId).to.not.equal('7705696a8ba0933d79d8a80069ba13d2')
    const out = execFileSync('python3', ['-c', `
import sqlite3
c=sqlite3.connect(${JSON.stringify(dbPath)})
print(c.execute("select id from morango_instanceidmodel where current=1").fetchone()[0])
`], { encoding: 'utf8' }).trim()
    expect(out).to.equal(newId)
    expect(await fs.pathExists(path.join(home, 'server.pid'))).to.equal(false)
    expect(await fs.pathExists(path.join(home, 'process_cache'))).to.equal(false)
  })
})
