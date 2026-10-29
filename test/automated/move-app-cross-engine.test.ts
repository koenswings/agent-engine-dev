/**
 * move-app-cross-engine.test.ts — moveApp to a disk on another Engine (idea#79).
 *
 * Two Engines share one Automerge store in-process: SOURCE (this Engine) runs
 * moveAppCrossEngine; TARGET runs verifyMoveTarget, wired through the injected
 * requestVerify (the real one is sendCommand). The copy step is injected (the
 * real one is the cross-Engine copyApp path, covered in copy-move-app.test.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { InstanceID, DiskID, DiskName, EngineID, Timestamp, AppID } from '../../src/data/CommonTypes.js'
import { moveAppCrossEngine, verifyMoveTarget, MoveDeps, refusalCode } from '../../src/data/MoveAppRemote.js'
import { MoveError, MOVE_CROSS_ENGINE_CAPABILITY, moveFailedText, sourceNotRemovedText, sizesMatch } from '../../src/data/MoveAppShapes.js'
import { recoverInterruptedOperations } from '../../src/data/Operations.js'
import { RemoveError } from '../../src/data/RemoveInstance.js'

const SRC = String(localEngineId)
const TGT = 'ENGINE_idea04' as EngineID
const SRC_DISK = 'disk-src' as DiskID
const TGT_DISK = 'disk-tgt' as DiskID
const INST = 'inst-src' as InstanceID
const NEW = 'inst-new' as InstanceID
const BYTES = 50 * 1024 * 1024

const inst = (id: InstanceID, storedOn: DiskID, status: string) => ({
    id, instanceOf: 'kolibri-1.0' as AppID, name: 'my-kolibri' as any, status: status as any, port: 3000 as any,
    serviceImages: [], created: 0 as Timestamp, lastBackup: null, lastStarted: 0 as Timestamp, statusCondition: null,
    storedOn, currentStep: null, totalSteps: null, stepLabel: null, metrics: null, portZip: null,
})
const disk = (id: DiskID, dockedTo: string) => ({
    id, name: id as unknown as DiskName, device: 'sda1' as any, dockedTo: dockedTo as any, created: 0 as Timestamp,
    lastDocked: 0 as Timestamp, diskTypes: ['app'], backupConfig: null,
})

const makeStore = (opts: { status?: string, targetCaps?: string[] } = {}): DocHandle<Store> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<Store>({
        engineDB: {
            [SRC]: { id: SRC, hostname: 'idea03', lastBooted: 1, capabilities: [MOVE_CROSS_ENGINE_CAPABILITY], capabilitiesBootedAt: 1 } as any,
            [TGT]: { id: TGT, hostname: 'idea04', lastBooted: 2, capabilities: opts.targetCaps ?? [MOVE_CROSS_ENGINE_CAPABILITY], capabilitiesBootedAt: 2 } as any,
        },
        diskDB: { [SRC_DISK]: disk(SRC_DISK, SRC), [TGT_DISK]: disk(TGT_DISK, TGT) } as any,
        appDB: {},
        instanceDB: { [INST]: inst(INST, SRC_DISK, opts.status ?? 'Running') } as any,
        operationDB: {},
    } as any)
}

/** Two-Engine wiring: copy registers the new instance on the TARGET disk; verify runs as TARGET. */
const twoEngines = (h: DocHandle<Store>, o: { targetStatus?: string, targetBytes?: number, copyFails?: string, verifyReply?: boolean, removeFails?: boolean, sourceBytesSeq?: number[], duringVerify?: (sh: DocHandle<Store>) => void } = {}) => {
    const removeSource = vi.fn(async (sh: DocHandle<Store>, id: InstanceID) => {
        if (o.removeFails) throw new RemoveError('QUARANTINE_FAILED', 'cannot quarantine /disks/sda1/instances/inst-src: busy; the store is unchanged')
        sh.change(d => { delete d.instanceDB[id] })
        return { quarantinePath: `/disks/sda1/.idea-quarantine/${id}` }
    })
    const startSource = vi.fn(async (sh: DocHandle<Store>, i: any) => { sh.change(d => { (d.instanceDB as any)[i.id].status = 'Running' }) })
    const deps: Partial<MoveDeps> = {
        localEngineId: async () => SRC,
        validate: async (store) => ({ instance: store.instanceDB[INST] as any, sourceDisk: store.diskDB[SRC_DISK] as any, targetDisk: store.diskDB[TGT_DISK] as any }),
        helperProblem: async () => null,
        sourceBytes: async () => (o.sourceBytesSeq?.shift() ?? BYTES),
        copy: async (sh) => {
            // like copyApp with keepSourceStopped: the source is stopped for the copy and stays stopped
            sh.change(d => { (d.instanceDB as any)[INST].status = 'Stopped' })
            if (o.copyFails) throw new Error(o.copyFails)
            sh.change(d => { (d.instanceDB as any)[NEW] = inst(NEW, TGT_DISK, o.targetStatus ?? 'Running') })
            return NEW
        },
        requestVerify: (sh, engineId, command) => {
            expect(engineId).toBe(String(TGT))
            o.duringVerify?.(sh)
            if (o.verifyReply === false) return
            const [, opId, id, bytes, running] = command.split(' ')
            void verifyMoveTarget(sh, opId, id, bytes, running, { localEngineId: async () => String(TGT), targetBytes: async () => o.targetBytes ?? BYTES, timeoutMs: 50, pollMs: 5 })
        },
        startSource: startSource as any,
        removeSource: removeSource as any,
        verifyTimeoutMs: 300,
        pollMs: 5,
    }
    return { deps, removeSource, startSource }
}
const theOp = (h: DocHandle<Store>) => Object.values(h.doc().operationDB)[0] as any

