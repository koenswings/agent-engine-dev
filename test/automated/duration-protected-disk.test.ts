/**
 * r59 FAIL@60: `infra_undock_fixtures` refused duration-kolibri-grade5a-001 because its store device
 * is `sda1` (real Stage 2 partition on idea01) and the guard matched the kernel name as "system".
 * The guard now decides from what a disk IS (markers, label, store name, mount, root disk), a known
 * fixture is never vetoed by name/label/device, and every refusal names the Pi, disk and match.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    RealFleetOps, assertPrivateDurationRoots, looksLikeProtectedHwDisk, protectedDiskReason, protectedDiskRefusal,
} from '../duration/realFleetOps.js'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'
import type { Stage2Status } from '../duration/stage2.js'

const K = 'duration-kolibri-grade5a-001'
const LIVE: Record<string, string> = { idea01: 'ENGINE_idea01', idea03: 'ENGINE_gge6zxyl6ftmnri4qx6', idea04: 'ENGINE_5vyahbut147hw5dp4e1' }
const HOSTS = { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' }

/** r59 store-before.json diskDB (identical on every Pi; dockedTo as idea03/idea04 report it). */
const r59DiskDB = () => ({
    'duration-add-files-001': { id: 'duration-add-files-001', name: 'Duration Tests — Add Files App', device: 'sda2', dockedTo: 'idea01' },
    'duration-empty-001': { id: 'duration-empty-001', name: 'Duration Tests — Empty Disk 001', device: 'sdb2', dockedTo: 'idea03' },
    'duration-empty-002': { id: 'duration-empty-002', name: 'Duration Tests — Empty Disk 002', device: 'sda1', dockedTo: 'idea04' },
    'duration-empty-003': { id: 'duration-empty-003', name: 'Duration Tests — Empty Disk 003', device: 'sda2', dockedTo: 'idea04' },
    [K]: { id: K, name: 'Duration Tests — Kolibri Grade 5A', device: 'sda1', dockedTo: 'idea01' },
    'duration-nextcloud-grade5a-001': { id: 'duration-nextcloud-grade5a-001', name: 'Duration Tests — Nextcloud Grade 5A', device: 'sdb1', dockedTo: 'idea03' },
    i3qlubws0txx4k23wje: { id: 'i3qlubws0txx4k23wje', name: 'System Disk', device: null, dockedTo: null },
})

type Cmd = { engine: string; live: string; cmd: string }
const fakeStores = (diskDB: Record<string, unknown>, cmds: Cmd[]) => {
    vi.spyOn(RealFleetOps.prototype as unknown as { connect: (id: string) => Promise<never> }, 'connect').mockImplementation(async (logicalId: string) => {
        const doc = { diskDB, engineDB: { [LIVE[logicalId]!]: { commands: [] as string[] } } }
        return {
            storeHandle: {
                doc: () => doc,
                change: (fn: (s: typeof doc) => void) => {
                    const before = doc.engineDB[LIVE[logicalId]!]!.commands.length
                    fn(doc)
                    for (const c of doc.engineDB[LIVE[logicalId]!]!.commands.slice(before)) cmds.push({ engine: logicalId, live: LIVE[logicalId]!, cmd: c })
                },
            },
        } as never
    })
}
const realOps = () => {
    const o = new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
    for (const [k, v] of Object.entries(LIVE)) (o as unknown as { liveIds: Map<string, string> }).liveIds.set(k, v)
    return o
}

afterEach(() => vi.restoreAllMocks())

