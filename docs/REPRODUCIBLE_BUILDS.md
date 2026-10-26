# Reproducible Engine installs (idea#322)

**Decision (Koen, 2026-10-26):** every IDEA image and every field Engine install must be
*content-identical* reproducible from git and checked automatically. Byte-identical is not
required. This page covers the Engine part (agent-engine-dev). Client and router images are
Atlas's (idea `tools/client-image`, `tools/router-image`).

## 1. Build only from a tagged commit on main

Release tags are **`engine-vYYYY.MM.DD[-N]`** (e.g. `engine-v2026.10.27`, a second release
that day `engine-v2026.10.27-2`). They go on `main` only, and only **after Koen merges**; agents
never create tags or releases. `build-engine` reads the local checkout it syncs from
(`git fetch origin main --tags`) and refuses to build unless HEAD carries such a tag, is clean
and is on `origin/main` (`judgeSource()` / `ENGINE_TAG_RE` in `src/install/deploymentRecord.ts`;
other tags do not count).

**Field/archive tags** `field/<batch>/engine-<sha7>` (e.g. `field/zimbabwe-2026-10/engine-adfd9d3`)
mark the commit a field batch was installed from and carry its input-archive release. They are
recognised (`FIELD_TAG_RE`, `isFieldTag`) but are **not** build tags: the gate still wants
`engine-v…`. Records put the field tag in `imageTag=`. `--allow-untagged` builds anyway; the reasons are printed and
written into the record (`buildSourceFlags`). `--dry-run` and `--personalize` only warn.

There is **one install path**: `build-engine`. `script/install.sh` (and `script/setup-dev.sh`)
only run `pnpm install --frozen-lockfile` for build-engine itself and then `exec ./build-engine`;
`pnpm install_packages` (compose files, `startdev.sh`) is `pnpm install --frozen-lockfile`.

## 2. Pinned inputs

