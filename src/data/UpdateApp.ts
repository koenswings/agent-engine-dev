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
 *  - Swap: copy the new bundle files over the instance folder (.env kept; engine#447: dest relative symlinks are unlinked first and copied as links), restamp
 *    x-app.instanceName and x-app.demo from the old instance compose, re-read the record (instanceOf = newAppId).
 *  - Start, Health: startInstance, then the health gate (healthGate) within healthTimeout.
 * Any failure from Snapshot on rolls back: compose down (no -v), `restore-snapshot` (in place,
 * helper v9: instances/<id> is never moved; replaced or deleted files go to .idea-quarantine
 * first, so even that is undoable), re-read the record, start the old version. Result text:
 * "ROLLED BACK: <why>"; when the rollback itself fails the instance is left Stopped with
 * statusCondition "ROLLBACK FAILED: ...".
 * Nothing is ever deleted except the engine#469 temporary backup below; snapshots are kept (quarantine only).
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
 * engine#469 (Koen's decision on idea#374): when that backup is due but no linked Backup Disk is
 * docked here, updateApp makes a TEMPORARY backup on the system disk instead (helper v18,
 * <system>/.idea-temp-backups/<id>/<stamp>/, a verified Borg repo, inside the one Snapshot stop).
 * It satisfies NEEDS_BACKUP for this operation only (no lastBackup, no backup result, no
 * BACKUP.yaml). Space is checked at Check (TEMP_BACKUP_NO_SPACE; the snapshot counts too when
 * it lands on the same filesystem). After the Health gate passes it is really deleted (rm -rf,
 * Koen's exception, only inside that subtree); on any failure it is kept, its path goes in the
 * error and the operation, and a failed snapshot restore falls back to it. Boot recovery never
 * deletes it.
 *
 * Named Docker volumes of the instance are exported into the snapshot too (helper v5, offline host
 * tar, verified before COMPLETE) and restored on rollback; a previous snapshot is renamed into
 * .idea-quarantine first (never copied or removed).
 */
import { assertAppId } from './NameCheck.js'
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
    TEMP_BACKUP_HELPER_MIN, borgProblem, tempBackupEstimateArgs, parseTempBackupEstimate, tempBackupCreateArgs,
    parseTempBackupCreate, tempBackupDeleteArgs, tempBackupRestoreArgs, TempBackupEstimate, verifyStampNow,
    runAppDataWithInput, swapQuarantineArgs, swapQuarantineInput, parseSwapQuarantine, swapPathProblem,
    SWAP_QUARANTINE_HELPER_MIN, SwapQuarantineResult,
} from '../utils/appDataHelper.js'
import { createOperation, updateOperation, dropInterruptedCommand } from './Operations.js'
import { log } from '../utils/utils.js'
import {
    UpdateAppError, UpdateStep, UPDATE_STEPS, checkUpdate, healthGate, healthTimeoutSeconds, rollbackPlan,
    parseHealthCheck, healthBodyOk, estimateUpdateMinutes, fallbackUp, fallbackHealthTimeoutSeconds,
    HealthSample, ContainerHealth, offerable, compareVersions, isMajorChange, backupIsDue,
    declaredUpdateStages, parseUpdateContract, contractHasSteps, UpdateContract, UpdateStepSpec,
} from './UpdateAppPolicy.js'
import { writeUpdateInFlight, clearUpdateInFlight } from './UpdateInFlight.js'
import { runUpdateStep, StepContext, StepRun, stepFailureText } from './UpdateStepRunner.js'
import type { UpdateStageKey } from './UpdateAppPolicy.js'
import { appIdentity } from './AppIdParse.js'
import { stampComposeInstanceIdentity } from './InstanceCopy.js'
import { isUnfinishedFetch } from './UpdateFetch.js'
import { beginUsageSkip, endUsageSkip } from '../usage/opFlags.js'
import { parseBackupExcludeList, parseSnapshotExcludeList, mergeBackupExcludeLists, assertSnapshotExcludeList } from '../utils/backupExclude.js'
import { defaultReadBootId, defaultReadUptimeS } from '../usage/sampler.js'
import { engineClockTrusted } from '../utils/engineClockStatus.js'
import { parseBackupSpec, BackupMethod } from '../utils/backupMethod.js'
import type { PreUpdateBackupOptions } from '../monitors/backupMonitor.js'
import { backupArchiveName } from '../utils/backupArchiveName.js'
import { shouldFailUpdateRestart, TEST_FAIL_UPDATE_FAILURE_MESSAGE, TEST_FAIL_UPDATE_RESTART_MESSAGE } from './UpdateAppTestHook.js'
import { stableStringify } from '../utils/stableJson.js'

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
    /** engine#456: the step's last `ERROR:` / `not yet:` line (≤ 200 characters), absent otherwise */
    phaseNote?: string
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
    /** engine#469: the temporary backup on the system disk (null when none was made); deleted after full success (engine#456) */
    tempBackup: { path: string, sizeBytes: number, deleted: boolean } | null
    /** engine#456: true when this run only finished a committed update (work + settle) */
    resumed?: boolean
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
    /** engine#506: why the helper cannot quarantine the files the new bundle dropped (below v24), or null */
    swapQuarantineProblem: () => Promise<string | null>
    /** engine#506: helper swap-quarantine (v24): move those instance-relative files to .idea-quarantine (never rm) */
    swapQuarantine: (disk: Disk, id: InstanceID, paths: string[]) => Promise<SwapQuarantineResult>
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
    /** engine#469: why no temporary backup can be made here (helper below v18, or no borg), or null */
    tempBackupProblem: () => Promise<{ code: 'HELPER_OUTDATED' | 'TEMP_BACKUP_FAILED', text: string } | null>
    /** engine#469: read-only net size (backup excludes out), system-disk free space, same filesystem */
    tempBackupEstimate: (disk: Disk, id: InstanceID, excludes: string[]) => Promise<TempBackupEstimate>
    /** engine#469: helper temp-backup-create (containers stopped); resolves when borg check passed */
    tempBackupCreate: (disk: Disk, id: InstanceID, stamp: string, archive: string, excludes: string[]) => Promise<{ path: string, sizeBytes: number }>
    /** engine#469: helper temp-backup-delete (rm -rf inside <system>/.idea-temp-backups/ only) */
    tempBackupDelete: (id: InstanceID, stamp: string) => Promise<void>
    /** engine#469: helper temp-backup-restore; resolves with the quarantined replaced folder (or 'none') */
    tempBackupRestore: (disk: Disk, id: InstanceID, stamp: string) => Promise<string>
    /** Refresh Engine.tempBackups after a temp backup is created or deleted (and at boot). */
    refreshTempBackups: () => Promise<void>
    reread: (disk: Disk, id: InstanceID) => Promise<void>
    /** engine#456: `updateOpId` owns instances/<id>/.idea-update-in-flight (any other start is refused) */
    start: (inst: Instance, disk: Disk, opts?: { updateOpId?: string, imagesLoaded?: boolean }) => Promise<void>
    /**
     * engine#456 LoadImages: `docker image load` the swapped compose's service images from the
     * disk's services/*.tar (Instance.ts pinned-tar logic, idea#322/#445), never a pull. `strict`
     * (a bundle with x-app.update): a missing or stale image throws (PREPARE_FAILED, rollback).
     */
    loadImages: (instDir: string, mountRoot: string, strict: boolean) => Promise<void>
    /**
     * engine#456: the per-start .env values and the Files / USB override Start uses, for the
     * prepare one-off. Resolves with the extra compose files (absolute) after compose.yaml.
     */
    stepComposeFiles: (inst: Instance, disk: Disk, writeEnv: boolean) => Promise<string[]>
    /** engine#456: run one x-app.update step (UpdateStepRunner.ts) */
    runStep: (kind: UpdateStageKey, spec: UpdateStepSpec, ctx: StepContext, opts?: { timeoutS?: number }) => Promise<StepRun>
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

/**
 * engine#447: fs.copy({overwrite:true}) cannot replace an existing relative
 * symlink ("Cannot copy '../pre-installation/…' to a subdirectory of itself").
 * lstat the dest (never follow): a symlink is unlinked, including one that
 * points at a directory, so the copy cannot descend into and empty the target.
 * A type change (symlink ↔ file) removes the dest entry too. Recurses only
 * through real directories. Only paths present in `src` are touched.
 */
export const unlinkDestSymlinks = async (src: string, dst: string): Promise<void> => {
    const srcStat = await fs.lstat(src)
    const dstStat = await fs.lstat(dst).catch(() => null)
    if (!dstStat) return
    if (dstStat.isSymbolicLink()) { await fs.unlink(dst); return }
    if (srcStat.isSymbolicLink()) { await fs.remove(dst); return }
    if (srcStat.isDirectory() && dstStat.isDirectory()) {
        for (const name of await fs.readdir(src)) {
            await unlinkDestSymlinks(path.join(src, name), path.join(dst, name))
        }
    }
}

/**
 * Copy one bundle tree over a dest folder (apps/<id> or instances/<id>).
 * Skips .env, SHA256SUMS and .idea-* so the instance identity and markers stay.
 * Links are copied as links with their relative targets unchanged (dereference: false).
 */
export const copyBundle = async (src: string, dst: string): Promise<void> => {
    for (const name of await fs.readdir(src)) {
        if (name === '.env' || name === 'SHA256SUMS' || name.startsWith('.idea-')) continue
        const from = path.join(src, name), to = path.join(dst, name)
        await unlinkDestSymlinks(from, to)
        await fs.copy(from, to, { overwrite: true, dereference: false })
    }
}

/**
 * engine#506: the relative paths a SHA256SUMS lists (`<64 hex>  <path>` or `<64 hex> *<path>`,
 * a leading ./ dropped). sha256sum's escaped lines (a leading backslash: a name with a newline
 * or a backslash) and anything else are left out.
 */
export const sumsPaths = (sums: string): string[] => {
    const out: string[] = []
    for (const line of sums.split('\n')) {
        const m = line.replace(/\r$/, '').match(/^[0-9a-fA-F]{64} [ *](.+)$/)
        if (!m) continue
        out.push(m[1].replace(/^(\.\/)+/, ''))
    }
    return out
}

/** engine#506: every non-folder entry under `dir` (files and links, never followed), relative, '/'-separated. */
export const bundleTreeEntries = async (dir: string, rel = ''): Promise<string[]> => {
    const out: string[] = []
    for (const name of await fs.readdir(path.join(dir, rel))) {
        const r = rel ? `${rel}/${name}` : name
        const st = await fs.lstat(path.join(dir, r))
        if (st.isDirectory()) out.push(...await bundleTreeEntries(dir, r))
        else out.push(r)
    }
    return out
}

export interface SwapDropped {
    /** false when the instance has no top-level SHA256SUMS (nothing to compare; nothing is moved) */
    oldSums: boolean
    /** listed in the instance's SHA256SUMS (the bundle it was installed or last updated from), absent from the new bundle */
    paths: string[]
    /** dropped too, but never moved: instance data (data/), Engine markers, .env, or a name the helper refuses */
    skipped: { path: string, why: string }[]
}

/**
 * engine#506: the bundle-owned files the old bundle had and the new one dropped. "Old" is the
 * instance's own top-level SHA256SUMS (install copies it; Swap refreshes it), never a walk of the
 * instance folder, so data/ and anything the App or the Engine wrote there is never a candidate.
 * "New" is the new bundle's SHA256SUMS plus every entry in its tree (copyBundle copies both).
 */
export const swapDroppedPaths = async (instDir: string, bundleDir: string): Promise<SwapDropped> => {
    let oldSums: string
    try { oldSums = await fs.readFile(path.join(instDir, 'SHA256SUMS'), 'utf8') } catch { return { oldSums: false, paths: [], skipped: [] } }
    const keep = new Set<string>(await bundleTreeEntries(bundleDir))
    try { for (const p of sumsPaths(await fs.readFile(path.join(bundleDir, 'SHA256SUMS'), 'utf8'))) keep.add(p) } catch { /* no SHA256SUMS: the tree alone */ }
    const paths: string[] = []
    const skipped: SwapDropped['skipped'] = []
    for (const p of [...new Set(sumsPaths(oldSums))].sort()) {
        if (keep.has(p)) continue
        const why = swapPathProblem(p)
        if (why) skipped.push({ path: p, why })
        else paths.push(p)
    }
    return { oldSums: true, paths, skipped }
}

/**
 * engine#506: the instance's top-level SHA256SUMS becomes the new bundle's (copyBundle skips it,
 * so the install-time file used to stay forever). Written to a temp file and renamed. Returns why
 * it could not, or null; a failure is a warning (the update itself does not depend on it).
 */
export const refreshInstanceSums = async (bundleDir: string, instDir: string): Promise<string | null> => {
    const src = path.join(bundleDir, 'SHA256SUMS')
    if (!await fs.pathExists(src)) return `the new bundle ${bundleDir} has no SHA256SUMS`
    const tmp = path.join(instDir, '.SHA256SUMS.swap-tmp')
    try {
        await fs.copyFile(src, tmp)
        await fs.rename(tmp, path.join(instDir, 'SHA256SUMS'))
        return null
    } catch (e) {
        await fs.remove(tmp).catch(() => undefined)
        return (e as Error).message
    }
}

/**
 * engine#456 LoadImages (§1 gap, §10): load the swapped compose's service images from the App
 * Disk's services/*.tar with the Start path's pinned-tar logic (preloadServiceImageFromTar,
 * verifyServiceImageDigest). Offline: never a pull. Without x-app.update a missing tar stays a
 * warning, as in Start today; with x-app.update (`strict`) any warning, a stale tar or an image
 * that is not local afterwards throws. Tests skip it like Start does (skipImageLoad).
 */
export const defaultLoadImages = async (instDir: string, mountRoot: string, strict: boolean): Promise<void> => {
    const { skipImageLoad } = await import('./Config.js')
    if (skipImageLoad()) { log(`updateApp: LoadImages: skipImageLoad is set; not loading images from ${mountRoot}/services`); return }
    const I = await import('./Instance.js')
    const compose = YAML.parse(await fs.readFile(path.join(instDir, 'compose.yaml'), 'utf8'))
    const images = [...new Set(Object.values(compose?.services ?? {}).map((s: any) => String(s?.image ?? '')).filter(Boolean))]
    const problems: string[] = []
    for (const image of images) {
        const warnings: string[] = []
        // a stale pinned tar throws here (quarantined, never loaded)
        await I.preloadServiceImageFromTar(image, mountRoot, async (msg) => { log(`updateApp: LoadImages: ${msg}`); warnings.push(msg) })
        if (image.includes('@')) {
            // pinned: the pin itself must be local and match (idea#322/#445); a warning about a stale
            // tar while the pin is already local is not a problem with the image
            await I.verifyServiceImageDigest(image, { requirePresent: strict })
        } else if (strict) {
            // unpinned: the tar must have loaded, and the tag must be local afterwards
            problems.push(...warnings)
            if (!(await I.inspectServiceImage(image)).id) problems.push(`Service image ${image} is not local after the load`)
        }
    }
    if (problems.length) throw new Error(problems.join('; '))
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
    copyBundle,
    swapQuarantineProblem: () => helperAtLeast(SWAP_QUARANTINE_HELPER_MIN, 'Moving the files the new bundle dropped out of the instance folder (engine#506)'),
    swapQuarantine: async (disk, id, paths) =>
        parseSwapQuarantine(await runAppDataWithInput(swapQuarantineArgs(await appDataRoot(disk), String(id)), swapQuarantineInput(paths))),
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
    tempBackupProblem: async () => {
        const helper = await helperAtLeast(TEMP_BACKUP_HELPER_MIN, 'the temporary pre-update backup on the system disk (engine#469)')
        if (helper) return { code: 'HELPER_OUTDATED', text: helper }
        const borg = borgProblem()
        return borg ? { code: 'TEMP_BACKUP_FAILED', text: borg } : null
    },
    tempBackupEstimate: async (disk, id, excludes) => parseTempBackupEstimate(await runAppData(tempBackupEstimateArgs(await appDataRoot(disk), String(id), excludes))),
    tempBackupCreate: async (disk, id, stamp, archive, excludes) =>
        parseTempBackupCreate(await runAppData(tempBackupCreateArgs(await appDataRoot(disk), String(id), stamp, archive, excludes))),
    tempBackupDelete: async (id, stamp) => { await runAppData(tempBackupDeleteArgs(String(id), stamp)) },
    tempBackupRestore: async (disk, id, stamp) => lastLine(await runAppData(tempBackupRestoreArgs(await appDataRoot(disk), String(id), stamp))),
    refreshTempBackups: async () => { const { refreshTempBackups } = await import('./TempBackups.js'); await refreshTempBackups(storeHandle) },
    reread: async (disk, id) => { await (await import('./Instance.js')).createOrUpdateInstance(storeHandle, id, disk) },
    start: async (inst, disk, opts) => (await import('./Instance.js')).startInstance(storeHandle, inst, disk, 'console-command', opts ?? {}),
    loadImages: (instDir, mountRoot, strict) => defaultLoadImages(instDir, mountRoot, strict),
    stepComposeFiles: async (inst, disk, writeEnv) => {
        const I = await import('./Instance.js')
        const mountRoot = await diskMountRoot(disk)
        const store = storeHandle.doc()
        const fresh = (store.instanceDB[inst.id] as Instance) ?? inst
        if (writeEnv) {
            const instDir = joinMountRoot(mountRoot, 'instances', String(inst.id))
            if (!await fs.pathExists(path.join(instDir, '.env'))) await fs.writeFile(path.join(instDir, '.env'), '')
            await I.writeStartHostEnv(store, fresh, mountRoot)
        }
        const env = await (await import('./FilesMount.js')).composeFileEnv(store, fresh)
        if (!env?.COMPOSE_FILE) return []
        const instDir = joinMountRoot(mountRoot, 'instances', String(inst.id))
        return env.COMPOSE_FILE.split(':').filter(f => f && f !== 'compose.yaml').map(f => path.resolve(instDir, f))
    },
    runStep: (kind, spec, ctx, opts) => runUpdateStep(kind, spec, ctx, opts),
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
    // newAppId becomes apps/<newAppId> on a disk: one safe path component only
    assertAppId(pos[1], 'updateApp app id')
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

/** engine#456: the service names of a compose file; [] when unreadable. */
export const readComposeServices = async (composePath: string): Promise<string[]> => {
    try {
        const sv = YAML.parse(await fs.readFile(composePath, 'utf8'))?.services
        return sv && typeof sv === 'object' && !Array.isArray(sv) ? Object.keys(sv) : []
    } catch { return [] }
}

/** engine#456: the plain updateApp that resumes a committed update (Console reuses the Update action). */
export const resumeCommand = (inst: Pick<Instance, 'id' | 'instanceOf'>): string => `updateApp ${inst.id} ${inst.instanceOf}`

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

    // engine#456 §10: while a committed update has not settled, the only update accepted is the
    // plain resume `updateApp <id> <current version>` (no --source, no --allow-major).
    if (inst.updatePending) {
        const cur = String(inst.instanceOf)
        const curVersion = appIdentity(cur, await readXApp(path.join(joinMountRoot(await d.mountRoot(disk), 'instances', String(inst.id)), 'compose.yaml'))).version
        const isResume = (newAppId === cur || newAppId === curVersion) && !opts.allowMajor && !opts.sourceDiskId
        if (!isResume) throw new UpdateAppError('UPDATE_PENDING', `finish the current update first: send ${resumeCommand(inst)} (no --source, no --allow-major) to run its work and settle steps again`)
        return resumeUpdate(storeHandle, d, inst, disk, engineId)
    }

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
        let snapshotNeed = 0
        let snapExcludes: string[] = []
        let liveBackupExcludes: string[] = []
        let backupExcludes: string[] = []
        let liveSnapshotExcludes: string[] = []
        let live: Awaited<ReturnType<typeof readComposeBackup>> | undefined
        const newCompose = bundle ? path.join(bundle.dir, 'compose.yaml') : ''
        const backupAgeMs = inst.lastBackup ? d.now() - Number(inst.lastBackup) : null
        // idea#403: method none has nothing to back up (no NEEDS_BACKUP). Read best-effort here so
        // NEEDS_BACKUP / MAJOR / NO_SUMS keep their order; a malformed spec refuses BAD_BACKUP_SPEC below.
        const liveBackupMethod = await readComposeBackup(path.join(instDir, 'compose.yaml'), 'live').then(r => r.method, () => undefined)
        // engine#480: the live compose's x-app (which built instanceOf) and the bundle's x-app name
        // each App; splitting `kiwix-release-1.0` at a digit read the kit's kiwix@release-1.0 as kiwix-release@1.0.
        const liveXApp = await readXApp(path.join(instDir, 'compose.yaml'))
        const xapp = bundle ? await readXApp(path.join(bundle.dir, 'compose.yaml')) : {}
        const newServices = bundle ? await readComposeServices(path.join(bundle.dir, 'compose.yaml')) : undefined
        const backupDue = backupIsDue(String(inst.instanceOf), newAppId, backupAgeMs, liveXApp, xapp)
        const backupDisk = backupDue ? linkedBackupDisk(store, engineId, inst) : null
        // engine#469: due, nothing to back up to, and something to back up: a temporary backup on
        // the system disk satisfies the gate for this operation (a malformed spec still refuses
        // BAD_BACKUP_SPEC below, before anything changes).
        const tempBackupPlanned = backupDue && !backupDisk && liveBackupMethod !== 'none'
        const facts = {
            diskDocked: true, busy: !gotLock, currentAppId: String(inst.instanceOf), newAppId,
            currentXApp: liveXApp, newXApp: xapp,
            sourcePresent: !!bundle, sumsValid: bundle ? await d.verifySums(bundle.dir) : false,
            allowMajor: !!opts.allowMajor,
            backupAgeMs,
            shortDisks: [] as string[],
            updatesFrom: xapp.updatesFrom,
            xAppUpdate: xapp.update,
            newServices,
            backupPlanned: !!backupDisk || tempBackupPlanned,
            backupMethod: liveBackupMethod,
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
            snapshotNeed = dataBytes + snapshotMarginBytes(dataBytes) + bundleBytes
            if (est.freeBytes < snapshotNeed) shortDisks = [`${disk.name} (snapshot needs ${snapshotNeed}, free ${est.freeBytes})`]
        }
        if (shortDisks.length) {
            const space = checkUpdate({ ...facts, shortDisks })
            if (space) throw space
        }
        if (bundle && gotLock && tempBackupPlanned) {
            // engine#469: refuse before anything stops when the temporary backup cannot be made or will not fit.
            const problem = await d.tempBackupProblem()
            if (problem) throw new UpdateAppError(problem.code, `${problem.text} Dock a Backup Disk linked to this instance instead; nothing was stopped or changed`)
            let tb: TempBackupEstimate
            try { tb = await d.tempBackupEstimate(disk, inst.id, liveBackupExcludes) } catch (e) {
                throw new UpdateAppError('TEMP_BACKUP_FAILED', `cannot size the temporary pre-update backup: ${(e as Error).message}; nothing was stopped or changed`)
            }
            const space = tempBackupSpace(tb, snapshotNeed)
            if (space) throw space
        }
        // idea#458: the pre-update backup method comes from the LIVE compose (a backup of the
        // current instance), never from the new bundle.
        progress('Check')
        // engine#456: checkUpdate has validated it; the steps come from the NEW bundle only
        const parsed = parseUpdateContract(xapp.update, newServices)
        const contract: UpdateContract = parsed.ok ? parsed.contract : {}
        const staged = contractHasSteps(contract)

        const fromAppId = inst.instanceOf
        const opId = createOperation(storeHandle, 'updateApp', { instanceId: String(inst.id), diskId: String(disk.id), fromAppId: String(fromAppId), toAppId: newAppId }, 'console-command', { type: 'instance', id: inst.id })
        opened = true
        updateOperation(storeHandle, opId, { status: 'Running' })
        const setStep = (step: UpdateStep) => updateOperation(storeHandle, opId, { currentStep: UPDATE_STEPS.indexOf(step), totalSteps: UPDATE_STEPS.length, stepLabel: step })
        let step: UpdateStep = 'Snapshot'
        // engine#456: set once verify passed and args.committed is persisted (no rollback after it)
        let committed = false
        let markerWritten = false
        let snap: SnapshotResult | null = null
        let stopped = false
        let preUpdateBackup: UpdateResult['preUpdateBackup'] = null
        let tempBackup: TempBackupRef | null = null
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
            // idea#403: method none copies nothing; the result says so instead of 'stop'
            preUpdateBackup = { backupDiskId: String(backupDisk!.id), method: live?.method === 'none' ? 'none' : (instanceStopped ? 'stop' : 'hook'), duringStop: instanceStopped }
            log(`updateApp: ${inst.id}: pre-update backup to ${backupDisk!.id} done (${instanceStopped ? 'inside the snapshot stop' : 'hook, no stop'})`)
        }
        const takeTempBackup = async () => {
            updateOperation(storeHandle, opId, { stepLabel: 'Temporary pre-update backup on the system disk (no Backup Disk linked; inside the snapshot stop)' })
            const stamp = verifyStampNow(new Date(d.now()))
            try {
                const r = await d.tempBackupCreate(disk, inst.id, stamp, backupArchiveName(new Date(d.now()), 'stop'), liveBackupExcludes)
                tempBackup = { stamp, path: r.path, sizeBytes: r.sizeBytes }
            } catch (e) {
                const m = String((e as Error).message)
                // A failed create never wrote COMPLETE, so it can never be restored: remove its folder.
                await d.tempBackupDelete(inst.id, stamp).catch(de => log(`updateApp: ${inst.id}: removing the failed temporary backup ${stamp} failed: ${(de as Error).message}`))
                await d.refreshTempBackups().catch(re => log(`updateApp: ${inst.id}: tempBackups refresh after a failed create: ${(re as Error).message}`))
                const ns = m.match(/TEMP_BACKUP_NO_SPACE: [^\n]*/)
                if (ns) throw new UpdateAppError('TEMP_BACKUP_NO_SPACE', ns[0].replace(/^TEMP_BACKUP_NO_SPACE: /, ''))
                throw new UpdateAppError('TEMP_BACKUP_FAILED', `the temporary pre-update backup on the system disk failed: ${m}`)
            }
            setTempBackupOpArgs(storeHandle, opId, tempBackup, 'created')
            await d.refreshTempBackups().catch(re => log(`updateApp: ${inst.id}: tempBackups refresh after create failed: ${(re as Error).message}`))
            log(`updateApp: ${inst.id}: temporary pre-update backup ${tempBackup.path} done (${tempBackup.sizeBytes} bytes, inside the snapshot stop)`)
        }
        try {
            // ── Backup (engine#456: its own step; a hook backup runs before anything stops)
            if (hookFirst) { setStep('Backup'); progress('Backup'); await takeBackup(false) }
            // ── Snapshot (a stop-mode or temporary backup runs inside the one Snapshot stop, under Backup)
            const backupInStop = (!!backupDisk && !hookFirst) || tempBackupPlanned
            if (backupInStop) { setStep('Backup'); progress('Backup') } else { setStep('Snapshot'); progress('Snapshot', 0, dataBytes) }
            if (wasUp) { stopped = true; await d.stop(inst, disk) }
            await waitContainersGone(d, inst.id)
            // engine#449: env-gated test hook, read per call. Fail pre-swap after
            // the Snapshot stop so the old-version restart path runs.
            if (shouldFailUpdateRestart(inst.id)) throw new Error(TEST_FAIL_UPDATE_FAILURE_MESSAGE)
            if (backupDisk && !hookFirst) await takeBackup(true)
            if (tempBackupPlanned) await takeTempBackup()
            if (backupInStop) { setStep('Snapshot'); progress('Snapshot', 0, dataBytes) }
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
            // engine#456 Q4: from here until verify passes, no other start may run this folder
            if (staged) { await writeUpdateInFlight(instDir, opId, engineId); markerWritten = true }
            if (bundle!.dir !== targetApps) await d.copyBundle(bundle!.dir, targetApps)
            // engine#506: files the old bundle had and the new one dropped leave the instance folder
            // first (moved to .idea-quarantine by the helper, never removed). A failure throws here,
            // inside Swap, so the rollback puts the old version back from the snapshot.
            await quarantineSwapDropped(storeHandle, d, opId, disk, inst.id, instDir, bundle!.dir)
            await d.copyBundle(bundle!.dir, instDir)
            const sumsProblem = await refreshInstanceSums(bundle!.dir, instDir)
            if (sumsProblem) log(`updateApp: ${inst.id}: WARNING: the instance's SHA256SUMS was not refreshed from the new bundle (${sumsProblem}); it still lists the previous bundle's files (engine#506)`)
            const composePath = path.join(instDir, 'compose.yaml')
            await fs.writeFile(composePath, stampComposeInstanceIdentity(await fs.readFile(composePath, 'utf8'), { instanceName: String(inst.name), demo: oldDemo }))
            await d.reread(disk, inst.id)
            done.push('Swap')
            if (oldDemo) await refreshDemoPackWarning(storeHandle, instDir, bundle!.dir, inst.id)
            const fromVersion = appIdentity(String(fromAppId), liveXApp).version
            const toVersion = appIdentity(newAppId, xapp).version
            const stepCtx = async (writeEnv: boolean): Promise<StepContext> => ({
                instanceDir: instDir, project: composeProjectFor(String(inst.id)), fromVersion, toVersion,
                extraComposeFiles: await d.stepComposeFiles((storeHandle.doc().instanceDB[inst.id] as Instance) ?? inst, disk, writeEnv),
            })
            const setNote = (s: UpdateStep, note: string | null) => setPhaseNote(storeHandle, d, opId, engineId, String(inst.id), s, note)
            // ── LoadImages (engine#456: every App; offline, never a pull)
            step = 'LoadImages'; setStep('LoadImages'); progress('LoadImages')
            try { await d.loadImages(instDir, instRoot, staged) } catch (e) {
                throw new UpdateAppError('PREPARE_FAILED', `the service images could not be loaded from the disk: ${(e as Error).message}`)
            }
            done.push('LoadImages')
            // ── Prepare (one-off container, the App's own containers stay down)
            if (contract.prepare) {
                step = 'Prepare'; setStep('Prepare'); progress('Prepare')
                const r = await d.runStep('prepare', contract.prepare, await stepCtx(true))
                setNote('Prepare', r.note)
                if (!stepOk(r)) throw new UpdateAppError('PREPARE_FAILED', stepFailureText('prepare', contract.prepare, r))
                done.push('Prepare')
            }
            // ── Start
            step = 'Start'; setStep('Start'); progress('Start')
            const fresh = storeHandle.doc().instanceDB[inst.id] as Instance
            await d.start(fresh, disk, { ...(staged ? { updateOpId: opId } : {}), imagesLoaded: true })
            const after = storeHandle.doc().instanceDB[inst.id]
            if (!after || after.status === 'Error') throw new Error(`start failed: ${after?.statusCondition ?? 'instance record missing'}`)
            done.push('Start')
            // ── Health
            step = 'Health'; setStep('Health')
            const newX = await readXApp(composePath)
            const hc = parseHealthCheck(newX.healthCheck)
            // Declared healthCheck: agreed per-App timeout rule; fallback (main URL): healthTimeout, per-App default, else 300 s
            const timeoutS = hc ? await readHealthTimeout(composePath, appIdentity(newAppId, newX).name) : fallbackHealthTimeoutSeconds(appIdentity(newAppId, newX).name, newX.healthTimeout)
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
            // ── Verify (in the running service; never runs when Health failed)
            if (contract.verify) {
                step = 'Verify'; setStep('Verify'); progress('Verify')
                const r = await d.runStep('verify', contract.verify, await stepCtx(false))
                setNote('Verify', r.note)
                if (!stepOk(r)) throw new UpdateAppError('VERIFY_FAILED', stepFailureText('verify', contract.verify, r))
                done.push('Verify')
            }
            // ── point of no return (E2): persisted BEFORE work starts, so boot recovery never rolls back after it
            storeHandle.change(doc => {
                const o = doc.operationDB?.[opId]
                if (o) { o.args.committed = 'true'; o.args.committedAt = String(d.now()); o.args.fromVersion = fromVersion; o.args.toVersion = toVersion }
            })
            committed = true
            if (markerWritten) {
                await clearUpdateInFlight(instDir, opId).catch(me => console.warn(`updateApp: ${inst.id}: could not remove the update-in-flight marker after verify: ${(me as Error).message}; the App will not start on its own until it is removed`))
            }
            const pending = !!(contract.work || contract.settle)
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
                    if (staged) i.updatePending = true
                }
            })
            if (pending) log(`updateApp: ${inst.id}: verify passed (point of no return); ${newAppId} runs; work and settle follow`)
            // ── Work, Settle (no rollback); the temporary backup goes only after full success
            const fin = await finishCommitted(storeHandle, d, {
                inst, opId, engineId, contract, stepCtx: () => stepCtx(false), tempBackup, toAppId: newAppId,
                resumeHint: `updateApp ${inst.id} ${newAppId}`, setStep, progress, done,
            })
            updateOperation(storeHandle, opId, { status: 'Done', completedAt: d.now() as Timestamp })
            log(`updateApp: ${inst.id} ('${inst.name}') ${fromAppId} -> ${newAppId}; snapshot ${snap.path} (${snap.sizeBytes} bytes) kept`)
            return { instanceId: inst.id, name: String(inst.name), fromAppId, toAppId: newAppId as AppID, snapshotPath: snap.path, snapshotBytes: snap.sizeBytes, steps: done, previousSnapshotQuarantinedAt: snap.previousQuarantinedAt, volumes: snap.volumes, snapshotExcludes: snapExcludes, preUpdateBackup, tempBackup: tempBackupResult(tempBackup, fin.tempDeleted) }
        } catch (e) {
            // engine#456: after the point of no return there is no rollback; finishCommitted already
            // ended the operation (MIGRATIONS_PENDING / SETTLE_FAILED) and the App keeps running.
            if (committed) throw e
            const why = e instanceof UpdateAppError && e.code === 'NO_SPACE' ? null : String((e as Error).message)
            if (!why || !snap) {
                // Before a complete snapshot nothing was swapped: the old version is intact.
                // It may have been stopped for the snapshot: start the old version again.
                // engine#442: if that restart fails, the App must not stay stopped with no Error
                // and with a "nothing was changed" message.
                let restartWhy: string | null = null
                if (stopped) {
                    try {
                        if (shouldFailUpdateRestart(inst.id)) throw new Error(TEST_FAIL_UPDATE_RESTART_MESSAGE)
                        await d.start(storeHandle.doc().instanceDB[inst.id] as Instance, disk)
                        const after = storeHandle.doc().instanceDB[inst.id]
                        if (!after || (after.status !== 'Running' && after.status !== 'Starting')) {
                            restartWhy = after?.statusCondition || (after ? `instance status is ${after.status}` : 'instance record missing')
                        }
                    } catch (se) {
                        restartWhy = (se as Error).message
                        log(`updateApp: restarting ${inst.id} failed: ${restartWhy}`)
                    }
                    if (restartWhy) {
                        storeHandle.change(doc => {
                            const i = doc.instanceDB[inst.id]
                            // Leave an Error (or Undocked, hw180) that start already set.
                            if (!i || i.status === 'Error' || i.status === 'Undocked') return
                            i.status = 'Error' as any
                            i.statusCondition = `the update failed and the old version could not be restarted: ${restartWhy}`
                        })
                    }
                }
                const restartOpts = restartWhy ? { restartFailed: true as const } : undefined
                const restartClause = restartWhy
                    ? `the update failed and the old version could not be restarted: ${restartWhy}`
                    : 'nothing was changed'
                let err: UpdateAppError
                if (e instanceof UpdateAppError) {
                    if (!restartWhy) err = e
                    else {
                        const prefix = `${e.code}: `
                        const text = (e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message)
                            .replace(/; nothing was changed$/, '')
                        err = new UpdateAppError(e.code, `${text}; ${restartClause}`, restartOpts)
                    }
                } else {
                    err = new UpdateAppError('ROLLED_BACK', `${step} failed: ${why}; ${restartClause}`, restartOpts)
                }
                keepTempBackup(storeHandle, opId, err, tempBackup)
                updateOperation(storeHandle, opId, {
                    status: 'Failed',
                    error: err.message,
                    completedAt: d.now() as Timestamp,
                    ...(err.restartFailed ? { restartFailed: true as const } : {}),
                })
                throw err
            }
            let restoreExcludes = liveBackupExcludes
            try {
                const current = await readComposeBackup(path.join(instDir, 'compose.yaml'), 'current')
                restoreExcludes = mergeBackupExcludeLists(liveBackupExcludes, current.exclude)
            } catch (e) {
                log(`updateApp: ${inst.id}: ${(e as Error).message}; restore-snapshot will use the live backup.exclude list only`)
            }
            const err = await rollBack(storeHandle, d, inst, disk, instDir, step, why, snap, restoreExcludes, tempBackup, String(inst.instanceOf), opId)
            keepTempBackup(storeHandle, opId, err, tempBackup)
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

/** engine#469: the temporary backup of one updateApp operation. */
/**
 * engine#506 (helper v24): at Swap, move the files the new bundle dropped (swapDroppedPaths) out
 * of the instance folder. Below v24 it warns and leaves them (the update goes on: no App depends
 * on it, app-nextcloud 8860c5d ignores unlisted tarballs). With v24 a helper failure throws, so
 * the update rolls back before the point of no return.
 */
const quarantineSwapDropped = async (
    storeHandle: DocHandle<Store>, d: UpdateDeps, opId: string, disk: Disk, id: InstanceID, instDir: string, bundleDir: string,
): Promise<void> => {
    const dropped = await swapDroppedPaths(instDir, bundleDir)
    if (!dropped.oldSums) { log(`updateApp: ${id}: the instance has no SHA256SUMS, so the files the new bundle dropped cannot be told apart; none are moved (engine#506)`); return }
    for (const s of dropped.skipped) log(`updateApp: ${id}: the new bundle dropped ${s.path}, left in place (${s.why}) (engine#506)`)
    if (!dropped.paths.length) return
    const outdated = await d.swapQuarantineProblem()
    if (outdated) {
        log(`updateApp: ${id}: WARNING: ${dropped.paths.length} file(s) the new bundle dropped stay in the instance folder: ${outdated}`)
        setSwapOpArgs(storeHandle, opId, dropped.paths.length, 'skipped: HELPER_OUTDATED')
        return
    }
    let r: SwapQuarantineResult
    try { r = await d.swapQuarantine(disk, id, dropped.paths) } catch (e) {
        throw new Error(`the ${dropped.paths.length} file(s) the new bundle dropped could not be moved to quarantine (engine#506): ${(e as Error).message}`)
    }
    log(`updateApp: ${id}: moved ${r.moved.length} file(s) the new bundle dropped to ${r.quarantine ?? '(nothing to move)'}${r.absent.length ? `; ${r.absent.length} already absent` : ''} (engine#506)`)
    setSwapOpArgs(storeHandle, opId, r.moved.length, r.quarantine ?? 'none')
}
/** engine#506: what Swap did with the dropped files, on the operation (args.swapDropped / args.swapQuarantine). */
const setSwapOpArgs = (storeHandle: DocHandle<Store>, opId: string, count: number, where: string): void => {
    storeHandle.change(doc => {
        const op = doc.operationDB?.[opId]
        if (!op) return
        op.args.swapDropped = String(count)
        op.args.swapQuarantine = where
    })
}

export interface TempBackupRef { stamp: string, path: string, sizeBytes: number }
export type TempBackupState = 'created' | 'deleted' | 'delete-failed' | 'kept'

const gib = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GiB`

/**
 * engine#469: TEMP_BACKUP_NO_SPACE when the system disk cannot hold the temporary backup (net
 * size + the snapshot margin) and, when the snapshot lands on the same filesystem, the snapshot too.
 */
export const tempBackupSpace = (tb: TempBackupEstimate, snapshotNeedBytes: number): UpdateAppError | null => {
    const own = tb.netBytes + snapshotMarginBytes(tb.netBytes)
    const total = own + (tb.sameFilesystem ? snapshotNeedBytes : 0)
    if (tb.freeBytes >= total) return null
    const snapTxt = tb.sameFilesystem && snapshotNeedBytes ? ` plus ${snapshotNeedBytes} bytes for the snapshot on the same disk` : ''
    return new UpdateAppError('TEMP_BACKUP_NO_SPACE',
        `the temporary pre-update backup on the system disk needs ${own} bytes (${gib(own)}: ${tb.netBytes} bytes of data + margin)${snapTxt}, ` +
        `free ${tb.freeBytes} bytes (${gib(tb.freeBytes)}). Free space on the system disk or dock a Backup Disk linked to this instance; nothing was stopped or changed`)
}

export const setTempBackupOpArgs = (storeHandle: DocHandle<Store>, opId: string, tb: TempBackupRef, state: TempBackupState): void => {
    storeHandle.change(doc => {
        const op = doc.operationDB?.[opId]
        if (!op) return
        op.args.tempBackup = tb.path
        op.args.tempBackupStamp = tb.stamp
        op.args.tempBackupState = state
    })
}

/** The temporary backup recorded on an updateApp operation (boot recovery), or null. */
export const tempBackupFromOp = (op: { args: Record<string, string> }): TempBackupRef | null => {
    const path = op.args?.tempBackup, stamp = op.args?.tempBackupStamp
    if (!path || !stamp || op.args?.tempBackupState === 'deleted') return null
    return { path: String(path), stamp: String(stamp), sizeBytes: 0 }
}

/** engine#469: a failed update keeps its temporary backup; the error says where it is. */
const keepTempBackup = (storeHandle: DocHandle<Store>, opId: string, err: Error, tb: TempBackupRef | null): void => {
    if (!tb) return
    setTempBackupOpArgs(storeHandle, opId, tb, 'kept')
    err.message = `${err.message}; the temporary pre-update backup is kept at ${tb.path}`
    log(`updateApp: the temporary pre-update backup ${tb.path} is kept (the update failed)`)
}

const tempBackupResult = (tb: TempBackupRef | null, deleted: boolean): UpdateResult['tempBackup'] =>
    tb ? { path: tb.path, sizeBytes: tb.sizeBytes, deleted } : null

/**
 * Restore the snapshot and start the old version. Returns the error to report.
 * engine#456 (Q6, mirrors #468): when the data was restored but the old version does not start,
 * the result is ROLLBACK_START_FAILED (instance Stopped, statusCondition "ROLLBACK START FAILED: …"),
 * not "the rollback failed". After a successful restore the update-in-flight marker of `opId` is
 * cleared (restore-snapshot normally moved it aside already).
 */
const rollBack = async (
    storeHandle: DocHandle<Store>, d: UpdateDeps, inst: Instance, disk: Disk, instDir: string,
    failedAt: UpdateStep, why: string, snap: { path: string, sizeBytes: number }, excludes: string[],
    tempBackup: TempBackupRef | null = null,
    /** the version the rollback puts back (the op's fromAppId); at boot inst.instanceOf may already be the new one */
    restoredAppId: string = String(inst.instanceOf),
    /** engine#456: the update operation (owner of the update-in-flight marker) */
    opId: string | null = null,
): Promise<UpdateAppError> => {
    const plan = rollbackPlan(failedAt)
    log(`updateApp: ${failedAt} failed for ${inst.id} (${why}); rolling back from ${snap.path}`)
    writePreUpdateGate(storeHandle, inst.id, null)
    const wasUp = inst.status === 'Running' || inst.status === 'Starting'
    let dataRestored = !plan.restoreData
    let restoredFrom = `from ${snap.path}`
    let snapWhy: string | null = null
    try {
        await d.composeDown(instDir, inst.id)
        await waitContainersGone(d, inst.id)
        if (plan.restoreData) {
            // In place (idea#448): excluded paths keep their inodes; replaced files go to `aside`.
            const aside = await d.restoreSnapshot(disk, inst.id, excludes)
            dataRestored = true
            log(`updateApp: ${inst.id} restored in place from ${snap.path}; the replaced files are kept at ${aside}`)
        }
    } catch (e) {
        snapWhy = (e as Error).message
    }
    let tempWhy: string | null = null
    if (snapWhy !== null && !dataRestored && tempBackup) {
        // engine#469: the snapshot could not be put back: restore from the temporary backup instead.
        try {
            log(`updateApp: ${inst.id}: the snapshot rollback failed (${snapWhy}); restoring from the temporary pre-update backup ${tempBackup.path}`)
            await d.composeDown(instDir, inst.id).catch(ce => log(`updateApp: ${inst.id}: compose down before the temporary-backup restore: ${(ce as Error).message}`))
            await waitContainersGone(d, inst.id)
            const aside = await d.tempBackupRestore(disk, inst.id, tempBackup.stamp)
            dataRestored = true
            restoredFrom = `from the temporary pre-update backup ${tempBackup.path}${aside && aside !== 'none' ? ` (the replaced folder is at ${aside})` : ''}`
        } catch (te) {
            tempWhy = (te as Error).message
        }
    }
    const markStopped = (err: UpdateAppError) => storeHandle.change(doc => {
        const i = doc.instanceDB[inst.id]
        if (!i) return
        i.status = 'Stopped' as any
        i.statusCondition = err.message
    })
    if (!dataRestored) {
        const tempClause = tempWhy ? `; restoring from the temporary pre-update backup ${tempBackup!.path} failed too: ${tempWhy}` : ''
        const err = new UpdateAppError('ROLLBACK_FAILED', `${failedAt} failed: ${why}; then the rollback failed: ${snapWhy}. The snapshot is kept at ${snap.path}${tempClause}`)
        markStopped(err)
        return err
    }
    if (opId) await clearUpdateInFlight(instDir, opId).catch(me => log(`updateApp: ${inst.id}: clearing the update-in-flight marker after the restore: ${(me as Error).message}`))
    const snapClause = snapWhy !== null ? `. The snapshot rollback failed (${snapWhy}), so` : '.'
    try {
        await d.reread(disk, inst.id)
        if (plan.startOld && wasUp) {
            await d.start(storeHandle.doc().instanceDB[inst.id] as Instance, disk, opId ? { updateOpId: opId } : undefined)
            const after = storeHandle.doc().instanceDB[inst.id]
            if (!after || after.status === 'Error') throw new Error(after?.statusCondition ?? 'record missing')
        }
    } catch (e) {
        const cond = String((e as Error).message).replace(/^the old version did not start: /, '')
        const err = new UpdateAppError('ROLLBACK_START_FAILED', `${failedAt} failed: ${why}${snapClause} ${restoredAppId} and its data were restored ${restoredFrom}; the old version did not start: ${cond}`)
        markStopped(err)
        log(`updateApp: ${inst.id}: ${err.message}`)
        return err
    }
    return new UpdateAppError('ROLLED_BACK', `${failedAt} failed: ${why}${snapClause} ${restoredAppId} and its data were restored ${restoredFrom}`)
}

/** engine#456: a step run counts as passed only on exit 0 within its timeout. */
const stepOk = (r: StepRun): boolean => r.exitCode === 0 && !r.timedOut && !r.spawnError

/** engine#456: the step's ERROR: / not yet: line goes to the op (args.phaseNote) and idea/updateProgress. */
const setPhaseNote = (storeHandle: DocHandle<Store>, d: Pick<UpdateDeps, 'broadcast'>, opId: string, engineId: string, instanceId: string, step: UpdateStep, note: string | null): void => {
    if (!note) return
    storeHandle.change(doc => { const o = doc.operationDB?.[opId]; if (o) o.args.phaseNote = note })
    d.broadcast({ type: UPDATE_PROGRESS_TYPE, engineId, instanceId, step, bytesDone: 0, bytesTotal: 0, phaseNote: note })
}

interface CommitContext {
    inst: Instance
    opId: string
    engineId: string
    contract: UpdateContract
    stepCtx: () => Promise<StepContext>
    tempBackup: TempBackupRef | null
    /** other operations that recorded the same temporary backup (the committed op, on a resume) */
    tempBackupOps?: string[]
    toAppId: string
    resumeHint: string
    setStep: (s: UpdateStep) => void
    progress: (s: UpdateStep, bytesDone?: number, bytesTotal?: number) => void
    done: UpdateStep[]
}

/**
 * engine#456 §2: work and settle after the point of no return. Never rolls back. A failed or
 * timed-out work, or a settle that still says "not yet" at its timeout, ends the operation Failed
 * with MIGRATIONS_PENDING; any other settle exit ends it SETTLE_FAILED. In both cases the App stays
 * Running with Instance.updatePending and the temporary backup is kept. Full success (settle exited
 * 0, or nothing left to run) clears updatePending and deletes the temporary backup (Koen's exception).
 */
const finishCommitted = async (storeHandle: DocHandle<Store>, d: UpdateDeps, c: CommitContext): Promise<{ tempDeleted: boolean }> => {
    const id = String(c.inst.id)
    const fail = (code: 'MIGRATIONS_PENDING' | 'SETTLE_FAILED', text: string): UpdateAppError => {
        const err = new UpdateAppError(code, `${text}; ${c.toAppId} keeps running; send ${c.resumeHint} to finish the update`)
        keepTempBackup(storeHandle, c.opId, err, c.tempBackup)
        updateOperation(storeHandle, c.opId, { status: 'Failed', error: err.message, completedAt: d.now() as Timestamp })
        log(`updateApp: ${id}: ${err.message}`)
        return err
    }
    let current: UpdateStep = 'Work'
    try {
        const work = c.contract.work
        if (work) {
            current = 'Work'; c.setStep('Work'); c.progress('Work')
            const r = await d.runStep('work', work, await c.stepCtx())
            setPhaseNote(storeHandle, d, c.opId, c.engineId, id, 'Work', r.note)
            if (!stepOk(r)) throw fail('MIGRATIONS_PENDING', stepFailureText('work', work, r))
            c.done.push('Work')
        }
        const settle = c.contract.settle
        if (settle) {
            current = 'Settle'; c.setStep('Settle'); c.progress('Settle', 0, settle.timeout * 1000)
            const t0 = d.now(), deadline = t0 + settle.timeout * 1000
            let runs = 0, lastNote: string | null = null
            const ctx = await c.stepCtx()
            for (;;) {
                const leftS = Math.ceil((deadline - d.now()) / 1000)
                if (leftS <= 0) throw fail('MIGRATIONS_PENDING', `settle ${settle.command} did not report settled within ${settle.timeout} s (${runs} run${runs === 1 ? '' : 's'})${lastNote ? `: ${lastNote}` : ''}`)
                const budget = Math.min(settle.timeout, leftS)
                const r = await d.runStep('settle', settle, ctx, { timeoutS: budget })
                runs++
                setPhaseNote(storeHandle, d, c.opId, c.engineId, id, 'Settle', r.note)
                if (stepOk(r)) break
                if (r.timedOut) throw fail('MIGRATIONS_PENDING', stepFailureText('settle', settle, r, budget))
                if (r.exitCode !== 3) throw fail('SETTLE_FAILED', stepFailureText('settle', settle, r))
                lastNote = r.note
                c.progress('Settle', Math.min(d.now() - t0, settle.timeout * 1000), settle.timeout * 1000)
                if (d.now() + settle.interval! * 1000 >= deadline) {
                    throw fail('MIGRATIONS_PENDING', `settle ${settle.command} still reported not yet after ${settle.timeout} s (${runs} run${runs === 1 ? '' : 's'})${lastNote ? `: ${lastNote}` : ''}`)
                }
                await d.sleep(settle.interval! * 1000)
            }
            c.done.push('Settle')
        }
    } catch (e) {
        if (e instanceof UpdateAppError && (e.code === 'MIGRATIONS_PENDING' || e.code === 'SETTLE_FAILED')) throw e
        throw fail('MIGRATIONS_PENDING', `${current} could not run: ${(e as Error).message}`)
    }
    // ── full success
    storeHandle.change(doc => {
        const i = doc.instanceDB[c.inst.id] as any
        if (i && i.updatePending !== undefined) delete i.updatePending
    })
    // engine#469 / engine#456 §4: only now is the temporary backup really deleted (Koen's exception).
    let tempDeleted = false
    if (c.tempBackup) {
        const tbr: TempBackupRef = c.tempBackup
        const ops = [c.opId, ...(c.tempBackupOps ?? [])]
        try {
            await d.tempBackupDelete(c.inst.id, tbr.stamp)
            tempDeleted = true
            for (const o of ops) setTempBackupOpArgs(storeHandle, o, tbr, 'deleted')
            log(`updateApp: ${id}: temporary pre-update backup ${tbr.path} deleted after the update finished`)
        } catch (e) {
            for (const o of ops) setTempBackupOpArgs(storeHandle, o, tbr, 'delete-failed')
            // Like backupApp's args.postStartWarning (engine#468): the update stays Done, the operation
            // and the trace (console.warn lands in it) say the space was not given back.
            const warning = tempBackupWarningMessage(tbr.path, (e as Error).message)
            storeHandle.change(doc => { const o = doc.operationDB?.[c.opId]; if (o) o.args.tempBackupWarning = warning })
            console.warn(`updateApp: ${id}: ${warning}`)
        }
        await d.refreshTempBackups().catch(re => log(`updateApp: ${id}: tempBackups refresh after delete: ${(re as Error).message}`))
    }
    return { tempDeleted }
}

/** engine#456: the newest updateApp operation of the instance that passed its point of no return. */
export const committedUpdateOp = (store: Store, instanceId: string) =>
    Object.values(store.operationDB ?? {})
        .filter(o => o && o.kind === 'updateApp' && String(o.args?.instanceId) === instanceId && o.args?.committed === 'true')
        .sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0))[0] ?? null

/**
 * engine#456 Q1 / §10: Resume. A plain `updateApp <id> <current version>` while updatePending is
 * set runs only work and settle again (the steps of the compose now in the folder), in a new
 * updateApp operation (args.resume / args.resumeOf). Nothing is stopped, swapped or rolled back.
 */
const resumeUpdate = async (storeHandle: DocHandle<Store>, d: UpdateDeps, inst: Instance, disk: Disk, engineId: string): Promise<UpdateResult> => {
    const key = instanceKey(inst.id)
    if (!resourceLock.acquire(key, 'updateApp')) throw new UpdateAppError('BUSY', 'another operation is running on this instance')
    beginUsageSkip('update')
    let opened = false
    try {
        const root = await d.mountRoot(disk)
        const instDir = joinMountRoot(root, 'instances', String(inst.id))
        const composePath = path.join(instDir, 'compose.yaml')
        const xapp = await readXApp(composePath)
        const parsed = parseUpdateContract(xapp.update, await readComposeServices(composePath))
        if (!parsed.ok) throw parsed.error
        if (inst.status !== 'Running' && inst.status !== 'Starting') {
            throw new UpdateAppError('UPDATE_PENDING', `${inst.instanceOf} is ${inst.status}; start it, then send ${resumeCommand(inst)} again to finish the update`)
        }
        const prev = committedUpdateOp(storeHandle.doc(), String(inst.id))
        const toAppId = String(inst.instanceOf)
        const fromAppId = prev?.args?.fromAppId ? String(prev.args.fromAppId) : String(inst.previousAppId ?? toAppId)
        const tb = prev ? tempBackupFromOp(prev) : null
        const opId = createOperation(storeHandle, 'updateApp', {
            instanceId: String(inst.id), diskId: String(disk.id), fromAppId, toAppId,
            resume: 'true', resumeOf: prev ? String(prev.id) : '', committed: 'true',
            fromVersion: prev?.args?.fromVersion || appIdentity(fromAppId, undefined).version, toVersion: appIdentity(toAppId, xapp).version,
        }, 'console-command', { type: 'instance', id: inst.id })
        opened = true
        updateOperation(storeHandle, opId, { status: 'Running' })
        if (tb) setTempBackupOpArgs(storeHandle, opId, tb, 'kept')
        const setStep = (step: UpdateStep) => updateOperation(storeHandle, opId, { currentStep: UPDATE_STEPS.indexOf(step), totalSteps: UPDATE_STEPS.length, stepLabel: step })
        const progress = (step: UpdateStep, bytesDone = 0, bytesTotal = 0) =>
            d.broadcast({ type: UPDATE_PROGRESS_TYPE, engineId, instanceId: String(inst.id), step, bytesDone, bytesTotal })
        const fromVersion = prev?.args?.fromVersion || appIdentity(fromAppId, undefined).version
        const toVersion = appIdentity(toAppId, xapp).version
        const done: UpdateStep[] = []
        log(`updateApp: ${inst.id}: resuming the committed update ${fromAppId} -> ${toAppId}${prev ? ` (operation ${prev.id})` : ''}: work and settle only`)
        const fin = await finishCommitted(storeHandle, d, {
            inst, opId, engineId, contract: parsed.contract, tempBackup: tb, tempBackupOps: prev ? [String(prev.id)] : [],
            toAppId, resumeHint: resumeCommand(inst), setStep, progress, done,
            stepCtx: async () => ({
                instanceDir: instDir, project: composeProjectFor(String(inst.id)), fromVersion, toVersion,
                extraComposeFiles: await d.stepComposeFiles((storeHandle.doc().instanceDB[inst.id] as Instance) ?? inst, disk, false),
            }),
        })
        updateOperation(storeHandle, opId, { status: 'Done', completedAt: d.now() as Timestamp })
        log(`updateApp: ${inst.id}: the update to ${toAppId} has finished (resumed)`)
        return {
            instanceId: inst.id, name: String(inst.name), fromAppId: fromAppId as AppID, toAppId: toAppId as AppID,
            snapshotPath: joinMountRoot(root, PRE_UPDATE_DIR, String(inst.id)), snapshotBytes: 0, steps: done,
            previousSnapshotQuarantinedAt: null, volumes: [], snapshotExcludes: [], preUpdateBackup: null,
            tempBackup: tempBackupResult(tb, fin.tempDeleted), resumed: true,
        }
    } finally {
        resourceLock.release(key)
        endUsageSkip('update')
        if (opened) await refreshOfferAfterUpdate(storeHandle, String(engineId), d)
    }
}

/** engine#469: the warning a Done update carries when the temporary backup could not be removed. */
export const tempBackupWarningMessage = (tbPath: string, why: string): string =>
    `temporary backup ${tbPath} could not be removed: ${why}; free space by deleting it`

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
        // Operations written before #456 have six indices; interpret them with the old list.
        const legacySteps: UpdateStep[] = ['Fetch', 'Check', 'Snapshot', 'Swap', 'Start', 'Health']
        const step = (op.totalSteps === 6 || op.totalSteps == null ? legacySteps : UPDATE_STEPS)[op.currentStep ?? 0] ?? 'Snapshot'
        const root0 = await d.mountRoot(disk)
        const instDir0 = joinMountRoot(root0, 'instances', String(inst.id))
        if (op.args?.committed === 'true') {
            // engine#456 §5: past the point of no return (verify passed) there is no rollback. The
            // op ends MIGRATIONS_PENDING, the App starts normally on the new version, and Resume is
            // an explicit updateApp (the queued command is dropped, never replayed).
            const tb = tempBackupFromOp(op)
            if (tb) setTempBackupOpArgs(storeHandle, op.id, tb, 'kept')
            await clearUpdateInFlight(instDir0, op.id).catch(me => log(`updateApp: ${inst.id}: ${(me as Error).message}`))
            storeHandle.change(doc => { const i = doc.instanceDB[inst.id]; if (i) i.updatePending = true })
            const err = new UpdateAppError('MIGRATIONS_PENDING', `the Engine restarted during ${step}, after verify passed (interrupted); ${inst.instanceOf} starts normally; send ${resumeCommand(inst)} to finish the update`)
            keepTempBackup(storeHandle, op.id, err, tb)
            updateOperation(storeHandle, op.id, { status: 'Failed', error: err.message, completedAt: d.now() as Timestamp })
            dropInterruptedCommand(storeHandle, op)
            out.push(`${inst.id}: ${err.message}`)
            continue
        }
        const snaps = (await d.listSnapshots(disk).catch(() => null))?.snapshots ?? []
        const complete = snaps.some(s => String(s.instanceId) === String(inst.id) && s.complete)
        const swapped = UPDATE_STEPS.indexOf(step) >= UPDATE_STEPS.indexOf('Swap')
        if (!complete || !swapped) {
            // engine#469: never deleted on boot; a temporary backup of this op stays for a manual restore.
            const tb = tempBackupFromOp(op)
            if (tb) setTempBackupOpArgs(storeHandle, op.id, tb, 'kept')
            // engine#456: nothing was swapped, so a marker of this op (written at Swap) can go
            if (!swapped) await clearUpdateInFlight(instDir0, op.id).catch(me => log(`updateApp: ${inst.id}: ${(me as Error).message}`))
            out.push(`${inst.id}: interrupted at ${step}; old version untouched${tb ? `; the temporary pre-update backup is kept at ${tb.path}` : ''}`)
            continue
        }
        const root = await d.mountRoot(disk)
        const instDir = joinMountRoot(root, 'instances', String(inst.id))
        // idea#448: the snapshot's EXCLUDE already holds the live ∪ new list; the compose now in
        // the folder (old or swapped) is added so nothing it excludes is written back.
        let excludes: string[] = []
        try { excludes = (await readComposeBackup(path.join(instDir, 'compose.yaml'), 'current')).exclude } catch (e) {
            log(`updateApp: ${inst.id}: ${(e as Error).message}; restoring with the snapshot's own EXCLUDE list only`)
        }
        const err = await rollBack(storeHandle, d, inst, disk, instDir, step, 'the Engine restarted during the update', { path: joinMountRoot(root, PRE_UPDATE_DIR, String(inst.id)), sizeBytes: 0 }, excludes, tempBackupFromOp(op),
            op.args.fromAppId ? String(op.args.fromAppId) : String(inst.instanceOf), op.id)
        keepTempBackup(storeHandle, op.id, err, tempBackupFromOp(op))
        updateOperation(storeHandle, op.id, { status: 'Failed', error: `INTERRUPTED: ${err.message}`, completedAt: d.now() as Timestamp })
        // Pi proof step 8: the updateApp command is still queued (a command leaves the queue only
        // when it finishes), so the startup replay would run the same update again on every boot.
        dropInterruptedCommand(storeHandle, op)
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
    const b: AppBundleInfo = { appId: appId as AppID, version: appIdentity(appId, xapp).version, sumsListed: sumsLookUsable(sums), sizeBytes }
    if (Array.isArray(xapp.updatesFrom)) b.updatesFrom = xapp.updatesFrom.map(Number).filter(n => Number.isFinite(n))
    const t = Number(xapp.healthTimeout)
    if (xapp.healthTimeout != null && Number.isFinite(t) && t > 0) b.healthTimeout = t
    if (typeof xapp.migrationNote === 'string' && xapp.migrationNote.trim()) b.migrationNote = xapp.migrationNote.trim()
    const stages = declaredUpdateStages(xapp.update)
    if (stages.length) b.updateStages = [...stages]
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
    if (!cur || stableStringify(cur.appBundles ?? null) === stableStringify(list)) return false
    storeHandle.change(doc => {
        const x = doc.diskDB[disk.id as DiskID]
        if (x) x.appBundles = list.map(b => ({
            ...b,
            ...(b.updatesFrom ? { updatesFrom: [...b.updatesFrom] } : {}),
            ...(b.updateStages ? { updateStages: [...b.updateStages] } : {}),
        }))
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
            xapp: {
                // engine#480: the published version (from the bundle's x-app) names a remote bundle's App too
                ...remoteBundleIdentity(String(b.appId), b.version),
                updatesFrom: b.updatesFrom ? [...b.updatesFrom] : undefined,
                healthTimeout: b.healthTimeout,
                migrationNote: b.migrationNote,
                update: b.updateStages?.length ? Object.fromEntries(b.updateStages.map(k => [k, true])) : undefined,
            },
        }))
    })

