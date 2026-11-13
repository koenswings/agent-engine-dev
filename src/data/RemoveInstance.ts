/**
 * RemoveInstance.ts — removeInstance <instanceId> (idea#347, option A: quarantine).
 *
 * 1. `docker compose -p <id> -f <instanceDir>/compose.yaml down` WITHOUT -v:
 *    containers go, named volumes are kept. instanceDir comes from diskPath
 *    (idea#237 / idea#424): on the system disk that is /instances/<id>, never
 *    path.join(diskMountRoot()) which is the relative `instances/<id>` and
 *    makes the compose.yaml check silently skip. Never glob
 *    /.idea-quarantine/<id>-<stamp> — that directory is root:root 0700, so a
 *    path glob as pi matches nothing and compose down never runs.
 *    Then remove any leftover containers by com.docker.compose.project=<id>
 *    (`docker rm -f`, also without -v).
 * 2. Under the instance lock, the root helper renames <disk>/instances/<id> to
 *    <disk>/.idea-quarantine/<id>-<UTC stamp> (idea-app-data quarantine, helper v4).
 * 3. The record is dropped from instanceDB.
 * 4. Disk.preUpdateSnapshots, preUpdateBytes and quarantineBytes are refreshed
 *    from the helper (idea#428), the same way updateApp does after a snapshot.
 *    The removed instance's own snapshot entry is then dropped from the disk
 *    row (and subtracted from preUpdateBytes) so it does not linger if
 *    .pre-update/<id> is still on disk. That folder is never deleted.
 * Nothing is deleted: the quarantine is never purged automatically; clearing it is
 * manual and needs Koen's OK.
 *
 * After a successful remove, unused Docker networks labelled
 * `com.docker.compose.project=<id>` on this Engine are pruned (idea#468). Shared
 * frontend/backend networks are never removed, nor a network that still has
 * containers attached. A prune failure is logged and does not fail the command.
 *
 * If compose down or the label cleanup fails: COMPOSE_DOWN_FAILED is logged and
 * thrown, the folder is left in place, and the store is untouched.
 *
 * Refusals throw `CODE: text`, and the store is untouched on any failure:
 *   NOT_FOUND, NOT_LOCAL, AMBIGUOUS, RUNNING, BUSY_BACKUP, BUSY_MOVE, BUSY,
 *   COMPOSE_DOWN_FAILED, QUARANTINE_FAILED, HELPER_OUTDATED (helper older than v4).
 */
import { DocHandle } from '@automerge/automerge-repo'
import { $ } from 'zx'
import type { Store } from './Store.js'
import type { Instance } from './Instance.js'
import type { InstanceID } from './CommonTypes.js'
import { lookupLocalInstanceArg } from './InstanceArg.js'
import { diskPath, appDataRoot, Disk } from './Disk.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import { runAppData, quarantineArgs, helperAtLeast } from '../utils/appDataHelper.js'
import { log } from '../utils/utils.js'
import { composeDownAt, pruneUnusedInstanceNetworks } from '../utils/instanceNetworks.js'

export { composeDownAt } from '../utils/instanceNetworks.js'

export const QUARANTINE_DIR = '.idea-quarantine'

export class RemoveError extends Error {
    constructor(public code: string, text: string) { super(`${code}: ${text}`) }
}

export interface RemoveResult { instanceId: InstanceID; name: string; quarantinePath: string; keptVolumes: string[] }

export const REMOVE_HELPER_MIN = 4

/** Live instance folder. Absolute even on the system disk (idea#424 / idea#237). */
export const defaultInstanceDir = (disk: Disk, id: InstanceID): Promise<string> =>
    diskPath(disk, 'instances', String(id))

export const dockerQuiet = async (args: string[]): Promise<string> =>
    (await $`docker ${args}`.quiet()).stdout

/** Fallback: remove leftover containers of this compose project. No -v (volumes stay). */
export const removeContainersByComposeProject = async (
    id: InstanceID, run: (args: string[]) => Promise<string> = dockerQuiet,
): Promise<void> => {
    const raw = await run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${id}`])
    for (const cid of raw.split('\n').map(s => s.trim()).filter(Boolean)) {
        await run(['rm', '-f', cid])
    }
}

export interface RemoveDeps {
    helperProblem: () => Promise<string | null>
    instanceDir: (disk: Disk, id: InstanceID) => Promise<string>
    composeDown: (dir: string, id: InstanceID) => Promise<void>
    removeProjectContainers: (id: InstanceID) => Promise<void>
    listVolumes: (id: InstanceID) => Promise<string[]>
    quarantine: (disk: Disk, id: InstanceID) => Promise<string>
    /** Refresh Disk.preUpdateSnapshots / preUpdateBytes / quarantineBytes (idea#428). */
    refreshSnapshots: (disk: Disk) => Promise<void>
    /** idea#468: prune unused compose-project networks for this instance, locally. */
    pruneNetworks: (id: InstanceID) => Promise<void>
}

const defaultDeps: RemoveDeps = {
    helperProblem: () => helperAtLeast(REMOVE_HELPER_MIN, 'removeInstance'),
    instanceDir: defaultInstanceDir,
    composeDown: (dir, id) => composeDownAt(dir, id),
    removeProjectContainers: (id) => removeContainersByComposeProject(id),
    listVolumes: async (id) => {
        try {
            const out = await dockerQuiet(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${id}`])
            return out.split('\n').map(s => s.trim()).filter(Boolean)
        } catch { return [] }
    },
    quarantine: async (disk, id) => (await runAppData(quarantineArgs(await appDataRoot(disk), String(id)))).trim(),
    refreshSnapshots: async () => { /* replaced in removeInstance with a storeHandle-bound default */ },
    pruneNetworks: async (id) => { await pruneUnusedInstanceNetworks(String(id)) },
}

