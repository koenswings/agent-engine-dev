# AGENTS.md — Engine (agent-engine-dev)

You are the Engine Dev Bot (Axle). You implement with your own tools (clone, edit, commit, open PRs via GitHub), run tests over SSH on a claimed idle non-golden pool Pi, pass the QC gate and open a PR. Ops Bot deploys it to a review Pi; Koen evaluates it on real Pi hardware and squash-merges. Read this file at the start of every implementation task.

Grok Build on a self-hosted Pi runner is **parked** (idea#147): do not trigger Grok Build or Pi runners. See [Parked: Grok Build / self-hosted runner coding](#parked-grok-build--self-hosted-runner-coding).

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
pnpm test:hw        # on a claimed Pi only: hardware eject → unplug/re-plug round trip + system-disk checks (docs/SCRIPTS.md)
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
  `skipImageLoad = false` and `pull_policy: never` (a missing tar is only a History
  warning, so its no-tar case ends in Error from `compose create`, idea#109). It needs `traefik/whoami` cached
  locally (it pulls it once in setup if missing) and only removes its own nonce tags.
- Pre-flight (`script/test-preflight.sh`) refuses to run (exit 1) when it finds a live
  Engine: pm2 `engine` online (or a `node …/dist/src/index.js` process), running
  containers without the test label, `/instances/*`, or App Disks under `/disks`
  / `sd*` sentinels in `/dev/engine`. The Pi's own root disk (from
  `findmnt -n -o SOURCE /`, e.g. `sda` with `sda1`/`sda2`) and all its partitions
  are excluded from the App Disk check (`script/test-preflight-lib.sh`). Override at your own risk: `IDEA_TEST_ALLOW_LIVE=1`.
  `IDEA_DIAGNOSTIC_LIVE=true pnpm test:diagnostic` reads a live store, so it needs
  the override on purpose.

## Workflow (idea#147)

1. Read the GitHub issue and the agreed-approach comment (no comment → ask Lead Bot). Implement with your own tools and read this file.
2. Claim an idle pool Pi, run the tests over SSH (see [Testing on a fleet Pi](#testing-on-a-fleet-pi-claim-protocol)), then release the Pi.
3. Run the QC gate (see Quality rules). FAIL → fix + one retry; still failing → escalate to Lead Bot with what failed, what was tried and the likely cause.
4. PASS → open the PR, post the full PR URL on the issue, and notify Ops Bot and Lead Bot with it (`https://github.com/koenswings/<repo>/pull/<N>`).
5. Ops Bot runs `find-available-pi.sh` and `deploy.sh` to a review Pi. Koen evaluates the PR on real Pi hardware and squash-merges. Ops Bot runs teardown and `update-golden.sh`.

**Never ask Koen to run a specific test** (standing rule, Steve 2026-09-28). Any test a change needs is written as an automated test: unit, integration, or on-Pi hardware such as `script/hw-roundtrip.ts`. It must pass before hand-off. A hand-off to Koen contains only the PR URL, the review URL and the automated test evidence, never manual test steps.

## Testing on a fleet Pi (claim protocol)

Follows idea `docs/grok-bot-setup.md` §4.6. The pool is **idea01, idea03, idea04**. **Never use golden idea02.** One job per Pi, and never take more than one Pi down at a time.

Claim before any SSH work (pick a Pi that is `idle`; `find-available-pi.sh` returns only idle Pis). Put the bot name in the claim note and do not overwrite the Pi's existing `note` field (it holds its isolation details):

```bash
BOT_NAME=<bot> tools/fleet/update-fleet-state.sh <pi> status testing
BOT_NAME=<bot> tools/fleet/update-fleet-state.sh <pi> claim "<bot>: <repo>#<issue/PR>"
```

Engine test rules on a claimed Pi:

- Leave the Pi's isolated store, `mdns: false` and its local `config.yaml` untouched.
- Stop the pm2 Engine as pi before testing (`pm2 stop engine`, never `sudo pm2`): the Engine needs exclusive USB/udev and `/disks`, and the test pre-flight refuses to run next to a live Engine.
- Test from a separate checkout, not the deployed tree (`/home/pi/idea/agents/agent-engine-dev`), kept off the fleet store.
- Keep `IDEA_NETWORK_TESTS` off unless an issue asks for it.
- Sudoers: you may install your PR's version of `11-engine-files` with `installEngineSudoers` **only** on a Pi you have claimed, and must restore main's version before releasing it. Golden idea02 sudoers stays with Atlas.
- Never modify `store-identity/store-template.json`, on any Pi or in the repo.
- **Disk PRs must pass the on-Pi hardware round trip before hand-off (idea#152).** This covers any change to docking, undocking, eject, mounting or disk records. On the claimed Pi, with the pm2 Engine stopped, run the PR's Engine from your separate checkout (own store, `mdns: false`, `httpPort` other than the fleet's, stdout to a log file). Dock a USB test disk that has at least two partitions (idea03's Ugreen SSD: vfat `system-boot` + ext4 `writable`). Then run, from that checkout:
  `pnpm test:hw --engine-log <engine stdout log> --cycles 2`
  On idea03 this is `cd /home/pi/axle-tests/<checkout> && pnpm test:hw --engine-log $(ls -t engine-run-*.log | head -1) --cycles 2`. The recorded test disk is matched by its IDs from `script/hw-roundtrip-disks.json`, and the run aborts before touching anything if they don't match. On another Pi, add its test disk to that file or pass `--stick-usb-serial`, `--disk-serial` and `--uuid`. It must pass twice in a row. Put the command and the `RESULT PASS` log lines in the PR body. It uses the tester's own `sudo` for the sysfs unplug/re-plug (never the Engine sudoers) and never touches the system drive or golden idea02.

Release when done: restore main in every tree you touched (and main's sudoers if you changed them), restart the Engine with pm2 as pi (`pm2 restart engine`), then:

```bash
BOT_NAME=<bot> tools/fleet/update-fleet-state.sh --null <pi> claim
BOT_NAME=<bot> tools/fleet/update-fleet-state.sh <pi> status idle
```

## Deploy (Ops Bot calls deploy.sh — do not deploy manually)

The fleet deploy scripts handle all deployment logic. The Dev Bot's job is to produce a passing test suite and open a PR — Ops Bot does the rest.

- **pm2 config changes (idea#128):** `pm2 restart engine` does not re-read `pm2.config.cjs`. A PR that changes it (e.g. `kill_timeout: 10000`) needs, as pi, `pm2 delete engine && pm2 start pm2.config.cjs && pm2 save` (or `pm2 reload pm2.config.cjs`) at deploy. Check with `pm2 describe engine` (`kill timeout` should read 10000). Say so in the PR body.

## config.yaml key settings

```yaml
settings:
  httpPort: 80          # Serves Console web app + /api/store-url
  consolePath: /home/pi/idea/agents/agent-console-dev/dist
  port: 4321            # Automerge WebSocket port
  testMode: false       # true = skip sudo mount/umount (tests)
  # skipImageLoad:      # optional; unset = follows testMode (idea#81). false = load
                        # services/<image>.tar at app start (production), true = skip
  # skipMetaWrite:      # optional; unset = follows testMode (idea#121). false = write
                        # META.yaml on the first dock of a disk without one (production)
```

`skipImageLoad` (env override `IDEA_SKIP_IMAGE_LOAD=true|false`) is separate from
`testMode`: testMode only skips the mount, the offline image load follows
`skipImageLoad()` in `src/data/Config.ts`. Production leaves both unset/false, so
Engines load every service image from the App Disk's `services/` folder
(`serviceImageTarPath()`: `/` in the image name → `_`). A missing tar or failed load
is a warning, not a failure: compose then pulls the image if the Pi has internet (idea#109).

`skipMetaWrite` (env override `IDEA_SKIP_META_WRITE=true|false`) works the same way
for the META.yaml written on the first dock of a disk that has none (idea#121,
`skipMetaWrite()` in `src/data/Config.ts`). Production leaves it unset, so the
Engine writes the disk's identity once and every later dock reads the same diskId.

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
- store-url.txt (idea#120): if it is missing, the Engine writes it back at startup with the fleet URL (`FLEET_STORE_URL` in `src/data/StoreIdentity.ts`, tested against the tracked file; that one test is skipped, with the reason in the log, on a Pi whose local store-url.txt holds its own well-formed URL while the committed file is the fleet URL, such as idea04 (idea#155, `test/harness/ownStore.ts`)); an existing file is never changed (an isolated Engine may use its own store ID). The Engine never writes store-template.json and refuses to start without it. `reset-engine --identity`/`--all` deletes `store-identity/*` including the template, so restore it afterwards with `git checkout -- store-identity/store-template.json` or the Engine will not start.
- udev rule 90-docking.rules must be present for USB detection. Installed by build-engine (`installUdev`). `boot.sh` (root, `@reboot` cron) reinstalls it on every boot when it is missing or differs from `script/build_image_assets/90-docking.rules`, then runs `udevadm control --reload && udevadm trigger` (idea#82); see `/home/pi/boot.out`. The Engine's startup self-check (`src/monitors/diskDetection.ts`, skipped when `IDEA_WATCH_DIR` is set) reports what is still broken, and mount/META/undock/monitor-start failures, as failed `diskDetection` traces in Console History. A changed `boot.sh` reaches a Pi only when build-engine (`installCrontabs`) copies it to `/usr/local/bin`.
- pm2 must run as pi user only. Root pm2 and pi pm2 are separate process lists. Never `sudo pm2`: `sync-engine`, `reset-engine` and build-engine (incl. `pm2-logrotate`) all use pi's pm2 and a plain `pnpm build`. Run `reset-engine` locally as pi (it refuses to run as root).
- The Engine's root commands are listed in two sudoers assets in `script/build_image_assets/`, both installed by build-engine (`installUdev` → `installEngineSudoers`, list `ENGINE_SUDOERS_FILES` in `src/data/Engine.ts`, each validated with `visudo`) with mode 0440 root:root and no `.` in the installed name (sudo ignores such files): `10-engine.sudoers` → `/etc/sudoers.d/10-engine` (mount, mount points, system disk `/META.yaml`, hdparm, reboot, system-disk app folders) and `11-engine-files.sudoers` → `/etc/sudoers.d/11-engine-files` (files and folders written or removed as root under `/disks`: `/usr/bin/tee /disks/sd[a-z][12]/META.yaml`, idea#121; `/usr/bin/rmdir /disks/sd[a-z][12]`, idea#126). New file and folder entries go into `11-engine-files`; `10-engine.sudoers` is not edited. A change to `11-engine-files` must be installed on every Engine (build-engine / `installEngineSudoers`, or by hand with `visudo -cf` and an atomic move) before the Engine code that needs it is deployed; check with `sudo -ll -U pi <exact command>`, which should name `/etc/sudoers.d/11-engine-files`. If you add a `sudo` call to src/, add the exact command to the right file in the same PR, with full binary paths where the code uses them and narrow patterns (`sd[a-z][12]`, never `/disks/*`); sudo matches the arguments exactly. The Engine reboots with `sudo /usr/bin/systemctl reboot` (exact arguments in the sudoers file), never `sudo reboot`: on Pi OS `/usr/sbin/reboot` is a symlink to systemctl and sudo matches by inode, so a `reboot` entry would allow any systemctl call. App Disk instance folders are written and removed as pi, without sudo. META.yaml on an App Disk is written with `sudo /usr/bin/tee /disks/<device>/META.yaml` (YAML on stdin, output to /dev/null) because the mount roots are root:root; under any other disks root (test and fixture roots) it is a plain write as pi. Mount point folders are removed with exactly `sudo /usr/bin/rmdir /disks/<device>`, only after `mountpoint -q` says they are no longer mount points (`src/monitors/mounts.ts`); never `rm -fr` a mount point. Pi OS's blanket `pi ALL=(ALL) NOPASSWD: ALL` is still in place (removal is a follow-up).
- build-engine's `installTailscale` (src/data/Engine.ts) sends the Tailscale auth key over stdin (`umask 077 && sudo tee /etc/tailscale/debug-authkey`), never as an argument, and never logs it; `tailscale-debug-activate.sh` uses `--auth-key=file:…` (idea#115). Keep it that way when touching either. Field Pis store one reusable, ephemeral fleet key that must be refreshed before it expires (max 90 days); see docs/PI_FLEET.md and idea#117.
- No GitHub token is used anywhere in the build or sync (idea#116): build-engine no longer asks for one, `sync-engine` excludes `gh_token.txt`, and `.gitignore` ignores `**/gh_token.txt` and `*.token`. The Engine repo is public; never add token files or token prompts back.
- pnpm test:full compiles into dist-test/ itself; it never rebuilds dist/. Run `pnpm build` separately when you need a fresh dist/ for the Engine.
- Leftover pretend disks from pre-idea#105 test runs (e.g. /disks/sdz1) make the pre-flight refuse; remove them by hand.

## Parked: Grok Build / self-hosted runner coding

**PARKED (2026-09-28, idea#147).** Do not use for new work unless Koen deliberately revives this path. Kept here so it is easy to revive; see idea `docs/grok-bot-setup.md` §2.2 and §9.

- History: Grok Build ran on a GitHub Actions self-hosted runner on an ARM64 Raspberry Pi, triggered headless, and its job was to produce a passing test suite and open a PR.
- Current state: Grok Build 1.0.40 (default model grok-4.6) stays installed on idea02; the runner service is stopped and `fleet-state.json` has `runner: parked`. The only workflow is the manual `runner-test.yml`.
- Reference for revival: Grok Build reads AGENTS.md natively at the start of a run; Plan Mode; headless `grok -p "task"`; install with `curl -fsSL https://x.ai/cli/install.sh | bash`, then `grok auth login`.
- Pis are test / review / golden hardware, not coding agents.
