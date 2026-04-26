/**
 * cancel-operation.test.ts
 *
 * Unit tests for cancelOperation (Phase 1):
 *  - Pending op: command spliced from engine queue, op marked Cancelled
 *  - Failed op: op marked Cancelled (no queue mutation needed)
 *  - Running op: returns error message (Phase 2 not yet implemented)
 *  - Done/Cancelled op: no-op
 */

import { describe, it, expect, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, EngineID, OperationStatus, Timestamp } from '../../src/data/CommonTypes.js'
import { cancelOperation, registerProcess } from '../../src/data/Operations.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeStore = async (): Promise<{ repo: Repo; handle: DocHandle<Store> }> => {
    const repo = new Repo({ network: [], storage: undefined })
    const handle = repo.create<Store>({
        engineDB: {},
        diskDB: {},
        appDB: {},
        instanceDB: {},
        userDB: {},
        operationDB: {},
    })
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
    return { repo, handle }
}

const addOp = (
    handle: DocHandle<Store>,
    id: string,
    status: OperationStatus,
    args: Record<string, string> = {}
) => {
    handle.change(doc => {
        doc.operationDB[id] = {
            id,
            kind: 'copyApp',
            args,
            engineId: localEngineId as EngineID,
            status,
            progressPercent: null,
            startedAt: Date.now() as Timestamp,
            completedAt: null,
            error: null,
        }
    })
}

const addCommand = (handle: DocHandle<Store>, cmd: string) => {
    handle.change(doc => {
        const eng = doc.engineDB[localEngineId as any]
        if (eng) (eng.commands as any[]).push(cmd)
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cancelOperation', () => {
    it('marks a Pending op as Cancelled and splices command from queue', async () => {
        const { handle } = await makeStore()
        const instanceId = 'inst-abc'
        const srcDiskId  = 'DISK_src' as DiskID
        const tgtDiskId  = 'DISK_tgt' as DiskID
        const opId = 'op-pending-1'

        addOp(handle, opId, 'Pending', { instanceId, sourceDiskId: srcDiskId, targetDiskId: tgtDiskId })
        // Simulate command as the engine consumer would have it
        addCommand(handle, `copyApp kolibri-main ${srcDiskId} ${tgtDiskId}`)

        const err = cancelOperation(handle, opId)
        expect(err).toBeUndefined()

        const store = handle.doc()!
        expect(store.operationDB[opId].status).toBe('Cancelled')
        expect(store.operationDB[opId].completedAt).toBeGreaterThan(0)
        // Command must be removed from queue
        const queue = store.engineDB[localEngineId as any]?.commands ?? []
        expect(queue).toHaveLength(0)
    })

    it('marks a Failed op as Cancelled without touching the queue', async () => {
        const { handle } = await makeStore()
        const opId = 'op-failed-1'
        addOp(handle, opId, 'Failed')

        const err = cancelOperation(handle, opId)
        expect(err).toBeUndefined()

        const store = handle.doc()!
        expect(store.operationDB[opId].status).toBe('Cancelled')
        // Queue should still be empty (nothing was added)
        const queue = store.engineDB[localEngineId as any]?.commands ?? []
        expect(queue).toHaveLength(0)
    })

    it('returns an error for a Running op with no registered process', async () => {
        const { handle } = await makeStore()
        const opId = 'op-running-no-proc'
        addOp(handle, opId, 'Running')

        const err = cancelOperation(handle, opId)
        expect(err).toMatch(/no cancellable process/)
        expect(handle.doc()!.operationDB[opId].status).toBe('Running')
    })

    it('SIGTERMs the registered process and marks Running op as Cancelled', async () => {
        const { handle } = await makeStore()
        const opId = 'op-running-with-proc'
        addOp(handle, opId, 'Running')

        // Register a mock process
        const mockProc = { pid: 99999, kill: vi.fn() } as any
        registerProcess(opId, mockProc)

        const err = cancelOperation(handle, opId)
        expect(err).toBeUndefined()
        expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')
        expect(handle.doc()!.operationDB[opId].status).toBe('Cancelled')
        expect(handle.doc()!.operationDB[opId].completedAt).toBeGreaterThan(0)
    })

    it('is a no-op for a Done op', async () => {
        const { handle } = await makeStore()
        const opId = 'op-done-1'
        addOp(handle, opId, 'Done')

        const err = cancelOperation(handle, opId)
        expect(err).toBeUndefined()
        expect(handle.doc()!.operationDB[opId].status).toBe('Done')
    })

    it('is a no-op for an already Cancelled op', async () => {
        const { handle } = await makeStore()
        const opId = 'op-cancelled-1'
        addOp(handle, opId, 'Cancelled')

        const err = cancelOperation(handle, opId)
        expect(err).toBeUndefined()
        expect(handle.doc()!.operationDB[opId].status).toBe('Cancelled')
    })

    it('returns an error for an unknown opId', async () => {
        const { handle } = await makeStore()
        const err = cancelOperation(handle, 'nonexistent-op')
        expect(err).toMatch(/not found/)
    })

    it('does not splice unrelated commands from the queue', async () => {
        const { handle } = await makeStore()
        const opId = 'op-pending-2'
        addOp(handle, opId, 'Pending', { instanceId: 'inst-xyz', sourceDiskId: 'DISK_a', targetDiskId: 'DISK_b' })
        // Add a command for a different instance
        addCommand(handle, 'copyApp other-instance DISK_c DISK_d')

        cancelOperation(handle, opId)

        // The unrelated command should remain
        const queue = handle.doc()!.engineDB[localEngineId as any]?.commands ?? []
        expect(queue).toHaveLength(1)
        expect(queue[0]).toContain('other-instance')
    })
})
