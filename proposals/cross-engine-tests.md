# Design: Cross-Engine Integration Tests

**Status:** Implemented  
**Author:** Axle  
**Date:** 2026-04-09  

---

## Problem

The Engine's multi-engine behaviour — mDNS discovery, Automerge CRDT sync, and remote
command execution — cannot be verified by single-engine unit tests. These features only
work when two or more real Engine instances are running on the same LAN and communicating
over WebSockets.

Group Q in the backlog calls for cross-engine integration tests. This document defines
the scope, approach, and test structure.

---

## How the Shared Store Works

Every Engine provisioned from the same repo inherits the same `store-identity/store-url.txt`.
This file contains a single Automerge document ID — e.g. `automerge:4GQmEZehPDfryGDxkFo9XixbvmAC`.

When two engines discover each other via mDNS, they open a WebSocket connection and
Automerge automatically syncs their copies of that same document. There is no handshake,
no negotiation: the document ID is the shared key.

The test runner (running natively on the management Pi) has the same `store-url.txt`.
It can connect to any engine's WebSocket as a client and participate in the shared store
directly — no HTTP API needed. The `/api/store-url` endpoint exists only for browser
Console clients (which cannot read files from disk).

---

## Remote Command Execution

Commands are not sent over a separate channel. They are written directly into the CRDT:

```
engineDB[targetEngineId].commands.push("stopInstance foo disk-bar")
```

The target engine's `storeMonitor` watches for `put` patches on `engineDB[myId].commands`
and calls `handleCommand()` immediately. The result (e.g. an instance status change) is
written back into the shared store and syncs to all peers.

This means: any peer that can write to the store can issue commands to any engine. The
test runner uses this mechanism directly — no CLI, no SSH required for command dispatch.

---

## Approach

### Test Runner

Tests run on the management Pi (here), connecting as an Automerge client to the fleet
engines over LAN WebSockets. The test runner joins the shared store, observes changes,
and writes commands — exactly as a Console client would.

### Infrastructure Required

- Three Pis provisioned and running Engine (idea01, idea02, idea03 — done)
- All share the same `store-url.txt` (confirmed: `automerge:4GQmEZehPDfryGDxkFo9XixbvmAC`)
- `traefik/whoami` Docker image pre-pulled on idea01 (needed for disk dock test)
- SSH access from management Pi to all fleet nodes (done)

### Test Harness

```
test/cross-engine/
  cross-engine.test.ts    — the test suite
  remoteClient.ts         — connects to a fleet engine's WebSocket, exposes store handle
  remoteSSH.ts            — SSH helpers: dock/undock fixture, cleanup
```

`remoteClient.ts` is analogous to `diskSim.ts`'s `createTestStore`, but instead of
creating an in-memory store it connects to a live engine's WebSocket and retrieves the
shared document by its known ID.

`remoteSSH.ts` provides helpers to write/remove fixture files on a remote Pi via SSH,
simulating disk dock/undock on that engine.

---

## Test Suite

### Test 1 — mDNS Discovery & Store Sync

Connect to idea01's WebSocket. Wait (up to 60 s) for `engineDB` to contain entries for
at least idea01 and idea02. Assert:
- Both engines present in `engineDB`
- Both have `lastBooted > 0`

This proves: mDNS works, WebSocket sync works, engine self-registration works.

### Test 2 — Disk Dock Propagation

Via SSH, write the `disk-sample-v1` fixture to `/disks/sdz1/` on idea01 and create the
sentinel at `/dev/engine/sdz1`. Wait (up to 90 s) for instance `sample-00000000-test1`
to appear with `status === 'Running'` in the store as seen from our connection to idea01.

Then: connect a second client to idea02 and verify the same instance appears in its store
with the same status.

This proves: disk dock events propagate correctly across the CRDT to remote peers.

### Test 3 — Remote Command: stopInstance

From the test runner (connected to idea01's store), write `stopInstance sample-00000000-test1 sdz1`
into `engineDB[idea01Id].commands`. Wait (up to 30 s) for the instance status to become
`Stopped` as observed from idea02's connection.

This proves: the command-via-CRDT mechanism works end-to-end across engines.

### Test 4 — Remote Command: startInstance

Write `startInstance sample-00000000-test1 sdz1` into `engineDB[idea01Id].commands`.
Wait for status to return to `Running` as observed from idea02.

This proves: idempotent restart via remote command works.

### Test 5 — Undock Propagation

Via SSH, remove the sentinel on idea01. Wait for status to reach `Undocked` in both
the idea01 and idea02 stores.

Cleanup: remove fixture from `/disks/sdz1/` on idea01.

---

## Test Script

```json
"test:cross-engine": "vitest run test/cross-engine/"
```

Run manually on the management Pi when the fleet is online. Not run in CI (network-dependent).

---

## Timeout Budget

| Test | Timeout |
|---|---|
| Discovery (beforeAll) | 60 s |
| Dock → Running (local) | 90 s |
| Dock propagation (remote) | 30 s |
| stopInstance | 30 s |
| startInstance | 30 s |
| Undock propagation | 30 s |

---

## Constraints

- Tests are **sequential and stateful** — order matters
- Fleet must be online before running; tests fail fast if engines are unreachable
- No cross-engine rsync (copyApp/moveApp across engines) — Phase 2, separate design
- All other commands (ejectDisk, backupApp, etc.) use the same CRDT-write mechanism
  proven by Tests 3+4; they are covered by local-engine tests and do not need separate
  cross-engine variants

---

## Files

- `test/cross-engine/cross-engine.test.ts`
- `test/cross-engine/remoteClient.ts`
- `test/cross-engine/remoteSSH.ts`
- `package.json` — adds `test:cross-engine` script
- `design/cross-engine-tests.md` — this document
- `design/INDEX.md` — updated
