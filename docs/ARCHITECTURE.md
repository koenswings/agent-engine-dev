# Technical Architecture

Based on the source code and documentation, here is a technical architecture summary of the Powerberries project.

### **1. Core Concept: Physical Web App Management**
The project implements a distributed "Physical Web App Management" system. Instead of installing software on a central server, web applications are contained on portable physical drives (**App Disks**). When these disks are docked into a Raspberry Pi-based appliance (**Appdocker** or "Engine"), the system automatically detects, mounts, and executes the apps contained within them.

*   **Appdocker (Engine):** A Raspberry Pi device running the custom "Engine" software.
*   **App Disk:** An SSD or USB stick formatted with `ext4` containing Docker Compose definitions and data for web apps.
*   **Clients:** Devices on the same network that access the apps via a web browser.

---

### **2. Software Architecture: The "Engine"**
The core software is a Node.js application called the **Engine**, managed by `pm2` for persistence and auto-restart. The architecture relies on a local-first, distributed state model using **Automerge** to synchronize data between devices without a central server.

#### **A. State Management (Automerge Repo)**
The project moved away from Yjs/Valtio (referenced in brainstorming notes) to **Automerge** for conflict-free data synchronization.

*   **The Store:** The central data structure is a single shared Automerge CRDT document containing maps for Engines, Disks, Apps, and Instances. Every Engine on the network maintains its own local copy of this document and continuously merges it with copies from its peers. The result is that **every Engine holds a complete, up-to-date view of the entire network** — which engines exist, which disks are inserted into which engine, and which app instances are running where — without any central coordinator.
*   **Initialization (The "Golden Template"):** To solve the "offline-first" initialization problem (where two offline nodes create diverging documents that can never be merged), the code implements a specific pattern found in `repo.ts` and `Store.ts`.
    *   The system uses a binary template file (`store-template.json`) containing an empty document with a pre-defined UUID.
    *   On startup, the Engine attempts to load the main document from local storage. If it does not exist (first boot), it imports this binary template. This ensures all nodes start with the **same document ID**, allowing them to merge seamlessly when they eventually connect — even if each has been operating independently for days.
*   **Storage:** Data is persisted to the local filesystem using `NodeFSStorageAdapter`. Each Engine's local copy survives reboots and is incrementally merged with peers on reconnection.

#### **B. Data Flow: Monitors & The Repo**
The application uses a "Monitor" pattern. Monitors listen for system events (USB insertion, network changes, time) and update the Automerge Repo. The Repo then syncs these changes to other peers.

*   **USB Device Monitor (`usbDeviceMonitor.ts`):**
    *   Watches the `/dev/engine` directory for new storage devices.
    *   When a disk is inserted, it mounts the drive, reads its `META.yaml` identity, and scans for App instances.
    *   It updates the `Disk` and `Instance` objects in the Automerge Store.
    *   It triggers the execution of apps (via Docker).
    *   **App version tracking:** When a disk is docked, the Engine reads the `version` field from the instance's `compose.yaml` (`x-app.version`) and stores it as `instanceOf` in the store (e.g. `'kolibri-1.1'`). If the disk has been re-prepared with a newer version since its last dock, `instanceOf` is updated automatically and the instance restarts with the new version. `lastStarted` is refreshed in the store.
    *   **Cross-disk upgrade detection (planned):** When a new App Disk is docked, the Engine will scan running instances for the same app name at a different version. If a newer minor-version disk is found alongside an older one, the Engine writes an upgrade proposal to the store. The Console reads this and presents it to the Console Admin, who can initiate the upgrade (data migration via rsync from old instance to new instance). Major version changes are not proposed — they are flagged as data-format incompatible and require explicit operator action outside the normal upgrade flow. See `App.ts`: `isMajorUpgrade()`, `extractMajorVersion()`.

*   **mDNS Monitor (`mdnsMonitor.ts`):**
    *   Uses the `ciao` library to advertise the local Engine's presence on the LAN via mDNS, so other Engines and Console UIs can find it without any configuration.
    *   Uses `node-dns-sd` to continuously scan for other Engines advertising the same service type.
    *   When a new peer Engine is discovered, it automatically initiates a WebSocket connection and begins Automerge sync. The two documents merge: each Engine now knows about the other's disks, apps, and instances. As more Engines appear on the network, this process repeats, progressively building a shared picture of everything available across all engines.

*   **Time Monitor (`timeMonitor.ts`):**
    *   Periodically updates the `lastRun` timestamp in the Engine object within the Store. This acts as a heartbeat, allowing the UI to detect if an Engine has gone offline.

*   **Store Monitor (`storeMonitor.ts`):**
    *   Listens for changes *coming from* the Automerge Repo — whether those changes originated locally (a disk was inserted) or were received from a remote peer (another engine updated its state, or a Console UI wrote a command).
    *   It reacts to these data changes to trigger side effects. Most importantly, this is how **remote commands work**: a Console UI writes a command object into the shared Automerge document; the document syncs to the target Engine; the Store Monitor on that Engine detects the new command entry and executes it locally (e.g. starting or stopping an app instance, ejecting a disk). The command channel is the shared document itself — no separate RPC layer is needed.

