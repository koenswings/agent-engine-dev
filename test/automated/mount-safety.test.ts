/**
 * mount-safety.test.ts
 *
 * idea#126 (Files Disk step 0, Q5 safety fix, Atlas's double-mount finding):
 *   - the already-mounted check uses findmnt by target and by source, for vfat
 *     as well as ext4, and never mounts twice
 *   - mounting onto a target that is already a mount point is refused
 *   - undock repeats umount until `mountpoint -q` is false, then rmdirs the
 *     mount point (never rm -fr); `sudo /usr/bin/rmdir /disks/<dev>` matches the
 *     11-engine-files entry exactly
 *   - a busy unmount sets Disk.unmountError { engineId, mountPoint, fsUuid,
 *     message }, the store is still updated, and the next mount clears it
 *   - startup cleanup of unmountError (findmnt -no UUID)
 *
 * Mount commands are faked through setMountOps (unit tests and the dock/undock
 * flow in testMode) or with fake binaries first on PATH (the real MountOps:
 * exact argv of findmnt, mountpoint, lsblk and sudo), so nothing is mounted and
 * /disks is never touched.
 */

import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest'
import os from 'os'
import { $, fs, path } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { CommandLogStore, CommandTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import { DISK_DETECTION_COMMAND } from '../../src/monitors/diskDetection.js'
import {
    MountEntry, MountOps, checkMountState, safeMount, unmountAndRemove, removeMountPointFolder,
    clearStaleUnmountErrors, defaultMountOps, setMountOps, mountPointOf,
    SUDO_RMDIR, SUDO_RMDIR_PATH, UMOUNT_MAX_ATTEMPTS, UMOUNT_RETRY_DELAY_MS,
} from '../../src/monitors/mounts.js'
import {
    createTestStore, dockFixture, triggerUndock, cleanupDisk, waitFor, uniqueTestDevice,
    diskPath, sentinelPath,
} from '../harness/diskSim.js'

const ROOT = process.cwd()
const SUDOERS_11 = path.join(ROOT, 'script/build_image_assets/11-engine-files.sudoers')

// ── Fake MountOps ───────────────────────────────────────────────────────────

interface FakeState {
    mounts: MountEntry[]
    calls: string[]
    umountFails: boolean
    uuid: string | null
}

/** Fake MountOps over an in-memory mount table; every call is recorded in order. */
const fakeOps = (state: FakeState): MountOps => ({
    listMounts: async () => { state.calls.push('findmnt'); return [...state.mounts] },
    isMountPoint: async (p) => { state.calls.push(`mountpoint -q ${p}`); return state.mounts.some(m => m.target === p) },
    fsUuidOfDevice: async (d) => { state.calls.push(`lsblk -no UUID /dev/${d}`); return state.uuid },
    fsUuidAt: async (p) => {
        state.calls.push(`findmnt -no UUID ${p}`)
        return state.mounts.some(m => m.target === p) ? state.uuid : null
    },
    mkdir: async (d) => { state.calls.push(`mkdir ${d}`) },
    mount: async (d) => {
        state.calls.push(`mount ${d}`)
        state.mounts.push({ source: `/dev/${d}`, target: mountPointOf(d), fstype: 'vfat' })
    },
    umount: async (d) => {
        state.calls.push(`umount ${d}`)
        if (state.umountFails) {
            throw Object.assign(new Error('umount failed'), { stderr: `umount: ${mountPointOf(d)}: target is busy.` })
        }
        // umount removes the top mount only (stacked mounts need one per layer)
        const i = state.mounts.map(m => m.target).lastIndexOf(mountPointOf(d))
        if (i >= 0) state.mounts.splice(i, 1)
    },
    rmdir: async (p) => { state.calls.push(`rmdir ${p}`) },
})
const newState = (mounts: MountEntry[] = [], uuid: string | null = 'AAAA-1111'): FakeState =>
    ({ mounts, calls: [], umountFails: false, uuid })

// ── Already mounted: findmnt by target and source ──────────────────────────

describe('already-mounted check before mount (idea#126)', () => {
    const device = 'idea-test-126'
    const target = () => mountPointOf(device)

    it('finds a vfat partition already mounted at its target (target and source match) and does not mount again', async () => {
        const state = newState([
            { source: '/dev/sda2', target: '/', fstype: 'ext4' },
            { source: `/dev/${device}`, target: target(), fstype: 'vfat' },
        ])
        expect(await checkMountState(device, fakeOps(state))).toEqual({ state: 'mounted' })
        const r = await safeMount(device, fakeOps(state))
        expect(r).toEqual({ ok: true, alreadyMounted: true, fsUuid: 'AAAA-1111' })
        expect(state.calls.filter(c => c.startsWith('mount ') || c.startsWith('mkdir '))).toEqual([])
    })

    it('also for ext4, and for a stacked double mount of the same partition', async () => {
        const ext4 = newState([{ source: `/dev/${device}`, target: target(), fstype: 'ext4' }])
        expect(await checkMountState(device, fakeOps(ext4))).toEqual({ state: 'mounted' })
        const stacked = newState([
            { source: `/dev/${device}`, target: target(), fstype: 'vfat' },
            { source: `/dev/${device}`, target: target(), fstype: 'vfat' },
        ])
        expect((await safeMount(device, fakeOps(stacked))).ok).toBe(true)
        expect(stacked.calls).not.toContain(`mount ${device}`)
    })

    it('detects by source: the vfat partition mounted somewhere else is not mounted again', async () => {
        const state = newState([{ source: `/dev/${device}`, target: '/media/pi/STICK', fstype: 'vfat' }])
        const check = await checkMountState(device, fakeOps(state))
        expect(check.state).toBe('deviceElsewhere')
        const r = await safeMount(device, fakeOps(state))
        expect(r.ok).toBe(false)
        expect(!r.ok && r.message).toContain('already mounted')
        expect(state.calls).not.toContain(`mount ${device}`)
    })

    it('refuses to mount onto a target that is already a mount point (another filesystem there)', async () => {
        const state = newState([{ source: '/dev/sdq1', target: target(), fstype: 'vfat' }])
        expect((await checkMountState(device, fakeOps(state))).state).toBe('targetBusy')
        const r = await safeMount(device, fakeOps(state))
        expect(r.ok).toBe(false)
        expect(!r.ok && r.message).toContain('is already a mount point')
        expect(state.calls).not.toContain(`mount ${device}`)
        expect(state.calls).not.toContain(`mkdir ${device}`)
    })

    it('refuses when mountpoint -q says the target is a mount point even if findmnt lists no match', async () => {
        const state = newState()
        const ops = { ...fakeOps(state), isMountPoint: async () => true }
        expect((await checkMountState(device, ops)).state).toBe('targetBusy')
        expect((await safeMount(device, ops)).ok).toBe(false)
    })

    it('mounts a free partition and returns the fsUuid from lsblk', async () => {
        const state = newState([], 'B1C2-D3E4')
        const r = await safeMount(device, fakeOps(state))
        expect(r).toEqual({ ok: true, alreadyMounted: false, fsUuid: 'B1C2-D3E4' })
        expect(state.calls).toEqual(['findmnt', `mountpoint -q ${target()}`, `mkdir ${device}`, `mount ${device}`, `lsblk -no UUID /dev/${device}`])
    })
})

// ── Undock: umount loop then rmdir ─────────────────────────────────────────

describe('unmount loop then rmdir, never rm -fr (idea#126)', () => {
    let device = ''
    beforeEach(async () => { device = uniqueTestDevice(); await fs.ensureDir(diskPath(device)) })
    afterEach(async () => { await fs.remove(diskPath(device)) })

    it('a stacked double mount: umount repeats until mountpoint -q is false, then rmdir; no mount left behind', async () => {
        const m = { source: `/dev/${device}`, target: mountPointOf(device), fstype: 'vfat' }
        const state = newState([m, { ...m }])
        const r = await unmountAndRemove(device, fakeOps(state), UMOUNT_MAX_ATTEMPTS, 0)
        expect(r).toEqual({ ok: true, attempts: 2, removed: true })
        const mp = mountPointOf(device)
        expect(state.calls).toEqual([
            `mountpoint -q ${mp}`, `umount ${device}`,
            `mountpoint -q ${mp}`, `umount ${device}`,
            `mountpoint -q ${mp}`, `rmdir ${mp}`,
        ])
        expect(state.mounts.filter(x => x.target === mp)).toEqual([])
        expect(state.calls.join('\n')).not.toMatch(/rm -fr|rm -rf/)
    })

    it('a busy mount: gives up after UMOUNT_MAX_ATTEMPTS and never removes the folder', async () => {
        const state = newState([{ source: `/dev/${device}`, target: mountPointOf(device), fstype: 'ext4' }])
        state.umountFails = true
        const r = await unmountAndRemove(device, fakeOps(state), UMOUNT_MAX_ATTEMPTS, 0)
        expect(r.ok).toBe(false)
        expect(r.attempts).toBe(UMOUNT_MAX_ATTEMPTS)
        expect(!r.ok && r.message).toContain('target is busy')
        expect(state.calls.filter(c => c.startsWith('umount'))).toHaveLength(UMOUNT_MAX_ATTEMPTS)
        expect(state.calls.some(c => c.startsWith('rmdir'))).toBe(false)
        expect(await fs.pathExists(diskPath(device))).toBe(true)
    })

    it('not mounted: no umount, just rmdir; a missing folder is not an error', async () => {
        const state = newState()
        expect(await unmountAndRemove(device, fakeOps(state), 3, 0)).toEqual({ ok: true, attempts: 0, removed: true })
        expect(state.calls).toEqual([`mountpoint -q ${mountPointOf(device)}`, `rmdir ${mountPointOf(device)}`])
        await fs.remove(diskPath(device))
        const s2 = newState()
        expect(await unmountAndRemove(device, fakeOps(s2), 3, 0)).toEqual({ ok: true, attempts: 0, removed: false })
    })

    it('the real rmdir (test root, no sudo) refuses a folder that is not empty', async () => {
        await fs.writeFile(path.join(diskPath(device), 'data.txt'), 'disk data')
        await expect(removeMountPointFolder(diskPath(device))).rejects.toThrow()
        expect(await fs.pathExists(path.join(diskPath(device), 'data.txt'))).toBe(true)
    })

    it('the retry count is 5 with a 1 s delay (documented in docs/ARCHITECTURE.md)', () => {
        expect(UMOUNT_MAX_ATTEMPTS).toBe(5)
        expect(UMOUNT_RETRY_DELAY_MS).toBe(1000)
        const arch = fs.readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf-8')
        expect(arch).toContain('UMOUNT_MAX_ATTEMPTS')
    })
})

// ── Real MountOps with fake binaries: exact argv ───────────────────────────

describe('real mount commands: exact arguments (fake binaries on PATH)', () => {
    let binDir = ''
    const savedPath = process.env.PATH
    const log = () => path.join(binDir, 'calls')
    const readCalls = async (): Promise<string[][]> =>
        (await fs.readFile(log(), 'utf-8').catch(() => '')).split('\n---\n').filter(Boolean).map(b => b.split('\n').filter(Boolean))

    beforeAll(async () => {
        binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-126-fake-bin-'))
        // Each fake records "<name>\n<arg>\n<arg>...\n---\n" and prints FAKE_<NAME>_OUT
        for (const name of ['sudo', 'findmnt', 'mountpoint', 'lsblk']) {
            const envOut = `FAKE_${name.toUpperCase()}_OUT`
            const envExit = `FAKE_${name.toUpperCase()}_EXIT`
            await fs.writeFile(path.join(binDir, name),
                `#!/bin/sh\n{ echo ${name}; printf '%s\\n' "$@"; echo ---; } >> '${log()}'\nprintf '%s' "$${envOut}"\nexit \${${envExit}:-0}\n`,
                { mode: 0o755 })
        }
        process.env.PATH = `${binDir}:${savedPath}`
    })
    afterAll(async () => {
        process.env.PATH = savedPath
        if (binDir) await fs.remove(binDir)
    })
    beforeEach(async () => {
        await fs.remove(log())
        for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k]
    })

    // The command of the rmdir rule in 11-engine-files as a regex (sudo glob: [..] classes)
    const rmdirRule = (): RegExp => {
        const rules = fs.readFileSync(SUDOERS_11, 'utf-8').split('\n').filter(l => /^pi\s/.test(l) && l.includes(`${SUDO_RMDIR} `))
        expect(rules).toEqual(['pi ALL=(root) NOPASSWD: /usr/bin/rmdir /disks/sd[a-z][12]'])
        const glob = rules[0].replace(/^pi ALL=\(root\) NOPASSWD: /, '')
        return new RegExp('^' + glob.split(/(\[[^\]]+\])/).map(p =>
            p.startsWith('[') ? p : p.replace(/[.*+?^${}()|\\/]/g, c => '\\' + c)).join('') + '$')
    }

    it('rmdir of /disks/sdXN runs exactly `sudo /usr/bin/rmdir /disks/<dev>`, matching the sudoers entry', async () => {
        await removeMountPointFolder('/disks/sdz1')
        const calls = await readCalls()
        expect(calls).toEqual([['sudo', '/usr/bin/rmdir', '/disks/sdz1']])
        expect(calls[0].slice(1).join(' ')).toMatch(rmdirRule())
    })

    it('only /disks/sd[a-z][12] goes through sudo; the pattern equals the sudoers entry', () => {
        const rule = rmdirRule()
        for (const p of ['/disks/sda1', '/disks/sdb2', '/disks/sdz1']) {
            expect(SUDO_RMDIR_PATH.test(p), p).toBe(true)
            expect(`${SUDO_RMDIR} ${p}`).toMatch(rule)
        }
        for (const p of ['/disks/sda', '/disks/sda3', '/disks/old', '/disks/sda1/x', '/disks/sda1/', '/tmp/disks/sda1', '/disks/sd*']) {
            expect(SUDO_RMDIR_PATH.test(p), p).toBe(false)
            expect(`${SUDO_RMDIR} ${p}`).not.toMatch(rule)
        }
    })

    it('a sudo rmdir failure (e.g. folder not empty) is thrown', async () => {
        process.env.FAKE_SUDO_EXIT = '1'
        await expect(removeMountPointFolder('/disks/sdz2')).rejects.toThrow()
    })

    it('listMounts reads findmnt JSON (vfat and ext4) by source and target, stripping bind suffixes', async () => {
        process.env.FAKE_FINDMNT_OUT = JSON.stringify({ filesystems: [
            { source: '/dev/sdb1', target: '/disks/sdb1', fstype: 'vfat' },
            { source: '/dev/sdb2', target: '/disks/sdb2', fstype: 'ext4' },
            { source: '/dev/sdb2[/instances]', target: '/srv/x', fstype: 'ext4' },
        ] })
        const mounts = await defaultMountOps.listMounts()
        expect(mounts).toEqual([
            { source: '/dev/sdb1', target: '/disks/sdb1', fstype: 'vfat' },
            { source: '/dev/sdb2', target: '/disks/sdb2', fstype: 'ext4' },
            { source: '/dev/sdb2', target: '/srv/x', fstype: 'ext4' },
        ])
        expect(await readCalls()).toEqual([['findmnt', '-J', '-l', '-o', 'SOURCE,TARGET,FSTYPE']])
    })

    it('mountpoint -q, lsblk -no UUID and findmnt -no UUID use the agreed commands (no sudo)', async () => {
        expect(await defaultMountOps.isMountPoint('/disks/sdb1')).toBe(true)
        process.env.FAKE_MOUNTPOINT_EXIT = '1'
        expect(await defaultMountOps.isMountPoint('/disks/sdb1')).toBe(false)
        process.env.FAKE_LSBLK_OUT = 'B1C2-D3E4\n'
        expect(await defaultMountOps.fsUuidOfDevice('sdb1')).toBe('B1C2-D3E4')
        process.env.FAKE_FINDMNT_OUT = 'B1C2-D3E4\nFFFF-0000\n'
        expect(await defaultMountOps.fsUuidAt('/disks/sdb1')).toBe('FFFF-0000') // top of a stack
        process.env.FAKE_FINDMNT_EXIT = '1'
        process.env.FAKE_FINDMNT_OUT = ''
        expect(await defaultMountOps.fsUuidAt('/disks/sdb1')).toBeNull()
        expect(await readCalls()).toEqual([
            ['mountpoint', '-q', '/disks/sdb1'],
            ['mountpoint', '-q', '/disks/sdb1'],
            ['lsblk', '-no', 'UUID', '/dev/sdb1'],
            ['findmnt', '-no', 'UUID', '/disks/sdb1'],
            ['findmnt', '-no', 'UUID', '/disks/sdb1'],
        ])
    })
})

