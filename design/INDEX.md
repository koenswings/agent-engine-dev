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

## test-setup-virtual.md
**Status:** Superseded  ·  **Date:** 2025-07-11  ·  **Author:** Axle
Proposal A (virtual/Docker battery) — not chosen. Retained as decision record.
→ [design/test-setup-virtual.md](test-setup-virtual.md)
