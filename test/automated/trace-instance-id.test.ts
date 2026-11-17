/**
 * trace-instance-id.test.ts (engine#399): the command trace names the instance
 * as args.instanceId (the id) and args.instanceName (the display name).
 * Before, the registry arg was called 'instanceName' but held whatever was sent,
 * usually the instance id. copyApp / moveApp (both the local and the
 * cross-Engine path go through the same moveApp command) are mocked: only the
 * trace args written by handleCommand are under test.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'

vi.mock('../../src/data/CopyMoveApp.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, copyApp: vi.fn(async () => {}), moveApp: vi.fn(async () => undefined) }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { copyApp, moveApp } from '../../src/data/CopyMoveApp.js'
import { commands } from '../../src/data/Commands.js'
import { addTraceInstanceIdentity, handleCommand } from '../../src/utils/commandUtils.js'

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

describe('engine#399: registry arg names', () => {
    const INSTANCE_COMMANDS = ['startInstance', 'runInstance', 'stopInstance', 'copyApp', 'moveApp', 'backupApp', 'restoreApp',
        'listBackup', 'verifyBackup', 'clearBackupLock', 'addBackupLink', 'removeBackupLink', 'removeInstance', 'renameInstance', 'deleteTempBackup']

    it('every command that takes an instance names its first arg instanceId', () => {
        for (const name of INSTANCE_COMMANDS) {
            const def = commands.find(c => c.name === name)
            expect(def, name).toBeDefined()
            expect(def!.args[0].name, name).toBe('instanceId')
        }
    })

    it('no registry arg is called instanceName any more', () => {
        for (const c of commands) {
            for (const a of c.args) expect(a.name, `${c.name}`).not.toBe('instanceName')
        }
    })

    it('the Engine advertises traceInstanceId', () => {
        expect(ENGINE_CAPABILITIES).toContain('traceInstanceId')
    })
})

describe('engine#399: copyApp / moveApp traces carry instanceId and instanceName', () => {
    let h: DocHandle<Store>
    let log: DocHandle<CommandLogStore>
    const run = async (cmd: string) => { await handleCommand(commands, h, 'engine', cmd, log); return lastTrace(log) }
    const argsOf = (t: CommandTrace) => JSON.parse(t.args as any)

    beforeEach(async () => {
        vi.mocked(copyApp).mockClear()
        vi.mocked(moveApp).mockClear()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        h = await newStore()
        log = newLog()
        addDisk(h, 'd-a', 'DiskA', 'sda1')
        addDisk(h, 'd-b', 'DiskB', 'sdb1')
        addInstance(h, 'kolibri-g3c6r', 'Kolibri Grade 3', 'd-a')
        addInstance(h, 'kolibri-x1', 'kolibri', 'd-a')
        addInstance(h, 'kolibri-x2', 'kolibri', 'd-b')
    })
    afterEach(() => { vi.restoreAllMocks() })

    for (const cmd of ['copyApp', 'moveApp'] as const) {
        it(`${cmd} <id>: instanceId is the id, instanceName the display name`, async () => {
            const t = await run(`${cmd} kolibri-g3c6r d-a d-b`)
            expect(t.status).toBe('ok')
            expect(argsOf(t)).toEqual({ instanceId: 'kolibri-g3c6r', sourceDiskId: 'd-a', targetDiskId: 'd-b', instanceName: 'Kolibri Grade 3' })
            const fn = cmd === 'copyApp' ? copyApp : moveApp
            // The command itself still gets the argument as sent
            expect((vi.mocked(fn).mock.calls[0] as any[])[1]).toBe('kolibri-g3c6r')
        })

        it(`${cmd} <shared name> <sourceDiskId>: instanceId is the id resolved on the source disk`, async () => {
            const t = await run(`${cmd} kolibri d-b d-a`)
            expect(argsOf(t).instanceId).toBe('kolibri-x2')
            expect(argsOf(t).instanceName).toBe('kolibri')
        })

        it(`${cmd} <unknown>: instanceId keeps what was sent, instanceName is null`, async () => {
            const t = await run(`${cmd} ghost d-a d-b`)
            expect(argsOf(t).instanceId).toBe('ghost')
            expect(argsOf(t).instanceName).toBeNull()
        })
    }

    it('backupApp <id> (optional disk omitted): instanceId, instanceName and backupDiskId null', async () => {
        const t = await run('backupApp kolibri-g3c6r')
        const a = argsOf(t)
        expect(a.instanceId).toBe('kolibri-g3c6r')
        expect(a.instanceName).toBe('Kolibri Grade 3')
        expect(a.backupDiskId).toBeNull()
    })

    it('renameInstance: instanceName is the name before the rename', async () => {
        const t = await run('renameInstance kolibri-g3c6r New Name')
        expect(argsOf(t).instanceId).toBe('kolibri-g3c6r')
        expect(argsOf(t).instanceName).toBe('Kolibri Grade 3')
    })

    it('a pre-execute refusal keeps the positional args array (no identity added)', async () => {
        const t = await run('copyApp kolibri-g3c6r')
        expect(t.status).toBe('error')
        expect(JSON.parse(t.args as any)).toEqual(['kolibri-g3c6r'])
    })
})

describe('addTraceInstanceIdentity (pure)', () => {
    it('leaves args without instanceId alone', async () => {
        const args: Record<string, string | string[] | null> = { diskId: 'd-a' }
        addTraceInstanceIdentity(null, args)
        expect(args).toEqual({ diskId: 'd-a' })
    })

    it('no store: keeps the raw instanceId and sets instanceName null', async () => {
        const args: Record<string, string | string[] | null> = { instanceId: 'x' }
        addTraceInstanceIdentity(null, args)
        expect(args).toEqual({ instanceId: 'x', instanceName: null })
    })

    it('ambiguous name without a disk: raw instanceId, instanceName null', async () => {
        const h = await newStore()
        addDisk(h, 'd-a', 'DiskA', 'sda1')
        addDisk(h, 'd-b', 'DiskB', 'sdb1')
        addInstance(h, 'k1', 'kolibri', 'd-a')
        addInstance(h, 'k2', 'kolibri', 'd-b')
        const args: Record<string, string | string[] | null> = { instanceId: 'kolibri', backupDiskId: 'd-b' }
        addTraceInstanceIdentity(h, args)
        expect(args).toEqual({ instanceId: 'kolibri', backupDiskId: 'd-b', instanceName: null })
    })

    it('a disk name as diskId disambiguates like the command does', async () => {
        const h = await newStore()
        addDisk(h, 'd-a', 'DiskA', 'sda1')
        addDisk(h, 'd-b', 'DiskB', 'sdb1')
        addInstance(h, 'k1', 'kolibri', 'd-a')
        addInstance(h, 'k2', 'kolibri', 'd-b')
        const args: Record<string, string | string[] | null> = { instanceId: 'kolibri', diskId: 'DiskB' }
        addTraceInstanceIdentity(h, args)
        expect(args).toEqual({ instanceId: 'k2', diskId: 'DiskB', instanceName: 'kolibri' })
    })
})
