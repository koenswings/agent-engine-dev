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
import { buildInstance, versionDirName } from './Instance.js'
import { parseAppId } from './App.js'
import { AppID, AppName, DiskID, DiskName, InstanceName, Version } from './CommonTypes.js'
import { DocHandle } from '@automerge/automerge-repo'
import { Disk, diskMountRoot } from './Disk.js'
import { App, createOrUpdateApp } from './App.js'
import { assertNoExternalLinks, setComposeInstanceName } from './InstanceCopy.js'
import { splitArgs } from '../utils/commandUtils.js'
import { assertSameDockAfterWait, dockIdentityOf, trackInFlight } from './InstanceInFlight.js'

// ── Internet probe ────────────────────────────────────────────────────────────

/**
 * Check internet availability with a short TCP connect to 1.1.1.1:53.
 * No HTTP request — no data sent. Timeout: 2 seconds.
 */
export const hasInternet = (): Promise<boolean> => {
    // Test hook: Prefer A r31 unit coverage for offline alt-disk fallback
    if (process.env.IDEA_INSTALL_FORCE_OFFLINE === 'true') return Promise.resolve(false)
    // Test hook: idea#168 r81 unit coverage for the GitHub route without a network probe
    if (process.env.IDEA_INSTALL_FORCE_ONLINE === 'true') return Promise.resolve(true)
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '1.1.1.1', port: 53 })
        const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 2000)
        socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
        socket.on('error', () => { clearTimeout(timer); resolve(false) })
    })
}

// ── Arguments and name checks (Kid, idea#235) ────────────────────────────────

export const INSTALL_APP_USAGE = 'Usage: installApp <appId> <targetDiskId> [--source <sourceDiskId>] [--name <instanceName>] [--fresh]'

/** Longest display name accepted by installApp --name. */
export const MAX_INSTANCE_NAME_LENGTH = 64

/**
 * Check a display name for an instance: not empty or blank, at most
 * MAX_INSTANCE_NAME_LENGTH characters, no control characters (newlines, tabs).
 * Spaces are fine: the name only goes into x-app.instanceName and the store
 * record, never into the instance id, folder or Docker project name.
 */
export const validateInstanceName = (name: string): string => {
    if (name.trim().length === 0) throw new Error('installApp: --name must not be empty')
    if (name.length > MAX_INSTANCE_NAME_LENGTH) throw new Error(`installApp: --name is longer than ${MAX_INSTANCE_NAME_LENGTH} characters`)
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('installApp: --name must not contain control characters or newlines')
    return name
}

export interface ParsedInstallAppArgs {
    appId: AppID
    targetDiskId: string
    sourceDiskId?: string
    instanceName?: InstanceName
    fresh: boolean
}

/**
 * Parse the installApp argument line with the quote-aware splitArgs, so
 * `--name "Kolibri Demo"` is one value. Unquoted lines parse as before.
 */
export const parseInstallAppArgs = (argsString: string): ParsedInstallAppArgs => {
    const parts = splitArgs((argsString ?? '').trim())
    const appId = parts[0] as AppID
    const targetDiskId = parts[1]
    if (!appId || !targetDiskId || targetDiskId.startsWith('--')) throw new Error(INSTALL_APP_USAGE)
    const known = new Set(['--source', '--name', '--fresh'])
    for (let i = 2; i < parts.length; i++) {
        const p = parts[i]
        if (p === '--fresh') continue
        if (p === '--source' || p === '--name') { i++; continue }
        throw new Error(`installApp: unexpected argument '${p}'. ${INSTALL_APP_USAGE}`)
    }
    const flagValue = (flag: string): string | undefined => {
        const i = parts.indexOf(flag)
        if (i === -1) return undefined
        const v = parts[i + 1]
        if (v === undefined || known.has(v)) throw new Error(`installApp: ${flag} needs a value. ${INSTALL_APP_USAGE}`)
        return v
    }
    const name = flagValue('--name')
    return {
        appId,
        targetDiskId,
        sourceDiskId: flagValue('--source'),
        instanceName: name === undefined ? undefined : validateInstanceName(name) as InstanceName,
        fresh: parts.includes('--fresh'),
    }
}

/** True when both paths exist and resolve (realpath) to the same folder. */
export const sameRealPath = async (a: string, b: string): Promise<boolean> => {
    if (!await fs.pathExists(a) || !await fs.pathExists(b)) return false
    return (await fs.realpath(a)) === (await fs.realpath(b))
}

/**
 * The app id as it is stored on a disk: `<name>@<ref>` (installApp input, any git
 * ref) becomes `<name>-<versionDirName(ref)>`, the apps/ folder buildInstance writes.
 * Other ids are returned unchanged.
 */
