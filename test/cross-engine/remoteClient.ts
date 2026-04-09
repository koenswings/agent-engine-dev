/**
 * remoteClient.ts — Automerge client that connects to a live fleet engine.
 *
 * The shared store document ID is read from store-identity/store-url.txt (same
 * file that every provisioned engine carries). The client opens a WebSocket to
 * the engine's Automerge server port and syncs the shared document.
 *
 * This is the cross-engine equivalent of diskSim.createTestStore(): instead of
 * creating an in-memory store it joins an existing live store over the network.
 */

import { Repo, DocHandle, DocumentId, PeerId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { Store } from '../../src/data/Store.js'
import { $, fs, path } from 'zx'
import { config } from '../../src/data/Config.js'

// The shared document ID.
// Primary source: read from the live engine via SSH to handle cases where the fleet
// was re-initialised (store URL changed). Falls back to local store-identity/store-url.txt.
const LOCAL_STORE_URL_PATH = path.resolve(process.cwd(), 'store-identity/store-url.txt')

const SSH_OPTS = [
    '-i', `${process.env.HOME}/.ssh/id_ed25519`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
]

export const getStoreDocId = async (primaryHost: string): Promise<DocumentId> => {
    try {
        const result = await $`ssh ${SSH_OPTS} pi@${primaryHost} cat /home/pi/projects/engine/store-identity/store-url.txt`
        const url = result.stdout.trim()
        if (url.startsWith('automerge:')) {
            console.log(`[remoteClient] Using store URL from ${primaryHost}: ${url}`)
            return url.replace('automerge:', '') as DocumentId
        }
    } catch (e) {
        console.warn(`[remoteClient] Could not read store URL from ${primaryHost}, falling back to local file`)
    }
    const localUrl = fs.readFileSync(LOCAL_STORE_URL_PATH, 'utf-8').trim()
    console.log(`[remoteClient] Using local store URL: ${localUrl}`)
    return localUrl.replace('automerge:', '') as DocumentId
}

export const ENGINE_PORT = config.settings.port ?? 4321

// Cached after first call
let _storeDocId: DocumentId | null = null
export const getCachedStoreDocId = async (primaryHost: string): Promise<DocumentId> => {
    if (!_storeDocId) _storeDocId = await getStoreDocId(primaryHost)
    return _storeDocId
}

// Legacy export for backwards compat — reads from local file
export const STORE_DOC_ID = fs.readFileSync(LOCAL_STORE_URL_PATH, 'utf-8').trim().replace('automerge:', '') as DocumentId

/**
 * Connect to a fleet engine's Automerge WebSocket and return a synced store handle.
 *
 * @param host  Hostname or IP of the target engine (e.g. 'idea01.local' or '192.168.0.138')
 * @param label Optional label for logging (defaults to host)
 */
export const connectToEngine = async (
    host: string,
    label?: string,
    storeDocId?: DocumentId,
): Promise<{ repo: Repo; storeHandle: DocHandle<Store> }> => {
    const name = label ?? host
    const url = `ws://${host}:${ENGINE_PORT}`
    console.log(`[remoteClient] Connecting to ${name} at ${url}`)

    const docId = storeDocId ?? await getCachedStoreDocId(host)

    const adapter = new WebSocketClientAdapter(url, 2000)
    const repo = new Repo({
        network: [adapter],
        peerId: `test-runner-${name}-${Date.now()}` as PeerId,
    })

    const storeHandle = await repo.find<Store>(docId)
    await storeHandle.whenReady()
    console.log(`[remoteClient] Connected to ${name}. Doc state: ${storeHandle.state}`)
    return { repo, storeHandle }
}

/**
 * Disconnect cleanly from an engine.
 */
export const disconnectFromEngine = async (repo: Repo): Promise<void> => {
    await repo.shutdown()
}

/**
 * Poll the store until predicate returns true, or timeout expires.
 */
export const waitFor = async (
    storeHandle: DocHandle<Store>,
    predicate: (store: Store) => boolean,
    timeoutMs = 30_000,
    intervalMs = 200,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const store = storeHandle.doc()
        if (store && predicate(store)) return true
        await new Promise(r => setTimeout(r, intervalMs))
    }
    return false
}

/**
 * Poll the store until an instance reaches the expected status, or timeout expires.
 */
export const waitForInstanceStatus = async (
    storeHandle: DocHandle<Store>,
    instanceId: string,
    expectedStatus: string,
    timeoutMs = 30_000,
    intervalMs = 200,
): Promise<boolean> => {
    return waitFor(
        storeHandle,
        store => store.instanceDB[instanceId as any]?.status === expectedStatus,
        timeoutMs,
        intervalMs,
    )
}

/**
 * Write a command into a target engine's command queue in the shared CRDT store.
 * The target engine's storeMonitor will pick it up and execute it.
 *
 * @param storeHandle  Any connected store handle (the write syncs to all peers)
 * @param engineId     ID of the engine that should execute the command
 * @param command      Command string, e.g. 'stopInstance foo disk-bar'
 */
export const sendCommand = (
    storeHandle: DocHandle<Store>,
    engineId: string,
    command: string,
): void => {
    console.log(`[remoteClient] Sending command to engine ${engineId}: ${command}`)
    const store = storeHandle.doc()
    if (!store?.engineDB[engineId as any]) {
        throw new Error(`Engine ${engineId} not found in store`)
    }
    storeHandle.change(doc => {
        const engine = doc.engineDB[engineId as any]
        if (engine) engine.commands.push(command as any)
    })
}
