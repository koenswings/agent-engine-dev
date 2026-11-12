/**
 * backupMonitor.ts — Backup Disk processing, backup/restore operations
 *
 * Design: design/backup-disk.md
 *
 * Key design points:
 *  - BorgBackup for deduplicating, atomic, resumable archives
 *  - activeBackups Set prevents double-backup on reboot race
 *  - Lock file (.backup-in-progress) marks an interrupted backup; idea#446 records
 *    it on Disk.backupStaleLocks at dock/boot and does not auto-retry (clearBackupLock
 *    then an explicit backupApp resumes it)
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
import { Disk, BackupConfig, isBackupDisk, processDisk, diskMountRoot, appDataRoot, joinMountRoot } from '../data/Disk.js'
import { AppDataRunner, runAppData, borgInitArgs, borgInfoArgs, borgCreateArgs, borgExtractArgs, borgProblem, helperAtLeast } from '../utils/appDataHelper.js'
import { parseBackupExcludeList, parseBackupHookExcludeList, mergeBackupExcludeLists, BACKUP_EXCLUDE_HELPER_MIN } from '../utils/backupExclude.js'
import { backupCleanupRunner, backupDiskFullError, cleanupIsEnabled } from '../utils/backupCleanup.js'
import { parseBackupSpec, assertHookServicesExist, backupHookRunner, defaultBackupSpec } from '../utils/backupMethod.js'
import { indexBackupDiskApps } from '../data/InstallApp.js'
import { ensureAppFilesOnTarget } from '../data/RestoreAppFiles.js'
import { localEngineId } from '../data/Engine.js'
import { assertPreQuarantineHelper, quarantinePreRestore } from '../data/RestorePreQuarantine.js'
import { createOperation, updateOperation } from '../data/Operations.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { stopInstance as stopInstanceImpl, startInstance as startInstanceImpl, BACKUP_STEPS } from '../data/Instance.js'

/** Tests replace stop/start. Production uses Instance.ts. */
export const backupLifecycle = {
    stopInstance: stopInstanceImpl,
    startInstance: startInstanceImpl,
}
import { BackupMode, DiskID, DiskName, InstanceID, Timestamp, OperationCause, Operation } from '../data/CommonTypes.js'
import { Store, getInstance, getDisks, findDiskByName, getLocalEngine } from '../data/Store.js'
import { DocHandle } from '@automerge/automerge-repo'
import { getCommandLogHandle, addTrace, closeTrace } from '../data/CommandLogStore.js'
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
}

const BACKUP_YAML = 'BACKUP.yaml'
export const BACKUP_IN_PROGRESS = '.backup-in-progress'
const LOCK_FILE = BACKUP_IN_PROGRESS

/** True while backupInstance holds the in-memory mutex for this instance. */
export const isBackupActive = (instanceId: string): boolean => activeBackups.has(instanceId as InstanceID)

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
 * Scan backups/ for leftover .backup-in-progress files and record them on
 * Disk.backupStaleLocks. Does not start a backup (idea#446).
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
                log(`Stale lock file found for instance ${entry} on Backup Disk ${backupDisk.id} — recorded, not retried (idea#446)`)
            }
        }
    }
    storeHandle.change(doc => {
        const d = doc.diskDB[backupDisk.id]
        if (d) d.backupStaleLocks = found
    })
}

/** Drop one instance's entry from Disk.backupStaleLocks after clearBackupLock. Never assign undefined. */
export const clearBackupStaleLock = (storeHandle: DocHandle<Store>, diskId: string, instanceId: string): void => {
    storeHandle.change(doc => {
        const d = doc.diskDB[diskId]
        if (!d) return
        d.backupStaleLocks = (d.backupStaleLocks ?? []).filter(l => String(l.instanceId) !== String(instanceId))
    })
}

export const hasBackupStaleLock = (disk: Disk, instanceId: string): boolean =>
    (disk.backupStaleLocks ?? []).some(l => String(l.instanceId) === String(instanceId))


// ── Helpers ──────────────────────────────────────────────────────────────────

const backupDir = (backupDevice: string, instanceId: InstanceID) =>
    `${disksRoot()}/${backupDevice}/backups/${instanceId}`

const lockFilePath = (backupDevice: string, instanceId: InstanceID) =>
    `${backupDir(backupDevice, instanceId)}/${LOCK_FILE}`

