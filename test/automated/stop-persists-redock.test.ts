/**
 * stop-persists-redock.test.ts: a user's Stop survives every dock path (idea#176).
 *
 * #155 at 2fc8ec4 failed on the Path A pool: nextcloud-grade5a-001 was stopped by
 * the operator, the Engine restarted, and checkAndSetUndockedApps kept it Stopped.
 * But the testMode startup in enableUsbDeviceMonitor treats every disk as gone
 * (actualDevices = [] when isDev || testMode), undocks it (Stopped -> Undocked)
 * and the watcher re-adds it (Undocked -> Docked), and the dock pass auto-started it.
 *
 * These tests drive the real enableUsbDeviceMonitor (chokidar on IDEA_WATCH_DIR,
 * real undockDisk / addDevice / processDisk / processInstance / tracedStartInstance)
 * with the real stopInstance:
 *   - testMode: Engine restart (startup undock + re-add) and a physical unplug + replug;
 *   - production mode (testMode off, injected MountOps, sd* device names): a normal
 *     boot with the disk present, a boot where the disk shows up late or under
 *     another device name (startup undock, then add), and a hot unplug + replug.
 * Docker is replaced by an in-memory container table and startInstance is recorded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
    running: new Set<string>(),    // instance ids with a running container
    started: [] as string[],       // starts done by the Engine (tracedStartInstance / commands)
    sudo: [] as string[],          // `sudo rm` commands the production path tried (never run)
}))

vi.mock('node-docker-api', () => ({
    Docker: class {
        container = {
            list: async () => [...h.running].map(id => ({
                data: { Names: [`/${id}-sample-1`] },
                stop: async () => { h.running.delete(id) },
                kill: async () => { h.running.delete(id) },
            })),
        }
    },
}))

// startInstance: recorded; a successful start sets Running and lastStarted (as the real one)
vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        startInstance: vi.fn(async (handle: any, inst: any) => {
            h.started.push(String(inst.id))
            h.running.add(String(inst.id))
            handle.change((doc: any) => {
                const i = doc.instanceDB[inst.id]
                if (i) { i.status = 'Running'; i.lastStarted = Date.now() }
            })
        }),
    }
})

// Production mode only: `sudo rm -fr <disksRoot>/old` must never run here
vi.mock('zx', async (importOriginal) => {
    const actual = await importOriginal<any>()
    const mocked = vi.fn((strings: any, ...vals: any[]) => {
        if (Array.isArray(strings) && /^\s*sudo rm\s/.test(strings[0])) {
            const cmd = strings.reduce((acc: string, s: string, i: number) => acc + s + (i < vals.length ? String(vals[i]) : ''), '')
            h.sudo.push(cmd)
            const p: any = Promise.resolve({ stdout: '', stderr: '', exitCode: 0, toString: () => '' })
            p.quiet = () => p; p.nothrow = () => p
            return p
        }
        return actual.$(strings, ...vals)
    }) as any
    mocked.sync = actual.$.sync
    return { ...actual, $: mocked }
})

import path from 'path'
import { fs } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { config } from '../../src/data/Config.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import { MountEntry, setMountOps, mountPointOf } from '../../src/monitors/mounts.js'
import { checkAndSetUndockedApps } from '../../src/data/UndockedApps.js'
import { recoverInterruptedOperations } from '../../src/data/Operations.js'
import { startInstance, stopInstance } from '../../src/data/Instance.js'
import { InstanceID, OperationCause } from '../../src/data/CommonTypes.js'
import {
    createTestStore, dockFixture, triggerUndock, cleanupDisk, waitFor, uniqueTestDevice,
    diskPath, sentinelPath, FIXTURES_DIR,
} from '../harness/diskSim.js'

const FIXTURE = path.resolve(FIXTURES_DIR, 'disk-sample-v1')
const DISK = 'test-fixture-sample-v1'
const INST = 'sample-00000000-test1'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Watcher = Awaited<ReturnType<typeof enableUsbDeviceMonitor>>

let watchers: Watcher[] = []
let devices: string[] = []

const closeWatchers = async () => { for (const w of watchers) await w.close().catch(() => {}); watchers = [] }

/** start.ts order: startup check, crash recovery, then the USB device monitor. */
const bootEngine = async (handle: DocHandle<Store>) => {
    await checkAndSetUndockedApps(handle, localEngineId, async (id) => h.running.has(String(id)))
    await recoverInterruptedOperations(handle, {})
    watchers.push(await enableUsbDeviceMonitor(handle))
}

/** pm2 restart: the old process is gone (watcher closed), containers keep their state. */
const restartEngine = async (handle: DocHandle<Store>) => {
    await closeWatchers()
    h.started.length = 0
    await bootEngine(handle)
}

const inst = (handle: DocHandle<Store>) => handle.doc().instanceDB[INST as InstanceID] as any
const disk = (handle: DocHandle<Store>) => handle.doc().diskDB[DISK as any] as any
const status = (handle: DocHandle<Store>) => String(inst(handle)?.status)

