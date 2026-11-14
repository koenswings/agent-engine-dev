/**
 * meta-hardware-id.test.ts (idea#168 Stage 1)
 *
 * readHardwareId picks a serial reader from the device's sysfs model/vendor. The
 * Intenso vendor compare was `vendor === 'INTENSO'`, but idea01 reports
 * 'Intenso', so its stick got no hardware id. The compare is now case-insensitive.
 * sysfs reads and the readers are injected: no /sys, no sudo hdparm.
 * engine#360: readHardwareIdIntenso is tested with an injected exec (full
 * /usr/sbin/hdparm path, no `which`).
 */

import { describe, it, expect, vi } from 'vitest'
import { hardwareIdReaderFor, readHardwareId, readHardwareIdIntenso, describeShellError, HDPARM_BIN } from '../../src/data/Meta.js'
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

const joinCmd = (pieces: TemplateStringsArray, args: unknown[]): string => {
    let cmd = pieces[0] ?? ''
    for (let i = 0; i < args.length; i++) cmd += String(args[i]) + (pieces[i + 1] ?? '')
    return cmd
}

describe('readHardwareIdIntenso (engine#360)', () => {
    it('calls sudo /usr/sbin/hdparm -I by full path and never runs which', async () => {
        const commands: string[] = []
        const exec = async (pieces: TemplateStringsArray, ...args: unknown[]) => {
            const cmd = joinCmd(pieces, args)
            commands.push(cmd)
            return { stdout: 'Serial Number: 3813430-532011020\n' }
        }
        const id = await readHardwareIdIntenso('sdb' as DeviceName, { exec })
        expect(id).toBe('3813430-532011020')
        expect(commands).toHaveLength(1)
        expect(commands[0]).toContain(`sudo ${HDPARM_BIN} -I /dev/sdb`)
        expect(commands[0]).not.toMatch(/\bwhich\b/)
    })

    it('uses the same full-path form for a partition device', async () => {
        const commands: string[] = []
        const exec = async (pieces: TemplateStringsArray, ...args: unknown[]) => {
            commands.push(joinCmd(pieces, args))
            return { stdout: 'Serial Number: ABCD1234\n' }
        }
        expect(await readHardwareIdIntenso('sdb1' as DeviceName, { exec })).toBe('ABCD1234')
        expect(commands[0]).toContain(`sudo ${HDPARM_BIN} -I /dev/sdb1`)
        expect(commands[0]).not.toMatch(/\bwhich\b/)
    })

    it('returns undefined when the command fails', async () => {
        const exec = async () => {
            throw Object.assign(new Error(''), { exitCode: 1, stderr: '', stdout: '', message: '' })
        }
        expect(await readHardwareIdIntenso('sdb' as DeviceName, { exec })).toBeUndefined()
    })
})

describe('describeShellError (engine#360)', () => {
    it('uses exit code and stderr when zx ProcessOutput stringifies empty', () => {
        expect(describeShellError({ message: '', exitCode: 1, stderr: '', stdout: '' })).toBe('exit 1')
        expect(describeShellError({ message: '', exitCode: 1, stderr: 'sudo: hdparm: command not found\n', stdout: '' })).toBe('exit 1: sudo: hdparm: command not found')
        expect(describeShellError(undefined)).toBe('unknown error')
    })
})
