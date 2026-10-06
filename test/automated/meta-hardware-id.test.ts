/**
 * meta-hardware-id.test.ts (idea#168 Stage 1)
 *
 * readHardwareId picks a serial reader from the device's sysfs model/vendor. The
 * Intenso vendor compare was `vendor === 'INTENSO'`, but idea01 reports
 * 'Intenso', so its stick got no hardware id. The compare is now case-insensitive.
 * sysfs reads and the readers are injected: no /sys, no sudo hdparm.
 */

import { describe, it, expect, vi } from 'vitest'
import { hardwareIdReaderFor, readHardwareId } from '../../src/data/Meta.js'
import { DeviceName, DiskID } from '../../src/data/CommonTypes.js'

const sysfs = (model: string, vendor: string) => async (p: string) => {
    if (p.endsWith('/device/model')) return `${model}\n`
    if (p.endsWith('/device/vendor')) return `${vendor}  \n`           // sysfs pads vendor
    throw new Error(`unexpected read ${p}`)
}

describe('hardwareIdReaderFor', () => {
    it('Intenso vendor in any case → intenso reader; Samsung FIT by model; others none', () => {
        for (const v of ['INTENSO', 'Intenso', 'intenso', ' Intenso  ']) expect(hardwareIdReaderFor('USB Flash Drive', v), v).toBe('intenso')
        expect(hardwareIdReaderFor('Flash Drive FIT', 'Samsung')).toBe('samsungFit')
        expect(hardwareIdReaderFor('Flash Drive FIT ', 'Intenso')).toBe('samsungFit')
        expect(hardwareIdReaderFor('Ultra', 'SanDisk')).toBeNull()
        expect(hardwareIdReaderFor('', 'Intensor')).toBeNull()
    })
})

describe('readHardwareId', () => {
    it("idea01's 'Intenso' stick: reads sysfs of the root device and returns the hdparm serial", async () => {
        const reads: string[] = []
        const intenso = vi.fn(async () => '3813430-532011020' as DiskID)
        const samsungFit = vi.fn(async () => 'nope' as DiskID)
        const read = sysfs('Portable SSD', 'Intenso')
        const id = await readHardwareId('sda1' as DeviceName, { readSysfs: async p => { reads.push(p); return read(p) }, intenso, samsungFit })
        expect(id).toBe('3813430-532011020')
        expect(intenso).toHaveBeenCalledWith('sda1')
        expect(samsungFit).not.toHaveBeenCalled()
        expect(reads).toEqual(['/sys/block/sda/device/model', '/sys/block/sda/device/vendor'])
    })

    it("'INTENSO' still works; an unknown vendor or a sysfs error gives undefined", async () => {
        const intenso = vi.fn(async () => 'SER1' as DiskID)
        expect(await readHardwareId('sdb1' as DeviceName, { readSysfs: sysfs('X', 'INTENSO'), intenso })).toBe('SER1')
        expect(await readHardwareId('sdb1' as DeviceName, { readSysfs: sysfs('Ultra', 'SanDisk'), intenso })).toBeUndefined()
        expect(await readHardwareId('sdb1' as DeviceName, { readSysfs: async () => { throw new Error('No such file') }, intenso })).toBeUndefined()
        expect(intenso).toHaveBeenCalledTimes(1)
    })
})
