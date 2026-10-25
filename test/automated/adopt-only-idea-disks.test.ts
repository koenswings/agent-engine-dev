/**
 * adopt-only-idea-disks.test.ts
 *
 * idea#279 / idea#282 (agreed approach, Koen 2026-10-25): an Engine adopts only
 * disks that already carry IDEA's marks (a valid META.yaml). Anything else is
 * never written to. The IDEA-IGNORE marker excludes an IDEA disk. forgetDisk
 * removes a stale, undocked record. An 'Unformatted' disk whose partitions
 * change while it stays plugged is re-evaluated.
 *
 * Mount commands are faked through setMountOps, so nothing is mounted and
 * /disks is never touched.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import { fs, path, sleep } from 'zx'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    MountEntry, MountOps, lookForIdeaMeta, setMountOps, mountPointOf, isValidIdeaMetaFile, IDEA_IGNORE_MARKER, hasOsRootfsLayout,
} from '../../src/monitors/mounts.js'
import { checkForgetDisk, forgetDisk } from '../../src/data/ForgetDisk.js'
import { commands } from '../../src/data/Commands.js'
import {
    LsblkDevice, setUnformattedOpsForTests, refreshUnformattedDisks, reevaluateUnformattedDisks,
    clearGeneratedUnformattedIdsForTests,
} from '../../src/data/UnformattedDisks.js'
import { createTestStore, dockFixture, cleanupDisk, waitFor, uniqueTestDevice, sentinelPath, diskPath } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID

interface FakeState { mounts: MountEntry[], calls: string[] }
const fakeOps = (state: FakeState): MountOps => ({
    listMounts: async () => [...state.mounts],
    isMountPoint: async (p) => state.mounts.some(m => m.target === p),
    fsUuidOfDevice: async () => 'UUID-279',
    fsUuidAt: async () => null,
    mkdir: async (d) => { state.calls.push(`mkdir ${d}`) },
    mount: async (d) => {
        state.calls.push(`mount ${d}`)
        state.mounts.push({ source: `/dev/${d}`, target: mountPointOf(d), fstype: 'ext4' })
    },
    mountReadOnly: async (d) => {
        state.calls.push(`mount -o ro ${d}`)
        state.mounts.push({ source: `/dev/${d}`, target: mountPointOf(d), fstype: 'ext4' })
    },
    umount: async (d) => {
        state.calls.push(`umount ${d}`)
        const i = state.mounts.map(m => m.target).lastIndexOf(mountPointOf(d))
        if (i >= 0) state.mounts.splice(i, 1)
    },
    rmdir: async (p) => { state.calls.push(`rmdir ${p}`) },
})
const rwMounts = (state: FakeState, d: string) => state.calls.filter(c => c === `mount ${d}`)

/** Every file under dir with its content and mtime: proves nothing was written. */
const snapshot = async (dir: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    const walk = async (d: string) => {
        for (const e of await fs.readdir(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) await walk(p)
            else out[path.relative(dir, p)] = `${(await fs.stat(p)).mtimeMs}:${await fs.readFile(p, 'utf8')}`
        }
    }
    await walk(dir)
    return out
}

