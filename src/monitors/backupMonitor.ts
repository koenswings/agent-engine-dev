/**
 * backupMonitor.ts — Backup Disk processing, backup/restore operations
 *
 * Design: design/backup-disk.md
 *
 * Key design points:
 *  - BorgBackup for deduplicating, atomic, resumable archives
 *  - activeBackups Set prevents double-backup on reboot race
 *  - Lock file (.backup-in-progress) marks an interrupted backup; at dock/boot and
 *    before an automatic backup, a stale lock is cleared (engine#429) and the next
 *    backup resumes. A lock that belongs to a running backup (resourceLock,
 *    activeBackups, a Pending/Running backup or restore Operation, or a live borg
 *    in /proc) is never cleared. clearBackupLock stays as a manual tool.
 *  - skipBorg() (settings.skipBorg / IDEA_SKIP_BORG, default testMode): skips borg commands but
 *    exercises all other logic (store updates, YAML, lock files)
 *  - Borg runs as root through the app-data helper (idea#168):
 *    `sudo -n /usr/local/sbin/idea-app-data borg-init|borg-info|borg-create|borg-extract|borg-list|borg-delete|borg-compact`,
 *    so it can read instance data written by root/999/www-data and restores owners
 *    (--numeric-ids). Repositories become root-owned; the repo folder and the
 *    .backup-in-progress lock file stay the Engine's (pi).
 */

import { $, YAML, chalk, fs } from 'zx'
import { log, print } from '../utils/utils.js'
import { disksRoot, skipBorg } from '../data/Config.js'
import { Disk, BackupConfig, isBackupDisk, processDisk, diskMountRoot, appDataRoot, joinMountRoot, backupOrphanLinks, syncBackupOrphanLinks } from '../data/Disk.js'
import { AppDataRunner, runAppData, borgInitArgs, borgInfoArgs, borgCreateArgs, borgExtractArgs, borgProblem, helperAtLeast, ARCHIVE_MODE_HELPER_MIN } from '../utils/appDataHelper.js'
import { parseBackupExcludeList, parseBackupHookExcludeList, mergeBackupExcludeLists, BACKUP_EXCLUDE_HELPER_MIN } from '../utils/backupExclude.js'
import { backupCleanupRunner, backupDiskFullError, cleanupIsEnabled } from '../utils/backupCleanup.js'
import { backupArchiveName, type ArchiveMode } from '../utils/backupArchiveName.js'
import { parseBackupSpec, assertHookServicesExist, backupHookRunner, defaultBackupSpec, type BackupHookDecl } from '../utils/backupMethod.js'
import { indexBackupDiskApps } from '../data/InstallApp.js'
import { ensureAppFilesOnTarget } from '../data/RestoreAppFiles.js'
import { localEngineId } from '../data/Engine.js'
import { defaultReadBootId } from '../usage/sampler.js'
import { assertPreQuarantineHelper, quarantinePreRestore, sourceOnOtherEngine, instanceStartingHere, quarantineUnclaimedTarget } from '../data/RestorePreQuarantine.js'
import { createOperation, updateOperation } from '../data/Operations.js'
import { readBackupYamlState, setLinkLastBackup, editBackupYaml } from '../data/BackupYamlDoc.js'
import { applyBackupResult, recordBackupResult, successResultCode, failureResultCode, isManualBackupCause } from '../data/BackupResults.js'
import { DEFAULT_BACKUP_TIME } from '../utils/backupSchedule.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { requestDataBytes } from '../data/DataBytes.js'
import { stopInstance as stopInstanceImpl, startInstance as startInstanceImpl, BACKUP_STEPS, type Instance, type Status, isPortNotReadyCondition, portNotReadyTimeoutSeconds } from '../data/Instance.js'

/** Tests replace stop/start. Production uses Instance.ts. */
export const backupLifecycle = {
    stopInstance: stopInstanceImpl,
    startInstance: startInstanceImpl,
}
import { BackupMode, BackupMethodUsed, DiskID, DiskName, InstanceID, Timestamp, OperationCause, Operation } from '../data/CommonTypes.js'
import { Store, getInstance, getDisks, findDiskByName, getLocalEngine } from '../data/Store.js'
import { isDockedOnEngine, localEngineName, noLocalBackupDiskMessage } from '../data/LocalBackupDisk.js'
import { DocHandle } from '@automerge/automerge-repo'
import { getCommandLogHandle, addTrace, closeTrace, stashTraceCloseMessage } from '../data/CommandLogStore.js'
import { attachTraceResult } from '../data/SummariseDisk.js'
import { runWithTrace, flushTrace, getActiveTrace } from '../utils/CommandLogger.js'
import { beginUsageSkip, endUsageSkip } from '../usage/opFlags.js'

$.verbose = false

// ── In-memory mutex ──────────────────────────────────────────────────────────
// Prevents double-backup when both App Disk and Backup Disk dock at the same
// time after a reboot (see design/backup-disk.md — Reboot Race Condition).
const activeBackups = new Set<InstanceID>()

// ── BACKUP.yaml shape ────────────────────────────────────────────────────────
interface BackupYaml {
    mode: BackupMode
    links: Array<{ instanceId: string; lastBackup: number }>
    schedule?: { daily: string }
}

const BACKUP_YAML = 'BACKUP.yaml'
export const BACKUP_IN_PROGRESS = '.backup-in-progress'
const LOCK_FILE = BACKUP_IN_PROGRESS

/** True while backupInstance holds the in-memory mutex for this instance. */
export const isBackupActive = (instanceId: string): boolean => activeBackups.has(instanceId as InstanceID)

/**
 * Look through /proc for a live borg (or idea-app-data borg-*) process whose
 * cmdline names this repository. A pm2 restart can leave borg running as root
 * through sudo, so this check is what stops us clearing a live lock (engine#429).
 * Returns the pid, or null if none is found. Throws if /proc itself is unreadable
 * (treat as unknown: do not clear).
 */
export const findBorgPidUsingRepo = async (repoPath: string): Promise<number | null> => {
    const raw = String(repoPath ?? '').replace(/\/+$/, '')
    if (!raw) return null
    const needles = Array.from(new Set([raw, raw.replace(/^\/+/, '')].filter(Boolean)))
    let ents: string[]
    try {
        ents = await fs.readdir('/proc')
    } catch (e: any) {
        throw new Error(`/proc is unreadable: ${e?.message ?? e}`)
    }
    for (const pid of ents) {
        if (!/^\d+$/.test(pid)) continue
        let text = ''
        try {
            const buf = await fs.readFile(`/proc/${pid}/cmdline`)
            text = (Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)).replace(/\0/g, ' ')
        } catch {
            continue
        }
        if (!/\bborg\b|borg-/.test(text)) continue
        if (needles.some(n => text.includes(n))) return Number(pid)
    }
    return null
}

/** Injectable hooks for stale-lock auto-clear (engine#429). Tests replace these. */
export const staleBackupLock = {
    borgPidUsingRepo: findBorgPidUsingRepo,
    readBootId: defaultReadBootId,
}

/** Body written to a new .backup-in-progress file (engine#429: also engineId and bootId). */
export const backupLockContents = (instanceId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    instanceId,
    startedAt: Date.now(),
    engineId: localEngineId,
    bootId: staleBackupLock.readBootId(),
    ...extra,
})

const hasActiveBackupOrRestoreOp = (store: Store, instanceId: string): boolean =>
    Object.values(store.operationDB ?? {}).some(op =>
        !!op &&
        (op.kind === 'backupApp' || op.kind === 'restoreApp') &&
        (op.status === 'Pending' || op.status === 'Running') &&
        String(op.engineId) === String(localEngineId) &&
        String(op.args?.instanceId) === String(instanceId))

/**
 * engine#429: if the lock is stale, quarantine it and drop the store entry.
 * All of these must hold: the Backup Disk is docked here; no in-memory
 * resourceLock or activeBackups entry for the instance or disk; no Pending or
 * Running backup or restore Operation for the instance on this Engine; and no
 * live borg process uses this repository. Returns true when the lock file was
 * cleared. A live backup is never cleared.
 */
