/**
 * stop-persists-restart.test.ts: a user's Stop survives an Engine restart (idea#176).
 *
 * Bug (Engine main@745f2c3, seen on idea02 2026-10-08): milkwise-idea02-001 was
 * stopped with the Engine's stopInstance (store: Stopped, container exited). After a
 * pm2 restart of the Engine it was running again within ~30 s:
 *   1. checkAndSetUndockedApps saw no running container and overwrote Stopped with
 *      Undocked;
 *   2. the dock pass (processSystemInstance / createOrUpdateInstance) resets
 *      Undocked to Docked;
 *   3. tracedStartInstance auto-started the Docked instance.
 *
 * These tests run that restart sequence (startup check, then the dock pass for the
 * system disk and for an App Disk) against a real Automerge store with the real
 * stopInstance. Docker is replaced by an in-memory container table and
 * startInstance is recorded, so nothing here needs Docker.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

const h = vi.hoisted(() => ({
    running: new Set<string>(),    // instance ids with a running container on this Pi
    started: [] as string[],       // auto-starts done by the dock pass
    sysRoot: '',                   // stands in for / (system disk: /instances/<id>)
}))

// Docker API used by the real stopInstance: list and stop the in-memory containers
vi.mock('node-docker-api', () => ({
    Docker: class {
        container = {
            list: async () => [...h.running].map(id => ({
                data: { Names: [`/${id}-app-1`] },
                stop: async () => { h.running.delete(id) },
                kill: async () => { h.running.delete(id) },
            })),
        }
    },
}))

// startInstance is recorded and marks the instance Running (no Docker)
vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        startInstance: vi.fn(async (handle: any, inst: any) => {
            h.started.push(String(inst.id))
            h.running.add(String(inst.id))
            handle.change((doc: any) => { doc.instanceDB[inst.id].status = 'Running' })
        }),
    }
})

// The system disk keeps instances at /instances/<id>: read them from a temp folder
vi.mock('zx', async (importOriginal) => {
    const actual = await importOriginal<any>()
    const mocked = vi.fn((strings: any, ...vals: any[]) => {
        if (Array.isArray(strings) && strings[0] === 'cat /instances/') {
            return actual.$`cat ${`${h.sysRoot}/instances/${vals[0]}/compose.yaml`}`
        }
        return actual.$(strings, ...vals)
    }) as any
    mocked.sync = actual.$.sync
    return { ...actual, $: mocked }
})

import os from 'os'
import path from 'path'
import { fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { processInstance, processSystemInstance, setRootDeviceForTests } from '../../src/data/Disk.js'
import { stopInstance } from '../../src/data/Instance.js'
import { checkAndSetUndockedApps, isUserStopped, lastStopOperation } from '../../src/data/UndockedApps.js'
import { createOperation, updateOperation } from '../../src/data/Operations.js'
import { DiskID, EngineID, InstanceID, OperationCause, Timestamp } from '../../src/data/CommonTypes.js'

const SYS = 'DISK_system-sp' as DiskID
const APPD = 'DISK_app-sp' as DiskID
const APP_DEV = 'idea-test-sp1'
const OTHER = 'engine-other' as EngineID

const MILKWISE = 'milkwise-idea02-001'      // system-disk instance, as on idea02
const KOLIBRI = 'kolibri-sp-001'            // App Disk instance
const NEXTCLOUD = 'nextcloud-sp-001'        // App Disk instance, left Running

const compose = (name: string, instanceName: string) => `x-app:
  name: ${name}
  version: "1.0"
  instanceName: ${instanceName}
  title: ${name}
  category: test
services:
  ${name}:
    image: example/${name}:1.0
`

const engine = (id: string) => ({ id, hostname: id, version: '1', hostOS: 'linux', created: 0, lastBooted: 0, lastRun: 0, lastHalted: null, commands: [] })
const diskRec = (id: string, device: string, types: string[], dockedTo: string = String(localEngineId)) =>
    ({ id, name: id, device, created: 0, lastDocked: 0, dockedTo, diskTypes: types, backupConfig: null })
const inst = (id: string, storedOn: string, status: string) => ({
    id, instanceOf: `${id.split('-')[0]}-1.0`, name: id, status, statusCondition: null, port: 0, serviceImages: [],
    created: 0, lastBackup: null, lastStarted: 0, storedOn, currentStep: null, totalSteps: null, stepLabel: null,
    metrics: null,
})

let tmp: string

beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-persists-'))
    h.sysRoot = `${tmp}/sysroot`
    await fs.outputFile(`${h.sysRoot}/instances/${MILKWISE}/compose.yaml`, compose('milkwise', MILKWISE))
    const appRoot = `${disksRoot()}/${APP_DEV}`
    await fs.outputFile(`${appRoot}/instances/${KOLIBRI}/compose.yaml`, compose('kolibri', KOLIBRI))
    await fs.outputFile(`${appRoot}/instances/${NEXTCLOUD}/compose.yaml`, compose('nextcloud', NEXTCLOUD))
    // The App Disk is not the root device, so its mount root is <disksRoot>/<device>
    setRootDeviceForTests('mmcblk0p2')
})

afterAll(async () => {
    setRootDeviceForTests(null)
    await fs.remove(tmp)
    await fs.remove(`${disksRoot()}/${APP_DEV}`)
})

beforeEach(() => {
    h.running.clear()
    h.started.length = 0
})

/** This Engine's store after a normal boot: all three instances Running with containers. */
const makeStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const handle = repo.create<Store>({
        engineDB: { [localEngineId]: engine(String(localEngineId)), [OTHER]: engine(OTHER) } as any,
        diskDB: {
            [SYS]: diskRec(SYS, 'mmcblk0p2', ['system']),
            [APPD]: diskRec(APPD, APP_DEV, ['app']),
        } as any,
        appDB: {},
        instanceDB: {
            [MILKWISE]: inst(MILKWISE, SYS, 'Running'),
            [KOLIBRI]: inst(KOLIBRI, APPD, 'Running'),
            [NEXTCLOUD]: inst(NEXTCLOUD, APPD, 'Running'),
        } as any,
        userDB: {},
        operationDB: {},
    } as any)
    await handle.whenReady()
    for (const id of [MILKWISE, KOLIBRI, NEXTCLOUD]) h.running.add(id)
    return handle
}

