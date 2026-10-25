/**
 * ForgetDisk.ts — forgetDisk <diskId> (idea#279, idea#282)
 *
 * The sanctioned way to remove a stale disk record from the shared store, for
 * example the record an older Engine created when it wrote META.yaml onto a
 * client SD card (idea#282). Only an undocked record can be forgotten. Nothing
 * on any disk is touched: this is a store edit only.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { Store, getInstancesOfDisk } from './Store.js'
import { DiskID } from './CommonTypes.js'
import { log } from '../utils/utils.js'

export type ForgetDiskCheck =
    | { ok: true }
    | { ok: false, reason: string }

/**
 * Why a record may not be forgotten, or ok. Refused when:
 *   - there is no record with exactly that id (no name fallback: forgetting is irreversible)
 *   - the record is docked (dockedTo or device set): eject it first
 *   - instances are still stored on it (their records would be orphaned)
 */
export const checkForgetDisk = (store: Store, diskId: string): ForgetDiskCheck => {
    const disk = store.diskDB?.[diskId as DiskID]
    if (!disk) return { ok: false, reason: `Disk '${diskId}' not found (forgetDisk takes the exact disk id).` }
    const label = `'${disk.name}' (${disk.id})`
    if (disk.dockedTo || disk.device) {
        return { ok: false, reason: `Disk ${label} is docked${disk.dockedTo ? ` to ${disk.dockedTo}` : ''}; only an undocked disk can be forgotten. Eject or unplug it first.` }
    }
    const instances = getInstancesOfDisk(store, disk)
    if (instances.length > 0) {
        return { ok: false, reason: `Disk ${label} still holds instance record(s) ${instances.map(i => i.id).join(', ')}; forgetDisk does not remove instances.` }
    }
    return { ok: true }
}

/** Remove the undocked disk record. Throws with the reason when refused. */
export const forgetDisk = (storeHandle: DocHandle<Store>, diskId: string): DiskID => {
    const check = checkForgetDisk(storeHandle.doc(), diskId)
    if (!check.ok) throw new Error(check.reason)
    let removed = false
    storeHandle.change(doc => {
        // Re-check inside the change: the doc may have moved on since doc()
        if (checkForgetDisk(doc as Store, diskId).ok && doc.diskDB[diskId as DiskID]) {
            delete doc.diskDB[diskId as DiskID]
            removed = true
        }
    })
    if (!removed) throw new Error(`Disk '${diskId}' changed while it was being forgotten; nothing removed.`)
    log(`forgetDisk: removed the undocked disk record ${diskId}`)
    return diskId as DiskID
}