describe('moveApp across Engines (idea#79)', () => {
    it('success: copies, verifies on the target, quarantines (never deletes) the source', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h)
        const r = await moveAppCrossEngine(h, 'my-kolibri' as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('MOVED')
        expect(r.text).toBe('MOVED to idea04')
        expect(r.quarantinePath).toContain('.idea-quarantine')
        expect(removeSource).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]).toBeUndefined()
        expect(h.doc().instanceDB[NEW]?.storedOn).toBe(TGT_DISK)
        const op = theOp(h)
        expect(op.kind).toBe('moveApp')
        expect(op.status).toBe('Done')
        expect(op.error).toBeNull()
        expect(op.move).toMatchObject({ phase: 'done', verified: true, sourceRemoved: true, code: 'MOVED', targetInstanceId: NEW, expectedBytes: BYTES })
        expect(op.move.verify.ok).toBe(true)
    })

    it('verify fails (size mismatch): source stays intact, nothing removed', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h, { targetBytes: 10 * 1024 * 1024 })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_FAILED')
        expect(r.text).toMatch(/^MOVE FAILED: .*; source kept$/)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(theOp(h)).toMatchObject({ status: 'Failed', error: r.text })
        expect(theOp(h).move.verified).toBe(false)
    })

    it('verify fails (copy did not start healthy while the source was running): source kept', async () => {
        const h = makeStore({ status: 'Running' })
        const { deps, removeSource } = twoEngines(h, { targetStatus: 'Error' })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_FAILED')
        expect(r.text).toContain('failed to start')
        expect(removeSource).not.toHaveBeenCalled()
    })

    it('target never answers the verify: VERIFY_TIMEOUT, source kept', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h, { verifyReply: false })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_TIMEOUT')
        expect(r.text).toMatch(/source kept$/)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]).toBeDefined()
    })

    it('target unreachable: refused before anything happens (TARGET_UNREACHABLE), no operation', async () => {
        const h = makeStore()
        const { deps } = twoEngines(h)
        deps.validate = async () => `Target engine '${TGT}' is not currently reachable (not in network connections). Ensure it is online and connected.`
        const p = moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        await expect(p).rejects.toBeInstanceOf(MoveError)
        await expect(p).rejects.toMatchObject({ code: 'TARGET_UNREACHABLE' })
        await expect(p).rejects.toThrow(/^MOVE FAILED: .*source kept$/)
        expect(Object.keys(h.doc().operationDB)).toHaveLength(0)
    })

    it('HELPER_OUTDATED: refused before anything happens', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h)
        const copy = vi.fn(deps.copy!)
        deps.copy = copy
        deps.helperProblem = async () => 'moveApp to another Engine needs the app-data root helper /usr/local/sbin/idea-app-data v4 or later'
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)).rejects.toMatchObject({ code: 'HELPER_OUTDATED' })
        expect(copy).not.toHaveBeenCalled()
        expect(removeSource).not.toHaveBeenCalled()
        expect(Object.keys(h.doc().operationDB)).toHaveLength(0)
    })

    it('TARGET_OUTDATED: a target Engine without moveAppCrossEngine is refused', async () => {
        const h = makeStore({ targetCaps: ['removeInstance'] })
        const { deps } = twoEngines(h)
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)).rejects.toMatchObject({ code: 'TARGET_OUTDATED' })
    })

    it('copy interrupted (fails mid-copy): COPY_FAILED, no source removal', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h, { copyFails: 'rsync exited 20 (signal SIGTERM)' })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('COPY_FAILED')
        expect(r.text).toBe(moveFailedText('the copy to idea04 failed (rsync exited 20 (signal SIGTERM))'))
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]).toBeDefined()
    })

    it('Engine restart mid-copy: recovery marks INTERRUPTED and never removes the source', async () => {
        const h = makeStore()
        h.change(d => {
            (d.operationDB as any)['op-m'] = {
                id: 'op-m', kind: 'moveApp', args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                cause: 'console-command', subject: { type: 'instance', id: INST }, engineId: localEngineId, status: 'Running',
                progressPercent: 40, currentStep: 0, totalSteps: 3, stepLabel: 'Copying', startedAt: 0, completedAt: null, error: null,
                move: { phase: 'copying', targetEngineId: TGT, sourceInstanceId: INST, targetInstanceId: null, expectedBytes: BYTES, expectRunning: true,
                    verify: null, verified: false, sourceRemoved: false, quarantinePath: null, code: null, resultText: null },
            }
        })
        const retry = vi.fn(async () => undefined)
        await recoverInterruptedOperations(h, { moveApp: retry })
        const op = h.doc().operationDB['op-m'] as any
        expect(retry).not.toHaveBeenCalled()
        expect(op.status).toBe('Failed')
        expect(op.error).toBe('MOVE FAILED: the Engine restarted during the move; source kept')
        expect(op.move.code).toBe('INTERRUPTED')
        expect(h.doc().instanceDB[INST]).toBeDefined()
    })

    it('Engine restart after a recorded verify: MOVED, source not removed (no automatic delete)', async () => {
        const h = makeStore()
        h.change(d => {
            (d.operationDB as any)['op-v'] = {
                id: 'op-v', kind: 'moveApp', args: {}, cause: 'console-command', subject: null, engineId: localEngineId, status: 'Running',
                progressPercent: 90, currentStep: 2, totalSteps: 3, stepLabel: 'Removing the old copy', startedAt: 0, completedAt: null, error: null,
                move: { phase: 'removing', targetEngineId: TGT, sourceInstanceId: INST, targetInstanceId: NEW, expectedBytes: BYTES, expectRunning: false,
                    verify: { ok: true, bytes: BYTES, detail: null, at: 1 }, verified: true, sourceRemoved: false, quarantinePath: null, code: null, resultText: null },
            }
        })
        await recoverInterruptedOperations(h, {})
        const op = h.doc().operationDB['op-v'] as any
        expect(op.status).toBe('Done')
        expect(op.error).toBe('MOVED, source not removed: the Engine restarted before the old copy was removed')
        expect(op.move.code).toBe('SOURCE_NOT_REMOVED')
    })

    it('removal fails after a good copy: MOVED, source not removed', async () => {
        const h = makeStore()
        const { deps } = twoEngines(h, { removeFails: true })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_NOT_REMOVED')
        expect(r.text.startsWith('MOVED, source not removed: QUARANTINE_FAILED')).toBe(true)
        expect(theOp(h).status).toBe('Done')
        expect(theOp(h).move).toMatchObject({ verified: true, sourceRemoved: false })
        expect(h.doc().instanceDB[INST]).toBeDefined()
    })

    it('source started during the move: SOURCE_CHANGED, MOVED, source not removed, nothing quarantined', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h, { duringVerify: sh => sh.change(d => { const i = (d.instanceDB as any)[INST]; i.status = 'Running'; i.lastStarted = 999 }) })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(r.text).toMatch(/^MOVED, source not removed: the source was started during the move/)
        expect(removeSource).not.toHaveBeenCalled()
        expect(theOp(h)).toMatchObject({ status: 'Done', error: r.text })
        expect(theOp(h).move).toMatchObject({ verified: true, sourceRemoved: false, code: 'SOURCE_CHANGED' })
        expect(h.doc().instanceDB[INST]).toBeDefined()
    })

    it('source started and stopped again during the move (lastStarted moved): SOURCE_CHANGED', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h, { duringVerify: sh => sh.change(d => { (d.instanceDB as any)[INST].lastStarted = 999 }) })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(removeSource).not.toHaveBeenCalled()
    })

    it('source written to during the move (size changed): SOURCE_CHANGED, source kept', async () => {
        const h = makeStore()
        const { deps, removeSource } = twoEngines(h, { sourceBytesSeq: [BYTES, BYTES + 4096] })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(r.text).toMatch(/^MOVED, source not removed: the source was written to during the move/)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]).toBeDefined()
    })

    it('a failed verify restarts a source that was running (it was kept stopped for the copy)', async () => {
        const h = makeStore({ status: 'Running' })
        const { deps, startSource } = twoEngines(h, { targetBytes: 1 })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_FAILED')
        expect(startSource).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]?.status).toBe('Running')
    })

    it('progress steps are Copying, Checking, Removing the old copy', async () => {
        const h = makeStore()
        const { deps } = twoEngines(h)
        const labels: string[] = []
        h.on('change', () => { const op = theOp(h); if (op?.stepLabel && labels[labels.length - 1] !== op.stepLabel) labels.push(op.stepLabel) })
        await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(labels).toEqual(['Copying', 'Checking', 'Removing the old copy'])
    })

    it('texts, codes and size tolerance', () => {
        expect(moveFailedText('x.')).toBe('MOVE FAILED: x; source kept')
        expect(sourceNotRemovedText('y')).toBe('MOVED, source not removed: y')
        expect(refusalCode("Instance name 'a' is ambiguous: …")).toBe('AMBIGUOUS')
        expect(refusalCode("Source disk 'x' is docked to a remote engine. Copy/move must be initiated from that engine.")).toBe('SOURCE_REMOTE')
        expect(sizesMatch(BYTES, BYTES + 1000)).toBe(true)
        expect(sizesMatch(BYTES, BYTES / 2)).toBe(false)
    })
})
