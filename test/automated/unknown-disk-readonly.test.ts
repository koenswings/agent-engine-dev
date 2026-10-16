/**
 * unknown-disk-readonly.test.ts
 *
 * idea#201 §10 rule 1: the Engine never writes META.yaml to, and never mounts
 * read-write, a disk it does not recognise as an IDEA disk (no META.yaml).
 * Client SD cards, an Ubuntu card, a foreign ext4 disk: looked at read-only
 * (ext4 ro,noload) at most, released again, never registered.
 *
 * Mount commands are faked through setMountOps, so nothing is mounted and
 * /disks is never touched.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import { fs, path, sleep } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { DiskID } from '../../src/data/CommonTypes.js'
import { localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    MountEntry, MountOps, lookForIdeaMeta, setMountOps, mountPointOf,
    mountExt4ReadOnlyCommand, SUDO_MOUNT_RO_PATTERN,
} from '../../src/monitors/mounts.js'
import {
    createTestStore, dockFixture, cleanupDisk, waitFor, uniqueTestDevice, sentinelPath, diskPath,
} from '../harness/diskSim.js'

const ROOT = process.cwd()

interface FakeState { mounts: MountEntry[], calls: string[], roMountFails: boolean }
const newState = (mounts: MountEntry[] = []): FakeState => ({ mounts, calls: [], roMountFails: false })

const fakeOps = (state: FakeState): MountOps => ({
    listMounts: async () => [...state.mounts],
    isMountPoint: async (p) => state.mounts.some(m => m.target === p),
    fsUuidOfDevice: async () => 'UUID-201',
    fsUuidAt: async () => null,
    mkdir: async (d) => { state.calls.push(`mkdir ${d}`) },
    mount: async (d) => {
        state.calls.push(`mount ${d}`)
        state.mounts.push({ source: `/dev/${d}`, target: mountPointOf(d), fstype: 'ext4' })
    },
    mountReadOnly: async (d) => {
        state.calls.push(`mount -o ro ${d}`)
        if (state.roMountFails) throw new Error('wrong fs type')
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

describe('lookForIdeaMeta: read-only look before any rw mount (idea#201 §10)', () => {
    const dev = 'sdz1'
    const mp = mountPointOf(dev)

    it('no META.yaml: ro mount, released, mount point removed, never mounted rw', async () => {
        const state = newState()
        const r = await lookForIdeaMeta(dev, fakeOps(state), () => false)
        expect(r).toEqual({ ok: true, hasMeta: false, alreadyMounted: false })
        expect(state.calls[0]).toBe(`mkdir ${dev}`)
        expect(state.calls[1]).toBe(`mount -o ro ${dev}`)
        expect(state.calls).toContain(`umount ${dev}`)
        expect(rwMounts(state, dev)).toHaveLength(0)
        expect(state.mounts).toHaveLength(0)
    })

    it('META.yaml present: hasMeta, and still released (the rw mount is the caller\'s step)', async () => {
        const state = newState()
        const r = await lookForIdeaMeta(dev, fakeOps(state), () => true)
        expect(r).toEqual({ ok: true, hasMeta: true, alreadyMounted: false })
        expect(rwMounts(state, dev)).toHaveLength(0)
        expect(state.mounts).toHaveLength(0)
    })

    it('already mounted at its target (Engine restart): looked at in place, nothing mounted or unmounted', async () => {
        const state = newState([{ source: `/dev/${dev}`, target: mp, fstype: 'ext4' }])
        const r = await lookForIdeaMeta(dev, fakeOps(state), () => false)
        expect(r).toEqual({ ok: true, hasMeta: false, alreadyMounted: true })
        expect(state.calls).toEqual([])
    })

    it('target busy or device mounted elsewhere: refused, nothing mounted', async () => {
        const busy = newState([{ source: '/dev/sdy1', target: mp, fstype: 'ext4' }])
        expect((await lookForIdeaMeta(dev, fakeOps(busy), () => true)).ok).toBe(false)
        const elsewhere = newState([{ source: `/dev/${dev}`, target: '/media/pi/rootfs', fstype: 'ext4' }])
        expect((await lookForIdeaMeta(dev, fakeOps(elsewhere), () => true)).ok).toBe(false)
        expect([...busy.calls, ...elsewhere.calls].filter(c => c.startsWith('mount'))).toEqual([])
    })

    it('ro mount fails (not ext4, corrupt): refused, mount point removed, never retried rw', async () => {
        const state = newState()
        state.roMountFails = true
        const r = await lookForIdeaMeta(dev, fakeOps(state), () => true)
        expect(r.ok).toBe(false)
        expect(state.calls).toEqual([`mkdir ${dev}`, `mount -o ro ${dev}`, `rmdir ${mp}`])
    })

    it('real command and sudoers entry match exactly (ro,noload: no journal replay)', () => {
        expect(mountExt4ReadOnlyCommand('sdb2', '/disks/sdb2'))
            .toEqual(['/usr/bin/mount', '-t', 'ext4', '-o', 'ro,noload', '/dev/sdb2', '/disks/sdb2'])
        const sudoers = fs.readFileSync(path.join(ROOT, 'script/build_image_assets/11-engine-files.sudoers'), 'utf8')
        expect(sudoers).toContain(`pi ALL=(root) NOPASSWD: ${SUDO_MOUNT_RO_PATTERN.replace('ro,noload', 'ro\\,noload')}`)
        const src = fs.readFileSync(path.join(ROOT, 'src/monitors/mounts.ts'), 'utf8')
        expect(src).toContain('sudo /usr/bin/mount -t ext4 -o ro,noload /dev/${device} ${mp}')
    })

    it('capability unknownDiskReadOnly is advertised', () => {
        expect(ENGINE_CAPABILITIES).toContain('unknownDiskReadOnly')
    })
})

describe('dock flow: unknown disks are never written or mounted rw (idea#201 §10)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    const state = newState()
    const dirs: string[] = []
    const devices: string[] = []

    const fixture = async (files: Record<string, string>): Promise<string> => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-201-'))
        for (const [name, content] of Object.entries(files)) {
            await fs.ensureDir(path.dirname(path.join(dir, name)))
            await fs.writeFile(path.join(dir, name), content)
        }
        dirs.push(dir)
        return dir
    }
    const diskCount = () => Object.keys(storeHandle.doc()!.diskDB).length

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

    const cases: Array<[string, Record<string, string>]> = [
        ['Ubuntu card rootfs', { 'etc/os-release': 'NAME="Ubuntu"\n', 'etc/hostname': 'koen-ubuntu\n' }],
        ['IDEA client card rootfs', { 'etc/idea-client/version': '26.04-20261015-ab12cd3\n' }],
        ['empty foreign ext4 disk', {}],
    ]
    for (const [name, files] of cases) {
        it(`${name}: ro look only, no META.yaml written, not registered`, { timeout: 20_000 }, async () => {
            const device = uniqueTestDevice()
            devices.push(device)
            const before = diskCount()
            await dockFixture(await fixture(files), device)
            expect(await waitFor(storeHandle, () => state.calls.includes(`umount ${device}`), 10_000)).toBe(true)
            await sleep(500)
            expect(state.calls).toContain(`mount -o ro ${device}`)
            expect(rwMounts(state, device)).toHaveLength(0)
            expect(fs.existsSync(path.join(diskPath(device), 'META.yaml'))).toBe(false)
            expect(diskCount()).toBe(before)
            expect(state.mounts.filter(m => m.target === mountPointOf(device))).toHaveLength(0)
        })
    }

    it('IDEA disk with META.yaml: ro look, then rw mount and registered as before', { timeout: 20_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)
        const id = `idea201-known-${Date.now()}` as DiskID
        await dockFixture(await fixture({ 'META.yaml': `diskId: ${id}\ndiskName: known\ncreated: 1\nlastDocked: 1\n` }), device)
        expect(await waitFor(storeHandle, s => s.diskDB[id]?.dockedTo === localEngineId)).toBe(true)
        const ro = state.calls.indexOf(`mount -o ro ${device}`)
        expect(ro).toBeGreaterThanOrEqual(0)
        expect(state.calls.indexOf(`mount ${device}`)).toBeGreaterThan(ro)
    })

    it('testMode without mount commands: fixture without META.yaml gets no META.yaml and is not registered', { timeout: 20_000 }, async () => {
        setMountOps(null)
        try {
            const device = uniqueTestDevice()
            devices.push(device)
            const before = diskCount()
            await dockFixture(await fixture({ 'boot/cmdline.txt': 'console=tty1\n' }), device)
            await sleep(3000)
            expect(fs.existsSync(path.join(diskPath(device), 'META.yaml'))).toBe(false)
            expect(diskCount()).toBe(before)
        } finally {
            setMountOps(fakeOps(state))
        }
    })
})