const disk = (handle: DocHandle<Store>, id: DiskID) => handle.doc().diskDB[id] as any
const status = (handle: DocHandle<Store>, id: string) => String(handle.doc().instanceDB[id as InstanceID]?.status)

/**
 * An Engine restart as start.ts runs it: the startup check (checkAndSetUndockedApps)
 * with whatever containers survived, then the dock pass for the system disk and the
 * App Disk (processSystemInstance / processInstance, which auto-start Docked instances).
 * `reboot`: the Pi rebooted; Docker brings back only containers that were not stopped
 * (restart: unless-stopped), which is the same set as before.
 */
const restartEngine = async (handle: DocHandle<Store>) => {
    await checkAndSetUndockedApps(handle, localEngineId, async (id) => h.running.has(String(id)))
    await processSystemInstance(handle, disk(handle, SYS), MILKWISE as InstanceID)
    await processInstance(handle, disk(handle, APPD), KOLIBRI as InstanceID)
    await processInstance(handle, disk(handle, APPD), NEXTCLOUD as InstanceID)
}

/** The real stopInstance, with the cause the caller had (console = the user's Stop). */
const stop = async (handle: DocHandle<Store>, id: string, diskId: DiskID, cause: OperationCause = 'console-command') => {
    const i = handle.doc().instanceDB[id as InstanceID] as any
    await stopInstance(handle, i, disk(handle, diskId), cause)
    expect(status(handle, id)).toBe('Stopped')
    expect(h.running.has(id)).toBe(false)
}

