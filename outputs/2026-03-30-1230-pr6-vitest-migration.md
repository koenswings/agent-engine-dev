> **Task/Question:** Proceed with PR 6 — Mocha → Vitest migration (approved by Koen)

## What was done

Implemented PR 6 of 6 in the Engine test battery: migrated all tests from Mocha to Vitest.

### Files changed

| File | Change |
|---|---|
| `vitest.config.ts` | New: `environment: node`, `pool: forks`, `fileParallelism: false`, default timeouts |
| `test/automated/disk-dock-undock.test.ts` | `mocha`/`chai` → `vitest`; hooks/timeouts updated |
| `test/automated/instance-lifecycle.test.ts` | Same |
| `test/automated/app-versioning.test.ts` | Same |
| `test/automated/engine-network.test.ts` | Same; `this.skip()` → `describe.skipIf()` |
| `test/diagnostic/field-health.test.ts` | Same; both suites use `describe.skipIf()` |
| `package.json` | `test:unit`, `test:diagnostic`, `test:full` → `vitest run`; vitest devDep added |
| `tsconfig.json` | Added `exclude: ["test/legacy"]` |
| `test/legacy/` | Moved `00-config.test.ts` + `01-e2e-execution.test.ts` here |
| `design/test-setup-native.md` | Status → **Implemented** (PR 6 of 6 complete) |

### Key decisions

- **`fileParallelism: false`**: Critical. Vitest's `sequence.concurrent: false` only controls within-suite order. Without `fileParallelism: false`, all test files ran simultaneously — causing Docker container name conflicts between `app-versioning` and `instance-lifecycle` suites.
- **Keep mocha/chai in devDeps**: `src/test.ts` still imports mocha programmatically. Removing would break tsc.
- **Keep build step**: Vitest runs compiled `dist/test/...` JS files. No Vite transform pipeline changes needed.

### Test results

```
22 passing, 3 skipped (mDNS placeholders), 1 known sandbox-only failure
```

The 1 failure (`traefik/whoami should respond on http://localhost:…`) is the pre-existing sandbox issue: Docker ports bind on the host's `172.20.0.1`, not `localhost`. Passes on Pi. Identical to the Mocha baseline.

### PR

https://github.com/koenswings/agent-engine-dev/pull/23