export const clearAbandonedBackupLock = async (
    storeHandle: DocHandle<Store>,
    backupDisk: Disk,
    instanceId: InstanceID,
): Promise<boolean> => {
    const store = storeHandle.doc()
    const disk = (store?.diskDB?.[backupDisk.id] ?? backupDisk) as Disk
    if (!isDockedOnEngine(disk, String(localEngineId)) || !disk.device) return false
    const repoPath = backupDir(disk.device, instanceId)
    const lockPath = `${repoPath}/${LOCK_FILE}`
    if (!await fs.pathExists(lockPath)) return false
    if (isBackupActive(instanceId)) return false
    if (resourceLock.isLocked(instanceKey(instanceId)) || resourceLock.isLocked(diskKey(disk.id))) return false
    if (hasActiveBackupOrRestoreOp(store, instanceId)) return false
    let livePid: number | null = null
    try {
        livePid = await staleBackupLock.borgPidUsingRepo(repoPath)
    } catch (e: any) {
        log(`Backup lock for ${instanceId} on ${disk.id} not cleared; could not check for a live borg: ${e?.message ?? e}`)
        return false
    }
    if (livePid != null) {
        log(`Backup lock for ${instanceId} on ${disk.id} still running (pid ${livePid})`)
        return false
    }
    if (!resourceLock.acquireAll([diskKey(disk.id)], 'clearStaleBackupLock')) return false
    try {
        const again = storeHandle.doc()
        const diskNow = (again?.diskDB?.[disk.id] ?? disk) as Disk
        if (!isDockedOnEngine(diskNow, String(localEngineId)) || !diskNow.device) return false
        if (!await fs.pathExists(lockPath)) return false
        if (isBackupActive(instanceId)) return false
        if (resourceLock.isLocked(instanceKey(instanceId))) return false
        if (hasActiveBackupOrRestoreOp(again, instanceId)) return false
        try {
            livePid = await staleBackupLock.borgPidUsingRepo(repoPath)
        } catch (e: any) {
            log(`Backup lock for ${instanceId} on ${disk.id} not cleared; could not check for a live borg: ${e?.message ?? e}`)
            return false
        }
        if (livePid != null) {
            log(`Backup lock for ${instanceId} on ${disk.id} still running (pid ${livePid})`)
            return false
        }
        const startedAt = await readLockStartedAt(lockPath)
        const ts = Date.now()
        const dest = `${repoPath}/${LOCK_FILE}.stale-${ts}`
        await fs.rename(lockPath, dest)
        clearBackupStaleLock(storeHandle, disk.id, instanceId)
        const started = startedAt != null ? new Date(startedAt).toISOString() : 'at an unknown time'
        log(`Backup lock for ${instanceId} on ${disk.id} is from an interrupted backup started ${started}; no backup is running, so it is cleared and the next backup resumes (engine#429)`)
        return true
    } catch (e: any) {
        log(`Backup lock for ${instanceId} on ${disk.id} was not cleared: ${e?.message ?? e}`)
        return false
    } finally {
        resourceLock.releaseAll([diskKey(disk.id)])
    }
}

/**
 * True when an automatic backup should skip this instance because a lock is
 * still in use. Tries to clear a stale lock first (engine#429).
 */
export const autoBackupBlockedByLock = async (
    storeHandle: DocHandle<Store>,
    backupDisk: Disk,
    instanceId: InstanceID,
): Promise<boolean> => {
    const disk = (storeHandle.doc()?.diskDB?.[backupDisk.id] ?? backupDisk) as Disk
    const lockPath = disk.device ? lockFilePath(disk.device, instanceId) : ''
    const hasFile = !!(lockPath && await fs.pathExists(lockPath))
    const hasEntry = hasBackupStaleLock(disk, instanceId)
    if (!hasFile && !hasEntry) return false
    if (await clearAbandonedBackupLock(storeHandle, disk, instanceId)) return false
    const after = (storeHandle.doc()?.diskDB?.[disk.id] ?? disk) as Disk
    return !!(lockPath && await fs.pathExists(lockPath)) || hasBackupStaleLock(after, instanceId)
}

/**
 * Try to clear every leftover lock on this Backup Disk (store entries and
 * lock files). No store write unless a lock is actually cleared. Used on
 * each scheduler tick so a lock left for a live borg is cleared once borg
 * exits (engine#429).
 */
export const sweepAbandonedBackupLocks = async (
    storeHandle: DocHandle<Store>,
    backupDisk: Disk,
): Promise<void> => {
    const disk = (storeHandle.doc()?.diskDB?.[backupDisk.id] ?? backupDisk) as Disk
    const ids = new Set((disk.backupStaleLocks ?? []).map(l => String(l.instanceId)))
    if (disk.device) {
        const base = `${disksRoot()}/${disk.device}/backups`
        if (await fs.pathExists(base)) {
            for (const entry of await fs.readdir(base)) {
                if (await fs.pathExists(`${base}/${entry}/${LOCK_FILE}`)) ids.add(entry)
            }
        }
    }
    for (const id of ids) {
        await clearAbandonedBackupLock(storeHandle, disk, id as InstanceID)
    }
}

const readLockStartedAt = async (lockPath: string): Promise<Timestamp | null> => {
    try {
        const raw = JSON.parse(await fs.readFile(lockPath, 'utf-8'))
        const n = Number(raw?.startedAt)
        return Number.isFinite(n) ? n as Timestamp : null
    } catch {
        return null
    }
}

/**
 * Scan backups/ for leftover .backup-in-progress files, record them on
 * Disk.backupStaleLocks, and record INTERRUPTED once. Then clear each lock that
 * is stale (engine#429). Does not start a backup.
 */
export const recordBackupStaleLocks = async (storeHandle: DocHandle<Store>, backupDisk: Disk): Promise<void> => {
    if (!backupDisk.device) return
    const backupsBase = `${disksRoot()}/${backupDisk.device}/backups`
    const found: { instanceId: InstanceID; startedAt: Timestamp | null; detectedAt: Timestamp }[] = []
    const detectedAt = Date.now() as Timestamp
    if (await fs.pathExists(backupsBase)) {
        for (const entry of await fs.readdir(backupsBase)) {
            const lockPath = `${backupsBase}/${entry}/${LOCK_FILE}`
            if (await fs.pathExists(lockPath)) {
                found.push({ instanceId: entry as InstanceID, startedAt: await readLockStartedAt(lockPath), detectedAt })
                log(`Lock file found for instance ${entry} on Backup Disk ${backupDisk.id} (engine#429)`)
            }
        }
    }
    storeHandle.change(doc => {
        const d = doc.diskDB[backupDisk.id]
        if (d) d.backupStaleLocks = found
        // idea#400: an interrupted backup is the instance's latest result, recorded once per
        // lock (a later dock of the same disk with the same lock adds nothing).
        for (const l of found) {
            const inst = doc.instanceDB?.[l.instanceId]
            if (!inst) continue
            const last = inst.lastResult
            if (last && Number(last.time) >= (l.startedAt ?? 0)) continue // already recorded, or a newer result stands
            applyBackupResult(inst, { time: detectedAt, method: 'stop', result: 'INTERRUPTED' })
        }
    })
    for (const l of found) {
        await clearAbandonedBackupLock(storeHandle, backupDisk, l.instanceId)
    }
}

/**
 * Drop one instance's entry from Disk.backupStaleLocks (clearBackupLock, or a successful
 * backup, idea#454). Never assign undefined. Entries are spliced out in place: re-assigning
 * a filtered array would put the other instances' existing Automerge objects into a new
 * list, which Automerge rejects, so a disk with two stale locks could not lose one.
 */
export const clearBackupStaleLock = (storeHandle: DocHandle<Store>, diskId: string, instanceId: string): void => {
    storeHandle.change(doc => {
        const d = doc.diskDB[diskId]
        if (!d) return
        if (!d.backupStaleLocks) { d.backupStaleLocks = []; return }
        for (let i = d.backupStaleLocks.length - 1; i >= 0; i--) {
            if (String(d.backupStaleLocks[i].instanceId) === String(instanceId)) d.backupStaleLocks.splice(i, 1)
        }
    })
}

export const hasBackupStaleLock = (disk: Disk, instanceId: string): boolean =>
    (disk.backupStaleLocks ?? []).some(l => String(l.instanceId) === String(instanceId))


// ── Helpers ──────────────────────────────────────────────────────────────────

const backupDir = (backupDevice: string, instanceId: InstanceID) =>
    `${disksRoot()}/${backupDevice}/backups/${instanceId}`

const lockFilePath = (backupDevice: string, instanceId: InstanceID) =>
    `${backupDir(backupDevice, instanceId)}/${LOCK_FILE}`

