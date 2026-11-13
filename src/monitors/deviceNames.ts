/**
 * deviceNames.ts — which block device names the USB device monitor handles
 * (agent-engine-dev#228).
 *
 * The udev rule (90-docking.rules) links sd[a-z] and partitions sd[a-z][1-9] into
 * /dev/engine, so USB App Disks are always sd*. The Pi's own system disk is
 * not always sd*: a Pi 5 booting from NVMe has its root on nvme0n1p2 and an
 * SD-booted Pi on mmcblk0p2. Those names must be accepted too, or the system
 * disk is never registered and installApp has no disk to target.
 */

import { RULE_DEVICE_PATTERN } from './diskDetection.js'

/**
 * Pretend disks created by the test harness use names that real hardware never
 * produces (e.g. `idea-test-1`). Only an Engine in testMode accepts them.
 */
export const TEST_DEVICE_PATTERN = /^idea-test-[0-9]+$/
export const isTestDeviceName = (device: string | undefined | null): boolean =>
    !!device && TEST_DEVICE_PATTERN.test(device)

/** USB partitions 1-9: sda1 .. sdb9 (the udev rule's sd[a-z][1-9]). */
export const SD_PARTITION_PATTERN = /^sd[a-z][1-9]$/
/** USB whole disks (sda): listed as unformatted candidates, never mounted. */
export const SD_WHOLE_DISK_PATTERN = /^sd[a-z]$/
/** NVMe partitions (nvme0n1p2). Whole NVMe disks (nvme0n1) are not accepted. */
export const NVME_PARTITION_PATTERN = /^nvme\d+n\d+p\d+$/
/** SD card / eMMC partitions (mmcblk0p2). Whole disks (mmcblk0) and mmcblk0boot0 are not accepted. */
export const MMCBLK_PARTITION_PATTERN = /^mmcblk\d+p\d+$/

export interface ValidDeviceContext {
    /** The detected root partition (findmnt -n -o SOURCE /), e.g. nvme0n1p2; null when unknown. */
    systemDevice?: string | null
    testMode?: boolean
}

/**
 * True when the monitor handles this device name: the existing sd* forms,
 * NVMe and mmcblk partitions, the detected root device itself, and idea-test-N
 * in testMode only (idea#105). Everything else (loop0, zram0, dm-0, whole
 * nvme0n1 / mmcblk0, ...) is ignored.
 */
export const isValidDeviceName = (device: string | undefined | null, ctx: ValidDeviceContext = {}): boolean => {
    if (!device) return false
    // A live Engine (testMode off) ignores pretend disks, so a pretend disk can
    // never be picked up and mounted by a live Engine (idea#105).
    if (isTestDeviceName(device)) return !!ctx.testMode
    if (ctx.systemDevice && device === ctx.systemDevice) return true
    return SD_PARTITION_PATTERN.test(device)
        || SD_WHOLE_DISK_PATTERN.test(device)
        || NVME_PARTITION_PATTERN.test(device)
        || MMCBLK_PARTITION_PATTERN.test(device)
}

/** Whole sd disk entry (sda): never mounted, only listed (idea#134, idea#193 §3.2). */
export const isSdWholeDisk = (device: string | undefined | null): boolean =>
    !!device && SD_WHOLE_DISK_PATTERN.test(device)

/**
 * Partition `n` of a whole drive: sda + 1 → sda1, nvme0n1 + 1 → nvme0n1p1,
 * mmcblk0 + 1 → mmcblk0p1 (the kernel adds a `p` when the drive name ends in a
 * digit).
 */
export const partitionName = (drive: string, n: number): string =>
    /\d$/.test(drive) ? `${drive}p${n}` : `${drive}${n}`

/** True when the udev rule links this device into /dev/engine (sd[a-z], sd[a-z][1-9]). */
export const udevLinksDevice = (device: string): boolean => RULE_DEVICE_PATTERN.test(device)

/**
 * agent-engine-dev#228: the root device gets no /dev/engine link when its name
 * is outside the udev rule (nvme0n1p2, mmcblk0p2), so the watcher never reports
 * it. The monitor then registers it directly at start. Not when the system disk
 * is skipped (IDEA_SYSTEM_DISK_SKIP, tests), when there is no block root
 * (containers), or when the watch folder already holds a link for it.
 */
export const needsDirectSystemAdd = (
    systemDevice: string | null | undefined,
    opts: { systemDiskSkip: boolean, linkExists: boolean },
): boolean =>
    !!systemDevice && !opts.systemDiskSkip && !opts.linkExists && !udevLinksDevice(systemDevice)
