/**
 * startup-undock-identity.test.ts (idea#465)
 *
 * idea04, 2026-11-12: the WD test disk `updtest10i76` was last docked on sda1.
 * The WD was reflashed and unplugged and idea04 now boots from an SSD whose
 * boot partition is sda1 (/boot/firmware). Startup kept the record docked
 * because "sda1" was still listed in /dev/engine; addDevice skips the boot
 * partition and never read META.yaml, and ejectDisk/undockDisk refuse a record
 * on the system drive, so nothing could clear it.
 *
 * reconcileStartupDocks keeps a record docked only when META.yaml on the device
 * names it, and never treats the OS boot or root partition as that disk. Stale
 * records are undocked in the store only: no mount, umount or write.
 */

import { describe, it, beforeEach, expect, vi } from 'vitest'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { reconcileStartupDocks, undockRecordsStoreOnly, watchDirContainsDevice, shouldLeaveDeviceUntouched } from '../../src/monitors/usbDeviceMonitor.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { createTestStore } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID
const dev = (d: string) => d as DeviceName

const addDisk = (h: DocHandle<Store>, id: string, device: string | null, dockedTo: EngineID | null, diskTypes: any[] = ['app']) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID,
            name: id as DiskName,
            device: device as DeviceName | null,
            dockedTo,
            created: 1 as Timestamp,
            lastDocked: 2 as Timestamp,
            diskTypes: device ? diskTypes : [],
            backupConfig: null,
            backupStaleLocks: null,
            filesConfig: null,
            sizeBytes: device ? 1000 : null,
            freeBytes: device ? 500 : null,
        }
    })
}
const addInstance = (h: DocHandle<Store>, id: string, storedOn: string, status = 'Stopped') => {
    h.change(doc => {
        doc.instanceDB[id as InstanceID] = { id, name: id, storedOn, status, metrics: null } as any
    })
}
const disk = (h: DocHandle<Store>, id: string) => h.doc()!.diskDB[id as DiskID]
const isDocked = (h: DocHandle<Store>, id: string) => disk(h, id).device !== null && disk(h, id).dockedTo !== null
const status = (h: DocHandle<Store>, id: string) => (h.doc()!.instanceDB[id as InstanceID] as any).status

/** Pi booting from an SSD: root sda2, boot sda1 (idea04 after the reflash). */
const ssdPi = { systemDevice: dev('sda2'), systemBootDevice: dev('sda1') }

