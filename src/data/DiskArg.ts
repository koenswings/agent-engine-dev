/**
 * DiskArg.ts: one resolver for every disk argument of a command (idea#128)
 *
 * Files Disk step 0b: disk-targeting commands take the disk ID (installApp
 * target and --source, createBackupDisk, ejectDisk). The rules come from
 * idea#152 (#134, ejectDisk):
 *   1. A disk id: that record, which must be docked to this engine with a device.
 *   2. Otherwise a disk name, for older Consoles and the CLI (mixed versions):
 *      only records docked to this engine with a device count. Exactly one
 *      → accepted, with a deprecation warning naming the command and the disk.
 *      Two or more → refused as ambiguous. None → refused (not found, not
 *      docked, or docked to another engine).
 * The system disk resolves like any disk (it is a valid installApp target);
 * ejectDisk refuses it separately.
 *
 * resolveDiskArg() throws on a refusal, so the command trace ends as `error`.
 */

import { Store } from './Store.js'
import { Disk } from './Disk.js'
import { DiskID, EngineID } from './CommonTypes.js'

export type DiskArgResult =
    | { ok: true, disk: Disk, byName: boolean }
    | { ok: false, message: string }

/**
 * Look up a disk by id only (no name fallback): for commands that have no old
 * name form, such as createFilesDisk (idea#131). The record must be docked to
 * this engine and have a device.
 */
export const lookupDiskById = (store: Store, engineId: EngineID | undefined, id: string): DiskArgResult => {
    const byId = store.diskDB[id as DiskID]
    if (!byId) return { ok: false, message: `Disk '${id}' not found.` }
    if (!byId.device) return { ok: false, message: `Disk '${byId.name}' (${byId.id}) is not currently docked.` }
    if (String(byId.dockedTo) !== String(engineId)) return { ok: false, message: `Disk '${byId.name}' (${byId.id}) is not docked to this engine.` }
    return { ok: true, disk: byId, byName: false }
}

/** Resolve without side effects (no warning, no throw). */
export const lookupDiskArg = (store: Store, engineId: EngineID | undefined, arg: string): DiskArgResult => {
    if (store.diskDB[arg as DiskID]) return lookupDiskById(store, engineId, arg)
    const named = Object.values(store.diskDB).filter(d => d.name === arg)
    if (named.length === 0) return { ok: false, message: `Disk '${arg}' not found.` }
    const dockedHere = named.filter(d => d.device != null && String(d.dockedTo) === String(engineId))
    if (dockedHere.length === 1) return { ok: true, disk: dockedHere[0], byName: true }
    if (dockedHere.length > 1) {
        return { ok: false, message: `Disk name '${arg}' is ambiguous: ${dockedHere.map(d => `${d.id} (${d.device})`).join(', ')} are docked to this engine. Use the disk id.` }
    }
    if (named.some(d => d.device != null)) return { ok: false, message: `Disk '${arg}' is not docked to this engine.` }
    return { ok: false, message: `Disk '${arg}' is not currently docked.` }
}

/**
 * Resolve a disk argument of `command` on this engine. Throws on a refusal;
 * warns (console.warn, so it lands in the trace) when a name was used.
 */
export const resolveDiskArg = (store: Store, engineId: EngineID | undefined, arg: string, command: string): Disk => {
    const r = lookupDiskArg(store, engineId, arg)
    if (!r.ok) throw new Error(r.message)
    if (r.byName) {
        console.warn(`${command}: disk '${r.disk.name}' was given by name; use the disk id ${r.disk.id} (names are deprecated, idea#128).`)
    }
    return r.disk
}
