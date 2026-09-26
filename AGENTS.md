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
dist/              Compiled output the Engine runs from (gitignored)
dist-test/         Compiled output tests run from (gitignored) — never dist/
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
pnpm test:full      # pre-flight + compile into dist-test/ + vitest run dist-test/test/automated/
                    # results → test/testresults/ (gitignored — cite the log filename in the PR)
pnpm test:unit      # unit tests only
pnpm test:diagnostic  # field health checks
pnpm test:cross-engine  # requires 2+ Pis both running (no pre-flight, no testMode)
pnpm test:preflight # run only the live-Engine pre-flight check
pnpm build:test     # compile into dist-test/ only
```

All `test:*` scripts go through `script/test-run.sh`. Tests share nothing with a
live Engine (idea#105):

- `IDEA_SYSTEM_DISK_SKIP=true` is always set — tests never register the system disk
  or touch `/instances/*`.
- Each run gets a private temp folder: `IDEA_WATCH_DIR` (replaces `/dev/engine`)
  and `IDEA_DISKS_ROOT` (replaces `/disks`). `test/harness/diskSim.ts` refuses to
  load without them. Nothing in the tests touches `/dev/engine`, `/disks` or `/disks/old`.
- Pretend disks are named `idea-test-N`; a live Engine (testMode off) ignores such names.
- Tests compile into `dist-test/`, never `dist/` (which pm2 runs the live Engine from).
  `pnpm build` is no longer part of `test:*`.
- Test containers carry the label `org.idea.test=true`; test cleanup only removes
  labelled containers.
- `test/automated/service-image-tar-load.test.ts` (idea#81) runs the real offline
  image load: it tags `traefik/whoami` as `idea-test/tarload:<nonce>`, `docker save`s
  it into `services/` of a temp fixture disk, removes the tag, docks with
  `skipImageLoad = false` and `pull_policy: never`. It needs `traefik/whoami` cached
  locally (it pulls it once in setup if missing) and only removes its own nonce tags.
- Pre-flight (`script/test-preflight.sh`) refuses to run (exit 1) when it finds a live
  Engine: pm2 `engine` online (or a `node …/dist/src/index.js` process), running
  containers without the test label, `/instances/*`, or App Disks under `/disks`
  / `sd*` sentinels in `/dev/engine`. The Pi's own root disk (from
  `findmnt -n -o SOURCE /`, e.g. `sda` with `sda1`/`sda2`) and all its partitions
  are excluded from the App Disk check (`script/test-preflight-lib.sh`). Override at your own risk: `IDEA_TEST_ALLOW_LIVE=1`.
  `IDEA_DIAGNOSTIC_LIVE=true pnpm test:diagnostic` reads a live store, so it needs
  the override on purpose.

## Deploy (Ops Bot calls deploy.sh — do not deploy manually)

The fleet deploy scripts handle all deployment logic. Grok Build's job is to produce a passing test suite and open a PR.

## config.yaml key settings

```yaml
settings:
  httpPort: 80          # Serves Console web app + /api/store-url
  consolePath: /home/pi/idea/agents/agent-console-dev/dist
  port: 4321            # Automerge WebSocket port
  testMode: false       # true = skip sudo mount/umount (tests)
  # skipImageLoad:      # optional; unset = follows testMode (idea#81). false = load
                        # services/<image>.tar at app start (production), true = skip
```

`skipImageLoad` (env override `IDEA_SKIP_IMAGE_LOAD=true|false`) is separate from
`testMode`: testMode only skips the mount, the offline image load follows
`skipImageLoad()` in `src/data/Config.ts`. Production leaves both unset/false, so
Engines load every service image from the App Disk's `services/` folder
(`serviceImageTarPath()`: `/` in the image name → `_`).

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
- udev rule 90-docking.rules must be present for USB detection. Installed by build-engine (`installUdev`). `boot.sh` (root, `@reboot` cron) reinstalls it on every boot when it is missing or differs from `script/build_image_assets/90-docking.rules`, then runs `udevadm control --reload && udevadm trigger` (idea#82); see `/home/pi/boot.out`. The Engine's startup self-check (`src/monitors/diskDetection.ts`, skipped when `IDEA_WATCH_DIR` is set) reports what is still broken, and mount/META/undock/monitor-start failures, as failed `diskDetection` traces in Console History. A changed `boot.sh` reaches a Pi only when build-engine (`installCrontabs`) copies it to `/usr/local/bin`.
- pm2 must run as pi user only. Root pm2 and pi pm2 are separate process lists. Never `sudo pm2`: `sync-engine`, `reset-engine` and build-engine (incl. `pm2-logrotate`) all use pi's pm2 and a plain `pnpm build`. Run `reset-engine` locally as pi (it refuses to run as root).
- The Engine's root commands are listed in `script/build_image_assets/10-engine.sudoers`, installed by build-engine (`installUdev` → `installEngineSudoers`, validated with `visudo`) as `/etc/sudoers.d/10-engine` (0440 root:root; no `.` in the installed name, or sudo ignores it). If you add a `sudo` call to src/, add the exact command to that file in the same PR, with narrow patterns (`sd[a-z][12]`, never `/disks/*`). The Engine reboots with `sudo /usr/bin/systemctl reboot` (exact arguments in the sudoers file), never `sudo reboot`: on Pi OS `/usr/sbin/reboot` is a symlink to systemctl and sudo matches by inode, so a `reboot` entry would allow any systemctl call. App Disk files (META.yaml, instance folders) are written and removed as pi, without sudo. Pi OS's blanket `pi ALL=(ALL) NOPASSWD: ALL` is still in place (removal is a follow-up).
- pnpm test:full compiles into dist-test/ itself; it never rebuilds dist/. Run `pnpm build` separately when you need a fresh dist/ for the Engine.
- Leftover pretend disks from pre-idea#105 test runs (e.g. /disks/sdz1) make the pre-flight refuse; remove them by hand.
