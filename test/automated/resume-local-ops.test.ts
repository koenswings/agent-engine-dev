/**
 * resume-local-ops.test.ts — engine#497 stage 2 (Koen's rule): simulated power cuts of a
 * local copyApp / moveApp, then boot recovery and the dock pass. The op resumes inside the
 * ORIGINAL operation, into the SAME folder and id; the end state is exactly one verified
 * instance with that id, no in-flight marker, op Done. Real failures count to RESUME_LIMIT
 * (3, then Failed RESUME_GAVE_UP with the partial target and marker kept); interruptions
 * never count.
 *
 * The disks are a fake: FS.markers (instances/<id>.idea-op-in-flight → opId) and
 * FS.folders (instances/<id> → 'partial' | 'complete'), driven by the helper fake
 * (InFlight.inFlightHelper: mark/clear/verify) and the rsyncInstanceData mock. A "power
 * cut" is the Engine stopping mid-rsync (markEngineStopping, then the rsync child dies):
 * the op stays Running, as after a real cut. "Reboot" forgets all in-memory state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { InstanceID, DiskID, DiskName, Timestamp, AppID } from '../../src/data/CommonTypes.js'
import { copyApp, moveApp } from '../../src/data/CopyMoveApp.js'
import {
    recoverInterruptedOperations, noteDiskDocked, noteDiskUndocked, resetResumeStateForTests,
    markEngineStopping, resetEngineStoppingForTests, RESUME_LIMIT,
} from '../../src/data/Operations.js'
import { bootRetryHandlers } from '../../src/data/RecoveryRetry.js'
import { inFlightHelper } from '../../src/data/InFlight.js'
import { resourceLock, instanceKey, diskKey } from '../../src/utils/ResourceLock.js'

vi.mock('../../src/utils/rsync.js', () => ({
    rsyncDirectory: vi.fn(async (
        _src: string,
        _dest: string,
        onProgress?: (p: { progressPercent: number }) => void
    ) => {
        onProgress?.({ progressPercent: 50 })
        onProgress?.({ progressPercent: 100 })
    }),
    rsyncInstanceData: vi.fn(async (t: any, onProgress?: (p: { progressPercent: number }) => void) => {
        const key = `${t.dstRoot}/${t.dstId}`
        const exists = FS.folders.has(key)
        // the v20 helper guard: a non-empty target only under this op's own marker
        if (exists && (!t.opId || FS.markers.get(key) !== t.opId)) throw new Error(`rsync (idea-app-data copy refused: destination ${key} already exists and is not empty)`)
        FS.copies.push({ dstId: t.dstId, opId: t.opId, resumedInto: exists })
        onProgress?.({ progressPercent: 50 })
        const what = FS.rsync.shift() ?? 'ok'
        if (what === 'cut') {
            FS.folders.set(key, 'partial')
            markEngineStopping()
            throw new Error('rsync (idea-app-data copy stopped by SIGKILL)')
        }
        if (what === 'fail') {
            FS.folders.set(key, 'partial')
            throw new Error('rsync (idea-app-data copy exited with code 23: some files vanished)')
        }
        FS.folders.set(key, 'complete')
        onProgress?.({ progressPercent: 100 })
    }),
}))

// The app-data root helper (idea#168): instance data is sized and deleted as root.
vi.mock('../../src/utils/appDataHelper.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        instanceDataBytes: vi.fn(async () => 100 * 1024 * 1024),
        deleteInstanceData: vi.fn(async (root: string, id: string) => { FS.folders.delete(`${root}/${id}`) }),
        deleteRemoteInstanceData: vi.fn(async () => undefined),
        putInstanceFiles: vi.fn(async () => undefined),
    }
})

// Mock instance compose down / network prune (idea#468) — no real Docker
const { composeDownAtMock, pruneUnusedInstanceNetworksMock } = vi.hoisted(() => ({
    composeDownAtMock: vi.fn(async (..._args: any[]) => undefined),
    pruneUnusedInstanceNetworksMock: vi.fn(async (..._args: any[]) => ({ removed: [], skipped: [], errors: [] })),
}))
vi.mock('../../src/utils/instanceNetworks.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        composeDownAt: (...args: any[]) => composeDownAtMock(...args as [any, ...any[]]),
        pruneUnusedInstanceNetworks: (...args: any[]) => pruneUnusedInstanceNetworksMock(...args as [any, ...any[]]),
    }
})

vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        stopInstance: vi.fn(async () => {}),
        startInstance: vi.fn(async () => {}),
    }
})

// Mock the fs calls inside CopyMoveApp so no real disk access occurs.
// We do this by patching at the zx level but only for the functions CopyMoveApp uses:
// pathExists, readdir, ensureDir, remove. readFileSync must remain real for Config.
// Mock zx — $ and fs — used by CopyMoveApp at runtime.
// vi.mock is hoisted so this runs before any imports (including Config.ts).
// We preserve sync fs methods that Config.ts needs at startup.
vi.mock('zx', async (importOriginal) => {
    const actual = await importOriginal<any>()
    // Replace $ with a mock that returns safe defaults for df/du
    // and falls through to actual for other commands Config needs at startup.
    const mockedDollar = vi.fn(async (strings: any, ...vals: any[]) => {
        const cmd = Array.isArray(strings) ? strings.join('') : String(strings ?? '')
        if (cmd.includes('df')) return { stdout: '1048576\n' }  // 1 GB in KB
        if (cmd.includes('du')) return { stdout: '102400\n' }   // 100 MB in KB
        if (cmd.includes('sudo') && cmd.includes('rm')) return { stdout: '' }  // sudo rm -rf (instance dir removal)
        // Fall through to real $ for anything else (META.yaml reads, docker, etc.)
        return actual.$(strings, ...vals)
    }) as any
    // copy tag/raw so zx internals still work
    mockedDollar.sync = actual.$.sync
    return {
        ...actual,
        $: mockedDollar,
        fs: {
            ...actual.fs,
            pathExists: vi.fn(async () => true),
            readdir:    vi.fn(async (path: string) => {
                // Return the app ID when listing the apps directory so validate() finds it
                if (typeof path === 'string' && path.includes('/apps')) return [APP_ID]
                return []
            }),
            ensureDir:  vi.fn(async () => undefined),
            remove:     vi.fn(async () => undefined),
            copy:       vi.fn(async () => undefined),
            // preserve sync methods Config needs at import time
            readFileSync:  actual.fs.readFileSync,
            existsSync:    actual.fs.existsSync,
            writeFileSync: actual.fs.writeFileSync,
        },
    }
})


// processInstance: registers like the real one, and refuses a marked folder unless the
// caller is the op that owns the marker (the real guard: Disk.processInstance / InFlight)
vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        processInstance: vi.fn(async (handle: any, disk: any, instanceId: any, opts: any = {}) => {
            const owner = FS.markers.get(`${disk.device}/${instanceId}`)
            if (owner && owner !== opts.inFlightOpId) return undefined
            handle.change((doc: any) => {
                const inst = doc.instanceDB[instanceId]
                if (inst) { inst.storedOn = disk.id; inst.status = 'Stopped' }
                else doc.instanceDB[instanceId] = { ...JSON.parse(JSON.stringify(doc.instanceDB[INSTANCE_ID])), id: instanceId, storedOn: disk.id, name: 'copy', status: 'Running' }
            })
            FS.registered.push(String(instanceId))
            return undefined as any
        }),
    }
})

const { FS } = vi.hoisted(() => ({
    FS: {
        markers: new Map<string, string>(),
        folders: new Map<string, 'partial' | 'complete'>(),
        registered: [] as string[],
        copies: [] as { dstId: string, opId?: string, resumedInto: boolean }[],
        /** what the next rsyncInstanceData calls do: 'cut' (power cut mid-copy), 'fail' (real error), 'ok' */
        rsync: [] as ('cut' | 'fail' | 'ok')[],
    },
}))