const writeBackupYaml = async (backupDevice: string, yaml: BackupYaml): Promise<void> => {
    await fs.writeFile(`${disksRoot()}/${backupDevice}/${BACKUP_YAML}`, YAML.stringify(yaml))
}

// ── Core backup logic ─────────────────────────────────────────────────────────

/**
 * idea#448: the backup updateApp takes itself before a major update.
 *  - idea#458: it is a backup of the CURRENT (old) instance, so x-app.backup (exclude,
 *    hookExclude, method, hooks) comes from the instance's own compose.yaml, never from the
 *    new bundle: a hook that only the new version ships would run inside the old containers
 *    (exit 127). An old version without a hook means stop mode. The hook runs from that
 *    compose against the live compose project (BackupHookRunSpec.compose).
 *  - updateApp already holds the instance lock: only the Backup Disk lock is taken.
 *  - A failed preHook never stops the instance here (fallback is treated as `fail`).
 *  - `instanceStopped`: updateApp stopped the instance for its Snapshot (stop-mode current
 *    compose, or an instance that was not running): Borg runs directly, no hook, no
 *    stop and no start (one stop for backup and snapshot).
 *  - A `.backup-in-progress` left by an earlier backup still refuses the pre-update backup (BACKUP_STALE_LOCK).
 * Errors are thrown to updateApp (no own trace).
 */
export interface PreUpdateBackupOptions {
    instanceStopped: boolean
}

/** Text that starts a refusal of the pre-update backup because of a stale lock. */
export const BACKUP_STALE_LOCK = 'BACKUP_STALE_LOCK'

/**
 * Run a Borg backup of one instance to a Backup Disk.
 * Idempotent: if interrupted and re-triggered, Borg deduplicates against
 * existing chunks and completes in near-O(delta) time.
 */
