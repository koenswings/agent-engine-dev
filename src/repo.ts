import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { ThreadedWebSocketServerAdapter } from "./wsServerThread.js";
import { PortNumber } from "./data/CommonTypes.js";
import { deepPrint, log, error } from './utils/utils.js'


/**
 * r34 DURABILITY. automerge-repo 2.3.0-alpha.0 (and 2.3.0) never wrote a document
 * to disk after the first change: Repo's throttled save closure ignored its
 * arguments and kept saving the doc version captured at the first
 * 'heads-changed' (automerge-repo src/Repo.ts:166-168), so
 * StorageSubsystem.saveDoc saw unchanged heads and returned. Only repo.flush()
 * (SIGINT/SIGTERM -> shutdownRepo) wrote, so a crash or power cut lost
 * everything since the last clean stop. Fixed upstream in 2.3.1 (package.json).
 *
 * Backstop, independent of the library version: flush the ready docs every
 * STORE_FLUSH_INTERVAL_MS. saveDoc is a no-op when a doc's heads have not moved
 * since it was last stored, writes one incremental chunk when they have, and
 * compacts on its own when the incrementals outgrow the snapshot. This bounds a
 * crash/power-cut loss to this interval even if a future library version
 * regresses. shutdownRepo stops it (stopPeriodicFlush) before the final flush.
 */
export const STORE_FLUSH_INTERVAL_MS = 5_000

const periodicFlushes = new WeakMap<Repo, () => Promise<void>>()

/** Start the backstop flush for `repo`; returns its stop function (also reachable via stopPeriodicFlush). */
export const startPeriodicFlush = (repo: Repo, intervalMs: number = STORE_FLUSH_INTERVAL_MS): (() => Promise<void>) => {
    void periodicFlushes.get(repo)?.()
    let stopped = false
    let inFlight: Promise<void> | undefined
    const tick = async (): Promise<void> => {
        try {
            // Only ready handles: flush() of a handle that never loaded (e.g. a command
            // log that timed out) throws (see shutdownRepo in CommandLogStore.ts).
            const ready = Object.values(repo.handles).filter(h => h.isReady()).map(h => h.documentId)
            if (ready.length > 0) await repo.flush(ready)
        } catch (e) {
            error(`[repo] periodic flush failed: ${e instanceof Error ? e.message : e}`)
        }
    }
    const timer = setInterval(() => {
        if (stopped || inFlight) return
        inFlight = tick().finally(() => { inFlight = undefined })
    }, intervalMs)
    timer.unref()
    const stop = async (): Promise<void> => {
        stopped = true
        clearInterval(timer)
        if (periodicFlushes.get(repo) === stop) periodicFlushes.delete(repo)
        await inFlight
    }
    periodicFlushes.set(repo, stop)
    return stop
}

/** Stop `repo`'s backstop flush and wait for a running tick to finish. No-op if none is running. */
export const stopPeriodicFlush = async (repo: Repo): Promise<void> => {
    await periodicFlushes.get(repo)?.()
}

/** Keepalive ping interval of the Engine's WS server (adapter default: 5000 ms). */
export const WS_KEEPALIVE_INTERVAL_MS = 30_000

export const startAutomergeServer = async (dataDir:string, port:PortNumber):Promise<Repo> => {
    log(`Using data directory: ${dataDir}`);

    // 1. Create a storage adapter for the server to persist data.
    const storage = new NodeFSStorageAdapter(dataDir);

    // 2. Create the WebSocket server.
    // IDEA04-WS: the server runs in a worker thread (wsServerThread.ts) so that
    // accepting sockets, answering joins and the keepalive keep working while
    // the main thread is busy syncing the large store doc to many fresh peers.
    // Keepalive 30 s instead of the adapter's 5 s default: a peer is only
    // dropped after a full interval without a pong. Listen errors (e.g. port
    // in use) are logged as 'WebSocket server error on port ...' as before.
    const network = new ThreadedWebSocketServerAdapter(port, WS_KEEPALIVE_INTERVAL_MS);

    // 3. Create the Automerge repo.
    const repo = new Repo({
        storage: storage,
        network: [network],
        sharePolicy: async (peerId) => true // Allow all peers to sync
    });

    startPeriodicFlush(repo);

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
