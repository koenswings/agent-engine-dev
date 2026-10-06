/**
 * startup-engine-scope.test.ts: startup reconciliation only touches THIS Engine's
 * instances and operations (bug from Steve, 2026-10-06).
 *
 * A restart of idea03 ran checkAndSetUndockedApps, found no local container for
 * idea01's two instances (their disks are docked on idea01, Running there) and
 * marked them Undocked in the shared store. The check must follow the store's
 * disk -> engine relation (Disk.dockedTo): only instances on disks docked on this
 * Engine are judged; disks docked elsewhere, not docked, or with an unknown owner
 * are left alone. recoverInterruptedOperations had the same flaw for operationDB.
 */
import { describe, it, expect, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { checkAndSetUndockedApps, isInstanceDockedOn } from '../../src/data/UndockedApps.js'
import { recoverInterruptedOperations } from '../../src/data/Operations.js'
import { EngineID, InstanceID, OperationKind, Timestamp } from '../../src/data/CommonTypes.js'

const A = 'engine-idea01' as EngineID
const B = 'engine-idea03' as EngineID

const engine = (id: string, hostname: string) => ({ id, hostname, version: '1', hostOS: 'linux', created: 0, lastBooted: 0, lastRun: 0, lastHalted: null, commands: [] })
const disk = (id: string, dockedTo: string | null) => ({ id, name: id, device: dockedTo ? 'sda1' : null, created: 0, lastDocked: 0, dockedTo, diskTypes: ['app'], backupConfig: null })
const instance = (id: string, storedOn: string | null, status = 'Running') => ({
    id, instanceOf: 'kolibri', name: id, status, statusCondition: null, port: 8080, serviceImages: [],
    created: 0, lastBackup: null, lastStarted: 0, storedOn, currentStep: null, totalSteps: null, stepLabel: null,
    metrics: null,
})

/** The shared fleet store as idea03 (B) sees it right after its restart. */
const makeTwoEngineStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const handle = repo.create<Store>({
        engineDB: { [A]: engine(A, 'idea01'), [B]: engine(B, 'idea03') } as any,
        diskDB: {
            'disk-a-kolibri': disk('disk-a-kolibri', A),
            'disk-a-nc': disk('disk-a-nc', A),
            'disk-b-1': disk('disk-b-1', B),
            'disk-not-docked': disk('disk-not-docked', null),
            'disk-gone-engine': disk('disk-gone-engine', 'engine-not-in-store'),
        } as any,
        appDB: {},
        instanceDB: {
            // idea01's Path A instances, Running on idea01
            'kolibri-path-a': instance('kolibri-path-a', 'disk-a-kolibri'),
            'nextcloud-path-a': instance('nextcloud-path-a', 'disk-a-nc'),
            // idea03's own instances
            'b-running': instance('b-running', 'disk-b-1'),
            'b-gone': instance('b-gone', 'disk-b-1', 'Stopped'),
            'b-undocked': instance('b-undocked', 'disk-b-1', 'Undocked'),
            // owner unknown or not docked
            'on-undocked-disk': instance('on-undocked-disk', 'disk-not-docked'),
            'on-gone-engine-disk': instance('on-gone-engine-disk', 'disk-gone-engine'),
            'on-missing-disk': instance('on-missing-disk', 'disk-not-in-store'),
            'no-storedOn': instance('no-storedOn', null),
        } as any,
        userDB: {},
        operationDB: {},
    } as any)
    await handle.whenReady()
    return handle
}

const statuses = (h: DocHandle<Store>) =>
    Object.fromEntries(Object.values(h.doc().instanceDB).map(i => [String(i.id), String(i.status)]))

