/**
 * InstallApp.ts — Unified app installation command
 *
 * Design: design/install-app.md
 *
 * Replaces the old `createInstance` (GitHub-only) command with a unified
 * `installApp` that routes to the right source automatically:
 *
 *   --source given + bundle present → local copy from docked disk (offline-capable)
 *   --source given but apps/<appId> missing → treat as omitted (Prefer A r31 stale catalog)
 *   --source omitted + net  → GitHub clone (existing buildInstance logic)
 *   --source omitted, no net, usable local source → auto-select docked disk with bundle
 *   --source omitted, no net, no local source → clear error
 *
 * Phases implemented here:
 *   Phase 1 — rename + alias + internet probe
 *   Phase 2 — appDB extension for Backup/Catalog Disks  (processBackupDiskApps)
 *   Phase 3 — source router + local install path
 */

import { chalk, fs } from 'zx'
import * as net from 'net'
import { log } from '../utils/utils.js'
import { Store, getDisk, getLocalEngine } from './Store.js'
import { resolveDiskArg } from './DiskArg.js'
import { buildInstance } from './Instance.js'
import { AppID, AppName, DiskID, DiskName, InstanceName, Version } from './CommonTypes.js'
import { DocHandle } from '@automerge/automerge-repo'
import { Disk, diskMountRoot } from './Disk.js'
import { App, createOrUpdateApp } from './App.js'
import { assertNoExternalLinks } from './InstanceCopy.js'

// ── Internet probe ────────────────────────────────────────────────────────────

/**
 * Check internet availability with a short TCP connect to 1.1.1.1:53.
 * No HTTP request — no data sent. Timeout: 2 seconds.
 */
export const hasInternet = (): Promise<boolean> => {
    // Test hook: Prefer A r31 unit coverage for offline alt-disk fallback
    if (process.env.IDEA_INSTALL_FORCE_OFFLINE === 'true') return Promise.resolve(false)
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '1.1.1.1', port: 53 })
        const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 2000)
        socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
        socket.on('error', () => { clearTimeout(timer); resolve(false) })
    })
}

// ── Local install path ────────────────────────────────────────────────────────

/**
 * Install an app from a local source disk onto a target disk.
 * Copies the app bundle (apps/<appId>/) and creates a fresh instance directory.
 * Uses the same processInstance flow as normal disk docking.
 */
export const installAppFromDisk = async (
    storeHandle: DocHandle<Store>,
    appId: AppID,
    sourceDisk: Disk,
    targetDisk: Disk,
    instanceName: InstanceName
): Promise<void> => {
    const sourceDevice = sourceDisk.device
    const targetDevice = targetDisk.device

    if (!sourceDevice) throw new Error(`Source disk '${sourceDisk.name}' is not docked`)
    if (!targetDevice) throw new Error(`Target disk '${targetDisk.name}' is not docked`)

    // Locate app bundle on source disk (App Disk: apps/<appId>/, Backup Disk: apps/<appId>/)
    const sourceMountRoot = await diskMountRoot(sourceDisk)
    const sourcePath = `${sourceMountRoot}/apps/${appId}`
    if (!await fs.pathExists(sourcePath)) {
        throw new Error(`App '${appId}' not found on disk '${sourceDisk.name}' at ${sourcePath}`)
    }

    // Generate a fresh instance ID
    const { uuid } = await import('../utils/utils.js')
    const instanceId = uuid()

    const sourceInstanceBase = `${sourceMountRoot}/instances`

    // If source has an instance of this app, copy its data as the starting point
    let sourceInstanceId: string | null = null
    if (await fs.pathExists(sourceInstanceBase)) {
        const store = storeHandle.doc()
        const sourceInstance = Object.values(store.instanceDB).find(
            i => String(i.instanceOf) === String(appId) && String(i.storedOn) === String(sourceDisk.id)
        )
        if (sourceInstance) sourceInstanceId = sourceInstance.id
    }

    // Refuse source instance data that links off the disk (idea#168 r35) before
    // anything is written to the target: fs.copy reproduces a link verbatim, so the new
    // instance would share the source instance's data.
    const copyFromSourceInstance = !!sourceInstanceId && await fs.pathExists(`${sourceInstanceBase}/${sourceInstanceId}`)
    if (copyFromSourceInstance) {
        await assertNoExternalLinks('installApp', `${sourceInstanceBase}/${sourceInstanceId}`, sourceDisk)
    }

    // Ensure target has the required directory structure
    const targetMountRoot = await diskMountRoot(targetDisk)
    const targetInstanceBase = `${targetMountRoot}/instances`
    await fs.ensureDir(`${targetMountRoot}/apps`)
    await fs.ensureDir(`${targetMountRoot}/instances`)
    await fs.ensureDir(`${targetMountRoot}/services`)

    // Copy app bundle
    const targetAppPath = `${targetMountRoot}/apps/${appId}`
    log(`Copying app bundle: ${sourcePath} → ${targetAppPath}`)
    await fs.copy(sourcePath, targetAppPath, { overwrite: true })

    // Register app in store
    await createOrUpdateApp(storeHandle, appId, targetDisk)

    const instanceDir = `${targetInstanceBase}/${instanceId}`
    await fs.ensureDir(instanceDir)

    if (copyFromSourceInstance) {
        log(`Copying instance data from ${sourceInstanceId} to new instance ${instanceId}`)
        await fs.copy(`${sourceInstanceBase}/${sourceInstanceId}`, instanceDir, { overwrite: true })
    } else {
        // No existing instance data — copy compose.yaml from app bundle as baseline
        const composeSrc = `${targetAppPath}/compose.yaml`
        if (await fs.pathExists(composeSrc)) {
            await fs.copy(composeSrc, `${instanceDir}/compose.yaml`)
        }
    }

    // processInstance registers the new instance in the store and starts it
    const { processInstance } = await import('./Disk.js')
    await processInstance(storeHandle, targetDisk, instanceId as any)

    log(chalk.green(`installApp: installed '${appId}' as instance '${instanceName}' on disk '${targetDisk.name}'`))
}

