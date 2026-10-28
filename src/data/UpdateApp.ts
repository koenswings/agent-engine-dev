/**
 * UpdateApp.ts — updateApp <instance> <newAppId> [--allow-major] [--source <diskId>]
 * (agent-engine-dev#230, v1 local swap; proposal idea#351, shapes console#168).
 *
 * Steps (UPDATE_STEPS): Fetch → Check → Snapshot → Swap → Start → Health.
 *  - Fetch: the bundle apps/<newAppId>/ on a disk docked HERE (cross-Engine Fetch is #263).
 *  - Check: refusals from checkUpdate (UpdateAppPolicy.ts), full SHA256SUMS verify, helper v5,
 *    a free-space pre-check, all before anything changes.
 *  - Snapshot: stop the instance, wait until its containers are really gone (the
 *    restart: unless-stopped race), then `idea-app-data snapshot` copies instances/<id>
 *    (bundle files, .env and data) to <disk>/.pre-update/<id>/ with a COMPLETE marker last.
 *  - Swap: copy the new bundle files over the instance folder (.env kept), set
 *    x-app.instanceName again, re-read the record (instanceOf = newAppId).
 *  - Start, Health: startInstance, then the health gate (healthGate) within healthTimeout.
 * Any failure from Snapshot on rolls back: compose down (no -v), `restore-snapshot` (the
 * current folder is moved aside to .idea-quarantine first, so even that is undoable), re-read
 * the record, start the old version. Result text: "ROLLED BACK: <why>"; when the rollback
 * itself fails the instance is left Stopped with statusCondition "ROLLBACK FAILED: ...".
 * Nothing is ever deleted; snapshots are kept (cleanup is a backlog item, quarantine only).
 *
 * Named Docker volumes are not part of the snapshot (the snapshot is the instance folder).
 */
import { DocHandle } from '@automerge/automerge-repo'
import { $, fs, path, YAML, sleep } from 'zx'
import type { Store } from './Store.js'
import type { Instance } from './Instance.js'
import type { AppID, DiskID, InstanceID, Timestamp } from './CommonTypes.js'
import { lookupLocalInstanceArg } from './InstanceArg.js'
import { diskMountRoot, appDataRoot, Disk, PreUpdateSnapshot } from './Disk.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import {
    runAppData, snapshotArgs, restoreSnapshotArgs, snapshotsArgs, parseSnapshotResult, parseSnapshotsList,
    helperAtLeast, instanceDataBytes, lastLine,
} from '../utils/appDataHelper.js'
import { createOperation, updateOperation } from './Operations.js'
import { log } from '../utils/utils.js'
import {
    UpdateAppError, UpdateStep, UPDATE_STEPS, checkUpdate, healthGate, healthTimeoutSeconds, rollbackPlan,
    HealthSample, ContainerHealth,
} from './UpdateAppPolicy.js'
import { parseAppId } from './App.js'
import { setComposeInstanceName } from './InstanceCopy.js'

export const UPDATE_HELPER_MIN = 5
export const UPDATE_PROGRESS_TYPE = 'idea/updateProgress'
export const PRE_UPDATE_DIR = '.pre-update'
export const UPDATE_APP_USAGE = 'Usage: updateApp <instanceId|name> <newAppId> [--allow-major] [--source <diskId>]'
/** Same margin as the helper: 10 % of the data, at least 1 GiB. */
export const snapshotMarginBytes = (bytes: number): number => Math.max(Math.floor(bytes / 10), 1024 * 1024 * 1024)

export interface UpdateProgress { type: typeof UPDATE_PROGRESS_TYPE; engineId: string; instanceId: string; step: UpdateStep; bytesDone: number; bytesTotal: number }

export interface UpdateResult {
    instanceId: InstanceID; name: string; fromAppId: AppID; toAppId: AppID
    snapshotPath: string; snapshotBytes: number; steps: UpdateStep[]
}