/** Wait for a dock of the disk after `since` and for the instance to settle (Stopped/Running). */
const settle = async (handle: DocHandle<Store>, since: number) => {
    const ok = await waitFor(handle, s => {
        const d = s.diskDB[DISK as any] as any
        const i = s.instanceDB[INST as InstanceID] as any
        return !!d && String(d.dockedTo) === String(localEngineId) && (d.lastDocked ?? 0) >= since
            && !!i && (i.status === 'Stopped' || i.status === 'Running')
    }, 15_000)
    expect(ok, 'disk re-docked and instance settled').toBe(true)
    await sleep(600)   // let the dock pass finish (an auto-start would show up here)
}

const userStop = async (handle: DocHandle<Store>, cause: OperationCause = 'console-command') => {
    await stopInstance(handle, inst(handle), disk(handle), cause)
    expect(status(handle)).toBe('Stopped')
    expect(h.running.has(INST)).toBe(false)
    await sleep(2)
}

/** First boot with the disk attached on `device`: the instance is auto-started. */
const firstBoot = async (device: string) => {
    devices.push(device)
    await dockFixture(FIXTURE, device)
    const { storeHandle } = await createTestStore()
    const t0 = Date.now()
    await bootEngine(storeHandle)
    await settle(storeHandle, t0)
    expect(status(storeHandle)).toBe('Running')
    expect(h.started).toEqual([INST])
    h.started.length = 0
    return storeHandle
}

beforeEach(() => {
    h.running.clear(); h.started.length = 0; h.sudo.length = 0
})

afterEach(async () => {
    await closeWatchers()
    for (const d of devices) {
        await fs.remove(sentinelPath(d)).catch(() => {})
        await cleanupDisk(d).catch(() => {})
    }
    devices = []
})

describe('testMode (Path A pool): restart undocks and re-adds every disk', () => {
    it('a user-stopped instance stays Stopped across the startup undock + re-add (the r49 pool failure)', { timeout: 40_000 }, async () => {
        const handle = await firstBoot(uniqueTestDevice())
        await userStop(handle)

        const t = Date.now()
        await restartEngine(handle)
        await settle(handle, t)

        expect(status(handle)).toBe('Stopped')
        expect(h.started).not.toContain(INST)
        expect(h.running.has(INST)).toBe(false)
    })

    it('stays Stopped over repeated restarts', { timeout: 60_000 }, async () => {
        const handle = await firstBoot(uniqueTestDevice())
        await userStop(handle)
        for (let n = 0; n < 3; n++) {
            const t = Date.now()
            await restartEngine(handle)
            await settle(handle, t)
            expect(status(handle), `restart ${n + 1}`).toBe('Stopped')
        }
        expect(h.started).not.toContain(INST)
    })

    it('regression: a Running instance whose container is gone is auto-started after the restart', { timeout: 40_000 }, async () => {
        const handle = await firstBoot(uniqueTestDevice())
        h.running.clear()                                     // reboot: nothing running yet
        const t = Date.now()
        await restartEngine(handle)
        await settle(handle, t)
        expect(h.started).toContain(INST)
        expect(status(handle)).toBe('Running')
    })

    it('replug: a user-stopped instance stays Stopped after a physical unplug + replug', { timeout: 40_000 }, async () => {
        const device = uniqueTestDevice()
        const handle = await firstBoot(device)
        await userStop(handle)

        await triggerUndock(device)
        expect(await waitFor(handle, () => !disk(handle)?.dockedTo && status(handle) === 'Undocked')).toBe(true)
        const t = Date.now()
        await dockFixture(FIXTURE, device)
        await settle(handle, t)

        expect(status(handle)).toBe('Stopped')
        expect(h.started).not.toContain(INST)
    })

    it('replug: a Running instance is auto-started again (regression)', { timeout: 40_000 }, async () => {
        const device = uniqueTestDevice()
        const handle = await firstBoot(device)
        await triggerUndock(device)
        expect(await waitFor(handle, () => status(handle) === 'Undocked')).toBe(true)
        const t = Date.now()
        await dockFixture(FIXTURE, device)
        await settle(handle, t)
        expect(h.started).toContain(INST)
        expect(status(handle)).toBe('Running')
    })

    it('replug: an instance the Engine stopped itself (backup-pre-stop, interrupted) is started again', { timeout: 40_000 }, async () => {
        const device = uniqueTestDevice()
        const handle = await firstBoot(device)
        await userStop(handle, 'backup-pre-stop')
        await triggerUndock(device)
        expect(await waitFor(handle, () => status(handle) === 'Undocked')).toBe(true)
        const t = Date.now()
        await dockFixture(FIXTURE, device)
        await settle(handle, t)
        expect(h.started).toContain(INST)
        expect(status(handle)).toBe('Running')
    })

    it('a user start after the user stop ends it: the next restart auto-starts again', { timeout: 60_000 }, async () => {
        const handle = await firstBoot(uniqueTestDevice())
        await userStop(handle)
        let t = Date.now()
        await restartEngine(handle)
        await settle(handle, t)
        expect(status(handle)).toBe('Stopped')

        await startInstance(handle, inst(handle), disk(handle), 'console-command')   // the operator starts it
        expect(status(handle)).toBe('Running')
        h.running.clear()                                                           // reboot
        t = Date.now()
        await restartEngine(handle)
        await settle(handle, t)
        expect(h.started).toContain(INST)
        expect(status(handle)).toBe('Running')
    })
})

