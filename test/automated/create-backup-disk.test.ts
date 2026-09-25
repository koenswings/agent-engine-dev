/**
 * create-backup-disk.test.ts
 *
 * Tests the createBackupDisk command (idea#101) and the variadic trailing
 * argument support in handleCommand that it relies on:
 *   - Parser: variadic last arg accepts 1 or more tokens, rejects 0, and is
 *     recorded as an array in the named trace args
 *   - createBackupDisk end to end via handleCommand: 1 instance, 2+ instances,
 *     bad mode, unknown disk
 *
 * No physical hardware required — the disk is a /disks/<device>/ directory
 * (same paths the production code uses) and disk state is set up in the store.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { CommandDefinition } from '../../src/data/CommandDefinition.js'
import { CommandLogStore } from '../../src/data/CommandLogStore.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { fs, YAML } from 'zx'
import { randomUUID } from 'crypto'

// ── helpers ──────────────────────────────────────────────────────────────────

const createMinimalStore = async (): Promise<{ repo: Repo; storeHandle: DocHandle<Store> }> => {
    const repo = new Repo({ network: [], storage: undefined })
    const storeHandle = repo.create<Store>({
        engineDB: {},
        diskDB: {},
        appDB: {},
        instanceDB: {},
        userDB: {},
        operationDB: {},
    })
    await storeHandle.whenReady()
    await createOrUpdateEngine(storeHandle, localEngineId)
    return { repo, storeHandle }
}

const addDockedDisk = (storeHandle: DocHandle<Store>, diskId: DiskID, diskName: DiskName, device: string): void => {
    storeHandle.change(doc => {
        doc.diskDB[diskId] = {
            id: diskId,
            name: diskName,
            device: device as any,
            dockedTo: localEngineId as EngineID,
            created: Date.now() as Timestamp,
            lastDocked: Date.now() as Timestamp,
            diskTypes: [],
            backupConfig: null,
        }
    })
}

const addInstance = (storeHandle: DocHandle<Store>, instanceId: InstanceID, name: string, diskId: DiskID): void => {
    storeHandle.change(doc => {
        doc.instanceDB[instanceId] = {
            id: instanceId,
            instanceOf: 'sample-app' as any,
            name: name as any,
            status: 'Stopped' as any,
            port: 8080 as any,
            serviceImages: [],
            created: Date.now() as Timestamp,
            lastBackup: null,
            lastStarted: Date.now() as Timestamp,
            statusCondition: null,
            storedOn: diskId,
            currentStep: null,
            totalSteps: null,
            stepLabel: null,
            metrics: null,
        }
    })
}

const createCommandLog = async (repo: Repo): Promise<DocHandle<CommandLogStore>> => {
    const handle = repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] } as any)
    await handle.whenReady()
    return handle
}

// ── parser: variadic trailing argument ───────────────────────────────────────

describe('handleCommand — variadic trailing argument', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>
    let execute: ReturnType<typeof vi.fn<CommandDefinition['execute']>>
    let testCommands: CommandDefinition[]

    beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        execute = vi.fn<CommandDefinition['execute']>()
        testCommands = [
            {
                name: 'multi',
                execute,
                args: [{ type: 'string', name: 'first' }, { type: 'string', name: 'rest', variadic: true }],
                scope: 'engine',
            },
            {
                name: 'only',
                execute,
                args: [{ type: 'string', name: 'items', variadic: true }],
                scope: 'engine',
            },
        ]
    })

    afterEach(() => {
        errorSpy.mockRestore()
    })

    it('passes a single variadic token as one argument', async () => {
        await handleCommand(testCommands, null, 'engine', 'multi a b')
        expect(execute).toHaveBeenCalledWith(null, 'a', 'b')
    })

    it('passes 2+ variadic tokens as separate arguments', async () => {
        await handleCommand(testCommands, null, 'engine', 'multi a b c d')
        expect(execute).toHaveBeenCalledWith(null, 'a', 'b', 'c', 'd')
    })

    it('ignores repeated spaces between tokens', async () => {
        await handleCommand(testCommands, null, 'engine', 'multi  a   b  c ')
        expect(execute).toHaveBeenCalledWith(null, 'a', 'b', 'c')
    })

    it('requires at least one variadic token', async () => {
        await handleCommand(testCommands, null, 'engine', 'multi a')
        expect(execute).not.toHaveBeenCalled()
        expect(errorSpy).toHaveBeenCalledWith('Error: Insufficient arguments')
    })

    it('splits tokens when the only arg is variadic (no rest-of-line special case)', async () => {
        await handleCommand(testCommands, null, 'engine', 'only x y')
        expect(execute).toHaveBeenCalledWith(null, 'x', 'y')
    })

    it('records the variadic arg as an array in the named trace args', async () => {
        const repo = new Repo({ network: [], storage: undefined })
        const logHandle = await createCommandLog(repo)
        await handleCommand(testCommands, null, 'engine', 'multi a b c', logHandle)
        const traces = Object.values(logHandle.doc()!.traces)
        expect(traces).toHaveLength(1)
        expect(JSON.parse(traces[0].args)).toEqual({ first: 'a', rest: ['b', 'c'] })
    })

    it('still rejects extra args for commands without a variadic arg', async () => {
        const fixed: CommandDefinition[] = [{
            name: 'fixed', execute,
            args: [{ type: 'string', name: 'a' }, { type: 'string', name: 'b' }],
            scope: 'engine',
        }]
        await handleCommand(fixed, null, 'engine', 'fixed 1 2 3')
        expect(execute).not.toHaveBeenCalled()
        expect(errorSpy).toHaveBeenCalledWith('Error: Too many arguments')
    })
})

// ── createBackupDisk command ─────────────────────────────────────────────────

describe('createBackupDisk command', () => {
    let storeHandle: DocHandle<Store>
    let repo: Repo
    let device: string
    let errorSpy: ReturnType<typeof vi.spyOn>
    const diskId = 'DISK_backup_test' as DiskID
    const diskName = 'backup-disk' as DiskName

    const readBackupYaml = async () =>
        YAML.parse(await fs.readFile(`/disks/${device}/BACKUP.yaml`, 'utf-8'))

    beforeEach(async () => {
        const ctx = await createMinimalStore()
        storeHandle = ctx.storeHandle
        repo = ctx.repo
        device = `test-cbd-${randomUUID().slice(0, 8)}`
        await fs.ensureDir(`/disks/${device}`)
        addDockedDisk(storeHandle, diskId, diskName, device)
        addInstance(storeHandle, 'INST_kolibri' as InstanceID, 'kolibri', diskId)
        addInstance(storeHandle, 'INST_nextcloud' as InstanceID, 'nextcloud', diskId)
        addInstance(storeHandle, 'INST_wikipedia' as InstanceID, 'wikipedia', diskId)
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(async () => {
        errorSpy.mockRestore()
        await fs.remove(`/disks/${device}`)
    })

    it('declares diskName, mode and a variadic instanceNames arg', () => {
        const cmd = commands.find(c => c.name === 'createBackupDisk')!
        expect(cmd.args.map(a => a.name)).toEqual(['diskName', 'mode', 'instanceNames'])
        expect(cmd.args[2].variadic).toBe(true)
    })

    it('configures a Backup Disk with 1 instance', async () => {
        await handleCommand(commands, storeHandle, 'engine', `createBackupDisk ${diskName} on-demand kolibri`)
        expect(errorSpy).not.toHaveBeenCalled()
        const yaml = await readBackupYaml()
        expect(yaml.mode).toBe('on-demand')
        expect(yaml.links.map((l: any) => l.instanceId)).toEqual(['INST_kolibri'])
        const disk = storeHandle.doc()!.diskDB[diskId]
        expect(disk.diskTypes).toContain('backup')
        expect(disk.backupConfig?.links).toEqual(['INST_kolibri'])
    })

    it('configures a Backup Disk with 2+ instances', async () => {
        await handleCommand(commands, storeHandle, 'engine',
            `createBackupDisk ${diskName} on-demand kolibri nextcloud wikipedia`)
        expect(errorSpy).not.toHaveBeenCalled()
        const yaml = await readBackupYaml()
        expect(yaml.mode).toBe('on-demand')
        expect(yaml.links.map((l: any) => l.instanceId))
            .toEqual(['INST_kolibri', 'INST_nextcloud', 'INST_wikipedia'])
        const disk = storeHandle.doc()!.diskDB[diskId]
        expect(disk.backupConfig?.links).toEqual(['INST_kolibri', 'INST_nextcloud', 'INST_wikipedia'])
    })

    it('records correctly named trace args', async () => {
        const logHandle = await createCommandLog(repo)
        await handleCommand(commands, storeHandle, 'engine',
            `createBackupDisk ${diskName} on-demand kolibri nextcloud`, logHandle)
        const traces = Object.values(logHandle.doc()!.traces).filter(t => t.command === 'createBackupDisk')
        expect(traces).toHaveLength(1)
        expect(JSON.parse(traces[0].args))
            .toEqual({ diskName: 'backup-disk', mode: 'on-demand', instanceNames: ['kolibri', 'nextcloud'] })
        expect(traces[0].status).toBe('ok')
    })

    it('rejects the command when no instance is given', async () => {
        await handleCommand(commands, storeHandle, 'engine', `createBackupDisk ${diskName} on-demand`)
        expect(errorSpy).toHaveBeenCalledWith('Error: Insufficient arguments')
        expect(await fs.pathExists(`/disks/${device}/BACKUP.yaml`)).toBe(false)
    })

    it('rejects an invalid mode', async () => {
        await handleCommand(commands, storeHandle, 'engine', `createBackupDisk ${diskName} sometimes kolibri nextcloud`)
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid mode 'sometimes'"))
        expect(await fs.pathExists(`/disks/${device}/BACKUP.yaml`)).toBe(false)
    })

    it('rejects an unknown disk', async () => {
        await handleCommand(commands, storeHandle, 'engine', 'createBackupDisk no-such-disk on-demand kolibri nextcloud')
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Disk 'no-such-disk' not found or not docked"))
        expect(await fs.pathExists(`/disks/${device}/BACKUP.yaml`)).toBe(false)
    })
})
