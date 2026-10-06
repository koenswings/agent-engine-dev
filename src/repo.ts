import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { ThreadedWebSocketServerAdapter } from "./wsServerThread.js";
import { PortNumber } from "./data/CommonTypes.js";
import { deepPrint, log, error } from './utils/utils.js'


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
