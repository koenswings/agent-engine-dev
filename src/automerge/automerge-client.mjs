
import { Repo } from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { next as Automerge } from "@automerge/automerge";

console.info("Starting Automerge client...");

// 1. Create a WebSocket client adapter to connect to the server.
const network = new WebSocketClientAdapter("ws://localhost:3030");

// 2. Create the Automerge repo for the client.
//    No storage adapter is used, so the data is ephemeral on the client.
const repo = new Repo({
  network: [network],
});

// 3. Find or create a document.
//    The 'find' method will create the document if it doesn't exist.
const docHandle = repo.find("automerge://mydocument");
await docHandle.whenReady();

console.info("Document handle is ready.");

// 4. Set up a listener to log changes to the document.
docHandle.on("change", ({ doc }) => {
  console.info("Document changed:", JSON.stringify(doc, null, 2));
});

// 5. Make a change to the document.
//    This change will be synced to the server and any other connected clients.
docHandle.change((doc) => {
  console.info("Making a change to the document...");
  if (!doc.counter) {
    doc.counter = new Automerge.Counter();
    console.info("Initialized counter.");
  } else {
    doc.counter.increment(1);
    console.info("Incremented counter.");
  }
});

console.info("Initial change has been made.");
