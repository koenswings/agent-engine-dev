# Comparison: Docker Battery vs Native Engine Test Setup

**Status:** Decision pending  
**Author:** Axle (Engine Developer)  
**Date:** 2025-07-11

This document compares two proposed automated test setups for the Engine. Read the
individual design documents for full detail on each approach.

- **Proposal A** — `docs/test-setup-design.md` — Docker Battery
- **Proposal B** — `docs/test-setup-native.md` — Native Engine

---

## Summary

| | Docker Battery (A) | Native Engine (B) |
|---|---|---|
| Engine runs in | Docker containers | Directly on host |
| App containers | Docker-in-Docker (complex) or mocked | Real Docker, starts normally |
| Multi-engine | 3 containers on bridge network | Real Pis on same LAN (conditional) |
| mDNS | Bypassed (explicit connect) | Tested for real |
| Test environment | Reproducible anywhere with Docker | Requires matching hardware |
| CI friendly | Yes (no Pi needed) | Partial (tier 1 only without Pis) |
| Test realism | Medium | High |

---

## Detailed Comparison

### 1. App Startup

**A — Docker Battery**

Engines run inside Docker containers. Starting apps requires Docker-in-Docker: the
containerised engine must call Docker to start app containers, which either requires
`--privileged` mode or Docker socket passthrough. Socket passthrough has a path-mapping
problem: volume mounts in `compose.yaml` reference paths inside the engine container,
which the host daemon cannot resolve. This makes real app startup complex enough that
the design defers it, asserting `Starting` status only.

**B — Native Engine**

The engine runs directly. `docker compose up` works exactly as in production. Apps start,
reach `Running`, and can be tested over HTTP. Playwright UI tests work against the live
container. No DinD, no path mapping issues, no mocking.

**Winner: B.** App startup is a core Engine responsibility. Mocking it reduces test
confidence at exactly the point that matters most in the field.

---

### 2. Multi-Engine Testing

**A — Docker Battery**

Three engine containers on a shared Docker bridge network. Fully reproducible: any
machine with Docker can run the battery. mDNS does not work across Docker bridges, so
peer discovery is replaced with explicit `connect` commands. This means discovery itself
is never tested.

**B — Native Engine**

Uses real Pis (or other machines) on a real LAN. mDNS discovery is tested as a
first-class feature. Tests gracefully skip if no peers are found, so the suite remains
runnable on a single machine. Remote Pi control uses SSH or the engine's own command
system — the same path used in production.

**Winner: B for realism, A for reproducibility.** B tests the actual peer discovery
path. A can run anywhere without hardware. The right choice depends on how important
mDNS coverage is and whether a Pi battery is available.

---

### 3. Test Fidelity

**A — Docker Battery**

- Disk dock/undock: real (file-based simulation, same as B)
- App startup: mocked (instance asserted `Starting`, Docker skipped)
- mDNS: not tested (explicit connect replaces it)
- CRDT sync: real (Automerge between containers)
- Engine join/leave: real (container stop/start)
- USB hardware: not tested (same as B)

**B — Native Engine**

