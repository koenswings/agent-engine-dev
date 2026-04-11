# Design Document Index — Axle (agent-engine-dev)

Engine-local design documents. See `../../design/INDEX.md` for org-level design docs.

Update this file whenever a local design doc is added, superseded, or its status changes.

---

## test-setup-comparison.md
**Status:** Superseded (decision made)  ·  **Date:** 2025-07-11  ·  **Author:** Axle
Compares Proposal A (Docker battery) vs Proposal B (native engine) for test execution.
Proposal B selected — see `test-setup-native.md` for the adopted design.
→ [design/test-setup-comparison.md](test-setup-comparison.md)

## test-setup-native.md
**Status:** Implemented  ·  **Date:** 2025-07-11  ·  **Author:** Axle
Adopted design for native engine test setup: runs tests on the Pi host via SSH from the
OpenClaw container. SSH command= restriction via `scripts/run-tests.sh` wrapper (see `../../design/ssh-key-management.md`).
→ [design/test-setup-native.md](test-setup-native.md)

## run-architecture.md
**Status:** Approved — implementation deferred  ·  **Date:** 2026-03-30  ·  **Author:** Axle
Run architecture review: which user runs the Engine, file ownership, and permission model.
Proposes Engine run as `pi` with targeted sudoers rules rather than root via `sudo pm2`.
The approach is confirmed valid; implementation is deliberately deferred — the current
restricted Docker environment for OpenClaw is considered acceptable for now.
→ [design/run-architecture.md](run-architecture.md)

## backup-disk.md
**Status:** Implemented  ·  **Date:** 2026-04-04  ·  **Author:** Axle
Backup Disk format (BACKUP.yaml, BorgBackup repos), `isBackupDisk`, `processBackupDisk`,
`backupInstance` with lock-file boot-resume, `checkPendingBackups`, `restoreApp`,
`createBackupDisk`, `diskTypes`/`backupConfig`/`lastBackup` store fields.
→ [design/backup-disk.md](backup-disk.md)

## copy-move-app.md
**Status:** Approved  ·  **Date:** 2026-04-07  ·  **Author:** Axle
Design for `copyApp` + `moveApp` commands and the rsync infrastructure that underpins them.
Covers file layout, generalised `Operation` store type, progress tracking, crash recovery, same-engine phase 1, and test strategy.
→ [design/copy-move-app.md](copy-move-app.md)

## duration-tests.md
**Status:** Proposed  ·  **Date:** 2026-04-11  ·  **Author:** Axle
Markov-model duration tests: simulate a school day of real-world activity (reboots, disk swaps,
engine changes). YAML scenario files drive the Markov chain. Each transition triggers actions
and verifies invariants including Automerge convergence across all engines.
→ [design/duration-tests.md](duration-tests.md)

## test-policy.md
**Status:** Approved  ·  **Date:** 2026-04-10  ·  **Author:** Axle
Test policy for cross-engine tests: tests may stop/start any running app on the LAN
(including real production apps). Only constraint: never delete or modify app data.
Equivalent to running a diagnostic — operator consent is implied.
→ [design/test-policy.md](test-policy.md)

## cross-engine-tests.md
**Status:** Implemented  ·  **Date:** 2026-04-09  ·  **Author:** Axle
Cross-engine integration test design: mDNS discovery, CRDT sync propagation, and remote
command execution (stopInstance/startInstance) across real fleet Pis. Covers store URL
architecture, remote client harness, SSH fixture helpers, and test scope.
→ [design/cross-engine-tests.md](cross-engine-tests.md)

## test-setup-virtual.md
**Status:** Superseded  ·  **Date:** 2025-07-11  ·  **Author:** Axle
Proposal A (virtual/Docker battery) — not chosen. Retained as decision record.
→ [design/test-setup-virtual.md](test-setup-virtual.md)

## install-app.md
**Status:** Proposed  ·  **Date:** 2026-04-11  ·  **Author:** Axle
Unified `installApp` command replacing `createInstance`. Covers naming convention cleanup
(`*App` vs `*Instance`), source routing (local disk vs GitHub with internet probe), `appDB`
extension for Backup/Catalog Disk visibility, deprecated `createInstance` alias, and
four-phase implementation plan.
→ [design/install-app.md](install-app.md)

## duration-tests.md
**Status:** Proposed  ·  **Date:** 2026-04-11  ·  **Author:** Axle
Markov-model duration tests: simulate a school day of real-world activity (reboots, disk swaps,
engine changes). YAML scenario files drive the Markov chain. Each transition triggers actions
and verifies invariants including Automerge convergence across all engines.
→ [design/duration-tests.md](duration-tests.md)
