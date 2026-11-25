# Engine — IDEA Platform

The IDEA Engine is the core software running on each school Raspberry Pi. It is a Node.js/TypeScript application managed by pm2 (`pm2.config.cjs`: processes `engine` and `idea-usage`).

It detects App Disks (USB/SSD drives containing Docker Compose apps), starts Docker containers for each app instance, synchronises the full network state with all other Engines of the same store using Automerge CRDTs over WebSockets (no central server), and serves the Console web app over HTTP.

The Engine itself is **not** containerised. App Disks run Docker. The Engine does not.

## Ports

- **HTTP Console** (`settings.httpPort` in `config.yaml`): default **80**. Serves the Console UI and `/api/store-url`. The dev pool often uses **8080**.
- **idea.local** (idea#203): when mDNS is on and `settings.ideaLocal` is true (the default), the Engine also publishes `http://idea.local`, bound on `settings.ideaLocalHttpPort` (default **80**) even if `httpPort` is not 80.
- **WebSocket peer sync** (`settings.port`): default **4321**, overridable with `IDEA_ENGINE_PORT`.

## Key characteristics

- **ARM64 only** — compiles and runs natively on Raspberry Pi
- **Offline-first** — works with no internet, no central server
- **pm2-managed** — starts on boot, restarts on crash with backoff (engine#567), runs as the pi user
- **Automerge CRDT sync** — Engines that share the same store document sync automatically on the LAN

## Repos

| Repo | Purpose |
|------|---------|
| `koenswings/agent-engine-dev` | This repo — Engine source |
| `koenswings/idea` | Org root — tasks, proposals, docs, fleet-state |

## Documentation

The index of authoritative Engine docs is `docs/INDEX.md`. In particular:

- `docs/ARCHITECTURE.md` — how the Engine works (authoritative, kept current with main)
- `docs/COMMANDS.md` — CLI command reference
- `docs/SCRIPTS.md` — provisioning and utility scripts
- `docs/PI_FLEET.md` — idea01–idea04 test fleet (roles, access, provisioning)
- `docs/USAGE-CONTRACT.md` — field usage monitoring (`idea-usage`)
- `proposals/` — past decisions and design reasoning
