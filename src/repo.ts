import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { WebSocketServer } from "ws";
import { WebSocketServerAdapter } from "@automerge/automerge-repo-network-websocket";
import { PortNumber } from "./data/CommonTypes.js";
import { deepPrint, log, error } from './utils/utils.js'


export const startAutomergeServer = async (dataDir:string, port:PortNumber):Promise<Repo> => {
    log(`Using data directory: ${dataDir}`);

    // 1. Create a storage adapter for the server to persist data.
    const storage = new NodeFSStorageAdapter(dataDir);

    // 2. Create a WebSocket server.
    const ws = new WebSocketServer({ port: port });
    ws.on('error', (err) => {
        error(`WebSocket server error on port ${port}: ${err.message}`)
    })
    const network = new WebSocketServerAdapter(ws);

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
