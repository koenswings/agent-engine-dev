/**
 * instance-id-args.test.ts (idea#168): startInstance / runInstance / stopInstance
 * resolve their instance arg id-first via resolveInstanceArg, like backupApp and
 * restoreApp: an instance id, else a unique name. A name shared by two instances
 * is refused as ambiguous (listing the ids); an unknown one as not found.
 * findInstanceByName used to silently take the first match. The disk arg is
 * unchanged (a disk name; start/stop prefer the instance's storedOn).
 */

import { describe, it, beforeEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'

vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        startInstance: vi.fn(async () => {}),
        runInstance: vi.fn(async () => {}),
        stopInstance: vi.fn(async () => {}),
        markInstanceError: vi.fn(async () => {}),
    }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { startInstance, runInstance, stopInstance } from '../../src/data/Instance.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'

const LOCAL = localEngineId as EngineID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}
const addDisk = (h: DocHandle<Store>, id: string, name: string, device: string) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID, name: name as DiskName, device: device as DeviceName, dockedTo: LOCAL,
            created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['app'], backupConfig: null,
        } as any
    })
}
const addInstance = (h: DocHandle<Store>, id: string, name: string, storedOn: string) => {
    h.change(doc => { doc.instanceDB[id as InstanceID] = { id, name, storedOn, instanceOf: 'kolibri-1.0' } as any })
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

const targets = {
    startInstance: () => vi.mocked(startInstance),
    runInstance: () => vi.mocked(runInstance),
    stopInstance: () => vi.mocked(stopInstance),
} as const

describe('startInstance / runInstance / stopInstance resolve the instance id-first (idea#168)', () => {
    let h: DocHandle<Store>
    let log: DocHandle<CommandLogStore>
    const run = async (cmd: string) => { await handleCommand(commands, h, 'engine', cmd, log); return lastTrace(log) }

    beforeEach(async () => {
        for (const t of Object.values(targets)) t().mockClear()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
        log = newLog()
        addDisk(h, 'd-a', 'DiskA', 'sda1')
        addDisk(h, 'd-b', 'DiskB', 'sdb1')
        addInstance(h, 'inst-k1', 'kolibri', 'd-a')
        addInstance(h, 'inst-k2', 'kolibri', 'd-b')
        addInstance(h, 'inst-n1', 'nextcloud', 'd-a')
    })

    for (const cmd of Object.keys(targets) as (keyof typeof targets)[]) {
        it(`${cmd} by instance id: picks that instance even with two named 'kolibri'`, async () => {
            const t = await run(`${cmd} inst-k2 DiskB`)
            expect(t.status).toBe('ok')
            expect(targets[cmd]()).toHaveBeenCalledOnce()
            const [, inst, disk] = targets[cmd]().mock.calls[0] as any[]
            expect(inst.id).toBe('inst-k2')
            expect(disk.id).toBe('d-b')
        })

        it(`${cmd} by a unique instance name: still resolves (unchanged behaviour)`, async () => {
            const t = await run(`${cmd} nextcloud DiskA`)
            expect(t.status).toBe('ok')
            expect((targets[cmd]().mock.calls[0] as any[])[1].id).toBe('inst-n1')
        })

        it(`${cmd} refuses an ambiguous instance name, listing the ids, and runs nothing`, async () => {
            const t = await run(`${cmd} kolibri DiskA`)
            expect(t.status).toBe('error')
            expect(t.errorMessage).toContain(`${cmd}: instance name 'kolibri' is ambiguous: inst-k1 (on disk d-a), inst-k2 (on disk d-b). Use the instance id.`)
            expect(targets[cmd]()).not.toHaveBeenCalled()
        })

        it(`${cmd} refuses an unknown instance`, async () => {
            const t = await run(`${cmd} ghost DiskA`)
            expect(t.status).toBe('error')
            expect(t.errorMessage).toContain(`${cmd}: instance 'ghost' not found.`)
            expect(targets[cmd]()).not.toHaveBeenCalled()
        })
    }
})
