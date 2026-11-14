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
 *  - Swap: copy the new bundle files over the instance folder (.env kept), restamp
 *    x-app.instanceName and x-app.demo from the old instance compose, re-read the record (instanceOf = newAppId).
 *  - Start, Health: startInstance, then the health gate (healthGate) within healthTimeout.
 * Any failure from Snapshot on rolls back: compose down (no -v), `restore-snapshot` (in place,
 * helper v9: instances/<id> is never moved; replaced or deleted files go to .idea-quarantine
 * first, so even that is undoable), re-read the record, start the old version. Result text:
 * "ROLLED BACK: <why>"; when the rollback itself fails the instance is left Stopped with
 * statusCondition "ROLLBACK FAILED: ...".
 * Nothing is ever deleted; snapshots are kept (cleanup is a backlog item, quarantine only).
 * updateAvailable (idea#459): recomputed when an update that started its operation ends
 * (done, failed or rolled back), so the record never keeps offering the version now running.
 *
 * Identity (idea#448): the snapshot leaves out the union of the live and the new compose's
 * x-app.backup.exclude (e.g. data/tailscale, data/keys), and restore-snapshot never writes,
 * deletes or moves those paths, so their inodes survive a rollback. A major update that needs
 * a fresh backup takes it here to a docked Backup Disk linked to the instance. It is a backup
 * of the CURRENT instance, so it uses the current (live) compose's x-app.backup, never the
 * new bundle's (idea#458: a hook only the new version ships ran inside the old containers,
 * exit 127): method hook runs the old compose's preHook before anything is stopped (a failed
 * preHook refuses, HOOK_FAILED; it never falls back to a stop); method stop, no x-app.backup
 * (an old version without a hook) or an instance that is not running runs Borg inside the
 * one Snapshot stop.
 *
 * Named Docker volumes of the instance are exported into the snapshot too (helper v5, offline host
 * tar, verified before COMPLETE) and restored on rollback; a previous snapshot is renamed into
 * .idea-quarantine first (never copied or removed).
 */
import { DocHandle } from '@automerge/automerge-repo'
import { $, fs, path, YAML, sleep } from 'zx'
import type { Store } from './Store.js'
import { pickLocalBackupDisk } from './LocalBackupDisk.js'
import type { Instance } from './Instance.js'
import type { AppID, DiskID, InstanceID, Timestamp } from './CommonTypes.js'
import { lookupLocalInstanceArg } from './InstanceArg.js'
import { checkInstanceIdForDocker, composeProjectFor, COMPOSE_PROJECT_LABEL } from '../utils/instanceIds.js'
import { diskMountRoot, appDataRoot, Disk, PreUpdateSnapshot, AppBundleInfo, joinMountRoot } from './Disk.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import {
    runAppData, snapshotArgs, restoreSnapshotArgs, snapshotsArgs, parseSnapshotResult, parseSnapshotsList,
    helperAtLeast, lastLine, SnapshotResult, estimateArgs, parseEstimate,
} from '../utils/appDataHelper.js'
import { createOperation, updateOperation } from './Operations.js'
import { log } from '../utils/utils.js'
import {
    UpdateAppError, UpdateStep, UPDATE_STEPS, checkUpdate, healthGate, healthTimeoutSeconds, rollbackPlan,
    parseHealthCheck, healthBodyOk, estimateUpdateMinutes, fallbackUp, fallbackHealthTimeoutSeconds,
    HealthSample, ContainerHealth, offerable, compareVersions, isMajorChange, backupIsDue,
} from './UpdateAppPolicy.js'
import { parseAppId } from './App.js'
import { stampComposeInstanceIdentity } from './InstanceCopy.js'
import { isUnfinishedFetch } from './UpdateFetch.js'
import { beginUsageSkip, endUsageSkip } from '../usage/opFlags.js'
import { parseBackupExcludeList, parseSnapshotExcludeList, mergeBackupExcludeLists, assertSnapshotExcludeList } from '../utils/backupExclude.js'
import { defaultReadBootId, defaultReadUptimeS } from '../usage/sampler.js'
import { engineClockTrusted } from '../utils/engineClockStatus.js'
import { parseBackupSpec, BackupMethod } from '../utils/backupMethod.js'
import type { PreUpdateBackupOptions } from '../monitors/backupMonitor.js'

/** v14 (idea#396): snapshot/estimate excludes under data/, 24 h pre-update quarantine. */
export const UPDATE_HELPER_MIN = 14
export const UPDATE_PROGRESS_TYPE = 'idea/updateProgress'
export const PRE_UPDATE_DIR = '.pre-update'
export const UPDATE_APP_USAGE = 'Usage: updateApp <instanceId|name> <newAppId> [--allow-major] [--source <diskId>]'
/** Same margin as the helper: 10 % of the data, at least 1 GiB. */
export const snapshotMarginBytes = (bytes: number): number => Math.max(Math.floor(bytes / 10), 1024 * 1024 * 1024)

export interface UpdateProgress {
    type: typeof UPDATE_PROGRESS_TYPE; engineId: string; instanceId: string; step: UpdateStep; bytesDone: number; bytesTotal: number
    /** #263: set while a cross-Engine Fetch waits (thermal pause), absent otherwise */
    fetchPaused?: FetchPaused
}
export interface FetchPaused { reason: 'thermal'; bytesDone: number; bytesTotal: number; since: number }

export interface UpdateResult {
    instanceId: InstanceID; name: string; fromAppId: AppID; toAppId: AppID
    snapshotPath: string; snapshotBytes: number; steps: UpdateStep[]
    /** the previous snapshot, renamed into .idea-quarantine before this one (or null) */
    previousSnapshotQuarantinedAt: string | null
    /** named Docker volumes exported into the snapshot, with their export time */
    volumes: { name: string, bytes: number, exportMs: number }[]
    /** idea#448: paths left out of the snapshot and never written back on rollback */
    snapshotExcludes: string[]
    /** idea#448: the backup updateApp took itself (null when none was due) */
    preUpdateBackup: { backupDiskId: string, method: BackupMethod, duringStop: boolean } | null
}
export interface SnapshotsInfo { snapshots: PreUpdateSnapshot[], preUpdateBytes: number | null, quarantineBytes: number | null }