const SOURCE_DISK_ID = 'DISK_source' as DiskID
const TARGET_DISK_ID = 'DISK_target' as DiskID
const INSTANCE_ID = 'kolibri-abc123' as InstanceID
const APP_ID = 'kolibri-1.0' as AppID

const helperCalls: string[][] = []
const installHelperFake = () => {
    inFlightHelper.atLeast = async () => null
    inFlightHelper.run = async (args: string[]) => {
        helperCalls.push(args)
        const [verb, a, b, c] = args
        if (verb === 'mark-in-flight') {
            const key = `${a}/${b}`
            const cur = FS.markers.get(key)
            if (cur && cur !== c) throw new Error(`idea-app-data mark-in-flight refused: IN_FLIGHT: ${key} already marks operation ${cur}`)
            FS.markers.set(key, c)
            return ''
        }
        if (verb === 'clear-in-flight') {
            const key = `${a}/${b}`
            if (FS.markers.has(key) && FS.markers.get(key) !== c) throw new Error('idea-app-data clear-in-flight refused: IN_FLIGHT')
            FS.markers.delete(key)
            return ''
        }
        if (verb === 'verify-copy') {
            const st = FS.folders.get(`${args[3]}/${args[4]}`)
            return st === 'complete' ? 'differences=0\n' : 'differences=3\ndiff=>f+++++++++ data/db\n'
        }
        return ''
    }
}

