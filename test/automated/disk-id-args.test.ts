/**
 * disk-id-args.test.ts (idea#128, Files Disk step 0b)
 *
 * Covers:
 *   - resolveDiskArg: id, unique docked name (deprecation warning), ambiguous
 *     name, undocked, docked to another engine, not found, system disk
 *   - installApp <appId> <targetDiskId> [--source <sourceDiskId>] [--name …]:
 *     id path, name path with warning, refusals that end the trace as error;
 *     no fallback to undocked or other-engine records
 *   - createBackupDisk <diskId> …: name path with warning, refusals throw
 *   - optional variadic: zero tokens accepted, recorded as []
 *   - capabilities ['diskIdArgs', 'filesDisk'] (idea#131) rewritten as a whole list at every startup,
 *     capabilitiesBootedAt === lastBooted; pm2 kill_timeout
 *
 * testMode: no sudo, no mount; disks are folders under the private DISKS_ROOT.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import { createRequire } from 'module'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { commands } from '../../src/data/Commands.js'
import { lookupDiskArg, resolveDiskArg } from '../../src/data/DiskArg.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { CommandDefinition } from '../../src/data/CommandDefinition.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { DeviceName, DiskID, DiskName, DiskType, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}
const addDisk = (h: DocHandle<Store>, id: string, name: string, device: string | null, dockedTo: EngineID | null, diskTypes: DiskType[] = ['empty']) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID, name: name as DiskName, device: device as DeviceName | null, dockedTo,
            created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: device ? diskTypes : [], backupConfig: null,
        }
    })
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

// ── resolveDiskArg ───────────────────────────────────────────────────────────

describe('resolveDiskArg: one resolver for disk arguments (idea#128)', () => {
    let h: DocHandle<Store>
    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        h = await newStore()
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        addDisk(h, 'd-live', 'IDEA Disk', 'idea-test-1', LOCAL)
        addDisk(h, 'd-twin', 'IDEA Disk', 'idea-test-2', LOCAL)
        addDisk(h, 'd-solo', 'Solo', 'idea-test-3', LOCAL)
        addDisk(h, 'd-stale', 'Solo', null, null)
        addDisk(h, 'd-gone', 'Gone', null, null)
        addDisk(h, 'd-remote', 'Remote', 'idea-test-4', OTHER)
        addDisk(h, 'd-sys', 'System Disk', 'idea-test-5', LOCAL, ['system'])
    })
    afterEach(() => warn.mockRestore())

    it('id: resolves the record, no warning (two docked "IDEA Disk"s are no longer ambiguous)', () => {
        expect(resolveDiskArg(h.doc()!, LOCAL, 'd-twin', 'installApp').id).toBe('d-twin')
        expect(warn).not.toHaveBeenCalled()
    })
    it('unique docked name: resolves with a deprecation warning naming the command and disk; stale same-name records ignored', () => {
        expect(resolveDiskArg(h.doc()!, LOCAL, 'Solo', 'createBackupDisk').id).toBe('d-solo')
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/createBackupDisk: disk 'Solo' was given by name; use the disk id d-solo/))
    })
    it('ambiguous name: refused, listing the ids', () => {
        expect(() => resolveDiskArg(h.doc()!, LOCAL, 'IDEA Disk', 'installApp')).toThrow(/ambiguous: d-live \(idea-test-1\), d-twin \(idea-test-2\)/)
    })
    it('undocked (by id or name): refused', () => {
        expect(() => resolveDiskArg(h.doc()!, LOCAL, 'd-gone', 'installApp')).toThrow(/not currently docked/)
        expect(() => resolveDiskArg(h.doc()!, LOCAL, 'Gone', 'installApp')).toThrow(/not currently docked/)
    })
    it('docked to another engine (by id or name): refused', () => {
        expect(() => resolveDiskArg(h.doc()!, LOCAL, 'd-remote', 'installApp')).toThrow(/not docked to this engine/)
        expect(() => resolveDiskArg(h.doc()!, LOCAL, 'Remote', 'installApp')).toThrow(/not docked to this engine/)
    })
    it('not found: refused', () => {
        expect(lookupDiskArg(h.doc()!, LOCAL, 'nope')).toEqual({ ok: false, message: "Disk 'nope' not found." })
    })
    it('system disk: resolves (valid installApp target), but ejectDisk refuses it', async () => {
        expect(resolveDiskArg(h.doc()!, LOCAL, 'd-sys', 'installApp').id).toBe('d-sys')
        const log = newLog()
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        await handleCommand(commands, h, 'engine', 'ejectDisk d-sys', log)
        err.mockRestore()
        expect(lastTrace(log).status).toBe('error')
        expect(lastTrace(log).errorMessage).toContain('system disk')
        expect(h.doc()!.diskDB['d-sys' as DiskID].dockedTo).toBe(LOCAL)
    })
    it('ejectDisk by a unique name still works and warns', async () => {
        await handleCommand(commands, h, 'engine', 'ejectDisk Solo')
        expect(h.doc()!.diskDB['d-solo' as DiskID].device).toBeNull()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("ejectDisk: disk 'Solo' was given by name"))
    })
})

// ── installApp ───────────────────────────────────────────────────────────────

describe('installApp <appId> <targetDiskId> [--source <sourceDiskId>] (idea#128)', () => {
    let h: DocHandle<Store>
    let warn: ReturnType<typeof vi.spyOn>
    let err: ReturnType<typeof vi.spyOn>
    let src: string, tgt: string, twin: string
    beforeEach(async () => {
        h = await newStore()
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        src = uniqueTestDevice(); tgt = uniqueTestDevice(); twin = uniqueTestDevice()
        for (const d of [src, tgt, twin]) await fs.ensureDir(`${DISKS_ROOT}/${d}`)
        addDisk(h, 'src-id', 'Catalog', src, LOCAL)
        addDisk(h, 'tgt-id', 'IDEA_Disk', tgt, LOCAL)
        addDisk(h, 'twin-id', 'IDEA_Disk', twin, LOCAL)
        addDisk(h, 'gone-id', 'Gone', null, null)
        addDisk(h, 'remote-id', 'Remote', 'idea-test-9', OTHER)
    })
    afterEach(async () => {
        warn.mockRestore(); err.mockRestore()
        for (const d of [src, tgt, twin]) await fs.remove(`${DISKS_ROOT}/${d}`)
    })

    const run = async (cmd: string) => { const log = newLog(); await handleCommand(commands, h, 'engine', cmd, log); return lastTrace(log) }

    it('by id: source and target resolve by id (reaches the copy: app bundle missing on the source)', async () => {
        const t = await run('installApp kolibri-1.0 tgt-id --source src-id --name my-kolibri')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toContain(`App 'kolibri-1.0' not found on disk 'Catalog' at ${DISKS_ROOT}/${src}/apps/kolibri-1.0`)
        expect(warn).not.toHaveBeenCalled()
    })
    it('by id: installs from the source onto the chosen one of two same-named disks', async () => {
        await fs.ensureDir(`${DISKS_ROOT}/${src}/apps/demo-1.0`)
        await fs.writeFile(`${DISKS_ROOT}/${src}/apps/demo-1.0/compose.yaml`, 'x-app:\n  name: demo\n  version: "1.0"\n')
        await run('installApp demo-1.0 twin-id --source src-id')
        expect(await fs.pathExists(`${DISKS_ROOT}/${twin}/apps/demo-1.0/compose.yaml`)).toBe(true)
        expect(await fs.pathExists(`${DISKS_ROOT}/${tgt}/apps/demo-1.0`)).toBe(false)
    })
    it('by name: a unique source name resolves with a deprecation warning', async () => {
        const t = await run('installApp kolibri-1.0 tgt-id --source Catalog')
        expect(t.errorMessage).toContain("not found on disk 'Catalog'")
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("installApp --source: disk 'Catalog' was given by name"))
    })
    it('ambiguous target name: refused, trace error, nothing written', async () => {
        const t = await run('installApp kolibri-1.0 IDEA_Disk --source src-id')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toContain("Disk name 'IDEA_Disk' is ambiguous")
        expect(await fs.pathExists(`${DISKS_ROOT}/${tgt}/apps`)).toBe(false)
        expect(await fs.pathExists(`${DISKS_ROOT}/${twin}/apps`)).toBe(false)
    })
    it('undocked or other-engine target / source: refused (no fallback to those records)', async () => {
        expect((await run('installApp kolibri-1.0 gone-id --source src-id')).errorMessage).toContain('not currently docked')
        expect((await run('installApp kolibri-1.0 Gone --source src-id')).errorMessage).toContain('not currently docked')
        expect((await run('installApp kolibri-1.0 remote-id --source src-id')).errorMessage).toContain('not docked to this engine')
        expect((await run('installApp kolibri-1.0 tgt-id --source remote-id')).errorMessage).toContain('not docked to this engine')
    })
    it('usage errors end the trace as error', async () => {
        expect((await run('installApp kolibri-1.0')).status).toBe('error')
        expect((await run('installApp kolibri-1.0 tgt-id --source')).errorMessage).toContain('--source needs a value')
    })
})

// ── createBackupDisk by name ─────────────────────────────────────────────────

describe('createBackupDisk <diskId> <mode> <instanceName…> (idea#128)', () => {
    let h: DocHandle<Store>
    let warn: ReturnType<typeof vi.spyOn>
    let err: ReturnType<typeof vi.spyOn>
    let dev: string
    beforeEach(async () => {
        h = await newStore()
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        dev = uniqueTestDevice()
        await fs.ensureDir(`${DISKS_ROOT}/${dev}`)
        addDisk(h, 'bk-id', 'Backups', dev, LOCAL)
        h.change(doc => { doc.instanceDB['INST_k' as InstanceID] = { id: 'INST_k', name: 'kolibri', storedOn: 'bk-id' } as any })
    })
    afterEach(async () => { warn.mockRestore(); err.mockRestore(); await fs.remove(`${DISKS_ROOT}/${dev}`) })

    it('by a unique name: configured, with a deprecation warning', async () => {
        await handleCommand(commands, h, 'engine', 'createBackupDisk Backups on-demand kolibri')
        expect(await fs.pathExists(`${DISKS_ROOT}/${dev}/BACKUP.yaml`)).toBe(true)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("createBackupDisk: disk 'Backups' was given by name; use the disk id bk-id"))
    })
    it('refusals throw: ambiguous name, other engine, bad mode → trace error, nothing written', async () => {
        addDisk(h, 'bk-twin', 'Backups', 'idea-test-8', LOCAL)
        addDisk(h, 'bk-remote', 'R', 'idea-test-7', OTHER)
        for (const cmd of ['createBackupDisk Backups on-demand kolibri', 'createBackupDisk bk-remote on-demand kolibri', 'createBackupDisk bk-id sometimes kolibri']) {
            const log = newLog()
            await handleCommand(commands, h, 'engine', cmd, log)
            expect(lastTrace(log).status).toBe('error')
        }
        expect(await fs.pathExists(`${DISKS_ROOT}/${dev}/BACKUP.yaml`)).toBe(false)
    })
})

// ── optional variadic ────────────────────────────────────────────────────────

describe('optional variadic last arg (idea#128)', () => {
    const seen: any[][] = []
    const testCommands: CommandDefinition[] = [{
        name: 'testOptional',
        execute: async (_h, ...args: any[]) => { seen.push(args) },
        args: [{ type: 'string', name: 'diskId' }, { type: 'string', name: 'shareName', variadic: true, optional: true }],
        scope: 'engine',
    }]
    beforeEach(() => { seen.length = 0 })

    it('accepts zero tokens and records [] in the trace', async () => {
        const log = newLog()
        await handleCommand(testCommands, null, 'engine', 'testOptional disk-1', log)
        expect(seen).toEqual([['disk-1']])
        expect(JSON.parse(lastTrace(log).args)).toEqual({ diskId: 'disk-1', shareName: [] })
    })
    it('takes the rest of the line as tokens', async () => {
        await handleCommand(testCommands, null, 'engine', 'testOptional disk-1 My Share (2)')
        expect(seen).toEqual([['disk-1', 'My', 'Share', '(2)']])
    })
    it('the required args before it are still required', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        await handleCommand(testCommands, null, 'engine', 'testOptional')
        expect(err).toHaveBeenCalledWith('Error: Insufficient arguments')
        err.mockRestore()
        expect(seen).toEqual([])
    })
})

// ── capabilities ─────────────────────────────────────────────────────────────

describe('capabilities and capabilitiesBootedAt (idea#128)', () => {
    it('a new engine record gets capabilities [diskIdArgs, filesDisk] stamped with its lastBooted', async () => {
        const h = await newStore()
        const e = h.doc()!.engineDB[LOCAL]
        expect(ENGINE_CAPABILITIES).toEqual(['diskIdArgs', 'filesDisk'])   // filesDisk: idea#131
        expect(e.capabilities).toEqual(['diskIdArgs', 'filesDisk'])
        expect(e.capabilitiesBootedAt).toBe(e.lastBooted)
    })
    it('every startup rewrites the whole list (stale/extra entries gone) and re-stamps it with the new lastBooted', async () => {
        const h = await newStore()
        h.change(doc => {
            const e = doc.engineDB[LOCAL]
            e.capabilities = ['stale-thing', 'diskIdArgs']
            e.capabilitiesBootedAt = 5 as Timestamp
            e.lastBooted = 5 as Timestamp
        })
        await new Promise(r => setTimeout(r, 5))
        await createOrUpdateEngine(h, LOCAL)
        const e = h.doc()!.engineDB[LOCAL]
        expect(e.capabilities).toEqual(['diskIdArgs', 'filesDisk'])
        expect(e.lastBooted).toBeGreaterThan(5)
        expect(e.capabilitiesBootedAt).toBe(e.lastBooted)
    })
    it('a rolled-back Engine (rewrites lastBooted only) no longer matches the stamp', async () => {
        const h = await newStore()
        h.change(doc => { doc.engineDB[LOCAL].lastBooted = (doc.engineDB[LOCAL].lastBooted + 1000) as Timestamp })
        const e = h.doc()!.engineDB[LOCAL]
        const consoleSees = e.capabilities?.includes('diskIdArgs') === true && e.capabilitiesBootedAt === e.lastBooted
        expect(consoleSees).toBe(false)
    })
    it('pm2.config.cjs sets kill_timeout: 10000', () => {
        const cfg = createRequire(import.meta.url)(path.join(process.cwd(), 'pm2.config.cjs'))
        expect(cfg.apps[0].kill_timeout).toBe(10000)
    })
})
