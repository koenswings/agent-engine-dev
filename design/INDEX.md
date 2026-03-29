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
**Status:** Partially Implemented (PR 1 of 6 complete)  ·  **Date:** 2025-07-11  ·  **Author:** Axle
Adopted design for native engine test setup: runs tests on the Pi host via SSH from the
OpenClaw container. SSH command= restriction via `scripts/run-tests.sh` wrapper (see `../../design/ssh-key-management.md`).
→ [design/test-setup-native.md](test-setup-native.md)

## test-setup-virtual.md
**Status:** Superseded  ·  **Date:** 2025-07-11  ·  **Author:** Axle
Proposal A (virtual/Docker battery) — not chosen. Retained as decision record.
→ [design/test-setup-virtual.md](test-setup-virtual.md)