describe('reconcileStartupDocks: a docked record needs more than its device name (idea#465)', () => {
    let h: DocHandle<Store>
    type UndockGone = (sh: DocHandle<Store>, e: EngineID, d: DeviceName) => Promise<DiskID[]>
    let undockGone: ReturnType<typeof vi.fn<UndockGone>>

    beforeEach(async () => {
        h = (await createTestStore()).storeHandle
        undockGone = vi.fn<UndockGone>(async () => [] as DiskID[])
    })

    it('repro: a record docked on sda1 while sda1 is now the boot partition is undocked in the store only, META never read', async () => {
        addDisk(h, 'updtest10i76', 'sda1', LOCAL)
        for (const i of ['updtest-i76major', 'updtest-i76minor', 'updtest-i76stale']) addInstance(h, i, 'updtest10i76')
        const readMeta = vi.fn(async () => 'updtest10i76' as DiskID)
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sda1')], [dev('sda'), dev('sda1'), dev('sda2')], { ...ssdPi, readMetaDiskId: readMeta, undockGone })
        expect(res).toEqual([{ device: 'sda1', action: 'system-partition', kept: null, undocked: ['updtest10i76'] }])
        const d = disk(h, 'updtest10i76')
        expect(d.dockedTo).toBeNull()
        expect(d.device).toBeNull()
        expect(d.diskTypes).toEqual([])
        expect(d.sizeBytes).toBeNull()
        expect(d.freeBytes).toBeNull()
        for (const i of ['updtest-i76major', 'updtest-i76minor', 'updtest-i76stale']) expect(status(h, i)).toBe('Undocked')
        // Nothing reads (or mounts) the boot partition; undockDisk (umount) is never called
        expect(readMeta).not.toHaveBeenCalled()
        expect(undockGone).not.toHaveBeenCalled()
    })

    it('the boot partition is found by the detected boot device, not by the name sda1 (mmcblk0p1 on an SD-card Pi)', async () => {
        addDisk(h, 'stale-sd', 'mmcblk0p1', LOCAL)
        addDisk(h, 'usb-a', 'sda1', LOCAL)
        const readMeta = vi.fn(async (d: DeviceName) => (d === 'sda1' ? 'usb-a' : null) as DiskID | null)
        const res = await reconcileStartupDocks(h, LOCAL, [dev('mmcblk0p1'), dev('sda1')], [dev('mmcblk0p1'), dev('sda'), dev('sda1')],
            { systemDevice: dev('mmcblk0p2'), systemBootDevice: dev('mmcblk0p1'), readMetaDiskId: readMeta, undockGone })
        expect(res.map(r => r.action)).toEqual(['system-partition', 'kept'])
        expect(isDocked(h, 'stale-sd')).toBe(false)
        expect(isDocked(h, 'usb-a')).toBe(true)
        expect(readMeta).toHaveBeenCalledTimes(1)
        expect(readMeta).toHaveBeenCalledWith('sda1')
    })

    it('a non-system record on the OS root partition is undocked in the store only', async () => {
        addDisk(h, 'stale-root', 'sda2', LOCAL)
        const readMeta = vi.fn(async () => 'stale-root' as DiskID)
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sda2')], [dev('sda'), dev('sda1'), dev('sda2')], { ...ssdPi, readMetaDiskId: readMeta, undockGone })
        expect(res[0].action).toBe('system-partition')
        expect(isDocked(h, 'stale-root')).toBe(false)
        expect(readMeta).not.toHaveBeenCalled()
    })

    it('the system disk record is always left docked', async () => {
        addDisk(h, 'sys', 'sda2', LOCAL, ['system'])
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sda2')], [], { ...ssdPi, undockGone })
        expect(res).toEqual([{ device: 'sda2', action: 'system-disk', kept: 'sys', undocked: [] }])
        expect(isDocked(h, 'sys')).toBe(true)
        expect(undockGone).not.toHaveBeenCalled()
    })

    it('a device that is no longer listed still goes through undockAllOnDevice (unchanged)', async () => {
        addDisk(h, 'gone', 'sdb1', LOCAL)
        undockGone.mockImplementation(async () => ['gone' as DiskID])
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sdb1')], [dev('sda'), dev('sda1'), dev('sda2')], { ...ssdPi, undockGone })
        expect(res).toEqual([{ device: 'sdb1', action: 'gone', kept: null, undocked: ['gone'] }])
        expect(undockGone).toHaveBeenCalledWith(h, LOCAL, 'sdb1')
    })

    it('META.yaml on the device names the record: it stays docked, instances untouched', async () => {
        addDisk(h, 'real', 'sdb1', LOCAL)
        addInstance(h, 'real-i', 'real', 'Running')
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sdb1')], [dev('sdb'), dev('sdb1')], { ...ssdPi, readMetaDiskId: async () => 'real' as DiskID, undockGone })
        expect(res).toEqual([{ device: 'sdb1', action: 'kept', kept: 'real', undocked: [] }])
        expect(isDocked(h, 'real')).toBe(true)
        expect(status(h, 'real-i')).toBe('Running')
    })

    it('META.yaml names one of several records on the device: that one is kept, the rest undocked (idea#152 still holds)', async () => {
        addDisk(h, 'stale', 'sdb1', LOCAL)
        addDisk(h, 'live', 'sdb1', LOCAL)
        addInstance(h, 'stale-i', 'stale', 'Running')
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sdb1'), dev('sdb1')], [dev('sdb1')], { ...ssdPi, readMetaDiskId: async () => 'live' as DiskID, undockGone })
        expect(res).toEqual([{ device: 'sdb1', action: 'kept', kept: 'live', undocked: ['stale'] }])
        expect(isDocked(h, 'live')).toBe(true)
        expect(isDocked(h, 'stale')).toBe(false)
        expect(status(h, 'stale-i')).toBe('Undocked')
    })

    it('META.yaml names a different disk: the record is undocked in the store only (the dock registers the real one)', async () => {
        addDisk(h, 'old-wd', 'sdb1', LOCAL)
        addInstance(h, 'old-i', 'old-wd')
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sdb1')], [dev('sdb1')], { ...ssdPi, readMetaDiskId: async () => 'new-disk' as DiskID, undockGone })
        expect(res).toEqual([{ device: 'sdb1', action: 'identity-mismatch', kept: null, undocked: ['old-wd'] }])
        expect(isDocked(h, 'old-wd')).toBe(false)
        expect(status(h, 'old-i')).toBe('Undocked')
        expect(undockGone).not.toHaveBeenCalled()
    })

    it('no readable META.yaml on the device: not known to be that disk, so undocked in the store only', async () => {
        addDisk(h, 'unknown', 'sdc1', LOCAL)
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sdc1')], [dev('sdc1')], { ...ssdPi, readMetaDiskId: async () => null, undockGone })
        expect(res).toEqual([{ device: 'sdc1', action: 'identity-unknown', kept: null, undocked: ['unknown'] }])
        expect(isDocked(h, 'unknown')).toBe(false)
    })

    it('an App Disk partition on the system drive (not boot or root) gets the META.yaml check, not an automatic undock', async () => {
        addDisk(h, 'p3', 'sda3', LOCAL)
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sda3')], [dev('sda1'), dev('sda2'), dev('sda3')], { ...ssdPi, readMetaDiskId: async () => 'p3' as DiskID, undockGone })
        expect(res[0].action).toBe('kept')
        expect(isDocked(h, 'p3')).toBe(true)
    })

    it('records docked to another Engine on the same device name are never touched', async () => {
        addDisk(h, 'theirs', 'sda1', OTHER)
        addDisk(h, 'mine', 'sda1', LOCAL)
        await reconcileStartupDocks(h, LOCAL, [dev('sda1')], [dev('sda1')], { ...ssdPi, undockGone })
        expect(isDocked(h, 'mine')).toBe(false)
        expect(isDocked(h, 'theirs')).toBe(true)
        expect(disk(h, 'theirs').dockedTo).toBe(OTHER)
    })
})

