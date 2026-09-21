# AGENTS.md — Engine (agent-engine-dev)

You are Grok Build running on an ARM64 Raspberry Pi runner.

## What this repo is

The IDEA Engine — a Node.js/TypeScript application running natively via pm2 (NOT Docker). Manages App Disks (USB/SSD drives with ext4 + META.yaml + Docker Compose apps), syncs fleet state via Automerge CRDTs, serves Console web app on port 80.

Constraints: ARM64 only · pm2 as pi user only · store-template.json must never be regenerated · offline-first · exclusive hardware access.

## Repo layout

```
src/               Production TypeScript source
  index.ts         Entry point
  data/            Store, Config, CommandLogStore
  monitors/        USB, mDNS, HTTP, Store, time monitors
  utils/           Shared utilities
test/
  automated/       Vitest unit + integration tests
  cross-engine/    Multi-engine tests (requires 2+ Pis)
  diagnostic/      Field health checks
  testresults/     Test logs (gitignored)
script/            Provisioning and utility scripts
docs/              Authoritative docs — .md, .pdf, .png, .svg ONLY
proposals/         Proposals and historical design reasoning
dist/              Compiled output (gitignored)
config.yaml        Runtime configuration
store-template.json  Automerge bootstrap — NEVER MODIFY
```

## Build

```bash
pnpm install        # first time or after package.json changes
pnpm build          # TypeScript → dist/ (pnpm clean && tsc)
```

## Test (required before any PR)

```bash
pnpm test:full      # build + vitest run dist/test/automated/
                    # results → test/testresults/ (include in PR)
pnpm test:unit      # unit tests only
pnpm test:diagnostic  # field health checks
pnpm test:cross-engine  # requires 2+ Pis both running
```

## Deploy (Ops Bot calls deploy.sh — do not deploy manually)

The fleet deploy scripts handle all deployment logic. Grok Build's job is to produce a passing test suite and open a PR.

## config.yaml key settings

```yaml
settings:
  httpPort: 80          # Serves Console web app + /api/store-url
  consolePath: /home/pi/console-dist
  port: 4321            # Automerge WebSocket port
  testMode: false       # true = skip sudo mount/umount (tests)
```

## Quality rules (every PR, no exceptions)

- No source files (.ts/.js) in docs/ — .md, .pdf, .png, .svg only
- No hardcoded credentials — process.env only
- No console.log in src/ production paths
- No commented-out blocks >5 lines without explanation
- No TODO/FIXME without linked GitHub issue
- Build/deploy changed → update this file in same PR
- New doc in docs/ → update docs/INDEX.md in same PR
- store-template.json: never modified under any circumstances

## Known gotchas

- store-template.json: all Engines share the same Automerge doc ID. Regenerating it permanently breaks cross-Engine merging.
- udev rule 90-docking.rules must be present for USB detection. Installed by install.sh.
- pm2 must run as pi user only. Root pm2 and pi pm2 are separate process lists.
- pnpm test:full runs on compiled dist/. Always rebuild before testing.
