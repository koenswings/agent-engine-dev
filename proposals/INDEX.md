# Proposals Index — Engine (agent-engine-dev)

Ideas seeking or having sought a decision in the Engine repo. See `koenswings/idea/proposals/README.md` for format and lifecycle.

---

## solution-description.md
**Status:** Living document · **Author:** Axle
Full requirements and vision for the Engine: mission, App Disk model, offline-first constraints, key design decisions, and feature inventory.

## test-setup-comparison.md
**Status:** Superseded by test-setup-native.md · **Author:** Axle
Comparison of Proposal A (Docker battery) vs Proposal B (native engine) for test execution.

## test-setup-native.md
**Status:** Implemented · **Author:** Axle
Native engine test setup: tests run on the Pi host via SSH. Adopted approach.

## test-setup-virtual.md
**Status:** Rejected · **Author:** Axle
Virtual test setup (Docker). Rejected in favour of native approach.

## test-policy.md
**Status:** Implemented · **Author:** Axle
Test categorisation policy: automated, diagnostic, cross-engine. Which tests run before PR, which run on fleet.

## cross-engine-tests.md
**Status:** Implemented · **Author:** Axle
Cross-engine test design: Group Q tests across multiple Pis, test sequence and assertions.

## run-architecture.md
**Status:** Approved — Engine part implemented (idea#80) · **Author:** Axle
Engine run architecture: which user runs the Engine, file ownership, permission model. Confirms pi user + targeted sudoers (`script/build_image_assets/10-engine.sudoers`).

## backup-disk.md
**Status:** Implemented · **Author:** Axle
Backup Disk format (BACKUP.yaml, BorgBackup), processBackupDisk, lock-file boot-resume, restoreApp.

## install-app.md
**Status:** Implemented · **Author:** Axle
installApp command: unified replacement for createInstance. Offline install from App Disk.

## copy-move-app.md
**Status:** Approved · **Author:** Axle
copyApp + moveApp commands and rsync infrastructure. Covers Operation store type, progress tracking, crash recovery.

## command-logging.md
**Status:** Implemented · **Author:** Axle
Per-command log capture via AsyncLocalStorage + Automerge CommandLogStore.

## duration-tests.md
**Status:** Proposed · **Author:** Axle
Markov-model duration tests: simulate a school day (reboots, disk swaps, engine changes) from YAML scenarios and verify invariants, including Automerge convergence across all engines.
