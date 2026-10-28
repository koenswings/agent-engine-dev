/**
 * update-app.test.ts — updateApp execution (agent-engine-dev#230): Check refusals before any
 * change, Snapshot/Swap/Start/Health, rollback, the stop race, progress shape, recovery.
 * Docker and the root helper are injected fakes; bundle and instance folders are real temp dirs.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { updateApp, UpdateDeps, UpdateProgress, waitContainersGone, aggregateHealth, parseUpdateAppArgs, recoverInterruptedUpdates, snapshotMarginBytes, refreshUpdateAvailable, sumsLookUsable } from '../../src/data/UpdateApp.js'
import { parseSnapshotResult, parseSnapshotsList } from '../../src/utils/appDataHelper.js'
import { createOperation, updateOperation } from '../../src/data/Operations.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import { commands } from '../../src/data/Commands.js'
import { isIdeaDiskPath } from '../../src/data/SummariseDisk.js'

const ME = String(localEngineId)
let h: DocHandle<Store>, tmp: string, calls: string[], msgs: UpdateProgress[]
let health: string[]

const compose = (version: string) => `services:\n  web:\n    image: x\nx-app:\n  name: kolibri\n  version: "${version}"\n  instanceName: Old\n`
const inst = () => h.doc().instanceDB['i1' as any] as any

const deps = (over: Partial<UpdateDeps> = {}): Partial<UpdateDeps> => {
    let gone = 0
    return {
        helperProblem: async () => null,
        mountRoot: async () => tmp,
        verifySums: async () => true,
        estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * 1024 ** 3 }),
        dirBytes: async () => 10,
        stop: async () => { calls.push('stop'); h.change(d => { (d.instanceDB['i1' as any] as any).status = 'Stopped' }) },
        containerIds: async () => { gone++; return [] },
        composeDown: async () => { calls.push('down') },
        snapshot: async () => { calls.push('snapshot'); return { path: `${tmp}/.pre-update/i1`, sizeBytes: 4096, previousQuarantinedAt: null, volumes: [] } },
        restoreSnapshot: async () => { calls.push('restore'); await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0')); return `${tmp}/.idea-quarantine/i1-before-restore-x` },
        listSnapshots: async () => ({ snapshots: [{ instanceId: 'i1' as any, sizeBytes: 4096, complete: true }], preUpdateBytes: 8192, quarantineBytes: 1024 }),
        reread: async () => {
            calls.push('reread')
            const v = (await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')).match(/version: "([^"]+)"/)![1]
            h.change(d => { (d.instanceDB['i1' as any] as any).instanceOf = `kolibri-${v}` })
        },
        start: async () => { calls.push('start'); h.change(d => { (d.instanceDB['i1' as any] as any).status = 'Running' }) },
        health: async () => ({ state: (health.shift() ?? 'healthy') as any, restartCount: 0 }),
        broadcast: (m) => { msgs.push(m) },
        now: () => Date.now(),
        sleep: async () => {},
        stopWaitMs: 1000, pollMs: 1,
        ...over,
    }
}
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }

beforeEach(async () => {
    calls = []; msgs = []; health = []
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-'))
    await fs.outputFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0'))
    await fs.outputFile(`${tmp}/instances/i1/.env`, 'port=50001\n')
    await fs.outputFile(`${tmp}/apps/kolibri-1.1/compose.yaml`, compose('1.1'))
    await fs.outputFile(`${tmp}/apps/kolibri-1.1/.env`, 'port=1\n')
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
        doc.instanceDB['i1' as any] = { id: 'i1', name: 'Old', storedOn: 'd1', instanceOf: 'kolibri-1.0', status: 'Running', port: 50001, lastBackup: null, statusCondition: null } as any
    })
})
afterEach(async () => { await fs.remove(tmp) })

describe('updateApp (#230)', () => {
    it('success: snapshot, swap (.env kept), start, health; result and disk info carry the snapshot path and size', async () => {
        health = ['starting', 'unhealthy', 'healthy']
        const r = await updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps())
        expect(r).toMatchObject({ instanceId: 'i1', fromAppId: 'kolibri-1.0', toAppId: 'kolibri-1.1', snapshotPath: `${tmp}/.pre-update/i1`, snapshotBytes: 4096 })
        expect(r.steps).toEqual(['Fetch', 'Check', 'Snapshot', 'Swap', 'Start', 'Health'])
        expect(calls).toEqual(['stop', 'snapshot', 'reread', 'start'])
        expect(inst().instanceOf).toBe('kolibri-1.1')
        expect(await fs.readFile(`${tmp}/instances/i1/.env`, 'utf8')).toBe('port=50001\n')
        expect(await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')).toMatch(/instanceName: Old/)
        expect(h.doc().diskDB['d1' as any].preUpdateSnapshots).toEqual([{ instanceId: 'i1', sizeBytes: 4096, complete: true }])
        expect(h.doc().diskDB['d1' as any].preUpdateBytes).toBe(8192)
        expect(h.doc().diskDB['d1' as any].quarantineBytes).toBe(1024)
        const op = Object.values(h.doc().operationDB).find(o => o.kind === 'updateApp')!
        expect(op.status).toBe('Done')
        expect(new Set(msgs.map(m => m.step))).toEqual(new Set(['Fetch', 'Check', 'Snapshot', 'Swap', 'Start', 'Health']))
        expect(Object.keys(msgs[0]).sort()).toEqual(['bytesDone', 'bytesTotal', 'engineId', 'instanceId', 'step', 'type'])
        expect(msgs[0].type).toBe('idea/updateProgress')
    })
    it('second update and volumes: result and op log carry the quarantined previous snapshot and per-volume export time', async () => {
        health = ['healthy']
        const r = await updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ snapshot: async () => ({ path: `${tmp}/.pre-update/i1`, sizeBytes: 4096, previousQuarantinedAt: `${tmp}/.idea-quarantine/pre-update-i1-x`, volumes: [{ name: 'i1_db', bytes: 2048, exportMs: 7 }] }) }))
        expect(r.previousSnapshotQuarantinedAt).toBe(`${tmp}/.idea-quarantine/pre-update-i1-x`)
        expect(r.volumes).toEqual([{ name: 'i1_db', bytes: 2048, exportMs: 7 }])
        expect(parseSnapshotResult('x\nVOLUME v_a 10 3\n/d/.pre-update/i 4 /d/.idea-quarantine/p').volumes).toEqual([{ name: 'v_a', bytes: 10, exportMs: 3 }])
        expect(parseSnapshotResult('/d/.pre-update/i 4 none').previousQuarantinedAt).toBeNull()
        expect(parseSnapshotsList('i 4 complete\nTOTAL pre-update 8\nTOTAL quarantine 2')).toEqual({ snapshots: [{ instanceId: 'i', sizeBytes: 4096, complete: true }], preUpdateBytes: 8192, quarantineBytes: 2048 })
    })
    it('dock-time updateAvailable: SHA256SUMS presence and version only, highest newer wins, null when none', async () => {
        const SUM = 'a'.repeat(64) + '  compose.yaml\n'
        const apps: Record<string, string | null> = { 'kolibri-1.1': SUM, 'kolibri-2.0': SUM, 'kolibri-3.0': null, 'kolibri-0.9': SUM, 'nextcloud-9.0': SUM }
        const read: string[] = []
        const deps = { mountRoot: async () => tmp, listApps: async () => Object.keys(apps), readSums: async (dir: string) => { read.push(path.basename(dir)); return apps[path.basename(dir)] } }
        expect(await refreshUpdateAvailable(h, ME, deps)).toBe(1)
        expect(inst().updateAvailable).toMatchObject({ appId: 'kolibri-2.0', sourceDiskId: 'd1', fromVersion: '1.0', toVersion: '2.0', major: true })
        expect(read.sort()).toEqual(Object.keys(apps).sort())   // only SHA256SUMS is read, nothing verified
        delete apps['kolibri-2.0']; delete apps['kolibri-1.1']
        await refreshUpdateAvailable(h, ME, deps)
        expect(inst().updateAvailable).toBeNull()
        expect(sumsLookUsable('')).toBe(false)
        expect(sumsLookUsable('b'.repeat(64) + '  other.txt')).toBe(false)
    })
    it('NO_SPACE before anything changes: "snapshot needs X, free Y", no stop, no snapshot', async () => {
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 5 }) })))
        expect(m).toMatch(new RegExp(`^NO_SPACE: not enough free space on d1 \\(snapshot needs ${1000 + snapshotMarginBytes(1000)}, free 5\\)`))
        expect(calls).toEqual([])
        expect(inst().status).toBe('Running')
        expect(Object.values(h.doc().operationDB)).toEqual([])
    })
    it('volume-driven NO_SPACE refuses before the stop: the estimate counts named volumes, nothing changes', async () => {
        const vol = 3 * 1024 ** 3
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ estimate: async () => ({ folderBytes: 1000, volumeBytes: vol, freeBytes: 2 * 1024 ** 3 }) })))
        expect(m).toMatch(new RegExp(`^NO_SPACE: .*snapshot needs ${1000 + vol + snapshotMarginBytes(1000 + vol)}, free ${2 * 1024 ** 3}`))
        expect(calls).toEqual([])
        expect(inst().status).toBe('Running')
        expect(Object.values(h.doc().operationDB).some(o => o.kind === 'updateApp')).toBe(false)
    })
    it('NO_SPACE from the helper: the old version is started again, nothing swapped', async () => {
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ snapshot: async () => { throw new Error('idea-app-data snapshot exited 3: NO_SPACE: snapshot needs 2000 bytes, free 10 bytes') } })))
        expect(m).toBe('NO_SPACE: snapshot needs 2000 bytes, free 10 bytes')
        expect(calls).toEqual(['stop', 'start'])
        expect(inst().instanceOf).toBe('kolibri-1.0')
    })
    it('refusals: NO_SUMS, HELPER_OUTDATED, NOT_FOUND, BUSY, NOT_NEWER, SOURCE_MISSING', async () => {
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ verifySums: async () => false })))).toMatch(/^NO_SUMS: /)
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ helperProblem: async () => 'updateApp needs the app-data root helper v5 or later' })))).toMatch(/^HELPER_OUTDATED: updateApp needs .* v5/)
        expect(await codeOf(updateApp(h, 'nope', 'kolibri-1.1', ME, {}, deps()))).toMatch(/^NOT_FOUND: /)
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-0.9', ME, {}, deps()))).toMatch(/^SOURCE_MISSING: /)
        await fs.outputFile(`${tmp}/apps/kolibri-0.9/compose.yaml`, compose('0.9'))
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-0.9', ME, {}, deps()))).toMatch(/^NOT_NEWER: /)
        resourceLock.acquire(instanceKey('i1'), 'backupApp')
        try { expect(await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps()))).toMatch(/^BUSY: /) } finally { resourceLock.release(instanceKey('i1')) }
        expect(calls).toEqual([])
    })
    it('health failure rolls back: compose down (no -v), restore-snapshot, old version started; "ROLLED BACK: <why>"', async () => {
        health = ['starting', 'exited']
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps()))
        expect(m).toMatch(/^ROLLED BACK: Health failed: health gate: the primary container exited\. kolibri-1\.0 and its data were restored from /)
        expect(calls).toEqual(['stop', 'snapshot', 'reread', 'start', 'down', 'restore', 'reread', 'start'])
        expect(inst().instanceOf).toBe('kolibri-1.0')
        expect(Object.values(h.doc().operationDB).find(o => o.kind === 'updateApp')!.status).toBe('Failed')
    })
    it('a failed rollback leaves the instance Stopped with "ROLLBACK FAILED:" and keeps the snapshot', async () => {
        health = ['exited']
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ restoreSnapshot: async () => { throw new Error('refused: disk gone') } })))
        expect(m).toMatch(/^ROLLBACK FAILED: Health failed: .* the rollback failed: refused: disk gone\. The snapshot is kept at /)
        expect(inst().status).toBe('Stopped')
        expect(inst().statusCondition).toMatch(/^ROLLBACK FAILED:/)
    })
    it('restart: unless-stopped race: waits until the containers are really gone before the snapshot', async () => {
        let n = 0
        const order: string[] = []
        const r = await updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({
            containerIds: async () => { order.push('ps'); return n++ < 2 ? ['c1'] : [] },
            snapshot: async () => { order.push('snapshot'); return { path: '/x', sizeBytes: 1, previousQuarantinedAt: null, volumes: [] } },
        }))
        expect(r.toAppId).toBe('kolibri-1.1')
        expect(order.slice(0, 4)).toEqual(['ps', 'ps', 'ps', 'snapshot'])
    })
    it('containers that keep coming back stop the update before the snapshot: nothing changed', async () => {
        let t = 0
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps({ containerIds: async () => ['c1'], now: () => (t += 400) })))
        expect(m).toMatch(/^ROLLED BACK: Snapshot failed: containers of i1 are still running .*; nothing was changed/)
        expect(calls).toEqual(['stop', 'start'])
        expect(inst().instanceOf).toBe('kolibri-1.0')
    })
    it('waitContainersGone fails after stopWaitMs', async () => {
        let t = 0
        await expect(waitContainersGone({ containerIds: async () => ['c'], now: () => (t += 600), sleep: async () => {}, stopWaitMs: 1000, pollMs: 1 }, 'i1' as any)).rejects.toThrow(/still running/)
    })
    it('power loss: an interrupted update after Swap with a complete snapshot is rolled back at startup', async () => {
        const opId = createOperation(h, 'updateApp', { instanceId: 'i1', diskId: 'd1', fromAppId: 'kolibri-1.0', toAppId: 'kolibri-1.1' }, 'console-command', { type: 'instance', id: 'i1' as any })
        updateOperation(h, opId, { status: 'Running', currentStep: 4, totalSteps: 6, stepLabel: 'Start' })
        await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.1'))
        const out = await recoverInterruptedUpdates(h, ME, deps())
        expect(out[0]).toMatch(/^i1: ROLLED BACK: /)
        expect(calls).toContain('restore')
        expect(inst().instanceOf).toBe('kolibri-1.0')
        expect(h.doc().operationDB[opId].status).toBe('Failed')
        expect(h.doc().operationDB[opId].error).toMatch(/^INTERRUPTED: ROLLED BACK:/)
    })
    it('power loss before the snapshot completed: old version untouched, no restore', async () => {
        const opId = createOperation(h, 'updateApp', { instanceId: 'i1', diskId: 'd1' }, 'console-command')
        updateOperation(h, opId, { status: 'Running', currentStep: 2, totalSteps: 6, stepLabel: 'Snapshot' })
        const out = await recoverInterruptedUpdates(h, ME, deps({ listSnapshots: async () => ({ snapshots: [{ instanceId: 'i1' as any, sizeBytes: 1, complete: false }], preUpdateBytes: 1, quarantineBytes: 0 }) }))
        expect(out[0]).toMatch(/old version untouched/)
        expect(calls).toEqual([])
    })
    it('wiring: command, capability, args, health aggregation, scans ignore .pre-update', () => {
        expect(commands.find(c => c.name === 'updateApp')).toBeTruthy()
        expect(ENGINE_CAPABILITIES).toContain('updateApp')
        expect(parseUpdateAppArgs('Kolibri kolibri-1.1 --allow-major --source d2')).toEqual({ instanceArg: 'Kolibri', newAppId: 'kolibri-1.1', opts: { allowMajor: true, sourceDiskId: 'd2' } })
        expect(() => parseUpdateAppArgs('one')).toThrow(/Usage: updateApp/)
        expect(aggregateHealth([{ status: 'running', health: 'healthy' }, { status: 'exited', exitCode: 0 }]).state).toBe('healthy')
        expect(aggregateHealth([{ status: 'running', health: 'unhealthy' }]).state).toBe('unhealthy')
        expect(aggregateHealth([{ status: 'exited', exitCode: 1 }]).state).toBe('exited')
        expect(isIdeaDiskPath('.pre-update/i1/data/x')).toBe(true)
    })
})