const RUNNING_STATES = new Set(['Running', 'Starting'])
const BACKUP_KINDS = new Set(['backupApp', 'restoreApp'])
const MOVE_KINDS = new Set(['moveApp', 'copyApp'])

export const removeInstance = async (
    storeHandle: DocHandle<Store>, instanceArg: string, engineId: string, deps: Partial<RemoveDeps> = {},
): Promise<RemoveResult> => {
    const d: RemoveDeps = {
        ...defaultDeps,
        refreshSnapshots: async (disk) => {
            const { refreshPreUpdateSnapshots, defaultUpdateDeps } = await import('./UpdateApp.js')
            await refreshPreUpdateSnapshots(storeHandle, disk, defaultUpdateDeps(storeHandle).listSnapshots)
        },
        ...deps,
    }
    const store = storeHandle.doc()
    const r = lookupLocalInstanceArg(store, String(instanceArg ?? ''), engineId)
    if (!r.ok) {
        if (r.reason === 'not-found') throw new RemoveError('NOT_FOUND', `instance '${instanceArg}' not found on this Engine`)
        if (r.reason === 'not-local') throw new RemoveError('NOT_LOCAL', `instance '${instanceArg}' is not stored on a disk docked to this Engine`)
        throw new RemoveError('AMBIGUOUS', `instance name '${instanceArg}' is shared by several instances on this Engine; use the instance id`)
    }
    const inst: Instance = r.instance
    if (RUNNING_STATES.has(String(inst.status))) throw new RemoveError('RUNNING', `instance '${inst.name}' is ${inst.status}; stop it first`)

    const helper = await d.helperProblem()
    if (helper) throw new RemoveError('HELPER_OUTDATED', helper)

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
            await d.removeProjectContainers(inst.id)
        } catch (e) {
            const msg = `docker compose down failed for '${inst.name}': ${(e as Error).message}; nothing changed`
            log(`removeInstance: ${msg}`)
            throw new RemoveError('COMPOSE_DOWN_FAILED', msg)
        }
        const keptVolumes = await d.listVolumes(inst.id)
        let quarantinePath: string
        try {
            quarantinePath = await d.quarantine(disk, inst.id)
        } catch (e) {
            throw new RemoveError('QUARANTINE_FAILED', `cannot quarantine ${dir}: ${(e as Error).message}; the store is unchanged`)
        }
        storeHandle.change(doc => { delete doc.instanceDB[inst.id] })
        try {
            await d.refreshSnapshots(disk)
        } catch (e) {
            log(`removeInstance: could not refresh pre-update snapshot info on ${disk.id}: ${(e as Error).message}`)
        }
        // Drop this instance from the disk row even if the helper still lists
        // .pre-update/<id> (the folder is never deleted). quarantineBytes stays
        // as the helper reported it, including the new quarantine folder (idea#428).
        storeHandle.change(doc => {
            const row = doc.diskDB[disk.id]
            if (!row) return
            const snaps = row.preUpdateSnapshots ?? []
            const kept = snaps.filter(s => String(s.instanceId) !== String(inst.id))
            if (kept.length === snaps.length) return
            const droppedBytes = snaps
                .filter(s => String(s.instanceId) === String(inst.id))
                .reduce((n, s) => n + (Number(s.sizeBytes) || 0), 0)
            row.preUpdateSnapshots = kept.map(s => ({ ...s }))
            row.preUpdateBytes = Math.max(0, (Number(row.preUpdateBytes) || 0) - droppedBytes)
        })
        log(`removeInstance: ${inst.id} ('${inst.name}') quarantined at ${quarantinePath}; kept volumes: ${keptVolumes.length ? keptVolumes.join(', ') : 'none'}`)
        try { await d.pruneNetworks(inst.id) } catch (e) {
            log(`removeInstance: network prune for ${inst.id}: ${(e as Error).message ?? e}`)
        }
        return { instanceId: inst.id, name: String(inst.name), quarantinePath, keptVolumes }
    } finally {
        resourceLock.release(key)
    }
}
