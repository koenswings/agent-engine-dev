import os from 'os'
import { enableUsbDeviceMonitor } from './monitors/usbDeviceMonitor.js'
import { enableTimeMonitor, generateHeartBeat } from './monitors/timeMonitor.js'
import { $, chalk, fs, sleep } from 'zx'
import { deepPrint, log } from './utils/utils.js'
import { config } from './data/Config.js'
import { createOrUpdateEngine, localEngineId } from './data/Engine.js'
import { PortNumber } from './data/CommonTypes.js'
import { enableHttpMonitor } from './monitors/httpMonitor.js'
import { DocumentId, Repo, DocHandle } from '@automerge/automerge-repo'
import { startAutomergeServer } from './repo.js'
import { enableMulticastDNSEngineMonitor } from './monitors/mdnsMonitor.js'
import { createServerStore, initialiseServerStore } from './data/Store.js'
import { enableStoreMonitor } from './monitors/storeMonitor.js'
import { recoverInterruptedOperations } from './data/Operations.js'
import { copyApp, moveApp } from './data/CopyMoveApp.js'
import { backupInstance } from './monitors/backupMonitor.js'
import { InstanceID } from './data/CommonTypes.js'
import { Status } from './data/Instance.js'
import { Store } from './data/Store.js'




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

    // Process the config
    const settings = config.settings
    const STORE_DATA_PATH = "./"+config.settings.storeDataFolder
    const STORE_IDENTITY_PATH = "./"+config.settings.storeIdentityFolder
    const STORE_URL_PATH = STORE_IDENTITY_PATH + "/store-url.txt"
    const STORE_TEMPLATE_PATH = STORE_IDENTITY_PATH + "/store-template.json" 

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

    // If the store URL file does not exist, create it and an initial store document
    // This should only happen if we change the structure of the store document
    // and we want to force the creation of a new initial store document by deleting the old one
    if (!fs.existsSync(STORE_URL_PATH) || !fs.existsSync(STORE_TEMPLATE_PATH)) {
        log(`No URL file found at ${STORE_URL_PATH} or template file found at ${STORE_TEMPLATE_PATH}. Recreating them.`);
        await initialiseServerStore(repo, STORE_TEMPLATE_PATH, STORE_URL_PATH);
    }

    const storeDocUrlStr = fs.readFileSync(STORE_URL_PATH, 'utf-8');
    const storeDocId = storeDocUrlStr.replace('automerge:', '') as DocumentId;
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
    const storeHandle = await createServerStore(repo, storeDocId, STORE_DATA_PATH, STORE_TEMPLATE_PATH)

    // Create or update the local engine object
    const engine = await createOrUpdateEngine(storeHandle, localEngineId)
    await storeHandle.whenReady()
    const store = storeHandle.doc()

    // Check for undocked apps after restart
    await checkAndSetUndockedApps(storeHandle)

    // Crash recovery: retry idempotent interrupted ops; mark others Failed
    await recoverInterruptedOperations(storeHandle, {
        copyApp: async (args, handle) => {
            await copyApp(handle, args.instanceId as any, args.sourceDiskId as any, args.targetDiskId as any)
        },
        moveApp: async (args, handle) => {
            await moveApp(handle, args.instanceId as any, args.sourceDiskId as any, args.targetDiskId as any)
        },
        backupApp: async (args, handle) => {
            const store = handle.doc()
            const backupDisk = store.diskDB[args.backupDiskId]
            if (backupDisk) {
                await backupInstance(handle, args.instanceId as any, backupDisk as any)
            }
        },
        // restoreApp: strategy='fail', no retry handler needed
    })

    // Start the HTTP server (serves Console UI + /api/store-url)
    log(chalk.bgMagenta('STARTING HTTP SERVER'))
    enableHttpMonitor()

    // Start the instances monitor
    // log(chalk.bgMagenta('STARTING INSTANCES MONITOR'))
    // await enableInstanceStatusMonitor(storeHandle)
    
    // If this process is killed, shut down automerge
    process.on('SIGINT', async () => {
        // this will be fired when you kill the app with ctrl + c.
        log('Shutting down automerge')
        log('*** SIGINT received ****');
        await shutdownProcedure(repo)
        process.exit(0)
    })
    process.on('SIGTERM', async () => {
        // this will be fired by the Linux shutdown command
        log('Shutting down automerge')
        log('*** SIGTERM received ****');
        await shutdownProcedure(repo)
        process.exit(0)
    })

    await sleep(1000)
    log(chalk.bgMagenta('STARTING STORE MONITOR'))
    enableStoreMonitor(storeHandle)

    const configMDNS = config.settings.mdns
    if (!disableMDNS && configMDNS) {
        await sleep(1000)
        log(chalk.bgMagenta('STARTING MULTICAST DNS MONITOR'))
        enableMulticastDNSEngineMonitor(storeHandle, repo)
    }


    await sleep(1000)
    log(chalk.bgMagenta('STARTING MONITORING OF USB DEVICES'))
    enableUsbDeviceMonitor(storeHandle)

    await sleep(1000)
    log(chalk.bgMagenta('STARTING HEARTBEAT GENERATION'))
    generateHeartBeat(storeHandle)
    enableTimeMonitor(50000, () => generateHeartBeat(storeHandle))


}


export const checkAndSetUndockedApps = async (storeHandle: DocHandle<Store>): Promise<void> => {
    const { instanceDB } = storeHandle.doc();
    const promises = Object.keys(instanceDB).map(async (instanceId) => {
        const instance = instanceDB[instanceId];
        if (instance.status !== "Undocked") {
            try {
                const result = await $`docker ps -q -f name=${instance.id}`;
                if (result.stdout.trim() === "") {
                    // No container running, set to undocked
                    log(`Setting status of instance ${instanceId} to Undocked`)
                    storeHandle.change(doc => {
                          const inst = doc.instanceDB[instanceId]
                          inst.status = 'Undocked' as Status 
                        })
                }
            } catch (error) {
                console.error(`Error checking docker status for ${instance.name}: ${error}`);
            }
        }
    });
    await Promise.all(promises);
};

async function shutdownProcedure(repo:Repo):Promise<void> {
    console.log('*** Engine is now closing ***');
    if (repo) await repo.shutdown()
}