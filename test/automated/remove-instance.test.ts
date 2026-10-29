/**
 * remove-instance.test.ts — removeInstance (idea#347, option A): compose down without -v,
 * quarantine under the instance lock, then drop the record; refusals leave the store untouched.
 */
import { describe, it, beforeEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { removeInstance, RemoveDeps } from '../../src/data/RemoveInstance.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import { commands } from '../../src/data/Commands.js'
import { quarantineArgs, helperAtLeast } from '../../src/utils/appDataHelper.js'
import { isIdeaDiskPath } from '../../src/data/SummariseDisk.js'

const ME = String(localEngineId)
let h: DocHandle<Store>
let calls: string[]

const deps = (over: Partial<RemoveDeps> = {}): Partial<RemoveDeps> => ({
    helperProblem: async () => null,
    instanceDir: async (_d, id) => `/fake/instances/${id}`,
    composeDown: async (dir) => { calls.push(`down ${dir}`) },
    listVolumes: async (id) => [`${id}_data`],
    quarantine: async (_d, id) => { calls.push(`quarantine ${id}`); return `/fake/.idea-quarantine/${id}-20261028T130000Z` },
    ...over,
})
const add = (id: string, name: string, disk: string, status = 'Stopped') => h.change(doc => {
    doc.instanceDB[id as any] = { id, name, storedOn: disk, instanceOf: 'kolibri-1.0', status, port: 50001 } as any
})
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message).split(':')[0] } }

beforeEach(async () => {
    calls = []
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
        doc.diskDB['far' as any] = { id: 'far', name: 'far', device: 'idea-test-2', dockedTo: 'other-engine', diskTypes: ['app'] } as any
    })
})

describe('removeInstance', () => {
    it('downs without -v, quarantines, then drops the record; result has path and kept volumes', async () => {
        add('i1', 'kolibri', 'd1')
        const r = await removeInstance(h, 'i1', ME, deps())
        expect(calls).toEqual(['down /fake/instances/i1', 'quarantine i1'])
        expect(r).toEqual({ instanceId: 'i1', name: 'kolibri', quarantinePath: '/fake/.idea-quarantine/i1-20261028T130000Z', keptVolumes: ['i1_data'] })
        expect(h.doc().instanceDB['i1' as any]).toBeUndefined()
    })
    it('the real compose down never passes -v', async () => {
        const src = await fs.readFile(path.join(process.cwd(), 'src/data/RemoveInstance.ts'), 'utf8')
        expect(src).toMatch(/docker compose -p \$\{id\} down`/)
        expect(src).not.toMatch(/down -v|--volumes/)
    })
    it('refusals: NOT_FOUND, NOT_LOCAL, AMBIGUOUS, RUNNING', async () => {
        add('far1', 'x', 'far'); add('a', 'dup', 'd1'); add('b', 'dup', 'd1'); add('run', 'r', 'd1', 'Running')
        expect(await codeOf(removeInstance(h, 'nope', ME, deps()))).toBe('NOT_FOUND')
        expect(await codeOf(removeInstance(h, 'far1', ME, deps()))).toBe('NOT_LOCAL')
        expect(await codeOf(removeInstance(h, 'dup', ME, deps()))).toBe('AMBIGUOUS')
        expect(await codeOf(removeInstance(h, 'run', ME, deps()))).toBe('RUNNING')
        expect(calls).toEqual([])
    })
    it('BUSY_BACKUP, BUSY_MOVE, BUSY by the lock holder', async () => {
        add('i1', 'k', 'd1')
        for (const [kind, code] of [['backupApp', 'BUSY_BACKUP'], ['restoreApp', 'BUSY_BACKUP'], ['moveApp', 'BUSY_MOVE'], ['copyApp', 'BUSY_MOVE'], ['renameInstance', 'BUSY']]) {
            resourceLock.acquire(instanceKey('i1'), kind)
            try { expect(await codeOf(removeInstance(h, 'i1', ME, deps()))).toBe(code) } finally { resourceLock.release(instanceKey('i1')) }
        }
        expect(h.doc().instanceDB['i1' as any]).toBeDefined()
    })
    it('COMPOSE_DOWN_FAILED and QUARANTINE_FAILED leave the store untouched and release the lock', async () => {
        add('i1', 'k', 'd1')
        expect(await codeOf(removeInstance(h, 'i1', ME, deps({ composeDown: async () => { throw new Error('boom') } })))).toBe('COMPOSE_DOWN_FAILED')
        expect(await codeOf(removeInstance(h, 'i1', ME, deps({ quarantine: async () => { throw new Error('refused: x') } })))).toBe('QUARANTINE_FAILED')
        expect(h.doc().instanceDB['i1' as any]).toBeDefined()
        expect(resourceLock.getLockInfo(instanceKey('i1'))).toBeFalsy()
    })
    it('is wired as a command with the removeInstance capability and helper args', () => {
        expect(commands.find(c => c.name === 'removeInstance')?.args.map(a => a.name)).toEqual(['instanceId'])
        expect(ENGINE_CAPABILITIES).toContain('removeInstance')
        expect(quarantineArgs('sdb1', 'i1')).toEqual(['quarantine', 'sdb1', 'i1'])
    })
    it('disk scans ignore <disk>/.idea-quarantine: summariseDisk counts it as IDEA data, and app/instance listing only reads apps/ and instances/', async () => {
        expect(isIdeaDiskPath('.idea-quarantine')).toBe(true)
        expect(isIdeaDiskPath('.idea-quarantine/i1-20261028T130000Z/data.db')).toBe(true)
        expect(isIdeaDiskPath('photos/a.jpg')).toBe(false)
        const disk = await fs.readFile(path.join(process.cwd(), 'src/data/Disk.ts'), 'utf8')
        expect(disk).toMatch(/ls \$\{mountRoot\}\/apps/)
        expect(disk).toMatch(/ls \$\{mountRoot\}\/instances/)
        expect(disk).not.toMatch(/idea-quarantine/)
    })
    it('HELPER_OUTDATED against a helper older than v4; nothing changes', async () => {
        add('i1', 'k', 'd1')
        const fakeRun = async () => 'idea-app-data 3'
        const problem = await helperAtLeast(4, 'removeInstance', fakeRun)
        expect(problem).toMatch(/removeInstance needs the app-data root helper .* v4 or later, but the installed one reports 'idea-app-data 3'/)
        expect(await helperAtLeast(4, 'removeInstance', async () => 'idea-app-data 5')).toBeNull()
        expect(await codeOf(removeInstance(h, 'i1', ME, deps({ helperProblem: async () => problem })))).toBe('HELPER_OUTDATED')
        expect(calls).toEqual([])
        expect(h.doc().instanceDB['i1' as any]).toBeDefined()
    })
})
