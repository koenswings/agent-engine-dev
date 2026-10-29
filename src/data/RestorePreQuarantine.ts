/**
 * RestorePreQuarantine.ts (#190): restore onto ANOTHER disk leaves the instance's
 * pre-restore folder (<old disk>/instances/<id>) behind, so a later moveApp back to
 * that disk finds a non-empty destination and refuses.
 *
 * Decision (Steve, #190 option a): quarantine, never delete. After restoreApp has
 * registered the instance on the new disk, the old folder is renamed with the
 * EXISTING helper v4 op `idea-app-data quarantine <root> <id>` (from #271) to
 * <old disk>/.idea-quarantine/<id>-<UTC stamp>. That pre-restore data may be newer
 * than the backup, so it is kept; clearing the quarantine is manual.
 *
 * Only when: the old disk is docked to this Engine, the store says the instance now
 * lives on the target, the old folder exists, and the old copy is not running.
 * A helper older than v4 refuses the restore up front with HELPER_OUTDATED.
 */
import { fs, path } from 'zx'
import type { Store } from './Store.js'
import type { InstanceID } from './CommonTypes.js'
import { Disk, diskMountRoot, appDataRoot } from './Disk.js'
import { runAppData, quarantineArgs, helperAtLeast } from '../utils/appDataHelper.js'
import { log } from '../utils/utils.js'

export const RESTORE_QUARANTINE_HELPER_MIN = 4

export interface PreQuarantineDeps {
    helperProblem: () => Promise<string | null>
    folderExists: (disk: Disk, id: InstanceID) => Promise<boolean>
    quarantine: (disk: Disk, id: InstanceID) => Promise<string>
}

export const defaultPreQuarantineDeps: PreQuarantineDeps = {
    helperProblem: () => helperAtLeast(RESTORE_QUARANTINE_HELPER_MIN, 'restoreApp to another disk'),
    folderExists: async (disk, id) => fs.pathExists(path.join(await diskMountRoot(disk), 'instances', String(id))),
    quarantine: async (disk, id) => (await runAppData(quarantineArgs(await appDataRoot(disk), String(id)))).trim(),
}

const RUNNING_STATES = new Set(['Running', 'Starting'])

/** The old disk whose pre-restore folder would be left behind, or null. */
export const preRestoreDisk = async (
    store: Store, instanceId: InstanceID, targetDisk: Disk, localEngineId: string, deps: PreQuarantineDeps = defaultPreQuarantineDeps,
): Promise<Disk | null> => {
    const inst = store.instanceDB?.[instanceId]
    const prevId = inst?.storedOn
    if (!prevId || String(prevId) === String(targetDisk.id)) return null
    const prev = store.diskDB?.[prevId] as Disk | undefined
    if (!prev?.device || String(prev.dockedTo) !== String(localEngineId)) return null
    return (await deps.folderExists(prev, instanceId)) ? prev : null
}

/** Before any change: refuse HELPER_OUTDATED when a quarantine will be needed and the helper is below v4. */
export const assertPreQuarantineHelper = async (
    store: Store, instanceId: InstanceID, targetDisk: Disk, localEngineId: string, deps: PreQuarantineDeps = defaultPreQuarantineDeps,
): Promise<Disk | null> => {
    const prev = await preRestoreDisk(store, instanceId, targetDisk, localEngineId, deps)
    if (!prev) return null
    const problem = await deps.helperProblem()
    if (problem) throw new Error(`HELPER_OUTDATED: ${problem}`)
    return prev
}

/**
 * After registration on the target: quarantine the old folder. Returns the quarantine
 * path, or null when skipped. A failure is logged, not thrown: the restore itself is done.
 */
export const quarantinePreRestore = async (
    store: Store, instanceId: InstanceID, targetDisk: Disk, prevDisk: Disk | null, deps: PreQuarantineDeps = defaultPreQuarantineDeps,
): Promise<string | null> => {
    if (!prevDisk) return null
    const inst = store.instanceDB?.[instanceId]
    if (!inst || String(inst.storedOn) !== String(targetDisk.id)) {
        log(`restoreApp: instance ${instanceId} is not registered on ${targetDisk.name}; pre-restore folder on ${prevDisk.name} left in place (#190)`)
        return null
    }
    const prevNow = store.diskDB?.[prevDisk.id]
    if (!prevNow?.device) {
        log(`restoreApp: ${prevDisk.name} is no longer docked; pre-restore folder of ${instanceId} left in place (#190)`)
        return null
    }
    if (RUNNING_STATES.has(String(inst.status)) && String(inst.storedOn) === String(prevDisk.id)) return null
    try {
        const q = await deps.quarantine(prevDisk, instanceId)
        log(`restoreApp: pre-restore folder of ${instanceId} on ${prevDisk.name} quarantined at ${q} (#190); clearing it is manual`)
        return q
    } catch (e) {
        log(`restoreApp: WARNING could not quarantine the pre-restore folder of ${instanceId} on ${prevDisk.name}: ${(e as Error).message}; it stays in place (#190)`)
        return null
    }
}
