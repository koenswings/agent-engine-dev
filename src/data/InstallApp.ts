/**
 * InstallApp.ts — Unified app installation command
 *
 * Design: design/install-app.md
 *
 * Replaces the old `createInstance` (GitHub-only) command with a unified
 * `installApp` that routes to the right source automatically:
 *
 *   --source given          → local copy from docked disk (offline-capable)
 *   --source omitted + net  → GitHub clone (existing buildInstance logic)
 *   --source omitted, no net, appDB has local source → auto-select local disk
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
import { Store, getDisk, findDiskByName } from './Store.js'
import { buildInstance } from './Instance.js'
import { AppID, AppName, DiskID, DiskName, InstanceName, Version } from './CommonTypes.js'
import { DocHandle } from '@automerge/automerge-repo'
import { Disk } from './Disk.js'
import { App, createOrUpdateApp } from './App.js'

// ── Internet probe ────────────────────────────────────────────────────────────

/**
 * Check internet availability with a short TCP connect to 1.1.1.1:53.
 * No HTTP request — no data sent. Timeout: 2 seconds.
 */
export const hasInternet = (): Promise<boolean> =>
    new Promise(resolve => {
        const socket = net.createConnection({ host: '1.1.1.1', port: 53 })
        const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 2000)
        socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
        socket.on('error', () => { clearTimeout(timer); resolve(false) })
    })

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
    const sourcePath = `/disks/${sourceDevice}/apps/${appId}`
    if (!await fs.pathExists(sourcePath)) {
        throw new Error(`App '${appId}' not found on disk '${sourceDisk.name}' at ${sourcePath}`)
    }

    // Ensure target has the required directory structure
    await fs.ensureDir(`/disks/${targetDevice}/apps`)
    await fs.ensureDir(`/disks/${targetDevice}/instances`)
    await fs.ensureDir(`/disks/${targetDevice}/services`)

    // Copy app bundle
    const targetAppPath = `/disks/${targetDevice}/apps/${appId}`
    log(`Copying app bundle: ${sourcePath} → ${targetAppPath}`)
    await fs.copy(sourcePath, targetAppPath, { overwrite: true })

    // Register app in store
    await createOrUpdateApp(storeHandle, appId, targetDisk)

    // Generate a fresh instance ID and create the instance directory
    const { uuid } = await import('../utils/utils.js')
    const instanceId = uuid()

    const sourceInstanceBase = `/disks/${sourceDevice}/instances`
    const targetInstanceBase = `/disks/${targetDevice}/instances`

    // If source has an instance of this app, copy its data as the starting point
    let sourceInstanceId: string | null = null
    if (await fs.pathExists(sourceInstanceBase)) {
        const store = storeHandle.doc()
        const sourceInstance = Object.values(store.instanceDB).find(
            i => i.instanceOf === appId && i.storedOn === sourceDisk.id
        )
        if (sourceInstance) sourceInstanceId = sourceInstance.id
    }

    const instanceDir = `${targetInstanceBase}/${instanceId}`
    await fs.ensureDir(instanceDir)

    if (sourceInstanceId && await fs.pathExists(`${sourceInstanceBase}/${sourceInstanceId}`)) {
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
    targetDiskName: DiskName
    sourceDiskName?: DiskName    // --source flag; omit for auto-routing
    instanceName?: InstanceName  // --name flag; defaults to appId
    gitAccount?: string          // for GitHub path; defaults to 'koenswings'
}

/**
 * Unified installApp — routes to local or GitHub path based on --source and
 * internet availability.
 */
export const installApp = async (
    storeHandle: DocHandle<Store>,
    opts: InstallAppOptions
): Promise<void> => {
    const store = storeHandle.doc()
    const instanceName = (opts.instanceName ?? opts.appId) as InstanceName
    const gitAccount = opts.gitAccount ?? 'koenswings'

    // Resolve target disk
    const targetDisk = findDiskByName(store, opts.targetDiskName)
        ?? Object.values(store.diskDB).find(d => d.name === opts.targetDiskName)
    if (!targetDisk || !targetDisk.device) {
        console.error(chalk.red(`installApp: target disk '${opts.targetDiskName}' not found or not docked`))
        return
    }

    // ── Route 1: --source given → local path ──────────────────────────────
    if (opts.sourceDiskName) {
        const sourceDisk = findDiskByName(store, opts.sourceDiskName)
            ?? Object.values(store.diskDB).find(d => d.name === opts.sourceDiskName)
        if (!sourceDisk || !sourceDisk.device) {
            console.error(chalk.red(`installApp: source disk '${opts.sourceDiskName}' not found or not docked`))
            return
        }
        log(chalk.blue(`installApp: local path — source '${opts.sourceDiskName}'`))
        await installAppFromDisk(storeHandle, opts.appId, sourceDisk, targetDisk as Disk, instanceName)
        return
    }

    // ── Route 2/3: no --source → probe internet ───────────────────────────
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

    // Route 3: offline — look for a local source in appDB
    log(chalk.yellow(`installApp: no internet — searching appDB for local source of '${opts.appId}'`))
    const appEntry = store.appDB[opts.appId]
    if (appEntry && (appEntry as any).sourceDiskId) {
        const sourceDiskId: DiskID = (appEntry as any).sourceDiskId
        const sourceDisk = getDisk(store, sourceDiskId)
        if (sourceDisk?.device) {
            log(chalk.blue(`installApp: auto-selected source disk '${sourceDisk.name}'`))
            await installAppFromDisk(storeHandle, opts.appId, sourceDisk, targetDisk as Disk, instanceName)
            return
        }
    }

    // No local source found
    const appName = opts.appId.slice(0, opts.appId.lastIndexOf('-')) as AppName
    console.error(chalk.red(
        `installApp: App '${appName}' not found locally.\n` +
        `Insert a disk containing '${appName}' or connect to the internet.`
    ))
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

    const appsDir = `/disks/${device}/apps`
    if (!await fs.pathExists(appsDir)) {
        log(`indexBackupDiskApps: no apps/ directory on disk ${backupDisk.name}`)
        return
    }

    const appIds = (await fs.readdir(appsDir)) as AppID[]
    for (const appId of appIds) {
        if (!appId) continue
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