export interface UpdateDeps {
    helperProblem: () => Promise<string | null>
    mountRoot: (disk: Disk) => Promise<string>
    verifySums: (bundleDir: string) => Promise<boolean>
    instanceBytes: (disk: Disk, id: InstanceID) => Promise<number>
    freeBytes: (dir: string) => Promise<number>
    dirBytes: (dir: string) => Promise<number>
    copyBundle: (src: string, dst: string) => Promise<void>
    stop: (inst: Instance, disk: Disk) => Promise<void>
    containerIds: (id: InstanceID) => Promise<string[]>
    composeDown: (dir: string, id: InstanceID) => Promise<void>
    snapshot: (disk: Disk, id: InstanceID) => Promise<{ path: string, sizeBytes: number }>
    restoreSnapshot: (disk: Disk, id: InstanceID) => Promise<string>
    listSnapshots: (disk: Disk) => Promise<PreUpdateSnapshot[]>
    reread: (disk: Disk, id: InstanceID) => Promise<void>
    start: (inst: Instance, disk: Disk) => Promise<void>
    health: (id: InstanceID) => Promise<Omit<HealthSample, 'elapsedMs'>>
    broadcast: (msg: UpdateProgress) => void
    now: () => number
    sleep: (ms: number) => Promise<void>
    stopWaitMs: number
    pollMs: number
}

const docker = async (args: string[]): Promise<string> => (await $`docker ${args}`.quiet()).stdout

/** Worst state over the instance's containers; a one-shot container that exited 0 is fine. */
export const aggregateHealth = (states: { status: string, health?: string, exitCode?: number, restartCount?: number }[]): Omit<HealthSample, 'elapsedMs'> => {
    let state: ContainerHealth = 'none'
    const rank: Record<ContainerHealth, number> = { none: 0, healthy: 0, starting: 1, unhealthy: 1, restarting: 2, exited: 3 }
    let restartCount = 0
    for (const c of states) {
        restartCount = Math.max(restartCount, c.restartCount ?? 0)
        let s: ContainerHealth
        if (c.status === 'exited' || c.status === 'dead') { if ((c.exitCode ?? 1) === 0) continue; s = 'exited' }
        else if (c.status === 'restarting') s = 'restarting'
        else if (c.status === 'created') s = 'starting'
        else s = (c.health === 'healthy' || c.health === 'starting' || c.health === 'unhealthy') ? c.health : 'none'
        if (rank[s] > rank[state] || (rank[s] === rank[state] && s !== 'none')) state = s
    }
    if (!states.length) state = 'exited'
    return { state, restartCount }
}

export const defaultUpdateDeps = (storeHandle: DocHandle<Store>): UpdateDeps => ({
    helperProblem: () => helperAtLeast(UPDATE_HELPER_MIN, 'updateApp'),
    mountRoot: (disk) => diskMountRoot(disk),
    verifySums: async (dir) => {
        if (!await fs.pathExists(path.join(dir, 'SHA256SUMS'))) return false
        try { await $({ cwd: dir })`sha256sum --check --strict --quiet SHA256SUMS`.quiet(); return true } catch { return false }
    },
    instanceBytes: async (disk, id) => instanceDataBytes(await appDataRoot(disk), String(id)),
    freeBytes: async (dir) => (await import('./CopyMoveApp.js')).availableBytes(dir),
    dirBytes: async (dir) => (await import('./CopyMoveApp.js')).directoryBytes(dir),
    copyBundle: async (src, dst) => {
        for (const name of await fs.readdir(src)) {
            if (name === '.env' || name === 'SHA256SUMS') continue
            await fs.copy(path.join(src, name), path.join(dst, name), { overwrite: true })
        }
    },
    stop: async (inst, disk) => (await import('./Instance.js')).stopInstance(storeHandle, inst, disk),
    containerIds: async (id) => (await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${id}`])).split('\n').map(s => s.trim()).filter(Boolean),
    composeDown: async (dir, id) => {
        if (!await fs.pathExists(path.join(dir, 'compose.yaml'))) return
        await $({ cwd: dir })`docker compose -p ${id} down`.quiet()
    },
    snapshot: async (disk, id) => parseSnapshotResult(await runAppData(snapshotArgs(await appDataRoot(disk), String(id)))),
    restoreSnapshot: async (disk, id) => lastLine(await runAppData(restoreSnapshotArgs(await appDataRoot(disk), String(id)))),
    listSnapshots: async (disk) => parseSnapshotsList(await runAppData(snapshotsArgs(await appDataRoot(disk)))) as PreUpdateSnapshot[],
    reread: async (disk, id) => { await (await import('./Instance.js')).createOrUpdateInstance(storeHandle, id, disk) },
    start: async (inst, disk) => (await import('./Instance.js')).startInstance(storeHandle, inst, disk),
    health: async (id) => {
        const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${id}`])).split('\n').map(s => s.trim()).filter(Boolean)
        if (!ids.length) return aggregateHealth([])
        const info = JSON.parse(await docker(['inspect', ...ids])) as any[]
        return aggregateHealth(info.map(c => ({ status: c?.State?.Status, health: c?.State?.Health?.Status, exitCode: c?.State?.ExitCode, restartCount: c?.RestartCount })))
    },
    broadcast: (msg) => { try { storeHandle.broadcast(msg) } catch { /* no peers */ } },
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    stopWaitMs: 120_000,
    pollMs: 5_000,
})