export const diskAppId = (appId: string): AppID => {
    if (!String(appId).includes('@')) return appId as AppID
    const { name, version } = parseAppId(appId)
    return `${name}-${versionDirName(version)}` as AppID
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
    instanceName: InstanceName,
    opts: { fresh?: boolean } = {}
): Promise<void> => {
    const sourceDevice = sourceDisk.device
    const targetDevice = targetDisk.device
    // #170: the copies below can take minutes; an eject/erase/re-dock meanwhile must not get a store record
    const targetDock = dockIdentityOf(targetDisk)
    const recheck = (step: string) => assertSameDockAfterWait(storeHandle.doc(), String(targetDisk.id), targetDock, `installApp '${appId}' on '${targetDisk.name}' (${step})`)

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
    // --fresh: never copy an existing instance's data (a demo must not inherit a school's data)
    let sourceInstanceId: string | null = null
    if (!opts.fresh && await fs.pathExists(sourceInstanceBase)) {
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

    // Copy app bundle, unless source and target are the same folder (--source is the
    // target disk; Kid, #221): fs.copy refuses to copy a folder onto itself
    const targetAppPath = `${targetMountRoot}/apps/${appId}`
    if (await sameRealPath(sourcePath, targetAppPath)) {
        log(`App bundle already in place at ${targetAppPath} (source is the target disk); not copying it`)
    } else {
        log(`Copying app bundle: ${sourcePath} → ${targetAppPath}`)
        await fs.copy(sourcePath, targetAppPath, { overwrite: true })
    }

    // Register app in store
    recheck('before registering the app')
    await createOrUpdateApp(storeHandle, appId, targetDisk)

    const instanceDir = `${targetInstanceBase}/${instanceId}`
    await fs.ensureDir(instanceDir)

    if (copyFromSourceInstance) {
        log(`Copying instance data from ${sourceInstanceId} to new instance ${instanceId}`)
        await fs.copy(`${sourceInstanceBase}/${sourceInstanceId}`, instanceDir, { overwrite: true })
    } else if (opts.fresh) {
        // --fresh: the whole app bundle is the instance's starting point (entrypoint
        // scripts, hooks, bundled apps; Nextcloud needs them), never a source instance's data
        log(`Fresh instance ${instanceId}: copying the whole app bundle ${targetAppPath}`)
        await fs.copy(targetAppPath, instanceDir, { overwrite: true })
    } else {
        // No existing instance data — copy compose.yaml from app bundle as baseline
        const composeSrc = `${targetAppPath}/compose.yaml`
        if (await fs.pathExists(composeSrc)) {
            await fs.copy(composeSrc, `${instanceDir}/compose.yaml`)
        }
    }

    // Write the requested display name (Kid, idea#235). Only x-app.instanceName
    // changes; the instance id, folder and Docker project stay the generated id.
    const composeFile = `${instanceDir}/compose.yaml`
    if (await fs.pathExists(composeFile)) {
        const text = await fs.readFile(composeFile, 'utf8')
        await fs.writeFile(composeFile, setComposeInstanceName(text, String(instanceName)))
    }

    // processInstance registers the new instance in the store and starts it
    recheck('before registering the instance')
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
    fresh?: boolean              // --fresh flag; local route starts from the bundle, no source instance data
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

/** #179: an install is in flight on its target disk until it settles, so an eject waits for it. */
export const installApp = async (
    storeHandle: DocHandle<Store>,
    opts: InstallAppOptions
): Promise<void> => {
    const target = resolveDiskArg(storeHandle.doc(), getLocalEngine(storeHandle.doc())?.id, opts.targetDiskId, 'installApp')
    return trackInFlight(String(target.id), `installApp ${opts.appId}`, installAppRouted(storeHandle, opts))
}

const installAppRouted = async (
    storeHandle: DocHandle<Store>,
    opts: InstallAppOptions
): Promise<void> => {
    // `<name>@<ref>` (Kid, #221): the ref goes to git as given; disks use the folder-safe id
    const refAppId = opts.appId
    opts = { ...opts, appId: diskAppId(opts.appId) }
    const store = storeHandle.doc()
    const instanceName = (opts.instanceName === undefined ? opts.appId : validateInstanceName(String(opts.instanceName))) as InstanceName
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
            await installAppFromDisk(storeHandle, opts.appId, sourceDisk as Disk, targetDisk as Disk, instanceName, { fresh: opts.fresh })
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
        const { name: appName, version } = parseAppId(refAppId)
        if (!appName || !version) throw new Error(`installApp: cannot read an app name and version from '${refAppId}'. Use <name>-<version> or <name>@<git ref>.`)
        const targetDevice = targetDisk.device!
        const targetDock = dockIdentityOf(targetDisk)
        const instanceId = await buildInstance(instanceName, appName, gitAccount, version, targetDevice as any)
        if (!instanceId) {
            throw new Error(`installApp: GitHub build of '${opts.appId}' on disk '${targetDisk.name}' failed (see Engine log)`)
        }
        // idea#168 r81: buildInstance only writes apps/ + instances/<id> on the disk. Register the
        // app and the instance in the store and start it, exactly like the local route
        // (installAppFromDisk). Without this the instance stayed invisible (no instanceDB row,
        // no container) until the disk was next re-docked.
        // #170: the build can take minutes; never register on a dock that changed meanwhile
        assertSameDockAfterWait(storeHandle.doc(), String(targetDisk.id), targetDock, `installApp '${opts.appId}' on '${targetDisk.name}' (GitHub build)`)
        await createOrUpdateApp(storeHandle, opts.appId, targetDisk as Disk)
        const { processInstance } = await import('./Disk.js')
        await processInstance(storeHandle, targetDisk as Disk, instanceId)
        log(chalk.green(`installApp: installed '${opts.appId}' as instance '${instanceName}' on disk '${targetDisk.name}' (GitHub)`))
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
            await installAppFromDisk(storeHandle, opts.appId, sourceDisk as Disk, targetDisk as Disk, instanceName, { fresh: opts.fresh })
            return
        }
    }

    const alt = await findDockedDiskWithApp(store, opts.appId, String(targetDisk.id))
    if (alt) {
        log(chalk.blue(`installApp: found apps/${opts.appId} on docked disk '${alt.name}' (${alt.id})`))
        await installAppFromDisk(storeHandle, opts.appId, alt, targetDisk as Disk, instanceName, { fresh: opts.fresh })
        return
    }

    // No local source found
    const appName = parseAppId(opts.appId).name
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
