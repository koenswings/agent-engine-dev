# Authoritative Documentation Index — Axle (agent-engine-dev)

Authoritative docs for the Engine project. See `../../docs/INDEX.md` for org-level docs.

Update this file whenever an authoritative doc is added or significantly revised.

---

## proposals/solution-description.md
**Status:** Historical proposal (not current)  ·  **Maintained by:** Axle
The original requirements and vision write-up. It is **not** an authoritative description of
Engine main (the file `docs/SOLUTION_DESCRIPTION.md` does not exist). Current behaviour is in
ARCHITECTURE.md and COMMANDS.md.
→ [proposals/solution-description.md](../proposals/solution-description.md)

## ARCHITECTURE.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Technical architecture of the Engine: distributed physical web app management, App Disk
detection, Docker container lifecycle, state synchronisation via Automerge CRDTs,
store durability and self-heal (engine#567 / #568), HTTP Console ports and idea.local (idea#203).
→ [docs/ARCHITECTURE.md](ARCHITECTURE.md)

## COMMANDS.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Reference for all Engine CLI commands: inspection, management, and diagnostic commands
with usage examples.
→ [docs/COMMANDS.md](COMMANDS.md)

## COMMAND_AUTH.md
**Status:** Authoritative for the steps on main (engine#582, built in steps)  ·  **Maintained by:** Axle
Operator sign-in and signed commands: Engine-local auth folder, CORS for own Console origins,
second confirmation for disk wipe and card flash, `createInstance` local-only and the git account
pin, command source on traces and the local audit log; later steps add sign-in, signed
commands, the relay and the firewall script.
→ [docs/COMMAND_AUTH.md](COMMAND_AUTH.md)

## BACKUP_SCHEDULE.md
**Status:** Authoritative (idea#400 PRs A–D and idea#404 are on main)  ·  **Maintained by:** Axle
Scheduled Backup Disk: in-Engine daily schedule, due/catch-up rules, uptime fallback and clock
trust, locks and retries, BACKUP.yaml fields, store summary fields, `setBackupMode`, and `makeBackupDisk` (idea#404).
→ [docs/BACKUP_SCHEDULE.md](BACKUP_SCHEDULE.md)

## SCRIPTS.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Reference for provisioning and utility scripts (`build-engine`, the `install.sh` wrapper, archive/release scripts): purpose,
parameters, and usage.
→ [docs/SCRIPTS.md](SCRIPTS.md)

## ENGINE_IMAGE.md
**Status:** Authoritative  ·  **Maintained by:** Axle
The offline Engine build into a mounted root filesystem for the release image builder (idea#322 Option A):
`script/build-engine-offline`, steps, sanitise/verify, lock, first boot, exit codes.
→ [docs/ENGINE_IMAGE.md](ENGINE_IMAGE.md)

## PI_FLEET.md
**Status:** Authoritative  ·  **Maintained by:** Axle
IDEA Pi test fleet: node inventory (idea01–idea04), hardware specs, provisioning
procedure, SSH access, and fleet management commands.
→ [docs/PI_FLEET.md](PI_FLEET.md)

## REPRODUCIBLE_BUILDS.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Content-identical reproducible Engine installs (idea#322): tagged-source gate, pinned inputs,
deployment records, comparison, input archives, kit retro records, MORANGO procedure.
→ [docs/REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md)

## STORE_HISTORY_R86Q.md
**Status:** Record (2026-10-13; addendum 2026-11-14)  ·  **Maintained by:** Axle
r86q diagnosis: why the shared store's history (heartbeats, metrics) made syncs slow, and the fixes (#192/#194, compaction). Addendum: items 1–3 (ephemeral heartbeats and metrics, 7-day ops archive) and the dev-pool compaction are now in place on Engine main; the diagnosis itself is unchanged.
→ [docs/STORE_HISTORY_R86Q.md](STORE_HISTORY_R86Q.md)

## USB-STICKS.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Teacher USB sticks (idea#193): Engine ⇄ app interface — `/run/idea-usb` mount root, read-only
vfat/exFAT mount options, store fields and what apps (Nextcloud, Kolibri) see.
→ [docs/USB-STICKS.md](USB-STICKS.md)

## USAGE-CONTRACT.md
**Status:** Authoritative (idea-usage process on main since #308 / `16c3174`; `/usr/local/sbin/idea-usage-export` is the Python asset, idea#412)  ·  **Maintained by:** Axle
Field usage monitoring (idea#411 / idea#412): `x-app.usage` hook shape and invocation,
day/sample/presence JSON schemas, on-disk layout under `/var/lib/idea/usage/`,
export wire format (`since`, `archive-and-clear`), off switch (`idea-usage-settings` `on`/`off`/`status`) and `usageSummaries`.
→ [docs/USAGE-CONTRACT.md](USAGE-CONTRACT.md)

## interfaces.json
**Status:** Static snapshot (intentionally not updated; idea#308)  ·  **Maintained by:** Axle
A one-off sample of Node's `os.networkInterfaces()` output from a Pi, kept as an example of the
shape the Engine reads. Not generated, not read by any code or test; it does not track the source.
→ [docs/interfaces.json](interfaces.json)

## source-bundle.md
**Status:** Generated bundle  ·  **Maintained by:** Axle
Generated bundle of the Engine source (`src/**/*.ts`, `package.json`, `tsconfig.json`) for offline/LLM review.
Regenerate with `pnpm bundle-context` (script/bundle-context.ts) when the source changes; last refreshed 2026-10-30 (idea#366).
→ [docs/source-bundle.md](source-bundle.md)

## styles/markdown-pdf.css
**Status:** Supporting asset (PDF styles)  ·  **Maintained by:** Axle
CSS stylesheet used by markdown-to-PDF rendering for Engine documentation.
Static stylesheet: intentionally unchanged unless the rendering changes (idea#308).
→ [docs/styles/markdown-pdf.css](styles/markdown-pdf.css)

## styles/markdown.css
**Status:** Supporting asset (styles)  ·  **Maintained by:** Axle
Base CSS stylesheet for rendered Engine markdown documentation.
Static stylesheet: intentionally unchanged unless the rendering changes (idea#308).
→ [docs/styles/markdown.css](styles/markdown.css)

## styles/tomorrow.css
**Status:** Supporting asset (styles)  ·  **Maintained by:** Axle
Syntax-highlight / theme CSS (Tomorrow) for rendered Engine markdown documentation.
Static stylesheet: intentionally unchanged unless the rendering changes (idea#308).
→ [docs/styles/tomorrow.css](styles/tomorrow.css)
