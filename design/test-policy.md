# Design: Test Policy — Engine Cross-Engine Tests

**Status:** Approved  
**Author:** Axle  
**Date:** 2026-04-10  

---

## Principle

All engines and apps reachable on the same LAN as the development/operations machine are
considered part of the operational environment. Running the cross-engine tests is equivalent
to running a diagnostic — the operator who triggers the tests understands that apps may be
stopped and restarted as part of the test sequence.

This is intentional and consistent with the physical management metaphor: inserting a test
disk and triggering a diagnostic run is a deliberate operator action.

## What tests may do

- **Stop and start any running instance** — including real production apps (Kolibri, Nextcloud, etc.)
- **Dock and undock fixture disks** via the sentinel mechanism (testMode skips actual mount/umount)
- **Write commands to any engine's command queue** via the shared CRDT
- **Read and assert on any state** in the shared store

## What tests must not do

- **Delete or modify app data** — Docker volumes, bind-mounted data directories, backup files
- **Eject a real production disk** in a way that leaves it permanently undocked without restart
  (ejectDisk is allowed but tests must restore state via startInstance before completion)
- **Modify config files** on fleet engines outside of testMode flag

## Implications for test design

**Fixture tests** (Tests 1–5): remain the primary mechanism — fast, deterministic,
predictable timing, no dependency on what apps happen to be running.

**Real-app propagation tests** (future): assert that state changes on real running apps
(e.g. Kolibri going Running→Stopped→Running) propagate correctly across all fleet observers.
These are valid and encouraged — they exercise the full system under realistic load.

**No isolation required**: tests do not need to avoid real apps or work around them.
If Nextcloud is running on wizardly-hugle when the tests run, and a test stops it and
restarts it, that is correct behaviour. The operator knows this when they run the tests.

## Cleanup obligation

Tests must restore what they change:
- Instances stopped by tests must be restarted by the end of the test run (afterAll)
- Fixture disks docked by tests must be undocked and cleaned up (afterAll)
- No net change to store state beyond what was already there before the test run

The shared CRDT store accumulates state across runs. Tests should call `clearAllCommands`
at the start of beforeAll to prevent stale command queues from interfering with assertions.
