/**
 * no-replay-settled-ops.test.ts — engine#477
 *
 * Once boot recovery has settled (Done / Cancelled) or failed an Operation of ANY kind,
 * the queued command that created it is removed so the startup replay does not run it
 * again. An op recovery left Pending or Running keeps its command (replayed as before).
 * A missing op removes nothing. Generalises the engine#469 (#472) updateApp/restoreApp rule.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { dropInterruptedCommand, recoverInterruptedOperations, QUEUED_COMMAND_OF } from '../../src/data/Operations.js'
import { OperationKind, Timestamp } from '../../src/data/CommonTypes.js'

const ME = localEngineId

let h: DocHandle<Store>

const makeHandle = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const handle = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await handle.whenReady()
    await createOrUpdateEngine(handle, ME)
    handle.change(d => {
        (d.instanceDB as any)['i1'] = { id: 'i1', name: 'Kolibri1' }
        ;(d.diskDB as any)['d1'] = { id: 'd1', name: 'DemoDisk' }
    })
    return handle
}

const queue = (cmds: string[]) => h.change(d => { (d.engineDB[ME as any] as any).commands = cmds })
const queued = () => [...((h.doc().engineDB[ME as any] as any).commands ?? [])].map(String)

const addOp = (id: string, kind: OperationKind, status: string, args: Record<string, string>) => {
    h.change(doc => {
        doc.operationDB[id] = {
            id, kind, args, cause: 'console-command', subject: null, engineId: ME, status: status as any,
            progressPercent: null, currentStep: null, totalSteps: null, stepLabel: null,
            startedAt: 0 as Timestamp, completedAt: null, error: null,
        }
    })
    return h.doc().operationDB[id]
}

/** Per kind: the op args and the queued command that created that op. */
const CASES: Array<{ kind: OperationKind; args: Record<string, string>; cmd: string }> = [
    { kind: 'copyApp', args: { instanceId: 'i1', sourceDiskId: 'd1', targetDiskId: 'd2' }, cmd: 'copyApp i1 d1 d2' },
    { kind: 'moveApp', args: { instanceId: 'i1', sourceDiskId: 'd1', targetDiskId: 'd2' }, cmd: 'moveApp Kolibri1 d1 d2' },
    { kind: 'backupApp', args: { instanceId: 'i1', backupDiskId: 'b1' }, cmd: 'backupApp i1 b1' },
    { kind: 'restoreApp', args: { instanceId: 'i1', targetDiskId: 'd1' }, cmd: 'restoreApp i1 d1' },
    { kind: 'updateApp', args: { instanceId: 'i1', diskId: 'd1', fromAppId: 'k-1', toAppId: 'k-2' }, cmd: 'updateApp i1 k-2 --allow-major' },
    { kind: 'startApp', args: { instanceId: 'i1', diskId: 'd1' }, cmd: 'startInstance i1 d1' },
    { kind: 'stopApp', args: { instanceId: 'i1', diskId: 'd1' }, cmd: 'stopInstance Kolibri1 d1' },
    { kind: 'flashCard', args: { candidateId: 'usb-Card_1', version: '3', confirmSizeBytes: '100' }, cmd: 'flashCard usb-Card_1 current 100' },
    { kind: 'initialiseDisk', args: { candidateId: 'usb-Card_1', role: 'files' }, cmd: 'initialiseDisk usb-Card_1 files' },
    { kind: 'makeBackupDisk', args: { targetId: 'sdz', summaryTraceId: 't1', confirmName: 'STICK' }, cmd: 'makeBackupDisk sdz t1 STICK' },
    { kind: 'setupDemo', args: { targetDiskId: 'd1', apps: 'kolibri' }, cmd: 'setupDemo DemoDisk --apps kolibri' },
    { kind: 'removeDemo', args: { instanceIds: 'i1,i2' }, cmd: 'removeDemo i2 i1' },
]

beforeEach(async () => { h = await makeHandle() })

