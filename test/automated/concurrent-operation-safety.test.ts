/**
 * concurrent-operation-safety.test.ts — Group P: Concurrent operation safety
 *
 * Tests for ResourceLock and the lock guards in copyApp, moveApp, ejectDisk.
 *
 * Acceptance criteria (from MC task):
 *   - Operations that mutate the same resource are serialised
 *   - Returns a clear error when a lock is held (not silent corruption)
 *   - Concurrent copyApp + ejectDisk on the same disk is rejected cleanly
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
    resourceLock, instanceKey, diskKey
} from '../../src/utils/ResourceLock.js'

// ── ResourceLockManager unit tests ────────────────────────────────────────────

// Use a fresh manager for each test (don't pollute the singleton)
const makeLock = () => new (resourceLock.constructor as any)()

describe('ResourceLock', () => {
    let lock: typeof resourceLock

    beforeEach(() => {
        // Reset singleton between tests
        const allKeys = [...resourceLock.allLocks().keys()]
        allKeys.forEach(k => resourceLock.release(k))
        lock = resourceLock
    })

    it('acquire returns true for an unlocked key', () => {
        expect(lock.acquire('inst:A', 'copyApp')).toBe(true)
        lock.release('inst:A')
    })

    it('acquire returns false when key is already locked', () => {
        lock.acquire('inst:A', 'copyApp')
        expect(lock.acquire('inst:A', 'moveApp')).toBe(false)
        lock.release('inst:A')
    })

    it('release allows a subsequent acquire', () => {
        lock.acquire('inst:A', 'copyApp')
        lock.release('inst:A')
        expect(lock.acquire('inst:A', 'moveApp')).toBe(true)
        lock.release('inst:A')
    })

    it('acquireAll acquires all keys atomically', () => {
        expect(lock.acquireAll(['inst:A', 'disk:D'], 'moveApp')).toBe(true)
        expect(lock.isLocked('inst:A')).toBe(true)
        expect(lock.isLocked('disk:D')).toBe(true)
        lock.releaseAll(['inst:A', 'disk:D'])
    })

    it('acquireAll rolls back if any key is already locked', () => {
        lock.acquire('disk:D', 'copyApp')
        // Try to acquire both — second one is locked
        expect(lock.acquireAll(['inst:A', 'disk:D'], 'moveApp')).toBe(false)
        // inst:A should have been rolled back
        expect(lock.isLocked('inst:A')).toBe(false)
        lock.release('disk:D')
    })

    it('releaseAll releases multiple keys', () => {
        lock.acquireAll(['inst:A', 'disk:D'], 'copyApp')
        lock.releaseAll(['inst:A', 'disk:D'])
        expect(lock.isLocked('inst:A')).toBe(false)
        expect(lock.isLocked('disk:D')).toBe(false)
    })

    it('getLockInfo returns kind and acquiredAt', () => {
        const before = Date.now()
        lock.acquire('inst:A', 'backupApp')
        const info = lock.getLockInfo('inst:A')
        expect(info?.kind).toBe('backupApp')
        expect(info?.acquiredAt).toBeGreaterThanOrEqual(before)
        lock.release('inst:A')
    })

    it('release on unlocked key is a no-op', () => {
        expect(() => lock.release('nonexistent')).not.toThrow()
    })

    it('allLocks returns current snapshot', () => {
        lock.acquire('inst:X', 'copyApp')
        expect(lock.allLocks().has('inst:X')).toBe(true)
        lock.release('inst:X')
        expect(lock.allLocks().has('inst:X')).toBe(false)
    })

    it('instanceKey and diskKey produce distinct namespaced keys', () => {
        const iKey = instanceKey('abc')
        const dKey = diskKey('abc')
        expect(iKey).toBe('instance:abc')
        expect(dKey).toBe('disk:abc')
        expect(iKey).not.toBe(dKey)
    })
})

// ── Integration: ejectDisk blocked when disk is locked ────────────────────────

vi.mock('../../src/utils/rsync.js', () => ({
    rsyncDirectory: vi.fn(async () => {})
}))

vi.mock('../../src/data/Disk.js', async (importOriginal) => ({
    ...await importOriginal<any>(),
    processInstance: vi.fn(async (_h: any, _d: any, _id: any) => undefined as any),
}))

vi.mock('../../src/data/Instance.js', async (importOriginal) => ({
    ...await importOriginal<any>(),
    stopInstance: vi.fn(async () => {}),
    startInstance: vi.fn(async () => {}),
}))

vi.mock('zx', async (importOriginal) => {
    const actual = await importOriginal<any>()
    const mockedDollar = vi.fn(async (strings: any, ...vals: any[]) => {
        const cmd = Array.isArray(strings) ? strings.join('') : String(strings ?? '')
        if (cmd.includes('df')) return { stdout: '1048576\n' }
        if (cmd.includes('du')) return { stdout: '102400\n' }
        return actual.$(strings, ...vals)
    }) as any
    mockedDollar.sync = actual.$.sync
    return {
        ...actual,
        $: mockedDollar,
        fs: {
            ...actual.fs,
            pathExists: vi.fn(async () => true),
            readdir: vi.fn(async (path: string) => {
                if (typeof path === 'string' && path.includes('/apps')) return ['kolibri-1.0']
                return []
            }),
            ensureDir: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
            copy: vi.fn(async () => undefined),
            readFileSync: actual.fs.readFileSync,
            existsSync: actual.fs.existsSync,
            writeFileSync: actual.fs.writeFileSync,
        },
    }
})

import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, InstanceID, Timestamp, AppID } from '../../src/data/CommonTypes.js'

const makeHandle = async (): Promise<{ repo: Repo; handle: DocHandle<Store> }> => {
    const repo = new Repo({ network: [], storage: undefined })
    const SOURCE_DISK_ID = 'DISK_source' as DiskID
    const TARGET_DISK_ID = 'DISK_target' as DiskID
    const handle = repo.create<Store>({
        engineDB: {},
        diskDB: {
            [SOURCE_DISK_ID]: {
                id: SOURCE_DISK_ID,
                name: 'source-disk' as DiskName,
                device: 'sdz1' as any,
                dockedTo: localEngineId,
                created: 0 as Timestamp, lastDocked: 0 as Timestamp,
                diskTypes: ['app'], backupConfig: null,
            },
            [TARGET_DISK_ID]: {
                id: TARGET_DISK_ID,
                name: 'target-disk' as DiskName,
                device: 'sdz2' as any,
                dockedTo: localEngineId,
                created: 0 as Timestamp, lastDocked: 0 as Timestamp,
                diskTypes: ['app'], backupConfig: null,
            },
        },
        appDB: {},
        instanceDB: {
            ['INST_001' as InstanceID]: {
                id: 'INST_001' as InstanceID,
                instanceOf: 'kolibri-1.0' as AppID,
                name: 'my-kolibri' as any,
                status: 'Stopped' as any,
                port: 3000 as any,
                serviceImages: [],
                created: 0 as Timestamp, lastBackup: null, lastStarted: 0 as Timestamp,
                storedOn: 'DISK_source' as DiskID,
            },
        },
        userDB: {},
        operationDB: {},
    })
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
    return { repo, handle }
}

describe('concurrent operation safety — ejectDisk blocked when disk locked', () => {
    beforeEach(() => {
        // Clear all locks between tests
        const allKeys = [...resourceLock.allLocks().keys()]
        allKeys.forEach(k => resourceLock.release(k))
        vi.clearAllMocks()
    })

    it('ejectDisk is rejected when the disk is locked by another operation', async () => {
        const { handle } = await makeHandle()
        const { commands } = await import('../../src/data/Commands.js')
        const { handleCommand } = await import('../../src/utils/commandUtils.js')

        // Manually acquire a lock on the source disk (simulating a copyApp in progress)
        resourceLock.acquire(diskKey('DISK_source'), 'copyApp')

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await handleCommand(commands, handle, 'engine', 'ejectDisk source-disk')

        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('locked by an active')
        )
        consoleSpy.mockRestore()
        resourceLock.release(diskKey('DISK_source'))
    })

    it('ejectDisk proceeds when no lock is held on the disk', async () => {
        const { handle } = await makeHandle()
        const { commands } = await import('../../src/data/Commands.js')
        const { handleCommand } = await import('../../src/utils/commandUtils.js')
        const { undockDisk } = await import('../../src/monitors/usbDeviceMonitor.js')
        const undockSpy = vi.spyOn(await import('../../src/monitors/usbDeviceMonitor.js'), 'undockDisk')
            .mockResolvedValue(undefined)

        await handleCommand(commands, handle, 'engine', 'ejectDisk source-disk')

        expect(undockSpy).toHaveBeenCalledOnce()
        undockSpy.mockRestore()
    })

    it('second copyApp on same instance is rejected while first holds lock', async () => {
        // Acquire the instance lock manually (simulates first copyApp running)
        resourceLock.acquire(instanceKey('INST_001'), 'copyApp')

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { copyApp } = await import('../../src/data/CopyMoveApp.js')
        const { handle } = await makeHandle()

        await copyApp(handle, 'my-kolibri' as any, 'source-disk' as any, 'target-disk' as any)

        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('resource locked')
        )
        // No operation record created — rejected before createOperation
        expect(Object.keys(handle.doc().operationDB)).toHaveLength(0)
        consoleSpy.mockRestore()
        resourceLock.release(instanceKey('INST_001'))
    })
})
