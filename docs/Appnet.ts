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



