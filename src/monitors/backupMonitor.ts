/**
 * backupMonitor.ts — Backup Disk processing, backup/restore operations
 *
 * Design: design/backup-disk.md
 *
 * Key design points:
 *  - BorgBackup for deduplicating, atomic, resumable archives
 *  - activeBackups Set prevents double-backup on reboot race
 *  - Lock file (.backup-in-progress) enables boot-resume after interrupted backup
 *  - testMode: skips borg commands but exercises all other logic (store updates, YAML, lock files)
 */

import { $, YAML, chalk, fs } from 'zx'
import { log } from '../utils/utils.js'
import { config } from '../data/Config.js'
import { Disk, BackupConfig, isBackupDisk, processDisk } from '../data/Disk.js'
import { stopInstance, startInstance } from '../data/Instance.js'
import { BackupMode, DiskID, DiskName, InstanceID, Timestamp } from '../data/CommonTypes.js'
import { Store, getInstance, getDisks, findDiskByName } from '../data/Store.js'
import { DocHandle } from '@automerge/automerge-repo'

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
const LOCK_FILE = '.backup-in-progress'

// ── Helpers ──────────────────────────────────────────────────────────────────

const backupDir = (backupDevice: string, instanceId: InstanceID) =>
    `/disks/${backupDevice}/backups/${instanceId}`

const lockFilePath = (backupDevice: string, instanceId: InstanceID) =>
    `${backupDir(backupDevice, instanceId)}/${LOCK_FILE}`

const readBackupYaml = async (backupDevice: string): Promise<BackupYaml | null> => {
    try {
        const raw = await fs.readFile(`/disks/${backupDevice}/${BACKUP_YAML}`, 'utf-8')
        return YAML.parse(raw) as BackupYaml
    } catch {
        return null
    }
}

const writeBackupYaml = async (backupDevice: string, yaml: BackupYaml): Promise<void> => {
    await fs.writeFile(`/disks/${backupDevice}/${BACKUP_YAML}`, YAML.stringify(yaml))
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
    backupDisk: Disk
): Promise<void> => {
    if (activeBackups.has(instanceId)) {
        log(`Backup for ${instanceId} already in progress — skipping duplicate trigger`)
        return
    }
    activeBackups.add(instanceId)
    let wasRunning = false

    try {
        const store = storeHandle.doc()
        const instance = getInstance(store, instanceId)
        if (!instance) {
            log(`backupInstance: instance ${instanceId} not found in store`)
            return
        }
        if (!instance.storedOn) {
            log(`backupInstance: instance ${instanceId} has no storedOn disk`)
            return
        }

        const appDisk = store.diskDB[instance.storedOn]
        if (!appDisk || !appDisk.device) {
            log(`backupInstance: App Disk for instance ${instanceId} is not docked`)
            return
        }

        const backupDevice = backupDisk.device!
        const appDevice = appDisk.device
        const repoPath = backupDir(backupDevice, instanceId)
        const lockPath = lockFilePath(backupDevice, instanceId)

        log(`Starting backup of instance ${instanceId} from ${appDevice} to ${backupDevice}`)

        // 1. Init Borg repo if this is the first backup
        const repoExists = await fs.pathExists(`${repoPath}/config`)
        if (!repoExists) {
            log(`Initialising Borg repo at ${repoPath}`)
            await fs.ensureDir(repoPath)
            if (!config.settings.testMode) {
                await $`borg init --encryption=none ${repoPath}`
            } else {
                log(`testMode: skipping borg init`)
            }
        }

        // 2. Write lock file (signals in-progress backup for boot-resume)
        await fs.writeFile(lockPath, JSON.stringify({ instanceId, startedAt: Date.now() }))

        // 3. Stop the instance if running (ensures filesystem consistency)
        if (instance.status === 'Running') {
            wasRunning = true
            log(`Stopping instance ${instanceId} before backup`)
            await stopInstance(storeHandle, instance, appDisk)
        }

        // 4. Run borg create
        const archiveName = new Date().toISOString().replace(/[:.]/g, '-')
        if (!config.settings.testMode) {
            log(`Running borg create for instance ${instanceId}`)
            await $`borg create ${repoPath}::${archiveName} /disks/${appDevice}/instances/${instanceId}`
        } else {
            log(`testMode: skipping borg create for instance ${instanceId}`)
        }

        // 5. Restart instance if it was running
        if (wasRunning) {
            log(`Restarting instance ${instanceId} after backup`)
            await startInstance(storeHandle, instance, appDisk)
        }

        // 6. Update store: set lastBackup on the instance
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

        log(chalk.green(`Backup of instance ${instanceId} completed successfully`))

    } catch (e: any) {
        log(chalk.red(`Backup of instance ${instanceId} failed: ${e.message ?? e}`))
        // Always restart instance if it was stopped (even on failure)
        if (wasRunning) {
            try {
                const store = storeHandle.doc()
                const instance = getInstance(store, instanceId)
                const appDisk = instance?.storedOn ? store.diskDB[instance.storedOn] : null
                if (instance && appDisk) {
                    log(`Restarting instance ${instanceId} after failed backup`)
                    await startInstance(storeHandle, instance, appDisk)
                }
            } catch (restartErr) {
                log(chalk.red(`Failed to restart instance ${instanceId} after backup error: ${restartErr}`))
            }
        }
        // Lock file intentionally left in place — signals boot-resume on next dock
    } finally {
        activeBackups.delete(instanceId)
    }
}

