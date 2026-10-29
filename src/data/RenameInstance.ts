/**
 * RenameInstance.ts — renameInstance <instanceId> <newName…> (agent-engine-dev#220).
 *
 * Changes only the display name: x-app.instanceName in the instance's compose.yaml
 * (dock and Engine start re-read the name from there, Instance.ts) and instance.name
 * in the store. The id, folder, Docker project, containers, data and port stay the same.
 * Nothing uses the display name as a key (paths, volumes and projects use the id), so a
 * running instance may be renamed. The instance lock is held for the compose write, so a
 * copy, move, backup or restore never sees a half-written compose.yaml (BUSY instead).
 *
 * Refusals throw `CODE: text` so the command trace ends as `error`:
 *   NOT_FOUND, NOT_LOCAL, AMBIGUOUS, EMPTY_NAME, NAME_TOO_LONG, BAD_NAME, NAME_TAKEN,
 *   BUSY, COMPOSE_WRITE_FAILED. The same name as now is a no-op ok.
 */
import { DocHandle } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import type { Store } from './Store.js'
import type { InstanceID, InstanceName } from './CommonTypes.js'
import { lookupLocalInstanceArg } from './InstanceArg.js'
import { MAX_INSTANCE_NAME_LENGTH } from './InstallApp.js'
import { setComposeInstanceName } from './InstanceCopy.js'
import { diskMountRoot } from './Disk.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import { log } from '../utils/utils.js'

export class RenameError extends Error {
    constructor(public code: string, text: string) { super(`${code}: ${text}`) }
}

export interface RenameResult { instanceId: InstanceID; oldName: string; newName: string; changed: boolean }

/** Trimmed, checked name or a RenameError (same limits as installApp --name). */
export const validateNewInstanceName = (raw: string): string => {
    const name = (raw ?? '').trim()
    if (name.length === 0) throw new RenameError('EMPTY_NAME', 'the new name is empty')
    if (name.length > MAX_INSTANCE_NAME_LENGTH) throw new RenameError('NAME_TOO_LONG', `the new name is longer than ${MAX_INSTANCE_NAME_LENGTH} characters`)
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new RenameError('BAD_NAME', 'the new name must not contain control characters or newlines')
    return name
}

export interface RenameDeps {
    instanceRoot: (store: Store, instanceId: InstanceID) => Promise<string>
}
const defaultDeps: RenameDeps = {
    instanceRoot: async (store, id) => {
        const inst = store.instanceDB[id]
        const disk = store.diskDB[inst.storedOn!]
        return path.join(await diskMountRoot(disk as any), 'instances', String(id))
    },
}

export const renameInstance = async (
    storeHandle: DocHandle<Store>, instanceArg: string, rawName: string, engineId: string,
    deps: Partial<RenameDeps> = {},
): Promise<RenameResult> => {
    const d = { ...defaultDeps, ...deps }
    const store = storeHandle.doc()
    const r = lookupLocalInstanceArg(store, String(instanceArg ?? ''), engineId)
    if (!r.ok) {
        if (r.reason === 'not-found') throw new RenameError('NOT_FOUND', `instance '${instanceArg}' not found on this Engine`)
        if (r.reason === 'not-local') throw new RenameError('NOT_LOCAL', `instance '${instanceArg}' is not stored on a disk docked to this Engine`)
        throw new RenameError('AMBIGUOUS', `instance name '${instanceArg}' is shared by several instances on this Engine; use the instance id`)
    }
    const inst = r.instance
    const newName = validateNewInstanceName(rawName)
    const oldName = String(inst.name)
    if (newName === oldName) return { instanceId: inst.id, oldName, newName, changed: false }
    const taken = Object.values(store.instanceDB ?? {}).find(i =>
        i && i.id !== inst.id && String(i.name).toLowerCase() === newName.toLowerCase()
        && lookupLocalInstanceArg(store, String(i.id), engineId).ok)
    if (taken) throw new RenameError('NAME_TAKEN', `instance ${taken.id} on this Engine is already named '${taken.name}'`)

    const key = instanceKey(inst.id)
    if (!resourceLock.acquire(key, 'renameInstance')) {
        const held = resourceLock.getLockInfo(key)
        throw new RenameError('BUSY', `instance '${oldName}' is busy (${held?.kind ?? 'another operation'}); retry when it completes`)
    }
    try {
        const composeFile = path.join(await d.instanceRoot(store, inst.id), 'compose.yaml')
        try {
            const text = await fs.readFile(composeFile, 'utf-8')
            await fs.writeFile(composeFile, setComposeInstanceName(text, newName))
        } catch (e) {
            throw new RenameError('COMPOSE_WRITE_FAILED', `cannot update ${composeFile}: ${(e as Error).message}; nothing changed`)
        }
        storeHandle.change(doc => {
            const s = doc.instanceDB[inst.id]
            if (s) s.name = newName as InstanceName
        })
        log(`renameInstance: '${oldName}' -> '${newName}' (${inst.id})`)
        return { instanceId: inst.id, oldName, newName, changed: true }
    } finally {
        resourceLock.release(key)
    }
}
