import { storeTag } from './data/StoreScope.js'
import os from 'os'
import { enableUsbDeviceMonitor } from './monitors/usbDeviceMonitor.js'
import { runDiskDetectionSelfCheck, recordDiskDetectionFailure, errorMessage } from './monitors/diskDetection.js'
import { runIgmpMaxMembershipsSelfCheck } from './monitors/igmpSelfCheck.js'
import { runContainerdImageStoreSelfCheck } from './monitors/containerdImageStoreCheck.js'
import { enableTimeMonitor } from './monitors/timeMonitor.js'
import { startLiveness, writeLastSeen } from './data/Liveness.js'
import { $, chalk, fs, sleep } from 'zx'
import { deepPrint, log, print } from './utils/utils.js'
import { config, peerAccessEnabled, peerStaleMs } from './data/Config.js'
import { warnIfTestFailUpdateRestartIgnored } from './data/UpdateAppTestHook.js'
import { takeStartupFailure, publishStartupFailure } from './data/StartupFailure.js'
import { StoreSelfHeal, publishStoreSelfHeal } from './data/StoreHealth.js'
import { createOrUpdateEngine, cleanupPhantomEngines, localEngineId, checkBackupCleanupCapability, checkPreUpdateQuarantineCapability, checkCrossEngineResumeCapability, checkDemoAppsCapability } from './data/Engine.js'
import { PortNumber } from './data/CommonTypes.js'
import { enableHttpMonitor } from './monitors/httpMonitor.js'
import { enableIdeaLocalPublisher, IdeaLocalPublisher } from './monitors/ideaLocal.js'
import { DocumentId, Repo } from '@automerge/automerge-repo'
import { startAutomergeServer } from './repo.js'
import { enableMulticastDNSEngineMonitor } from './monitors/mdnsMonitor.js'
import { startStaticPeers, staticPeersSetting } from './data/StaticPeers.js'
import { createServerStore } from './data/Store.js'
import { assertStoreIdentityMatchesData, prepareStoreIdentity, refuseFleetStoreInIsolatedMode, storeIdentityPaths } from './data/StoreIdentity.js'
import { enableStoreMonitor } from './monitors/storeMonitor.js'
import { enableInstanceStatusMonitor } from './monitors/instanceStatusMonitor.js'
import { recoverInterruptedOperations, archiveOldOperations, markEngineStopping, watchPeerResumes } from './data/Operations.js'
import { startBackupScheduler } from './monitors/backupScheduler.js'
import { startDataBytesMonitor } from './data/DataBytes.js'
import { startPreUpdateQuarantine } from './monitors/preUpdateQuarantine.js'
import { enableDockerMetricsMonitor } from './monitors/dockerMetricsMonitor.js'
import { enableDiskSizeMonitor } from './data/DiskSize.js'
import { ensureEngineStateDir, setFilesMountStore } from './data/FilesMount.js'
import { clearStaleEraseStaging } from './data/EraseDisk.js'
import { refreshUnformattedDisks, setAfterUnformattedRefresh, startUnformattedDiskPoll } from './data/UnformattedDisks.js'
import { refreshClientCards, startClientCardPoll } from './data/ClientCards.js'
import { refreshClientImages } from './data/ClientImages.js'
import './data/FlashCard.js'
import { diskFsRoot } from './data/Disk.js'
import { bootRetryHandlers } from './data/RecoveryRetry.js'
import { clearStaleUnmountErrors } from './monitors/mounts.js'
import { createCommandLogStore, getCommandLogHandle, shutdownRepo, startCommandLogRotation } from './data/CommandLogStore.js'
import { startMemoryMonitor } from './monitors/memoryMonitor.js'
import { initCommandLogger } from './utils/CommandLogger.js'
import { assertAppDataHelper, reportBorgAtStartup } from './utils/appDataHelper.js'
import { startPeerAccess } from './data/PeerAccess.js'
import { checkAndSetUndockedApps } from './data/UndockedApps.js'
import { installStaleDocGuard, staleStoreExit } from './data/StaleDocGuard.js'
import { startLoopStallMonitor } from './monitors/loopStallMonitor.js'
export { checkAndSetUndockedApps }




