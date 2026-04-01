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
- Pi host: `172.20.0.1` (Docker bridge gateway); hostname `wizardry-hugle`
- Engine on Pi: `/home/pi/idea/agents/agent-engine-dev/`
- SSH key (container→Pi): `/home/node/workspace/.ssh/id_ed25519`

## Architecture (current, as built)
- Engine: TypeScript / Node.js 22+, Automerge CRDTs, Docker Compose, pnpm, Vitest
- Engine serves Console dist/ via HTTP server on port 80 (PR #26 merged)
- GET /api/store-url → { url: 'automerge:<hash>' } read from store-url.txt
- App runtime: Docker Compose per app; apps dock/undock via USB disk detection
- Config: testMode: true default in Pi builds (skips sudo mount/umount only)
- IDEA_TEST_MODE=true env var overrides config at process start

## Test Infrastructure (PR #9, #16 merged to main)
- pnpm test:unit — disk simulation + instance lifecycle; 5/5 passing
- Tests run on Pi host (no cloud runners); TEST_HOST=172.20.0.1
- Fixtures: test/fixtures/disk-sample-v1/ (META.yaml + apps/sample-1.0/compose.yaml)
- Test device: sdz1; test paths /disks/sdz1/, /dev/engine/sdz1
- test/testresults/ gitignored; timestamped log files written there
- SSH task ebfa743b complete: restricted authorized_keys + run-tests.sh on Pi; 5/5 passing
- run-tests.sh at /home/pi/idea/scripts/run-tests.sh

## Open PRs
- PR #14: chore/remove-tmux-vscode (open, cleanup)
- PR #27: memory/updates (open, pending merge — contains AGENTS.md updates)

## Backlog Tasks (MC)
- 34c37e24 — Fix extractAppVersion for hyphenated app names
- 904feb39 — SSH key plan for field Pis (per-engine keypairs + LAN key exchange)

## Planned PRs (test suite)
- PR 3: App versioning + upgrade tests (isMinorUpdate(), disk-sample-v2/ fixture)
- PR 4: Multi-engine network tests (mDNS, CRDT sync, assignAppsToEngines())
- PR 5: Diagnostic mode (pnpm test:diagnostic, test/diagnostic/field-health.test.ts)
- PR 6: Mocha → Vitest migration

## Key Decisions
- Version comparison: major-number only (1.x vs 2.x). 1.x→2.x = blocked; 1.x→1.y = minor
- Image pre-pull: auto-pull if missing (docker pull inline before start)
- Diagnostic report: test/testresults/diagnostic-report-YYYY-MM-DD-HHMM.log (gitignored)
- testMode: true default on Pi; enables diagnostic mode without config change
- Multi-engine assignment: sorted round-robin engines[i % N] by alphabetical appId
- App compatibility tests live in each app repo; future App Maintainer agent owns harness
- Instance lifecycle: Undocked→Docked→Starting→Pauzed→Running; undock: Stopped→Undocked

## Cross-Agent Communication
- All cross-agent comms go through Koen (Telegram relay). Do not message agents directly.
- Send "📨 For [Agent]: [message]" in own Telegram group; Koen forwards.

## Key Lessons
- source .env fails in sh; use bash -c 'source .env && ...' or . .env in bash
- git push needs GITHUB_TOKEN in remote URL; reset URL after push
- PR body newlines break inline JSON in curl — use Python urllib.request for multi-line bodies
- docker-compose-plugin (v2) must be installed separately
