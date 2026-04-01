import path from 'path'
import { Engine, localEngineId } from './Engine.js'
import { Disk } from './Disk.js'
import { deepPrint, getKeys, log } from '../utils/utils.js'
import { App } from './App.js'
import { Instance } from './Instance.js'
import { User } from './User.js'
import { AppID, DeviceName, DiskID, EngineID, Hostname, InstanceID, UserID } from './CommonTypes.js'
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
    console.log(`Connecting to hosts ${hostnames.join(', ')} with peer ID ${clientPeerId}`);
    
    const connectPromise = (async () => {
        const urls = await Promise.all(hostnames.map(async (hostname) => {
            try {
                console.log(chalk.blue(`Resolving hostname ${hostname}...`));
                const { address } = await lookup(hostname);
                console.log(chalk.green(`  - Resolved to ${address}`));
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
            console.log(chalk.blue(`Attempting to connect with a ${timeout} second timeout...`));
            const timeoutPromise = new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error(`Connection timed out after ${timeout} seconds`)), timeout * 1000)
            );
            result = await Promise.race([connectPromise, timeoutPromise]);
        } else {
            console.log(chalk.blue(`Attempting to connect with no timeout...`));
            result = await connectPromise;
        }
        
        console.log(`Connected successfully with peer ID ${clientPeerId}`);
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
        if (instance && instance.status === 'Running') {
            return [instance]
        } else {
            return []
        }
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
        if (instance && instance.storedOn === disk.id) {
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
        if (disk && disk.dockedTo === engine.id) {
            return [disk]
        } else {
            return []
        }
    })
}

export const findDiskByDevice = (store: Store, deviceName: DeviceName): Disk | undefined => {
    return getDisks(store).find(disk => disk.device === deviceName)
}

export const findDiskByName = (store: Store, diskName: string): Disk | undefined => {
    return getDisks(store).find(disk => disk.name === diskName)
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
