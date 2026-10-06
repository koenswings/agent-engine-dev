/**
 * copy-move-app.test.ts — Unit tests for copyApp and moveApp
 *
 * Design: design/copy-move-app.md — Test Strategy section
 *
 * Uses a real Automerge Repo (same pattern as eject-disk.test.ts) and mocks:
 *   - rsyncDirectory (app masters, service tars) and rsyncInstanceData (instance
 *     data through the app-data root helper, idea#168) — no real file transfers
 *   - the app-data helper calls instanceDataBytes / deleteInstanceData /
 *     deleteRemoteInstanceData (no sudo)
 *   - processInstance (no Docker)
 *   - stopInstance / startInstance (no Docker)
 *   - fs operations in CopyMoveApp (no real disk access)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { copyApp, moveApp, recoverInterruptedOperations } from '../../src/data/CopyMoveApp.js'
import {
    InstanceID, DiskID, DiskName, EngineID, Timestamp, AppID
} from '../../src/data/CommonTypes.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/utils/rsync.js', () => ({
    rsyncDirectory: vi.fn(async (
        _src: string,
        _dest: string,
        onProgress?: (p: { progressPercent: number }) => void
    ) => {
        onProgress?.({ progressPercent: 50 })
        onProgress?.({ progressPercent: 100 })
    }),
    rsyncInstanceData: vi.fn(async (
        _t: unknown,
        onProgress?: (p: { progressPercent: number }) => void
    ) => {
        onProgress?.({ progressPercent: 50 })
        onProgress?.({ progressPercent: 100 })
    }),
}))

// The app-data root helper (idea#168): instance data is sized and deleted as root.
vi.mock('../../src/utils/appDataHelper.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        instanceDataBytes: vi.fn(async () => 100 * 1024 * 1024),
        deleteInstanceData: vi.fn(async () => undefined),
        deleteRemoteInstanceData: vi.fn(async () => undefined),
        putInstanceFiles: vi.fn(async () => undefined),
    }
})

// Mock the Disk.processInstance — no Docker during unit tests
vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        processInstance: vi.fn(async (handle: any, disk: any, instanceId: any) => {
            // Simulate processInstance updating storedOn so moveApp's guard check passes
            handle.change((doc: any) => {
                const inst = doc.instanceDB[instanceId]
                if (inst) {
                    inst.storedOn = disk.id
                    inst.status = 'Stopped'
                }
            })
            return undefined as any
        }),
    }
})

// Mock Instance lifecycle — no Docker
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

// ── Store helpers ─────────────────────────────────────────────────────────────

const SOURCE_DISK_ID = 'DISK_source' as DiskID
const TARGET_DISK_ID = 'DISK_target' as DiskID
const INSTANCE_ID = 'kolibri-abc123' as InstanceID
const APP_ID = 'kolibri-1.0' as AppID

const makeRepo = () => new Repo({ network: [], storage: undefined })

const makeHandle = async (instanceStatus = 'Stopped'): Promise<{ repo: Repo; handle: DocHandle<Store> }> => {
    const repo = makeRepo()
    const handle = repo.create<Store>({
        engineDB: {},
        diskDB: {
            [SOURCE_DISK_ID]: {
                id: SOURCE_DISK_ID,
                name: 'source-disk' as DiskName,
                device: 'idea-test-1' as any,
                dockedTo: localEngineId,
                created: 0 as Timestamp,
                lastDocked: 0 as Timestamp,
                diskTypes: ['app'],
                backupConfig: null,
            },
            [TARGET_DISK_ID]: {
                id: TARGET_DISK_ID,
                name: 'target-disk' as DiskName,
                device: 'idea-test-2' as any,
                dockedTo: localEngineId,
                created: 0 as Timestamp,
                lastDocked: 0 as Timestamp,
                diskTypes: ['app'],
                backupConfig: null,
            },
        },
        appDB: {},
        instanceDB: {
            [INSTANCE_ID]: {
                id: INSTANCE_ID,
                instanceOf: APP_ID,
                name: 'my-kolibri' as any,
                status: instanceStatus as any,
                port: 3000 as any,
                serviceImages: [],
                created: 0 as Timestamp,
                lastBackup: null,
                lastStarted: 0 as Timestamp,
                statusCondition: null,
                storedOn: SOURCE_DISK_ID,
                currentStep: null,
                totalSteps: null,
                stepLabel: null,
                metrics: null,
            },
        },
        userDB: {},
        operationDB: {},
    })
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
    return { repo, handle }
}

// Helper to grab the mocked fs for assertions
const getMockedFs = async () => (await import('zx')).fs

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('copyApp', () => {
    beforeEach(() => { vi.clearAllMocks() })
    afterEach(() => { vi.restoreAllMocks() })

    it('creates an operation record with status Done on success', async () => {
        const { handle } = await makeHandle()
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const ops = Object.values(handle.doc().operationDB)
        expect(ops).toHaveLength(1)
        expect(ops[0].kind).toBe('copyApp')
        expect(ops[0].status).toBe('Done')
        expect(ops[0].progressPercent).toBe(100)
        expect(ops[0].error).toBeNull()
    })

    it('assigns a new InstanceID (not the original) for the copy', async () => {
        const { handle } = await makeHandle()
        const { processInstance } = await import('../../src/data/Disk.js')
        let capturedId: string | null = null
        vi.mocked(processInstance).mockImplementationOnce(async (_h, _d, id) => {
            capturedId = id; return undefined as any
        })
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(capturedId).not.toBeNull()
        expect(capturedId).not.toBe(INSTANCE_ID)
    })

    it('stops and restarts the source instance when it is Running', async () => {
        const { handle } = await makeHandle('Running')
        const { stopInstance, startInstance } = await import('../../src/data/Instance.js')
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(vi.mocked(stopInstance)).toHaveBeenCalledOnce()
        expect(vi.mocked(startInstance)).toHaveBeenCalledOnce()
    })

    it('does not stop/restart when instance is already Stopped', async () => {
        const { handle } = await makeHandle('Stopped')
        const { stopInstance, startInstance } = await import('../../src/data/Instance.js')
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(vi.mocked(stopInstance)).not.toHaveBeenCalled()
        expect(vi.mocked(startInstance)).not.toHaveBeenCalled()
    })

    it('copies instance data with the helper into the new id (disk root tokens) and sizes it as root (idea#168)', async () => {
        const { handle } = await makeHandle()
        const { rsyncInstanceData } = await import('../../src/utils/rsync.js')
        const helper = await import('../../src/utils/appDataHelper.js')
        const { processInstance } = await import('../../src/data/Disk.js')
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const newId = vi.mocked(processInstance).mock.calls[0][2]
        expect(vi.mocked(helper.instanceDataBytes).mock.calls).toEqual([['idea-test-1', INSTANCE_ID]])
        expect(vi.mocked(rsyncInstanceData).mock.calls.map(c => c[0])).toEqual([
            { kind: 'copy', srcRoot: 'idea-test-1', srcId: INSTANCE_ID, dstRoot: 'idea-test-2', dstId: newId },
        ])
        expect(newId).toMatch(/^[a-z0-9]{19}$/)
        expect(typeof vi.mocked(rsyncInstanceData).mock.calls[0][2]).toBe('string')   // opId: cancellable
        const mfs = await getMockedFs()
        expect(vi.mocked(mfs.ensureDir).mock.calls.map(c => String(c[0])).some(p => p.includes('/instances/'))).toBe(false)
    })

    it('a failed instance copy removes the partial copy (new id) through the helper', async () => {
        const { handle } = await makeHandle()
        const { rsyncInstanceData } = await import('../../src/utils/rsync.js')
        const helper = await import('../../src/utils/appDataHelper.js')
        vi.mocked(rsyncInstanceData).mockRejectedValueOnce(new Error('rsync cancelled (SIGTERM)'))
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const spec = vi.mocked(rsyncInstanceData).mock.calls[0][0] as any
        expect(vi.mocked(helper.deleteInstanceData).mock.calls).toEqual([['idea-test-2', spec.dstId]])
        expect(spec.dstId).not.toBe(INSTANCE_ID)
        expect(vi.mocked(helper.deleteRemoteInstanceData)).not.toHaveBeenCalled()
    })

    it('sets operation status to Failed when rsync throws', async () => {
        const { handle } = await makeHandle()
        const { rsyncDirectory } = await import('../../src/utils/rsync.js')
        vi.mocked(rsyncDirectory).mockRejectedValueOnce(new Error('disk full'))
        await copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const ops = Object.values(handle.doc().operationDB)
        expect(ops[0].status).toBe('Failed')
        expect(ops[0].error).toContain('disk full')
    })

    // Validation refusals throw (idea#168 r29@97), so the trace fails loud.
    it('throws when instance is not found, no operation created', async () => {
        const { handle } = await makeHandle()
        await expect(copyApp(handle, 'nonexistent' as any, SOURCE_DISK_ID, TARGET_DISK_ID))
            .rejects.toThrow("copyApp: Instance 'nonexistent' not found")
        expect(Object.keys(handle.doc().operationDB)).toHaveLength(0)
    })

    it('throws when target disk is not docked', async () => {
        const { handle } = await makeHandle()
        handle.change(doc => { doc.diskDB[TARGET_DISK_ID].device = null })
        await expect(copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID))
            .rejects.toThrow(`copyApp: Target disk '${TARGET_DISK_ID}' is not docked`)
        expect(Object.keys(handle.doc().operationDB)).toHaveLength(0)
    })

    it('throws when source and target are the same disk', async () => {
        const { handle } = await makeHandle()
        await expect(copyApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, SOURCE_DISK_ID))
            .rejects.toThrow('copyApp: Source and target disk are the same')
    })

    it('via handleCommand: the refusal ends the copyApp trace as error (no unhandled rejection)', async () => {
        const { handle } = await makeHandle()
        const { commands } = await import('../../src/data/Commands.js')
        const { handleCommand } = await import('../../src/utils/commandUtils.js')
        const log = makeRepo().create<any>({ traces: {}, recentTraceIds: [] })
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await expect(handleCommand(commands, handle, 'engine', `copyApp nonexistent ${SOURCE_DISK_ID} ${TARGET_DISK_ID}`, log)).resolves.toBeUndefined()
        const ids = log.doc().recentTraceIds
        const t = log.doc().traces[ids[ids.length - 1]]
        expect(t.command).toBe('copyApp')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toContain("copyApp: Instance 'nonexistent' not found")
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("copyApp: Instance 'nonexistent' not found"))
    })
})

describe('moveApp', () => {
    beforeEach(() => { vi.clearAllMocks() })
    afterEach(() => { vi.restoreAllMocks() })

    it('creates an operation record with status Done on success', async () => {
        const { handle } = await makeHandle()
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const ops = Object.values(handle.doc().operationDB)
        expect(ops[0].kind).toBe('moveApp')
        expect(ops[0].status).toBe('Done')
    })

    it('retains the original InstanceID', async () => {
        const { handle } = await makeHandle()
        const { processInstance } = await import('../../src/data/Disk.js')
        let capturedId: string | null = null
        vi.mocked(processInstance).mockImplementationOnce(async (_h, _d, id) => {
            capturedId = id; return undefined as any
        })
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(capturedId).toBe(INSTANCE_ID)
    })

    it('calls processInstance with the target disk after rsync completes', async () => {
        const { handle } = await makeHandle()
        const { processInstance } = await import('../../src/data/Disk.js')
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        // processInstance must be called with the target disk — this is what registers
        // the instance on the target before any source cleanup happens
        expect(vi.mocked(processInstance)).toHaveBeenCalledWith(
            handle,
            expect.objectContaining({ id: TARGET_DISK_ID }),
            INSTANCE_ID
        )
    })

    it('removes the source instance directory as root through the helper after a successful move (idea#168)', async () => {
        const { handle } = await makeHandle()
        const { $ } = await import('zx')
        const helper = await import('../../src/utils/appDataHelper.js')
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(vi.mocked(helper.deleteInstanceData).mock.calls).toEqual([['idea-test-1', INSTANCE_ID]])
        // never as pi (fs.remove) and never a sudo rm
        const mfs = await getMockedFs()
        const removeCalls = vi.mocked(mfs.remove).mock.calls.map(c => c[0] as string)
        expect(removeCalls.some(p => p.includes(`/instances/${INSTANCE_ID}`))).toBe(false)
        const didSudoRm = vi.mocked($).mock.calls.some((args: any) => {
            const [strings, ...vals] = args
            const allParts = [
                ...(Array.isArray(strings) ? strings : [String(strings ?? '')]),
                ...vals.map(String)
            ].join('')
            return allParts.includes('sudo') && allParts.includes('rm') && allParts.includes(INSTANCE_ID)
        })
        expect(didSudoRm).toBe(false)
    })

    it('copies instance data with the helper (same id, disk root tokens) and sizes it as root', async () => {
        const { handle } = await makeHandle()
        const { rsyncInstanceData } = await import('../../src/utils/rsync.js')
        const helper = await import('../../src/utils/appDataHelper.js')
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(vi.mocked(helper.instanceDataBytes).mock.calls).toEqual([['idea-test-1', INSTANCE_ID]])
        expect(vi.mocked(rsyncInstanceData).mock.calls.map(c => c[0])).toEqual([
            { kind: 'copy', srcRoot: 'idea-test-1', srcId: INSTANCE_ID, dstRoot: 'idea-test-2', dstId: INSTANCE_ID },
        ])
        expect(typeof vi.mocked(rsyncInstanceData).mock.calls[0][2]).toBe('string')   // opId: cancellable
        // the instance folder is not pre-created as pi (the helper creates it as root)
        const mfs = await getMockedFs()
        expect(vi.mocked(mfs.ensureDir).mock.calls.map(c => String(c[0])).some(p => p.includes('/instances/'))).toBe(false)
    })

    it('a failed instance copy removes the partial target copy through the helper, never the source', async () => {
        const { handle } = await makeHandle()
        const { rsyncInstanceData } = await import('../../src/utils/rsync.js')
        const helper = await import('../../src/utils/appDataHelper.js')
        vi.mocked(rsyncInstanceData).mockRejectedValueOnce(new Error('rsync (idea-app-data copy exited with code 23: some files vanished)'))
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(Object.values(handle.doc().operationDB)[0].status).toBe('Failed')
        expect(vi.mocked(helper.deleteInstanceData).mock.calls).toEqual([['idea-test-2', INSTANCE_ID]])
    })

    it('a helper refusal (e.g. the target folder already exists) removes nothing', async () => {
        const { handle } = await makeHandle()
        const { rsyncInstanceData } = await import('../../src/utils/rsync.js')
        const helper = await import('../../src/utils/appDataHelper.js')
        vi.mocked(rsyncInstanceData).mockRejectedValueOnce(new Error('rsync (idea-app-data copy refused: destination /disks/sdc1/instances/x already exists and is not empty)'))
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(Object.values(handle.doc().operationDB)[0].error).toContain('already exists and is not empty')
        expect(vi.mocked(helper.deleteInstanceData)).not.toHaveBeenCalled()
    })

    it('a failure after the instance is registered on the target does not remove the target copy', async () => {
        const { handle } = await makeHandle()
        const helper = await import('../../src/utils/appDataHelper.js')
        const mfs = await getMockedFs()
        // app master removal (after registration) fails
        vi.mocked(mfs.remove).mockRejectedValueOnce(new Error('EBUSY'))
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(vi.mocked(helper.deleteInstanceData).mock.calls.filter(c => c[0] === 'idea-test-2')).toEqual([])
    })

    it('a failing source delete is logged and the move still ends Done', async () => {
        const { handle } = await makeHandle()
        const helper = await import('../../src/utils/appDataHelper.js')
        vi.mocked(helper.deleteInstanceData).mockRejectedValueOnce(new Error('idea-app-data delete refused: x'))
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        expect(Object.values(handle.doc().operationDB)[0].status).toBe('Done')
    })

    it('removes app master when no other instance on source disk uses it', async () => {
        const { handle } = await makeHandle()
        // After the move, processInstance updates storedOn to TARGET_DISK_ID,
        // so getInstancesOfDisk(sourceDisk) returns empty → app master removed.
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const mfs = await getMockedFs()
        const removeCalls = vi.mocked(mfs.remove).mock.calls.map(c => c[0] as string)
        expect(removeCalls.some(p => p.includes(`/apps/${APP_ID}`))).toBe(true)
    })

    it('keeps app master when another instance on source disk still uses it', async () => {
        const { handle } = await makeHandle()
        // Add a second instance using the same app on the source disk
        handle.change(doc => {
            doc.instanceDB['INST_other' as InstanceID] = {
                id: 'INST_other' as InstanceID,
                instanceOf: APP_ID,
                name: 'other-kolibri' as any,
                status: 'Running' as any,
                port: 3001 as any,
                serviceImages: [],
                created: 0 as Timestamp,
                lastBackup: null,
                lastStarted: 0 as Timestamp,
                statusCondition: null,
                storedOn: SOURCE_DISK_ID,
                currentStep: null,
                totalSteps: null,
                stepLabel: null,
                metrics: null,
            }
        })
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const mfs = await getMockedFs()
        const removeCalls = vi.mocked(mfs.remove).mock.calls.map(c => c[0] as string)
        expect(removeCalls.some(p => p.includes(`/apps/${APP_ID}`))).toBe(false)
    })

    it('throws on a validation refusal (instance not stored on source disk), no operation created', async () => {
        const { handle } = await makeHandle()
        await expect(moveApp(handle, 'my-kolibri' as any, TARGET_DISK_ID, SOURCE_DISK_ID))
            .rejects.toThrow(`moveApp: Instance 'my-kolibri' is not stored on disk '${TARGET_DISK_ID}'`)
        expect(Object.keys(handle.doc().operationDB)).toHaveLength(0)
    })

    it('refuses a cross-engine target: throws, and via handleCommand the trace ends as error', async () => {
        const { handle } = await makeHandle()
        const { network } = await import('../../src/data/Network.js')
        const REMOTE = 'ENGINE_remote-1' as EngineID
        handle.change(doc => { doc.diskDB[TARGET_DISK_ID].dockedTo = REMOTE })
        network.connections['10.0.0.9:4321' as any] = { adapter: {} as any, missedDiscoveryCount: 0, hostname: 'idea09' as any, engineId: REMOTE }
        try {
            await expect(moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID))
                .rejects.toThrow('Cross-engine move is not supported')
            const { commands } = await import('../../src/data/Commands.js')
            const { handleCommand } = await import('../../src/utils/commandUtils.js')
            const log = makeRepo().create<any>({ traces: {}, recentTraceIds: [] })
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            await handleCommand(commands, handle, 'engine', `moveApp my-kolibri ${SOURCE_DISK_ID} ${TARGET_DISK_ID}`, log)
            const ids = log.doc().recentTraceIds
            const t = log.doc().traces[ids[ids.length - 1]]
            expect(t.status).toBe('error')
            expect(t.errorMessage).toContain('Cross-engine move is not supported')
            expect(Object.keys(handle.doc().operationDB)).toHaveLength(0)
            consoleSpy.mockRestore()
        } finally {
            delete network.connections['10.0.0.9:4321' as any]
        }
    })

    it('refuses while the instance or a disk is locked: throws, no operation created', async () => {
        const { handle } = await makeHandle()
        const { resourceLock, diskKey } = await import('../../src/utils/ResourceLock.js')
        resourceLock.acquire(diskKey(TARGET_DISK_ID), 'restoreApp')
        try {
            await expect(moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID))
                .rejects.toThrow('moveApp: resource locked')
            expect(Object.keys(handle.doc().operationDB)).toHaveLength(0)
        } finally {
            resourceLock.release(diskKey(TARGET_DISK_ID))
        }
    })

    it('crash-recovery retry: a validation refusal marks the operation Failed', async () => {
        const { handle } = await makeHandle()
        handle.change(doc => {
            doc.operationDB['op-r'] = {
                id: 'op-r', kind: 'moveApp', args: { instanceId: 'nonexistent', sourceDiskId: SOURCE_DISK_ID, targetDiskId: TARGET_DISK_ID },
                cause: 'console-command', subject: null, engineId: localEngineId,
                status: 'Running', progressPercent: 10, currentStep: null, totalSteps: null, stepLabel: null,
                startedAt: 0 as Timestamp, completedAt: null, error: null,
            }
        })
        await recoverInterruptedOperations(handle, {
            moveApp: async (args, h) => { await moveApp(h, args.instanceId as any, args.sourceDiskId as any, args.targetDiskId as any, 'crash-recovery') },
        })
        await vi.waitFor(() => expect(handle.doc().operationDB['op-r'].status).toBe('Failed'))
        expect(handle.doc().operationDB['op-r'].error).toContain("Retry failed: moveApp: Instance 'nonexistent' not found")
    })

    it('sets Failed and restarts source instance when rsync throws', async () => {
        const { handle } = await makeHandle('Running')
        const { rsyncDirectory } = await import('../../src/utils/rsync.js')
        vi.mocked(rsyncDirectory).mockRejectedValueOnce(new Error('io error'))
        const { startInstance } = await import('../../src/data/Instance.js')
        await moveApp(handle, 'my-kolibri' as any, SOURCE_DISK_ID, TARGET_DISK_ID)
        const ops = Object.values(handle.doc().operationDB)
        expect(ops[0].status).toBe('Failed')
        expect(ops[0].error).toContain('io error')
        expect(vi.mocked(startInstance)).toHaveBeenCalled()
    })
})

describe('recoverInterruptedOperations', () => {
    it('marks Running and Pending operations as Failed on startup', async () => {
        const { handle } = await makeHandle()
        handle.change(doc => {
            doc.operationDB['op1'] = {
                id: 'op1', kind: 'copyApp', args: {}, cause: 'console-command', subject: null, engineId: localEngineId,
                status: 'Running', progressPercent: 50,
                currentStep: null, totalSteps: null, stepLabel: null,
                startedAt: 0 as Timestamp, completedAt: null, error: null,
            }
            doc.operationDB['op2'] = {
                id: 'op2', kind: 'moveApp', args: {}, cause: 'console-command', subject: null, engineId: localEngineId,
                status: 'Pending', progressPercent: null,
                currentStep: null, totalSteps: null, stepLabel: null,
                startedAt: 0 as Timestamp, completedAt: null, error: null,
            }
            doc.operationDB['op3'] = {
                id: 'op3', kind: 'copyApp', args: {}, cause: 'console-command', subject: null, engineId: localEngineId,
                status: 'Done', progressPercent: 100,
                currentStep: null, totalSteps: null, stepLabel: null,
                startedAt: 0 as Timestamp, completedAt: 1 as Timestamp, error: null,
            }
        })
        // Pass empty handlers so all ops fall through to 'fail' strategy
        await recoverInterruptedOperations(handle, {})
        expect(handle.doc().operationDB['op1'].status).toBe('Failed')
        expect(handle.doc().operationDB['op2'].status).toBe('Failed')
        expect(handle.doc().operationDB['op3'].status).toBe('Done')
    })
})
