/**
 * usb-monitor-missing-watch-dir.test.ts
 *
 * agent-engine-dev#228 follow-up: on kind-panda (Pi 5, NVMe root, no USB disk)
 * /dev/engine does not exist. udev creates it only with the first sd* link. The
 * monitor ran `ls /dev/engine`, threw, and never registered the system disk.
 *
 *   1. listDeviceFolder: a missing folder is an empty list, not an error
 *   2. registerUnlinkedSystemDisk: an NVMe/mmcblk root is registered directly,
 *      also when the watch folder does not exist; never with IDEA_SYSTEM_DISK_SKIP
 *      or for an sd root (which comes in through its udev link)
 *   3. watchDeviceFolderWhenPresent: attaches when the folder appears later,
 *      reports links already in it and new ones, detaches (unlinking what it
 *      reported) when the folder goes, and re-attaches when it comes back
 *   4. enableUsbDeviceMonitor starts with a missing watch folder and docks a disk
 *      whose link appears after the folder is created
 *   5. Source checks: no `ls` of the watch folder or /disks is left, and the
 *      direct registration runs outside the startup cleanup and before the watcher
 *
 * Everything runs in private temp folders; nothing touches /dev/engine or /disks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { fs, sleep } from 'zx'
import {
    listDeviceFolder, registerUnlinkedSystemDisk, watchDeviceFolderWhenPresent, enableUsbDeviceMonitor,
    DeviceFolderWatch,
} from '../../src/monitors/usbDeviceMonitor.js'
import { createTestStore, diskPath, uniqueTestDevice, cleanupDisk } from '../harness/diskSim.js'

const ROOT = process.cwd()
const POLL_MS = 50

let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-228-watch-')) })
afterEach(async () => { await fs.remove(tmp) })

const until = async (cond: () => boolean, timeoutMs = 5000): Promise<boolean> => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (cond()) return true
        await sleep(25)
    }
    return cond()
}

describe('listDeviceFolder', () => {
    it('a missing folder is an empty list, not an error', async () => {
        await expect(listDeviceFolder(path.join(tmp, 'engine'))).resolves.toEqual([])
    })
    it('lists the entries of an existing folder', async () => {
        const dir = path.join(tmp, 'engine')
        await fs.ensureDir(dir)
        await fs.symlink('/nonexistent/sda', path.join(dir, 'sda'))
        await fs.symlink('/nonexistent/sda1', path.join(dir, 'sda1'))
        expect((await listDeviceFolder(dir)).sort()).toEqual(['sda', 'sda1'])
    })
    it('a path that is not a folder is read as empty', async () => {
        const file = path.join(tmp, 'file')
        await fs.writeFile(file, '')
        await expect(listDeviceFolder(file)).resolves.toEqual([])
    })
})

describe('registerUnlinkedSystemDisk', () => {
    const run = (systemDevice: string | null, watchDir: string, systemDiskSkip = false) => {
        const calls: string[] = []
        const started = registerUnlinkedSystemDisk({ systemDevice, watchDir, systemDiskSkip, addDevice: async (p) => { calls.push(p) } })
        return { started, calls }
    }

    it('registers an NVMe root directly when the watch folder does not exist', () => {
        const watchDir = path.join(tmp, 'engine')
        const r = run('nvme0n1p2', watchDir)
        expect(r.started).toBe(true)
        expect(r.calls).toEqual([`${watchDir}/nvme0n1p2`])
    })
    it('registers an mmcblk root directly', () => {
        const r = run('mmcblk0p2', path.join(tmp, 'engine'))
        expect(r.calls).toEqual([`${path.join(tmp, 'engine')}/mmcblk0p2`])
    })
    it('not with IDEA_SYSTEM_DISK_SKIP, not without a root device, not for an sd root', () => {
        expect(run('nvme0n1p2', path.join(tmp, 'engine'), true)).toEqual({ started: false, calls: [] })
        expect(run(null, path.join(tmp, 'engine'))).toEqual({ started: false, calls: [] })
        expect(run('sda2', path.join(tmp, 'engine'))).toEqual({ started: false, calls: [] })
    })
    it('not when the watch folder already has a link for it', async () => {
        const watchDir = path.join(tmp, 'engine')
        await fs.ensureDir(watchDir)
        await fs.writeFile(path.join(watchDir, 'nvme0n1p2'), '')
        expect(run('nvme0n1p2', watchDir)).toEqual({ started: false, calls: [] })
    })
    it('a failing addDevice is caught (never an unhandled rejection)', async () => {
        const started = registerUnlinkedSystemDisk({
            systemDevice: 'nvme0n1p2', watchDir: path.join(tmp, 'engine'), systemDiskSkip: false,
            addDevice: async () => { throw new Error('boom') },
        })
        expect(started).toBe(true)
        await sleep(20)
    })
})

describe('watchDeviceFolderWhenPresent', () => {
    let w: DeviceFolderWatch | null = null
    afterEach(async () => { await w?.close(); w = null })

    // A link to an existing block-device stand-in (chokidar does not report dangling
    // links; the real /dev/engine links always point at an existing /dev/sdX)
    const link = async (to: string) => {
        const target = path.join(tmp, 'blockdev')
        if (!fs.existsSync(target)) await fs.writeFile(target, '')
        await fs.symlink(target, to)
    }

    const start = (dir: string) => {
        const events: string[] = []
        const errors: unknown[] = []
        w = watchDeviceFolderWhenPresent(dir, {
            add: p => { events.push(`add ${path.basename(p)}`) },
            unlink: p => { events.push(`unlink ${path.basename(p)}`) },
            error: e => { errors.push(e) },
        }, POLL_MS)
        return { events, errors }
    }

    it('starts without the folder and attaches when it appears later (first USB disk)', async () => {
        const dir = path.join(tmp, 'engine')
        const { events, errors } = start(dir)
        expect(w!.isAttached()).toBe(false)
        await sleep(3 * POLL_MS)
        expect(events).toEqual([])

        // udev creates the folder together with the first link
        await fs.ensureDir(dir)
        await link(path.join(dir, 'sda'))
        await link(path.join(dir, 'sda1'))
        expect(await until(() => events.includes('add sda') && events.includes('add sda1'))).toBe(true)
        expect(w!.isAttached()).toBe(true)

        // A link created after attaching is reported too
        await link(path.join(dir, 'sdb2'))
        expect(await until(() => events.includes('add sdb2'))).toBe(true)
        expect(errors).toEqual([])
    })

    it('an existing folder is watched at once', async () => {
        const dir = path.join(tmp, 'engine')
        await fs.ensureDir(dir)
        await link(path.join(dir, 'sda1'))
        const { events } = start(dir)
        expect(w!.isAttached()).toBe(true)
        expect(await until(() => events.includes('add sda1'))).toBe(true)
        await fs.remove(path.join(dir, 'sda1'))
        expect(await until(() => events.includes('unlink sda1'))).toBe(true)
    })

    it('detaches when the folder goes (unlinking what it reported) and re-attaches when it comes back', async () => {
        const dir = path.join(tmp, 'engine')
        await fs.ensureDir(dir)
        await link(path.join(dir, 'sda1'))
        const { events } = start(dir)
        expect(await until(() => events.includes('add sda1'))).toBe(true)

        await fs.remove(dir)
        expect(await until(() => !w!.isAttached() && events.includes('unlink sda1'))).toBe(true)
        expect(events.filter(e => e === 'unlink sda1')).toHaveLength(1)

        await fs.ensureDir(dir)
        await link(path.join(dir, 'sdc1'))
        expect(await until(() => w!.isAttached() && events.includes('add sdc1'))).toBe(true)
    })

    it('close stops the polling and the watcher', async () => {
        const dir = path.join(tmp, 'engine')
        const { events } = start(dir)
        await w!.close()
        await fs.ensureDir(dir)
        await fs.writeFile(path.join(dir, 'sda1'), '')
        await sleep(5 * POLL_MS)
        expect(events).toEqual([])
        expect(w!.isAttached()).toBe(false)
    })
})

describe('enableUsbDeviceMonitor with a missing watch folder', () => {
    let saved: string | undefined
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>> | null = null
    const device = uniqueTestDevice()
    beforeEach(() => { saved = process.env.IDEA_WATCH_DIR })
    afterEach(async () => {
        await watcher?.close(); watcher = null
        process.env.IDEA_WATCH_DIR = saved
        await cleanupDisk(device)
    })

    it('starts, then docks a disk whose link appears once the folder exists', async () => {
        const watchDir = path.join(tmp, 'engine-missing')
        process.env.IDEA_WATCH_DIR = watchDir
        const { storeHandle } = await createTestStore()
        watcher = await enableUsbDeviceMonitor(storeHandle)
        expect(fs.existsSync(watchDir)).toBe(false)

        await fs.outputFile(path.join(diskPath(device), 'META.yaml'),
            `diskId: "test-228-${device}"\nisHardwareId: false\ndiskName: "test-228"\ncreated: 1700000000000\nlastDocked: 1700000000000\n`)
        await fs.ensureDir(watchDir)
        await fs.writeFile(path.join(watchDir, device), '')

        const docked = await until(() => Object.values(storeHandle.doc()!.diskDB).some(d => d.device === device && !!d.dockedTo), 10000)
        expect(docked).toBe(true)
    }, 20000)
})

describe('usbDeviceMonitor startup source checks', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/monitors/usbDeviceMonitor.ts'), 'utf8')
    it('never shells out to ls for the watch folder or the mount root', () => {
        expect(src).not.toMatch(/\$`ls \$\{/)
        expect(src).toMatch(/listDeviceFolder\(watchDir\)/)
        expect(src).toMatch(/listDeviceFolder\(disksRoot\(\)\)/)
    })
    it('registers the system disk outside the startup cleanup and before the watcher', () => {
        const cleanupCatch = src.indexOf('startup cleanup failed (monitor continues)')
        const register = src.indexOf('registerUnlinkedSystemDisk({ systemDevice, watchDir')
        const watch = src.indexOf('const watcher = watchDeviceFolderWhenPresent(watchDir,')
        expect(cleanupCatch).toBeGreaterThan(0)
        expect(register).toBeGreaterThan(cleanupCatch)
        expect(watch).toBeGreaterThan(register)
    })
})
