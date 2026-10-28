/**
 * RemoveInstance.ts — removeInstance <instanceId> (idea#347, option A: quarantine).
 *
 * 1. `docker compose down` WITHOUT -v: containers go, named volumes are kept.
 * 2. Under the instance lock, the root helper renames <disk>/instances/<id> to
 *    <disk>/.idea-quarantine/<id>-<UTC stamp> (idea-app-data quarantine, helper v4).
 * 3. The record is dropped from instanceDB.
 * Nothing is deleted: the quarantine is never purged automatically; clearing it is
 * manual and needs Koen's OK.
 *
 * Refusals throw `CODE: text`, and the store is untouched on any failure:
 *   NOT_FOUND, NOT_LOCAL, AMBIGUOUS, RUNNING, BUSY_BACKUP, BUSY_MOVE, BUSY,
 *   COMPOSE_DOWN_FAILED, QUARANTINE_FAILED.
 */
import { DocHandle } from '@automerge/automerge-repo'
import { $, fs, path } from 'zx'
import type { Store } from './Store.js'
import type { Instance } from './Instance.js'
import type { InstanceID } from './CommonTypes.js'
import { lookupLocalInstanceArg } from './InstanceArg.js'
import { diskMountRoot, appDataRoot, Disk } from './Disk.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import { runAppData, quarantineArgs } from '../utils/appDataHelper.js'
import { log } from '../utils/utils.js'

export const QUARANTINE_DIR = '.idea-quarantine'

export class RemoveError extends Error {
    constructor(public code: string, text: string) { super(`${code}: ${text}`) }
}

export interface RemoveResult { instanceId: InstanceID; name: string; quarantinePath: string; keptVolumes: string[] }

export interface RemoveDeps {
    instanceDir: (disk: Disk, id: InstanceID) => Promise<string>
    composeDown: (dir: string, id: InstanceID) => Promise<void>
    listVolumes: (id: InstanceID) => Promise<string[]>
    quarantine: (disk: Disk, id: InstanceID) => Promise<string>
}

const defaultDeps: RemoveDeps = {
    instanceDir: async (disk, id) => path.join(await diskMountRoot(disk), 'instances', String(id)),
    composeDown: async (dir, id) => {
        if (!fs.existsSync(path.join(dir, 'compose.yaml'))) return
        await $({ cwd: dir })`docker compose -p ${id} down`.quiet()
    },
    listVolumes: async (id) => {
        try {
            const r = await $`docker volume ls -q --filter label=com.docker.compose.project=${id}`.quiet()
            return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
        } catch { return [] }
    },
    quarantine: async (disk, id) => (await runAppData(quarantineArgs(await appDataRoot(disk), String(id)))).trim(),
}

const RUNNING_STATES = new Set(['Running', 'Starting'])
const BACKUP_KINDS = new Set(['backupApp', 'restoreApp'])
const MOVE_KINDS = new Set(['moveApp', 'copyApp'])

export const removeInstance = async (
    storeHandle: DocHandle<Store>, instanceArg: string, engineId: string, deps: Partial<RemoveDeps> = {},
): Promise<RemoveResult> => {
    const d = { ...defaultDeps, ...deps }
    const store = storeHandle.doc()
    const r = lookupLocalInstanceArg(store, String(instanceArg ?? ''), engineId)
    if (!r.ok) {
        if (r.reason === 'not-found') throw new RemoveError('NOT_FOUND', `instance '${instanceArg}' not found on this Engine`)
        if (r.reason === 'not-local') throw new RemoveError('NOT_LOCAL', `instance '${instanceArg}' is not stored on a disk docked to this Engine`)
        throw new RemoveError('AMBIGUOUS', `instance name '${instanceArg}' is shared by several instances on this Engine; use the instance id`)
    }
    const inst: Instance = r.instance
    if (RUNNING_STATES.has(String(inst.status))) throw new RemoveError('RUNNING', `instance '${inst.name}' is ${inst.status}; stop it first`)

    const key = instanceKey(inst.id)
    if (!resourceLock.acquire(key, 'removeInstance')) {
        const kind = resourceLock.getLockInfo(key)?.kind ?? ''
        if (BACKUP_KINDS.has(kind)) throw new RemoveError('BUSY_BACKUP', `instance '${inst.name}' is being backed up or restored; retry when it completes`)
        if (MOVE_KINDS.has(kind)) throw new RemoveError('BUSY_MOVE', `instance '${inst.name}' is being copied or moved; retry when it completes`)
        throw new RemoveError('BUSY', `instance '${inst.name}' is busy (${kind || 'another operation'}); retry when it completes`)
    }
    try {
        const disk = store.diskDB[inst.storedOn!] as Disk
        const dir = await d.instanceDir(disk, inst.id)
        try {
            await d.composeDown(dir, inst.id)
        } catch (e) {
            throw new RemoveError('COMPOSE_DOWN_FAILED', `docker compose down failed for '${inst.name}': ${(e as Error).message}; nothing changed`)
        }
        const keptVolumes = await d.listVolumes(inst.id)
        let quarantinePath: string
        try {
            quarantinePath = await d.quarantine(disk, inst.id)
        } catch (e) {
            throw new RemoveError('QUARANTINE_FAILED', `cannot quarantine ${dir}: ${(e as Error).message}; the store is unchanged`)
        }
        storeHandle.change(doc => { delete doc.instanceDB[inst.id] })
        log(`removeInstance: ${inst.id} ('${inst.name}') quarantined at ${quarantinePath}; kept volumes: ${keptVolumes.length ? keptVolumes.join(', ') : 'none'}`)
        return { instanceId: inst.id, name: String(inst.name), quarantinePath, keptVolumes }
    } finally {
        resourceLock.release(key)
    }
}