export interface UpdateDeps {
    helperProblem: () => Promise<string | null>
    mountRoot: (disk: Disk) => Promise<string>
    verifySums: (bundleDir: string) => Promise<boolean>
    /** read-only helper `estimate`: folder + named-volume bytes and the App Disk's free bytes; stops nothing. idea#396: trailing excludes are the snapshot list. */
    estimate: (disk: Disk, id: InstanceID, excludes?: string[]) => Promise<{ folderBytes: number, volumeBytes: number, freeBytes: number }>
    /** idea#396: clock/boot at the Health gate for Instance.preUpdateGate. */
    clockTrusted: () => boolean
    bootId: () => string
    uptimeS: () => number
    dirBytes: (dir: string) => Promise<number>
    copyBundle: (src: string, dst: string) => Promise<void>
    stop: (inst: Instance, disk: Disk) => Promise<void>
    containerIds: (id: InstanceID) => Promise<string[]>
    composeDown: (dir: string, id: InstanceID) => Promise<void>
    /** #263: cross-Engine Fetch onto the instance's disk; resolves with the local bundle folder */
    fetch: (req: import('./UpdateFetch.js').FetchRequest) => Promise<string>
    snapshot: (disk: Disk, id: InstanceID, excludes: string[]) => Promise<SnapshotResult>
    restoreSnapshot: (disk: Disk, id: InstanceID, excludes: string[]) => Promise<string>
    /** idea#448: backupInstance in its pre-update mode (only the Backup Disk lock; errors thrown) */
    backup: (inst: Instance, backupDisk: Disk, opts: PreUpdateBackupOptions) => Promise<void>
    listSnapshots: (disk: Disk) => Promise<SnapshotsInfo>
    reread: (disk: Disk, id: InstanceID) => Promise<void>
    start: (inst: Instance, disk: Disk) => Promise<void>
    health: (id: InstanceID) => Promise<Omit<HealthSample, 'elapsedMs'>>
    /** GET an x-app.healthCheck URL (idea#76); null when it does not answer */
    probe: (url: string) => Promise<{ status: number, body: string } | null>
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

const defaultVerifySums = async (dir: string): Promise<boolean> => {
    if (!await fs.pathExists(path.join(dir, 'SHA256SUMS'))) return false
    try { await $({ cwd: dir })`sha256sum --check --strict --quiet SHA256SUMS`.quiet(); return true } catch { return false }
}

export const defaultUpdateDeps = (storeHandle: DocHandle<Store>): UpdateDeps => ({
    helperProblem: () => helperAtLeast(UPDATE_HELPER_MIN, 'updateApp'),
    mountRoot: (disk) => diskMountRoot(disk),
    verifySums: (dir) => defaultVerifySums(dir),
    fetch: async (req) => {
        const f = await import('./UpdateFetch.js')
        return f.fetchBundle(req, f.defaultFetchTargetDeps(storeHandle, defaultVerifySums))
    },
    estimate: async (disk, id, excludes = []) => {
        try {
            return parseEstimate(await runAppData(estimateArgs(await appDataRoot(disk), String(id), excludes)))
        } catch (e) {
            const mapped = invalidExcludeFromHelper(e)
            if (mapped) throw mapped
            throw e
        }
    },
    clockTrusted: engineClockTrusted,
    bootId: defaultReadBootId,
    uptimeS: defaultReadUptimeS,
    dirBytes: async (dir) => (await import('./CopyMoveApp.js')).directoryBytes(dir),
    copyBundle: async (src, dst) => {
        for (const name of await fs.readdir(src)) {
            if (name === '.env' || name === 'SHA256SUMS' || name.startsWith('.idea-')) continue
            await fs.copy(path.join(src, name), path.join(dst, name), { overwrite: true })
        }
    },
    stop: async (inst, disk) => (await import('./Instance.js')).stopInstance(storeHandle, inst, disk),
    containerIds: async (id) => (await docker(['ps', '-q', '--filter', `label=${COMPOSE_PROJECT_LABEL}=${composeProjectFor(String(id))}`])).split('\n').map(s => s.trim()).filter(Boolean),
    composeDown: async (dir, id) => {
        const composeFile = path.join(dir, 'compose.yaml')
        if (!await fs.pathExists(composeFile)) {
            log(`updateApp: no compose.yaml at ${composeFile}; skipping compose down`)
            return
        }
        // idea#424: -p and -f with the live absolute path; never cwd-only or a
        // quarantine glob. No -v (named volumes stay).
        await docker(['compose', '-p', composeProjectFor(String(id)), '-f', composeFile, 'down'])
    },
    snapshot: async (disk, id, excludes) => parseSnapshotResult(await runAppData(snapshotArgs(await appDataRoot(disk), String(id), excludes))),
    restoreSnapshot: async (disk, id, excludes) => lastLine(await runAppData(restoreSnapshotArgs(await appDataRoot(disk), String(id), excludes))),
    backup: async (inst, backupDisk, opts) =>
        (await import('../monitors/backupMonitor.js')).backupInstance(storeHandle, inst.id, backupDisk, undefined, 'console-command', opts),
    listSnapshots: async (disk) => parseSnapshotsList(await runAppData(snapshotsArgs(await appDataRoot(disk)))) as SnapshotsInfo,
    reread: async (disk, id) => { await (await import('./Instance.js')).createOrUpdateInstance(storeHandle, id, disk) },
    start: async (inst, disk) => (await import('./Instance.js')).startInstance(storeHandle, inst, disk),
    health: async (id) => {
        const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${id}`])).split('\n').map(s => s.trim()).filter(Boolean)
        if (!ids.length) return aggregateHealth([])
        const info = JSON.parse(await docker(['inspect', ...ids])) as any[]
        return aggregateHealth(info.map(c => ({ status: c?.State?.Status, health: c?.State?.Health?.Status, exitCode: c?.State?.ExitCode, restartCount: c?.RestartCount })))
    },
    probe: async (url) => {
        try {
            const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
            return { status: r.status, body: await r.text() }
        } catch { return null }
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

/** Refresh Disk.preUpdateSnapshots, preUpdateBytes and quarantineBytes from the helper (best effort; Ops visibility, Atlas). */
export const refreshPreUpdateSnapshots = async (storeHandle: DocHandle<Store>, disk: Disk, list: UpdateDeps['listSnapshots']): Promise<PreUpdateSnapshot[] | null> => {
    let info: SnapshotsInfo
    try { info = await list(disk) } catch (e) { log(`updateApp: cannot list .pre-update snapshots on ${disk.id}: ${(e as Error).message}`); return null }
    storeHandle.change(doc => {
        const d = doc.diskDB[disk.id]
        if (!d) return
        d.preUpdateSnapshots = info.snapshots.map(s => ({ ...s }))
        d.preUpdateBytes = info.preUpdateBytes
        d.quarantineBytes = info.quarantineBytes
    })
    return info.snapshots
}

const findBundleDisk = async (store: Store, d: UpdateDeps, engineId: string, inst: Instance, newAppId: string, sourceDiskId?: string): Promise<{ disk: Disk, dir: string } | null> => {
    const docked = Object.values(store.diskDB ?? {}).filter(x => x && String(x.dockedTo) === engineId && x.device) as Disk[]
    const order = sourceDiskId ? docked.filter(x => String(x.id) === sourceDiskId)
        : [...docked.filter(x => String(x.id) === String(inst.storedOn)), ...docked.filter(x => String(x.id) !== String(inst.storedOn))]
    for (const disk of order) {
        const dir = joinMountRoot(await d.mountRoot(disk), 'apps', newAppId)
        if (await fs.pathExists(path.join(dir, 'compose.yaml')) && !await isUnfinishedFetch(dir)) return { disk, dir }
    }
    return null
}

/** x-app of a compose file; {} when unreadable. */

/** engine#369 decision 5: warn (do not download) when the on-disk pack is below the new bundle minVersion. */
export const refreshDemoPackWarning = async (
    storeHandle: DocHandle<Store>, instanceDir: string, bundleDir: string, instanceId: InstanceID,
): Promise<void> => {
    try {
        const { readAppDemoSpec, parsePackJson } = await import('./DemoPack.js')
        const spec = await readAppDemoSpec(bundleDir)
        const minVersion = spec?.pack?.minVersion
        const packPath = path.join(instanceDir, 'demo-pack', 'x', 'pack.json')
        const hasPack = await fs.pathExists(packPath)
        storeHandle.change(doc => {
            const i = doc.instanceDB[instanceId] as any
            if (!i) return
            if (i.demo !== true || minVersion === undefined || !hasPack) {
                if (i.demoPackWarning) i.demoPackWarning = null
                return
            }
        })
        if (minVersion === undefined || !hasPack) return
        let packVersion: number
        try { packVersion = parsePackJson(await fs.readFile(packPath, 'utf8')).packVersion } catch { return }
        storeHandle.change(doc => {
            const i = doc.instanceDB[instanceId] as any
            if (!i || i.demo !== true) return
            if (packVersion < minVersion) i.demoPackWarning = { code: 'PACK_OUTDATED', packVersion, minVersion }
            else if (i.demoPackWarning) i.demoPackWarning = null
        })
    } catch (e) {
        log(`updateApp: demoPackWarning for ${instanceId}: ${(e as Error).message}`)
    }
}

export const readXApp = async (composePath: string): Promise<Record<string, any>> => {
    try { const x = YAML.parse(await fs.readFile(composePath, 'utf8'))?.['x-app']; return x && typeof x === 'object' ? x : {} }
    catch { return {} }
}

/**
 * idea#448 (Steve): the new bundle must not ship a path in the snapshot exclude list. Swap
 * copies the bundle over the instance folder, so such a path would overwrite the identity
 * (e.g. data/tailscale) that the snapshot and the rollback deliberately leave alone. A path is
 * hit when it exists in the bundle (any type, symlinks not followed) or when one of its parent
 * components exists there as something other than a directory. Returns the hit paths.
 */
export const bundleExcludedPaths = async (bundleDir: string, excludes: string[]): Promise<string[]> => {
    const hits: string[] = []
    for (const rel of excludes) {
        const parts = rel.split('/').filter(Boolean)
        for (let i = 1; i <= parts.length; i++) {
            const st = await fs.lstat(path.join(bundleDir, ...parts.slice(0, i))).catch(() => null)
            if (!st) break
            if (i === parts.length || !st.isDirectory()) { hits.push(rel); break }
        }
    }
    return hits
}

/**
 * idea#448: x-app.backup of a compose file: its exclude list and method. A missing file or
 * x-app.backup gives [] / 'stop'; a malformed one refuses BAD_BACKUP_SPEC (fail closed).
 */
export const readComposeBackup = async (composePath: string, which: string): Promise<{ exclude: string[], method: BackupMethod }> => {
    if (!await fs.pathExists(composePath)) return { exclude: [], method: 'stop' }
    try {
        const xapp = YAML.parse(await fs.readFile(composePath, 'utf8'))?.['x-app']
        return { exclude: parseBackupExcludeList(xapp), method: parseBackupSpec(xapp).method }
    } catch (e) {
        throw new UpdateAppError('BAD_BACKUP_SPEC', `the ${which} compose ${composePath} has an invalid x-app.backup: ${(e as Error).message}`)
    }
}

/** idea#448: a Backup Disk docked to this Engine and linked to the instance (backupApp's default choice). */
/** Map a helper `refused:` (exit 2) from estimate / snapshot to INVALID_EXCLUDE. */
export const invalidExcludeFromHelper = (e: unknown): UpdateAppError | null => {
    const msg = e instanceof Error ? e.message : String(e)
    const m = msg.match(/refused:\s*(.*)/)
    if (!m) return null
    const why = m[1].trim().replace(/\s+/g, ' ')
    return new UpdateAppError('INVALID_EXCLUDE', `${why}; nothing was stopped or changed`)
}

/** idea#396: top-level x-app.snapshotExclude of a compose file (fail closed). */
export const readComposeSnapshotExclude = async (composePath: string, which: string): Promise<string[]> => {
    if (!await fs.pathExists(composePath)) return []
    try {
        const xapp = YAML.parse(await fs.readFile(composePath, 'utf8'))?.['x-app']
        return parseSnapshotExcludeList(xapp)
    } catch (e) {
        const msg = (e as Error).message
        throw new UpdateAppError('INVALID_EXCLUDE', `the ${which} compose ${composePath} has an invalid x-app.snapshotExclude: ${msg}; nothing was stopped or changed`)
    }
}

const namedExcludeLists = (pathRel: string, backupExcludes: string[], snapshotExcludes: string[]): string[] => {
    const names: string[] = []
    if (backupExcludes.includes(pathRel)) names.push('x-app.backup.exclude')
    if (snapshotExcludes.includes(pathRel)) names.push('x-app.snapshotExclude')
    return names.length ? names : ['x-app.backup.exclude']
}

const bundleContainsExcludedMessage = (dir: string, shipped: string[], backupExcludes: string[], snapshotExcludes: string[]): string => {
    const lists = [...new Set(shipped.flatMap(p => namedExcludeLists(p, backupExcludes, snapshotExcludes)))]
    const listTxt = lists.join(' and ')
    return `the bundle ${dir} contains ${shipped.join(', ')}, which the snapshot and rollback leave out (${listTxt}); remove ${shipped.length === 1 ? 'it' : 'them'} from the bundle. Nothing was stopped or changed`
}

export const writePreUpdateGate = (
    storeHandle: DocHandle<Store>, instanceId: InstanceID,
    gate: { at: number | null, bootId: string, uptimeS: number } | null,
): void => {
    storeHandle.change(doc => {
        const i = doc.instanceDB[instanceId]
        if (i) i.preUpdateGate = gate
    })
}

export const linkedBackupDisk = (store: Store, engineId: string, inst: Instance): Disk | null =>
    pickLocalBackupDisk(store, engineId, inst.id) ?? null

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
    // idea#479: check the id before any compose or Docker action; a legacy dotted id is refused (removeInstance only).
    const idCheck = checkInstanceIdForDocker(String(inst.id))
    if (!idCheck.ok) throw new UpdateAppError('INVALID_INSTANCE_ID', idCheck.reason)
    const disk = store.diskDB[inst.storedOn as DiskID] as Disk
    const helper = await d.helperProblem()
    if (helper) throw new UpdateAppError('HELPER_OUTDATED', helper)

    const key = instanceKey(inst.id)
    const gotLock = resourceLock.acquire(key, 'updateApp')
    if (gotLock) beginUsageSkip('update')
    // idea#459: once an operation exists the instance may now run another version (or was rolled
    // back); updateAvailable is recomputed from the record afterwards, never left from the dock.
    let opened = false
    try {
        const progress = (step: UpdateStep, bytesDone = 0, bytesTotal = 0) =>
            d.broadcast({ type: UPDATE_PROGRESS_TYPE, engineId, instanceId: String(inst.id), step, bytesDone, bytesTotal })
        // ── Fetch (local) + Check: nothing changes before every refusal has been checked
        progress('Fetch')
        let bundle = await findBundleDisk(store, d, engineId, inst, newAppId, opts.sourceDiskId)
        // #263: --source names a disk docked to ANOTHER Engine: that Engine pushes the bundle here.
        const remote = opts.sourceDiskId ? store.diskDB[opts.sourceDiskId as DiskID] as Disk | undefined : undefined
        if (!bundle && gotLock && remote?.dockedTo && remote.device && String(remote.dockedTo) !== engineId) {
            const dir = await d.fetch({ localEngineId: engineId, instanceId: String(inst.id), newAppId, sourceDisk: remote, targetDisk: disk })
            bundle = { disk, dir }
        }
        const instRoot = await d.mountRoot(disk)
        const instDir = joinMountRoot(instRoot, 'instances', String(inst.id))
        let shortDisks: string[] = []
        let dataBytes = 0
        let snapExcludes: string[] = []
        let liveBackupExcludes: string[] = []
        let backupExcludes: string[] = []
        let liveSnapshotExcludes: string[] = []
        let live: Awaited<ReturnType<typeof readComposeBackup>> | undefined
        const newCompose = bundle ? path.join(bundle.dir, 'compose.yaml') : ''
        const backupAgeMs = inst.lastBackup ? d.now() - Number(inst.lastBackup) : null
        const backupDisk = backupIsDue(String(inst.instanceOf), newAppId, backupAgeMs) ? linkedBackupDisk(store, engineId, inst) : null
        const facts = {
            diskDocked: true, busy: !gotLock, currentAppId: String(inst.instanceOf), newAppId,
            sourcePresent: !!bundle, sumsValid: bundle ? await d.verifySums(bundle.dir) : false,
            allowMajor: !!opts.allowMajor,
            backupAgeMs,
            shortDisks: [] as string[],
            updatesFrom: bundle ? (await readXApp(path.join(bundle.dir, 'compose.yaml'))).updatesFrom : undefined,
            backupPlanned: !!backupDisk,
        }
        // NEEDS_BACKUP / MAJOR / NO_SUMS still win over exclude parsing (existing agreed order).
        const early = checkUpdate(facts)
        if (early) throw early
        // idea#396: merge excludes and refuse INVALID_EXCLUDE / BUNDLE_CONTAINS_EXCLUDED
        // before estimate and before anything is stopped.
        if (bundle) {
            live = await readComposeBackup(path.join(instDir, 'compose.yaml'), 'live')
            const next = await readComposeBackup(newCompose, 'new')
            liveBackupExcludes = live.exclude
            backupExcludes = mergeBackupExcludeLists(live.exclude, next.exclude)
            liveSnapshotExcludes = await readComposeSnapshotExclude(path.join(instDir, 'compose.yaml'), 'live')
            try {
                snapExcludes = assertSnapshotExcludeList(mergeBackupExcludeLists(backupExcludes, liveSnapshotExcludes), 'snapshot exclude')
            } catch (e) {
                throw new UpdateAppError('INVALID_EXCLUDE', `${(e as Error).message}; nothing was stopped or changed`)
            }
            const shipped = await bundleExcludedPaths(bundle.dir, snapExcludes)
            if (shipped.length) throw new UpdateAppError('BUNDLE_CONTAINS_EXCLUDED', bundleContainsExcludedMessage(bundle.dir, shipped, backupExcludes, liveSnapshotExcludes))
        }
        if (bundle && gotLock) {
            // NO_SPACE changes nothing (Steve): the helper's read-only estimate counts the folder AND
            // the named volumes before anything is stopped, net of the snapshot excludes (idea#396).
            let est: Awaited<ReturnType<UpdateDeps['estimate']>>
            try { est = await d.estimate(disk, inst.id, snapExcludes) } catch (e) {
                const mapped = invalidExcludeFromHelper(e)
                if (mapped) throw mapped
                throw e
            }
            dataBytes = est.folderBytes + est.volumeBytes
            const bundleBytes = String(bundle.disk.id) === String(disk.id) ? 0 : await d.dirBytes(bundle.dir)
            const need = dataBytes + snapshotMarginBytes(dataBytes) + bundleBytes
            if (est.freeBytes < need) shortDisks = [`${disk.name} (snapshot needs ${need}, free ${est.freeBytes})`]
        }
        if (shortDisks.length) {
            const space = checkUpdate({ ...facts, shortDisks })
            if (space) throw space
        }
        // idea#458: the pre-update backup method comes from the LIVE compose (a backup of the
        // current instance), never from the new bundle.
        progress('Check')

        const fromAppId = inst.instanceOf
        const opId = createOperation(storeHandle, 'updateApp', { instanceId: String(inst.id), diskId: String(disk.id), fromAppId: String(fromAppId), toAppId: newAppId }, 'console-command', { type: 'instance', id: inst.id })
        opened = true
        updateOperation(storeHandle, opId, { status: 'Running' })
        const setStep = (step: UpdateStep) => updateOperation(storeHandle, opId, { currentStep: UPDATE_STEPS.indexOf(step), totalSteps: UPDATE_STEPS.length, stepLabel: step })
        let step: UpdateStep = 'Snapshot'
        let snap: SnapshotResult | null = null
        let stopped = false
        let preUpdateBackup: UpdateResult['preUpdateBackup'] = null
        const done: UpdateStep[] = ['Fetch', 'Check']
        const wasUp = inst.status === 'Running' || inst.status === 'Starting'
        // hook: before anything stops; stop (or not running): inside the one Snapshot stop (Steve Q3)
        const hookFirst = !!backupDisk && wasUp && live?.method === 'hook'
        const takeBackup = async (instanceStopped: boolean) => {
            updateOperation(storeHandle, opId, { stepLabel: `Pre-update backup to ${backupDisk!.name} (${instanceStopped ? 'inside the snapshot stop' : 'hook, no stop'})` })
            try { await d.backup(inst, backupDisk!, { instanceStopped }) } catch (e) {
                const m = String((e as Error).message)
                if (/HOOK_FAILED: /.test(m)) throw new UpdateAppError('HOOK_FAILED', `${m.replace(/^.*?HOOK_FAILED: /, '')} (the current version's backup hook); nothing was stopped or changed, and the update does not fall back to a stop-mode backup`)
                throw new UpdateAppError('BACKUP_FAILED', `the pre-update backup to ${backupDisk!.name} failed: ${m}`)
            }
            preUpdateBackup = { backupDiskId: String(backupDisk!.id), method: instanceStopped ? 'stop' : 'hook', duringStop: instanceStopped }
            log(`updateApp: ${inst.id}: pre-update backup to ${backupDisk!.id} done (${instanceStopped ? 'inside the snapshot stop' : 'hook, no stop'})`)
        }
        try {
            if (hookFirst) await takeBackup(false)
            // ── Snapshot
            setStep('Snapshot'); progress('Snapshot', 0, dataBytes)
            if (wasUp) { stopped = true; await d.stop(inst, disk) }
            await waitContainersGone(d, inst.id)
            if (backupDisk && !hookFirst) await takeBackup(true)
            try { snap = await d.snapshot(disk, inst.id, snapExcludes) } catch (e) {
                const m = String((e as Error).message)
                const ns = m.match(/NO_SPACE: [^\n]*/)
                if (ns) throw new UpdateAppError('NO_SPACE', ns[0].replace(/^NO_SPACE: /, ''))
                throw e
            }
            progress('Snapshot', snap.sizeBytes, snap.sizeBytes); done.push('Snapshot')
            if (snap.previousQuarantinedAt) log(`updateApp: ${inst.id}: the previous snapshot was moved to ${snap.previousQuarantinedAt}`)
            for (const v of snap.volumes) log(`updateApp: ${inst.id}: volume ${v.name} exported (${v.bytes} bytes, ${v.exportMs} ms)`)
            updateOperation(storeHandle, opId, { stepLabel: `Snapshot ${snap.path} (${snap.sizeBytes} bytes${snap.volumes.length ? `; volumes ${snap.volumes.map(v => `${v.name} ${v.bytes} B in ${v.exportMs} ms`).join(', ')}` : ''}${snap.previousQuarantinedAt ? `; previous snapshot quarantined at ${snap.previousQuarantinedAt}` : ''})` })
            await refreshPreUpdateSnapshots(storeHandle, disk, d.listSnapshots)
            writePreUpdateGate(storeHandle, inst.id, null)
            // ── Swap
            step = 'Swap'; setStep('Swap'); progress('Swap')
            const liveComposePath = path.join(instDir, 'compose.yaml')
            const oldX = await readXApp(liveComposePath)
            const oldDemo = oldX.demo === true ? true as const : undefined
            const targetApps = joinMountRoot(instRoot, 'apps', newAppId)
            if (bundle!.dir !== targetApps) await d.copyBundle(bundle!.dir, targetApps)
            await d.copyBundle(bundle!.dir, instDir)
            const composePath = path.join(instDir, 'compose.yaml')
            await fs.writeFile(composePath, stampComposeInstanceIdentity(await fs.readFile(composePath, 'utf8'), { instanceName: String(inst.name), demo: oldDemo }))
            await d.reread(disk, inst.id)
            done.push('Swap')
            if (oldDemo) await refreshDemoPackWarning(storeHandle, instDir, bundle!.dir, inst.id)
            // ── Start
            step = 'Start'; setStep('Start'); progress('Start')
            const fresh = storeHandle.doc().instanceDB[inst.id] as Instance
            await d.start(fresh, disk)
            const after = storeHandle.doc().instanceDB[inst.id]
            if (!after || after.status === 'Error') throw new Error(`start failed: ${after?.statusCondition ?? 'instance record missing'}`)
            done.push('Start')
            // ── Health
            step = 'Health'; setStep('Health')
            const newX = await readXApp(composePath)
            const hc = parseHealthCheck(newX.healthCheck)
            // Declared healthCheck: agreed per-App timeout rule; fallback (main URL): healthTimeout, per-App default, else 300 s
            const timeoutS = hc ? await readHealthTimeout(composePath, parseAppId(newAppId).name) : fallbackHealthTimeoutSeconds(parseAppId(newAppId).name, newX.healthTimeout)
            const t0 = d.now()
            for (;;) {
                const elapsedMs = d.now() - t0
                const sample = await d.health(inst.id)
                // x-app.healthCheck (idea#351 §4.3): only once Docker says the containers are up
                const ready = sample.state === 'healthy' || sample.state === 'none'
                const base = `http://127.0.0.1:${(storeHandle.doc().instanceDB[inst.id] as Instance)?.port ?? inst.port}`
                const bodyOk = !ready ? undefined
                    : hc ? healthBodyOk(await d.probe(`${base}${hc.path}`), hc.expect)
                    : fallbackUp(await d.probe(`${base}/`))
                const v = healthGate({ ...sample, bodyOk, elapsedMs }, timeoutS)
                progress('Health', Math.min(elapsedMs, timeoutS * 1000), timeoutS * 1000)
                if (v.verdict === 'pass') break
                if (v.verdict === 'fail') throw new Error(`health gate: ${v.why}`)
                await d.sleep(d.pollMs)
            }
            done.push('Health')
            storeHandle.change(doc => {
                const i = doc.instanceDB[inst.id]
                if (i) {
                    i.previousAppId = fromAppId
                    i.updateAvailable = null
                    i.preUpdateGate = {
                        at: d.clockTrusted() ? d.now() : null,
                        bootId: d.bootId(),
                        uptimeS: d.uptimeS(),
                    }
                }
            })
            updateOperation(storeHandle, opId, { status: 'Done', completedAt: d.now() as Timestamp })
            log(`updateApp: ${inst.id} ('${inst.name}') ${fromAppId} -> ${newAppId}; snapshot ${snap.path} (${snap.sizeBytes} bytes) kept`)
            return { instanceId: inst.id, name: String(inst.name), fromAppId, toAppId: newAppId as AppID, snapshotPath: snap.path, snapshotBytes: snap.sizeBytes, steps: done, previousSnapshotQuarantinedAt: snap.previousQuarantinedAt, volumes: snap.volumes, snapshotExcludes: snapExcludes, preUpdateBackup }
        } catch (e) {
            const why = e instanceof UpdateAppError && e.code === 'NO_SPACE' ? null : String((e as Error).message)
            if (!why || !snap) {
                // Before a complete snapshot nothing was swapped: the old version is intact.
                // It may have been stopped for the snapshot: start the old version again.
                if (stopped) {
                    try { await d.start(storeHandle.doc().instanceDB[inst.id] as Instance, disk) } catch (se) { log(`updateApp: restarting ${inst.id} failed: ${(se as Error).message}`) }
                }
                const err = e instanceof UpdateAppError ? e : new UpdateAppError('ROLLED_BACK', `${step} failed: ${why}; nothing was changed`)
                updateOperation(storeHandle, opId, { status: 'Failed', error: err.message, completedAt: d.now() as Timestamp })
                throw err
            }
            let restoreExcludes = liveBackupExcludes
            try {
                const current = await readComposeBackup(path.join(instDir, 'compose.yaml'), 'current')
                restoreExcludes = mergeBackupExcludeLists(liveBackupExcludes, current.exclude)
            } catch (e) {
                log(`updateApp: ${inst.id}: ${(e as Error).message}; restore-snapshot will use the live backup.exclude list only`)
            }
            const err = await rollBack(storeHandle, d, inst, disk, instDir, step, why, snap, restoreExcludes)
            updateOperation(storeHandle, opId, { status: 'Failed', error: err.message, completedAt: d.now() as Timestamp })
            throw err
        }
    } finally {
        if (gotLock) {
            resourceLock.release(key)
            endUsageSkip('update')
        }
        if (opened) await refreshOfferAfterUpdate(storeHandle, engineId, d)
    }
}

/** Restore the snapshot and start the old version. Returns the error to report. */
const rollBack = async (
    storeHandle: DocHandle<Store>, d: UpdateDeps, inst: Instance, disk: Disk, instDir: string,
    failedAt: UpdateStep, why: string, snap: { path: string, sizeBytes: number }, excludes: string[],
): Promise<UpdateAppError> => {
    const plan = rollbackPlan(failedAt)
    log(`updateApp: ${failedAt} failed for ${inst.id} (${why}); rolling back from ${snap.path}`)
    writePreUpdateGate(storeHandle, inst.id, null)
    try {
        await d.composeDown(instDir, inst.id)
        await waitContainersGone(d, inst.id)
        if (plan.restoreData) {
            // In place (idea#448): excluded paths keep their inodes; replaced files go to `aside`.
            const aside = await d.restoreSnapshot(disk, inst.id, excludes)
            log(`updateApp: ${inst.id} restored in place from ${snap.path}; the replaced files are kept at ${aside}`)
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
        const snaps = (await d.listSnapshots(disk).catch(() => null))?.snapshots ?? []
        const complete = snaps.some(s => String(s.instanceId) === String(inst.id) && s.complete)
        const swapped = UPDATE_STEPS.indexOf(step) >= UPDATE_STEPS.indexOf('Swap')
        if (!complete || !swapped) { out.push(`${inst.id}: interrupted at ${step}; old version untouched`); continue }
        const root = await d.mountRoot(disk)
        const instDir = joinMountRoot(root, 'instances', String(inst.id))
        // idea#448: the snapshot's EXCLUDE already holds the live ∪ new list; the compose now in
        // the folder (old or swapped) is added so nothing it excludes is written back.
        let excludes: string[] = []
        try { excludes = (await readComposeBackup(path.join(instDir, 'compose.yaml'), 'current')).exclude } catch (e) {
            log(`updateApp: ${inst.id}: ${(e as Error).message}; restoring with the snapshot's own EXCLUDE list only`)
        }
        const err = await rollBack(storeHandle, d, inst, disk, instDir, step, 'the Engine restarted during the update', { path: joinMountRoot(root, PRE_UPDATE_DIR, String(inst.id)), sizeBytes: 0 }, excludes)
        updateOperation(storeHandle, op.id, { status: 'Failed', error: `INTERRUPTED: ${err.message}`, completedAt: d.now() as Timestamp })
        out.push(`${inst.id}: ${err.message}`)
    }
    if (out.length) await refreshOfferAfterUpdate(storeHandle, engineId, d)
    return out
}


/**
 * Dock-time updateAvailable (Steve call 3): cheap, no full verify. For every instance on a disk
 * docked to this Engine, look for a newer bundle of the same App under apps/ on any disk docked
 * here whose SHA256SUMS exists, is non-empty and lists compose.yaml (read, not checked). The
 * full SHA256SUMS verify stays at update start (NO_SUMS). Sets Instance.updateAvailable (highest
 * version wins; the instance's own disk first on a tie) or null.
 */
export interface UpdateAvailableDeps {
    mountRoot: (disk: Disk) => Promise<string>
    listApps: (appsDir: string) => Promise<string[]>
    readSums: (bundleDir: string) => Promise<string | null>
    /** x-app of a bundle (updatesFrom, healthTimeout, migrationNote) */
    readXApp: (bundleDir: string) => Promise<Record<string, any>>
    /** data bytes a snapshot of the instance would copy (idea#396: net of the snapshot exclude list); null when unknown (estimatedMinutes then left out) */
    dataBytes: (disk: Disk, id: InstanceID, excludes?: string[]) => Promise<number | null>
}
const defaultAvailableDeps: UpdateAvailableDeps = {
    mountRoot: (disk) => diskMountRoot(disk),
    listApps: async (dir) => (await fs.pathExists(dir)) ? (await fs.readdir(dir)).filter(n => !n.startsWith('.')) : [],
    readSums: async (dir) => { try { return await fs.readFile(path.join(dir, 'SHA256SUMS'), 'utf8') } catch { return null } },
    readXApp: (dir) => readXApp(path.join(dir, 'compose.yaml')),
    dataBytes: async (disk, id, excludes = []) => {
        try {
            const e = parseEstimate(await runAppData(estimateArgs(await appDataRoot(disk), String(id), excludes)))
            return e.folderBytes + e.volumeBytes
        } catch { return null }
    },
}
export const sumsLookUsable = (sums: string | null): boolean =>
    !!sums && sums.split('\n').some(l => /^[0-9a-f]{64} [ *]\.?\/?compose\.yaml$/.test(l.trim()))

/** Bundle info for Disk.appBundles from a bundle folder (idea#76 gap 1). Only the fields with a valid value are set. */
export const bundleInfo = (appId: string, sums: string | null, sizeBytes: number, xapp: Record<string, any>): AppBundleInfo => {
    const b: AppBundleInfo = { appId: appId as AppID, version: parseAppId(appId).version, sumsListed: sumsLookUsable(sums), sizeBytes }
    if (Array.isArray(xapp.updatesFrom)) b.updatesFrom = xapp.updatesFrom.map(Number).filter(n => Number.isFinite(n))
    const t = Number(xapp.healthTimeout)
    if (xapp.healthTimeout != null && Number.isFinite(t) && t > 0) b.healthTimeout = t
    if (typeof xapp.migrationNote === 'string' && xapp.migrationNote.trim()) b.migrationNote = xapp.migrationNote.trim()
    return b
}

export interface PublishBundlesDeps extends Pick<UpdateAvailableDeps, 'mountRoot' | 'listApps' | 'readSums' | 'readXApp'> {
    dirBytes: (dir: string) => Promise<number>
    isBundle: (dir: string) => Promise<boolean>
}
const defaultPublishDeps: PublishBundlesDeps = {
    mountRoot: (disk) => diskMountRoot(disk),
    listApps: defaultAvailableDeps.listApps,
    readSums: defaultAvailableDeps.readSums,
    readXApp: defaultAvailableDeps.readXApp,
    dirBytes: async (dir) => (await import('./CopyMoveApp.js')).directoryBytes(dir),
    isBundle: async (dir) => (await fs.pathExists(path.join(dir, 'compose.yaml'))) && !await isUnfinishedFetch(dir),
}

/**
 * Write Disk.appBundles for a disk docked HERE (idea#76 gap 1, Lead option A): called on dock only.
 * The store is written only when the list differs from what it holds (no timer, no rewrite when equal).
 * A half-fetched bundle (no done marker) is not listed. Returns true when the store was written.
 */
export const publishAppBundles = async (storeHandle: DocHandle<Store>, disk: Disk, deps: Partial<PublishBundlesDeps> = {}): Promise<boolean> => {
    const d = { ...defaultPublishDeps, ...deps }
    let list: AppBundleInfo[]
    try {
        const apps = joinMountRoot(await d.mountRoot(disk), 'apps')
        list = []
        for (const appId of (await d.listApps(apps).catch(() => [] as string[])).sort()) {
            const dir = joinMountRoot(apps, appId)
            if (!await d.isBundle(dir).catch(() => false)) continue
            list.push(bundleInfo(appId, await d.readSums(dir), await d.dirBytes(dir).catch(() => 0), await d.readXApp(dir).catch(() => ({}))))
        }
    } catch (e) { log(`publishAppBundles ${disk.id}: ${(e as Error).message}`); return false }
    const cur = storeHandle.doc().diskDB[disk.id as DiskID]
    if (!cur || JSON.stringify(cur.appBundles ?? null) === JSON.stringify(list)) return false
    storeHandle.change(doc => {
        const x = doc.diskDB[disk.id as DiskID]
        if (x) x.appBundles = list.map(b => ({ ...b, ...(b.updatesFrom ? { updatesFrom: [...b.updatesFrom] } : {}) }))
    })
    return true
}

/** Rough LAN copy rate for the cross-Engine part of estimatedMinutes, until Atlas's measurement (idea#351 §10.2). */
export const TRANSFER_BYTES_PER_MIN = 1024 ** 3

/** Bundles on disks docked on OTHER Engines that may be offered: sumsListed and the source advertises updateAppFetch. */
export const remoteBundles = (store: Store, engineId: string): { disk: Disk, appId: string, xapp: Record<string, any>, sizeBytes: number }[] =>
    (Object.values(store.diskDB ?? {}) as Disk[]).flatMap(disk => {
        if (!disk || !disk.dockedTo || !disk.device || String(disk.dockedTo) === engineId || !Array.isArray(disk.appBundles)) return []
        const caps = (store.engineDB as any)?.[String(disk.dockedTo)]?.capabilities
        if (!Array.isArray(caps) || !caps.includes('updateAppFetch')) return []
        return disk.appBundles.filter(b => b && b.sumsListed).map(b => ({
            disk, appId: String(b.appId), sizeBytes: Number(b.sizeBytes) || 0,
            xapp: { updatesFrom: b.updatesFrom ? [...b.updatesFrom] : undefined, healthTimeout: b.healthTimeout, migrationNote: b.migrationNote },
        }))
    })

export const refreshUpdateAvailable = async (storeHandle: DocHandle<Store>, engineId: string, deps: Partial<UpdateAvailableDeps> = {}): Promise<number> => {
    const d = { ...defaultAvailableDeps, ...deps }
    const store = storeHandle.doc()
    const docked = Object.values(store.diskDB ?? {}).filter(x => x && String(x.dockedTo) === engineId && x.device) as Disk[]
    const bundles: { disk: Disk, appId: string, xapp: Record<string, any>, sizeBytes?: number }[] = []
    for (const disk of docked) {
        let root: string
        try { root = await d.mountRoot(disk) } catch { continue }
        for (const appId of await d.listApps(joinMountRoot(root, 'apps')).catch(() => [] as string[])) {
            const dir = joinMountRoot(root, 'apps', appId)
            if (sumsLookUsable(await d.readSums(dir))) bundles.push({ disk, appId, xapp: await d.readXApp(dir).catch(() => ({})) })
        }
    }
    // idea#76 gap 1: local bundles first, so a local copy wins a version tie over a remote one
    bundles.push(...remoteBundles(store, engineId))
    const updates: Record<string, Instance['updateAvailable']> = {}
    for (const inst of Object.values(store.instanceDB ?? {}) as Instance[]) {
        if (!inst) continue
        if (!docked.some(x => String(x.id) === String(inst.storedOn))) {
            // idea#76: an instance whose disk is docked nowhere has no hint; one docked on another Engine is that Engine's
            const own = inst.storedOn ? store.diskDB[inst.storedOn as DiskID] : undefined
            if (inst.updateAvailable && (!own || !own.dockedTo)) updates[String(inst.id)] = null
            continue
        }
        let best: (typeof bundles)[number] | null = null
        for (const b of bundles) {
            if (!offerable({ currentAppId: String(inst.instanceOf), newAppId: b.appId, sumsValid: true, updatesFrom: b.xapp.updatesFrom })) continue
            const c = best ? compareVersions(parseAppId(b.appId).version, parseAppId(best.appId).version) : 1
            if (c !== null && (c > 0 || (c === 0 && String(b.disk.id) === String(inst.storedOn)))) best = b
        }
        if (!best) { updates[String(inst.id)] = null; continue }
        const from = parseAppId(String(inst.instanceOf)).version, to = parseAppId(best.appId).version
        const u: NonNullable<Instance['updateAvailable']> = {
            appId: best.appId as AppID, sourceDiskId: best.disk.id as DiskID, sourceEngineId: String(best.disk.dockedTo) as any,
            fromVersion: from, toVersion: to, major: isMajorChange(from, to),
        }
        // idea#76: estimatedMinutes (snapshot copy + health timeout) and the App's migrationNote
        const disk = docked.find(x => String(x.id) === String(inst.storedOn))!
        let hintExcludes: string[] = []
        try {
            const instDir = joinMountRoot(await d.mountRoot(disk), 'instances', String(inst.id))
            const liveCompose = path.join(instDir, 'compose.yaml')
            const live = await readComposeBackup(liveCompose, 'live')
            const liveSnap = await readComposeSnapshotExclude(liveCompose, 'live')
            hintExcludes = assertSnapshotExcludeList(mergeBackupExcludeLists(live.exclude, parseBackupExcludeList(best.xapp), liveSnap), 'snapshot exclude')
        } catch { hintExcludes = [] }
        const bytes = await d.dataBytes(disk, inst.id, hintExcludes).catch(() => null)
        const remote = String(best.disk.dockedTo) !== engineId
        if (remote) u.sizeBytes = best.sizeBytes ?? 0
        if (bytes !== null) u.estimatedMinutes = estimateUpdateMinutes(bytes, healthTimeoutSeconds(parseAppId(best.appId).name, best.xapp.healthTimeout))
            + (remote ? Math.ceil((best.sizeBytes ?? 0) / TRANSFER_BYTES_PER_MIN) : 0)
        if (typeof best.xapp.migrationNote === 'string' && best.xapp.migrationNote.trim()) u.migrationNote = best.xapp.migrationNote.trim()
        updates[String(inst.id)] = u
    }
    storeHandle.change(doc => {
        for (const [id, u] of Object.entries(updates)) {
            const i = doc.instanceDB[id as InstanceID]
            if (!i) continue
            const cur = JSON.stringify(i.updateAvailable ?? null), next = JSON.stringify(u ?? null)
            if (cur !== next) i.updateAvailable = u ? { ...u } : null
        }
    })
    return Object.values(updates).filter(Boolean).length
}

/**
 * idea#76 gap 1: true when a store patch changes a disk's dockedTo or appBundles, so the cross-Engine
 * hints must be recomputed (dock/undock on any Engine, or a source Engine republishing its list).
 */
export const patchTouchesBundles = (p: { path: (string | number)[] }): boolean =>
    p.path[0] === 'diskDB' && (p.path[2] === 'dockedTo' || p.path[2] === 'appBundles' || p.path.length <= 2)

let hintTimer: ReturnType<typeof setTimeout> | null = null
/** Debounced refreshUpdateAvailable for store changes (one refresh per burst of patches). */
export const scheduleHintRefresh = (storeHandle: DocHandle<Store>, engineId: string, delayMs = 2000): void => {
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = setTimeout(() => {
        hintTimer = null
        refreshUpdateAvailable(storeHandle, engineId).catch(e => log(`updateAvailable refresh after a disk change failed: ${(e as Error).message}`))
    }, delayMs)
}

/**
 * idea#459: recompute updateAvailable after an updateApp (done, failed or rolled back) or a
 * startup recovery. Without it the dock-time offer stayed on the record, so an instance that
 * now runs 1.1 was still offered 1.1. Uses the same mount root as the update; best effort (a
 * failure is logged and the next dock recomputes it).
 */
export const refreshOfferAfterUpdate = async (storeHandle: DocHandle<Store>, engineId: string, d: Pick<UpdateDeps, 'mountRoot'>): Promise<void> => {
    try { await refreshUpdateAvailable(storeHandle, engineId, { mountRoot: d.mountRoot }) } catch (e) {
        log(`updateApp: updateAvailable refresh after the update failed: ${(e as Error).message}`)
    }
}
