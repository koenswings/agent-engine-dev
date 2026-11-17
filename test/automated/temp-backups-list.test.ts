/**
 * temp-backups-list.test.ts — Engine.tempBackups and deleteTempBackup
 * (console#230 option A / idea#374 exception, Steve-approved).
 *
 * The list is a stored Engine field, refreshed after create, after delete, and at
 * boot. deleteTempBackup removes only a #469 temp backup under
 * /.idea-temp-backups/<instanceId>/<stamp>. Docker and the root helper are injected fakes.
 */
import { describe, it, beforeEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import {
    refreshTempBackups, deleteTempBackup, writeTempBackups, checkDeleteTempBackup,
    isTempBackupLocation, checkedTempBackupPath, TempBackupError, TempBackupPublic,
    DELETE_TEMP_BACKUP_USAGE,
} from '../../src/data/TempBackups.js'
import { commands } from '../../src/data/Commands.js'
import { TEMP_BACKUPS_DIR, tempBackupPath } from '../../src/utils/appDataHelper.js'

const ME = String(localEngineId)
const STAMP = '20261117T091530Z'
const OTHER = '20261116T120000Z'
const PATH = `${TEMP_BACKUPS_DIR}/i1/${STAMP}`
const SIZE = 1234 * 1024

const entry = (over: Partial<TempBackupPublic> = {}): TempBackupPublic => ({
    instanceId: 'i1', stamp: STAMP, path: PATH, sizeBytes: SIZE, complete: true, ...over,
})

let h: DocHandle<Store>
let listed: TempBackupPublic[]
let removed: string[]
let helperOk: boolean
let listFails: string | null
let removeFails: string | null

const deps = () => ({
    helperProblem: async () => helperOk ? null : 'needs the app-data root helper v18 or later',
    list: async () => {
        if (listFails) throw new Error(listFails)
        return listed.map(e => ({ ...e }))
    },
    remove: async (id: string, stamp: string) => {
        if (removeFails) throw new Error(removeFails)
        removed.push(`${id}/${stamp}`)
        listed = listed.filter(e => !(e.instanceId === id && e.stamp === stamp))
    },
})

const engineList = () => (h.doc().engineDB[ME as any] as any)?.tempBackups as TempBackupPublic[] | undefined

const codeOf = async (p: Promise<unknown>) => {
    try { await p; return 'ok' } catch (e) { return String((e as Error).message) }
}

beforeEach(async () => {
    listed = [entry()]
    removed = []
    helperOk = true
    listFails = null
    removeFails = null
    h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.instanceDB['i1' as any] = { id: 'i1', name: 'Old', storedOn: 'd1', instanceOf: 'kolibri-1.0', status: 'Running' } as any
    })
})

describe('Engine.tempBackups refresh', () => {
    it('writes the helper list onto the Engine, with path, size and complete', async () => {
        listed = [
            entry(),
            entry({ instanceId: 'i2', stamp: OTHER, path: `${TEMP_BACKUPS_DIR}/i2/${OTHER}`, sizeBytes: 2048, complete: false }),
        ]
        const got = await refreshTempBackups(h, deps())
        expect(got).toEqual(listed)
        expect(engineList()).toEqual(listed)
        expect(engineList()![0]).toEqual({ instanceId: 'i1', stamp: STAMP, path: PATH, sizeBytes: SIZE, complete: true })
        expect(engineList()![1].complete).toBe(false)
    })

    it('boot refresh writes an empty list when nothing is on the system disk', async () => {
        listed = []
        await refreshTempBackups(h, deps())
        expect(engineList()).toEqual([])
    })

    it('a failed list (helper too old or a throw) leaves the stored field alone', async () => {
        await refreshTempBackups(h, deps())
        expect(engineList()).toEqual([entry()])
        helperOk = false
        expect(await refreshTempBackups(h, deps())).toBeNull()
        expect(engineList()).toEqual([entry()])
        helperOk = true
        listFails = 'helper busy'
        expect(await refreshTempBackups(h, deps())).toBeNull()
        expect(engineList()).toEqual([entry()])
    })

    it('createOrUpdateEngine does not invent an empty tempBackups list', () => {
        expect(engineList()).toBeUndefined()
    })
})

describe('deleteTempBackup happy path', () => {
    it('removes the matching #469 backup, refreshes the list, and returns a structured result', async () => {
        listed = [entry(), entry({ instanceId: 'i1', stamp: OTHER, path: `${TEMP_BACKUPS_DIR}/i1/${OTHER}`, sizeBytes: 10, complete: true })]
        const r = await deleteTempBackup(h, 'i1', STAMP, deps())
        expect(r).toEqual({ instanceId: 'i1', stamp: STAMP, path: PATH, sizeBytes: SIZE, complete: true, deleted: true })
        expect(removed).toEqual([`i1/${STAMP}`])
        expect(engineList()).toEqual([
            { instanceId: 'i1', stamp: OTHER, path: `${TEMP_BACKUPS_DIR}/i1/${OTHER}`, sizeBytes: 10, complete: true },
        ])
    })

    it('can remove an incomplete leftover and a leftover whose instance record is gone', async () => {
        listed = [entry({ complete: false })]
        h.change(doc => { delete doc.instanceDB['i1' as any] })
        const r = await deleteTempBackup(h, 'i1', STAMP, deps())
        expect(r.complete).toBe(false)
        expect(r.deleted).toBe(true)
        expect(removed).toEqual([`i1/${STAMP}`])
        expect(engineList()).toEqual([])
    })
})

