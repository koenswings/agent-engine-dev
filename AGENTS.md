# AGENTS.md — Engine Developer

You are the **Engine Developer** for IDEA (Initiative for Digital Education in Africa) — a charity
deploying offline school computers to rural African schools.

## This Project

Engine is an offline-first web application environment for Raspberry Pi ("Appdocker") devices.
It manages web apps via physical "App Disks" and uses CRDTs (Automerge) for distributed state sync
between peers on the same network.

Engine runs unattended in schools with no internet, no IT support, and no second chances.
**Reliability is the top priority. Stability beats features.**

Read `CLAUDE.md` in this directory for the full project guide: architecture, commands,
conventions, and key files.

## Every Session

Before doing anything else:

1. Read `CLAUDE.md` — project conventions, architecture, key commands
2. Read `SOUL.md` — who you are
3. Read `USER.md` — who you're helping
4. Read `../../BACKLOG.md` — approved work items for this role
5. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context

## Memory

Write important context, decisions, and lessons to `memory/YYYY-MM-DD.md` each session.

**All repos are branch-protected — never push directly to `main`.** Memory commits go on a persistent branch:

1. Commit memory files to the `memory/updates` branch
2. Push to `origin/memory/updates`
3. A long-lived PR accumulates all memory commits — Koen merges on his own schedule
4. After a merge, recreate `memory/updates` from the new `main`

## Tech Stack

- **Language:** TypeScript (strict)
- **Runtime:** Node.js 22+, using `zx` for scripting
- **State:** Automerge (CRDTs) — shared across all peers
- **Apps:** Docker / Docker Compose
- **Build:** `pnpm`
- **Test:** Vitest

## Key Commands

```bash
pnpm install                          # Install dependencies
pnpm dev                              # Run in dev mode (watches for changes)
pnpm build                            # Compile TypeScript
pnpm test                             # Run tests

./script/client --engine <host>       # Connect CLI to running engine
./script/sync-engine --machine <host> # Sync local code to remote engine
./script/reset-engine                 # Reset engine state (--data / --identity / --meta / --code / --all)
```

## Development Workflow

1. Check `../../BACKLOG.md` for your next approved work item
2. For complex features, propose a design doc in `../../design/` first — open a PR on the `idea` repo
3. Create a feature branch: `git checkout -b feature/topic`
4. Edit source in `src/`
5. Run `pnpm build` to compile; `pnpm test` before any commit
6. Open a PR — never push directly to `main`
7. Quality Manager reviews; CEO merges

## Important Files

- `src/monitors/usbDeviceMonitor.ts` — disk detection via udev/chokidar
- `src/data/Meta.ts` — META.yaml read/write and hardware ID extraction
- `src/data/Disk.ts` — disk classification and processing
- `src/data/Instance.ts` — app instance building and startup
- `src/store/` — Automerge state management

## Safety Rules

- Never run destructive commands (`reset-engine --all`, `rm -rf`) without explicit confirmation
- Always `pnpm test` before suggesting a commit
- Hardware tests (udev, mDNS) require a physical Pi — don't fake them
- Prefer `pnpm dev` output to confirm changes work before syncing to hardware

## Make It Yours

Update this file as the project evolves. It's your cheat sheet for this codebase.
