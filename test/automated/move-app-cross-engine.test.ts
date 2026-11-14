/**
 * move-app-cross-engine.test.ts — moveApp to a disk on another Engine (idea#79).
 *
 * Two Engines share one Automerge store in-process: SOURCE (this Engine) runs
 * moveAppCrossEngine; TARGET runs verifyMoveTarget, wired through the injected
 * requestVerify (the real one is sendCommand). The copy step is injected (the
 * real one is the cross-Engine copyApp path, covered in copy-move-app.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { InstanceID, DiskID, DiskName, EngineID, Timestamp, AppID } from '../../src/data/CommonTypes.js'
import { moveAppCrossEngine, verifyMoveTarget, cleanupMoveTarget, MoveDeps, refusalCode, moveCommandOutcome, MOVE_PROGRESS_TYPE, isInFlightKeepIdMove, CLEANUP_TIMEOUT_MS } from '../../src/data/MoveAppRemote.js'
import { removeInstance as dropInstanceFromDisk } from '../../src/data/Disk.js'
import { checkingProgressMessage, setPortReadyProgress, resetPortReadyProgressForTests } from '../../src/data/PortReadyProgress.js'
import { MoveError, MOVE_CODES, MOVE_FAILURE_CODES, MOVE_REFUSAL_CODES, MOVE_DONE_CODES, MOVE_CROSS_ENGINE_CAPABILITY, moveFailedText, sourceNotRemovedText, sourceKeptText, withTargetCleanupText, sizesMatch } from '../../src/data/MoveAppShapes.js'
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
    serviceImages: [], created: 0 as Timestamp, lastBackup: 1_700_000_000_000 as Timestamp, lastStarted: 0 as Timestamp, statusCondition: null,
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

/** Two-Engine wiring: copy keeps the same id and does not flip storedOn; verify runs as TARGET. */
const twoEngines = (h: DocHandle<Store>, o: { targetStatus?: string, targetBytes?: number, copyFails?: string, verifyReply?: boolean, removeFails?: boolean, sourceBytesSeq?: number[], sourceBytesThrows?: string, cleanupFails?: string, duringVerify?: (sh: DocHandle<Store>) => void, folderExists?: boolean } = {}) => {
    const removeSource = vi.fn(async (_sh: DocHandle<Store>, id: InstanceID) => {
        if (o.removeFails) throw new RemoveError('QUARANTINE_FAILED', 'cannot quarantine /disks/sda1/instances/inst-src: busy; the store is unchanged')
        // engine#381: quarantine the source folder only; never delete instanceDB[id]
        return { quarantinePath: `/disks/sda1/.idea-quarantine/${id}` }
    })
    const startSource = vi.fn(async (sh: DocHandle<Store>, i: any) => { sh.change(d => { (d.instanceDB as any)[i.id].status = 'Running' }) })
    const requestStart = vi.fn()
    const stopAndQuarantine = vi.fn(async (disk: any, id: InstanceID) => {
        if (o.cleanupFails) throw new Error(o.cleanupFails)
        return { quarantinePath: `/disks/sdb1/.idea-quarantine/${id}` }
    })
    const requestCleanup = vi.fn(async (sh: DocHandle<Store>, engineId: string, command: string) => {
        expect(engineId).toBe(String(TGT))
        const parts = command.split(' ')
        expect(parts[0]).toBe('cleanupMoveTarget')
        const [, opId, id, diskId] = parts
        await cleanupMoveTarget(sh, opId, id, diskId, { localEngineId: async () => String(TGT), stopAndQuarantine })
    })
    const deps: Partial<MoveDeps> = {
        localEngineId: async () => SRC,
        validate: async (store) => ({ instance: store.instanceDB[INST] as any, sourceDisk: store.diskDB[SRC_DISK] as any, targetDisk: store.diskDB[TGT_DISK] as any }),
        helperProblem: async () => null,
        sourceBytes: async () => {
            if (o.sourceBytesSeq && o.sourceBytesSeq.length === 0 && o.sourceBytesThrows) throw new Error(o.sourceBytesThrows)
            if (o.sourceBytesThrows && !o.sourceBytesSeq) throw new Error(o.sourceBytesThrows)
            return o.sourceBytesSeq?.shift() ?? BYTES
        },
        targetFolderExists: async () => o.folderExists === true,
        copy: async (sh) => {
            // like copyApp with keepSourceStopped + dstId: source stopped, same id, storedOn unchanged
            sh.change(d => { (d.instanceDB as any)[INST].status = 'Stopped' })
            if (o.copyFails) throw new Error(o.copyFails)
            return INST
        },
        requestStart: requestStart as any,
        requestVerify: (sh, engineId, command) => {
            expect(engineId).toBe(String(TGT))
            o.duringVerify?.(sh)
            if (o.verifyReply === false) return
            const [, opId, id, bytes, running] = command.split(' ')
            const healthy = running === 'true' && (!o.targetStatus || o.targetStatus === 'Running')
            if (healthy) setPortReadyProgress(id, { firstReadyAt: Date.now() - 10_000, stableMs: 10_000, stableReached: true })
            void verifyMoveTarget(sh, opId, id, bytes, running, { localEngineId: async () => String(TGT), targetBytes: async () => o.targetBytes ?? BYTES, timeoutMs: 50, pollMs: 5 })
        },
        requestCleanup: requestCleanup as any,
        startSource: startSource as any,
        removeSource: removeSource as any,
        verifyTimeoutMs: 300,
        cleanupTimeoutMs: 300,
        pollMs: 5,
    }
    return { deps, removeSource, startSource, requestStart, requestCleanup, stopAndQuarantine }
}
const theOp = (h: DocHandle<Store>) => Object.values(h.doc().operationDB)[0] as any

