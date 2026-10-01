import { CommandDefinition } from "./CommandDefinition.js";
import { Store, getApps, getDisks, getDisk, getRunningEngines, getInstances, getEngine, findDiskByName, findInstanceByName, getLocalEngine, createClientStore } from "./Store.js";
import { Disk, clearDuplicateDiskRecords, isSystemDiskRecord } from "./Disk.js";
import { deepPrint, log, print } from "../utils/utils.js";
import { buildInstance, startInstance, runInstance, stopInstance, markInstanceError } from "./Instance.js";
import { buildEngine, syncEngine, clearKnownHost, rebootEngine } from "./Engine.js";
import { AppName, Command, DeviceName, DiskID, DiskName, EngineID, Hostname, InstanceName, Version } from "./CommonTypes.js";
import { localEngineId } from "./Engine.js";
import { chalk, fs, $ } from "zx";
import { ssh } from '../utils/ssh.js'

$.verbose = false;
import { DocHandle, Repo } from "@automerge/automerge-repo";
import { config } from "./Config.js";
import { readStoreDocId } from "./StoreIdentity.js";
import { generateHostName } from "../utils/nameGenerator.js";
import pack from '../../package.json' with { type: "json" };
import { sendCommand } from "../utils/commandUtils.js";
import { installApp } from './InstallApp.js';
import { copyApp, moveApp } from './CopyMoveApp.js';
import { resourceLock, diskKey } from '../utils/ResourceLock.js';
import { undockDisk } from "../monitors/usbDeviceMonitor.js";
import { backupInstance, restoreApp, createBackupDiskConfig, runningBackupOnDisk } from "../monitors/backupMonitor.js";
import { cancelOperation } from './Operations.js';
import { DiskArgResult, lookupDiskArg, resolveDiskArg } from './DiskArg.js';
import { createFilesDisk } from './CreateFilesDisk.js';
import { summariseDisk, attachTraceResult } from './SummariseDisk.js';
import { eraseDisk } from './EraseDisk.js';
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
    const DOCUMENT_ID = readStoreDocId() as any;

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
 * installApp command wrapper (idea#128).
 * Usage: installApp <appId> <targetDiskId> [--source <sourceDiskId>] [--name <instanceName>]
 *
 * All arguments are passed as a single string and parsed here. Disk arguments
 * go through resolveDiskArg (a unique disk name still works, with a warning).
 * Refusals throw, so the trace ends as `error`.
 */
const INSTALL_APP_USAGE = 'Usage: installApp <appId> <targetDiskId> [--source <sourceDiskId>] [--name <instanceName>]'
const installAppWrapper = async (storeHandle: DocHandle<Store> | null, argsString: string) => {
    if (!storeHandle) throw new Error("Store is not available.")

    // Parse: installApp kolibri-1.0 <targetDiskId> --source <sourceDiskId> --name my-kolibri
    const parts = (argsString ?? '').trim().split(/\s+/).filter(Boolean)
    const appId = parts[0] as any
    const targetDiskId = parts[1]
    if (!appId || !targetDiskId || targetDiskId.startsWith('--')) throw new Error(INSTALL_APP_USAGE)
    const flagValue = (flag: string): string | undefined => {
        const i = parts.indexOf(flag)
        if (i === -1) return undefined
        const v = parts[i + 1]
        if (!v || v.startsWith('--')) throw new Error(`installApp: ${flag} needs a value. ${INSTALL_APP_USAGE}`)
        return v
    }
    const sourceDiskId = flagValue('--source')
    const instanceName = flagValue('--name') as any

    await installApp(storeHandle, { appId, targetDiskId, sourceDiskId, instanceName })
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
    // runInstance propagates compose up failures (idea#109): mark the instance
    // Error and rethrow, so handleCommand closes this command's trace as failed.
    try {
        await runInstance(storeHandle, instance, disk)
    } catch (e) {
        await markInstanceError(storeHandle, instance, disk, e)
        throw e
    }
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
    // Refusals throw so the command-log trace closes as error (idea#122).
    if (!storeHandle) throw new Error("Store is not available. Please connect first.")
    const store = storeHandle.doc()
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) throw new Error(`Instance '${instanceName}' not found.`)

    // Find backup disk: named or first linked docked Backup Disk
    let backupDisk = backupDiskName
        ? Object.values(store.diskDB).find(d => d.name === backupDiskName && d.device != null)
        : Object.values(store.diskDB).find(d =>
            d.device != null &&
            d.diskTypes?.includes('backup') &&
            d.backupConfig?.links.includes(instance.id)
          )

    if (!backupDisk) {
        throw new Error(`No docked Backup Disk found${backupDiskName ? ` named '${backupDiskName}'` : ` linked to instance '${instanceName}'`}.`)
    }
    print(chalk.blue(`Backing up instance '${instanceName}' to disk '${backupDisk.name}'...`))
    await backupInstance(storeHandle, instance.id, backupDisk as any, undefined, 'console-command')
}

const restoreAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, targetDiskName: DiskName) => {
    // Refusals throw so the command-log trace closes as error (idea#122).
    if (!storeHandle) throw new Error("Store is not available. Please connect first.")
    const store = storeHandle.doc()
    const instance = Object.values(store.instanceDB).find(i => i.name === instanceName)
    if (!instance) throw new Error(`Instance '${instanceName}' not found in store.`)

    const targetDisk = Object.values(store.diskDB).find(d => d.name === targetDiskName && d.device != null)
    if (!targetDisk) throw new Error(`Target disk '${targetDiskName}' not found or not docked.`)

    print(chalk.blue(`Restoring instance '${instanceName}' to disk '${targetDiskName}'...`))
    await restoreApp(storeHandle, instance.id, targetDisk as any, undefined, 'console-command')
}

/**
 * createBackupDisk <diskId> <mode> <instanceName…> (idea#128). The disk goes
 * through resolveDiskArg; refusals throw, so the trace ends as `error`.
 */
const createBackupDiskWrapper = async (storeHandle: DocHandle<Store> | null, diskId: string, mode: string, ...instanceNames: InstanceName[]) => {
    if (!storeHandle) throw new Error("Store is not available. Please connect first.")
    const validModes = ['immediate', 'on-demand', 'scheduled']
    if (!validModes.includes(mode)) throw new Error(`Invalid mode '${mode}'. Valid modes: ${validModes.join(', ')}`)
    const store = storeHandle.doc()
    const disk = resolveDiskArg(store, getLocalEngine(store)?.id, diskId, 'createBackupDisk')

    const instanceIds = instanceNames.map(name => {
        const inst = Object.values(store.instanceDB).find(i => i.name === name)
        if (!inst) console.warn(chalk.yellow(`Warning: instance '${name}' not found — it will be added to the links list anyway`))
        return inst?.id
    }).filter(Boolean) as any[]

    print(chalk.blue(`Creating Backup Disk config on '${disk.name}' (${disk.id}, mode: ${mode})...`))
    await createBackupDiskConfig(storeHandle, disk as any, mode as any, instanceIds)
    print(chalk.green(`Backup Disk '${disk.name}' (${disk.id}) configured.`))
}

/**
 * createFilesDisk <diskId> [<shareName…>] (idea#131). The disk ID only (the
 * command has no old name form); the share name takes the rest of the line and
 * defaults to "School Files". Refusals throw, so the trace ends as `error`.
 */

/** summariseDisk <diskId|candidateId> (idea#134). Result in CommandTrace.result. */
const summariseDiskWrapper = async (storeHandle: DocHandle<Store> | null, targetId: string) => {
    if (!storeHandle) throw new Error('Store is not available.')
    const summary = await summariseDisk(storeHandle, targetId)
    attachTraceResult(summary)
    const partial = !!(summary.files?.partial || summary.other?.partial)
    print(chalk.green(`Summary for ${summary.label}: readable=${summary.readable} partial=${partial}`))
}

/** eraseDisk <targetId> <summaryTraceId> <confirmName…> (idea#134). */
const eraseDiskWrapper = async (storeHandle: DocHandle<Store> | null, targetId: string, summaryTraceId: string, ...confirmTokens: string[]) => {
    if (!storeHandle) throw new Error('Store is not available.')
    const confirmName = confirmTokens.join(' ')
    const result = await eraseDisk(storeHandle, targetId, summaryTraceId, confirmName)
    attachTraceResult({ diskId: result.diskId, removedInstances: result.removedInstances })
    print(chalk.green(`Erased → empty IDEA disk ${result.diskId}`))
}

const createFilesDiskWrapper = async (storeHandle: DocHandle<Store> | null, diskId: string, ...shareNameTokens: string[]) => {
    if (!storeHandle) throw new Error("Store is not available. Please connect first.")
    const shareName = shareNameTokens.length > 0 ? shareNameTokens.join(' ') : undefined
    const disk = await createFilesDisk(storeHandle, diskId, shareName)
    print(chalk.green(`'${disk.name}' (${disk.id}) is now a Files Disk (disk types: ${disk.diskTypes.join(', ')}).`))
}

const copyAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, sourceDiskId: DiskID, targetDiskId: DiskID) => {
    if (!storeHandle) { console.error(chalk.red('Store is not available.')); return; }
    await copyApp(storeHandle, instanceName, sourceDiskId, targetDiskId, 'console-command')
}

const moveAppWrapper = async (storeHandle: DocHandle<Store> | null, instanceName: InstanceName, sourceDiskId: DiskID, targetDiskId: DiskID) => {
    if (!storeHandle) { console.error(chalk.red('Store is not available.')); return; }
    await moveApp(storeHandle, instanceName, sourceDiskId, targetDiskId, 'console-command')
}

export type EjectTarget = DiskArgResult

/** The ejectDisk lookup (idea#152), now the shared disk-argument lookup (idea#128). */
export const resolveEjectTarget = (store: Store, arg: string, engineId: EngineID | undefined): EjectTarget =>
    lookupDiskArg(store, engineId, arg)

/**
 * ejectDisk <diskId> (idea#152). A name still works (see resolveEjectTarget).
 * Refusals throw, so the command trace ends as `error` with the reason and the
 * Console can show it.
 */
const ejectDiskWrapper = async (storeHandle: DocHandle<Store> | null, diskIdOrName: string) => {
    if (!storeHandle) throw new Error("Store is not available. Please connect first.")
    const store = storeHandle.doc();
    const localEngine = getLocalEngine(store);
    const disk = resolveDiskArg(store, localEngine?.id, diskIdOrName, 'ejectDisk')
    const label = `'${disk.name}' (${disk.id})`
    // Never eject the Pi's own system disk, however it was named (idea#152)
    if (await isSystemDiskRecord(disk)) {
        throw new Error(`Disk ${label} is this Pi's system disk and cannot be ejected.`)
    }
    // Refuse to eject if an operation is actively using this disk
    if (resourceLock.isLocked(diskKey(disk.id))) {
        const info = resourceLock.getLockInfo(diskKey(disk.id))
        throw new Error(`Disk ${label} is locked by an active '${info?.kind}' operation. Stop or wait for it to complete before ejecting.`)
    }
    // Refuse to eject a Backup Disk while a backup writes to it (idea#126). Checked by
    // the backupApp operation's backupDiskId, so scheduled and automatic backups count too.
    const backup = runningBackupOnDisk(store, disk.id)
    if (backup) {
        throw new Error(`Disk ${label} is in use by a running backup of instance ${backup.args.instanceId}. Wait for it to complete before ejecting.`)
    }
    print(chalk.blue(`Ejecting disk ${label}...`));
    // The device is unmounted, so any stale record on it is undocked too (idea#152)
    let cleared: DiskID[] = []
    storeHandle.change(doc => { cleared = clearDuplicateDiskRecords(doc, disk.dockedTo as EngineID, disk.device as DeviceName, disk.id) })
    if (cleared.length > 0) log(`Undocked stale disk record(s) ${cleared.join(', ')} on ${disk.device}`)
    await undockDisk(storeHandle, disk);
    print(chalk.green(`Disk ${label} ejected successfully.`));
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
    { name: "createBackupDisk", execute: createBackupDiskWrapper, args: [{ type: "string", name: "diskId" }, { type: "string", name: "mode" }, { type: "string", name: "instanceNames", variadic: true }], scope: 'engine' },
    { name: "createFilesDisk", execute: createFilesDiskWrapper, args: [{ type: "string", name: "diskId" }, { type: "string", name: "shareName", variadic: true, optional: true }], scope: 'engine' },
    { name: "summariseDisk", execute: summariseDiskWrapper, args: [{ type: "string", name: "targetId" }], scope: 'engine' },
    { name: "eraseDisk", execute: eraseDiskWrapper, args: [{ type: "string", name: "targetId" }, { type: "string", name: "summaryTraceId" }, { type: "string", name: "confirmName", variadic: true }], scope: 'engine' },
    { name: "cancelOperation", execute: async (storeHandle: DocHandle<Store> | null, opId: string) => {
        if (!storeHandle) { console.error(chalk.red('Store is not available.')); return; }
        const err = cancelOperation(storeHandle, opId)
        if (err) console.error(chalk.red(`cancelOperation: ${err}`))
        else print(chalk.green(`Operation ${opId} cancelled`))
    }, args: [{ type: "string" }], scope: 'engine' },
];
