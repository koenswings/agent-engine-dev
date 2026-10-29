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

## Where Engine tests run (idea#335)

- **The Grok Bot box** (no live Engine): the default place for `pnpm test:full`, including the quality scan's Engine run.
- **A claimed idle pool Pi** with the pm2 Engine stopped (`pm2 stop engine`), per the claim protocol below; needed for `test:hw` and on-Pi checks.
- **Never** next to a live production Engine: idea01 while it serves the fleet, golden idea02, or 'idea'. The idea#105 pre-flight refuses there (live pm2 Engine, unlabelled containers, App Disks) and says so; do not override it with `IDEA_TEST_ALLOW_LIVE=1` to get a run through.
- Ports are not the conflict: the suite binds only ephemeral ports (`listen(0)` / freePort), never 80, 4321 or 8080, and uses its own temp `IDEA_WATCH_DIR` / `IDEA_DISKS_ROOT` and `dist-test/`. `test/automated/tests-beside-live-engine.test.ts` guards this, and it was checked on the box with 80, 4321 and 8080 held by other listeners during `test:full`.

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
- Engine state folder `~/.local/state/idea-engine/` (idea#133): compose overrides for Files Disk mounts (`files-overrides/`) and display-name JSON (`files-display/`); created at startup, no sudo. Atlas backs it up pre-deploy.
- store-url.txt (idea#120): if it is missing, the Engine writes it back at startup with the fleet URL (`FLEET_STORE_URL` in `src/data/StoreIdentity.ts`, tested against the tracked file; that one test is skipped, with the reason in the log, on a Pi whose local store-url.txt holds its own well-formed URL while the committed file is the fleet URL, such as idea04 (idea#155, `test/harness/ownStore.ts`)); an existing file is never changed (an isolated Engine may use its own store ID). The Engine never writes store-template.json and refuses to start without it. `reset-engine --identity`/`--all` deletes `store-identity/*` including the template, so restore it afterwards with `git checkout -- store-identity/store-template.json` or the Engine will not start.
- udev rule 90-docking.rules must be present for USB detection. Installed by build-engine (`installUdev`). `boot.sh` (root, `@reboot` cron) reinstalls it on every boot when it is missing or differs from `script/build_image_assets/90-docking.rules`, then runs `udevadm control --reload && udevadm trigger` (idea#82); see `/home/pi/boot.out`. The Engine's startup self-check (`src/monitors/diskDetection.ts`, skipped when `IDEA_WATCH_DIR` is set) reports what is still broken, and mount/META/undock/monitor-start failures, as failed `diskDetection` traces in Console History. A changed `boot.sh` reaches a Pi only when build-engine (`installCrontabs`) copies it to `/usr/local/bin`. `/dev/engine` itself comes from tmpfiles.d `idea-engine.conf` (build-engine `installUdev`) or, without it, from udev with the first sd* link: on an NVMe/SD-root Pi with no USB disk it may not exist. The USB device monitor treats that as "no USB devices", registers a non-sd root (nvme0n1p2, mmcblk0p2) directly, and attaches its watcher once the folder appears (one stat every 2 s); boot.sh grows the root partition found by `findmnt /` + `lsblk PKNAME`, never a fixed `/dev/sda` (agent-engine-dev#228).
- pm2 must run as pi user only. Root pm2 and pi pm2 are separate process lists. Never `sudo pm2`: `sync-engine`, `reset-engine` and build-engine (incl. `pm2-logrotate`) all use pi's pm2 and a plain `pnpm build`. Run `reset-engine` locally as pi (it refuses to run as root).
- The Engine's root commands are listed in two sudoers assets in `script/build_image_assets/`, both installed by build-engine (`installUdev` → `installEngineSudoers`, list `ENGINE_SUDOERS_FILES` in `src/data/Engine.ts`, each validated with `visudo`) with mode 0440 root:root and no `.` in the installed name (sudo ignores such files): `10-engine.sudoers` → `/etc/sudoers.d/10-engine` (mount, mount points, system disk `/META.yaml`, hdparm, reboot, system-disk app folders) and `11-engine-files.sudoers` → `/etc/sudoers.d/11-engine-files` (files and folders written, removed or re-owned as root under `/disks`: `/usr/bin/tee /disks/sd[a-z][12]/META.yaml`, idea#121; `/usr/bin/rmdir /disks/sd[a-z][12]`, idea#126; the disk root owner for `createFilesDisk`: `/usr/bin/chown -h pi\:pi /disks/sd[a-z][12]`, idea#131; `/usr/local/sbin/idea-erase-disk` (no argument list) and `/usr/bin/mount -t ext4 /dev/sd[a-z][12] /disks/sd[a-z][12]`, idea#134; `/usr/local/sbin/idea-app-data` (no argument list; the app-data root helper, idea#168, see docs/ARCHITECTURE.md). New file and folder entries go into `11-engine-files`; `10-engine.sudoers` is not edited. A change to `11-engine-files` must be installed on every Engine (build-engine / `installEngineSudoers`, or by hand with `visudo -cf` and an atomic move) before the Engine code that needs it is deployed; check with `sudo -ll -U pi <exact command>`, which should name `/etc/sudoers.d/11-engine-files`. If you add a `sudo` call to src/, add the exact command to the right file in the same PR, with full binary paths where the code uses them and narrow patterns (`sd[a-z][12]`, never `/disks/*`); sudo matches the arguments exactly. The Engine reboots with `sudo /usr/bin/systemctl reboot` (exact arguments in the sudoers file), never `sudo reboot`: on Pi OS `/usr/sbin/reboot` is a symlink to systemctl and sudo matches by inode, so a `reboot` entry would allow any systemctl call. Instance DATA (sizing, copy, cross-Pi send, delete, borg backup and restore) goes through the app-data root helper `sudo -n /usr/local/sbin/idea-app-data …` (idea#168), never a new `sudo rsync|rm|borg`; the Engine refuses to start (unless isDev) when the installed helper is missing or has another version. Its `/etc/idea/app-data-roots` bridge is TEST-ONLY (pool Pis until Stage 2), never on production. App masters and service tars are written and removed as pi, without sudo. META.yaml on an App Disk is written with `sudo /usr/bin/tee /disks/<device>/META.yaml` (YAML on stdin, output to /dev/null) because the mount roots are root:root; under any other disks root (test and fixture roots) it is a plain write as pi. `createFilesDisk` is the only code that changes a disk root's owner, with exactly `sudo -n /usr/bin/chown -h pi:pi /disks/<device>` and only when pi can't write the root (idea#131). Mount point folders are removed with exactly `sudo /usr/bin/rmdir /disks/<device>`, only after `mountpoint -q` says they are no longer mount points (`src/monitors/mounts.ts`); never `rm -fr` a mount point. Pi OS's blanket `pi ALL=(ALL) NOPASSWD: ALL` is still in place (removal is a follow-up).
- build-engine's `installTailscale` (src/data/Engine.ts) sends the Tailscale auth key over stdin (`umask 077 && sudo tee /etc/tailscale/debug-authkey`), never as an argument, and never logs it; `tailscale-debug-activate.sh` uses `--auth-key=file:…` (idea#115). Keep it that way when touching either. The key is only for that step: `installTailscale` removes `TAILSCALE_AUTHKEY` from build-engine's environment right after reading it, and every pm2 call in build-engine runs under `env -u TAILSCALE_AUTHKEY`, so the key never reaches the pm2 daemon, an app's env or `dump.pm2` (idea#273, `test/automated/pm2-no-authkey.test.ts`). build-engine runs `pm2 startup` with sudo (`sudo env PATH=$PATH:<node bin> <pm2> startup systemd -u pi --hp /home/pi`): it writes a systemd unit that starts pi's pm2 at boot; `pm2 start` and `pm2 save` stay as pi (idea#273). `tailscale-debug-activate.sh` advertises `tag:idea`. Field Pis store one reusable, ephemeral fleet key that must be refreshed before it expires (max 90 days); see docs/PI_FLEET.md and idea#117.
- DHCP vendor class (idea#209 D8, idea#284): every Engine sends DHCP option 60 `idea-engine` so the kit router gives it 10.42.0.2–.9. It is applied by `installRootHelpers` (build-engine via `installUdev`, `./install-root-helpers`, `sync-engine`), so every update re-applies it idempotently; it never restarts NetworkManager or drops a link (the new value is used from the next DHCP activation, at the latest the 05:00 reboot). Deploys that do not run `./install-root-helpers` must run `sudo install -o root -g root -m 0755 script/build_image_assets/idea-dhcp-vendor-class /usr/local/sbin/idea-dhcp-vendor-class && sudo /usr/local/sbin/idea-dhcp-vendor-class` and, when NetworkManager is active, `sudo nmcli general reload conf`.
- No GitHub token is used anywhere in the build or sync (idea#116): build-engine no longer asks for one, `sync-engine` excludes `gh_token.txt`, and `.gitignore` ignores `**/gh_token.txt` and `*.token`. The Engine repo is public; never add token files or token prompts back.
- Reproducible installs (idea#322, docs/REPRODUCIBLE_BUILDS.md): build-engine refuses an untagged, dirty or off-main checkout unless `--allow-untagged` (recorded); the Engine installs with `pnpm install --frozen-lockfile` and pinned n/pnpm/pm2/pm2-logrotate/Node (`src/data/Engine.ts`); Debian apt is pinned to `DEBIAN_SNAPSHOT`, Raspberry Pi packages to `script/build_image_assets/apt-rpi-pins.tsv` (+ `deb-cache/`), Tailscale to version + sha256, Docker Engine to `script/build_image_assets/docker-pins.tsv` (sha-checked debs, `deb-cache/docker/` first), the dev Dockerfile base by digest (gh apt repo stays unpinned: dev-only); record schema is idea `deployments/README.md` (archive keys `packageArchive`/`packageArchiveSha256`/`packageArchiveUrl`); `engine-record.ts compare|check` wraps idea `tools/repro/compare-record.py` + `volatile.txt` when available; field tags `field/<batch>/engine-<sha7>` are references, not build tags; release tags are `engine-vYYYY.MM.DD[-N]` on main, created only after Koen merges (agents never tag or publish releases); every full build writes an idea-format record (`idea-deployment-record/1`) to `<idea checkout>/deployments/engines/<hostname>/<label>/` (`--idea-repo`/`$IDEA_REPO_DIR`; commit it in the idea repo; secret-free). `script/install.sh` is only a wrapper around build-engine — no second install path. Input archives: `archive-engine-inputs.sh`, then `release-archive.sh` prepares split release assets + gh commands (not run). `script/capture-engine-record.sh` is read-only and is the only thing to run on kit Engines for records; compare with `npx tsx script/engine-record.ts compare` (`--idea-repo`).
- pnpm test:full compiles into dist-test/ itself; it never rebuilds dist/. Run `pnpm build` separately when you need a fresh dist/ for the Engine.
- Leftover pretend disks from pre-idea#105 test runs (e.g. /disks/sdz1) make the pre-flight refuse; remove them by hand.

## Parked: Grok Build / self-hosted runner coding

**PARKED (2026-09-28, idea#147).** Do not use for new work unless Koen deliberately revives this path. Kept here so it is easy to revive; see idea `docs/grok-bot-setup.md` §2.2 and §9.

- History: Grok Build ran on a GitHub Actions self-hosted runner on an ARM64 Raspberry Pi, triggered headless, and its job was to produce a passing test suite and open a PR.
- Current state: Grok Build 1.0.40 (default model grok-4.6) stays installed on idea02; the runner service is stopped and `fleet-state.json` has `runner: parked`. The only workflow is the manual `runner-test.yml`.
- Reference for revival: Grok Build reads AGENTS.md natively at the start of a run; Plan Mode; headless `grok -p "task"`; install with `curl -fsSL https://x.ai/cli/install.sh | bash`, then `grok auth login`.
- Pis are test / review / golden hardware, not coding agents.
- `script/build_image_assets/idea-flash-card` (idea#303, helper v2) now accepts a target with `rm=1` OR `tran=usb` (USB SSDs/HDDs), and takes `--os-rootfs <sdXN>` to allow META.yaml on a partition the Engine found to be an OS rootfs (an old Engine stick). It is a root helper installed by build-engine; install the new copy on an Engine BEFORE deploying the Engine code from this PR. With the old v1 helper an SSD flash fails safely with NOT_REMOVABLE and an old-Engine-stick flash fails safely with BAD_ARGS (unknown argument); nothing is written in either case.
- `script/build_image_assets/idea-flash-card` v3 (idea#208) takes `--timezone <zone>` and, after the verified write, calls the new root-owned copy `/usr/local/sbin/idea-write-card-timezone` (installed by build-engine `installRootHelpers`, no sudoers entry; sudoers unchanged) to write `idea-timezone.txt` on FAT partition 1. The Engine probes `sudo -n idea-flash-card --version` before each flash and passes `--timezone` only to v3 or later; an older helper or a failed or unknown probe means the time zone is skipped with a log line and the flash goes ahead. Deploy order doesn't matter, but both helpers must be installed for the file to be written. A missing `idea-write-card-timezone` only gives `"timezoneFile":"failed"` (flash still ok, client on UTC).
- `script/build_image_assets/idea-flash-card` v4 (idea#203 §2) takes `--home <engine-name>` and, after the verified write, calls the existing root helper `/usr/local/sbin/idea-write-home-engine` to write `idea-home.txt` = `<name>.local\n` on FAT partition 1 (until v4 nothing called it, so cards got no home Engine). The Engine passes `--home` only when the helper reports v4 or later, otherwise it logs a skip and the flash goes ahead. Redeploy `idea-flash-card` v4 together with `idea-write-home-engine` and `idea-write-card-timezone` (`installRootHelpers`) on every Engine that flashes cards; sudoers is unchanged. A failed home write leaves the flash ok with `"homeFile":"failed"`.

## Environment stalls in time-sensitive tests (idea#332)

The shared box sometimes freezes every process at once, for minutes at a time. Time-sensitive tests (duration-realfleet-ws, ws-concurrent-sync, duration-r86l-store-offthread) use `stallIt` from `test/harness/stallGuard.ts`. If such a test fails and a heartbeat worker thread, or the main thread's wall-vs-monotonic clock drift, shows the environment stalled ≥ 5 s during the test, the error is:

`ENVIRONMENT STALL (Ns): inconclusive — the process/box froze during this test; original error: ...`

The test still FAILS: it never passes silently. When you scan a test log, a failure whose message contains `ENVIRONMENT STALL (` is inconclusive (re-run it); any other failure is real. A main-thread-only block, meaning our own code hogging the loop, is not counted as a stall. Use `stallIt(name, body, timeoutMs)` for new timing-sensitive tests; vitest gets timeoutMs + 15 s so the guard reports first.

## Slow-host setup budgets (idea#332)

`ws-post-burst.test.ts`'s `beforeAll` (large doc import + server start) defaults to `180_000 * PI_TIMING_FACTOR` ms (180 s box, 360 s Pi). Set `IDEA_TEST_POST_BURST_SETUP_MS` (positive integer ms) to raise it on a slow host; `quality-scan.sh` sets it on Pi targets only. Profile (2026-10-28, main 2583608): setup 11 s on the box, 76 s on idea04 alone, >360 s under the full suite on idea04. Use `envTimeoutMs()` from `test/harness/hostEnv.ts` for such overrides; never for product assertions.
- `script/build_image_assets/idea-app-data` v4 (idea#347) adds `quarantine <root> <id>` (rename `instances/<id>` to `<root>/.idea-quarantine/<id>-<UTC stamp>`, root 0700, under the instance lock; no rm, sudoers unchanged). Rollout order: install the v4 helper on every Engine first (`installRootHelpers`), then deploy the Engine. The Engine starts with any helper version (startup only warns); against a helper older than v4 `removeInstance` refuses `HELPER_OUTDATED` and changes nothing.
- `script/build_image_assets/idea-app-data` v5 (#230, after v4 from #271) adds `snapshot <root> <id>`, `restore-snapshot <root> <id>` and `snapshots <root>` for updateApp (`<root>/.pre-update/<id>/`, root 0700, COMPLETE marker last, no rm; refuses while the app's containers run; NO_SPACE exit 3; named volumes exported offline with host tar and verified; a previous snapshot is renamed into .idea-quarantine; `snapshots` also prints the .pre-update/.idea-quarantine totals; read-only `estimate`; IN_USE refusal for volumes mounted by running containers; vanished volumes recreated on restore). Sudoers unchanged. Rollout: helper first on idea04, then idea03, then golden, the kit Engines later; then the Engine. The Engine starts with any helper (startup only warns); updateApp refuses `HELPER_OUTDATED` below v5.
- Cross-Engine `moveApp` (idea#79, capability `moveAppCrossEngine`, `src/data/MoveAppRemote.ts`): copy via copyApp, `verifyMoveTarget` on the target, then `removeInstance` (helper v4 quarantine). Never removes the source without a recorded verify; restart recovery never retries it. Both Engines need the new Engine build; the source needs helper v4+. No helper change. Codes: one list `MOVE_CODES` (MoveAppShapes.ts), on `Operation.move.code` and the trace `errorCode` / `result.code`.