describe('moveApp across Engines (idea#79)', () => {
    afterEach(() => { resetPortReadyProgressForTests() })

    it('success: copies, verifies on the target, quarantines (never deletes) the source', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup } = twoEngines(h)
        const r = await moveAppCrossEngine(h, 'my-kolibri' as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('MOVED')
        expect(r.text).toBe('MOVED to idea04')
        expect(r.quarantinePath).toContain('.idea-quarantine')
        expect(removeSource).toHaveBeenCalledTimes(1)
        expect(requestCleanup).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
        expect(h.doc().instanceDB[NEW]).toBeUndefined()
        const op = theOp(h)
        expect(op.kind).toBe('moveApp')
        expect(op.status).toBe('Done')
        expect(op.error).toBeNull()
        expect(op.move).toMatchObject({ phase: 'done', verified: true, sourceRemoved: true, code: 'MOVED', targetInstanceId: INST, expectedBytes: BYTES, targetCleanup: null })
        expect(op.move.verify.ok).toBe(true)
    })

    it('verify fails (size mismatch): source stays intact, target copy stopped and quarantined', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine, requestStart } = twoEngines(h, { targetBytes: 10 * 1024 * 1024 })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_SIZE')
        expect(r.text).toBe(withTargetCleanupText(moveFailedText('the copy on idea04 did not check out (size 10485760 bytes, expected 52428800)'), 'quarantined', 'idea04'))
        expect(requestStart).toHaveBeenCalled()
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine.mock.calls[0][0].id).toBe(TGT_DISK)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
        expect(theOp(h)).toMatchObject({ status: 'Failed', error: r.text })
        expect(theOp(h).move).toMatchObject({ verified: false, targetCleanup: 'quarantined', code: 'VERIFY_SIZE' })
    })

    it('Checking fails with a running target: VERIFY_NOT_RUNNING, target stopped and quarantined, source kept', async () => {
        const h = makeStore({ status: 'Running' })
        const { deps, removeSource, requestCleanup, stopAndQuarantine, requestStart, startSource } = twoEngines(h, { targetStatus: 'Error' })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_NOT_RUNNING')
        expect(r.text).toMatch(/did not start|failed to start/)
        expect(r.text).toMatch(/source kept, the copy on idea04 was quarantined$/)
        expect(requestStart).toHaveBeenCalled()
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        expect(startSource).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(h.doc().instanceDB[INST]?.status).toBe('Running')
        expect(theOp(h).move.targetCleanup).toBe('quarantined')
    })

    it('target never answers the verify: VERIFY_TIMEOUT, target copy stopped and quarantined, source kept', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine, requestStart } = twoEngines(h, { verifyReply: false })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_TIMEOUT')
        expect(r.text).toBe(withTargetCleanupText(moveFailedText('idea04 did not confirm the copy in time'), 'quarantined', 'idea04'))
        expect(requestStart).toHaveBeenCalled()
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(theOp(h).move.targetCleanup).toBe('quarantined')
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

    it('copy interrupted (fails mid-copy): COPY_FAILED, no source removal, no cleanup', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine } = twoEngines(h, { copyFails: 'rsync exited 20 (signal SIGTERM)' })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('COPY_FAILED')
        expect(r.text).toBe(moveFailedText('the copy to idea04 failed (rsync exited 20 (signal SIGTERM))'))
        expect(r.text).not.toMatch(/quarantined|leftover copy/)
        expect(requestCleanup).not.toHaveBeenCalled()
        expect(stopAndQuarantine).not.toHaveBeenCalled()
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]).toBeDefined()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(theOp(h).move).toMatchObject({ code: 'COPY_FAILED', targetCleanup: null, targetInstanceId: null })
    })

    it('size measurement throws after a finished copy: SOURCE_KEPT, cleanup requested, storedOn unchanged', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine, startSource } = twoEngines(h, { sourceBytesThrows: 'du failed' })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_KEPT')
        expect(r.text).toBe(withTargetCleanupText(moveFailedText('du failed'), 'quarantined', 'idea04'))
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine.mock.calls[0][0].id).toBe(TGT_DISK)
        expect(removeSource).not.toHaveBeenCalled()
        expect(startSource).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
        expect(theOp(h)).toMatchObject({ status: 'Failed', error: r.text })
        expect(theOp(h).move).toMatchObject({
            verified: false, sourceRemoved: false, code: 'SOURCE_KEPT',
            targetCleanup: 'quarantined', targetInstanceId: INST, expectedBytes: null,
        })
    })

    it('cleanup timeout reports within the short bound, targetCleanup failed, leftover named', async () => {
        const h = makeStore()
        const { deps, stopAndQuarantine, removeSource } = twoEngines(h, { targetBytes: 1 })
        deps.cleanupTimeoutMs = 80
        deps.pollMs = 10
        const requestCleanup = vi.fn(() => { /* never writes targetCleanup */ })
        deps.requestCleanup = requestCleanup as any
        const t0 = Date.now()
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        const elapsed = Date.now() - t0
        expect(r.code).toBe('VERIFY_SIZE')
        expect(r.text).toBe(withTargetCleanupText(moveFailedText('the copy on idea04 did not check out (size 1 bytes, expected 52428800)'), 'failed', 'idea04'))
        expect(r.text).toMatch(/the leftover copy is on idea04$/)
        expect(elapsed).toBeLessThan(1500)
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).not.toHaveBeenCalled()
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(theOp(h).move.targetCleanup).toBe('failed')
        expect(theOp(h).move.targetCleanupDetail).toMatch(/timed out/)
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
                id: 'op-v', kind: 'moveApp', args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' }, cause: 'console-command', subject: null, engineId: localEngineId, status: 'Running',
                progressPercent: 90, currentStep: 2, totalSteps: 3, stepLabel: 'Removing the old copy', startedAt: 0, completedAt: null, error: null,
                move: { phase: 'removing', targetEngineId: TGT, sourceInstanceId: INST, targetInstanceId: INST, expectedBytes: BYTES, expectRunning: false,
                    verify: { ok: true, bytes: BYTES, detail: null, at: 1 }, verified: true, sourceRemoved: false, quarantinePath: null, code: null, resultText: null },
            }
        })
        await recoverInterruptedOperations(h, {})
        const op = h.doc().operationDB['op-v'] as any
        expect(op.status).toBe('Done')
        expect(op.error).toBe('MOVED, source not removed: the Engine restarted before the old copy was removed')
        expect(op.move.code).toBe('SOURCE_NOT_REMOVED')
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
    })

    it('removal fails after a good copy: MOVED, source not removed, no target cleanup', async () => {
        const h = makeStore()
        const { deps, requestCleanup, stopAndQuarantine } = twoEngines(h, { removeFails: true })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_NOT_REMOVED')
        expect(r.text.startsWith('MOVED, source not removed: QUARANTINE_FAILED')).toBe(true)
        expect(requestCleanup).not.toHaveBeenCalled()
        expect(stopAndQuarantine).not.toHaveBeenCalled()
        expect(theOp(h).status).toBe('Done')
        expect(theOp(h).move).toMatchObject({ verified: true, sourceRemoved: false, targetCleanup: null })
        expect(h.doc().instanceDB[INST]).toBeDefined()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
    })

    it('source started during the move: SOURCE_CHANGED, source kept, target copy quarantined', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine, startSource } = twoEngines(h, { duringVerify: sh => sh.change(d => { const i = (d.instanceDB as any)[INST]; i.status = 'Running'; i.lastStarted = 999 }) })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(r.text).toBe(withTargetCleanupText(sourceKeptText('the source was started during the move (status Running); it may hold newer data than the copy'), 'quarantined', 'idea04'))
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        // already Running, so restartIfNeeded does not start it again
        expect(startSource).not.toHaveBeenCalled()
        expect(theOp(h)).toMatchObject({ status: 'Done', error: r.text })
        expect(theOp(h).move).toMatchObject({ verified: true, sourceRemoved: false, code: 'SOURCE_CHANGED', targetCleanup: 'quarantined' })
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
    })

    it('source started and stopped again during the move (lastStarted moved): SOURCE_CHANGED, target quarantined', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine, startSource } = twoEngines(h, { duringVerify: sh => sh.change(d => { (d.instanceDB as any)[INST].lastStarted = 999 }) })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(r.text).toMatch(/^MOVE STOPPED: the source was started during the move/)
        expect(r.text).toMatch(/source kept, the copy on idea04 was quarantined$/)
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        // status is still Stopped after the copy, so restartIfNeeded restarts it
        expect(startSource).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(theOp(h).move.targetCleanup).toBe('quarantined')
    })

    it('source written to during the move (size changed): SOURCE_CHANGED, source kept, target quarantined', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine } = twoEngines(h, { sourceBytesSeq: [BYTES, BYTES + 4096] })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(r.text).toBe(withTargetCleanupText(sourceKeptText(`the source was written to during the move (${BYTES} → ${BYTES + 4096} bytes); it may hold newer data than the copy`), 'quarantined', 'idea04'))
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(theOp(h).move.targetCleanup).toBe('quarantined')
    })

    it('source record is gone before the flip: SOURCE_CHANGED, target quarantined, source not quarantined', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine } = twoEngines(h)
        // Record a good verify and drop the source row in the same change so
        // step 3 sees SOURCE_CHANGED rather than a VERIFY_NOT_FOUND race.
        deps.requestVerify = (sh, engineId, command) => {
            expect(engineId).toBe(String(TGT))
            const [, opId] = command.split(' ')
            sh.change(d => {
                const op = (d.operationDB as any)?.[opId]
                if (op?.move) op.move.verify = { ok: true, code: null, bytes: BYTES, detail: null, at: Date.now() }
                delete (d.instanceDB as any)[INST]
            })
        }
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(r.text).toBe(withTargetCleanupText(sourceKeptText('the source instance record is gone'), 'quarantined', 'idea04'))
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]).toBeUndefined()
        expect(theOp(h).move).toMatchObject({ code: 'SOURCE_CHANGED', targetCleanup: 'quarantined', sourceRemoved: false })
    })

    it('failed source-size measurement before the flip: SOURCE_KEPT, target quarantined, storedOn unchanged', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine, startSource } = twoEngines(h, { sourceBytesSeq: [BYTES], sourceBytesThrows: 'du failed' })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_KEPT')
        expect(r.text).toBe(withTargetCleanupText(moveFailedText('du failed'), 'quarantined', 'idea04'))
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine.mock.calls[0][0].id).toBe(TGT_DISK)
        expect(removeSource).not.toHaveBeenCalled()
        expect(startSource).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
        expect(theOp(h)).toMatchObject({ status: 'Failed', error: r.text })
        expect(theOp(h).move).toMatchObject({ verified: true, sourceRemoved: false, code: 'SOURCE_KEPT', targetCleanup: 'quarantined' })
    })

    it('target cleanup itself failing: leftover copy is named in the result, storedOn unchanged', async () => {
        const h = makeStore()
        const { deps, removeSource, requestCleanup, stopAndQuarantine } = twoEngines(h, { sourceBytesSeq: [BYTES, BYTES * 2], cleanupFails: 'cannot quarantine: busy' })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('SOURCE_CHANGED')
        expect(r.text).toBe(withTargetCleanupText(sourceKeptText(`the source was written to during the move (${BYTES} → ${BYTES * 2} bytes); it may hold newer data than the copy`), 'failed', 'idea04'))
        expect(r.text).toMatch(/the leftover copy is on idea04$/)
        expect(requestCleanup).toHaveBeenCalledTimes(1)
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(theOp(h).move).toMatchObject({ targetCleanup: 'failed', targetCleanupDetail: 'cannot quarantine: busy', code: 'SOURCE_CHANGED' })
    })

    it('a failed verify restarts a source that was running (it was kept stopped for the copy)', async () => {
        const h = makeStore({ status: 'Running' })
        const { deps, startSource } = twoEngines(h, { targetBytes: 1 })
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('VERIFY_SIZE')
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
        expect(sourceKeptText('the source was started during the move.')).toBe('MOVE STOPPED: the source was started during the move; source kept')
        expect(withTargetCleanupText(moveFailedText('x'), 'quarantined', 'idea04')).toBe('MOVE FAILED: x; source kept, the copy on idea04 was quarantined')
        expect(withTargetCleanupText(sourceKeptText('x'), 'failed', 'idea04')).toBe('MOVE STOPPED: x; source kept, the leftover copy is on idea04')
        expect(CLEANUP_TIMEOUT_MS).toBe(60_000)
        expect(refusalCode("Instance name 'a' is ambiguous: …")).toBe('AMBIGUOUS')
        expect(refusalCode("Source disk 'x' is docked to a remote engine. Copy/move must be initiated from that engine.")).toBe('SOURCE_REMOTE')
        expect(refusalCode(`instance ${INST} already exists on idea04`)).toBe('TARGET_EXISTS')
        expect(sizesMatch(BYTES, BYTES + 1000)).toBe(true)
        expect(sizesMatch(BYTES, BYTES / 2)).toBe(false)
    })

    // ── stable machine code on BOTH the op and the command trace (console#179) ──
    const viaTrace = async (h: DocHandle<Store>, deps: Partial<MoveDeps>) => {
        const { handleCommand } = await import('../../src/utils/commandUtils.js')
        const log = new Repo({ network: [] }).create<any>({ traces: {}, recentTraceIds: [] })
        const commands = [{ name: 'moveApp', args: [], scope: 'engine' as const, execute: async (sh: any) => {
            moveCommandOutcome(await moveAppCrossEngine(sh, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps))
        } }]
        await handleCommand(commands, h, 'engine', 'moveApp', log)
        const ids = log.doc().recentTraceIds
        return log.doc().traces[ids[ids.length - 1]]
    }
    const scenarios: [string, any, (h: DocHandle<Store>, d: Partial<MoveDeps>) => void, string][] = [
        ['MOVED', {}, () => {}, 'MOVED'],
        ['VERIFY_SIZE', { targetBytes: 1 }, () => {}, 'VERIFY_SIZE'],
        ['VERIFY_NOT_RUNNING', { status: 'Running', targetStatus: 'Stopped' }, () => {}, 'VERIFY_NOT_RUNNING'],
        ['VERIFY_NOT_FOUND', { copyNotRegistered: true }, () => {}, 'VERIFY_NOT_FOUND'],
        ['VERIFY_TIMEOUT', { verifyReply: false }, () => {}, 'VERIFY_TIMEOUT'],
        ['COPY_FAILED', { copyFails: 'rsync died' }, () => {}, 'COPY_FAILED'],
        ['SOURCE_NOT_REMOVED', { removeFails: true }, () => {}, 'SOURCE_NOT_REMOVED'],
        ['SOURCE_CHANGED', { sourceBytesSeq: [BYTES, BYTES * 2] }, () => {}, 'SOURCE_CHANGED'],
        ['SOURCE_KEPT', { sourceBytesSeq: [BYTES], sourceBytesThrows: 'du failed' }, () => {}, 'SOURCE_KEPT'],
        ['HELPER_OUTDATED (refusal)', {}, (_h, d) => { d.helperProblem = async () => 'needs helper v4' }, 'HELPER_OUTDATED'],
        ['TARGET_UNREACHABLE (refusal)', {}, (_h, d) => { d.validate = async () => `Target engine '${TGT}' is not currently reachable (not in network connections).` }, 'TARGET_UNREACHABLE'],
        ['TARGET_EXISTS (refusal)', { folderExists: true }, () => {}, 'TARGET_EXISTS'],
    ]
    it.each(scenarios)('%s: code on op.move.code and trace errorCode/result.code', async (_n, o, tweak, code) => {
        const h = makeStore(o.status ? { status: o.status } : undefined)
        const { deps } = twoEngines(h, o)
        if (o.copyNotRegistered) deps.copy = async (sh) => {
            sh.change(d => {
                (d.instanceDB as any)[INST].status = 'Stopped'
                ;(d.diskDB as any)[TGT_DISK].dockedTo = null
            })
            return INST
        }
        tweak(h, deps)
        const t = await viaTrace(h, deps)
        const result = JSON.parse(t.result)
        expect(result.code).toBe(code)
        expect(typeof result.text).toBe('string')
        const refusal = (MOVE_REFUSAL_CODES as readonly string[]).includes(code)
        const failed = refusal || (MOVE_FAILURE_CODES as readonly string[]).includes(code)
        expect(t.status).toBe(failed ? 'error' : 'ok')
        if (failed) {
            expect(t.errorCode).toBe(code)
            expect(t.errorMessage).toBe(result.text)
            expect(t.errorMessage).toMatch(/^MOVE FAILED: .*source kept/)
        } else {
            expect(t.errorCode ?? null).toBeNull()
        }
        if (refusal) expect(Object.keys(h.doc().operationDB)).toHaveLength(0)
        else {
            expect(theOp(h).move.code).toBe(code)
            expect(theOp(h).status).toBe(failed ? 'Failed' : 'Done')
        }
    })

    it('BUSY: a locked instance is refused with BUSY', async () => {
        const { resourceLock, instanceKey } = await import('../../src/utils/ResourceLock.js')
        const h = makeStore()
        const { deps } = twoEngines(h)
        expect(resourceLock.acquire(instanceKey(INST), 'test')).toBe(true)
        try {
            await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)).rejects.toMatchObject({ code: 'BUSY' })
        } finally { resourceLock.release(instanceKey(INST)) }
    })

    it('keeps the instance id and lastBackup; no second instanceDB row', async () => {
        const h = makeStore()
        const { deps } = twoEngines(h)
        const r = await moveAppCrossEngine(h, 'my-kolibri' as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('MOVED')
        expect(r.targetInstanceId).toBe(String(INST))
        expect(Object.keys(h.doc().instanceDB)).toEqual([INST])
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
        expect(h.doc().instanceDB[INST]?.name).toBe('my-kolibri')
    })

    it('TARGET_EXISTS: a leftover folder on the target is refused before anything happens', async () => {
        const h = makeStore()
        const { deps } = twoEngines(h, { folderExists: true })
        const copy = vi.fn(deps.copy!)
        deps.copy = copy
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)).rejects.toMatchObject({
            code: 'TARGET_EXISTS',
        })
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)).rejects.toThrow(/already exists on disk-tgt; source kept/)
        expect(copy).not.toHaveBeenCalled()
        expect(Object.keys(h.doc().operationDB)).toHaveLength(0)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
    })

    it('TARGET_EXISTS: storedOn already names a disk on the target Engine', async () => {
        const h = makeStore()
        h.change(d => { (d.instanceDB as any)[INST].storedOn = TGT_DISK })
        const { deps } = twoEngines(h)
        const copy = vi.fn(deps.copy!)
        deps.copy = copy
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)).rejects.toMatchObject({
            code: 'TARGET_EXISTS',
        })
        expect(copy).not.toHaveBeenCalled()
        expect(Object.keys(h.doc().operationDB)).toHaveLength(0)
    })

    it('an interrupted (unverified) move leaves the source intact and authoritative', async () => {
        const h = makeStore()
        h.change(d => {
            (d.operationDB as any)['op-m'] = {
                id: 'op-m', kind: 'moveApp', args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                cause: 'console-command', subject: { type: 'instance', id: INST }, engineId: localEngineId, status: 'Running',
                progressPercent: 40, currentStep: 0, totalSteps: 3, stepLabel: 'Copying', startedAt: 0, completedAt: null, error: null,
                move: { phase: 'checking', targetEngineId: TGT, sourceInstanceId: INST, targetInstanceId: INST, expectedBytes: BYTES, expectRunning: true,
                    verify: null, verified: false, sourceRemoved: false, quarantinePath: null, code: null, resultText: null },
            }
        })
        await recoverInterruptedOperations(h, {})
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(h.doc().instanceDB[INST]?.lastBackup).toBe(1_700_000_000_000)
        expect((h.doc().operationDB['op-m'] as any).move.code).toBe('INTERRUPTED')
    })

    it('dock scan must not mark Missing when storedOn is already another disk', () => {
        const h = makeStore()
        h.change(d => { (d.instanceDB as any)[INST].storedOn = TGT_DISK; (d.instanceDB as any)[INST].status = 'Running' })
        dropInstanceFromDisk(h, h.doc().diskDB[SRC_DISK] as any, INST)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
        expect(h.doc().instanceDB[INST]?.status).toBe('Running')
    })

    it('isInFlightKeepIdMove is true only for an unverified move to that target disk', () => {
        const h = makeStore()
        expect(isInFlightKeepIdMove(h.doc(), INST, TGT_DISK)).toBe(false)
        h.change(d => {
            (d.operationDB as any)['op-m'] = {
                id: 'op-m', kind: 'moveApp',
                args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                status: 'Running',
                move: { phase: 'checking', sourceInstanceId: INST, targetInstanceId: INST, verified: false, sourceRemoved: false },
            } as any
        })
        expect(isInFlightKeepIdMove(h.doc(), INST, TGT_DISK)).toBe(true)
        expect(isInFlightKeepIdMove(h.doc(), INST, SRC_DISK)).toBe(false)
        h.change(d => { (d.operationDB['op-m'] as any).move.verified = true })
        expect(isInFlightKeepIdMove(h.doc(), INST, TGT_DISK)).toBe(false)
    })

    it('MOVE_CODES is the single list: refusals + failures + done, no duplicates', () => {
        expect(MOVE_CODES).toEqual([...MOVE_REFUSAL_CODES, ...MOVE_FAILURE_CODES, ...MOVE_DONE_CODES])
        expect(new Set(MOVE_CODES).size).toBe(MOVE_CODES.length)
        expect(MOVE_CODES).toEqual(expect.arrayContaining(['VERIFY_SIZE', 'VERIFY_NOT_RUNNING', 'VERIFY_NOT_FOUND', 'VERIFY_TIMEOUT', 'TARGET_EXISTS', 'SOURCE_KEPT']))
        expect(MOVE_FAILURE_CODES).toContain('SOURCE_KEPT')
        expect(MOVE_DONE_CODES).toContain('SOURCE_CHANGED')
        expect(MOVE_DONE_CODES).toContain('SOURCE_NOT_REMOVED')
    })

    it('the source picks up the verify result on the store change, without waiting for the 2 s poll (idea#498)', async () => {
        const h = makeStore()
        const { deps } = twoEngines(h, { verifyReply: false })
        deps.pollMs = 2000
        deps.verifyTimeoutMs = 3000
        deps.requestVerify = (sh, engineId, command) => {
            expect(engineId).toBe(String(TGT))
            const [, opId] = command.split(' ')
            setTimeout(() => {
                sh.change(doc => {
                    const op = doc.operationDB?.[opId] as any
                    if (op?.move) op.move.verify = { ok: true, code: null, bytes: BYTES, detail: null, at: Date.now() }
                })
            }, 40)
        }
        const t0 = Date.now()
        const r = await moveAppCrossEngine(h, 'my-kolibri' as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        const elapsed = Date.now() - t0
        expect(r.code).toBe('MOVED')
        expect(elapsed).toBeLessThan(1500)
        expect(theOp(h).move.verify.ok).toBe(true)
    })

    it('emits idea/progress for Copying at the start, before the copy work (idea#498)', async () => {
        const h = makeStore()
        const seen: object[] = []
        const { deps } = twoEngines(h)
        deps.broadcast = (m: object) => { seen.push(m) }
        const inner = deps.copy!
        let atCopyStart: object[] = []
        deps.copy = async (...args: Parameters<typeof inner>) => {
            atCopyStart = [...seen]
            return inner(...args)
        }
        const r = await moveAppCrossEngine(h, 'my-kolibri' as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('MOVED')
        const msg = atCopyStart.find((m: any) => m.type === MOVE_PROGRESS_TYPE && m.step === 'Copying') as any
        expect(msg).toMatchObject({ type: 'idea/progress', step: 'Copying', bytesDone: 0, bytesTotal: 0 })
        expect(typeof msg.opId).toBe('string')
        expect(msg.opId.length).toBeGreaterThan(0)
    })
})


