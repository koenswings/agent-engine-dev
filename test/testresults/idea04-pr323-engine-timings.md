# idea04 Engine-level port-ready timings (agent-engine-dev#323) — PARTIAL

- When: 2026-11-11 (Europe/Brussels, CET/UTC+1)
- Engine tip proved: `dbf1c87bd65f305a17dd151c1ac849c67836104d`
- app-nextcloud: `bdcbd241628cdef1ecc9ae99ddbb5f1aaba14a6d` (1.4-31.0.1, x-app.healthTimeout: 300)
- Isolated store: `automerge:2E1H3wQtSj8bGJpGEu9e1SBy7Jmy`
- System disk: `5vyahbut147hw5dp4e1` (sdb2)
- Instance: `nextcloud-303ppf7mkg1svtvn91x` name=axle323-nc port=64227
- Status: **first start measured; restart aborted** (Steve 16:39 CET: Koen about to pull idea04 power and unplug both SSDs). PR left as draft; not marked ready.

Times in seconds. `from command` starts when installApp / startInstance was queued. `from probe` starts at the Engine log line `assertInstancePortReady ... probing`.

## First start (installApp) — complete

The external 360s monitor timed out at 16:31:10 CET while store status was still `Pauzed` (expected after `compose create`, before HTTP-stable `Running`). The Engine continued and marked the instance Running after a 10s stable HTTP window, inside the 300000ms budget from `x-app.healthTimeout: 300`. HTTP and Running times are recovered from the Nextcloud Apache access log (first Engine `GET /` 302 from `172.27.0.1` at 16:31:23 CET) plus the Engine `stable for 10000ms (http)` rule. TCP and probe times come from the live monitor. Docker log timestamps for the same probe burst are about 2s later (first 16:31:25.311 CET, last 16:31:35.596 CET).

A 60s fallback would have failed this first start: TCP was up at 16:28:37 CET (docker-proxy) but Apache did not listen until 16:31:22 CET and the first HTTP 302 was at 16:31:23 CET (163.101s after probe start).

| Kind | Clock | TCP | HTTP | Running | Budget configured | HTTP status | Port |
|---|---|---:|---:|---:|---:|---:|---:|
| Nextcloud first start (installApp) | from command | 207.439 s | 372.947 s | 382.947 s | 300000 ms | 302 | 64227 |
| Nextcloud first start (port-ready wait) | from probe | -2.407 s | 163.101 s | 173.101 s | 300000 ms | 302 | 64227 |

Clock times (Europe/Brussels): command 16:25:10.053 CET; TCP 16:28:37.492 CET; probe 16:28:39.899 CET; first HTTP 302 16:31:23 CET; Running 16:31:33 CET (first HTTP + 10s stable).

## Restart (startInstance) — aborted, not a completed proof

`stopInstance` through the Engine succeeded (store status `Stopped`). `startInstance` was queued at 16:40:09.414 CET. Partial live monitor observations before emergency stop at 16:41:32 CET:

- status `Starting` then `Pauzed` (16:41:17 CET)
- TCP accept at 16:41:20 CET (`dt_tcp` 70.645 s from command)
- `assertInstancePortReady` probing (http, budget 300000ms) at 16:41:22 CET
- HTTP: **not recorded**
- Running: **not recorded**

| Kind | Clock | TCP | HTTP | Running | Budget configured | HTTP status | Port |
|---|---|---:|---:|---:|---:|---:|---:|
| Nextcloud restart (startInstance, ABORTED) | from command | 70.645 s | n/a | n/a | 300000 ms | n/a | 64227 |
| Nextcloud restart (port-ready wait, ABORTED) | from probe | -2.065 s | n/a | n/a | 300000 ms | n/a | 64227 |

## test:full

- idea04 `/home/pi/axle-323` @ `dbf1c87bd65f305a17dd151c1ac849c67836104d`
- rc=0
- Test Files 213 passed (213)
- Tests 2637 passed | 3 skipped (2640)
- Duration 1441.13s
- Log: `test/testresults/idea04-pr323-test-full-2026-11-11.log`

Negative check (budget fallback): unit tests already cover absent/invalid `healthTimeout` → 60 s (12/12 on the box after merging main into this tip).

## WD SSD note

The scratch Engine watches `/dev/engine` (udev), not `disksRoot`. It mounted WD SSD partition `sda2` (UPDTEST11, diskId `updtest11i76`) at `/home/pi/axle-323-proof/disks/sda2` and rewrote that partition's `META.yaml` `lastDocked` to `1794410309713` (2026-11-11 16:18:29 CET). No pre-write snapshot of `lastDocked` exists; the field that changed is `lastDocked` only. No instance was created or started on that disk. `sda1` (UPDTEST10) stayed mounted at `/disks/sda1` (Engine refused: already mounted). `sda3`/`sda4` were not mounted. The `lastDocked` write was left as-is (not undone). After the emergency stop, `META.yaml` was copied read-only and the private `sda2` mount was unmounted (`sync; umount`). Content immediately before unmount:

```
diskId: updtest11i76
isHardwareId: false
diskName: Update Test 1.1
created: 1793378552000
lastDocked: 1794410309713
```

`lastDocked` was still `1794410309713` at after-dock, before-restart, and before-unmount (no further write).