/** A power cut: in-memory state is gone (resource locks, resume state, the stopping flag). */
const reboot = () => {
    resourceLock.releaseAll([instanceKey(INSTANCE_ID), diskKey(SOURCE_DISK_ID), diskKey(TARGET_DISK_ID)])
    resetResumeStateForTests()
    resetEngineStoppingForTests()
}

/** Boot: recovery runs before the USB monitor; then each disk finishes its dock pass. */
const boot = async (handle: DocHandle<Store>) => {
    reboot()
    await recoverInterruptedOperations(handle, bootRetryHandlers)
    noteDiskDocked(handle, SOURCE_DISK_ID)
    noteDiskDocked(handle, TARGET_DISK_ID)
}

const makeHandle = async (instanceStatus = 'Stopped'): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const disk = (id: DiskID, name: string, device: string) => ({
        id, name: name as DiskName, device: device as any, dockedTo: localEngineId,
        created: 0 as Timestamp, lastDocked: 0 as Timestamp, diskTypes: ['app'], backupConfig: null,
    })
    const handle = repo.create<Store>({
        engineDB: {},
        diskDB: { [SOURCE_DISK_ID]: disk(SOURCE_DISK_ID, 'source-disk', 'idea-test-1'), [TARGET_DISK_ID]: disk(TARGET_DISK_ID, 'target-disk', 'idea-test-2') } as any,
        appDB: {},
        instanceDB: {
            [INSTANCE_ID]: {
                id: INSTANCE_ID, instanceOf: APP_ID, name: 'my-kolibri' as any, status: instanceStatus as any, port: 3000 as any,
                serviceImages: [], created: 0 as Timestamp, lastBackup: null, lastStarted: 0 as Timestamp, statusCondition: null,
                storedOn: SOURCE_DISK_ID, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            },
        } as any,
        userDB: {},
        operationDB: {},
    })
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
    FS.folders.set(`idea-test-1/${INSTANCE_ID}`, 'complete')
    return handle
}

const onlyOp = (handle: DocHandle<Store>) => {
    const ops = Object.values(handle.doc().operationDB)
    expect(ops).toHaveLength(1)
    return ops[0]
}

