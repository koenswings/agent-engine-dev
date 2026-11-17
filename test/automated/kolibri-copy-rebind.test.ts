/**
 * r40 / engine#503: a Kolibri copy must mint a fresh morango instance id so host-network
 * zeroconf does not NonUniqueNameException when original + copy both advertise.
 *
 * engine#503: the Kolibri container writes data/kolibri/db.sqlite3 as root:root 0644 and
 * the root copy keeps that owner, so the rebind runs in the app-data root helper
 * (`idea-app-data kolibri-rebind <root> <id>`, v21), never as pi. These are the Engine
 * side with a fake exec; the helper itself is in idea-app-data-kolibri-rebind.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { fs } from 'zx'
import path from 'path'
import os from 'os'
import {
  rebindKolibriMorangoInstanceId,
  instanceDirLooksLikeKolibri,
  type KolibriRebindDeps,
} from '../../src/data/InstanceCopy.js'
import {
  kolibriRebindArgs, parseKolibriRebind, KOLIBRI_REBIND_HELPER_MIN, APP_DATA_HELPER_VERSION,
} from '../../src/utils/appDataHelper.js'

const NEW = '0123456789abcdef0123456789abcdef'
const OLD = '7705696a8ba0933d79d8a80069ba13d2'

const fakeDeps = (out: string | Error, outdated: string | null = null) => {
  const calls: string[][] = []
  const mins: number[] = []
  const deps: KolibriRebindDeps = {
    run: async (args) => {
      calls.push(args)
      if (out instanceof Error) throw out
      return out
    },
    helperAtLeast: async (min) => { mins.push(min); return outdated },
  }
  return { deps, calls, mins }
}

describe('rebindKolibriMorangoInstanceId through the root helper (engine#503)', () => {
  it('needs helper v21 and runs exactly `kolibri-rebind <root> <id>`', async () => {
    expect(KOLIBRI_REBIND_HELPER_MIN).toBe(21)
    expect(APP_DATA_HELPER_VERSION).toBe('22')
    const f = fakeDeps(`previousId=${OLD}\nmorangoId=${NEW}\nquarantined=/disks/sdb2/.idea-quarantine/k1-rebind-marker-20261117T100000123456789Z\n`)
    expect(await rebindKolibriMorangoInstanceId('sdb2', 'k1', f.deps)).toBe(NEW)
    expect(f.mins).toEqual([21])
    expect(f.calls).toEqual([['kolibri-rebind', 'sdb2', 'k1']])
  })

  it('returns null when the instance has no Kolibri db or no current row', async () => {
    expect(await rebindKolibriMorangoInstanceId('sdb2', 'k1', fakeDeps('kolibriDb=absent\n').deps)).toBeNull()
    expect(await rebindKolibriMorangoInstanceId('system', 'k1', fakeDeps('previousId=none\nmorangoId=none\n').deps)).toBeNull()
  })

  it('refuses HELPER_OUTDATED below v21 without running the helper', async () => {
    const f = fakeDeps(`morangoId=${NEW}\n`, "Starting a copied or moved Kolibri needs the app-data root helper /usr/local/sbin/idea-app-data v21 or later, but the installed one reports 'idea-app-data 20'; ask Ops")
    await expect(rebindKolibriMorangoInstanceId('sdb2', 'k1', f.deps)).rejects.toThrow(/^HELPER_OUTDATED: .*v21 or later.*'idea-app-data 20'.*clash with the original on zeroconf/)
    expect(f.calls).toEqual([])
  })

  it('a helper refusal or failure keeps the zeroconf warning and the helper reason', async () => {
    const f = fakeDeps(new Error("idea-app-data kolibri-rebind refused: RUNNING: the containers of k1 are still running; stop the instance first"))
    await expect(rebindKolibriMorangoInstanceId('sdb2', 'k1', f.deps))
      .rejects.toThrow(/cannot update the morango id of instance k1 on sdb2: .*RUNNING: .*clash with the original on zeroconf/)
    const g = fakeDeps('garbage\n')
    await expect(rebindKolibriMorangoInstanceId('sdb2', 'k1', g.deps)).rejects.toThrow(/no morangoId=<32 hex>\|none line/)
  })

  it('refuses bad root and instance tokens before anything runs', async () => {
    const f = fakeDeps(`morangoId=${NEW}\n`)
    await expect(rebindKolibriMorangoInstanceId('/disks/sdb2', 'k1', f.deps)).rejects.toThrow(/not a disk root/)
    await expect(rebindKolibriMorangoInstanceId('sdb2', '../etc', f.deps)).rejects.toThrow(/not an instance id/)
    expect(f.calls).toEqual([])
    expect(() => kolibriRebindArgs('sdb2', '-rf')).toThrow(/not an instance id/)
  })

  it('parseKolibriRebind reads the helper lines', () => {
    expect(parseKolibriRebind(`previousId=${OLD}\nmorangoId=${NEW}\nquarantined=/q/a\nquarantined=/q/b\n`))
      .toEqual({ dbPresent: true, previousId: OLD, morangoId: NEW, quarantined: ['/q/a', '/q/b'] })
    expect(parseKolibriRebind('kolibriDb=absent\nquarantined=/q/m\n')).toEqual({ dbPresent: false, previousId: null, morangoId: null, quarantined: ['/q/m'] })
    expect(parseKolibriRebind('previousId=none\nmorangoId=none\n')).toEqual({ dbPresent: true, previousId: null, morangoId: null, quarantined: [] })
    expect(() => parseKolibriRebind('morangoId=XYZ\n')).toThrow()
  })

  it('the Engine no longer runs python or sqlite as pi (InstanceCopy.ts, Instance.ts)', async () => {
    const copy = await fs.readFile(path.resolve('src/data/InstanceCopy.ts'), 'utf8')
    expect(copy).not.toMatch(/python3 -c|sqlite3\.connect/)
    const inst = await fs.readFile(path.resolve('src/data/Instance.ts'), 'utf8')
    expect(inst).toMatch(/rebindKolibriMorangoInstanceId\(await appDataRoot\(disk\), String\(instance\.id\)\)/)
    // the markers are consumed by the helper (quarantine), not removed as pi
    expect(inst).not.toMatch(/for \(const m of hit\) await fs\.remove\(m\)/)
  })
})

describe('instanceDirLooksLikeKolibri (r40)', () => {
  it('needs a Kolibri db or a kolibri compose', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-kolibri-look-'))
    try {
      expect(await instanceDirLooksLikeKolibri(dir)).toBe(false)
      await fs.ensureDir(path.join(dir, 'data', 'kolibri'))
      await fs.writeFile(path.join(dir, 'data', 'kolibri', 'db.sqlite3'), '')
      expect(await instanceDirLooksLikeKolibri(dir)).toBe(true)
    } finally {
      await fs.remove(dir)
    }
  })
})
