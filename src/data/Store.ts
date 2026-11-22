import { splitAppId } from './AppIdParse.js'
import path from 'path'
import { Engine, localEngineId } from './Engine.js'
import { Disk } from './Disk.js'
import { deepPrint, error, getKeys, log, print } from '../utils/utils.js'
import { missingStoreMaps, quarantineBadChunks, StoreSelfHeal } from './StoreHealth.js'
import { quarantineDirFor } from './StoreQuarantine.js'
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

// initialiseServerStore (created a random new store and overwrote store-template.json)
// was removed in idea#120: all Engines share one store; see StoreIdentity.ts.

/**
 * Finds or creates the main Store document.
 *
 * engine#567 startup guard: before the document is opened, its chunk files are
 * checked (StoreHealth.quarantineBadChunks); 0-byte or corrupt chunks are moved to
 * <store-data>-quarantine/<stamp>/ (never deleted). The document is then
 *   1. loaded from the usable chunks that are left, or
 *   2. when none are left (or there were none), created from store-template.json
 *      (read only, never written) under the same document ID.
 * After loading, the template's top-level maps must be there; if one is missing the
 * template is merged into the loaded doc (same genesis, so a no-op for a healthy doc).
 * No map is ever assigned here. A self-heal is flushed at once and reported through
 * `onSelfHeal` (start.ts publishes it on this Engine's entry).
 *
 * @param repo The initialized Automerge repo.
 * @param storagePath The path to the repo's storage directory.
 * @returns A DocHandle for the main store document.
 */
export const createServerStore = async (
    repo: Repo, storeDocId: DocumentId, storagePath: string, templatePath: string,
    opts: { onSelfHeal?: (heal: StoreSelfHeal) => void } = {},
): Promise<DocHandle<Store>> => {
    const docPath = path.join(storagePath, storeDocId.slice(0, 2), storeDocId.slice(2));
    log(`Checking for store document at: ${docPath}`);

    const chunks = await quarantineBadChunks(storagePath, storeDocId)
    const quarantineDir = (): string | null => chunks.quarantined.length > 0 ? quarantineDirFor(storagePath) : null
    let heal: StoreSelfHeal | null = null
    let handle: DocHandle<Store>

    if (chunks.good.length > 0) {
        // 1. Usable chunks in storage. Load them normally.
        log("Store document found in storage. Loading...")
        try {
            handle = await repo.find<Store>(storeDocId)
        } catch (e) {
            log(`Error finding document: ${e}`)
            throw e
        }
        log(`Document loaded successfully with handle state: ${handle.state} and url: ${handle.url}`);
        if (chunks.quarantined.length > 0) {
            heal = { at: Date.now(), source: 'chunks', reason: `${chunks.quarantined.length} bad chunk file(s) quarantined; loaded from ${chunks.good.length} usable chunk file(s)`, quarantined: chunks.quarantined.length, quarantineDir: quarantineDir() }
        }
    } else {
        // 2. No usable document data: create it from the template (same document ID),
        // so its history is the shared genesis every Engine of this store has.
        if (chunks.quarantined.length > 0) {
            error(`[store-health] store ${storeDocId}: no usable chunks left after quarantine; rebuilding from ${templatePath} (engine#567)`)
            heal = { at: Date.now(), source: 'template', reason: `all ${chunks.quarantined.length} chunk file(s) unusable; rebuilt from store-template.json`, quarantined: chunks.quarantined.length, quarantineDir: quarantineDir() }
        } else {
            log("Document not found. Creating from template to ensure consistent history.")
        }
        const templateBytes = await fs.readFile(templatePath);
        handle = repo.import(templateBytes, { docId: storeDocId });
        log("Successfully imported an initial store document with id " + handle.url);
    }

    // 3. Wait for the document to be fully ready.
    await handle.whenReady();

    // 4. engine#567: the template's top-level maps must be there.
    const missing = missingStoreMaps(handle.doc())
    if (missing.length > 0) {
        error(`[store-health] store ${storeDocId} is missing ${missing.join(', ')}: merging store-template.json into it (engine#567)`)
        repo.import(await fs.readFile(templatePath), { docId: storeDocId })
        const still = missingStoreMaps(handle.doc())
        if (still.length > 0) error(`[store-health] store ${storeDocId} still misses ${still.join(', ')} after the template merge; startup continues with defensive reads`)
        heal = {
            at: Date.now(), source: 'template-merge',
            reason: `missing ${missing.join(', ')}${heal ? ` (after: ${heal.reason})` : ''}${still.length > 0 ? `; still missing ${still.join(', ')}` : ''}`,
            quarantined: chunks.quarantined.length, quarantineDir: quarantineDir(),
        }
    }
    if (heal) {
        // Make the repaired document durable before anything else runs (a crash now would
        // otherwise find an empty doc folder next to other docs: engine#391 refusal).
        await repo.flush([handle.documentId])
        error(`[store-health] STORE_SELF_HEALED ${storeDocId}: ${heal.source}: ${heal.reason}${heal.quarantineDir ? `; quarantine ${heal.quarantineDir}` : ''}`)
        opts.onSelfHeal?.(heal)
    }

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
    // engine#567: never throw on a store doc without engineDB
    if (store?.engineDB && Object.prototype.hasOwnProperty.call(store.engineDB, engineId)) {
        return store.engineDB[engineId]
    } else {
        return undefined
    }
}

export const getRunningEngines = (store: Store): Engine[] => {
    const engineIds = Object.keys(store?.engineDB ?? {}) as EngineID[]
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

/**
 * @deprecated Takes the FIRST instance with that name; names are not unique
 * (idea#168). Commands resolve instance arguments with resolveInstanceArg /
 * lookupInstanceArg (InstanceArg.ts), which refuse an ambiguous name.
 */
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

/**
 * Every disk record on a device (idea#152). A stale record can share the device
 * with the live one (e.g. an old undock that never reached the store), so callers
 * that dock, undock or dedupe must look at all of them, not just the first.
 */
export const findDisksByDevice = (store: Store, deviceName: DeviceName, engineId?: EngineID): Disk[] => {
    const disks = engineId
        ? getDisksOfEngine(store, store.engineDB[engineId])
        : getDisks(store)
    return disks.filter(disk => String(disk.device) === String(deviceName))
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

export const extractAppName = (appId: AppID): string => splitAppId(String(appId)).name

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
