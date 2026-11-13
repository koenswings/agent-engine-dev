/**
 * hw-roundtrip-guard.test.ts (idea#152)
 *
 * script/hw-roundtrip.ts may only eject and unplug the recorded test disk,
 * matched by IDs (disk serial; USB serial and filesystem UUIDs only when given
 * as flags), never by device name. Fake lsblk/sysfs facts modelled on idea03: root SSD sda (serial
 * AA202000000000004820, USB 2-1), test disk sdb (serial 3813430-532011020,
 * USB 4-1 serial 26A1EE83197F).
 */

import { describe, it, expect } from 'vitest'
import { fs, path } from 'zx'
import os from 'os'
import { BlockFacts, StickExpectation, loadExpectation, resolveStick, usbPathFromSysPath } from '../../script/hw-roundtrip-guard.js'

const USB_A = '/sys/devices/platform/axi/1000120000.pcie/1f00200000.usb/xhci-hcd.0/usb2/2-1'
const USB_B = '/sys/devices/platform/axi/1000120000.pcie/1f00300000.usb/xhci-hcd.1/usb4/4-1'

const expected = (): StickExpectation => ({
    usbSerial: '26A1EE83197F',
    diskSerial: '3813430-532011020',
    uuids: ['3E50-902A', '378383c9-0612-4c82-9c07-8c34d15253ba'],
    refuseSerials: ['AA202000000000004820'],
})

/** What the committed config yields: disk serial + refused serials only */
const serialOnly = (): StickExpectation => ({
    usbSerial: '',
    diskSerial: '3813430-532011020',
    uuids: [],
    refuseSerials: ['AA202000000000004820', 'AA000000000000005638'],
})

const idea03 = (): BlockFacts => ({
    partitions: [
        { name: 'sda1', uuid: 'EACA-13DA', disk: 'sda' },
        { name: 'sda2', uuid: '21724cc6-e5a3-48a1-8643-7917dba3a9fb', disk: 'sda' },
        { name: 'sdb1', uuid: '3E50-902A', disk: 'sdb' },
        { name: 'sdb2', uuid: '378383c9-0612-4c82-9c07-8c34d15253ba', disk: 'sdb' },
    ],
    disks: {
        sda: { serial: 'AA202000000000004820', usbPath: USB_A, usbSerial: '26A1EE833A13' },
        sdb: { serial: '3813430-532011020', usbPath: USB_B, usbSerial: '26A1EE83197F' },
    },
    systemDisks: ['sda'],
})