beforeEach(() => {
    vi.clearAllMocks()
    FS.markers.clear(); FS.folders.clear(); FS.registered.length = 0; FS.copies.length = 0; FS.rsync.length = 0
    helperCalls.length = 0
    installHelperFake()
    reboot()
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('engine#497 stage 2: a power cut mid-copy resumes the same copyApp into the same folder and id', () => {
    it('cut → boot → dock: exactly one verified copy with the same id, no marker left, the original op Done', async () => {
        const handle = await makeHandle('Running')
        FS.rsync.push('cut')
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const cut = onlyOp(handle)
        // after the cut: Running, phase copying, a partial folder under its marker
        expect(cut.status).toBe('Running')
        const id = cut.args.targetInstanceId
        expect(cut.args.phase).toBe('copying')
        expect(FS.folders.get(`idea-test-2/${id}`)).toBe('partial')
        expect(FS.markers.get(`idea-test-2/${id}`)).toBe(cut.id)

        await boot(handle)
        await vi.waitFor(() => expect(handle.doc().operationDB[cut.id].status).toBe('Done'))
        const op = onlyOp(handle)
        expect(op.id).toBe(cut.id)
        expect(op.error).toBeNull()
        expect(op.args.resumeFailures).toBeUndefined()   // the cut was not counted
        // the resumed copy went into the same folder, as the owner of its marker
        expect(FS.copies.map(c => c.dstId)).toEqual([id, id])
        expect(FS.copies[1]).toMatchObject({ opId: cut.id, resumedInto: true })
        expect(FS.folders.get(`idea-test-2/${id}`)).toBe('complete')
        expect(FS.markers.size).toBe(0)
        expect(FS.registered).toEqual([id])
        const copies = Object.values(handle.doc().instanceDB).filter(i => String(i.storedOn) === TARGET_DISK_ID)
        expect(copies.map(i => i.id)).toEqual([id])
        expect(helperCalls.filter(c => c[0] === 'verify-copy')).toHaveLength(1)
        expect([...FS.folders.keys()].filter(k => k.startsWith('idea-test-2/'))).toEqual([`idea-test-2/${id}`])
    })

    it('boot alone does not run it: it waits (RESUME_WAITING) until BOTH disks finished their dock pass', async () => {
        const handle = await makeHandle()
        FS.rsync.push('cut')
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const opId = onlyOp(handle).id
        reboot()
        await recoverInterruptedOperations(handle, bootRetryHandlers)
        expect(handle.doc().operationDB[opId].status).toBe('Pending')
        expect(handle.doc().operationDB[opId].error).toMatch(/^RESUME_WAITING: resumes when 'source-disk' \(DISK_source\) and 'target-disk' \(DISK_target\) have docked/)
        expect(noteDiskDocked(handle, TARGET_DISK_ID)).toEqual([])
        expect(FS.copies).toHaveLength(1)
        expect(noteDiskDocked(handle, SOURCE_DISK_ID)).toEqual([opId])
        await vi.waitFor(() => expect(handle.doc().operationDB[opId].status).toBe('Done'))
        expect(FS.markers.size).toBe(0)
    })

    it('a cut after registration only clears the marker on resume (no second copy, no second row)', async () => {
        const handle = await makeHandle()
        const run = inFlightHelper.run
        inFlightHelper.run = async (args) => {
            if (args[0] === 'clear-in-flight') { markEngineStopping(); throw new Error('idea-app-data clear-in-flight stopped by SIGKILL') }
            return run(args)
        }
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const cut = onlyOp(handle)
        expect(cut.status).toBe('Running')
        expect(cut.args.phase).toBe('registered')
        installHelperFake()
        await boot(handle)
        await vi.waitFor(() => expect(handle.doc().operationDB[cut.id].status).toBe('Done'))
        expect(FS.copies).toHaveLength(1)
        expect(FS.registered).toEqual([cut.args.targetInstanceId])
        expect(FS.markers.size).toBe(0)
    })

    it('another op cannot register or copy into the marked folder (the marker blocks registration)', async () => {
        const handle = await makeHandle()
        FS.rsync.push('cut')
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const cut = onlyOp(handle)
        const id = cut.args.targetInstanceId
        reboot()
        const { processInstance } = await import('../../src/data/Disk.js')
        // a dock scan (no op id) does not register the half-written folder
        expect(await processInstance(handle, handle.doc().diskDB[TARGET_DISK_ID] as any, id as any)).toBeUndefined()
        expect(handle.doc().instanceDB[id as any]).toBeUndefined()
        expect(FS.registered).toEqual([])
    })
})

describe('engine#497 stage 2: a power cut mid-move resumes the same moveApp; the source goes only after the target verified', () => {
    it('cut → boot → dock: the instance (same id) is stored on the target, verified, the source folder removed, no marker, op Done', async () => {
        const handle = await makeHandle('Running')
        const helper = await import('../../src/utils/appDataHelper.js')
        FS.rsync.push('cut')
        await expect(moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)).rejects.toMatchObject({ code: 'COPY_FAILED' })
        const cut = onlyOp(handle)
        expect(cut.status).toBe('Running')
        expect(cut.args).toMatchObject({ targetInstanceId: INSTANCE_ID, phase: 'copying', wasRunning: '1' })
        // the source is untouched while the target is partial
        expect(FS.folders.get(`idea-test-1/${INSTANCE_ID}`)).toBe('complete')
        expect(vi.mocked(helper.deleteInstanceData)).not.toHaveBeenCalled()

        await boot(handle)
        await vi.waitFor(() => expect(handle.doc().operationDB[cut.id].status).toBe('Done'))
        expect(onlyOp(handle).error).toBeNull()
        expect(FS.copies.map(c => c.dstId)).toEqual([INSTANCE_ID, INSTANCE_ID])
        expect(FS.copies[1]).toMatchObject({ opId: cut.id, resumedInto: true })
        expect(handle.doc().instanceDB[INSTANCE_ID]?.storedOn).toBe(TARGET_DISK_ID)
        expect(Object.keys(handle.doc().instanceDB)).toEqual([INSTANCE_ID])
        expect(FS.folders.get(`idea-test-2/${INSTANCE_ID}`)).toBe('complete')
        expect(FS.folders.has(`idea-test-1/${INSTANCE_ID}`)).toBe(false)
        expect(FS.markers.size).toBe(0)
        // verify ran before the source was removed
        const order = vi.mocked(helper.deleteInstanceData).mock.invocationCallOrder[0]
        expect(order).toBeGreaterThan(0)
    })

    it('a cut after registration finishes the move on resume: start on the target, remove the source, clear the marker', async () => {
        const handle = await makeHandle('Running')
        const { startInstance } = await import('../../src/data/Instance.js')
        vi.mocked(startInstance).mockImplementationOnce(async () => { markEngineStopping(); throw new Error('killed') })
        await expect(moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)).rejects.toBeTruthy()
        const cut = onlyOp(handle)
        expect(cut.status).toBe('Running')
        expect(cut.args.phase).toBe('registered')
        expect(FS.markers.get(`idea-test-2/${INSTANCE_ID}`)).toBe(cut.id)
        await boot(handle)
        await vi.waitFor(() => expect(handle.doc().operationDB[cut.id].status).toBe('Done'))
        expect(FS.copies).toHaveLength(1)
        expect(vi.mocked(startInstance).mock.calls.at(-1)?.slice(2)).toEqual([expect.objectContaining({ id: TARGET_DISK_ID }), 'post-move', { inFlightOpId: cut.id }])
        expect(FS.folders.has(`idea-test-1/${INSTANCE_ID}`)).toBe(false)
        expect(FS.markers.size).toBe(0)
    })
})

