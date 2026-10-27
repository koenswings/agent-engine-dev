# Authoritative Documentation Index — Axle (agent-engine-dev)

Authoritative docs for the Engine project. See `../../docs/INDEX.md` for org-level docs.

Update this file whenever an authoritative doc is added or significantly revised.

---

## SOLUTION_DESCRIPTION.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Full requirements and vision for the Engine: mission, App Disk model, offline-first
constraints, key design decisions, and feature inventory. Axle reads this in full every session.
→ [docs/SOLUTION_DESCRIPTION.md](SOLUTION_DESCRIPTION.md)

## ARCHITECTURE.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Technical architecture of the Engine: distributed physical web app management, App Disk
detection, Docker container lifecycle, state synchronisation via Automerge CRDTs.
→ [docs/ARCHITECTURE.md](ARCHITECTURE.md)

## COMMANDS.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Reference for all Engine CLI commands: inspection, management, and diagnostic commands
with usage examples.
→ [docs/COMMANDS.md](COMMANDS.md)

## SCRIPTS.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Reference for provisioning and utility scripts (`build-engine`, the `install.sh` wrapper, archive/release scripts): purpose,
parameters, and usage.
→ [docs/SCRIPTS.md](SCRIPTS.md)

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
**Status:** Record (2026-10-13)  ·  **Maintained by:** Axle
r86q diagnosis: why the shared store's history (heartbeats, metrics) made syncs slow, and the fixes (#192/#194, compaction).
→ [docs/STORE_HISTORY_R86Q.md](STORE_HISTORY_R86Q.md)

## USB-STICKS.md
**Status:** Authoritative  ·  **Maintained by:** Axle
Teacher USB sticks (idea#193): Engine ⇄ app interface — `/run/idea-usb` mount root, read-only
vfat/exFAT mount options, store fields and what apps (Nextcloud, Kolibri) see.
→ [docs/USB-STICKS.md](USB-STICKS.md)

## interfaces.json
**Status:** Static snapshot (intentionally not updated; idea#308)  ·  **Maintained by:** Axle
A one-off sample of Node's `os.networkInterfaces()` output from a Pi, kept as an example of the
shape the Engine reads. Not generated, not read by any code or test; it does not track the source.
→ [docs/interfaces.json](interfaces.json)

## source-bundle.md
**Status:** Generated bundle  ·  **Maintained by:** Axle
Generated source bundle of Engine docs/code for offline review and PDF export.
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
