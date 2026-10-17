/**
 * initialise-meta-cache.test.ts — initialiseDisk and the usb monitor's cached META look
 * (happy-zebra 2026-10-17, initialiseDisk AA000000000000004526, reported by Atlas).
 *
 * The monitor caches one read-only META look per device. initialiseDisk wrote META.yaml and
 * then called addDevice, which reused the "no META.yaml" look cached at plug-in, so the disk
 * never docked (WRITE_FAILED "did not dock as …") and the partition stayed mounted rw.
 *
 * Covers: the cache itself (stale until forgotten), initialiseDisk forgetting the look before
 * addDevice, addDevice docking a partition that is already mounted rw at its mount point with
 * META.yaml (lookForIdeaMeta + safeMount: no second mount), and the failure cleanup (the rw
 * mount initialiseDisk made is unmounted when registration still fails).
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { EngineID, DiskID } from '../../src/data/CommonTypes.js'
import {
    scanClientCards, setClientCardOpsForTests, clearClientCardStateForTests, resetClientCardWriteCacheForTests, CardLsblkDevice,
} from '../../src/data/ClientCards.js'
import { initialiseDisk, setFlashCardOpsForTests, clearFlashStateForTests, CardError } from '../../src/data/FlashCard.js'
import { setUnformattedOpsForTests, clearGeneratedUnformattedIdsForTests } from '../../src/data/UnformattedDisks.js'
import { createMetaLookCache, metaLookCache, forgetMetaLook } from '../../src/monitors/metaLookCache.js'
import { IdeaLookResult, MountEntry, MountOps, lookForIdeaMeta, safeMount, mountPointOf } from '../../src/monitors/mounts.js'

const LOCAL = localEngineId as EngineID
const GB = 1_000_000_000
const SYS: CardLsblkDevice = { name: 'sda', type: 'disk', size: 500 * GB, rm: false, tran: 'usb', model: 'SSD', serial: 'SYS1',
    children: [{ name: 'sda1', type: 'part', fstype: 'vfat', label: 'bootfs', size: 512e6, mountpoint: '/boot/firmware' },
               { name: 'sda2', type: 'part', fstype: 'ext4', label: 'rootfs', size: 499 * GB, mountpoint: '/' }] }
// An old ext4 disk without META.yaml, partition 2 ext4 (like 4526's sdb2)
const OLD_EXT4: CardLsblkDevice = { name: 'sdb', type: 'disk', size: 500 * GB, rm: false, tran: 'usb', model: 'Old SSD', serial: 'AA000000000000004526',
    children: [{ name: 'sdb1', type: 'part', fstype: 'vfat', label: 'EFI', size: 512e6 },
               { name: 'sdb2', type: 'part', fstype: 'ext4', label: 'data', size: 499 * GB }] }

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

const useDevices = (devs: CardLsblkDevice[]) => {
    setClientCardOpsForTests({
        lsblkJson: async () => JSON.parse(JSON.stringify(devs)),
        byIdLinks: async () => devs.filter(d => d.name !== 'sda').map(d => ({ link: `/dev/disk/by-id/usb-${(d.model ?? 'X').replace(/ /g, '_')}_${d.serial}-0:0`, device: d.name })),
        sysfsPath: async (d) => `/sys/devices/platform/usb1/1-1/1-1.2/1-1.2:1.0/host0/target0:0:0/0:0:0:0/block/${d}`,
        isSystemDevice: async (d) => d.startsWith('sda'),
        dockedDevices: () => new Set<string>(),
    })
    setUnformattedOpsForTests({ lsblkJson: async () => JSON.parse(JSON.stringify(devs)) as any, hardwareId: async () => undefined })
}

const code = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e) { return (e as CardError).code ?? String(e) } }

describe('metaLookCache (one ro META look per device)', () => {
    it('keeps a look until it is forgotten; a failed look is not kept', async () => {
        const cache = createMetaLookCache()
        let hasMeta = false, looks = 0
        const look = async (): Promise<IdeaLookResult> => { looks++; return { ok: true, hasMeta, alreadyMounted: false } }
        expect(await cache.get('sdb2', look)).toMatchObject({ hasMeta: false })
        hasMeta = true                                              // META.yaml written
        expect(await cache.get('sdb2', look)).toMatchObject({ hasMeta: false })   // the stale answer (the bug)
        expect(looks).toBe(1)
        cache.forget('sdb2')
        expect(await cache.get('sdb2', look)).toMatchObject({ hasMeta: true })
        expect(looks).toBe(2)

        let fails = 0
        const failing = async (): Promise<IdeaLookResult> => { fails++; return { ok: false, message: 'busy' } }
        await cache.get('sdc1', failing); await new Promise(r => setTimeout(r, 0))
        await cache.get('sdc1', failing)
        expect(fails).toBe(2)
    })

    it('forgetMetaLook accepts /dev/engine/<dev>, /dev/<dev> and <dev>', async () => {
        for (const name of ['/dev/engine/sdb2', '/dev/sdb2', 'sdb2']) {
            metaLookCache.clear()
            await metaLookCache.get('sdb2', async () => ({ ok: true, hasMeta: false, alreadyMounted: false }))
            forgetMetaLook(name)
            expect(await metaLookCache.get('sdb2', async () => ({ ok: true, hasMeta: true, alreadyMounted: false }))).toMatchObject({ hasMeta: true })
        }
        metaLookCache.clear()
    })
})

describe('addDevice of a partition already mounted rw at its mount point with META.yaml', () => {
    it('lookForIdeaMeta sees META in place and safeMount docks it without a second mount', async () => {
        const calls: string[] = []
        const mounts: MountEntry[] = [{ source: '/dev/sdb2', target: mountPointOf('sdb2'), fstype: 'ext4' }]
        const ops: MountOps = {
            listMounts: async () => mounts,
            isMountPoint: async (p) => p === mountPointOf('sdb2'),
            fsUuidOfDevice: async () => 'uuid-4526',
            fsUuidAt: async () => 'uuid-4526',
            mkdir: async (d) => { calls.push(`mkdir ${d}`) },
            mount: async (d) => { calls.push(`mount ${d}`) },
            mountReadOnly: async (d) => { calls.push(`mountReadOnly ${d}`) },
            umount: async (d) => { calls.push(`umount ${d}`) },
            rmdir: async (p) => { calls.push(`rmdir ${p}`) },
        }
        const look = await lookForIdeaMeta('sdb2', ops, () => true)
        expect(look).toEqual({ ok: true, hasMeta: true, alreadyMounted: true })
        const m = await safeMount('sdb2', ops)
        expect(m).toEqual({ ok: true, alreadyMounted: true, fsUuid: 'uuid-4526' })
        expect(calls).toEqual([])   // no ro look mount, no second rw mount, no unmount
    })
})

describe('initialiseDisk forgets the cached META look before addDevice (happy-zebra 4526)', () => {
    let h: DocHandle<Store>, onDisk: Record<string, string>, monitorLooks: number, unmounted: string[], mountedRw: string[]

    // A stand-in for the usb monitor's addDevice: it decides with the shared metaLookCache, as
    // the monitor does, and docks the disk only when the look says the partition has META.yaml.
    const monitorAddDevice = async (partition: string) => {
        const look = await metaLookCache.get(partition, async () => { monitorLooks++; return { ok: true, hasMeta: !!onDisk[partition], alreadyMounted: mountedRw.includes(partition) } })
        if (!look.ok || !look.hasMeta) return   // "has no IDEA META.yaml — left untouched"
        const id = /diskId: (\S+)/.exec(onDisk[partition])![1]
        h.change(d => { (d.diskDB as any)[id] = { id, name: 'IDEA Disk', device: partition, dockedTo: LOCAL, diskTypes: ['empty'] } })
    }

    beforeEach(async () => {
        clearClientCardStateForTests(); resetClientCardWriteCacheForTests(); clearFlashStateForTests(); clearGeneratedUnformattedIdsForTests()
        metaLookCache.clear()
        h = await newStore()
        useDevices([SYS, OLD_EXT4])
        onDisk = {}; monitorLooks = 0; unmounted = []; mountedRw = []
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async (p) => ({ ok: true, hasMeta: !!onDisk[p], alreadyMounted: false }),
            mountRw: async (p) => { mountedRw.push(p); return { ok: true, alreadyMounted: false, fsUuid: null } },
            writeMeta: async (p, yaml) => { onDisk[p] = yaml },
            addDevice: monitorAddDevice,
            unmount: async (p) => { unmounted.push(p); return { ok: true } },
            createFilesDisk: async () => undefined,
            createBackupDisk: async () => undefined,
        })
    })
    afterEach(() => { setFlashCardOpsForTests(null); setClientCardOpsForTests(null); setUnformattedOpsForTests(null); metaLookCache.clear() })

    const candidate = async () => (await scanClientCards(undefined, String(LOCAL))).newDisks.find(d => d.device === 'sdb')!.candidateId

    it('plug-in look said "no META", META.yaml written, addDevice docks after the forget; rw mount kept', async () => {
        await monitorAddDevice('sdb2')                      // the plug-in add: cached hasMeta false
        expect(monitorLooks).toBe(1)
        expect(Object.keys(h.doc()!.diskDB)).toHaveLength(0)
        const r = await initialiseDisk(h, await candidate(), 'empty')
        expect(r.partition).toBe('sdb2')
        expect(monitorLooks).toBe(2)                        // looked again after the forget
        expect(h.doc()!.diskDB[r.diskId as DiskID]).toMatchObject({ device: 'sdb2', dockedTo: LOCAL })
        expect(h.doc()!.operationDB[r.operationId]).toMatchObject({ kind: 'initialiseDisk', status: 'Done' })
        expect(unmounted).toEqual([])                       // a docked disk stays mounted
    })

    it('without the forget (the old code) it fails WRITE_FAILED — and the rw mount is released', async () => {
        let forgets = 0
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async (p) => ({ ok: true, hasMeta: !!onDisk[p], alreadyMounted: false }),
            mountRw: async (p) => { mountedRw.push(p); return { ok: true, alreadyMounted: false, fsUuid: null } },
            writeMeta: async (p, yaml) => { onDisk[p] = yaml },
            // the old behaviour (no forget before addDevice); the cleanup's own forget still runs
            forgetMetaLook: (p) => { if (forgets++ > 0) forgetMetaLook(p) },
            addDevice: monitorAddDevice,
            unmount: async (p) => { unmounted.push(p); return { ok: true } },
        })
        await monitorAddDevice('sdb2')
        let err: CardError | null = null
        try { await initialiseDisk(h, await candidate(), 'empty') } catch (e) { err = e as CardError }
        expect(err?.code).toBe('WRITE_FAILED')
        expect(err?.message).toMatch(/sdb2 got META.yaml but did not dock as /)
        expect(unmounted).toEqual(['sdb2'])                 // not left mounted rw
        // The cleanup forgets the look too, so the next add (re-plug / restart) docks the disk
        await monitorAddDevice('sdb2')
        expect(Object.values(h.doc()!.diskDB).map((d: any) => d.device)).toEqual(['sdb2'])
    })

    it('a failure after the rw mount (writeMeta throws) unmounts; a mount that was already there is left alone', async () => {
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async () => ({ ok: true, hasMeta: false, alreadyMounted: false }),
            mountRw: async (p) => { mountedRw.push(p); return { ok: true, alreadyMounted: false, fsUuid: null } },
            writeMeta: async () => { throw new Error('could not write META.yaml on sdb2: tee: Permission denied') },
            addDevice: monitorAddDevice,
            unmount: async (p) => { unmounted.push(p); return { ok: true } },
        })
        expect(await code(initialiseDisk(h, await candidate(), 'empty'))).toBe('WRITE_FAILED')
        expect(unmounted).toEqual(['sdb2'])

        unmounted = []
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async () => ({ ok: true, hasMeta: false, alreadyMounted: false }),
            mountRw: async () => ({ ok: true, alreadyMounted: true, fsUuid: null }),   // not mounted by initialiseDisk
            writeMeta: async () => { throw new Error('boom') },
            addDevice: monitorAddDevice,
            unmount: async (p) => { unmounted.push(p); return { ok: true } },
        })
        expect(await code(initialiseDisk(h, await candidate(), 'empty'))).toBe('WRITE_FAILED')
        expect(unmounted).toEqual([])
    })

    it('a failed unmount in the cleanup does not hide the WRITE_FAILED', async () => {
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async (p) => ({ ok: true, hasMeta: !!onDisk[p], alreadyMounted: false }),
            mountRw: async (p) => { mountedRw.push(p); return { ok: true, alreadyMounted: false, fsUuid: null } },
            writeMeta: async (p, yaml) => { onDisk[p] = yaml },
            addDevice: async () => undefined,               // registration fails
            unmount: async () => { throw new Error('target is busy') },
        })
        expect(await code(initialiseDisk(h, await candidate(), 'empty'))).toBe('WRITE_FAILED')
    })
})