describe('valid META.yaml and the IDEA-IGNORE marker (idea#279)', () => {
    let dir: string
    beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-279-meta-')) })
    afterAll(async () => { await fs.remove(dir) })

    it('only a non-empty YAML mapping counts as IDEA META', async () => {
        const f = path.join(dir, 'META.yaml')
        expect(isValidIdeaMetaFile(f)).toBe(false)                  // missing
        await fs.writeFile(f, '')
        expect(isValidIdeaMetaFile(f)).toBe(false)                  // empty
        await fs.writeFile(f, '- a\n- b\n')
        expect(isValidIdeaMetaFile(f)).toBe(false)                  // a list
        await fs.writeFile(f, 'diskId: [unclosed\n')
        expect(isValidIdeaMetaFile(f)).toBe(false)                  // unparseable
        await fs.writeFile(f, 'diskId: abc\ndiskName: x\n')
        expect(isValidIdeaMetaFile(f)).toBe(true)
    })

    it('lookForIdeaMeta reports the marker and still releases the device', async () => {
        const state: FakeState = { mounts: [], calls: [] }
        const r = await lookForIdeaMeta('sdz2', fakeOps(state), () => true, () => true)
        expect(r).toEqual({ ok: true, hasMeta: true, alreadyMounted: false, ignored: true })
        expect(rwMounts(state, 'sdz2')).toHaveLength(0)
        expect(state.mounts).toHaveLength(0)
    })

    it('OS rootfs rule: etc/os-release plus a real usr/ or boot/ dir; App, Files and Backup Disk layouts never match', async () => {
        const mk = async (files: string[], dirsIn: string[] = []) => {
            const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-279-rootfs-'))
            for (const x of dirsIn) await fs.ensureDir(path.join(d, x))
            for (const f of files) { await fs.ensureDir(path.dirname(path.join(d, f))); await fs.writeFile(path.join(d, f), 'x\n') }
            return d
        }
        expect(hasOsRootfsLayout(await mk(['etc/os-release', 'META.yaml'], ['usr/bin']))).toBe(true)
        expect(hasOsRootfsLayout(await mk(['etc/os-release'], ['boot']))).toBe(true)
        const sym = await mk([], ['usr/lib', 'etc'])                      // Ubuntu: etc/os-release -> ../usr/lib/os-release
        await fs.symlink('../usr/lib/os-release', path.join(sym, 'etc/os-release'))
        expect(hasOsRootfsLayout(sym)).toBe(true)
        expect(hasOsRootfsLayout(await mk(['etc/os-release']))).toBe(false)               // no usr/ or boot/
        expect(hasOsRootfsLayout(await mk(['boot/cmdline.txt'], ['usr']))).toBe(false)     // no etc/os-release
        const usrLink = await mk(['etc/os-release'])
        await fs.symlink('/usr', path.join(usrLink, 'usr'))
        expect(hasOsRootfsLayout(usrLink)).toBe(false)                                   // symlinks not followed
        // Legitimate IDEA layouts
        expect(hasOsRootfsLayout(await mk(['META.yaml', 'apps/kolibri-1.0/compose.yaml', 'instances/kolibri/compose.yaml', 'services/kolibri.tar']))).toBe(false)
        expect(hasOsRootfsLayout(await mk(['META.yaml', 'FILES.yaml', 'files/boot/readme.txt', 'files/usr/notes.txt']))).toBe(false)
        expect(hasOsRootfsLayout(await mk(['META.yaml', 'BACKUP.yaml', 'backups/kolibri/etc/os-release'], ['backups/kolibri/usr']))).toBe(false)
    })

    it('lookForIdeaMeta: rootfs with META.yaml is not IDEA META, and the device is released', async () => {
        const state: FakeState = { mounts: [], calls: [] }
        const r = await lookForIdeaMeta('sdz2', fakeOps(state), () => true, () => false, () => true)
        expect(r).toEqual({ ok: true, hasMeta: false, alreadyMounted: false, ignored: false, osRootfs: true })
        expect(rwMounts(state, 'sdz2')).toHaveLength(0)
        expect(state.mounts).toHaveLength(0)
    })

    it('capabilities forgetDisk and ideaIgnoreMarker are advertised', () => {
        expect(ENGINE_CAPABILITIES).toContain('forgetDisk')
        expect(ENGINE_CAPABILITIES).toContain('ideaIgnoreMarker')
        expect(IDEA_IGNORE_MARKER).toBe('IDEA-IGNORE')
    })
})