// ── Dock / undock flow with a busy unmount (testMode + injected MountOps) ──

const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] =>
    h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])

describe('busy unmount on undock sets Disk.unmountError; the next mount clears it (idea#126)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    const logHandle = newCommandLog()
    const state = newState([], 'CAFE-0126')
    const fixtures: Record<string, string> = {}
    const devices: string[] = []

    const makeFixture = async (kind: 'empty' | 'backup'): Promise<string> => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), `idea-126-${kind}-`))
        const id = `idea126-${kind}-${Date.now()}`
        await fs.writeFile(path.join(dir, 'META.yaml'), `diskId: ${id}\ndiskName: ${kind}-disk\ncreated: 1\nlastDocked: 1\n`)
        if (kind === 'backup') await fs.writeFile(path.join(dir, 'BACKUP.yaml'), 'mode: on-demand\nlinks: []\n')
        fixtures[kind] = dir
        return id
    }

    beforeAll(async () => {
        setMountOps(fakeOps(state))
        setCommandLogHandle(logHandle)
        storeHandle = (await createTestStore()).storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    }, 15_000)

    afterAll(async () => {
        await watcher?.close()
        setMountOps(null)
        setCommandLogHandle(null)
        for (const d of devices) { await fs.remove(sentinelPath(d)).catch(() => {}); await cleanupDisk(d).catch(() => {}) }
        for (const dir of Object.values(fixtures)) await fs.remove(dir).catch(() => {})
    })

    for (const kind of ['empty', 'backup'] as const) {
        it(`${kind} disk: error trace, store updated, unmountError with all four fields; cleared on the next mount`, { timeout: 30_000 }, async () => {
            const diskId = await makeFixture(kind) as DiskID
            const device = uniqueTestDevice()
            devices.push(device)
            const mp = mountPointOf(device)

            state.umountFails = false
            await dockFixture(fixtures[kind], device)
            expect(await waitFor(storeHandle, s => s.diskDB[diskId]?.dockedTo === localEngineId)).toBe(true)
            expect(state.calls).toContain(`mount ${device}`)
            expect(state.calls).toContain(`lsblk -no UUID /dev/${device}`)
            if (kind === 'backup') {
                expect(await waitFor(storeHandle, s => !!s.diskDB[diskId]?.diskTypes?.includes('backup'))).toBe(true)
            }

            // Pull the disk while something keeps the mount busy
            state.umountFails = true
            await triggerUndock(device)
            expect(await waitFor(storeHandle, s => !!s.diskDB[diskId]?.unmountError, 15_000)).toBe(true)
            const disk = storeHandle.doc()!.diskDB[diskId]
            expect(disk.dockedTo).toBeNull()          // store updated anyway
            expect(disk.device).toBeNull()
            expect(disk.unmountError!.engineId).toBe(localEngineId)
            expect(disk.unmountError!.mountPoint).toBe(mp)
            expect(disk.unmountError!.fsUuid).toBe('CAFE-0126')
            expect(disk.unmountError!.message).toContain('target is busy')
            expect(state.calls.filter(c => c === `umount ${device}`)).toHaveLength(UMOUNT_MAX_ATTEMPTS)
            expect(state.calls).not.toContain(`rmdir ${mp}`)
            const failure = traces(logHandle).find(t => t.command === DISK_DETECTION_COMMAND &&
                JSON.parse(t.args).step === 'undock' && JSON.parse(t.args).device === device)
            expect(failure?.status).toBe('error')
            expect(JSON.parse(failure!.args).fsUuid).toBe('CAFE-0126')

            // The disk comes back (the old mount has gone): mounted again, error cleared
            state.mounts = state.mounts.filter(m => m.target !== mp)
            state.umountFails = false
            await fs.writeFile(sentinelPath(device), '')
            expect(await waitFor(storeHandle, s => s.diskDB[diskId]?.dockedTo === localEngineId && !s.diskDB[diskId]?.unmountError)).toBe(true)
            expect(storeHandle.doc()!.diskDB[diskId].unmountError).toBeNull()

            // A clean undock: umount once, then rmdir
            await triggerUndock(device)
            expect(await waitFor(storeHandle, s => s.diskDB[diskId]?.dockedTo === null)).toBe(true)
            expect(await waitFor(storeHandle, () => state.calls.includes(`rmdir ${mp}`))).toBe(true)
            expect(storeHandle.doc()!.diskDB[diskId].unmountError ?? null).toBeNull()
        })
    }
})