export const backupInstance = async (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    backupDisk: Disk,
    existingOpId?: string,  // pass when retrying an interrupted op
    cause: OperationCause = 'console-command',
    preUpdate?: PreUpdateBackupOptions,
): Promise<void> => {
    const instRecEarly = getInstance(storeHandle.doc(), instanceId)
    if (instRecEarly && (instRecEarly as any).demo === true) {
        if (cause === 'console-command') throw new Error(`NOT_DEMO: instance ${instanceId} is a demo instance; demo instances are excluded from backups`)
        log(`Backup of demo instance ${instanceId} skipped`)
        return
    }

    // If there is no active trace (called from backup monitor, not via Console command),
    // create one so that step markers and log lines land in the Console log panel.
    // The pre-update backup reports its errors to updateApp, so it never swallows them.
    if (!getActiveTrace() && !preUpdate) {
        const cmdLogHandle = getCommandLogHandle()
        const traceId = crypto.randomUUID()
        const traceArgs = JSON.stringify({ instanceId, instanceName: instRecEarly?.name != null ? String(instRecEarly.name) : null, backupDiskId: backupDisk.id, cause })
        if (cmdLogHandle) addTrace(cmdLogHandle, { traceId, command: 'backupApp', args: traceArgs, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
        return runWithTrace({ traceId, command: 'backupApp', args: traceArgs }, async () => {
            await backupInstance(storeHandle, instanceId, backupDisk, existingOpId, cause)
            if (cmdLogHandle) { await flushTrace(traceId); closeTrace(cmdLogHandle, traceId, 'ok') }
        }).catch(async (err: any) => {
            if (cmdLogHandle) { await flushTrace(traceId); closeTrace(cmdLogHandle, traceId, 'error', err?.message ?? String(err)) }
        })
    }

    if (activeBackups.has(instanceId)) {
        // A console backupApp refusal must fail its trace (idea#168 r29@97); a duplicate
        // automatic trigger stays a quiet skip.
        if (cause === 'console-command') throw new Error(`Backup for ${instanceId} already in progress — not started again`)
        log(`Backup for ${instanceId} already in progress — skipping duplicate trigger`)
        return
    }
    activeBackups.add(instanceId)
    let didStop = false
    // idea#400: the App method for Instance.lastResult (x-app.backup.method; stop by default)
    let methodUsed: BackupMethodUsed = 'stop'
    // idea#448: a pre-update backup that fails before Borg ran (e.g. HOOK_FAILED) clears
    // its own lock file, so it is no stale lock; after Borg started it stays (boot-resume).
    let wroteLock: string | null = null
    let borgStarted = false

    // Take the instance lock and the Backup Disk lock together, as restore does
    // (idea#126, Files Disk step 0): nothing else may change the instance or the
    // Backup Disk (eject, erase, another backup or restore) while Borg writes.
    const backupLockKeys = preUpdate ? [diskKey(backupDisk.id)] : backupLockKeysFor(instanceId, backupDisk.id)
    if (!resourceLock.acquireAll(backupLockKeys, 'backupApp')) {
        activeBackups.delete(instanceId)
        const held = backupLockKeys.map(k => resourceLock.getLockInfo(k)).find(Boolean)
        const why = `Backup of instance ${instanceId} to disk ${backupDisk.id} not started: the instance or the Backup Disk is locked${held ? ` by '${held.kind}'` : ''} (another operation is running)`
        // idea#400 Q4 / #347 call 4: a direct command with a waiting caller is refused with BUSY and
        // records nothing. Anything without a caller (dock, App Disk dock, crash recovery, the
        // scheduler in PR C) records SKIPPED_LOCKED as the instance's result.
        if (isManualBackupCause(cause)) {
            const running = runningBackupOnDisk(storeHandle.doc(), backupDisk.id)
            throw new Error(`BUSY: ${why}${running?.cause === 'scheduled-backup' ? '; a scheduled backup is running on this Backup Disk' : ''}`)
        }
        recordBackupResult(storeHandle, instanceId, 'stop', 'SKIPPED_LOCKED')
        throw new Error(`SKIPPED_LOCKED: ${why}`)
    }

    const opId = existingOpId ?? createOperation(storeHandle, 'backupApp', {
        instanceId,
        backupDiskId: backupDisk.id,
        ...(preUpdate ? { reason: 'pre-update' } : {}),
    }, cause, { type: 'instance', id: instanceId })
    beginUsageSkip('backup')

    try {
        updateOperation(storeHandle, opId, { status: 'Running' })
        const store = storeHandle.doc()
        const instance = getInstance(store, instanceId)
        if (!instance) {
            throw new Error(`Instance ${instanceId} not found in store`)
        }
        if (!instance.storedOn) {
            throw new Error(`Instance ${instanceId} has no storedOn disk`)
        }

        const appDisk = store.diskDB[instance.storedOn]
        const localId = getLocalEngine(store)?.id ?? localEngineId
        if (!isDockedOnEngine(appDisk, localId)) {
            throw new Error(`App Disk for instance ${instanceId} is not docked`)
        }
        if (!isDockedOnEngine(backupDisk, localId)) {
            throw new Error(noLocalBackupDiskMessage(localEngineName(store)))
        }

        const backupDevice = backupDisk.device!
        const appDevice = appDisk.device
        const repoPath = backupDir(backupDevice, instanceId)
        const lockPath = lockFilePath(backupDevice, instanceId)

        const totalBackupSteps = BACKUP_STEPS.length

        const setBackupStep = (step: number, label: string) => {
            const line = `  Step ${step + 1}/${totalBackupSteps}  │  ${label}  `
            const bar  = '─'.repeat(line.length)
            print(`┌${bar}┐`)
            print(`│${line}│`)
            print(`└${bar}┘`)
            storeHandle.change(doc => {
                const op = doc.operationDB?.[opId]
                if (!op) return
                op.currentStep = step
                op.totalSteps = totalBackupSteps
                op.stepLabel = label
                op.progressPercent = Math.round((step / (totalBackupSteps - 1)) * 100)
            })
        }

        log(`Starting backup of instance ${instanceId} from ${appDevice} to ${backupDevice}`)

        // 0b. Honour x-app.backup.exclude (idea#443) and x-app.backup.method
        // (idea#444). Fail closed: a non-empty exclude list on a helper older
        // than v8, or a malformed method/hook block, refuses before any hook
        // or stop, and without writing lastBackup.
        const instanceDir = joinMountRoot(await diskMountRoot(appDisk as Disk), 'instances', instanceId)
        const composePath = joinMountRoot(instanceDir, 'compose.yaml')
        let backupExcludes: string[] = []
        let hookExcludes: string[] = []
        let backupSpec = defaultBackupSpec()
        if (preUpdate && !await fs.pathExists(composePath)) {
            throw new Error(`backupApp: the instance's ${composePath} is missing (the pre-update backup reads x-app.backup from the current version)`)
        }
        if (await fs.pathExists(composePath)) {
            let parsed: unknown
            try {
                parsed = YAML.parse(await fs.readFile(composePath, 'utf-8'))
            } catch (e: any) {
                throw new Error(`Cannot parse ${composePath} for x-app.backup (${e?.message ?? e})`)
            }
            const xapp = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>)['x-app'] : undefined
            try {
                backupExcludes = parseBackupExcludeList(xapp)
            } catch (e: any) {
                throw new Error(`backupApp: invalid x-app.backup.exclude (${e?.message ?? e})`)
            }
            try {
                hookExcludes = parseBackupHookExcludeList(xapp)
            } catch (e: any) {
                throw new Error(`backupApp: invalid x-app.backup.hookExclude (${e?.message ?? e})`)
            }
            try {
                backupSpec = parseBackupSpec(xapp)
                assertHookServicesExist(parsed, backupSpec)
            } catch (e: any) {
                throw new Error(`backupApp: invalid x-app.backup (${e?.message ?? e})`)
            }
        }
        methodUsed = backupSpec.method

        // idea#403: method none — nothing goes to the Backup Disk (the App's content is on
        // the App Disk and can be rebuilt). No borg, no lock file, no hook, no stop, no
        // cleanup and no lastBackup; the run is recorded as method none, result OK, so the
        // Console shows it neutral ("Not backed up: its content is on the App Disk").
        if (backupSpec.method === 'none') {
            log(`Backup of instance ${instanceId}: x-app.backup.method is none — nothing is copied to the Backup Disk`)
            storeHandle.change(doc => {
                const op = doc.operationDB?.[opId]
                if (!op) return
                op.args.hookResult = 'none'
                op.stepLabel = 'Not backed up: method none'
            })
            recordBackupResult(storeHandle, instanceId, 'none', 'OK')
            updateOperation(storeHandle, opId, {
                status: 'Done',
                progressPercent: 100,
                completedAt: Date.now() as Timestamp,
            })
            return
        }

        // 0. Preflight: no borg means exit 127 from the helper; say so plainly instead
        // (idea#403: after x-app.backup is read, so method none never needs borg).
        if (!skipBorg()) {
            const borgMissing = borgProblem()
            if (borgMissing) throw new Error(borgMissing)
        }

        // idea#448 (Steve Q4): inside updateApp a failed preHook refuses, it never stops.
        if (preUpdate) backupSpec.fallback = 'fail'
        if (preUpdate && !preUpdate.instanceStopped && backupSpec.method !== 'hook') {
            throw new Error(`backupApp: the pre-update backup of ${instanceId} needs method 'hook' in the current compose while the instance runs (updateApp takes a stop-mode backup inside its Snapshot stop)`)
        }
        if ((backupExcludes.length || hookExcludes.length) && !skipBorg()) {
            const helper = await helperAtLeast(BACKUP_EXCLUDE_HELPER_MIN, 'backupApp with x-app.backup.exclude')
            if (helper) throw new Error(`HELPER_OUTDATED: ${helper}`)
        }

        // 0c. Fullness cleanup (idea#401, helper v9) before any hook or stop.
        // An older helper skips cleanup and the backup still runs.
        let cleanupWarning: string | null = null
        const backupMountRoot = joinMountRoot(await diskMountRoot(backupDisk as Disk))
        if (cleanupIsEnabled()) {
            const before = await runCleanupTracked(storeHandle, backupDisk.id, {
                backupDevice, mountRoot: backupMountRoot, currentInstanceId: instanceId, phase: 'before',
            })
            if (before.status === 'HELPER_OUTDATED') cleanupWarning = before.warning ?? 'HELPER_OUTDATED'
            if (before.status === 'full') throw backupDiskFullError()
        }

        // 1. Init Borg repo if this is the first backup
        setBackupStep(0, BACKUP_STEPS[0])
        const repoExists = await fs.pathExists(`${repoPath}/config`)
        if (!repoExists) {
            log(`Initialising Borg repo at ${repoPath}`)
            await fs.ensureDir(repoPath)
            if (!skipBorg()) {
                await runAppData(borgInitArgs(backupDevice, instanceId))
            } else {
                log(`skipBorg: skipping borg init`)
            }
        }

        // 2. Write lock file (signals in-progress backup for boot-resume)
        if (preUpdate && await fs.pathExists(lockPath)) {
            throw new Error(`${BACKUP_STALE_LOCK}: ${lockPath} is left from an earlier backup of ${instanceId}; it is not retried here (idea#446)`)
        }
        await fs.writeFile(lockPath, JSON.stringify(backupLockContents(instanceId, preUpdate ? { reason: 'pre-update' } : {})))
        wroteLock = lockPath

        const wasRunningAtStart = instance.status === 'Running' && !preUpdate?.instanceStopped
        // idea#403: hooks exec into the App's containers, so they only run while the instance
        // is up. A stopped instance is backed up cold (its files are quiet): no hook, no stop.
        const instanceUp = (instance.status === 'Running' || instance.status === 'Starting') && !preUpdate?.instanceStopped
        let hookResult: 'stop' | 'hook' | 'cold' | 'HOOK_FALLBACK' = 'stop'
        let hookWarning: string | null = null

        type HookStepResult = { failed: boolean, timedOut: boolean, code: number, stderr: string }

        const runDeclaredHook = async (hook: BackupHookDecl): Promise<HookStepResult> => {
            try {
                const r = await backupHookRunner.run({
                    cwd: instanceDir,
                    timeoutS: backupSpec.hookTimeout,
                    service: hook.service,
                    command: hook.command,
                    user: hook.user,
                    ...(preUpdate ? { compose: { project: String(instanceId), projectDir: instanceDir, file: composePath } } : {}),
                })
                return { failed: r.code !== 0 || r.timedOut, timedOut: r.timedOut, code: r.code, stderr: r.stderr }
            } catch (e: any) {
                return { failed: true, timedOut: false, code: -1, stderr: e?.message ?? String(e) }
            }
        }

        const hookFailureMessage = (which: string, r: { timedOut: boolean, code: number, stderr: string }): string => {
            const why = r.timedOut ? 'timed out' : (r.code < 0 ? 'could not start' : `exited ${r.code}`)
            const detail = r.stderr.trim().replace(/\s+/g, ' ').slice(0, 300)
            return `${which} ${why}${detail ? `: ${detail}` : ''}`
        }

        /** A step's name in messages: `preHook` for a list of one (as before), else `preHook[i]`. */
        const stepName = (which: 'preHook' | 'postHook', steps: BackupHookDecl[], i: number): string =>
            steps.length > 1 ? `${which}[${i}]` : which

        /** idea#403: pre steps in order; stops at the first failure. Returns that failure's message, or null. */
        const runPreHooks = async (): Promise<string | null> => {
            const steps = backupSpec.preHook
            for (let i = 0; i < steps.length; i++) {
                const r = await runDeclaredHook(steps[i])
                if (r.failed) {
                    const skipped = steps.length - i - 1
                    return `${hookFailureMessage(stepName('preHook', steps, i), r)}${skipped ? ` (${skipped} later preHook step(s) not run)` : ''}`
                }
            }
            return null
        }

        /** idea#403: EVERY post step always runs, whatever failed before. Returns the failure messages. */
        const runPostHooks = async (): Promise<string[]> => {
            const steps = backupSpec.postHook
            const failures: string[] = []
            for (let i = 0; i < steps.length; i++) {
                const r = await runDeclaredHook(steps[i])
                if (r.failed) failures.push(hookFailureMessage(stepName('postHook', steps, i), r))
            }
            return failures
        }

        // engine#401: the archive name carries the backup mode (-hook / -stop / -cold) when
        // the helper accepts it (v16); an older helper gets today's untagged name.
        const tagArchives = skipBorg() || !(await helperAtLeast(ARCHIVE_MODE_HELPER_MIN, 'a backup-mode archive name'))
        if (!tagArchives) log(`Backup of ${instanceId}: app-data helper older than v${ARCHIVE_MODE_HELPER_MIN}; the archive name gets no mode suffix`)
        let archiveName: string | null = null

        const runBorgCreate = async (excludes: string[], mode: ArchiveMode): Promise<void> => {
            setBackupStep(2, BACKUP_STEPS[2])
            borgStarted = true
            archiveName = backupArchiveName(new Date(), tagArchives ? mode : null)
            if (!skipBorg()) {
                log(`Running borg create for instance ${instanceId}${excludes.length ? ` (${excludes.length} exclude(s))` : ''}`)
                await runAppData(borgCreateArgs(backupDevice, instanceId, archiveName, await appDataRoot(appDisk as Disk), excludes))
            } else {
                log(`skipBorg: skipping borg create for instance ${instanceId}`)
            }
        }

        const stopThenStartAround = async (copy: () => Promise<void>): Promise<void> => {
            if (wasRunningAtStart) {
                didStop = true
                log(`Stopping instance ${instanceId} before backup`)
                setBackupStep(1, BACKUP_STEPS[1])
                await backupLifecycle.stopInstance(storeHandle, instance, appDisk, 'backup-pre-stop')
            }
            await copy()
            if (didStop) {
                log(`Restarting instance ${instanceId} after backup`)
                setBackupStep(3, BACKUP_STEPS[3])
                await backupLifecycle.startInstance(storeHandle, instance, appDisk, 'backup-post-start')
                warnIfPostStartNotRunning(storeHandle, opId, instanceId, 'after backup')
            }
        }

        // 3–5. Copy: method hook runs the preHook steps (no stop) then borg then every
        // postHook step; a failed/timed-out pre step runs every postHook step, then either
        // HOOK_FALLBACK (short stop) or HOOK_FAILED (no stop), per x-app.backup.fallback.
        // A failed borg run also runs every postHook step before the failure is reported.
        if (preUpdate?.instanceStopped) {
            // updateApp stopped the instance for its Snapshot: Borg only, the hook dump is not
            // needed (the live files are quiet), so hookExclude does not apply.
            hookResult = 'stop'
            await runBorgCreate(backupExcludes, 'stop')
        } else if (backupSpec.method === 'hook' && !instanceUp) {
            // idea#403: the instance is not running: skip the hooks and back up cold. No dump
            // was made, so hookExclude does not apply. Not HOOK_FALLBACK (nothing failed).
            hookResult = 'cold'
            log(`Instance ${instanceId} is not running (${instance.status}): hooks skipped, backing up cold`)
            await runBorgCreate(backupExcludes, 'cold')
        } else if (backupSpec.method === 'hook') {
            setBackupStep(1, 'Running pre-backup hook')
            const preFailure = await runPreHooks()
            if (!preFailure) {
                hookResult = 'hook'
                try {
                    await runBorgCreate(mergeBackupExcludeLists(backupExcludes, hookExcludes), 'hook')
                } catch (borgErr) {
                    setBackupStep(3, 'Running post-backup hook')
                    const postFailures = await runPostHooks()
                    for (const f of postFailures) log(chalk.yellow(`postHook failed after a failed borg run on ${instanceId}: ${f}`))
                    throw borgErr
                }
                setBackupStep(3, 'Running post-backup hook')
                const postFailures = await runPostHooks()
                if (postFailures.length) {
                    hookWarning = `HOOK_POST_WARNING: ${postFailures.join('; ')}`
                    log(chalk.yellow(`Backup of ${instanceId} succeeded with a postHook warning: ${hookWarning}`))
                }
            } else {
                const postFailures = await runPostHooks()
                for (const f of postFailures) log(chalk.yellow(`postHook failed after a failed preHook on ${instanceId}: ${f}`))
                if (backupSpec.fallback === 'fail') {
                    throw new Error(`HOOK_FAILED: ${preFailure}`)
                }
                hookResult = 'HOOK_FALLBACK'
                log(`HOOK_FALLBACK: ${preFailure}; falling back to a short stop`)
                await stopThenStartAround(() => runBorgCreate(backupExcludes, 'stop'))
            }
        } else {
            await stopThenStartAround(() => runBorgCreate(backupExcludes, 'stop'))
        }

        // 6. Update store: set lastBackup on the instance
        setBackupStep(4, BACKUP_STEPS[4])
        storeHandle.change(doc => {
            const inst = doc.instanceDB[instanceId]
            if (inst) inst.lastBackup = Date.now() as Timestamp
        })

        // 7. Update BACKUP.yaml on the disk
        // idea#400: a document edit, so schedule / lastRun / uptimeCounter and unknown keys stay
        await setLinkLastBackup(backupDevice, instanceId, Date.now())

        // 8. Remove lock file (success). A backup over a stale lock also drops the
        // instance's Disk.backupStaleLocks entry: the lock it recorded is gone (idea#454).
        await fs.remove(lockPath)
        if (hasBackupStaleLock(storeHandle.doc().diskDB[backupDisk.id] ?? backupDisk, instanceId)) {
            clearBackupStaleLock(storeHandle, backupDisk.id, instanceId)
            log(`Backup of ${instanceId} succeeded over a stale lock — removed its Disk.backupStaleLocks entry (idea#454)`)
        }

        if (cleanupIsEnabled()) {
            const after = await runCleanupTracked(storeHandle, backupDisk.id, {
                backupDevice, mountRoot: backupMountRoot, currentInstanceId: instanceId, phase: 'after',
            })
            if (after.status === 'HELPER_OUTDATED' && !cleanupWarning) {
                cleanupWarning = after.warning ?? 'HELPER_OUTDATED'
            }
        }
        storeHandle.change(doc => {
            const op = doc.operationDB?.[opId]
            if (!op) return
            op.args.hookResult = hookResult
            if (archiveName) op.args.archive = archiveName   // engine#401
            if (hookWarning) op.args.warning = hookWarning
            if (cleanupWarning) op.args.cleanup = cleanupWarning as string
        })
        recordBackupResult(storeHandle, instanceId, methodUsed, successResultCode({
            hookFallback: hookResult === 'HOOK_FALLBACK',
            hookWarning: !!hookWarning,
            cleanupHelperOutdated: !!cleanupWarning && String(cleanupWarning).startsWith('HELPER_OUTDATED'),
        }))
        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`Backup of instance ${instanceId} completed successfully${hookWarning ? ` (${hookWarning})` : ''}`))

    } catch (e: any) {
        updateOperation(storeHandle, opId, {
            status: 'Failed',
            error: e.message ?? String(e),
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.red(`Backup of instance ${instanceId} failed: ${e.message ?? e}`))
        recordBackupResult(storeHandle, instanceId, methodUsed, failureResultCode(String(e?.message ?? e)))
        // Always restart instance if this run stopped it (even on failure)
        if (didStop) {
            try {
                const store = storeHandle.doc()
                const instance = getInstance(store, instanceId)
                const appDisk = instance?.storedOn ? store.diskDB[instance.storedOn] : null
                if (instance && appDisk) {
                    log(`Restarting instance ${instanceId} after failed backup`)
                    await backupLifecycle.startInstance(storeHandle, instance, appDisk, 'backup-post-start')
                    warnIfPostStartNotRunning(storeHandle, opId, instanceId, 'after failed backup')
                }
            } catch (restartErr) {
                log(chalk.red(`Failed to restart instance ${instanceId} after backup error: ${restartErr}`))
            }
        }
        if (preUpdate && wroteLock && !borgStarted) {
            await fs.remove(wroteLock).catch(() => { /* best effort; the next updateApp reports it */ })
        }
        // Lock file intentionally left in place — signals boot-resume on next dock
        // Rethrow so the backup's trace ends with status 'error' and this message
        throw e
    } finally {
        activeBackups.delete(instanceId)
        resourceLock.releaseAll(backupLockKeys)
        endUsageSkip('backup')
    }
    // engine#430: only reached after a successful backup (failures rethrow above). The
    // locks are released, so the queued measurement can run.
    requestDataBytes(storeHandle, [instanceId])
}

