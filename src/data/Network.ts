import { BrowserWebSocketClientAdapter, WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { Engine } from './Engine.js'
import { findIp, log, print } from '../utils/utils.js';
import { EngineID, Hostname, IPAddress, InterfaceName, PortNumber, Timestamp } from './CommonTypes.js';
import { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import { config } from './Config.js';
import { Store, findRunningEngineByHostname } from "./Store.js";
import { readStoreDocId } from "./StoreIdentity.js";
import { describeRefusal, isForeignStoreDoc, PeerVerdict, RefusalLog, storeTag } from "./StoreScope.js";
import { ClientRefusal, StoreScopedWebSocketClientAdapter } from "./StoreScopedClientAdapter.js";

const settings = config.settings


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

/**
 * Store-scoped peering (StoreScope.ts): a peer (ip:port) that was refused because it
 * belongs to another store, or is an old Engine without a store tag, is not dialled
 * again for REFUSED_PEER_BACKOFF_MS (mDNS discovery and the static-peer supervisor
 * would otherwise redial it every 10 s). After that one new attempt is made, so a
 * peer that was moved into our store (or upgraded) is picked up on its own.
 */
export const REFUSED_PEER_BACKOFF_MS = 5 * 60_000
export const refusedPeers = new Map<string, { until: number, verdict: PeerVerdict, by: 'local' | 'remote' }>()
const outboundRefusalLog = new RefusalLog(print)

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
          // Read when needed, not at module load: startup writes a missing store-url.txt first (idea#120).
          await connectEngine(repo, address, peerInfo.hostname, peerInfo.engineId, readStoreDocId());
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




export const connectEngine = async (repo:Repo, address: IPAddress, hostname: Hostname, engineId: EngineID, storeDocId: DocumentId, peerPort?: PortNumber): Promise<WebSocketClientAdapter | undefined> => {

  // peerPort: static peers (StaticPeers.ts) only; mDNS peers use the own port as before
  const port = peerPort ?? (settings.port as PortNumber || 1234 as PortNumber)
  const key = `${address}:${port}`
  const ownTag = storeTag(storeDocId)

  const refused = refusedPeers.get(key)
  if (refused && refused.until > Date.now()) {
    log(`[store-scope] Not dialling ${key} (${hostname}): refused at ${new Date(refused.until - REFUSED_PEER_BACKOFF_MS).toISOString()} (${refused.verdict.kind}); next attempt after ${new Date(refused.until).toISOString()}`)
    return undefined
  }

  log(`Connecting to engine at ${key}`)


  log(`Checking connection with ${address}`)
  if (!network.connections.hasOwnProperty(key) && address !== 'localhost' && address !== '127.0.0.1') {
    log(`Creating a new connection to ${key}`)

    // Store-scoped client: the server's peerId must carry our store tag, or the
    // link is dropped before any document is exchanged (StoreScopedClientAdapter.ts).
    const clientConnection: StoreScopedWebSocketClientAdapter = new StoreScopedWebSocketClientAdapter(`ws://${key}`, {
      ownTag,
      docGuard: (documentId) => isForeignStoreDoc(repo as any, storeDocId, documentId),
      onRefused: (r) => refuseEngine(repo, key, hostname, ownTag, clientConnection, r),
    })
    refusedPeers.delete(key)
    repo.networkSubsystem.addNetworkAdapter(clientConnection)
    
    log(`Finding document with ID: ${storeDocId}`);
    const handle = await repo.find(storeDocId) // Trigger the connection by finding the store document
    
    log(`Waiting for handle to be ready. Current state: ${handle.state}`);
    await handle.whenReady(); // Ensure it's loaded before returning
    log(`Handle is ready. State: ${handle.state}`);

    if (clientConnection.refusal) {
      log(`Connection to ${key} was refused by the store check; not registered`)
      return undefined
    }

    handle.on('change', () => {
      // no-op: CRDT sync events are handled by storeMonitor
    });

    network.connections[key] = { adapter: clientConnection, missedDiscoveryCount: 0, hostname, engineId };
    
    log(`Created an websocket client connection on adddress ws://${key}`)
    return clientConnection
  } else {
    // Return a resolved promise of ConnectionResult
    log(`Connection to ${key} already exists or address is localhost or 127.0.0.1`)
    if (network.connections[key]) {
        network.connections[key].missedDiscoveryCount = 0;
    }
    return undefined
  }
}

/**
 * The store check refused the link to `key` (we refused the server, or it refused
 * us): log it (peer address, its store, ours), drop the adapter and the connection
 * entry, and back off before dialling it again.
 */
const refuseEngine = (repo: Repo, key: string, hostname: Hostname, ownTag: string, adapter: StoreScopedWebSocketClientAdapter, r: ClientRefusal): void => {
  refusedPeers.set(key, { until: Date.now() + REFUSED_PEER_BACKOFF_MS, verdict: r.verdict, by: r.by })
  const where = r.by === 'local' ? `outbound to ${key} (${hostname})` : `outbound to ${key} (${hostname}), which refused us`
  outboundRefusalLog.report(`out|${key}|${r.verdict.kind}|${r.verdict.theirTag ?? ''}`,
    describeRefusal(r.verdict, ownTag, r.remotePeerId, where) + ` Not dialling it again for ${REFUSED_PEER_BACKOFF_MS / 60_000} min.`)
  try { repo.networkSubsystem.removeNetworkAdapter(adapter) } catch (e: any) { log(`removeNetworkAdapter after refusal: ${e?.message ?? e}`) }
  const conn = network.connections[key as IPAddress]
  if (conn && conn.adapter === adapter) delete network.connections[key as IPAddress]
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



