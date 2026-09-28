/**
 * cleanup-store-lib.ts — pure helpers for script/cleanup-store.ts
 *
 * Kept free of side effects (no store loading, no process.exit) so the rules
 * can be unit-tested.
 */

export interface StoreLike {
    engineDB?: Record<string, any>
    diskDB?: Record<string, any>
    instanceDB?: Record<string, any>
    operationDB?: Record<string, any>
}

/**
 * Disks that are system disks: an engine has id 'ENGINE_' + diskId, or the disk
 * has diskType 'system'.
 */
export const findSystemDiskIds = (store: StoreLike): Set<string> => {
    const engineIds = new Set(Object.keys(store.engineDB ?? {}))
    const disks = store.diskDB ?? {}
    return new Set(
        Object.keys(disks).filter(diskId =>
            engineIds.has('ENGINE_' + diskId) || (disks[diskId].diskTypes ?? []).includes('system')
        )
    )
}

/**
 * Orphan diskDB entries (idea#121).
 *
 * Before idea#121 a disk without META.yaml and without a readable hardware
 * serial got a new random diskId on every dock, so each undock left an entry
 * behind that no disk can ever match again. An entry is an orphan when:
 *   - it is not docked (no dockedTo, no device),
 *   - it is not a system disk,
 *   - no instance in instanceDB is stored on it,
 *   - it has no backupConfig (not a Backup Disk), and
 *   - no operation in operationDB names it in its args.
 *
 * Removing an orphan loses no data: it holds only a name and timestamps. A disk
 * that does have a META.yaml gets its entry back, with the same id, on its next
 * dock.
 */
export const findOrphanDiskIds = (store: StoreLike): string[] => {
    const disks = store.diskDB ?? {}
    const systemDiskIds = findSystemDiskIds(store)
    const storedOn = new Set(
        Object.values(store.instanceDB ?? {}).map((i: any) => i?.storedOn).filter(Boolean)
    )
    const inOperations = new Set(
        Object.values(store.operationDB ?? {}).flatMap((op: any) => Object.values(op?.args ?? {}))
    )
    return Object.keys(disks).filter(id => {
        const d = disks[id]
        if (d.device || d.dockedTo) return false
        if (systemDiskIds.has(id)) return false
        if (storedOn.has(id)) return false
        if (d.backupConfig) return false
        if (inOperations.has(id)) return false
        return true
    })
}
