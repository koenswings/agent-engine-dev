/**
 * copy-move-app.test.ts — Unit tests for copyApp and moveApp
 *
 * Design: design/copy-move-app.md — Test Strategy section
 *
 * Uses a real Automerge Repo (same pattern as eject-disk.test.ts) and mocks:
 *   - rsyncDirectory (no real file transfers)
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
    })
}))

// Mock the Disk.processInstance — no Docker during unit tests
vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        processInstance: vi.fn(async (_h: any, _d: any, _id: any) => undefined as any),
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
vi.mock('../../src/data/CopyMoveApp.js', async (importOriginal) => {
    // Patch fs used inside CopyMoveApp via a module-level intercept
    const mod = await importOriginal<any>()
    return mod  // real module — we'll mock at the $ / fs level below
})

// Intercept $ (shell) and fs methods used by CopyMoveApp.
// We use vi.mock on 'zx' for the pieces CopyMoveApp needs, while ensuring
// that Config's readFileSync still works (it's called at import time, before this runs).
// Strategy: replace the module-level $ reference after import.
// This is done by mocking the utility that wraps disk-space checks.

// Actually the cleanest approach for this test structure: mock the internal helpers
// (directoryBytes / availableBytes) by intercepting at the $ level only for our calls.
// We provide a factory-based mock for zx that keeps fs.readFileSync intact.

// NOTE: CopyMoveApp calls:
//   $`df -k ...`       → available space
//   $`du -sk ...`      → directory size
//   fs.pathExists      → check app master / instance exist
//   fs.readdir         → list instances (getInstancesOfDisk uses Store, not fs)
//   fs.ensureDir       → create dirs
//   fs.remove          → delete dirs
//
// We mock these by wrapping them in spies injected via vi.doMock inside each test.
// This avoids the top-level hoisting problem with vi.mock + zx.

// ── Store helpers ─────────────────────────────────────────────────────────────

const SOURCE_DISK_ID = 'DISK_source' as DiskID
const TARGET_DISK_ID = 'DISK_target' as DiskID
const INSTANCE_ID = 'INST_abc' as InstanceID
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
                device: 'sdz1' as any,
                dockedTo: localEngineId,
                created: 0 as Timestamp,
                lastDocked: 0 as Timestamp,
                diskTypes: ['app'],
                backupConfig: null,
            },
            [TARGET_DISK_ID]: {
                id: TARGET_DISK_ID,
                name: 'target-disk' as DiskName,
                device: 'sdz2' as any,
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
                storedOn: SOURCE_DISK_ID,
            },
        },
        userDB: {},
        operationDB: {},
    })
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
    return { repo, handle }
}

// Patch the fs / $ calls that CopyMoveApp makes at runtime via the zx module.
// We grab the live zx module and spy on its methods.
const patchZxForCopyMove = async () => {
    const zx = await import('zx')

    // $ mock: return 1GB available for df, 100MB for du
    const dollarSpy = vi.spyOn(zx, '$' as any).mockImplementation(async (strings: any, ...vals: any[]) => {
        const cmd = String(strings[0] ?? '')
        if (cmd.includes('df')) return { stdout: '1048576' }   // 1GB in KB
        if (cmd.includes('du')) return { stdout: '102400' }    // 100MB in KB
        return { stdout: '' }
    })

    const pathExistsSpy = vi.spyOn(zx.fs, 'pathExists' as any).mockResolvedValue(true)
    const readdirSpy = vi.spyOn(zx.fs, 'readdir' as any).mockResolvedValue([])
    const ensureDirSpy = vi.spyOn(zx.fs, 'ensureDir' as any).mockResolvedValue(undefined)
    const removeSpy = vi.spyOn(zx.fs, 'remove' as any).mockResolvedValue(undefined)
    const copySpy = vi.spyOn(zx.fs, 'copy' as any).mockResolvedValue(undefined)

    return { dollarSpy, pathExistsSpy, readdirSpy, ensureDirSpy, removeSpy, copySpy }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('copyApp', () => {
    let spies: Awaited<ReturnType<typeof patchZxForCopyMove>>

    beforeEach(async () => {
        vi.clearAllMocks()
        spies = await patchZxForCopyMove()
    })

    afterEach(() => { vi.restoreAllMocks() })

    it('creates an operation record with status Done on success', async () => {
        const { handle } = await makeHandle()
        await copyApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
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
        vi.mocked(processInstance).mockImplementation(async (_h, _d, id) => {
            capturedId = id; return undefined as any
        })
        await copyApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        expect(capturedId).not.toBeNull()
        expect(capturedId).not.toBe(INSTANCE_ID)
    })

    it('stops and restarts the source instance when it is Running', async () => {
        const { handle } = await makeHandle('Running')
        const { stopInstance, startInstance } = await import('../../src/data/Instance.js')
        await copyApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        expect(vi.mocked(stopInstance)).toHaveBeenCalledOnce()
        expect(vi.mocked(startInstance)).toHaveBeenCalledOnce()
    })

    it('does not stop/restart when instance is already Stopped', async () => {
        const { handle } = await makeHandle('Stopped')
        const { stopInstance, startInstance } = await import('../../src/data/Instance.js')
        await copyApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        expect(vi.mocked(stopInstance)).not.toHaveBeenCalled()
        expect(vi.mocked(startInstance)).not.toHaveBeenCalled()
    })

    it('sets operation status to Failed when rsync throws', async () => {
        const { handle } = await makeHandle()
        const { rsyncDirectory } = await import('../../src/utils/rsync.js')
        vi.mocked(rsyncDirectory).mockRejectedValueOnce(new Error('disk full'))
        await copyApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        const ops = Object.values(handle.doc().operationDB)
        expect(ops[0].status).toBe('Failed')
        expect(ops[0].error).toContain('disk full')
    })

    it('errors cleanly when instance is not found', async () => {
        const { handle } = await makeHandle()
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await copyApp(handle, 'nonexistent' as any, 'source-disk' as any, 'target-disk' as any)
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not found'))
        expect(Object.keys(handle.doc().operationDB)).toHaveLength(0)
        consoleSpy.mockRestore()
    })

    it('errors cleanly when target disk is not docked', async () => {
        const { handle } = await makeHandle()
        handle.change(doc => { doc.diskDB[TARGET_DISK_ID].device = null })
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await copyApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not docked'))
        consoleSpy.mockRestore()
    })
})

describe('moveApp', () => {
    let spies: Awaited<ReturnType<typeof patchZxForCopyMove>>

    beforeEach(async () => {
        vi.clearAllMocks()
        spies = await patchZxForCopyMove()
    })

    afterEach(() => { vi.restoreAllMocks() })

    it('creates an operation record with status Done on success', async () => {
        const { handle } = await makeHandle()
        await moveApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        const ops = Object.values(handle.doc().operationDB)
        expect(ops[0].kind).toBe('moveApp')
        expect(ops[0].status).toBe('Done')
    })

    it('retains the original InstanceID', async () => {
        const { handle } = await makeHandle()
        const { processInstance } = await import('../../src/data/Disk.js')
        let capturedId: string | null = null
        vi.mocked(processInstance).mockImplementation(async (_h, _d, id) => {
            capturedId = id; return undefined as any
        })
        await moveApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        expect(capturedId).toBe(INSTANCE_ID)
    })

    it('marks source instance as Missing with storedOn=null after a successful move', async () => {
        const { handle } = await makeHandle()
        await moveApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        const inst = handle.doc().instanceDB[INSTANCE_ID]
        expect(inst.status).toBe('Missing')
        expect(inst.storedOn).toBeNull()
    })

    it('removes source instance directory after successful move', async () => {
        const { handle } = await makeHandle()
        await moveApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        expect(spies.removeSpy).toHaveBeenCalledWith(
            expect.stringContaining(`/instances/${INSTANCE_ID}`)
        )
    })

    it('removes app master when no other instance on source disk uses it', async () => {
        const { handle } = await makeHandle()
        // After the move, instanceDB shows this instance as Missing/null storedOn,
        // so getInstancesOfDisk (which uses instanceDB) returns empty → app master removed.
        await moveApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        const removeCalls = spies.removeSpy.mock.calls.map(c => c[0] as string)
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
                storedOn: SOURCE_DISK_ID,
            }
        })
        await moveApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
        const removeCalls = spies.removeSpy.mock.calls.map(c => c[0] as string)
        expect(removeCalls.some(p => p.includes(`/apps/${APP_ID}`))).toBe(false)
    })

    it('sets Failed and restarts source instance when rsync throws', async () => {
        const { handle } = await makeHandle('Running')
        const { rsyncDirectory } = await import('../../src/utils/rsync.js')
        vi.mocked(rsyncDirectory).mockRejectedValueOnce(new Error('io error'))
        const { startInstance } = await import('../../src/data/Instance.js')
        await moveApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)
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
                id: 'op1', kind: 'copyApp', args: {}, engineId: localEngineId,
                status: 'Running', progressPercent: 50,
                startedAt: 0 as Timestamp, completedAt: null, error: null,
            }
            doc.operationDB['op2'] = {
                id: 'op2', kind: 'moveApp', args: {}, engineId: localEngineId,
                status: 'Pending', progressPercent: null,
                startedAt: 0 as Timestamp, completedAt: null, error: null,
            }
            doc.operationDB['op3'] = {
                id: 'op3', kind: 'copyApp', args: {}, engineId: localEngineId,
                status: 'Done', progressPercent: 100,
                startedAt: 0 as Timestamp, completedAt: 1 as Timestamp, error: null,
            }
        })
        recoverInterruptedOperations(handle)
        expect(handle.doc().operationDB['op1'].status).toBe('Failed')
        expect(handle.doc().operationDB['op2'].status).toBe('Failed')
        expect(handle.doc().operationDB['op3'].status).toBe('Done')
    })
})
