import { CommandDefinition } from "./CommandDefinition.js";
import { Store, getApps, getDisks, getDisk, getRunningEngines, getInstances, getEngine, findDiskByName, findInstanceByName, getLocalEngine, createClientStore } from "./Store.js";
import { deepPrint } from "../utils/utils.js";
import { buildInstance, startInstance, runInstance, stopInstance } from "./Instance.js";
import { buildEngine, syncEngine, clearKnownHost, rebootEngine } from "./Engine.js";
import { AppName, Command, DiskName, EngineID, Hostname, InstanceName, Version } from "./CommonTypes.js";
import { localEngineId } from "./Engine.js";
import { chalk, fs, $ } from "zx";
import { ssh } from '../utils/ssh.js'

$.verbose = false;
import { DocHandle, Repo } from "@automerge/automerge-repo";
import { config } from "./Config.js";
import { generateHostName } from "../utils/nameGenerator.js";
import pack from '../../package.json' with { type: "json" };
import { sendCommand } from "../utils/commandUtils.js";
import { undockDisk } from "../monitors/usbDeviceMonitor.js";
import { backupInstance, restoreApp, createBackupDiskConfig } from "../monitors/backupMonitor.js";
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
        console.log(chalk.blue("Disconnecting test runner..."));
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
    console.log(chalk.blue(`Executing remote buildEngine command with args: ${argsString}`));

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
        console.log(chalk.green('buildEngine command finished successfully.'));
    } catch (e: any) {
        console.error(chalk.red(`buildEngine command failed: ${e.message}`));
    }
}

const ls = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    console.log('NetworkData on this engine:');
    console.log(deepPrint(storeHandle.doc()), 3);
}

const lsEngines = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    console.log('Engines:');
    const engines = getRunningEngines(storeHandle.doc());
    console.log(`Total engines: ${engines.length}`);
    console.log(deepPrint(engines, 2));
}

const lsDisks = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    console.log('Disks:');
    const disks = getDisks(storeHandle.doc());
    console.log(`Total disks: ${disks.length}`);
    console.log(deepPrint(disks, 2));
}

const lsApps = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    console.log('Apps:');
    const apps = getApps(storeHandle.doc());
    console.log(`Total apps: ${apps.length}`);
    console.log(deepPrint(apps, 2));
}

const lsInstances = (storeHandle: DocHandle<Store> | null): void => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    console.log('Instances:');
    const instances = getInstances(storeHandle.doc());
    console.log(`Total instances: ${instances.length}`);
    console.log(deepPrint(instances, 2));
}

const buildInstanceWrapper = async (storeHandle: DocHandle<Store>, instanceName: InstanceName, appName: AppName, gitAccount: string, gitTag: string, diskName: DiskName) => {
    const store = storeHandle.doc()
    if (!store) {
        console.error(chalk.red("Store is not available to create instance."));
        return;
    }
    const disk = findDiskByName(store, diskName)
    if (!disk || !disk.device) {
        console.log(chalk.red(`Disk '${diskName}' not found or has no device on engine ${localEngineId}`))
        return
    }
    await buildInstance(instanceName, appName, gitAccount, gitTag as Version, disk.device)
}

const startInstanceWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, diskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available.")); return; }
    const store = storeHandle.doc()
    const instance = findInstanceByName(store, instanceName)
    if (!instance) {
        console.log(chalk.red(`Instance ${instanceName} not found`))
        return
    }
    // Look up disk by ID from instance.storedOn — same fix as stopInstanceWrapper.
    // findDiskByName uses getDisks() which filters dockedTo != null and misses
    // disks that appear undocked in the CRDT but are physically still attached.
    const disk = (instance.storedOn ? getDisk(store, instance.storedOn) : undefined) ?? findDiskByName(store, diskName)
    if (!disk) {
        console.log(chalk.red(`Disk '${diskName}' not found or has no device on engine ${localEngineId}`))
        return
    }
    startInstance(storeHandle, instance, disk)
}

const runInstanceWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, diskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available.")); return; }
    const store = storeHandle.doc()
    const instance = findInstanceByName(store, instanceName)
    const disk = findDiskByName(store, diskName)
    if (!instance) {
        console.log(chalk.red(`Instance ${instanceName} not found`))
        return
    }
    if (!disk) {
        console.log(chalk.red(`Disk ${diskName} not found`))
        return
    }
    runInstance(storeHandle, instance, disk)
}

const stopInstanceWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, diskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available.")); return; }
    const store = storeHandle.doc()
    const instance = findInstanceByName(store, instanceName)
    if (!instance) {
        console.log(chalk.red(`Instance ${instanceName} not found`))
        return
    }
    // Look up disk by ID from instance.storedOn — not via getDisks() which filters
    // to dockedTo != null and would miss disks that appear undocked in the CRDT.
    const disk = (instance.storedOn ? getDisk(store, instance.storedOn) : undefined) ?? findDiskByName(store, diskName)
    if (!disk) {
        console.log(chalk.red(`Disk '${diskName}' not found or has no device on engine ${localEngineId}`))
        return
    }
    stopInstance(storeHandle, instance, disk)
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
    console.log(chalk.blue(`Backing up instance '${instanceName}' to disk '${backupDisk.name}'...`))
    await backupInstance(storeHandle, instance.id, backupDisk as any)
}

const restoreAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, targetDiskName: DiskName) => {
    if (!storeHandle) { console.error(chalk.red("Store is not available. Please connect first.")); return; }
    const store = storeHandle.doc()
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) { console.error(chalk.red(`Instance '${instanceName}' not found in store.`)); return; }

    const targetDisk = Object.values(store.diskDB).find(d => d.name === targetDiskName && d.device != null)
    if (!targetDisk) { console.error(chalk.red(`Target disk '${targetDiskName}' not found or not docked.`)); return; }

    console.log(chalk.blue(`Restoring instance '${instanceName}' to disk '${targetDiskName}'...`))
    await restoreApp(storeHandle, instance.id, targetDisk as any)
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

    console.log(chalk.blue(`Creating Backup Disk config on '${diskName}' (mode: ${mode})...`))
    await createBackupDiskConfig(storeHandle, disk as any, mode as any, instanceIds)
    console.log(chalk.green(`Backup Disk '${diskName}' configured.`))
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
    console.log(chalk.blue(`Ejecting disk '${diskName}'...`));
    await undockDisk(storeHandle, disk);
    console.log(chalk.green(`Disk '${diskName}' ejected successfully.`));
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
    { name: "createInstance", execute: buildInstanceWrapper, args: [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }], scope: 'engine' },
    { name: "startInstance", execute: startInstanceWrapper, args: [{ type: "string" }, { type: "string" }], scope: 'engine' },
    { name: "runInstance", execute: runInstanceWrapper, args: [{ type: "string" }, { type: "string" }], scope: 'engine' },
    { name: "stopInstance", execute: stopInstanceWrapper, args: [{ type: "string" }, { type: "string" }], scope: 'engine' },
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
    { name: "ejectDisk", execute: ejectDiskWrapper, args: [{ type: "string" }], scope: 'engine' },
    { name: "backupApp", execute: backupAppWrapper, args: [{ type: "string" }, { type: "string" }], scope: 'engine' },
    { name: "restoreApp", execute: restoreAppWrapper, args: [{ type: "string" }, { type: "string" }], scope: 'engine' },
    { name: "createBackupDisk", execute: createBackupDiskWrapper, args: [{ type: "string" }, { type: "string" }, { type: "string" }], scope: 'engine' },
];
