/**
 * instance-id-args.test.ts (idea#168 r35): startInstance / runInstance /
 * stopInstance resolve their instance argument id-first (resolveInstanceArg,
 * src/data/InstanceArg.ts):
 *   1. an instance id,
 *   2. else a unique instance name,
 *   3. else the one instance with that name on the disk the command names
 *      (the Console sends `<name> <storedOn>`), with a warning in the trace,
 *   4. else refused: ambiguous (ids listed) or not found.
 * copyApp put two instances named 'kolibri' in the store; findInstanceByName
 * silently took the first. Instance lifecycle functions are mocked: only the
 * argument resolution of the command wrappers is under test.
 * Ported from 51606fc (fix/restore-backup-disk-id) and extended.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
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
import { lookupInstanceArg, resolveInstanceArg } from '../../src/data/InstanceArg.js'
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
    let warn: ReturnType<typeof vi.spyOn>
    const run = async (cmd: string) => { await handleCommand(commands, h, 'engine', cmd, log); return lastTrace(log) }

    beforeEach(async () => {
        for (const t of Object.values(targets)) t().mockClear()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        h = await newStore()
        log = newLog()
        addDisk(h, 'd-a', 'DiskA', 'sda1')
        addDisk(h, 'd-b', 'DiskB', 'sdb1')
        addDisk(h, 'd-c', 'DiskC', 'sdc1')
        // Two instances named 'kolibri' (an original and a pre-fix copy) on different disks
        addInstance(h, 'inst-k1', 'kolibri', 'd-a')
        addInstance(h, 'inst-k2', 'kolibri', 'd-b')
        addInstance(h, 'inst-n1', 'nextcloud', 'd-a')
    })
    afterEach(() => { vi.restoreAllMocks() })

    for (const cmd of Object.keys(targets) as (keyof typeof targets)[]) {
        it(`${cmd} by instance id: acts on exactly that instance with two named 'kolibri'`, async () => {
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

        it(`${cmd} by a shared name + the disk it is on (Console wire format): that one, with a warning`, async () => {
            const t = await run(`${cmd} kolibri DiskB`)
            expect(t.status).toBe('ok')
            expect((targets[cmd]().mock.calls[0] as any[])[1].id).toBe('inst-k2')
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${cmd}: instance name 'kolibri' is shared by several instances; using inst-k2`))
        })

        it(`${cmd} refuses an ambiguous instance name, listing the ids, and runs nothing`, async () => {
            // Neither 'kolibri' is on DiskC, so the disk cannot disambiguate
            const t = await run(`${cmd} kolibri DiskC`)
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

    it('stopInstance: two kolibri on the SAME disk are refused even with the disk id', async () => {
        addInstance(h, 'inst-k3', 'kolibri', 'd-a')
        const t = await run('stopInstance kolibri d-a')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toContain("stopInstance: instance name 'kolibri' is ambiguous: inst-k1 (on disk d-a), inst-k3 (on disk d-a)")
        expect(vi.mocked(stopInstance)).not.toHaveBeenCalled()
        // ...but the id still stops exactly the right one
        expect((await run('stopInstance inst-k3 d-a')).status).toBe('ok')
        expect((vi.mocked(stopInstance).mock.calls[0] as any[])[1].id).toBe('inst-k3')
    })

    it('startInstance <id> <diskId> --cause cross-engine-cmd (the cross-engine copyApp dispatch) is accepted', async () => {
        const t = await run('startInstance inst-k2 d-b --cause cross-engine-cmd')
        expect(t.status).toBe('ok')
        const [, inst, disk, cause] = vi.mocked(startInstance).mock.calls[0] as any[]
        expect(inst.id).toBe('inst-k2')
        expect(disk.id).toBe('d-b')
        expect(cause).toBe('cross-engine-cmd')
        // The trace keeps the 'instanceName' key the Console filters on
        expect(JSON.parse(t.args as any).instanceName).toBe('inst-k2')
    })

    it('the trace arg key stays instanceName for the Console wire format', async () => {
        const t = await run('stopInstance kolibri d-b')
        const args = JSON.parse(t.args as any)
        expect(args.instanceName).toBe('kolibri')
        expect(args.diskId).toBe('d-b')
    })
})

describe('lookupInstanceArg (pure)', () => {
    it('id wins over a name that equals another instance id', async () => {
        const h = await newStore()
        addDisk(h, 'd-a', 'DiskA', 'sda1')
        addInstance(h, 'kolibri', 'other', 'd-a')
        addInstance(h, 'inst-k1', 'kolibri', 'd-a')
        const r = lookupInstanceArg(h.doc()!, 'kolibri')
        expect(r.ok && r.instance.id).toBe('kolibri')
        expect(r.ok && r.via).toBe('id')
        expect(resolveInstanceArg(h.doc()!, 'inst-k1', 'x').id).toBe('inst-k1')
    })
})
