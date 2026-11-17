/**
 * update-temp-backup.test.ts — engine#469 (Koen's decision on idea#374): a major updateApp with
 * no linked Backup Disk takes a temporary backup on the system disk. Trigger / no trigger, the
 * space refusal, the gate, delete after Health, kept on failure and used for the restore, and
 * boot recovery never deletes it. Docker and the root helper are injected fakes.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { updateApp, UpdateDeps, recoverInterruptedUpdates, tempBackupSpace, tempBackupFromOp, snapshotMarginBytes } from '../../src/data/UpdateApp.js'
import { checkUpdate } from '../../src/data/UpdateAppPolicy.js'
import { createOperation, updateOperation, recoverInterruptedOperations, dropInterruptedCommand } from '../../src/data/Operations.js'
import {
    TEMP_BACKUP_HELPER_MIN, APP_DATA_HELPER_VERSION, tempBackupCreateArgs, tempBackupDeleteArgs, tempBackupRestoreArgs, tempBackupEstimateArgs,
    tempBackupsArgs, parseTempBackupEstimate, parseTempBackupCreate, parseTempBackups, tempBackupPath,
} from '../../src/utils/appDataHelper.js'

const ME = String(localEngineId)
const GiB = 1024 ** 3
let h: DocHandle<Store>, tmp: string, calls: string[], created: { stamp: string, archive: string, excludes: string[] }[], deleted: string[]
let health: string[]

const compose = (version: string, extra = '') => `services:\n  web:\n    image: x\nx-app:\n  name: kolibri\n  version: "${version}"\n  instanceName: Old\n${extra}`
const inst = () => h.doc().instanceDB['i1' as any] as any
const op = () => Object.values(h.doc().operationDB).find(o => o.kind === 'updateApp')!

const deps = (over: Partial<UpdateDeps> = {}): Partial<UpdateDeps> => ({
    helperProblem: async () => null,
    mountRoot: async () => tmp,
    verifySums: async () => true,
    fetch: async () => { throw new Error('no fetch expected') },
    estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * GiB }),
    dirBytes: async () => 10,
    stop: async () => { calls.push('stop'); h.change(d => { (d.instanceDB['i1' as any] as any).status = 'Stopped' }) },
    containerIds: async () => [],
    composeDown: async () => { calls.push('down') },
    snapshot: async () => { calls.push('snapshot'); return { path: `${tmp}/.pre-update/i1`, sizeBytes: 4096, previousQuarantinedAt: null, volumes: [] } },
    restoreSnapshot: async () => { calls.push('restore'); await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0')); return `${tmp}/.idea-quarantine/i1-before-restore-x` },
    backup: async (_i, _bd, o) => { calls.push(o.instanceStopped ? 'backup:in-stop' : 'backup:hook') },
    listSnapshots: async () => ({ snapshots: [{ instanceId: 'i1' as any, sizeBytes: 4096, complete: true }], preUpdateBytes: 4096, quarantineBytes: 0 }),
    reread: async () => {
        calls.push('reread')
        const v = (await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')).match(/version: "([^"]+)"/)![1]
        h.change(d => { (d.instanceDB['i1' as any] as any).instanceOf = `kolibri-${v}` })
    },
    start: async () => { calls.push('start'); h.change(d => { (d.instanceDB['i1' as any] as any).status = 'Running' }) },
    health: async () => ({ state: (health.shift() ?? 'healthy') as any, restartCount: 0 }),
    probe: async () => ({ status: 200, body: 'ok' }),
    broadcast: () => {},
    now: () => Date.now(),
    sleep: async () => {},
    stopWaitMs: 1000, pollMs: 1,
    tempBackupProblem: async () => null,
    tempBackupEstimate: async () => ({ netBytes: 2 * GiB, freeBytes: 20 * GiB, sameFilesystem: false }),
    tempBackupCreate: async (_d, id, stamp, archive, excludes) => {
        calls.push('tempCreate'); created.push({ stamp, archive, excludes })
        return { path: `/.idea-temp-backups/${id}/${stamp}`, sizeBytes: 1234 * 1024 }
    },
    tempBackupDelete: async (id, stamp) => { calls.push('tempDelete'); deleted.push(`${id}/${stamp}`) },
    tempBackupRestore: async () => {
        calls.push('tempRestore'); await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0'))
        return `${tmp}/.idea-quarantine/i1-before-temp-restore-x`
    },
    ...over,
})
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }

beforeEach(async () => {
    calls = []; created = []; deleted = []; health = []
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-tmpbk-'))
    await fs.outputFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0', '  backup:\n    exclude: [keys]\n'))
    await fs.outputFile(`${tmp}/instances/i1/.env`, 'port=50001\n')
    for (const v of ['1.1', '2.0']) {
        await fs.outputFile(`${tmp}/apps/kolibri-${v}/compose.yaml`, compose(v))
        await fs.outputFile(`${tmp}/apps/kolibri-${v}/.env`, 'port=1\n')
    }
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
        doc.instanceDB['i1' as any] = { id: 'i1', name: 'Old', storedOn: 'd1', instanceOf: 'kolibri-1.0', status: 'Running', port: 50001, lastBackup: null, statusCondition: null } as any
    })
})
afterEach(async () => { await fs.remove(tmp) })

describe('engine#469 trigger', () => {
    it('major update, no linked Backup Disk: temporary backup inside the snapshot stop, gate satisfied, really deleted after Health', async () => {
        const r = await updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps())
        expect(calls).toEqual(['stop', 'tempCreate', 'snapshot', 'reread', 'start', 'tempDelete'])
        expect(created[0].excludes).toEqual(['data/keys'])   // the live compose's x-app.backup.exclude
        expect(created[0].archive).toMatch(/-stop$/)
        expect(deleted).toEqual([`i1/${created[0].stamp}`])
        expect(r.tempBackup).toEqual({ path: `/.idea-temp-backups/i1/${created[0].stamp}`, sizeBytes: 1234 * 1024, deleted: true })
        expect(r.preUpdateBackup).toBeNull()
        expect(inst().instanceOf).toBe('kolibri-2.0')
        expect(op().status).toBe('Done')
        expect(op().args).toMatchObject({ tempBackup: r.tempBackup!.path, tempBackupStamp: created[0].stamp, tempBackupState: 'deleted' })
        // this operation only: no standing "backed up" record, no backup operation or result
        expect(inst().lastBackup).toBeNull()
        expect(inst().lastResult ?? null).toBeNull()
        expect(Object.values(h.doc().operationDB).filter(o => o.kind === 'backupApp')).toEqual([])
    })
    it('a linked Backup Disk docked here: the normal pre-update backup, no temporary backup', async () => {
        h.change(doc => { doc.diskDB['bd1' as any] = { id: 'bd1', name: 'B', device: 'idea-test-2', dockedTo: ME, diskTypes: ['backup'], backupConfig: { mode: 'on-demand', links: ['i1'] } } as any })
        const r = await updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps())
        expect(calls).toEqual(['stop', 'backup:in-stop', 'snapshot', 'reread', 'start'])
        expect(r.tempBackup).toBeNull()
    })
    it('no backup due (minor update, a backup in the last hour, or method none): no temporary backup', async () => {
        await updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps())
        expect(calls).not.toContain('tempCreate')
        h.change(d => { (d.instanceDB['i1' as any] as any).instanceOf = 'kolibri-1.0'; (d.instanceDB['i1' as any] as any).lastBackup = Date.now() - 60_000 })
        await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0'))
        calls = []
        await updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps())
        expect(calls).not.toContain('tempCreate')
        h.change(d => { (d.instanceDB['i1' as any] as any).instanceOf = 'kolibri-1.0'; (d.instanceDB['i1' as any] as any).lastBackup = null })
        await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0', '  backup:\n    method: none\n'))
        calls = []
        await updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps())
        expect(calls).not.toContain('tempCreate')
    })
    it('--allow-major is still required; a malformed live x-app.backup refuses BAD_BACKUP_SPEC before anything changes', async () => {
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, {}, deps()))).toMatch(/^MAJOR_NOT_ALLOWED: /)
        await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0', '  backup:\n    method: rsync\n'))
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps()))).toMatch(/^BAD_BACKUP_SPEC: /)
        expect(calls).toEqual([])
    })
    it('gate: a planned backup (Backup Disk or temporary) satisfies NEEDS_BACKUP; none planned still refuses', () => {
        const f = { diskDocked: true, busy: false, currentAppId: 'kolibri-1.0', newAppId: 'kolibri-2.0', sourcePresent: true, sumsValid: true, allowMajor: true, backupAgeMs: null, shortDisks: [] }
        expect(checkUpdate(f)?.code).toBe('NEEDS_BACKUP')
        expect(checkUpdate({ ...f, backupPlanned: true })).toBeNull()
    })
})

describe('engine#469 refusals before anything stops', () => {
    it('TEMP_BACKUP_NO_SPACE: needs X, free Y; nothing stopped, no operation', async () => {
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({
            tempBackupEstimate: async () => ({ netBytes: 10 * GiB, freeBytes: 5 * GiB, sameFilesystem: false }),
        })))
        expect(m).toMatch(/^TEMP_BACKUP_NO_SPACE: the temporary pre-update backup on the system disk needs 11811160064 bytes \(11\.0 GiB: 10737418240 bytes of data \+ margin\), free 5368709120 bytes \(5\.0 GiB\)\. Free space on the system disk or dock a Backup Disk linked to this instance; nothing was stopped or changed$/)
        expect(calls).toEqual([])
        expect(Object.values(h.doc().operationDB)).toEqual([])
        expect(inst().status).toBe('Running')
    })
    it('same filesystem (App Disk is the system disk): the snapshot counts too', async () => {
        const snapNeed = 1000 + snapshotMarginBytes(1000)
        const own = 2 * GiB + snapshotMarginBytes(2 * GiB)
        const est = (free: number) => async () => ({ netBytes: 2 * GiB, freeBytes: free, sameFilesystem: true })
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({ tempBackupEstimate: est(own + snapNeed - 1) })))
        expect(m).toMatch(new RegExp(`^TEMP_BACKUP_NO_SPACE: .* plus ${snapNeed} bytes for the snapshot on the same disk`))
        expect(calls).toEqual([])
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({ tempBackupEstimate: est(own + snapNeed) })))).toBe('ok')
        expect(tempBackupSpace({ netBytes: 2 * GiB, freeBytes: own, sameFilesystem: false }, snapNeed)).toBeNull()
    })
    it('a helper below v18 or no borg refuses before anything stops', async () => {
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({ tempBackupProblem: async () => ({ code: 'HELPER_OUTDATED', text: 'needs helper v18.' }) }))))
            .toBe('HELPER_OUTDATED: needs helper v18. Dock a Backup Disk linked to this instance instead; nothing was stopped or changed')
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({ tempBackupProblem: async () => ({ code: 'TEMP_BACKUP_FAILED', text: '/usr/bin/borg is not installed.' }) }))))
            .toMatch(/^TEMP_BACKUP_FAILED: \/usr\/bin\/borg is not installed\./)
        expect(calls).toEqual([])
        expect(TEMP_BACKUP_HELPER_MIN).toBe(18)
        expect(APP_DATA_HELPER_VERSION).toBe('21')
    })
})

describe('engine#469 failures keep the temporary backup', () => {
    it("the helper's own space check at create: TEMP_BACKUP_NO_SPACE, the partial folder is removed, the old version restarted", async () => {
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({
            tempBackupCreate: async () => { calls.push('tempCreate'); throw new Error('idea-app-data temp-backup-create exited 3: TEMP_BACKUP_NO_SPACE: the temporary backup needs 9 bytes, free 1 bytes on the system disk') },
        })))
        expect(m).toBe('TEMP_BACKUP_NO_SPACE: the temporary backup needs 9 bytes, free 1 bytes on the system disk')
        expect(calls).toEqual(['stop', 'tempCreate', 'tempDelete', 'start'])
        expect(inst().status).toBe('Running')
        expect(op().status).toBe('Failed')
        expect(op().args.tempBackupState).toBeUndefined()
    })
    it('a failed borg run: TEMP_BACKUP_FAILED, nothing swapped', async () => {
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({
            tempBackupCreate: async () => { calls.push('tempCreate'); throw new Error('borg exited 2') },
        })))
        expect(m).toBe('TEMP_BACKUP_FAILED: the temporary pre-update backup on the system disk failed: borg exited 2')
        expect(calls).not.toContain('snapshot')
        expect(inst().instanceOf).toBe('kolibri-1.0')
    })
    it('a failure before Swap after the backup: kept, path in the error and the operation', async () => {
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({
            snapshot: async () => { calls.push('snapshot'); throw new Error('rsync exited 23') },
        })))
        expect(m).toMatch(/^ROLLED BACK: Snapshot failed: rsync exited 23; nothing was changed; the temporary pre-update backup is kept at \/\.idea-temp-backups\/i1\/\d{8}T\d+Z$/)
        expect(calls).not.toContain('tempDelete')
        expect(op().args.tempBackupState).toBe('kept')
        expect(op().error).toMatch(/temporary pre-update backup is kept at/)
    })
    it('Health fails: rolled back from the snapshot (first); the temporary backup is kept, not used', async () => {
        health = ['exited']
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps()))
        expect(m).toMatch(/^ROLLED BACK: Health failed: .* restored from .*\.pre-update\/i1; the temporary pre-update backup is kept at \/\.idea-temp-backups\/i1\//)
        expect(calls).toContain('restore')
        expect(calls).not.toContain('tempRestore')
        expect(calls).not.toContain('tempDelete')
        expect(inst().instanceOf).toBe('kolibri-1.0')
        expect(op().args.tempBackupState).toBe('kept')
    })
    it('the snapshot restore fails: the old version is restored from the temporary backup', async () => {
        health = ['exited']
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({
            restoreSnapshot: async () => { calls.push('restore'); throw new Error('rsync exited 12') },
        })))
        expect(m).toMatch(/^ROLLED BACK: Health failed: .* The snapshot rollback failed \(rsync exited 12\), so kolibri-1\.0 and its data were restored from the temporary pre-update backup \/\.idea-temp-backups\/i1\/\S+ \(the replaced folder is at .*i1-before-temp-restore-x\); the temporary pre-update backup is kept at /)
        expect(calls.slice(calls.indexOf('restore'))).toEqual(['restore', 'down', 'tempRestore', 'reread', 'start'])
        expect(inst().instanceOf).toBe('kolibri-1.0')
        expect(inst().status).toBe('Running')
    })
    it('both restores fail: ROLLBACK_FAILED names the snapshot and the temporary backup', async () => {
        health = ['exited']
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({
            restoreSnapshot: async () => { throw new Error('rsync exited 12') },
            tempBackupRestore: async () => { throw new Error('borg exited 2') },
        })))
        expect(m).toMatch(/^ROLLBACK FAILED: .*The snapshot is kept at .*; restoring from the temporary pre-update backup \/\.idea-temp-backups\/i1\/\S+ failed too: borg exited 2; the temporary pre-update backup is kept at /)
        expect(inst().status).toBe('Stopped')
    })
    it('the old version does not start after a good snapshot restore: no second restore from the temporary backup', async () => {
        health = ['exited']
        let starts = 0
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({
            start: async () => { starts++; h.change(d => { (d.instanceDB['i1' as any] as any).status = starts === 1 ? 'Running' : 'Error' }) },
        })))
        expect(m).toMatch(/^ROLLBACK FAILED: /)
        expect(calls).not.toContain('tempRestore')
    })
    it('the delete after Health fails: the update is still Done; the backup is reported as left', async () => {
        const r = await updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({ tempBackupDelete: async () => { throw new Error('rm exited 1') } }))
        expect(r.tempBackup?.deleted).toBe(false)
        expect(op().status).toBe('Done')
        expect(op().args.tempBackupState).toBe('delete-failed')
        expect(op().args.tempBackupWarning).toBe(`temporary backup ${r.tempBackup!.path} could not be removed: rm exited 1; free space by deleting it`)
    })
    it('a successful delete leaves no tempBackupWarning; the warning also goes to console.warn (the trace)', async () => {
        await updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps())
        expect(op().args.tempBackupWarning).toBeUndefined()
        const warns: string[] = []
        const orig = console.warn
        console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
        try {
            h.change(d => { (d.instanceDB['i1' as any] as any).instanceOf = 'kolibri-1.0'; (d.operationDB as any) = {} })
            await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0', '  backup:\n    exclude: [keys]\n'))
            await updateApp(h, 'i1', 'kolibri-2.0', ME, { allowMajor: true }, deps({ tempBackupDelete: async () => { throw new Error('rm exited 1') } }))
        } finally { console.warn = orig }
        expect(warns.some(w => /^updateApp: i1: temporary backup \/\.idea-temp-backups\/i1\/\S+ could not be removed: rm exited 1; free space by deleting it$/.test(w))).toBe(true)
    })
})

describe('engine#469 boot recovery never deletes it', () => {
    const interrupted = (step: number) => {
        const opId = createOperation(h, 'updateApp', { instanceId: 'i1', diskId: 'd1', fromAppId: 'kolibri-1.0', toAppId: 'kolibri-2.0', tempBackup: '/.idea-temp-backups/i1/20261116T080000Z', tempBackupStamp: '20261116T080000Z', tempBackupState: 'created' }, 'console-command', { type: 'instance', id: 'i1' as any })
        updateOperation(h, opId, { status: 'Running', currentStep: step, totalSteps: 6, stepLabel: 'x' })
        return opId
    }
    it('after Swap: rolled back from the snapshot, the temporary backup kept', async () => {
        const opId = interrupted(5)
        await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('2.0'))
        const out = await recoverInterruptedUpdates(h, ME, deps())
        expect(out[0]).toMatch(/^i1: ROLLED BACK: .*; the temporary pre-update backup is kept at \/\.idea-temp-backups\/i1\/20261116T080000Z$/)
        expect(calls).not.toContain('tempDelete')
        expect(h.doc().operationDB[opId].args.tempBackupState).toBe('kept')
    })
    it('after Swap with a failing snapshot restore: restored from the temporary backup', async () => {
        interrupted(4)
        await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('2.0'))
        const out = await recoverInterruptedUpdates(h, ME, deps({ restoreSnapshot: async () => { throw new Error('rsync exited 12') } }))
        expect(out[0]).toMatch(/restored from the temporary pre-update backup \/\.idea-temp-backups\/i1\/20261116T080000Z/)
        expect(calls).toContain('tempRestore')
        expect(calls).not.toContain('tempDelete')
    })
    it('before Swap: old version untouched, the temporary backup kept', async () => {
        const opId = interrupted(2)
        const out = await recoverInterruptedUpdates(h, ME, deps({ listSnapshots: async () => ({ snapshots: [], preUpdateBytes: 0, quarantineBytes: 0 }) }))
        expect(out[0]).toBe('i1: interrupted at Snapshot; old version untouched; the temporary pre-update backup is kept at /.idea-temp-backups/i1/20261116T080000Z')
        expect(calls).toEqual([])
        expect(h.doc().operationDB[opId].args.tempBackupState).toBe('kept')
    })
    it('tempBackupFromOp: none recorded, or already deleted', () => {
        expect(tempBackupFromOp({ args: {} })).toBeNull()
        expect(tempBackupFromOp({ args: { tempBackup: '/x', tempBackupStamp: '20261116T080000Z', tempBackupState: 'deleted' } })).toBeNull()
    })
})

describe('engine#469 Pi proof step 8: boot recovery names the restored version and never replays the update', () => {
    const interrupted = (step: number) => {
        const opId = createOperation(h, 'updateApp', { instanceId: 'i1', diskId: 'd1', fromAppId: 'kolibri-1.0', toAppId: 'kolibri-2.0', tempBackup: '/.idea-temp-backups/i1/20261116T080000Z', tempBackupStamp: '20261116T080000Z', tempBackupState: 'created' }, 'console-command', { type: 'instance', id: 'i1' as any })
        updateOperation(h, opId, { status: 'Running', currentStep: step, totalSteps: 6, stepLabel: 'x' })
        return opId
    }
    const queue = (cmds: string[]) => h.change(d => { (d.engineDB[ME as any] as any).commands = cmds })
    const queued = () => [...((h.doc().engineDB[ME as any] as any).commands ?? [])].map(String)
    // after Swap the Engine reread the new compose, so the store already says the new version
    const swapped = async () => { h.change(d => { (d.instanceDB['i1' as any] as any).instanceOf = 'kolibri-2.0' }); await fs.writeFile(`${tmp}/instances/i1/compose.yaml`, compose('2.0')) }
    it('the INTERRUPTED message names the pre-update version (fromAppId), not the new one', async () => {
        const opId = interrupted(5)
        await swapped()
        const out = await recoverInterruptedUpdates(h, ME, deps())
        expect(out[0]).toMatch(/kolibri-1\.0 and its data were restored from /)
        expect(out[0]).not.toMatch(/kolibri-2\.0 and its data/)
        expect(h.doc().operationDB[opId].error).toMatch(/^INTERRUPTED: ROLLED BACK: .*kolibri-1\.0 and its data were restored/)
        expect(inst().instanceOf).toBe('kolibri-1.0')
    })
    it('the same through the temporary-backup restore', async () => {
        interrupted(5)
        await swapped()
        const out = await recoverInterruptedUpdates(h, ME, deps({ restoreSnapshot: async () => { throw new Error('rsync exited 12') } }))
        expect(out[0]).toMatch(/so kolibri-1\.0 and its data were restored from the temporary pre-update backup/)
    })
    it('rolled back at boot: its queued command is removed (by name or id), a later identical one and other commands stay', async () => {
        const opId = interrupted(5)
        await swapped()
        queue(['updateApp Old kolibri-2.0 --allow-major', 'ls', 'updateApp i1 kolibri-2.0 --allow-major'])
        await recoverInterruptedUpdates(h, ME, deps())
        await recoverInterruptedOperations(h, {}, ME as any)
        expect(queued()).toEqual(['ls', 'updateApp i1 kolibri-2.0 --allow-major'])
        expect(h.doc().operationDB[opId].status).toBe('Failed')
        expect(h.doc().operationDB[opId].error).toMatch(/^INTERRUPTED: /)
    })
    it('interrupted before Swap: marked Failed by recoverInterruptedOperations, and its command removed too', async () => {
        const opId = interrupted(2)
        queue(['updateApp i1 kolibri-2.0 --allow-major'])
        await recoverInterruptedUpdates(h, ME, deps({ listSnapshots: async () => ({ snapshots: [], preUpdateBytes: 0, quarantineBytes: 0 }) }))
        expect(queued()).toEqual(['updateApp i1 kolibri-2.0 --allow-major'])   // not yet settled
        await recoverInterruptedOperations(h, {}, ME as any)
        expect(h.doc().operationDB[opId].status).toBe('Failed')
        expect(queued()).toEqual([])
    })
    it('an interrupted restoreApp is not replayed either; other kinds and other instances are left alone', async () => {
        const r = createOperation(h, 'restoreApp', { instanceId: 'i1', targetDiskId: 'd1' }, 'console-command', { type: 'instance', id: 'i1' as any })
        updateOperation(h, r, { status: 'Running' })
        queue(['restoreApp Old d1', 'restoreApp i2 d1', 'backupApp i1 b1'])
        await recoverInterruptedOperations(h, {}, ME as any)
        expect(h.doc().operationDB[r].status).toBe('Failed')
        expect(queued()).toEqual(['restoreApp i2 d1', 'backupApp i1 b1'])
        const cId = createOperation(h, 'copyApp', { instanceId: 'i1', sourceDiskId: 'd1', targetDiskId: 'd2' }, 'console-command')
        const c = h.doc().operationDB[cId]
        queue(['copyApp i1 d1 d2'])
        expect(dropInterruptedCommand(h, c as any)).toBeNull()
        expect(queued()).toEqual(['copyApp i1 d1 d2'])
    })
})

describe('engine#469 helper argv and parsers', () => {
    it('builds checked argv; refuses paths and option-looking tokens', () => {
        expect(tempBackupEstimateArgs('sda1', 'i1', ['keys', 'data/keys'])).toEqual(['temp-backup-estimate', 'sda1', 'i1', 'data/keys'])
        expect(tempBackupCreateArgs('system', 'i1', '20261116T080000Z', '2026-11-16T08-00-00-000Z-stop', ['keys'])).toEqual(['temp-backup-create', 'system', 'i1', '20261116T080000Z', '2026-11-16T08-00-00-000Z-stop', 'data/keys'])
        expect(tempBackupDeleteArgs('i1', '20261116T080000Z')).toEqual(['temp-backup-delete', 'i1', '20261116T080000Z'])
        expect(tempBackupRestoreArgs('sda1', 'i1', '20261116T080000Z')).toEqual(['temp-backup-restore', 'sda1', 'i1', '20261116T080000Z'])
        expect(tempBackupRestoreArgs('system', 'i1', '20261116T080000Z')).toEqual(['temp-backup-restore', 'system', 'i1', '20261116T080000Z'])
        expect(tempBackupsArgs()).toEqual(['temp-backups'])
        expect(() => tempBackupDeleteArgs('../x', '20261116T080000Z')).toThrow()
        expect(() => tempBackupDeleteArgs('i1', '../../etc')).toThrow()
        expect(() => tempBackupDeleteArgs('-rf', '20261116T080000Z')).toThrow()
        expect(() => tempBackupCreateArgs('/', 'i1', '20261116T080000Z', '2026-11-16T08-00-00-000Z-stop')).toThrow()
        expect(tempBackupPath('i1', '20261116T080000Z')).toBe('/.idea-temp-backups/i1/20261116T080000Z')
    })
    it('parses the helper output', () => {
        expect(parseTempBackupEstimate('exclude data/keys 4 KB\n100 2000 1\n')).toEqual({ netBytes: 100 * 1024, freeBytes: 2000 * 1024, sameFilesystem: true })
        expect(() => parseTempBackupEstimate('')).toThrow(/no result line/)
        expect(parseTempBackupCreate('/.idea-temp-backups/i1/20261116T080000Z 42\n')).toEqual({ path: '/.idea-temp-backups/i1/20261116T080000Z', sizeBytes: 42 * 1024 })
        expect(parseTempBackups('i1 20261116T080000Z 42 complete\ni2 20261116T090000Z 7 incomplete\nTOTAL 49\n')).toEqual({
            backups: [
                { instanceId: 'i1', stamp: '20261116T080000Z', sizeBytes: 42 * 1024, complete: true },
                { instanceId: 'i2', stamp: '20261116T090000Z', sizeBytes: 7 * 1024, complete: false },
            ],
            totalBytes: 49 * 1024,
        })
    })
})
