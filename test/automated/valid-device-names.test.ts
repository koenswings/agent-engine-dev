/**
 * valid-device-names.test.ts
 *
 * agent-engine-dev#228: the USB device monitor accepted only sd* names, so a Pi 5
 * booting from NVMe (root on nvme0n1p2) never registered its system disk and
 * installApp had no target. Pure name checks; nothing touches /dev or /disks.
 *
 *   1. sd* forms behave exactly as before (sda, sda1, sdb2 valid; sda3, sdaa1 not)
 *   2. NVMe and mmcblk partitions are valid; whole disks and boot areas are not
 *   3. loop, zram, dm and other virtual devices are rejected
 *   4. The detected root device is always valid
 *   5. idea-test-N only in testMode (idea#105)
 *   6. partitionName / driveNameOf for sd, nvme and mmcblk
 *   7. Direct registration of a root device the udev rule does not link
 *   8. The monitor uses these helpers
 *   9. boot.sh grows the root partition found by findmnt/lsblk, not /dev/sda
 */

import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { $, fs } from 'zx'
import { isValidDeviceName, isSdWholeDisk, partitionName, udevLinksDevice, needsDirectSystemAdd } from '../../src/monitors/deviceNames.js'
import { driveNameOf } from '../../src/data/SystemDisk.js'
import { driveOf } from '../../src/data/Disk.js'

const ROOT = process.cwd()

describe('isValidDeviceName: sd* unchanged', () => {
    it('accepts sda, sda1, sda2, sdb2, sdz1', () => {
        for (const d of ['sda', 'sdb', 'sda1', 'sda2', 'sdb1', 'sdb2', 'sdz1']) {
            expect(isValidDeviceName(d), d).toBe(true)
        }
    })
    it('still rejects sd partitions 3+ and malformed sd names', () => {
        for (const d of ['sda3', 'sdb9', 'sda0', 'sdaa', 'sdaa1', 'sd', 'sd1', 'sda12', 'xsda1', 'sda1 ', 'sda\nsda1']) {
            expect(isValidDeviceName(d), JSON.stringify(d)).toBe(false)
        }
    })
    it('only sdX is a whole-disk entry', () => {
        expect(isSdWholeDisk('sda')).toBe(true)
        for (const d of ['sda1', 'nvme0n1', 'nvme0n1p2', 'mmcblk0', 'mmcblk0p2', '', null, undefined]) {
            expect(isSdWholeDisk(d), String(d)).toBe(false)
        }
    })
})

describe('isValidDeviceName: NVMe and mmcblk partitions', () => {
    it('accepts nvme and mmcblk partitions', () => {
        for (const d of ['nvme0n1p1', 'nvme0n1p2', 'nvme1n2p10', 'mmcblk0p1', 'mmcblk0p2', 'mmcblk1p3']) {
            expect(isValidDeviceName(d), d).toBe(true)
        }
    })
    it('rejects whole nvme / mmcblk disks (like the rule for sd partitions, a whole drive is never mounted)', () => {
        for (const d of ['nvme0n1', 'nvme0', 'mmcblk0', 'mmcblk0boot0', 'mmcblk0boot1', 'mmcblk0rpmb', 'nvme0n1p', 'mmcblk0p', 'nvmen1p1', 'mmcblkp1']) {
            expect(isValidDeviceName(d), d).toBe(false)
        }
    })
})

describe('isValidDeviceName: virtual devices rejected', () => {
    it('rejects loop, zram, dm, ram, md, sr and garbage', () => {
        for (const d of ['loop0', 'loop12', 'zram0', 'dm-0', 'ram0', 'md0', 'sr0', 'mtdblock0', 'overlay', 'system', '', 'idea-test-']) {
            expect(isValidDeviceName(d), d).toBe(false)
        }
        expect(isValidDeviceName(undefined)).toBe(false)
        expect(isValidDeviceName(null)).toBe(false)
    })
    it('a virtual device is rejected even when another device is the root', () => {
        expect(isValidDeviceName('loop0', { systemDevice: 'nvme0n1p2' })).toBe(false)
        expect(isValidDeviceName('dm-0', { systemDevice: 'sda2' })).toBe(false)
    })
})