describe('cleanupMoveTarget (engine#388)', () => {
    it('stops and quarantines the target folder when storedOn still names the source', async () => {
        const h = makeStore()
        h.change(d => {
            (d.operationDB as any)['op-c'] = {
                id: 'op-c', kind: 'moveApp',
                args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                status: 'Failed', startedAt: 1000,
                move: { phase: 'failed', sourceInstanceId: INST, targetInstanceId: INST, verified: false, sourceRemoved: false, targetCleanup: null, targetCleanupDetail: null, code: 'SOURCE_KEPT' },
            } as any
        })
        const stopAndQuarantine = vi.fn(async (disk: any, id: InstanceID) => {
            expect(disk.id).toBe(TGT_DISK)
            expect(id).toBe(INST)
            return { quarantinePath: `/disks/sdb1/.idea-quarantine/${id}` }
        })
        const r = await cleanupMoveTarget(h, 'op-c', INST, TGT_DISK, { localEngineId: async () => String(TGT), stopAndQuarantine })
        expect(r).toEqual({ status: 'quarantined', detail: `/disks/sdb1/.idea-quarantine/${INST}` })
        expect(stopAndQuarantine).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect((h.doc().operationDB as any)['op-c'].move).toMatchObject({
            targetCleanup: 'quarantined',
            targetCleanupDetail: `/disks/sdb1/.idea-quarantine/${INST}`,
        })
    })

    it('refuses to touch the folder when the row says the id is stored on the target', async () => {
        const h = makeStore()
        h.change(d => { (d.instanceDB as any)[INST].storedOn = TGT_DISK })
        h.change(d => {
            (d.operationDB as any)['op-c'] = {
                id: 'op-c', kind: 'moveApp',
                args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                status: 'Running',
                move: { phase: 'removing', sourceInstanceId: INST, targetInstanceId: INST, verified: true, sourceRemoved: false, targetCleanup: null, targetCleanupDetail: null },
            } as any
        })
        const stopAndQuarantine = vi.fn(async () => ({ quarantinePath: '/should-not-run' }))
        const r = await cleanupMoveTarget(h, 'op-c', INST, TGT_DISK, { localEngineId: async () => String(TGT), stopAndQuarantine })
        expect(r.status).toBe('failed')
        expect(r.detail).toMatch(/stored on the target/)
        expect(stopAndQuarantine).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
        expect((h.doc().operationDB as any)['op-c'].move.targetCleanup).toBe('failed')
    })

    it('does not quarantine when the target disk is not docked to this Engine', async () => {
        const h = makeStore()
        h.change(d => {
            (d.operationDB as any)['op-c'] = {
                id: 'op-c', kind: 'moveApp',
                args: { instanceId: INST, targetDiskId: TGT_DISK },
                status: 'Running',
                move: { phase: 'checking', sourceInstanceId: INST, targetInstanceId: INST, verified: false, targetCleanup: null, targetCleanupDetail: null },
            } as any
        })
        const stopAndQuarantine = vi.fn(async () => ({ quarantinePath: '/should-not-run' }))
        const r = await cleanupMoveTarget(h, 'op-c', INST, TGT_DISK, { localEngineId: async () => SRC, stopAndQuarantine })
        expect(r.status).toBe('failed')
        expect(r.detail).toMatch(/not docked to this Engine/)
        expect(stopAndQuarantine).not.toHaveBeenCalled()
    })

    it('refuses a late cleanup when a newer moveApp op exists for the instance', async () => {
        const h = makeStore()
        h.change(d => {
            (d.operationDB as any)['op-old'] = {
                id: 'op-old', kind: 'moveApp',
                args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                status: 'Failed', startedAt: 1000,
                move: { phase: 'failed', sourceInstanceId: INST, targetInstanceId: INST, verified: false, sourceRemoved: false, targetCleanup: null, targetCleanupDetail: null, code: 'VERIFY_SIZE' },
            } as any
            (d.operationDB as any)['op-new'] = {
                id: 'op-new', kind: 'moveApp',
                args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                status: 'Running', startedAt: 2000,
                move: { phase: 'copying', sourceInstanceId: INST, targetInstanceId: INST, verified: false, sourceRemoved: false, targetCleanup: null, targetCleanupDetail: null, code: null },
            } as any
        })
        const stopAndQuarantine = vi.fn(async () => ({ quarantinePath: '/should-not-run' }))
        const r = await cleanupMoveTarget(h, 'op-old', INST, TGT_DISK, { localEngineId: async () => String(TGT), stopAndQuarantine })
        expect(r.status).toBe('failed')
        expect(r.detail).toMatch(/newer moveApp/)
        expect(stopAndQuarantine).not.toHaveBeenCalled()
        expect((h.doc().operationDB as any)['op-old'].move.targetCleanup).toBeNull()
        expect((h.doc().operationDB as any)['op-new'].move.targetCleanup).toBeNull()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
    })

    it('refuses cleanup for a successful moveApp op and records nothing destructive', async () => {
        const h = makeStore()
        // storedOn stays on the source so this hits the late-safe success check, not the storedOn-on-target refusal.
        h.change(d => {
            (d.operationDB as any)['op-ok'] = {
                id: 'op-ok', kind: 'moveApp',
                args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                status: 'Done', startedAt: 1000,
                move: { phase: 'done', sourceInstanceId: INST, targetInstanceId: INST, verified: true, sourceRemoved: true, targetCleanup: null, targetCleanupDetail: null, code: 'MOVED' },
            } as any
        })
        const stopAndQuarantine = vi.fn(async () => ({ quarantinePath: '/should-not-run' }))
        const r = await cleanupMoveTarget(h, 'op-ok', INST, TGT_DISK, { localEngineId: async () => String(TGT), stopAndQuarantine })
        expect(r.status).toBe('failed')
        expect(r.detail).toMatch(/already succeeded/)
        expect(stopAndQuarantine).not.toHaveBeenCalled()
        expect((h.doc().operationDB as any)['op-ok'].move.targetCleanup).toBeNull()
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
    })
})