const refusedWith = (exp: StickExpectation, facts: BlockFacts, text: string) => {
    const r = resolveStick(exp, facts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain(text)
}

describe('hw-roundtrip test disk guard (idea#152)', () => {
    it('the recorded stick matches: sdb on USB 4-1 with both partitions', () => {
        expect(resolveStick(expected(), idea03())).toEqual({ ok: true, disk: 'sdb', usbPath: USB_B, usbId: '4-1', partitions: ['sdb1', 'sdb2'] })
    })

    it('matches by IDs, not by name: the stick enumerated as sdc still resolves', () => {
        const f = idea03()
        f.partitions = f.partitions.map(p => p.disk === 'sdb' ? { ...p, name: p.name.replace('sdb', 'sdc'), disk: 'sdc' } : p)
        f.disks = { sda: f.disks.sda, sdc: f.disks.sdb }
        expect(resolveStick(expected(), f)).toMatchObject({ ok: true, disk: 'sdc', usbId: '4-1' })
    })

    it('wrong USB serial is refused', () => {
        refusedWith({ ...expected(), usbSerial: 'DEADBEEF0000' }, idea03(), 'not the expected DEADBEEF0000')
    })

    it('wrong disk serial is refused', () => {
        const f = idea03(); f.disks.sdb.serial = 'OTHER-DISK'
        refusedWith(expected(), f, 'serial OTHER-DISK is not the expected')
    })

    it('wrong (unknown) UUID is refused', () => {
        refusedWith({ ...expected(), uuids: ['3E50-0000', '378383c9-0612-4c82-9c07-8c34d15253ba'] }, idea03(), 'not found: 3E50-0000')
    })

    it('a disk with an extra, unexpected partition is refused', () => {
        const f = idea03(); f.partitions.push({ name: 'sdb3', uuid: 'EXTRA', disk: 'sdb' })
        refusedWith(expected(), f, 'not expected: sdb3')
    })

    it('UUIDs spread over two disks are refused', () => {
        refusedWith({ ...expected(), uuids: ['3E50-902A', 'EACA-13DA'] }, idea03(), 'different disks')
    })

    it('the root SSD serial is refused, even when every other ID points at it', () => {
        const exp: StickExpectation = { usbSerial: '26A1EE833A13', diskSerial: 'AA202000000000004820', uuids: ['EACA-13DA', '21724cc6-e5a3-48a1-8643-7917dba3a9fb'], refuseSerials: ['AA202000000000004820'] }
        refusedWith(exp, idea03(), 'refused serial')
        refusedWith({ ...exp, refuseSerials: [] }, idea03(), 'system drive')
    })

    it('a disk carrying a refused serial is refused even if expected', () => {
        const f = idea03(); f.disks.sdb.serial = 'AA202000000000004820'
        refusedWith({ ...expected(), diskSerial: 'X' }, f, 'refused serial AA202000000000004820')
    })

    it('the drive backing / or /boot/firmware is refused', () => {
        const f = idea03(); f.systemDisks = ['sda', 'sdb']
        refusedWith(expected(), f, 'system drive')
    })

    it('a USB device above the system drive (shared hub) is refused', () => {
        const f = idea03(); f.disks.sda.usbPath = USB_B + '/4-1.2'
        refusedWith(expected(), f, 'is (or is above) the system drive')
    })

    it('missing disk serial is refused; missing USB serial / UUIDs only skip those checks', () => {
        refusedWith({ ...expected(), diskSerial: '' }, idea03(), 'no expected disk serial')
        expect(resolveStick({ ...expected(), usbSerial: '', uuids: [] }, idea03())).toMatchObject({ ok: true, disk: 'sdb' })
        const f = idea03(); f.disks.sdb.usbSerial = null
        refusedWith(expected(), f, 'reports no serial')
        const g = idea03(); g.disks.sdb.serial = ''
        refusedWith(expected(), g, 'reports no serial')
        const h = idea03(); h.disks.sdb.usbPath = null
        refusedWith(expected(), h, 'not on USB')
    })

    it('serial-only (the committed config): matches after an enclosure swap and a dd rewrite', () => {
        const f = idea03()
        f.partitions = f.partitions.filter(p => p.disk !== 'sdb').concat([{ name: 'sdb1', uuid: 'b3e90dc7-d00a-4465-9ccf-d8e8d9993bbb', disk: 'sdb' }])
        f.disks.sdb.usbSerial = '26A1EE830E37'
        expect(resolveStick(serialOnly(), f)).toEqual({ ok: true, disk: 'sdb', usbPath: USB_B, usbId: '4-1', partitions: ['sdb1'] })
    })

    it('serial-only: unknown or duplicated disk serial is refused', () => {
        refusedWith({ ...serialOnly(), diskSerial: 'NOPE' }, idea03(), 'no disk with serial NOPE')
        const f = idea03(); f.disks.sdc = { ...f.disks.sdb }
        refusedWith(serialOnly(), f, 'more than one disk')
    })

    it('serial-only: both refused serials (root SSD, Intenso fixture) are refused', () => {
        refusedWith({ ...serialOnly(), diskSerial: 'AA000000000000005638' }, idea03(), 'refused serial')
        const f = idea03(); f.disks.sdb.serial = 'AA000000000000005638'
        refusedWith(serialOnly(), f, 'no disk with serial 3813430-532011020')
        refusedWith({ ...serialOnly(), diskSerial: 'AA202000000000004820', refuseSerials: [] }, idea03(), 'system drive')
    })

    it('usbPathFromSysPath takes the deepest bus-port component', () => {
        expect(usbPathFromSysPath(`${USB_B}/4-1:1.0/host1/target1:0:0/1:0:0:0/block/sdb`)).toBe(USB_B)
        expect(usbPathFromSysPath('/sys/devices/platform/soc/mmc0/block/mmcblk0')).toBeNull()
    })
})

describe('hw-roundtrip expected IDs: config file + CLI flags', () => {
    const file = path.join(os.tmpdir(), `hw-disks-${process.pid}.json`)
    fs.writeFileSync(file, JSON.stringify({ idea03: expected() }))

    it('reads only diskSerial and refuseSerials from the config (usbSerial/uuids are not matched on)', () => {
        expect(loadExpectation([], file, 'idea03')).toEqual({ ...expected(), usbSerial: '', uuids: [] })
    })
    it('an unknown host has no IDs (refused later as missing)', () => {
        expect(loadExpectation([], file, 'idea09')).toEqual({ usbSerial: '', diskSerial: '', uuids: [], refuseSerials: [] })
    })
    it('flags override; --uuid replaces the list; --refuse-serial adds', () => {
        const e = loadExpectation(['--uuid', 'U1', '--uuid', 'U2', '--stick-usb-serial', 'S', '--refuse-serial', 'R'], file, 'idea03')
        expect(e).toEqual({ usbSerial: 'S', diskSerial: '3813430-532011020', uuids: ['U1', 'U2'], refuseSerials: ['AA202000000000004820', 'R'] })
    })
    it('the committed config records the idea03 disk by serial only, refusing both serials', () => {
        const file = path.join(process.cwd(), 'script', 'hw-roundtrip-disks.json')
        const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(cfg.idea03.usbSerial).toBeUndefined()
        expect(cfg.idea03.uuids).toBeUndefined()
        expect(cfg.idea03.note).toMatch(/idea#139/)
        expect(loadExpectation([], file, 'idea03')).toEqual(serialOnly())
    })
})

describe('unformattedDisks expectation for the stick disk (idea#193, #205)', () => {
    const idea04 = JSON.stringify({ blockdevices: [{ name: 'sda', fstype: null, children: [{ name: 'sda1', fstype: 'vfat' }, { name: 'sda2', fstype: 'ext4' }] }, { name: 'sdb', fstype: null, children: [{ name: 'sdb1', fstype: 'vfat' }, { name: 'sdb2', fstype: 'ext4' }] }] })
    const plain = JSON.stringify({ blockdevices: [{ name: 'sdc', fstype: null, children: [{ name: 'sdc1', fstype: 'exfat' }] }] })
    it('detects ext4 on a sibling partition', async () => {
        const { diskHasExt4 } = await import('../../script/hw-roundtrip-guard.js')
        expect(diskHasExt4(idea04, 'sda')).toBe(true)
        expect(diskHasExt4(plain, 'sdc')).toBe(false)
        expect(diskHasExt4(JSON.stringify({ blockdevices: [{ name: 'sdd', fstype: 'ext4' }] }), 'sdd')).toBe(true)
    })
    it('throws on unknown disk or bad JSON (no silent pass)', async () => {
        const { diskHasExt4 } = await import('../../script/hw-roundtrip-guard.js')
        expect(() => diskHasExt4(plain, 'sda')).toThrow()
        expect(() => diskHasExt4('', 'sda')).toThrow()
    })
    it('reversed assertion with ext4, normal without', async () => {
        const { unformattedExpectation } = await import('../../script/hw-roundtrip-guard.js')
        expect(unformattedExpectation(true, false).ok).toBe(true)
        expect(unformattedExpectation(true, true).ok).toBe(false)
        expect(unformattedExpectation(false, true).ok).toBe(true)
        expect(unformattedExpectation(false, false).ok).toBe(false)
        expect(unformattedExpectation(true, false).label).toMatch(/NOT in unformattedDisks/)
    })
})
