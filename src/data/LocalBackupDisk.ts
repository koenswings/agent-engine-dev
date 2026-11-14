/**
 * LocalBackupDisk.ts — pick a Backup Disk docked on this Engine (engine#394).
 *
 * backupApp without a disk argument, and any other caller that needs the default
 * Backup Disk for an instance, must only consider disks docked here (dockedTo ==
 * this Engine and device set). A disk listed first in the shared store may be
 * docked on another Engine; using its device name as a local path could write
 * Borg to the wrong volume. Prefer the instance's linked Backup Disk when several
 * are docked locally.
 */
import { Disk } from './Disk.js'
import { Store, getLocalEngine } from './Store.js'
import { localEngineId } from './Engine.js'

/** True when the disk is docked on this Engine and has a device. */
export const isDockedOnEngine = (
    disk: { device?: unknown, dockedTo?: unknown } | null | undefined,
    engineId: string | undefined,
): boolean =>
    !!disk && disk.device != null && engineId != null && String(disk.dockedTo) === String(engineId)

/** Backup Disks docked on this Engine, in store order. */
export const localBackupDisks = (store: Store, engineId: string | undefined): Disk[] =>
    Object.values(store.diskDB ?? {}).filter(d =>
        isDockedOnEngine(d, engineId) && d.diskTypes?.includes('backup')) as Disk[]

/**
 * The Backup Disk docked on this Engine to use when none was named: the one
 * linked to the instance, if any; otherwise undefined (callers must not fall
 * back to an unlinked local Backup Disk).
 */
export const pickLocalBackupDisk = (
    store: Store,
    engineId: string | undefined,
    instanceId: string,
): Disk | undefined => {
    const local = localBackupDisks(store, engineId)
    return local.find(d => (d.backupConfig?.links ?? []).some(l => String(l) === String(instanceId)))
}

/** Hostname of this Engine, else its id, for refusal text. */
export const localEngineName = (store: Store): string => {
    try {
        const engine = getLocalEngine(store)
        const name = engine?.hostname != null ? String(engine.hostname).trim() : ''
        return name || String(engine?.id ?? localEngineId)
    } catch {
        return String(localEngineId)
    }
}

/** Refusal when no Backup Disk is docked on this Engine. */
export const noLocalBackupDiskMessage = (engineName: string): string =>
    `NOT_DOCKED: no Backup Disk docked on ${engineName}`
