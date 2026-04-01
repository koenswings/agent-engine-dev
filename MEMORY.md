# Axle — Engine Developer Memory

## Agent Identity
- Name: **Axle** ⚙️
- Role: Engine Developer — builds IDEA Engine (offline Raspberry Pi app runtime)
- Workspace: `/home/node/workspace/agents/agent-engine-dev/`
- Telegram group: `-5146184666`

## Infrastructure Facts
- MC API: `http://mission-control-backend:8000`
- MC Board ID: `6bddb9d2-c06f-444d-8b18-b517aeaa6aa8`
- AUTH_TOKEN: in `.env` (board-scoped)
- MC_PLATFORM_TOKEN: in `.env` (admin, for cross-board writes)
- GITHUB_TOKEN: in `.env` (gitignored, never commit)
- GitHub repo: `koenswings/agent-engine-dev`
- Pi host: `172.20.0.1` (Docker bridge gateway); hostname `wizardly-hugle`
- Tailscale: `wizardly-hugle.tail2d60.ts.net`
- Engine on Pi: `/home/pi/idea/agents/agent-engine-dev/`
- SSH key (container→Pi): `/home/node/workspace/.ssh/id_ed25519`

## Architecture (current, as built)
- Engine: TypeScript / Node.js 22+, Automerge CRDTs, Docker Compose, pnpm, Vitest
- Engine serves Console dist/ via `httpMonitor.ts` on port 80 (PR #26 merged)
- GET /api/store-url → `{ url: 'automerge:<hash>' }` read from store-url.txt
- `settings.httpPort` (default 80) + `settings.consolePath` in Config.ts / config.yaml
- Node binary has `cap_net_bind_service` granted via setcap in provisioning (PR #28) — allows port 80 as non-root
- App runtime: Docker Compose per app; apps dock/undock via USB disk detection
- Config: testMode: true default in Pi builds (skips sudo mount/umount only)
- IDEA_TEST_MODE=true env var overrides config at process start
- Store: engineDB, diskDB, appDB, instanceDB, userDB (PR #28)
- userDB: `{ [UserID]: User }` — Console operator auth (bcrypt); unblocks Console PR #19

## Test Infrastructure (all 6 PRs merged to main)
- `pnpm test` runs full test suite via `pnpm test:full`
- `fileParallelism: false` in vitest.config.ts — critical; prevents Docker container name conflicts
- Tests run on Pi host (no cloud runners); TEST_HOST=172.20.0.1
- Fixtures: disk-sample-v1, disk-sample-v1.1, disk-sample-v2, disk-kolibri-v1
- Test device: sdz1; test paths /disks/sdz1/, /dev/engine/sdz1
- test/testresults/ gitignored; timestamped log files written there
- SSH restricted: `command=` on authorized_keys triggers run-tests.sh on Pi
- run-tests.sh at /home/pi/idea/scripts/run-tests.sh
- TEST_SSH_KEY=/home/node/workspace/.ssh/id_ed25519 in .env

## Open PRs
- PR #14: chore/remove-tmux-vscode (open, cleanup — low priority)
- PR #25: chore/inconsistency-report (open, awaiting CEO merge)
- PR #17 (idea org repo): fix/run-tests-sandbox-ownership (open, awaiting merge)

## Backlog Tasks (MC)
- `34c37e24` — Fix extractAppVersion for hyphenated app names
- `904feb39` — SSH key plan for field Pis (per-engine keypairs + LAN key exchange)
- `432c90cc` — Upgrade zx v7→v8 (CVE-2025-13437)
- `d5ad1fcf` — Remove App concept
- `e3e8e31d` — Cross-disk upgrade detection
- `566a0820` — Refactor script/ to scripts/
- `7ea92164` — Remove Docker dev environment support
- `c9cb8515` — Update Architecture doc from Solution Description
- `3b0f08f6` — Review and improve Solution Description
- `2fc2631b` — Test permanently attached USB SSD as system disk

## Key Decisions
- Version comparison: major-number only. 1.x→2.x = new instance (data lives on disk); 1.x→1.y = minor update
- Image pre-pull: auto-pull if missing (docker pull inline before start)
- testMode: true skips only sudo mount/umount — all other engine logic runs normally
- Multi-engine assignment: sorted round-robin by alphabetical engineId
- instanceDB retention: undockDisk sets Undocked + storedOn=null — does NOT delete entry
- Port 80: solved via `setcap cap_net_bind_service` on node binary (not authbind, not port remapping)
- setcap must be re-run after Node.js binary updates
- Engine should run as `pi` (not root) — design in PR #24 merged; implementation pending
- userDB: Console-side auth only (bcryptjs compare client-side; handle.change() for writes)

## Cross-Agent Communication
- All cross-agent comms via Telegram relay through Koen
- Pixel group: `-5105695997`; Axle group: `-5146184666`
- Depth-1 tasks: answer only, do NOT create sub-tasks
- Always pull main before answering cross-agent questions — may have been updated

## Key Lessons
- `source .env` fails in sh; use `bash -c 'source .env && ...'`
- git push needs GITHUB_TOKEN in remote URL; reset URL after push
- PR body newlines: use heredoc or Python urllib.request for multi-line curl bodies
- `docker-compose-plugin` (v2) must be installed separately
- Pull main at session start — parallel PRs may change things before your answer
- Memory files committed on wrong branch: use `git checkout memory/updates` before editing
- Tables → PNG via `/home/node/workspace/skills/telegram-table/scripts/render_table.py`
