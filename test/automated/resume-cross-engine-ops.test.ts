/**
 * resume-cross-engine-ops.test.ts — engine#497 stage 3 (a), cross-Engine resume.
 *
 * Koen's decisions (2026-11-17): Q1 option A, the SOURCE Engine owns the resume and pushes again,
 * into the same folder and id on the target, under the in-flight marker it wrote there (through
 * the target's peer gate) before the first byte. Q2: a parked move keeps its source stopped; the
 * source starts again only when the move gives up (RESUME_GAVE_UP).
 *
 * Two Engines share one Automerge store in-process. The target's disk is a fake (`peer`): its
 * markers (instances/<id>.idea-op-in-flight → opId) and folders (partial | complete), driven by
 * the copy fake the way the v23 helper verbs do (peer-mark-in-flight refuses an existing folder,
 * peer-resume-receive needs this op's marker). The helper and gate themselves are covered for
 * real in idea-app-data-peers.test.ts / idea-peer-gate-script.test.ts. The target's verify is
 * the real verifyMoveTarget; boot recovery, dock pass and peer watch are the real Operations code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { fs } from 'zx'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { InstanceID, DiskID, DiskName, EngineID, Timestamp, AppID } from '../../src/data/CommonTypes.js'
import { disksRoot, config } from '../../src/data/Config.js'
import { setRootDeviceForTests } from '../../src/data/Disk.js'
import { moveAppCrossEngine, verifyMoveTarget, MoveDeps, moveCommandOutcome, moveOpFinished } from '../../src/data/MoveAppRemote.js'
import { checkAndSetUndockedApps } from '../../src/data/UndockedApps.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { commands } from '../../src/data/Commands.js'
import { crossResumeRefusal } from '../../src/data/CopyMoveApp.js'
import { MOVE_CROSS_ENGINE_CAPABILITY, MOVE_FAILURE_CODES } from '../../src/data/MoveAppShapes.js'
import { setPortReadyProgress, resetPortReadyProgressForTests } from '../../src/data/PortReadyProgress.js'
import {
    recoverInterruptedOperations, noteDiskDocked, resetResumeStateForTests, resumePeerParkedOps, peerResumeProbe,
    peerInterruption, peerTargetReady, setOperationArgs, markEngineStopping, resetEngineStoppingForTests,
    isResumableOp, isParkedOp, RETRY_MARKER, PEER_RESUME_RETRY_MS, PEER_PROBE_BACKOFF_MS, RetryHandler, resumeGate, skippedSystemDiskHere,
} from '../../src/data/Operations.js'
import { CROSS_ENGINE_RESUME_CAPABILITY, peerInFlight, isPeerLinkFailure, engineCanResume } from '../../src/data/InFlight.js'
import { engineCapabilities } from '../../src/data/Engine.js'
import { shouldAutoStart, moveInFlightFromSource } from '../../src/data/AutoStart.js'

const { startInstanceMock } = vi.hoisted(() => ({ startInstanceMock: vi.fn(async (..._a: any[]) => undefined) }))
vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, startInstance: (...a: any[]) => startInstanceMock(...a) }
})

const SRC = String(localEngineId)
const TGT = 'ENGINE_idea04' as EngineID
const TGT_ADDR = '10.0.0.4'
const SRC_DISK = 'disk-src' as DiskID
const TGT_DISK = 'disk-tgt' as DiskID
const SRC_DEV = 'sdx497a'
const TGT_DEV = 'sdy497a'
const INST = 'inst-src' as InstanceID
const BYTES = 50 * 1024 * 1024

const makeStore = (o: { status?: string, targetCaps?: string[] } = {}): DocHandle<Store> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<Store>({
        engineDB: {
            [SRC]: { id: SRC, hostname: 'idea03', lastBooted: 1, commands: [], capabilities: [MOVE_CROSS_ENGINE_CAPABILITY, CROSS_ENGINE_RESUME_CAPABILITY], capabilitiesBootedAt: 1 } as any,
            [TGT]: { id: TGT, hostname: 'idea04', lastBooted: 2, commands: [], capabilities: o.targetCaps ?? [MOVE_CROSS_ENGINE_CAPABILITY, CROSS_ENGINE_RESUME_CAPABILITY], capabilitiesBootedAt: 2 } as any,
        },
        diskDB: {
            [SRC_DISK]: { id: SRC_DISK, name: 'src' as DiskName, device: SRC_DEV, dockedTo: SRC, created: 0, lastDocked: 0, diskTypes: ['app'], backupConfig: null },
            [TGT_DISK]: { id: TGT_DISK, name: 'tgt' as DiskName, device: TGT_DEV, dockedTo: TGT, created: 0, lastDocked: 0, diskTypes: ['app'], backupConfig: null },
        } as any,
        appDB: {},
        instanceDB: {
            [INST]: {
                id: INST, instanceOf: 'kolibri-1.0' as AppID, name: 'my-kolibri', status: o.status ?? 'Running', port: 3000,
                serviceImages: [], created: 0 as Timestamp, lastBackup: 1_700_000_000_000 as Timestamp, lastStarted: 0 as Timestamp, statusCondition: null,
                storedOn: SRC_DISK, currentStep: null, totalSteps: null, stepLabel: null, metrics: null, portZip: null,
            },
        } as any,
        operationDB: {},
    } as any)
}

/** The target Engine's disk, as its v23 helper keeps it. */
const peer = {
    up: true,
    markers: new Map<string, string>(),
    folders: new Map<string, 'partial' | 'complete'>(),
    pushes: [] as { opId: string, resumedInto: boolean }[],
    copyScript: [] as ('ok' | 'link' | 'cut' | 'fail')[],
    verifyScript: [] as ('ok' | 'bad')[],
}
const LINK_ERR = 'rsync (idea-app-data send exited with code 12: rsync: connection unexpectedly closed)'
const REAL_ERR = 'rsync (idea-app-data send exited with code 23: some files vanished)'

