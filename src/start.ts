import os from 'os'
import { enableUsbDeviceMonitor } from './monitors/usbDeviceMonitor.js'
import { runDiskDetectionSelfCheck, recordDiskDetectionFailure, errorMessage } from './monitors/diskDetection.js'
import { enableTimeMonitor, generateHeartBeat } from './monitors/timeMonitor.js'
import { $, chalk, fs, sleep } from 'zx'
import { deepPrint, log, print } from './utils/utils.js'
import { config } from './data/Config.js'
import { createOrUpdateEngine, cleanupPhantomEngines, localEngineId } from './data/Engine.js'
import { PortNumber } from './data/CommonTypes.js'
import { enableHttpMonitor } from './monitors/httpMonitor.js'
import { DocumentId, Repo } from '@automerge/automerge-repo'
import { startAutomergeServer } from './repo.js'
import { enableMulticastDNSEngineMonitor } from './monitors/mdnsMonitor.js'
import { startStaticPeers, staticPeersSetting } from './data/StaticPeers.js'
import { createServerStore } from './data/Store.js'
import { prepareStoreIdentity, storeIdentityPaths } from './data/StoreIdentity.js'
import { enableStoreMonitor } from './monitors/storeMonitor.js'
import { recoverInterruptedOperations } from './data/Operations.js'
import { enableDockerMetricsMonitor } from './monitors/dockerMetricsMonitor.js'
import { enableDiskSizeMonitor } from './data/DiskSize.js'
import { ensureEngineStateDir, setFilesMountStore } from './data/FilesMount.js'
import { clearStaleEraseStaging } from './data/EraseDisk.js'
import { refreshUnformattedDisks } from './data/UnformattedDisks.js'
import { diskFsRoot } from './data/Disk.js'
import { copyApp, moveApp } from './data/CopyMoveApp.js'
import { backupInstance } from './monitors/backupMonitor.js'
import { clearStaleUnmountErrors } from './monitors/mounts.js'
import { createCommandLogStore, shutdownRepo } from './data/CommandLogStore.js'
import { initCommandLogger } from './utils/CommandLogger.js'
import { assertAppDataHelper } from './utils/appDataHelper.js'
import { checkAndSetUndockedApps } from './data/UndockedApps.js'
export { checkAndSetUndockedApps }