describe('a user Stop persists across an Engine restart', () => {
    it('system-disk instance (the idea02 milkwise case) stays Stopped and is not auto-started', async () => {
        const handle = await makeStore()
        await stop(handle, MILKWISE, SYS)

        await restartEngine(handle)

        expect(status(handle, MILKWISE)).toBe('Stopped')
        expect(h.started).not.toContain(MILKWISE)
        expect(h.running.has(MILKWISE)).toBe(false)
    })

    it('App Disk instance stays Stopped and is not auto-started', async () => {
        const handle = await makeStore()
        await stop(handle, KOLIBRI, APPD)

        await restartEngine(handle)

        expect(status(handle, KOLIBRI)).toBe('Stopped')
        expect(h.started).not.toContain(KOLIBRI)
    })

    it('stays Stopped over repeated restarts (pm2 restart, then the 05:00 reboot)', async () => {
        const handle = await makeStore()
        await stop(handle, MILKWISE, SYS)
        await stop(handle, KOLIBRI, APPD)
        for (let n = 0; n < 3; n++) await restartEngine(handle)
        expect(status(handle, MILKWISE)).toBe('Stopped')
        expect(status(handle, KOLIBRI)).toBe('Stopped')
        expect(h.started).not.toContain(MILKWISE)
        expect(h.started).not.toContain(KOLIBRI)
    })

    it('a stop issued by another Engine (cross-engine command) is also kept', async () => {
        const handle = await makeStore()
        await stop(handle, KOLIBRI, APPD, 'cross-engine-cmd')
        await restartEngine(handle)
        expect(status(handle, KOLIBRI)).toBe('Stopped')
        expect(h.started).not.toContain(KOLIBRI)
    })

    it('a Stopped instance with no stop record in operationDB is kept Stopped (trust the store)', async () => {
        const handle = await makeStore()
        h.running.delete(KOLIBRI)
        handle.change(d => { (d.instanceDB as any)[KOLIBRI].status = 'Stopped' })
        await restartEngine(handle)
        expect(status(handle, KOLIBRI)).toBe('Stopped')
        expect(h.started).not.toContain(KOLIBRI)
    })

    it('an explicit start after the restart still works and is then auto-started on the next restart', async () => {
        const handle = await makeStore()
        await stop(handle, MILKWISE, SYS)
        await restartEngine(handle)
        expect(status(handle, MILKWISE)).toBe('Stopped')

        const { startInstance } = await import('../../src/data/Instance.js')
        await startInstance(handle, handle.doc().instanceDB[MILKWISE as InstanceID] as any, disk(handle, SYS), 'console-command')
        expect(status(handle, MILKWISE)).toBe('Running')

        // Reboot: the container does not survive here, so the Engine must start it again
        h.running.delete(MILKWISE)
        h.started.length = 0
        await restartEngine(handle)
        expect(h.started).toContain(MILKWISE)
        expect(status(handle, MILKWISE)).toBe('Running')
    })
})