/**
 * Fullness cleanup with Disk.cleaning / cleaningStartedAt (idea#400 PR C): set when the cleanup
 * starts deleting archives and cleared when it ends, so the store changes only when cleanup
 * deletes. cleaningStartedAt stays as the time of the last cleanup.
 */
export const runCleanupTracked = async (
    storeHandle: DocHandle<Store>, diskId: DiskID, opts: Parameters<typeof backupCleanupRunner.run>[0],
): ReturnType<typeof backupCleanupRunner.run> => {
    let marked = false
    try {
        return await backupCleanupRunner.run({
            ...opts,
            onDeleteStart: () => {
                marked = true
                storeHandle.change(doc => {
                    const d = doc.diskDB[diskId]
                    if (d) { d.cleaning = true; d.cleaningStartedAt = Date.now() as Timestamp }
                })
            },
        })
    } finally {
        if (marked) storeHandle.change(doc => { const d = doc.diskDB[diskId]; if (d) d.cleaning = false })
    }
}

/** Lock keys a backup holds: the instance and the Backup Disk (idea#126). */
export const backupLockKeysFor = (instanceId: string, backupDiskId: string): string[] =>
    [instanceKey(instanceId), diskKey(backupDiskId)]

/**
 * The running (or pending) backupApp operation writing to a disk, if any
 * (idea#126). Eject (and a later erase) check this by the operation's
 * backupDiskId, so every backup is covered, whatever started it (console,
 * immediate mode, stale lock, crash recovery, a schedule).
 */
