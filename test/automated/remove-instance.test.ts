/**
 * remove-instance.test.ts — removeInstance (idea#347, option A): compose down without -v,
 * then quarantine under the instance lock, then drop the record; refusals leave the
 * store untouched. idea#424: down uses the live instance path (diskPath) and a
 * compose-project label fallback; it never globs /.idea-quarantine (root:root 0700).
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import os from 'node:os'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import {
    removeInstance, RemoveDeps, defaultInstanceDir, composeDownAt,
    removeContainersByComposeProject,
} from '../../src/data/RemoveInstance.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import { commands } from '../../src/data/Commands.js'
import { quarantineArgs, helperAtLeast } from '../../src/utils/appDataHelper.js'
import { isIdeaDiskPath } from '../../src/data/SummariseDisk.js'
import { Disk, setRootDeviceForTests } from '../../src/data/Disk.js'
import { disksRoot } from '../../src/data/Config.js'

const ME = String(localEngineId)
let h: DocHandle<Store>
let calls: string[]

const deps = (over: Partial<RemoveDeps> = {}): Partial<RemoveDeps> => ({
    helperProblem: async () => null,
    instanceDir: async (_d, id) => `/fake/instances/${id}`,
    composeDown: async (dir) => { calls.push(`down ${dir}`) },
    removeProjectContainers: async (id) => { calls.push(`rm-project ${id}`) },
    listVolumes: async (id) => [`${id}_data`],
    quarantine: async (_d, id) => { calls.push(`quarantine ${id}`); return `/fake/.idea-quarantine/${id}-20261028T130000Z` },
    refreshSnapshots: async () => { calls.push('refresh') },
    pruneNetworks: async (id) => { calls.push(`prune ${id}`) },
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
    it('downs without -v, cleans leftover project containers, quarantines, then drops the record', async () => {
        add('i1', 'kolibri', 'd1')
        const r = await removeInstance(h, 'i1', ME, deps())
        expect(calls).toEqual(['down /fake/instances/i1', 'rm-project i1', 'quarantine i1', 'refresh', 'prune i1'])
        expect(r).toEqual({ instanceId: 'i1', name: 'kolibri', quarantinePath: '/fake/.idea-quarantine/i1-20261028T130000Z', keptVolumes: ['i1_data'] })
        expect(h.doc().instanceDB['i1' as any]).toBeUndefined()
    })
    it('the real compose down uses -p and -f on the live file, never -v, and never globs the quarantine dir', async () => {
        const src = await fs.readFile(path.join(process.cwd(), 'src/data/RemoveInstance.ts'), 'utf8')
        const helper = await fs.readFile(path.join(process.cwd(), 'src/utils/instanceNetworks.ts'), 'utf8')
        expect(helper).toMatch(/'compose', '-p', String\(id\), '-f', composeFile, 'down'/)
        expect(helper).not.toMatch(/'down', '-v'|--volumes/)
        expect(src).toMatch(/pruneUnusedInstanceNetworks/)
        expect(src).toMatch(/diskPath\(disk, 'instances', String\(id\)\)/)
        expect(src).toMatch(/label=com\.docker\.compose\.project=\$\{id\}/)
        expect(src).toMatch(/'rm', '-f', cid/)
        expect(src).not.toMatch(/down -v|--volumes/)
        expect(src).not.toMatch(/'rm', '-f', '-v'/)
        expect(src).not.toMatch(/path\.join\(await diskMountRoot/)
        expect(src).not.toMatch(/idea-quarantine\/\$\{/)
        expect(src).not.toMatch(/idea-quarantine\/[^'"\n]*\*/)
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
    it('COMPOSE_DOWN_FAILED does not quarantine and leaves the store and lock untouched', async () => {
        add('i1', 'k', 'd1')
        expect(await codeOf(removeInstance(h, 'i1', ME, deps({ composeDown: async () => { calls.push('down'); throw new Error('boom') } })))).toBe('COMPOSE_DOWN_FAILED')
        expect(calls).toEqual(['down'])
        expect(h.doc().instanceDB['i1' as any]).toBeDefined()
        expect(resourceLock.getLockInfo(instanceKey('i1'))).toBeFalsy()
    })
    it('fallback container cleanup failure is COMPOSE_DOWN_FAILED and does not quarantine', async () => {
        add('i1', 'k', 'd1')
        expect(await codeOf(removeInstance(h, 'i1', ME, deps({ removeProjectContainers: async () => { throw new Error('rm failed') } })))).toBe('COMPOSE_DOWN_FAILED')
        expect(calls).toEqual(['down /fake/instances/i1'])
        expect(h.doc().instanceDB['i1' as any]).toBeDefined()
        expect(resourceLock.getLockInfo(instanceKey('i1'))).toBeFalsy()
    })
    it('QUARANTINE_FAILED leaves the store untouched after a successful compose down', async () => {
        add('i1', 'k', 'd1')
        expect(await codeOf(removeInstance(h, 'i1', ME, deps({ quarantine: async () => { throw new Error('refused: x') } })))).toBe('QUARANTINE_FAILED')
        expect(calls).toEqual(['down /fake/instances/i1', 'rm-project i1'])
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
    it('refreshes Disk.preUpdateSnapshots, preUpdateBytes and quarantineBytes after a successful remove (idea#428)', async () => {
        add('i1', 'kolibri', 'd1')
        h.change(doc => {
            const d = doc.diskDB['d1' as any] as any
            d.preUpdateSnapshots = [{ instanceId: 'i1', sizeBytes: 4096, complete: true }]
            d.preUpdateBytes = 8192
            d.quarantineBytes = 100
        })
        await removeInstance(h, 'i1', ME, deps({
            refreshSnapshots: async (disk) => {
                calls.push(`refresh ${disk.id}`)
                h.change(doc => {
                    const d = doc.diskDB[disk.id as any] as any
                    d.preUpdateSnapshots = []
                    d.preUpdateBytes = 0
                    d.quarantineBytes = 5000
                })
            },
        }))
        expect(calls).toContain('refresh d1')
        expect(h.doc().instanceDB['i1' as any]).toBeUndefined()
        expect(h.doc().diskDB['d1' as any].preUpdateSnapshots).toEqual([])
        expect(h.doc().diskDB['d1' as any].preUpdateBytes).toBe(0)
        expect(h.doc().diskDB['d1' as any].quarantineBytes).toBe(5000)
    })
    it('drops the removed instance from preUpdateSnapshots even if the helper still lists its folder (idea#428)', async () => {
        add('i1', 'kolibri', 'd1')
        await removeInstance(h, 'i1', ME, deps({
            refreshSnapshots: async (disk) => {
                calls.push(`refresh ${disk.id}`)
                h.change(doc => {
                    const d = doc.diskDB[disk.id as any] as any
                    d.preUpdateSnapshots = [
                        { instanceId: 'i1', sizeBytes: 4096, complete: true },
                        { instanceId: 'other', sizeBytes: 100, complete: true },
                    ]
                    d.preUpdateBytes = 4196
                    d.quarantineBytes = 5000
                })
            },
        }))
        expect(calls).toContain('refresh d1')
        expect(h.doc().diskDB['d1' as any].preUpdateSnapshots).toEqual([{ instanceId: 'other', sizeBytes: 100, complete: true }])
        expect(h.doc().diskDB['d1' as any].preUpdateBytes).toBe(100)
        expect(h.doc().diskDB['d1' as any].quarantineBytes).toBe(5000)
    })
    it('does not refresh snapshot info when compose down or quarantine fails (idea#428)', async () => {
        add('i1', 'k', 'd1')
        h.change(doc => {
            const d = doc.diskDB['d1' as any] as any
            d.preUpdateSnapshots = [{ instanceId: 'i1', sizeBytes: 1, complete: true }]
            d.preUpdateBytes = 1
            d.quarantineBytes = 1
        })
        expect(await codeOf(removeInstance(h, 'i1', ME, deps({ composeDown: async () => { throw new Error('boom') } })))).toBe('COMPOSE_DOWN_FAILED')
        expect(calls.filter(c => c.startsWith('refresh'))).toEqual([])
        expect(h.doc().diskDB['d1' as any].preUpdateSnapshots).toEqual([{ instanceId: 'i1', sizeBytes: 1, complete: true }])
        expect(h.doc().diskDB['d1' as any].preUpdateBytes).toBe(1)
        expect(h.doc().diskDB['d1' as any].quarantineBytes).toBe(1)
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

describe('defaultInstanceDir and compose down helpers (idea#424)', () => {
    afterEach(() => setRootDeviceForTests(null))

    it('system disk instance dir is /instances/<id>, not the relative path.join(diskMountRoot) result', async () => {
        setRootDeviceForTests('nvme0n1p2')
        const sys = { id: 'sys', device: 'nvme0n1p2' } as unknown as Disk
        const id = 'usage-dashboard-vxlkf3cjhmxo6z73qb2'
        const dir = await defaultInstanceDir(sys, id as any)
        expect(dir).toBe(`/instances/${id}`)
        expect(path.isAbsolute(dir)).toBe(true)
        expect(path.join('', 'instances', id)).toBe(`instances/${id}`)
    })
    it('regular disk instance dir stays <disksRoot>/<device>/instances/<id>', async () => {
        setRootDeviceForTests('nvme0n1p2')
        const app = { id: 'd1', device: 'sdb1' } as unknown as Disk
        expect(await defaultInstanceDir(app, 'i1' as any)).toBe(path.join(disksRoot(), 'sdb1', 'instances', 'i1'))
    })
    it('composeDownAt runs compose -p -f down on the live file and does not pass -v', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-rm-down-'))
        try {
            const composeFile = path.join(tmp, 'compose.yaml')
            fs.writeFileSync(composeFile, 'services: {}\n')
            const ran: string[][] = []
            await composeDownAt(tmp, 'i1' as any, async (args) => { ran.push(args); return '' })
            expect(ran).toEqual([['compose', '-p', 'i1', '-f', composeFile, 'down']])
            expect(ran[0]).not.toContain('-v')
            expect(ran[0]).not.toContain('--volumes')
            expect(ran[0].join(' ')).not.toMatch(/idea-quarantine/)
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true })
        }
    })
    it('composeDownAt without compose.yaml does not invent a quarantine glob or call docker compose', async () => {
        const ran: string[][] = []
        await composeDownAt('/no/such/instances/i1', 'i1' as any, async (args) => { ran.push(args); return '' })
        expect(ran).toEqual([])
    })
    it('removeContainersByComposeProject lists and rms by project label without -v', async () => {
        const ran: string[][] = []
        await removeContainersByComposeProject('i1' as any, async (args) => {
            ran.push(args)
            if (args[0] === 'ps') return 'abc\ndef\n'
            return ''
        })
        expect(ran).toEqual([
            ['ps', '-aq', '--filter', 'label=com.docker.compose.project=i1'],
            ['rm', '-f', 'abc'],
            ['rm', '-f', 'def'],
        ])
    })
})