describe('engine#477: the command of a settled or failed op is not replayed, for every kind', () => {
    it('every kind that a queued command creates has a case here', () => {
        const kinds = Object.entries(QUEUED_COMMAND_OF).filter(([, v]) => v).map(([k]) => k).sort()
        expect(CASES.map(c => c.kind).sort()).toEqual(kinds)
    })

    for (const c of CASES) {
        for (const status of ['Failed', 'Done', 'Cancelled']) {
            it(`${c.kind} ${status}: its queued command is removed; a later identical one and other commands stay`, () => {
                const op = addOp(`op-${c.kind}`, c.kind, status, c.args)
                queue([c.cmd, 'ls', c.cmd])
                expect(dropInterruptedCommand(h, op as any)).toBe(c.cmd)
                expect(queued()).toEqual(['ls', c.cmd])
            })
        }
        for (const status of ['Pending', 'Running']) {
            it(`${c.kind} ${status}: its queued command stays and is replayed as before`, () => {
                const op = addOp(`op-${c.kind}`, c.kind, status, c.args)
                queue([c.cmd])
                expect(dropInterruptedCommand(h, op as any)).toBeNull()
                expect(queued()).toEqual([c.cmd])
            })
        }
    }

    it('reads the recovered state from the store, not the stale op it is given', () => {
        const op = addOp('op-f', 'flashCard', 'Running', CASES[7].args)
        h.change(d => { (d.operationDB['op-f'] as any).status = 'Failed' })
        queue([CASES[7].cmd])
        expect(dropInterruptedCommand(h, op as any)).toBe(CASES[7].cmd)
        expect(queued()).toEqual([])
    })

    it('a missing op (or none) removes nothing', () => {
        queue(['flashCard usb-Card_1 current 100'])
        expect(dropInterruptedCommand(h, { id: 'gone', kind: 'flashCard', args: { candidateId: 'usb-Card_1' }, engineId: ME } as any)).toBeNull()
        expect(dropInterruptedCommand(h, null)).toBeNull()
        expect(dropInterruptedCommand(h, undefined)).toBeNull()
        expect(queued()).toEqual(['flashCard usb-Card_1 current 100'])
    })

    it('kinds no command creates (upgradeApp, upgradeEngine) remove nothing', () => {
        const a = addOp('op-u', 'upgradeApp', 'Failed', { instanceId: 'i1' })
        const b = addOp('op-e', 'upgradeEngine', 'Failed', {})
        queue(['upgradeApp i1', 'upgradeEngine'])
        expect(dropInterruptedCommand(h, a as any)).toBeNull()
        expect(dropInterruptedCommand(h, b as any)).toBeNull()
        expect(queued()).toEqual(['upgradeApp i1', 'upgradeEngine'])
    })

    it('a command for another target or another kind is not removed', () => {
        const op = addOp('op-f', 'flashCard', 'Failed', CASES[7].args)
        queue(['flashCard usb-Card_2 current 100', 'initialiseDisk usb-Card_1 files', 'removeDemo i1'])
        expect(dropInterruptedCommand(h, op as any)).toBeNull()
        const r = addOp('op-r', 'removeDemo', 'Failed', { instanceIds: 'i1,i2' })
        expect(dropInterruptedCommand(h, r as any)).toBeNull()
        expect(queued()).toEqual(['flashCard usb-Card_2 current 100', 'initialiseDisk usb-Card_1 files', 'removeDemo i1'])
    })

    it('the bare removeDemo form matches an op with no instance ids', () => {
        const r = addOp('op-r', 'removeDemo', 'Failed', { instanceIds: '' })
        queue(['removeDemo i1', 'removeDemo'])
        expect(dropInterruptedCommand(h, r as any)).toBe('removeDemo')
        expect(queued()).toEqual(['removeDemo i1'])
    })
})

