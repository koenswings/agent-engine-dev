
import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { WebSocketServer } from "ws";
import { WebSocketServerAdapter } from "@automerge/automerge-repo-network-websocket";
import os from "os";

console.info("Starting Automerge server...");

// Define the directory for storing Automerge data.
const dataDir = `./automerge-data`;
console.info(`Using data directory: ${dataDir}`);

// 1. Create a storage adapter for the server to persist data.
const storage = new NodeFSStorageAdapter(dataDir);

// 2. Create a WebSocket server.
const ws = new WebSocketServer({ port: 3030 });
const network = new WebSocketServerAdapter(ws);

// 3. Create the Automerge repo.
const repo = new Repo({
  storage,
  network: [network]
});

console.info("Automerge server is running on ws://localhost:3030");