describe('dock flow: adopt only IDEA disks, never write to others (idea#279, idea#282)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    const state: FakeState = { mounts: [], calls: [] }
    const dirs: string[] = []
    const devices: string[] = []

    const fixture = async (files: Record<string, string>): Promise<string> => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-279-'))
        for (const [name, content] of Object.entries(files)) {
            await fs.ensureDir(path.dirname(path.join(dir, name)))
            await fs.writeFile(path.join(dir, name), content)
        }
        dirs.push(dir)
        return dir
    }
    const diskCount = () => Object.keys(storeHandle.doc()!.diskDB).length

    /** Dock, wait for the look to be released, and prove: no rw mount, no write, no record. */
    const expectUntouched = async (files: Record<string, string>) => {
        const device = uniqueTestDevice()
        devices.push(device)
        const before = diskCount()
        await dockFixture(await fixture(files), device)
        const pre = await snapshot(diskPath(device))
        expect(await waitFor(storeHandle, () => state.calls.includes(`umount ${device}`), 10_000)).toBe(true)
        await sleep(500)
        expect(state.calls).toContain(`mount -o ro ${device}`)
        expect(rwMounts(state, device)).toHaveLength(0)
        expect(await snapshot(diskPath(device))).toEqual(pre)
        expect(diskCount()).toBe(before)
        return device
    }

    beforeAll(async () => {
        setMountOps(fakeOps(state))
        storeHandle = (await createTestStore()).storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    }, 15_000)

    afterAll(async () => {
        await watcher?.close()
        setMountOps(null)
        for (const d of devices) { await fs.remove(sentinelPath(d)).catch(() => {}); await cleanupDisk(d).catch(() => {}) }
        for (const d of dirs) await fs.remove(d).catch(() => {})
    })

    it('unrecognised ext4 disk: no writes at all, no META.yaml, no record', { timeout: 20_000 }, async () => {
        const device = await expectUntouched({ 'data/report.txt': 'school data\n' })
        expect(fs.existsSync(path.join(diskPath(device), 'META.yaml'))).toBe(false)
    })

    it('SD card with a rootfs (client card, idea#282): no writes, no META.yaml, no record', { timeout: 20_000 }, async () => {
        const device = await expectUntouched({
            'etc/os-release': 'NAME="Ubuntu"\nVERSION_ID="26.04"\n',
            'etc/idea-client-version': '26.04-20261016-f00748e\n',
            'etc/hostname': 'student\n',
        })
        expect(fs.existsSync(path.join(diskPath(device), 'META.yaml'))).toBe(false)
    })

    it('a META.yaml that is not IDEA\'s (empty or not a mapping): not adopted, left as it is', { timeout: 20_000 }, async () => {
        await expectUntouched({ 'META.yaml': '' })
        await expectUntouched({ 'META.yaml': '- not\n- a mapping\n' })
    })

    it("old Engine rootfs with META.yaml (the 'anna' Samsung stick on 'idea', 2026-10-25): no writes, no record, released", { timeout: 20_000 }, async () => {
        const id = `idea279-anna-${Date.now()}` as DiskID
        const device = await expectUntouched({
            'META.yaml': `diskId: ${id}\ndiskName: anna\ncreated: 1\nlastDocked: 1\n`,
            'etc/os-release': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n',
            'etc/hostname': 'anna\n',
            'usr/bin/node': 'x\n',
            'boot/firmware/config.txt': 'x\n',
            'home/pi/idea/agents/agent-engine-dev/package.json': '{}\n',
        })
        expect(storeHandle.doc()!.diskDB[id]).toBeUndefined()
        expect(state.mounts.filter(m => m.target === mountPointOf(device))).toHaveLength(0)
    })

    it('IDEA disk with the IDEA-IGNORE marker: ignored like an unrecognised disk', { timeout: 20_000 }, async () => {
        const id = `idea279-ignored-${Date.now()}` as DiskID
        await expectUntouched({
            'META.yaml': `diskId: ${id}\ndiskName: ignored\ncreated: 1\nlastDocked: 1\n`,
            [IDEA_IGNORE_MARKER]: 'kept out for repair\n',
        })
        expect(storeHandle.doc()!.diskDB[id]).toBeUndefined()
    })

    it('existing IDEA disk: ro look, then rw mount and docked exactly as before', { timeout: 20_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)
        const id = `idea279-known-${Date.now()}` as DiskID
        await dockFixture(await fixture({ 'META.yaml': `diskId: ${id}\ndiskName: known\ncreated: 1\nlastDocked: 1\n` }), device)
        expect(await waitFor(storeHandle, s => s.diskDB[id]?.dockedTo === localEngineId)).toBe(true)
        const ro = state.calls.indexOf(`mount -o ro ${device}`)
        expect(ro).toBeGreaterThanOrEqual(0)
        expect(state.calls.indexOf(`mount ${device}`)).toBeGreaterThan(ro)
        expect(rwMounts(state, device)).toHaveLength(1)
    })
})

