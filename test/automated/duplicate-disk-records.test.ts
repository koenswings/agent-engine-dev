/**
 * duplicate-disk-records.test.ts (idea#152)
 *
 * On idea03 an old failed undock left a stale record `system-boot` (undocked in
 * the end, but for a while still docked) next to the live record for the same
 * USB partition. `ejectDisk <name>` took the first record by name and refused
 * ("not currently docked") while the live disk stayed mounted.
 *
 * Covers:
 *   - ejectDisk resolves by disk id; the name fallback only counts records
 *     docked to this engine with a device and refuses an ambiguous name
 *   - refusals end the command trace as `error` (the Console can show them)
 *   - createOrUpdateDisk undocks other records on the same engine+device
 *   - device removal undocks every record on the device
 *   - startup keeps the record META.yaml names when several share a device
 *   - eject → re-plug round trip through the usbDeviceMonitor harness
 *
 * testMode: no sudo, no mount; pretend disks live in the harness temp folders.
 */

import { describe, it, beforeEach, afterEach, beforeAll, afterAll, expect, vi } from 'vitest'
import os from 'os'
import { fs, path, YAML } from 'zx'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store, findDisksByDevice } from '../../src/data/Store.js'
import { createOrUpdateDisk, clearDuplicateDiskRecords } from '../../src/data/Disk.js'
import { localEngineId } from '../../src/data/Engine.js'
import { commands, resolveEjectTarget } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import {
    enableUsbDeviceMonitor,
    undockAllOnDevice,
    resolveDuplicateDisksOnDevice,
    readMetaDiskIdOnDevice,
} from '../../src/monitors/usbDeviceMonitor.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
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

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID

const addDisk = (h: DocHandle<Store>, id: string, name: string, device: string | null, dockedTo: EngineID | null, diskTypes: any[] = ['empty']) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID,
            name: name as DiskName,
            device: device as DeviceName | null,
            dockedTo,
            created: Date.now() as Timestamp,
            lastDocked: Date.now() as Timestamp,
            diskTypes: device ? diskTypes : [],
            backupConfig: null,
        }
    })
}
const disk = (h: DocHandle<Store>, id: string) => h.doc()!.diskDB[id as DiskID]
const isDocked = (h: DocHandle<Store>, id: string) => disk(h, id).device !== null && disk(h, id).dockedTo !== null

const newCommandLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

// ── ejectDisk resolution ─────────────────────────────────────────────────────

describe('ejectDisk resolves by disk id; name fallback only for docked records (idea#152)', () => {
    let h: DocHandle<Store>
    let errSpy: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
        h = (await createTestStore()).storeHandle
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => errSpy.mockRestore())

    it('by id: ejects the live record even when a same-name stale record sorts first', async () => {
        addDisk(h, 'a-stale', 'system-boot', null, null)
        addDisk(h, 'b-live', 'system-boot', 'idea-test-1', LOCAL)
        await handleCommand(commands, h, 'engine', 'ejectDisk b-live')
        expect(isDocked(h, 'b-live')).toBe(false)
        expect(errSpy).not.toHaveBeenCalled()
    })

    it('by name: docked + undocked sibling picks the docked one (the idea03 case)', async () => {
        addDisk(h, 'a-stale', 'system-boot', null, null)
        addDisk(h, 'b-live', 'system-boot', 'idea-test-1', LOCAL)
        expect(resolveEjectTarget(h.doc()!, 'system-boot', LOCAL)).toMatchObject({ ok: true, disk: { id: 'b-live' } })
        await handleCommand(commands, h, 'engine', 'ejectDisk system-boot')
        expect(isDocked(h, 'b-live')).toBe(false)
        expect(errSpy).not.toHaveBeenCalled()
    })

    it('by name: two docked records with that name are refused as ambiguous; nothing is ejected; trace ends as error', async () => {
        addDisk(h, 'a-one', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'b-two', 'system-boot', 'idea-test-2', LOCAL)
        const log = newCommandLog()
        await handleCommand(commands, h, 'engine', 'ejectDisk system-boot', log)
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ambiguous'))
        expect(isDocked(h, 'a-one')).toBe(true)
        expect(isDocked(h, 'b-two')).toBe(true)
        const trace = lastTrace(log)
        expect(trace.command).toBe('ejectDisk')
        expect(trace.status).toBe('error')
        expect(trace.errorMessage).toContain('ambiguous')
        expect(trace.errorMessage).toContain('a-one')
    })

    it('by name: records docked to another engine do not count', async () => {
        addDisk(h, 'a-remote', 'shared', 'idea-test-1', OTHER)
        addDisk(h, 'b-local', 'shared', 'idea-test-2', LOCAL)
        await handleCommand(commands, h, 'engine', 'ejectDisk shared')
        expect(isDocked(h, 'b-local')).toBe(false)
        expect(isDocked(h, 'a-remote')).toBe(true)
    })

    it('refusals: undocked id, remote id, unknown name, only-undocked name, only-remote name', () => {
        addDisk(h, 'u1', 'gone', null, null)
        addDisk(h, 'r1', 'remote', 'idea-test-3', OTHER)
        const s = h.doc()!
        expect(resolveEjectTarget(s, 'u1', LOCAL)).toMatchObject({ ok: false, message: expect.stringContaining('not currently docked') })
        expect(resolveEjectTarget(s, 'r1', LOCAL)).toMatchObject({ ok: false, message: expect.stringContaining('not docked to this engine') })
        expect(resolveEjectTarget(s, 'nope', LOCAL)).toMatchObject({ ok: false, message: expect.stringContaining('not found') })
        expect(resolveEjectTarget(s, 'gone', LOCAL)).toMatchObject({ ok: false, message: expect.stringContaining('not currently docked') })
        expect(resolveEjectTarget(s, 'remote', LOCAL)).toMatchObject({ ok: false, message: expect.stringContaining('not docked to this engine') })
    })

    it('eject by id also undocks a stale record that still claims the same device; other devices and engines untouched', async () => {
        addDisk(h, 'a-stale', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'b-live', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'c-other-dev', 'writable', 'idea-test-2', LOCAL)
        addDisk(h, 'd-other-eng', 'x', 'idea-test-1', OTHER)
        await handleCommand(commands, h, 'engine', 'ejectDisk b-live')
        expect(isDocked(h, 'b-live')).toBe(false)
        expect(isDocked(h, 'a-stale')).toBe(false)
        expect(isDocked(h, 'c-other-dev')).toBe(true)
        expect(isDocked(h, 'd-other-eng')).toBe(true)
    })
})