describe('engine#477 through recoverInterruptedOperations', () => {
    it('fail-strategy kinds interrupted at boot are marked Failed and their commands are not replayed', async () => {
        const failKinds = CASES.filter(c => !['copyApp', 'moveApp', 'backupApp'].includes(c.kind))
        failKinds.forEach(c => addOp(`op-${c.kind}`, c.kind, 'Running', c.args))
        queue([...failKinds.map(c => c.cmd), 'ls'])
        await recoverInterruptedOperations(h, {}, ME as any)
        for (const c of failKinds) expect(h.doc().operationDB[`op-${c.kind}`].status).toBe('Failed')
        expect(queued()).toEqual(['ls'])
    })

    it('retry kinds without a handler are Failed and not replayed', async () => {
        const retry = CASES.filter(c => ['copyApp', 'moveApp', 'backupApp'].includes(c.kind))
        retry.forEach(c => addOp(`op-${c.kind}`, c.kind, 'Running', c.args))
        queue(retry.map(c => c.cmd))
        await recoverInterruptedOperations(h, {}, ME as any)
        expect(queued()).toEqual([])
    })

    it('a scheduled backup marked Failed is not replayed', async () => {
        h.change(doc => {
            doc.operationDB['op-s'] = { id: 'op-s', kind: 'backupApp', args: { instanceId: 'i1', backupDiskId: 'b1' }, cause: 'scheduled-backup', subject: null, engineId: ME, status: 'Running', progressPercent: null, currentStep: null, totalSteps: null, stepLabel: null, startedAt: 0 as Timestamp, completedAt: null, error: null } as any
        })
        queue(['backupApp i1 b1'])
        await recoverInterruptedOperations(h, {}, ME as any)
        expect(h.doc().operationDB['op-s'].status).toBe('Failed')
        expect(queued()).toEqual([])
    })

    it('engine#497: a retried op is owned by recovery: its command is dropped at once, the op ends Done', async () => {
        addOp('op-c', 'copyApp', 'Running', CASES[0].args)
        queue([CASES[0].cmd, 'ls'])
        let resolveRetry!: () => void
        const retried = new Promise<void>(r => { resolveRetry = r })
        await recoverInterruptedOperations(h, { copyApp: () => retried }, ME as any)
        expect(h.doc().operationDB['op-c'].status).toBe('Pending')
        expect(queued()).toEqual(['ls'])
        resolveRetry()
        await vi.waitFor(() => expect(h.doc().operationDB['op-c'].status).toBe('Done'))
    })

    it('an interrupted cross-Engine moveApp settled at boot is not replayed', async () => {
        addOp('op-m', 'moveApp', 'Running', { instanceId: 'i1', sourceDiskId: 'd1', targetDiskId: 'd2', crossEngine: 'true', instanceName: 'Kolibri1' })
        h.change(d => { (d.operationDB['op-m'] as any).move = { verified: true, phase: 'verify' } })
        queue(['moveApp Kolibri1 d1 d2'])
        await recoverInterruptedOperations(h, {}, ME as any)
        expect(h.doc().operationDB['op-m'].status).toBe('Done')
        expect(queued()).toEqual([])
    })

    it("another Engine's op and its queue are left alone", async () => {
        h.change(doc => {
            doc.operationDB['op-o'] = { id: 'op-o', kind: 'flashCard', args: CASES[7].args, cause: 'console-command', subject: null, engineId: 'other-engine', status: 'Running', progressPercent: null, currentStep: null, totalSteps: null, stepLabel: null, startedAt: 0 as Timestamp, completedAt: null, error: null } as any
        })
        queue([CASES[7].cmd])
        await recoverInterruptedOperations(h, {}, ME as any)
        expect(h.doc().operationDB['op-o'].status).toBe('Running')
        expect(queued()).toEqual([CASES[7].cmd])
    })
})