| Input | Pin | Where |
|---|---|---|
| npm packages | `pnpm install --frozen-lockfile` (committed `pnpm-lock.yaml`) | `installEnginePM2` |
| pnpm | `PNPM_VERSION` = `packageManager` | `src/data/Engine.ts` |
| Node | `NODE_VERSION` (via `n`) | `src/data/Engine.ts` |
| n, pm2, pm2-logrotate | `N_VERSION`, `PM2_VERSION`, `PM2_LOGROTATE_VERSION` | `src/data/Engine.ts` |
| Debian apt | `DEBIAN_SNAPSHOT`: `pinAptSnapshot` writes `/etc/apt/sources.list.d/idea-debian-snapshot.sources` (snapshot.debian.org, `Check-Valid-Until: no`) and moves the stock Debian sources to `*.idea-disabled` (kept, not deleted) | `src/data/Engine.ts` |
| Raspberry Pi archive | Raspberry Pi OS keeps `raspi.sources` (archive.raspberrypi.com) enabled; it has no snapshots: exact versions in `script/build_image_assets/apt-rpi-pins.tsv` (`pkg<TAB>version`, filled from a captured reference Engine's `packages.tsv`); `installRpiPins` installs `<engine>/deb-cache/*.deb` if present, else `pkg=version`, then `apt-mark hold`. The `.deb`s ship in the release archive. (No Launchpad: that path is Ubuntu-only.) Unpinned RPi-archive packages still follow `apt upgrade` until they are listed | `src/data/Engine.ts` |
| Tailscale | `TAILSCALE_VERSION` + `TAILSCALE_ARM64_SHA256`, checked with `sha256sum -c` before install | `src/data/Engine.ts` |
| Docker Engine | `script/build_image_assets/docker-pins.tsv`: docker-ce / docker-ce-cli 5:29.9.2-1~debian.13~trixie, containerd.io 2.4.2-3~debian.13~trixie, docker-buildx-plugin 0.38.1-1~debian.13~trixie, docker-compose-plugin 5.6.1-1~debian.13~trixie (arm64) with sha256. download.docker.com has no snapshots, so `install-docker-pinned.sh` uses `<engine>/deb-cache/docker/*.deb` if present, else downloads that exact file; every .deb is sha256-checked before `apt-get install`, then held (`apt-mark hold`). No Docker apt repo is added | `installDocker` |
| Dev image | `Dockerfile` `FROM ubuntu:focal-20240123@sha256:bb1c4168…` (resolved with `crane digest`) | `Dockerfile` |
| Docker images | the Engine runs none in production; app images are recorded by digest | `images.tsv` |

Deliberately unpinned: the `cli.github.com` apt repo (`installGh`, gh). It is a **dev-only** tool for agents and is not used by the running Engine or by any app; installs on field Engines do not depend on it. (The dev `Dockerfile` still installs its own Docker via get.docker.com `--version 25.0.3`; dev only.)
Kits get the same approach once their versions are captured.

## 3. Deployment record (schema: idea `deployments/README.md`)

The record format, required keys, sidecars and archive keys (`packageArchive`,
`packageArchiveSha256`, `packageArchiveUrl`) are defined **only** in koenswings/idea
`deployments/README.md` (idea#323, `idea-deployment-record/1`). Engine records live at
`deployments/engines/<hostname>/<label>/`. This page keeps the Engine specifics.

**Writing a record.** At the end of a full build, `build-engine` runs
`script/capture-engine-record.sh` on the target and copies the result into
`<idea checkout>/deployments/engines/<host>/<label>/` (`--idea-repo DIR`, default
`$IDEA_REPO_DIR`; without one `/tmp/idea-deployment-<host>-<label>/`), adds `buildSource*`,
`buildOptions` and `packageArchive*` (`UNKNOWN` / `not published yet` until an archive exists;
fill from `release-archive.sh`'s `record-keys.txt`). `--batch NAME` sets `batch=`; `--no-record`
skips it. Commit the record in the idea repo. Engine-only keys: dirty/skip-worktree counts,
Console commit and dist hash, lockfile sha256, tool versions, root helper sha256.

**Capture** is strictly **read-only** (no sudo, no installs, no restarts, output only to a new
folder under `/tmp`, never reads `/etc/tailscale`, `~/.ssh`, `.env` or store keys). It is the only
thing to run on a kit Engine:

    bash script/capture-engine-record.sh [--engine-dir DIR] [--console-dir DIR] [--batch NAME] [--out /tmp/DIR]

## 4. Checking and comparing

    npx tsx script/engine-record.ts compare <expected dir> <actual dir> [--ignore-path P]... [--idea-repo DIR]
    npx tsx script/engine-record.ts check <dir> [--idea-repo DIR]
    npx tsx script/engine-record.ts check-secrets <dir>

`compare` and `check` are a thin wrapper: with python3 and an idea checkout (`--idea-repo` or
`$IDEA_REPO_DIR`) they run idea `tools/repro/compare-record.py` with its `volatile.txt`. Without
them (or with `--ts`, or `--ignore-key`) the same rules run in TypeScript: `UNKNOWN` never
differs, a sidecar is compared only when the expected side has it, `--ignore-path` is an exact
path or a prefix ending in `/`, and volatile keys are the `key:` lines of `volatile.txt`, else the
built-in `VOLATILE_KEYS`. `check-secrets` runs in build-engine before a record is kept.
A rebuild check = build from the same tag on a spare Pi, capture, compare.

## 5. Archiving inputs and release assets

`script/archive-engine-inputs.sh <commit> <out> [image-ref...]` stores, for one commit:
`source.tar`, `pnpm-store/` (linux/arm64/glibc), the Node arm64 tarball (checked against
`SHASUMS256.txt`), `npm pack` tarballs of n/pnpm/pm2/pm2-logrotate, the pinned Tailscale
tarball (sha-checked), `debs/` from `script/archive-debs.py` (Debian `.deb`s from the
snapshot, Raspberry Pi `.deb`s from the pins or `ARCHIVE_RPI_CURRENT`, the indices used,
`index.tsv`, `missing.tsv`), `debs/docker/` (the exact Docker Engine debs of `docker-pins.tsv`, sha-checked), Docker images for linux/arm64 and `SHA256SUMS` + `ARCHIVE.json`.
`ARCHIVE_PACKAGES=<packages.tsv>` archives exact versions from a captured record.

**Home (Steve, 2026-10-26):** GitHub release assets on the Engine release tag in
agent-engine-dev, plus the copy on the box (`/workspace/idea322-archive/`).

    script/release-archive.sh <name> <commit> <archive-dir> <release-dir> [--tag T] [--prerelease]

tars the archive, splits it into parts (`PART_SIZE`, default 200m), writes `SHA256SUMS`
(parts only), `RELEASE-NOTES.md` (restore steps, joined-tar sha256) and `gh-commands.sh` with
`gh release create <existing tag> --verify-tag` / `gh release upload` / `gh release view`. It
creates no tag and runs none of them: **Koen gives the go** and the tag is made separately. Restore:
`sha256sum -c SHA256SUMS`, `cat <name>.tar.part-* > <name>.tar`, check the joined sum from the notes, `tar -xf`. It also writes
`record-keys.txt` with the record keys below. The parts are not byte-reproducible (tar mtimes),
so publish exactly the prepared files whose sha256 the records carry.

Parts default to 200 MiB (`PART_SIZE`): 1 GB uploads from the box failed with `unexpected EOF`.

## 6. Zimbabwe kit Engines (retro records)

Retro records for sunny-robin, happy-zebra and kind-panda are in the idea repo at
`deployments/engines/<host>/retro-2026-10-18/`: Engine `adfd9d3` (branch `deploy/kit-229-232`),
Console `62bd2ba` (dist only, checkout `main@654224e`), the adfd9d3 lockfile and tracked-file
hashes, and the manual MORANGO edit. Unknown fields say `UNKNOWN`; fill them in by running the
capture script when each Engine is next online (no other changes to kit Engines). `imageTag`:
`field/zimbabwe-2026-10/engine-adfd9d3`. The adfd9d3 inputs are published as the **prerelease**
https://github.com/koenswings/agent-engine-dev/releases/tag/field/zimbabwe-2026-10/engine-adfd9d3
(assets `kit-adfd9d3-archive.tar.part-00..05` + `SHA256SUMS`; box copy
`/workspace/idea322-archive/release-kit-adfd9d3/`). The kits' Tailscale, Docker and apt versions
are unknown: the archive holds today's pins (Tailscale 1.104.2, `docker-pins.tsv`), the Debian
snapshot indices of 2026-10-17 and today's Raspberry Pi chromium `.deb`s.

## 7. MORANGO fix (app-kolibri#8)

The fix is app-side: app-kolibri#8 (merged, `b47d6eb`) adds
`MORANGO_SYSTEM_ID=idea-${hostname}-${port}` to the Kolibri compose file, so a new instance
built from app-kolibri main gets a unique Morango instance id. Nothing is needed in the
Engine build. On the three kit Engines it was applied **by hand** on 2026-10-17 (one-time
exception approved by Steve), recorded in the retro records:

1. Back up `/instances/<id>/compose.yaml` to `~/quarantine/<label>/<id>/compose.yaml`.
2. Add `- MORANGO_SYSTEM_ID=idea-${hostname}-${port}` after `KOLIBRI_LISTEN_PORT` in the
   Kolibri service environment.
3. `stopInstance`, wait until the containers are gone, then `startInstance`, both through
   the Engine command queue.
4. Check the new `morango_instanceidmodel` current id differs per instance; facility ids stay.

Engine backups of those instances taken before the edit restore the old shared id unless
the compose file is fixed again. The Engine's own copy path (`rebindKolibriMorangoInstanceId`,
r40) is unchanged.