const readBackupYaml = async (backupDevice: string): Promise<BackupYaml | null> => {
    try {
        const raw = await fs.readFile(`${disksRoot()}/${backupDevice}/${BACKUP_YAML}`, 'utf-8')
        return YAML.parse(raw) as BackupYaml
    } catch {
        return null
    }
}

const writeBackupYaml = async (backupDevice: string, yaml: BackupYaml): Promise<void> => {
    await fs.writeFile(`${disksRoot()}/${backupDevice}/${BACKUP_YAML}`, YAML.stringify(yaml))
}

// ── Core backup logic ─────────────────────────────────────────────────────────

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
): Promise<void> => {
    // If there is no active trace (called from backup monitor, not via Console command),
    // create one so that step markers and log lines land in the Console log panel.
    if (!getActiveTrace()) {
        const cmdLogHandle = getCommandLogHandle()
        const traceId = crypto.randomUUID()
        const traceArgs = JSON.stringify({ instanceId, backupDiskId: backupDisk.id, cause })
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

    // Take the instance lock and the Backup Disk lock together, as restore does
    // (idea#126, Files Disk step 0): nothing else may change the instance or the
    // Backup Disk (eject, erase, another backup or restore) while Borg writes.
    const backupLockKeys = backupLockKeysFor(instanceId, backupDisk.id)
    if (!resourceLock.acquireAll(backupLockKeys, 'backupApp')) {
        activeBackups.delete(instanceId)
        const held = backupLockKeys.map(k => resourceLock.getLockInfo(k)).find(Boolean)
        throw new Error(`Backup of instance ${instanceId} to disk ${backupDisk.id} not started: the instance or the Backup Disk is locked${held ? ` by '${held.kind}'` : ''} (another operation is running)`)
    }

    const opId = existingOpId ?? createOperation(storeHandle, 'backupApp', {
        instanceId,
        backupDiskId: backupDisk.id,
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
        if (!appDisk || !appDisk.device) {
            throw new Error(`App Disk for instance ${instanceId} is not docked`)
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

        // 0. Preflight: no borg means exit 127 from the helper; say so plainly instead
        if (!skipBorg()) {
            const borgMissing = borgProblem()
            if (borgMissing) throw new Error(borgMissing)
        }

        // 0b. Honour x-app.backup.exclude (idea#443) and x-app.backup.method
        // (idea#444). Fail closed: a non-empty exclude list on a helper older
        // than v8, or a malformed method/hook block, refuses before any hook
        // or stop, and without writing lastBackup.
        const composePath = joinMountRoot(await diskMountRoot(appDisk as Disk), 'instances', instanceId, 'compose.yaml')
        const instanceDir = joinMountRoot(await diskMountRoot(appDisk as Disk), 'instances', instanceId)
        let backupExcludes: string[] = []
        let hookExcludes: string[] = []
        let backupSpec = defaultBackupSpec()
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
        if ((backupExcludes.length || hookExcludes.length) && !skipBorg()) {
            const helper = await helperAtLeast(BACKUP_EXCLUDE_HELPER_MIN, 'backupApp with x-app.backup.exclude')
            if (helper) throw new Error(`HELPER_OUTDATED: ${helper}`)
        }

        // 0c. Fullness cleanup (idea#401, helper v9) before any hook or stop.
        // An older helper skips cleanup and the backup still runs.
        let cleanupWarning: string | null = null
        const backupMountRoot = joinMountRoot(await diskMountRoot(backupDisk as Disk))
        if (cleanupIsEnabled()) {
            const before = await backupCleanupRunner.run({
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
        await fs.writeFile(lockPath, JSON.stringify({ instanceId, startedAt: Date.now() }))

        const wasRunningAtStart = instance.status === 'Running'
        let hookResult: 'stop' | 'hook' | 'HOOK_FALLBACK' = 'stop'
        let hookWarning: string | null = null

        const runDeclaredHook = async (
            hook: typeof backupSpec.preHook,
            _which: 'preHook' | 'postHook',
        ): Promise<{ failed: boolean, timedOut: boolean, code: number, stderr: string }> => {
            if (!hook) return { failed: false, timedOut: false, code: 0, stderr: '' }
            try {
                const r = await backupHookRunner.run({
                    cwd: instanceDir,
                    timeoutS: backupSpec.hookTimeout,
                    service: hook.service,
                    command: hook.command,
                    user: hook.user,
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

        const runBorgCreate = async (excludes: string[]): Promise<void> => {
            setBackupStep(2, BACKUP_STEPS[2])
            const archiveName = new Date().toISOString().replace(/[:.]/g, '-')
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
            }
        }

        // 3–5. Copy: method hook runs preHook (no stop) then borg then postHook;
        // a failed/timed-out preHook always runs postHook, then either HOOK_FALLBACK
        // (short stop) or HOOK_FAILED (no stop), per x-app.backup.fallback.
        if (backupSpec.method === 'hook') {
            setBackupStep(1, 'Running pre-backup hook')
            const pre = await runDeclaredHook(backupSpec.preHook, 'preHook')
            if (!pre.failed) {
                hookResult = 'hook'
                await runBorgCreate(mergeBackupExcludeLists(backupExcludes, hookExcludes))
                setBackupStep(3, 'Running post-backup hook')
                const post = await runDeclaredHook(backupSpec.postHook, 'postHook')
                if (post.failed) {
                    hookWarning = `HOOK_POST_WARNING: ${hookFailureMessage('postHook', post)}`
                    log(chalk.yellow(`Backup of ${instanceId} succeeded with a postHook warning: ${hookWarning}`))
                }
            } else {
                const post = await runDeclaredHook(backupSpec.postHook, 'postHook')
                if (post.failed) {
                    log(chalk.yellow(`postHook failed after a failed preHook on ${instanceId}: ${hookFailureMessage('postHook', post)}`))
                }
                if (backupSpec.fallback === 'fail') {
                    throw new Error(`HOOK_FAILED: ${hookFailureMessage('preHook', pre)}`)
                }
                hookResult = 'HOOK_FALLBACK'
                log(`HOOK_FALLBACK: ${hookFailureMessage('preHook', pre)}; falling back to a short stop`)
                await stopThenStartAround(() => runBorgCreate(backupExcludes))
            }
        } else {
            await stopThenStartAround(() => runBorgCreate(backupExcludes))
        }

        // 6. Update store: set lastBackup on the instance
        setBackupStep(4, BACKUP_STEPS[4])
        storeHandle.change(doc => {
            const inst = doc.instanceDB[instanceId]
            if (inst) inst.lastBackup = Date.now() as Timestamp
        })

        // 7. Update BACKUP.yaml on the disk
        const yaml = await readBackupYaml(backupDevice)
        if (yaml) {
            const link = yaml.links.find(l => l.instanceId === instanceId)
            if (link) {
                link.lastBackup = Date.now()
            }
            await writeBackupYaml(backupDevice, yaml)
        }

        // 8. Remove lock file (success)
        await fs.remove(lockPath)

        if (cleanupIsEnabled()) {
            const after = await backupCleanupRunner.run({
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
            if (hookWarning) op.args.warning = hookWarning
            if (cleanupWarning) op.args.cleanup = cleanupWarning as string
        })
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
        // Always restart instance if this run stopped it (even on failure)
        if (didStop) {
            try {
                const store = storeHandle.doc()
                const instance = getInstance(store, instanceId)
                const appDisk = instance?.storedOn ? store.diskDB[instance.storedOn] : null
                if (instance && appDisk) {
                    log(`Restarting instance ${instanceId} after failed backup`)
                    await backupLifecycle.startInstance(storeHandle, instance, appDisk, 'backup-post-start')
                }
            } catch (restartErr) {
                log(chalk.red(`Failed to restart instance ${instanceId} after backup error: ${restartErr}`))
            }
        }
        // Lock file intentionally left in place — signals boot-resume on next dock
        // Rethrow so the backup's trace ends with status 'error' and this message
        throw e
    } finally {
        activeBackups.delete(instanceId)
        resourceLock.releaseAll(backupLockKeys)
        endUsageSkip('backup')
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
 * - Scans for stale lock files and records them on Disk.backupStaleLocks (no auto-retry, idea#446)
 * - Triggers backupInstance for immediate mode (linked instances without a stale lock)
 */
export const processBackupDisk = async (
    storeHandle: DocHandle<Store>,
    backupDisk: Disk
): Promise<void> => {
    const backupDevice = backupDisk.device!
    log(`Processing Backup Disk ${backupDisk.id} on device ${backupDevice}`)

    const yaml = await readBackupYaml(backupDevice)
    if (!yaml) {
        log(`No BACKUP.yaml found on disk ${backupDisk.id} — skipping backup processing`)
        return
    }

    const mode = yaml.mode
    const links = yaml.links.map(l => l.instanceId as InstanceID)

    // Set backupConfig in store
    storeHandle.change(doc => {
        const d = doc.diskDB[backupDisk.id]
        if (d) d.backupConfig = { mode, links }
    })

    // Phase 2: index any app bundles on this disk into appDB for installApp / Console
    await indexBackupDiskApps(storeHandle, backupDisk)

    // Scan for stale lock files (interrupted backups). Record only; do not re-run backupApp (idea#446).
    await recordBackupStaleLocks(storeHandle, backupDisk)

    // Trigger immediate backups for linked instances whose App Disk is docked and that have no stale lock
    if (mode === 'immediate') {
        const store = storeHandle.doc()
        const staleIds = new Set((store.diskDB[backupDisk.id]?.backupStaleLocks ?? []).map(l => String(l.instanceId)))
        for (const instanceId of links) {
            if (staleIds.has(String(instanceId))) {
                log(`Instance ${instanceId}: stale lock present — not auto-backing up; use clearBackupLock then backupApp (idea#446)`)
                continue
            }
            const instance = getInstance(store, instanceId)
            if (!instance?.storedOn) continue
            const appDisk = store.diskDB[instance.storedOn]
            if (appDisk?.device) {
                await triggerBackup(storeHandle, instanceId, backupDisk, 'console-command')
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

    // Find all currently docked Backup Disks
    const dockedDisks = Object.values(store.diskDB).filter(d => d.device != null)
    for (const candidate of dockedDisks) {
        if (!candidate.diskTypes?.includes('backup')) continue
        if (!candidate.backupConfig) continue
        if (candidate.backupConfig.mode !== 'immediate') continue

        // Check if any linked instance lives on the newly docked App Disk
        const instancesOnAppDisk = Object.values(store.instanceDB)
            .filter(inst => String(inst.storedOn) === String(appDisk.id))

        const staleIds = new Set((candidate.backupStaleLocks ?? []).map(l => String(l.instanceId)))
        for (const instance of instancesOnAppDisk) {
            if (!candidate.backupConfig.links.includes(instance.id)) continue
            const lockPath = candidate.device
                ? `${disksRoot()}/${candidate.device}/backups/${instance.id}/${LOCK_FILE}`
                : ''
            if (staleIds.has(String(instance.id)) || (lockPath && await fs.pathExists(lockPath))) {
                log(`checkPendingBackups: stale lock for ${instance.id} — not auto-backing up; use clearBackupLock then backupApp (idea#446)`)
                continue
            }
            log(`checkPendingBackups: triggering backup for instance ${instance.id}`)
            await triggerBackup(storeHandle, instance.id, candidate as Disk, 'backup-app-docked')
        }
        // Stale .backup-in-progress locks are recorded on Disk.backupStaleLocks at
        // Backup Disk dock (processBackupDisk) and are not retried here (idea#446).
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

/**
 * Restore the latest archive for instanceId from any docked Backup Disk
 * onto targetDisk.
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

        // #190: restoring to another disk quarantines the old folder afterwards (helper v4)
        const prevDisk = await assertPreQuarantineHelper(store, instanceId, targetDisk, String(localEngineId))

        const repoPath = backupDir(backupDevice, instanceId)
        const instancesDir = `${await diskMountRoot(targetDisk)}/instances`

        // Stop instance if currently running
        const instance = getInstance(store, instanceId)
        if (instance?.status === 'Running') {
            const currentDisk = instance.storedOn ? store.diskDB[instance.storedOn] : null
            if (currentDisk) await backupLifecycle.stopInstance(storeHandle, instance, currentDisk, 'backup-pre-stop')
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

        const { processInstance } = await import('../data/Disk.js')
        await processInstance(storeHandle, targetDisk, instanceId)
        await quarantinePreRestore(storeHandle.doc(), instanceId, targetDisk, prevDisk)

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
 * Called by the createBackupDisk command from Console.
 */
export const createBackupDiskConfig = async (
    storeHandle: DocHandle<Store>,
    disk: Disk,
    mode: BackupMode,
    instanceIds: InstanceID[]
): Promise<void> => {
    if (!disk.device) throw new Error(`createBackupDiskConfig: disk ${disk.id} is not docked`)

    const yaml: BackupYaml = {
        mode,
        links: instanceIds.map(id => ({ instanceId: id, lastBackup: 0 }))
    }

    await writeBackupYaml(disk.device, yaml)
    log(`Written BACKUP.yaml to disk ${disk.name} (mode: ${mode}, links: ${instanceIds.join(', ')})`)

    // Re-process the disk so diskTypes and backupConfig are set in the store
    await processDisk(storeHandle, disk)
}
