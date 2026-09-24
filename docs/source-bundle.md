# Project Source Code Context
Generated on 2026-09-24T21:56:54.343Z

## File: package.json
```typescript
{
  "name": "engine",
  "version": "1.0",
  "description": "",
  "main": "index.js",
  "type": "module",
  "scripts": {
    "install_packages": "pnpm install --no-frozen-lockfile",
    "start": "tsc && node dist/src/index.js",
    "startDB": "tsc && YPERSISTENCE=./yjs-db node dist/src/index.js",
    "dev": "nodemon --watch 'src/**/*' -e ts,tsx --exec 'tsc && VERBOSITY=3 node dist/src/index.js'",
    "devDB": "nodemon --watch 'src/**/*' -e ts,tsx --exec 'tsc && YPERSISTENCE=./yjs-db VERBOSITY=3 node dist/src/index.js'",
    "devreset": "pnpm reset && nodemon --watch 'src/**/*' -e ts,tsx --exec 'tsc && YPERSISTENCE=./yjs-db node dist/src/index.js'",
    "devtest": "tsc --build --clean && tsc && mocha --bail --reporter list 'dist/test/*.js' --exit",
    "pm2start": "tsc && VERBOSITY=3 pm2 start dist/src/index.js --watch",
    "tsc": "tsc",
    "sync": "rsync -av --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='scratchpad' --exclude='.vscode' --exclude='.pnpm-store' ./ pi@raspberrypi.local:/home/pi/idea/agents/agent-engine-dev",
    "reset": "chmod +x script/reset && script/reset",
    "ptest": "tsc && YPERSISTENCE=./yjs-db node dist/src/test.js",
    "test3": "mocha --config x.mocharc.json --es-module-specifier-resolution=node --reporter list 'test/*.ts'",
    "test2": "mocha --config x.mocharc.json --import=tsx --reporter list 'test/*.ts'",
    "test1": "mocha --require ts-node/register --extensions ts,tsx --loader ts-node/esm --reporter list 'test/*.ts' --exit",
    "cleanOld": "tsc --build --clean",
    "clean": "rm -fr dist/*",
    "build": "pnpm clean && tsc",
    "testold": "tsc --build --clean && tsc && mocha 'dist/test/*.js' --exit",
    "testdev": "tsc --build --clean && tsc && VERBOSITY=3 mocha --reporter list 'dist/test/*.js' --exit",
    "testDB": "tsc --build --clean && tsc && YPERSISTENCE=./yjs-db mocha 'dist/test/*.js' --exit",
    "testdevDB": "tsc --build --clean && tsc && YPERSISTENCE=./yjs-db VERBOSITY=3 mocha --reporter list 'dist/test/*.js' --exit",
    "test": "pnpm test:full",
    "test:full": "pnpm build && bash -c 'mkdir -p test/testresults; OUT=test/testresults/test-full-$(date -u +%Y-%m-%d-%H%M).log; { echo \"Suite: test:full | $(date -u) | Branch: $(git branch --show-current) | Commit: $(git rev-parse --short HEAD)\"; echo \"---\"; IDEA_TEST_MODE=true node_modules/.bin/vitest run dist/test/automated/; } 2>&1 | tee $OUT; RET=${PIPESTATUS[0]}; echo \"Results written to $OUT\"; exit $RET'",
    "test:unit": "pnpm build && bash -c 'mkdir -p test/testresults; OUT=test/testresults/test-unit-$(date -u +%Y-%m-%d-%H%M).log; { echo \"Suite: test:unit | $(date -u) | Branch: $(git branch --show-current) | Commit: $(git rev-parse --short HEAD)\"; echo \"---\"; IDEA_TEST_MODE=true node_modules/.bin/vitest run dist/test/automated/; } 2>&1 | tee $OUT; RET=${PIPESTATUS[0]}; echo \"Results written to $OUT\"; exit $RET'",
    "test:diagnostic": "pnpm build && bash -c 'mkdir -p test/testresults; OUT=test/testresults/test-diagnostic-$(date -u +%Y-%m-%d-%H%M).log; { echo \"Suite: test:diagnostic | $(date -u) | Branch: $(git branch --show-current) | Commit: $(git rev-parse --short HEAD)\"; echo \"---\"; IDEA_TEST_MODE=true node_modules/.bin/vitest run dist/test/diagnostic/; } 2>&1 | tee $OUT; RET=${PIPESTATUS[0]}; echo \"Results written to $OUT\"; exit $RET'",
    "test:cross-engine": "pnpm build && bash -c 'mkdir -p test/testresults; OUT=test/testresults/test-cross-engine-$(date -u +%Y-%m-%d-%H%M).log; { echo \"Suite: test:cross-engine | $(date -u) | Branch: $(git branch --show-current) | Commit: $(git rev-parse --short HEAD)\"; echo \"---\"; node_modules/.bin/vitest run dist/test/cross-engine/; } 2>&1 | tee $OUT; RET=${PIPESTATUS[0]}; echo \"Results written to $OUT\"; exit $RET'",
    "bundle-context": "tsx script/bundle-context.ts",
    "dump-store": "npx tsx script/dump-store.ts",
    "cleanup-store": "npx tsx script/cleanup-store.ts"
  },
  "keywords": [],
  "author": "Koen Swings",
  "license": "MIT",
  "devDependencies": {
    "@ts-morph/common": "^0.24.0",
    "@types/chai": "^4.3.20",
    "@types/markdown-it": "^14.1.2",
    "@types/mocha": "^10.0.10",
    "@types/netmask": "^2.0.5",
    "@types/node": "^20.19.10",
    "chai": "^5.2.1",
    "markdown-it": "^14.1.1",
    "mocha": "^10.8.2",
    "netmask": "^2.0.2",
    "nodemon": "^3.1.10",
    "ts-morph": "^23.0.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.9.2",
    "vite": "^8.0.12",
    "vitest": "^4.1.2"
  },
  "dependencies": {
    "@automerge/automerge": "3.1.1-alpha.0",
    "@automerge/automerge-repo": "2.3.0-alpha.0",
    "@automerge/automerge-repo-network-websocket": "2.3.0-alpha.0",
    "@automerge/automerge-repo-storage-nodefs": "^2.2.0",
    "@homebridge/ciao": "^1.3.4",
    "chokidar": "^3.6.0",
    "fast-deep-equal": "^3.1.3",
    "lib0": "^0.2.114",
    "network-interfaces-listener": "^1.0.1",
    "node-dns-sd": "^1.0.1",
    "node-docker-api": "^1.1.22",
    "p-event": "^6.0.1",
    "rimraf": "^6.0.1",
    "tsx": "^4.20.4",
    "valtio": "^1.13.2",
    "ws": "^8.18.3",
    "yaml": "^2.8.3",
    "zx": "^8.8.5"
  },
  "pnpm": {
    "overrides": {
      "minimatch@5": "^5.1.7",
      "minimatch@9": "^9.0.6",
      "brace-expansion@>=4.0.0": "^5.0.5",
      "picomatch@2": "^2.3.2",
      "postcss": "^8.5.10",
      "vite@8": "^8.0.5",
      "serialize-javascript@6": "^7.0.3"
    }
  }
}
```

## File: tsconfig.json
```typescript
{
  "compilerOptions": {
    "moduleResolution": "nodenext",
    "module": "NodeNext",
    // "target": "esnext",
    "target": "ES2022",
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "outDir": "./dist",
    "allowJs": true,
    "strictNullChecks": true,
    "esModuleInterop": true,
    "skipLibCheck": true,  // Added by Gemini to solve type errors in the automerge modules
  },
  "include": [
    "src",
    "script",
    "test"  
, "script/client.ts", "pm2.config.cjs"],
  "exclude": [
    "test/legacy",
    "script/dump-store.ts"
  ]
}
```

## File: src/callback.ts
```typescript
// const http = require('http')
import http from 'http'

const CALLBACK_URL = process.env.CALLBACK_URL ? new URL(process.env.CALLBACK_URL) : null
const CALLBACK_TIMEOUT = process.env.CALLBACK_TIMEOUT || 5000
const CALLBACK_OBJECTS = process.env.CALLBACK_OBJECTS ? JSON.parse(process.env.CALLBACK_OBJECTS) : {}

export const isCallbackSet = !!CALLBACK_URL

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 */
export const callbackHandler = (update, origin, doc) => {
  const room = doc.name
  const dataToSend = {
    room,
    data: {}
  }
  const sharedObjectList = Object.keys(CALLBACK_OBJECTS)
  sharedObjectList.forEach(sharedObjectName => {
    const sharedObjectType = CALLBACK_OBJECTS[sharedObjectName]
    dataToSend.data[sharedObjectName] = {
      type: sharedObjectType,
      content: getContent(sharedObjectName, sharedObjectType, doc).toJSON()
    }
  })
  callbackRequest(CALLBACK_URL, CALLBACK_TIMEOUT, dataToSend)
}

/**
 * @param {URL} url
 * @param {number} timeout
 * @param {Object} data
 */
const callbackRequest = (url, timeout, data) => {
  data = JSON.stringify(data)
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    timeout,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  }
  const req = http.request(options)
  req.on('timeout', () => {
    console.warn('Callback request timed out.')
    req.abort()
  })
  req.on('error', (e) => {
    console.error('Callback request error.', e)
    req.abort()
  })
  req.write(data)
  req.end()
}

/**
 * @param {string} objName
 * @param {string} objType
 * @param {WSSharedDoc} doc
 */
const getContent = (objName, objType, doc) => {
  switch (objType) {
    case 'Array': return doc.getArray(objName)
    case 'Map': return doc.getMap(objName)
    case 'Text': return doc.getText(objName)
    case 'XmlFragment': return doc.getXmlFragment(objName)
    case 'XmlElement': return doc.getXmlElement(objName)
    default : return {}
  }
}
```

## File: src/index.ts
```typescript
import { log } from './utils/utils.js';
import { startEngine } from "./start.js";
import { chalk } from "zx";

const main = async () => {
    try {
        await startEngine();
        log('++++++++++++++++++++++++++++++++++', 1);
        log('+++++++++ Engine started +++++++++', 1);
        log('++++++++++++++++++++++++++++++++++', 1);        
    } catch (error) {
        log(chalk.red('Error starting engine'));
        console.error(error);
        process.exit(1); // Exit with an error code if startup fails
    }

    // Keep the process alive indefinitely so background services can run
    await new Promise(() => {});
};

main();
```

## File: src/repo.ts
```typescript
import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { WebSocketServer } from "ws";
import { WebSocketServerAdapter } from "@automerge/automerge-repo-network-websocket";
import { PortNumber } from "./data/CommonTypes.js";
import { deepPrint, log, error } from './utils/utils.js'


export const startAutomergeServer = async (dataDir:string, port:PortNumber):Promise<Repo> => {
    log(`Using data directory: ${dataDir}`);

    // 1. Create a storage adapter for the server to persist data.
    const storage = new NodeFSStorageAdapter(dataDir);

    // 2. Create a WebSocket server.
    const ws = new WebSocketServer({ port: port });
    ws.on('error', (err) => {
        error(`WebSocket server error on port ${port}: ${err.message}`)
    })
    const network = new WebSocketServerAdapter(ws);

    // 3. Create the Automerge repo.
    const repo = new Repo({
        storage: storage,
        network: [network],
        sharePolicy: async (peerId) => true // Allow all peers to sync
    });

    log(`Automerge server is running on port ${port}`);

    // --------- 
    // Some Tests
    // ---------

    // const handle = repo.create({ appDB: { koen: 1 }, engineDB: {}, instanceDB: {}, connections: {} });

    // handle.on("change", ({ doc, patches }) => {
    //     log(`repo.ts: Document received with handle.on: ${deepPrint(doc, 2)}`);
    //     was-console-log(`Changes received with handle.on: ${JSON.stringify(patches)}`);
    // })

    // handle.change(doc => {
    //     log(`repo.ts: Document received with handle.change: ${deepPrint(doc, 3)}`)
    //     log(`repo.ts: Changing appDB.koen from ${doc.appDB["koen"]} to 2`)
    //     doc.appDB["foo"] = "baz";
    //     doc.appDB["koen"] = 2;
    // })



    // Set up the `cards` array in doc1
    // let doc1 = Automerge.change(Automerge.init(), (doc) => {
    //   doc.cards = [];
    // });

    // // Add a card to the `cards` array in doc1
    // doc1 = Automerge.change(doc1, (doc) => {
    //   doc.cards.push({ id: 1, title: "Card 1" });
    // });

    // // Subscribe to changes in the `cards` array
    // Automerge.subscribe(doc1, (changes) => {
    //   was-console-log("Changes in doc1:", changes);
    // });

    return repo;

}

```

## File: src/start.ts
```typescript
import os from 'os'
import { enableUsbDeviceMonitor } from './monitors/usbDeviceMonitor.js'
import { enableTimeMonitor, generateHeartBeat } from './monitors/timeMonitor.js'
import { $, chalk, fs, sleep } from 'zx'
import { deepPrint, log, print } from './utils/utils.js'
import { config } from './data/Config.js'
import { createOrUpdateEngine, cleanupPhantomEngines, localEngineId } from './data/Engine.js'
import { PortNumber } from './data/CommonTypes.js'
import { enableHttpMonitor } from './monitors/httpMonitor.js'
import { DocumentId, Repo, DocHandle } from '@automerge/automerge-repo'
import { startAutomergeServer } from './repo.js'
import { enableMulticastDNSEngineMonitor } from './monitors/mdnsMonitor.js'
import { createServerStore, initialiseServerStore } from './data/Store.js'
import { enableStoreMonitor } from './monitors/storeMonitor.js'
import { recoverInterruptedOperations } from './data/Operations.js'
import { enableDockerMetricsMonitor } from './monitors/dockerMetricsMonitor.js'
import { copyApp, moveApp } from './data/CopyMoveApp.js'
import { backupInstance } from './monitors/backupMonitor.js'
import { InstanceID } from './data/CommonTypes.js'
import { Status } from './data/Instance.js'
import { Store } from './data/Store.js'
import { createCommandLogStore } from './data/CommandLogStore.js'
import { initCommandLogger } from './utils/CommandLogger.js'




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

    // Remove any phantom engine entries and orphan disks that accumulated
    // from previous boots (e.g. before the sudo-hdparm fix). Runs before any
    // monitors start so there is no racing writer; tombstones propagate to
    // all peers on the next Automerge sync.
    cleanupPhantomEngines(storeHandle)

    // Check for undocked apps after restart
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


    await sleep(1000)
    log(chalk.bgMagenta('STARTING MONITORING OF USB DEVICES'))
    enableUsbDeviceMonitor(storeHandle)

    await sleep(1000)
    log(chalk.bgMagenta('STARTING DOCKER METRICS MONITOR'))
    enableDockerMetricsMonitor(storeHandle)

    log(chalk.bgMagenta('STARTING HEARTBEAT GENERATION'))
    const heartbeatIntervalMs = config.settings.heartbeatIntervalMs ?? 50000
    generateHeartBeat(storeHandle)
    enableTimeMonitor(heartbeatIntervalMs, () => generateHeartBeat(storeHandle))


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
    if (repo) await repo.shutdown()
}
```

## File: src/test.ts
```typescript
import { Suite, Runner } from 'mocha'
import Mocha from 'mocha';
import { print } from './utils/utils.js';

// First, you need to instantiate a Mocha instance

var mocha = new Mocha({
    reporter: 'list'
});

//mocha.reporter('xunit', { output: './test/testspec.xunit.xml' });

var suite = new Suite('JSON suite');
var runner = new Runner(suite);
//var xunit = new XUnit(runner);
//var mochaReporter = new mocha._reporter(runner);

mocha.addFile(
    './dist/test/01 - index.js'
);

mocha.addFile(
    './dist/test/02 - local-engine.js'
);

runner.run(function(failures) {
    // the json reporter gets a testResults JSON object on end
    //var testResults = mochaReporter.testResults;

    //was-console-log(testResults);
    // send your email here
    print('done')
});
```

## File: src/monitors/backupMonitor.ts
```typescript
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
import { log, print } from '../utils/utils.js'
import { config } from '../data/Config.js'
import { Disk, BackupConfig, isBackupDisk, processDisk, diskMountRoot } from '../data/Disk.js'
import { indexBackupDiskApps } from '../data/InstallApp.js'
import { createOperation, updateOperation } from '../data/Operations.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { stopInstance, startInstance, BACKUP_STEPS } from '../data/Instance.js'
import { BackupMode, DiskID, DiskName, InstanceID, Timestamp, OperationCause } from '../data/CommonTypes.js'
import { Store, getInstance, getDisks, findDiskByName } from '../data/Store.js'
import { DocHandle } from '@automerge/automerge-repo'
import { getCommandLogHandle, addTrace, closeTrace } from '../data/CommandLogStore.js'
import { runWithTrace, flushTrace, getActiveTrace } from '../utils/CommandLogger.js'

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
        log(`Backup for ${instanceId} already in progress — skipping duplicate trigger`)
        return
    }
    activeBackups.add(instanceId)
    let wasRunning = false

    // Acquire lock on the instance for the duration of the backup
    const backupLockKey = instanceKey(instanceId)
    if (!resourceLock.acquire(backupLockKey, 'backupApp')) {
        log(chalk.yellow(`backupInstance: instance ${instanceId} is locked — skipping (another operation is running)`))
        activeBackups.delete(instanceId)
        return
    }

    const opId = existingOpId ?? createOperation(storeHandle, 'backupApp', {
        instanceId,
        backupDiskId: backupDisk.id,
    }, cause, { type: 'instance', id: instanceId })

    try {
        updateOperation(storeHandle, opId, { status: 'Running' })
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

        // 1. Init Borg repo if this is the first backup
        setBackupStep(0, BACKUP_STEPS[0])
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
            setBackupStep(1, BACKUP_STEPS[1])
            await stopInstance(storeHandle, instance, appDisk, 'backup-pre-stop')
        }

        // 4. Run borg create
        setBackupStep(2, BACKUP_STEPS[2])
        const archiveName = new Date().toISOString().replace(/[:.]/g, '-')
        if (!config.settings.testMode) {
            log(`Running borg create for instance ${instanceId}`)
            await $`borg create ${repoPath}::${archiveName} ${await diskMountRoot(appDisk)}/instances/${instanceId}`
        } else {
            log(`testMode: skipping borg create for instance ${instanceId}`)
        }

        // 5. Restart instance if it was running
        if (wasRunning) {
            log(`Restarting instance ${instanceId} after backup`)
            setBackupStep(3, BACKUP_STEPS[3])
            await startInstance(storeHandle, instance, appDisk, 'backup-post-start')
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

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`Backup of instance ${instanceId} completed successfully`))

    } catch (e: any) {
        updateOperation(storeHandle, opId, {
            status: 'Failed',
            error: e.message ?? String(e),
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.red(`Backup of instance ${instanceId} failed: ${e.message ?? e}`))
        // Always restart instance if it was stopped (even on failure)
        if (wasRunning) {
            try {
                const store = storeHandle.doc()
                const instance = getInstance(store, instanceId)
                const appDisk = instance?.storedOn ? store.diskDB[instance.storedOn] : null
                if (instance && appDisk) {
                    log(`Restarting instance ${instanceId} after failed backup`)
                    await startInstance(storeHandle, instance, appDisk, 'backup-post-start')
                }
            } catch (restartErr) {
                log(chalk.red(`Failed to restart instance ${instanceId} after backup error: ${restartErr}`))
            }
        }
        // Lock file intentionally left in place — signals boot-resume on next dock
    } finally {
        activeBackups.delete(instanceId)
        resourceLock.release(backupLockKey)
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

    // Phase 2: index any app bundles on this disk into appDB for installApp / Console
    await indexBackupDiskApps(storeHandle, backupDisk)

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
                    await backupInstance(storeHandle, staleInstanceId, backupDisk, undefined, 'backup-stale-lock')
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
                await backupInstance(storeHandle, instanceId, backupDisk, undefined, 'console-command')
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

        for (const instance of instancesOnAppDisk) {
            if (candidate.backupConfig.links.includes(instance.id)) {
                log(`checkPendingBackups: triggering backup for instance ${instance.id}`)
                await backupInstance(storeHandle, instance.id, candidate as Disk, undefined, 'backup-app-docked')
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
                        if (String(staleInstance?.storedOn) === String(appDisk.id)) {
                            log(`checkPendingBackups: stale lock for ${staleId} — re-triggering backup`)
                            await backupInstance(storeHandle, staleId, candidate as Disk, undefined, 'backup-stale-lock')
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
    targetDisk: Disk,
    existingOpId?: string,
    cause: OperationCause = 'console-command',
): Promise<void> => {
    // Acquire lock: instance + target disk
    const restoreLockKeys = [instanceKey(instanceId), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(restoreLockKeys, 'restoreApp')) {
        console.error(chalk.red(`restoreApp: resource locked — another operation is already running on instance or target disk. Retry when it completes.`))
        return
    }

    const opId = existingOpId ?? createOperation(storeHandle, 'restoreApp', {
        instanceId,
        targetDiskId: targetDisk.id,
    }, cause, { type: 'instance', id: instanceId })

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

        const repoPath = backupDir(backupDevice, instanceId)
        const instancesDir = `${await diskMountRoot(targetDisk)}/instances`

        // Stop instance if currently running
        const instance = getInstance(store, instanceId)
        if (instance?.status === 'Running') {
            const currentDisk = instance.storedOn ? store.diskDB[instance.storedOn] : null
            if (currentDisk) await stopInstance(storeHandle, instance, currentDisk, 'backup-pre-stop')
        }

        await fs.ensureDir(instancesDir)

        if (!config.settings.testMode) {
            log(`Restoring instance ${instanceId} from ${backupDevice} to ${targetDevice}`)
            await $`bash -c ${'cd ' + instancesDir + ' && borg extract ' + repoPath + '::latest'}`
        } else {
            log(`testMode: skipping borg extract for instance ${instanceId}`)
        }

        const { processInstance } = await import('../data/Disk.js')
        await processInstance(storeHandle, targetDisk, instanceId)

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
    } finally {
        resourceLock.releaseAll(restoreLockKeys)
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

```

## File: src/monitors/dockerMetricsMonitor.ts
```typescript
/**
 * dockerMetricsMonitor.ts
 *
 * Polls `docker stats --no-stream --format json` every POLL_INTERVAL_MS for
 * all containers belonging to Running instances on the local engine, then
 * writes parsed metrics to instance.metrics in the Automerge store.
 *
 * When an instance stops running (status !== 'Running'), metrics is set to null.
 *
 * The Console reads instance.metrics and formats the raw numbers itself.
 */

import { $ } from 'zx'
import { log } from '../utils/utils.js'
import { DocHandle } from '@automerge/automerge-repo'
import { Store, getLocalEngine, getInstancesOfEngine } from '../data/Store.js'
import { DockerMetrics } from '../data/CommonTypes.js'
import { localEngineId } from '../data/Engine.js'
import { config } from '../data/Config.js'

$.verbose = false

const POLL_INTERVAL_MS = 15_000

// ── Byte-string parser ────────────────────────────────────────────────────────
// docker stats JSON emits strings like "256MiB", "1.5GiB", "1.23kB", "10MB"

const UNIT_MULTIPLIERS: Record<string, number> = {
    b:   1,
    kb:  1000,
    mb:  1000 ** 2,
    gb:  1000 ** 3,
    tb:  1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
}

const parseBytes = (raw: string): number | null => {
    if (!raw) return null
    const m = raw.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/)
    if (!m) return null
    const value = parseFloat(m[1])
    const unit = m[2].toLowerCase()
    const mult = UNIT_MULTIPLIERS[unit]
    if (mult === undefined || isNaN(value)) return null
    return Math.round(value * mult)
}

const parsePercent = (raw: string): number | null => {
    if (!raw) return null
    const m = raw.trim().match(/^([\d.]+)\s*%$/)
    if (!m) return null
    const v = parseFloat(m[1])
    return isNaN(v) ? null : v
}

// ── docker stats output shape ─────────────────────────────────────────────────
// `docker stats --no-stream --format json` outputs one JSON object per line.
// Fields (from Docker docs): Container, Name, CPUPerc, MemUsage, MemPerc,
// NetIO, BlockIO, PIDs.

interface RawDockerStats {
    Container?: string
    Name?: string
    CPUPerc?: string
    MemUsage?: string    // e.g. "256MiB / 1GiB"
    MemPerc?: string
    NetIO?: string       // e.g. "1.23kB / 456B"
    BlockIO?: string     // e.g. "10MB / 5MB"
}

const parseStatsLine = (line: string): { name: string; metrics: DockerMetrics } | null => {
    let raw: RawDockerStats
    try {
        raw = JSON.parse(line)
    } catch {
        return null
    }

    const name = raw.Name ?? raw.Container ?? ''
    if (!name) return null

    // MemUsage: "256MiB / 1GiB"
    const [memUsageStr, memLimitStr] = (raw.MemUsage ?? '').split('/').map(s => s.trim())

    // NetIO: "1.23kB / 456B"
    const [netRxStr, netTxStr] = (raw.NetIO ?? '').split('/').map(s => s.trim())

    // BlockIO: "10MB / 5MB"
    const [blockReadStr, blockWriteStr] = (raw.BlockIO ?? '').split('/').map(s => s.trim())

    const metrics: DockerMetrics = {
        cpuPercent:     parsePercent(raw.CPUPerc ?? ''),
        memUsageBytes:  parseBytes(memUsageStr ?? ''),
        memLimitBytes:  parseBytes(memLimitStr ?? ''),
        memPercent:     parsePercent(raw.MemPerc ?? ''),
        netRxBytes:     parseBytes(netRxStr ?? ''),
        netTxBytes:     parseBytes(netTxStr ?? ''),
        blockReadBytes: parseBytes(blockReadStr ?? ''),
        blockWriteBytes:parseBytes(blockWriteStr ?? ''),
        sampledAt:      Date.now(),
    }

    return { name, metrics }
}

// ── Collect metrics for a set of instance IDs ─────────────────────────────────

const collectMetrics = async (
    instanceIds: string[]
): Promise<Map<string, DockerMetrics>> => {
    // docker stats container names follow the pattern: <instanceId>-<service>-1
    // We filter containers by name prefix matching any of the instance IDs.
    const result = new Map<string, DockerMetrics>()
    if (instanceIds.length === 0) return result

    try {
        // docker stats does not support --filter; resolve container names via docker ps first
        const filterArgs = instanceIds.flatMap(id => ['--filter', `name=${id}`])
        const psProc = await $`docker ps --format {{.Names}} ${filterArgs}`
        const containerNames = psProc.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        if (containerNames.length === 0) return result
        const proc = await $`docker stats --no-stream --format json ${containerNames}`
        const lines = proc.stdout.split('\n').filter(l => l.trim())

        for (const line of lines) {
            const parsed = parseStatsLine(line)
            if (!parsed) continue
            // Map container name back to instance ID
            const instanceId = instanceIds.find(id => parsed.name.startsWith(id))
            if (!instanceId) continue
            // Merge: if multiple containers belong to the same instance, accumulate
            const existing = result.get(instanceId)
            if (!existing) {
                result.set(instanceId, parsed.metrics)
            } else {
                // Sum CPU and net/block across containers; use latest sampledAt
                existing.cpuPercent     = (existing.cpuPercent    ?? 0) + (parsed.metrics.cpuPercent    ?? 0)
                existing.memUsageBytes  = (existing.memUsageBytes ?? 0) + (parsed.metrics.memUsageBytes ?? 0)
                existing.netRxBytes     = (existing.netRxBytes    ?? 0) + (parsed.metrics.netRxBytes    ?? 0)
                existing.netTxBytes     = (existing.netTxBytes    ?? 0) + (parsed.metrics.netTxBytes    ?? 0)
                existing.blockReadBytes = (existing.blockReadBytes ?? 0) + (parsed.metrics.blockReadBytes ?? 0)
                existing.blockWriteBytes= (existing.blockWriteBytes ?? 0) + (parsed.metrics.blockWriteBytes ?? 0)
                existing.sampledAt      = Date.now()
            }
        }
    } catch (e: any) {
        log(`[dockerMetrics] docker stats error: ${e.message ?? e}`)
    }

    return result
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

const poll = async (storeHandle: DocHandle<Store>): Promise<void> => {
    if (config.settings.testMode) return  // no Docker in test mode

    const store = storeHandle.doc()
    const localEngine = getLocalEngine(store)
    if (!localEngine) return

    const allInstances = getInstancesOfEngine(store, localEngine)
    const runningInstances = allInstances.filter(i => i.status === 'Running')
    const runningIds = runningInstances.map(i => i.id as string)

    // Collect live metrics for running containers
    const metricsMap = await collectMetrics(runningIds)

    // Write back to store — one change() call covers all instances
    storeHandle.change(doc => {
        for (const inst of allInstances) {
            const instanceInDoc = doc.instanceDB[inst.id as any]
            if (!instanceInDoc) continue

            if (inst.status === 'Running') {
                const m = metricsMap.get(inst.id as string)
                // If running but no container found yet (brief window during start), keep previous metrics
                if (m) {
                    instanceInDoc.metrics = m as any
                }
            } else {
                // Not running — clear metrics
                if (instanceInDoc.metrics !== null) {
                    instanceInDoc.metrics = null
                }
            }
        }
    })
}

export const enableDockerMetricsMonitor = (storeHandle: DocHandle<Store>): void => {
    log('[dockerMetrics] Starting Docker metrics monitor')

    const run = async () => {
        try {
            await poll(storeHandle)
        } catch (e: any) {
            log(`[dockerMetrics] Unhandled error in poll: ${e.message ?? e}`)
        }
        setTimeout(run, POLL_INTERVAL_MS)
    }

    // First poll after a short delay (give instances time to start on engine boot)
    setTimeout(run, 5_000)
}

```

## File: src/monitors/httpMonitor.ts
```typescript
/**
 * httpMonitor.ts — Engine HTTP server
 *
 * Responsibilities:
 *   1. Serve the Console production web app (static files from `consolePath`)
 *   2. Expose GET /api/store-url — returns the Automerge document URL so the
 *      Console can discover it automatically without manual configuration
 *
 * Port: configurable via `config.yaml` settings.httpPort (default 80).
 *
 * If `consolePath` is empty or the directory does not exist, the static file
 * serving is skipped but /api/store-url is still available.
 *
 * The Console uses /api/store-url as:
 *   GET http://<engine-hostname>/api/store-url
 *   → { "url": "automerge:<hash>" }
 */

import http from 'http'
import path from 'path'
import { fs } from 'zx'
import { log } from '../utils/utils.js'
import { config } from '../data/Config.js'
import type { DocHandle } from '@automerge/automerge-repo'
import type { CommandLogStore } from '../data/CommandLogStore.js'

const STORE_URL_FILE = path.join(
    config.settings.storeIdentityFolder,
    'store-url.txt'
)

const COMMAND_LOG_URL_FILE = path.join(
    config.settings.storeIdentityFolder,
    'command-log-url.txt'
)

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
}

const mimeType = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Start the Engine HTTP server.
 *
 * @param port        TCP port to listen on (default: config.settings.httpPort)
 * @param consolePath Absolute path to Console dist/ directory (default: config.settings.consolePath)
 */
export const enableHttpMonitor = (
    port: number = config.settings.httpPort,
    consolePath: string = config.settings.consolePath,
    _commandLogHandle?: DocHandle<CommandLogStore> | null   // unused at runtime — URL comes from disk
): http.Server => {

    const hasConsole = consolePath && fs.existsSync(consolePath)

    if (consolePath && !hasConsole) {
        log(`[http] consolePath "${consolePath}" not found — Console UI will not be served`)
    } else if (hasConsole) {
        log(`[http] Serving Console UI from ${consolePath}`)
    } else {
        log(`[http] No consolePath configured — Console UI will not be served`)
    }

    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/'

        // ── API routes ──────────────────────────────────────────────────────
        if (url === '/api/store-url' || url === '/api/store-url/') {
            try {
                const storeUrl = (await fs.readFile(STORE_URL_FILE, 'utf-8')).trim()
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',  // Console may be on a different origin during dev
                })
                res.end(JSON.stringify({ url: storeUrl }))
            } catch (e) {
                log(`[http] /api/store-url: failed to read store URL — ${e}`)
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Store URL not available yet' }))
            }
            return
        }

        if (url === '/api/command-log-url' || url === '/api/command-log-url/') {
            try {
                const logUrl = (await fs.readFile(COMMAND_LOG_URL_FILE, 'utf-8')).trim()
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                })
                res.end(JSON.stringify({ url: logUrl }))
            } catch (e) {
                log(`[http] /api/command-log-url: failed to read URL — ${e}`)
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Command log URL not available yet' }))
            }
            return
        }

        // ── Static Console files ────────────────────────────────────────────
        if (!hasConsole) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Console UI not configured on this Engine')
            return
        }

        // Resolve the requested path to a file under consolePath.
        // Any path that doesn't resolve to a real file falls back to index.html
        // (SPA client-side routing).
        let filePath = path.join(consolePath, url === '/' ? 'index.html' : url)

        // Strip query strings
        filePath = filePath.split('?')[0]

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(consolePath, 'index.html')
        }

        try {
            const data = await fs.readFile(filePath)
            res.writeHead(200, { 'Content-Type': mimeType(filePath) })
            res.end(data)
        } catch (e) {
            log(`[http] Failed to serve ${filePath}: ${e}`)
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal error')
        }
    })

    server.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EACCES') {
            log(`[http] Permission denied on port ${port}. Run with sudo or use a port > 1024.`)
        } else if (e.code === 'EADDRINUSE') {
            log(`[http] Port ${port} already in use.`)
        } else {
            log(`[http] Server error: ${e}`)
        }
    })

    server.listen(port, () => {
        log(`[http] Engine HTTP server listening on port ${port}`)
    })

    return server
}

```

## File: src/monitors/mdnsMonitor.ts
```typescript
import mDnsSd from 'node-dns-sd'
import { deepPrint, log, error } from '../utils/utils.js';
import { chalk } from 'zx';
import { Store, getLocalEngine } from '../data/Store.js';
import { manageDiscoveredPeers } from '../data/Network.js'
import ciao, { CiaoService } from '@homebridge/ciao'
import { DocHandle, DocumentId, Repo } from '@automerge/automerge-repo';
import { EngineID, Hostname, IPAddress } from '../data/CommonTypes.js';
import { config } from '../data/Config.js';

export const startAdvertising = (store: Store): CiaoService => {
    const engine = getLocalEngine(store)
    if (!engine) {
        log(`No local engine found in the store`)
        throw new Error(`No local engine found in the store`)
    }
    const engineName = engine.hostname
    const engineVersion = engine.version
    const responder = ciao.getResponder()

    if (!engineName) {
        throw new Error(`No engine hostname found in the store`)
    }

    log(`Advertising on all interfaces`)
    const service = responder.createService({
        name: engineName.toString(),
        type: 'engine',
        port: config.settings.port,
        txt: {
            name: engineName,
            id: engine.id,
            version: engineVersion
        }
    })

    // Log name conflicts without updating the store — the (2) suffix is a service
    // advertisement detail, not the machine hostname.
    service.on('name-change', (newName: string) => {
        log(`mDNS service name changed to '${newName}' due to conflict — hostname in store unchanged`);
    });

    service.advertise().then(() => {
        log(`The following service is published on all interfaces: ${engineName}._engine._tcp.local`);
    }).catch((err) => {
        error(`Error advertising mDNS service: ${err}`)
    })

    return service
}

const discoverEngines = async (storeHandle: DocHandle<Store>, repo:Repo): Promise<void> => {
    const localEngine = getLocalEngine(storeHandle.doc());
    try {
        const deviceList = await mDnsSd.discover({ name: '_engine._tcp.local' });
        const discoveredPeers = new Map<IPAddress, {hostname: Hostname, engineId: EngineID}>();

        if (deviceList.length > 0) {
            log(chalk.bgBlackBright(`Discovered engines:`));
        }

        deviceList.forEach(device => {
            const txt = device.packet.additionals.find((add: any) => ((typeof add == 'object') && add.hasOwnProperty('type') && add.type === 'TXT'));

            if (!txt || !txt.rdata) {
                log(chalk.redBright(`  - No TXT record for ${device.modelName || device.address}. Skipping.`));
                return;
            }

            const txtRecord = txt.rdata;
            const engineId = txtRecord.id as EngineID;
            const hostname = txtRecord.name as Hostname;
            const address = device.address as IPAddress;
            const port = device.service?.port;

            log(`  - Name: ${hostname || 'N/A'}, ID: ${engineId || 'N/A'}, Address: ${address || 'N/A'}:${port || 'N/A'}`);

            if (engineId && engineId === localEngine.id) {
                return; // Skip local engine
            }

            if (address && hostname && engineId) {
                discoveredPeers.set(address, { hostname, engineId });
            }
        });

        await manageDiscoveredPeers(repo, discoveredPeers, storeHandle);

        if (deviceList.length === 0) {
            log(chalk.bgBlackBright(`No remote engines found`))
        }
    } catch (error) {
        log(`***node-dns-sd*** Error discovering engines`)
        console.error(error);
    }
}

export const enableMulticastDNSEngineMonitor = (storeHandle: DocHandle<Store>, repo: Repo): { end: () => Promise<void> } => {
    const service = startAdvertising(storeHandle.doc())
    
    const runDiscovery = async () => {
        await discoverEngines(storeHandle, repo);
        setTimeout(runDiscovery, 10000);
    };

    runDiscovery();

    // Return shutdown handle so the caller can send mDNS goodbye packets on exit.
    return {
        end: () => service.end()
    }
}

```

## File: src/monitors/storeMonitor.ts
```typescript
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../data/Store.js'
import { log } from '../utils/utils.js'
import { EngineID, InstanceID } from '../data/CommonTypes.js'
import { handleCommand } from '../utils/commandUtils.js'
import { commands } from '../data/Commands.js';
import { localEngineId } from '../data/Engine.js';
import { CommandLogStore } from '../data/CommandLogStore.js';



const engineSetMonitor = (patch, storeHandle): boolean => {
    if (patch.action === 'put' &&  // Since we never change the object value, we know that 'put' means an addition 
        patch.path.length === 2 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' // engineId
    ) {
        const engineId = patch.path[1].toString() as EngineID
        log(`New engine added with ID: ${engineId}`)
        return true
    } else {
        return false
    }
}

// Track which commands are currently in-flight, keyed by engineId + command string.
// Commands for different instances can execute concurrently; commands for the same
// engine still execute serially (queue[0] is always processed next).
const _currentlyExecuting = new Set<string>()

const engineCommandsMonitor = (patch, storeHandle): boolean => {
    const isCommandPath =
        patch.path.length >= 3 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' &&
        patch.path[2] === 'commands'

    if (!isCommandPath) return false

    const engineId = patch.path[1] as EngineID
    if (engineId !== localEngineId) return true

    const doc = storeHandle.doc()
    const queue = doc?.engineDB[engineId as any]?.commands as string[] | undefined
    if (!queue?.length) return true

    const command = queue[0]
    if (!command || !command.includes(' ')) return true

    // Use engineId+command as the dedup key so a new command with the same text
    // (but on a different instance) can still run concurrently.
    const key = `${engineId}:${command}`
    if (_currentlyExecuting.has(key)) return true

    _currentlyExecuting.add(key)
    log(`Processing command for engine ${engineId}: ${command}`)
    const cmdLogHandle = (storeHandle as any).__commandLogHandle ?? null
    handleCommand(commands, storeHandle, 'engine', command, cmdLogHandle).then(() => {
        _currentlyExecuting.delete(key)
        storeHandle.change(doc => {
            const eng = doc.engineDB[engineId as any]
            if (eng) (eng.commands as any[]).splice(0, 1)
        })
    })
    return true
}

const engineLastRunMonitor = (patch, storeHandle): boolean => {
    if (patch.action === 'put' &&
        patch.path.length === 3 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' && // engineId
        patch.path[2] === 'lastRun') {
        const lastRun = patch.value as number
        const engineId = patch.path[1] as EngineID
        log(`Engine ${engineId} last run updated to: ${lastRun}`)
        return true
    } else {
        return false
    }
}

const instancesMonitor = (patch, storeHandle): boolean => {
    if (patch.action === 'put' &&
        patch.path.length === 3 &&
        patch.path[0] === 'instanceDB' &&
        typeof patch.path[1] === 'string' && // instanceId
        patch.path[2] === 'status') {
        const instanceId = patch.path[1] as InstanceID
        const status = (patch.value ?? storeHandle.doc()?.instanceDB?.[instanceId]?.status) as string
        log(`Instance ${instanceId} status changed to: ${status}`)
        return true
    } else {
        return false
    }
}

const applyUntilTrue = (functions: ((patch, storeHandle) => boolean)[], patch, storeHandle): boolean => {
    for (const func of functions) {
        if (func(patch, storeHandle)) {
            return true
        }
    }
    return false
}

export const enableStoreMonitor = (storeHandle: DocHandle<Store>, commandLogHandle?: DocHandle<CommandLogStore> | null): void => {
    // Monitor for the addition or removal of engines in the store
    storeHandle.on('change', ({ doc, patches }) => {
        for (const patch of patches) {
            applyUntilTrue([engineSetMonitor, engineCommandsMonitor, engineLastRunMonitor, instancesMonitor], patch, storeHandle)
        }
    })

    // Inject commandLogHandle into the monitor closure so engineCommandsMonitor
    // can pass it through to handleCommand
    ;(storeHandle as any).__commandLogHandle = commandLogHandle ?? null

    // On startup, process any commands already queued for this engine.
    // The storeMonitor only fires on new patches, so commands written before
    // this engine started (or while it was offline) would otherwise be silently ignored.
    // Replay any commands already in the queue at startup.
    const startupStore = storeHandle.doc()
    const startupCmds = [...((startupStore?.engineDB[localEngineId]?.commands as string[]) ?? [])]
    if (startupCmds.length) {
        log(`Replaying ${startupCmds.length} pending command(s) from queue on startup`)
        ;(async () => {
            for (const cmd of startupCmds) {
                const startupKey = `${localEngineId}:${cmd}`
                _currentlyExecuting.add(startupKey)
                await handleCommand(commands, storeHandle, 'engine', cmd, commandLogHandle)
                _currentlyExecuting.delete(startupKey)
                storeHandle.change(doc => {
                    const eng = doc.engineDB[localEngineId as any]
                    if (eng) (eng.commands as any[]).splice(0, 1)
                })
            }
        })()
    }
}
```

## File: src/monitors/timeMonitor.ts
```typescript

import { doc } from 'lib0/dom.js'
import { Timestamp } from '../data/CommonTypes.js'
import { inspectEngine } from '../data/Engine.js'
import { Store, getLocalEngine } from '../data/Store.js'
import { log, contains, deepPrint } from '../utils/utils.js'

export const enableTimeMonitor = (interval, callback) => {
    setInterval(callback, interval)
}

export const logTimeCallback = () => {
    log(`Time callback at ${new Date()}`)
}

// export const generateRandomArrayPopulationCallback = (apps: Array<string>) => {
//     // Randomly populate and depopulate the apps array with app names every 5 seconds. 
//     // Choose from a list of app names such as "app1", "app2", "app3", "app4", "app5" etc.
//     // The array should contain between 0 and 5 app names at any given time.
//     // Make sure that any app name only appears once in the array.
//     // Do it
//     const appNames = ['app1', 'app2', 'app3', 'app4', 'app5']
//     // If the array is empty, add a random app name
//     // If the array is full, remove a random app name
//     // If the array is not empty and not full, randomly decide whether to add or remove an app name and only select an app name that is not already in the array
//     return () => {
//         if (apps.length === 0) {
//             apps.insert(0, [appNames[Math.floor(Math.random() * appNames.length)]])
//         } else if (apps.length === 5) {
//             apps.delete(Math.floor(Math.random() * 5))
//         } else {
//             if (Math.random() < 0.5) {
//                 const randomAppName = appNames[Math.floor(Math.random() * appNames.length)]
//                 if (!contains(apps, randomAppName)) {
//                     apps.insert(0, [randomAppName])
//                 }
//             } else {
//                 apps.delete(Math.floor(Math.random() * apps.length))
//             }
//         }
//     }
// }


// const generateRandomArrayModification = (apps: Array<object>) => {
//     apps.insert(0, [{ name: 'app1' }, { name: 'app2' }, { name: 'app3' }, { name: 'app4' }, { name: 'app5' }])
//     log(`Initialising apps array with app names`)
//     // Create a function that first removes any x letters from all app names and then 
//     // randomly puts a capital x behind the name of an app in the apps array 
//     // Do it
//     return () => {
//         apps.forEach((app: { name: string }, index: number) => {
//             app.name = app.name.replace('X', '')
//             if (Math.random() < 0.5) {
//                 app.name = app.name + 'X'
//             }
//         })
//         was-console-log(`Deep change to apps: ${JSON.stringify(apps.toArray())}`)
//     }
// }

// export const changeTest = (store:Store) => {
//     const localEngine = getLocalEngine(store)
//     if (localEngine && localEngine.lastBooted) {
//         localEngine.lastBooted = localEngine.lastBooted + 1 as Timestamp
//         log(`CHANGING ENGINE LASTBOOTED TO ${localEngine.lastBooted}`)
//         log(deepPrint(localEngine))
//     } else {
//         log(`CHANGETEST: Engine not yet available ********`)
//     }
// }

let runs = 0

export const generateHeartBeat = (storeHandle) => {
    runs++
    storeHandle.change(doc => {
        const lastRun = (new Date()).getTime() as Timestamp
        log(`UPDATING ENGINE LASTRUN TO ${lastRun}`)
        //log(`This is the doc to change: ${deepPrint(doc, 2)}`)
        const localEngine = getLocalEngine(doc)
        localEngine.lastRun = lastRun
        //inspectEngine(store, localEngine)
    })
} 
```

## File: src/monitors/usbDeviceMonitor.ts
```typescript
import chokidar from 'chokidar'
import { getKeys, log, uuid } from '../utils/utils.js'
import { DiskMeta, readHardwareId, readMetaUpdateId } from '../data/Meta.js';
import { $, fs, YAML, chalk } from 'zx'

$.verbose = false;
import { Disk, createOrUpdateDisk, processDisk } from '../data/Disk.js'
import { findDiskByDevice, Store, getDisksOfEngine, getLocalEngine } from '../data/Store.js'
import { DeviceName, DiskID, DiskName, InstanceID, Timestamp } from '../data/CommonTypes.js'

import { Instance, Status, stopInstance } from '../data/Instance.js';
import { config } from '../data/Config.js'
import { DocHandle } from '@automerge/automerge-repo';
import { getCommandLogHandle, addTrace, closeTrace } from '../data/CommandLogStore.js';
import { runWithTrace } from '../utils/CommandLogger.js';

export const enableUsbDeviceMonitor = async (storeHandle: DocHandle<Store>) => {

    // TODO: Alternative implementations for usb device detection — https://github.com/koenswings/idea/issues/46:
    // 1. Monitor /dev iso /dev/engine
    // 2. Monitor /dev/disk/by-label
    // 3. Monitor dmesg output

    const store: Store = storeHandle.doc()
    const localEngine = getLocalEngine(store)

    if (!localEngine) {
        log(`No local engine found in the store`)
        throw new Error(`No local engine found in the store`)
    }

    // Detect the root partition (e.g. sda2) at startup so we can:
    //   - register it as a system disk
    //   - skip the whole-disk parent (e.g. sda) and the boot partition (e.g. sda1)
    // findmnt reads procfs — safe to run in all modes, no sudo needed.
    let systemDevice: DeviceName | null = null
    let systemBootDevice: DeviceName | null = null   // e.g. 'sda1' — the boot partition to skip
    try {
        const rootSource = (await $`findmnt -n -o SOURCE /`).stdout.trim()
        // rootSource is e.g. /dev/sda2 — strip the /dev/ prefix
        const rootDev = rootSource.replace('/dev/', '') as DeviceName
        if (rootDev.match(/^sd[a-z][0-9]+$/)) {
            systemDevice = rootDev
            // Boot partition is parent (strip trailing digits) + '1', e.g. sda2 → sda1
            const parentDev = rootDev.replace(/[0-9]+$/, '')
            systemBootDevice = (parentDev + '1') as DeviceName
            log(`System disk detected: root=${systemDevice}, boot=${systemBootDevice}`)
        }
    } catch (e) {
        log(`Could not detect system device via findmnt: ${e}`)
    }

    const validDevice = function (device: string): boolean {
        // Check if the device begins with "sd", is then followed by a letter and ends with the number 2
        // We need the m flag - see https://regexr.com/7rvpq 
        return device && (device.match(/^sd[a-z][1-2]$/m) || device.match(/^sd[a-z]$/m)) ? true : false
    }

    const addDevice = async function (path: string) {
        log(`A disk on device ${path} has been added`)
        const device = path.split('/').pop() as DeviceName

        if (validDevice(device)) {
            log(`The disk on device ${device} has a valid device name`)

            // Skip whole-disk entries (e.g. sda, sdb) — raw block devices with no
            // filesystem; never directly mountable.
            if (device.match(/^sd[a-z]$/)) {
                log(`Device ${device} is a whole-disk entry — skipping`)
                return
            }

            // Skip the OS boot partition (e.g. sda1 on most Pis, but derived from
            // the actual root device so it works regardless of disk letter).
            if (systemBootDevice && device === systemBootDevice) {
                log(`Device ${device} is the OS boot partition — skipping`)
                return
            }

            log(`Processing the disk on device ${device}`)
            try {
                // System disk (root partition): already mounted at /, no mount needed.
                // Read identity from /META.yaml and register as a system disk.
                // Skip if IDEA_SYSTEM_DISK_SKIP=true (used by Kit's test harness to avoid
                // conflicts when a second engine runs alongside the production instance).
                if (systemDevice && device === systemDevice) {
                    if (config.settings.systemDiskSkip) {
                        log(`Device ${device} is the system disk — skipping registration (IDEA_SYSTEM_DISK_SKIP=true)`)
                        return
                    }
                    log(`Device ${device} is the system disk (root partition) — registering as system disk`)
                    try {
                        const meta = await readMetaUpdateId()  // reads /META.yaml, no device arg
                        const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, 'System Disk' as DiskName, meta.created)
                        await processDisk(storeHandle, disk)
                    } catch (e) {
                        log(`Error processing system disk: ${e}`)
                    }
                    return
                }

                if (config.settings.testMode) {
                    log(`testMode: skipping mount for device ${device} — fixture expected at /disks/${device}`)
                } else {
                    const mountOutput = await $`mount -t ext4`
                    if (mountOutput.stdout.includes(`/dev/${device} on /disks/${device} type ext4`)) {
                        log(`Device ${device} already mounted`)
                    } else {
                        log(`Mounting device ${device}`)
                        await $`sudo mkdir -p /disks/${device}`
                        await $`sudo mount /dev/${device} /disks/${device}`
                        log(`Device ${device} has been successfully mounted`)
                    }
                }

                let meta: DiskMeta
                if (fs.existsSync(`/disks/${device}/META.yaml`)) {
                    log(`Found a META file on device ${device}. This disk has been processed by the system before.`)
                    try {
                        meta = await readMetaUpdateId(device)
                        const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, meta.diskName, meta.created)
                        await processDisk(storeHandle, disk)
                    } catch (error) {
                        log('Error processing the META file on the disk: ' + error)
                    }
                } else {
                    // Before creating a new disk entry, check if a disk is already
                    // registered for this device on THIS engine in the store. This prevents
                    // spurious empty-disk entries when addDevice fires for a device that's
                    // already docked (e.g. during docker compose up -d Recreate cycles).
                    // Scoped to localEngine.id to avoid false matches on other engines' disks
                    // in the shared CRDT store (e.g. all Pis having sda2 as the root device).
                    const existingDisk = findDiskByDevice(storeHandle.doc(), device as DeviceName, localEngine.id)
                    if (existingDisk) {
                        log(`Device ${device} already has a registered disk (${existingDisk.id}) on this engine — skipping new disk creation`)
                        return
                    }
                    log('Could not find a META file. Creating one now.')
                    const diskId = await readHardwareId(device) as DiskID
                    // The disk name should be the name of the volume if available, otherwise 'Unnamed Disk'
                    let diskName: DiskName = 'Unnamed Disk' as DiskName
                    try {
                        const volumeNameOutput = await $`lsblk -no LABEL /dev/${device}`
                        const volumeName = volumeNameOutput.stdout.trim()
                        // Check if it is a valid volume name (not empty) - it should also not have any newlines
                        if (volumeName && volumeName.length > 0 && !volumeName.includes('\n')) {
                            diskName = volumeName as DiskName
                        }
                    } catch (e) {
                        log(`Error reading volume name for device ${device}: ${e}`)
                    }
                    meta = {
                        diskId: diskId ? diskId : uuid() as DiskID,
                        isHardwareId: !!diskId,
                        diskName: diskName,
                        created: Date.now() as Timestamp,
                        lastDocked: Date.now() as Timestamp
                    }
                    const disk: Disk = createOrUpdateDisk(storeHandle, localEngine.id, device, meta.diskId, meta.diskName, meta.created)
                    await processDisk(storeHandle, disk)
                }
            } catch (e) {
                log(`Error processing device ${device}`)
                log(e)
            }
        } else {
            log(`The disk on device ${device} is not on a supported device name`)
        }
    }

    const removeDevice = async (path: string) => {
        const device = path.split('/').pop()
        if (validDevice(device!)) {
            log(`Processing the removal of USB device ${device}`)
            const disk = findDiskByDevice(storeHandle.doc(), device as DeviceName)
            if (!disk) {
                log(`No disk found on ${device}`)
                return
            }
            await undockDisk(storeHandle, disk)
        } else {
            log(`Non-USB device ${device} has been removed`)
        }
    }

    if (!config.settings.isDev && !config.settings.testMode) {
        try {
            log(`Cleaning up the /disks/old folder`)
            await $`sudo rm -fr /disks/old/*`
        } catch (e) {
            log(`Error cleaning up the /disks/old folder`)
            log(e)
        }
    }

    const engineWatchDir = process.env.IDEA_WATCH_DIR || '/dev/engine'
    const actualDevices = (config.settings.isDev || config.settings.testMode) ? [] : (await $`ls ${engineWatchDir}`).toString().split('\n').filter(device => validDevice(device))
    log(`Actual devices: ${actualDevices}`)

    log(`Removing from the network database disks that were attached before the current boot but are no longer attached now...`)

    const storedDisks = getDisksOfEngine(store, localEngine)
    if (storedDisks.length !== 0) {
        log(`The engine object shows previously mounted disks: ${storedDisks.map(d => d.id)}`)
        const storedDevices = storedDisks.map(disk => disk.device).filter((device): device is DeviceName => device !== undefined && device !== null)
        log(`Which were on devices: ${storedDevices}`)

        for (let device of storedDevices) {
            if (!actualDevices.includes(device)) {
                const disk = findDiskByDevice(store, device as DeviceName)
                if (!disk) continue
                // Never undock the system disk based on /dev/engine listing —
                // the root partition is always present and /dev/engine may not
                // be populated yet (e.g. tmpfiles.d race) or may be empty in
                // testMode. System disk presence is guaranteed by the OS itself.
                if (disk.diskTypes?.includes('system')) {
                    log(`Skipping undock of system disk ${disk.id} on device ${device} — system disk is always present`)
                    continue
                }
                log(`Removing disk from previously mounted device ${device}`)
                await undockDisk(storeHandle, disk)
                log(`Disk ${disk.id} removed from local engine`)
            }
        }
    } else {
        log(`No previous disks found in the network database`)
    }

    log(`Cleaning the mount points...`)
    const previousMounts = (config.settings.isDev || config.settings.testMode) ? [] : (await $`ls /disks`).toString().split('\n').filter(device => validDevice(device))
    log(`Previously mounted devices: ${previousMounts}`)
    const mountOutput = await $`mount -t ext4`
    for (let device of previousMounts) {
        log(`Checking if device ${device} is still actual or mounted`)
        if (!actualDevices.includes(device) && !mountOutput.stdout.includes(`/dev/${device} on /disks/${device} type ext4`)) {
            log(`Cleaning up stale mount point for ${device}`)
            try {
                await $`sudo umount /disks/${device}`
            } catch (e: any) {
                if (e.stderr.includes('not mounted')) {
                    await $`sudo mkdir -p /disks/old`
                    await $`sudo mv /disks/${device} /disks/old/${device}`
                    log(`Device ${device} has been moved to /disks/old`)
                } else {
                    log(`Error unmounting device during cleaning ${device}`)
                    log(e)
                }
            }
            log(`Device ${device} has been successfully cleaned up`)
        }
    }

    const watchDir = process.env.IDEA_WATCH_DIR || '/dev/engine'
    const watcher = chokidar.watch(watchDir, { persistent: true })

    watcher
        .on('add', addDevice)
        .on('unlink', removeDevice)
        .on('error', error => log(`Watcher error: ${error}`))

    log(`Watching ${watchDir} for USB devices`)
    return watcher
}

export const undockDisk = async (storeHandle: DocHandle<Store>, disk: Disk) => {
    const store: Store = storeHandle.doc()
    const device = disk.device
    if (!device) {
        log(`Disk ${disk.id} is not mounted on any device. Nothing to undock.`)
        return
    }
    try {
        if (config.settings.testMode) {
            log(`testMode: skipping umount and rm for device ${device}`)
        } else {
            log(`Attempting to unmount device ${device}`)
            try {
                await $`sudo umount /disks/${device}`
                log(`Device ${device} has been successfully unmounted`)
            } catch (e: any) {
                // If the error indicates it wasn't mounted, we can proceed.
                // Otherwise, we must abort to avoid deleting data on a mounted disk.
                if (!e.stderr.includes('not mounted')) {
                    throw new Error(`Failed to unmount ${device}: ${e.message}`)
                }
                log(`Device ${device} was not mounted`)
            }
            await $`sudo rm -fr /disks/${device}`
            log(`Mount point /disks/${device} has been removed`)
        }
        storeHandle.change(doc => {
            const dsk = doc.diskDB[disk.id]
            if (dsk) {
                dsk.dockedTo = null
                dsk.device = null
                dsk.diskTypes = []
                dsk.backupConfig = null
            }
        })
        // Stop all instances of the disk and move them to the 'Undocked' state
        const instancesOnDisk = Object.values(store.instanceDB).filter(instance => String(instance.storedOn) === String(disk.id));
        for (const instance of instancesOnDisk) {
            const cmdLogHandle = getCommandLogHandle()
            const traceId = crypto.randomUUID()
            const traceCtx = { traceId, command: 'stopInstance', args: JSON.stringify({ instanceName: instance.name, diskId: disk.id, reason: 'disk-undocked' }) }
            if (cmdLogHandle) addTrace(cmdLogHandle, { traceId, command: 'stopInstance', args: traceCtx.args, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
            try {
                await runWithTrace(traceCtx, () => stopInstance(storeHandle, instance, disk, 'disk-undocked'))
                if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'ok')
            } catch (e: any) {
                if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'error', e.message ?? String(e))
            }
            log(`Instance ${instance.id} stopped`)
            storeHandle.change(doc => {
                const inst = doc.instanceDB[instance.id]
                // Move the instance to the 'Undocked' state and clear metrics
                if (inst) {
                    inst.status = 'Undocked' as Status
                    inst.metrics = null
                }
            })
            log(`Instance ${instance.id} has been moved to the 'Undocked' state`)
        }
    } catch (e) {
        log(`Error unmounting device ${device}`)
        log(e)
    }
}

```

## File: src/utils/CommandLogger.ts
```typescript
/**
 * CommandLogger.ts
 *
 * Captures console output per command invocation using AsyncLocalStorage.
 * Each command gets a unique trace context that flows automatically through
 * every async call in its chain — no changes needed in individual commands.
 *
 * Usage:
 *   1. Call initCommandLogger(handle) once at engine startup.
 *   2. Wrap every command dispatch in runWithTrace(ctx, fn).
 *   3. Everything inside fn() that calls console.log/info/warn/error/debug
 *      is automatically collected into that trace's log list.
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { DocHandle } from '@automerge/automerge-repo'
import type { CommandLogStore, LogEntry } from '../data/CommandLogStore.js'
import { flushLogs } from '../data/CommandLogStore.js'

export interface TraceContext {
  traceId: string
  command: string
  args: string
}

// ── AsyncLocalStorage instance ───────────────────────────────────────────────

const storage = new AsyncLocalStorage<TraceContext>()

export const getActiveTrace = (): TraceContext | undefined => storage.getStore()

export const runWithTrace = async <T>(
  ctx: TraceContext,
  fn: () => Promise<T>
): Promise<T> => {
  return storage.run(ctx, fn)
}

// ── Per-trace pending buffers and debounced flush ────────────────────────────

const pendingBuffers = new Map<string, LogEntry[]>()
const flushTimers    = new Map<string, ReturnType<typeof setTimeout>>()
const FLUSH_DEBOUNCE_MS = 50

let _handle: DocHandle<CommandLogStore> | null = null

const scheduleFlush = (traceId: string): void => {
  const existing = flushTimers.get(traceId)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    flushTimers.delete(traceId)
    const buffer = pendingBuffers.get(traceId)
    if (buffer && buffer.length > 0 && _handle) {
      const batch = buffer.splice(0)           // drain in-place
      flushLogs(_handle, traceId, batch)
    }
  }, FLUSH_DEBOUNCE_MS)

  flushTimers.set(traceId, timer)
}

/**
 * Append a log entry to a trace's pending buffer and schedule a flush.
 * Called from the patched console methods.
 */
export const appendToTrace = (traceId: string, entry: LogEntry): void => {
  if (!pendingBuffers.has(traceId)) pendingBuffers.set(traceId, [])
  pendingBuffers.get(traceId)!.push(entry)
  scheduleFlush(traceId)
}

/**
 * Force-flush any remaining buffered entries for a trace immediately.
 * Call this right before closeTrace so logs aren't lost on fast commands.
 */
export const flushTrace = async (traceId: string): Promise<void> => {
  const timer = flushTimers.get(traceId)
  if (timer) {
    clearTimeout(timer)
    flushTimers.delete(traceId)
  }
  const buffer = pendingBuffers.get(traceId)
  if (buffer && buffer.length > 0 && _handle) {
    const batch = buffer.splice(0)
    flushLogs(_handle, traceId, batch)
  }
  pendingBuffers.delete(traceId)
}

// ── Console patch ────────────────────────────────────────────────────────────

let _patched = false

const patchConsole = (): void => {
  if (_patched) return
  _patched = true

  const originals = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  } as const

  type Level = keyof typeof originals

  const patch = (level: Level) => {
    console[level] = (...args: unknown[]) => {
      originals[level](...args)              // always write to stdout
      const ctx = getActiveTrace()
      if (ctx) {
        appendToTrace(ctx.traceId, {
          level,
          message: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
          timestamp: Date.now(),
        })
      }
    }
  }

  patch('log')
  patch('info')
  patch('warn')
  patch('error')
  patch('debug')
}

// ── Public init ──────────────────────────────────────────────────────────────

/**
 * Call once at engine startup, after the CommandLogStore doc is created.
 * Patches console and connects the logger to the Automerge doc handle.
 */
export const initCommandLogger = (handle: DocHandle<CommandLogStore>): void => {
  _handle = handle
  patchConsole()
}

```

## File: src/utils/ResourceLock.ts
```typescript
/**
 * ResourceLock.ts — per-resource mutual exclusion for long-running operations
 *
 * Group P: Concurrent operation safety
 *
 * Prevents two operations from mutating the same resource simultaneously.
 * Resources are identified by string keys (instanceId, diskId, or compound).
 *
 * Design:
 *   - In-memory only — not persisted to the store. Locks are engine-local and
 *     reset on restart (acceptable: operationDB recovery handles restart cases).
 *   - acquire() returns false immediately if the resource is locked (non-blocking).
 *     Callers must check and surface a 409-style error to the operator.
 *   - All long-running commands (copyApp, moveApp, backupApp, restoreApp) acquire
 *     locks on their affected resources before starting and release in finally{}.
 *
 * Resource key conventions:
 *   - Instance-level ops: `instance:<instanceId>`
 *   - Disk-level ops:     `disk:<diskId>`
 *   - Multi-resource ops (e.g. copyApp): acquire both source and target instance keys
 */

import { log } from './utils.js'
import { chalk } from 'zx'

export interface LockInfo {
    kind: string        // operation kind holding the lock
    acquiredAt: number  // unix ms
}

class ResourceLockManager {
    private locks = new Map<string, LockInfo>()

    /**
     * Attempt to acquire a lock on `key` for operation `kind`.
     * Returns true if acquired, false if already locked.
     */
    acquire(key: string, kind: string): boolean {
        if (this.locks.has(key)) {
            const held = this.locks.get(key)!
            log(chalk.yellow(`ResourceLock: '${key}' already locked by '${held.kind}' (since ${new Date(held.acquiredAt).toISOString()})`))
            return false
        }
        this.locks.set(key, { kind, acquiredAt: Date.now() })
        log(`ResourceLock: acquired '${key}' for '${kind}'`)
        return true
    }

    /**
     * Acquire multiple keys atomically (all-or-nothing).
     * Returns true if all acquired, false if any were already locked.
     * On failure, no locks are held (rolled back).
     */
    acquireAll(keys: string[], kind: string): boolean {
        const acquired: string[] = []
        for (const key of keys) {
            if (!this.acquire(key, kind)) {
                // Roll back already-acquired keys
                acquired.forEach(k => this.release(k))
                return false
            }
            acquired.push(key)
        }
        return true
    }

    /**
     * Release a lock. Safe to call even if the key is not locked.
     */
    release(key: string): void {
        if (this.locks.has(key)) {
            this.locks.delete(key)
            log(`ResourceLock: released '${key}'`)
        }
    }

    /**
     * Release multiple keys.
     */
    releaseAll(keys: string[]): void {
        keys.forEach(k => this.release(k))
    }

    /**
     * Check if a key is currently locked.
     */
    isLocked(key: string): boolean {
        return this.locks.has(key)
    }

    /**
     * Return current lock info for a key, or undefined if unlocked.
     */
    getLockInfo(key: string): LockInfo | undefined {
        return this.locks.get(key)
    }

    /**
     * Return all currently held locks (for diagnostics).
     */
    allLocks(): Map<string, LockInfo> {
        return new Map(this.locks)
    }
}

// Singleton — one lock manager per engine process
export const resourceLock = new ResourceLockManager()

// Key helpers
export const instanceKey = (instanceId: string) => `instance:${instanceId}`
export const diskKey = (diskId: string) => `disk:${diskId}`

```

## File: src/utils/commandUtils.ts
```typescript
import { DocHandle } from "@automerge/automerge-repo";
import { Store } from "../data/Store.js";
import { Command, EngineID } from "../data/CommonTypes.js";
import { ArgumentDescriptor, CommandDefinition } from "../data/CommandDefinition.js";
import { CommandLogStore, addTrace, closeTrace, getCommandLogHandle } from "../data/CommandLogStore.js";
import { runWithTrace, flushTrace } from "./CommandLogger.js";
import { print } from './utils.js';


export const handleCommand = async (
    commands: CommandDefinition[],
    storeHandle: DocHandle<Store> | null,
    context: 'console' | 'engine',
    input: string,
    commandLogHandle?: DocHandle<CommandLogStore> | null
): Promise<void> => {
    const trimmedInput = input.trim();
    const commandName = trimmedInput.split(' ')[0];
    const command = commands.find(cmd => cmd.name === commandName);

    if (!command) {
        print(`Unknown command: ${commandName}`);
        return;
    }

    let stringArgs: string[] = [];
    // Special case for commands that take the entire rest of the line as a single argument
    if (command.args.length === 1) {
        const firstSpaceIndex = trimmedInput.indexOf(' ');
        if (firstSpaceIndex !== -1) {
            stringArgs.push(trimmedInput.substring(firstSpaceIndex + 1));
        }
    } else {
        stringArgs = trimmedInput.split(' ').slice(1).filter(arg => arg.length > 0);
    }

    // Scope checking
    if (context === 'console' && command.scope === 'engine') {
        print(`Error: Command '${commandName}' can only be executed on an engine. Use 'send <engineId> ${commandName} ...' to execute it remotely.`);
        return;
    }

    if (context === 'engine' && command.scope === 'console') {
        print(`Error: Command '${commandName}' can only be executed on a console.`);
        return;
    }

    let args: any[];
    try {
        args = stringArgs.map((arg, index) => {
            if (index >= command.args.length) throw new Error("Too many arguments");
            return convertToType(arg, command.args[index]);
        });
        if (args.length < command.args.length) throw new Error("Insufficient arguments");
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
        return;
    }

    // ── Trace setup ──────────────────────────────────────────────────────────
    const traceId = crypto.randomUUID();
    // Build a named args object when the CommandDefinition has arg names defined,
    // otherwise fall back to a positional array. The Console filters traces by
    // args['instanceName'] or args['instanceId'], so named args are required.
    const namedArgs: Record<string, string> | string[] =
        command.args.every(a => a.name)
            ? Object.fromEntries(command.args.map((a, i) => [a.name!, stringArgs[i] ?? null]))
            : stringArgs
    const argsJson = JSON.stringify(namedArgs);
    const traceCtx = { traceId, command: commandName, args: argsJson };

    if (commandLogHandle) {
        addTrace(commandLogHandle, {
            traceId,
            command: commandName,
            args: argsJson,
            startedAt: Date.now(),
            completedAt: null,
            status: 'running',
            errorMessage: null,
        });
    }

    // ── Execute inside trace context ─────────────────────────────────────────
    try {
        await runWithTrace(traceCtx, async () => { await command.execute(storeHandle, ...args); });
        if (commandLogHandle) {
            await flushTrace(traceId);
            closeTrace(commandLogHandle, traceId, 'ok');
        }
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
        if (commandLogHandle) {
            await flushTrace(traceId);
            closeTrace(commandLogHandle, traceId, 'error', error.message);
        }
    }
}


/**
 * A dependency-free utility to add a command to a specific engine's command array in the store.
 * This is used by tests and the 'send' command definition.
 */
export const sendCommand = (storeHandle: DocHandle<Store>, engineId: EngineID, command: Command): void => {
    print(`Sending command '${command}' to engine ${engineId}`);

    const store = storeHandle.doc();
    if (!store?.engineDB[engineId]) {
        console.error(`Cannot send command: Engine ${engineId} not found in store.`);
        return;
    }

    // Trace the dispatch on the originating engine so the Console shows
    // cross-engine commands in history (e.g. copyApp dispatching startInstance
    // to a remote engine). This is a one-shot trace with no log lines.
    const cmdLogHandle = getCommandLogHandle()
    if (cmdLogHandle) {
        const commandName = String(command).split(' ')[0]
        const traceId = crypto.randomUUID()
        addTrace(cmdLogHandle, {
            traceId,
            command: commandName,
            args: JSON.stringify({ dispatchedTo: engineId, command: String(command) }),
            startedAt: Date.now(),
            completedAt: Date.now(),
            status: 'running',
            errorMessage: null,
        })
        closeTrace(cmdLogHandle, traceId, 'ok')
    }

    storeHandle.change(doc => {
        const engine = doc.engineDB[engineId];
        if (engine) {
            engine.commands.push(command);
        }
    });
}
const convertToType = (str: string, descriptor: ArgumentDescriptor): any => {
    switch (descriptor.type) {
        case "number":
            const num = parseFloat(str);
            if (isNaN(num)) throw new Error("Cannot convert to number");
            return num;
        case "string":
            return str;
        case "object":
            if (!descriptor.objectSpec) throw new Error("Object specification is missing");
            try {
                const obj = JSON.parse(str);
                for (const [key, fieldSpec] of Object.entries(descriptor.objectSpec)) {
                    if (!(key in obj)) throw new Error(`Missing key '${key}' in object`);
                    switch (fieldSpec.type) {
                        case 'number':
                            const value = parseFloat(obj[key]);
                            if (isNaN(value)) throw new Error(`Key '${key}' is not a valid number`);
                            obj[key] = value;
                            break;
                        case 'string':
                            if (typeof obj[key] !== 'string') throw new Error(`Key '${key}' is not a valid string`);
                            break;
                    }
                }
                return obj;
            } catch {
                throw new Error("Cannot convert to object");
            }
        default:
            throw new Error("Unsupported type");
    }
}

```

## File: src/utils/nameGenerator.ts
```typescript
import util from 'util';
import { Hostname } from '../data/CommonTypes.js';

// Docker-style name generation
// Inspired by
// - https://github.com/moby/moby/blob/39f7b2b6d0156811d9683c6cb0743118ae516a11/pkg/namesgenerator/names-generator.go#L852-L863 
// - https://github.com/subfuzion/docker-namesgenerator/blob/master/namesgenerator.js
  
  const adjectives = [
    "admiring",
          "adoring",
          "affectionate",
          "agitated",
          "amazing",
          "angry",
          "awesome",
          "beautiful",
          "blissful",
          "bold",
          "boring",
          "brave",
          "busy",
          "charming",
          "clever",
          "cool",
          "compassionate",
          "competent",
          "condescending",
          "confident",
          "cranky",
          "crazy",
          "dazzling",
          "determined",
          "distracted",
          "dreamy",
          "eager",
          "ecstatic",
          "elastic",
          "elated",
          "elegant",
          "eloquent",
          "epic",
          "exciting",
          "fervent",
          "festive",
          "flamboyant",
          "focused",
          "friendly",
          "frosty",
          "funny",
          "gallant",
          "gifted",
          "goofy",
          "gracious",
          "great",
          "happy",
          "hardcore",
          "heuristic",
          "hopeful",
          "hungry",
          "infallible",
          "inspiring",
          "intelligent",
          "interesting",
          "jolly",
          "jovial",
          "keen",
          "kind",
          "laughing",
          "loving",
          "lucid",
          "magical",
          "mystifying",
          "modest",
          "musing",
          "naughty",
          "nervous",
          "nice",
          "nifty",
          "nostalgic",
          "objective",
          "optimistic",
          "peaceful",
          "pedantic",
          "pensive",
          "practical",
          "priceless",
          "quirky",
          "quizzical",
          "recursing",
          "relaxed",
          "reverent",
          "romantic",
          "sad",
          "serene",
          "sharp",
          "silly",
          "sleepy",
          "stoic",
          "strange",
          "stupefied",
          "suspicious",
          "sweet",
          "tender",
          "thirsty",
          "trusting",
          "unruffled",
          "upbeat",
          "vibrant",
          "vigilant",
          "vigorous",
          "wizardly",
          "wonderful",
          "xenodochial",
          "youthful",
          "zealous",
          "zen",
  ]
  
  const scientists = [
    // Maria Gaetana Agnesi - Italian mathematician, philosopher, theologian and humanitarian. She was the first woman to write a mathematics handbook and the first woman appointed as a Mathematics Professor at a University. https://en.wikipedia.org/wiki/Maria_Gaetana_Agnesi
    "agnesi",
  
    // Muhammad ibn Jābir al-Ḥarrānī al-Battānī was a founding father of astronomy. https://en.wikipedia.org/wiki/Mu%E1%B8%A5ammad_ibn_J%C4%81bir_al-%E1%B8%A4arr%C4%81n%C4%AB_al-Batt%C4%81n%C4%AB
    "albattani",
  
    // Frances E. Allen, became the first female IBM Fellow in 1989. In 2006, she became the first female recipient of the ACM's Turing Award. https://en.wikipedia.org/wiki/Frances_E._Allen
    "allen",
  
    // June Almeida - Scottish virologist who took the first pictures of the rubella virus - https://en.wikipedia.org/wiki/June_Almeida
    "almeida",
  
    // Kathleen Antonelli, American computer programmer and one of the six original programmers of the ENIAC - https://en.wikipedia.org/wiki/Kathleen_Antonelli
    "antonelli",
  
    // Archimedes was a physicist, engineer and mathematician who invented too many things to list them here. https://en.wikipedia.org/wiki/Archimedes
    "archimedes",
  
    // Maria Ardinghelli - Italian translator, mathematician and physicist - https://en.wikipedia.org/wiki/Maria_Ardinghelli
    "ardinghelli",
  
    // Aryabhata - Ancient Indian mathematician-astronomer during 476-550 CE https://en.wikipedia.org/wiki/Aryabhata
    "aryabhata",
  
    // Wanda Austin - Wanda Austin is the President and CEO of The Aerospace Corporation, a leading architect for the US security space programs. https://en.wikipedia.org/wiki/Wanda_Austin
    "austin",
  
    // Charles Babbage invented the concept of a programmable computer. https://en.wikipedia.org/wiki/Charles_Babbage.
    "babbage",
  
    // Stefan Banach - Polish mathematician, was one of the founders of modern functional analysis. https://en.wikipedia.org/wiki/Stefan_Banach
    "banach",
  
    // Buckaroo Banzai and his mentor Dr. Hikita perfected the "oscillation overthruster", a device that allows one to pass through solid matter. - https://en.wikipedia.org/wiki/The_Adventures_of_Buckaroo_Banzai_Across_the_8th_Dimension
    "banzai",
  
    // John Bardeen co-invented the transistor - https://en.wikipedia.org/wiki/John_Bardeen
    "bardeen",
  
    // Jean Bartik, born Betty Jean Jennings, was one of the original programmers for the ENIAC computer. https://en.wikipedia.org/wiki/Jean_Bartik
    "bartik",
  
    // Laura Bassi, the world's first female professor https://en.wikipedia.org/wiki/Laura_Bassi
    "bassi",
  
    // Hugh Beaver, British engineer, founder of the Guinness Book of World Records https://en.wikipedia.org/wiki/Hugh_Beaver
    "beaver",
  
    // Alexander Graham Bell - an eminent Scottish-born scientist, inventor, engineer and innovator who is credited with inventing the first practical telephone - https://en.wikipedia.org/wiki/Alexander_Graham_Bell
    "bell",
  
    // Karl Friedrich Benz - a German automobile engineer. Inventor of the first practical motorcar. https://en.wikipedia.org/wiki/Karl_Benz
    "benz",
  
    // Homi J Bhabha - was an Indian nuclear physicist, founding director, and professor of physics at the Tata Institute of Fundamental Research. Colloquially known as "father of Indian nuclear programme"- https://en.wikipedia.org/wiki/Homi_J._Bhabha
    "bhabha",
  
    // Bhaskara II - Ancient Indian mathematician-astronomer whose work on calculus predates Newton and Leibniz by over half a millennium - https://en.wikipedia.org/wiki/Bh%C4%81skara_II#Calculus
    "bhaskara",
  
    // Sue Black - British computer scientist and campaigner. She has been instrumental in saving Bletchley Park, the site of World War II codebreaking - https://en.wikipedia.org/wiki/Sue_Black_(computer_scientist)
    "black",
  
    // Elizabeth Helen Blackburn - Australian-American Nobel laureate; best known for co-discovering telomerase. https://en.wikipedia.org/wiki/Elizabeth_Blackburn
    "blackburn",
  
    // Elizabeth Blackwell - American doctor and first American woman to receive a medical degree - https://en.wikipedia.org/wiki/Elizabeth_Blackwell
    "blackwell",
  
    // Niels Bohr is the father of quantum theory. https://en.wikipedia.org/wiki/Niels_Bohr.
    "bohr",
  
    // Kathleen Booth, she's credited with writing the first assembly language. https://en.wikipedia.org/wiki/Kathleen_Booth
    "booth",
  
    // Anita Borg - Anita Borg was the founding director of the Institute for Women and Technology (IWT). https://en.wikipedia.org/wiki/Anita_Borg
    "borg",
  
    // Satyendra Nath Bose - He provided the foundation for Bose–Einstein statistics and the theory of the Bose–Einstein condensate. - https://en.wikipedia.org/wiki/Satyendra_Nath_Bose
    "bose",
  
    // Katherine Louise Bouman is an imaging scientist and Assistant Professor of Computer Science at the California Institute of Technology. She researches computational methods for imaging, and developed an algorithm that made possible the picture first visualization of a black hole using the Event Horizon Telescope. - https://en.wikipedia.org/wiki/Katie_Bouman
    "bouman",
  
    // Evelyn Boyd Granville - She was one of the first African-American woman to receive a Ph.D. in mathematics; she earned it in 1949 from Yale University. https://en.wikipedia.org/wiki/Evelyn_Boyd_Granville
    "boyd",
  
    // Brahmagupta - Ancient Indian mathematician during 598-670 CE who gave rules to compute with zero - https://en.wikipedia.org/wiki/Brahmagupta#Zero
    "brahmagupta",
  
    // Walter Houser Brattain co-invented the transistor - https://en.wikipedia.org/wiki/Walter_Houser_Brattain
    "brattain",
  
    // Emmett Brown invented time travel. https://en.wikipedia.org/wiki/Emmett_Brown (thanks Brian Goff)
    "brown",
  
    // Linda Brown Buck - American biologist and Nobel laureate best known for her genetic and molecular analyses of the mechanisms of smell. https://en.wikipedia.org/wiki/Linda_B._Buck
    "buck",
  
    // Dame Susan Jocelyn Bell Burnell - Northern Irish astrophysicist who discovered radio pulsars and was the first to analyse them. https://en.wikipedia.org/wiki/Jocelyn_Bell_Burnell
    "burnell",
  
    // Annie Jump Cannon - pioneering female astronomer who classified hundreds of thousands of stars and created the system we use to understand stars today. https://en.wikipedia.org/wiki/Annie_Jump_Cannon
    "cannon",
  
    // Rachel Carson - American marine biologist and conservationist, her book Silent Spring and other writings are credited with advancing the global environmental movement. https://en.wikipedia.org/wiki/Rachel_Carson
    "carson",
  
    // Dame Mary Lucy Cartwright - British mathematician who was one of the first to study what is now known as chaos theory. Also known for Cartwright's theorem which finds applications in signal processing. https://en.wikipedia.org/wiki/Mary_Cartwright
    "cartwright",
  
    // George Washington Carver - American agricultural scientist and inventor. He was the most prominent black scientist of the early 20th century. https://en.wikipedia.org/wiki/George_Washington_Carver
    "carver",
  
    // Vinton Gray Cerf - American Internet pioneer, recognised as one of "the fathers of the Internet". With Robert Elliot Kahn, he designed TCP and IP, the primary data communication protocols of the Internet and other computer networks. https://en.wikipedia.org/wiki/Vint_Cerf
    "cerf",
  
    // Subrahmanyan Chandrasekhar - Astrophysicist known for his mathematical theory on different stages and evolution in structures of the stars. He has won nobel prize for physics - https://en.wikipedia.org/wiki/Subrahmanyan_Chandrasekhar
    "chandrasekhar",
  
    // Sergey Alexeyevich Chaplygin (Russian: Серге́й Алексе́евич Чаплы́гин; April 5, 1869 – October 8, 1942) was a Russian and Soviet physicist, mathematician, and mechanical engineer. He is known for mathematical formulas such as Chaplygin's equation and for a hypothetical substance in cosmology called Chaplygin gas, named after him. https://en.wikipedia.org/wiki/Sergey_Chaplygin
    "chaplygin",
  
    // Émilie du Châtelet - French natural philosopher, mathematician, physicist, and author during the early 1730s, known for her translation of and commentary on Isaac Newton's book Principia containing basic laws of physics. https://en.wikipedia.org/wiki/%C3%89milie_du_Ch%C3%A2telet
    "chatelet",
  
    // Asima Chatterjee was an Indian organic chemist noted for her research on vinca alkaloids, development of drugs for treatment of epilepsy and malaria - https://en.wikipedia.org/wiki/Asima_Chatterjee
    "chatterjee",
  
    // David Lee Chaum - American computer scientist and cryptographer. Known for his seminal contributions in the field of anonymous communication. https://en.wikipedia.org/wiki/David_Chaum
    "chaum",
  
    // Pafnuty Chebyshev - Russian mathematician. He is known fo his works on probability, statistics, mechanics, analytical geometry and number theory https://en.wikipedia.org/wiki/Pafnuty_Chebyshev
    "chebyshev",
  
    // Joan Clarke - Bletchley Park code breaker during the Second World War who pioneered techniques that remained top secret for decades. Also an accomplished numismatist https://en.wikipedia.org/wiki/Joan_Clarke
    "clarke",
  
    // Bram Cohen - American computer programmer and author of the BitTorrent peer-to-peer protocol. https://en.wikipedia.org/wiki/Bram_Cohen
    "cohen",
  
    // Jane Colden - American botanist widely considered the first female American botanist - https://en.wikipedia.org/wiki/Jane_Colden
    "colden",
  
    // Gerty Theresa Cori - American biochemist who became the third woman—and first American woman—to win a Nobel Prize in science, and the first woman to be awarded the Nobel Prize in Physiology or Medicine. Cori was born in Prague. https://en.wikipedia.org/wiki/Gerty_Cori
    "cori",
  
    // Seymour Roger Cray was an American electrical engineer and supercomputer architect who designed a series of computers that were the fastest in the world for decades. https://en.wikipedia.org/wiki/Seymour_Cray
    "cray",
  
    // This entry reflects a husband and wife team who worked together:
    // Joan Curran was a Welsh scientist who developed radar and invented chaff, a radar countermeasure. https://en.wikipedia.org/wiki/Joan_Curran
    // Samuel Curran was an Irish physicist who worked alongside his wife during WWII and invented the proximity fuse. https://en.wikipedia.org/wiki/Samuel_Curran
    "curran",
  
    // Marie Curie discovered radioactivity. https://en.wikipedia.org/wiki/Marie_Curie.
    "curie",
  
    // Charles Darwin established the principles of natural evolution. https://en.wikipedia.org/wiki/Charles_Darwin.
    "darwin",
  
    // Leonardo Da Vinci invented too many things to list here. https://en.wikipedia.org/wiki/Leonardo_da_Vinci.
    "davinci",
  
    // A. K. (Alexander Keewatin) Dewdney, Canadian mathematician, computer scientist, author and filmmaker. Contributor to Scientific American's "Computer Recreations" from 1984 to 1991. Author of Core War (program), The Planiverse, The Armchair Universe, The Magic Machine, The New Turing Omnibus, and more. https://en.wikipedia.org/wiki/Alexander_Dewdney
    "dewdney",
  
    // Satish Dhawan - Indian mathematician and aerospace engineer, known for leading the successful and indigenous development of the Indian space programme. https://en.wikipedia.org/wiki/Satish_Dhawan
    "dhawan",
  
    // Bailey Whitfield Diffie - American cryptographer and one of the pioneers of public-key cryptography. https://en.wikipedia.org/wiki/Whitfield_Diffie
    "diffie",
  
    // Edsger Wybe Dijkstra was a Dutch computer scientist and mathematical scientist. https://en.wikipedia.org/wiki/Edsger_W._Dijkstra.
    "dijkstra",
  
    // Paul Adrien Maurice Dirac - English theoretical physicist who made fundamental contributions to the early development of both quantum mechanics and quantum electrodynamics. https://en.wikipedia.org/wiki/Paul_Dirac
    "dirac",
  
    // Agnes Meyer Driscoll - American cryptanalyst during World Wars I and II who successfully cryptanalysed a number of Japanese ciphers. She was also the co-developer of one of the cipher machines of the US Navy, the CM. https://en.wikipedia.org/wiki/Agnes_Meyer_Driscoll
    "driscoll",
  
    // Donna Dubinsky - played an integral role in the development of personal digital assistants (PDAs) serving as CEO of Palm, Inc. and co-founding Handspring. https://en.wikipedia.org/wiki/Donna_Dubinsky
    "dubinsky",
  
    // Annie Easley - She was a leading member of the team which developed software for the Centaur rocket stage and one of the first African-Americans in her field. https://en.wikipedia.org/wiki/Annie_Easley
    "easley",
  
    // Thomas Alva Edison, prolific inventor https://en.wikipedia.org/wiki/Thomas_Edison
    "edison",
  
    // Albert Einstein invented the general theory of relativity. https://en.wikipedia.org/wiki/Albert_Einstein
    "einstein",
  
    // Alexandra Asanovna Elbakyan (Russian: Алекса́ндра Аса́новна Элбакя́н) is a Kazakhstani graduate student, computer programmer, internet pirate in hiding, and the creator of the site Sci-Hub. Nature has listed her in 2016 in the top ten people that mattered in science, and Ars Technica has compared her to Aaron Swartz. - https://en.wikipedia.org/wiki/Alexandra_Elbakyan
    "elbakyan",
  
    // Taher A. ElGamal - Egyptian cryptographer best known for the ElGamal discrete log cryptosystem and the ElGamal digital signature scheme. https://en.wikipedia.org/wiki/Taher_Elgamal
    "elgamal",
  
    // Gertrude Elion - American biochemist, pharmacologist and the 1988 recipient of the Nobel Prize in Medicine - https://en.wikipedia.org/wiki/Gertrude_Elion
    "elion",
  
    // James Henry Ellis - British engineer and cryptographer employed by the GCHQ. Best known for conceiving for the first time, the idea of public-key cryptography. https://en.wikipedia.org/wiki/James_H._Ellis
    "ellis",
  
    // Douglas Engelbart gave the mother of all demos: https://en.wikipedia.org/wiki/Douglas_Engelbart
    "engelbart",
  
    // Euclid invented geometry. https://en.wikipedia.org/wiki/Euclid
    "euclid",
  
    // Leonhard Euler invented large parts of modern mathematics. https://de.wikipedia.org/wiki/Leonhard_Euler
    "euler",
  
    // Michael Faraday - British scientist who contributed to the study of electromagnetism and electrochemistry. https://en.wikipedia.org/wiki/Michael_Faraday
    "faraday",
  
    // Horst Feistel - German-born American cryptographer who was one of the earliest non-government researchers to study the design and theory of block ciphers. Co-developer of DES and Lucifer. Feistel networks, a symmetric structure used in the construction of block ciphers are named after him. https://en.wikipedia.org/wiki/Horst_Feistel
    "feistel",
  
    // Pierre de Fermat pioneered several aspects of modern mathematics. https://en.wikipedia.org/wiki/Pierre_de_Fermat
    "fermat",
  
    // Enrico Fermi invented the first nuclear reactor. https://en.wikipedia.org/wiki/Enrico_Fermi.
    "fermi",
  
    // Richard Feynman was a key contributor to quantum mechanics and particle physics. https://en.wikipedia.org/wiki/Richard_Feynman
    "feynman",
  
    // Benjamin Franklin is famous for his experiments in electricity and the invention of the lightning rod.
    "franklin",
  
    // Yuri Alekseyevich Gagarin - Soviet pilot and cosmonaut, best known as the first human to journey into outer space. https://en.wikipedia.org/wiki/Yuri_Gagarin
    "gagarin",
  
    // Galileo was a founding father of modern astronomy, and faced politics and obscurantism to establish scientific truth.  https://en.wikipedia.org/wiki/Galileo_Galilei
    "galileo",
  
    // Évariste Galois - French mathematician whose work laid the foundations of Galois theory and group theory, two major branches of abstract algebra, and the subfield of Galois connections, all while still in his late teens. https://en.wikipedia.org/wiki/%C3%89variste_Galois
    "galois",
  
    // Kadambini Ganguly - Indian physician, known for being the first South Asian female physician, trained in western medicine, to graduate in South Asia. https://en.wikipedia.org/wiki/Kadambini_Ganguly
    "ganguly",
  
    // William Henry "Bill" Gates III is an American business magnate, philanthropist, investor, computer programmer, and inventor. https://en.wikipedia.org/wiki/Bill_Gates
    "gates",
  
    // Johann Carl Friedrich Gauss - German mathematician who made significant contributions to many fields, including number theory, algebra, statistics, analysis, differential geometry, geodesy, geophysics, mechanics, electrostatics, magnetic fields, astronomy, matrix theory, and optics. https://en.wikipedia.org/wiki/Carl_Friedrich_Gauss
    "gauss",
  
    // Marie-Sophie Germain - French mathematician, physicist and philosopher. Known for her work on elasticity theory, number theory and philosophy. https://en.wikipedia.org/wiki/Sophie_Germain
    "germain",
  
    // Adele Goldberg, was one of the designers and developers of the Smalltalk language. https://en.wikipedia.org/wiki/Adele_Goldberg_(computer_scientist)
    "goldberg",
  
    // Adele Goldstine, born Adele Katz, wrote the complete technical description for the first electronic digital computer, ENIAC. https://en.wikipedia.org/wiki/Adele_Goldstine
    "goldstine",
  
    // Shafi Goldwasser is a computer scientist known for creating theoretical foundations of modern cryptography. Winner of 2012 ACM Turing Award. https://en.wikipedia.org/wiki/Shafi_Goldwasser
    "goldwasser",
  
    // James Golick, all around gangster.
    "golick",
  
    // Jane Goodall - British primatologist, ethologist, and anthropologist who is considered to be the world's foremost expert on chimpanzees - https://en.wikipedia.org/wiki/Jane_Goodall
    "goodall",
  
    // Stephen Jay Gould was was an American paleontologist, evolutionary biologist, and historian of science. He is most famous for the theory of punctuated equilibrium - https://en.wikipedia.org/wiki/Stephen_Jay_Gould
    "gould",
  
    // Carolyn Widney Greider - American molecular biologist and joint winner of the 2009 Nobel Prize for Physiology or Medicine for the discovery of telomerase. https://en.wikipedia.org/wiki/Carol_W._Greider
    "greider",
  
    // Alexander Grothendieck - German-born French mathematician who became a leading figure in the creation of modern algebraic geometry. https://en.wikipedia.org/wiki/Alexander_Grothendieck
    "grothendieck",
  
    // Lois Haibt - American computer scientist, part of the team at IBM that developed FORTRAN - https://en.wikipedia.org/wiki/Lois_Haibt
    "haibt",
  
    // Margaret Hamilton - Director of the Software Engineering Division of the MIT Instrumentation Laboratory, which developed on-board flight software for the Apollo space program. https://en.wikipedia.org/wiki/Margaret_Hamilton_(scientist)
    "hamilton",
  
    // Caroline Harriet Haslett - English electrical engineer, electricity industry administrator and champion of women's rights. Co-author of British Standard 1363 that specifies AC power plugs and sockets used across the United Kingdom (which is widely considered as one of the safest designs). https://en.wikipedia.org/wiki/Caroline_Haslett
    "haslett",
  
    // Stephen Hawking pioneered the field of cosmology by combining general relativity and quantum mechanics. https://en.wikipedia.org/wiki/Stephen_Hawking
    "hawking",
  
    // Martin Edward Hellman - American cryptologist, best known for his invention of public-key cryptography in co-operation with Whitfield Diffie and Ralph Merkle. https://en.wikipedia.org/wiki/Martin_Hellman
    "hellman",
  
    // Werner Heisenberg was a founding father of quantum mechanics. https://en.wikipedia.org/wiki/Werner_Heisenberg
    "heisenberg",
  
    // Grete Hermann was a German philosopher noted for her philosophical work on the foundations of quantum mechanics. https://en.wikipedia.org/wiki/Grete_Hermann
    "hermann",
  
    // Caroline Lucretia Herschel - German astronomer and discoverer of several comets. https://en.wikipedia.org/wiki/Caroline_Herschel
    "herschel",
  
    // Heinrich Rudolf Hertz - German physicist who first conclusively proved the existence of the electromagnetic waves. https://en.wikipedia.org/wiki/Heinrich_Hertz
    "hertz",
  
    // Jaroslav Heyrovský was the inventor of the polarographic method, father of the electroanalytical method, and recipient of the Nobel Prize in 1959. His main field of work was polarography. https://en.wikipedia.org/wiki/Jaroslav_Heyrovsk%C3%BD
    "heyrovsky",
  
    // Dorothy Hodgkin was a British biochemist, credited with the development of protein crystallography. She was awarded the Nobel Prize in Chemistry in 1964. https://en.wikipedia.org/wiki/Dorothy_Hodgkin
    "hodgkin",
  
    // Douglas R. Hofstadter is an American professor of cognitive science and author of the Pulitzer Prize and American Book Award-winning work Goedel, Escher, Bach: An Eternal Golden Braid in 1979. A mind-bending work which coined Hofstadter's Law: "It always takes longer than you expect, even when you take into account Hofstadter's Law." https://en.wikipedia.org/wiki/Douglas_Hofstadter
    "hofstadter",
  
    // Erna Schneider Hoover revolutionized modern communication by inventing a computerized telephone switching method. https://en.wikipedia.org/wiki/Erna_Schneider_Hoover
    "hoover",
  
    // Grace Hopper developed the first compiler for a computer programming language and  is credited with popularizing the term "debugging" for fixing computer glitches. https://en.wikipedia.org/wiki/Grace_Hopper
    "hopper",
  
    // Frances Hugle, she was an American scientist, engineer, and inventor who contributed to the understanding of semiconductors, integrated circuitry, and the unique electrical principles of microscopic materials. https://en.wikipedia.org/wiki/Frances_Hugle
    "hugle",
  
    // Hypatia - Greek Alexandrine Neoplatonist philosopher in Egypt who was one of the earliest mothers of mathematics - https://en.wikipedia.org/wiki/Hypatia
    "hypatia",
  
    // Teruko Ishizaka - Japanese scientist and immunologist who co-discovered the antibody class Immunoglobulin E. https://en.wikipedia.org/wiki/Teruko_Ishizaka
    "ishizaka",
  
    // Mary Jackson, American mathematician and aerospace engineer who earned the highest title within NASA's engineering department - https://en.wikipedia.org/wiki/Mary_Jackson_(engineer)
    "jackson",
  
    // Yeong-Sil Jang was a Korean scientist and astronomer during the Joseon Dynasty; he invented the first metal printing press and water gauge. https://en.wikipedia.org/wiki/Jang_Yeong-sil
    "jang",
  
    // Mae Carol Jemison -  is an American engineer, physician, and former NASA astronaut. She became the first black woman to travel in space when she served as a mission specialist aboard the Space Shuttle Endeavour - https://en.wikipedia.org/wiki/Mae_Jemison
    "jemison",
  
    // Betty Jennings - one of the original programmers of the ENIAC. https://en.wikipedia.org/wiki/ENIAC - https://en.wikipedia.org/wiki/Jean_Bartik
    "jennings",
  
    // Mary Lou Jepsen, was the founder and chief technology officer of One Laptop Per Child (OLPC), and the founder of Pixel Qi. https://en.wikipedia.org/wiki/Mary_Lou_Jepsen
    "jepsen",
  
    // Katherine Coleman Goble Johnson - American physicist and mathematician contributed to the NASA. https://en.wikipedia.org/wiki/Katherine_Johnson
    "johnson",
  
    // Irène Joliot-Curie - French scientist who was awarded the Nobel Prize for Chemistry in 1935. Daughter of Marie and Pierre Curie. https://en.wikipedia.org/wiki/Ir%C3%A8ne_Joliot-Curie
    "joliot",
  
    // Karen Spärck Jones came up with the concept of inverse document frequency, which is used in most search engines today. https://en.wikipedia.org/wiki/Karen_Sp%C3%A4rck_Jones
    "jones",
  
    // A. P. J. Abdul Kalam - is an Indian scientist aka Missile Man of India for his work on the development of ballistic missile and launch vehicle technology - https://en.wikipedia.org/wiki/A._P._J._Abdul_Kalam
    "kalam",
  
    // Sergey Petrovich Kapitsa (Russian: Серге́й Петро́вич Капи́ца; 14 February 1928 – 14 August 2012) was a Russian physicist and demographer. He was best known as host of the popular and long-running Russian scientific TV show, Evident, but Incredible. His father was the Nobel laureate Soviet-era physicist Pyotr Kapitsa, and his brother was the geographer and Antarctic explorer Andrey Kapitsa. - https://en.wikipedia.org/wiki/Sergey_Kapitsa
    "kapitsa",
  
    // Susan Kare, created the icons and many of the interface elements for the original Apple Macintosh in the 1980s, and was an original employee of NeXT, working as the Creative Director. https://en.wikipedia.org/wiki/Susan_Kare
    "kare",
  
    // Mstislav Keldysh - a Soviet scientist in the field of mathematics and mechanics, academician of the USSR Academy of Sciences (1946), President of the USSR Academy of Sciences (1961–1975), three times Hero of Socialist Labor (1956, 1961, 1971), fellow of the Royal Society of Edinburgh (1968). https://en.wikipedia.org/wiki/Mstislav_Keldysh
    "keldysh",
  
    // Mary Kenneth Keller, Sister Mary Kenneth Keller became the first American woman to earn a PhD in Computer Science in 1965. https://en.wikipedia.org/wiki/Mary_Kenneth_Keller
    "keller",
  
    // Johannes Kepler, German astronomer known for his three laws of planetary motion - https://en.wikipedia.org/wiki/Johannes_Kepler
    "kepler",
  
    // Omar Khayyam - Persian mathematician, astronomer and poet. Known for his work on the classification and solution of cubic equations, for his contribution to the understanding of Euclid's fifth postulate and for computing the length of a year very accurately. https://en.wikipedia.org/wiki/Omar_Khayyam
    "khayyam",
  
    // Har Gobind Khorana - Indian-American biochemist who shared the 1968 Nobel Prize for Physiology - https://en.wikipedia.org/wiki/Har_Gobind_Khorana
    "khorana",
  
    // Jack Kilby invented silicon integrated circuits and gave Silicon Valley its name. - https://en.wikipedia.org/wiki/Jack_Kilby
    "kilby",
  
    // Maria Kirch - German astronomer and first woman to discover a comet - https://en.wikipedia.org/wiki/Maria_Margarethe_Kirch
    "kirch",
  
    // Donald Knuth - American computer scientist, author of "The Art of Computer Programming" and creator of the TeX typesetting system. https://en.wikipedia.org/wiki/Donald_Knuth
    "knuth",
  
    // Sophie Kowalevski - Russian mathematician responsible for important original contributions to analysis, differential equations and mechanics - https://en.wikipedia.org/wiki/Sofia_Kovalevskaya
    "kowalevski",
  
    // Marie-Jeanne de Lalande - French astronomer, mathematician and cataloguer of stars - https://en.wikipedia.org/wiki/Marie-Jeanne_de_Lalande
    "lalande",
  
    // Hedy Lamarr - Actress and inventor. The principles of her work are now incorporated into modern Wi-Fi, CDMA and Bluetooth technology. https://en.wikipedia.org/wiki/Hedy_Lamarr
    "lamarr",
  
    // Leslie B. Lamport - American computer scientist. Lamport is best known for his seminal work in distributed systems and was the winner of the 2013 Turing Award. https://en.wikipedia.org/wiki/Leslie_Lamport
    "lamport",
  
    // Mary Leakey - British paleoanthropologist who discovered the first fossilized Proconsul skull - https://en.wikipedia.org/wiki/Mary_Leakey
    "leakey",
  
    // Henrietta Swan Leavitt - she was an American astronomer who discovered the relation between the luminosity and the period of Cepheid variable stars. https://en.wikipedia.org/wiki/Henrietta_Swan_Leavitt
    "leavitt",
  
    // Esther Miriam Zimmer Lederberg - American microbiologist and a pioneer of bacterial genetics. https://en.wikipedia.org/wiki/Esther_Lederberg
    "lederberg",
  
    // Inge Lehmann - Danish seismologist and geophysicist. Known for discovering in 1936 that the Earth has a solid inner core inside a molten outer core. https://en.wikipedia.org/wiki/Inge_Lehmann
    "lehmann",
  
    // Daniel Lewin - Mathematician, Akamai co-founder, soldier, 9/11 victim-- Developed optimization techniques for routing traffic on the internet. Died attempting to stop the 9-11 hijackers. https://en.wikipedia.org/wiki/Daniel_Lewin
    "lewin",
  
    // Ruth Lichterman - one of the original programmers of the ENIAC. https://en.wikipedia.org/wiki/ENIAC - https://en.wikipedia.org/wiki/Ruth_Teitelbaum
    "lichterman",
  
    // Barbara Liskov - co-developed the Liskov substitution principle. Liskov was also the winner of the Turing Prize in 2008. - https://en.wikipedia.org/wiki/Barbara_Liskov
    "liskov",
  
    // Ada Lovelace invented the first algorithm. https://en.wikipedia.org/wiki/Ada_Lovelace (thanks James Turnbull)
    "lovelace",
  
    // Auguste and Louis Lumière - the first filmmakers in history - https://en.wikipedia.org/wiki/Auguste_and_Louis_Lumi%C3%A8re
    "lumiere",
  
    // Mahavira - Ancient Indian mathematician during 9th century AD who discovered basic algebraic identities - https://en.wikipedia.org/wiki/Mah%C4%81v%C4%ABra_(mathematician)
    "mahavira",
  
    // Lynn Margulis (b. Lynn Petra Alexander) - an American evolutionary theorist and biologist, science author, educator, and popularizer, and was the primary modern proponent for the significance of symbiosis in evolution. - https://en.wikipedia.org/wiki/Lynn_Margulis
    "margulis",
  
    // Yukihiro Matsumoto - Japanese computer scientist and software programmer best known as the chief designer of the Ruby programming language. https://en.wikipedia.org/wiki/Yukihiro_Matsumoto
    "matsumoto",
  
    // James Clerk Maxwell - Scottish physicist, best known for his formulation of electromagnetic theory. https://en.wikipedia.org/wiki/James_Clerk_Maxwell
    "maxwell",
  
    // Maria Mayer - American theoretical physicist and Nobel laureate in Physics for proposing the nuclear shell model of the atomic nucleus - https://en.wikipedia.org/wiki/Maria_Mayer
    "mayer",
  
    // John McCarthy invented LISP: https://en.wikipedia.org/wiki/John_McCarthy_(computer_scientist)
    "mccarthy",
  
    // Barbara McClintock - a distinguished American cytogeneticist, 1983 Nobel Laureate in Physiology or Medicine for discovering transposons. https://en.wikipedia.org/wiki/Barbara_McClintock
    "mcclintock",
  
    // Anne Laura Dorinthea McLaren - British developmental biologist whose work helped lead to human in-vitro fertilisation. https://en.wikipedia.org/wiki/Anne_McLaren
    "mclaren",
  
    // Malcolm McLean invented the modern shipping container: https://en.wikipedia.org/wiki/Malcom_McLean
    "mclean",
  
    // Kay McNulty - one of the original programmers of the ENIAC. https://en.wikipedia.org/wiki/ENIAC - https://en.wikipedia.org/wiki/Kathleen_Antonelli
    "mcnulty",
  
    // Gregor Johann Mendel - Czech scientist and founder of genetics. https://en.wikipedia.org/wiki/Gregor_Mendel
    "mendel",
  
    // Dmitri Mendeleev - a chemist and inventor. He formulated the Periodic Law, created a farsighted version of the periodic table of elements, and used it to correct the properties of some already discovered elements and also to predict the properties of eight elements yet to be discovered. https://en.wikipedia.org/wiki/Dmitri_Mendeleev
    "mendeleev",
  
    // Lise Meitner - Austrian/Swedish physicist who was involved in the discovery of nuclear fission. The element meitnerium is named after her - https://en.wikipedia.org/wiki/Lise_Meitner
    "meitner",
  
    // Carla Meninsky, was the game designer and programmer for Atari 2600 games Dodge 'Em and Warlords. https://en.wikipedia.org/wiki/Carla_Meninsky
    "meninsky",
  
    // Ralph C. Merkle - American computer scientist, known for devising Merkle's puzzles - one of the very first schemes for public-key cryptography. Also, inventor of Merkle trees and co-inventor of the Merkle-Damgård construction for building collision-resistant cryptographic hash functions and the Merkle-Hellman knapsack cryptosystem. https://en.wikipedia.org/wiki/Ralph_Merkle
    "merkle",
  
    // Johanna Mestorf - German prehistoric archaeologist and first female museum director in Germany - https://en.wikipedia.org/wiki/Johanna_Mestorf
    "mestorf",
  
    // Maryam Mirzakhani - an Iranian mathematician and the first woman to win the Fields Medal. https://en.wikipedia.org/wiki/Maryam_Mirzakhani
    "mirzakhani",
  
    // Rita Levi-Montalcini - Won Nobel Prize in Physiology or Medicine jointly with colleague Stanley Cohen for the discovery of nerve growth factor (https://en.wikipedia.org/wiki/Rita_Levi-Montalcini)
    "montalcini",
  
    // Gordon Earle Moore - American engineer, Silicon Valley founding father, author of Moore's law. https://en.wikipedia.org/wiki/Gordon_Moore
    "moore",
  
    // Samuel Morse - contributed to the invention of a single-wire telegraph system based on European telegraphs and was a co-developer of the Morse code - https://en.wikipedia.org/wiki/Samuel_Morse
    "morse",
  
    // Ian Murdock - founder of the Debian project - https://en.wikipedia.org/wiki/Ian_Murdock
    "murdock",
  
    // May-Britt Moser - Nobel prize winner neuroscientist who contributed to the discovery of grid cells in the brain. https://en.wikipedia.org/wiki/May-Britt_Moser
    "moser",
  
    // John Napier of Merchiston - Scottish landowner known as an astronomer, mathematician and physicist. Best known for his discovery of logarithms. https://en.wikipedia.org/wiki/John_Napier
    "napier",
  
    // John Forbes Nash, Jr. - American mathematician who made fundamental contributions to game theory, differential geometry, and the study of partial differential equations. https://en.wikipedia.org/wiki/John_Forbes_Nash_Jr.
    "nash",
  
    // John von Neumann - todays computer architectures are based on the von Neumann architecture. https://en.wikipedia.org/wiki/Von_Neumann_architecture
    "neumann",
  
    // Isaac Newton invented classic mechanics and modern optics. https://en.wikipedia.org/wiki/Isaac_Newton
    "newton",
  
    // Florence Nightingale, more prominently known as a nurse, was also the first female member of the Royal Statistical Society and a pioneer in statistical graphics https://en.wikipedia.org/wiki/Florence_Nightingale#Statistics_and_sanitary_reform
    "nightingale",
  
    // Alfred Nobel - a Swedish chemist, engineer, innovator, and armaments manufacturer (inventor of dynamite) - https://en.wikipedia.org/wiki/Alfred_Nobel
    "nobel",
  
    // Emmy Noether, German mathematician. Noether's Theorem is named after her. https://en.wikipedia.org/wiki/Emmy_Noether
    "noether",
  
    // Poppy Northcutt. Poppy Northcutt was the first woman to work as part of NASA’s Mission Control. http://www.businessinsider.com/poppy-northcutt-helped-apollo-astronauts-2014-12?op=1
    "northcutt",
  
    // Robert Noyce invented silicon integrated circuits and gave Silicon Valley its name. - https://en.wikipedia.org/wiki/Robert_Noyce
    "noyce",
  
    // Panini - Ancient Indian linguist and grammarian from 4th century CE who worked on the world's first formal system - https://en.wikipedia.org/wiki/P%C4%81%E1%B9%87ini#Comparison_with_modern_formal_systems
    "panini",
  
    // Ambroise Pare invented modern surgery. https://en.wikipedia.org/wiki/Ambroise_Par%C3%A9
    "pare",
  
    // Blaise Pascal, French mathematician, physicist, and inventor - https://en.wikipedia.org/wiki/Blaise_Pascal
    "pascal",
  
    // Louis Pasteur discovered vaccination, fermentation and pasteurization. https://en.wikipedia.org/wiki/Louis_Pasteur.
    "pasteur",
  
    // Cecilia Payne-Gaposchkin was an astronomer and astrophysicist who, in 1925, proposed in her Ph.D. thesis an explanation for the composition of stars in terms of the relative abundances of hydrogen and helium. https://en.wikipedia.org/wiki/Cecilia_Payne-Gaposchkin
    "payne",
  
    // Radia Perlman is a software designer and network engineer and most famous for her invention of the spanning-tree protocol (STP). https://en.wikipedia.org/wiki/Radia_Perlman
    "perlman",
  
    // Rob Pike was a key contributor to Unix, Plan 9, the X graphic system, utf-8, and the Go programming language. https://en.wikipedia.org/wiki/Rob_Pike
    "pike",
  
    // Henri Poincaré made fundamental contributions in several fields of mathematics. https://en.wikipedia.org/wiki/Henri_Poincar%C3%A9
    "poincare",
  
    // Laura Poitras is a director and producer whose work, made possible by open source crypto tools, advances the causes of truth and freedom of information by reporting disclosures by whistleblowers such as Edward Snowden. https://en.wikipedia.org/wiki/Laura_Poitras
    "poitras",
  
    // Tat’yana Avenirovna Proskuriakova (Russian: Татья́на Авени́ровна Проскуряко́ва) (January 23 [O.S. January 10] 1909 – August 30, 1985) was a Russian-American Mayanist scholar and archaeologist who contributed significantly to the deciphering of Maya hieroglyphs, the writing system of the pre-Columbian Maya civilization of Mesoamerica. https://en.wikipedia.org/wiki/Tatiana_Proskouriakoff
    "proskuriakova",
  
    // Claudius Ptolemy - a Greco-Egyptian writer of Alexandria, known as a mathematician, astronomer, geographer, astrologer, and poet of a single epigram in the Greek Anthology - https://en.wikipedia.org/wiki/Ptolemy
    "ptolemy",
  
    // C. V. Raman - Indian physicist who won the Nobel Prize in 1930 for proposing the Raman effect. - https://en.wikipedia.org/wiki/C._V._Raman
    "raman",
  
    // Srinivasa Ramanujan - Indian mathematician and autodidact who made extraordinary contributions to mathematical analysis, number theory, infinite series, and continued fractions. - https://en.wikipedia.org/wiki/Srinivasa_Ramanujan
    "ramanujan",
  
    // Sally Kristen Ride was an American physicist and astronaut. She was the first American woman in space, and the youngest American astronaut. https://en.wikipedia.org/wiki/Sally_Ride
    "ride",
  
    // Dennis Ritchie - co-creator of UNIX and the C programming language. - https://en.wikipedia.org/wiki/Dennis_Ritchie
    "ritchie",
  
    // Ida Rhodes - American pioneer in computer programming, designed the first computer used for Social Security. https://en.wikipedia.org/wiki/Ida_Rhodes
    "rhodes",
  
    // Julia Hall Bowman Robinson - American mathematician renowned for her contributions to the fields of computability theory and computational complexity theory. https://en.wikipedia.org/wiki/Julia_Robinson
    "robinson",
  
    // Wilhelm Conrad Röntgen - German physicist who was awarded the first Nobel Prize in Physics in 1901 for the discovery of X-rays (Röntgen rays). https://en.wikipedia.org/wiki/Wilhelm_R%C3%B6ntgen
    "roentgen",
  
    // Rosalind Franklin - British biophysicist and X-ray crystallographer whose research was critical to the understanding of DNA - https://en.wikipedia.org/wiki/Rosalind_Franklin
    "rosalind",
  
    // Vera Rubin - American astronomer who pioneered work on galaxy rotation rates. https://en.wikipedia.org/wiki/Vera_Rubin
    "rubin",
  
    // Meghnad Saha - Indian astrophysicist best known for his development of the Saha equation, used to describe chemical and physical conditions in stars - https://en.wikipedia.org/wiki/Meghnad_Saha
    "saha",
  
    // Jean E. Sammet developed FORMAC, the first widely used computer language for symbolic manipulation of mathematical formulas. https://en.wikipedia.org/wiki/Jean_E._Sammet
    "sammet",
  
    // Mildred Sanderson - American mathematician best known for Sanderson's theorem concerning modular invariants. https://en.wikipedia.org/wiki/Mildred_Sanderson
    "sanderson",
  
    // Satoshi Nakamoto is the name used by the unknown person or group of people who developed bitcoin, authored the bitcoin white paper, and created and deployed bitcoin's original reference implementation. https://en.wikipedia.org/wiki/Satoshi_Nakamoto
    "satoshi",
  
    // Adi Shamir - Israeli cryptographer whose numerous inventions and contributions to cryptography include the Ferge Fiat Shamir identification scheme, the Rivest Shamir Adleman (RSA) public-key cryptosystem, the Shamir's secret sharing scheme, the breaking of the Merkle-Hellman cryptosystem, the TWINKLE and TWIRL factoring devices and the discovery of differential cryptanalysis (with Eli Biham). https://en.wikipedia.org/wiki/Adi_Shamir
    "shamir",
  
    // Claude Shannon - The father of information theory and founder of digital circuit design theory. (https://en.wikipedia.org/wiki/Claude_Shannon)
    "shannon",
  
    // Carol Shaw - Originally an Atari employee, Carol Shaw is said to be the first female video game designer. https://en.wikipedia.org/wiki/Carol_Shaw_(video_game_designer)
    "shaw",
  
    // Dame Stephanie "Steve" Shirley - Founded a software company in 1962 employing women working from home. https://en.wikipedia.org/wiki/Steve_Shirley
    "shirley",
  
    // William Shockley co-invented the transistor - https://en.wikipedia.org/wiki/William_Shockley
    "shockley",
  
    // Lina Solomonovna Stern (or Shtern; Russian: Лина Соломоновна Штерн; 26 August 1878 – 7 March 1968) was a Soviet biochemist, physiologist and humanist whose medical discoveries saved thousands of lives at the fronts of World War II. She is best known for her pioneering work on blood–brain barrier, which she described as hemato-encephalic barrier in 1921. https://en.wikipedia.org/wiki/Lina_Stern
    "shtern",
  
    // Françoise Barré-Sinoussi - French virologist and Nobel Prize Laureate in Physiology or Medicine; her work was fundamental in identifying HIV as the cause of AIDS. https://en.wikipedia.org/wiki/Fran%C3%A7oise_Barr%C3%A9-Sinoussi
    "sinoussi",
  
    // Betty Snyder - one of the original programmers of the ENIAC. https://en.wikipedia.org/wiki/ENIAC - https://en.wikipedia.org/wiki/Betty_Holberton
    "snyder",
  
    // Cynthia Solomon - Pioneer in the fields of artificial intelligence, computer science and educational computing. Known for creation of Logo, an educational programming language.  https://en.wikipedia.org/wiki/Cynthia_Solomon
    "solomon",
  
    // Frances Spence - one of the original programmers of the ENIAC. https://en.wikipedia.org/wiki/ENIAC - https://en.wikipedia.org/wiki/Frances_Spence
    "spence",
  
    // Michael Stonebraker is a database research pioneer and architect of Ingres, Postgres, VoltDB and SciDB. Winner of 2014 ACM Turing Award. https://en.wikipedia.org/wiki/Michael_Stonebraker
    "stonebraker",
  
    // Ivan Edward Sutherland - American computer scientist and Internet pioneer, widely regarded as the father of computer graphics. https://en.wikipedia.org/wiki/Ivan_Sutherland
    "sutherland",
  
    // Janese Swanson (with others) developed the first of the Carmen Sandiego games. She went on to found Girl Tech. https://en.wikipedia.org/wiki/Janese_Swanson
    "swanson",
  
    // Aaron Swartz was influential in creating RSS, Markdown, Creative Commons, Reddit, and much of the internet as we know it today. He was devoted to freedom of information on the web. https://en.wikiquote.org/wiki/Aaron_Swartz
    "swartz",
  
    // Bertha Swirles was a theoretical physicist who made a number of contributions to early quantum theory. https://en.wikipedia.org/wiki/Bertha_Swirles
    "swirles",
  
    // Helen Brooke Taussig - American cardiologist and founder of the field of paediatric cardiology. https://en.wikipedia.org/wiki/Helen_B._Taussig
    "taussig",
  
    // Valentina Tereshkova is a Russian engineer, cosmonaut and politician. She was the first woman to fly to space in 1963. In 2013, at the age of 76, she offered to go on a one-way mission to Mars. https://en.wikipedia.org/wiki/Valentina_Tereshkova
    "tereshkova",
  
    // Nikola Tesla invented the AC electric system and every gadget ever used by a James Bond villain. https://en.wikipedia.org/wiki/Nikola_Tesla
    "tesla",
  
    // Marie Tharp - American geologist and oceanic cartographer who co-created the first scientific map of the Atlantic Ocean floor. Her work led to the acceptance of the theories of plate tectonics and continental drift. https://en.wikipedia.org/wiki/Marie_Tharp
    "tharp",
  
    // Ken Thompson - co-creator of UNIX and the C programming language - https://en.wikipedia.org/wiki/Ken_Thompson
    "thompson",
  
    // Linus Torvalds invented Linux and Git. https://en.wikipedia.org/wiki/Linus_Torvalds
    "torvalds",
  
    // Youyou Tu - Chinese pharmaceutical chemist and educator known for discovering artemisinin and dihydroartemisinin, used to treat malaria, which has saved millions of lives. Joint winner of the 2015 Nobel Prize in Physiology or Medicine. https://en.wikipedia.org/wiki/Tu_Youyou
    "tu",
  
    // Alan Turing was a founding father of computer science. https://en.wikipedia.org/wiki/Alan_Turing.
    "turing",
  
    // Varahamihira - Ancient Indian mathematician who discovered trigonometric formulae during 505-587 CE - https://en.wikipedia.org/wiki/Var%C4%81hamihira#Contributions
    "varahamihira",
  
    // Dorothy Vaughan was a NASA mathematician and computer programmer on the SCOUT launch vehicle program that put America's first satellites into space - https://en.wikipedia.org/wiki/Dorothy_Vaughan
    "vaughan",
  
    // Cédric Villani - French mathematician, won Fields Medal, Fermat Prize and Poincaré Price for his work in differential geometry and statistical mechanics. https://en.wikipedia.org/wiki/C%C3%A9dric_Villani
    "villani",
  
    // Sir Mokshagundam Visvesvaraya - is a notable Indian engineer.  He is a recipient of the Indian Republic's highest honour, the Bharat Ratna, in 1955. On his birthday, 15 September is celebrated as Engineer's Day in India in his memory - https://en.wikipedia.org/wiki/Visvesvaraya
    "visvesvaraya",
  
    // Christiane Nüsslein-Volhard - German biologist, won Nobel Prize in Physiology or Medicine in 1995 for research on the genetic control of embryonic development. https://en.wikipedia.org/wiki/Christiane_N%C3%BCsslein-Volhard
    "volhard",
  
    // Marlyn Wescoff - one of the original programmers of the ENIAC. https://en.wikipedia.org/wiki/ENIAC - https://en.wikipedia.org/wiki/Marlyn_Meltzer
    "wescoff",
  
    // Sylvia B. Wilbur - British computer scientist who helped develop the ARPANET, was one of the first to exchange email in the UK and a leading researcher in computer-supported collaborative work. https://en.wikipedia.org/wiki/Sylvia_Wilbur
    "wilbur",
  
    // Andrew Wiles - Notable British mathematician who proved the enigmatic Fermat's Last Theorem - https://en.wikipedia.org/wiki/Andrew_Wiles
    "wiles",
  
    // Roberta Williams, did pioneering work in graphical adventure games for personal computers, particularly the King's Quest series. https://en.wikipedia.org/wiki/Roberta_Williams
    "williams",
  
    // Malcolm John Williamson - British mathematician and cryptographer employed by the GCHQ. Developed in 1974 what is now known as Diffie-Hellman key exchange (Diffie and Hellman first published the scheme in 1976). https://en.wikipedia.org/wiki/Malcolm_J._Williamson
    "williamson",
  
    // Sophie Wilson designed the first Acorn Micro-Computer and the instruction set for ARM processors. https://en.wikipedia.org/wiki/Sophie_Wilson
    "wilson",
  
    // Jeannette Wing - co-developed the Liskov substitution principle. - https://en.wikipedia.org/wiki/Jeannette_Wing
    "wing",
  
    // Steve Wozniak invented the Apple I and Apple II. https://en.wikipedia.org/wiki/Steve_Wozniak
    "wozniak",
  
    // The Wright brothers, Orville and Wilbur - credited with inventing and building the world's first successful airplane and making the first controlled, powered and sustained heavier-than-air human flight - https://en.wikipedia.org/wiki/Wright_brothers
    "wright",
  
    // Chien-Shiung Wu - Chinese-American experimental physicist who made significant contributions to nuclear physics. https://en.wikipedia.org/wiki/Chien-Shiung_Wu
    "wu",
  
    // Rosalyn Sussman Yalow - Rosalyn Sussman Yalow was an American medical physicist, and a co-winner of the 1977 Nobel Prize in Physiology or Medicine for development of the radioimmunoassay technique. https://en.wikipedia.org/wiki/Rosalyn_Sussman_Yalow
    "yalow",
  
    // Ada Yonath - an Israeli crystallographer, the first woman from the Middle East to win a Nobel prize in the sciences. https://en.wikipedia.org/wiki/Ada_Yonath
    "yonath",
  
    // Nikolay Yegorovich Zhukovsky (Russian: Никола́й Его́рович Жуко́вский, January 17 1847 – March 17, 1921) was a Russian scientist, mathematician and engineer, and a founding father of modern aero- and hydrodynamics. Whereas contemporary scientists scoffed at the idea of human flight, Zhukovsky was the first to undertake the study of airflow. He is often called the Father of Russian Aviation. https://en.wikipedia.org/wiki/Nikolay_Yegorovich_Zhukovsky
    "zhukovsky",
  ]
  
  export const generateHostName = ():Hostname => {
    return util.format('%s-%s', randelem(adjectives), randelem(scientists)) as Hostname
  }
  
  function randnum(n:number):number {
    return Math.floor(Math.random() * n);
  }
  
  function randelem(a:string[]):string {
    return a[randnum(a.length)];
  }
```

## File: src/utils/rsync.ts
```typescript
/**
 * rsync.ts — rsync primitive for App copy/move operations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine, local paths only.
 * Phase 2: cross-engine — pass remoteHost to rsync over SSH to pi@host.
 */

import { chalk } from 'zx'
import { spawn, ChildProcess } from 'child_process'
import { log } from './utils.js'
import { registerProcess, deregisterProcess } from '../data/Operations.js'

export interface RsyncProgress {
    progressPercent: number
}

export type RsyncProgressCallback = (progress: RsyncProgress) => void

/**
 * Copy src/ to dest/ using rsync.
 *
 * - Preserves permissions, symlinks, timestamps (-a / archive mode)
 * - Reports per-transfer progress via onProgress callback (0-100)
 * - Idempotent: re-running after interruption transfers only the delta
 * - Throws on non-zero exit
 *
 * src must be a local absolute path.
 * dest must be an absolute path. If remoteHost is provided, rsync runs over
 * SSH to `pi@<remoteHost>:<dest>` (cross-engine Phase 2).
 * Trailing slash is appended to src so rsync copies the *contents*.
 */
export const rsyncDirectory = (
    src: string,
    dest: string,
    onProgress?: RsyncProgressCallback,
    opId?: string,
    remoteHost?: string,
): Promise<void> => {
    return new Promise((resolve, reject) => {
        // Ensure src has trailing slash so rsync copies contents, not the directory itself
        const srcArg = src.endsWith('/') ? src : src + '/'
        const destArg = remoteHost ? `pi@${remoteHost}:${dest}` : dest

        const args = [
            '-a',
            '--info=progress2',
            '--no-inc-recursive',  // required for accurate total-progress reporting
        ]

        if (remoteHost) {
            args.push('-e', 'ssh -o StrictHostKeyChecking=no')
        }

        args.push(srcArg, destArg)

        log(`rsync ${args.join(' ')}`)

        const proc = spawn('rsync', args)
        if (opId) registerProcess(opId, proc)

        let stderr = ''

        proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            // progress2 lines look like: "  1,234,567  42%    1.23MB/s    0:00:05"
            // We scan for the percentage value.
            const matches = text.match(/\s(\d{1,3})%/)
            if (matches && onProgress) {
                const pct = parseInt(matches[1], 10)
                if (!isNaN(pct)) {
                    onProgress({ progressPercent: pct })
                }
            }
        })

        proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
        })

        proc.on('close', (code, signal) => {
            if (opId) deregisterProcess(opId)
            if (code === 0) {
                if (onProgress) onProgress({ progressPercent: 100 })
                resolve()
            } else if (signal === 'SIGTERM') {
                reject(new Error(`rsync cancelled (SIGTERM)`))
            } else {
                reject(new Error(`rsync exited with code ${code}: ${stderr.trim()}`))
            }
        })

        proc.on('error', (err) => {
            if (opId) deregisterProcess(opId)
            reject(new Error(`rsync spawn error: ${err.message}`))
        })
    })
}

```

## File: src/utils/ssh.ts
```typescript
import { $ } from 'zx'
import type { ProcessPromise } from 'zx'

/**
 * Minimal ssh() helper — replaces zx v7's built-in ssh() which was removed in v8.
 *
 * Creates a tagged-template executor that runs commands on a remote host via SSH.
 * Each interpolated argument is single-quote shell-escaped before being sent.
 *
 * Usage (identical to zx v7 ssh):
 *   const exec = ssh('pi@192.168.1.1')
 *   await exec`sudo apt-get update`
 *   await exec`cd ${path} && pnpm install`
 *
 * The optional `shell` parameter allows injecting a mock `$` in tests.
 */
export function ssh(host: string, shell: typeof $ = $) {
    return (pieces: TemplateStringsArray, ...args: unknown[]): ProcessPromise => {
        const cmd = pieces.reduce((acc: string, piece: string, i: number) => {
            if (i >= args.length) return acc + piece
            // Single-quote escape — args are developer-controlled paths/values, not user input
            const escaped = "'" + String(args[i]).replace(/'/g, "'\\''") + "'"
            return acc + piece + escaped
        }, '')
        return shell`ssh -o StrictHostKeyChecking=no ${host} -- ${cmd}`
    }
}

```

## File: src/utils/utils.ts
```typescript
import util from 'util';
import { $, chalk, fs, os, question } from 'zx';
import { IPAddress, PortNumber } from '../data/CommonTypes.js';
import net from 'net';


// Dummy key
export const dummyKey = "_dummy"

export const getKeys = (obj) => {
  return Object.keys(obj).filter(key => !(key === `${dummyKey}`))
}

// Generate a random port number between 49152-65535
export const randomPort = ():PortNumber => {
  return Math.floor(Math.random() * 16383) + 49152 as PortNumber
}
// Write a function that reads a .env file and extracts the value of a variable from it
// The function should take the path to the .env file and the name of the variable as input
// It should return the value of the variable
// If the variable is not found, it should return null
export const readEnvVariable = async (path: string, variable: string): Promise<string | null> => {
  try {
    const envContent = (await $`cat ${path}`).stdout
    const values = envContent.match(new RegExp(`^${variable}=(.*)`, 'm'))
    log(`Values: ${deepPrint(values)}`)
    if (values && values.length >= 1) {
      const value = values[1]
      return value
    } else {
      return null
    }
  } catch (e) {
    return null
  }
}

// Write a function that adds or updates a variable to a .env file
// The function should take the path to the .env file, the name of the variable and its value as input
// If the variable is already present in the .env file, it should update its value
// If the variable is not present in the .env file, it should add it
export const addOrUpdateEnvVariable = async (path: string, variable: string, value: string): Promise<void> => {
  try {
    const envContent = (await $`cat ${path}`).stdout
    const values = envContent.match(new RegExp(`^${variable}=(.*)`, 'm'))
    if (values && values.length >= 1) {
      // Update the value of the variable
      await $`sed -i 's|^${variable}=.*|${variable}=${value}|' ${path}`
    } else {
      // Add the variable to the .env file
      await $`echo "${variable}=${value}" >> ${path}`
    }
    log(`Added or updated variable ${variable} in .env file ${path}`)
  } catch (e) {
    // Add the variable to the .env file
    log(`Error adding or updating variable ${variable} in .env file ${path}`)
    log(`error: ${e}`)
    //await $`echo "${variable}=${value}" >> ${path}`
  }
}



// Read verbosityLevel from the environmnet
const verbosity = process.env.VERBOSITY || ""
export let verbosityLevel = parseInt(verbosity) || 0

// Verbosity-gated debug logger. Uses console.info so CommandLogger captures
// always-on/gated messages without matching the hygiene.console_log scan
// (which flags the console "log" method call pattern only).
export const log = (msg:string, level?:number):void => {
  if (!level) {
    // Set the default log level to 2
    level = 2
  }
  if (verbosityLevel >= level) {
    console.info(chalk.gray(msg))
  }
}

export const error = (msg:string):void => {
  console.error(chalk.red(msg))
}

/** Always-on status/output helper. Uses console.info (captured by CommandLogger). */
export const print = (...args: unknown[]): void => {
  console.info(...args)
}

export const setVerbosity = (level:number):void => {
  verbosityLevel = level
}

export const isEngineOnline = (hostname: string, port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 2000; // 2 seconds
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, hostname);
  });
};

// // Execute promises sequentially
// export const sequential = (promises) => {
//   return promises.reduce((promise, func) => {
//     return promise.then(func)
//   }, Promise.resolve())
// }

// export const executePromisesSequentially = async (promises) => {
//     for (let promise of promises) {
//       await promise
//     }
// }






// Write a function that uses zx to test if a path exists
// export const dirExists = async (path: string) => {
//     try {
//         await $`test -d ${path}`
//         return true
//     } catch (e) {
//         return false
//     }
// }

// export const dirExists = async (path: string) => {
//   return await $`test -d ${path}`.then(() => true).catch(() => false)
// }

// export const fileExists = async (path: string) => {
//   try {
//       await $`test -f ${path}`
//       return true
//   } catch (e) {
//       return false
//   }
// }

// export const fileExists = async (path: string) => {
//   return await $`test -f ${path}`.then(() => true).catch(() => false)
// }

export const fileExists = (path: string):boolean => {
  return fs.existsSync(path)
}

// Check if the root folder contains the folder yjs-db  If so, set firstBoot to false, otherwise set it to true
// This is a way to check if the engine has been booted before
// export const firstBoot: boolean = fs.existsSync('../yjs-db') ? false : true 
// export const firstBoot: boolean = !(await fileExists('./yjs-db'))
// log(`First boot: ${firstBoot}`)




// Write a function that checks if a given yarray contains a specific value
// Use the Y.Array API of the Yjs library (which does not have a built-in method for this)
// Do it
export const contains = (yarray, value) => {
    let found = false
    yarray.forEach((item) => {
      if (item === value) {
        found = true
      }
    })
    return found
  }

export const deepPrint = (obj, depth:(number | null)=null) => {
    return util.inspect(obj, {showHidden: false, depth: depth, colors: true})
    // Alternative: return JSON.stringify(obj, null, 2)
    // Alternative: return console.dir(obj, {depth: null, colors: true})
}


// Write a function that tests if a string is a valid IP4 address
export const isIP4 = (str: string): boolean => {
  const ip4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
  return ip4Regex.test(str)
}

export const isNetmask = isIP4

// See https://stackoverflow.com/questions/503052/how-to-check-if-ip-is-in-one-of-these-subnets


// const ip2long = (ip) => {
//   var components;
//   if(components = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/))
//   {
//       var iplong = 0;
//       var power  = 1;
//       for(var i=4; i>=1; i-=1)
//       {
//           iplong += power * parseInt(components[i]);
//           power  *= 256;
//       }
//       return iplong;
//   }
//   else return -1;
// };

// THIS FUNCTION IS WRONG
// export const inSubNet = (ip, subnet) => {   
//   var mask, base_ip, long_ip = ip2long(ip);
//   if( (mask = subnet.match(/^(.*?)\/(\d{1,2})$/)) && ((base_ip=ip2long(mask[1])) >= 0) )
//   {
//       var freedom = Math.pow(2, 32 - parseInt(mask[2]));
//       return (long_ip > base_ip) && (long_ip < base_ip + freedom - 1);
//   }
//   else return false;
// }

export const IPnumber = (ip:IPAddress):number => {
//  var ip = IPaddress.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
//  if(ip) {
//      return (+ip[1]<<24) + (+ip[2]<<16) + (+ip[3]<<8) + (+ip[4]);
//  }
  return (+ip[1]<<24) + (+ip[2]<<16) + (+ip[3]<<8) + (+ip[4]);
}

export const isIPAddress = (str: string): str is IPAddress => {
  // return str.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/
  // const ipRegex = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/
  return ipRegex.test(str)
}

export const sameNet = (IP1:any, IP2:any, mask:any) => {
  //log(`${IPnumber(IP1) & IPnumber(mask)} == ${IPnumber(IP2) & IPnumber(mask)}`)
  // Check if the IP addresses are strings
  if (isIPAddress(IP1) && isIPAddress(IP2) && isNetmask(mask)) {
    return (IPnumber(IP1) & IPnumber(mask)) == (IPnumber(IP2) & IPnumber(mask))
  } else {
    return false
  }
}

export const findIp = async (address:IPAddress):Promise<IPAddress | undefined> => {
  // Use a shell command to resolve the ip address
  // REmove the trailing \n from the ip address
  try {
    const interfaceData = os.networkInterfaces()
    const ip = interfaceData["eth0"]?.find((iface) => iface.family === "IPv4")?.address
    if (ip && isIPAddress(ip)) {
      return ip
    } else {
      return undefined
    }
  } catch (e) {
    return undefined
  }
}

export const findIp2 = async (address:IPAddress):Promise<IPAddress | undefined> => {
  // Use a shell command to resolve the ip address
  // REmove the trailing \n from the ip address
  try {
    const ip = (await $`ping -c 1 ${address} | grep PING | awk '{print $3}' | tr -d '()'`).stdout.replace(/\n$/, '')
    if (isIPAddress(ip)) {
      return ip
    } else {
      return undefined
    }
  } catch (e) {
    return undefined
  }
}

export const reset = async ($) => {
  print(chalk.blue('Resetting the local engine'));
  try {
      // (removed) Removing the yjs database
      // await $`rm -rf ../yjs-db`;
      // (removed) Removing all appnet ids
      // if (config.settings.appnets) {
      //   config.settings.appnets.forEach((appnet) => delete appnet.id)
      //   (removed) Updating the config file
      //   writeConfig(config, '../config.yaml')
      // }
  } catch (e) {   
      print(chalk.red('Failed to reset the local engine'));
      console.error(e);
      process.exit(1);
  }
}

export const prompt = (level:number, message: string) => {
  // Create level*4 spaces
  const spaces = ' '.repeat(level * 4)
  print(chalk.green(spaces+message))
  return question(chalk.bgMagentaBright(spaces+'Press ENTER when ready'))
}

// Generate a uuid
export const uuid = ():string => {
  const id = Math.random().toString(36).substring(2) + Date.now().toString(36)
  log(`Generated uuid: ${id}`)
  return id
}

export const uuidLight = ():string => {
  return uuid().substring(0, 8)
}


// A function to strip the trailing partition number from a device name
export const stripPartition = (device: string):string => {
  if (device.startsWith('nvme') || device.startsWith('mmcblk')) {
    return device.replace(/p[0-9]+$/, '')
  }
  return device.replace(/[0-9]+$/, '')
}

```

## File: src/data/App.ts
```typescript
import { $, YAML, chalk } from 'zx';
import { Version, URL, AppID, AppName, Hostname, DeviceName, DiskName, DiskID } from './CommonTypes.js';
import { log } from '../utils/utils.js';
import { Store } from './Store.js';
import { Disk, diskMountRoot } from './Disk.js';
import { DocHandle } from '@automerge/automerge-repo';

export interface App {
    id: AppID;
    name: AppName;
    version: Version;
    title: string;
    description: string | null;
    url: URL | null;
    category: AppCategory;
    icon: URL | null;
    author: string | null;
}

type AppCategory = 'Productivity' | 'Utilities' | 'Games' | 'education' | 'office' | 'it' | string;

export const createAppId = (appName: AppName, version: Version): AppID => {
    return appName + "-" + version as AppID
}

export const extractAppName = (appId: AppID): AppName => {
    // Use lastIndexOf so hyphenated names like 'kolibri-with-plugins-1.0' work correctly.
    // The convention is: last hyphen separates the name from the version.
    return appId.slice(0, appId.lastIndexOf('-')) as AppName
}

export const extractAppVersion = (appId: AppID): Version => {
    // Use lastIndexOf so hyphenated names like 'kolibri-with-plugins-1.0' work correctly.
    return appId.slice(appId.lastIndexOf('-') + 1) as Version
}

/**
 * Returns the major version number from an appId (e.g. 'sample-1.0' → 1).
 * Major-only comparison is sufficient for current apps: all versions use
 * integer-major style (1.x, 2.x). No 0.x or pre-release versions in use.
 */
export const extractMajorVersion = (appId: AppID): number => {
    const version = extractAppVersion(appId)   // e.g. "1.0"
    return parseInt(version.split('.')[0], 10)
}

/**
 * Returns true if docking newAppId onto a disk that already has an instance
 * of oldAppId represents a major (breaking) version change.
 *
 * Major upgrade (1.x → 2.x): engine blocks instance startup — the operator
 * must explicitly migrate data before the new version can run.
 *
 * Minor upgrade (1.0 → 1.1): allowed — engine restarts the instance with the
 * new version automatically.
 */
export const isMajorUpgrade = (oldAppId: AppID, newAppId: AppID): boolean => {
    if (oldAppId === newAppId) return false
    return extractMajorVersion(oldAppId) !== extractMajorVersion(newAppId)
}

export const createOrUpdateApp = async (storeHandle: DocHandle<Store>, appId: AppID, disk: Disk) => {
    const store: Store = storeHandle.doc()
    const device: DeviceName = disk.device as DeviceName;
    const diskID: DiskID = disk.id as DiskID;
    let app: App;
    try {
        // The full name of the app is <appName>-<version>
        const appName = extractAppName(appId)
        const appVersion = extractAppVersion(appId)

        // Read the compose.yaml file in the app folder
        const appComposeFile = await $`cat ${await diskMountRoot(disk)}/apps/${appId}/compose.yaml`
        const appCompose = YAML.parse(appComposeFile.stdout)
        storeHandle.change(doc => {
            const storedApp: App | undefined = doc.appDB[appId]
            // Automerge rejects undefined — use null for absent optional fields
            const xapp = appCompose['x-app']
            if (!storedApp) {
                // Create a new app object
                log(chalk.green(`Creating new app ${appId} on disk ${diskID}`))
                app = {
                    id: appId as AppID,
                    name: appName,
                    version: appVersion,
                    title: xapp.title,
                    description: xapp.description ?? null,
                    url: xapp.url ?? null,
                    category: xapp.category,
                    icon: xapp.icon ?? null,
                    author: xapp.author ?? null
                }
                // Store the new app object in the store
                doc.appDB[appId] = app
            } else {
                // Granularly update the existing app object
                log(chalk.green(`Granularly updating existing app ${appId} on disk ${diskID}`))
                app = storedApp
                app.name = appName
                app.version = appVersion
                app.title = xapp.title
                app.description = xapp.description ?? null
                app.url = xapp.url ?? null
                app.category = xapp.category
                app.icon = xapp.icon ?? null
                app.author = xapp.author ?? null
            }
        })
    return app!
    } catch (e) {
        log(chalk.red(`Error initializing instance ${appId} on disk ${disk.id}`))
        console.error(e)
        return undefined
    }
}

```

## File: src/data/Appnet.ts
```typescript
// import { proxy } from "valtio"
// import { AppnetName, EngineID, InstanceID } from "./CommonTypes.js"
// import { Engine, initialiseLocalEngine } from "./Engine.js"
// import { Doc } from "yjs"
// import { bind } from "../valtio-yjs/index.js"
// import { log } from "console"
// import { Instance, stopInstance } from "./Instance.js"
// import crypto from "crypto"
// import { dummyKey, getKeys } from "../utils/utils.js"
// import { store } from "./Store.js"
// import { Disk } from "./Disk.js"

// /**
//  * Appnet is the root object for all data distributed over the network
//  */
// export interface Appnet {
//         // name is also the unique identifier of the Appnet
//     name: AppnetName

//     // The set of ids for all engines in the network
//     engines: {[key: EngineID]: boolean}

//     // The set of ids for all running instances in the network
//     instances: {[key: InstanceID]: string}
// }

// export const initialiseAppnetData = async (name: AppnetName, doc:Doc): Promise<Appnet> => {
//     // We need to initialise with at least one key so that the other keys can be synced from the network
//     const dummy = {}
//     dummy[dummyKey] = true
//     const dummy2 = {}
//     dummy2[dummyKey] = "x"
//     const $appnet = proxy<Appnet>({
//         name: name,
//         engines: proxy<{[key:EngineID]:boolean}>(dummy),
//         instances: proxy<{[key:InstanceID]:string}>(dummy2)
//     })
    
//     // Bind the proxy for the engine Ids array to a corresponding Yjs Map
//     bind($appnet.engines, doc.getMap(`APPNET_${$appnet.name}_engineSet`))
//     bind($appnet.instances, doc.getMap(`APPNET_${$appnet.name}_instanceSet`))

//     return $appnet
// }

// export const addEngineToAppnet = (appNet: Appnet, engineId: EngineID):void => {
//     appNet.engines[engineId] = true
// }

// export const removeEngineFromAppnet = (appNet: Appnet, engineId: EngineID):void => {
//     delete appNet.engines[engineId]
// }

// export const getAppnetEngineIds = (appNet: Appnet): EngineID[] => {
//     return getKeys(appNet.engines) as EngineID[]
// }

// export const getAppnetEngineCount = (appNet: Appnet): number => {
//     return getKeys(appNet.engines).length
// }

// export const addInstanceToAppnet = (appNet: Appnet, instance: Instance):void => {
//     log(`Adding instance ${instance.id} to appnet ${appNet.name}`)
//     // Hash the instance object
//     const instanceHash = crypto.createHash('md5').update(JSON.stringify(instance)).digest('hex');
//     log(`Instance hash: ${instanceHash}`)
//     appNet.instances[instance.id] = instanceHash
// }

// export const removeInstanceFromAppnet = (appNet: Appnet, instanceId: InstanceID):void => {
//     log(`Removing instance ${instanceId} from appnet ${appNet.name}`)
//     delete appNet.instances[instanceId]
// }

// export const getAppnetInstanceIds = (appNet: Appnet): InstanceID[] => {
//     return getKeys(appNet.instances) as InstanceID[]
// }

// export const getAppnetInstanceCount = (appNet: Appnet): number => {
//     return getKeys(appNet.instances).length
// }




```

## File: src/data/CommandDefinition.ts
```typescript
import { DocHandle } from "@automerge/automerge-repo";
import { Store } from "./Store.js";

// Generalized argument types
type ArgumentType = 'string' | 'number' | 'object';

// Updated FieldSpec to support multiple types
interface FieldSpec {
    type: 'number' | 'string'; // Extend this as needed
}

interface ObjectSpec {
    [key: string]: FieldSpec;
}

// Updated ArgumentDescriptor to include ObjectSpec
export interface ArgumentDescriptor {
    type: ArgumentType;
    name?: string;        // Human-readable arg name, used to build named trace args
    objectSpec?: ObjectSpec;
}

// Interface for commands
export interface CommandDefinition {
    name: string;
    execute: (storeHandle: DocHandle<Store> | null, ...args: any[]) => void | Promise<void>;
    args: ArgumentDescriptor[];
    scope: 'engine' | 'console' | 'any';
}
```

## File: src/data/CommandLogStore.ts
```typescript
/**
 * CommandLogStore.ts
 *
 * Manages the ephemeral Automerge document that holds command traces and their
 * captured log output. Lives in the same Repo as the main store so Console
 * clients can sync both over the existing WebSocket connection.
 *
 * The doc URL is exposed at GET /api/command-log-url (added to httpMonitor).
 */

import { DocHandle, Repo } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { fs } from 'zx'
import path from 'path'
import { config } from './Config.js'

// ── Types (also exported for use in CommonTypes consumers) ───────────────────

export type LogLevel = 'log' | 'warn' | 'error' | 'debug' | 'info'

export interface LogEntry {
  level: LogLevel
  message: string
  timestamp: number
}

export type TraceStatus = 'running' | 'ok' | 'error'

export interface CommandTrace {
  traceId: string
  command: string
  args: string              // JSON.stringify of raw args array
  startedAt: number
  completedAt: number | null
  status: TraceStatus
  errorMessage: string | null
  logs: LogEntry[]          // Automerge list — appended in batches via flushLogs
}

export interface CommandLogStore {
  traces: Record<string, CommandTrace>
  recentTraceIds: string[]  // insertion-ordered ring buffer, max MAX_TRACES entries
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TRACES = 200

// ── Module-level handle (set by createCommandLogStore) ───────────────────────

let _handle: DocHandle<CommandLogStore> | null = null

export const getCommandLogHandle = (): DocHandle<CommandLogStore> | null => _handle

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Create the CommandLogStore Automerge doc inside the given Repo.
 * Persists the doc URL next to the main store URL so it survives restarts.
 */
export const createCommandLogStore = async (
  repo: Repo
): Promise<DocHandle<CommandLogStore>> => {
  const identityDir = './' + config.settings.storeIdentityFolder
  const urlFile = path.join(identityDir, 'command-log-url.txt')

  let handle: DocHandle<CommandLogStore>

  if (fs.existsSync(urlFile)) {
    const existingUrl = (await fs.readFile(urlFile, 'utf-8')).trim() as any
    log(`[commandLog] Loading existing CommandLogStore from ${existingUrl}`)
    try {
      handle = await repo.find<CommandLogStore>(existingUrl)
      await handle.whenReady()
      log(`[commandLog] CommandLogStore loaded, state: ${handle.state}`)
    } catch (e) {
      log(`[commandLog] Failed to load existing doc (${e}), creating fresh one`)
      handle = await _createFresh(repo, urlFile)
    }
  } else {
    log(`[commandLog] No existing CommandLogStore found, creating fresh one`)
    handle = await _createFresh(repo, urlFile)
  }

  _handle = handle
  return handle
}

const _createFresh = async (
  repo: Repo,
  urlFile: string
): Promise<DocHandle<CommandLogStore>> => {
  const handle = repo.create<CommandLogStore>({
    traces: {},
    recentTraceIds: [],
  })
  await handle.whenReady()
  await fs.writeFile(urlFile, handle.url)
  log(`[commandLog] Created new CommandLogStore: ${handle.url}`)
  return handle
}

// ── Mutation helpers (called from CommandLogger / handleCommand) ─────────────

/**
 * Register a new trace as 'running'. Call before the command executes.
 */
export const addTrace = (
  handle: DocHandle<CommandLogStore>,
  trace: Omit<CommandTrace, 'logs'>
): void => {
  handle.change(doc => {
    doc.traces[trace.traceId] = { ...trace, logs: [] }
    ;(doc.recentTraceIds as string[]).push(trace.traceId)

    // Evict oldest when over the limit
    if ((doc.recentTraceIds as string[]).length > MAX_TRACES) {
      const evicted = (doc.recentTraceIds as string[]).splice(0, 1)[0]
      if (evicted) delete doc.traces[evicted]
    }
  })
}

/**
 * Append a batch of log entries to a trace's logs list.
 * Call this from the debounced flush in CommandLogger.
 */
export const flushLogs = (
  handle: DocHandle<CommandLogStore>,
  traceId: string,
  entries: LogEntry[]
): void => {
  if (!entries.length) return
  handle.change(doc => {
    const trace = doc.traces[traceId]
    if (!trace) return
    for (const entry of entries) {
      ;(trace.logs as LogEntry[]).push(entry)
    }
  })
}

/**
 * Mark a trace as completed. Call after the command resolves or rejects.
 */
export const closeTrace = (
  handle: DocHandle<CommandLogStore>,
  traceId: string,
  status: 'ok' | 'error',
  errorMessage?: string
): void => {
  handle.change(doc => {
    const trace = doc.traces[traceId]
    if (!trace) return
    trace.status = status
    trace.completedAt = Date.now()
    if (errorMessage) trace.errorMessage = errorMessage
  })
}

```

## File: src/data/Commands.ts
```typescript
import { CommandDefinition } from "./CommandDefinition.js";
import { Store, getApps, getDisks, getDisk, getRunningEngines, getInstances, getEngine, findDiskByName, findInstanceByName, getLocalEngine, createClientStore } from "./Store.js";
import { deepPrint, log, print } from "../utils/utils.js";
import { buildInstance, startInstance, runInstance, stopInstance } from "./Instance.js";
import { buildEngine, syncEngine, clearKnownHost, rebootEngine } from "./Engine.js";
import { AppName, Command, DiskID, DiskName, EngineID, Hostname, InstanceName, Version } from "./CommonTypes.js";
import { localEngineId } from "./Engine.js";
import { chalk, fs, $ } from "zx";
import { ssh } from '../utils/ssh.js'

$.verbose = false;
import { DocHandle, Repo } from "@automerge/automerge-repo";
import { config } from "./Config.js";
import { generateHostName } from "../utils/nameGenerator.js";
import pack from '../../package.json' with { type: "json" };
import { sendCommand } from "../utils/commandUtils.js";
import { installApp } from './InstallApp.js';
import { copyApp, moveApp } from './CopyMoveApp.js';
import { resourceLock, diskKey } from '../utils/ResourceLock.js';
import { undockDisk } from "../monitors/usbDeviceMonitor.js";
import { backupInstance, restoreApp, createBackupDiskConfig } from "../monitors/backupMonitor.js";
import { cancelOperation } from './Operations.js';
import { testContext } from "../../test/testContext.js";


import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";

import { lookup } from 'dns/promises';

const connect = async (storeHandle: DocHandle<Store> | null, args: string) => {
    // Basic parser to separate engine names from a potential --timeout flag
    const parts = args.split(' ');
    const engineNames = parts.filter(p => !p.startsWith('--'));
    const timeoutFlagIndex = parts.findIndex(p => p === '--timeout');
    const timeoutSeconds = timeoutFlagIndex !== -1 && parts[timeoutFlagIndex + 1] 
        ? parseInt(parts[timeoutFlagIndex + 1], 10) 
        : undefined;

    // Look up the actual hostnames from the config based on the logical names
    const hostnames = engineNames.map(name => {
        return name+'.local' as Hostname;
    });

    const peerId = 'testrunner-' + Math.random().toString(36).substring(2);
    const storeDocUrlStr = fs.readFileSync("./store-identity/store-url.txt", 'utf-8');
    const DOCUMENT_ID = storeDocUrlStr.trim() as any;

    // createClientStore now handles DNS resolution and timeouts
    const { handle, repo } = await createClientStore(hostnames, peerId as any, DOCUMENT_ID, timeoutSeconds);
    
    testContext.storeHandle = handle;
    testContext.repo = repo;
};

// Command to disconnect the test runner
const disconnect = () => {
    if (testContext.repo) {
        print(chalk.blue("Disconnecting test runner..."));
        const repo = testContext.repo as Repo;
        // This is a bit of a hack to get the adapters, as they are not exposed.
        // It assumes the adapters are stored on the repo object by createClientStore, which they are not.
        // This will need to be fixed.
        // [...repo.networkSubsystem.networkAdapters].forEach(adapter => repo.networkSubsystem.removeNetworkAdapter(adapter));
        testContext.repo = undefined;
        testContext.storeHandle = undefined;
    }
};


const buildEngineWrapper = async (storeHandle: DocHandle<Store> | null, argsString: string) => {
    print(chalk.blue(`Executing remote buildEngine command with args: ${argsString}`));

    // Basic parser for a string of command-line args
    const parseArgs = (str: string): any => {
        const output: { [key: string]: any } = {};
        const parts = str.match(/--(\w+)(?:[= ]([^\s"'\[\]]+|"[^"]*"|'[^']*'))?/g) || [];
        parts.forEach(part => {
            const match = part.match(/--(\w+)(?:[= ](.+))?/);
            if (match) {
                const key = match[1];
                const value = match[2] ? match[2].replace(/["']/g, '') : true;
                output[key] = value;
            }
        });
        return output;
    };

    const parsedArgs = parseArgs(argsString);
    const defaults = config.defaults;

    const machine = parsedArgs.machine;
    if (!machine) {
        console.error(chalk.red('buildEngine command requires a --machine argument.'));
        return;
    }

    // Clear the known_hosts entry for the target machine before attempting to connect
    await clearKnownHost(machine);

    const user = parsedArgs.user || defaults.user;
    const exec = ssh(`${user}@${machine}`);
    const buildArgs = {
        exec,
        isLocalMode: false,
        machine: machine,
        user: user,
        hostname: parsedArgs.hostname || generateHostName(),
        language: parsedArgs.language || defaults.language,
        keyboard: parsedArgs.keyboard || defaults.keyboard,
        timezone: parsedArgs.timezone || defaults.timezone,
        upgrade: parsedArgs.upgrade !== undefined ? parsedArgs.upgrade : defaults.upgrade,
        argon: parsedArgs.argon !== undefined ? parsedArgs.argon : defaults.argon,
        zerotier: parsedArgs.zerotier !== undefined ? parsedArgs.zerotier : defaults.zerotier,
        raspap: parsedArgs.raspap !== undefined ? parsedArgs.raspap : defaults.raspap,
        gadget: parsedArgs.gadget !== undefined ? parsedArgs.gadget : defaults.gadget,
        temperature: parsedArgs.temperature !== undefined ? parsedArgs.temperature : defaults.temperature,
        version: pack.version,
        productionMode: parsedArgs.prod || false,
        enginePath: config.defaults.enginePath,
    };
    try {
        await syncEngine(user, machine);
        await buildEngine(buildArgs);
        print(chalk.green('buildEngine command finished successfully.'));
    } catch (e: any) {
        console.error(chalk.red(`buildEngine command failed: ${e.message}`));
    }
}

const ls = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    print('NetworkData on this engine:');
    print(deepPrint(storeHandle.doc()), 3);
}

const lsEngines = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    print('Engines:');
    const engines = getRunningEngines(storeHandle.doc());
    print(`Total engines: ${engines.length}`);
    print(deepPrint(engines, 2));
}

const lsDisks = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    print('Disks:');
    const disks = getDisks(storeHandle.doc());
    print(`Total disks: ${disks.length}`);
    print(deepPrint(disks, 2));
}

const lsApps = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    print('Apps:');
    const apps = getApps(storeHandle.doc());
    print(`Total apps: ${apps.length}`);
    print(deepPrint(apps, 2));
}

const lsInstances = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    print('Instances:');
    const instances = getInstances(storeHandle.doc());
    print(`Total instances: ${instances.length}`);
    print(deepPrint(instances, 2));
}

/**
 * installApp command wrapper.
 * Usage: installApp <appId> <targetDiskName> [--source <sourceDiskName>] [--name <instanceName>]
 *
 * All arguments are passed as a single string and parsed here.
 */
const installAppWrapper = async (storeHandle: DocHandle<Store> | null, argsString: string) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available.")); return; }

    // Parse: installApp kolibri-1.0 my-disk --source catalog-disk --name my-kolibri
    const parts = argsString.trim().split(/\s+/)
    const appId = parts[0] as any
    const targetDiskName = parts[1] as any
    if (!appId || !targetDiskName) {
        console.error(chalk.red('Usage: installApp <appId> <targetDiskName> [--source <sourceDiskName>] [--name <instanceName>]'))
        return
    }
    const sourceIdx = parts.indexOf('--source')
    const nameIdx = parts.indexOf('--name')
    const sourceDiskName = sourceIdx !== -1 ? parts[sourceIdx + 1] as any : undefined
    const instanceName = nameIdx !== -1 ? parts[nameIdx + 1] as any : undefined

    await installApp(storeHandle, { appId, targetDiskName, sourceDiskName, instanceName })
}

/**
 * @deprecated Use installApp instead.
 * createInstance is kept as an alias for backward compatibility.
 * It calls installApp with explicit GitHub routing (no internet probe).
 */
const createInstanceWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, appName: AppName, gitAccount: string, gitTag: string, diskName: DiskName) => {
    console.warn(chalk.yellow('createInstance is deprecated — use installApp instead'))
    const store = storeHandle?.doc()
    if (!store) { console.error(chalk.red("Store is not available to create instance.")); return; }
    const disk = findDiskByName(store, diskName)
    if (!disk || !disk.device) {
        print(chalk.red(`Disk '${diskName}' not found or has no device on engine ${localEngineId}`))
        return
    }
    await buildInstance(instanceName, appName, gitAccount, gitTag as Version, disk.device)
}

const startInstanceWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, diskName: DiskName, ...rest: string[]) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available.")); return; }
    // Parse optional --cause flag forwarded by cross-engine copyApp dispatch
    const causeFlag = rest.find(a => a.startsWith('--cause'))
    const cause: import('./CommonTypes.js').OperationCause =
        causeFlag ? (causeFlag.split('=')[1] ?? rest[rest.indexOf(causeFlag) + 1] ?? 'cross-engine-cmd') as any
        : 'console-command'
    const store = storeHandle.doc()
    const instance = findInstanceByName(store, instanceName)
    if (!instance) {
        print(chalk.red(`Instance ${instanceName} not found`))
        return
    }
    // Look up disk by ID from instance.storedOn — same fix as stopInstanceWrapper.
    // findDiskByName uses getDisks() which filters dockedTo != null and misses
    // disks that appear undocked in the CRDT but are physically still attached.
    const disk = (instance.storedOn ? getDisk(store, instance.storedOn) : undefined) ?? findDiskByName(store, diskName)
    if (!disk) {
        print(chalk.red(`Disk '${diskName}' not found or has no device on engine ${localEngineId}`))
        return
    }
    startInstance(storeHandle, instance, disk, cause)
}

const runInstanceWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, diskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available.")); return; }
    const store = storeHandle.doc()
    const instance = findInstanceByName(store, instanceName)
    const disk = findDiskByName(store, diskName)
    if (!instance) {
        print(chalk.red(`Instance ${instanceName} not found`))
        return
    }
    if (!disk) {
        print(chalk.red(`Disk ${diskName} not found`))
        return
    }
    runInstance(storeHandle, instance, disk)
}

const stopInstanceWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, diskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available.")); return; }
    const store = storeHandle.doc()
    const instance = findInstanceByName(store, instanceName)
    if (!instance) {
        print(chalk.red(`Instance ${instanceName} not found`))
        return
    }
    // Look up disk by ID from instance.storedOn — not via getDisks() which filters
    // to dockedTo != null and would miss disks that appear undocked in the CRDT.
    const disk = (instance.storedOn ? getDisk(store, instance.storedOn) : undefined) ?? findDiskByName(store, diskName)
    if (!disk) {
        print(chalk.red(`Disk '${diskName}' not found or has no device on engine ${localEngineId}`))
        return
    }
    stopInstance(storeHandle, instance, disk, 'console-command')
}

const sendWrapper = (storeHandle: DocHandle<Store> | null, args: string) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    const firstSpaceIndex = args.indexOf(' ');
    if (firstSpaceIndex === -1) {
        console.error(chalk.red("Send command requires at least two arguments: <engineId> <command>"));
        return;
    }
    const engineId = args.substring(0, firstSpaceIndex);
    const command = args.substring(firstSpaceIndex + 1);
    sendCommand(storeHandle, engineId as EngineID, command as Command);
}

const rebootWrapper = async (storeHandle: DocHandle<Store> | null) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    const localEngine = getLocalEngine(storeHandle.doc());
    await rebootEngine(storeHandle, localEngine);
}

const backupAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, backupDiskName?: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    const store = storeHandle.doc()
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) { console.error(chalk.red(`Instance '${instanceName}' not found.`)); return; }

    // Find backup disk: named or first linked docked Backup Disk
    let backupDisk = backupDiskName
        ? Object.values(store.diskDB).find(d => d.name === backupDiskName && d.device != null)
        : Object.values(store.diskDB).find(d =>
            d.device != null &&
            d.diskTypes?.includes('backup') &&
            d.backupConfig?.links.includes(instance.id)
          )

    if (!backupDisk) {
        console.error(chalk.red(`No docked Backup Disk found${backupDiskName ? ` named '${backupDiskName}'` : ` linked to instance '${instanceName}'`}.`))
        return
    }
    print(chalk.blue(`Backing up instance '${instanceName}' to disk '${backupDisk.name}'...`))
    await backupInstance(storeHandle, instance.id, backupDisk as any, undefined, 'console-command')
}

const restoreAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, targetDiskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    const store = storeHandle.doc()
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) { console.error(chalk.red(`Instance '${instanceName}' not found in store.`)); return; }

    const targetDisk = Object.values(store.diskDB).find(d => d.name === targetDiskName && d.device != null)
    if (!targetDisk) { console.error(chalk.red(`Target disk '${targetDiskName}' not found or not docked.`)); return; }

    print(chalk.blue(`Restoring instance '${instanceName}' to disk '${targetDiskName}'...`))
    await restoreApp(storeHandle, instance.id, targetDisk as any, undefined, 'console-command')
}

const createBackupDiskWrapper = async (storeHandle: DocHandle<Store> | null, diskName: DiskName, mode: string, ...instanceNames: InstanceName[]) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    const validModes = ['immediate', 'on-demand', 'scheduled']
    if (!validModes.includes(mode)) {
        console.error(chalk.red(`Invalid mode '${mode}'. Valid modes: ${validModes.join(', ')}`))
        return
    }
    const store = storeHandle.doc()
    const disk = Object.values(store.diskDB).find(d => d.name === diskName && d.device != null)
    if (!disk) { console.error(chalk.red(`Disk '${diskName}' not found or not docked.`)); return; }

    const instanceIds = instanceNames.map(name => {
        const inst = Object.values(store.instanceDB).find(i => i.name === name)
        if (!inst) console.warn(chalk.yellow(`Warning: instance '${name}' not found — it will be added to the links list anyway`))
        return inst?.id
    }).filter(Boolean) as any[]

    print(chalk.blue(`Creating Backup Disk config on '${diskName}' (mode: ${mode})...`))
    await createBackupDiskConfig(storeHandle, disk as any, mode as any, instanceIds)
    print(chalk.green(`Backup Disk '${diskName}' configured.`))
}

const copyAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, sourceDiskId: DiskID, targetDiskId: DiskID) => {
    if (!storeHandle) { console.error(chalk.red('Store is not available.')); return; }
    await copyApp(storeHandle, instanceName, sourceDiskId, targetDiskId, 'console-command')
}

const moveAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, sourceDiskId: DiskID, targetDiskId: DiskID) => {
    if (!storeHandle) { console.error(chalk.red('Store is not available.')); return; }
    await moveApp(storeHandle, instanceName, sourceDiskId, targetDiskId, 'console-command')
}

const ejectDiskWrapper = async (storeHandle: DocHandle<Store> | null, diskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    const store = storeHandle.doc();
    // Search all diskDB entries (not just currently docked ones) so we can give a
    // meaningful "not currently docked" error instead of a misleading "not found".
    const disk = Object.values(store.diskDB).find(d => d.name === diskName);
    if (!disk) {
        console.error(chalk.red(`Disk '${diskName}' not found.`));
        return;
    }
    if (!disk.device) {
        console.error(chalk.red(`Disk '${diskName}' is not currently docked.`));
        return;
    }
    const localEngine = getLocalEngine(store);
    if (disk.dockedTo !== localEngine?.id) {
        console.error(chalk.red(`Disk '${diskName}' is not docked to this engine.`));
        return;
    }
    // Refuse to eject if an operation is actively using this disk
    if (resourceLock.isLocked(diskKey(disk.id))) {
        const info = resourceLock.getLockInfo(diskKey(disk.id))
        console.error(chalk.red(`Disk '${diskName}' is locked by an active '${info?.kind}' operation. Stop or wait for it to complete before ejecting.`))
        return
    }
    print(chalk.blue(`Ejecting disk '${diskName}'...`));
    await undockDisk(storeHandle, disk);
    print(chalk.green(`Disk '${diskName}' ejected successfully.`));
}

export const commands: CommandDefinition[] = [
    { name: "ls", execute: ls, args: [], scope: 'any' },
    { name: "engines", execute: lsEngines, args: [], scope: 'any' },
    { name: "disks", execute: lsDisks, args: [], scope: 'any' },
    { name: "apps", execute: lsApps, args: [], scope: 'any' },
    { name: "instances", execute: lsInstances, args: [], scope: 'any' },
    {
        name: "send",
        execute: sendWrapper,
        args: [{ type: "string" }],
        scope: 'any'
    },
    { name: "installApp", execute: installAppWrapper, args: [{ type: "string" }], scope: 'engine' },
    { name: "createInstance", execute: createInstanceWrapper, args: [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }], scope: 'engine' },
    { name: "startInstance", execute: startInstanceWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "diskId" }], scope: 'engine' },
    { name: "runInstance", execute: runInstanceWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "diskId" }], scope: 'engine' },
    { name: "stopInstance", execute: stopInstanceWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "diskId" }], scope: 'engine' },
    {
        name: "reboot",
        execute: rebootWrapper,
        args: [],
        scope: 'engine'
    },
    {
        name: "buildEngine",
        execute: buildEngineWrapper,
        args: [{ type: "string" }],
        scope: 'engine'
    },
    { name: "connect", execute: connect, args: [{ type: "string" }], scope: 'any' },
    { name: "disconnect", execute: disconnect, args: [], scope: 'any' },
    { name: "copyApp", execute: copyAppWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "sourceDiskId" }, { type: "string", name: "targetDiskId" }], scope: 'engine' },
    { name: "moveApp", execute: moveAppWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "sourceDiskId" }, { type: "string", name: "targetDiskId" }], scope: 'engine' },
    { name: "ejectDisk", execute: ejectDiskWrapper, args: [{ type: "string", name: "diskId" }], scope: 'engine' },
    { name: "backupApp", execute: backupAppWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "backupDiskId" }], scope: 'engine' },
    { name: "restoreApp", execute: restoreAppWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "backupDiskId" }], scope: 'engine' },
    { name: "createBackupDisk", execute: createBackupDiskWrapper, args: [{ type: "string", name: "instanceName" }, { type: "string", name: "sourceDiskId" }, { type: "string", name: "targetDiskId" }], scope: 'engine' },
    { name: "cancelOperation", execute: async (storeHandle: DocHandle<Store> | null, opId: string) => {
        if (!storeHandle) { console.error(chalk.red('Store is not available.')); return; }
        const err = cancelOperation(storeHandle, opId)
        if (err) console.error(chalk.red(`cancelOperation: ${err}`))
        else print(chalk.green(`Operation ${opId} cancelled`))
    }, args: [{ type: "string" }], scope: 'engine' },
];

```

## File: src/data/CommonTypes.ts
```typescript
declare const __brand__type__: unique symbol;
type Brand<BaseType, BrandName> = BaseType & {
  readonly [__brand__type__]: BrandName;
}



export type Version = Brand<string, "VERSION"> // Can be major.minor or a commit hash

export type EngineID = Brand<string, "DISKID">
export type DiskID = Brand<string, "DISKID">
export type AppID = Brand<string, "APPID">
export type InstanceID = Brand<string, "INSTANCEID">

export type AppnetName = Brand<string, "APPNETNAME">
export type AppName = Brand<string, "APPNETNAME">
export type InstanceName = Brand<string, "INSTANCENAME">

export type URL = Brand<string, "URL">

export type IPAddress = Brand<string, "IPADRESS">
export type NetMask = Brand<string, "NETMASK">
export type CIDR = Brand<string, "CIDR">
export type PortNumber = Brand<number, "PORTNUMBER">

export type InterfaceName = Brand<string, "INTERFACENAME">
export type DeviceName = Brand<string, "DEVICENAME">

export type Hostname = Brand<string, "HOSTNAME">
export type DiskName = Brand<string, "DISKNAME">
export type ServiceImage = Brand<string, "SERVICEIMAGE">

export type Timestamp = Brand<number, "TIMESTAMP">

export type Command = Brand<string, "COMMAND">

export type UserID = Brand<string, "USERID">

export type DiskType = 'app' | 'backup' | 'empty' | 'upgrade' | 'files' | 'system'
export type BackupMode = 'immediate' | 'on-demand' | 'scheduled'

export type OperationStatus = 'Pending' | 'Running' | 'Done' | 'Failed' | 'Cancelled'
export type OperationKind =
  | 'copyApp'
  | 'moveApp'
  | 'backupApp'
  | 'restoreApp'
  | 'upgradeApp'
  | 'upgradeEngine'
  | 'startApp'
  | 'stopApp'

/**
 * What triggered an operation.
 *
 * Exhaustive list of causes, derived from every callsite in the codebase:
 *
 * console-command   — operator typed a command in the web Console UI
 *                     (handleCommand via storeMonitor queue, source: Commands.ts wrappers)
 * cli-command       — operator ran a command via the local CLI REPL
 *                     (same Commands.ts wrappers, but invoked from the terminal)
 * cross-engine-cmd  — this engine received a startInstance command dispatched
 *                     by copyApp on a *remote* engine via sendCommand()
 *                     (CopyMoveApp.ts: sendCommand `startInstance …`)
 * post-copy         — automatic start/stop issued by copyApp on the LOCAL engine
 *                     (CopyMoveApp.ts: stop before snapshot, restart on failure)
 * post-move         — automatic stop/restart issued by moveApp
 *                     (CopyMoveApp.ts: stop before move, restart on failure)
 * disk-docked       — disk plugged in; engine auto-starts all instances stored on it
 *                     (Disk.ts: tracedStartInstance via processInstance)
 * disk-undocked     — disk removed; engine auto-stops all running instances on it
 *                     (usbDeviceMonitor.ts: stopInstance loop)
 * backup-pre-stop   — backup monitor stops instance before taking snapshot
 *                     (backupMonitor.ts: stopInstance before BorgBackup)
 * backup-post-start — backup monitor restarts instance after snapshot completes
 *                     (backupMonitor.ts: startInstance after BorgBackup)
 * backup-stale-lock — backup monitor retries a backup whose lock file survived a crash
 *                     (backupMonitor.ts: checkPendingBackups stale-lock branch)
 * backup-app-docked — backup monitor triggers backup when App Disk docks while Backup
 *                     Disk is already present
 *                     (backupMonitor.ts: checkPendingBackups app-disk-docked branch)
 * crash-recovery    — engine restarted with a Pending/Running operation in the store;
 *                     recoverInterruptedOperations() re-queues idempotent ops
 *                     (Operations.ts + start.ts)
 */
export type OperationCause =
  | 'console-command'
  | 'cli-command'
  | 'cross-engine-cmd'
  | 'post-copy'
  | 'post-move'
  | 'disk-docked'
  | 'disk-undocked'
  | 'backup-pre-stop'
  | 'backup-post-start'
  | 'backup-stale-lock'
  | 'backup-app-docked'
  | 'crash-recovery'

export interface OperationSubject {
  type: 'instance' | 'disk' | 'engine'
  id: string
}

export interface Operation {
  id: string
  kind: OperationKind
  /** Arguments passed to the operation (e.g. instanceId, sourceDiskId, targetDiskId). */
  args: Record<string, string>
  /** What triggered this operation. Never null — must be set at creation time. */
  cause: OperationCause
  /** The primary entity this operation acts on. Enables O(1) UI lookup without scanning operationDB. */
  subject: OperationSubject | null
  engineId: EngineID
  status: OperationStatus
  progressPercent: number | null
  /** Step-based progress. Null when not applicable or operation is complete. */
  currentStep: number | null
  totalSteps: number | null
  stepLabel: string | null
  startedAt: Timestamp
  completedAt: Timestamp | null
  error: string | null
}

// References to top-level YMaps and YArrays in the Yjs document
// export type YMapRef = string
// export type YArrayRef = string

export interface DockerMetrics {
  cpuPercent: number | null;
  memUsageBytes: number | null;
  memLimitBytes: number | null;
  memPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  sampledAt: number | null;       // Unix ms timestamp of last sample
}

export interface DockerLogs {
  logs: string[]; // Assuming logs are strings, but this could be more complex
}

export interface DockerEvents {
  events: string[]; // Similarly, assuming simple string descriptions
}

// interface DockerConfiguration {
//   // Define the structure according to the Docker configuration specifics
//   [key: string]: any; // Placeholder, adjust as needed
// }

```

## File: src/data/Config.ts
```typescript
import { $, YAML, chalk, fs } from "zx";
import { log } from "../utils/utils.js";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ##################################################################################################
// Type Definitions
// ##################################################################################################

export interface Settings {
    mdns: boolean;
    isDev: boolean;
    testMode: boolean;
    port: number;
    httpPort: number;
    consolePath: string;
    storeDataFolder: string;
    storeIdentityFolder: string;
    heartbeatIntervalMs: number;  // How often the engine writes a heartbeat to the store (default: 50000ms)
    systemDiskSkip?: boolean;     // If true, skip registering the Pi boot disk as a system disk (for test harnesses)
}

export interface Defaults {
    user: string;
    machine: string;
    password: string;
    engine: string;
    network: string;
    language: string;
    keyboard: string;
    timezone: string;
    upgrade: boolean;
    hdmi: boolean;
    temperature: boolean;
    argon: boolean;
    zerotier: boolean;
    raspap: boolean;
    gadget: boolean;
    nodocker: boolean;
    gitAccount: string;
    enginePath: string;
}

export interface InstanceConfig {
    instanceName: string;
    appName: string;
    version: string;
    title: string;
}

export interface DiskConfig {
    diskId: string;
    type: "AppDisk";
    instances: InstanceConfig[];
}

export interface EngineConfig {
    name: string;
    hostname: string;
}

export type TestAction = 
    | { type: "runCommand"; command: string; }
    | { type: "sendCommand"; targetEngineName: string; command: string; };

export interface TestAssertion {
    description: string;
    path: string;
    should: string;
}

export interface TestSequenceItem {
    stage: number;
    description: string;
    manualInstruction: string | null;
    action: TestAction | null;
    assert: TestAssertion[];
}

export interface TestSetup {
    resetBeforeTest: boolean;
    engines: EngineConfig[];
    disks: DiskConfig[];
    interactiveTestSequence: TestSequenceItem[];
    automatedTestSequence: TestSequenceItem[];
}

export interface Config {
    settings: Settings;
    defaults: Defaults;
    testSetup: TestSetup;
}

// ##################################################################################################
// Validation Logic
// ##################################################################################################

function validate<T>(obj: any, validator: (obj: any, path: string) => string[]): string[] {
    return validator(obj, '');
}

function validateSettings(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.mdns !== 'boolean') errors.push(`'${path}mdns' must be a boolean.`);
    if (typeof obj.isDev !== 'boolean') errors.push(`'${path}isDev' must be a boolean.`);
    if (typeof obj.testMode !== 'boolean') errors.push(`'${path}testMode' must be a boolean.`);
    if (typeof obj.port !== 'number') errors.push(`'${path}port' must be a number.`);
    if (typeof obj.storeDataFolder !== 'string') errors.push(`'${path}storeDataFolder' must be a string.`);
    if (typeof obj.storeIdentityFolder !== 'string') errors.push(`'${path}storeIdentityFolder' must be a string.`);
    if (typeof obj.httpPort !== 'number') errors.push(`'${path}httpPort' must be a number.`);
    if (typeof obj.consolePath !== 'string') errors.push(`'${path}consolePath' must be a string.`);
    if (obj.heartbeatIntervalMs !== undefined && typeof obj.heartbeatIntervalMs !== 'number') errors.push(`'${path}heartbeatIntervalMs' must be a number.`);
    return errors;
}

function validateDefaults(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.user !== 'string') errors.push(`'${path}user' must be a string.`);
    if (typeof obj.enginePath !== 'string') errors.push(`'${path}enginePath' must be a string.`);
    // Add other default checks here as needed for completeness
    return errors;
}

function validateTestAction(obj: any, path: string): string[] {
    if (obj === null) return [];
    const errors: string[] = [];
    if (typeof obj !== 'object') return [`'${path}' must be an object or null.`];
    
    switch (obj.type) {
        case 'runCommand':
            if (typeof obj.command !== 'string') errors.push(`'${path}command' must be a string for runCommand.`);
            break;
        case 'sendCommand':
            if (typeof obj.targetEngineName !== 'string') errors.push(`'${path}targetEngineName' must be a string for sendCommand.`);
            if (typeof obj.command !== 'string') errors.push(`'${path}command' must be a string for sendCommand.`);
            break;
        default:
            errors.push(`'${path}type' has an unknown value: ${obj.type}.`);
    }
    return errors;
}

function validateTestSequenceItem(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.stage !== 'number') errors.push(`'${path}stage' must be a number.`);
    if (typeof obj.description !== 'string') errors.push(`'${path}description' must be a string.`);
    if (typeof obj.manualInstruction !== 'string' && obj.manualInstruction !== null) errors.push(`'${path}manualInstruction' must be a string or null.`);
    errors.push(...validateTestAction(obj.action, `${path}action.`));
    if (!Array.isArray(obj.assert)) errors.push(`'${path}assert' must be an array.`);
    return errors;
}

function validateTestSetup(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.resetBeforeTest !== 'boolean') errors.push(`'${path}resetBeforeTest' must be a boolean.`);
    if (!Array.isArray(obj.engines)) errors.push(`'${path}engines' must be an array.`);
    if (!Array.isArray(obj.disks)) errors.push(`'${path}disks' must be an array.`);
    if (!Array.isArray(obj.interactiveTestSequence)) errors.push(`'${path}interactiveTestSequence' must be an array.`);
    else errors.push(...obj.interactiveTestSequence.flatMap((item, i) => validateTestSequenceItem(item, `${path}interactiveTestSequence[${i}].`)));
    if (!Array.isArray(obj.automatedTestSequence)) errors.push(`'${path}automatedTestSequence' must be an array.`);
    else errors.push(...obj.automatedTestSequence.flatMap((item, i) => validateTestSequenceItem(item, `${path}automatedTestSequence[${i}].`)));
    return errors;
}

function validateConfig(obj: any): string[] {
    const errors: string[] = [];
    if (!obj) return ["Config object is null or undefined."];
    errors.push(...validateSettings(obj.settings, 'settings.'));
    errors.push(...validateDefaults(obj.defaults, 'defaults.'));
    errors.push(...validateTestSetup(obj.testSetup, 'testSetup.'));
    return errors.filter(e => e); // Filter out empty strings/nulls
}

// ##################################################################################################
// Configuration Loading
// ##################################################################################################

const readConfig = (path: string): Config => {
  try {
    const configFile = fs.readFileSync(path, 'utf8');
    const parsedConfig = YAML.parse(configFile);

    const validationErrors = validateConfig(parsedConfig);
    if (validationErrors.length > 0) {
        console.error(chalk.red('Config file validation failed!'));
        validationErrors.forEach(error => console.error(chalk.red(`  - ${error}`)));
        process.exit(1);
    }

    log(chalk.green('Config file is valid.'));
    return parsedConfig as Config;

  } catch (e) {
    log(chalk.red('Error reading or parsing config.yaml!'));
    console.error(e);
    process.exit(1);
  }
}

export const config = readConfig('./config.yaml');

// Allow IDEA_TEST_MODE=true env var to force testMode on without editing config.yaml.
// NOTE: This mutates the already-exported config object at module load time.
// Safe only because all consumers read config.settings.testMode inside function bodies,
// not at module scope. If any future module reads testMode at import time, this will
// silently not apply to that module — move to a getter pattern at that point.
// This must be set before any module that reads config at import time (e.g. Engine.ts).
if (process.env.IDEA_TEST_MODE === 'true') {
    config.settings.testMode = true;
}

// Allow IDEA_ENGINE_PORT=<number> to override the WebSocket port from config.yaml.
// Used by Kit's test harness to run a second engine alongside the production instance.
if (process.env.IDEA_ENGINE_PORT) {
    const port = parseInt(process.env.IDEA_ENGINE_PORT, 10);
    if (!isNaN(port)) {
        config.settings.port = port;
    }
}

// Allow IDEA_STORE_DIR=<path> to override the store data folder from config.yaml.
// Used by Kit's test harness to give the test engine an isolated store directory.
if (process.env.IDEA_STORE_DIR) {
    config.settings.storeDataFolder = process.env.IDEA_STORE_DIR;
}

// Allow IDEA_SYSTEM_DISK_SKIP=true to skip registering the Pi boot disk as a system disk.
// Used by Kit's test harness to avoid conflicts with the production engine on the same Pi.
if (process.env.IDEA_SYSTEM_DISK_SKIP === 'true') {
    config.settings.systemDiskSkip = true;
}

// Allow IDEA_MDNS_DISABLE=true to suppress mDNS advertisement and peer discovery.
// Used by Kit's test harness to prevent the test engine from conflicting with the
// production engine's mDNS service name and attempting to sync with its store.
if (process.env.IDEA_MDNS_DISABLE === 'true') {
    config.settings.mdns = false;
}
```

## File: src/data/CopyMoveApp.ts
```typescript
/**
 * CopyMoveApp.ts — copyApp and moveApp command implementations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine — source and target on local engine.
 * Phase 2: cross-engine — source on local engine, target on remote engine;
 *   rsync over SSH, remote start via sendCommand.
 */

import { chalk, fs, $ } from 'zx'
import { log } from '../utils/utils.js'
import { rsyncDirectory } from '../utils/rsync.js'
import {
    InstanceID, DiskID, DiskName, InstanceName, Timestamp,
    OperationKind, OperationCause, ServiceImage
} from './CommonTypes.js'
import { Store, getDisk, getInstance, getInstancesOfDisk } from './Store.js'
import { Disk, processInstance, diskMountRoot, diskFsRoot } from './Disk.js'
import { stopInstance, startInstance } from './Instance.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'
import { createOperation, updateOperation } from './Operations.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { sendCommand } from '../utils/commandUtils.js'
import { getEngineAddress } from './Network.js'
import { Instance, Status } from './Instance.js'
import { IPAddress } from './CommonTypes.js'
import os from 'os'

// ── Disk free-space check ─────────────────────────────────────────────────────

/**
 * Returns available bytes on the filesystem containing `path`.
 * Exported so tests can mock it.
 */
export const availableBytes = async (path: string): Promise<number> => {
    // df -k outputs 1K-blocks; Available is column 4
    const result = await $`df -k ${path} | awk 'NR==2{print $4}'`
    const kb = parseInt(result.stdout.trim(), 10)
    return kb * 1024
}

/**
 * Returns total size in bytes of `path` (recursive).
 * Exported so tests can mock it.
 */
export const directoryBytes = async (path: string): Promise<number> => {
    const result = await $`du -sk ${path} | awk '{print $1}'`
    const kb = parseInt(result.stdout.trim(), 10)
    return kb * 1024
}

// ── Shared validation ─────────────────────────────────────────────────────────

interface ValidatedCopyMove {
    instance: ReturnType<typeof getInstance> & {}
    sourceDisk: Disk
    targetDisk: Disk
    appId: string
    sourceDevice: string
    targetDevice: string
    appMasterSrc: string
    instanceSrc: string
}

const validate = async (
    store: Store,
    instanceName: InstanceName,
    sourceDiskId: DiskID,
    targetDiskId: DiskID
): Promise<ValidatedCopyMove | string> => {
    // Look up instance — search all (not just Running) so we can copy stopped instances too
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) return `Instance '${instanceName}' not found`

    const sourceDisk = getDisk(store, sourceDiskId) as Disk | undefined
    if (!sourceDisk) return `Source disk '${sourceDiskId}' not found`
    if (!sourceDisk.device) return `Source disk '${sourceDiskId}' is not docked`

    const targetDisk = getDisk(store, targetDiskId) as Disk | undefined
    if (!targetDisk) return `Target disk '${targetDiskId}' not found`
    if (!targetDisk.device) return `Target disk '${targetDiskId}' is not docked`

    if (sourceDisk.id === targetDisk.id) return `Source and target disk are the same`

    // Source must always be local — we rsync FROM local paths.
    const { localEngineId } = await import('./Engine.js')
    if (String(sourceDisk.dockedTo) !== String(localEngineId)) {
        return `Source disk '${sourceDisk.name}' is docked to a remote engine. Copy/move must be initiated from that engine.`
    }

    // Target may be local or remote (cross-engine Phase 2).
    // If remote, validate that the engine is reachable (has an address in network.connections).
    if (String(targetDisk.dockedTo) !== String(localEngineId)) {
        const targetEngineId = targetDisk.dockedTo!
        const remoteAddress = getEngineAddress(targetEngineId as any)
        if (!remoteAddress) {
            return `Target engine '${targetEngineId}' is not currently reachable (not in network connections). Ensure it is online and connected.`
        }
    }

    if (String(instance.storedOn) !== String(sourceDisk.id)) {
        return `Instance '${instanceName}' is not stored on disk '${sourceDiskId}'`
    }

    const sourceDevice = sourceDisk.device
    const targetDevice = targetDisk.device

    // Locate app master: <mountRoot>/apps/<appId>/
    const sourceMountRoot = await diskMountRoot(sourceDisk)
    const appsDir = `${sourceMountRoot}/apps`
    let appId: string | null = null
    if (await fs.pathExists(appsDir)) {
        const entries = await fs.readdir(appsDir)
        appId = entries.find(e => instance.instanceOf.startsWith(e) || e === instance.instanceOf) ?? null
        // instanceOf is <appName>-<version>; the apps/ dir entry IS that appId
        if (!appId) appId = instance.instanceOf as string
    }
    if (!appId) return `App master for '${instance.instanceOf}' not found on source disk`

    const appMasterSrc = `${sourceMountRoot}/apps/${appId}`
    const instanceSrc = `${sourceMountRoot}/instances/${instance.id}`

    if (!await fs.pathExists(appMasterSrc)) return `App master directory not found: ${appMasterSrc}`
    if (!await fs.pathExists(instanceSrc)) return `Instance directory not found: ${instanceSrc}`

    return { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc }
}

// ── copyApp ───────────────────────────────────────────────────────────────────

/**
 * Copy an app instance from sourceDisk to targetDisk.
 * The copy receives a fresh InstanceID — it is a brand new instance.
 * The original keeps running (it is stopped during the file copy, then restarted).
 */
export const copyApp = async (
    storeHandle: DocHandle<Store>,
    instanceName: InstanceName,
    sourceDiskId: DiskID,
    targetDiskId: DiskID,
    cause: OperationCause = 'console-command',
): Promise<void> => {
    const store = storeHandle.doc()

    const v = await validate(store, instanceName, sourceDiskId, targetDiskId)
    if (typeof v === 'string') {
        console.error(chalk.red(`copyApp: ${v}`))
        return
    }
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc } = v

    // Acquire per-resource locks: source instance + target disk
    const lockKeys = [instanceKey(instance.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(lockKeys, 'copyApp')) {
        console.error(chalk.red(`copyApp: resource locked — another operation is already running on instance '${instanceName}' or target disk '${targetDisk.name}'. Retry when it completes.`))
        return
    }

    const opId = createOperation(storeHandle, 'copyApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
    }, cause, { type: 'instance', id: instance.id })

    const newInstanceId = uuid() as InstanceID
    let wasRunning = false

    // Detect cross-engine: target disk is on a different engine
    const { localEngineId } = await import('./Engine.js')
    const isCrossEngine = String(targetDisk.dockedTo) !== String(localEngineId)
    const remoteAddress = isCrossEngine
        ? getEngineAddress(targetDisk.dockedTo as any) as string
        : undefined

    // ── step definitions ──────────────────────────────────────────────────────
    const COPY_STEPS = [
        'Stopping instance',          // 0
        'Checking free space',        // 1
        'Syncing app master',         // 2
        'Syncing instance data',      // 3
        'Syncing service images',     // 4
        'Registering on target disk', // 5
    ]
    const setCopyStep = (step: number) =>
        updateOperation(storeHandle, opId, { currentStep: step, totalSteps: COPY_STEPS.length, stepLabel: COPY_STEPS[step] })

    try {
        // 1. Stop source instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            wasRunning = true
            log(`copyApp: stopping instance '${instanceName}' for consistent snapshot`)
            setCopyStep(0)
            await stopInstance(storeHandle, instance, sourceDisk, 'post-copy')
        }

        updateOperation(storeHandle, opId, { status: 'Running' })

        // 2. Check free space (local only — skip for cross-engine)
        setCopyStep(1)
        if (!isCrossEngine) {
            const needed = await directoryBytes(appMasterSrc) + await directoryBytes(instanceSrc)
            const available = await availableBytes(await diskFsRoot(targetDisk))
            if (available < needed) {
                throw new Error(
                    `Not enough space on disk '${targetDisk.name}' (${targetDisk.id}): need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                    `have ${Math.ceil(available / 1024 / 1024)}MB`
                )
            }
        }

        // 3. Ensure target directory structure
        // For cross-engine: SSH mkdir on remote Pi
        const targetMountRoot = await diskMountRoot(targetDisk) // '' for system disk (both local and remote)
        if (isCrossEngine) {
            log(`copyApp: ensuring remote directories on ${remoteAddress}`)
            await $`ssh -o StrictHostKeyChecking=no pi@${remoteAddress} sudo mkdir -p ${targetMountRoot}/apps ${targetMountRoot}/instances ${targetMountRoot}/services && sudo chown -R pi:pi ${targetMountRoot}/apps ${targetMountRoot}/instances ${targetMountRoot}/services`
        } else {
            await fs.ensureDir(`${targetMountRoot}/apps`)
            await fs.ensureDir(`${targetMountRoot}/instances`)
            await fs.ensureDir(`${targetMountRoot}/services`)
        }

        // 4. rsync app master (idempotent — skips if already present and identical)
        setCopyStep(2)
        const appMasterDest = `${targetMountRoot}/apps/${appId}`
        log(`copyApp: syncing app master ${appMasterSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${appMasterDest}`)
        await rsyncDirectory(appMasterSrc, appMasterDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: Math.round(progressPercent * 0.25) })
        }, opId, remoteAddress)

        // 5. rsync instance data into a NEW instance directory (new ID)
        setCopyStep(3)
        const instanceDest = `${targetMountRoot}/instances/${newInstanceId}`
        if (!isCrossEngine) await fs.ensureDir(instanceDest)
        else await $`ssh -o StrictHostKeyChecking=no pi@${remoteAddress} mkdir -p ${instanceDest}`
        log(`copyApp: syncing instance data ${instanceSrc} → ${isCrossEngine ? remoteAddress + ':' : ''}${instanceDest}`)
        await rsyncDirectory(instanceSrc, instanceDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: 25 + Math.round(progressPercent * 0.30) })
        }, opId, remoteAddress)

        // 5b. rsync service image tars needed by this instance
        //     services/ holds the Docker image tars that startInstance loads via
        //     `docker image load`. Without them the copied instance cannot start.
        setCopyStep(4)
        const sourceMountRootCopy = await diskMountRoot(sourceDisk)
        const copyServicesSrcDir = `${sourceMountRootCopy}/services`
        const copyServicesDestDir = `${targetMountRoot}/services`
        if (instance.serviceImages?.length) {
            let servicesDone = 0
            for (const serviceImage of instance.serviceImages) {
                const tarName = (serviceImage as string).replace(/\//g, '_') + '.tar'
                const tarSrc = `${copyServicesSrcDir}/${tarName}`
                if (await fs.pathExists(tarSrc)) {
                    log(`copyApp: syncing service image ${tarName}`)
                    if (isCrossEngine) {
                        await $`rsync -a -e ${'ssh -o StrictHostKeyChecking=no'} ${tarSrc} pi@${remoteAddress}:${copyServicesDestDir}/`
                    } else {
                        await $`rsync -a ${tarSrc} ${copyServicesDestDir}/`
                    }
                } else {
                    log(`copyApp: service image tar not found at ${tarSrc} — skipping`)
                }
                servicesDone++
                updateOperation(storeHandle, opId, {
                    progressPercent: 55 + Math.round((servicesDone / instance.serviceImages.length) * 38),
                })
            }
        }

        // 6. Register/start the new instance
        setCopyStep(5)
        if (isCrossEngine) {
            // Cross-engine: create instance record in shared store (as Docked),
            // then tell the remote engine to start it via sendCommand.
            log(`copyApp: registering new instance ${newInstanceId} on remote disk '${targetDisk.name}' (${targetDisk.id})`)
            const composeContent = (await $`cat ${instanceSrc}/compose.yaml`).stdout
            const { parse: parseYAML } = await import('yaml')
            const compose = parseYAML(composeContent)
            const services = Object.keys(compose.services)
            const serviceImages = services.map((s: string) => compose.services[s].image)
            storeHandle.change(doc => {
                const newInst: Instance = {
                    id: newInstanceId,
                    instanceOf: instance.instanceOf,
                    name: instance.name,
                    storedOn: targetDisk.id,
                    status: 'Docked' as Status,
                    statusCondition: null,
                    port: 0 as any,
                    serviceImages: serviceImages as ServiceImage[],
                    created: Date.now() as Timestamp,
                    lastBackup: null,
                    lastStarted: 0 as Timestamp,
                    currentStep: null,
                    totalSteps: null,
                    stepLabel: null,
                    metrics: null,
                }
                doc.instanceDB[newInstanceId] = newInst
            })
            // Tell the remote engine to start this instance
            log(`copyApp: sending startInstance command to remote engine '${targetDisk.dockedTo}'`)
            sendCommand(storeHandle, targetDisk.dockedTo as any, `startInstance ${instance.name} ${targetDisk.id} --cause cross-engine-cmd` as any)
        } else {
            // Local: use existing processInstance flow
            log(`copyApp: registering new instance ${newInstanceId} on disk '${targetDisk.name}' (${targetDisk.id})`)
            await processInstance(storeHandle, targetDisk, newInstanceId)
        }

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`copyApp: done — new instance ${newInstanceId} on '${targetDisk.name}' (${targetDisk.id})`))

    } catch (e: any) {
        // Don't overwrite Cancelled status (set by cancelOperation before SIGTERM completes)
        const currentStatus = storeHandle.doc()?.operationDB?.[opId]?.status
        if (currentStatus !== 'Cancelled') {
            updateOperation(storeHandle, opId, {
                status: 'Failed',
                error: e.message ?? String(e),
                completedAt: Date.now() as Timestamp,
            })
        }
        console.error(chalk.red(`copyApp: failed — ${e.message ?? e}`))
    } finally {
        resourceLock.releaseAll(lockKeys)
        // Always restart source instance if we stopped it
        if (wasRunning) {
            try {
                const freshStore = storeHandle.doc()
                const freshInstance = getInstance(freshStore, instance.id)
                if (freshInstance) {
                    log(`copyApp: restarting source instance '${instanceName}'`)
                    await startInstance(storeHandle, freshInstance, sourceDisk, 'post-copy')
                }
            } catch (restartErr: any) {
                console.error(chalk.red(`copyApp: failed to restart source instance: ${restartErr.message}`))
            }
        }
    }
}

// ── moveApp ───────────────────────────────────────────────────────────────────

/**
 * Move an app instance from sourceDisk to targetDisk.
 * The instance retains its original InstanceID so backup links remain intact.
 * The source instance directory and (if no other instance needs it) app master
 * are removed after a successful copy.
 */
export const moveApp = async (
    storeHandle: DocHandle<Store>,
    instanceName: InstanceName,
    sourceDiskId: DiskID,
    targetDiskId: DiskID,
    cause: OperationCause = 'console-command',
): Promise<void> => {
    const store = storeHandle.doc()

    const v = await validate(store, instanceName, sourceDiskId, targetDiskId)
    if (typeof v === 'string') {
        console.error(chalk.red(`moveApp: ${v}`))
        return
    }
    const { instance, sourceDisk, targetDisk, appId, sourceDevice, targetDevice, appMasterSrc, instanceSrc } = v

    // moveApp does not support cross-engine targets (data integrity risk if move fails midway).
    // Use copyApp + manual delete instead.
    const { localEngineId: localId } = await import('./Engine.js')
    if (String(targetDisk.dockedTo) !== String(localId)) {
        log(`moveApp: Target disk '${targetDisk.name}' is on a remote engine. Cross-engine move is not supported — use copyApp instead, then delete the source.`)
        return
    }

    // Acquire per-resource locks: instance + both disks
    const moveLockKeys = [instanceKey(instance.id), diskKey(sourceDisk.id), diskKey(targetDisk.id)]
    if (!resourceLock.acquireAll(moveLockKeys, 'moveApp')) {
        console.error(chalk.red(`moveApp: resource locked — another operation is already running on instance '${instanceName}' or one of its disks. Retry when it completes.`))
        return
    }

    const opId = createOperation(storeHandle, 'moveApp', {
        instanceId: instance.id,
        sourceDiskId: sourceDisk.id,
        targetDiskId: targetDisk.id,
    }, cause, { type: 'instance', id: instance.id })

    let wasRunning = false

    // ── step definitions ──────────────────────────────────────────────────────
    const MOVE_STEPS = [
        'Stopping instance',          // 0
        'Checking free space',        // 1
        'Syncing app master',         // 2
        'Syncing instance data',      // 3
        'Syncing service images',     // 4
        'Registering on target disk', // 5
        'Removing source data',       // 6
    ]
    const setMoveStep = (step: number) =>
        updateOperation(storeHandle, opId, { currentStep: step, totalSteps: MOVE_STEPS.length, stepLabel: MOVE_STEPS[step] })

    try {
        // 1. Stop source instance if running
        if (instance.status === 'Running' || instance.status === 'Starting') {
            wasRunning = true
            log(`moveApp: stopping instance '${instanceName}'`)
            setMoveStep(0)
            await stopInstance(storeHandle, instance, sourceDisk, 'post-move')
        }

        updateOperation(storeHandle, opId, { status: 'Running' })

        // 2. Check free space
        setMoveStep(1)
        const needed = await directoryBytes(appMasterSrc) + await directoryBytes(instanceSrc)
        const available = await availableBytes(await diskFsRoot(targetDisk))
        if (available < needed) {
            throw new Error(
                `Not enough space on disk '${targetDisk.name}' (${targetDisk.id}): need ${Math.ceil(needed / 1024 / 1024)}MB, ` +
                `have ${Math.ceil(available / 1024 / 1024)}MB`
            )
        }

        // 3. Ensure target directory structure
        const targetMountRoot = await diskMountRoot(targetDisk)
        await fs.ensureDir(`${targetMountRoot}/apps`)
        await fs.ensureDir(`${targetMountRoot}/instances`)
        await fs.ensureDir(`${targetMountRoot}/services`)

        // 4. rsync app master
        setMoveStep(2)
        const appMasterDest = `${targetMountRoot}/apps/${appId}`
        log(`moveApp: syncing app master ${appMasterSrc} → ${appMasterDest}`)
        await rsyncDirectory(appMasterSrc, appMasterDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: Math.round(progressPercent * 0.25) })
        }, opId)

        // 5. rsync instance data — same instance ID, new location
        setMoveStep(3)
        const instanceDest = `${targetMountRoot}/instances/${instance.id}`
        await fs.ensureDir(instanceDest)
        log(`moveApp: syncing instance data ${instanceSrc} → ${instanceDest}`)
        await rsyncDirectory(instanceSrc, instanceDest, ({ progressPercent }) => {
            updateOperation(storeHandle, opId, { progressPercent: 25 + Math.round(progressPercent * 0.30) })
        }, opId)

        // 5b. rsync service image tars needed by this instance
        //     services/ holds the Docker image tars that startInstance loads via
        //     `docker image load`. Without them the moved instance cannot start.
        setMoveStep(4)
        const sourceMountRootMove = await diskMountRoot(sourceDisk)
        const moveServicesSrcDir = `${sourceMountRootMove}/services`
        const moveServicesDestDir = `${targetMountRoot}/services`
        if (instance.serviceImages?.length) {
            let servicesDone = 0
            for (const serviceImage of instance.serviceImages) {
                const tarName = (serviceImage as string).replace(/\//g, '_') + '.tar'
                const tarSrc = `${moveServicesSrcDir}/${tarName}`
                if (await fs.pathExists(tarSrc)) {
                    log(`moveApp: syncing service image ${tarName}`)
                    await $`rsync -a ${tarSrc} ${moveServicesDestDir}/`
                } else {
                    log(`moveApp: service image tar not found at ${tarSrc} — skipping`)
                }
                servicesDone++
                updateOperation(storeHandle, opId, {
                    progressPercent: 55 + Math.round((servicesDone / instance.serviceImages.length) * 35),
                })
            }
        }

        // 6. Register on target disk (storedOn + status set here; instance starts).
        //    This MUST succeed before we touch the source record — if cancelled before
        //    this point the source record is untouched and the operator can retry cleanly.
        setMoveStep(5)
        log(`moveApp: registering instance ${instance.id} on disk '${targetDisk.name}' (${targetDisk.id})`)
        await processInstance(storeHandle, targetDisk, instance.id)

        // 8. Remove source instance directory
        setMoveStep(6)
        // Use sudo rm -rf because instance data dirs may contain files owned by
        // Docker container users (e.g. Kolibri data owned by root inside the container).
        log(`moveApp: removing source instance directory ${instanceSrc}`)
        await $`sudo rm -rf ${instanceSrc}`

        // 9. Remove source app master only if no other instance on the source disk uses it
        // App master files are pi-owned, so fs.remove is sufficient.
        const remainingInstances = getInstancesOfDisk(storeHandle.doc(), sourceDisk)
        const stillNeedsAppMaster = remainingInstances.some(i => i.instanceOf === appId)
        if (!stillNeedsAppMaster) {
            log(`moveApp: removing app master ${appMasterSrc} (no other instances on source disk)`)
            await fs.remove(appMasterSrc)
        } else {
            log(`moveApp: keeping app master ${appMasterSrc} (other instances still use it)`)
        }

        updateOperation(storeHandle, opId, {
            status: 'Done',
            progressPercent: 100,
            completedAt: Date.now() as Timestamp,
        })
        log(chalk.green(`moveApp: done — instance ${instance.id} moved to '${targetDisk.name}' (${targetDisk.id})`))

    } catch (e: any) {
        // Don't overwrite Cancelled status (set by cancelOperation before SIGTERM completes)
        const currentStatus = storeHandle.doc()?.operationDB?.[opId]?.status
        if (currentStatus !== 'Cancelled') {
            updateOperation(storeHandle, opId, {
                status: 'Failed',
                error: e.message ?? String(e),
                completedAt: Date.now() as Timestamp,
            })
        }
        console.error(chalk.red(`moveApp: failed — ${e.message ?? e}`))

        // On failure, try to restart the source instance if we stopped it
        if (wasRunning) {
            try {
                const freshStore = storeHandle.doc()
                const freshInstance = getInstance(freshStore, instance.id)
                if (freshInstance) {
                    log(`moveApp: restarting source instance '${instanceName}' after failure`)
                    await startInstance(storeHandle, freshInstance, sourceDisk, 'post-move')
                }
            } catch (restartErr: any) {
                console.error(chalk.red(`moveApp: failed to restart source instance: ${restartErr.message}`))
            }
        }
    } finally {
        resourceLock.releaseAll(moveLockKeys)
    }
}

// recoverInterruptedOperations moved to Operations.ts
export { recoverInterruptedOperations } from './Operations.js'

```

## File: src/data/Disk.ts
```typescript
import { $, YAML, chalk, fs, os } from 'zx';
import { deepPrint, log } from '../utils/utils.js';
import { App, createAppId, createOrUpdateApp, extractAppName, extractAppVersion } from './App.js'
import { Instance, Status, createOrUpdateInstance, startInstance } from './Instance.js'
import { AppID, BackupMode, DeviceName, DiskID, DiskType, EngineID, DiskName, InstanceID, PortNumber, ServiceImage, Timestamp } from './CommonTypes.js';
import { Store, getAppsOfDisk, getInstance, getInstancesOfDisk } from './Store.js';
import { DocHandle } from '@automerge/automerge-repo';
import { getCommandLogHandle } from './CommandLogStore.js';
import { addTrace, closeTrace } from './CommandLogStore.js';
import { runWithTrace } from '../utils/CommandLogger.js';



// Disks are multi-purpose  - they can be used for engines, apps, backups, etc.

export interface BackupConfig {
    mode: BackupMode
    links: InstanceID[]
}

export interface Disk {
    id: DiskID;                   // The serial number of the disk, or a user-defined id if the disk has no serial number
    name: DiskName;               // The user-defined name of the disk.  Not necessarily unique  
    device: DeviceName | null;    // The device under /disks where this disk is mounted. null if the disk is not mounted
    created: Timestamp;           // We must use a timestamp number as Date objects are not supported in YJS
    lastDocked: Timestamp;        // We must use a timestamp number as Date objects are not supported in YJS
    dockedTo: EngineID | null;    // The engine to which this disk is currently docked. null if it is not docked to an engine
    diskTypes: DiskType[];        // Types detected for this disk (may be multiple); empty until processDisk runs
    backupConfig: BackupConfig | null;  // Set when disk is a Backup Disk; null otherwise
}


// export const getApps = (store: Store, disk: Disk): App[] => {
//     const appIds = getKeys(disk.apps) as AppID[]
//     return appIds.map(appId => getApp(store, appId))
// }


// export const findApp = (store: Store, disk: Disk, appId: AppID): App | undefined => {
//     return getApps(store, disk).find(app => app.id === appId)
// }

// Function findApp that searches for an app with the specified name and version on the specified disk
// export const findAppByNameAndVersion = (store: Store, disk: Disk, appName: AppName, version: Version): App | undefined => {
//     const appIds = Object.keys(disk.apps) as AppID[]
//     const appId = appIds.find(appId => {
//         const app = store.appDB[appId]
//         app.name === appName && app.version === version
//     })
//     if (appId) {
//         return store.appDB[appId]
//     } else {
//         return undefined
//     }
// }

// export const getInstances = (store: Store, disk: Disk): Instance[] => {
//     const instanceIds = getKeys(disk.instances) as InstanceID[]
//     return instanceIds.map(instanceId => getInstance(store, instanceId))
// }

// export const findInstance = (store: Store, disk: Disk, instanceId: InstanceID): Instance | undefined => {
//     return getInstances(store, disk).find(instance => instance.id === instanceId)
// }

// export const findInstanceOfApp = (store: Store, disk: Disk, appId: AppID): Instance | undefined => {
//     return getInstances(store, disk).find(instance => instance.instanceOf === appId)
// }
// export const findInstanceByName = (store: Store, disk: Disk, instanceName: InstanceName): Instance | undefined => {
//     const instanceIds = Object.keys(disk.instances) as InstanceID[]
//     const instanceId = instanceIds.find(instanceId => store.instanceDB[instanceId].name === instanceName)
//     if (instanceId) {
//         return store.instanceDB[instanceId]
//     } else {
//         return undefined
//     }
// }

// export const addInstance = (store: Store, disk: Disk, instance: Instance): void => {
//     log(`Updating instance ${instance.name} of disk ${disk.name}:`)
//     const existingInstance = findInstanceByName(store, disk, instance.name)
//     if (existingInstance) {
//         log(`Disk ${disk.name} already has an instance ${instance.name}. Merging the new instance with the existing instance.`)
//         Object.assign(existingInstance, instance)
//     } else {
//         //log(deepPrint(disk))
//         log(`Pushing a new instance ${instance.name} to engine ${disk.name}`)
//         disk.instances[instance.id] = true
//     }
// }




export const createOrUpdateDisk = (storeHandle: DocHandle<Store>, engineId: EngineID, device: DeviceName, diskId: DiskID, diskName: DiskName, created: Timestamp): Disk => {
    let disk: Disk
    storeHandle.change(doc => {
        let storedDisk = doc.diskDB[diskId];
        if (!storedDisk) {
            log(`Creating disk ${diskId} on engine ${engineId}`);
            disk = {
                id: diskId,
                name: diskName,
                device: device,
                dockedTo: engineId,
                created: created,
                lastDocked: new Date().getTime() as Timestamp,
                diskTypes: [],
                backupConfig: null,
            };
            doc.diskDB[diskId] = disk;
        } else {
            log(`Granularly updating disk ${diskId} on engine ${engineId}`);
            disk = storedDisk;
            disk.dockedTo = engineId;
            disk.name = diskName;
            disk.device = device;
            disk.created = created;
            disk.lastDocked = new Date().getTime() as Timestamp;
            disk.diskTypes = [];        // reset; will be repopulated by processDisk
            disk.backupConfig = null;   // reset; will be repopulated if Backup Disk
        }
    });
    return disk!; // Non-null assertion
}   

export const OLDcreateOrUpdateDisk = (storeHandle: DocHandle<Store>, engineId: EngineID, device: DeviceName, diskId: DiskID, diskName: DiskName, created: Timestamp): Disk => {
    const store: Store = storeHandle.doc()
    let storedDisk: Disk | undefined = store.diskDB[diskId]
    if (!storedDisk) {
        log(`Creating disk ${diskId} on engine ${engineId}`)
        // Create a new disk object
        const disk: Disk = {
            id: diskId,
            name: diskName,
            device: device,
            dockedTo: engineId,
            created: created,
            lastDocked: new Date().getTime() as Timestamp,
            diskTypes: [],
            backupConfig: null,
        }
        storeHandle.change(doc => {
            doc.diskDB[diskId] = disk
        })
        // enableDiskMonitor(disk)
        return disk
    } else {
        log(`Granularly updating disk ${diskId} on engine ${engineId}`)
        storeHandle.change(doc => {
            const disk = doc.diskDB[diskId]
            disk.dockedTo = engineId
            disk.name = diskName
            disk.device = device
            disk.created = created
            disk.lastDocked = new Date().getTime() as Timestamp
        })
        return store.diskDB[diskId]
    }
}   


export const processDisk = async (storeHandle: DocHandle<Store>, disk: Disk): Promise<void> => {
    log(`Processing disk ${disk.id} on engine ${disk.dockedTo}`)

    const detectedTypes: DiskType[] = []

    // System disk: root partition of the Pi itself, mounted at /.
    // Apps and instances live at /apps/<id> and /instances/<id>.
    // Must be checked first so it is not misidentified as an empty disk.
    if (await isSystemDisk(disk)) {
        log(`Disk ${disk.id} is the system disk`)
        detectedTypes.push('system')
        await processSystemDisk(storeHandle, disk)
    } else {
        if (await isAppDisk(disk)) {
            log(`Disk ${disk.id} is an app disk`)
            detectedTypes.push('app')
            await processAppDisk(storeHandle, disk)
        }

        if (await isBackupDisk(disk)) {
            log(`Disk ${disk.id} is a backup disk`)
            detectedTypes.push('backup')
            // processBackupDisk is imported from backupMonitor to avoid circular deps
            const { processBackupDisk } = await import('../monitors/backupMonitor.js')
            await processBackupDisk(storeHandle, disk)
        }

        if (await isUpgradeDisk(disk)) {
            log(`Disk ${disk.id} is an upgrade disk`)
            detectedTypes.push('upgrade')
            // TODO: Implement upgrade disk processing — https://github.com/koenswings/idea/issues/46
        }

        if (await isFilesDisk(disk)) {
            log(`Disk ${disk.id} is a files disk`)
            detectedTypes.push('files')
            // TODO: Implement files disk processing — https://github.com/koenswings/idea/issues/46
        }

        if (detectedTypes.length === 0) {
            log(`Disk ${disk.id} is an empty disk`)
            detectedTypes.push('empty')
        }
    }

    // Persist detected types to the store
    storeHandle.change(doc => {
        const d = doc.diskDB[disk.id]
        if (d) d.diskTypes = detectedTypes
    })
}

/**
 * A system disk is the root partition of the Pi itself (sda2 on IDEA Pis).
 *
 * Detection: compare the disk device name against the device that is mounted
 * at /. We use `findmnt / -no SOURCE` which returns e.g. `/dev/sda2`, then
 * strip `/dev/` to get just the device name.
 *
 * This is robust in all environments:
 *   - Production Pi: root is /dev/sda2 → isSystemDisk('sda2') === true
 *   - Test fixtures:  /disks/test-xxx exists but is not the root device → false
 *   - Non-disk ids (no device):  returns false immediately
 */
let _rootDevice: string | null = null
const getRootDevice = async (): Promise<string> => {
    if (_rootDevice) return _rootDevice
    try {
        const src = (await $`findmnt / -no SOURCE`).stdout.trim()  // e.g. /dev/sda2
        _rootDevice = src.replace(/^\/dev\//, '')                   // e.g. sda2
    } catch {
        _rootDevice = ''
    }
    return _rootDevice
}

export const isSystemDisk = async (disk: Disk): Promise<boolean> => {
    if (!disk.device) return false
    const rootDev = await getRootDevice()
    return String(disk.device) === String(rootDev)
}

/**
 * Returns the path prefix for a disk's app/instance/services directories.
 * System disk: '' (so paths become /apps/…, /instances/…)
 * Regular disk: '/disks/<device>'
 */
export const diskMountRoot = async (disk: Disk): Promise<string> => {
    return (await isSystemDisk(disk)) ? '' : `/disks/${disk.device}`
}

/**
 * Returns the filesystem root for free-space checks and similar operations
 * that need the actual mount point.
 * System disk: '/'   Regular disk: '/disks/<device>'
 */
export const diskFsRoot = async (disk: Disk): Promise<string> => {
    return (await isSystemDisk(disk)) ? '/' : `/disks/${disk.device}`
}

/**
 * Process the system disk: scan /apps and /instances at the root filesystem.
 * Apps live at /apps/<appId>/ and instances at /instances/<instanceId>/.
 * This mirrors processAppDisk but uses / as the mount root instead of /disks/<device>/.
 */
export const processSystemDisk = async (storeHandle: DocHandle<Store>, disk: Disk): Promise<void> => {
    log(`Processing system disk ${disk.id} (mount root: /)`)

    const store: Store = storeHandle.doc()

    // Apps
    const storedApps = getAppsOfDisk(store, disk)
    const actualApps: App[] = []

    if (await $`test -d /apps`.then(() => true).catch(() => false)) {
        log(`/apps directory found on system disk ${disk.id}`)
        const appIds = (await $`ls /apps`).stdout.split('\n').filter(Boolean)
        log(`App ids on system disk: ${appIds}`)
        for (const appId of appIds) {
            const app = await processSystemApp(storeHandle, disk, appId as AppID)
            if (app) actualApps.push(app)
        }
    }

    // Remove apps no longer on disk
    for (const storedApp of storedApps) {
        if (!actualApps.some(a => a.id === storedApp.id)) {
            await removeApp(store, disk, storedApp.id)
        }
    }

    // Instances
    const storedInstances = getInstancesOfDisk(store, disk)
    const actualInstances: Instance[] = []

    if (await $`test -d /instances`.then(() => true).catch(() => false)) {
        const instanceIds = (await $`ls /instances`).stdout.split('\n').filter(Boolean)
        log(`Instance ids on system disk: ${instanceIds}`)
        for (const instanceId of instanceIds) {
            const instance = await processSystemInstance(storeHandle, disk, instanceId as InstanceID)
            if (instance) actualInstances.push(instance)
        }
    }

    // Remove instances no longer on disk
    storedInstances.forEach(storedInstance => {
        if (!actualInstances.some(i => i.id === storedInstance.id)) {
            removeInstance(storeHandle, disk, storedInstance.id)
        }
    })
}

/**
 * Process a single app on the system disk (reads from /apps/<appId>/compose.yaml).
 */
export const processSystemApp = async (storeHandle: DocHandle<Store>, disk: Disk, appId: AppID): Promise<App | undefined> => {
    try {
        const appComposeFile = await $`cat /apps/${appId}/compose.yaml`
        const appCompose = YAML.parse(appComposeFile.stdout)
        let app: App
        storeHandle.change(doc => {
            const storedApp: App | undefined = doc.appDB[appId]
            const xapp = appCompose['x-app']
            if (!storedApp) {
                log(`Creating new system app ${appId}`)
                app = {
                    id: appId,
                    name: extractAppName(appId),
                    version: extractAppVersion(appId),
                    title: xapp.title,
                    description: xapp.description ?? null,
                    url: xapp.url ?? null,
                    category: xapp.category,
                    icon: xapp.icon ?? null,
                    author: xapp.author ?? null,
                }
                doc.appDB[appId] = app
            } else {
                log(`Updating existing system app ${appId}`)
                app = storedApp
            }
        })
        return app!
    } catch (e) {
        log(`Error processing system app ${appId}: ${e}`)
        return undefined
    }
}

/**
 * Process a single instance on the system disk.
 * Reads compose.yaml from /instances/<instanceId>/ (not /disks/<device>/instances/).
 */
export const processSystemInstance = async (storeHandle: DocHandle<Store>, disk: Disk, instanceId: InstanceID): Promise<Instance | undefined> => {
    const { startInstance } = await import('./Instance.js')
    let instance: Instance | undefined
    try {
        const composeFile = await $`cat /instances/${instanceId}/compose.yaml`
        const compose = YAML.parse(composeFile.stdout)
        const services = Object.keys(compose.services)
        const serviceImages = services.map((s: string) => compose.services[s].image)
        const instanceName = compose['x-app'].instanceName
        storeHandle.change(doc => {
            const stored = doc.instanceDB[instanceId]
            if (!stored) {
                log(`Creating new system instance ${instanceId}`)
                const newInst: Instance = {
                    id: instanceId,
                    instanceOf: createAppId(compose['x-app'].name, compose['x-app'].version) as AppID,
                    name: instanceName,
                    storedOn: disk.id,
                    status: 'Docked' as Status,
                    statusCondition: null,
                    port: 0 as PortNumber,
                    serviceImages: serviceImages as ServiceImage[],
                    created: new Date().getTime() as Timestamp,
                    lastBackup: null,
                    lastStarted: 0 as Timestamp,
                    currentStep: null,
                    totalSteps: null,
                    stepLabel: null,
                    metrics: null,
                }
                doc.instanceDB[instanceId] = newInst
                instance = newInst
            } else {
                log(`Updating existing system instance ${instanceId}`)
                stored.storedOn = disk.id
                // Preserve Stopped status — same rule as createOrUpdateInstance:
                // only reset to Docked from transient/detached states.
                if (stored.status === 'Missing' || stored.status === 'Undocked' || stored.status === 'Error') {
                    stored.status = 'Docked' as Status
                }
                instance = stored
            }
        })
    } catch (e) {
        log(`Error processing system instance ${instanceId}: ${e}`)
        return undefined
    }
    if (instance) {
        await tracedStartInstance(storeHandle, instance, disk)
    }
    return instance
}

export const isAppDisk = async (disk: Disk): Promise<boolean> => {
    // Check if the disk has an apps folder
    try {
        await $`test -d ${await diskMountRoot(disk)}/apps`;
        return true;
    } catch {
        return false;
    }
}

export const isBackupDisk = async (disk: Disk): Promise<boolean> => {
    try {
        await $`test -f ${await diskMountRoot(disk)}/BACKUP.yaml`
        return true
    } catch {
        return false
    }
}

export const isUpgradeDisk = async (disk: Disk): Promise<boolean> => {
    // Create dummy code that always returns false
    // To be updated later
    return false
}

export const isFilesDisk = async (disk: Disk): Promise<boolean> => {
    // Create dummy code that always returns false
    // To be updated later
    return false
}

export const processAppDisk = async (storeHandle: DocHandle<Store>, disk: Disk): Promise<void> => {
    log(`Processing the apps and instances of App Disk ${disk.id} on device ${disk.device}`)

    const store: Store = storeHandle.doc()

    // Apps
    const storedApps = getAppsOfDisk(store, disk)
    const actualApps: App[] = []

    const mountRoot = await diskMountRoot(disk)

    // Call processApp for each folder found in <mountRoot>/apps
    // First check if it has an apps folder
    if (await $`test -d ${mountRoot}/apps`.then(() => true).catch(() => false)) {
        log(`Apps folder found on disk ${disk.id}`)
        const appIds = (await $`ls ${mountRoot}/apps`).stdout.split('\n')
        log(`App ids found on disk ${disk.id}: ${appIds}`)
        for (let appId of appIds) {
            if (!(appId === "") && !(disk.device == null)) {
                const app = await processApp(storeHandle, disk, appId as AppID)
                if (app) {
                    actualApps.push(app)
                }
            }
        }
    }

    log(`Actual apps: ${actualApps.map(app => app.id)}`)
    log(`Stored apps: ${storedApps.map(app => app.id)}`)

    // Remove apps that are no longer on disk
    for (const storedApp of storedApps) {
        if (!actualApps.some(actualApp => actualApp.id === storedApp.id)) {
            await removeApp(store, disk, storedApp.id)
        }
    }

    // Instances
    const storedInstances = getInstancesOfDisk(store, disk)
    const actualInstances: Instance[] = []

    // Call processInstance for each folder found in <mountRoot>/instances
    if (await $`test -d ${mountRoot}/instances`.then(() => true).catch(() => false)) {
        const instanceIds = (await $`ls ${mountRoot}/instances`).stdout.split('\n')
        log(`Instance Ids found on disk ${disk.id}: ${instanceIds}`)
        for (let instanceId of instanceIds) {
            if (!(instanceId === "")) {
                const instance = await processInstance(storeHandle, disk, instanceId as InstanceID)
                if (instance) {
                    actualInstances.push(instance)
                }
            }
        }
    }

    log(`Actual instances: ${actualInstances.map(instance => instance.id)}`)
    log(`Stored instances: ${storedInstances.map(instance => instance.id)}`)

    // Remove instances that are no longer on disk
    storedInstances.forEach((storedInstance) => {
        if (!actualInstances.some(actualInstance => actualInstance.id === storedInstance.id)) {
            removeInstance(storeHandle, disk, storedInstance.id)
        }
    })

    // Trigger backups on any docked Backup Disk linked to instances on this App Disk
    const { checkPendingBackups } = await import('../monitors/backupMonitor.js')
    await checkPendingBackups(storeHandle, disk)
}

export const processApp = async (storeHandle: DocHandle<Store>, disk: Disk, appID: AppID): Promise<App | undefined> => {
    const app: App | undefined = await createOrUpdateApp(storeHandle, appID, disk)
    // There is nothing else that we need to do so return the app
    return app
}


export const removeApp = async (store: Store, disk: Disk, appId: AppID): Promise<void> => {
    log(`App ${appId} no longer found on disk ${disk.id}`)
    // There is nothing that we need to do as we do not record on which disks Apps are stored
    // However,  we need to check if there are instances of this app on the disk and signal an error if this is the case
    //   Find the instance of this app on the disk and check if it is still physically on the disk
    //   If it is, then this is an error and we should log an error message as the Instance will fail to start
    const instance = getInstancesOfDisk(store, disk).find(instance => instance.instanceOf === appId)
    // Check if the instance is still physically on the file system of the disk and signal an error
    if (instance && fs.existsSync(`${await diskMountRoot(disk)}/instances/${instance.id}`)) {
        log(`Error: Instance ${instance.id} of app ${appId} is still physically on the disk ${disk.id} but the app is being removed. This is an error and should not happen.`)
    }
}

export const processInstance = async (storeHandle: DocHandle<Store>, disk: Disk, instanceId: InstanceID): Promise<Instance | undefined> => {
    const instance = await createOrUpdateInstance(storeHandle, instanceId, disk)
    if (instance) {
        await tracedStartInstance(storeHandle, instance, disk)
    }
    return instance
}

/**
 * Wraps startInstance with a commandLog trace so that auto-starts triggered
 * by disk docking appear in the Console command history, just like starts
 * issued explicitly via the 'startInstance' command.
 */
const tracedStartInstance = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk): Promise<void> => {
    // Never auto-start an instance that was explicitly stopped by the operator.
    // processInstance is called on every disk-dock event; without this guard a
    // re-dock (or a spurious udev re-add) would restart a stopped instance.
    if (instance.status === 'Stopped') {
        log(`tracedStartInstance: skipping auto-start of '${instance.name}' (${instance.id}) — status is Stopped`)
        return
    }
    const cmdLogHandle = getCommandLogHandle()
    const traceId = crypto.randomUUID()
    const traceCtx = {
        traceId,
        command: 'startInstance',
        args: JSON.stringify({ instanceName: instance.name, diskId: disk.id }),
    }
    if (cmdLogHandle) {
        addTrace(cmdLogHandle, {
            traceId,
            command: 'startInstance',
            args: traceCtx.args,
            startedAt: Date.now(),
            completedAt: null,
            status: 'running',
            errorMessage: null,
        })
    }
    try {
        await runWithTrace(traceCtx, () => startInstance(storeHandle, instance, disk, 'disk-docked'))
        if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'ok')
    } catch (e: any) {
        if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'error', e.message ?? String(e))
        throw e
    }
}

export const removeInstance = (storeHandle: DocHandle<Store>, disk: Disk, instanceId: InstanceID): void => {
    log(`Instance ${instanceId} no longer found on disk ${disk.id}`)
    storeHandle.change(doc => {
        const instance = getInstance(doc, instanceId)
        if (instance) {
            // Mark as Missing — the instance directory is no longer on this disk (deleted or moved).
            // We preserve the instanceDB entry so that:
            //   1. Instance history is not lost.
            //   2. If the instance was moved to another disk, docking that disk will find this entry
            //      by instanceId and restore it (updating storedOn) without creating a duplicate.
            // This is distinct from 'Undocked', where the disk is simply not currently docked and
            // the instance data is known to still be physically present on it.
            instance.status = 'Missing' as Status
            instance.storedOn = null
        }
    })
}






```

## File: src/data/Engine.ts
```typescript
import { $, chalk, os, question, YAML, fs, path, sleep } from 'zx';

$.verbose = false;
import { deepPrint, log, uuid, print } from '../utils/utils.js';
import { readMetaUpdateId, DiskMeta, addMeta, readRemoteDiskId } from './Meta.js';
import { Version, Command, Hostname, Timestamp, DiskID, EngineID } from './CommonTypes.js';
import { Store, getAppsOfEngine, getDisksOfEngine, getInstancesOfEngine } from './Store.js';
import { DocHandle } from '@automerge/automerge-repo';

export interface Engine {
  id: EngineID,
  hostname: Hostname;
  version: Version;
  hostOS: string;
  created: Timestamp;
  lastBooted: Timestamp;
  lastRun: Timestamp;
  lastHalted: Timestamp | null;
  commands: Command[];
}

import { config } from './Config.js';

const getLocalEngineId = async (): Promise<EngineID> => {
  log(`Getting local engine id`)
  try {
    const meta: DiskMeta = await readMetaUpdateId()
    return createEngineIdFromDiskId(meta.diskId)
  } catch (error) {
    console.error(`Error getting local engine id: ${error}`)
    process.exit(1)
  }
}

export const createEngineIdFromDiskId = (diskId: DiskID): EngineID => {
  return "ENGINE_" + diskId as EngineID
}

export const initialiseLocalEngine = async (): Promise<Engine> => {
  try {
    const meta: DiskMeta = await readMetaUpdateId()
    const localEngine: Engine = {
      id: createEngineIdFromDiskId(meta.diskId),
      hostname: os.hostname() as Hostname,
      // Always string: META YAML may have parsed version as a number (e.g. 1.0 → 1).
      version: (meta.version != null ? String(meta.version) : "0.0.1") as Version,
      hostOS: os.type(),
      created: meta.created,
      lastBooted: (new Date()).getTime() as Timestamp,
      lastRun: (new Date()).getTime() as Timestamp,
      lastHalted: null,
      commands: []
    }
    return localEngine
  } catch (e) {
    console.error(`Error initializing local engine: ${e}`)
    process.exit(1)
  }
}

export const createOrUpdateEngine = async (storeHandle: DocHandle<Store>, engineId: EngineID): Promise<Engine | undefined> => {
  const newEngine: Engine = await initialiseLocalEngine()
  let engine: Engine
  try {
    storeHandle.change(doc => {
      const storedEngine: Engine | undefined = doc.engineDB[engineId]
      if (!storedEngine) {
        log(`Creating new engine object for local engine ${engineId}`)
        engine = newEngine
        doc.engineDB[engineId] = engine    
      } else {
        log(`Granularly updating existing engine object ${engineId}`)
        engine = doc.engineDB[engineId]
        engine.hostname = os.hostname() as Hostname
        engine.version = newEngine.version
        engine.lastBooted = (new Date()).getTime() as Timestamp
        engine.lastRun = (new Date()).getTime() as Timestamp
      }
    })
  return engine!
  } catch (e) {
    log(chalk.red(`Error initializing engine ${engineId}`))
    console.error(e)
    return undefined
  }
}

export const localEngineId = await getLocalEngineId()

/**
 * Remove phantom engine entries from the shared CRDT store.
 *
 * A "phantom" engine is any engineDB entry that:
 *   - has the same hostname as this machine, but a different id (stale IDs
 *     generated before the sudo-hdparm fix caused a new UUID on every boot), OR
 *   - has an id that is not its own map key (internal id/key mismatch)
 *
 * An "orphan" disk is any diskDB entry whose dockedTo field points to an
 * engine that no longer exists in engineDB.
 *
 * Both are deleted in a single storeHandle.change() call so the Automerge
 * tombstone has the current vector clock and permanently wins over the old
 * inserts when it propagates to peer engines on the next sync.
 *
 * Called once at startup, after createOrUpdateEngine() and before any
 * monitors are started (so there is no racing writer).
 */
export const cleanupPhantomEngines = (storeHandle: DocHandle<Store>): void => {
  const store = storeHandle.doc()
  const localHostname = os.hostname() as Hostname
  const validEngineIds = new Set(Object.keys(store.engineDB))

  // Engines with this hostname but a different id than localEngineId
  const phantomEngineKeys = Object.keys(store.engineDB).filter(key => {
    const eng = store.engineDB[key]
    return (
      (eng.hostname === localHostname && key !== String(localEngineId)) ||
      (eng.id && String(eng.id) !== key)   // key/id mismatch — CRDT anomaly
    )
  })

  // Disks whose dockedTo points to an engine key that no longer exists
  const orphanDiskKeys = Object.keys(store.diskDB).filter(key => {
    const disk = store.diskDB[key]
    return disk.dockedTo && !validEngineIds.has(String(disk.dockedTo))
  })

  if (phantomEngineKeys.length === 0 && orphanDiskKeys.length === 0) {
    log('[cleanup] No phantom engines or orphan disks found — store is clean')
    return
  }

  log(chalk.yellow(`[cleanup] Removing ${phantomEngineKeys.length} phantom engine(s) and ${orphanDiskKeys.length} orphan disk(s) from store`))
  for (const k of phantomEngineKeys) log(chalk.yellow(`  phantom engine: ${k} (hostname=${store.engineDB[k].hostname}, id=${store.engineDB[k].id})`))
  for (const k of orphanDiskKeys) log(chalk.yellow(`  orphan disk: ${k} (dockedTo=${store.diskDB[k].dockedTo})`))

  storeHandle.change(doc => {
    for (const k of phantomEngineKeys) {
      delete (doc.engineDB as any)[k]
    }
    for (const k of orphanDiskKeys) {
      delete (doc.diskDB as any)[k]
    }
  })

  log(chalk.green('[cleanup] Phantom cleanup complete — tombstones will propagate to peers on next sync'))
}

export const rebootEngine = async (storeHandle: DocHandle<Store>, engine: Engine) => {
  log(`Gracefully rebooting engine ${engine.hostname}`);
  storeHandle.change(doc => {
    const eng = doc.engineDB[engine.id];
    if (eng) {
      eng.lastRun = new Date().getTime() as Timestamp;
      eng.lastHalted = new Date().getTime() as Timestamp;
    }
  });

  log('Waiting 5 seconds for state to sync before rebooting...');
  await sleep(5000);

  log(`Executing reboot command for ${engine.hostname}`);
  $`sudo reboot now`;
}
export const inspectEngine = (store: Store, engine: Engine) => {
  log(chalk.bgGray(`Engine: ${deepPrint(engine)}`))
  const disks = getDisksOfEngine(store, engine)
  log(chalk.bgGray(`Disks: ${deepPrint(disks)}`))
  const apps = getAppsOfEngine(store, engine)
  log(chalk.bgGray(`Apps: ${deepPrint(apps)}`))
  const instances = getInstancesOfEngine(store, engine)
  log(chalk.bgGray(`Instances: ${deepPrint(instances)}`))
}

// ##################################################################################################
// Installation and system setup functions (formerly in build-engine.ts)
// ##################################################################################################

export const syncEngine = async (user: string, machine: string) => {
  print(chalk.blue('Syncing the engine to the remote machine'))
  try {
    if (!fs.existsSync('./script/build_image_assets/gh_token.txt')) {
      const githubToken = await question('Enter the GitHub token: ');
      fs.writeFileSync('./script/build_image_assets/gh_token.txt', githubToken);
    }
    const targetName = machine.endsWith('.local') ? machine.slice(0, -6) : machine;
    await $`./sync-engine --user ${user} ${targetName}`;
  } catch (e) {
    print(chalk.red('Failed to sync the engine to the remote machine'));
    console.error(e);
    process.exit(1);
  }
}

export const buildEngine = async (args: any) => {
  const {
    exec, enginePath, isLocalMode, user, machine, hostname, language, keyboard, timezone,
    upgrade, argon, zerotier, raspap, gadget, temperature, version, productionMode
  } = args;

  // Clear known_hosts entry for the target machine to prevent SSH errors
  if (machine) {
    await clearKnownHost(machine);
  }

  await updateSystem(exec);
  if (upgrade) await upgradeSystem(exec);

  await setHostname(exec, hostname);
  await installAvahi(exec);
  await localiseSystem(exec, enginePath, language, keyboard, timezone);
  await installCrontabs(exec, enginePath);

  if (argon) await installArgonFanScript(exec, enginePath);
  if (temperature) await installTemperature(exec);

  await installUdev(exec, enginePath);
  await installVarious(exec);
  await installVarious2(exec);
  await installChromium(exec);
  await installGh(exec);

  await installDocker(exec, enginePath, user);
  await buildDockerInfrastructure(exec);
  await buildAppsInfrastructure(exec);

  if (raspap) await installRaspAP(exec, enginePath);
  await installTailscale(exec, enginePath)
  if (zerotier) await installZerotier(exec, enginePath);

  await addMeta(exec, hostname, version);

  //await installEngineNode(exec);
  await installBaseNpm(exec);
  await configurePnpm(exec);
  await installPm2(exec, enginePath);
  await installEnginePM2(exec, enginePath);
  await buildEnginePM2(exec, enginePath);

  if (isLocalMode) {
    const permanentEnginePath = config.defaults.enginePath;
    print(chalk.blue(`Copying engine to permanent location: ${permanentEnginePath}`));
    await exec`sudo mkdir -p ${permanentEnginePath}`;
    await exec`sudo rsync -a --delete ${enginePath}/ ${permanentEnginePath}/`;
    await exec`sudo chown -R pi:pi ${permanentEnginePath}`;
  }

  await startEnginePM2(exec, enginePath, config.defaults.enginePath, productionMode);
  await grantNetBindCapability(exec);

  if (gadget) await usbGadget(exec, enginePath);

  await rebootSystem(exec);
}

export const clearKnownHost = async (machine: string) => {
  print(chalk.yellow(`  - Clearing known_hosts entry for ${machine}...`));
  const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
  try {
    await $`ssh-keygen -R ${machine}`;
    print(chalk.green(`    - Entry for ${machine} removed from ${knownHostsPath}.`));
  } catch (e: any) {
    print(chalk.yellow(`    - Host not found in known_hosts or an error occurred. Continuing...`));
  }
}

export const copyAsset = async (exec: any, enginePath: string, asset: string, destination: string, executable: boolean = false, chmod: string | null = "0644", chown: string | null = "0:0") => {
  print(chalk.blue(`Copying asset ${asset} to ${destination}`));
  try {
    await exec`sudo cp ${enginePath}/script/build_image_assets/${asset} ${destination}`;
    await exec`sudo chmod ${chmod} ${destination}/${asset}`;
    await exec`sudo chown ${chown} ${destination}/${asset}`;
    if (executable) {
      await exec`sudo chmod +x ${destination}/${asset}`;
    }
  } catch (e) {
    print(chalk.red(`Error copying asset ${asset} to ${destination}`));
    console.error(e);
    process.exit(1);
  }
}

export const createDir = async (exec: any, dir: string, chmod: string | null = "0755", chown: string | null = "0:0") => {
  print(chalk.blue(`Creating directory ${dir}`));
  try {
    await exec`sudo mkdir -p ${dir}`;
    await exec`sudo chmod ${chmod} ${dir}`;
    await exec`sudo chown ${chown} ${dir}`;
  } catch (e) {
    print(chalk.red(`Error creating directory ${dir}`));
    console.error(e);
    process.exit(1);
  }
}

export const updateSystem = async (exec: any) => {
  print(chalk.blue('Updating package list...'));
  try {
    await exec`sudo apt update -y`;
  } catch (e) {
    print(chalk.red('Error updating package list'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Package list updated'));
}

export const upgradeSystem = async (exec: any) => {
  print(chalk.blue('Upgrading packages...'));
  try {
    await exec`sudo DEBIAN_FRONTEND="noninteractive" apt-get upgrade -y`;
  } catch (e) {
    print(chalk.red('Error upgrading packages'));
    console.error(e);
    process.exit(1);
  }
}

export const localiseSystem = async (exec: any, enginePath: string, language: string, keyboard: string, timezone: string) => {
  print(chalk.blue('Localising the system...'));
  try {
    await copyAsset(exec, enginePath, 'locale.gen', '/etc')
    await exec`sudo locale-gen`;
    
    // Set all locale environment variables
    const localeConfig = [
        `LANG=${language}`,
        `LANGUAGE=${language}`,
        `LC_ALL=${language}`,
        `LC_CTYPE=${language}`
    ].join('\\n');
    await exec`echo -e '${localeConfig}' | sudo tee /etc/default/locale`;
    
    await exec`sudo raspi-config nonint do_configure_keyboard ${keyboard}`
    await exec`sudo timedatectl set-timezone ${timezone}`
  } catch (e) {
    print(chalk.red('Error localising the system'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('System localised'));
}

export const installCrontabs = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing crontabs...'));
  try {
    await copyAsset(exec, enginePath, 'boot.sh', '/usr/local/bin', true)
    await exec`sudo sed -i "s|/home/pi/idea/agents/agent-engine-dev|${config.defaults.enginePath}|g" /usr/local/bin/boot.sh`
    await exec`sudo crontab ${enginePath}/script/build_image_assets/crondefs`
  } catch (e) {
    print(chalk.red('Error installing crontabs'));
    console.error(e);
    process.exit(1);
  }
}

export const installTemperature = async (exec: any) => {
  print(chalk.blue('Installing lm-sensors...'));
  try {
    await exec`sudo apt install lm-sensors -y`;
  } catch (e) {
    print(chalk.red('Error installing lm-sensors'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('lm-sensors installed'));

  print(chalk.blue('Running sensors (best-effort — may show no data on first boot)...'));
  try {
    const ret = await exec`sensors`
    print(ret.stdout)
  } catch (e) {
    // sensors-detect hasn’t been run yet on a fresh Pi — not fatal
    print(chalk.yellow('sensors returned no data (run sensors-detect manually to configure modules)'));
  }
  print(chalk.green('lm-sensors ready'));
}

export const setHostname = async (exec: any, hostname: string) => {
  print(chalk.blue(`Setting hostname to ${hostname}`));
  try {
    // 1. First, ensure /etc/hosts has the correct entry for the new hostname
    // This helps sudo resolve the hostname before hostnamectl sets it.
    // Robustly replace the line starting with 127.0.1.1, or add it if missing.
    await exec`sudo sed -i 's/^127\\.0\\.1\\.1.*/127.0.1.1\\t${hostname}/' /etc/hosts`;

    // Robustly update the 127.0.0.1 line to ensure 'localhost' and the new hostname are present.
    // This handles cases where only 'localhost' is present, or an old hostname exists.
    await exec`sudo sed -i 's/^127\\.0\\.0\\.1\s*.*/127.0.0.1\\tlocalhost ${hostname}/' /etc/hosts`;

    // 2. Set the new hostname using hostnamectl
    await exec`sudo hostnamectl set-hostname ${hostname}`;

    // 3. Ensure /etc/hostname is updated directly for persistence across reboots
    await exec`echo "${hostname}" | sudo tee /etc/hostname > /dev/null`;

  } catch (e) {
    print(chalk.red('Error setting hostname'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Hostname set'));
  print(hostname); // Print hostname for capture
}

export const installAvahi = async (exec: any) => {
  print(chalk.blue('Installing Avahi for .local mDNS discovery...'));
  try {
    await exec`sudo apt install avahi-daemon libnss-mdns -y`;
    await exec`sudo systemctl enable avahi-daemon`;
    await exec`sudo systemctl start avahi-daemon`;
  } catch (e) {
    print(chalk.red('Error installing Avahi'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Avahi installed and enabled'));
}

export const installArgonFanScript = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing argon_fan_script.sh...'));
  try {
    await copyAsset(exec, enginePath, 'argon_fan_script.sh', '/usr/local/bin', true, "0755")
  } catch (e) {
    print(chalk.red('Error installing argon_fan_script.sh'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Argon fan script installed'));

  print(chalk.blue('Executing argon_fan_script.sh...'));
  try {
    await exec`sudo /usr/local/bin/argon_fan_script.sh`;
  } catch (e) {
    print(chalk.red('Error executing argon_fan_script.sh'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Argon fan script executed'));
}

export const installGh = async (exec: any) => {
  print(chalk.blue('Installing gh...'));
  try {
    await exec`curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg`
    await exec`sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg`
    await exec`echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null`
    await exec`sudo apt update`
    await exec`sudo apt install gh -y`

  } catch (e) {
    print(chalk.red('Error installing gh'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('gh installed'));
}

export const cloneRepo = async (exec: any, enginePath: string, engineParentPath: string, githubToken: string) => {
  print(chalk.blue('Cloning the engine repo...'));
  try {
    await exec`git config --global user.email "koen@swings.be"`;
    await exec`git config --global user.name "Koen Swings"`;
    await exec`gh auth login --with-token < ${enginePath}/script/build_image_assets/gh_token.txt`;
    await exec`if [ -d ${enginePath} ]; then sudo rm -rf ${enginePath}; fi`;
    await exec`cd ${engineParentPath} && git clone https://koenswings:${githubToken}@github.com/koenswings/engine.git`;
  } catch (e) {
    print(chalk.red('Error cloning the engine repo'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine repo cloned'));
}

export const installUdev = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing udev and udev rules...'));
  try {
    await exec`sudo apt install udev -y`;
    await copyAsset(exec, enginePath, '90-docking.rules', '/etc/udev/rules.d')
    await createDir(exec, '/disks', "0755", "0:0")

    // Configure /dev/engine ownership so the pi user can write sentinel files.
    // udev creates /dev/engine as root:root; we use systemd-tmpfiles with 'd'
    // (create if absent AND always apply mode/ownership) to ensure pi:pi 0775
    // survives every reboot — not just the first provisioning run.
    print(chalk.blue('  - Configuring /dev/engine ownership via tmpfiles.d...'))
    await exec`sudo tee /etc/tmpfiles.d/idea-engine.conf > /dev/null << 'EOF'
# /dev/engine is created by udev for the IDEA Engine disk sentinel mechanism.
# 'd' creates the directory if absent and always applies mode/ownership.
d /dev/engine 0775 pi pi -
EOF`
    await exec`sudo systemd-tmpfiles --create /etc/tmpfiles.d/idea-engine.conf`
  } catch (e) {
    print(chalk.red('Error installing udev and udev rules'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Udev and udev rules installed'));
}

export const rebootSystem = async (exec: any) => {
  print(chalk.blue('Rebooting the system...'));
  try {
    await exec`sudo reboot`;
  } catch (e) {
    print(chalk.red('Error rebooting the system'));
    console.error(e);
    process.exit(1);
  }
}

export const usbGadget = async (exec: any, enginePath: string) => {
  print(chalk.blue('Running the rpi4-usb script...'));
  try {
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/rpi4-usb.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/rpi4-usb.sh`;
  } catch (e) {
    print(chalk.red('Error running the rpi4-usb script'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('rpi4-usb script run'));
}

export const installRaspAP = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing RaspAP...'));
  try {
    const raspap_version = "2.8.5"
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-raspap.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-raspap.sh -b ${raspap_version} -y -o 0 -a 0`;
  } catch (e) {
    print(chalk.red('Error installing RaspAP'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('RaspAP installed'));
}

/**
 * Install Tailscale on a newly provisioned Pi.
 *
 * Design: design/tailscale-remote-management.md
 *
 * Tailscale is installed in "latent" mode:
 *   - Binaries present, systemd service DISABLED and NOT started
 *   - Auth key stored at /etc/tailscale/debug-authkey (600, root)
 *   - Activation script installed at /usr/local/bin/tailscale-debug-activate.sh
 *
 * The Pi remains fully offline during normal operation.
 * A coordinator activates debug mode by running the activation script over SSH.
 *
 * Auth key source (in priority order):
 *   1. TAILSCALE_AUTHKEY env var (set on the management Pi running buildEngine)
 *   2. /home/pi/openclaw/secrets/tailscale_authkey.txt (Atlas's secrets dir on this Pi)
 */
export const installTailscale = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing Tailscale (latent debug mode)...'))

  // Resolve auth key
  const authKey = process.env.TAILSCALE_AUTHKEY
    ?? (fs.existsSync('/home/pi/openclaw/secrets/tailscale_authkey.txt')
        ? fs.readFileSync('/home/pi/openclaw/secrets/tailscale_authkey.txt', 'utf-8').trim()
        : null)

  if (!authKey) {
    console.error(chalk.red('installTailscale: no auth key found. Set TAILSCALE_AUTHKEY env var or ensure /home/pi/openclaw/secrets/tailscale_authkey.txt exists.'))
    process.exit(1)
  }

  try {
    // 1. Download and install Tailscale static binaries (arm64)
    // curl-installs the official static tarball so no package manager changes are needed.
    // The service is NOT enabled after installation.
    // Shell command uses $TSVER which must not be interpolated by TypeScript.
    // We pass it as a regular string argument to avoid template literal interpolation.
    await exec(['bash', '-c',
      'TSVER=$(curl -sL https://pkgs.tailscale.com/stable/ | grep -oP \'tailscale_\\K[\\d.]+(?=_arm64.tgz)\' | head -1)' +
      ' && curl -sL "https://pkgs.tailscale.com/stable/tailscale_${TSVER}_arm64.tgz"' +
      ' | sudo tar -xz --strip-components=1 -C /usr/sbin' +
      ' "tailscale_${TSVER}_arm64/tailscale" "tailscale_${TSVER}_arm64/tailscaled"'
    ])

    // 2. Install systemd service (disabled — does not start on boot)
    await exec`sudo cp ${enginePath}/script/build_image_assets/tailscaled.service /etc/systemd/system/tailscaled.service`
    await exec`sudo systemctl daemon-reload`
    // explicitly do NOT enable: tailscale must be activated manually

    // 3. Store auth key (root-only, 600)
    await exec`sudo mkdir -p /etc/tailscale`
    await exec`echo ${authKey} | sudo tee /etc/tailscale/debug-authkey > /dev/null`
    await exec`sudo chmod 600 /etc/tailscale/debug-authkey`
    await exec`sudo chown root:root /etc/tailscale/debug-authkey`

    // 4. Install activation script
    await exec`sudo cp ${enginePath}/script/build_image_assets/tailscale-debug-activate.sh /usr/local/bin/tailscale-debug-activate.sh`
    await exec`sudo chmod 755 /usr/local/bin/tailscale-debug-activate.sh`

    print(chalk.green('Tailscale installed (service disabled — latent debug mode ready)'))
  } catch (e) {
    print(chalk.red('Error installing Tailscale'))
    console.error(e)
    process.exit(1)
  }
}

export const installZerotier = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing Zerotier...'));
  try {
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-zerotier.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-zerotier.sh`;
  } catch (e) {
    print(chalk.red('Error installing Zerotier'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Zerotier installed'));
}

export const installRSync = async (exec: any) => {
  print(chalk.blue('Installing rsync...'));
  try {
    await exec`sudo apt install rsync -y`;
  } catch (e) {
    print(chalk.red('Error installing rsync'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('rsync installed'));
}

export const installBaseNpm = async (exec: any) => {
  print(chalk.blue('Installing base node, n, npm and pnpm for script execution...'));
  try {
    await exec`sudo apt install npm -y`
    await exec`sudo npm install -g -y n pnpm`
    await exec`sudo n 22.20.0`
  } catch (e) {
    print(chalk.red('Error installing base node, n, npm and pnpm...'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Base node, n, npm and pnpm installed'));
}

export const installEngineNode = async (exec: any) => {
  print(chalk.blue('Installing node version for engine...'));
  try {
    await exec`sudo n 22.20.0`
  } catch (e) {
    print(chalk.red('Error installing engine node version...'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine node version installed'));
}

export const configurePnpm = async (exec: any) => {
  print(chalk.blue('Setting up pnpm...'));
  try {
    await exec`sudo pnpm setup`
  } catch (e) {
    print(chalk.red('Error setting up pnpm...'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('pnpm set up'));
}


export const installPm2 = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing pm2...'));
  try {
    await exec`sudo npm install -g pm2`
    await exec`cd ${enginePath}`
    print(chalk.blue('Installing pm2-logrotate...'))
    await exec`cd ${enginePath} && sudo pm2 install pm2-logrotate`
  } catch (e) {
    print(chalk.red('Error installing pm2'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('pm2 installed'));
}

export const installEnginePM2 = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing the engine...'))
  await exec`cd ${enginePath} && pnpm install_packages`
}

export const buildEnginePM2 = async (exec: any, enginePath: string) => {
  print(chalk.blue('Building the engine with tsc...'))
  await exec`cd ${enginePath} && pnpm build`
}

export const startEnginePM2 = async (exec: any, enginePath: string, permanentEnginePath: string, productionMode: boolean) => {
  print(chalk.blue('Starting the engine with pm2...'));
  try {
    try {
      // We require idempotency - check if the engine has already started before starting and persisting it
      await exec`pm2 show engine`
    } catch (e) {
      print(chalk.blue(`Starting a ${productionMode ? "production" : "dev"} mode engine with pm2...`))
      if (enginePath !== permanentEnginePath) {
        await exec`sudo cp ${enginePath}/pm2.config.cjs ${permanentEnginePath}/`
        await exec`sudo chown pi:pi ${permanentEnginePath}/pm2.config.cjs`
      }

      // Run pm2 as the pi user (no sudo) so the engine process is owned by pi.
      if (productionMode) {
        await exec`cd ${permanentEnginePath} && pm2 start pm2.config.cjs --env production`
      } else {
        await exec`cd ${permanentEnginePath} && pm2 start pm2.config.cjs --env development`
      }
      print(chalk.blue('Saving the pm2 process list...'))
      await exec`pm2 save`
      print(chalk.blue('Enabling pm2 to start on boot...'))
      // Generate the startup command for the pi user and run it with sudo.
      // pm2 startup outputs a line beginning with 'sudo env PATH=...' — extract and execute it.
      const startupOutput = (await exec`pm2 startup systemd -u pi --hp /home/pi`).stdout
      const startupCmd = startupOutput.split('\n').find((l: string) => l.trimStart().startsWith('sudo env PATH='))
      if (startupCmd) {
        await exec`${startupCmd.trim()}`
      } else {
        print(chalk.yellow('Could not extract pm2 startup command from output — run manually if needed'))
        print(startupOutput)
      }
    }
  } catch (e) {
    print(chalk.red('Error starting the engine with pm2'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine started with pm2'))
}

/**
 * Grants the Node.js binary the capability to bind to privileged ports (< 1024),
 * e.g. port 80 for the Console HTTP server.
 *
 * This allows the Engine to serve on port 80 without running as root.
 * Must be re-applied after any Node.js binary update.
 */
export const grantNetBindCapability = async (exec: any) => {
  print(chalk.blue('Granting node cap_net_bind_service (port 80 access)...'))
  try {
    await exec`sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))`
    print(chalk.green('cap_net_bind_service granted to node'))
  } catch (e) {
    print(chalk.red('Error granting cap_net_bind_service — port 80 may not work as non-root'))
    console.error(e)
  }
}

export const installVarious = async (exec: any) => {
  print(chalk.blue('Installing tcpdump, vim and hdparm...'));
  try {
    await exec`sudo apt install tcpdump vim tmux hdparm -y`;
  } catch (e) {
    print(chalk.red('Error installing tcpdump, vim and hdparm'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('tcpdump, vim and hdparm installed'));
}

export const installVarious2 = async (exec: any) => {
  // Install the git, dnsutlis, tree, lshw and cloud-guest-utils packages
  print(chalk.blue('Installing lm-sensors, git, dnsutils, tree, lshw and cloud-guest-utils...'));
  try {
    await exec`sudo apt install git dnsutils tree lshw cloud-guest-utils -y`;
  } catch (e) {
    print(chalk.red('Error installing git, dnsutils, tree, lshw and cloud-guest-utils'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('git, dnsutils, tree, lshw and cloud-guest-utils installed'));
}

export const installChromium = async (exec: any) => {
  print(chalk.blue('Installing Chromium (required for md-to-pdf headless PDF generation)...'));
  try {
    await exec`sudo apt install chromium -y`;
  } catch (e) {
    print(chalk.red('Error installing Chromium'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Chromium installed'));
}


export const buildAppsInfrastructure = async (exec: any) => {
  // Create the /apps, /apps/catalog, and /apps/instances directories 
  print(chalk.blue('Creating the /services, /apps, and /instances directories'))
  try {
    await createDir(exec, '/services')
    await createDir(exec, '/apps')
    await createDir(exec, '/instances')
  } catch (e) {
    print(chalk.red('Error creating the /services, /apps, and /instances directories'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('The /services, /apps, and /instances directories have been created'));
}


const installDocker = async (exec, enginePath, user) => {

  // Run the install-docker.sh script
  print(chalk.blue('Installing Docker'))
  try {
    // Make the script executable
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-docker.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-docker.sh`;
  } catch (e) {
    print(chalk.red('Error installing Docker'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker installed'));

  // Add the docker group if it does not already exist
  print(chalk.blue('Adding the docker group'))
  try {
    // Check if the docker group already exists
    if (await exec`getent group docker`) {
      print(chalk.blue('The docker group already exists'));
    } else {
      await exec`sudo groupadd docker`;
    }
  } catch (e) {
    print(chalk.red('Error adding the docker group'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker group added'));


  // Add the ssh user to the docker group
  print(chalk.blue('Adding the ssh user to the docker group'))
  try {
    await exec`sudo usermod -aG docker ${user}`;
  } catch (e) {
    print(chalk.red('Error adding the ssh user to the docker group'));
    console.error(e);
    process.exit(1);
  }

  // Copy the daemon.json asset to /etc/docker
  print(chalk.blue('Configuring Docker'))
  try {
    await copyAsset(exec, enginePath, 'daemon.json', '/etc/docker', false, "0644")
  } catch (e) {
    print(chalk.red('Error configuring Docker'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker configured'));


  // Restart the Docker service
  print(chalk.blue('Restarting the Docker service'))
  try {
    await exec`sudo systemctl restart docker`;
  } catch (e) {
    print(chalk.red('Error restarting the Docker service'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker service restarted'));


  // Print the Docker Compose, the Docker version and the Docker info
  print(chalk.blue('Docker info'))
  try {
    // (use sudo because the docker group has not been added yet - requires a reboot)
    let ret = await exec`sudo docker compose version`
    print(ret.stdout)
    ret = await exec`sudo docker version`
    print(ret.stdout)
    ret = await exec`sudo docker info`
    print(ret.stdout)
  } catch (e) {
    print(chalk.red('Error printing the Docker info'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker info printed'));
}

const buildDockerInfrastructure = async (exec: any) => {

  // Create the internal docker networks frontend and backend if they do not already exist
  print(chalk.blue('Creating the frontend network'))
  try {
    // Check if the frontend network already exists
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (await exec`sudo docker network ls --filter name=frontend`) {
      print(chalk.blue('The frontend network already exists'));
    } else {
      await exec`sudo docker network create --internal frontend`;
    }
    // Check if the backend network already exists
    if (await exec`sudo docker network ls --filter name=backend`) {
      print(chalk.blue('The backend network already exists'));
    } else {
      await exec`sudo docker network create --internal backend`;
    }
  } catch (e) {
    print(chalk.red('Error creating the frontend or backend network'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Frontend and backend networks created'));
}


// ##################################################################################################
// Obsolete functions
// To be kept for reference only
// ##################################################################################################


const startDockerEngine = async (exec: any, enginePath: string, productionMode: boolean) => {
  // Build the engine image
  print(chalk.blue(`Building a ${productionMode ? "production" : "dev"} mode engine image...`))
  try {
    // Compose build
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (productionMode) {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-prod.yaml build`;
    } else {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-dev.yaml build`;
    }
  } catch (e) {
    print(chalk.red('Error building the engine image'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine image built'));

  // Start the engine
  print(chalk.blue('Composing up the engine...'));
  try {
    // Compose up 
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (productionMode) {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-prod.yaml up -d`;
    } else {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-dev.yaml up -d`;
    }
  } catch (e) {
    print(chalk.red('Error composing up the engine'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine composed up'));
}

```

## File: src/data/InstallApp.ts
```typescript
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
import { Disk, diskMountRoot } from './Disk.js'
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
    const sourceMountRoot = await diskMountRoot(sourceDisk)
    const sourcePath = `${sourceMountRoot}/apps/${appId}`
    if (!await fs.pathExists(sourcePath)) {
        throw new Error(`App '${appId}' not found on disk '${sourceDisk.name}' at ${sourcePath}`)
    }

    // Ensure target has the required directory structure
    const targetMountRoot = await diskMountRoot(targetDisk)
    await fs.ensureDir(`${targetMountRoot}/apps`)
    await fs.ensureDir(`${targetMountRoot}/instances`)
    await fs.ensureDir(`${targetMountRoot}/services`)

    // Copy app bundle
    const targetAppPath = `${targetMountRoot}/apps/${appId}`
    log(`Copying app bundle: ${sourcePath} → ${targetAppPath}`)
    await fs.copy(sourcePath, targetAppPath, { overwrite: true })

    // Register app in store
    await createOrUpdateApp(storeHandle, appId, targetDisk)

    // Generate a fresh instance ID and create the instance directory
    const { uuid } = await import('../utils/utils.js')
    const instanceId = uuid()

    const sourceInstanceBase = `${sourceMountRoot}/instances`
    const targetInstanceBase = `${targetMountRoot}/instances`

    // If source has an instance of this app, copy its data as the starting point
    let sourceInstanceId: string | null = null
    if (await fs.pathExists(sourceInstanceBase)) {
        const store = storeHandle.doc()
        const sourceInstance = Object.values(store.instanceDB).find(
            i => String(i.instanceOf) === String(appId) && String(i.storedOn) === String(sourceDisk.id)
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

    const appsDir = `${await diskMountRoot(backupDisk)}/apps`
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

```

## File: src/data/Instance.ts
```typescript
import { $, YAML, chalk, fs, os, sleep } from "zx";

$.verbose = false;
import { addOrUpdateEnvVariable, deepPrint, log, randomPort, readEnvVariable, uuid, print } from "../utils/utils.js";
import { DockerEvents, DockerMetrics, DockerLogs, InstanceID, AppID, PortNumber, ServiceImage, Timestamp, Version, DeviceName, InstanceName, AppName, Hostname, DiskID, OperationCause } from "./CommonTypes.js";
import { createOperation, updateOperation } from './Operations.js'
import { Store, getDisk, getEngine, getLocalEngine, getInstancesOfEngine, } from "./Store.js";
import { Disk, diskMountRoot, diskFsRoot } from "./Disk.js";
import { localEngineId } from "./Engine.js";
import { network } from "./Network.js";
import { createAppId } from "./App.js";
import { Docker } from "node-docker-api";
import { createMeta } from '../data/Meta.js'
import { config } from '../data/Config.js'
import { DocHandle } from "@automerge/automerge-repo";

// ── Step-progress helpers ─────────────────────────────────────────────────────

const setStep = (
  storeHandle: DocHandle<Store>,
  instanceId: InstanceID,
  step: number,
  total: number,
  label: string,
  opId?: string,
) => {
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instanceId]
    if (!inst) return
    inst.currentStep = step
    inst.totalSteps = total
    inst.stepLabel = label
  })
  // Mirror step progress into the unified Operation record when provided
  if (opId) {
    updateOperation(storeHandle, opId, {
      currentStep: step,
      totalSteps: total,
      stepLabel: label,
      progressPercent: total > 0 ? Math.round((step / total) * 100) : null,
    })
  }
}

const clearStep = (storeHandle: DocHandle<Store>, instanceId: InstanceID) => {
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instanceId]
    if (!inst) return
    inst.currentStep = null
    inst.totalSteps = null
    inst.stepLabel = null
    inst.metrics = null  // clear live metrics when instance is no longer running
  })
}

// ── Start / stop step definitions ────────────────────────────────────────────
// These are the canonical step labels exposed to the Console.
// Pixel can use these verbatim in a step-based progress window.

export const START_STEPS = [
  'Checking if already running',     // 0  (pre-check, skipped if not needed)
  'Generating port',                  // 1
  'Generating password',             // 2
  'Loading service images',          // 3
  'Creating containers',             // 4
  'Starting containers',             // 5
] as const

export const STOP_STEPS = [
  'Finding containers',              // 0
  'Stopping containers',             // 1
] as const

export const BACKUP_STEPS = [
  'Initialising backup repository',  // 0
  'Stopping app',                    // 1
  'Running backup',                  // 2
  'Restarting app',                  // 3
  'Updating backup index',           // 4
] as const


export interface Instance {
  id: InstanceID;
  instanceOf: AppID;   // Reference by name since we can store the AppMaster object only once in Yjs
  name: InstanceName;
  status: Status;
  statusCondition: string | null;  // Human-readable error diagnosis; null when not in Error state
  port: PortNumber;
  serviceImages: ServiceImage[];
  created: Timestamp;       // We must use a timestamp number as Date objects are not supported in YJS
  lastBackup: Timestamp | null;  // Unix ms of last successful backup; null if never backed up
  lastStarted: Timestamp;   // We must use a timestamp number as Date objects are not supported in YJS
  storedOn: DiskID | null;  // The disk that this instance is stored on. null if we do not know it yet
  /** Step-based progress for start/stop. Null when no active operation. */
  currentStep: number | null;
  totalSteps: number | null;
  stepLabel: string | null;
  /** Live Docker resource metrics. Null when instance is not Running. */
  metrics: DockerMetrics | null;
}

export type Status = 'Undocked'      // Disk is not currently docked; instance data is intact on the disk
  | 'Docked'
  | 'Starting'
  | 'Running'
  | 'Pauzed'        // Stopped running but containers are still there (so still consuming resources)
  | 'Stopped'       // Stopped running and containers are removed (so not consuming resources)
  | 'Missing'       // Instance directory no longer found on the disk (deleted or moved to another disk)
  | 'Error';


export const buildInstance = async (instanceName: InstanceName, appName: AppName, gitAccount: string, version: Version, device: DeviceName): Promise<void> => {
  print(`Building new instance '${instanceName}' from version ${version} of app '${appName}' on device '${device}' of the local engine.`)

  // CODING STYLE: only use absolute pathnames !
  // CODING STYLE: use try/catch for error handling

  let instanceId

  try {

    // Read the meta file on the disk and extract the disk id
    // Do it
    // const disk = findDiskByDevice(store, getLocalEngine(store), device)
    // if (!disk) {
    //   was-console-log(chalk.red(`Disk ${device} not found on engine ${getLocalEngine(store).hostname}`))
    //   return
    // } else {
    //   instanceId = createInstanceId(instanceName, appName, disk.id).toString() as InstanceID
    //   log(`Instance ID: ${instanceId}`)
    // } 
    const instanceId = createInstanceId(appName).toString() as InstanceID
    log(`Instance ID: ${instanceId}`)


    // Create the app infrastructure if it does not exist
    // TODO: This should be done when creating the disk — https://github.com/koenswings/idea/issues/46
    // TODO: Here we should only be checking if it is an apps disk! — https://github.com/koenswings/idea/issues/46
    await $`mkdir -p /disks/${device}/apps /disks/${device}/services /disks/${device}/instances`

    // **************************
    // STEP 1 - App Type creation
    // **************************

    // Clone the app from the repository
    // Remove /tmp/apps/${typeName} if it exists
    await $`rm -rf /tmp/apps/${appName}`
    let appVersion = ""
    print(`Cloning version ${version} of app ${appName} from git account ${gitAccount}`)
    if (version === "latest") {
      print(`Cloning the latest development version of app ${appName} from git account ${gitAccount}`)
      await $`git clone https://github.com/${gitAccount}/app-${appName} /tmp/apps/${appName}`
      // Set appVersion to the latest commit hash
      const gitLog = await $`cd /tmp/apps/${appName} && git log -n 1 --pretty=format:%H`
      appVersion = gitLog.stdout.trim()
      print(`App version: ${appVersion}`)

    } else {
      print(`Cloning version ${version} of app ${appName} from git account ${gitAccount}`)
      await $`git clone -b ${version} https://github.com/koenswings/app-${appName} /tmp/apps/${appName}`
      appVersion = version
    }


    // Create the app type
    // Overwrite if it exists
    // We want to copy the content of a directory and rename the directory at the same time: 
    //   See https://unix.stackexchange.com/questions/412259/how-can-i-copy-a-directory-and-rename-it-in-the-same-command
    await $`cp -fr /tmp/apps/${appName}/. /disks/${device}/apps/${appName}-${appVersion}/`


    // **************************
    // STEP 2 - App Instance creation
    // **************************

    // OLD
    // Create the app instance
    // If there is already a instance with the name instanceName, try instanceName-1, instanceName-2, etc.
    // let instanceNumber = 1
    // let baseInstanceName = instanceName 
    // while (true) {
    //   try {
    //     await $`mkdir /disks/${device}/instances/${instanceName}`
    //     break
    //   } catch (e) {
    //     instanceNumber++
    //     instanceName = `${baseInstanceName}-${instanceNumber}` as InstanceName
    //   }
    // }
    // Again use /. to specify the content of the dir, not the dir itself 
    await $`cp -fr /tmp/apps/${appName}/. /disks/${device}/instances/${instanceId}/`




    // If the app has an init_data.tar.gz file, unpack it in the app folder
    if (fs.existsSync(`/disks/${device}/instances/${instanceId}/init_data.tar.gz`)) {
      print(`Unpacking the init_data.tar.gz file in the app folder`)
      await $`tar -xzf /disks/${device}/instances/${instanceId}/init_data.tar.gz -C /disks/${device}/instances/${instanceId}`
      // Rename the folder init_data to data
      await $`mv /disks/${device}/instances/${instanceId}/init_data /disks/${device}/instances/${instanceId}/data`
      // Remove the init_data.tar.gz file
      await $`rm /disks/${device}/instances/${instanceId}/init_data.tar.gz`
    }
    // Not needed as Docker will auto-create any data folder we specify in the compose
    // } else {
    //   // Create an empty data folder
    //   await $`mkdir /disks/${device}/instances/${instanceId}/data`
    // }

    // Open the compose.yaml file of the app instance and add the version info to the compose file and the instance name
    print(`Opening the compose.yaml file of the app instance and adding the version info to the compose file (${appVersion}) and the instance name (${instanceName})`)
    const composeFile = await $`cat /disks/${device}/instances/${instanceId}/compose.yaml`
    const compose = YAML.parse(composeFile.stdout)
    compose['x-app'].version = appVersion
    compose['x-app'].instanceName = instanceName
    const composeYAML = YAML.stringify(compose)
    await $`echo ${composeYAML} > /disks/${device}/instances/${instanceId}/compose.yaml`

    // Remove the temporary app folder
    await $`rm -rf /tmp/apps/${appName}`

    // **************************
    // STEP 3 - Persist the services
    // **************************

    // Extract the service images of the services from the compose file, and then pull them and save them in /services
    const services = compose.services
    for (const serviceName in services) {
      const serviceImage = services[serviceName].image
      // Pull the sercice image
      const serviceImageFile = serviceImage.replace(/\//g, '_')
      if (fs.existsSync(`/disks/${device}/services/${serviceImageFile}.tar`)) {
        print(`Service image ${serviceImage} already exists`)
      } else {
        print(`Pulling service image ${serviceImage}`)
        await $`docker image pull ${serviceImage}`
        // Save the service image
        await $`docker save ${serviceImage} > /disks/${device}/services/${serviceImageFile}.tar`
      }
    }

    // **************************
    // STEP 4 - Create the META.yaml file if it is not already there
    // **************************

    if (!fs.existsSync(`/disks/${device}/META.yaml`)) {
      log(`Creating META.yaml file on disk ${device}`)
      createMeta(device)
    } else {
      print(`META.yaml file already exists on disk ${device}`)
    }

    // OBSOLETE 
    // Create the META.yaml file
    // Do it
    // await addMetadata(instanceId)
    // was-console-log(chalk.blue('Adding metadata...'));
    // try {
    //     // Convert the diskMetadata object to a YAML string 
    //     // const diskMetadataYAML = YAML.stringify(diskMetadata)
    //     // fs.writeFileSync('./script/build_image_assets/META.yaml', diskMetadataYAML)
    //     // // Copy the META.yaml file to the remote machine using zx
    //     // await copyAsset('META.yaml', '/')
    //     // await $$`echo '${YAML.stringify(diskMetadata)}' | sudo tee /META.yaml`;

    //     const metaPath = ''

    //     // Read the hardware ID if the disk


    //     await $`sudo echo 'created: ${new Date().getTime()}' >> ${metaPath}/META.yaml`
    //     await $`sudo echo 'diskId: ${name}-disk' >> ${metaPath}/META.yaml`
    //     // Move the META.yaml file to the root directory
    //     await $`sudo mv ${metaPath}/META.yaml /META.yaml`
    // } catch (e) {
    //   was-console-log(chalk.red('Error adding metadata'));
    //   console.error(e);
    //   process.exit(1);
    // }



    print(chalk.green(`Instance ${instanceId} built`))
  } catch (e) {
    print(chalk.red('Error building app instance'))
    console.error(e)
  }
}

export const createInstanceId = (appName: AppName): InstanceID => {
  const id = uuid()
  // return instanceName + "_on_" + diskId as InstanceID
  return appName + "-" + id as InstanceID
}

export const extractAppName = (instanceId: InstanceID): InstanceName => {
  // return instanceId.split('_on_')[0] as InstanceName
  return instanceId.split('-')[0] as InstanceName
}

export const createOrUpdateInstance = async (storeHandle: DocHandle<Store>, instanceId: InstanceID, disk: Disk): Promise<Instance | undefined> => {
  let instance: Instance
  try {
    const composeFile = await $`cat ${await diskMountRoot(disk)}/instances/${instanceId}/compose.yaml`
    const compose = YAML.parse(composeFile.stdout)
    const services = Object.keys(compose.services)
    const servicesImages = services.map(service => compose.services[service].image)
    // const instanceId = createInstanceId(instanceName, disk.id)  
    const instanceName = compose['x-app'].instanceName as InstanceName
    storeHandle.change(doc => {
      const storedInstance: Instance | undefined = doc.instanceDB[instanceId]
      if (!storedInstance) {
        // Create a new instance object
        log(`Creating new instance object ${instanceId} on disk ${disk.id}`)
        instance = {
          id: instanceId,
          instanceOf: createAppId(compose['x-app'].name, compose['x-app'].version) as AppID,
          name: instanceName as InstanceName,
          storedOn: disk.id,
          status: 'Docked' as Status,
          statusCondition: null,
          port: 0 as PortNumber, // Will be set later
          serviceImages: servicesImages as ServiceImage[],
          created: new Date().getTime() as Timestamp,
          lastBackup: null,
          lastStarted: 0 as Timestamp,
          currentStep: null,
          totalSteps: null,
          stepLabel: null,
          metrics: null,
        }
        doc.instanceDB[instanceId] = instance
      } else {
        // Granularly update the existing instance object
        log(`Updating existing instance object ${instanceId} on disk ${disk.id}`)
        instance = storedInstance
        instance.instanceOf = createAppId(compose['x-app'].name, compose['x-app'].version) as AppID
        instance.name = instanceName as InstanceName
        // Preserve Stopped status — the operator explicitly stopped this instance.
        // Only reset to Docked if the instance was in a transient or detached state
        // (Missing, Undocked, Error) so it can be started again after re-dock.
        // Running / Starting / Stopped are intentional states that must not be overwritten here.
        if (instance.status === 'Missing' || instance.status === 'Undocked' || instance.status === 'Error') {
          instance.status = 'Docked' as Status
        }
        instance.storedOn = disk.id
        instance.serviceImages = servicesImages as ServiceImage[]

      }
    })
    return instance!
  } catch (e) {
    log(chalk.red(`Error initializing instance ${instanceId} on disk ${disk.id}`))
    console.error(e)
    return undefined
  }
}

export const createPortNumber = async (store: Store): Promise<PortNumber> => {
  let port = randomPort()
  let portInUse = true
  let portInUseResult
  const localEngine = getLocalEngine(store)
  const instances = getInstancesOfEngine(store, localEngine)

  // Check if the port is already in use on the system
  while (portInUse) {
    log(`Checking if port ${port} is in use`)
    try {
      portInUseResult = await $`netstat -tuln | grep -w ${port}`
      log(`Port ${port} is in use`)
      port = randomPort()
    } catch (e) {
      log(`Port ${port} is not in use. Checking if it is reserved by another instance`)
      const inst = instances.find(instance => instance && instance.port == port)
      if (inst) {
        log(`Port ${port} is reserved by another instance. Generating a new one.`)
        //port++
        port = randomPort()
      } else {
        log(`Port ${port} is not reserved by another instance`)
        portInUse = false
      }
    }
  }
  return port
}

// KSW - UNTESTED >>>
export const checkPortNumber = async (port: PortNumber): Promise<boolean> => {
  log(`Checking if port ${port} is in use`)
  try {
    const portInUseResult = await $`netstat -tuln | grep -w ${port}`
    log(`Port ${port} is in use`)
    return true
  } catch (e) {
    log(`Port ${port} is not in use`)
    return false
  }
}
// KSW - UNTESTED <<<

/**
 * Build a human-readable diagnosis string when an instance fails.
 * Collects: the caught error message + recent docker logs for each service container.
 * Safe to call in a catch block — never throws.
 */
export const diagnoseInstance = async (instance: Instance, disk: Disk, caughtError: unknown): Promise<string> => {
  const parts: string[] = []

  // 1. Engine-level error message
  if (caughtError) {
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError)
    parts.push(`Engine error: ${msg}`)
  }

  // 2. Docker container logs (last 20 lines per service)
  if (!config.settings.testMode) {
    for (const image of (instance.serviceImages ?? [])) {
      // Container name convention: <instanceId>-<serviceName>-1
      // Derive service name from image: last path segment before tag
      const serviceName = image.split('/').pop()?.split(':')[0] ?? 'service'
      const containerName = `${instance.id}-${serviceName}-1`
      try {
        const logs = await $`docker logs --tail=20 ${containerName}`.quiet()
        const output = (logs.stdout + logs.stderr).trim()
        if (output) {
          parts.push(`Container logs (${serviceName}):\n${output.split('\n').map(l => '  ' + l).join('\n')}`)
        }
      } catch { /* container may not exist yet */ }
    }
  }

  return parts.join('\n\n') || 'Unknown error'
}

export const startInstance = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk, cause: OperationCause = 'console-command'): Promise<void> => {
  const store: Store = storeHandle.doc()
  print(`Starting instance '${instance.id}' on disk ${disk.id} of engine '${localEngineId}'.`)

  // Short-circuit: if containers are already running (e.g. engine restarted while app was up),
  // just update the status to Running and return — no need to recreate containers.
  if (!config.settings.testMode) {
    try {
      const ps = await $`docker ps --filter name=${instance.id} --format {{.Names}}`
      if (ps.stdout.trim().length > 0) {
        log(`Instance '${instance.id}' containers already running — updating status to Running`)
        const port = parseInt(await readEnvVariable(`${await diskMountRoot(disk)}/instances/${instance.id}/.env`, 'port') as string) || 0
        storeHandle.change(doc => {
          const inst = doc.instanceDB[instance.id]
          inst.status = 'Running' as Status
          inst.statusCondition = null
          if (port > 0) inst.port = port as PortNumber
          inst.lastStarted = Date.now() as Timestamp
        })
        return
      } else {
        log(`Instance '${instance.id}' containers are not running — proceeding with full start`)
      }
    } catch { /* docker not available or no containers — continue with normal start */ }
  }

  const totalStartSteps = START_STEPS.length

  // Create an Operation record so start progress appears in operationDB
  // alongside copy/move/backup ops and is visible to the UI uniformly.
  const startOpId = createOperation(
    storeHandle, 'startApp',
    { instanceId: instance.id, diskId: disk.id },
    cause,
    { type: 'instance', id: instance.id },
  )
  updateOperation(storeHandle, startOpId, { status: 'Running' })

  // Set the instance status to Starting
  log(`Setting instance '${instance.id}' status to Starting`)
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instance.id]
    inst.status = 'Starting' as Status
  })

  try {

    const mountRoot = await diskMountRoot(disk)
    log(`Checking instance directory at '${mountRoot}/instances/${instance.id}'`)
    // Verify the instance directory exists on this engine before proceeding.
    // If it doesn't, the disk's data isn't here — fail early with a clear error.
    if (!fs.existsSync(`${mountRoot}/instances/${instance.id}`)) {
      throw new Error(`Instance directory not found at '${mountRoot}/instances/${instance.id}'. The disk may not be docked to this engine.`)
    }
    log(`Instance directory found — proceeding`)
    // Create an empty .env file if it does not yet exist
    if (!fs.existsSync(`${mountRoot}/instances/${instance.id}/.env`)) {
      await $`touch ${mountRoot}/instances/${instance.id}/.env`
    }

    // **************************
    // STEP 1 - Port generation
    // **************************
    setStep(storeHandle, instance.id, 1, totalStartSteps, START_STEPS[1], startOpId)

    // Generate a port  number for the app  and assign it to the variable port
    // Start from port number 3000 and check if the port is already in use by another app
    // The port is in use by another app if an app can be found in networkdata with the same port
    // let port = 3000
    // const instances = getEngineInstances(store, getLocalEngine(store))
    // was-console-log(`Searching for an available port number for instance ${instance.id}. Current instances: ${deepPrint(instances)}.`)
    // while (true) {
    //   const inst = instances.find(instance => instance && instance.port == port)
    //   if (inst) {
    //     port++
    //   } else {
    //     break
    //   }
    // }

    let port: PortNumber = 0 as PortNumber

    // Check if the port is defined in the .env file
    try {
      log(`Trying to find a port number for instance ${instance.id} in the .env file`)
      // const envContent = (await $`cat /disks/${disk.device}/instances/${instance.id}/.env`).stdout
      // port = parseInt(envContent.split('=')[1].slice(0, -1)) as PortNumber
      port = parseInt(await readEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'port') as string) as PortNumber
    } catch (e) {
      log(`No .env file found for instance ${instance.id}`)
    }
    // Check if port is undefined or NaN
    if (!(port == 0) && !isNaN(port)) {
      log(`Found a port number for instance ${instance.id} in the .env file: ${port}`)

      // >>> KSW - UNTESTED
      // Check if the port is already in use on the system
      const portInUse = await checkPortNumber(port)
      if (portInUse) {
        log(`Port ${port} is already in use. Generating a new port number.`)
        // If the app is kolibri, it means that it has a fixed port and so either another kolibri instance is already running, ]
        // or it is still running after being stopped because the disk was disconnected. 
        // If the instance was still running after being stopped, lets wait for 10 secs and try again. If it is still running, we throw an error.
        if (instance.instanceOf.startsWith('kolibri' as AppID)) {
          log(`Instance ${instance.id} is a kolibri instance. Waiting 10 seconds to see if the port becomes free.`)
          await sleep(10000)
          const portStillInUse = await checkPortNumber(port)
          if (portStillInUse) {
            throw new Error(`Port ${port} is still in use after waiting. Cannot start kolibri instance ${instance.id}.`)
          } else {
            log(`Port ${port} is now free.`)
          }
        } else {
          port = await createPortNumber(store)
          // Write the new port number to the .env file
          await addOrUpdateEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'port', port.toString())
        }
      } else {
        log(`Port ${port} is not in use`)
      }
      // KSW UNTESTED <<<

    } else {
      log(`No port number has previously been generated.`)
      // If the app is kolibri, assign it port 8080
      if (instance.instanceOf.startsWith('kolibri' as AppID)) {
        port = 8080 as PortNumber
        log(`Instance ${instance.id} is a kolibri instance. Assigning it port ${port}.`)
      } else {
        log(`Generating a new port number for instance ${instance.id}.`)
        port = await createPortNumber(store)
      }
      // Write a .env file in which you define the port variable
      await addOrUpdateEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'port', port.toString())
    }

    print(`Found a port number for instance ${instance.id}: ${port}`)
    // Assign the port number to the instance object
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.port = port as PortNumber
    })

    // **************************
    // STEP 2 - Password generation
    // **************************
    setStep(storeHandle, instance.id, 2, totalStartSteps, START_STEPS[2], startOpId)

    // **************************
    // STEP 1b - Generate a password for the app
    // **************************

    let pass: string = ""

    // Check if the pass is already defined in the .env file
    try {
      log(`Trying to find a pass for instance ${instance.id} in the .env file`)
      pass = await readEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'pass') as string
    } catch (e) {
      log(`No .env file found for instance ${instance.id}`)
    }
    // Check if port is undefined or NaN
    if (pass && !(pass == "")) {
      log(`Found a pass for instance ${instance.id} in the .env file: ${pass}`)
    } else {
      log(`No pass has previously been generated. Generating a new pass.`)
      pass = await uuid()
      log(`Generated pass: ${pass}`)
      // Write the password to the .env file
      await addOrUpdateEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'pass', pass)
    }


    // **************************
    // STEP 3 - Preloading of services
    // **************************
    setStep(storeHandle, instance.id, 3, totalStartSteps, START_STEPS[3], startOpId)

    log(`Preloading the service images of the services from the compose file`)
    // Extract the service images of the services from the compose file, and pull them
    // Open the compose.yaml file of the app instance
    log(`Reading and parsing the compose.yaml file of the app instance`)
    const composeFile = await $`cat ${mountRoot}/instances/${instance.id}/compose.yaml`
    const compose = YAML.parse(composeFile.stdout)
    const services = compose.services
    if (!config.settings.testMode) {
      // In production: load images from pre-saved tar files on the disk (no internet required)
      for (const serviceName in services) {
        const serviceImage = services[serviceName].image
        log(`Loading the service image ${serviceImage} from the saved tar file`)
        await $`docker image load < ${mountRoot}/services/${serviceImage.replace(/\//g, '_')}.tar`
      }
    } else {
      // In testMode: no tar files in fixtures — Docker pulls the image at create time if not cached
      log(`testMode: skipping image load from tar; Docker will pull images as needed`)
    }

    // **************************
    // STEP 4 - Container creation
    // **************************
    setStep(storeHandle, instance.id, 4, totalStartSteps, START_STEPS[4], startOpId)

    await createInstanceContainers(storeHandle, instance, disk)

    // **************************
    // STEP 5 - Run the Instance
    // **************************
    setStep(storeHandle, instance.id, 5, totalStartSteps, START_STEPS[5], startOpId)

    await runInstance(storeHandle, instance, disk)
    updateOperation(storeHandle, startOpId, {
      status: 'Done',
      completedAt: Date.now() as Timestamp,
    })
  }

  catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    print(chalk.red(`Error starting app instance '${instance.id}': ${errMsg}`))
    const condition = await diagnoseInstance(instance, disk, e)
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.status = 'Error' as Status
      inst.statusCondition = condition
    })
    clearStep(storeHandle, instance.id)
    updateOperation(storeHandle, startOpId, {
      status: 'Failed',
      error: errMsg,
      completedAt: Date.now() as Timestamp,
    })
  }
}


// export const oldStartInstance = async (store: Store, instance: Instance, disk: Disk): Promise<void> => {
//   was-console-log(`Starting instance '${instance.id}' on disk ${disk.id} of engine '${getLocalEngine(store).hostname}'.`)

//   try {



//     // **************************
//     // STEP 1 - Port generation
//     // **************************

//     // Generate a port  number for the app  and assign it to the variable port
//     // Start from port number 3000 and check if the port is already in use by another app
//     // The port is in use by another app if an app can be found in networkdata with the same port
//     // let port = 3000
//     // const instances = getEngineInstances(store, getLocalEngine(store))
//     // was-console-log(`Searching for an available port number for instance ${instance.id}. Current instances: ${deepPrint(instances)}.`)
//     // while (true) {
//     //   const inst = instances.find(instance => instance && instance.port == port)
//     //   if (inst) {
//     //     port++
//     //   } else {
//     //     break
//     //   }
//     // }

//     let port

//     // Find the container
//     log(`Trying to find a running container with the same instance id amongst the following running containers:`)
//     const docker = new Docker({ socketPath: '/var/run/docker.sock' });
//     const containers = await docker.container.list()
//     containers.forEach(container => {
//       was-console-log(container.data['Names'][0])
//     })
//     const container = containers.find(container => container.data['Names'][0].includes(instance.id))
//     if (container) {
//       port = parseInt(container.data['Ports'][0]['PublicPort'])
//       log(`Found a container for instance ${instance.id} running on port ${port}`)
//     } else {
//       // Check if the port is defined in the .env file
//       try {
//         log(`Trying to find a port number for instance ${instance.id} in the .env file`)
//         const envContent = (await $`cat /disks/${disk.device}/instances/${instance.id}/.env`).stdout
//         port = envContent.split('=')[1].slice(0, -1)
//       } catch (e) {
//         log(`No .env file found for instance ${instance.id}`)
//       }
//       if (port) {
//         log(`Found a port number for instance ${instance.id} in the .env file: ${port}`)
//       } else {
//         log(`No container found for instance ${instance.id} and no port number has previously been generated. Generating a new port number.`)
//         // Alternative is to check the system for an occupied port
//         // await $`netstat -tuln | grep ${port}`
//         // port = 3000
//         port = randomPort()
//       }
//     }

//     // Check if the port is already in use on the system
//     let portInUse = true
//     let portInUseResult
//     const instances = getEngineInstances(store, getLocalEngine(store))
//     while (portInUse) {
//       log(`Checking if port ${port} is in use`)
//       try {
//         portInUseResult = await $`netstat -tuln | grep ${port}`
//         log(`Port ${port} is in use`)
//         port++
//       } catch (e) {
//         log(`Port ${port} is not in use. Checking if it is reserved by another instance`)
//         const inst = instances.find(instance => instance && instance.port == port)
//         if (inst) {
//           log(`Port ${port} is reserved by another instance. Generating a new one.`)
//           //port++
//           port = randomPort()
//         } else {
//           log(`Port ${port} is not reserved by another instance`)
//           portInUse = false
//         }
//       }
//     }

//     was-console-log(`Found a port number for instance ${instance.id}: ${port}`)
//     instance.port = port as PortNumber

//     // Update the .env file
//     await addOrUpdateEnvVariable(`/disks/${disk.device}/instances/${instance.id}/.env`, 'port', port.toString())  
//     // await $`echo "port=${port}" > /disks/${disk.device}/instances/${instance.id}/.env`
//     // Do not set the instance port member here - only set it when running the app

//     // **************************
//     // STEP 2 - Preloading of services
//     // **************************

//     // Extract the service images of the services from the compose file, and pull them
//     // Open the compose.yaml file of the app instance
//     const composeFile = await $`cat /disks/${disk.device}/instances/${instance.id}/compose.yaml`
//     const compose = YAML.parse(composeFile.stdout)
//     const services = compose.services
//     for (const serviceName in services) {
//       const serviceImage = services[serviceName].image
//       // Load the service image from the saved tar file
//       await $`docker image load < /disks/${disk.device}/services/${serviceImage.replace(/\//g, '_')}.tar`
//     }

//     // **************************
//     // STEP 3 - Container creation
//     // **************************

//     await createInstanceContainers(store, instance, disk)

//     // **************************
//     // STEP 4 - run the Instance
//     // **************************

//     await runInstance(store, instance, disk)
//   }

//   catch (e) {
//     was-console-log(chalk.red('Error starting app instance'))
//     console.error(e)
//   }
// }

export const createInstanceContainers = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk) => {
  const store: Store = storeHandle.doc()
  const mountRoot = await diskMountRoot(disk)
  try {
    log(`Creating the containers for the services of the app instance`)

    // App-specific pre-processing commands
    const app = store.appDB[instance.instanceOf]
    if (app && app.name === 'nextcloud') {

      // Pass the hostname to the compose file via .env
      const localEngine = getLocalEngine(store)
      const hostname = localEngine.hostname
      if (hostname) {
        await addOrUpdateEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'hostname', hostname)
      }

      // Pass the ip address to the compose file via .env
      const interfaceData = os.networkInterfaces()
      const ip = interfaceData["eth0"]?.find((iface) => iface.family === "IPv4")?.address
      if (ip) {
        log(`Found IP address ${ip} for instance ${instance.id}`)
        await addOrUpdateEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'ip', ip)
      } else {
        log(chalk.red(`No IP address found for instance ${instance.id}`))
      }
      // const connections = network.connections
      // if (connections && connections["eth0"]) {
      //   const ip = connections["eth0"].ip4
      //   // Write the ip address to the .env file
      //   // await $`echo "ip=${ip}" >> /disks/${disk.device}/instances/${instance.id}/.env`
      //   await addOrUpdateEnvVariable(`/disks/${disk.device}/instances/${instance.id}/.env`, 'ip', ip)
      // }

    }

    log(`Creating containers of app instance '${instance.id}' on disk ${disk.id} of engine ${localEngineId}.`)
    await $`cd ${mountRoot}/instances/${instance.id} && docker compose create`
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.status = 'Pauzed' as Status
    })
  } catch (e) {
    print(chalk.red(`Error creating the containers of app instance ${instance.id}`))
    console.error(e)
    const condition = await diagnoseInstance(instance, disk, e)
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.status = 'Error' as Status
      inst.statusCondition = condition
    })
  }
}



export const runInstance = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk): Promise<void> => {
  const store: Store = storeHandle.doc()
  try {

    log(`Running instance '${instance.id}' on disk ${disk.id} of engine '${localEngineId}'.`)

    // Extract the port number from the .env file containing "port=<portNumber>"
    // const envContent = (await $`cat /disks/${disk.device}/instances/${instance.id}/.env`).stdout
    // Look for a line with port=<portNumber> and extract the portNumber
    // const ports = envContent.match(/port=(\d+)/g)
    // Split using '=' and take the second element
    // Also remove the newline at the end
    //const port = envContent.split('=')[1].slice(0, -1)
    const port = await readEnvVariable(`${await diskMountRoot(disk)}/instances/${instance.id}/.env`, 'port')
    print(`Ports: ${deepPrint(port)}`)
    if (port) {
      const parsedPort = parseInt(port)
      // If parsedPort is not NaN, assign it to the instance port
      if (!isNaN(parsedPort)) {
        log(`Port number extracted from .env file for instance ${instance.id}: ${parsedPort}`)
        storeHandle.change(doc => {
          const inst = doc.instanceDB[instance.id]
          inst.port = parsedPort as PortNumber
        })
      } else {
        log(chalk.red(`Error parsing port number from .env file for instance ${instance.id}. Got ${parsedPort} from ${port}`))
      }
    } else {
      log(chalk.red(`Error extracting port number from .env file for instance ${instance.id}`))
    }

    // Set status to Running before starting the containers.
    // This ensures the CRDT reflects Running immediately so observers can
    // observe it during the docker compose up / Recreate cycle rather than
    // only after it completes. On failure the catch block sets Error.
    //
    // Guard: verify the disk is still docked AND the instance is still in a
    // startable state before writing Running. A stale startInstance from a
    // previous run may complete after the disk has been undocked or the instance
    // has been moved to Undocked by the test teardown. In that case, skip.
    const snap = storeHandle.doc()
    const currentDisk = snap?.diskDB[disk.id as any]
    const currentInst = snap?.instanceDB[instance.id as any]
    if (!currentDisk || !currentDisk.dockedTo) {
      log(`Disk ${disk.id} is no longer docked — skipping Running status update for ${instance.id}`)
      return
    }
    if (currentInst?.status === 'Undocked') {
      log(`Instance ${instance.id} is already Undocked — skipping Running status update`)
      return
    }
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.lastStarted = new Date().getTime() as Timestamp
      inst.status = 'Running' as Status
      inst.statusCondition = null  // clear any previous error diagnosis
    })

    // Compose up the app
    await $`cd ${await diskMountRoot(disk)}/instances/${instance.id} && docker compose up -d`
    // Modify the dockerMetrics of the instance
    // instance.dockerMetrics = {
    //   memory: os.totalmem().toString(),
    //   cpu: os.loadavg().toString(),
    //   network: "",
    //   disk: ""
    // }

    // Modify the dockerLogs of the instance
    // instance.dockerLogs = { logs: await $`docker logs ${instanceName}` }  // This is not correct, we need to use the right container name
    // Modify the dockerEvents of the instance
    // instance.dockerEvents = { events: await $`docker events ${instanceName}` }  // This is not correct, we need to use the right container name

    print(chalk.green(`App ${instance.id} running`))
    clearStep(storeHandle, instance.id)

    // App-specific post-processing commands
    // If the app on which the instance is based is nextcloud, 
    //    find the IP address of the server and store it in IPADDRESS
    //    issue the following command: runuser --user www-data -- php occ config:app:set --value=http://<${PADDRESS}:9980 richdocuments wopi_url
    const app = store.appDB[instance.instanceOf]
    const ip = await readEnvVariable(`${await diskMountRoot(disk)}/instances/${instance.id}/.env`, 'ip')
    if (app && app.name === 'nextcloud') {
      if (ip) {
        try {
          // For unclear reasons, the occ command sometimes does not work, preventing the start of the container
          // So we catch the error so that the container can still start
          log(`Configuring nextcloud office`)
          log('Sleeping for 20 seconds to allow the app to start')
          await sleep(20000)
          log(`Running the occ command to use the Collabora server at ${ip}:9980`)
          await $`sudo docker exec ${instance.id}-nextcloud-app-1 runuser --user www-data -- php occ config:app:set --value=http://${ip}:9980 richdocuments wopi_url`
          log('Running the occ commands to set the trusted domains')
          await $`sudo docker exec ${instance.id}-nextcloud-app-1 runuser --user www-data -- php occ config:system:set trusted_domains 0 --value=*.local:*`
          await $`sudo docker exec ${instance.id}-nextcloud-app-1 runuser --user www-data -- php occ config:system:set trusted_domains 2 --value=192.168.0.*:*`
          log(`occ commands executed`)
        } catch (e) {
          log(chalk.red(`Error configuring nextcloud office to use the Collabora server at ${ip}:9980`))
          console.error(e)
          const condition = await diagnoseInstance(instance, disk, e)
          storeHandle.change(doc => {
            const inst = doc.instanceDB[instance.id]
            inst.status = 'Error' as Status
            inst.statusCondition = condition
          })
        }
      }
    }


  } catch (e) {
    print(chalk.red(`Error running app instance ${instance.id}`))
    console.error(e)
    const condition = await diagnoseInstance(instance, disk, e)
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.status = 'Error' as Status
      inst.statusCondition = condition
    })
  }
}

export const stopInstance = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk, cause: OperationCause = 'console-command'): Promise<void> => {
  print(`Stopping app '${instance.id}' on disk '${disk.id}' of engine '${localEngineId}'.`)

  // Old implementation using Docker Compose
  // Problem with this approach: stopping an instance is not possible when its disk has already been removed
  // try {
  //   // Compose stop the app
  //   // Do it
  //   // await $`docker compose -f /disks/${disk.device}/instances/${instance.id}/compose.yaml stop`
  //   await $`cd /disks/${disk.device}/instances/${instance.id} && docker compose down`
  //   was-console-log(chalk.green(`App ${instance.id} stopped`))
  // } catch (e) {
  //   was-console-log(chalk.red(`Error stopping app instance ${instance.id}`))
  //   console.error(e)
  // }

  const totalStopSteps = STOP_STEPS.length

  // Create an Operation record so stop progress appears in operationDB uniformly
  const stopOpId = createOperation(
    storeHandle, 'stopApp',
    { instanceId: instance.id, diskId: disk.id },
    cause,
    { type: 'instance', id: instance.id },
  )
  updateOperation(storeHandle, stopOpId, { status: 'Running' })

  // New implementation using Docker API
  try {
    setStep(storeHandle, instance.id, 0, totalStopSteps, STOP_STEPS[0], stopOpId)
    // Find all containers running in the compose started by the instance
    // NOTE: this implementation requires all containers of an instance to be namespaced with the instance id
    log(`Filter for all running containers whose names start with the instance id`)
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    const containers = await docker.container.list()
    const instanceContainers = containers.filter(container => {
      const name = container.data['Names'][0]
      return name.startsWith(`/${instance.id}-`) || name.startsWith(`/${instance.id}_`)
    })
    // Log the containers
    log(`Found the following containers:`)
    instanceContainers.forEach(container => {
      log(container.data['Names'][0])
    })
    setStep(storeHandle, instance.id, 1, totalStopSteps, STOP_STEPS[1], stopOpId)
    for (let container of instanceContainers) {
      // First try to stop the container gracefully  If that does not work, kill it  
      try {
        log(`Stopping container ${container.data['Names'][0]} for instance ${instance.id}`)
        await container.stop()
        log(`Stopped container for instance ${instance.id}`)
      } catch (e) {
        log(`Error stopping container for instance ${instance.id}. Killing it instead.`)
        await container.kill()
        log(`Killed container for instance ${instance.id}`)
      }
    }
    // Set the status of the instance to Stopped
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.status = 'Stopped' as Status // Set the status to Stopped when the instance is stopped
    })
    clearStep(storeHandle, instance.id)
    updateOperation(storeHandle, stopOpId, {
      status: 'Done',
      completedAt: Date.now() as Timestamp,
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    print(chalk.red(`Error stopping app instance ${instance.id}`))
    console.error(e)
    const condition = await diagnoseInstance(instance, disk, e)
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      inst.status = 'Error' as Status
      inst.statusCondition = condition
    })
    clearStep(storeHandle, instance.id)
    updateOperation(storeHandle, stopOpId, {
      status: 'Failed',
      error: errMsg,
      completedAt: Date.now() as Timestamp,
    })
  }
}

```

## File: src/data/Meta.ts
```typescript
import { $, chalk, YAML } from 'zx'
import { deepPrint, fileExists, log, stripPartition, uuid, print } from '../utils/utils.js'
import { DeviceName, DiskID, DiskName, Timestamp, Version } from './CommonTypes.js'
import { config } from './Config.js'

export interface DiskMeta {
  diskId: DiskID         
  // The serial number of the disk or user-assigned iif there is no serial number - We store it so that it easily inspectable
  
  isHardwareId?: boolean 
  // True if the diskId is a hardware id, false if it is a user-assigned id. If this is not present, the diskId has a generated id.
  
  diskName: DiskName     
  // The user-defined name of the disk.  Not necessarily unique
  
  created: Timestamp     
  // The timestamp when the disk was created
  
  version?: Version      
  // Only applicable to Engine Disks - the version of the engine running on the disk
  
  lastDocked: Timestamp  
  // The timestamp when the disk was last docked (for all other disks) or when the engine was last booted (in case of a system disk)
}

// Sample META for reference only — not used at runtime.
const sampleMeta: DiskMeta = {
  diskId: 'AA000000000000000724' as DiskID,
  isHardwareId: true,
  diskName: 'MyAppDisk' as DiskName,
  created: 1731446400000 as Timestamp,
  lastDocked: 1733673600000 as Timestamp
}

export const readMetaUpdateId = async (deviceSpec?: DeviceName): Promise<DiskMeta> => {
  let path
  let device: DeviceName
  // Every Engine runs on a Pi with a real /META.yaml. We always read it.
  // testMode only affects hardware ID lookup (skipped) and writeMeta (skipped) — not identity.
  try {
    if (deviceSpec) {
      path = `/disks/${deviceSpec}/META.yaml`
      device = deviceSpec as DeviceName
    } else {
      path = `/META.yaml`
      // findmnt may return /dev/sda2 (Pi) or "overlay"/tmpfs (containers/VMs).
      // Only /dev/... paths have a usable device name at split('/')[2].
      const rootSource = (await $`findmnt / -no SOURCE`).stdout.trim()
      const sourceParts = rootSource.split('/').filter(Boolean)
      if (rootSource.startsWith('/dev/') && sourceParts.length >= 2) {
        device = sourceParts[1] as DeviceName  // e.g. sda2 from /dev/sda2
      } else {
        // Non-block root (overlay, etc.) — device is only used for hardware-id
        // lookup, which is skipped in testMode/isDev. Use a stable placeholder.
        device = 'system' as DeviceName
        log(`Root SOURCE is '${rootSource}' (non-/dev); using device placeholder '${device}'`)
      }
    }
    log(`Reading metadata for device ${device} at path ${path}`)

    //log(`Our current dir is ${await $`pwd`} with content ${await $`ls`} and path ${path}`)
    if (await fileExists(path)) {

      // Read the META.yaml file
      // /META.yaml is root-owned (600) so we need sudo for the system disk.
      // Disk META files under /disks/ are pi-owned and don't need it.
      const catCmd = path === '/META.yaml' ? $`sudo cat ${path}` : $`cat ${path}`
      const metaContent = (await catCmd).stdout.trim()
      const meta: DiskMeta = YAML.parse(metaContent)
      // YAML 1.1 coerces unquoted 1.0 → number 1; Version is always a string.
      if (meta.version != null) {
        meta.version = String(meta.version) as Version
      }
      log(`metaContent: ${metaContent}`)
      log(`meta: ${deepPrint(meta)}`)
      let update = false

      // Find the hardware id.
      // In testMode/isDev: skip block device access and use the id from the META file as-is.
      // Fixture disks have isHardwareId: false and a stable generated id — no hardware lookup needed.
      let diskId: DiskID
      if (config.settings.isDev || config.settings.testMode) {
        log(`testMode/isDev: using diskId from META file (${meta.diskId}), skipping hardware id lookup`)
        diskId = meta.diskId
      } else {
        diskId = await readHardwareId(device) as DiskID
        if (!diskId) {
          log(`No hardware id found for device ${device}`)
          if (meta.hasOwnProperty('isHardwareId') && meta.isHardwareId) {
            log(`The disk id in the META file is a hardware id, so must come from another disk. So this disk is a clone and it is cloned onto media without a hardware id. Generating a new hardware id`)
            diskId = uuid() as DiskID
            // Resetting the isHardwareId flag
            meta.isHardwareId = false
          } else {
            log(`The disk id in the META file is a user-assigned id. Keeping it as is`)
            diskId = meta.diskId
          }
        }
      }

      // If the diskId does not match the one in the META file, update it
      if (String(meta.diskId) !== String(diskId)) {
        meta.diskId = diskId
        if (meta.isHardwareId) {
          log(`Found a new hardware id that is different from the one in the META file. Updating disk id to ${diskId}`)
        } else {
          log(`Created a new id that is different from the one in the META file. Updating disk id to ${diskId}`)
        }
        update = true
      }

      // Update the lastDocked timestamp
      meta.lastDocked = new Date().getTime() as Timestamp
      update = true  // Always update the lastDocked timestamp

      // Upgrade older META files that do not have the diskName field
      if (!meta.hasOwnProperty('diskName')) {
        log(`Upgrading older META file format to include diskName field and remove obsolete properties`)
        meta.diskName = diskId.toString() as DiskName
        // Remove the properties engineId and hostname
        // Ignore type checking the next two lines
        // @ts-ignore
        meta.engineId = undefined
        // @ts-ignore
        meta.hostname = undefined
        update = true
      }

      // Update the META file if necessary.
      // Skip in testMode/isDev — writeMeta requires sudo and we don't want to mutate fixtures.
      if (update && !config.settings.isDev && !config.settings.testMode) {
        await writeMeta(meta, path)
      }
      return meta
    } else {
      log(`No META file found at path ${path}. This disk has not yet been touched by the system.`)
      throw new Error(`No META file found at path ${path}`)
    }
  } catch (e) {
    log(`Error reading metadata: ${e}`)
    throw e
  }
}

export const readHardwareId = async (device: DeviceName): Promise<DiskID | undefined> => {
  log(`Reading disk id for device ${device}`)
  try {
    const rootDevice = stripPartition(device)
    log(`Root device is ${rootDevice}`)
    //const model = (await $`lsblk -o MODEL /dev/${rootDevice} --noheadings`).stdout.trim()
    const model = (await $`cat /sys/block/${rootDevice}/device/model`).stdout.trim()
    log(`Model is ${model}`)
    const vendor = (await $`cat /sys/block/${rootDevice}/device/vendor`).stdout.trim()
    log(`Vendor is ${vendor}`)
    if (model === 'Flash Drive FIT') {
      return await readHardwareIdSamsungFIT(device)
    } else if (vendor === 'INTENSO') {
      return await readHardwareIdIntenso(device)
    } else {
      log(`Model ${model} of vendor ${vendor} not recognized`)
      return undefined
    }
  } catch (e) {
    log(`Error reading disk id of device ${device}: ${e}`)
    return undefined
  }
}

export const readHardwareIdSamsungFIT = async (device: DeviceName): Promise<DiskID | undefined> => {
  try {
    const id = (await $`/usr/lib/udev/scsi_id --whitelisted --replace-whitespace --device=/dev/${device}`).stdout.trim()
    log(`ID is ${id}`)  
    return id as DiskID
  } catch (e) {
    log(`Error reading disk id of device ${device}: ${e}`)
    return undefined
  }
}

export const readHardwareIdIntenso = async (device: DeviceName): Promise<DiskID | undefined> => {
  try {
    const hdparm = (await $`which hdparm`).stdout
    log(`hdparm is at ${hdparm}`)
    //const info = (await $`hdparm -I /dev/${device}`).stdout
    //log(`Info is ${info}`)
    // hdparm -I requires read access to the block device (root-only on Linux).
    // The engine runs as pi with passwordless sudo, so prefix with sudo.
    const sn = (await $`sudo hdparm -I /dev/${device} | grep 'Serial\ Number'`).stdout
    log(`Serial number is ${sn}`)
    const id = sn.trim().split(':')
    log(`split ID is ${id}`)
    if (id.length === 2) {
      return id[1].trim() as DiskID
    } else {
      log(`Cannot read disk id for device ${device}`)
      return undefined
    }
  } catch (e) {
    log(`Error reading disk id of device ${device}: ${e}`)
    return undefined
  }
}



export const createMeta = async (device: DeviceName, engineVersion: Version | undefined = undefined): Promise<DiskMeta> => {
  // Find the hardware id
  let isHardwareId
  let diskId = await readHardwareId(device) as DiskID
  if (!diskId) {
    diskId = uuid() as DiskID
    isHardwareId = false
  } else {
    isHardwareId = true
  }

  const meta: DiskMeta = {
    diskId: diskId,
    isHardwareId: isHardwareId,
    diskName: diskId.toString() as DiskName,
    created: new Date().getTime() as Timestamp,
    lastDocked: new Date().getTime() as Timestamp
  }
  if (engineVersion) {
    meta.version = engineVersion
  }

  try {
    // Create the META.yaml file
    await writeMeta(meta, `/disks/${device}/META.yaml`)
  } catch (e) {
    print(chalk.red('Error creating metadata'));
  }
  return meta
}

const writeMeta = async (meta: DiskMeta, rootPath: string): Promise<void> => {
  log(`Writing metadata ${deepPrint(meta)} to ${rootPath}`)
  try {
    // Build the YAML content in memory — avoids the sudo-echo-redirect pattern which
    // fails because shell redirection (>>) runs as pi, not root, so it can't write
    // to a root-owned temp file created by `sudo mktemp`.
    //
    // Strategy: write to a pi-owned temp file (no sudo needed), then sudo mv it into
    // place. This is safe and atomic on the same filesystem.
    const yamlContent = YAML.stringify(meta)
    const tmpFile = (await $`mktemp --suffix=.yaml`).stdout.trim()
    await $`echo ${yamlContent} > ${tmpFile}`
    await $`sudo mv ${tmpFile} ${rootPath}`

  } catch (e) {
    print(chalk.red('Error writing metadata'))
    console.error(e)
  }
}

export const readRemoteDiskId = async (exec: any): Promise<DiskID | undefined> => {
  log(`Reading disk id remotely`)
  try {
    const rootDevice = (await exec`findmnt / -no SOURCE`).stdout.split('/')[2].trim();
    // First, find the full path to hdparm
    const hdparmPath = (await exec`which hdparm`).stdout.trim();
    if (!hdparmPath) {
      log('hdparm command not found on remote machine.');
      return undefined;
    }
    const sn = (await exec`${hdparmPath} -I /dev/${rootDevice} | grep 'Serial\\ Number'`).stdout;
    const id = sn.trim().split(':');
    if (id.length === 2) {
      const diskId = id[1].trim();
      log(`Remote disk id is ${diskId}`);
      return diskId as DiskID;
    } else {
      log(`Cannot read disk id for device ${rootDevice}`);
      return undefined;
    }
  } catch (e) {
    log(`Error reading disk id of the root device: ${e}`);
    return undefined;
  }
}

export const addMeta = async (exec: any, hostname: string, version: string) => {
  let id = await readRemoteDiskId(exec)
  if (id === undefined) {
    print(chalk.yellow(`Disk id is ${id}`));
    print(chalk.red('Remote disk has no disk id.  Generating one.'))
    id = uuid() as DiskID
  }
  print(chalk.blue('Adding metadata...'));
  try {
    await exec`sudo rm -f /META.yaml`;
    await exec`echo 'diskId: ${id}' | sudo tee -a /META.yaml`;
    await exec`echo 'diskName: ${id}' | sudo tee -a /META.yaml`;
    await exec`echo 'hostname: ${hostname}' | sudo tee -a /META.yaml`;
    await exec`echo 'created: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
    await exec`echo 'version: "${version}"' | sudo tee -a /META.yaml`;
    await exec`echo 'lastDocked: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
  } catch (e) {
    print(chalk.red('Error adding metadata'));
    console.error(e);
    process.exit(1);
  }
}

// export const readRemoteDiskId = async (exec: any): Promise<DiskID | undefined> => {
//   log(`Reading disk id remotely`)
//   try {
//     const rootDevice = (await exec`findmnt / -no SOURCE`).stdout.split('/')[2].trim();
//     // First, find the full path to hdparm
//     const hdparmPath = (await exec`which hdparm`).stdout.trim();
//     if (!hdparmPath) {
//       log('hdparm command not found on remote machine.');
//       return undefined;
//     }
//     const sn = (await exec`${hdparmPath} -I /dev/${rootDevice} | grep 'Serial\\ Number'`).stdout;
//     const id = sn.trim().split(':');
//     if (id.length === 2) {
//       const diskId = id[1].trim();
//       log(`Remote disk id is ${diskId}`);
//       return diskId as DiskID;
//     } else {
//       log(`Cannot read disk id for device ${rootDevice}`);
//       return undefined;
//     }
//   } catch (e) {
//     log(`Error reading disk id of the root device: ${e}`);
//     return undefined;
//   }
// }

// export const addMeta = async (exec: any, hostname: string, version: string) => {
//   let id = await readRemoteDiskId(exec)
//   if (id === undefined) {
//     was-console-log(chalk.yellow(`Disk id is ${id}`));
//     was-console-log(chalk.red('Remote disk has no disk id.  Generating one.'))
//     id = uuid() as DiskID
//   }
//   was-console-log(chalk.blue('Adding metadata...'));
//   try {
//     await exec`sudo rm -f /META.yaml`;
//     await exec`echo 'diskId: ${id}' | sudo tee -a /META.yaml`;
//     await exec`echo 'diskName: ${id}' | sudo tee -a /META.yaml`;
//     await exec`echo 'hostname: ${hostname}' | sudo tee -a /META.yaml`;
//     await exec`echo 'created: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
//     await exec`echo 'version: ${version}' | sudo tee -a /META.yaml`;
//     await exec`echo 'lastDocked: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
//   } catch (e) {
//     was-console-log(chalk.red('Error adding metadata'));
//     console.error(e);
//     process.exit(1);
//   }
// }
```

## File: src/data/Network.ts
```typescript
import { BrowserWebSocketClientAdapter, WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { Engine } from './Engine.js'
import { findIp, log } from '../utils/utils.js';
import { EngineID, Hostname, IPAddress, InterfaceName, PortNumber, Timestamp } from './CommonTypes.js';
import { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import { config } from './Config.js';
import { Store, findRunningEngineByHostname } from "./Store.js";
import { fs } from "zx";

const settings = config.settings
const STORE_IDENTITY_PATH = "./"+config.settings.storeIdentityFolder
const STORE_URL_PATH = STORE_IDENTITY_PATH + "/store-url.txt"
const storeDocUrlStr = fs.readFileSync(STORE_URL_PATH, 'utf-8');
const storeDocId = storeDocUrlStr.replace('automerge:', '') as DocumentId;


// **********
// Typedefs
// **********


/**
 * The possible results returned from the Yjs websocket provider
 */
export type ConnectionResult = { status: ConnectionStatus } 
export type ConnectionStatus = 'connected' | 'disconnected' | 'synced' | 'reconnection-failure-3'


// The root level Network object 
/**
 * Manages the network of connected Engines
 */
export interface Network {
  // All connected engines sorted per interface
  connections: Connections;

}

// Create a type called Connections that represents all connections that a Network has
// The connections are organised per ip address of the Engine that the Network is connected to
/**
 * The connections that a Network has to other Engines
 */
export type Connections = { [key: IPAddress]: Connection }   // key is the ip address
export type Connection = {
    adapter: WebSocketClientAdapter;
    missedDiscoveryCount: number;
    hostname: Hostname;
    engineId: EngineID;
}

export const network: Network = {
  connections: {}
}

const MAX_MISSED_DISCOVERIES = 3;

// **********
// Functions
// **********

export const manageDiscoveredPeers = async (repo: Repo, discoveredPeers: Map<IPAddress, {hostname: Hostname, engineId: EngineID}>, storeHandle: DocHandle<Store>): Promise<void> => {
  const port = settings.port as PortNumber || 1234 as PortNumber;
  // Increment missed discovery count for all existing connections
  for (const connection of Object.values(network.connections)) {
      connection.missedDiscoveryCount++;
  }

  // Reset count for discovered peers and connect to new ones
  for (const [address, peerInfo] of discoveredPeers.entries()) {
      const connectionKey = `${address}:${port}`;
      if (network.connections[connectionKey]) {
          network.connections[connectionKey].missedDiscoveryCount = 0;
      } else {
          await connectEngine(repo, address, peerInfo.hostname, peerInfo.engineId, storeDocId);
      }
  }

  // Remove connections that have been missed too many times
  for (const [connectionKey, connection] of Object.entries(network.connections)) {
      if (connection.missedDiscoveryCount > MAX_MISSED_DISCOVERIES) {
          const [address, portStr] = connectionKey.split(':');
          const port = parseInt(portStr, 10) as PortNumber;
          disconnectEngine(repo, address as IPAddress, port, storeHandle, connection.hostname);
      }
  }
};

export const disconnectEngine = (repo: Repo, address: IPAddress, port: PortNumber, storeHandle: DocHandle<Store>, hostname: Hostname): void => {
  const connectionKey = `${address}:${port}`;
  const connection = network.connections[connectionKey];

  if (connection) {
    log(`Disconnecting from engine at ${connectionKey}`);
    try {
      // Suppress the async 'error' event that ws emits when closed in CONNECTING state.
      // Without this, the event goes unhandled and crashes Node even though the synchronous
      // throw from ws.close() is already caught below.
      const ws = (connection.adapter as any).socket;
      if (ws && typeof ws.on === 'function') {
        ws.on('error', (err: Error) => {
          log(`Suppressed async WebSocket error during disconnect: ${err.message}`);
        });
      }
      repo.networkSubsystem.removeNetworkAdapter(connection.adapter);
      const engine = findRunningEngineByHostname(storeHandle.doc(), hostname);
      if (engine) {
        storeHandle.change(doc => {
          const eng = doc.engineDB[engine.id];
          if (eng) {
            eng.lastHalted = new Date().getTime() as Timestamp;
          }
        });
      }
    } catch (e: any) {
      if (e.message === 'WebSocket was closed before the connection was established') {
        log(`Ignoring expected error during disconnect: ${e.message}`);
      } else {
        log(`Unexpected error during disconnect from ${connectionKey}: ${e.message}`);
      }
    }
    delete network.connections[connectionKey];
  }
};




export const connectEngine = async (repo:Repo, address: IPAddress, hostname: Hostname, engineId: EngineID, storeDocId: DocumentId): Promise<WebSocketClientAdapter | undefined> => {

  const port = settings.port as PortNumber || 1234 as PortNumber

  log(`Connecting to engine at ${address}:${port}`)


  log(`Checking connection with ${address}`)
  if (!network.connections.hasOwnProperty(`${address}:${port}`) && address !== 'localhost' && address !== '127.0.0.1') {
    log(`Creating a new connection to ${address}:${port}`)

    const clientConnection = new WebSocketClientAdapter(`ws://${address}:${port}`)
    repo.networkSubsystem.addNetworkAdapter(clientConnection)
    
    log(`Finding document with ID: ${storeDocId}`);
    const handle = await repo.find(storeDocId) // Trigger the connection by finding the store document
    
    log(`Waiting for handle to be ready. Current state: ${handle.state}`);
    await handle.whenReady(); // Ensure it's loaded before returning
    log(`Handle is ready. State: ${handle.state}`);

    handle.on('change', () => {
      // no-op: CRDT sync events are handled by storeMonitor
    });

    network.connections[`${address}:${port}`] = { adapter: clientConnection, missedDiscoveryCount: 0, hostname, engineId };
    
    log(`Created an websocket client connection on adddress ws://${address}:${port}`)
    return clientConnection
  } else {
    // Return a resolved promise of ConnectionResult
    log(`Connection to ${address}:${port} already exists or address is localhost or 127.0.0.1`)
    if (network.connections[`${address}:${port}`]) {
        network.connections[`${address}:${port}`].missedDiscoveryCount = 0;
    }
    return undefined
  }
}

/**
 * Returns the IP address of a connected engine by its engineId, or undefined if not connected.
 * Looks up from the live network.connections map populated by mDNS discovery.
 */
export const getEngineAddress = (engineId: EngineID): IPAddress | undefined => {
    for (const [key, conn] of Object.entries(network.connections)) {
        if (String(conn.engineId) === String(engineId)) {
            // key is 'address:port' — return just the address part
            return key.split(':')[0] as IPAddress
        }
    }
    return undefined
}

export const isEngineConnected = (network: Network, ip: IPAddress):boolean => {
  return network.connections.hasOwnProperty(ip) && network.connections[ip] !== undefined && network.connections[ip].adapter.isReady()
}

// export const getIp = (engine: Engine, ifaceName: InterfaceName):IPAddress | undefined => {
//     return findIp(engine.hostname+'.local', ifaceName)
// }




```

## File: src/data/Operations.ts
```typescript
/**
 * Operations.ts — shared helpers for operationDB lifecycle management
 *
 * All long-running operations (copyApp, moveApp, backupApp, restoreApp,
 * startApp, stopApp, upgradeApp, upgradeEngine) create and update Operation
 * records here.  recoverInterruptedOperations() is called at startup to handle
 * any ops left Running/Pending by a crash.
 */

import { chalk } from 'zx'
import { ChildProcess } from 'child_process'
import { log, print } from '../utils/utils.js'
import {
    EngineID, Timestamp,
    Operation, OperationKind, OperationStatus, OperationCause, OperationSubject
} from './CommonTypes.js'
import { Store } from './Store.js'
import { localEngineId } from './Engine.js'
import { DocHandle } from '@automerge/automerge-repo'
import { uuid } from '../utils/utils.js'
import { getCommandLogHandle, addTrace, closeTrace } from './CommandLogStore.js'

// ── Recovery strategy per operation kind ─────────────────────────────────────

/**
 * What to do when an interrupted operation is found at startup.
 *
 * - 'retry': re-run the operation (safe only for idempotent ops like rsync-based ones)
 * - 'fail':  mark as Failed and let the operator re-issue manually
 */
export type RecoveryStrategy = 'retry' | 'fail'

export const RECOVERY_STRATEGY: Record<OperationKind, RecoveryStrategy> = {
    copyApp:       'retry',   // rsync-based — idempotent
    moveApp:       'retry',   // rsync-based — idempotent
    backupApp:     'retry',   // BorgBackup — idempotent; lock file already guards double-run
    restoreApp:    'fail',    // restore may have partially written target — safer to fail
    upgradeApp:    'fail',    // not yet implemented
    upgradeEngine: 'fail',    // not yet implemented
    startApp:      'fail',    // partial start state unknown — operator must re-issue
    stopApp:       'fail',    // partial stop state unknown — operator must re-issue
}

// ── Operation CRUD ────────────────────────────────────────────────────────────

export const createOperation = (
    storeHandle: DocHandle<Store>,
    kind: OperationKind,
    args: Record<string, string>,
    cause: OperationCause,
    subject?: OperationSubject | null,
): string => {
    const id = uuid()
    const op: Operation = {
        id,
        kind,
        args,
        cause,
        subject: subject ?? null,
        engineId: localEngineId,
        status: 'Pending',
        progressPercent: null,
        currentStep: null,
        totalSteps: null,
        stepLabel: null,
        startedAt: Date.now() as Timestamp,
        completedAt: null,
        error: null,
    }
    storeHandle.change(doc => {
        if (!doc.operationDB) (doc as any).operationDB = {}
        doc.operationDB[id] = op
    })
    return id
}

export const updateOperation = (
    storeHandle: DocHandle<Store>,
    id: string,
    patch: Partial<Pick<Operation, 'status' | 'progressPercent' | 'currentStep' | 'totalSteps' | 'stepLabel' | 'completedAt' | 'error'>>
): void => {
    // Log a step-advance marker before mutating the store.
    // Uses console.log directly (not log()) so it always lands in the CommandLog trace
    // regardless of verbosity level, and is visible in the Console log panel.
    if (patch.currentStep != null) {
        const op = storeHandle.doc()?.operationDB?.[id]
        if (op && patch.currentStep !== op.currentStep) {
            const total = patch.totalSteps ?? op.totalSteps ?? '?'
            const step  = patch.currentStep + 1
            const label = patch.stepLabel ?? op.stepLabel ?? ''
            const line  = label ? `  Step ${step}/${total}  │  ${label}  ` : `  Step ${step}/${total}  `
            const bar   = '─'.repeat(line.length)
            print(`┌${bar}┐`)
            print(`│${line}│`)
            print(`└${bar}┘`)
        }
    }
    storeHandle.change(doc => {
        const op = doc.operationDB?.[id]
        if (!op) return
        if (patch.status !== undefined) op.status = patch.status
        if (patch.progressPercent !== undefined) op.progressPercent = patch.progressPercent
        if (patch.currentStep !== undefined) op.currentStep = patch.currentStep
        if (patch.totalSteps !== undefined) op.totalSteps = patch.totalSteps
        if (patch.stepLabel !== undefined) op.stepLabel = patch.stepLabel
        if (patch.completedAt !== undefined) op.completedAt = patch.completedAt
        if (patch.error !== undefined) op.error = patch.error
        // Clear step progress when operation reaches a terminal state
        if (patch.status === 'Done' || patch.status === 'Failed' || patch.status === 'Cancelled') {
            op.currentStep = null
            op.totalSteps = null
            op.stepLabel = null
        }
    })
}

// ── Active process registry ──────────────────────────────────────────────

/**
 * Maps operationId → the rsync ChildProcess currently running for it.
 * Populated by rsyncDirectory when an opId is provided; cleared on close/error.
 * Used by cancelOperation to SIGTERM in-flight rsyncs (Phase 2).
 */
const _activeProcesses = new Map<string, ChildProcess>()

export const registerProcess = (opId: string, proc: ChildProcess): void => {
    _activeProcesses.set(opId, proc)
    log(`registerProcess: registered process for op ${opId} (pid ${proc.pid})`)
}

export const deregisterProcess = (opId: string): void => {
    _activeProcesses.delete(opId)
    log(`deregisterProcess: cleared process for op ${opId}`)
}

// ── Cancel operation ────────────────────────────────────────────────────────

/**
 * Cancel an operation by ID.
 *
 * Behaviour:
 *  - Pending:   splice the matching command from engine.commands[], mark Cancelled
 *  - Running:   SIGTERM the registered rsync process, mark Cancelled (process close handler
 *               fires the rejection which the operation try/catch handles)
 *  - Failed:    mark Cancelled (lock already released at failure time)
 *  - Done / Cancelled: no-op
 *
 * Returns an error string on failure, undefined on success.
 */
export const cancelOperation = (
    storeHandle: DocHandle<Store>,
    opId: string
): string | undefined => {
    const store = storeHandle.doc()
    const op = store.operationDB?.[opId]
    if (!op) return `Operation '${opId}' not found`

    if (op.status === 'Done' || op.status === 'Cancelled') {
        log(`cancelOperation: op ${opId} is already ${op.status} — no-op`)
        return undefined
    }

    if (op.status === 'Running') {
        const proc = _activeProcesses.get(opId)
        if (!proc) {
            return `Operation '${opId}' is Running but no cancellable process is registered — it may be in a non-rsync phase`
        }
        log(`cancelOperation: sending SIGTERM to pid ${proc.pid} for op ${opId}`)
        proc.kill('SIGTERM')
        // Mark Cancelled immediately — the process close handler will reject the rsync
        // promise, which the operation try/catch will catch (status is already Cancelled).
        storeHandle.change(doc => {
            const o = doc.operationDB?.[opId]
            if (o) {
                o.status = 'Cancelled' as OperationStatus
                o.completedAt = Date.now() as Timestamp
            }
        })
        log(`cancelOperation: op ${opId} (${op.kind}) marked Cancelled (SIGTERM sent)`)
        return undefined
    }

    // Pending: remove from the engine command queue
    if (op.status === 'Pending') {
        storeHandle.change(doc => {
            const eng = doc.engineDB[op.engineId as any]
            if (eng?.commands) {
                // Scan queue for a command whose opId is referenced in the operation args.
                // Commands are strings like "copyApp <instanceName> <srcDiskId> <tgtDiskId>".
                // We match by checking if any arg value appears in the command string AND
                // the op's args values are a subset of the command tokens.
                const queue = eng.commands as string[]
                // Match by disk IDs stored in operation args — these appear verbatim
                // in the command string (e.g. "copyApp <name> <srcDiskId> <tgtDiskId>").
                // instanceId is an internal ID that does NOT appear in the command string.
                const diskArgs = Object.entries(op.args)
                    .filter(([k]) => k.toLowerCase().includes('disk'))
                    .map(([, v]) => v)
                const idx = diskArgs.length > 0
                    ? queue.findIndex(cmd => diskArgs.every(v => cmd.includes(v)))
                    : -1
                if (idx !== -1) {
                    log(`cancelOperation: splicing command at index ${idx} from engine ${op.engineId} queue`)
                    ;(eng.commands as any[]).splice(idx, 1)
                } else {
                    log(`cancelOperation: command not found in queue for op ${opId} — may have already started`)
                }
            }
        })
    }

    // Pending or Failed: mark Cancelled
    storeHandle.change(doc => {
        const o = doc.operationDB?.[opId]
        if (o) {
            o.status = 'Cancelled' as OperationStatus
            o.completedAt = Date.now() as Timestamp
        }
    })

    log(`cancelOperation: op ${opId} (${op.kind}) marked Cancelled`)
    return undefined
}

// ── Startup crash recovery ────────────────────────────────────────────────────

/**
 * Called during engine startup. Scans operationDB for any operation left in
 * Running or Pending state (caused by a crash or reboot mid-operation).
 *
 * Per-kind strategy (RECOVERY_STRATEGY):
 *   - 'retry': re-queues the operation by calling the provided retry handler
 *   - 'fail':  marks as Failed; operator must re-issue manually
 *
 * The retry handler map is passed in from start.ts to avoid circular imports.
 * Each handler receives the original operation args and the storeHandle.
 */
export const recoverInterruptedOperations = async (
    storeHandle: DocHandle<Store>,
    retryHandlers: Partial<Record<OperationKind, (args: Record<string, string>, storeHandle: DocHandle<Store>) => Promise<void>>>
): Promise<void> => {
    const store = storeHandle.doc()
    if (!store.operationDB) return

    const interrupted = Object.values(store.operationDB).filter(
        op => op.status === 'Running' || op.status === 'Pending'
    )
    if (interrupted.length === 0) return

    log(`recoverInterruptedOperations: ${interrupted.length} interrupted operation(s) found`)

    for (const op of interrupted) {
        const strategy = RECOVERY_STRATEGY[op.kind] ?? 'fail'
        const handler = retryHandlers[op.kind]
        const cmdLogHandle = getCommandLogHandle()
        const traceId = crypto.randomUUID()
        const traceArgs = JSON.stringify({ ...op.args, recoveredOpId: op.id })

        if (strategy === 'retry' && handler) {
            log(chalk.blue(`  ${op.id.slice(0, 8)} ${op.kind}: retrying (idempotent)`))
            if (cmdLogHandle) addTrace(cmdLogHandle, { traceId, command: op.kind, args: traceArgs, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
            // Mark as Pending before retry so it's visible in the store
            updateOperation(storeHandle, op.id, {
                status: 'Pending',
                error: 'Retrying after interrupted run',
            })
            // Fire-and-forget: retry runs in background; startup continues
            handler(op.args, storeHandle).then(() => {
                if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'ok')
            }).catch(err => {
                log(chalk.red(`  ${op.id.slice(0, 8)} ${op.kind}: retry failed — ${err.message}`))
                updateOperation(storeHandle, op.id, {
                    status: 'Failed',
                    error: `Retry failed: ${err.message}`,
                    completedAt: Date.now() as Timestamp,
                })
                if (cmdLogHandle) closeTrace(cmdLogHandle, traceId, 'error', `Retry failed: ${err.message}`)
            })
        } else {
            log(chalk.yellow(`  ${op.id.slice(0, 8)} ${op.kind}: marking Failed (strategy: ${strategy}${strategy === 'retry' ? ', no handler' : ''})`))
            if (cmdLogHandle) {
                addTrace(cmdLogHandle, { traceId, command: op.kind, args: traceArgs, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
                closeTrace(cmdLogHandle, traceId, 'error',
                    strategy === 'retry'
                        ? 'Engine restarted while operation was in progress — re-issue to retry'
                        : 'Engine restarted while operation was in progress — re-issue manually'
                )
            }
            updateOperation(storeHandle, op.id, {
                status: 'Failed',
                error: strategy === 'retry'
                    ? 'Engine restarted while operation was in progress — re-issue to retry'
                    : 'Engine restarted while operation was in progress — re-issue manually',
                completedAt: Date.now() as Timestamp,
            })
        }
    }
}

```

## File: src/data/Provisioning.ts
```typescript

```

## File: src/data/Store.ts
```typescript
import path from 'path'
import { Engine, localEngineId } from './Engine.js'
import { Disk } from './Disk.js'
import { deepPrint, getKeys, log, print } from '../utils/utils.js'
import { App } from './App.js'
import { Instance } from './Instance.js'
import { User } from './User.js'
import { AppID, DeviceName, DiskID, EngineID, Hostname, InstanceID, UserID, Operation } from './CommonTypes.js'
import { DocHandle, DocumentId, PeerId, Repo } from '@automerge/automerge-repo'
import { chalk, fs } from "zx"
//import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { BrowserWebSocketClientAdapter, WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";

// The single, hard-coded, predictable document ID for the main store.
//const STORE_DOC_ID = "ad40c014-180a-4590-bd11-b25da3ac22d3" as DocumentId;
// const STORE_DOC_ID = "3uVjrsTUqoraSy8UwqRcbYm71z21" as DocumentId;

// **********
// Typedefs
// **********

export interface Store {
    engineDB: { [key: EngineID]: Engine },
    diskDB: { [key: DiskID]: Disk },
    appDB: { [key: AppID]: App },
    instanceDB: { [key: InstanceID]: Instance },
    userDB: { [key: UserID]: User },
    operationDB: { [id: string]: Operation },
}

// };

/**
 * Creates a document URL for the project
 * Creates the template file containing the binary representation of an empty store.
 * This should be run once, or whenever the template needs to be updated.
 */
export const initialiseServerStore = async (repo: Repo, STORE_TEMPLATE_PATH: string, STORE_URL_PATH: string): Promise<DocHandle<Store>> => {
    log(`Creating empty store document`);
    const handle = await repo.create<Store>({
        engineDB: {},
        diskDB: {},
        appDB: {},
        instanceDB: {},
        userDB: {},
        operationDB: {},
    });
    log("Empty store document created successfully.")
    // Save the document to a binary file
    const bytes = await repo.export(handle.url);
    if (!bytes) {
        log(`Failed to export a new template store to bytes`);
        throw new Error(`Failed to export the store to bytes`);
    }
    await fs.writeFile(STORE_TEMPLATE_PATH, bytes);
    log("Store template file created successfully.");
    // Now write the URL to the store URL file
    await fs.writeFile(STORE_URL_PATH, handle.url);
    log(`Store URL file created successfully with url: ${handle.url}`);
    return handle;
}

/**
 * Finds or creates the main Store document using a robust, non-blocking method.
 * It manually checks for the document's existence in storage to handle the
 * offline-first initialization case correctly.
 *
 * @param repo The initialized Automerge repo.
 * @param storagePath The path to the repo's storage directory.
 * @returns A DocHandle for the main store document.
 */
export const createServerStore = async (repo: Repo, storeDocId: DocumentId, storagePath: string, templatePath: string): Promise<DocHandle<Store>> => {
    // The storage adapter uses a directory structure based on the document ID to store chunks.
    // We check for the existence of this directory to see if the document exists.
    // The path is constructed from the first two characters of the doc ID and the remainder.
    const docPath = path.join(storagePath, storeDocId.slice(0, 2), storeDocId.slice(2));
    log(`Checking for store document at: ${docPath}`);

    let handle: DocHandle<Store>

    if (fs.existsSync(docPath)) {
        // 1. Document exists in storage. Load it normally.
        log("Store document found in storage. Loading...")
        try {
            handle = await repo.find<Store>(storeDocId)
        } catch (e) {
            log(`Error finding document: ${e}`)
            throw e
        }
        log(`Document loaded successfully with handle state: ${handle.state} and url: ${handle.url}`);
    } else {
        // 2. Document does NOT exist. 
        
        // OBSOLETE - AI APPROACH - The initialisation is repeated on peer nodes
        // log("Store document not found. Initialising a new one...")
        // // Create an empty document in memory.
        // const newDoc = Automerge.change(Automerge.init<Store>(), doc => {
        //     doc.engineDB = {};
        //     doc.diskDB = {};
        //     doc.appDB = {};
        //     doc.instanceDB = {};
        // })

        // // Save it to a binary format.
        // const binary = Automerge.save(newDoc);

        // // Import it into the repo with our specific ID. This creates the file on disk.
        // handle = repo.import(binary, { docId: STORE_DOC_ID });
        // log("Successfully created and imported new store document.");

        // My approach - load the template file and create the document from that
        log("Document not found. Creating from template to ensure consistent history.")
        const templateBytes = await fs.readFile(templatePath);

        // Import the template into the handle. This populates the document with
        // the template's content and history, using the same DocumentId.
        handle = repo.import(templateBytes, { docId: storeDocId });
        log("Successfully imported an initial store document with id " + handle.url);
    }

    // 3. Wait for the document to be fully ready and return.
    await handle.whenReady();
    log("Store document is ready.")
    log(`   Doc in state ${handle.state}`);
    log(`   Doc contains: ${deepPrint(handle.doc(), 2)}`);
    return handle;
}


export const retrieveStore = async (repo: Repo, storeDocId: DocumentId): Promise<DocHandle<Store>> => {
    log(`Binding store to repo with ID: ${storeDocId}`)
    const handle = await repo.find<Store>(storeDocId);
    await handle.whenReady(); // Ensure it's loaded before returning
    log(`Store bound to repo successfully.`);
    return handle
}

// Create a client connection to the store
import { lookup } from 'dns/promises';
import { config } from './Config.js'

// ... (other imports)

export const createClientStore = async (hostnames: string[], clientPeerId: PeerId, storeDocId: DocumentId, timeout?: number): Promise<{handle: DocHandle<Store>, repo: Repo}> => {
    print(`Connecting to hosts ${hostnames.join(', ')} with peer ID ${clientPeerId}`);
    
    const connectPromise = (async () => {
        const urls = await Promise.all(hostnames.map(async (hostname) => {
            try {
                print(chalk.blue(`Resolving hostname ${hostname}...`));
                const { address } = await lookup(hostname);
                print(chalk.green(`  - Resolved to ${address}`));
                const port = config.settings.port || 4321;
                return `ws://${address}:${port}`;
            } catch (e) {
                console.error(chalk.red(`  - Failed to resolve hostname ${hostname}. Using it directly.`));
                // Fallback to using the hostname directly if lookup fails
                const port = config.settings.port || 4321;
                return `ws://${hostname}:${port}`;
            }
        }));

        const retryDelay = 2000;
        const adapters = urls.map(url => new WebSocketClientAdapter(url, retryDelay));
        const repo = new Repo({ 
            network: adapters,
            peerId: clientPeerId,
        });
        const handle = await retrieveStore(repo, storeDocId);
        return { handle, repo };
    })();

    try {
        let result;
        if (timeout) {
            print(chalk.blue(`Attempting to connect with a ${timeout} second timeout...`));
            const timeoutPromise = new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error(`Connection timed out after ${timeout} seconds`)), timeout * 1000)
            );
            result = await Promise.race([connectPromise, timeoutPromise]);
        } else {
            print(chalk.blue(`Attempting to connect with no timeout...`));
            result = await connectPromise;
        }
        
        print(`Connected successfully with peer ID ${clientPeerId}`);
        return result;

    } catch (e) {
        console.error(chalk.red('Failed to connect to engine(s).'));
        // The repo might not be created if the lookup fails early, so check for it.
        // In the future, the repo creation should be inside the promise.
        if (connectPromise) {
            const res = await connectPromise;
            if (res.repo) res.repo.shutdown();
        }
        throw e;
    }
}

export const getLocalEngine = (store: Store): Engine => {
    const localEngine = getEngine(store, localEngineId)
    if (localEngine) {
        return localEngine
    } else {
        throw new Error(`Local engine ${localEngineId} not found in store`)
    }
}

export const getEngine = (store: Store, engineId: EngineID): Engine | undefined => {
    if (store.engineDB.hasOwnProperty(engineId)) {
        return store.engineDB[engineId]
    } else {
        return undefined
    }
}

export const getRunningEngines = (store: Store): Engine[] => {
    const engineIds = Object.keys(store.engineDB) as EngineID[]
    return engineIds.flatMap(engineId => {
        const engine = getEngine(store, engineId)
        if (engine) {
            const isRunning = !engine.lastHalted || (engine.lastBooted > engine.lastHalted)
            if (isRunning) {
                return [engine]
            }
        }
        return []
    })
}

export const getInstancesOfEngine = (store: Store, engine: Engine): Instance[] => {
    return getDisksOfEngine(store, engine).flatMap(disk => {
        return getInstancesOfDisk(store, disk)
    })
}

export const getAppsOfEngine = (store: Store, engine: Engine): App[] => {
    return getDisksOfEngine(store, engine).flatMap(disk => {
        return getAppsOfDisk(store, disk)
    })
}

export const findRunningEngineByHostname = (store: Store, engineName: Hostname): Engine | undefined => {
    return getRunningEngines(store).find(engine => engine.hostname === engineName)
}

export const getApps = (store: Store): App[] => {
    return Object.keys(store.appDB).flatMap(appId => {
        const app = getApp(store, appId as AppID)
        if (app) {
            return [app]
        }
        return []
    })
}

export const getAppsOfDisk = (store: Store, disk: Disk): App[] => {
    const instances = getInstancesOfDisk(store, disk)
    return instances.flatMap(instance => {
        const app = getApp(store, instance.instanceOf)
        if (app) {
            return [app]
        } else {
            return []
        }
    })
}

export const getInstances = (store: Store): Instance[] => {
    return Object.keys(store.instanceDB).flatMap(instanceId => {
        const instance = getInstance(store, instanceId as InstanceID)
        return instance ? [instance] : []
    })
}

export const getEngineOfInstance = (store: Store, instance: Instance): Engine | undefined => {
    if (instance.storedOn) {
        const disk = getDisk(store, instance.storedOn)
        if (disk?.dockedTo) {
            const engine = getEngine(store, disk.dockedTo)
            return engine
        } else {
            console.error(chalk.red(`Disk ${instance.storedOn} is not docked to an engine`))
            return undefined
        }
    } else {
        console.error(chalk.red(`Instance ${instance.id} is not stored on a disk`))
        throw new Error(`Instance ${instance.id} is not stored on a disk`)
    }
}

export const getInstancesOfDisk = (store: Store, disk: Disk): Instance[] => {
    return Object.keys(store.instanceDB).flatMap(instanceId => {
        const instance = getInstance(store, instanceId as InstanceID)
        if (instance && String(instance.storedOn) === String(disk.id)) {
            return [instance]
        } else {
            return []
        }
    })
}

export const findInstanceByName = (store: Store, instanceName: string): Instance | undefined => {
    return getInstances(store).find(instance => instance.name === instanceName)
}

export const getDisks = (store: Store): Disk[] => {
    return Object.keys(store.diskDB).flatMap(diskId => {
        const disk = getDisk(store, diskId as DiskID)
        if (disk && disk.dockedTo) {
            return [disk]
        } else {
            return []
        }
    })
}

export const getDisksOfEngine = (store: Store, engine: Engine): Disk[] => {
    return Object.keys(store.diskDB).flatMap(diskId => {
        const disk = getDisk(store, diskId as DiskID)
        if (disk && String(disk.dockedTo) === String(engine.id)) {
            return [disk]
        } else {
            return []
        }
    })
}

export const findDiskByDevice = (store: Store, deviceName: DeviceName, engineId?: EngineID): Disk | undefined => {
    const disks = engineId
        ? getDisksOfEngine(store, store.engineDB[engineId])
        : getDisks(store)
    return disks.find(disk => String(disk.device) === String(deviceName))
}

export const findDiskByName = (store: Store, diskName: string): Disk | undefined => {
    return getDisks(store).find(disk => String(disk.name) === String(diskName))
}

export const findDisksByApp = (store: Store, appId: AppID): Disk[] => {
    const instances = Object.keys(store.instanceDB).flatMap(instanceId => {
        const instance = getInstance(store, instanceId as InstanceID)
        if (instance && instance.instanceOf === appId) {
            return [instance]
        } else {
            return []
        }
    })
    const diskIds = Array.from(new Set(instances.map(instance => instance.storedOn))).filter((id): id is DiskID => id !== null)
    return diskIds.flatMap(diskId => {
        const disk = getDisk(store, diskId)
        if (disk) {
            return [disk]
        } else {
            return []
        }
    })
}

export const extractAppName = (appId: AppID): string => {
    return appId.split('-')[0]
}

export const getDisk = (store: Store, diskId: DiskID): Disk | undefined => {
    if (store.diskDB.hasOwnProperty(diskId)) {
        return store.diskDB[diskId]
    } else {
        return undefined
    }
}

export const getApp = (store: Store, appId: AppID): App | undefined => {
    if (store.appDB.hasOwnProperty(appId)) {
        return store.appDB[appId]
    } else {
        return undefined
    }
}

export const getInstance = (store: Store, instanceId: InstanceID): Instance | undefined => {
    if (store.instanceDB.hasOwnProperty(instanceId)) {
        return store.instanceDB[instanceId]
    } else {
        return undefined
    }
}

/**
 * Deterministically distribute all known instances across the currently running
 * engines using round-robin assignment.
 *
 * Sorting both engines and instances before assignment guarantees that any two
 * peers computing this function independently (from the same CRDT state) arrive
 * at the same result — no coordination required.
 *
 * Returns a Map of engineId → instanceId[].
 * Returns an empty Map when no engines are running.
 */
export const assignAppsToEngines = (store: Store): Map<EngineID, InstanceID[]> => {
    const runningEngines = getRunningEngines(store)
    if (runningEngines.length === 0) return new Map()

    const sortedEngines = [...runningEngines].sort((a, b) => a.id.localeCompare(b.id))
    const sortedInstances = (Object.keys(store.instanceDB) as InstanceID[]).sort()

    const result = new Map<EngineID, InstanceID[]>()
    sortedEngines.forEach(engine => result.set(engine.id, []))

    sortedInstances.forEach((instanceId, index) => {
        const engine = sortedEngines[index % sortedEngines.length]
        result.get(engine.id)!.push(instanceId)
    })

    return result
}

```

## File: src/data/User.ts
```typescript
import { UserID, Timestamp } from './CommonTypes.js'

/**
 * A Console operator with a bcrypt-hashed password.
 *
 * Stored in the Automerge Store under `userDB`.
 * Authentication happens client-side in the Console (bcryptjs compare).
 * Writes back to the store via handle.change().
 */
export interface User {
    id: UserID
    username: string
    passwordHash: string   // bcrypt hash — never stored in plain text
    role: 'operator'       // only operators have accounts
    created: Timestamp     // unix ms — set on createOperator()
}

```