describe('undockRecordsStoreOnly (idea#465)', () => {
    it('only changes the named records docked to this Engine on that device', async () => {
        const h = (await createTestStore()).storeHandle
        addDisk(h, 'a', 'sdb1', LOCAL)
        addDisk(h, 'b', 'sdb2', LOCAL)
        addDisk(h, 'c', 'sdb1', OTHER)
        addInstance(h, 'b-i', 'b', 'Running')
        expect(undockRecordsStoreOnly(h, LOCAL, dev('sdb1'), ['a', 'b', 'c'] as DiskID[], 'test')).toEqual(['a'])
        expect(isDocked(h, 'a')).toBe(false)
        expect(isDocked(h, 'b')).toBe(true)
        expect(isDocked(h, 'c')).toBe(true)
        expect(status(h, 'b-i')).toBe('Running')
        expect(undockRecordsStoreOnly(h, LOCAL, dev('sdb1'), [], 'test')).toEqual([])
    })
})


describe('reconcileStartupDocks: testMode leaves disks outside IDEA_WATCH_DIR alone (engine#362)', () => {
    it('docked sdb1 plus an empty watch dir does not undock and does not write the store', async () => {
        const h = (await createTestStore()).storeHandle
        addDisk(h, 'diskb202610301247', 'sdb1', LOCAL)
        addInstance(h, 'nextcloud-files-b-001', 'diskb202610301247', 'Running')
        const undockGone = vi.fn(async () => ['diskb202610301247' as DiskID])
        const change = vi.spyOn(h, 'change')
        change.mockClear()
        const leaveUntouched = (d: DeviceName) => !watchDirContainsDevice([], d)
        const before = JSON.stringify({ disk: disk(h, 'diskb202610301247'), status: status(h, 'nextcloud-files-b-001') })
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sdb1')], [], { ...ssdPi, undockGone, leaveUntouched })
        expect(res).toEqual([{ device: 'sdb1', action: 'outside-watch-dir', kept: 'diskb202610301247', undocked: [] }])
        expect(isDocked(h, 'diskb202610301247')).toBe(true)
        expect(disk(h, 'diskb202610301247').dockedTo).toBe(LOCAL)
        expect(disk(h, 'diskb202610301247').device).toBe('sdb1')
        expect(status(h, 'nextcloud-files-b-001')).toBe('Running')
        expect(undockGone).not.toHaveBeenCalled()
        expect(change).not.toHaveBeenCalled()
        expect(JSON.stringify({ disk: disk(h, 'diskb202610301247'), status: status(h, 'nextcloud-files-b-001') })).toBe(before)
    })

    it('a fixture disk that is in the watch dir still goes through the gone path (undock-then-re-add)', async () => {
        const h = (await createTestStore()).storeHandle
        addDisk(h, 'fixture', 'idea-test-1', LOCAL)
        const undockGone = vi.fn(async () => ['fixture' as DiskID])
        const leaveUntouched = (d: DeviceName) => !watchDirContainsDevice(['idea-test-1'], d)
        const res = await reconcileStartupDocks(h, LOCAL, [dev('idea-test-1')], [], { ...ssdPi, undockGone, leaveUntouched })
        expect(res[0].action).toBe('gone')
        expect(undockGone).toHaveBeenCalledWith(h, LOCAL, 'idea-test-1')
    })

    it('watchDirContainsDevice matches the partition, the whole disk, or another partition of the same drive', () => {
        expect(watchDirContainsDevice([], dev('sdb1'))).toBe(false)
        expect(watchDirContainsDevice(['sdb1'], dev('sdb1'))).toBe(true)
        expect(watchDirContainsDevice(['sdb'], dev('sdb1'))).toBe(true)
        expect(watchDirContainsDevice(['sdb2'], dev('sdb1'))).toBe(true)
        expect(watchDirContainsDevice(['sdc1'], dev('sdb1'))).toBe(false)
    })
})


