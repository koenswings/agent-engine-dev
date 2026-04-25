/**
 * One-shot script: removes a stale engineDB entry from the live Automerge store.
 * Usage: node script/remove-stale-engine.mjs [engineId]
 */
import { Repo } from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { rm } from "fs/promises";

const STALE_ID = process.argv[2] || "ENGINE_AA000000000000000724";
const STORE_DOC_ID = "4GQmEZehPDfryGDxkFo9XixbvmAC";
const STORE_URL = `automerge:${STORE_DOC_ID}`;
const WS_URL = "ws://localhost:4321";
const TMP_STORAGE = "./store-data-tmp-remove";

console.log(`Connecting to ${WS_URL}...`);
const repo = new Repo({
    network: [new WebSocketClientAdapter(WS_URL)],
    storage: new NodeFSStorageAdapter(TMP_STORAGE),
});

console.log(`Finding doc ${STORE_URL}...`);
// In automerge-repo 2.x, repo.find() is awaitable (returns a DocHandle thenable)
const handle = await repo.find(STORE_URL);

console.log("Doc ready. Reading store...");
const doc = handle.doc();
const keys = Object.keys(doc.engineDB);
console.log("Current engineDB keys:", keys);

if (!doc.engineDB[STALE_ID]) {
    console.log(`Entry '${STALE_ID}' not found — nothing to do.`);
    process.exit(0);
}

console.log(`Removing stale entry: ${STALE_ID}`);
handle.change(d => {
    delete d.engineDB[STALE_ID];
});

// Wait for the change to sync back to the server
console.log("Waiting for sync...");
await new Promise(r => setTimeout(r, 4000));

const updated = handle.doc();
console.log("engineDB keys after removal:", Object.keys(updated.engineDB));
console.log("Done.");

// Clean up tmp storage
await rm(TMP_STORAGE, { recursive: true, force: true });
process.exit(0);