describe('verifyMoveTarget Checking idea/progress (idea#498 option 3)', () => {
    afterEach(() => { resetPortReadyProgressForTests() })

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

    it('checkingProgressMessage: starting, stabilising with rising N, reset to starting, then stable', () => {
        const opId = 'op-move'
        const t0 = 1_000_000
        expect(checkingProgressMessage(opId, undefined, t0)).toEqual({
            type: 'idea/progress', opId, step: 'Checking', bytesDone: 0, bytesTotal: 0,
            checking: { phase: 'starting', label: 'Starting on new Engine', stableElapsedMs: 0, stableTargetMs: 10_000 },
        })
        const snap = { firstReadyAt: t0, stableMs: 10_000 }
        const s1 = checkingProgressMessage(opId, snap, t0 + 1500)
        expect(s1.checking).toEqual({ phase: 'stabilising', label: 'Checking it stays up: 1 of 10 s', stableElapsedMs: 1500, stableTargetMs: 10_000 })
        const s2 = checkingProgressMessage(opId, snap, t0 + 2500)
        expect(s2.checking).toEqual({ phase: 'stabilising', label: 'Checking it stays up: 2 of 10 s', stableElapsedMs: 2500, stableTargetMs: 10_000 })
        const reset = checkingProgressMessage(opId, { firstReadyAt: null, stableMs: 10_000 }, t0 + 3000)
        expect(reset.checking).toEqual({ phase: 'starting', label: 'Starting on new Engine', stableElapsedMs: 0, stableTargetMs: 10_000 })
        expect(checkingProgressMessage(opId, snap, t0 + 10_000).checking).toEqual({
            phase: 'stable', label: 'Checking it stays up: 10 of 10 s', stableElapsedMs: 10_000, stableTargetMs: 10_000,
        })
        expect(checkingProgressMessage(opId, { ...snap, stableReached: true }, t0 + 100).checking.phase).toBe('stable')
        // stableTargetMs is always present and equals the real stableMs in use
        const custom = { firstReadyAt: null as number | null, stableMs: 8_000 }
        for (const m of [
            checkingProgressMessage(opId, custom, t0),
            checkingProgressMessage(opId, { firstReadyAt: t0, stableMs: 8_000 }, t0 + 1500),
            checkingProgressMessage(opId, { firstReadyAt: t0, stableMs: 8_000, stableReached: true }, t0 + 100),
        ]) {
            expect(m.type).toBe('idea/progress')
            expect(m.checking.stableTargetMs).toBe(8_000)
        }
    })

    it('broadcasts that sequence from a fake prober; opId matches; no message after the verdict; nothing written to the doc', async () => {
        const h = makeStore()
        h.change(doc => {
            (doc.instanceDB as any)[INST] = inst(INST, TGT_DISK, 'Starting')
            doc.operationDB['op-move'] = {
                id: 'op-move', kind: 'moveApp',
                args: { instanceId: String(INST), sourceDiskId: String(SRC_DISK), targetDiskId: String(TGT_DISK), crossEngine: 'true' },
                status: 'Running', currentStep: 1, totalSteps: 3, stepLabel: 'Checking',
                move: {
                    phase: 'checking', targetEngineId: String(TGT), sourceInstanceId: String(INST), targetInstanceId: String(INST),
                    expectedBytes: BYTES, expectRunning: true, verify: null, verified: false, sourceRemoved: false,
                    quarantinePath: null, code: null, resultText: null,
                },
            } as any
        })
        const seen: any[] = []
        const verifyP = verifyMoveTarget(h, 'op-move', String(INST), String(BYTES), 'true', {
            localEngineId: async () => String(TGT),
            targetBytes: async () => BYTES,
            timeoutMs: 4000,
            pollMs: 25,
            progressIntervalMs: 25,
            broadcast: (m) => { seen.push(JSON.parse(JSON.stringify(m))) },
        })

        await sleep(40)
        setPortReadyProgress(String(INST), { firstReadyAt: Date.now() - 1500, stableMs: 10_000 })
        await sleep(50)
        setPortReadyProgress(String(INST), { firstReadyAt: Date.now() - 2500, stableMs: 10_000 })
        await sleep(50)
        setPortReadyProgress(String(INST), { firstReadyAt: null, stableMs: 10_000 })
        await sleep(50)
        setPortReadyProgress(String(INST), { firstReadyAt: Date.now() - 10_000, stableMs: 10_000, stableReached: true })
        await sleep(50)
        h.change(d => { (d.instanceDB as any)[INST].status = 'Running' })
        const v = await verifyP
        expect(v.ok).toBe(true)

        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every((m: any) => m.type === 'idea/progress' && m.step === 'Checking' && m.opId === 'op-move' && m.bytesDone === 0 && m.bytesTotal === 0 && m.checking.stableTargetMs === 10_000)).toBe(true)
        const phases = seen.map((m: any) => m.checking.phase)
        expect(phases[0]).toBe('starting')
        expect(seen[0].checking).toMatchObject({ label: 'Starting on new Engine', stableElapsedMs: 0, stableTargetMs: 10_000 })
        const firstStab = phases.indexOf('stabilising')
        expect(firstStab).toBeGreaterThan(0)
        const stab = seen.filter((m: any) => m.checking.phase === 'stabilising')
        expect(stab.length).toBeGreaterThanOrEqual(2)
        const nOf = (m: any) => Number((m.checking.label.match(/Checking it stays up: (\d+) of 10 s/) ?? [])[1])
        expect(nOf(stab[0])).toBeLessThan(nOf(stab[stab.length - 1]))
        const resetAt = phases.indexOf('starting', firstStab)
        expect(resetAt).toBeGreaterThan(firstStab)
        const stableAt = phases.indexOf('stable')
        expect(stableAt).toBeGreaterThan(resetAt)
        expect(seen.filter((m: any) => m.checking.phase === 'stable')).toHaveLength(1)
        expect(seen[stableAt].checking).toMatchObject({ label: 'Checking it stays up: 10 of 10 s', stableElapsedMs: 10_000, stableTargetMs: 10_000 })

        const afterVerdict = seen.length
        await sleep(80)
        expect(seen.length).toBe(afterVerdict)

        const op = (h.doc().operationDB as any)['op-move']
        expect(op.stepLabel).toBe('Checking')
        expect(op.currentStep).toBe(1)
        expect(op.move.verify.ok).toBe(true)
        expect(op.move.checking).toBeUndefined()
        expect(op.checking).toBeUndefined()
        expect((h.doc() as any).checking).toBeUndefined()
    })

    it('sends stable exactly once and no message after stable for that opId', async () => {
        const h = makeStore()
        const stableMs = 10_000
        h.change(doc => {
            (doc.instanceDB as any)[INST] = inst(INST, TGT_DISK, 'Starting')
            doc.operationDB['op-move'] = {
                id: 'op-move', kind: 'moveApp',
                args: { instanceId: String(INST), sourceDiskId: String(SRC_DISK), targetDiskId: String(TGT_DISK), crossEngine: 'true' },
                status: 'Running', currentStep: 1, totalSteps: 3, stepLabel: 'Checking',
                move: {
                    phase: 'checking', targetEngineId: String(TGT), sourceInstanceId: String(INST), targetInstanceId: String(INST),
                    expectedBytes: BYTES, expectRunning: true, verify: null, verified: false, sourceRemoved: false,
                    quarantinePath: null, code: null, resultText: null,
                },
            } as any
        })
        const seen: any[] = []
        const verifyP = verifyMoveTarget(h, 'op-move', String(INST), String(BYTES), 'true', {
            localEngineId: async () => String(TGT),
            targetBytes: async () => BYTES,
            timeoutMs: 4000,
            pollMs: 25,
            progressIntervalMs: 25,
            broadcast: (m) => { seen.push(JSON.parse(JSON.stringify(m))) },
        })
        await sleep(40)
        setPortReadyProgress(String(INST), { firstReadyAt: Date.now() - stableMs, stableMs, stableReached: true })
        const deadline = Date.now() + 1000
        while (Date.now() < deadline && !seen.some((m: any) => m.checking?.phase === 'stable')) await sleep(10)
        expect(seen.filter((m: any) => m.checking?.phase === 'stable')).toHaveLength(1)
        const afterStable = seen.length
        // A later probe reset must not produce another message for this op.
        setPortReadyProgress(String(INST), { firstReadyAt: null, stableMs })
        await sleep(80)
        expect(seen.length).toBe(afterStable)
        h.change(d => { (d.instanceDB as any)[INST].status = 'Running' })
        const v = await verifyP
        expect(v.ok).toBe(true)
        await sleep(80)
        expect(seen.length).toBe(afterStable)
        expect(seen.filter((m: any) => m.checking?.phase === 'stable')).toHaveLength(1)
        expect(seen.every((m: any) => m.type === 'idea/progress' && m.opId === 'op-move' && m.checking.stableTargetMs === stableMs)).toBe(true)
        expect((h.doc().operationDB as any)['op-move'].stepLabel).toBe('Checking')
    })
})
