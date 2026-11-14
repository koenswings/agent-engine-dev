/**
 * instance-backup-method.test.ts — idea#403: Instance.backupMethod mirrors x-app.backup.method
 * ('stop' default when absent; unset when x-app.backup is invalid; optional for old records).
 */
import { describe, it, expect } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { applyBackupMethod, backupMethodFromCompose, Instance } from '../../src/data/Instance.js'
import { upsertSystemInstanceRecord } from '../../src/data/Disk.js'
import { defaultBackupSpec } from '../../src/utils/backupMethod.js'

const compose = (backup?: string) => ({
    services: { web: { image: 'x' } },
    'x-app': { name: 'kolibri', version: '1.0', instanceName: 'K', ...(backup === undefined ? {} : { backup: JSON.parse(backup) }) },
})

describe('backupMethodFromCompose (idea#403)', () => {
    it('declared method, the backup code default when absent, undefined when invalid', () => {
        expect(backupMethodFromCompose(compose('{"method":"hook","preHook":{"service":"web","command":["true"]}}'))).toBe('hook')
        expect(backupMethodFromCompose(compose('{"method":"none"}'))).toBe('none')
        expect(backupMethodFromCompose(compose('{"method":"stop"}'))).toBe('stop')
        expect(backupMethodFromCompose(compose())).toBe(defaultBackupSpec().method)
        expect(backupMethodFromCompose(compose('{}'))).toBe('stop')
        expect(backupMethodFromCompose(compose('{"method":"rsync"}'))).toBeUndefined()
        expect(backupMethodFromCompose(undefined)).toBe('stop')
    })
    it('applyBackupMethod sets, updates and removes the field', () => {
        const i = {} as Instance
        applyBackupMethod(i, compose('{"method":"none"}'))
        expect(i.backupMethod).toBe('none')
        applyBackupMethod(i, compose())
        expect(i.backupMethod).toBe('stop')
        applyBackupMethod(i, compose('{"method":"rsync"}'))
        expect('backupMethod' in i).toBe(false)
    })
})

describe('store records carry backupMethod (idea#403)', () => {
    const store = async (): Promise<DocHandle<Store>> => {
        const h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await h.whenReady()
        return h
    }
    it('a new and a refreshed (system) instance record get the compose method; an old record without it stays valid', async () => {
        const h = await store()
        const disk = { id: 'sys', name: 'sys' } as any
        upsertSystemInstanceRecord(h, disk, 'i1' as any, compose('{"method":"none"}'))
        expect((h.doc().instanceDB['i1' as any] as Instance).backupMethod).toBe('none')
        upsertSystemInstanceRecord(h, disk, 'i1' as any, compose())
        expect((h.doc().instanceDB['i1' as any] as Instance).backupMethod).toBe('stop')
        h.change(d => { delete (d.instanceDB['i1' as any] as any).backupMethod })
        expect((h.doc().instanceDB['i1' as any] as Instance).backupMethod).toBeUndefined()
        upsertSystemInstanceRecord(h, disk, 'i1' as any, compose('{"method":"hook","preHook":{"service":"web","command":["true"]}}'))
        expect((h.doc().instanceDB['i1' as any] as Instance).backupMethod).toBe('hook')
    })
})
