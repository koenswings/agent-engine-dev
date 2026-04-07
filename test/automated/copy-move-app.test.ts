/**
 * copy-move-app.test.ts
 *
 * Unit tests for copyApp and moveApp:
 *   - Operation record created and transitions through correct statuses
 *   - copyApp assigns a new InstanceID; moveApp retains the original
 *   - rsyncDirectory called with correct src/dest paths
 *   - moveApp removes source instance dir only after copy is confirmed
 *   - moveApp removes app master only when no other instance uses it
 *   - moveApp retains app master when another instance shares it
 *   - Failed rsync sets status to 'Failed' with error message
 *
 * rsyncDirectory and processAppDisk are mocked — no real disks or rsync required.
 * The zx $ tag is mocked but fs/YAML/chalk are left intact so Config.js can load.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { AppID, DiskID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'

// ── module mocks (hoisted) ────────────────────────────────────────────────────

// vi.hoisted ensures these are initialised before any vi.mock factory runs
const { mockRsyncDirectory, mockShell } = vi.hoisted(() => {
    const mockRsyncDirectory = vi.fn(async (
        _src: string,
        _dest: string,
        onProgress?: (p: { progressPercent: number }) => void
    ) => { onProgress?.({ progressPercent: 100 }) })

    const mockShell = vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
        const cmd = strings.reduce(
            (acc: string, str: string, i: number) => acc + str + (values[i] ?? ''), ''
        )
        if (cmd.includes('cat') && cmd.includes('compose.yaml')) {
            return {
                stdout: [
                    'x-app:',
                    '  name: sample',
                    '  version: "1.0"',
                    '  instanceId: sample-original-id',
                    '  instanceName: my-sample',
                    'services:',
                    '  app:',
                    '    image: sample:1.0',
                ].join('\n'),
                stderr: '',
            }
        }
        if (cmd.includes('du -sk'))  return { stdout: '1024\t/path', stderr: '' }
        if (cmd.includes('df -k'))   return { stdout: 'Avail\n999999', stderr: '' }
        if (cmd.includes('ls '))     return { stdout: 'compose.yaml', stderr: '' }
        if (cmd.includes('rm -rf'))  return { stdout: '', stderr: '' }
        if (cmd.includes('docker'))  return { stdout: '', stderr: '' }
        if (cmd.includes('mkdir'))   return { stdout: '', stderr: '' }
        if (cmd.includes('echo'))    return { stdout: '', stderr: '' }
        return { stdout: '', stderr: '' }
    })

    return { mockRsyncDirectory, mockShell }
})

vi.mock('../../src/utils/rsync.js', () => ({ rsyncDirectory: mockRsyncDirectory }))

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/data/Disk.js')>()
    return { ...actual, processAppDisk: vi.fn(async () => {}) }
})

// Mock only $ — keep real fs/YAML/chalk so Config.js can read config.yaml at import time
vi.mock('zx', async (importOriginal) => {
    const actual = await importOriginal<typeof import('zx')>()
    return { ...actual, $: mockShell }
})

// ── helpers ───────────────────────────────────────────────────────────────────

const SOURCE_DISK_ID = 'disk-source-001' as DiskID
const TARGET_DISK_ID = 'disk-target-001' as DiskID
const INSTANCE_ID = 'sample-original-id' as InstanceID
const APP_ID = 'sample-1.0' as AppID

const createMinimalStore = async (): Promise<{ repo: Repo; storeHandle: DocHandle<Store> }> => {
    const repo = new Repo({ network: [], storage: undefined })
    const storeHandle = repo.create<Store>({
        engineDB: {},
        diskDB: {},
        appDB: {},
        instanceDB: {},
        userDB: {},
        operationDB: {},
    })
    await storeHandle.whenReady()
    await createOrUpdateEngine(storeHandle, localEngineId)

    storeHandle.change(doc => {
        doc.diskDB[SOURCE_DISK_ID] = {
            id: SOURCE_DISK_ID,
            name: 'source-disk' as any,
            device: 'sdz1' as any,
            dockedTo: localEngineId,
            created: Date.now() as Timestamp,
            lastDocked: Date.now() as Timestamp,
            diskTypes: ['app'],
            backupConfig: null,
        }
        doc.diskDB[TARGET_DISK_ID] = {
            id: TARGET_DISK_ID,
            name: 'target-disk' as any,
            device: 'sdz2' as any,
            dockedTo: localEngineId,
            created: Date.now() as Timestamp,
            lastDocked: Date.now() as Timestamp,
            diskTypes: ['app'],
            backupConfig: null,
        }
        doc.instanceDB[INSTANCE_ID] = {
            id: INSTANCE_ID,
            instanceOf: APP_ID,
            name: 'my-sample' as any,
            status: 'Stopped',
            port: 3000 as any,
            serviceImages: ['sample:1.0' as any],
            created: Date.now() as Timestamp,
            lastBackup: null,
            lastStarted: 0 as Timestamp,
            storedOn: SOURCE_DISK_ID,
        }
    })

    return { repo, storeHandle }
}

// ── tests: copyApp ────────────────────────────────────────────────────────────

describe('copyApp', () => {
    let storeHandle: DocHandle<Store>
    let repo: Repo

    beforeEach(async () => {
        vi.clearAllMocks()
        // Reset rsync mock to default success behaviour
        mockRsyncDirectory.mockImplementation(async (
            _src: string, _dest: string, onProgress?: (p: { progressPercent: number }) => void
        ) => { onProgress?.({ progressPercent: 100 }) })

        const ctx = await createMinimalStore()
        storeHandle = ctx.storeHandle
        repo = ctx.repo
    })

    afterEach(() => repo.shutdown())

    it('creates an operation record with status Done on success', async () => {
        const { copyApp } = await import('../../src/data/App.js')
        await copyApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const ops = Object.values(storeHandle.doc().operationDB)
        expect(ops).toHaveLength(1)
        expect(ops[0].kind).toBe('copyApp')
        expect(ops[0].status).toBe('Done')
        expect(ops[0].progressPercent).toBe(100)
        expect(ops[0].error).toBeNull()
        expect(ops[0].completedAt).not.toBeNull()
    })

    it('calls rsyncDirectory for the instance dir with correct source path', async () => {
        const { copyApp } = await import('../../src/data/App.js')
        await copyApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const instanceCall = mockRsyncDirectory.mock.calls.find(c =>
            (c[0] as string).includes(`/instances/${INSTANCE_ID}`)
        )
        expect(instanceCall).toBeDefined()
        expect(instanceCall![0]).toBe(`/disks/sdz1/instances/${INSTANCE_ID}`)
    })

    it('assigns a new InstanceID (not the original) to the destination path', async () => {
        const { copyApp } = await import('../../src/data/App.js')
        await copyApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const instanceCall = mockRsyncDirectory.mock.calls.find(c =>
            (c[0] as string).includes(`/instances/${INSTANCE_ID}`)
        )
        // dest should contain a new ID starting with 'sample-' but not the original ID
        expect(instanceCall![1]).toContain('/disks/sdz2/instances/sample-')
        expect(instanceCall![1]).not.toBe(`/disks/sdz2/instances/${INSTANCE_ID}`)
    })

    it('sets status to Failed when rsync throws', async () => {
        mockRsyncDirectory.mockRejectedValueOnce(new Error('rsync: connection closed'))

        const { copyApp } = await import('../../src/data/App.js')
        await expect(
            copyApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)
        ).rejects.toThrow()

        const ops = Object.values(storeHandle.doc().operationDB)
        expect(ops[0].status).toBe('Failed')
        expect(ops[0].error).toContain('rsync: connection closed')
    })

    it('throws when source disk is not docked', async () => {
        storeHandle.change(doc => { doc.diskDB[SOURCE_DISK_ID].device = null })
        const { copyApp } = await import('../../src/data/App.js')
        await expect(
            copyApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)
        ).rejects.toThrow('not docked')
    })

    it('throws when instance is not found', async () => {
        const { copyApp } = await import('../../src/data/App.js')
        await expect(
            copyApp(storeHandle, 'nonexistent-id' as InstanceID, SOURCE_DISK_ID, TARGET_DISK_ID)
        ).rejects.toThrow('not found')
    })
})

// ── tests: moveApp ────────────────────────────────────────────────────────────

describe('moveApp', () => {
    let storeHandle: DocHandle<Store>
    let repo: Repo

    beforeEach(async () => {
        vi.clearAllMocks()
        mockRsyncDirectory.mockImplementation(async (
            _src: string, _dest: string, onProgress?: (p: { progressPercent: number }) => void
        ) => { onProgress?.({ progressPercent: 100 }) })

        const ctx = await createMinimalStore()
        storeHandle = ctx.storeHandle
        repo = ctx.repo
    })

    afterEach(() => repo.shutdown())

    it('creates an operation record with status Done on success', async () => {
        const { moveApp } = await import('../../src/data/App.js')
        await moveApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const ops = Object.values(storeHandle.doc().operationDB)
        expect(ops).toHaveLength(1)
        expect(ops[0].kind).toBe('moveApp')
        expect(ops[0].status).toBe('Done')
        expect(ops[0].error).toBeNull()
    })

    it('retains the original InstanceID in the destination path', async () => {
        const { moveApp } = await import('../../src/data/App.js')
        await moveApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const instanceCall = mockRsyncDirectory.mock.calls.find(c =>
            (c[0] as string).includes(`/instances/${INSTANCE_ID}`)
        )
        expect(instanceCall).toBeDefined()
        expect(instanceCall![1]).toBe(`/disks/sdz2/instances/${INSTANCE_ID}`)
    })

    it('sets source instance status to Missing after move', async () => {
        const { moveApp } = await import('../../src/data/App.js')
        await moveApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const inst = storeHandle.doc().instanceDB[INSTANCE_ID]
        expect(inst.status).toBe('Missing')
    })

    it('issues rm -rf for source instance dir after copy', async () => {
        const { moveApp } = await import('../../src/data/App.js')
        await moveApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const rmCalls = mockShell.mock.calls
            .map(c => (c[0] as TemplateStringsArray).reduce(
                (a: string, s: string, i: number) => a + s + (c[i + 1] ?? ''), ''
            ))
            .filter(cmd => cmd.includes('rm -rf') && cmd.includes(INSTANCE_ID))
        expect(rmCalls.length).toBeGreaterThan(0)
    })

    it('issues rm -rf for app master when no other instance on source disk uses it', async () => {
        const { moveApp } = await import('../../src/data/App.js')
        await moveApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const rmCalls = mockShell.mock.calls
            .map(c => (c[0] as TemplateStringsArray).reduce(
                (a: string, s: string, i: number) => a + s + (c[i + 1] ?? ''), ''
            ))
            .filter(cmd => cmd.includes('rm -rf') && cmd.includes('apps/sample-1.0'))
        expect(rmCalls.length).toBeGreaterThan(0)
    })

    it('does NOT remove app master when another instance on source disk uses it', async () => {
        const secondId = 'sample-second-instance' as InstanceID
        storeHandle.change(doc => {
            doc.instanceDB[secondId] = {
                id: secondId,
                instanceOf: APP_ID,
                name: 'my-sample-2' as any,
                status: 'Stopped',
                port: 3001 as any,
                serviceImages: ['sample:1.0' as any],
                created: Date.now() as Timestamp,
                lastBackup: null,
                lastStarted: 0 as Timestamp,
                storedOn: SOURCE_DISK_ID,
            }
        })

        const { moveApp } = await import('../../src/data/App.js')
        await moveApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)

        const rmMasterCalls = mockShell.mock.calls
            .map(c => (c[0] as TemplateStringsArray).reduce(
                (a: string, s: string, i: number) => a + s + (c[i + 1] ?? ''), ''
            ))
            .filter(cmd => cmd.includes('rm -rf') && cmd.includes('apps/sample-1.0'))
        expect(rmMasterCalls).toHaveLength(0)
    })

    it('sets status to Failed when rsync throws', async () => {
        mockRsyncDirectory.mockRejectedValueOnce(new Error('disk full'))

        const { moveApp } = await import('../../src/data/App.js')
        await expect(
            moveApp(storeHandle, INSTANCE_ID, SOURCE_DISK_ID, TARGET_DISK_ID)
        ).rejects.toThrow()

        const ops = Object.values(storeHandle.doc().operationDB)
        expect(ops[0].status).toBe('Failed')
        expect(ops[0].error).toContain('disk full')
    })
})
