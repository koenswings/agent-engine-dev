/**
 * DiskSize.ts: Disk.sizeBytes / Disk.freeBytes (idea#131, Files Disk §7.2, §7.5)
 *
 * Every docked disk gets its size and free space, read with fs.statfs on the
 * mount point (no sudo), on dock and every 10 minutes. To keep the Automerge
 * document small the values are rounded to whole MB and written only when the
 * size changed or free space moved by more than 1% of the disk size or more
 * than 100 MB. Both are cleared on undock.
 */

import { statfs } from 'fs/promises'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { Disk } from './Disk.js'
import { DiskID, EngineID } from './CommonTypes.js'
import { log } from '../utils/utils.js'

export const SIZE_ROUNDING_BYTES = 1_000_000          // whole MB
export const FREE_CHANGE_BYTES = 100_000_000          // 100 MB
export const FREE_CHANGE_FRACTION = 0.01              // 1% of the disk size
export const DISK_SIZE_INTERVAL_MS = 10 * 60 * 1000   // 10 minutes

export interface DiskSize { sizeBytes: number; freeBytes: number }

export const roundBytes = (n: number): number => Math.round(n / SIZE_ROUNDING_BYTES) * SIZE_ROUNDING_BYTES

/** Size and free space (available to the Engine, i.e. without root's reserve), rounded. */
export const readDiskSize = async (fsRoot: string): Promise<DiskSize> => {
    const s = await statfs(fsRoot)
    return { sizeBytes: roundBytes(s.blocks * s.bsize), freeBytes: roundBytes(s.bavail * s.bsize) }
}

/** Write rule: first value, a size change, or free space moved by more than 1% of the size or 100 MB. */
export const sizeNeedsWrite = (old: { sizeBytes?: number | null, freeBytes?: number | null }, next: DiskSize): boolean => {
    if (old.sizeBytes == null || old.freeBytes == null) return true
    if (old.sizeBytes !== next.sizeBytes) return true
    const delta = Math.abs(next.freeBytes - old.freeBytes)
    return delta > FREE_CHANGE_BYTES || delta > next.sizeBytes * FREE_CHANGE_FRACTION
}

/**
 * Read the disk's size at fsRoot and store it when the write rule says so
 * (always with force, e.g. on dock). Returns true when the store was written.
 */
export const updateDiskSize = async (storeHandle: DocHandle<Store>, diskId: DiskID, fsRoot: string, force = false): Promise<boolean> => {
    const next = await readDiskSize(fsRoot)
    const current = storeHandle.doc().diskDB[diskId]
    if (!current || !current.device) return false
    if (!force && !sizeNeedsWrite(current, next)) return false
    storeHandle.change(doc => {
        const d = doc.diskDB[diskId]
        if (!d) return
        if (d.sizeBytes !== next.sizeBytes) d.sizeBytes = next.sizeBytes
        if (d.freeBytes !== next.freeBytes) d.freeBytes = next.freeBytes
    })
    return true
}

/** One pass over the disks docked to this engine (the 10-minute timer). */
export const refreshDiskSizes = async (storeHandle: DocHandle<Store>, engineId: EngineID, fsRootOf: (disk: Disk) => Promise<string>): Promise<void> => {
    const disks = Object.values(storeHandle.doc().diskDB)
        .filter(d => d && d.device != null && String(d.dockedTo) === String(engineId))
    for (const disk of disks) {
        try {
            await updateDiskSize(storeHandle, disk.id, await fsRootOf(disk))
        } catch (e: any) {
            log(`[diskSize] could not read the size of disk ${disk.id}: ${e.message ?? e}`)
        }
    }
}

let sizeTimer: NodeJS.Timeout | null = null

export const enableDiskSizeMonitor = (storeHandle: DocHandle<Store>, engineId: EngineID, fsRootOf: (disk: Disk) => Promise<string>, intervalMs = DISK_SIZE_INTERVAL_MS): void => {
    if (sizeTimer) clearInterval(sizeTimer)
    sizeTimer = setInterval(() => { refreshDiskSizes(storeHandle, engineId, fsRootOf).catch(() => {}) }, intervalMs)
    sizeTimer.unref()
}

export const disableDiskSizeMonitor = (): void => {
    if (sizeTimer) clearInterval(sizeTimer)
    sizeTimer = null
}