export interface UpdateOptions { allowMajor?: boolean; sourceDiskId?: string }

export const parseUpdateAppArgs = (argsString: string): { instanceArg: string, newAppId: string, opts: UpdateOptions } => {
    const words = String(argsString ?? '').trim().split(/\s+/).filter(Boolean)
    const opts: UpdateOptions = {}
    const pos: string[] = []
    for (let i = 0; i < words.length; i++) {
        if (words[i] === '--allow-major') opts.allowMajor = true
        else if (words[i] === '--source') { opts.sourceDiskId = words[++i]; if (!opts.sourceDiskId) throw new Error(UPDATE_APP_USAGE) }
        else if (words[i].startsWith('--')) throw new Error(`unknown option ${words[i]}. ${UPDATE_APP_USAGE}`)
        else pos.push(words[i])
    }
    if (pos.length !== 2) throw new Error(UPDATE_APP_USAGE)
    return { instanceArg: pos[0], newAppId: pos[1], opts }
}

/** Wait until no container of the compose project exists any more (restart: unless-stopped race). */
export const waitContainersGone = async (d: Pick<UpdateDeps, 'containerIds' | 'now' | 'sleep' | 'stopWaitMs' | 'pollMs'>, id: InstanceID): Promise<void> => {
    const until = d.now() + d.stopWaitMs
    for (;;) {
        const left = await d.containerIds(id)
        if (!left.length) return
        if (d.now() >= until) throw new Error(`containers of ${id} are still running ${Math.round(d.stopWaitMs / 1000)} s after the stop: ${left.join(', ')}`)
        await d.sleep(d.pollMs)
    }
}

/** Refresh Disk.preUpdateSnapshots from the helper (best effort; Ops visibility, Atlas). */
export const refreshPreUpdateSnapshots = async (storeHandle: DocHandle<Store>, disk: Disk, list: UpdateDeps['listSnapshots']): Promise<PreUpdateSnapshot[] | null> => {
    let snaps: PreUpdateSnapshot[] | null = null
    try { snaps = await list(disk) } catch (e) { log(`updateApp: cannot list .pre-update snapshots on ${disk.id}: ${(e as Error).message}`); return null }
    storeHandle.change(doc => { const d = doc.diskDB[disk.id]; if (d) d.preUpdateSnapshots = snaps!.map(s => ({ ...s })) })
    return snaps
}

const findBundleDisk = async (store: Store, d: UpdateDeps, engineId: string, inst: Instance, newAppId: string, sourceDiskId?: string): Promise<{ disk: Disk, dir: string } | null> => {
    const docked = Object.values(store.diskDB ?? {}).filter(x => x && String(x.dockedTo) === engineId && x.device) as Disk[]
    const order = sourceDiskId ? docked.filter(x => String(x.id) === sourceDiskId)
        : [...docked.filter(x => String(x.id) === String(inst.storedOn)), ...docked.filter(x => String(x.id) !== String(inst.storedOn))]
    for (const disk of order) {
        const dir = path.join(await d.mountRoot(disk), 'apps', newAppId)
        if (await fs.pathExists(path.join(dir, 'compose.yaml'))) return { disk, dir }
    }
    return null
}

