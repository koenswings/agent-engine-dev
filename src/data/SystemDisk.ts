/**
 * SystemDisk.ts — identify the Pi's boot/root disk by lookup (idea#134)
 *
 * Never by name, connection type or model. Uses findmnt for `/` and
 * `/boot/firmware`, then lsblk -no PKNAME (with a name-parsing fallback for
 * sdX / mmcblkNpM / nvmeNnMpP). Covers a USB system disk and idea02's Intenso.
 */

import { $ } from 'zx'
import { log } from '../utils/utils.js'

export interface SystemDiskOps {
    findmntSource: (mountPoint: string) => Promise<string | null>
    pkname: (devicePath: string) => Promise<string | null>
}

const defaultOps: SystemDiskOps = {
    findmntSource: async (mp) => {
        const out = await $`findmnt -n -o SOURCE ${mp}`.nothrow()
        if (out.exitCode !== 0) return null
        const src = out.stdout.trim().split('\n')[0]?.trim() ?? ''
        return src || null
    },
    pkname: async (devicePath) => {
        const out = await $`lsblk -no PKNAME ${devicePath}`.nothrow()
        if (out.exitCode !== 0) return null
        const pk = out.stdout.trim().split('\n')[0]?.trim() ?? ''
        return pk || null
    },
}

let ops: SystemDiskOps = defaultOps
/** Tests only. Pass null to restore. */
export const setSystemDiskOpsForTests = (o: Partial<SystemDiskOps> | null): void => {
    ops = o ? { ...defaultOps, ...o } : defaultOps
}

/** Parent whole-disk name of a partition: sda2→sda, mmcblk0p2→mmcblk0, nvme0n1p2→nvme0n1. */
export const driveNameOf = (device: string): string => {
    const d = device.replace(/^\/dev\//, '')
    if (/^(mmcblk\d+)p\d+$/.test(d)) return d.replace(/p\d+$/, '')
    if (/^(nvme\d+n\d+)p\d+$/.test(d)) return d.replace(/p\d+$/, '')
    if (/^sd[a-z]\d+$/.test(d)) return d.replace(/\d+$/, '')
    return d
}

/** Strip /dev/ and any findmnt bind suffix `[/dir]`. */
export const bareDevice = (source: string): string =>
    source.replace(/^\/dev\//, '').replace(/\[.*\]$/, '').trim()

/**
 * Whole-disk device names that hold `/` or `/boot/firmware` (e.g. `sda`).
 * Empty when findmnt fails (containers with overlay root).
 */
export const systemDriveNames = async (): Promise<string[]> => {
    const drives = new Set<string>()
    for (const mp of ['/', '/boot/firmware']) {
        const src = await ops.findmntSource(mp)
        if (!src) continue
        const bare = bareDevice(src)
        if (!bare || bare === 'overlay' || bare.startsWith('tmpfs')) continue
        const pk = await ops.pkname(`/dev/${bare}`)
        drives.add(pk || driveNameOf(bare))
    }
    return [...drives]
}

/** True when `device` (e.g. sda, sda1, sda2) is on a system drive. */
export const isSystemDevice = async (device: string | null | undefined): Promise<boolean> => {
    if (!device) return false
    const bare = bareDevice(device)
    const drives = await systemDriveNames()
    if (drives.length === 0) return false
    const drive = driveNameOf(bare)
    return drives.includes(drive) || drives.includes(bare)
}

export const logSystemDrives = async (): Promise<void> => {
    const drives = await systemDriveNames()
    log(`System drives: ${drives.length ? drives.join(', ') : '(none detected)'}`)
}
