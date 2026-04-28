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
        throw e;
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

    handle.on('change', ({ doc }) => {
      log(`Document changed on connection to ${address}:${port}. Current doc: ${JSON.stringify(doc)}`);
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