// ── dock / removal / startup dedupe ──────────────────────────────────────────

describe('duplicate records on one device are cleared on dock, removal and startup (idea#152)', () => {
    let h: DocHandle<Store>
    beforeEach(async () => { h = (await createTestStore()).storeHandle })

    it('createOrUpdateDisk undocks other records on the same engine+device only', () => {
        addDisk(h, 'stale', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'other-dev', 'writable', 'idea-test-2', LOCAL)
        addDisk(h, 'other-eng', 'x', 'idea-test-1', OTHER)
        createOrUpdateDisk(h, LOCAL, 'idea-test-1' as DeviceName, 'live' as DiskID, 'system-boot' as DiskName, Date.now() as Timestamp)
        expect(isDocked(h, 'live')).toBe(true)
        expect(disk(h, 'stale')).toMatchObject({ device: null, dockedTo: null, diskTypes: [], backupConfig: null })
        expect(isDocked(h, 'other-dev')).toBe(true)
        expect(isDocked(h, 'other-eng')).toBe(true)
        expect(findDisksByDevice(h.doc()!, 'idea-test-1' as DeviceName, LOCAL).map(d => d.id)).toEqual(['live'])
    })

    it('re-docking the same record keeps it (clearDuplicateDiskRecords never clears the kept id)', () => {
        addDisk(h, 'live', 'system-boot', 'idea-test-1', LOCAL)
        let cleared: DiskID[] = []
        h.change(doc => { cleared = clearDuplicateDiskRecords(doc, LOCAL, 'idea-test-1' as DeviceName, 'live' as DiskID) })
        expect(cleared).toEqual([])
        expect(isDocked(h, 'live')).toBe(true)
    })

    it('removal undocks every record on the device, not just the first', async () => {
        addDisk(h, 'a', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'b', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'c', 'writable', 'idea-test-2', LOCAL)
        addDisk(h, 'd', 'x', 'idea-test-1', OTHER)
        const undocked = await undockAllOnDevice(h, LOCAL, 'idea-test-1' as DeviceName)
        expect(undocked.sort()).toEqual(['a', 'b'])
        expect(isDocked(h, 'a')).toBe(false)
        expect(isDocked(h, 'b')).toBe(false)
        expect(isDocked(h, 'c')).toBe(true)
        expect(isDocked(h, 'd')).toBe(true)
        expect(await undockAllOnDevice(h, LOCAL, 'idea-test-9' as DeviceName)).toEqual([])
    })

    it('startup keeps the record META.yaml names and undocks the rest', async () => {
        addDisk(h, 'stale', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'live', 'system-boot', 'idea-test-1', LOCAL)
        const cleared = await resolveDuplicateDisksOnDevice(h, LOCAL, 'idea-test-1' as DeviceName, async () => 'live' as DiskID)
        expect(cleared).toEqual(['stale'])
        expect(isDocked(h, 'live')).toBe(true)
        expect(isDocked(h, 'stale')).toBe(false)
    })

    it('startup without a matching META.yaml changes nothing (the dock resolves it); a single record is left alone', async () => {
        addDisk(h, 'x1', 'system-boot', 'idea-test-1', LOCAL)
        addDisk(h, 'x2', 'system-boot', 'idea-test-1', LOCAL)
        expect(await resolveDuplicateDisksOnDevice(h, LOCAL, 'idea-test-1' as DeviceName, async () => null)).toEqual([])
        expect(await resolveDuplicateDisksOnDevice(h, LOCAL, 'idea-test-1' as DeviceName, async () => 'unknown' as DiskID)).toEqual([])
        expect(isDocked(h, 'x1') && isDocked(h, 'x2')).toBe(true)
        addDisk(h, 'solo', 'w', 'idea-test-2', LOCAL)
        const reader = vi.fn(async () => 'other' as DiskID)
        expect(await resolveDuplicateDisksOnDevice(h, LOCAL, 'idea-test-2' as DeviceName, reader)).toEqual([])
        expect(reader).not.toHaveBeenCalled()
        expect(isDocked(h, 'solo')).toBe(true)
    })

    it('readMetaDiskIdOnDevice reads diskId from <disksRoot>/<device>/META.yaml without changing it', async () => {
        const device = uniqueTestDevice()
        await fs.ensureDir(diskPath(device))
        try {
            expect(await readMetaDiskIdOnDevice(device as DeviceName)).toBeNull()
            const text = YAML.stringify({ diskId: 'meta-id-1', diskName: 'system-boot', created: 1, lastDocked: 2 })
            await fs.writeFile(path.join(diskPath(device), 'META.yaml'), text)
            expect(await readMetaDiskIdOnDevice(device as DeviceName)).toBe('meta-id-1')
            expect(await fs.readFile(path.join(diskPath(device), 'META.yaml'), 'utf-8')).toBe(text)
        } finally {
            await cleanupDisk(device)
        }
    })
})