#### **C. Communication Topology**

The system forms a self-organising mesh on the local network with no configuration required.

*   **Engine ↔ Engine (peer sync):** Each Engine runs a WebSocket server (set up in `repo.ts`). When mDNS discovery finds a new Engine, a WebSocket connection is opened and Automerge sync begins. Changes flow in both directions and are merged automatically using CRDTs — no conflict resolution logic is needed. Once synced, every Engine's local document contains the aggregated state of all engines: every disk, every app instance, and every engine heartbeat visible on the network.

*   **Engine ↔ Console UI (read path):** A Console UI connects to any one Engine on the network via WebSocket. Because that Engine already holds the merged view of the whole network, the Console UI immediately receives the complete picture — all engines, all disks, all running apps — without needing to connect to each engine individually. The Automerge document is the single source of truth, and the Console UI subscribes to it like any other peer.

*   **Console UI → Engine (write / command path):** When a user performs an action in the Console UI (e.g. "start this app", "eject this disk"), the Console UI writes a command entry into its local copy of the Automerge document. That change syncs to the connected Engine, which syncs it further to the Engine that owns the relevant disk or instance. The Store Monitor on the target Engine detects the new command and executes it. The result (success, error, updated instance state) is written back into the document by the executing Engine and syncs back to the Console UI — closing the loop without any bespoke request/response protocol.

*   **Discovery:** All of the above is driven by mDNS on the local network. There is no central registry, no manual IP configuration, and no dependency on internet connectivity. Engines and consoles find each other automatically when they appear on the same subnet.

---

### **3. Implementation of Brainstorming Decisions**

| Brainstorming Concept | Implemented Decision (Source Code) |
| :--- | :--- |
| **Data Sync:** Use Yjs with Valtio | **Switched to Automerge:** The code explicitly uses `@automerge/automerge-repo` and implements `startAutomergeServer` in `repo.ts`. |
| **Object Identity:** Objects need unique IDs | **Implemented:** The `Meta.ts` and `CommonTypes.ts` define strongly typed IDs (`EngineID`, `DiskID`) derived from hardware UUIDs or generated UUIDs stored in `META.yaml` files. |
| **Initialization:** Preventing data overwrite on boot | **Implemented:** `start.ts` checks for a `STORE_URL_PATH` or `STORE_TEMPLATE_PATH`. `Store.ts` implements `initialiseServerStore` which imports a binary template to ensure consistent document IDs across offline nodes. |
| **App Execution:** Docker Containers | **Implemented:** `Instance.ts` uses `node-docker-api` and `zx` shell scripts to manage Docker containers. Apps are defined by `compose.yaml` files found on the disk. |
| **Remote Commands:** Shell scripts via SSH | **Refined:** While SSH/rsync keys are generated, the primary command interface is now data-driven. `Commands.ts` defines commands that are processed by the `storeMonitor`, allowing remote UIs to trigger actions by writing to the shared Automerge document. |

### **4. Summary of Data Flow**

#### Scenario A — Disk insertion propagates across the network

1.  **Event:** A user inserts a USB drive containing a "Kolibri" app into Engine A.
2.  **Detection:** `usbDeviceMonitor` on Engine A detects the hardware event.
3.  **Local Update:** The monitor writes a new `Disk` object and `Instance` object into the Automerge Store.
4.  **Execution:** Engine A reads the Docker Compose definition from the disk and starts the container.
5.  **Sync to peers:** The Automerge Repo propagates the change via WebSockets to all connected peers — Engine B, Engine C, and any connected Console UIs.
6.  **Visualisation:** Every Console UI observing the document immediately shows "Kolibri" as "Running on Engine A", even if the Console UI is physically connected to Engine B.

#### Scenario B — Console UI sends a command to a remote Engine

1.  **User action:** A user on a Console UI (connected to Engine B) taps "Stop Kolibri".
2.  **Command write:** The Console UI writes a command entry into its local Automerge document.
3.  **Sync:** The change propagates via WebSocket to Engine B, which syncs it further to Engine A (which owns the disk).
4.  **Execution:** The `storeMonitor` on Engine A detects the new command and stops the Docker container.
5.  **State update:** Engine A updates the `Instance` status to "Stopped" in the document.
6.  **Feedback:** The updated status syncs back through the mesh and the Console UI reflects the change — all without a dedicated RPC layer.

#### Scenario C — New Engine joins the network

1.  **Boot:** Engine C starts up for the first time and loads the golden template Store document.
2.  **Advertise:** `mdnsMonitor` advertises Engine C's presence via mDNS.
3.  **Discovery:** Engine A and Engine B detect the new advertisement and each open a WebSocket to Engine C.
4.  **Merge:** Automerge sync runs; Engine C's empty document merges with the full document from Engine A and B. Engine C now knows about all disks and instances on the network.
5.  **Visible to consoles:** Any Console UI immediately shows Engine C in its engine list, even before any disk is inserted into it.