describe('production mode (testMode off): real startup disk scan and USB add', () => {
    let saved: { testMode: boolean; isDev: boolean; skipHardwareId: any; skipMetaUpdate: any }
    let mounts: MountEntry[]

    beforeEach(() => {
        const st = config.settings as any
        saved = { testMode: st.testMode, isDev: st.isDev, skipHardwareId: st.skipHardwareId, skipMetaUpdate: st.skipMetaUpdate }
        st.testMode = false; st.isDev = false
        // No block devices or root-owned META here: keep the fixture's id and META as they are
        st.skipHardwareId = true; st.skipMetaUpdate = true
        mounts = []
        setMountOps({
            listMounts: async () => [...mounts],
            isMountPoint: async (p: string) => mounts.some(m => m.target === p),
            fsUuidOfDevice: async () => 'AAAA-1111',
            fsUuidAt: async (p: string) => mounts.some(m => m.target === p) ? 'AAAA-1111' : null,
            mkdir: async () => {},
            mount: async (d: string) => { mounts.push({ source: `/dev/${d}`, target: mountPointOf(d), fstype: 'ext4' }) },
            umount: async (d: string) => { mounts = mounts.filter(m => m.target !== mountPointOf(d)) },
            rmdir: async () => {},
        })
    })

    afterEach(() => {
        Object.assign(config.settings as any, saved)
        setMountOps(null)
    })

    /** An sd* name that is not on this machine's system drive (the box/CI root is not sdq-sdz). */
    const sdDevice = (() => { let n = 0; const letters = 'qrstuvwxyz'; return () => `sd${letters[n++ % letters.length]}1` })()

    const prodFirstBoot = async (device: string) => {
        const handle = await firstBoot(device)
        expect(h.sudo.some(c => c.includes('rm -fr'))).toBe(true)   // the production startup branch ran (and was not executed)
        return handle
    }

    it('normal boot, disk still attached: no startup undock, the initial add keeps it Stopped', { timeout: 40_000 }, async () => {
        const handle = await prodFirstBoot(sdDevice())
        await userStop(handle)
        const t = Date.now()
        await restartEngine(handle)
        await settle(handle, t)
        expect(status(handle)).toBe('Stopped')
        expect(h.started).not.toContain(INST)
    })

    it('boot where the disk shows up late or under another device name: startup undock, then add, stays Stopped', { timeout: 40_000 }, async () => {
        const first = sdDevice()
        const handle = await prodFirstBoot(first)
        await userStop(handle)

        // Reboot: /dev/engine/<first> is not there when the Engine starts
        await fs.remove(sentinelPath(first))
        await closeWatchers()
        h.started.length = 0
        await bootEngine(handle)
        expect(status(handle)).toBe('Undocked')              // startup undocked the missing device
        // ...and the disk appears a moment later as another sd device
        const second = sdDevice(); devices.push(second)
        await fs.copy(diskPath(first), diskPath(second))
        const t = Date.now()
        await fs.writeFile(sentinelPath(second), '')
        await settle(handle, t)

        expect(String(disk(handle).device)).toBe(second)
        expect(status(handle)).toBe('Stopped')
        expect(h.started).not.toContain(INST)
    })

    it('regression: the same late/renamed boot still auto-starts a Running instance', { timeout: 40_000 }, async () => {
        const first = sdDevice()
        const handle = await prodFirstBoot(first)
        await fs.remove(sentinelPath(first))
        h.running.clear()
        await closeWatchers()
        h.started.length = 0
        await bootEngine(handle)
        const second = sdDevice(); devices.push(second)
        await fs.copy(diskPath(first), diskPath(second))
        const t = Date.now()
        await fs.writeFile(sentinelPath(second), '')
        await settle(handle, t)
        expect(h.started).toContain(INST)
        expect(status(handle)).toBe('Running')
    })

    it('hot unplug + replug of the USB disk: a user-stopped instance stays Stopped', { timeout: 40_000 }, async () => {
        const device = sdDevice()
        const handle = await prodFirstBoot(device)
        await userStop(handle)
        await triggerUndock(device)
        expect(await waitFor(handle, () => status(handle) === 'Undocked')).toBe(true)
        const t = Date.now()
        await fs.writeFile(sentinelPath(device), '')
        await settle(handle, t)
        expect(status(handle)).toBe('Stopped')
        expect(h.started).not.toContain(INST)
    })
})