/** engine#480: x-app name/version of a remote bundle from its published appId and version, when the id ends in `-<version>`. */
export const remoteBundleIdentity = (appId: string, version: unknown): { name?: string, version?: string } => {
    const v = version == null ? '' : String(version)
    return v && appId.endsWith(`-${v}`) && appId.length > v.length + 1 ? { name: appId.slice(0, -(v.length + 1)), version: v } : {}
}

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
        // engine#480: the instance's live compose x-app names its App (kiwix@release-1.0), not a split of instanceOf
        const ownDisk = docked.find(x => String(x.id) === String(inst.storedOn))!
        const liveXApp = await d.mountRoot(ownDisk).then(r => d.readXApp(joinMountRoot(r, 'instances', String(inst.id)))).catch(() => ({}))
        if (inst.updatePending) {
            // engine#456 §10: while a committed update has not settled, the only offer is Resume (a plain
            // updateApp to the version it already runs), never the next major
            const v = appIdentity(String(inst.instanceOf), liveXApp).version
            updates[String(inst.id)] = { appId: inst.instanceOf as AppID, fromVersion: v, toVersion: v, major: false }
            continue
        }
        let best: (typeof bundles)[number] | null = null
        for (const b of bundles) {
            if (!offerable({ currentAppId: String(inst.instanceOf), newAppId: b.appId, sumsValid: true, updatesFrom: b.xapp.updatesFrom, xAppUpdate: b.xapp.update, currentXApp: liveXApp, newXApp: b.xapp })) continue
            const c = best ? compareVersions(appIdentity(b.appId, b.xapp).version, appIdentity(best.appId, best.xapp).version) : 1
            if (c !== null && (c > 0 || (c === 0 && String(b.disk.id) === String(inst.storedOn)))) best = b
        }
        if (!best) { updates[String(inst.id)] = null; continue }
        const from = appIdentity(String(inst.instanceOf), liveXApp).version, to = appIdentity(best.appId, best.xapp).version
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
        if (bytes !== null) u.estimatedMinutes = estimateUpdateMinutes(bytes, healthTimeoutSeconds(appIdentity(best.appId, best.xapp).name, best.xapp.healthTimeout))
            + (remote ? Math.ceil((best.sizeBytes ?? 0) / TRANSFER_BYTES_PER_MIN) : 0)
        if (typeof best.xapp.migrationNote === 'string' && best.xapp.migrationNote.trim()) u.migrationNote = best.xapp.migrationNote.trim()
        updates[String(inst.id)] = u
    }
    storeHandle.change(doc => {
        for (const [id, u] of Object.entries(updates)) {
            const i = doc.instanceDB[id as InstanceID]
            if (!i) continue
            const cur = stableStringify(i.updateAvailable ?? null), next = stableStringify(u ?? null)
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