describe('regression: normal autostart and interrupted operations', () => {
    it('Running instances whose containers are gone after a reboot are auto-started', async () => {
        const handle = await makeStore()
        h.running.clear()                       // reboot: nothing running yet
        await restartEngine(handle)
        expect(h.started.sort()).toEqual([KOLIBRI, MILKWISE, NEXTCLOUD].sort())
        for (const id of [MILKWISE, KOLIBRI, NEXTCLOUD]) expect(status(handle, id)).toBe('Running')
    })

    it('a stopped instance does not block the autostart of the others', async () => {
        const handle = await makeStore()
        await stop(handle, MILKWISE, SYS)
        h.running.clear()
        await restartEngine(handle)
        expect(h.started.sort()).toEqual([KOLIBRI, NEXTCLOUD].sort())
        expect(status(handle, MILKWISE)).toBe('Stopped')
    })

    it('Running instances whose containers survived keep running (the already-running path)', async () => {
        const handle = await makeStore()
        await checkAndSetUndockedApps(handle, localEngineId, async (id) => h.running.has(String(id)))
        for (const id of [MILKWISE, KOLIBRI, NEXTCLOUD]) expect(status(handle, id)).toBe('Running')
    })

    for (const cause of ['backup-pre-stop', 'post-copy', 'post-move', 'disk-undocked'] as OperationCause[]) {
        it(`an instance the Engine stopped itself (${cause}) and that the restart interrupted is started again`, async () => {
            const handle = await makeStore()
            await stop(handle, KOLIBRI, APPD, cause)
            await restartEngine(handle)
            expect(h.started).toContain(KOLIBRI)
            expect(status(handle, KOLIBRI)).toBe('Running')
        })
    }

    it('the last stop decides: a user stop after an interrupted backup keeps the instance Stopped', async () => {
        const handle = await makeStore()
        await stop(handle, KOLIBRI, APPD, 'backup-pre-stop')
        await new Promise(r => setTimeout(r, 2))
        await stop(handle, KOLIBRI, APPD, 'console-command')
        expect(lastStopOperation(handle.doc(), KOLIBRI as InstanceID)?.cause).toBe('console-command')
        await restartEngine(handle)
        expect(status(handle, KOLIBRI)).toBe('Stopped')
        expect(h.started).not.toContain(KOLIBRI)
    })

    it('the last stop decides: a backup stop after a user stop + start restarts it', async () => {
        const handle = await makeStore()
        await stop(handle, KOLIBRI, APPD, 'console-command')
        await new Promise(r => setTimeout(r, 2))
        handle.change(d => { (d.instanceDB as any)[KOLIBRI].status = 'Running' }); h.running.add(KOLIBRI)
        await stop(handle, KOLIBRI, APPD, 'backup-pre-stop')
        await restartEngine(handle)
        expect(h.started).toContain(KOLIBRI)
    })

    it('a user stop interrupted by the restart after its containers stopped ends Stopped, not auto-started', async () => {
        const handle = await makeStore()
        // stopInstance got as far as stopping the container; the Engine died before it wrote Stopped
        const opId = createOperation(handle, 'stopApp', { instanceId: KOLIBRI, diskId: APPD }, 'console-command', { type: 'instance', id: KOLIBRI })
        updateOperation(handle, opId, { status: 'Running' })
        h.running.delete(KOLIBRI)
        expect(status(handle, KOLIBRI)).toBe('Running')

        await restartEngine(handle)

        expect(status(handle, KOLIBRI)).toBe('Stopped')
        expect(h.started).not.toContain(KOLIBRI)
    })

    it('a user stop interrupted before its containers stopped leaves the running instance alone', async () => {
        const handle = await makeStore()
        const opId = createOperation(handle, 'stopApp', { instanceId: KOLIBRI, diskId: APPD }, 'console-command', { type: 'instance', id: KOLIBRI })
        updateOperation(handle, opId, { status: 'Running' })
        await checkAndSetUndockedApps(handle, localEngineId, async (id) => h.running.has(String(id)))
        expect(status(handle, KOLIBRI)).toBe('Running')
    })

    it('another Engine\'s unfinished user stop is not treated as interrupted by this restart', async () => {
        const handle = await makeStore()
        handle.change(d => {
            (d.operationDB as any)['op-other'] = {
                id: 'op-other', kind: 'stopApp', args: { instanceId: KOLIBRI, diskId: APPD }, cause: 'console-command',
                subject: { type: 'instance', id: KOLIBRI }, engineId: OTHER, status: 'Running', progressPercent: null,
                currentStep: null, totalSteps: null, stepLabel: null, startedAt: Date.now() as Timestamp, completedAt: null, error: null,
            }
        })
        h.running.delete(KOLIBRI)
        await checkAndSetUndockedApps(handle, localEngineId, async (id) => h.running.has(String(id)))
        expect(status(handle, KOLIBRI)).toBe('Undocked')
    })

    it('a user-stopped instance on a disk docked on another Engine is left alone', async () => {
        const handle = await makeStore()
        await stop(handle, KOLIBRI, APPD)
        handle.change(d => { (d.diskDB as any)[APPD].dockedTo = OTHER })
        const asked = vi.fn(async (_id: InstanceID) => false)
        await checkAndSetUndockedApps(handle, localEngineId, asked)
        expect(status(handle, KOLIBRI)).toBe('Stopped')
        expect(asked.mock.calls.map(c => String(c[0]))).not.toContain(KOLIBRI)
    })

    it('isUserStopped is false for every status but Stopped', async () => {
        const handle = await makeStore()
        for (const s of ['Running', 'Docked', 'Starting', 'Undocked', 'Error', 'Missing', 'Pauzed']) {
            handle.change(d => { (d.instanceDB as any)[KOLIBRI].status = s })
            expect(isUserStopped(handle.doc(), handle.doc().instanceDB[KOLIBRI as InstanceID] as any), s).toBe(false)
        }
    })
})
