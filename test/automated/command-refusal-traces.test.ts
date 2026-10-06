/**
 * command-refusal-traces.test.ts (idea#168 r29@97, fail loud)
 *
 * Command handler refusals that used to only print/log (so the trace closed
 * as ok and the Console never saw them) now throw, the same way other
 * refusals do: handleCommand closes the trace as `error` with the reason in
 * errorMessage. One test per converted call site in src/data/Commands.ts.
 * (CopyMoveApp and backupMonitor refusals: copy-move-app.test.ts,
 * concurrent-operation-safety.test.ts, backup-locks.test.ts.)
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'

// buildEngine must never reach SSH/rsync in a unit test
vi.mock('../../src/data/Engine.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        clearKnownHost: vi.fn(async () => {}),
        syncEngine: vi.fn(async () => { throw new Error('rsync: connection refused') }),
        buildEngine: vi.fn(async () => {}),
    }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

describe('command refusals end the trace as error (idea#168 r29@97)', () => {
    let h: DocHandle<Store>
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
        h.change(doc => {
            doc.diskDB['d-1' as DiskID] = {
                id: 'd-1' as DiskID, name: 'Disk One' as DiskName, device: 'idea-test-1' as any, dockedTo: localEngineId as EngineID,
                created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['app'], backupConfig: null,
            }
            // An instance whose disk record is gone and whose disk name is unknown
            doc.instanceDB['inst-orphan' as InstanceID] = { id: 'inst-orphan', name: 'orphan', storedOn: 'd-gone', instanceOf: 'x-1.0', status: 'Stopped' } as any
        })
    })
    afterEach(() => err.mockRestore())

    const refused = async (store: DocHandle<Store> | null, cmd: string, message: string | RegExp) => {
        const log = newLog()
        await handleCommand(commands, store, 'engine', cmd, log)
        const t = lastTrace(log)
        expect(t.command).toBe(cmd.split(' ')[0])
        expect(t.status).toBe('error')
        if (typeof message === 'string') expect(t.errorMessage).toContain(message)
        else expect(t.errorMessage).toMatch(message)
        expect(t.completedAt).not.toBeNull()
    }

    it('ls / engines / disks / apps / instances without a store', async () => {
        for (const cmd of ['ls', 'engines', 'disks', 'apps', 'instances']) {
            await refused(null, cmd, 'Store is not available. Please connect first.')
        }
    })

    it('send: no store, missing command, unknown engine', async () => {
        await refused(null, 'send ENGINE_x ls', 'Store is not available. Please connect first.')
        await refused(h, 'send ENGINE_x', 'Send command requires at least two arguments')
        await refused(h, 'send ENGINE_nope ls', 'Cannot send command: Engine ENGINE_nope not found in store.')
    })

    it('createInstance: no store, disk not found', async () => {
        await refused(null, 'createInstance a b c d e', 'Store is not available to create instance.')
        await refused(h, 'createInstance i1 kolibri acct v1 NoSuchDisk', "Disk 'NoSuchDisk' not found or has no device")
    })

    for (const cmd of ['startInstance', 'runInstance', 'stopInstance']) {
        it(`${cmd}: no store, instance not found, disk not found`, async () => {
            await refused(null, `${cmd} orphan NoSuchDisk`, 'Store is not available.')
            await refused(h, `${cmd} ghost d-1`, 'Instance ghost not found')
            await refused(h, `${cmd} orphan NoSuchDisk`, /Disk '?NoSuchDisk'? not found/)
        })
    }

    it('reboot without a store', async () => {
        await refused(null, 'reboot', 'Store is not available. Please connect first.')
    })

    it('buildEngine: missing --machine, and a failed build', async () => {
        await refused(h, 'buildEngine --user pi', 'buildEngine command requires a --machine argument.')
        await refused(h, 'buildEngine --machine 10.255.255.1', 'buildEngine command failed: rsync: connection refused')
    })

    it('copyApp / moveApp without a store', async () => {
        await refused(null, 'copyApp i s t', 'Store is not available.')
        await refused(null, 'moveApp i s t', 'Store is not available.')
    })

    it('cancelOperation: no store, unknown operation', async () => {
        await refused(null, 'cancelOperation op-1', 'Store is not available.')
        await refused(h, 'cancelOperation op-nope', "cancelOperation: Operation 'op-nope' not found")
    })

    it('a command that succeeds still ends ok (control)', async () => {
        const log = newLog()
        await handleCommand(commands, h, 'engine', 'disks', log)
        expect(lastTrace(log).status).toBe('ok')
    })
})
