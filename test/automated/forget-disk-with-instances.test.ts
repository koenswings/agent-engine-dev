/**
 * forget-disk-with-instances.test.ts (idea#466)
 *
 * `forgetDisk <diskId> --with-instances` drops an undocked disk record plus every
 * instance record storedOn it, for a disk that is gone (2VroE: updtest10i76,
 * 9bgojj2asocyf7gxtci after the WD was reflashed). Refused, store untouched,
 * trace `error` with `CODE: text`, when the disk is docked anywhere or an
 * instance is Running/Starting/Pauzed or has an unknown status. The default
 * forgetDisk (no option) is unchanged; removeInstance is not relaxed.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { enableStoreMonitor } from '../../src/monitors/storeMonitor.js'
import {
    ForgetDiskError, checkForgetDiskWithInstances, forgetDisk, forgetDiskWithInstances,
} from '../../src/data/ForgetDisk.js'
import { removeInstance } from '../../src/data/RemoveInstance.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'

const OTHER = 'ENGINE_other-engine-000000'
const GONE = 'updtest10i76'
const KEEP = 'keep-disk-1'

const disk = (id: string, over: any = {}) => ({ id, name: `disk ${id}`, dockedTo: null, device: null, created: 1, lastDocked: 1, diskTypes: [], backupConfig: null, ...over })
const inst = (id: string, storedOn: string, status: any) => ({ id, name: `name-${id}`, instanceOf: 'app-1.0', storedOn, status, metrics: null })

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(d => {
        (d.diskDB as any)[GONE] = disk(GONE, { name: 'Update Test 1.0' });
        (d.diskDB as any)[KEEP] = disk(KEEP)
        for (const [id, st] of [['updtest-i76major', 'Stopped'], ['updtest-i76minor', 'Undocked'], ['updtest-i76stale', 'Missing']]) (d.instanceDB as any)[id] = inst(id, GONE, st);
        (d.instanceDB as any)['other-i'] = inst('other-i', KEEP, 'Stopped')
    })
    return h
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] => h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => traces(h)[traces(h).length - 1]
const snapshot = (h: DocHandle<Store>) => JSON.stringify({ d: h.doc()!.diskDB, i: h.doc()!.instanceDB })
const setInst = (h: DocHandle<Store>, id: string, patch: any) => h.change(d => { Object.assign((d.instanceDB as any)[id], patch) })
const delStatus = (h: DocHandle<Store>, id: string) => h.change(d => { delete (d.instanceDB as any)[id].status })

const expectCode = (fn: () => unknown, code: string) => {
    let err: unknown
    try { fn() } catch (e) { err = e }
    expect(err).toBeInstanceOf(ForgetDiskError)
    expect((err as ForgetDiskError).code).toBe(code)
    expect((err as ForgetDiskError).message.startsWith(`${code}: `)).toBe(true)
}

describe('forgetDisk --with-instances (idea#466)', () => {
    let h: DocHandle<Store>
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
    })
    afterEach(() => err.mockRestore())

    it('success: drops the disk row and every instance row storedOn it, nothing else', () => {
        const r = forgetDiskWithInstances(h, GONE)
        expect(r.diskId).toBe(GONE)
        expect(r.diskName).toBe('Update Test 1.0')
        expect(r.removedInstances.map(i => i.id).sort()).toEqual(['updtest-i76major', 'updtest-i76minor', 'updtest-i76stale'])
        expect(h.doc()!.diskDB[GONE as any]).toBeUndefined()
        for (const id of ['updtest-i76major', 'updtest-i76minor', 'updtest-i76stale']) expect(h.doc()!.instanceDB[id as any]).toBeUndefined()
        expect(h.doc()!.diskDB[KEEP as any]).toBeTruthy()
        expect(h.doc()!.instanceDB['other-i' as any]).toBeTruthy()
    })

    it('success: only the instances of that disk go; a disk with no instances is simply removed', () => {
        expect(forgetDiskWithInstances(h, KEEP).diskId).toBe(KEEP)
        expect(h.doc()!.instanceDB['other-i' as any]).toBeUndefined()
        const h2Disk = 'empty-disk'
        h.change(d => { (d.diskDB as any)[h2Disk] = disk(h2Disk) })
        expect(forgetDiskWithInstances(h, h2Disk).removedInstances).toEqual([])
        expect(h.doc()!.diskDB[h2Disk as any]).toBeUndefined()
    })

    it('success: Docked and Error statuses are known not-running statuses', () => {
        setInst(h, 'updtest-i76major', { status: 'Docked' })
        setInst(h, 'updtest-i76minor', { status: 'Error' })
        expect(forgetDiskWithInstances(h, GONE).removedInstances.length).toBe(3)
    })

    it('NOT_FOUND: no record with exactly that id (no name fallback)', () => {
        const before = snapshot(h)
        expectCode(() => forgetDiskWithInstances(h, 'nope'), 'NOT_FOUND')
        expectCode(() => forgetDiskWithInstances(h, 'Update Test 1.0'), 'NOT_FOUND')
        expect(snapshot(h)).toBe(before)
    })

    it('DOCKED: dockedTo set (this or another Engine), or only device set', () => {
        for (const over of [{ dockedTo: localEngineId, device: 'sda1' }, { dockedTo: OTHER, device: 'sdb1' }, { dockedTo: OTHER }, { device: 'sda1' }]) {
            h.change(d => { Object.assign((d.diskDB as any)[GONE], { dockedTo: null, device: null }, over) })
            const before = snapshot(h)
            expectCode(() => forgetDiskWithInstances(h, GONE), 'DOCKED')
            expect(snapshot(h)).toBe(before)
        }
    })

    it.each(['Running', 'Starting', 'Pauzed'])('INSTANCE_RUNNING: an instance is %s', (status) => {
        setInst(h, 'updtest-i76stale', { status })
        const before = snapshot(h)
        expectCode(() => forgetDiskWithInstances(h, GONE), 'INSTANCE_RUNNING')
        expect(snapshot(h)).toBe(before)
    })

    it('INSTANCE_STATUS_UNKNOWN: an instance has no status or an unrecognised one', () => {
        delStatus(h, 'updtest-i76minor')
        let before = snapshot(h)
        expectCode(() => forgetDiskWithInstances(h, GONE), 'INSTANCE_STATUS_UNKNOWN')
        expect(snapshot(h)).toBe(before)
        setInst(h, 'updtest-i76minor', { status: 'Rebooting' })
        before = snapshot(h)
        expectCode(() => forgetDiskWithInstances(h, GONE), 'INSTANCE_STATUS_UNKNOWN')
        expect(snapshot(h)).toBe(before)
    })

    it('CHANGED: the store moves on between the check and the change, nothing removed', () => {
        const origChange = h.change.bind(h)
        const spy = vi.spyOn(h, 'change').mockImplementationOnce((fn: any) => {
            // Another Engine marks an instance Running just before our change applies
            origChange(d => { (d.instanceDB as any)['updtest-i76major'].status = 'Running' })
            return origChange(fn)
        })
        expectCode(() => forgetDiskWithInstances(h, GONE), 'CHANGED')
        spy.mockRestore()
        expect(h.doc()!.diskDB[GONE as any]).toBeTruthy()
        expect(h.doc()!.instanceDB['updtest-i76minor' as any]).toBeTruthy()
    })

    it('the check reports the plan without changing the store', () => {
        const before = snapshot(h)
        const c = checkForgetDiskWithInstances(h.doc()!, GONE)
        expect(c.ok).toBe(true)
        expect(snapshot(h)).toBe(before)
    })

    it('default forgetDisk is unchanged: still refuses while instance records exist', () => {
        expect(() => forgetDisk(h, GONE)).toThrow(/forgetDisk does not remove instances/)
        expect(h.doc()!.diskDB[GONE as any]).toBeTruthy()
    })

    it('removeInstance is not relaxed for an undocked disk (NOT_LOCAL)', async () => {
        await expect(removeInstance(h, 'updtest-i76major', String(localEngineId))).rejects.toThrow(/^NOT_LOCAL: /)
        expect(h.doc()!.instanceDB['updtest-i76major' as any]).toBeTruthy()
    })

    it('advertises the forgetDiskWithInstances capability', () => {
        expect(ENGINE_CAPABILITIES).toContain('forgetDiskWithInstances')
        expect(ENGINE_CAPABILITIES).toContain('forgetDisk')
    })
})

describe('forgetDisk --with-instances command trace (idea#466)', () => {
    let h: DocHandle<Store>
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
    })
    afterEach(() => err.mockRestore())

    it('success: trace ok with { diskId, diskName, removedInstances } as result', async () => {
        const log = newLog()
        await handleCommand(commands, h, 'engine', `forgetDisk ${GONE} --with-instances`, log)
        const t = lastTrace(log)
        expect(t.command).toBe('forgetDisk')
        expect(t.status).toBe('ok')
        const result = typeof t.result === 'string' ? JSON.parse(t.result) : t.result
        expect(result.diskId).toBe(GONE)
        expect(result.removedInstances.map((i: any) => i.id).sort()).toEqual(['updtest-i76major', 'updtest-i76minor', 'updtest-i76stale'])
        expect(h.doc()!.diskDB[GONE as any]).toBeUndefined()
    })

    it.each([
        ['DOCKED', (h: DocHandle<Store>) => h.change(d => { Object.assign((d.diskDB as any)[GONE], { dockedTo: OTHER, device: 'sda1' }) })],
        ['INSTANCE_RUNNING', (h: DocHandle<Store>) => setInst(h, 'updtest-i76major', { status: 'Running' })],
        ['INSTANCE_STATUS_UNKNOWN', (h: DocHandle<Store>) => delStatus(h, 'updtest-i76major')],
    ] as const)('refusal %s: trace error, errorMessage = error = CODE: text, store untouched', async (code, arrange) => {
        arrange(h)
        const before = snapshot(h)
        const log = newLog()
        await handleCommand(commands, h, 'engine', `forgetDisk ${GONE} --with-instances`, log)
        const t = lastTrace(log)
        expect(t.status).toBe('error')
        expect(t.errorMessage).toMatch(new RegExp(`^${code}: `))
        expect(t.error).toBe(t.errorMessage)
        expect(snapshot(h)).toBe(before)
    })

    it('refusal NOT_FOUND and BAD_OPTION through the command path', async () => {
        const before = snapshot(h)
        let log = newLog()
        await handleCommand(commands, h, 'engine', 'forgetDisk nope --with-instances', log)
        expect(lastTrace(log).errorMessage).toMatch(/^NOT_FOUND: /)
        log = newLog()
        await handleCommand(commands, h, 'engine', `forgetDisk ${GONE} --force`, log)
        expect(lastTrace(log).status).toBe('error')
        expect(lastTrace(log).errorMessage).toMatch(/^BAD_OPTION: /)
        expect(snapshot(h)).toBe(before)
    })

    it('without the option: same refusal as before (instances block it)', async () => {
        const log = newLog()
        await handleCommand(commands, h, 'engine', `forgetDisk ${GONE}`, log)
        expect(lastTrace(log).status).toBe('error')
        expect(lastTrace(log).errorMessage).toMatch(/forgetDisk does not remove instances/)
        expect(h.doc()!.diskDB[GONE as any]).toBeTruthy()
    })

    it('via the Engine command queue: removed and trace ok', async () => {
        const log = newLog()
        enableStoreMonitor(h, log)
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).push(`forgetDisk ${GONE} --with-instances`) })
        await vi.waitFor(() => expect(traces(log).filter(t => t.command === 'forgetDisk' && t.status !== 'running').length).toBe(1))
        expect(traces(log).find(t => t.command === 'forgetDisk')!.status).toBe('ok')
        expect(h.doc()!.diskDB[GONE as any]).toBeUndefined()
        expect(h.doc()!.instanceDB['updtest-i76major' as any]).toBeUndefined()
    })
})

describe('forgetDisk --with-instances network prune (idea#468)', () => {
    it('the command wrapper prunes local unused networks for forgotten instance ids after a successful store edit', async () => {
        const { promises: fs } = await import('node:fs')
        const { default: path } = await import('node:path')
        const src = await fs.readFile(path.join(process.cwd(), 'src/data/Commands.ts'), 'utf8')
        expect(src).toMatch(/await pruneUnusedInstanceNetworksForIds\(result\.removedInstances\.map/)
        expect(src).toMatch(/idea#468/)
        const wrapper = src.slice(src.indexOf('const forgetDiskWrapper'))
        const withOpt = wrapper.slice(0, wrapper.indexOf('const removed = forgetDisk'))
        expect(withOpt).toMatch(/forgetDiskWithInstances/)
        expect(withOpt).toMatch(/pruneUnusedInstanceNetworksForIds/)
        expect(withOpt.indexOf('forgetDiskWithInstances')).toBeLessThan(withOpt.indexOf('pruneUnusedInstanceNetworksForIds'))
    })
})