describe('engine#497 stage 2: real failures count, interruptions do not; after 3 the op gives up and keeps the partial target', () => {
    it(`copyApp: ${'fail'} ×3 → RESUME_PENDING (1/3), (2/3), then Failed RESUME_GAVE_UP; the partial copy and its marker are kept`, async () => {
        const handle = await makeHandle()
        const helper = await import('../../src/utils/appDataHelper.js')
        FS.rsync.push('fail', 'fail', 'fail')
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const opId = onlyOp(handle).id
        const id = onlyOp(handle).args.targetInstanceId
        expect(handle.doc().operationDB[opId].error).toMatch(/^RESUME_PENDING \(1\/3\): rsync .*code 23/)
        // next boot: resumes after the dock pass, fails again (2/3)
        await boot(handle)
        await vi.waitFor(() => expect(handle.doc().operationDB[opId].error).toMatch(/^RESUME_PENDING \(2\/3\)/))
        // the target disk docks again (same boot): third real failure
        noteDiskUndocked(TARGET_DISK_ID)
        noteDiskDocked(handle, TARGET_DISK_ID)
        await vi.waitFor(() => expect(handle.doc().operationDB[opId].status).toBe('Failed'))
        const op = handle.doc().operationDB[opId]
        expect(op.error).toMatch(/^RESUME_GAVE_UP: rsync .*code 23/)
        expect(op.args.resumeFailures).toBe(String(RESUME_LIMIT))
        expect(FS.copies.map(c => c.dstId)).toEqual([id, id, id])
        expect(FS.folders.get(`idea-test-2/${id}`)).toBe('partial')
        expect(FS.markers.get(`idea-test-2/${id}`)).toBe(opId)
        expect(vi.mocked(helper.deleteInstanceData)).not.toHaveBeenCalled()
        // given up: no further boot or dock runs it
        await boot(handle)
        await new Promise(r => setTimeout(r, 20))
        expect(FS.copies).toHaveLength(3)
        expect(handle.doc().operationDB[opId].status).toBe('Failed')
    })

    it('a failure while the target disk is gone is an interruption: RESUME_WAITING, not counted; it resumes when the disk docks', async () => {
        const handle = await makeHandle()
        await boot(handle)   // the Engine is up, both disks docked; then the live copy runs
        const { rsyncInstanceData } = await import('../../src/utils/rsync.js')
        vi.mocked(rsyncInstanceData).mockImplementationOnce(async (t: any) => {
            FS.folders.set(`${t.dstRoot}/${t.dstId}`, 'partial')
            FS.copies.push({ dstId: t.dstId, opId: t.opId, resumedInto: false })
            handle.change(doc => { (doc.diskDB[TARGET_DISK_ID] as any).device = null })
            throw new Error('rsync (idea-app-data copy exited with code 11: Input/output error)')
        })
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const op = onlyOp(handle)
        expect(op.status).toBe('Pending')
        expect(op.error).toMatch(/^RESUME_WAITING: disk 'target-disk' \(DISK_target\) is no longer docked on this Engine/)
        expect(op.args.resumeFailures).toBeUndefined()
        // the target disk comes back: undock, then its dock pass
        noteDiskUndocked(TARGET_DISK_ID)
        handle.change(doc => { (doc.diskDB[TARGET_DISK_ID] as any).device = 'idea-test-2' })
        noteDiskDocked(handle, TARGET_DISK_ID)
        await vi.waitFor(() => expect(handle.doc().operationDB[op.id].status).toBe('Done'))
        expect(FS.copies.map(c => c.dstId)).toEqual([op.args.targetInstanceId, op.args.targetInstanceId])
        expect(FS.markers.size).toBe(0)
    })

    it('moveApp: three real failures give up with the source kept and registered on the source disk', async () => {
        const handle = await makeHandle()
        FS.rsync.push('fail', 'fail', 'fail')
        await expect(moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)).rejects.toBeTruthy()
        const opId = onlyOp(handle).id
        await boot(handle)
        await vi.waitFor(() => expect(handle.doc().operationDB[opId].error).toMatch(/^RESUME_PENDING \(2\/3\)/))
        await boot(handle)
        await vi.waitFor(() => expect(handle.doc().operationDB[opId].status).toBe('Failed'))
        expect(handle.doc().operationDB[opId].error).toMatch(/^RESUME_GAVE_UP: /)
        expect(handle.doc().instanceDB[INSTANCE_ID]?.storedOn).toBe(SOURCE_DISK_ID)
        expect(FS.folders.get(`idea-test-1/${INSTANCE_ID}`)).toBe('complete')
        expect(FS.markers.get(`idea-test-2/${INSTANCE_ID}`)).toBe(opId)
    })
})