// ── eject → re-plug round trip through the harness ──────────────────────────

describe('eject → re-plug round trip with a stale same-name record (harness, testMode)', () => {
    let h: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    let fixtureDir = ''
    const device = uniqueTestDevice()
    const LIVE = 'live-roundtrip-disk' as DiskID
    const onDevice = () => findDisksByDevice(h.doc()!, device as DeviceName, LOCAL).map(d => String(d.id))

    beforeAll(async () => {
        fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-152-fixture-'))
        await fs.writeFile(path.join(fixtureDir, 'META.yaml'),
            YAML.stringify({ diskId: LIVE, isHardwareId: false, diskName: 'system-boot', created: 1790000000000, lastDocked: 1790000000000 }))
        h = (await createTestStore()).storeHandle
        watcher = await enableUsbDeviceMonitor(h)
    }, 15_000)

    afterAll(async () => {
        await watcher?.close()
        await fs.remove(sentinelPath(device)).catch(() => {})
        await cleanupDisk(device).catch(() => {})
        if (fixtureDir) await fs.remove(fixtureDir).catch(() => {})
    })

    it('dock, stale record appears, eject by name is ambiguous, eject by id clears both, re-plug docks only the live record', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            // 1. dock the disk
            await dockFixture(fixtureDir, device)
            expect(await waitFor(h, s => s.diskDB[LIVE]?.device === device, 10_000)).toBe(true)

            // 2. a stale record for the same partition (what the old undock order left behind)
            addDisk(h, 'aaa-stale-roundtrip', 'system-boot', device, LOCAL)
            expect(onDevice().sort()).toEqual(['aaa-stale-roundtrip', LIVE].sort())

            // 3. eject by name: two docked records → refused, nothing ejected
            await handleCommand(commands, h, 'engine', 'ejectDisk system-boot')
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ambiguous'))
            expect(onDevice()).toHaveLength(2)

            // 4. eject by id (what the Console sends): live and stale both undocked
            await handleCommand(commands, h, 'engine', `ejectDisk ${LIVE}`)
            expect(onDevice()).toEqual([])
            expect(isDocked(h, 'aaa-stale-roundtrip')).toBe(false)

            // 5. unplug and re-plug
            await triggerUndock(device)
            await new Promise(r => setTimeout(r, 500))
            await dockFixture(fixtureDir, device)
            expect(await waitFor(h, s => s.diskDB[LIVE]?.device === device, 10_000)).toBe(true)
            expect(onDevice()).toEqual([LIVE])
            expect(disk(h, LIVE).dockedTo).toBe(LOCAL)

            // 6. the Console's case now works: stale undocked + live docked, eject by name
            await handleCommand(commands, h, 'engine', 'ejectDisk system-boot')
            expect(onDevice()).toEqual([])
        } finally {
            errSpy.mockRestore()
        }
    }, 30_000)

    it('a stale record that still claims the device is cleared when the device docks', async () => {
        await triggerUndock(device)
        await new Promise(r => setTimeout(r, 300))
        addDisk(h, 'zzz-stale-dock', 'system-boot', device, LOCAL)
        await dockFixture(fixtureDir, device)
        expect(await waitFor(h, s => s.diskDB[LIVE]?.device === device && s.diskDB['zzz-stale-dock' as DiskID]?.device === null, 10_000)).toBe(true)
        expect(onDevice()).toEqual([LIVE])
    }, 20_000)
})
