# Reproducible Engine installs (idea#322)

**Decision (Koen, 2026-10-26):** every IDEA image and every field Engine install must be
*content-identical* reproducible from git and checked automatically. Byte-identical is not
required. This page covers the Engine part (agent-engine-dev). Client and router images are
Atlas's (idea `tools/client-image`, `tools/router-image`).

## 1. Build only from a tagged commit on main

`build-engine` reads the local checkout it syncs from (`git fetch origin main --tags`) and
refuses to build unless HEAD is **tagged, clean (no tracked changes) and on `origin/main`**
(`judgeSource()` in `src/install/deploymentRecord.ts`). `--allow-untagged` builds anyway; the
reasons are printed and written into the record (`buildSourceFlags`). `--dry-run` and
`--personalize` only warn.

## 2. Pinned inputs

| Input | Pin | Where |
|---|---|---|
| npm packages | `pnpm install --frozen-lockfile` (committed `pnpm-lock.yaml`) | `installEnginePM2` |
| pnpm | `PNPM_VERSION` = `packageManager` | `src/data/Engine.ts` |
| Node | `NODE_VERSION` (via `n`) | `src/data/Engine.ts` |
| n, pm2, pm2-logrotate | `N_VERSION`, `PM2_VERSION`, `PM2_LOGROTATE_VERSION` | `src/data/Engine.ts` |
| apt packages | **recorded, not yet pinned** (open decision: snapshot source) | `apt.txt` in the record |
| Tailscale | **recorded, not yet pinned** (installs latest stable tarball) | `tailscaleVersion` |
| Docker images | the Engine runs none in production (not containerised); app images are recorded by digest | `images.txt` |

## 3. Deployment record

At the end of a full build, `build-engine` runs `script/capture-engine-record.sh` on the
target and copies the result to `records/engines/<hostname>/<UTC label>/` in the local
checkout. **Commit that folder.** `--no-record` skips it.

| File | Content |
|---|---|
| `record.txt` | sticker name, Engine commit/branch/tag, dirty and skip-worktree counts, Console commit and dist hash, lockfile sha256, Node/npm/pnpm/pm2/Docker/Tailscale versions, root helper sha256, plus `buildSource*` and `buildOptions` from build-engine |
| `apt.txt` | `dpkg-query -W` package, version, arch |
| `images.txt` | every local Docker image: ref, image id, repo digests |
| `files.sha256` | sha256 of every tracked Engine file (except `store-identity/`) |
| `dist.sha256` | sha256 of the compiled `dist/` |

**No secrets:** the capture never reads `/etc/tailscale`, `~/.ssh`, `.env` or store keys;
build-engine runs `engine-record.ts check-secrets` on the copy and warns before commit.

The capture script is strictly **read-only**: no sudo, no installs, no restarts, output only
to a new folder under `/tmp` (it refuses anything else). It is safe to run on a kit Engine:

    bash script/capture-engine-record.sh [--engine-dir DIR] [--console-dir DIR] [--out /tmp/DIR]

## 4. Automatic comparison

    npx tsx script/engine-record.ts compare <committed record dir> <fresh record dir>

Exit 0 and `IDENTICAL (content)` when everything except the volatile keys (`capturedUtc`,
`hostname`, `recordLabel`, …) matches. `UNKNOWN` values (retro records) never count.
`--ignore-key K` and `--ignore-path P` (prefix with trailing `/`) add exclusions.
A rebuild check = build from the same tag on a spare Pi, capture, compare.

## 5. Archiving inputs

`script/archive-engine-inputs.sh <commit> <out> [image-ref...]` stores, for one commit:
`source.tar` (git archive), `pnpm-store/` (`pnpm fetch` from the lockfile for linux/arm64/glibc),
the Node arm64 tarball checked against nodejs.org `SHASUMS256.txt`, `npm pack` tarballs of
n/pnpm/pm2/pm2-logrotate, Docker images for linux/arm64 (`docker save`, or `crane pull` when
the host has no Docker) and `SHA256SUMS` + `ARCHIVE.json`. Apt `.deb`s are not fetched yet
(open decision 2).

Durable storage of archives is an **open decision** (Steve); options: GitHub release assets
on agent-engine-dev per tag (2 GB/file limit, public), a separate `idea-archive` repo with
Git LFS, or an offline disk kept with the kit plus a copy on the bot computer.

## 6. Zimbabwe kit Engines (retro records)

`records/engines/{sunny-robin,happy-zebra,kind-panda}/retro-2026-10-18/` record what is known
from git and the idea repo's `fleet-state.json`: Engine `adfd9d3` (branch
`deploy/kit-229-232`, deployed 2026-10-18), Console `62bd2ba` (agent-console-dev#162, dist
only, checkout `main@654224e`), the adfd9d3 lockfile hash and tracked-file hashes, and the
manual MORANGO edit. Unknown fields say `UNKNOWN`. Fill them in by running the capture script
when each Engine is next online (no other changes to kit Engines).

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
