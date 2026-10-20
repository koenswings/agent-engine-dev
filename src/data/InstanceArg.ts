/**
 * InstanceArg.ts — resolve an instance argument id-first (idea#168).
 *
 * Instance names are not unique: copyApp used to give the copy the original's
 * name, so two instances named e.g. "kolibri" could exist, and name lookups
 * (findInstanceByName, `find(i => i.name === …)`) silently took the first one.
 * Every command that takes an instance argument now goes through this module:
 *
 *   1. Id first. An instanceDB key equal to the argument wins.
 *   2. Unique name. Exactly one instance with that name.
 *   3. Name on the command's disk. When several instances share the name and
 *      the command also names a disk (startInstance/stopInstance/runInstance
 *      `<instance> <diskId|diskName>`, copyApp/moveApp `<instance> <sourceDiskId> …`),
 *      exactly one of them stored on that disk. This keeps the Console's wire
 *      format (`startInstance <name> <storedOn>`, `copyApp <name> <sourceDiskId> …`)
 *      working and unambiguous.
 *   4. Otherwise refused: ambiguous (the candidate ids are listed) or not found.
 */

import type { Store } from './Store.js'
import type { Instance } from './Instance.js'
import type { InstanceID } from './CommonTypes.js'

export type InstanceArgLookup =
    | { ok: true; instance: Instance; via: 'id' | 'name' | 'name-on-disk' }
    | { ok: false; reason: 'not-found' }
    | { ok: false; reason: 'ambiguous'; candidates: Instance[] }

/** True when the instance is stored on the disk given as an id or a disk name. */
export const instanceIsOnDisk = (store: Store, instance: Instance, diskArg: string): boolean => {
    if (!instance.storedOn) return false
    if (String(instance.storedOn) === diskArg) return true
    const disk = store.diskDB?.[instance.storedOn]
    return !!disk && String(disk.name) === diskArg
}

/** Pure lookup; see the module comment for the order. Never throws. */
export const lookupInstanceArg = (store: Store, arg: string, diskArg?: string): InstanceArgLookup => {
    const byId = store.instanceDB?.[arg as InstanceID]
    if (byId) return { ok: true, instance: byId, via: 'id' }
    const named = Object.values(store.instanceDB ?? {}).filter(i => i && String(i.name) === arg)
    if (named.length === 0) return { ok: false, reason: 'not-found' }
    if (named.length === 1) return { ok: true, instance: named[0], via: 'name' }
    if (diskArg) {
        const onDisk = named.filter(i => instanceIsOnDisk(store, i, diskArg))
        if (onDisk.length === 1) return { ok: true, instance: onDisk[0], via: 'name-on-disk' }
        if (onDisk.length > 1) return { ok: false, reason: 'ambiguous', candidates: onDisk }
    }
    return { ok: false, reason: 'ambiguous', candidates: named }
}

export const describeInstanceCandidates = (candidates: Instance[]): string =>
    candidates.map(i => `${i.id} (on disk ${i.storedOn ?? 'none'})`).join(', ')

/**
 * Command form: returns the instance or throws (so the command trace ends as
 * `error`). A name that was only unambiguous on the given disk logs a warning
 * into the trace, naming the id to use instead.
 */
export const resolveInstanceArg = (store: Store, arg: string, command: string, diskArg?: string): Instance => {
    const r = lookupInstanceArg(store, arg, diskArg)
    if (r.ok) {
        if (r.via === 'name-on-disk') {
            console.warn(`${command}: instance name '${arg}' is shared by several instances; using ${r.instance.id}, the one on disk ${diskArg}. Send the instance id.`)
        }
        return r.instance
    }
    if (r.reason === 'ambiguous') {
        throw new Error(`${command}: instance name '${arg}' is ambiguous: ${describeInstanceCandidates(r.candidates)}. Use the instance id.`)
    }
    throw new Error(`${command}: instance '${arg}' not found.`)
}

/**
 * True when the instance is stored on a disk that is docked to the given Engine
 * (an App Disk or the system disk of that Engine).
 */
export const instanceIsOnEngine = (store: Store, instance: Instance, engineId: string): boolean => {
    if (!instance?.storedOn) return false
    const disk = store.diskDB?.[instance.storedOn]
    return !!disk && String(disk.dockedTo) === String(engineId)
}

export type LocalInstanceArgLookup =
    | { ok: true; instance: Instance; via: 'id' | 'name' }
    | { ok: false; reason: 'not-found' }
    | { ok: false; reason: 'not-local'; instance: Instance }
    | { ok: false; reason: 'ambiguous'; candidates: Instance[] }

/**
 * Lookup scoped to one Engine (createBackupDisk, kind-panda / happy-zebra 2026-10-17):
 * kit Engines share one store and have instances with identical names, so a name
 * must only match instances stored on disks docked to this Engine.
 *   1. Id first: accepted when that instance is on this Engine, else 'not-local'.
 *   2. Exactly one instance with that name on this Engine.
 *   3. Otherwise refused: ambiguous on this Engine, or not found on this Engine.
 * Never throws.
 */
export const lookupLocalInstanceArg = (store: Store, arg: string, engineId: string): LocalInstanceArgLookup => {
    const byId = store.instanceDB?.[arg as InstanceID]
    if (byId) return instanceIsOnEngine(store, byId, engineId) ? { ok: true, instance: byId, via: 'id' } : { ok: false, reason: 'not-local', instance: byId }
    const named = Object.values(store.instanceDB ?? {}).filter(i => i && String(i.name) === arg && instanceIsOnEngine(store, i, engineId))
    if (named.length === 1) return { ok: true, instance: named[0], via: 'name' }
    if (named.length > 1) return { ok: false, reason: 'ambiguous', candidates: named }
    return { ok: false, reason: 'not-found' }
}

/** Command form of lookupLocalInstanceArg: returns the instance or throws. */
export const resolveLocalInstanceArg = (store: Store, arg: string, command: string, engineId: string): Instance => {
    const r = lookupLocalInstanceArg(store, arg, engineId)
    if (r.ok) return r.instance
    if (r.reason === 'ambiguous') {
        throw new Error(`${command}: instance name '${arg}' is ambiguous on this Engine: ${describeInstanceCandidates(r.candidates)}. Use the instance id.`)
    }
    if (r.reason === 'not-local') {
        throw new Error(`${command}: instance ${arg} is not on this Engine (stored on disk ${r.instance.storedOn ?? 'none'}, not docked here).`)
    }
    throw new Error(`${command}: instance '${arg}' not found on this Engine.`)
}
