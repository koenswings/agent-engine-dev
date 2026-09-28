/**
 * system-disk-eject.test.ts (idea#152)
 *
 * On idea03 Koen could eject the "System Disk" row (sda2, the root partition the
 * Pi boots from): the Engine undocked the record (device null, row gone) and
 * would have stopped its instances. The root itself stayed mounted only because
 * the unmount looks at /disks/sda2.
 *
 * Covers:
 *   - driveOf / isOnSystemDrive: every partition of the root's drive counts
 *   - ejectDisk refuses the system disk by id and by name, by its marker
 *     (diskTypes 'system') and by its device (root or boot partition), and the
 *     trace ends as `error`
 *   - undock (device removal path) never undocks the system disk record
 *
 * testMode: no sudo, no mount.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { driveOf, isOnSystemDrive, isSystemDiskRecord, setRootDeviceForTests } from '../../src/data/Disk.js'
import { localEngineId } from '../../src/data/Engine.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { undockAllOnDevice } from '../../src/monitors/usbDeviceMonitor.js'
import { DeviceName, DiskID, DiskName, DiskType, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { createTestStore } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID

const addDisk = (h: DocHandle<Store>, id: string, name: string, device: string, diskTypes: DiskType[]) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID,
            name: name as DiskName,
            device: device as DeviceName,
            dockedTo: LOCAL,
            created: Date.now() as Timestamp,
            lastDocked: Date.now() as Timestamp,
            diskTypes,
            backupConfig: null,
        }
    })
}
const isDocked = (h: DocHandle<Store>, id: string) => {
    const d = h.doc()!.diskDB[id as DiskID]
    return d.device !== null && d.dockedTo === LOCAL
}
const newCommandLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

describe('system drive detection (idea#152)', () => {
    afterEach(() => setRootDeviceForTests(null))

    it('driveOf strips the partition number', () => {
        expect(driveOf('sda2')).toBe('sda')
        expect(driveOf('sdb1')).toBe('sdb')
        expect(driveOf('mmcblk0p2')).toBe('mmcblk0')
        expect(driveOf('nvme0n1p1')).toBe('nvme0n1')
    })

    it('root sda2: sda2 and sda1 are on the system drive, sdb1 and test devices are not', async () => {
        setRootDeviceForTests('sda2')
        expect(await isOnSystemDrive('sda2')).toBe(true)
        expect(await isOnSystemDrive('sda1')).toBe(true)
        expect(await isOnSystemDrive('sdb1')).toBe(false)
        expect(await isOnSystemDrive('idea-test-1')).toBe(false)
        expect(await isOnSystemDrive(null)).toBe(false)
    })

    it('root on SD card: mmcblk0p1 counts, sda1 does not', async () => {
        setRootDeviceForTests('mmcblk0p2')
        expect(await isOnSystemDrive('mmcblk0p1')).toBe(true)
        expect(await isOnSystemDrive('sda1')).toBe(false)
    })

    it('an unrecognised root (overlay, container) matches nothing', async () => {
        setRootDeviceForTests('overlay')
        expect(await isOnSystemDrive('sda2')).toBe(false)
    })

    it('isSystemDiskRecord: by marker or by device', async () => {
        setRootDeviceForTests('sda2')
        const base = { id: 'x' as DiskID, name: 'x' as DiskName, dockedTo: LOCAL, created: 0 as Timestamp, lastDocked: 0 as Timestamp, backupConfig: null }
        expect(await isSystemDiskRecord({ ...base, device: 'idea-test-1' as DeviceName, diskTypes: ['system'] })).toBe(true)
        expect(await isSystemDiskRecord({ ...base, device: 'sda2' as DeviceName, diskTypes: [] })).toBe(true)
        expect(await isSystemDiskRecord({ ...base, device: 'sdb1' as DeviceName, diskTypes: ['empty'] })).toBe(false)
    })
})

describe('ejectDisk never ejects the system disk (idea#152)', () => {
    let h: DocHandle<Store>
    let errSpy: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
        h = (await createTestStore()).storeHandle
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => { errSpy.mockRestore(); setRootDeviceForTests(null) })

    it('by id: refused, trace ends as error, record stays docked', async () => {
        addDisk(h, 'sys', 'System Disk', 'idea-test-1', ['system'])
        const log = newCommandLog()
        await handleCommand(commands, h, 'engine', 'ejectDisk sys', log)
        expect(isDocked(h, 'sys')).toBe(true)
        expect(h.doc()!.diskDB['sys' as DiskID].diskTypes).toEqual(['system'])
        const trace = lastTrace(log)
        expect(trace.command).toBe('ejectDisk')
        expect(trace.status).toBe('error')
        expect(trace.errorMessage).toContain("system disk and cannot be ejected")
    })

    it('by name: refused the same way', async () => {
        addDisk(h, 'sys', 'System Disk', 'idea-test-1', ['system'])
        const log = newCommandLog()
        await handleCommand(commands, h, 'engine', 'ejectDisk System Disk', log)
        expect(isDocked(h, 'sys')).toBe(true)
        expect(lastTrace(log).status).toBe('error')
    })

    it('by device: a record on the root or boot partition is refused even without the marker', async () => {
        setRootDeviceForTests('sda2')
        addDisk(h, 'root', 'rootfs', 'sda2', [])
        addDisk(h, 'boot', 'bootfs', 'sda1', ['empty'])
        for (const id of ['root', 'boot']) {
            const log = newCommandLog()
            await handleCommand(commands, h, 'engine', `ejectDisk ${id}`, log)
            expect(isDocked(h, id)).toBe(true)
            expect(lastTrace(log).status).toBe('error')
        }
    })

    it('another disk still ejects', async () => {
        setRootDeviceForTests('sda2')
        addDisk(h, 'sys', 'System Disk', 'sda2', ['system'])
        addDisk(h, 'usb', 'writable', 'idea-test-2', ['empty'])
        await handleCommand(commands, h, 'engine', 'ejectDisk usb')
        expect(isDocked(h, 'usb')).toBe(false)
        expect(isDocked(h, 'sys')).toBe(true)
    })

    it('undock on device removal leaves the system disk record docked', async () => {
        addDisk(h, 'sys', 'System Disk', 'idea-test-3', ['system'])
        await undockAllOnDevice(h, LOCAL, 'idea-test-3' as DeviceName)
        expect(isDocked(h, 'sys')).toBe(true)
    })
})