describe('isValidDeviceName: detected root device', () => {
    it('accepts the root device whatever its name', () => {
        expect(isValidDeviceName('nvme0n1p2', { systemDevice: 'nvme0n1p2' })).toBe(true)
        expect(isValidDeviceName('mmcblk0p2', { systemDevice: 'mmcblk0p2' })).toBe(true)
        expect(isValidDeviceName('sda2', { systemDevice: 'sda2' })).toBe(true)
        expect(isValidDeviceName('sda3', { systemDevice: 'sda3' })).toBe(true)
        expect(isValidDeviceName('sda3', { systemDevice: 'sda2' })).toBe(false)
    })
    it('no root device (container, overlay) changes nothing', () => {
        expect(isValidDeviceName('sda1', { systemDevice: null })).toBe(true)
        expect(isValidDeviceName('sda3', { systemDevice: null })).toBe(false)
    })
})

describe('isValidDeviceName: test-only names (idea#105)', () => {
    it('idea-test-N only in testMode', () => {
        expect(isValidDeviceName('idea-test-1', { testMode: true })).toBe(true)
        expect(isValidDeviceName('idea-test-1', { testMode: false })).toBe(false)
        expect(isValidDeviceName('idea-test-1')).toBe(false)
        expect(isValidDeviceName('sda1', { testMode: true })).toBe(true)
    })
})

describe('partition and parent-disk names', () => {
    it('partitionName adds a p after a drive name ending in a digit', () => {
        expect(partitionName('sda', 1)).toBe('sda1')
        expect(partitionName('sdb', 2)).toBe('sdb2')
        expect(partitionName('nvme0n1', 1)).toBe('nvme0n1p1')
        expect(partitionName('mmcblk0', 1)).toBe('mmcblk0p1')
    })
    it('driveNameOf and driveOf give the parent drive (not trailing digits stripped)', () => {
        const cases: [string, string][] = [['sda1', 'sda'], ['sdb2', 'sdb'], ['nvme0n1p2', 'nvme0n1'], ['nvme1n2p10', 'nvme1n2'], ['mmcblk0p2', 'mmcblk0']]
        for (const [part, drive] of cases) {
            expect(driveNameOf(part), part).toBe(drive)
            expect(driveNameOf(`/dev/${part}`), part).toBe(drive)
            expect(driveOf(part), part).toBe(drive)
        }
    })
    it('partitionName and driveNameOf round-trip', () => {
        for (const drive of ['sda', 'nvme0n1', 'mmcblk0']) {
            expect(driveNameOf(partitionName(drive, 2))).toBe(drive)
        }
    })
})

describe('direct registration of a root device without a udev link', () => {
    it('the udev rule links only sd?, sd?1, sd?2', () => {
        for (const d of ['sda', 'sda1', 'sda2']) expect(udevLinksDevice(d), d).toBe(true)
        for (const d of ['sda3', 'nvme0n1p2', 'mmcblk0p2']) expect(udevLinksDevice(d), d).toBe(false)
    })
    it('nvme / mmcblk root is registered directly', () => {
        expect(needsDirectSystemAdd('nvme0n1p2', { systemDiskSkip: false, linkExists: false })).toBe(true)
        expect(needsDirectSystemAdd('mmcblk0p2', { systemDiskSkip: false, linkExists: false })).toBe(true)
    })
    it('an sd root keeps going through the udev link (unchanged)', () => {
        expect(needsDirectSystemAdd('sda2', { systemDiskSkip: false, linkExists: false })).toBe(false)
        expect(needsDirectSystemAdd('sda2', { systemDiskSkip: false, linkExists: true })).toBe(false)
    })
    it('never with IDEA_SYSTEM_DISK_SKIP, without a root device, or when a link exists', () => {
        expect(needsDirectSystemAdd('nvme0n1p2', { systemDiskSkip: true, linkExists: false })).toBe(false)
        expect(needsDirectSystemAdd(null, { systemDiskSkip: false, linkExists: false })).toBe(false)
        expect(needsDirectSystemAdd('nvme0n1p2', { systemDiskSkip: false, linkExists: true })).toBe(false)
    })
})

