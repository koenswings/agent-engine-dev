# Duration tests (unified Markov walker)

Canonical design: `proposals/duration-tests.md` (PR #144 docs — do not merge unless Koen asks).  
Parent: [idea#166](https://github.com/koenswings/idea/issues/166).

## Fixtures (Kid / agent-app-dev#10)

| Pack | diskId | instanceId |
|------|--------|------------|
| Kolibri Grade 5A | `duration-kolibri-grade5a-001` | `kolibri-grade5a-001` |
| Nextcloud Grade 5A | `duration-nextcloud-grade5a-001` | `nextcloud-grade5a-001` |
| Kiwix | — | deferred Phase 3 |

Paths live under `agent-app-dev/tests/duration-tests/fixtures/`. Scenario YAML `fixtures:` maps these IDs; do not invent others. See Kid `walker-ref.yaml`.

Aligned (do not block): Atlas Ops [idea#167](https://github.com/koenswings/idea/pull/167); Pixel Console [agent-console-dev#134](https://github.com/koenswings/agent-console-dev/pull/134).

## Phase 1–2 (this tree)

- YAML loader + Markov walker + action dispatcher
- Infra dock / undock / move / reboot via `FleetOps` (fake by default)
- Settle gate (`waitForConvergence` + WS ready)
- Semantic invariants (instanceDB / diskDB / engineDB fields — not Automerge blobs)
- Return-to-start hygiene (undock when leaving `infra_docked`)
- Shared-store (`shared` + mDNS-on) vs unique-doc (`unique` + mDNS-off) mode switch
- Structured JSON logs on `pnpm test:duration`

**Not yet:** Playwright UI Interactions (Phase 3), stability probe (Phase 4), live fleet `FleetOps`.

## Run (no Pis — FakeFleetOps)

```bash
pnpm test:duration                          # minimal scenario, 40 steps
pnpm test:duration -- --scenario school-day --iterations 80 --fast
pnpm test:duration -- --scenario stress --iterations 100 --seed 99
```

Unit tests (fakes, part of automated suite):

```bash
pnpm build:test && IDEA_SYSTEM_DISK_SKIP=true IDEA_TEST_MODE=true \
  IDEA_WATCH_DIR=/tmp/idea-dur-watch IDEA_DISKS_ROOT=/tmp/idea-dur-disks \
  mkdir -p /tmp/idea-dur-watch /tmp/idea-dur-disks && \
  node_modules/.bin/vitest run dist-test/test/automated/duration-walker.test.js
```

Or via the normal suite: `pnpm test:unit` / `pnpm test:full` (includes `duration-walker.test.ts`).

## Fleet prerequisites (future --live)

- Claim **pool** Pis only (`idea01` / `idea03` / `idea04`). **Never golden idea02.**
- `exclude_engines: [idea02]` always.
- Multi-Engine: shared store + mDNS on. Single-Pi: unique store + mDNS off.
- Prefer Engine eject/dock commands over physical USB.
- Fixture disks must **never** be the idea03 hw-roundtrip stick
  (USB serial `26A1EE83197F` / vfat `3E50-902A` / disk serial `3813430-532011020`).
- Atlas Tailscale / claim hooks when available; health PAUSED around intentional reboots.

## Intent keys

See [ACTIONS.md](./ACTIONS.md) — shared contract for Pixel Playwright stubs.