describe('deleteTempBackup refusals', () => {
    it('NOT_FOUND: unknown stamp, or a valid name that is not on the disk', async () => {
        expect(await codeOf(deleteTempBackup(h, 'i1', OTHER, deps()))).toMatch(/^NOT_FOUND: /)
        expect(removed).toEqual([])
        listed = []
        expect(await codeOf(deleteTempBackup(h, 'i1', STAMP, deps()))).toMatch(/^NOT_FOUND: /)
        expect(removed).toEqual([])
        expect(engineList()).toBeUndefined()
    })

    it('IN_USE: this backup is the one an in-flight updateApp created', async () => {
        h.change(doc => {
            doc.operationDB['op1'] = {
                id: 'op1', kind: 'updateApp', engineId: ME, status: 'Running',
                args: { instanceId: 'i1', tempBackupStamp: STAMP, tempBackup: PATH },
            } as any
        })
        expect(await codeOf(deleteTempBackup(h, 'i1', STAMP, deps()))).toMatch(/^IN_USE: /)
        expect(removed).toEqual([])
    })

    it('UPDATE_PENDING: the instance has updatePending, or a Pending/Running updateApp', async () => {
        h.change(doc => {
            doc.operationDB['op2'] = {
                id: 'op2', kind: 'updateApp', engineId: ME, status: 'Pending',
                args: { instanceId: 'i1' },
            } as any
        })
        expect(await codeOf(deleteTempBackup(h, 'i1', STAMP, deps()))).toMatch(/^UPDATE_PENDING: /)
        expect(removed).toEqual([])
        h.change(doc => { delete doc.operationDB['op2'] })
        h.change(doc => { (doc.instanceDB['i1' as any] as any).updatePending = true })
        expect(await codeOf(deleteTempBackup(h, 'i1', STAMP, deps()))).toMatch(/^UPDATE_PENDING: /)
        expect(removed).toEqual([])
    })

    it('a finished updateApp of the same instance does not refuse', async () => {
        h.change(doc => {
            doc.operationDB['op3'] = {
                id: 'op3', kind: 'updateApp', engineId: ME, status: 'Failed',
                args: { instanceId: 'i1', tempBackupStamp: STAMP, tempBackupState: 'kept' },
            } as any
        })
        const r = await deleteTempBackup(h, 'i1', STAMP, deps())
        expect(r.deleted).toBe(true)
        expect(removed).toEqual([`i1/${STAMP}`])
    })

    it('BAD_PATH: tokens that would leave the temp-backup root, or a listed path outside it', async () => {
        expect(await codeOf(deleteTempBackup(h, 'i1', '20261117T091530Z/../../etc', deps()))).toMatch(/^BAD_PATH: /)
        expect(await codeOf(deleteTempBackup(h, '../etc', STAMP, deps()))).toMatch(/^BAD_PATH: /)
        expect(await codeOf(deleteTempBackup(h, 'i1', 'not-a-stamp', deps()))).toMatch(/^BAD_PATH: /)
        expect(removed).toEqual([])
        listed = [entry({ path: '/etc/passwd' })]
        expect(await codeOf(deleteTempBackup(h, 'i1', STAMP, deps()))).toMatch(/^BAD_PATH: /)
        expect(removed).toEqual([])
    })

    it('HELPER_OUTDATED and DELETE_FAILED do not remove anything', async () => {
        helperOk = false
        expect(await codeOf(deleteTempBackup(h, 'i1', STAMP, deps()))).toMatch(/^HELPER_OUTDATED: /)
        expect(removed).toEqual([])
        helperOk = true
        removeFails = 'busy'
        expect(await codeOf(deleteTempBackup(h, 'i1', STAMP, deps()))).toMatch(/^DELETE_FAILED: /)
        expect(removed).toEqual([])
        // the failed delete still refreshed from the (unchanged) list
        expect(engineList()).toEqual([entry()])
    })
})

describe('path and registry', () => {
    it('isTempBackupLocation / checkedTempBackupPath only accept the #469 folder', () => {
        expect(isTempBackupLocation('i1', STAMP, PATH)).toBe(true)
        expect(isTempBackupLocation('i1', STAMP, '/etc/passwd')).toBe(false)
        expect(isTempBackupLocation('i1', STAMP, `${TEMP_BACKUPS_DIR}/i1/../i1/${STAMP}`)).toBe(false)
        expect(checkedTempBackupPath('i1', STAMP)).toBe(PATH)
        expect(() => checkedTempBackupPath('i1', 'nope')).toThrow(TempBackupError)
        expect(tempBackupPath('i1', STAMP)).toBe(PATH)
    })

    it('the command is registered as deleteTempBackup <instanceId> <stamp>', () => {
        const def = commands.find(c => c.name === 'deleteTempBackup')
        expect(def).toBeDefined()
        expect(def!.scope).toBe('engine')
        expect(def!.args.map(a => a.name)).toEqual(['instanceId', 'stamp'])
        expect(DELETE_TEMP_BACKUP_USAGE).toBe('Usage: deleteTempBackup <instanceId> <stamp>')
    })

    it('checkDeleteTempBackup is a pure refusal (nothing is deleted)', () => {
        const store = h.doc()
        const miss = checkDeleteTempBackup(store, 'i1', OTHER, [entry()])
        expect(miss.ok).toBe(false)
        if (!miss.ok) expect(miss.error.code).toBe('NOT_FOUND')
        const ok = checkDeleteTempBackup(store, 'i1', STAMP, [entry()])
        expect(ok.ok).toBe(true)
    })

    it('writeTempBackups replaces the whole list and is a no-op when unchanged', async () => {
        writeTempBackups(h, [entry()])
        expect(engineList()).toEqual([entry()])
        writeTempBackups(h, [entry()])
        writeTempBackups(h, [])
        expect(engineList()).toEqual([])
    })
})
