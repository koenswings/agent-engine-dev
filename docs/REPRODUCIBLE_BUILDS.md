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
other tags do not count). `--allow-untagged` builds anyway; the reasons are printed and
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
| Raspberry Pi archive | has no snapshots: exact versions in `script/build_image_assets/apt-rpi-pins.tsv` (`pkg<TAB>version`, filled from a captured reference Engine's `packages.tsv`); `installRpiPins` installs `<engine>/deb-cache/*.deb` if present, else `pkg=version`. The `.deb`s ship in the release archive | `src/data/Engine.ts` |
| Tailscale | `TAILSCALE_VERSION` + `TAILSCALE_ARM64_SHA256`, checked with `sha256sum -c` before install | `src/data/Engine.ts` |
| Docker images | the Engine runs none in production; app images are recorded by digest | `images.tsv` |

Still unpinned (listed in the PR): the `cli.github.com` apt repo (gh) and the Docker install.
Kits get the same approach once their versions are captured.

## 3. Deployment record (idea `deployments/` schema)

Records live in the **idea repo** (koenswings/idea) at
`deployments/engines/<hostname>/<label>/`, in the `idea-deployment-record/1` format defined by
idea `deployments/README.md` (idea#323). Schema helpers and tooling stay here.
At the end of a full build, `build-engine` runs `script/capture-engine-record.sh` on the
target and copies the result into `<idea checkout>/deployments/engines/<host>/<label>/`
(`--idea-repo DIR`, default `$IDEA_REPO_DIR`; without one it writes `/tmp/idea-deployment-<host>-<label>/`).
Commit it in the idea repo. `--batch NAME` sets `batch=`; `--no-record` skips it.

| File | Content |
|---|---|
| `record.txt` | `#` comments then `key=value`: the schema's required keys (`schema`, `batch`, `deviceType=engine`, `hostname`/`stickerName`, `arch`, `model`, `osRelease`, `imageCommit`/`Branch`/`Tag`/`Version`, `imageFile`/`imageSha256`/`imageManifest`=`n/a` for Engines, `packageArchive`, `secrets` (names only), `deployedAt`, `evidence`, `confidence`, `open`), then Engine keys (dirty/skip-worktree counts, Console commit and dist hash, lockfile sha256, tool versions, root helper sha256, `buildSource*`, `buildOptions`), `manualEdit.<id>`/`postInstall.<id>` for field changes, and `contentSha256` = sha256 of `files.sha256` + `dist.sha256` |
| `packages.tsv` | `dpkg-query -W` package, version, arch |
| `images.tsv` | every local Docker image: ref, image id, repo digests |
| `files.sha256` | sha256 of every tracked Engine file (except `store-identity/`) |
| `dist.sha256` | sha256 of the compiled `dist/` |

**No secrets:** the capture never reads `/etc/tailscale`, `~/.ssh`, `.env` or store keys;
build-engine runs `engine-record.ts check-secrets` on the copy and warns before commit.

The capture script is strictly **read-only**: no sudo, no installs, no restarts, output only
to a new folder under `/tmp` (it refuses anything else). It is safe to run on a kit Engine:

    bash script/capture-engine-record.sh [--engine-dir DIR] [--console-dir DIR] [--batch NAME] [--out /tmp/DIR]

## 4. Automatic comparison

    npx tsx script/engine-record.ts compare <record dir> <fresh record dir>

Exit 0 and `IDENTICAL (content)` when everything except the volatile keys (`VOLATILE_KEYS`:
`capturedUtc`, `hostname`, `batch`, `deployedAt`, `evidence`, …) matches. `UNKNOWN` values
never count. `--ignore-key K` and `--ignore-path P` add exclusions.
A rebuild check = build from the same tag on a spare Pi, capture, compare.

## 5. Archiving inputs and release assets

`script/archive-engine-inputs.sh <commit> <out> [image-ref...]` stores, for one commit:
`source.tar`, `pnpm-store/` (linux/arm64/glibc), the Node arm64 tarball (checked against
`SHASUMS256.txt`), `npm pack` tarballs of n/pnpm/pm2/pm2-logrotate, the pinned Tailscale
tarball (sha-checked), `debs/` from `script/archive-debs.py` (Debian `.deb`s from the
snapshot, Raspberry Pi `.deb`s from the pins or `ARCHIVE_RPI_CURRENT`, the indices used,
`index.tsv`, `missing.tsv`), Docker images for linux/arm64 and `SHA256SUMS` + `ARCHIVE.json`.
`ARCHIVE_PACKAGES=<packages.tsv>` archives exact versions from a captured record.

**Home (Steve, 2026-10-26):** GitHub release assets on the Engine release tag in
agent-engine-dev, plus the copy on the box (`/workspace/idea322-archive/`).

    script/release-archive.sh <tag> <commit> <archive-dir> <release-dir>

tars the archive, splits it into parts under 2 GB (`PART_SIZE`, default 1900m), writes
`SHA256SUMS`, `RELEASE-NOTES.md` (restore steps) and `gh-commands.sh` with the exact
`git tag` / `gh release create --verify-tag` / `gh release upload` commands. It runs none of
them: **Koen gives the go** and the commands are run then. Restore:
`cat <tag>.tar.part-* > <tag>.tar`, check `SHA256SUMS`, `tar -xf`.

## 6. Zimbabwe kit Engines (retro records)

Retro records for sunny-robin, happy-zebra and kind-panda are in the idea repo at
`deployments/engines/<host>/retro-2026-10-18/`: Engine `adfd9d3` (branch `deploy/kit-229-232`),
Console `62bd2ba` (dist only, checkout `main@654224e`), the adfd9d3 lockfile and tracked-file
hashes, and the manual MORANGO edit. Unknown fields say `UNKNOWN`; fill them in by running the
capture script when each Engine is next online (no other changes to kit Engines). The
adfd9d3 inputs are prepared as release `kit-adfd9d3-archive` (tag on `adfd9d3`; not
published until Koen's go). The kits' Tailscale and apt versions are unknown: the archive
holds Tailscale 1.104.2 (today's pin), the Debian snapshot indices of 2026-10-17 and today's
Raspberry Pi chromium `.deb`s.

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