describe('protectedDiskReason / looksLikeProtectedHwDisk', () => {
    it('real Stage 2 lsblk rows: fixture partitions pass, system partitions are caught by label/mount/root disk', () => {
        // idea01: sda = fixture SSD (sda1 DUR-KOLIBRI, sda2 ADDFILES01); sdb = root (sdb1 bootfs, sdb2 rootfs)
        expect(protectedDiskReason(K, { label: 'DUR-KOLIBRI', device: 'sda1', mountpoint: '/disks/sda1' })).toBeNull()
        expect(protectedDiskReason('duration-add-files-001', { label: 'ADDFILES01', device: 'sda2', mountpoint: '/disks/sda2' })).toBeNull()
        expect(protectedDiskReason('x', { label: 'bootfs', device: 'sdb1', mountpoint: '/boot/firmware' })).toMatch(/system FS label 'bootfs'/)
        expect(protectedDiskReason('x', { label: 'rootfs', device: 'sdb2', mountpoint: '/' })).toMatch(/rootfs/)
        // idea03: sda = root (JAJS300M240C; sda1 bootfs, sda2 rootfs); sdb = fixture SSD
        expect(protectedDiskReason('x', { device: 'sda1', mountpoint: '/boot/firmware' })).toMatch(/system mount \/boot\/firmware/)
        expect(protectedDiskReason('x', { device: 'sda2', mountpoint: '/' })).toMatch(/system mount \//)
        expect(protectedDiskReason('x', { device: 'sdb3', onRootDisk: true })).toMatch(/root disk/)
        expect(protectedDiskReason('duration-nextcloud-grade5a-001', { label: 'DUR-NEXTCLOUD', device: 'sdb1', mountpoint: '/disks/sdb1' })).toBeNull()
        expect(protectedDiskReason('duration-empty-001', { label: 'DUR-EMPTY001', device: 'sdb2' })).toBeNull()
    })
    it('the kernel name alone never protects (sda1, mmcblk0p1, nvme0n1p1, "root"/"system" substrings)', () => {
        for (const device of ['sda1', 'sdb2', 'mmcblk0', 'mmcblk0p1', 'nvme0n1', 'nvme0n1p1', 'root', 'system']) {
            expect(looksLikeProtectedHwDisk('some-disk', { device })).toBe(false)
        }
        expect(looksLikeProtectedHwDisk(K, { name: 'Duration Tests — Kolibri Grade 5A', device: 'sda1' })).toBe(false)
        expect(looksLikeProtectedHwDisk('duration-empty-002', { name: 'Duration Tests — Empty Disk 002', device: 'sda1' })).toBe(false)
    })
    it('still refused: hw-roundtrip serial/UUID markers (even on a fixture id), IDEA Disk, the store System Disk', () => {
        expect(protectedDiskReason('stick-26A1EE83197F')).toMatch(/marker 26A1EE83197F/)
        expect(protectedDiskReason('x', { label: '3E50-902A' })).toMatch(/marker/)
        expect(protectedDiskReason(K, { device: 'a0bf8374-274e-4bef-b32e-cfbfd09d2884' })).toMatch(/marker/)
        expect(protectedDiskReason('x', { name: 'IDEA Disk' })).toMatch(/IDEA Disk/)
        expect(protectedDiskReason('x', { label: 'IDEA Disk' })).toMatch(/IDEA Disk/)
        expect(protectedDiskReason('i3qlubws0txx4k23wje', { name: 'System Disk' })).toMatch(/System Disk/)
    })
    it('refusal text names verb, Pi, disk, name, device and the match; no hardcoded host or vendor', () => {
        const t = protectedDiskRefusal('eject', 'idea04', 'x', 'system mount /', 'N', 'sda2')
        expect(t).toBe("RealFleetOps: refuse to eject protected disk 'x' on idea04 (name=N) [device sda2]: system mount /")
        expect(protectedDiskRefusal('dock', null, 'y', 'r')).not.toMatch(/idea03|Intenso/)
    })
})

describe('RealFleetOps.undockFixtures (store eject)', () => {
    it('r59 step-60 replay: Kolibri on sda1 is ejected on its holder, no refusal', async () => {
        const cmds: Cmd[] = []
        fakeStores(r59DiskDB(), cmds)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await realOps().undockFixtures(['idea01', 'idea03', 'idea04'], K)
        expect(cmds.map(c => c.cmd)).toEqual([`ejectDisk ${K}`, `ejectDisk ${K}`, `ejectDisk ${K}`])
    })
    it('duration-empty-002 on sda1 at idea04 is allowed', async () => {
        const cmds: Cmd[] = []
        fakeStores(r59DiskDB(), cmds)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await realOps().undockFixtures(['idea04'], 'duration-empty-002')
        expect(cmds).toEqual([{ engine: 'idea04', live: LIVE.idea04, cmd: 'ejectDisk duration-empty-002' }])
    })
    it('refuses a marker disk and the System Disk, naming the Pi and match', async () => {
        const db = { ...r59DiskDB(), 'hw-stick': { id: 'hw-stick', name: 'IDEA Disk', device: 'sdc1', dockedTo: 'idea03' } }
        fakeStores(db, [])
        await expect(realOps().undockFixtures(['idea03'], 'hw-stick'))
            .rejects.toThrow("refuse to eject protected disk 'hw-stick' on idea03 (name=IDEA Disk) [device sdc1]: protected label 'IDEA Disk'")
        await expect(realOps().undockFixtures(['idea01'], 'i3qlubws0txx4k23wje')).rejects.toThrow(/on idea01 \(name=System Disk\).*store name 'System Disk'/)
        await expect(realOps().undockFixtures(['idea01'], 'x-26A1EE83197F')).rejects.toThrow(/marker 26A1EE83197F/)
    })
    it('the scan is scoped to the requested disk: a protected neighbour does not block a fixture', async () => {
        const db = { ...r59DiskDB(), 'hw-stick': { id: 'hw-stick', name: 'IDEA Disk', device: 'sdc1', dockedTo: 'idea01' } }
        const cmds: Cmd[] = []
        fakeStores(db, cmds)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await realOps().undockFixtures(['idea01'], K)
        expect(cmds.map(c => c.cmd)).toEqual([`ejectDisk ${K}`])
    })
})

describe('Stage2FleetOps.undockFixtures holder check (lsblk facts on the holder Pi)', () => {
    const idea01Status = (over: Partial<Stage2Status['fixtures'][number]> = {}, rootDisk = 'sdb'): Stage2Status => ({
        ok: true, host: 'idea01', bootId: 'b', rootDisk, ugreenDetached: true, extraSdDisks: [],
        ssds: [{ kname: 'sda', serial: 'AA000000000000009991', model: 'Intenso SSD Sata III' }],
        fixtures: [
            { partLabel: 'IDEA-KOLIBRI', diskId: K, kname: 'sda1', parent: 'sda', fsType: 'ext4', fsLabel: 'DUR-KOLIBRI', mounted: '/disks/sda1', present: true, ...over },
            { partLabel: 'IDEA-ADDFILES', diskId: 'duration-add-files-001', kname: 'sda2', parent: 'sda', fsType: 'ext4', fsLabel: 'ADDFILES01', mounted: '/disks/sda2', present: true },
        ],
    } as Stage2Status)
    const s2 = (st: Stage2Status) => {
        const o = new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        const calls: string[] = []
        vi.spyOn(o, 'stage2Status').mockResolvedValue(st)
        vi.spyOn(o, 'engineEject').mockImplementation(async (e, d) => { calls.push(`engineEject ${e} ${d}`) })
        vi.spyOn(o as unknown as { dockCall: (e: string, v: string, a: { diskId?: string }) => Promise<unknown> }, 'dockCall').mockImplementation(async (e, v, a) => { calls.push(`${v} ${e} ${a.diskId}`); return {} })
        vi.spyOn(RealFleetOps.prototype, 'undockFixtures').mockImplementation(async (es, d) => { calls.push(`store-eject ${es.join(',')} ${d}`) })
        return { o, calls }
    }
    it('r59 replay: Kolibri sda1 on idea01 (root sdb) undocks on the holder', async () => {
        const { o, calls } = s2(idea01Status())
        await o.undockFixtures(['idea01', 'idea03', 'idea04'], K)
        expect(calls).toEqual([`store-eject idea03 ${K}`, `store-eject idea04 ${K}`, `engineEject idea01 ${K}`, `undock idea01 ${K}`])
    })
    it('refuses when the partition sits on the root disk or a system mount, before any eject', async () => {
        let t = s2(idea01Status({ parent: 'sdb', kname: 'sdb3' }))
        await expect(t.o.undockFixtures(['idea01'], K)).rejects.toThrow(`refuse to eject protected disk '${K}' on idea01 [device sdb3]: partition of the root disk`)
        expect(t.calls).toEqual([])
        vi.restoreAllMocks()
        t = s2(idea01Status({ mounted: '/boot/firmware' }))
        await expect(t.o.undockFixtures(['idea01'], K)).rejects.toThrow(/system mount \/boot\/firmware/)
        expect(t.calls).toEqual([])
    })
})

describe('Stage 1 harness roots: no block-device names (any sdX/mmcblk/nvme, any Pi)', () => {
    it('refuses device-named roots with a neutral message; private dirs pass', () => {
        expect(() => assertPrivateDurationRoots('/home/pi/idea/duration-disks', '/home/pi/idea/duration-watch')).not.toThrow()
        expect(() => assertPrivateDurationRoots('/home/pi/idea/sdb1', '/home/pi/idea/duration-watch')).toThrow(/'sdb1' in IDEA_DISKS_ROOT/)
        expect(() => assertPrivateDurationRoots('/home/pi/sda', '/home/pi/w')).toThrow(/'sda'/)
        expect(() => assertPrivateDurationRoots('/home/pi/d', '/home/pi/mmcblk0p1')).toThrow(/'mmcblk0p1' in IDEA_WATCH_DIR/)
        expect(() => assertPrivateDurationRoots('/home/pi/nvme0n1p2', '/home/pi/w')).toThrow(/nvme0n1p2/)
        expect(() => assertPrivateDurationRoots('/home/pi/sdbx-data', '/home/pi/w')).not.toThrow()
        for (const r of ['/home/pi/sdb1', '/home/pi/sda']) {
            try { assertPrivateDurationRoots(r, '/home/pi/w') } catch (e) { expect(String(e)).not.toMatch(/idea03|hw stick/) }
        }
    })
})