// ── Source router ─────────────────────────────────────────────────────────────

export interface InstallAppOptions {
    appId: AppID
    targetDiskId: string         // disk id (a unique disk name still resolves, deprecated; idea#128)
    sourceDiskId?: string        // --source flag; omit for auto-routing
    instanceName?: InstanceName  // --name flag; defaults to appId
    gitAccount?: string          // for GitHub path; defaults to 'koenswings'
}

/**
 * Unified installApp — routes to local or GitHub path based on --source and
 * internet availability.
 */
/** True when docked disk still has apps/<appId> on disk (not stale appDB). */
const diskHasAppBundle = async (disk: Disk, appId: AppID): Promise<boolean> => {
    if (!disk.device) return false
    const root = await diskMountRoot(disk)
    return fs.pathExists(`${root}/apps/${appId}`)
}

/**
 * Prefer A r31: find a docked disk that still has apps/<appId>.
 * Skips stale backup/empty sources that appDB may still advertise.
 */
const findDockedDiskWithApp = async (store: Store, appId: AppID, excludeDiskId?: string): Promise<Disk | undefined> => {
    for (const disk of Object.values(store.diskDB) as Disk[]) {
        if (!disk?.device) continue
        if (excludeDiskId && String(disk.id) === String(excludeDiskId)) continue
        if (await diskHasAppBundle(disk, appId)) return disk
    }
    return undefined
}

export const installApp = async (
    storeHandle: DocHandle<Store>,
    opts: InstallAppOptions
): Promise<void> => {
    const store = storeHandle.doc()
    const instanceName = (opts.instanceName ?? opts.appId) as InstanceName
    const gitAccount = opts.gitAccount ?? 'koenswings'

    // Resolve the disks on this engine (idea#128): by id, or a unique docked name
    // with a deprecation warning; refusals throw so the trace ends as `error`
    const engineId = getLocalEngine(store)?.id
    const targetDisk = resolveDiskArg(store, engineId, opts.targetDiskId, 'installApp')

    // ── Route 1: --source given → local path if bundle still present ───────
    // Prefer A r31: Console EmptyDiskPanel may pass stale appDB.sourceDiskId
    // (e.g. empty-001 after make_backup wiped apps/). Missing bundle → fall
    // through to GitHub (online) or another docked disk that still has apps/.
    if (opts.sourceDiskId) {
        const sourceDisk = resolveDiskArg(store, engineId, opts.sourceDiskId, 'installApp --source')
        if (await diskHasAppBundle(sourceDisk as Disk, opts.appId)) {
            log(chalk.blue(`installApp: local path — source '${sourceDisk.name}' (${sourceDisk.id})`))
            await installAppFromDisk(storeHandle, opts.appId, sourceDisk as Disk, targetDisk as Disk, instanceName)
            return
        }
        log(chalk.yellow(
            `installApp: --source '${sourceDisk.name}' (${sourceDisk.id}) has no apps/${opts.appId} — ` +
            `stale catalog pointer; falling back to GitHub / other docked disks`
        ))
    }

    // ── Route 2/3: no usable --source → probe internet ────────────────────
    const online = await hasInternet()

    if (online) {
        // Route 2: GitHub path (existing buildInstance logic)
        log(chalk.blue(`installApp: GitHub path (internet available)`))
        const appName = opts.appId.slice(0, opts.appId.lastIndexOf('-')) as AppName
        const version = opts.appId.slice(opts.appId.lastIndexOf('-') + 1) as Version
        const targetDevice = targetDisk.device!
        await buildInstance(instanceName, appName, gitAccount, version, targetDevice as any)
        return
    }

    // Route 3: offline — appDB pointer only if bundle still on that disk; else scan docked disks
    log(chalk.yellow(`installApp: no internet — searching for local source of '${opts.appId}'`))
    const appEntry = store.appDB[opts.appId]
    if (appEntry && (appEntry as any).sourceDiskId) {
        const sourceDiskId: DiskID = (appEntry as any).sourceDiskId
        const sourceDisk = getDisk(store, sourceDiskId)
        if (sourceDisk?.device && await diskHasAppBundle(sourceDisk as Disk, opts.appId)) {
            log(chalk.blue(`installApp: auto-selected source disk '${sourceDisk.name}'`))
            await installAppFromDisk(storeHandle, opts.appId, sourceDisk as Disk, targetDisk as Disk, instanceName)
            return
        }
    }

    const alt = await findDockedDiskWithApp(store, opts.appId, String(targetDisk.id))
    if (alt) {
        log(chalk.blue(`installApp: found apps/${opts.appId} on docked disk '${alt.name}' (${alt.id})`))
        await installAppFromDisk(storeHandle, opts.appId, alt, targetDisk as Disk, instanceName)
        return
    }

    // No local source found
    const appName = opts.appId.slice(0, opts.appId.lastIndexOf('-')) as AppName
    throw new Error(
        `installApp: App '${appName}' not found locally. ` +
        `Insert a disk containing '${appName}' or connect to the internet.`
    )
}