const readHealthTimeout = async (composePath: string, appName: string): Promise<number> => {
    try { return healthTimeoutSeconds(appName, YAML.parse(await fs.readFile(composePath, 'utf8'))?.['x-app']?.healthTimeout) }
    catch { return healthTimeoutSeconds(appName) }
}

export const updateApp = async (
    storeHandle: DocHandle<Store>, instanceArg: string, newAppId: string, engineId: string,
    opts: UpdateOptions = {}, deps: Partial<UpdateDeps> = {},
): Promise<UpdateResult> => {
    const d: UpdateDeps = { ...defaultUpdateDeps(storeHandle), ...deps }
    const store = storeHandle.doc()
    const r = lookupLocalInstanceArg(store, String(instanceArg ?? ''), engineId)
    if (!r.ok) {
        if (r.reason === 'not-found') throw new UpdateAppError('NOT_FOUND', `instance '${instanceArg}' not found on this Engine`)
        if (r.reason === 'not-local') throw new UpdateAppError('NOT_DOCKED', 'the App Disk is not docked to this Engine')
        throw new UpdateAppError('AMBIGUOUS', `instance name '${instanceArg}' is shared by several instances on this Engine; use the instance id`)
    }
    const inst: Instance = r.instance
    const disk = store.diskDB[inst.storedOn as DiskID] as Disk
    const helper = await d.helperProblem()
    if (helper) throw new UpdateAppError('HELPER_OUTDATED', helper)

    const key = instanceKey(inst.id)
    const gotLock = resourceLock.acquire(key, 'updateApp')
    try {
        const progress = (step: UpdateStep, bytesDone = 0, bytesTotal = 0) =>
            d.broadcast({ type: UPDATE_PROGRESS_TYPE, engineId, instanceId: String(inst.id), step, bytesDone, bytesTotal })
        // ── Fetch (local) + Check: nothing changes before every refusal has been checked
        progress('Fetch')
        const bundle = await findBundleDisk(store, d, engineId, inst, newAppId, opts.sourceDiskId)
        const instRoot = await d.mountRoot(disk)
        const instDir = path.join(instRoot, 'instances', String(inst.id))
        let shortDisks: string[] = []
        let dataBytes = 0
        if (bundle && gotLock) {
            dataBytes = await d.instanceBytes(disk, inst.id)
            const bundleBytes = String(bundle.disk.id) === String(disk.id) ? 0 : await d.dirBytes(bundle.dir)
            const need = dataBytes + snapshotMarginBytes(dataBytes) + bundleBytes
            const free = await d.freeBytes(instRoot)
            if (free < need) shortDisks = [`${disk.name} (snapshot needs ${need}, free ${free})`]
        }
        const refusal = checkUpdate({
            diskDocked: true, busy: !gotLock, currentAppId: String(inst.instanceOf), newAppId,
            sourcePresent: !!bundle, sumsValid: bundle ? await d.verifySums(bundle.dir) : false,
            allowMajor: !!opts.allowMajor,
            backupAgeMs: inst.lastBackup ? d.now() - Number(inst.lastBackup) : null,
            shortDisks,
        })
        if (refusal) throw refusal
        progress('Check')

        const fromAppId = inst.instanceOf
        const opId = createOperation(storeHandle, 'updateApp', { instanceId: String(inst.id), diskId: String(disk.id), fromAppId: String(fromAppId), toAppId: newAppId }, 'console-command', { type: 'instance', id: inst.id })
        updateOperation(storeHandle, opId, { status: 'Running' })
        const setStep = (step: UpdateStep) => updateOperation(storeHandle, opId, { currentStep: UPDATE_STEPS.indexOf(step), totalSteps: UPDATE_STEPS.length, stepLabel: step })
        let step: UpdateStep = 'Snapshot'
        let snap: { path: string, sizeBytes: number } | null = null
        const done: UpdateStep[] = ['Fetch', 'Check']
        try {
            // ── Snapshot
            setStep('Snapshot'); progress('Snapshot', 0, dataBytes)
            if (inst.status === 'Running' || inst.status === 'Starting') await d.stop(inst, disk)
            await waitContainersGone(d, inst.id)
            try { snap = await d.snapshot(disk, inst.id) } catch (e) {
                const m = String((e as Error).message)
                const ns = m.match(/NO_SPACE: [^\n]*/)
                if (ns) throw new UpdateAppError('NO_SPACE', ns[0].replace(/^NO_SPACE: /, ''))
                throw e
            }
            progress('Snapshot', snap.sizeBytes, snap.sizeBytes); done.push('Snapshot')
            await refreshPreUpdateSnapshots(storeHandle, disk, d.listSnapshots)
            // ── Swap
            step = 'Swap'; setStep('Swap'); progress('Swap')
            const targetApps = path.join(instRoot, 'apps', newAppId)
            if (bundle!.dir !== targetApps) await d.copyBundle(bundle!.dir, targetApps)
            await d.copyBundle(bundle!.dir, instDir)
            const composePath = path.join(instDir, 'compose.yaml')
            await fs.writeFile(composePath, setComposeInstanceName(await fs.readFile(composePath, 'utf8'), String(inst.name)))
            await d.reread(disk, inst.id)
            done.push('Swap')
            // ── Start
            step = 'Start'; setStep('Start'); progress('Start')
            const fresh = storeHandle.doc().instanceDB[inst.id] as Instance
            await d.start(fresh, disk)
            const after = storeHandle.doc().instanceDB[inst.id]
            if (!after || after.status === 'Error') throw new Error(`start failed: ${after?.statusCondition ?? 'instance record missing'}`)
            done.push('Start')
            // ── Health
            step = 'Health'; setStep('Health')
            const timeoutS = await readHealthTimeout(composePath, parseAppId(newAppId).name)
            const t0 = d.now()
            for (;;) {
                const elapsedMs = d.now() - t0
                const v = healthGate({ ...(await d.health(inst.id)), elapsedMs }, timeoutS)
                progress('Health', Math.min(elapsedMs, timeoutS * 1000), timeoutS * 1000)
                if (v.verdict === 'pass') break
                if (v.verdict === 'fail') throw new Error(`health gate: ${v.why}`)
                await d.sleep(d.pollMs)
            }
            done.push('Health')
            updateOperation(storeHandle, opId, { status: 'Done', completedAt: d.now() as Timestamp })
            log(`updateApp: ${inst.id} ('${inst.name}') ${fromAppId} -> ${newAppId}; snapshot ${snap.path} (${snap.sizeBytes} bytes) kept`)
            return { instanceId: inst.id, name: String(inst.name), fromAppId, toAppId: newAppId as AppID, snapshotPath: snap.path, snapshotBytes: snap.sizeBytes, steps: done }
        } catch (e) {
            const why = e instanceof UpdateAppError && e.code === 'NO_SPACE' ? null : String((e as Error).message)
            if (!why || !snap) {
                // Before a complete snapshot nothing was swapped: the old version is intact.
                // It may have been stopped for the snapshot: start the old version again.
                if (inst.status === 'Running' || inst.status === 'Starting') {
                    try { await d.start(storeHandle.doc().instanceDB[inst.id] as Instance, disk) } catch (se) { log(`updateApp: restarting ${inst.id} failed: ${(se as Error).message}`) }
                }
                const err = e instanceof UpdateAppError ? e : new UpdateAppError('ROLLED_BACK', `${step} failed: ${why}; nothing was changed`)
                updateOperation(storeHandle, opId, { status: 'Failed', error: err.message, completedAt: d.now() as Timestamp })
                throw err
            }
            const err = await rollBack(storeHandle, d, inst, disk, instDir, step, why, snap)
            updateOperation(storeHandle, opId, { status: 'Failed', error: err.message, completedAt: d.now() as Timestamp })
            throw err
        }
    } finally {
        if (gotLock) resourceLock.release(key)
    }
}