const wire = (h: DocHandle<Store>) => {
    const removeSource = vi.fn(async (_sh: DocHandle<Store>, id: InstanceID) => ({ quarantinePath: `/disks/${SRC_DEV}/.idea-quarantine/${id}` }))
    const startSource = vi.fn(async () => undefined)
    const requestStart = vi.fn()
    const clearTargetMarker = vi.fn(async (_host: string, _e: string, _root: string, id: string, opId: string) => {
        if (!peer.up) throw new Error('ssh exited with code 255: Connection refused')
        if (peer.markers.get(id) === opId) peer.markers.delete(id)
    })
    const copy = vi.fn(async (sh: DocHandle<Store>, id: InstanceID, _s: DiskID, _t: DiskID, _c: any, opId: string) => {
        // copyApp (keepSourceStopped, same id) on the source Engine
        sh.change(d => { (d.instanceDB as any)[INST].status = 'Stopped' })
        const key = String(id)
        const mark = peer.markers.get(key)
        if (!mark) {
            // peer-mark-in-flight: a NEW id only
            if (peer.folders.has(key)) throw new Error(`peer-mark-in-flight refused: instances/${key} already exists`)
            peer.markers.set(key, opId)
            setOperationArgs(sh, opId, { targetMarked: '1' })
        } else if (mark !== opId) {
            throw new Error(`peer-resume-receive refused: instances/${key} is in flight for another operation`)
        }
        peer.pushes.push({ opId, resumedInto: peer.folders.has(key) })
        const step = peer.copyScript.shift() ?? 'ok'
        if (step === 'link') { peer.folders.set(key, 'partial'); peer.up = false; throw new Error(LINK_ERR) }
        if (step === 'cut') { peer.folders.set(key, 'partial'); markEngineStopping(); throw new Error('rsync (idea-app-data send stopped by SIGKILL)') }
        if (step === 'fail') { peer.folders.set(key, 'partial'); throw new Error(REAL_ERR) }
        peer.folders.set(key, 'complete')
        return id
    })
    const deps: Partial<MoveDeps> = {
        localEngineId: async () => SRC,
        validate: async (store) => ({ instance: store.instanceDB[INST] as any, sourceDisk: store.diskDB[SRC_DISK] as any, targetDisk: store.diskDB[TGT_DISK] as any }),
        helperProblem: async () => null,
        crossResumeHelperProblem: async () => null,
        sourceBytes: async () => BYTES,
        targetFolderExists: async (_s, _d, id) => peer.folders.has(String(id)),
        copy: copy as any,
        requestStart: requestStart as any,
        requestVerify: (sh, engineId, command) => {
            expect(engineId).toBe(String(TGT))
            const [, opId, id, bytes, running] = command.split(' ')
            if (running === 'true') setPortReadyProgress(id, { firstReadyAt: Date.now() - 10_000, stableMs: 10_000, stableReached: true })
            const bad = (peer.verifyScript.shift() ?? 'ok') === 'bad'
            void verifyMoveTarget(sh, opId, id, bytes, running, {
                localEngineId: async () => String(TGT),
                targetBytes: async () => (!bad && peer.folders.get(id) === 'complete') ? BYTES : 1,
                timeoutMs: 50, pollMs: 5,
            })
        },
        requestCleanup: vi.fn() as any,
        clearTargetMarker: clearTargetMarker as any,
        startSource: startSource as any,
        removeSource: removeSource as any,
        verifyTimeoutMs: 400,
        cleanupTimeoutMs: 100,
        pollMs: 5,
    }
    // the boot / dock / peer-watch handler: moveApp resumes the cross move in its own op (CopyMoveApp.moveApp)
    const handlers: Record<string, RetryHandler> = {
        moveApp: async (args, sh, opId) => {
            moveCommandOutcome(await moveAppCrossEngine(sh, args.instanceId as any, args.sourceDiskId as DiskID, args.targetDiskId as DiskID, 'console-command', deps, { recoveredOpId: opId }))
        },
    }
    return { deps, handlers, copy, removeSource, startSource, requestStart, clearTargetMarker }
}
const theOp = (h: DocHandle<Store>) => Object.values(h.doc().operationDB)[0] as any
const until = async (fn: () => boolean, what: string, ms = 3000) => {
    const t0 = Date.now()
    while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
        await new Promise(r => setTimeout(r, 5))
    }
}

const expectSourceHeldStopped = (h: DocHandle<Store>, startSource: ReturnType<typeof vi.fn>) => {
    const inst = h.doc().instanceDB[INST] as any
    expect(inst.status).toBe('Stopped')
    expect(inst.storedOn).toBe(SRC_DISK)
    expect(startSource).not.toHaveBeenCalled()
    expect(startInstanceMock).not.toHaveBeenCalled()
    // Koen Q2: no Engine starts it by itself (dock, re-add) while the move is parked
    const decision = shouldAutoStart(h.doc(), inst)
    expect(decision.start).toBe(false)
    expect(decision.reason).toMatch(/a move of this instance is in flight/)
    expect(moveInFlightFromSource(h.doc(), inst)?.id).toBe(theOp(h).id)
}

