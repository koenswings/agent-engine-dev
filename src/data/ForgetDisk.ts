/**
 * ForgetDisk.ts — forgetDisk <diskId> (idea#279, idea#282)
 *
 * The sanctioned way to remove a stale disk record from the shared store, for
 * example the record an older Engine created when it wrote META.yaml onto a
 * client SD card (idea#282). Only an undocked record can be forgotten. Nothing
 * on any disk is touched: this is a store edit only.
 *
 * `forgetDisk <diskId> --with-instances` (idea#466) also drops every instance
 * record storedOn that disk, for a disk that is gone (reflashed, lost). Allowed
 * only when the disk is undocked on every Engine and none of its instances can
 * have a running container anywhere (store status Running/Starting or unknown
 * refuses). Refusals throw `CODE: text` and leave the store untouched. The
 * default forgetDisk is unchanged, and removeInstance is not relaxed.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { Store, getInstancesOfDisk } from './Store.js'
import { DiskID, InstanceID } from './CommonTypes.js'
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

// ── forgetDisk --with-instances (idea#466) ───────────────────────────────────

export const WITH_INSTANCES_FLAG = '--with-instances'

/** Refusal of forgetDisk --with-instances; message is `CODE: text` (like removeInstance). */
export class ForgetDiskError extends Error {
    constructor(public code: ForgetDiskErrorCode, text: string) { super(`${code}: ${text}`) }
}

export type ForgetDiskErrorCode =
    | 'NOT_FOUND'                // no record with exactly that id
    | 'DOCKED'                   // dockedTo or device set on the record
    | 'INSTANCE_RUNNING'         // an instance on it is Running or Starting
    | 'INSTANCE_STATUS_UNKNOWN'  // an instance on it has no or an unrecognised status
    | 'BAD_OPTION'               // an option other than --with-instances
    | 'CHANGED'                  // the store moved on between the check and the change

/** Store statuses that mean no container of the instance can be running (Instance.ts Status). */
export const NOT_RUNNING_STATUSES: ReadonlySet<string> = new Set(['Undocked', 'Docked', 'Stopped', 'Missing', 'Error'])
/** Store statuses that mean a container may be running ('Pauzed' keeps its containers). */
export const RUNNING_STATUSES: ReadonlySet<string> = new Set(['Running', 'Starting', 'Pauzed'])

export interface ForgetDiskWithInstancesResult {
    diskId: DiskID
    diskName: string
    removedInstances: { id: InstanceID, name: string, status: string }[]
}

/**
 * Why `forgetDisk <diskId> --with-instances` is refused, or the plan. The instance
 * status is the shared store value every Engine writes, so it covers every Engine.
 */
export const checkForgetDiskWithInstances = (store: Store, diskId: string):
    { ok: true, plan: ForgetDiskWithInstancesResult } | { ok: false, error: ForgetDiskError } => {
    const disk = store.diskDB?.[diskId as DiskID]
    if (!disk) return { ok: false, error: new ForgetDiskError('NOT_FOUND', `Disk '${diskId}' not found (forgetDisk takes the exact disk id).`) }
    const label = `'${disk.name}' (${disk.id})`
    if (disk.dockedTo || disk.device) {
        const where = [disk.dockedTo ? `to ${disk.dockedTo}` : '', disk.device ? `on ${disk.device}` : ''].filter(Boolean).join(' ')
        return { ok: false, error: new ForgetDiskError('DOCKED', `Disk ${label} is docked ${where}; --with-instances needs a disk that is undocked on every Engine. Eject or unplug it first.`) }
    }
    const instances = getInstancesOfDisk(store, disk)
    const running = instances.filter(i => RUNNING_STATUSES.has(String(i.status)))
    if (running.length) {
        return { ok: false, error: new ForgetDiskError('INSTANCE_RUNNING', `Disk ${label}: instance(s) ${running.map(i => `${i.id} (${i.status})`).join(', ')} may have a running container; nothing removed. Stop them first.`) }
    }
    const unknown = instances.filter(i => !NOT_RUNNING_STATUSES.has(String(i.status ?? '')))
    if (unknown.length) {
        return { ok: false, error: new ForgetDiskError('INSTANCE_STATUS_UNKNOWN', `Disk ${label}: instance(s) ${unknown.map(i => `${i.id} (status ${i.status ?? 'missing'})`).join(', ')} have an unknown status, so a running container cannot be ruled out; nothing removed.`) }
    }
    return {
        ok: true,
        plan: {
            diskId: disk.id,
            diskName: String(disk.name),
            removedInstances: instances.map(i => ({ id: i.id, name: String(i.name), status: String(i.status) })),
        },
    }
}

/**
 * Remove the undocked disk record and every instance record storedOn it, in one
 * store change (idea#466). Throws ForgetDiskError when refused; the store is
 * then untouched. Nothing on any disk is read or written.
 */
export const forgetDiskWithInstances = (storeHandle: DocHandle<Store>, diskId: string): ForgetDiskWithInstancesResult => {
    const first = checkForgetDiskWithInstances(storeHandle.doc(), diskId)
    if (!first.ok) throw first.error
    let result: ForgetDiskWithInstancesResult | null = null
    let refusal: ForgetDiskError | null = null
    storeHandle.change(doc => {
        // Re-check inside the change: the doc may have moved on since doc()
        const again = checkForgetDiskWithInstances(doc as Store, diskId)
        if (!again.ok) { refusal = again.error; return }
        for (const inst of again.plan.removedInstances) delete doc.instanceDB[inst.id]
        delete doc.diskDB[diskId as DiskID]
        result = again.plan
    })
    if (refusal) throw new ForgetDiskError('CHANGED', `Disk '${diskId}' changed while it was being forgotten; nothing removed (${(refusal as ForgetDiskError).message}).`)
    if (!result) throw new ForgetDiskError('CHANGED', `Disk '${diskId}' changed while it was being forgotten; nothing removed.`)
    const r = result as ForgetDiskWithInstancesResult
    log(`forgetDisk --with-instances: removed the undocked disk record ${r.diskId} and instance record(s) ${r.removedInstances.map(i => i.id).join(', ') || '(none)'}`)
    return r
}