export const startEngine = async (disableMDNS?:boolean):Promise<void> => {

    log(`Hello from ${os.hostname()}!`)
    // engine#512: name any long main-thread block (startup's sync work starved the peer links)
    startLoopStallMonitor()
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

    // The app-data root helper (idea#168): checked and logged, never fatal (Steve,
    // 2026-10-28). Commands that need a newer helper refuse with HELPER_OUTDATED.
    await assertAppDataHelper()
    // borg: loud but not fatal (only Backup Disks need it)
    reportBorgAtStartup()

    // engine#449: IDEA_TEST_FAIL_UPDATE_RESTART is ignored when testMode is off.
    warnIfTestFailUpdateRestartIgnored(msg => log(chalk.yellow(msg)))

    // Process the config
    const settings = config.settings
    const STORE_DATA_PATH = "./"+config.settings.storeDataFolder
    const STORE_IDENTITY_PATH = "./"+config.settings.storeIdentityFolder
    const storeIdentity = storeIdentityPaths(STORE_IDENTITY_PATH)

    // engine#391: if store-data already holds documents, refuse when the identity
    // is unusable or names a document that is not in store-data. Read-only, and
    // runs before any mkdir or prepareStoreIdentity write. Override:
    // --allow-new-store or IDEA_ALLOW_NEW_STORE=1 (never set by the image or pm2).
    // Throws StoreIdentityMismatchError (code STORE_IDENTITY_MISMATCH); index.ts
    // logs it and process.exit(1), so pm2 restarts are visible in the Engine log.
    assertStoreIdentityMatchesData({ identityDir: STORE_IDENTITY_PATH, dataDir: STORE_DATA_PATH })

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

    // Store identity (idea#120): a missing store-url.txt stops startup unless
    // IDEA_ALLOW_STORE_URL_FALLBACK=true, in which case it is written back with
    // the shared fleet store URL; an existing one is used as it is.
    // store-template.json is never written; if it is missing, startup stops
    // with a clear error.
    // Read BEFORE the Automerge server starts: the Repo's peerId carries the store
    // tag, so the Engine only ever peers with Engines of this store (StoreScope.ts).
    const { storeDocId, restored, fallback } = await prepareStoreIdentity(storeIdentity)
    // engine#362: a test/fixture Engine must not open a known fleet store
    refuseFleetStoreInIsolatedMode(storeDocId, {
        testMode: config.settings.testMode,
        watchDirSet: !!process.env.IDEA_WATCH_DIR,
    })
    if (restored) print(chalk.yellow(`store-url.txt was missing: restored the fleet store URL`))
    if (fallback) print(chalk.bgRed.white(`store-url.txt was restored by the Engine (store-identity/store-url.restored): peer access fails closed until Ops confirms the store`))
    log(`Using document ID: ${storeDocId}`)

    log(`Starting Automerge server...`)
    const repo = await startAutomergeServer(STORE_DATA_PATH, settings.port as PortNumber || 1234 as PortNumber,
        { storeDocId, engineId: String(localEngineId) })

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

    // engine#512: a stale (outdated) store doc exits for a pm2 restart instead of running on
    // half-alive; other stale docs are evicted and resync. The shutdown refs fill in below.
    const live: { httpServer?: import('http').Server, mdnsHandle?: { end: () => Promise<void> }, ideaLocalPublisher?: IdeaLocalPublisher } = {}
    const staleGuard = installStaleDocGuard(repo, {
        storeDocId: String(storeDocId),
        isPinned: (id) => id === String(getCommandLogHandle()?.documentId ?? ''),
        onStaleStore: (reason) => {
            markEngineStopping()   // engine#497: in-flight work is interrupted, boot recovery resumes it
            void staleStoreExit(reason, {
                shutdown: async () => {
                    await live.ideaLocalPublisher?.stop().catch(() => {})
                    await shutdownProcedure(repo, live.httpServer, live.mdnsHandle)
                },
            })
        },
    })

    log(`Initialising store`)
    // engine#567: bad chunks are quarantined and the doc rebuilt/merged from the template; reported below
    const storeSelfHeal: { value: StoreSelfHeal | null } = { value: null }
    // engine#567 genesis guard: a refused heal skips every store write until peer sync brings the
    // top-level maps; then this Engine's entry is written (and the refusal published) after all.
    const storeMapsArrived = { handler: (): void => {} }
    const storeHandle = await createServerStore(repo, storeDocId, STORE_DATA_PATH, storeIdentity.templatePath, {
        onSelfHeal: (h) => { storeSelfHeal.value = h },
        onStoreMapsArrived: () => storeMapsArrived.handler(),
    })
    storeMapsArrived.handler = () => {
        createOrUpdateEngine(storeHandle, localEngineId)
            .then(() => { if (storeSelfHeal.value) publishStoreSelfHeal(storeHandle, String(localEngineId), { ...storeSelfHeal.value, reason: `${storeSelfHeal.value.reason}; maps arrived by peer sync at ${new Date().toISOString()}` }) })
            .catch(e => log(`[store-health] writing this Engine's entry after peer sync failed: ${e}`))
    }
    staleGuard.watchStoreHandle(storeHandle)

    // backupCleanup capability: one helper version check, never fatal (idea#400 §3.1).
    // Must run before createOrUpdateEngine writes Engine.capabilities.
    await checkBackupCleanupCapability()
    await checkPreUpdateQuarantineCapability()
    await checkCrossEngineResumeCapability()
    checkDemoAppsCapability()

    // Create or update the local engine object
    const engine = await createOrUpdateEngine(storeHandle, localEngineId)
    if (storeSelfHeal.value) publishStoreSelfHeal(storeHandle, String(localEngineId), storeSelfHeal.value)
    await storeHandle.whenReady()
    await import('./data/DemoApps.js').then(m => m.refreshDemoHb(storeHandle, String(localEngineId))).catch(e => log(`demo hb: ${e}`))
    const store = storeHandle.doc()

    // Remove any phantom engine entries and orphan disks that accumulated
    // from previous boots (e.g. before the sudo-hdparm fix). Runs before any
    // monitors start so there is no racing writer; tombstones propagate to
    // all peers on the next Automerge sync.
    cleanupPhantomEngines(storeHandle)

    // Per-Pi Engine key (design-per-pi-engine-key.md): make it if missing, publish
    // it with the host key in this Engine's entry, and sync peers' keys into the
    // root-owned authorized_keys/known_hosts through idea-app-data sync-peers.
    // Fails closed (no key published; the keys already on the Pi are kept) on a restored
    // store URL. Never rewrites the host files from a non-fleet store, testMode or
    // IDEA_WATCH_DIR, or with an empty peer set (engine#376).
    const peerAccess = await startPeerAccess(storeHandle, String(localEngineId), {
        enabled: peerAccessEnabled(), fallbackStore: fallback, storeUrlPath: storeIdentity.urlPath, staleMs: peerStaleMs(),
        // engine#376: the host peer files only for a known fleet store, never in testMode / IDEA_WATCH_DIR
        storeDocId, testMode: config.settings.testMode, watchDirSet: !!process.env.IDEA_WATCH_DIR,
    })

    // Clear unmount errors (idea#126) this Engine recorded for disks whose mount
    // point is no longer mounted, or now holds another filesystem (fsUuid).
    await clearStaleUnmountErrors(storeHandle, localEngineId).catch(e => log(`Could not clear stale unmount errors: ${e}`))

    // Check for undocked apps after restart: only instances on disks docked on
    // this Engine (Disk.dockedTo); other Engines' instances are left alone.
    // An instance the operator stopped stays Stopped, so the dock pass does not
    // auto-start it (idea#176)
    await checkAndSetUndockedApps(storeHandle)

    // #230 power-loss safety: roll back an interrupted updateApp from its complete .pre-update snapshot
    await import('./data/UpdateApp.js').then(m => m.recoverInterruptedUpdates(storeHandle, String(localEngineId)))
        .then(r => r.forEach(line => log(`recoverInterruptedUpdates: ${line}`)))
        .catch(e => log(`recoverInterruptedUpdates failed: ${e}`))
    // idea#76: recompute updateAvailable at boot (stale hints from before the restart go)
    await import('./data/UpdateApp.js').then(m => m.refreshUpdateAvailable(storeHandle, String(localEngineId)))
        .catch(e => log(`updateAvailable refresh at boot failed: ${e}`))
    // Engine.tempBackups: after recoverInterruptedUpdates, so a kept leftover is listed
    await import('./data/TempBackups.js').then(m => m.refreshTempBackups(storeHandle))
        .catch(e => log(`tempBackups refresh at boot failed: ${e}`))

    // Crash recovery: retry idempotent interrupted ops; mark others Failed
    // engine#497: each retry runs inside the interrupted op and rejects on failure (RecoveryRetry.ts)
    await recoverInterruptedOperations(storeHandle, bootRetryHandlers)
    // engine#497 stage 3 (a): a parked cross-Engine copy/move resumes when its target is ready on a peer
    watchPeerResumes(storeHandle)

    // Create the command log store and initialise the console patcher
    log(chalk.bgMagenta('STARTING COMMAND LOG STORE'))
    const commandLogHandle = await createCommandLogStore(repo, { storeTag: storeTag(storeDocId), engineId: String(localEngineId), storeDataDir: STORE_DATA_PATH })
    initCommandLogger(commandLogHandle)
    // idea#183: fresh CommandLog doc each local day, previous one archived
    startCommandLogRotation(repo)
    // engine#471: hourly [memory] line (rss, heap, external = mostly Automerge wasm, loaded docs / command logs)
    startMemoryMonitor(repo, { ownCommandLogId: () => getCommandLogHandle()?.documentId ?? null })

    // Start the HTTP server (serves Console UI + /api/store-url)
    log(chalk.bgMagenta('STARTING HTTP SERVER'))
    // idea#203: http://idea.local (port 80) must reach this Engine's Console even when httpPort is not 80
    const httpServer = enableHttpMonitor(undefined, undefined, commandLogHandle, config.settings.ideaLocalHttpPort ?? 80, { engineId: String(localEngineId) })
    live.httpServer = httpServer

    // Start the instances monitor (engine#428: heal late PORT_NOT_READY starts)
    log(chalk.bgMagenta('STARTING INSTANCES MONITOR'))
    enableInstanceStatusMonitor(storeHandle)
    
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
        markEngineStopping()   // engine#497: what fails from now on is an interruption, not a counted failure
        await ideaLocalPublisher?.stop().catch(() => {})
        await shutdownProcedure(repo, httpServer, mdnsHandle)
        process.exit(0)
    })
    process.on('SIGTERM', async () => {
        // this will be fired by the Linux shutdown command
        log('Shutting down automerge')
        log('*** SIGTERM received ****');
        markEngineStopping()   // engine#497: what fails from now on is an interruption, not a counted failure
        await ideaLocalPublisher?.stop().catch(() => {})
        await shutdownProcedure(repo, httpServer, mdnsHandle)
        process.exit(0)
    })

    await sleep(1000)
    log(chalk.bgMagenta('STARTING STORE MONITOR'))
    enableStoreMonitor(storeHandle, commandLogHandle)

    const configMDNS = config.settings.mdns
    let mdnsHandle: { end: () => Promise<void> } | undefined
    let ideaLocalPublisher: IdeaLocalPublisher | undefined
    if (!disableMDNS && configMDNS) {
        await sleep(1000)
        log(chalk.bgMagenta('STARTING MULTICAST DNS MONITOR'))
        mdnsHandle = enableMulticastDNSEngineMonitor(storeHandle, repo)
        live.mdnsHandle = mdnsHandle
        // idea#203: every Engine competes for the shared name idea.local (one holder, takeover)
        if (config.settings.ideaLocal !== false) {
            log(chalk.bgMagenta('STARTING idea.local PUBLISHER'))
            ideaLocalPublisher = enableIdeaLocalPublisher()
            live.ideaLocalPublisher = ideaLocalPublisher
        }
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
    // idea#467: warn if net.ipv4.igmp_max_memberships is below 1024 (Kolibri zeroconf).
    // Read-only, no root, never blocks startup. Skipped when IDEA_WATCH_DIR is set.
    runIgmpMaxMembershipsSelfCheck()
    // idea#322: warn if Docker is not using the containerd image store (digest pins
    // need RepoDigests after docker load). Read-only, never blocks startup.
    // Skipped when IDEA_WATCH_DIR is set.
    runContainerdImageStoreSelfCheck().catch(e =>
        log(`[selfCheck] containerd image store check crashed: ${e instanceof Error ? e.message : String(e)}`))
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
    // idea#201 §10: client cards / new disks follow every unformattedDisks refresh, plus a
    // lsblk poll (a card put into a reader sends no add event for the whole disk)
    setAfterUnformattedRefresh((h) => refreshClientCards(h).then(() => undefined))
    await refreshUnformattedDisks(storeHandle).catch(e => log(`unformattedDisks at startup: ${e}`))
    startClientCardPoll(storeHandle)
    // idea#279: partitions that change while a disk stays plugged re-evaluate 'Unformatted'
    startUnformattedDiskPoll(storeHandle)
    // Hashing a new image takes a while: in the background, then every 10 minutes
    const imagesRefresh = () => refreshClientImages(storeHandle).catch(e => log(`client images: ${e}`))
    imagesRefresh()
    setInterval(imagesRefresh, 10 * 60_000)

    log(chalk.bgMagenta('STARTING HEARTBEAT GENERATION'))
    const heartbeatIntervalMs = config.settings.heartbeatIntervalMs ?? 50000
    // Liveness without store history (store-design 2026-10-13): ephemeral hb every
    // 10 s, stored lastRun at boot + hourly (Liveness.ts)
    writeLastSeen(storeHandle, String(localEngineId), Date.now(), 0, true)
    // idea#400: scheduled Backup Disks run from a 60 s tick inside the Engine (never host cron)
    const scheduler = startBackupScheduler(storeHandle)
    startLiveness(storeHandle, String(localEngineId), { clockStatus: () => scheduler.clockStatus() })
    startPreUpdateQuarantine(storeHandle)
    // engine#430: App data size per instance, every 24 h (also after each dock pass and backup)
    startDataBytesMonitor(storeHandle)
    // The heartbeat timer still repairs this Engine's peerAccess, expires stale
    // peers and archives old operations; it no longer writes to the store itself

    enableTimeMonitor(heartbeatIntervalMs, () => {
        archiveOldOperations(storeHandle).catch(e => print(chalk.red(`archive operations: ${e}`)))
        peerAccess.onHeartbeat().catch(e => print(chalk.red(`peer access heartbeat: ${e}`)))
    })

    // engine#567: this start came up; publish (once) and archive the crash-loop marker
    const startupFailure = takeStartupFailure()
    if (startupFailure) publishStartupFailure(storeHandle, String(localEngineId), startupFailure)


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