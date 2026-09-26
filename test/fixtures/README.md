# Test Fixtures

These are **synthetic test fixtures** — not copies of real app releases.

Each fixture contains only what the Engine needs to exercise its logic:
- `META.yaml` — disk identity (fake diskId, generated timestamps)
- `apps/<name>-<version>/compose.yaml` — minimal app metadata (`x-app` fields + one service)
- `instances/<instanceId>/compose.yaml` — a runnable instance (published port `${port}`)

Every service carries the label `org.idea.test: "true"`. Test cleanup
(`cleanupContainers` in `test/harness/diskSim.ts`) only removes containers with this
label, and the test pre-flight treats labelled containers as test containers (idea#105).
`dockFixture` adds the label to any service that lacks it.

Fixtures are docked under a private per-run mount root (`IDEA_DISKS_ROOT`) with the
test-only device name `idea-test-1` — never under `/disks`.

Fixtures deliberately use generic names (`sample`, `sample-v2`) to avoid confusion with
real IDEA apps (Kolibri, Nextcloud, etc.). The Docker images referenced are lightweight
and chosen for fast startup in tests, not for production use.

## Fixture inventory

| Directory | Purpose |
|-----------|---------|
| `disk-sample-v1/` | Baseline fixture — single app at version 1.0 |
| `disk-sample-v1.1/` | Minor upgrade of `disk-sample-v1` — same instance at version 1.1 |

## Adding fixtures

Add a new directory following the same structure. Keep fixtures minimal:
- No `init_data.tar.gz`
- No `services/` folder (Docker images are pulled at test time if needed)
- Use the `sample` app name or another clearly synthetic name
- Use `${port}` for published ports (never a fixed host port) and add the test label