describe('reconcileStartupDocks: isDev also leaves real disks alone (engine#362)', () => {
    it('isDev, docked sdb1, does not undock (IDEA_WATCH_DIR unset: no watch dir to be inside)', async () => {
        const h = (await createTestStore()).storeHandle
        addDisk(h, 'diskb202610301247', 'sdb1', LOCAL)
        addInstance(h, 'nextcloud-files-b-001', 'diskb202610301247', 'Running')
        const undockGone = vi.fn(async () => ['diskb202610301247' as DiskID])
        const change = vi.spyOn(h, 'change')
        change.mockClear()
        // Typical isDev: actualDevices forced [], and /dev/engine may even list sdb1.
        // Because IDEA_WATCH_DIR is unset, shouldLeaveDeviceUntouched is true for every device.
        const listedAsIfDevEngine = ['sdb', 'sdb1']
        const leaveUntouched = (d: DeviceName) => shouldLeaveDeviceUntouched(d, listedAsIfDevEngine, {
            testMode: false, isDev: true, watchDirSet: false,
        })
        const before = JSON.stringify({ disk: disk(h, 'diskb202610301247'), status: status(h, 'nextcloud-files-b-001') })
        const res = await reconcileStartupDocks(h, LOCAL, [dev('sdb1')], [], { ...ssdPi, undockGone, leaveUntouched })
        expect(res).toEqual([{ device: 'sdb1', action: 'outside-watch-dir', kept: 'diskb202610301247', undocked: [] }])
        expect(isDocked(h, 'diskb202610301247')).toBe(true)
        expect(disk(h, 'diskb202610301247').device).toBe('sdb1')
        expect(status(h, 'nextcloud-files-b-001')).toBe('Running')
        expect(undockGone).not.toHaveBeenCalled()
        expect(change).not.toHaveBeenCalled()
        expect(JSON.stringify({ disk: disk(h, 'diskb202610301247'), status: status(h, 'nextcloud-files-b-001') })).toBe(before)
    })

    it('isDev with IDEA_WATCH_DIR set matches testMode: only devices outside the listing are left alone', () => {
        const opts = { testMode: false, isDev: true, watchDirSet: true }
        expect(shouldLeaveDeviceUntouched(dev('sdb1'), [], opts)).toBe(true)
        expect(shouldLeaveDeviceUntouched(dev('sdb1'), ['sdb1'], opts)).toBe(false)
        // Unset WATCH_DIR: even if /dev/engine lists sdb1, leave it untouched
        expect(shouldLeaveDeviceUntouched(dev('sdb1'), ['sdb', 'sdb1'], { testMode: false, isDev: true, watchDirSet: false })).toBe(true)
        // testMode without WATCH_DIR is still the #363 listing rule
        expect(shouldLeaveDeviceUntouched(dev('sdb1'), ['sdb1'], { testMode: true, isDev: false, watchDirSet: false })).toBe(false)
        expect(shouldLeaveDeviceUntouched(dev('sdb1'), [], { testMode: true, isDev: false, watchDirSet: false })).toBe(true)
        // both flags, WATCH_DIR unset: safer isDev rule (leave all)
        expect(shouldLeaveDeviceUntouched(dev('sdb1'), ['sdb1'], { testMode: true, isDev: true, watchDirSet: false })).toBe(true)
    })
})
