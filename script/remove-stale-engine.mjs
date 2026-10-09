/**
 * One-shot script: removes a stale engineDB entry from the live Automerge store.
 * Usage: node script/remove-stale-engine.mjs [engineId]
 *
 * Run it on the Engine's machine, from the Engine's folder (it reads the store id
 * from ./store-identity/store-url.txt, like the Engine does).
 *   IDEA_STORE_URL_FILE  path of store-url.txt (default ./store-identity/store-url.txt)
 *   IDEA_WS_URL          the Engine's WS URL (default ws://localhost:4321)
 *
 * Store-scoped peering (src/data/StoreScope.ts, #156/#157): this script keeps a
 * local copy (NodeFS storage), so to the Engine it is not a storage-less client
 * but an Engine-like peer, and an Engine refuses any such peer that does not carry
 * ITS store tag. The script therefore connects with the peerId
 * `idea-engine/<storeTag>/TOOL_remove-stale-engine/<session>`, the tag derived
 * exactly as storeTag() in StoreScope.ts (test/automated/remove-stale-engine-script.test.ts
 * checks both give the same tag). It used to hard-code the fleet store 4GQm; it now
 * uses the store of the Engine it runs next to, so it cannot write into another fleet.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const TOOL_ENGINE_ID = "TOOL_remove-stale-engine";

/** `automerge:<id>` (whitespace ignored) -> `<id>`, as StoreIdentity.storeDocIdFromUrl. */
export const storeDocIdFromUrl = (url) => String(url).trim().replace(/^automerge:/, "");

/** Same derivation as storeTag() in src/data/StoreScope.ts. */
export const storeTag = (storeDocId) => {
    const id = storeDocIdFromUrl(storeDocId);
    if (!id) throw new Error("storeTag: empty store doc id");
    return `${id.slice(0, 5)}-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
};

/** Same format as enginePeerId() in src/data/StoreScope.ts. */
export const toolPeerId = (storeDocId, session = crypto.randomBytes(4).toString("hex")) =>
    `idea-engine/${storeTag(storeDocId)}/${TOOL_ENGINE_ID}/${session}`;

/** The store doc id from store-url.txt; throws a clear error when missing or empty. */
export const readStoreDocId = (urlFile) => {
    if (!fs.existsSync(urlFile)) throw new Error(`Store URL file ${urlFile} not found: run this from the Engine's folder or set IDEA_STORE_URL_FILE`);
    const id = storeDocIdFromUrl(fs.readFileSync(urlFile, "utf-8"));
    if (!id) throw new Error(`Store URL file ${urlFile} is empty`);
    return id;
};

const main = async () => {
    const { Repo } = await import("@automerge/automerge-repo");
    const { WebSocketClientAdapter } = await import("@automerge/automerge-repo-network-websocket");
    const { NodeFSStorageAdapter } = await import("@automerge/automerge-repo-storage-nodefs");
    const { rm } = await import("fs/promises");

    const STALE_ID = process.argv[2] || "ENGINE_AA000000000000000724";
    const URL_FILE = process.env.IDEA_STORE_URL_FILE || path.join("store-identity", "store-url.txt");
    const WS_URL = process.env.IDEA_WS_URL || "ws://localhost:4321";
    const TMP_STORAGE = "./store-data-tmp-remove";

    const STORE_DOC_ID = readStoreDocId(URL_FILE);
    const STORE_URL = `automerge:${STORE_DOC_ID}`;
    const peerId = toolPeerId(STORE_DOC_ID);

    console.log(`Connecting to ${WS_URL} as ${peerId} (store ${storeTag(STORE_DOC_ID)})...`);
    const repo = new Repo({
        network: [new WebSocketClientAdapter(WS_URL)],
        storage: new NodeFSStorageAdapter(TMP_STORAGE),
        peerId,
    });
    const cleanup = () => rm(TMP_STORAGE, { recursive: true, force: true });

    console.log(`Finding doc ${STORE_URL}...`);
    let handle;
    try {
        // In automerge-repo 2.x, repo.find() is awaitable (returns a DocHandle thenable)
        handle = await repo.find(STORE_URL);
    } catch (e) {
        console.error(`Could not load the store from ${WS_URL}: ${e?.message ?? e}. ` +
            `Is the Engine running, and is ${URL_FILE} the store of that Engine? ` +
            `An Engine refuses peers of another store (its log shows '[store-scope] REFUSED peer').`);
        await cleanup();
        process.exit(2);
    }

    console.log("Doc ready. Reading store...");
    const doc = handle.doc();
    const keys = Object.keys(doc.engineDB);
    console.log("Current engineDB keys:", keys);

    if (!doc.engineDB[STALE_ID]) {
        console.log(`Entry '${STALE_ID}' not found — nothing to do.`);
        await cleanup();
        process.exit(0);
    }

    console.log(`Removing stale entry: ${STALE_ID}`);
    handle.change(d => {
        delete d.engineDB[STALE_ID];
    });

    // Wait for the change to sync back to the server
    console.log("Waiting for sync...");
    await new Promise(r => setTimeout(r, Number(process.env.IDEA_SYNC_WAIT_MS || 4000)));

    const updated = handle.doc();
    console.log("engineDB keys after removal:", Object.keys(updated.engineDB));
    console.log("Done.");

    // Clean up tmp storage
    await cleanup();
    process.exit(0);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
