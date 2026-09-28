/**
 * meta-first-dock.test.ts
 *
 * idea#121: a disk docked without META.yaml gets one written on its first dock,
 * so its diskId stays the same on every later dock. Before this fix a disk
 * without a readable hardware serial got a new random id on every dock and left
 * an orphan diskDB entry behind.
 *
 * testMode normally skips the write (skipMetaWrite() follows testMode, like
 * readMetaUpdateId). These tests set settings.skipMetaWrite = false to run the
 * real write on fixture disks without META.yaml.
 *
 * Also unit-tests the orphan rule used by script/cleanup-store.ts.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import { fs, path, YAML } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { CommandLogStore, CommandTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { config, skipMetaWrite } from '../../src/data/Config.js'
import { localEngineId } from '../../src/data/Engine.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import { DISK_DETECTION_COMMAND } from '../../src/monitors/diskDetection.js'
import { findOrphanDiskIds } from '../../script/cleanup-store-lib.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    waitFor,
    uniqueTestDevice,
    diskPath,
    sentinelPath,
} from '../harness/diskSim.js'

const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] =>
    h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])

const disksOnDevice = (store: Store, device: string) =>
    Object.values(store.diskDB).filter(d => d.device === device && d.dockedTo === localEngineId)

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('META.yaml is written on the first dock (idea#121)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    const logHandle = newCommandLog()
    const savedSkip = config.settings.skipMetaWrite
    const devices: string[] = []
    let fixtureDir = ''

    beforeAll(async () => {
        // A disk with some content but no META.yaml and no apps (no Docker needed)
        fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-121-fixture-'))
        await fs.writeFile(path.join(fixtureDir, 'README.txt'), 'A disk that was never docked before\n')
        config.settings.skipMetaWrite = false
        setCommandLogHandle(logHandle)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    }, 15_000)

    afterAll(async () => {
        await watcher?.close()
        for (const device of devices) {
            await fs.remove(sentinelPath(device)).catch(() => {})
            await fs.chmod(diskPath(device), 0o755).catch(() => {})
            await cleanupDisk(device).catch(() => {})
        }
        if (fixtureDir) await fs.remove(fixtureDir).catch(() => {})
        setCommandLogHandle(null)
        config.settings.skipMetaWrite = savedSkip
    })

    it('skipMetaWrite() follows testMode unless settings.skipMetaWrite is set', () => {
        const saved = config.settings.skipMetaWrite
        try {
            config.settings.skipMetaWrite = undefined
            expect(skipMetaWrite()).toBe(config.settings.testMode)
            config.settings.skipMetaWrite = false
            expect(skipMetaWrite()).toBe(false)
            config.settings.skipMetaWrite = true
            expect(skipMetaWrite()).toBe(true)
        } finally {
            config.settings.skipMetaWrite = saved
        }
    })

    it('docking a fixture without META.yaml writes one', { timeout: 20_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)
        const metaPath = path.join(diskPath(device), 'META.yaml')

        await dockFixture(fixtureDir, device)
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)

        const disk = disksOnDevice(storeHandle.doc()!, device)[0]
        expect(fs.existsSync(metaPath)).toBe(true)
        const meta = YAML.parse(await fs.readFile(metaPath, 'utf-8'))
        expect(meta.diskId).toBe(disk.id)
        expect(meta.diskName).toBe(disk.name)
        expect(typeof meta.created).toBe('number')
    })

    it('a second dock of the same disk gives the same diskId', { timeout: 30_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)

        await dockFixture(fixtureDir, device)
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)
        const firstId = disksOnDevice(storeHandle.doc()!, device)[0].id

        await triggerUndock(device)
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 0)).toBe(true)

        // Re-dock the same disk content (META.yaml written by the first dock stays)
        await fs.writeFile(sentinelPath(device), '')
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)
        const secondId = disksOnDevice(storeHandle.doc()!, device)[0].id

        expect(secondId).toBe(firstId)
        // No second diskDB entry for the same disk
        const store = storeHandle.doc()!
        const entries = Object.values(store.diskDB).filter(d => d.id === firstId)
        expect(entries).toHaveLength(1)
        expect(Object.keys(store.diskDB).filter(id => id === firstId)).toHaveLength(1)
    })

    it.skipIf(isRoot)('an unwritable fixture records a detection failure and is still registered', { timeout: 20_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)
        const target = diskPath(device)

        // Read-only disk (like a root-owned or read-only mount): content, no META.yaml
        await fs.ensureDir(target)
        await fs.copy(fixtureDir, target)
        await fs.chmod(target, 0o555)
        await fs.ensureDir(path.dirname(sentinelPath(device)))
        await fs.writeFile(sentinelPath(device), '')

        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)
        expect(fs.existsSync(path.join(target, 'META.yaml'))).toBe(false)

        const failure = traces(logHandle).find(t => {
            if (t.command !== DISK_DETECTION_COMMAND) return false
            const args = JSON.parse(t.args)
            return args.step === 'writeMeta' && args.device === device
        })
        expect(failure, 'failed writeMeta trace').toBeDefined()
        expect(failure!.status).toBe('error')
        expect(failure!.errorMessage).toContain('Could not write META.yaml')
        const disk = disksOnDevice(storeHandle.doc()!, device)[0]
        expect(JSON.parse(failure!.args).diskId).toBe(disk.id)
    })
})

describe('cleanup-store orphan disk entries (idea#121)', () => {
    const base = { name: 'Unnamed Disk', created: 1, lastDocked: 1, diskTypes: [], backupConfig: null }

    it('only undocked, unreferenced, non-system, non-backup disks are orphans', () => {
        const store = {
            engineDB: { ENGINE_sys1: {} },
            diskDB: {
                orphan1: { ...base, id: 'orphan1', device: null, dockedTo: null },
                orphan2: { ...base, id: 'orphan2', device: null, dockedTo: null },
                docked: { ...base, id: 'docked', device: 'sda1', dockedTo: 'ENGINE_sys1' },
                sys1: { ...base, id: 'sys1', device: null, dockedTo: null },
                sysType: { ...base, id: 'sysType', device: null, dockedTo: null, diskTypes: ['system'] },
                withApp: { ...base, id: 'withApp', device: null, dockedTo: null },
                backup: { ...base, id: 'backup', device: null, dockedTo: null, backupConfig: { mode: 'copy', links: [] } },
                inOp: { ...base, id: 'inOp', device: null, dockedTo: null },
            },
            instanceDB: { i1: { storedOn: 'withApp' } },
            operationDB: { op1: { args: { targetDiskId: 'inOp' } } },
        }
        expect(findOrphanDiskIds(store).sort()).toEqual(['orphan1', 'orphan2'])
    })

    it('an empty store has no orphans', () => {
        expect(findOrphanDiskIds({})).toEqual([])
    })
})