export const runningBackupOnDisk = (store: Store, diskId: string): Operation | undefined =>
    Object.values(store.operationDB ?? {}).find(op =>
        op?.kind === 'backupApp' &&
        (op.status === 'Running' || op.status === 'Pending') &&
        op.args?.backupDiskId === diskId) as Operation | undefined

/**
 * Start a backup from a monitor loop: failures are already recorded in the
 * backup's trace and operation, so they are logged here and the loop goes on.
 */
const triggerBackup = async (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    backupDisk: Disk,
    cause: OperationCause,
): Promise<void> => {
    try {
        await backupInstance(storeHandle, instanceId, backupDisk, undefined, cause)
    } catch (e: any) {
        log(chalk.red(`Backup of instance ${instanceId} failed: ${e?.message ?? e}`))
    }
}

// ── Backup Disk processing ────────────────────────────────────────────────────

/**
 * Called by processDisk when a Backup Disk is detected.
 * - Reads BACKUP.yaml and sets backupConfig in the store
 * - Scans for leftover lock files, records INTERRUPTED, and clears stale ones (engine#429)
 * - Triggers backupInstance for immediate mode (linked instances; a stale lock is cleared first)
 */
export const processBackupDisk = async (
    storeHandle: DocHandle<Store>,
    backupDisk: Disk
): Promise<void> => {
    const backupDevice = backupDisk.device!
    log(`Processing Backup Disk ${backupDisk.id} on device ${backupDevice}`)

    const yaml = await readBackupYamlState(backupDevice)
    if (!yaml) {
        log(`No BACKUP.yaml found on disk ${backupDisk.id} — skipping backup processing`)
        return
    }

    const mode = yaml.mode
    const links = yaml.links.map(l => l.instanceId as InstanceID)
    if (yaml.scheduleError) {
        log(chalk.yellow(`Backup Disk ${backupDisk.id}: BACKUP.yaml schedule ignored (${yaml.scheduleError}); mirrored as null with backupConfig.scheduleError (idea#400)`))
    }

    // Set backupConfig in store, and mirror the scheduled-run summary kept on the disk (idea#400)
    storeHandle.change(doc => {
        const d = doc.diskDB[backupDisk.id]
        if (!d) return
        // scheduleError: the marker the Console shows for an invalid schedule (Steve, #347 call 5)
        d.backupConfig = {
            mode, links,
            schedule: yaml.schedule ? { daily: yaml.schedule.daily } : null,
            scheduleError: yaml.scheduleError,
            orphanLinks: backupOrphanLinks(doc, links),
        }
        if ((d.missedRuns ?? null) !== yaml.missedRuns) d.missedRuns = yaml.missedRuns
        if ((d.lastAttempt ?? null) !== yaml.lastAttempt) d.lastAttempt = yaml.lastAttempt as Timestamp | null
    })
    const orphans = storeHandle.doc()!.diskDB[backupDisk.id]?.backupConfig?.orphanLinks ?? []
    if (orphans.length) {
        log(`Backup Disk ${backupDisk.id}: ${orphans.length} linked instance(s) not in the store (orphanLinks): ${orphans.join(', ')}`)
    }

    // Phase 2: index any app bundles on this disk into appDB for installApp / Console
    await indexBackupDiskApps(storeHandle, backupDisk)

    // Scan for leftover lock files, record INTERRUPTED, and clear stale ones (engine#429).
    await recordBackupStaleLocks(storeHandle, backupDisk)

    // Trigger immediate backups for linked instances whose App Disk is docked.
    if (mode === 'immediate') {
        const store = storeHandle.doc()
        for (const instanceId of links) {
            if (await autoBackupBlockedByLock(storeHandle, backupDisk, instanceId)) {
                log(`Instance ${instanceId}: backup lock still in use — not auto-backing up (engine#429)`)
                continue
            }
            const instance = getInstance(storeHandle.doc(), instanceId)
            if (!instance) {
                log(`Instance ${instanceId}: not in the store; skipped (orphanLinks)`)
                continue
            }
            if ((instance as any).demo === true) {
                log(`Instance ${instanceId}: demo instance — skipped (engine#369)`)
                continue
            }
            if (!instance.storedOn) continue
            const appDisk = store.diskDB[instance.storedOn]
            if (appDisk?.device) {
                // idea#400 (Steve, #347 call 4): no caller waits on a dock backup, so a held lock records SKIPPED_LOCKED
                await triggerBackup(storeHandle, instanceId, backupDisk, 'disk-docked')
            } else {
                log(`Instance ${instanceId}: App Disk not docked — backup will trigger when App Disk docks`)
            }
        }
    }
}

// ── App Disk hook ─────────────────────────────────────────────────────────────

/**
 * Called from processAppDisk when an App Disk docks.
 * Checks all docked Backup Disks for links to instances on this App Disk
 * and triggers backup for immediate-mode disks.
 */
export const checkPendingBackups = async (
    storeHandle: DocHandle<Store>,
    appDisk: Disk
): Promise<void> => {
    const store = storeHandle.doc()

    // Instances may have just appeared (this App Disk docked); refresh orphanLinks without touching BACKUP.yaml.
    syncBackupOrphanLinks(storeHandle)

    // Find all currently docked Backup Disks
    const dockedDisks = Object.values(store.diskDB).filter(d => d.device != null)
    for (const candidate of dockedDisks) {
        if (!candidate.diskTypes?.includes('backup')) continue
        if (!candidate.backupConfig) continue
        if (candidate.backupConfig.mode !== 'immediate') continue

        // Check if any linked instance lives on the newly docked App Disk
        const instancesOnAppDisk = Object.values(store.instanceDB)
            .filter(inst => String(inst.storedOn) === String(appDisk.id))

        for (const instance of instancesOnAppDisk) {
            if ((instance as any).demo === true) continue
            if (!candidate.backupConfig.links.includes(instance.id)) continue
            if (await autoBackupBlockedByLock(storeHandle, candidate as Disk, instance.id)) {
                log(`checkPendingBackups: backup lock for ${instance.id} still in use — not auto-backing up (engine#429)`)
                continue
            }
            log(`checkPendingBackups: triggering backup for instance ${instance.id}`)
            await triggerBackup(storeHandle, instance.id, candidate as Disk, 'backup-app-docked')
        }
    }
}

// ── borg archive selection (idea#168) ─────────────────────────────────────────

/**
 * The newest archive of a repo and how to extract it into <mount root>/instances/.
 *
 * Archives are named by ISO timestamp (backupInstance), and borg 1.x has no
 * `latest` alias: `borg extract <repo>::latest` fails with "Archive latest does
 * not exist". So the newest archive is picked explicitly (`borg info --last 1`,
 * sorted by archive time).
 *
 * borg stores the backed-up path without its leading '/', e.g.
 * `disks/sda1/instances/<id>/...`, so the archive's own command line gives the
 * prefix to strip: everything before `<id>`, so the files land in
 * instances/<id>/ whatever the source disk's mount root was.
 */
export const latestArchiveFromInfo = (infoJson: string, instanceId: string): { name: string, stripComponents: number } => {
    const archive = JSON.parse(infoJson)?.archives?.[0]
    if (!archive?.name) throw new Error('No backup archives found in the repository')
    const suffix = `instances/${instanceId}`
    const source = (archive.command_line as string[] | undefined ?? [])
        .map(a => a.replace(/^\/+/, '').replace(/\/+$/, ''))
        .find(a => a === suffix || a.endsWith(`/${suffix}`))
    if (!source) throw new Error(`Archive ${archive.name} does not contain instances/${instanceId}`)
    return { name: archive.name, stripComponents: source.split('/').length - 1 }
}

