/**
 * backup-local-disk.test.ts (engine#394)
 *
 * backupApp without a disk argument must only pick a Backup Disk docked on
 * this Engine (dockedTo == local engine id), preferring the instance's linked
 * disk. A remote-docked Backup Disk listed first in the shared store is skipped.
 * The explicit-disk path (resolveDiskArg) is unchanged.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import {
    pickLocalBackupDisk, localBackupDisks, localEngineName, noLocalBackupDiskMessage, isDockedOnEngine,
} from '../../src/data/LocalBackupDisk.js'

vi.mock('../../src/monitors/backupMonitor.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, backupInstance: vi.fn(async () => {}) }
})

import { backupInstance } from '../../src/monitors/backupMonitor.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { linkedBackupDisk } from '../../src/data/UpdateApp.js'
import { runWithTrace } from '../../src/utils/CommandLogger.js'
import { resourceLock } from '../../src/utils/ResourceLock.js'
import { config } from '../../src/data/Config.js'

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID
const INST = 'inst-nc'
const INST_NAME = 'nextcloud'

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

const addDisk = (
    h: DocHandle<Store>,
    id: string,
    opts: {
        name?: string, device?: string | null, dockedTo?: EngineID | null,
        links?: string[], types?: string[],
    } = {},
) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID,
            name: (opts.name ?? id) as DiskName,
            device: (opts.device ?? null) as DeviceName | null,
            dockedTo: opts.dockedTo === undefined ? LOCAL : opts.dockedTo,
            created: 1 as Timestamp,
            lastDocked: 1 as Timestamp,
            diskTypes: opts.types ?? ['backup'],
            backupConfig: opts.types && !opts.types.includes('backup')
                ? null
                : { mode: 'on-demand', links: (opts.links ?? []) as InstanceID[] },
        } as any
    })
}

const addInstance = (h: DocHandle<Store>, id: string, name: string, storedOn: string) => {
    h.change(doc => { doc.instanceDB[id as InstanceID] = { id, name, storedOn, instanceOf: 'nextcloud-1.0' } as any })
}

const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })

const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

const backupApp = () => commands.find(c => c.name === 'backupApp')!

describe('backupApp without a disk argument uses only a locally docked Backup Disk (engine#394)', () => {
    let h: DocHandle<Store>
    let warn: ReturnType<typeof vi.spyOn>
    let err: ReturnType<typeof vi.spyOn>
    let engineName: string

    beforeEach(async () => {
        vi.mocked(backupInstance).mockClear()
        vi.mocked(backupInstance).mockImplementation(async () => {})
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
        engineName = localEngineName(h.doc()!)
        addInstance(h, INST, INST_NAME, 'app-local')
        addDisk(h, 'app-local', { device: 'sda1', types: ['app'], dockedTo: LOCAL })
    })
    afterEach(() => { warn.mockRestore(); err.mockRestore() })

    const runDefault = async (instanceArg = INST) => backupApp().execute(h, instanceArg)
    const runExplicit = async (cmd: string) => {
        const log = newLog()
        await handleCommand(commands, h, 'engine', cmd, log)
        return lastTrace(log)
    }

    it('skips a remote-docked Backup Disk listed first and uses the local one', async () => {
        // Insertion order: remote first, then local. Both link the instance.
        addDisk(h, 'bk-remote', { name: 'Remote Backups', device: 'sdb1', dockedTo: OTHER, links: [INST] })
        addDisk(h, 'bk-local', { name: 'Local Backups', device: 'sdc1', dockedTo: LOCAL, links: [INST] })
        const ids = Object.keys(h.doc()!.diskDB)
        expect(ids.indexOf('bk-remote')).toBeLessThan(ids.indexOf('bk-local'))

        expect(pickLocalBackupDisk(h.doc()!, LOCAL, INST)?.id).toBe('bk-local')
        await runDefault()
        expect(vi.mocked(backupInstance)).toHaveBeenCalledOnce()
        expect((vi.mocked(backupInstance).mock.calls[0][2] as any).id).toBe('bk-local')
    })

    it('prefers the linked Backup Disk when several are docked locally', async () => {
        addDisk(h, 'bk-unlinked', { name: 'Other Backups', device: 'sdb1', dockedTo: LOCAL, links: ['someone-else'] })
        addDisk(h, 'bk-linked', { name: 'Linked Backups', device: 'sdc1', dockedTo: LOCAL, links: [INST] })
        const ids = Object.keys(h.doc()!.diskDB)
        expect(ids.indexOf('bk-unlinked')).toBeLessThan(ids.indexOf('bk-linked'))

        expect(pickLocalBackupDisk(h.doc()!, LOCAL, INST)?.id).toBe('bk-linked')
        expect(String(linkedBackupDisk(h.doc()!, LOCAL, h.doc()!.instanceDB[INST as InstanceID])!.id)).toBe('bk-linked')
        await runDefault()
        expect(vi.mocked(backupInstance)).toHaveBeenCalledOnce()
        expect((vi.mocked(backupInstance).mock.calls[0][2] as any).id).toBe('bk-linked')
    })

    it('refuses with a clear error and runs no backup when none is docked locally', async () => {
        addDisk(h, 'bk-remote', { name: 'Remote Backups', device: 'sdb1', dockedTo: OTHER, links: [INST] })
        expect(localBackupDisks(h.doc()!, LOCAL)).toEqual([])
        expect(pickLocalBackupDisk(h.doc()!, LOCAL, INST)).toBeUndefined()

        const expected = noLocalBackupDiskMessage(engineName)
        expect(expected).toBe(`NOT_DOCKED: no Backup Disk docked on ${engineName}`)
        await expect(runDefault()).rejects.toThrow(expected)
        expect(vi.mocked(backupInstance)).not.toHaveBeenCalled()
    })

    it('the explicit-disk path is unchanged: a named local disk is used; a remote disk is refused', async () => {
        addDisk(h, 'bk-remote', { name: 'Remote', device: 'sdb1', dockedTo: OTHER, links: [INST] })
        addDisk(h, 'bk-local', { name: 'Local', device: 'sdc1', dockedTo: LOCAL, links: [INST] })
        addDisk(h, 'bk-other-local', { name: 'Other Local', device: 'sdd1', dockedTo: LOCAL, links: [] })

        const ok = await runExplicit(`backupApp ${INST} bk-other-local`)
        expect(ok.status).toBe('ok')
        expect(vi.mocked(backupInstance)).toHaveBeenCalledOnce()
        expect((vi.mocked(backupInstance).mock.calls[0][2] as any).id).toBe('bk-other-local')

        vi.mocked(backupInstance).mockClear()
        const remote = await runExplicit(`backupApp ${INST} bk-remote`)
        expect(remote.status).toBe('error')
        expect(remote.errorMessage).toContain('not docked to this engine')
        expect(vi.mocked(backupInstance)).not.toHaveBeenCalled()
    })

    it('the registry marks backupDiskId optional, so a one-arg dispatch reaches the wrapper', () => {
        const diskArg = backupApp().args.find(a => a.name === 'backupDiskId')
        expect(diskArg).toMatchObject({ type: 'string', name: 'backupDiskId', optional: true })
        expect(diskArg?.variadic).not.toBe(true)
    })

    it('dispatching backupApp <instanceId> with no disk passes validation and picks a local disk', async () => {
        addDisk(h, 'bk-remote', { name: 'Remote Backups', device: 'sdb1', dockedTo: OTHER, links: [INST] })
        addDisk(h, 'bk-local', { name: 'Local Backups', device: 'sdc1', dockedTo: LOCAL, links: [INST] })

        const t = await runExplicit(`backupApp ${INST}`)
        expect(t.status).toBe('ok')
        expect(t.errorMessage).toBeNull()
        expect(JSON.parse(t.args)).toEqual({ instanceName: INST, backupDiskId: null })
        expect(vi.mocked(backupInstance)).toHaveBeenCalledOnce()
        expect((vi.mocked(backupInstance).mock.calls[0][2] as any).id).toBe('bk-local')
    })

    it("dispatching backupApp <instanceId> with no local disk reaches the wrapper and throws NOT_DOCKED", async () => {
        addDisk(h, 'bk-remote', { name: 'Remote Backups', device: 'sdb1', dockedTo: OTHER, links: [INST] })

        const t = await runExplicit(`backupApp ${INST}`)
        expect(t.status).toBe('error')
        expect(t.errorMessage).toBe(noLocalBackupDiskMessage(engineName))
        expect(t.errorMessage).toMatch(/^NOT_DOCKED: no Backup Disk docked on /)
        expect(t.errorMessage).not.toMatch(/Insufficient arguments/)
        expect(JSON.parse(t.args)).toEqual({ instanceName: INST, backupDiskId: null })
        expect(vi.mocked(backupInstance)).not.toHaveBeenCalled()
    })

    it('the explicit two-arg dispatch still works and records backupDiskId as a string', async () => {
        addDisk(h, 'bk-other-local', { name: 'Other Local', device: 'sdd1', dockedTo: LOCAL, links: [] })

        const t = await runExplicit(`backupApp ${INST} bk-other-local`)
        expect(t.status).toBe('ok')
        expect(JSON.parse(t.args)).toEqual({ instanceName: INST, backupDiskId: 'bk-other-local' })
        expect(vi.mocked(backupInstance)).toHaveBeenCalledOnce()
        expect((vi.mocked(backupInstance).mock.calls[0][2] as any).id).toBe('bk-other-local')
    })
})

describe('backupInstance refuses a Backup Disk not docked on this Engine (engine#394)', () => {
    let prevSkipBorg: boolean | undefined

    beforeEach(() => { prevSkipBorg = config.settings.skipBorg; config.settings.skipBorg = true })
    afterEach(() => { config.settings.skipBorg = prevSkipBorg })

    it('isDockedOnEngine is false for a remote or undocked record', () => {
        expect(isDockedOnEngine({ device: 'sdb1', dockedTo: OTHER }, LOCAL)).toBe(false)
        expect(isDockedOnEngine({ device: null, dockedTo: LOCAL }, LOCAL)).toBe(false)
        expect(isDockedOnEngine({ device: 'sdb1', dockedTo: LOCAL }, LOCAL)).toBe(true)
    })

    it('throws the clear error and does not back up when the given Backup Disk is docked elsewhere', async () => {
        const h = await newStore()
        const engineName = localEngineName(h.doc()!)
        addInstance(h, INST, INST_NAME, 'app-local')
        addDisk(h, 'app-local', { device: 'sda1', types: ['app'], dockedTo: LOCAL })
        addDisk(h, 'bk-remote', { name: 'Remote Backups', device: 'sdb1', dockedTo: OTHER, links: [INST] })
        const remote = h.doc()!.diskDB['bk-remote' as DiskID]

        const actual = await vi.importActual<typeof import('../../src/monitors/backupMonitor.js')>('../../src/monitors/backupMonitor.js')
        await expect(runWithTrace({ traceId: 't-394', command: 'backupApp', args: '{}' }, async () => {
            await actual.backupInstance(h, INST as InstanceID, remote as any)
        })).rejects.toThrow(noLocalBackupDiskMessage(engineName))

        expect(h.doc()!.instanceDB[INST as InstanceID].lastBackup ?? null).toBeNull()
        expect(resourceLock.isLocked(`instance:${INST}`)).toBe(false)
        expect(resourceLock.isLocked('disk:bk-remote')).toBe(false)
    })
})