/** Restore the snapshot and start the old version. Returns the error to report. */
const rollBack = async (
    storeHandle: DocHandle<Store>, d: UpdateDeps, inst: Instance, disk: Disk, instDir: string,
    failedAt: UpdateStep, why: string, snap: { path: string, sizeBytes: number },
): Promise<UpdateAppError> => {
    const plan = rollbackPlan(failedAt)
    log(`updateApp: ${failedAt} failed for ${inst.id} (${why}); rolling back from ${snap.path}`)
    try {
        await d.composeDown(instDir, inst.id)
        await waitContainersGone(d, inst.id)
        if (plan.restoreData) {
            const aside = await d.restoreSnapshot(disk, inst.id)
            log(`updateApp: ${inst.id} restored from ${snap.path}; the updated folder is kept at ${aside}`)
        }
        await d.reread(disk, inst.id)
        if (plan.startOld && (inst.status === 'Running' || inst.status === 'Starting')) {
            await d.start(storeHandle.doc().instanceDB[inst.id] as Instance, disk)
            const after = storeHandle.doc().instanceDB[inst.id]
            if (!after || after.status === 'Error') throw new Error(`the old version did not start: ${after?.statusCondition ?? 'record missing'}`)
        }
        return new UpdateAppError('ROLLED_BACK', `${failedAt} failed: ${why}. ${inst.instanceOf} and its data were restored from ${snap.path}`)
    } catch (e) {
        const err = new UpdateAppError('ROLLBACK_FAILED', `${failedAt} failed: ${why}; then the rollback failed: ${(e as Error).message}. The snapshot is kept at ${snap.path}`)
        storeHandle.change(doc => {
            const i = doc.instanceDB[inst.id]
            if (!i) return
            i.status = 'Stopped' as any
            i.statusCondition = err.message
        })
        return err
    }
}