/**
 * Extract the newest archive of the instance's repo on the Backup Disk so the
 * instance lands in <target mount root>/instances/<instanceId>, as root through the
 * app-data helper: `borg-info` (JSON), then `borg-extract`, which extracts into a
 * fresh staging folder on the target disk, checks that only <instanceId> came out
 * and moves it into place (replacing a previous folder of that instance).
 * Roots are app-data helper root tokens. The runner is injectable for tests.
 */
export const extractLatestArchive = async (backupRoot: string, instanceId: string, targetRoot: string, run: AppDataRunner = runAppData): Promise<string> => {
    if (run === runAppData) {
        const borgMissing = borgProblem()
        if (borgMissing) throw new Error(borgMissing)
    }
    const { name, stripComponents } = latestArchiveFromInfo(await run(borgInfoArgs(backupRoot, instanceId)), instanceId)
    log(`Extracting archive ${name} (--strip-components ${stripComponents}) onto ${targetRoot} instances/${instanceId}`)
    await run(borgExtractArgs(backupRoot, instanceId, name, stripComponents, targetRoot))
    return name
}

// ── restoreApp ────────────────────────────────────────────────────────────────

/** engine#413: cause of the start after an in-place restore of a Running instance (not a user cause). */
export const RESTORE_POST_START_CAUSE: OperationCause = 'backup-post-start'

/** engine#428: honest restore result when the post-restore start did not reach Running. */
export const restoreStartPendingMessage = (instance: Instance): string => {
    const cond = String(instance.statusCondition ?? '')
    if (isPortNotReadyCondition(cond)) {
        const n = portNotReadyTimeoutSeconds(cond)
        return `START_PENDING: restored; the app did not answer within ${n} s and will show Running once it does`
    }
    const err = cond || `status is ${instance.status}`
    return `START_PENDING: restored; ${err}`
}

const recordRestoreStartPending = (instance: Instance): string => {
    const msg = restoreStartPendingMessage(instance)
    log(msg)
    attachTraceResult({ startPending: msg })
    const tid = getActiveTrace()?.traceId
    if (tid) stashTraceCloseMessage(tid, msg)
    return msg
}


/**
 * engine#468: the outcome of restoreApp's post-restore start. Running is ok. A
 * PORT_NOT_READY Error is START_PENDING (engine#428: the heal sets Running once the
 * app answers). Any other state, such as a container that exited, is a hard start
 * failure: the files are restored (no rollback) but the restore fails with
 * RESTORE_START_FAILED. Pure.
 */
export type RestoreStartOutcome = { kind: 'running' } | { kind: 'pending' } | { kind: 'failed', message: string }

export const restoreStartOutcome = (instance: Pick<Instance, 'status' | 'statusCondition'> | undefined, diskName: string): RestoreStartOutcome => {
    if (!instance) return { kind: 'failed', message: `RESTORE_START_FAILED: restored files to ${diskName}; the instance did not start: the instance record is gone` }
    if (instance.status === 'Running') return { kind: 'running' }
    const cond = String(instance.statusCondition ?? '')
    if (instance.status === 'Error' && isPortNotReadyCondition(cond)) return { kind: 'pending' }
    const why = cond || `status is ${instance.status}`
    return { kind: 'failed', message: `RESTORE_START_FAILED: restored files to ${diskName}; the instance did not start: ${why}` }
}

/**
 * engine#468: a backup's post-start (after the short stop, or after a failed backup)
 * that did not reach Running. The backup result is unchanged; the Operation gets
 * args.postStartWarning and a backupApp trace gets it as its result.
 */
export const postStartWarningMessage = (instance: Pick<Instance, 'status' | 'statusCondition'> | undefined, when: string): string | null => {
    if (instance?.status === 'Running') return null
    const why = !instance ? 'the instance record is gone' : (String(instance.statusCondition ?? '') || `status is ${instance.status}`)
    return `POST_START_WARNING: the instance did not return to Running ${when}: ${why}`
}

const warnIfPostStartNotRunning = (storeHandle: DocHandle<Store>, opId: string, instanceId: InstanceID, when: string): void => {
    const msg = postStartWarningMessage(getInstance(storeHandle.doc(), instanceId), when)
    if (!msg) return
    log(chalk.yellow(`Backup of ${instanceId}: ${msg}`))
    storeHandle.change(doc => {
        const op = doc.operationDB?.[opId]
        if (op) op.args.postStartWarning = msg
    })
    // Only a backupApp trace: inside updateApp the trace result belongs to the update
    if (getActiveTrace()?.command === 'backupApp') attachTraceResult({ postStartWarning: msg })
}

const RESTORE_RUNNING_STATES = new Set(['Running', 'Starting'])

/** engine#422: what restoreApp's pre-stop should do with the instance's recorded status. */
export type RestoreRunningState =
    | { kind: 'not-running' }
    | { kind: 'running-here', disk: Disk }
    | { kind: 'stale' }
    | { kind: 'other-engine', dockedTo: string }

/**
 * engine#422: a recorded Running is real only when the storedOn disk is docked to
 * this Engine (device set, dockedTo local); then restoreApp stops it and restarts it
 * afterwards (engine#413). A Running or Starting record whose storedOn disk has no
 * record or no device is stale: nothing can run from a disk that is not docked.
 * A storedOn disk docked to another Engine is never stopped from here. Pure.
 */
export const restoreRunningState = (store: Store, instance: Pick<Instance, 'storedOn' | 'status'> | undefined, engineId: string): RestoreRunningState => {
    if (!instance || !RESTORE_RUNNING_STATES.has(String(instance.status))) return { kind: 'not-running' }
    const disk = instance.storedOn ? store.diskDB?.[instance.storedOn] as Disk | undefined : undefined
    if (!disk || disk.device == null) return { kind: 'stale' }
    if (String(disk.dockedTo) !== String(engineId)) return { kind: 'other-engine', dockedTo: String(disk.dockedTo) }
    // Starting here is refused up front (INSTANCE_STARTING); only Running is stopped
    return instance.status === 'Running' ? { kind: 'running-here', disk } : { kind: 'not-running' }
}

/**
 * Restore the latest archive for instanceId from any docked Backup Disk
 * onto targetDisk. Always onto that same instance id: replaces
 * instances/<id> with the latest backups/<id> archive. Not a restore to
 * a new id (engine#457).
 */