describe('checkAndSetUndockedApps: only this Engine\'s instances', () => {
    it('engine B restarting does not change engine A\'s instances (the idea03/idea01 bug)', async () => {
        const handle = await makeTwoEngineStore()
        // B (idea03) has no container of idea01's instances; only b-running runs on B
        const running = vi.fn(async (id: InstanceID) => String(id) === 'b-running')
        await checkAndSetUndockedApps(handle, B, running)

        const s = statuses(handle)
        expect(s['kolibri-path-a']).toBe('Running')
        expect(s['nextcloud-path-a']).toBe('Running')
        // B never even asked its own docker about A's instances
        const asked = running.mock.calls.map(c => String(c[0])).sort()
        expect(asked).toEqual(['b-gone', 'b-running'])
    })

    it('B\'s own instances without a container are still marked Undocked', async () => {
        const handle = await makeTwoEngineStore()
        await checkAndSetUndockedApps(handle, B, async (id) => String(id) === 'b-running')
        const s = statuses(handle)
        expect(s['b-running']).toBe('Running')
        expect(s['b-gone']).toBe('Undocked')
        expect(s['b-undocked']).toBe('Undocked')
    })

    it('A restarting marks its own idle instances and leaves B\'s alone (symmetry)', async () => {
        const handle = await makeTwoEngineStore()
        await checkAndSetUndockedApps(handle, A, async (id) => String(id) === 'kolibri-path-a')
        const s = statuses(handle)
        expect(s['kolibri-path-a']).toBe('Running')
        expect(s['nextcloud-path-a']).toBe('Undocked')
        expect(s['b-running']).toBe('Running')
        expect(s['b-gone']).toBe('Stopped')
    })

    it('leaves instances alone when the disk\'s engine is unknown, missing, not docked or the disk is unknown', async () => {
        const handle = await makeTwoEngineStore()
        const running = vi.fn(async (_id: InstanceID) => false)
        await checkAndSetUndockedApps(handle, B, running)
        const s = statuses(handle)
        for (const id of ['on-undocked-disk', 'on-gone-engine-disk', 'on-missing-disk', 'no-storedOn']) {
            expect(s[id], id).toBe('Running')
            expect(running.mock.calls.map(c => String(c[0]))).not.toContain(id)
        }
    })

    it('re-checks the dock inside the change: a disk that moved to A while docker ps ran is left alone', async () => {
        const handle = await makeTwoEngineStore()
        await checkAndSetUndockedApps(handle, B, async (id) => {
            if (String(id) === 'b-gone') handle.change(d => { (d.diskDB as any)['disk-b-1'].dockedTo = A })
            return false
        })
        expect(statuses(handle)['b-gone']).toBe('Stopped')
    })

    it('a docker error leaves the instance as it is', async () => {
        const handle = await makeTwoEngineStore()
        await checkAndSetUndockedApps(handle, B, async () => { throw new Error('docker: command not found') })
        const s = statuses(handle)
        expect(s['b-running']).toBe('Running')
        expect(s['b-gone']).toBe('Stopped')
    })

    it('defaults to the local Engine id (Disk.dockedTo === localEngineId)', async () => {
        const handle = await makeTwoEngineStore()
        handle.change(d => {
            (d.diskDB as any)['disk-local'] = disk('disk-local', localEngineId)
            ;(d.instanceDB as any)['local-idle'] = instance('local-idle', 'disk-local')
        })
        await checkAndSetUndockedApps(handle, undefined, async () => false)
        const s = statuses(handle)
        expect(s['local-idle']).toBe('Undocked')
        expect(s['kolibri-path-a']).toBe('Running')
        expect(s['b-gone']).toBe('Stopped')
    })

    it('isInstanceDockedOn follows diskDB[storedOn].dockedTo only', async () => {
        const handle = await makeTwoEngineStore()
        const st = handle.doc()
        const i = (id: string) => st.instanceDB[id as InstanceID]
        expect(isInstanceDockedOn(st, i('kolibri-path-a'), A)).toBe(true)
        expect(isInstanceDockedOn(st, i('kolibri-path-a'), B)).toBe(false)
        expect(isInstanceDockedOn(st, i('on-undocked-disk'), B)).toBe(false)
        expect(isInstanceDockedOn(st, i('on-missing-disk'), B)).toBe(false)
        expect(isInstanceDockedOn(st, i('no-storedOn'), B)).toBe(false)
        expect(isInstanceDockedOn(st, undefined, B)).toBe(false)
    })
})

describe('recoverInterruptedOperations: only this Engine\'s operations', () => {
    const addOp = (h: DocHandle<Store>, id: string, kind: OperationKind, status: string, engineId: string | undefined) => {
        h.change(doc => {
            const op: any = {
                id, kind, args: { instanceId: 'x', sourceDiskId: 'disk-a-kolibri', targetDiskId: 'disk-b-1' },
                cause: 'console-command', subject: null, status, progressPercent: 50, currentStep: null,
                totalSteps: null, stepLabel: null, startedAt: 0 as Timestamp, completedAt: null, error: null,
            }
            if (engineId !== undefined) op.engineId = engineId
            doc.operationDB[id] = op
        })
    }

    it('B restarting leaves A\'s Running/Pending operations and ops without an engineId alone', async () => {
        const handle = await makeTwoEngineStore()
        addOp(handle, 'a-copy', 'copyApp', 'Running', A)
        addOp(handle, 'a-restore', 'restoreApp', 'Pending', A)
        addOp(handle, 'no-owner', 'moveApp', 'Running', undefined)
        addOp(handle, 'b-restore', 'restoreApp', 'Running', B)
        const copyApp = vi.fn(async () => {})
        await recoverInterruptedOperations(handle, { copyApp, moveApp: copyApp }, B)

        const ops = handle.doc().operationDB
        expect(ops['a-copy'].status).toBe('Running')
        expect(ops['a-copy'].error).toBeNull()
        expect(ops['a-restore'].status).toBe('Pending')
        expect(ops['no-owner'].status).toBe('Running')
        expect(copyApp).not.toHaveBeenCalled()
        // B's own interrupted op is still recovered (restoreApp: fail strategy)
        expect(ops['b-restore'].status).toBe('Failed')
    })

    it('B still retries its own idempotent op', async () => {
        const handle = await makeTwoEngineStore()
        addOp(handle, 'b-copy', 'copyApp', 'Running', B)
        addOp(handle, 'a-copy', 'copyApp', 'Running', A)
        const copyApp = vi.fn(async () => {})
        await recoverInterruptedOperations(handle, { copyApp }, B)
        expect(copyApp).toHaveBeenCalledTimes(1)
        expect(handle.doc().operationDB['b-copy'].status).toBe('Pending')
        expect(handle.doc().operationDB['a-copy'].status).toBe('Running')
    })

    it('defaults to the local Engine id', async () => {
        const handle = await makeTwoEngineStore()
        addOp(handle, 'local-restore', 'restoreApp', 'Running', String(localEngineId))
        addOp(handle, 'a-restore', 'restoreApp', 'Running', A)
        await recoverInterruptedOperations(handle, {})
        expect(handle.doc().operationDB['local-restore'].status).toBe('Failed')
        expect(handle.doc().operationDB['a-restore'].status).toBe('Running')
    })
})