describe('usbDeviceMonitor uses the shared helpers', () => {
    it('validDevice delegates to isValidDeviceName with the root device, and no sd-only regex is left', async () => {
        const src = await fs.readFile(path.join(ROOT, 'src/monitors/usbDeviceMonitor.ts'), 'utf-8')
        expect(src).toMatch(/isValidDeviceName\(device, \{ systemDevice, testMode: config\.settings\.testMode \}\)/)
        expect(src).toMatch(/needsDirectSystemAdd\(systemDevice/)
        expect(src).not.toMatch(/\^sd\[a-z\]/)
        expect(src).not.toMatch(/parent \+ '1'/)
    })
})

describe('boot.sh grows the root partition, not a fixed /dev/sda (agent-engine-dev#228)', () => {
    const boot = fs.readFileSync(path.join(ROOT, 'script/build_image_assets/boot.sh'), 'utf8')
    const fn = boot.slice(boot.indexOf('# --- grow_root_partition: begin'), boot.indexOf('# --- grow_root_partition: end'))

    // Fake findmnt / lsblk / sudo / growpart / resize2fs that record their calls
    const run = async (rootSource: string, pkname: string, partition: string | null) => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-228-grow-'))
        try {
            const bin = path.join(tmp, 'bin')
            const calls = path.join(tmp, 'calls')
            const sys = path.join(tmp, 'sys')
            await fs.ensureDir(bin)
            const dev = rootSource.replace(/^\/dev\//, '')
            if (partition !== null) await fs.outputFile(path.join(sys, dev, 'partition'), `${partition}\n`)
            await fs.writeFile(path.join(bin, 'findmnt'), `#!/bin/sh\necho "${rootSource}"\n`, { mode: 0o755 })
            await fs.writeFile(path.join(bin, 'lsblk'), `#!/bin/sh\necho "${pkname}"\n`, { mode: 0o755 })
            await fs.writeFile(path.join(bin, 'sudo'), `#!/bin/sh\nexec "$@"\n`, { mode: 0o755 })
            await fs.writeFile(path.join(bin, 'growpart'), `#!/bin/sh\necho "growpart $*" >> ${calls}\n`, { mode: 0o755 })
            await fs.writeFile(path.join(bin, 'resize2fs'), `#!/bin/sh\necho "resize2fs $*" >> ${calls}\n`, { mode: 0o755 })
            const script = path.join(tmp, 'grow.sh')
            await fs.writeFile(script, `${fn}\ngrow_root_partition\n`)
            const out = await $({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYS_BLOCK_DIR: sys } })`bash ${script}`.nothrow()
            return { code: out.exitCode, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] }
        } finally {
            await fs.remove(tmp)
        }
    }

    it('sda2 root: exactly the old commands', async () => {
        expect(await run('/dev/sda2', 'sda', '2')).toEqual({ code: 0, calls: ['growpart /dev/sda 2', 'resize2fs /dev/sda2'] })
    })
    it('NVMe root: grows nvme0n1 partition 2, never sda', async () => {
        expect(await run('/dev/nvme0n1p2', 'nvme0n1', '2')).toEqual({ code: 0, calls: ['growpart /dev/nvme0n1 2', 'resize2fs /dev/nvme0n1p2'] })
    })
    it('SD root: grows mmcblk0 partition 2', async () => {
        expect(await run('/dev/mmcblk0p2', 'mmcblk0', '2')).toEqual({ code: 0, calls: ['growpart /dev/mmcblk0 2', 'resize2fs /dev/mmcblk0p2'] })
    })
    it('no block root or no partition number: grows nothing', async () => {
        expect(await run('overlay', '', null)).toEqual({ code: 0, calls: [] })
        expect(await run('/dev/nvme0n1p2', 'nvme0n1', null)).toEqual({ code: 0, calls: [] })
    })
    it('runs on every boot and no fixed /dev/sda growpart is left', () => {
        expect(boot.indexOf('\ngrow_root_partition >>')).toBeGreaterThan(boot.indexOf('# This part runs on every boot'))
        expect(boot).not.toMatch(/growpart \/dev\/sda/)
        expect(boot).not.toMatch(/resize2fs \/dev\/sda2/)
    })
})