export const restoreApp = async (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    targetDisk: Disk,
    existingOpId?: string,
    cause: OperationCause = 'console-command',
): Promise<void> => {
    // Acquire lock: instance + target disk
    const restoreLockKeys = [instanceKey(instanceId), diskKey(targetDisk.id)]
    // Refusals and failures throw (idea#168 r29@97), so the restoreApp command trace ends as error.
    if (!resourceLock.acquireAll(restoreLockKeys, 'restoreApp')) {
        throw new Error(`restoreApp: resource locked — another operation is already running on instance or target disk. Retry when it completes.`)
    }

    const opId = existingOpId ?? createOperation(storeHandle, 'restoreApp', {
        instanceId,
        targetDiskId: targetDisk.id,
    }, cause, { type: 'instance', id: instanceId })
    beginUsageSkip('backup')

    try {
        updateOperation(storeHandle, opId, { status: 'Running' })
        const store = storeHandle.doc()

        // Find a docked Backup Disk with an archive for this instance
        const dockedDisks = Object.values(store.diskDB).filter(d => d.device != null)
        let backupDisk: Disk | null = null
        for (const candidate of dockedDisks) {
            if (!candidate.diskTypes?.includes('backup')) continue
            const repoPath = backupDir(candidate.device!, instanceId)
            if (await fs.pathExists(`${repoPath}/config`)) {
                backupDisk = candidate as Disk
                break
            }
        }

        if (!backupDisk) {
            throw new Error(`No docked Backup Disk with archives for instance ${instanceId}`)
        }

        const backupDevice = backupDisk.device!
        const targetDevice = targetDisk.device
        if (!targetDevice) {
            throw new Error(`Target disk ${targetDisk.id} is not docked`)
        }

        // engine#418: a storedOn disk docked to another Engine is refused before any extract
        const otherEngine = sourceOnOtherEngine(store, instanceId, targetDisk, String(localEngineId))
        if (otherEngine) throw new Error(otherEngine)
        // engine#418: never stop or replace an instance in the middle of its start
        const starting = instanceStartingHere(store, instanceId, String(localEngineId))
        if (starting) throw new Error(starting)

        // #190: restoring to another disk quarantines the old folder afterwards (helper v4)
        const prevDisk = await assertPreQuarantineHelper(store, instanceId, targetDisk, String(localEngineId))

        const repoPath = backupDir(backupDevice, instanceId)
        const instancesDir = `${await diskMountRoot(targetDisk)}/instances`

        // Stop instance if currently running. engine#413: remember that it was
        // Running, because the stop writes status Stopped and processInstance then
        // skips the auto-start (shouldAutoStart: 'status is Stopped').
        // engine#422: only a storedOn disk docked to THIS Engine can hold a running
        // copy we may stop; see restoreRunningState.
        const instance = getInstance(store, instanceId)
        const running = restoreRunningState(store, instance, String(localEngineId))
        const wasRunning = running.kind === 'running-here'
        if (running.kind === 'running-here') {
            await backupLifecycle.stopInstance(storeHandle, instance!, running.disk, 'backup-pre-stop')
        } else if (running.kind === 'stale') {
            log(`restoreApp: ${instanceId} is recorded ${instance!.status} but its storedOn disk ${instance!.storedOn ?? 'none'} is not docked anywhere; treating the status as stale (no stop, no engine#413 restart; the dock gate decides the start) (engine#422)`)
            storeHandle.change(doc => {
                const inst = doc.instanceDB[instanceId]
                if (inst && RESTORE_RUNNING_STATES.has(String(inst.status))) inst.status = 'Undocked' as Status
            })
        } else if (running.kind === 'other-engine') {
            log(`restoreApp: ${instanceId} is recorded ${instance!.status} on disk ${instance!.storedOn}, docked to another Engine (${running.dockedTo}); not stopping it from here (engine#422)`)
        }

        await fs.ensureDir(instancesDir)

        if (!skipBorg()) {
            log(`Restoring instance ${instanceId} from ${backupDevice} to ${targetDevice} (repo ${repoPath})`)
            await extractLatestArchive(backupDevice, instanceId, await appDataRoot(targetDisk))
        } else {
            log(`skipBorg: skipping borg extract for instance ${instanceId}`)
        }

        // #189: restored onto another disk → bring the app master and service tars along
        if (instance) {
            const now = storeHandle.doc()
            const prev = instance.storedOn ? now.diskDB[instance.storedOn] : undefined
            const local = Object.values(now.diskDB).filter(d => d.device != null && String(d.dockedTo) === String(getLocalEngine(now)?.id)) as Disk[]
            const candidates = [...(prev ? [prev as Disk] : []), ...local.filter(d => String(d.id) !== String(prev?.id))]
            await ensureAppFilesOnTarget(String(instance.instanceOf), (instance.serviceImages ?? []).map(String), targetDisk, candidates)
        }

        // engine#418: explicit restore-reclaim, so the instance is re-homed onto the
        // target when its storedOn disk is lost, or docked here and stopped.
        const { processInstance } = await import('../data/Disk.js')
        await processInstance(storeHandle, targetDisk, instanceId, { reclaim: 'restore' })
        // engine#418: fail closed. Never report ok while the record names another disk.
        const registeredOn = getInstance(storeHandle.doc(), instanceId)?.storedOn
        if (String(registeredOn) !== String(targetDisk.id)) {
            const q = await quarantineUnclaimedTarget(targetDisk, instanceId)
            const where = q ? `the restored copy is quarantined at ${q}` : `the restored copy could not be quarantined and is still in instances/${instanceId}`
            throw new Error(`RESTORE_NOT_CLAIMED: restored files to ${targetDisk.name} but the instance remains on ${registeredOn ?? 'no disk'}; ${where}`)
        }
        await quarantinePreRestore(storeHandle.doc(), instanceId, targetDisk, prevDisk)

        // engine#413: running in, running out (same as moveApp, idea#474). An
        // instance that was Stopped before the restore stays Stopped. The cause is
        // an Engine cause, not an operator one, so it never counts as a user start.
        if (wasRunning) {
            const restored = getInstance(storeHandle.doc(), instanceId)
            // engine#418: never start an instance on a disk that is not its storedOn
            if (restored && String(restored.storedOn) !== String(targetDisk.id)) {
                log(`restoreApp: not restarting ${instanceId} on ${targetDisk.name}; it is stored on ${restored.storedOn ?? 'no disk'} (engine#418)`)
            } else if (restored) {
                log(`Starting restored instance ${instanceId} on disk ${targetDisk.name} (it was Running before the restore)`)
                await backupLifecycle.startInstance(storeHandle, restored, targetDisk, RESTORE_POST_START_CAUSE)
                // startInstance records a failed start as Error and does not throw.
                // engine#428: a port-ready timeout keeps the Operation Done with a
                // START_PENDING trace. engine#468: any other failed start fails the
                // restore (RESTORE_START_FAILED); the restored files stay in place.
                const after = getInstance(storeHandle.doc(), instanceId)
                const outcome = restoreStartOutcome(after, String(targetDisk.name))
                if (outcome.kind === 'pending') recordRestoreStartPending(after!)
                else if (outcome.kind === 'failed') throw new Error(outcome.message)
            }
        }

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`Restore of instance ${instanceId} to disk ${targetDisk.name} completed`))

    } catch (e: any) {
        updateOperation(storeHandle, opId, {
            status: 'Failed',
            error: e.message ?? String(e),
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.red(`Restore of instance ${instanceId} failed: ${e.message ?? e}`))
        throw e
    } finally {
        resourceLock.releaseAll(restoreLockKeys)
        endUsageSkip('backup')
    }
}

// ── createBackupDisk ──────────────────────────────────────────────────────────

/**
 * Write BACKUP.yaml on a disk and trigger processDisk to register it as a Backup Disk.
 * Links that were already in the file keep their lastBackup (idea#451).
 * Called by the createBackupDisk command from Console.
 */
export const createBackupDiskConfig = async (
    storeHandle: DocHandle<Store>,
    disk: Disk,
    mode: BackupMode,
    instanceIds: InstanceID[]
): Promise<void> => {
    if (!disk.device) throw new Error(`createBackupDiskConfig: disk ${disk.id} is not docked`)

    // idea#451 (Steve, decision 6): a link that is kept keeps its lastBackup; new links start at 0.
    // idea#400: an existing BACKUP.yaml is edited as a document, so lastRun, the uptime
    // counter, unknown keys and an existing schedule stay. A scheduled disk without a valid
    // schedule gets 02:30.
    const previous = await readBackupYamlState(disk.device)
    const kept = new Map<string, number>()
    for (const l of previous?.links ?? []) kept.set(String(l.instanceId), l.lastBackup)
    const links = instanceIds.map(id => ({ instanceId: id, lastBackup: kept.get(String(id)) ?? 0 }))
    const schedule = mode === 'scheduled' ? { daily: previous?.schedule?.daily ?? DEFAULT_BACKUP_TIME } : null

    let edited = false
    try {
        edited = await editBackupYaml(disk.device, doc => {
            doc.set('mode', mode)
            doc.set('links', doc.createNode(links))
            // other modes keep an existing schedule, so switching back to scheduled keeps the time
            if (schedule && !doc.has('schedule')) doc.set('schedule', doc.createNode(schedule))
            else if (schedule && previous?.scheduleError) doc.set('schedule', doc.createNode(schedule))
        })
    } catch (e: any) {
        log(chalk.yellow(`createBackupDisk: existing BACKUP.yaml on ${disk.name} is not a mapping (${e?.message ?? e}); writing a new one`))
    }
    if (!edited) {
        const fresh: BackupYaml = { mode, links, ...(schedule ? { schedule } : {}) }
        await writeBackupYaml(disk.device, fresh)
    }
    log(`Written BACKUP.yaml to disk ${disk.name} (mode: ${mode}${schedule ? ` at ${schedule.daily}` : ''}, links: ${instanceIds.join(', ')})`)

    // Re-process the disk so diskTypes and backupConfig are set in the store
    await processDisk(storeHandle, disk)
}
