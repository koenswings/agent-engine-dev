# Engine — IDEA Platform

The IDEA Engine is the core software running on each school Raspberry Pi. It is a Node.js/TypeScript application managed by pm2.

It detects App Disks (USB/SSD drives containing Docker Compose apps), starts Docker containers for each app instance, synchronises the full network state with all other Pis using Automerge CRDTs over WebSockets (no central server), and serves the Console web app on port 80.

The Engine itself is **not** containerised. App Disks run Docker. The Engine does not.

## Key characteristics

- **ARM64 only** — compiles and runs natively on Raspberry Pi
- **Offline-first** — works with no internet, no central server
- **pm2-managed** — starts on boot, restarts on crash, runs as pi user
- **Automerge CRDT sync** — all Pis on the same LAN share state automatically

## Repos

| Repo | Purpose |
|------|---------|
| `koenswings/agent-engine-dev` | This repo — Engine source |
| `koenswings/idea` | Org root — tasks, proposals, docs |

## Documentation

- `docs/ARCHITECTURE.md` — how the Engine works (authoritative, always current)
- `docs/COMMANDS.md` — CLI command reference
- `docs/SCRIPTS.md` — provisioning scripts reference
- `proposals/` — past decisions and design reasoning