describe('forgetDisk: remove a stale, undocked disk record (idea#279, idea#282)', () => {
    const newStore = async (): Promise<DocHandle<Store>> => {
        const h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
        } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, LOCAL)
        h.change(doc => {
            const add = (id: string, device: string | null, dockedTo: EngineID | null) => {
                doc.diskDB[id as DiskID] = {
                    id: id as DiskID, name: 'writable' as DiskName, device: device as DeviceName | null, dockedTo,
                    created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: [], backupConfig: null,
                }
            }
            add('7wt29vdzvj3b2xxt605', null, null)            // the stale client-card record of idea#282
            add('d-docked', 'sdb2', LOCAL)
            add('d-holds', null, null)
            doc.instanceDB['i-1' as InstanceID] = { id: 'i-1', storedOn: 'd-holds' } as any
        })
        return h
    }

    it('removes an undocked record and nothing else', async () => {
        const h = await newStore()
        expect(forgetDisk(h, '7wt29vdzvj3b2xxt605')).toBe('7wt29vdzvj3b2xxt605')
        expect(h.doc()!.diskDB['7wt29vdzvj3b2xxt605' as DiskID]).toBeUndefined()
        expect(Object.keys(h.doc()!.diskDB).sort()).toEqual(['d-docked', 'd-holds'])
        expect(h.doc()!.instanceDB['i-1' as InstanceID]).toBeDefined()
    })

    it('refuses a docked record, a record holding instances, and an unknown id', async () => {
        const h = await newStore()
        expect(() => forgetDisk(h, 'd-docked')).toThrow(/is docked/)
        expect(() => forgetDisk(h, 'd-holds')).toThrow(/still holds instance record\(s\) i-1/)
        expect(() => forgetDisk(h, 'writable')).toThrow(/not found/)   // no name fallback
        expect(Object.keys(h.doc()!.diskDB)).toHaveLength(3)
        expect(checkForgetDisk(h.doc()!, '7wt29vdzvj3b2xxt605')).toEqual({ ok: true })
    })

    it('is registered as an engine-scoped command taking a diskId', () => {
        const def = commands.find(c => c.name === 'forgetDisk')
        expect(def?.scope).toBe('engine')
        expect(def?.args.map(a => a.name)).toEqual(['diskId'])
    })
})

describe("'Unformatted' disk whose partitions change is re-evaluated (idea#279, 'idea' 2026-10-25)", () => {
    let lsblk: LsblkDevice[] = []
    afterAll(() => { setUnformattedOpsForTests(null); clearGeneratedUnformattedIdsForTests() })

    it('a stick listed Unformatted that gets an ext4 partition leaves the list without a whole-disk event', async () => {
        setUnformattedOpsForTests({ lsblkJson: async () => lsblk, hardwareId: async () => undefined })
        const h = (await createTestStore()).storeHandle
        await createOrUpdateEngine(h, LOCAL)
        lsblk = [{ name: 'sdq', type: 'disk', size: 64_000_000_000, model: 'Flash Drive FIT', serial: 'SAMSUNG279', rm: false, children: [] }]
        await refreshUnformattedDisks(h)
        expect(h.doc()!.engineDB[LOCAL].unformattedDisks?.map(d => d.device)).toEqual(['sdq'])
        expect(await reevaluateUnformattedDisks(h)).toBe(false)        // unchanged: no write

        lsblk = [{ ...lsblk[0], children: [{ name: 'sdq1', type: 'part', fstype: 'ext4' }] }]
        expect(await reevaluateUnformattedDisks(h)).toBe(true)
        expect(h.doc()!.engineDB[LOCAL].unformattedDisks).toEqual([])

        lsblk = [{ ...lsblk[0], children: [{ name: 'sdq1', type: 'part', fstype: 'vfat' }] }]
        expect(await reevaluateUnformattedDisks(h)).toBe(true)          // and back: listed again
        expect(h.doc()!.engineDB[LOCAL].unformattedDisks?.map(d => d.fsType)).toEqual(['vfat'])
    })
})