describe('engine#497: boot recovery owns the retry of copyApp / moveApp / backupApp', () => {
    const RETRY = CASES.filter(c => ['copyApp', 'moveApp', 'backupApp'].includes(c.kind))

    for (const c of RETRY) {
        it(`${c.kind}: a successful retry closes the op Done, drops the queued command, and a second pass never retries it`, async () => {
            addOp(`op-${c.kind}`, c.kind, 'Running', c.args)
            queue([c.cmd, 'ls'])
            const handler = vi.fn(async (_a: Record<string, string>, _h: any, opId: string) => {
                expect(opId).toBe(`op-${c.kind}`)
                expect(queued()).toEqual(['ls'])   // dropped before the re-run starts
            })
            await recoverInterruptedOperations(h, { [c.kind]: handler } as any, ME as any)
            await vi.waitFor(() => expect(h.doc().operationDB[`op-${c.kind}`].status).toBe('Done'))
            const op = h.doc().operationDB[`op-${c.kind}`]
            expect(op.error).toBeNull()
            expect(op.completedAt).not.toBeNull()
            expect(queued()).toEqual(['ls'])
            expect(Object.keys(h.doc().operationDB)).toEqual([`op-${c.kind}`])   // no second op
            await recoverInterruptedOperations(h, { [c.kind]: handler } as any, ME as any)   // next boot
            await new Promise(r => setTimeout(r, 20))
            expect(handler).toHaveBeenCalledTimes(1)
        })

        it(`${c.kind}: a failed retry (handler rejects) closes the op Failed and a second pass never retries it`, async () => {
            addOp(`op-${c.kind}`, c.kind, 'Running', c.args)
            queue([c.cmd])
            const handler = vi.fn(async () => { throw new Error('disk gone') })
            await recoverInterruptedOperations(h, { [c.kind]: handler } as any, ME as any)
            await vi.waitFor(() => expect(h.doc().operationDB[`op-${c.kind}`].status).toBe('Failed'))
            expect(h.doc().operationDB[`op-${c.kind}`].error).toBe('Retry failed: disk gone')
            expect(queued()).toEqual([])
            await recoverInterruptedOperations(h, { [c.kind]: handler } as any, ME as any)
            await new Promise(r => setTimeout(r, 20))
            expect(handler).toHaveBeenCalledTimes(1)
        })
    }

    it('a handler that records Failed in the op itself and resolves (copyApp style) leaves it Failed with its own error', async () => {
        addOp('op-c', 'copyApp', 'Running', CASES[0].args)
        const handler = async (_a: any, hh: any, opId: string) => {
            hh.change((d: any) => { d.operationDB[opId].status = 'Failed'; d.operationDB[opId].error = 'rsync died'; d.operationDB[opId].completedAt = 1 })
        }
        await recoverInterruptedOperations(h, { copyApp: handler } as any, ME as any)
        await new Promise(r => setTimeout(r, 20))
        expect(h.doc().operationDB['op-c'].status).toBe('Failed')
        expect(h.doc().operationDB['op-c'].error).toBe('rsync died')
    })

    it('a handler that sets Done itself: the retry marker is cleared, a real Done text stays', async () => {
        addOp('op-c', 'copyApp', 'Running', CASES[0].args)
        addOp('op-m', 'moveApp', 'Running', CASES[1].args)
        const done = (text: string | null) => async (_a: any, hh: any, opId: string) => {
            hh.change((d: any) => { d.operationDB[opId].status = 'Done'; if (text) d.operationDB[opId].error = text })
        }
        await recoverInterruptedOperations(h, { copyApp: done(null), moveApp: done('MOVED, source not removed') } as any, ME as any)
        await new Promise(r => setTimeout(r, 20))
        expect(h.doc().operationDB['op-c'].error).toBeNull()
        expect(h.doc().operationDB['op-m'].error).toBe('MOVED, source not removed')
    })

    it('a Cancelled op stays Cancelled when its retry rejects', async () => {
        addOp('op-b', 'backupApp', 'Running', CASES[2].args)
        const handler = async (_a: any, hh: any, opId: string) => {
            hh.change((d: any) => { d.operationDB[opId].status = 'Cancelled' })
            throw new Error('SIGTERM')
        }
        await recoverInterruptedOperations(h, { backupApp: handler } as any, ME as any)
        await new Promise(r => setTimeout(r, 20))
        expect(h.doc().operationDB['op-b'].status).toBe('Cancelled')
    })

    it('without retryOwned a Pending op keeps its command (dropInterruptedCommand unchanged for other callers)', () => {
        const op = addOp('op-c', 'copyApp', 'Pending', CASES[0].args)
        queue([CASES[0].cmd])
        expect(dropInterruptedCommand(h, op as any)).toBeNull()
        expect(dropInterruptedCommand(h, op as any, { retryOwned: true })).toBe(CASES[0].cmd)
        expect(queued()).toEqual([])
    })
})