/**
 * Startup (power-loss safety): an updateApp operation of this Engine left Running is
 * rolled back when a complete snapshot exists (the helper's COMPLETE marker); otherwise
 * the old folder was never touched. The op is then marked Failed by recoverInterruptedOperations.
 */
export const recoverInterruptedUpdates = async (storeHandle: DocHandle<Store>, engineId: string, deps: Partial<UpdateDeps> = {}): Promise<string[]> => {
    const d: UpdateDeps = { ...defaultUpdateDeps(storeHandle), ...deps }
    const store = storeHandle.doc()
    const out: string[] = []
    for (const op of Object.values(store.operationDB ?? {})) {
        if (!op || op.kind !== 'updateApp' || String(op.engineId) !== engineId || (op.status !== 'Running' && op.status !== 'Pending')) continue
        const inst = store.instanceDB[op.args.instanceId as InstanceID]
        const disk = inst && store.diskDB[inst.storedOn as DiskID] as Disk
        if (!inst || !disk || String(disk.dockedTo) !== engineId) { out.push(`${op.args.instanceId}: disk not docked; left as is`); continue }
        const step = UPDATE_STEPS[op.currentStep ?? 0] ?? 'Snapshot'
        const snaps = await d.listSnapshots(disk).catch(() => [] as PreUpdateSnapshot[])
        const complete = snaps.some(s => String(s.instanceId) === String(inst.id) && s.complete)
        const swapped = UPDATE_STEPS.indexOf(step) >= UPDATE_STEPS.indexOf('Swap')
        if (!complete || !swapped) { out.push(`${inst.id}: interrupted at ${step}; old version untouched`); continue }
        const err = await rollBack(storeHandle, d, inst, disk, path.join(await d.mountRoot(disk), 'instances', String(inst.id)), step, 'the Engine restarted during the update', { path: path.join(await d.mountRoot(disk), PRE_UPDATE_DIR, String(inst.id)), sizeBytes: 0 })
        updateOperation(storeHandle, op.id, { status: 'Failed', error: `INTERRUPTED: ${err.message}`, completedAt: d.now() as Timestamp })
        out.push(`${inst.id}: ${err.message}`)
    }
    return out
}