describe('engine#497 stage 3 (a): cross-Engine resume (the source owns the resume)', () => {
    beforeEach(async () => {
        peer.up = true
        peer.markers.clear(); peer.folders.clear(); peer.pushes.length = 0
        peer.copyScript.length = 0; peer.verifyScript.length = 0
        startInstanceMock.mockClear()
        resetResumeStateForTests()
        resetEngineStoppingForTests()
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        // the source disk is mounted here (copyInterruption looks for <mount>/instances)
        await fs.ensureDir(`${disksRoot()}/${SRC_DEV}/instances`)
        peerResumeProbe.address = (id: string) => (id === String(TGT) && peer.up) ? TGT_ADDR : undefined
        peerResumeProbe.reachable = undefined
        // the give-up path clears the target marker through peerInFlight (MoveAppRemote defaultDeps)
        peerInFlight.clear = async (_host, _e, _root, id, opId) => { if (peer.markers.get(id) === opId) peer.markers.delete(id) }
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        resetPortReadyProgressForTests()
        resetEngineStoppingForTests()
        setRootDeviceForTests(null)
        await fs.remove(`${disksRoot()}/${SRC_DEV}`)
    })

    it('a new cross move is resumable from the start: crossResume 1, wasRunning, the target engine on the op (Console contract)', async () => {
        const h = makeStore({ status: 'Running' })
        const { deps } = wire(h)
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', deps)
        expect(r.code).toBe('MOVED')
        const op = theOp(h)
        expect(op.engineId).toBe(SRC)
        expect(op.move).toMatchObject({ sourceEngineId: SRC, targetEngineId: String(TGT), phase: 'done', code: 'MOVED' })
        expect(op.args).toMatchObject({ crossEngine: 'true', crossResume: '1', wasRunning: '1', targetEngineId: String(TGT), phase: 'done' })
        expect(op.args.targetMarked).toBeUndefined()
        expect(isResumableOp(op)).toBe(true)
        // marked before the first byte, cleared before storedOn flipped
        expect(peer.markers.size).toBe(0)
        expect(peer.pushes).toEqual([{ opId: op.id, resumedInto: false }])
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
    })

    it('the link to the target fails mid-push: parked RESUME_WAITING (not counted), source held stopped; the source pushes again into the SAME folder when the peer is back → Done', async () => {
        const h = makeStore({ status: 'Running' })
        const w = wire(h)
        await recoverInterruptedOperations(h, w.handlers)
        noteDiskDocked(h, SRC_DISK)
        peer.copyScript.push('link')
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        expect(r.code).toBe('RESUME_PARKED')
        const op = theOp(h)
        expect(op.status).toBe('Pending')
        expect(op.error).toMatch(/^RESUME_WAITING: Engine ENGINE_idea04 is not connected: rsync \(idea-app-data send exited with code 12/)
        expect(op.args.resumeFailures).toBeUndefined()
        expect(op.args).toMatchObject({ phase: 'copying', targetMarked: '1', wasRunning: '1' })
        expect(op.move.phase).toBe('copying')
        expect(isParkedOp(op)).toBe(true)
        // the partial copy stays on the target under this op's marker
        expect(peer.markers.get(INST)).toBe(op.id)
        expect(peer.folders.get(INST)).toBe('partial')
        expectSourceHeldStopped(h, w.startSource)
        // peer still away: nothing resumes
        expect(await resumePeerParkedOps(h)).toEqual([])
        // the peer is back: the source Engine resumes the op itself
        peer.up = true
        expect(await resumePeerParkedOps(h)).toEqual([op.id])
        await until(() => theOp(h).status === 'Done', 'the resumed move to end Done')
        const done = theOp(h)
        expect(Object.keys(h.doc().operationDB)).toEqual([op.id])          // the same op, no second one
        expect(done.error).toBeNull()
        expect(done.move).toMatchObject({ phase: 'done', code: 'MOVED', verified: true, sourceRemoved: true })
        expect(peer.pushes).toEqual([{ opId: op.id, resumedInto: false }, { opId: op.id, resumedInto: true }])
        expect(peer.markers.size).toBe(0)
        expect(peer.folders.get(INST)).toBe('complete')
        expect(w.removeSource).toHaveBeenCalledTimes(1)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
        // the post-move start goes to the target, never the source
        expect(w.startSource).not.toHaveBeenCalled()
        expect(w.requestStart.mock.calls.map(c => c[2])).toEqual([
            `startInstance ${INST} ${TGT_DISK} --cause cross-engine-cmd --op ${op.id}`,
            `startInstance ${INST} ${TGT_DISK} --cause post-move`,
        ])
    })

    it('a power cut on the source mid-push: the op stays Running; after the reboot it waits for its source dock pass, then pushes again into the same folder → Done', async () => {
        const h = makeStore({ status: 'Stopped' })
        const w = wire(h)
        peer.copyScript.push('cut')
        await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        const op = theOp(h)
        expect(op.status).toBe('Running')                                  // as after a real cut
        // reboot
        resetEngineStoppingForTests()
        resetResumeStateForTests()
        await recoverInterruptedOperations(h, w.handlers)
        expect(theOp(h).status).toBe('Pending')
        expect(theOp(h).error).toMatch(/^RESUME_WAITING: resumes when 'src' \(disk-src\) has docked/)
        expect(peer.markers.get(INST)).toBe(op.id)
        // the source disk's dock pass; the target is ready on its peer
        expect(noteDiskDocked(h, SRC_DISK)).toEqual([op.id])
        await until(() => theOp(h).status === 'Done', 'the resumed move to end Done')
        expect(theOp(h).move.code).toBe('MOVED')
        expect(peer.pushes.map(p => p.resumedInto)).toEqual([false, true])
        expect(new Set(peer.pushes.map(p => p.opId))).toEqual(new Set([op.id]))
        expect(peer.markers.size).toBe(0)
        expect(w.removeSource).toHaveBeenCalledTimes(1)
    })

    it('the source Engine restarts while the target is Checking: it resumes at Checking (no second push), asks the target to start the marked copy as this op', async () => {
        const h = makeStore({ status: 'Running' })
        const w = wire(h)
        // a first run that stops at Checking (verify times out on a busy target)
        const d0 = { ...w.deps, requestVerify: () => undefined, verifyTimeoutMs: 30 }
        await recoverInterruptedOperations(h, w.handlers)
        noteDiskDocked(h, SRC_DISK)
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', d0)
        expect(r.code).toBe('RESUME_PARKED')
        const op = theOp(h)
        expect(op.error).toMatch(/^RESUME_PENDING \(1\/3\): VERIFY_TIMEOUT: idea04 did not confirm the copy in time/)
        expect(op.move.phase).toBe('checking')
        expectSourceHeldStopped(h, w.startSource)
        // reboot of the source
        resetResumeStateForTests()
        await recoverInterruptedOperations(h, w.handlers)
        expect(noteDiskDocked(h, SRC_DISK)).toEqual([op.id])
        await until(() => theOp(h).status === 'Done', 'the resumed move to end Done')
        expect(w.copy).toHaveBeenCalledTimes(1)                           // Checking resumed, no second push
        expect(w.requestStart.mock.calls.filter(c => / --op /.test(c[2])).map(c => c[2])).toEqual([
            `startInstance ${INST} ${TGT_DISK} --cause cross-engine-cmd --op ${op.id}`,
            `startInstance ${INST} ${TGT_DISK} --cause cross-engine-cmd --op ${op.id}`,
        ])
        expect(theOp(h).move).toMatchObject({ code: 'MOVED', verified: true })
    })

    it('real failures count: RESUME_PENDING (1/3) → resumes only when the peer changed → (2/3) → Failed RESUME_GAVE_UP; the target copy is unmarked and quarantined, the source starts again', async () => {
        const h = makeStore({ status: 'Running' })
        const w = wire(h)
        await recoverInterruptedOperations(h, w.handlers)
        noteDiskDocked(h, SRC_DISK)
        peer.verifyScript.push('bad', 'bad', 'bad')
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        expect(r.code).toBe('RESUME_PARKED')
        const op = theOp(h)
        expect(op.error).toMatch(/^RESUME_PENDING \(1\/3\): VERIFY_SIZE: /)
        expect(op.args.resumeFailures).toBe('1')
        expectSourceHeldStopped(h, w.startSource)
        // a counted failure does not loop: nothing changed on the peer, nothing resumes
        expect(await resumePeerParkedOps(h)).toEqual([])
        expect(await resumePeerParkedOps(h, Date.now() + PEER_RESUME_RETRY_MS + 1)).toEqual([])
        // the target disk re-docks on its Engine: like a dock, that is a new chance
        h.change(d => { (d.diskDB as any)[TGT_DISK].lastDocked = 10 })
        expect(await resumePeerParkedOps(h)).toEqual([op.id])
        await until(() => /^RESUME_PENDING \(2\/3\)/.test(String(theOp(h).error)), 'the second park')
        expectSourceHeldStopped(h, w.startSource)
        // the target Engine reboots
        h.change(d => { (d.engineDB as any)[TGT].lastBooted = 3; (d.engineDB as any)[TGT].capabilitiesBootedAt = 3 })
        expect(await resumePeerParkedOps(h)).toEqual([op.id])
        await until(() => theOp(h).status === 'Failed', 'the give-up')
        const failed = theOp(h)
        expect(failed.error).toMatch(/^RESUME_GAVE_UP: VERIFY_SIZE: /)
        expect(failed.move).toMatchObject({ phase: 'failed', code: 'RESUME_GAVE_UP', verified: false, sourceRemoved: false })
        // gave up while Checking: the marker goes and the target is asked to quarantine its copy (engine#388, never rm)
        await until(() => startInstanceMock.mock.calls.length === 1, 'the source restart')
        expect(peer.markers.size).toBe(0)
        expect((h.doc().engineDB as any)[TGT].commands).toContain(`cleanupMoveTarget ${op.id} ${INST} ${TGT_DISK}`)
        expect(failed.args.targetMarked).toBeUndefined()
        // Koen Q2: the source starts again (it was running), on its own disk
        expect(String(startInstanceMock.mock.calls[0][1].id)).toBe(INST)
        expect(String(startInstanceMock.mock.calls[0][2].id)).toBe(SRC_DISK)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(SRC_DISK)
        expect(w.removeSource).not.toHaveBeenCalled()
        expect(shouldAutoStart(h.doc(), h.doc().instanceDB[INST] as any).reason).not.toMatch(/in flight/)
    })

    it('gave up while Copying: the partial copy and its marker stay on the target (kept for the operator); a source that was stopped stays stopped', async () => {
        const h = makeStore({ status: 'Stopped' })
        const w = wire(h)
        await recoverInterruptedOperations(h, w.handlers)
        noteDiskDocked(h, SRC_DISK)
        peer.copyScript.push('fail', 'fail', 'fail')
        await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        const op = theOp(h)
        expect(op.error).toMatch(/^RESUME_PENDING \(1\/3\): rsync \(idea-app-data send exited with code 23/)
        expect(await resumePeerParkedOps(h)).toEqual([])                         // first look: nothing changed yet
        for (const n of [2, 3]) {
            h.change(d => { (d.diskDB as any)[TGT_DISK].lastDocked = n })
            expect(await resumePeerParkedOps(h)).toEqual([op.id])
            expect(await resumePeerParkedOps(h)).toEqual([])                     // never twice at once
            await until(() => n === 3 ? theOp(h).status === 'Failed' : /\(2\/3\)/.test(String(theOp(h).error)), `run ${n}`)
        }
        expect(w.copy).toHaveBeenCalledTimes(3)
        expect(peer.pushes.map(p => p.resumedInto)).toEqual([false, true, true])
        expect(theOp(h).move).toMatchObject({ phase: 'failed', code: 'RESUME_GAVE_UP' })
        await new Promise(r => setTimeout(r, 20))
        expect(peer.markers.get(INST)).toBe(op.id)                         // kept, still marked
        expect(peer.folders.get(INST)).toBe('partial')
        expect((h.doc().engineDB as any)[TGT].commands ?? []).toEqual([])  // no cleanup asked
        expect(startInstanceMock).not.toHaveBeenCalled()                   // wasRunning '0'
        expect(theOp(h).args.wasRunning).toBe('0')
    })

    it('the target refuses what is not this op\'s: a new move to the same id is refused TARGET_EXISTS while the partial is there; the parked op is untouched', async () => {
        const h = makeStore({ status: 'Stopped' })
        const w = wire(h)
        peer.copyScript.push('fail')
        await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        const op = theOp(h)
        expect(op.status).toBe('Pending')
        // a second move of it is refused before anything happens: the leftover folder on the
        // target is the parked op's, and only that op resumes into it
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
        expect(Object.keys(h.doc().operationDB)).toEqual([op.id])
        expect(peer.markers.get(INST)).toBe(op.id)
        // a push for another op into the marked folder is refused by the target (peer-resume-receive)
        await expect(w.copy(h, INST, SRC_DISK, TGT_DISK, 'console-command', 'other-op')).rejects.toThrow(/in flight for another operation/)
    })

    it('mixed fleet: a target without crossEngineResume (or advertised in an older boot) is refused TARGET_OUTDATED before anything is stopped or written', async () => {
        const h = makeStore({ status: 'Running', targetCaps: [MOVE_CROSS_ENGINE_CAPABILITY] })
        const w = wire(h)
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)).rejects.toMatchObject({ code: 'TARGET_OUTDATED' })
        expect(w.copy).not.toHaveBeenCalled()
        expect(h.doc().instanceDB[INST]?.status).toBe('Running')
        expect(Object.keys(h.doc().operationDB)).toHaveLength(0)
        expect(await crossResumeRefusal(h.doc(), String(TGT), 'copy')).toMatch(/^TARGET_OUTDATED: Engine idea04 cannot resume an interrupted copy/)
        // capabilities from an older boot do not count
        h.change(d => { (d.engineDB as any)[TGT].capabilities = [MOVE_CROSS_ENGINE_CAPABILITY, CROSS_ENGINE_RESUME_CAPABILITY]; (d.engineDB as any)[TGT].lastBooted = 5 })
        expect(engineCanResume(h.doc(), String(TGT))).toBe(false)
        h.change(d => { (d.engineDB as any)[TGT].capabilitiesBootedAt = 5 })
        expect(engineCanResume(h.doc(), String(TGT))).toBe(true)
        // and a source whose own helper is older than v23 refuses HELPER_OUTDATED
        await expect(moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', { ...w.deps, crossResumeHelperProblem: async () => 'needs helper v23' }))
            .rejects.toMatchObject({ code: 'HELPER_OUTDATED' })
    })

    it('the Engine advertises crossEngineResume only with helper v23', () => {
        expect(engineCapabilities(false, false, false, false, false)).not.toContain(CROSS_ENGINE_RESUME_CAPABILITY)
        expect(engineCapabilities(false, false, false, false, true)).toContain(CROSS_ENGINE_RESUME_CAPABILITY)
    })

    it('interruption vs real failure on the peer side; peerTargetReady needs a connected peer with the capability', () => {
        const h = makeStore()
        const s = () => h.doc()
        expect(peerInterruption(s(), TGT_DISK, String(TGT), REAL_ERR)).toBeNull()
        expect(peerInterruption(s(), TGT_DISK, String(TGT), LINK_ERR)).toMatch(/link to Engine .* failed/)
        for (const e of ['ssh exited with code 255', 'rsync stopped by SIGPIPE', 'Connection reset by peer', 'Broken pipe', 'exited with code 30 (timeout)', 'exited with code 35', 'exit code: 255', 'Error: exit code: 255']) {
            expect(isPeerLinkFailure(e), e).toBe(true)
        }
        expect(isPeerLinkFailure('exited with code 23: some files vanished')).toBe(false)
        expect(isPeerLinkFailure('VERIFY_FAILED: differs in 2 item(s)')).toBe(false)
        peer.up = false
        expect(peerInterruption(s(), TGT_DISK, String(TGT), REAL_ERR)).toMatch(/is not connected/)
        peer.up = true
        h.change(d => { (d.diskDB as any)[TGT_DISK].dockedTo = 'ENGINE_other' })
        expect(peerInterruption(s(), TGT_DISK, String(TGT), REAL_ERR)).toMatch(/no longer docked to Engine/)
        const op = { id: 'x', kind: 'moveApp', args: { crossEngine: 'true', targetDiskId: TGT_DISK } } as any
        expect(peerTargetReady(s(), op, TGT_DISK)).toBe(false)              // ENGINE_other has no capability
        h.change(d => { (d.diskDB as any)[TGT_DISK].dockedTo = TGT })
        expect(peerTargetReady(s(), op, TGT_DISK)).toBe(true)
        expect(peerTargetReady(s(), { ...op, args: { targetDiskId: TGT_DISK } }, TGT_DISK)).toBe(false) // not a cross op
        h.change(d => { (d.diskDB as any)[TGT_DISK].dockedTo = null })
        expect(peerInterruption(s(), TGT_DISK, String(TGT), REAL_ERR)).toMatch(/no longer docked$/)
    })

    it('engine#511 B2: a stale store address does not start a resume; ensure-dirs exit 255 re-parks RESUME_WAITING; it finishes when the target is really reachable', async () => {
        const h = makeStore({ status: 'Running' })
        const w = wire(h)
        await recoverInterruptedOperations(h, w.handlers)
        noteDiskDocked(h, SRC_DISK)
        peer.copyScript.push('link')
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        expect(r.code).toBe('RESUME_PARKED')
        const op = theOp(h)
        expect(op.status).toBe('Pending')
        expect(op.error).toMatch(/^RESUME_WAITING/)
        expect(op.args.resumeFailures).toBeUndefined()
        expect(peer.markers.get(INST)).toBe(op.id)
        expect(peer.folders.get(INST)).toBe('partial')
        // the target is cut, but the store still reports an address (getEngineAddress after SIGKILL)
        peer.up = false
        peerResumeProbe.address = (id: string) => (id === String(TGT)) ? TGT_ADDR : undefined
        peerResumeProbe.reachable = async (id: string) => id === String(TGT) && peer.up
        expect(peerTargetReady(h.doc(), op, TGT_DISK)).toBe(true)          // the stale gate would have said ready
        const t0 = Date.now()
        expect(await resumePeerParkedOps(h, t0)).toEqual([])               // due, but reachable is false
        expect(theOp(h).status).toBe('Pending')
        expect(theOp(h).error).toMatch(/^RESUME_WAITING/)
        expect(theOp(h).args.resumeFailures).toBeUndefined()
        expect(peer.markers.get(INST)).toBe(op.id)
        expect(peer.folders.get(INST)).toBe('partial')
        // the target is really back: a fresh reachable probe lets the same op finish
        peer.up = true
        expect(await resumePeerParkedOps(h, t0 + PEER_RESUME_RETRY_MS + 1)).toEqual([op.id])
        await until(() => theOp(h).status === 'Done', 'the resumed move to end Done after a real liveness probe')
        expect(Object.keys(h.doc().operationDB)).toEqual([op.id])
        expect(theOp(h).error).toBeNull()
        expect(theOp(h).move).toMatchObject({ phase: 'done', code: 'MOVED', verified: true, sourceRemoved: true })
        expect(peer.markers.size).toBe(0)
        expect(peer.folders.get(INST)).toBe('complete')
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
    })

    it('engine#511e: a failed liveness probe does not consume the peer change; a RESUME_PENDING op retries on its own once the target is really back, with no further store change', async () => {
        const h = makeStore({ status: 'Running' })
        const w = wire(h)
        await recoverInterruptedOperations(h, w.handlers)
        noteDiskDocked(h, SRC_DISK)
        peer.verifyScript.push('bad')
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        expect(r.code).toBe('RESUME_PARKED')
        const op = theOp(h)
        expect(op.error).toMatch(/^RESUME_PENDING \(1\/3\): VERIFY_SIZE: /)
        expect(op.args.resumeFailures).toBe('1')
        expect(peer.markers.get(INST)).toBe(op.id)
        // stale address (the store change below would have started a resume before the probe existed)
        peer.up = false
        peerResumeProbe.address = (id: string) => (id === String(TGT)) ? TGT_ADDR : undefined
        peerResumeProbe.reachable = async (id: string) => id === String(TGT) && peer.up
        expect(await resumePeerParkedOps(h)).toEqual([])                   // PENDING does not loop on the same peer key
        // the peer "boots" in the store (lastBooted changes) but TCP is not up yet
        h.change(d => { (d.engineDB as any)[TGT].lastBooted = 3; (d.engineDB as any)[TGT].capabilitiesBootedAt = 3 })
        const frozen = JSON.stringify({ lastBooted: (h.doc().engineDB as any)[TGT].lastBooted, lastDocked: (h.doc().diskDB as any)[TGT_DISK].lastDocked })
        const t0 = Date.now()
        expect(await resumePeerParkedOps(h, t0)).toEqual([])               // probe fails; must not consume changed
        expect(theOp(h).error).toMatch(/^RESUME_PENDING \(1\/3\): /)
        expect(theOp(h).args.resumeFailures).toBe('1')
        expect(await resumePeerParkedOps(h, t0 + PEER_PROBE_BACKOFF_MS[0] - 1)).toEqual([])
        // the target is really reachable; the store is untouched
        peer.up = true
        expect(JSON.stringify({ lastBooted: (h.doc().engineDB as any)[TGT].lastBooted, lastDocked: (h.doc().diskDB as any)[TGT_DISK].lastDocked })).toBe(frozen)
        expect(await resumePeerParkedOps(h, t0 + PEER_PROBE_BACKOFF_MS[0])).toEqual([op.id])
        await until(() => theOp(h).status === 'Done', 'the PENDING op to finish after a probe retry, with no further store change')
        expect(Object.keys(h.doc().operationDB)).toEqual([op.id])
        expect(theOp(h).error).toBeNull()
        expect(theOp(h).move).toMatchObject({ phase: 'done', code: 'MOVED', verified: true, sourceRemoved: true })
        expect(theOp(h).args.resumeFailures).toBe('1')                     // the counted failure is kept; this resume succeeded
        expect(peer.markers.size).toBe(0)
        expect(h.doc().instanceDB[INST]?.storedOn).toBe(TGT_DISK)
    })

    it('engine#511e: after the probe backoff is exhausted, a parked op waits for the next peer change (it does not retry on a timer)', async () => {
        const h = makeStore({ status: 'Running' })
        const w = wire(h)
        await recoverInterruptedOperations(h, w.handlers)
        noteDiskDocked(h, SRC_DISK)
        peer.copyScript.push('link')
        const r = await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        expect(r.code).toBe('RESUME_PARKED')
        const op = theOp(h)
        expect(op.error).toMatch(/^RESUME_WAITING/)
        peer.up = false
        peerResumeProbe.address = (id: string) => (id === String(TGT)) ? TGT_ADDR : undefined
        peerResumeProbe.reachable = async () => false
        const t0 = Date.now()
        expect(await resumePeerParkedOps(h, t0)).toEqual([])               // first WAITING try; probe fails
        let t = t0
        for (const delay of PEER_PROBE_BACKOFF_MS) {
            t += delay
            expect(await resumePeerParkedOps(h, t)).toEqual([])           // each backoff fires and fails
        }
        expect(await resumePeerParkedOps(h, t + PEER_RESUME_RETRY_MS + 1)).toEqual([])  // exhausted: no timer retry
        expect(theOp(h).error).toMatch(/^RESUME_WAITING/)
        // a later peer change gets a fresh schedule and starts once the probe passes
        peer.up = true
        peerResumeProbe.reachable = async (id: string) => id === String(TGT)
        h.change(d => { (d.engineDB as any)[TGT].lastBooted = 3; (d.engineDB as any)[TGT].capabilitiesBootedAt = 3 })
        expect(await resumePeerParkedOps(h, t + PEER_RESUME_RETRY_MS + 2)).toEqual([op.id])
        await until(() => theOp(h).status === 'Done', 'the op to finish after a new peer change following exhausted backoff')
        expect(theOp(h).move).toMatchObject({ phase: 'done', code: 'MOVED' })
    })

    it('a legacy cross move (no crossResume) is not resumable and keeps the old recovery (INTERRUPTED)', async () => {
        const h = makeStore()
        h.change(d => {
            (d.operationDB as any)['op-old'] = {
                id: 'op-old', kind: 'moveApp', args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true' },
                cause: 'console-command', subject: null, engineId: SRC, status: 'Running', progressPercent: 10, currentStep: 0, totalSteps: 3,
                stepLabel: 'Copying', startedAt: 0, completedAt: null, error: null,
                move: { phase: 'copying', targetEngineId: TGT, sourceInstanceId: INST, targetInstanceId: null, expectedBytes: null, expectRunning: false,
                    verify: null, verified: false, sourceRemoved: false, quarantinePath: null, code: null, resultText: null },
            }
        })
        expect(isResumableOp(h.doc().operationDB['op-old'] as any)).toBe(false)
        await recoverInterruptedOperations(h, {})
        expect((h.doc().operationDB['op-old'] as any).move.code).toBe('INTERRUPTED')
        expect(RETRY_MARKER).toBe('Retrying after interrupted run')
        expect(MOVE_FAILURE_CODES).toEqual(expect.arrayContaining(['RESUME_PARKED', 'RESUME_GAVE_UP']))
    })
})

// ── engine#511 Part B findings (two-Pi proof 2026-11-17) ─────────────────────
describe('engine#511 Finding 2: a cross-Engine move whose SOURCE is the system disk', () => {
    const savedSkip = config.settings.systemDiskSkip
    beforeEach(async () => {
        peer.up = true
        peer.markers.clear(); peer.folders.clear(); peer.pushes.length = 0
        peer.copyScript.length = 0; peer.verifyScript.length = 0
        startInstanceMock.mockClear()
        resetResumeStateForTests()
        resetEngineStoppingForTests()
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        await fs.ensureDir(`${disksRoot()}/${SRC_DEV}/instances`)
        peerResumeProbe.address = (id: string) => (id === String(TGT) && peer.up) ? TGT_ADDR : undefined
        peerResumeProbe.reachable = undefined
        peerInFlight.clear = async (_host, _e, _root, id, opId) => { if (peer.markers.get(id) === opId) peer.markers.delete(id) }
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(async () => {
        config.settings.systemDiskSkip = savedSkip
        vi.restoreAllMocks()
        resetPortReadyProgressForTests()
        resetEngineStoppingForTests()
        setRootDeviceForTests(null)
        await fs.remove(`${disksRoot()}/${SRC_DEV}`)
    })
    const systemSource = (h: DocHandle<Store>) => h.change(d => { (d.diskDB as any)[SRC_DISK].diskTypes = ['system'] })

    it('skippedSystemDiskHere: only this Engine\'s docked system disk, and only with systemDiskSkip', () => {
        const sys = { device: 'sda2', dockedTo: SRC, diskTypes: ['system'] }
        expect(skippedSystemDiskHere(sys, SRC as EngineID, true)).toBe(true)
        expect(skippedSystemDiskHere(sys, SRC as EngineID, false)).toBe(false)                         // kits: it docks like any disk
        expect(skippedSystemDiskHere({ ...sys, diskTypes: ['app'] }, SRC as EngineID, true)).toBe(false)
        expect(skippedSystemDiskHere({ ...sys, dockedTo: TGT }, SRC as EngineID, true)).toBe(false)       // another Engine's system disk
        expect(skippedSystemDiskHere({ ...sys, device: null }, SRC as EngineID, true)).toBe(false)
    })

    it('systemDiskSkip=true (M2 on idea03): source cut mid-push → after the reboot it does NOT wait for a dock that never comes; it resumes when the peer target is ready → Done/MOVED, same op and folder', async () => {
        config.settings.systemDiskSkip = true
        const h = makeStore({ status: 'Running' })
        systemSource(h)
        const w = wire(h)
        peer.copyScript.push('cut')
        await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        const op = theOp(h)
        expect(op.status).toBe('Running')
        // reboot; the peer is not connected yet (it re-dials after the boot)
        resetEngineStoppingForTests()
        resetResumeStateForTests()
        peer.up = false
        await recoverInterruptedOperations(h, w.handlers)
        expect(theOp(h).status).toBe('Pending')
        // waits only for the target, never for the skipped system disk
        expect(theOp(h).error).toMatch(/^RESUME_WAITING: resumes when 'tgt' \(disk-tgt\) has docked/)
        expect(theOp(h).error).not.toMatch(/'src'/)
        expect(resumeGate(h.doc(), theOp(h)).waitingFor).toEqual([TGT_DISK])
        // the peer reconnects: the peer watch resumes it, with no dock pass of the system disk
        peer.up = true
        expect(await resumePeerParkedOps(h)).toEqual([op.id])
        await until(() => theOp(h).status === 'Done', 'the resumed move to end Done')
        expect(Object.keys(h.doc().operationDB)).toEqual([op.id])
        expect(theOp(h).move).toMatchObject({ code: 'MOVED', verified: true })
        expect(peer.pushes.map(p => p.resumedInto)).toEqual([false, true])
        expect(peer.markers.size).toBe(0)
        expect(w.removeSource).toHaveBeenCalledTimes(1)
        expect(w.startSource).not.toHaveBeenCalled()
    })

    it('systemDiskSkip=true and the peer already connected at boot: it resumes from boot recovery at once', async () => {
        config.settings.systemDiskSkip = true
        const h = makeStore({ status: 'Running' })
        systemSource(h)
        const w = wire(h)
        peer.copyScript.push('cut')
        await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        const op = theOp(h)
        resetEngineStoppingForTests()
        resetResumeStateForTests()
        await recoverInterruptedOperations(h, w.handlers)
        await until(() => theOp(h).status === 'Done', 'the move resumed by boot recovery to end Done')
        expect(theOp(h).id).toBe(op.id)
        expect(theOp(h).move.code).toBe('MOVED')
        expect(w.copy).toHaveBeenCalledTimes(2)
    })

    it('systemDiskSkip=false (a kit): the system disk docks through processDisk like any disk, so the resume waits for its dock pass and then ends Done', async () => {
        config.settings.systemDiskSkip = false
        const h = makeStore({ status: 'Running' })
        systemSource(h)
        const w = wire(h)
        peer.copyScript.push('cut')
        await moveAppCrossEngine(h, INST as any, SRC_DISK, TGT_DISK, 'console-command', w.deps)
        const op = theOp(h)
        resetEngineStoppingForTests()
        resetResumeStateForTests()
        await recoverInterruptedOperations(h, w.handlers)
        expect(theOp(h).error).toMatch(/^RESUME_WAITING: resumes when 'src' \(disk-src\) has docked/)
        expect(await resumePeerParkedOps(h)).toEqual([])                         // the peer alone is not enough
        expect(noteDiskDocked(h, SRC_DISK)).toEqual([op.id])              // the system disk's dock pass
        await until(() => theOp(h).status === 'Done', 'the resumed move to end Done')
        expect(theOp(h).move.code).toBe('MOVED')
        expect(peer.pushes.map(p => p.resumedInto)).toEqual([false, true])
    })

    it('systemDiskSkip=true: boot marks the held-stopped source of a parked move Stopped, not Undocked (no dock pass follows); other instances keep the old rule', async () => {
        const h = makeStore({ status: 'Running' })
        systemSource(h)
        h.change(d => {
            (d.instanceDB as any)[INST].status = 'Stopped'
            ;(d.operationDB as any)['op-park'] = {
                id: 'op-park', kind: 'moveApp', engineId: SRC, status: 'Pending', error: 'RESUME_WAITING: resumes when …',
                args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true', crossResume: '1', phase: 'copying', wasRunning: '1' },
                move: { phase: 'copying', sourceInstanceId: INST },
            }
            ;(d.instanceDB as any)['inst-other'] = { ...JSON.parse(JSON.stringify((d.instanceDB as any)[INST])), id: 'inst-other', name: 'other', status: 'Stopped' }
            // the move's own stop of its source (not an operator stop), as on idea03 in M2; and one for the other instance
            for (const id of [INST, 'inst-other']) {
                (d.operationDB as any)[`stop-${id}`] = { id: `stop-${id}`, kind: 'stopApp', engineId: SRC, status: 'Done', error: null, cause: 'post-move', startedAt: 5, args: { instanceId: id } }
            }
        })
        await checkAndSetUndockedApps(h, SRC as EngineID, async () => false, { systemDiskSkip: true })
        expect(h.doc().instanceDB[INST]?.status).toBe('Stopped')
        expect((h.doc().instanceDB as any)['inst-other'].status).toBe('Undocked')
    })
})

describe('engine#511 Finding 4: stale queued verify / --op start of a finished move', () => {
    const doneOp = (h: DocHandle<Store>, status: 'Done' | 'Failed') => h.change(d => {
        (d.operationDB as any)['op-done'] = {
            id: 'op-done', kind: 'moveApp', engineId: SRC, status, error: null,
            args: { instanceId: INST, sourceDiskId: SRC_DISK, targetDiskId: TGT_DISK, crossEngine: 'true', crossResume: '1', phase: status === 'Done' ? 'done' : 'failed' },
            move: { phase: status === 'Done' ? 'done' : 'failed', code: status === 'Done' ? 'MOVED' : 'RESUME_GAVE_UP', verified: status === 'Done',
                verify: { ok: true, code: null, bytes: BYTES, detail: null, at: 1 } },
        }
    })
    afterEach(() => { resetPortReadyProgressForTests(); vi.restoreAllMocks() })

    it('moveOpFinished: Done / Failed / Cancelled only; an unknown op is not finished', () => {
        const h = makeStore()
        expect(moveOpFinished(h.doc(), 'nope')).toBeNull()
        doneOp(h, 'Done')
        expect(moveOpFinished(h.doc(), 'op-done')).toBe('Done')
        h.change(d => { (d.operationDB as any)['op-done'].status = 'Pending' })
        expect(moveOpFinished(h.doc(), 'op-done')).toBeNull()
    })

    it('the M1 replay: a verify that runs (or ends) after the op is Done never rewrites its move.verify (was VERIFY_NOT_RUNNING over a MOVED op)', async () => {
        const h = makeStore()
        doneOp(h, 'Done')
        const before = JSON.stringify((h.doc().operationDB as any)['op-done'].move)
        const v = await verifyMoveTarget(h, 'op-done', INST, String(BYTES), 'true', { localEngineId: async () => String(TGT), targetBytes: async () => BYTES, timeoutMs: 30, pollMs: 5 })
        expect(v).toMatchObject({ ok: false, code: 'VERIFY_NOT_RUNNING' })   // its own answer
        expect(JSON.stringify((h.doc().operationDB as any)['op-done'].move)).toBe(before)  // the store is untouched
        // a verify started while the op was live and answering after it ended: also untouched
        h.change(d => { (d.operationDB as any)['op-done'].status = 'Running' })
        const p = verifyMoveTarget(h, 'op-done', INST, String(BYTES), 'true', { localEngineId: async () => String(TGT), targetBytes: async () => BYTES, timeoutMs: 60, pollMs: 5 })
        h.change(d => { (d.operationDB as any)['op-done'].status = 'Failed' })
        await p
        expect(JSON.stringify((h.doc().operationDB as any)['op-done'].move)).toBe(before)
    })

    it('a boot-replayed `verifyMoveTarget` / `startInstance … --op` for a Done or Failed op does nothing (handleCommand on the target)', async () => {
        for (const status of ['Done', 'Failed'] as const) {
            startInstanceMock.mockClear()
            const h = makeStore()
            doneOp(h, status)
            const before = JSON.stringify((h.doc().operationDB as any)['op-done'].move)
            await handleCommand(commands, h, 'engine', `verifyMoveTarget op-done ${INST} ${BYTES} true`)
            await handleCommand(commands, h, 'engine', `startInstance ${INST} ${SRC_DISK} --cause cross-engine-cmd --op op-done`)
            expect(JSON.stringify((h.doc().operationDB as any)['op-done'].move), status).toBe(before)
            expect(startInstanceMock, status).not.toHaveBeenCalled()
        }
    })
})
