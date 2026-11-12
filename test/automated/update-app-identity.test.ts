/**
 * update-app-identity.test.ts — updateApp keeps an instance's identity (idea#448).
 *
 * The snapshot leaves out the union of the live and the new compose's x-app.backup.exclude
 * (Steve Q5), rollback and power-loss recovery restore in place with the same list, and a
 * major update that needs a fresh backup takes it itself from the NEW compose: method hook
 * before anything stops (a failed preHook refuses, Q4), method stop inside the one Snapshot
 * stop (Q3). Docker, the helper and backupInstance are injected fakes.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { updateApp, UpdateDeps, recoverInterruptedUpdates, UPDATE_HELPER_MIN, readComposeBackup, linkedBackupDisk } from '../../src/data/UpdateApp.js'
import { snapshotArgs, restoreSnapshotArgs } from '../../src/utils/appDataHelper.js'
import { createOperation, updateOperation } from '../../src/data/Operations.js'

const ME = String(localEngineId)
const SHA = '69d40e913146ef5937fb89d8a4b4f64c217c9205'
const ID = 'usage-dashboard-8fhwrslsrq78xtswed4'
let h: DocHandle<Store>, tmp: string, calls: string[]
let backups: { composePath: string, instanceStopped: boolean, backupDiskId: string }[]
let snapEx: string[][], restoreEx: string[][]

const composeYaml = (version: string, backup?: Record<string, unknown>) => YAML.stringify({
    services: { web: { image: 'x' }, collector: { image: 'y' }, tailscale: { image: 'z' } },
    'x-app': { name: 'usage-dashboard', version, instanceName: 'Hub', ...(backup ? { backup } : {}) },
})
const hook = {
    method: 'hook', fallback: 'stop',
    preHook: { service: 'collector', command: '/app/scripts/backup-snapshot.sh' },
    exclude: ['keys', 'tailscale', 'tailscale-run'],
}
const inst = () => h.doc().instanceDB[ID as any] as any
const instDir = () => `${tmp}/instances/${ID}`
const newCompose = () => `${tmp}/apps/usage-dashboard-1.1/compose.yaml`

const deps = (over: Partial<UpdateDeps> = {}): Partial<UpdateDeps> => ({
    helperProblem: async () => null,
    mountRoot: async () => tmp,
    verifySums: async () => true,
    fetch: async () => { throw new Error('no fetch expected') },
    estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * 1024 ** 3 }),
    dirBytes: async () => 10,
    stop: async () => { calls.push('stop'); h.change(d => { (d.instanceDB[ID as any] as any).status = 'Stopped' }) },
    containerIds: async () => [],
    composeDown: async () => { calls.push('down') },
    snapshot: async (_d, _id, ex) => { calls.push('snapshot'); snapEx.push(ex); return { path: `${tmp}/.pre-update/${ID}`, sizeBytes: 4096, previousQuarantinedAt: null, volumes: [] } },
    restoreSnapshot: async (_d, _id, ex) => { calls.push('restore'); restoreEx.push(ex); await fs.writeFile(`${instDir()}/compose.yaml`, composeYaml(SHA, { exclude: ['keys', 'tailscale'] })); return `${tmp}/.idea-quarantine/${ID}-before-restore-x` },
    backup: async (_i, bd, o) => {
        calls.push(o.instanceStopped ? 'backup:in-stop' : 'backup:hook')
        backups.push({ composePath: o.composePath, instanceStopped: o.instanceStopped, backupDiskId: String(bd.id) })
        h.change(d => { (d.instanceDB[ID as any] as any).lastBackup = Date.now() })
    },
    listSnapshots: async () => ({ snapshots: [{ instanceId: ID as any, sizeBytes: 4096, complete: true }], preUpdateBytes: 4096, quarantineBytes: 0 }),
    reread: async () => {
        calls.push('reread')
        const v = YAML.parse(await fs.readFile(`${instDir()}/compose.yaml`, 'utf8'))['x-app'].version
        h.change(d => { (d.instanceDB[ID as any] as any).instanceOf = `usage-dashboard-${v}` })
    },
    start: async () => { calls.push('start'); h.change(d => { (d.instanceDB[ID as any] as any).status = 'Running' }) },
    health: async () => ({ state: 'healthy', restartCount: 0 }),
    broadcast: () => {},
    now: () => Date.now(),
    sleep: async () => {},
    stopWaitMs: 1000, pollMs: 1,
    ...over,
})
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }
const linkBackupDisk = () => h.change(doc => {
    doc.diskDB['bd1' as any] = { id: 'bd1', name: 'Disk B', device: 'idea-test-2', dockedTo: ME, diskTypes: ['backup'], backupConfig: { mode: 'on-demand', links: [ID] } } as any
})

beforeEach(async () => {
    calls = []; backups = []; snapEx = []; restoreEx = []
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-id-'))
    await fs.outputFile(`${instDir()}/compose.yaml`, composeYaml(SHA, { exclude: ['keys', 'tailscale'] }))
    await fs.outputFile(`${instDir()}/.env`, 'port=58546\n')
    await fs.outputFile(newCompose(), composeYaml('1.1', hook))
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['sys' as any] = { id: 'sys', name: 'System Disk', device: 'sda2', dockedTo: ME, diskTypes: ['system', 'app'] } as any
        doc.instanceDB[ID as any] = { id: ID, name: 'Hub', storedOn: 'sys', instanceOf: `usage-dashboard-${SHA}`, status: 'Running', port: 58546, lastBackup: null, statusCondition: null } as any
    })
})
afterEach(async () => { await fs.remove(tmp) })

describe('updateApp identity (idea#448)', () => {
    it('needs helper v9 (snapshot excludes and in-place restore)', () => {
        expect(UPDATE_HELPER_MIN).toBe(9)
    })

    it('helper argv: snapshot and restore-snapshot carry normalised, de-duplicated excludes; a bad one throws', () => {
        expect(snapshotArgs('system', ID, ['tailscale', 'data/tailscale', './data/keys/'])).toEqual(['snapshot', 'system', ID, 'data/tailscale', 'data/keys'])
        expect(restoreSnapshotArgs('sdb1', ID, ['keys'])).toEqual(['restore-snapshot', 'sdb1', ID, 'data/keys'])
        expect(snapshotArgs('sdb1', ID)).toEqual(['snapshot', 'sdb1', ID])
        expect(() => snapshotArgs('sdb1', ID, ['../etc'])).toThrow(/'\.' or '\.\.' component/)
        expect(() => restoreSnapshotArgs('sdb1', ID, ['-rf'])).toThrow(/looks like an option/)
    })

    it('SHA -> 1.1 without --allow-major is still MAJOR_NOT_ALLOWED; nothing happens', async () => {
        linkBackupDisk()
        expect(await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, {}, deps()))).toMatch(/^MAJOR_NOT_ALLOWED: /)
        expect(calls).toEqual([])
    })

    it('SHA -> 1.1 with --allow-major and no linked Backup Disk docked: NEEDS_BACKUP, nothing happens', async () => {
        expect(await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps()))).toMatch(/^NEEDS_BACKUP: Dock a Backup Disk linked to this instance/)
        expect(calls).toEqual([])
    })

    it('hook-capable new compose: the backup runs from the NEW compose before the stop, then one stop for the snapshot with the union excludes', async () => {
        linkBackupDisk()
        const r = await updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps())
        expect(calls).toEqual(['backup:hook', 'stop', 'snapshot', 'reread', 'start'])
        expect(backups).toEqual([{ composePath: newCompose(), instanceStopped: false, backupDiskId: 'bd1' }])
        // live [keys, tailscale] ∪ new [keys, tailscale, tailscale-run]
        expect(snapEx).toEqual([['data/keys', 'data/tailscale', 'data/tailscale-run']])
        expect(r.snapshotExcludes).toEqual(['data/keys', 'data/tailscale', 'data/tailscale-run'])
        expect(r.preUpdateBackup).toEqual({ backupDiskId: 'bd1', method: 'hook', duringStop: false })
        expect(inst().instanceOf).toBe('usage-dashboard-1.1')
        expect(inst().lastBackup).not.toBeNull()
    })

    it('stop-mode new compose: the backup is taken inside the single Snapshot stop (one stop, Steve Q3)', async () => {
        linkBackupDisk()
        await fs.writeFile(newCompose(), composeYaml('1.1', { exclude: ['keys', 'tailscale'] }))
        const r = await updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps())
        expect(calls).toEqual(['stop', 'backup:in-stop', 'snapshot', 'reread', 'start'])
        expect(calls.filter(c => c === 'stop')).toHaveLength(1)
        expect(r.preUpdateBackup).toEqual({ backupDiskId: 'bd1', method: 'stop', duringStop: true })
    })

    it('an instance that is not running takes the backup without a hook and without a stop', async () => {
        linkBackupDisk()
        h.change(d => { (d.instanceDB[ID as any] as any).status = 'Stopped' })
        await updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps())
        expect(calls).toEqual(['backup:in-stop', 'snapshot', 'reread', 'start'])
    })

    it('a failed preHook refuses HOOK_FAILED (fallback stop is treated as fail, Q4): no stop, no snapshot, no start', async () => {
        linkBackupDisk()
        const m = await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps({
            backup: async () => { calls.push('backup:hook'); throw new Error('HOOK_FAILED: preHook exited 2: db locked') },
        })))
        expect(m).toMatch(/^HOOK_FAILED: preHook exited 2: db locked; nothing was stopped or changed/)
        expect(calls).toEqual(['backup:hook'])
        expect(inst().status).toBe('Running')
        expect(inst().instanceOf).toBe(`usage-dashboard-${SHA}`)
        const op = Object.values(h.doc().operationDB).find(o => o.kind === 'updateApp')!
        expect(op.status).toBe('Failed')
    })

    it('a failed in-stop backup: BACKUP_FAILED, no snapshot, the old version is started again', async () => {
        linkBackupDisk()
        await fs.writeFile(newCompose(), composeYaml('1.1', {}))
        const m = await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps({
            backup: async () => { calls.push('backup:in-stop'); throw new Error('BACKUP_STALE_LOCK: left from an earlier backup') },
        })))
        expect(m).toMatch(/^BACKUP_FAILED: the pre-update backup to Disk B failed: BACKUP_STALE_LOCK/)
        expect(calls).toEqual(['stop', 'backup:in-stop', 'start'])
    })

    it('a minor update or a fresh backup takes no backup; the snapshot still leaves the excludes out', async () => {
        linkBackupDisk()
        h.change(d => { (d.instanceDB[ID as any] as any).lastBackup = Date.now() - 60_000 })
        await updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps())
        expect(calls).toEqual(['stop', 'snapshot', 'reread', 'start'])
        expect(backups).toEqual([])
        expect(snapEx[0]).toEqual(['data/keys', 'data/tailscale', 'data/tailscale-run'])
    })

    it('an invalid exclude in the new or the live compose refuses BAD_BACKUP_SPEC before anything changes', async () => {
        await fs.writeFile(newCompose(), composeYaml('1.1', { exclude: ['../etc'] }))
        expect(await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps({ helperProblem: async () => null }))))
            .toMatch(/^NEEDS_BACKUP/)   // NEEDS_BACKUP (no Backup Disk) comes first in the agreed order
        linkBackupDisk()
        expect(await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps()))).toMatch(/^BAD_BACKUP_SPEC: the new compose .* has an invalid x-app.backup/)
        await fs.writeFile(newCompose(), composeYaml('1.1', hook))
        await fs.writeFile(`${instDir()}/compose.yaml`, composeYaml(SHA, { exclude: ['/abs'] }))
        expect(await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps()))).toMatch(/^BAD_BACKUP_SPEC: the live compose/)
        expect(calls).toEqual([])
        expect(await readComposeBackup(`${tmp}/nope.yaml`, 'live')).toEqual({ exclude: [], method: 'stop' })
    })

    it('rollback after a failed health gate restores in place with the same union excludes', async () => {
        linkBackupDisk()
        const m = await codeOf(updateApp(h, ID, 'usage-dashboard-1.1', ME, { allowMajor: true }, deps({ health: async () => ({ state: 'exited', restartCount: 0 }) })))
        expect(m).toMatch(/^ROLLED BACK: Health failed/)
        expect(calls).toEqual(['backup:hook', 'stop', 'snapshot', 'reread', 'start', 'down', 'restore', 'reread', 'start'])
        expect(restoreEx).toEqual([['data/keys', 'data/tailscale', 'data/tailscale-run']])
        expect(inst().instanceOf).toBe(`usage-dashboard-${SHA}`)
    })

    it('power-loss recovery restores in place with the excludes of the compose now in the folder', async () => {
        await fs.writeFile(`${instDir()}/compose.yaml`, composeYaml('1.1', hook))   // swapped before the power loss
        const opId = createOperation(h, 'updateApp', { instanceId: ID, diskId: 'sys', fromAppId: `usage-dashboard-${SHA}`, toAppId: 'usage-dashboard-1.1' }, 'console-command', { type: 'instance', id: ID })
        updateOperation(h, opId, { status: 'Running', currentStep: 3 })
        const out = await recoverInterruptedUpdates(h, ME, deps())
        expect(out[0]).toMatch(/ROLLED BACK/)
        expect(restoreEx).toEqual([['data/keys', 'data/tailscale', 'data/tailscale-run']])
    })

    it('linkedBackupDisk: only a Backup Disk docked HERE and linked to the instance', () => {
        expect(linkedBackupDisk(h.doc(), ME, inst())).toBeNull()
        h.change(doc => { doc.diskDB['bd2' as any] = { id: 'bd2', name: 'other', device: 'sdc1', dockedTo: 'elsewhere', diskTypes: ['backup'], backupConfig: { mode: 'on-demand', links: [ID] } } as any })
        expect(linkedBackupDisk(h.doc(), ME, inst())).toBeNull()
        h.change(doc => { doc.diskDB['bd3' as any] = { id: 'bd3', name: 'unlinked', device: 'sdd1', dockedTo: ME, diskTypes: ['backup'], backupConfig: { mode: 'on-demand', links: ['other'] } } as any })
        expect(linkedBackupDisk(h.doc(), ME, inst())).toBeNull()
        linkBackupDisk()
        expect(String(linkedBackupDisk(h.doc(), ME, inst())!.id)).toBe('bd1')
    })
})