// ── Startup cleanup ─────────────────────────────────────────────────────────

describe('startup cleanup of unmountError (idea#126)', () => {
    const OTHER = 'ENGINE_other' as EngineID
    const base = { created: 1 as Timestamp, lastDocked: 1 as Timestamp, device: null, dockedTo: null, diskTypes: [], backupConfig: null }
    const err = (engineId: EngineID, mountPoint: string, fsUuid: string | null) =>
        ({ engineId, mountPoint, fsUuid, message: 'busy' })

    it('clears errors whose mount point is gone or holds another filesystem; keeps the same filesystem; never touches other Engines', async () => {
        const { storeHandle } = await createTestStore()
        storeHandle.change(doc => {
            const add = (id: string, e: any) => { doc.diskDB[id as DiskID] = { ...base, id: id as DiskID, name: id as DiskName, unmountError: e } as any }
            add('notMounted', err(localEngineId as EngineID, '/disks/sdb1', 'UUID-B1'))
            add('otherDisk', err(localEngineId as EngineID, '/disks/sdc1', 'UUID-C1'))
            add('sameFs', err(localEngineId as EngineID, '/disks/sdd1', 'UUID-D1'))
            add('unknownUuid', err(localEngineId as EngineID, '/disks/sde1', null))
            add('otherEngine', err(OTHER, '/disks/sdb1', 'UUID-X'))
            add('noError', null)
        })
        const mounted: Record<string, string> = { '/disks/sdc1': 'UUID-NEW', '/disks/sdd1': 'UUID-D1', '/disks/sde1': 'UUID-E' }
        const queried: string[] = []
        const ops = { ...defaultMountOps, fsUuidAt: async (p: string) => { queried.push(p); return mounted[p] ?? null } }

        const cleared = await clearStaleUnmountErrors(storeHandle, localEngineId as EngineID, ops)

        expect(cleared.sort()).toEqual(['notMounted', 'otherDisk'])
        const db = storeHandle.doc()!.diskDB
        expect(db['notMounted' as DiskID].unmountError).toBeNull()
        expect(db['otherDisk' as DiskID].unmountError).toBeNull()
        expect(db['sameFs' as DiskID].unmountError?.fsUuid).toBe('UUID-D1')
        expect(db['unknownUuid' as DiskID].unmountError?.mountPoint).toBe('/disks/sde1')
        expect(db['otherEngine' as DiskID].unmountError?.engineId).toBe(OTHER)
        expect(queried.sort()).toEqual(['/disks/sdb1', '/disks/sdc1', '/disks/sdd1', '/disks/sde1'])
    })

    it('start.ts runs the cleanup at startup with this Engine id', () => {
        const start = fs.readFileSync(path.join(ROOT, 'src/start.ts'), 'utf-8')
        expect(start).toMatch(/await clearStaleUnmountErrors\(storeHandle, localEngineId\)/)
    })
})