- Disk dock/undock: real (same simulation as A)
- App startup: real (actual Docker containers)
- mDNS: real (engine's own mDNS stack)
- CRDT sync: real (over real network)
- Engine join/leave: real (systemctl stop/start or reboot)
- USB hardware: not tested (same as A)

**Winner: B.** The gaps are the same (USB hardware simulation). B covers more real
behaviour, specifically app startup and mDNS.

---

### 4. CI / CD Compatibility

**A — Docker Battery**

Runs on any CI runner with Docker. No special hardware. GitHub Actions, Gitea Actions,
any standard pipeline. The test environment is fully described by `compose-engine-test.yaml`
and is reproducible from scratch on any machine.

**B — Native Engine**

Tier 1 (local tests) runs on any machine with Docker — CI compatible. Tier 2 (network
tests) requires Pi devices on the same network as the CI runner. Self-hosted CI on a Pi
with a network peer would work; cloud CI would not run network tests (they skip cleanly).

**Winner: A for pure CI. B for CI + hardware lab.** If the project moves to self-hosted
CI on a Pi, B becomes equally CI-friendly. If CI stays on cloud runners, A is the only
option for full network test coverage.

---

### 5. Setup and Maintenance Burden

**A — Docker Battery**

- Build and maintain `compose-engine-test.yaml`
- Manage container images, build args, volume layouts
- Debug failures that only manifest in containerised environments
- When production config changes, update the battery compose file to match

**B — Native Engine**

- Maintain fixture disk directories and pre-pull app images
- Manage SSH key distribution to test Pis
- Ensure remote Pis are running and up to date before running network tests
- When production Pi setup changes, the test environment changes automatically

**Winner: B in the long run.** The battery introduces a parallel infrastructure track
that must be kept in sync with production. The native approach uses the same
infrastructure as production — no divergence is possible.

---

### 6. Developer Experience

**A — Docker Battery**

A developer without Pi hardware can run the full battery locally. Tests are
self-contained: `pnpm test` downloads or reuses containers and runs. Debugging is done
via container logs. Failures in app tests (which are mocked) may not reproduce on real
hardware.

**B — Native Engine**

A developer with only a laptop runs tier 1 tests with real apps. If they also have a
Pi on their network, tier 2 runs automatically. Debugging is straightforward — the
engine is a visible process, logs are local, the app UI is accessible in the browser.
A developer without Pi hardware cannot run network tests locally, but those tests skip
cleanly.

**Winner: depends on the team.** For a solo developer (current situation) with Pi
hardware available, B is simpler and more direct. For a larger team mixing laptop and
Pi developers, A offers broader baseline coverage.

---

### 7. Test Run Time

**A — Docker Battery**

Container startup: ~10–30 seconds. App tests: mocked (instant). Network tests: fast
(container network, low latency). Total: minutes.

**B — Native Engine**

App image pull (first run): minutes to hours depending on connection.  
App startup (Kolibri, Kiwix): 30–120 seconds per app.  
Network tests: real network latency, mDNS scan adds ~5 seconds.  
Total: longer, but not dramatically so once images are cached.

**Winner: A for raw speed. B is acceptable once images are cached.**

---

### 8. Coverage of the Real Failure Modes

The systems we are building run in schools with no IT support and no second chances.
The failure modes that actually matter are:

| Failure mode | Caught by A | Caught by B |
|---|---|---|
| App fails to start (bad compose.yaml) | No (mocked) | Yes |
| App crashes after startup | No (mocked) | Yes |
| Kolibri data corrupted on upgrade | No | Yes |
| mDNS not advertising correctly | No (bypassed) | Yes |
| Peer discovery fails on real network | No (bypassed) | Yes |
| CRDT sync diverges across Pis | Partial | Yes |
| Engine fails after reboot on Pi | No | Yes |

**Winner: B.** The failure modes that matter most in the field are not caught by A.

---

## Recommendation

**Choose B (Native Engine).**

The Docker Battery (A) is reproducible and CI-friendly, but it does not test the things
that break in schools: app startup failures, mDNS issues, real network sync. The native
approach is honest — the tests run on real hardware, real apps start, real networks are
scanned. When the tests pass, there is genuine confidence.

The practical trade-off: network tests (tier 2) require Pi hardware. This is acceptable
for this project. A developer without a Pi can still run all local tests including real
app startup. A Pi lab or self-hosted CI runner covers the full suite.

**If CI must run on cloud runners without Pi hardware,** keep Proposal A for the
continuous integration gate (it catches regressions in state management and CRDT logic),
and run Proposal B on a Pi lab as a nightly or pre-release check. These are not mutually
exclusive — the native test suite can run alongside the battery suite.

---

## Decision Criteria Checklist

Before deciding, answer these:

1. Will CI run on a cloud runner (GitHub Actions, etc.) or self-hosted on a Pi?
2. Is a Pi battery (2–3 devices) available for permanent test infrastructure?
3. How important is it to test mDNS discovery in the automated suite?
4. Are app startup failures and real Docker behaviour considered in scope for `pnpm test`?

If the answer to 2, 3, and 4 is yes: choose **B**.  
If CI must run on cloud and Pi hardware is not available: choose **A** for CI, **B** for Pi lab.