export const startEngine = async (disableMDNS?:boolean):Promise<void> => {

    log(`Hello from ${os.hostname()}!`)
    log(`The current time is ${new Date()}`)
    log('Here is some information about the system:')
    log(`  Interfaces: ${JSON.stringify(os.networkInterfaces())}`)
    log(`  Platform: ${os.platform()}`)
    log(`  Architecture: ${os.arch()}`)
    log(`  OS Type: ${os.type()}`)
    log(`  OS Release: ${os.release()}`)
    log(`  OS Uptime: ${os.uptime()}`)
    log(`  OS Load Average: ${os.loadavg()}`)
    log(`  Total Memory: ${os.totalmem()}`)
    log(`  Free Memory: ${os.freemem()}`)
    log(`  CPU Cores: ${os.cpus().length}`)
    log(`  User Info: ${JSON.stringify(os.userInfo())}`)
    log(`  Home Directory: ${os.homedir()}`)
    log(`  Temp Directory: ${os.tmpdir()}`)
    log(`  Endianness: ${os.endianness()}`)
    log(`  Network Hostname: ${os.hostname()}`)

    // The app-data root helper (idea#168) must be installed, allowed by sudoers and
    // the version this Engine speaks; otherwise refuse to start with an "ask Ops to
    // update" message (copy, move, backup and restore of app data depend on it).
    await assertAppDataHelper()

    // Process the config
    const settings = config.settings
    const STORE_DATA_PATH = "./"+config.settings.storeDataFolder
    const STORE_IDENTITY_PATH = "./"+config.settings.storeIdentityFolder
    const storeIdentity = storeIdentityPaths(STORE_IDENTITY_PATH)

    // Create the store data directory if it does not yet exist
    if (!fs.existsSync(STORE_DATA_PATH)) {
        log(`Creating the store data folder at ${STORE_DATA_PATH}`)
        await $`mkdir -p ${STORE_DATA_PATH}`
    }

    // Create the store identity directory if it does not yet exist
    if (!fs.existsSync(STORE_IDENTITY_PATH)) {
        log(`Creating the store identity folder at ${STORE_IDENTITY_PATH}`)
        await $`mkdir -p ${STORE_IDENTITY_PATH}`
    }

    log(`Starting Automerge server...`)
    const repo = await startAutomergeServer(STORE_DATA_PATH, settings.port as PortNumber || 1234 as PortNumber)

    // Store identity (idea#120): a missing store-url.txt is written back with the
    // shared fleet store URL; an existing one is used as it is. store-template.json
    // is never written; if it is missing, startup stops with a clear error.
    const { storeDocId, restored } = await prepareStoreIdentity(storeIdentity)
    if (restored) print(chalk.yellow(`store-url.txt was missing: restored the fleet store URL`))
    log(`Using document ID: ${storeDocId}`)

    // HACK: Force save on remote changes
    // The repo doesn't persist changes that come in from a remote peer automatically.
    // This is a workaround to force a save by listening for the sync-state event and then
    // calling the throttled save function that the repo uses internally.
    // const throttledSave = throttle(() => {
    //     if (repo.storageSubsystem) {
    //         repo.storageSubsystem.saveDoc(storeHandle.documentId, storeHandle.doc())
    //     }
    // }, 100)
    
    // repo.synchronizer.on('sync-state', () => {
    //     throttledSave()
    // })

    log(`Initialising store`)
    const storeHandle = await createServerStore(repo, storeDocId, STORE_DATA_PATH, storeIdentity.templatePath)

    // Create or update the local engine object
    const engine = await createOrUpdateEngine(storeHandle, localEngineId)
    await storeHandle.whenReady()
    const store = storeHandle.doc()

    // Remove any phantom engine entries and orphan disks that accumulated
    // from previous boots (e.g. before the sudo-hdparm fix). Runs before any
    // monitors start so there is no racing writer; tombstones propagate to
    // all peers on the next Automerge sync.
    cleanupPhantomEngines(storeHandle)

    // Clear unmount errors (idea#126) this Engine recorded for disks whose mount
    // point is no longer mounted, or now holds another filesystem (fsUuid).
    await clearStaleUnmountErrors(storeHandle, localEngineId).catch(e => log(`Could not clear stale unmount errors: ${e}`))

    // Check for undocked apps after restart: only instances on disks docked on
    // this Engine (Disk.dockedTo); other Engines' instances are left alone
    await checkAndSetUndockedApps(storeHandle)

    // Crash recovery: retry idempotent interrupted ops; mark others Failed
    await recoverInterruptedOperations(storeHandle, {
        copyApp: async (args, handle) => {
            await copyApp(handle, args.instanceId as any, args.sourceDiskId as any, args.targetDiskId as any, 'crash-recovery')
        },
        moveApp: async (args, handle) => {
            await moveApp(handle, args.instanceId as any, args.sourceDiskId as any, args.targetDiskId as any, 'crash-recovery')
        },
        backupApp: async (args, handle) => {
            const store = handle.doc()
            const backupDisk = store.diskDB[args.backupDiskId]
            if (backupDisk) {
                await backupInstance(handle, args.instanceId as any, backupDisk as any, undefined, 'crash-recovery')
            }
        },
        // restoreApp: strategy='fail', no retry handler needed
    })

    // Create the command log store and initialise the console patcher
    log(chalk.bgMagenta('STARTING COMMAND LOG STORE'))
    const commandLogHandle = await createCommandLogStore(repo)
    initCommandLogger(commandLogHandle)

    // Start the HTTP server (serves Console UI + /api/store-url)
    log(chalk.bgMagenta('STARTING HTTP SERVER'))
    const httpServer = enableHttpMonitor(undefined, undefined, commandLogHandle)

    // Start the instances monitor
    // log(chalk.bgMagenta('STARTING INSTANCES MONITOR'))
    // await enableInstanceStatusMonitor(storeHandle)
    
    // Safety net: log unhandled async errors instead of crashing.
    // The primary fix is suppressing the WebSocket async error event in Network.ts,
    // but this catches anything else that slips through.
    process.on('uncaughtException', (err: Error) => {
        log(`[uncaughtException] ${err.message}\n${err.stack}`);
    });
    process.on('unhandledRejection', (reason: any) => {
        log(`[unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}`);
    });

    // If this process is killed, shut down automerge
    process.on('SIGINT', async () => {
        // this will be fired when you kill the app with ctrl + c.
        log('Shutting down automerge')
        log('*** SIGINT received ****');
        await shutdownProcedure(repo, httpServer, mdnsHandle)
        process.exit(0)
    })
    process.on('SIGTERM', async () => {
        // this will be fired by the Linux shutdown command
        log('Shutting down automerge')
        log('*** SIGTERM received ****');
        await shutdownProcedure(repo, httpServer, mdnsHandle)
        process.exit(0)
    })

    await sleep(1000)
    log(chalk.bgMagenta('STARTING STORE MONITOR'))
    enableStoreMonitor(storeHandle, commandLogHandle)

    const configMDNS = config.settings.mdns
    let mdnsHandle: { end: () => Promise<void> } | undefined
    if (!disableMDNS && configMDNS) {
        await sleep(1000)
        log(chalk.bgMagenta('STARTING MULTICAST DNS MONITOR'))
        mdnsHandle = enableMulticastDNSEngineMonitor(storeHandle, repo)
    }

    // Opt-in static peer list (IDEA_STATIC_PEERS / settings.staticPeers): dials
    // the listed Engines via connectEngine, independent of mDNS. Unset: no-op.
    if (staticPeersSetting()?.trim()) {
        log(chalk.bgMagenta('STARTING STATIC PEERS'))
        startStaticPeers(repo, storeHandle)
    }


    await sleep(1000)
    log(chalk.bgMagenta('STARTING MONITORING OF USB DEVICES'))
    // Report udev problems the boot.sh self-repair could not fix (idea#82).
    // Read-only and not awaited: it may re-check after a delay.
    runDiskDetectionSelfCheck().catch(e =>
        recordDiskDetectionFailure('selfCheck', `Disk detection self-check crashed: ${errorMessage(e)}`))
    // Not awaited (startup continues), but a start failure (e.g. `ls /dev/engine`
    // fails) is reported instead of silently disabling disk detection.
    enableUsbDeviceMonitor(storeHandle).catch(e =>
        recordDiskDetectionFailure('monitorStart', `USB device monitor failed to start; disks will not be detected: ${errorMessage(e)}`))

    await sleep(1000)
    log(chalk.bgMagenta('STARTING DOCKER METRICS MONITOR'))
    enableDockerMetricsMonitor(storeHandle)

    // Size and free space of docked disks every 10 minutes (idea#131); on dock via processDisk
    enableDiskSizeMonitor(storeHandle, localEngineId, diskFsRoot)

    // Files Disk mounts into opted-in Apps (idea#133): state folder for compose
    // overrides and the remount scheduler's store handle
    await ensureEngineStateDir()
    setFilesMountStore(storeHandle)
    await clearStaleEraseStaging()
    await refreshUnformattedDisks(storeHandle).catch(e => log(`unformattedDisks at startup: ${e}`))

    log(chalk.bgMagenta('STARTING HEARTBEAT GENERATION'))
    const heartbeatIntervalMs = config.settings.heartbeatIntervalMs ?? 50000
    generateHeartBeat(storeHandle)
    enableTimeMonitor(heartbeatIntervalMs, () => generateHeartBeat(storeHandle))


}


async function shutdownProcedure(repo: Repo, httpServer?: import('http').Server, mdnsHandle?: { end: () => Promise<void> }): Promise<void> {
    print('*** Engine is now closing ***');
    // Send mDNS goodbye packets so peers immediately know this engine is gone.
    // Without this, stale records linger until TTL expiry and cause name conflicts
    // on the next startup (ciao renames the service to 'hostname (2)').
    if (mdnsHandle) {
        try { await mdnsHandle.end() } catch (_) {}
        log('mDNS service ended')
    }
    // Close the HTTP server first so the port is released before the process exits.
    // Without this, PM2 restarts the engine before the OS releases the port, causing
    // EADDRINUSE on startup and leaving the engine unreachable until TIME_WAIT expires.
    if (httpServer) {
        await new Promise<void>(resolve => httpServer.close(() => resolve()))
        log('HTTP server closed')
    }
    if (repo) await shutdownRepo(repo)
}