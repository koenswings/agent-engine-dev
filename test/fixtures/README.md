# Test Fixtures

These are **synthetic test fixtures** — not copies of real app releases.

Each fixture contains only what the Engine needs to exercise its logic:
- `META.yaml` — disk identity (fake diskId, generated timestamps)
- `apps/<name>-<version>/compose.yaml` — minimal app metadata (`x-app` fields + one service)

Fixtures deliberately use generic names (`sample`, `sample-v2`) to avoid confusion with
real IDEA apps (Kolibri, Nextcloud, etc.). The Docker images referenced are lightweight
and chosen for fast startup in tests, not for production use.

## Fixture inventory

| Directory | Purpose |
|-----------|---------|
| `disk-sample-v1/` | Baseline fixture — single app at version 1.0 |

## Adding fixtures

Add a new directory following the same structure. Keep fixtures minimal:
- No `init_data.tar.gz`
- No `services/` folder (Docker images are pulled at test time if needed)
- Use the `sample` app name or another clearly synthetic name