// ── Phase 2: appDB population for Backup/Catalog Disks ───────────────────────

/**
 * Called from processBackupDisk to index all app bundles on a Backup or Catalog
 * Disk into appDB with a sourceDiskId field, making them visible to installApp
 * and the Console install dialog.
 *
 * A Catalog Disk is implemented as a Backup Disk with on-demand mode, so this
 * function handles both types identically.
 */
export const indexBackupDiskApps = async (
    storeHandle: DocHandle<Store>,
    backupDisk: Disk
): Promise<void> => {
    const device = backupDisk.device
    if (!device) return

    const appsDir = `${await diskMountRoot(backupDisk)}/apps`
    if (!await fs.pathExists(appsDir)) {
        log(`indexBackupDiskApps: no apps/ directory on disk ${backupDisk.name}`)
        clearStaleSourcePointers(storeHandle, backupDisk)
        return
    }

    const appIds = ((await fs.readdir(appsDir)) as AppID[]).filter(Boolean)
    if (appIds.length === 0) {
        log(`indexBackupDiskApps: empty apps/ on disk ${backupDisk.name} — clearing stale source pointers`)
        clearStaleSourcePointers(storeHandle, backupDisk)
        return
    }

    for (const appId of appIds) {
        try {
            // Register in appDB using existing createOrUpdateApp (reads compose.yaml for metadata)
            await createOrUpdateApp(storeHandle, appId, backupDisk)

            // Extend the appDB entry with sourceDiskId so installApp can locate it
            storeHandle.change(doc => {
                const entry = doc.appDB[appId] as any
                if (entry) {
                    entry.source = 'disk'
                    entry.sourceDiskId = backupDisk.id
                    entry.sourceDiskName = backupDisk.name
                }
            })
            log(`indexBackupDiskApps: indexed '${appId}' from disk '${backupDisk.name}'`)
        } catch (e: any) {
            log(chalk.yellow(`indexBackupDiskApps: skipping '${appId}' — ${e.message}`))
        }
    }
}

/**
 * Prefer A r31: when a Backup/Catalog disk no longer has apps/, drop appDB
 * sourceDiskId pointers at this disk so Console omits stale --source and
 * installApp can GitHub-route (or pick a docked disk that still has the bundle).
 */
export const clearStaleSourcePointers = (
    storeHandle: DocHandle<Store>,
    backupDisk: Disk
): void => {
    storeHandle.change(doc => {
        for (const appId of Object.keys(doc.appDB)) {
            const entry = doc.appDB[appId as AppID] as any
            if (!entry) continue
            if (String(entry.sourceDiskId) !== String(backupDisk.id)) continue
            delete entry.source
            delete entry.sourceDiskId
            delete entry.sourceDiskName
            log(`clearStaleSourcePointers: cleared source for '${appId}' (was disk '${backupDisk.name}')`)
        }
    })
}
