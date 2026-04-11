/**
 * interrupted-task-recovery.test.ts — Group R: Interrupted task recovery
 *
 * Tests for recoverInterruptedOperations() in Operations.ts.
 *
 * Covers:
 *   - Retry strategy: copyApp, moveApp, backupApp are re-queued on startup
 *   - Fail strategy: restoreApp is marked Failed (not retried)
 *   - Already-Done/Failed operations are left untouched
 *   - Retry handler is called with correct args
 *   - Retry handler failure sets operation to Failed
 *   - Multiple concurrent interrupted ops are all handled
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { recoverInterruptedOperations } from '../../src/data/Operations.js'
import { EngineID, Timestamp, OperationKind } from '../../src/data/CommonTypes.js'

// ── Store factory ─────────────────────────────────────────────────────────────

const makeHandle = async (): Promise<{ repo: Repo; handle: DocHandle<Store> }> => {
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

const addOp = (handle: DocHandle<Store>, id: string, kind: OperationKind, status: string, args: Record<string, string> = {}) => {
    handle.change(doc => {
        doc.operationDB[id] = {
            id, kind, args,
            engineId: localEngineId,
            status: status as any,
            progressPercent: status === 'Done' ? 100 : 50,
            startedAt: 0 as Timestamp,
            completedAt: status === 'Done' || status === 'Failed' ? 1 as Timestamp : null,
            error: null,
        }
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('recoverInterruptedOperations', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('leaves Done and Failed operations untouched', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'op-done', 'copyApp', 'Done')
        addOp(handle, 'op-failed', 'moveApp', 'Failed')

        await recoverInterruptedOperations(handle, {})

        expect(handle.doc().operationDB['op-done'].status).toBe('Done')
        expect(handle.doc().operationDB['op-failed'].status).toBe('Failed')
    })

    it('marks restoreApp as Failed (fail strategy, no retry)', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'op1', 'restoreApp', 'Running', { instanceId: 'I1', targetDiskId: 'D1' })

        await recoverInterruptedOperations(handle, {})

        const op = handle.doc().operationDB['op1']
        expect(op.status).toBe('Failed')
        expect(op.error).toContain('re-issue manually')
        expect(op.completedAt).not.toBeNull()
    })

    it('marks copyApp as Failed when no retry handler provided', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'op1', 'copyApp', 'Running')

        await recoverInterruptedOperations(handle, {})

        expect(handle.doc().operationDB['op1'].status).toBe('Failed')
    })

    it('calls retry handler for copyApp when provided', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'op1', 'copyApp', 'Running', {
            instanceId: 'INST_1', sourceDiskId: 'DISK_src', targetDiskId: 'DISK_tgt'
        })

        const copyHandler = vi.fn(async () => {})

        await recoverInterruptedOperations(handle, { copyApp: copyHandler })

        // Give the fire-and-forget a tick to run
        await new Promise(r => setTimeout(r, 10))

        expect(copyHandler).toHaveBeenCalledOnce()
        expect(copyHandler).toHaveBeenCalledWith(
            { instanceId: 'INST_1', sourceDiskId: 'DISK_src', targetDiskId: 'DISK_tgt' },
            handle
        )
    })

    it('calls retry handler for moveApp when provided', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'op1', 'moveApp', 'Pending', {
            instanceId: 'INST_2', sourceDiskId: 'DISK_a', targetDiskId: 'DISK_b'
        })

        const moveHandler = vi.fn(async () => {})
        await recoverInterruptedOperations(handle, { moveApp: moveHandler })
        await new Promise(r => setTimeout(r, 10))

        expect(moveHandler).toHaveBeenCalledOnce()
    })

    it('calls retry handler for backupApp when provided', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'op1', 'backupApp', 'Running', {
            instanceId: 'INST_3', backupDiskId: 'DISK_bak'
        })

        const backupHandler = vi.fn(async () => {})
        await recoverInterruptedOperations(handle, { backupApp: backupHandler })
        await new Promise(r => setTimeout(r, 10))

        expect(backupHandler).toHaveBeenCalledOnce()
    })

    it('sets op to Failed when retry handler throws', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'op1', 'copyApp', 'Running', {
            instanceId: 'INST_1', sourceDiskId: 'D1', targetDiskId: 'D2'
        })

        const failingHandler = vi.fn(async () => { throw new Error('disk gone') })
        await recoverInterruptedOperations(handle, { copyApp: failingHandler })

        // Wait for async failure to propagate
        await new Promise(r => setTimeout(r, 50))

        const op = handle.doc().operationDB['op1']
        expect(op.status).toBe('Failed')
        expect(op.error).toContain('disk gone')
    })

    it('handles multiple interrupted ops of different kinds simultaneously', async () => {
        const { handle } = await makeHandle()
        addOp(handle, 'copy1', 'copyApp', 'Running', { instanceId: 'I1', sourceDiskId: 'D1', targetDiskId: 'D2' })
        addOp(handle, 'move1', 'moveApp', 'Pending', { instanceId: 'I2', sourceDiskId: 'D3', targetDiskId: 'D4' })
        addOp(handle, 'restore1', 'restoreApp', 'Running', { instanceId: 'I3', targetDiskId: 'D5' })
        addOp(handle, 'backup1', 'backupApp', 'Running', { instanceId: 'I4', backupDiskId: 'D6' })

        const copyHandler = vi.fn(async () => {})
        const moveHandler = vi.fn(async () => {})
        const backupHandler = vi.fn(async () => {})

        await recoverInterruptedOperations(handle, {
            copyApp: copyHandler,
            moveApp: moveHandler,
            backupApp: backupHandler,
        })
        await new Promise(r => setTimeout(r, 20))

        // retry ops: handler called
        expect(copyHandler).toHaveBeenCalledOnce()
        expect(moveHandler).toHaveBeenCalledOnce()
        expect(backupHandler).toHaveBeenCalledOnce()

        // fail op: marked Failed immediately
        expect(handle.doc().operationDB['restore1'].status).toBe('Failed')
    })

    it('does nothing when operationDB is empty', async () => {
        const { handle } = await makeHandle()
        const handler = vi.fn()
        await recoverInterruptedOperations(handle, { copyApp: handler })
        expect(handler).not.toHaveBeenCalled()
    })
})