// ── Backup Disk processing ────────────────────────────────────────────────────

/**
 * Called by processDisk when a Backup Disk is detected.
 * - Reads BACKUP.yaml and sets backupConfig in the store
 * - Scans for stale lock files and re-queues interrupted backups
 * - Triggers backupInstance for immediate mode
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

    // Scan for stale lock files (interrupted backups from before a reboot)
    const backupsBase = `/disks/${backupDevice}/backups`
    if (await fs.pathExists(backupsBase)) {
        const entries = await fs.readdir(backupsBase)
        for (const entry of entries) {
            const lockPath = `${backupsBase}/${entry}/${LOCK_FILE}`
            if (await fs.pathExists(lockPath)) {
                const staleInstanceId = entry as InstanceID
                log(`Stale lock file found for instance ${staleInstanceId} — re-triggering backup`)
                const store = storeHandle.doc()
                const instance = getInstance(store, staleInstanceId)
                const appDiskDocked = instance?.storedOn
                    ? store.diskDB[instance.storedOn]?.device != null
                    : false
                if (appDiskDocked) {
                    await backupInstance(storeHandle, staleInstanceId, backupDisk)
                } else {
                    log(`App Disk for ${staleInstanceId} not yet docked — stale lock will be handled when App Disk docks`)
                }
            }
        }
    }

    // Trigger immediate backups for all linked instances whose App Disk is docked
    if (mode === 'immediate') {
        const store = storeHandle.doc()
        for (const instanceId of links) {
            const instance = getInstance(store, instanceId)
            if (!instance?.storedOn) continue
            const appDisk = store.diskDB[instance.storedOn]
            if (appDisk?.device) {
                await backupInstance(storeHandle, instanceId, backupDisk)
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
            .filter(inst => inst.storedOn === appDisk.id)

        for (const instance of instancesOnAppDisk) {
            if (candidate.backupConfig.links.includes(instance.id)) {
                log(`checkPendingBackups: triggering backup for instance ${instance.id}`)
                await backupInstance(storeHandle, instance.id, candidate as Disk)
            }
        }

        // Also check for stale locks for instances on this App Disk
        if (candidate.device) {
            const backupsBase = `/disks/${candidate.device}/backups`
            if (await fs.pathExists(backupsBase)) {
                const entries = await fs.readdir(backupsBase)
                for (const entry of entries) {
                    const lockPath = `${backupsBase}/${entry}/${LOCK_FILE}`
                    if (await fs.pathExists(lockPath)) {
                        const staleId = entry as InstanceID
                        const staleInstance = getInstance(store, staleId)
                        if (staleInstance?.storedOn === appDisk.id) {
                            log(`checkPendingBackups: stale lock for ${staleId} — re-triggering backup`)
                            await backupInstance(storeHandle, staleId, candidate as Disk)
                        }
                    }
                }
            }
        }
    }
}

// ── restoreApp ────────────────────────────────────────────────────────────────

/**
 * Restore the latest archive for instanceId from any docked Backup Disk
 * onto targetDisk.
 */
export const restoreApp = async (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    targetDisk: Disk
): Promise<void> => {
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
        log(chalk.red(`restoreApp: no docked Backup Disk with archives for instance ${instanceId}`))
        return
    }

    const backupDevice = backupDisk.device!
    const targetDevice = targetDisk.device
    if (!targetDevice) {
        log(chalk.red(`restoreApp: target disk ${targetDisk.id} is not docked`))
        return
    }

    const repoPath = backupDir(backupDevice, instanceId)
    const instancesDir = `/disks/${targetDevice}/instances`

    // Stop instance if currently running
    const instance = getInstance(store, instanceId)
    let wasRunning = false
    if (instance?.status === 'Running') {
        wasRunning = true
        const currentDisk = instance.storedOn ? store.diskDB[instance.storedOn] : null
        if (currentDisk) await stopInstance(storeHandle, instance, currentDisk)
    }

    await fs.ensureDir(instancesDir)

    if (!config.settings.testMode) {
        log(`Restoring instance ${instanceId} from ${backupDevice} to ${targetDevice}`)
        // borg extract extracts relative to cwd; use bash -c to cd first
        await $`bash -c ${'cd ' + instancesDir + ' && borg extract ' + repoPath + '::latest'}`
    } else {
        log(`testMode: skipping borg extract for instance ${instanceId}`)
    }

    // Register and start the restored instance
    const { processInstance } = await import('../data/Disk.js')
    await processInstance(storeHandle, targetDisk, instanceId)

    log(chalk.green(`Restore of instance ${instanceId} to disk ${targetDisk.name} completed`))
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
    if (!disk.device) {
        log(chalk.red(`createBackupDiskConfig: disk ${disk.id} is not docked`))
        return
    }

    const yaml: BackupYaml = {
        mode,
        links: instanceIds.map(id => ({ instanceId: id, lastBackup: 0 }))
    }

    await writeBackupYaml(disk.device, yaml)
    log(`Written BACKUP.yaml to disk ${disk.name} (mode: ${mode}, links: ${instanceIds.join(', ')})`)

    // Re-process the disk so diskTypes and backupConfig are set in the store
    await processDisk(storeHandle, disk)
}
