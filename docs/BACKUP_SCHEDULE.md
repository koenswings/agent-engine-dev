# Scheduled Backup Disk (idea#400)

**Status:** Draft. It describes the design as agreed and grows with each PR (A to D). Only the parts marked *landed* exist in the code.

**Sources:**
- [`proposals/scheduled-backup-disk.md`](https://github.com/koenswings/idea/blob/main/proposals/scheduled-backup-disk.md) (idea repo, accepted by Koen 30 Oct 2026).
- The Engine contract and Steve's decisions on [idea#400](https://github.com/koenswings/idea/issues/400).
- The plan and Steve's answers to Q1–Q13 (13 Nov 2026, 11:26 CET).

## What it does

A Backup Disk in `scheduled` mode, docked to an Engine, backs up its linked instances once a day at a Pi-local time (default **02:30**). The schedule runs **inside the Engine** under pm2, as a 60 s tick; it is never a host cron job. Only the Engine the disk is docked to runs it (`dockedTo === localEngineId`), so there are no double runs across Engines.

## Pieces and PRs

| PR | What | State |
|---|---|---|
| A | `src/utils/backupSchedule.ts`: schedule parsing, Pi-local slots, the due decision, missed runs, the uptime counter, clock trust, jump detection, the skipped-run catch-up rule and the test clock offset. Pure functions, with unit tests (`test/automated/backup-schedule.test.ts`), plus the type-only store fields below. | *landed with PR A* |
| B | `src/data/BackupYamlDoc.ts`: document-preserving BACKUP.yaml edits (#344's atomic writer, now shared) for the link `lastBackup` and the state keys `schedule` / `lastRun` / `uptimeCounter` / `missedRuns` / `lastAttempt`, plus a lenient state reader. `processBackupDisk` mirrors `schedule` / `missedRuns` / `lastAttempt`. `src/data/BackupResults.ts` and `backupInstance` write `lastResult` / `backupHistory` for every attempt. Manual refusals start with `BUSY`; automatic ones record `SKIPPED_LOCKED`; a stale lock found at dock is recorded once as `INTERRUPTED`. `createBackupDisk scheduled` adds the 02:30 default. | *landed with PR B* |
| C | `src/monitors/backupScheduler.ts`: the tick, sequential runs per disk, locks, retry and catch-up, a one-change-per-run store summary (`freePct`, `clockTrusted` / `clockReason`, `cleaning` / `cleaningStartedAt`), and the build timestamp baked in at build. | planned |
| D | The `setBackupMode` command and the `scheduledBackups` capability. | planned |

The 05:00 reboot wrapper (it waits while `/run/idea/backup-running` exists, with a 90-minute cap) is its own small PR, separate from #292 and from this work. The Engine already writes that marker for every backup (`beginUsageSkip('backup')`, idea#411).

## BACKUP.yaml (on the disk: the source of truth)

```yaml
mode: scheduled
schedule:
  daily: "02:30"            # Pi-local, 24 h; absent means 02:30
links:
  - instanceId: <id>
    lastBackup: <unix ms>
lastRun:                    # the last scheduled run
  time: <unix ms>
  uptimeS: <s>
  bootId: <boot_id>
lastAttempt: <unix ms>
missedRuns: <n>
uptimeCounter:              # uptime since lastRun, across reboots
  bootId: <boot_id>
  baseUptimeS: <s>
  seenUptimeS: <s>
  carriedS: <s>
```

- `schedule.daily` must match `HH:MM` (00:00–23:59). Anything else is `BAD_TIME`. Any key other than `daily` is `BAD_SCHEDULE`: daily only, no cron syntax.
- Writers keep unknown keys (#344).
- The uptime counter is written at most hourly and on a new boot. It lives on the disk, **never in the store** (Q9).

## When a run is due

- **Trusted clock:** the run is due when the most recent slot is after `lastRun.time`. After any number of missed slots (Engine off, disk docked late), the overdue run happens **once**, and `missedRuns` records how many slots were skipped. A disk that has never run is due at once.
- **Untrusted clock:** one run per 24 h of accumulated uptime. Because of the 05:00 host reboot, a single boot never reaches 24 h, so the counter carries uptime across boots. With no counter (an older BACKUP.yaml), an untrusted clock does not run until the counter has counted 24 h.
- **Stale `lastRun`:** a `lastRun` more than 5 min in the future is stale, and the uptime counter decides instead. A backwards clock jump therefore never causes a second run, and never a prune.
- **Slots and DST:** slots follow Pi-local time. A slot in a DST spring-forward gap runs once at the shifted time (02:30 becomes 03:30); in a fall-back overlap it runs once at the first occurrence.
- **Undocked disk:** if the Backup Disk is undocked at the slot, nothing runs. When it docks again, the decision catches up once. An instance whose App Disk is not docked on this Engine gets `APP_DISK_NOT_DOCKED`.

## Clock trust

`clockTrusted` / `clockReason` come from these checks, in order:

| Reason | When |
|---|---|
| `BEFORE_BUILD` | Wall time is before the Engine build time (the git commit time baked in at build, Q12). |
| `BEFORE_STORE` | Wall time is more than 5 min before the newest store timestamp. |
| `AHEAD_OF_PEER` | Wall time is more than 24 h ahead of a synced peer. |
| `CLOCK_JUMP` | A jump was detected, and trust has not come back yet. It comes back at the next sync **or** after 24 h of uptime with no further jump, whichever comes first (Steve, #346), because a lone school Engine may never sync. A further jump restarts the 24 h. |
| `NEVER_SYNCED` | Neither NTP (`timedatectl NTPSynchronized`) nor a peer has confirmed the clock since boot. |

A jump is a wall-clock step of more than 2 min between two ticks, compared with the monotonic clock. The reason tokens are Engine-internal; the Console keys off `clockTrusted`.

## Locks, retries and catch-up (Steve, 13 Nov)

- Each instance runs through `backupInstance` and takes the same instance lock and Backup Disk lock as a manual `backupApp`. Instances on one disk run one after another.
- **A manual `backupApp` (Console or CLI) while a scheduled run holds the lock is refused with `BUSY`.**
- **A scheduled run that finds a lock held records `SKIPPED_LOCKED`**, then catches up **once, as soon as the lock frees, inside the same day's window**. Otherwise it waits for the next slot.
- **Retry once on a transient failure, never on a stale lock.** A stale `.backup-in-progress` is reported (`Disk.backupStaleLocks`, `INTERRUPTED`) and left to the idea#446 flow (`clearBackupLock`, then `backupApp`).
- A manual `backupApp` writes `lastResult` / `backupHistory` but never moves the schedule's `lastRun`.

## Store summary (types in PR A; mirror and results in PR B; run summary in PR C)

The store gets one change per run (and a `clockTrusted` / `clockReason` change only when the value changes), never one per tick. Progress during a run stays in `operationDB`. There is no `nextRun` and no per-App schedule in the store (Q7, Q8).

- `Disk.backupConfig.schedule`: `{ daily }` or null.
- `Disk.freePct`, `clockTrusted`, `clockReason`, `missedRuns`, `lastAttempt`, `cleaning`, `cleaningStartedAt` (all optional and null-safe), plus the existing `backupStaleLocks`.
- `Instance.lastResult`: `{ time, method, result }`.
- `Instance.backupHistory`: the newest 7 results, oldest first. `Instance.lastBackup` stays as the last success.
- `result` is one of `OK`, `HOOK_POST_WARNING` (success with a warning), `SKIPPED_LOCKED`, `HOOK_FALLBACK`, `INTERRUPTED`, `BACKUP_DISK_FULL`, `HELPER_OUTDATED`, `APP_DISK_NOT_DOCKED`, or `FAILED` for any other failure (Steve, #347 call 1).
- One code per attempt, by precedence (Steve, #347 call 2): `FAILED`, `SKIPPED_LOCKED`, `HOOK_FALLBACK`, `HOOK_POST_WARNING`, `HELPER_OUTDATED` (cleanup skipped), `OK`.
- A held lock: only a direct command with a waiting caller (Console, CLI) is refused with `BUSY` and records nothing. Everything without a caller, including an `immediate`-mode backup on dock, records `SKIPPED_LOCKED` (#347 call 4).
- An invalid `schedule` in BACKUP.yaml is logged and mirrored as null. **PR C must make it visible with a marker the Console can show** (#347 call 5).
- `method` is one of `stop`, `hook`, `live`, `none`.

## `setBackupMode` (draft; lands in PR D, then moves to COMMANDS.md)

- **Usage:** `setBackupMode <diskIdOrName> <immediate|on-demand|scheduled> [HH:MM]`. It runs on the Engine the disk is docked to. Only `mode` and `schedule` in BACKUP.yaml change, and the time is valid only with `scheduled`.
- **Planned refusal codes:** `NOT_DOCKED`, `NOT_A_BACKUP_DISK`, `BAD_BACKUP_YAML`, `BAD_MODE`, `BAD_TIME`, `BUSY`, as leading tokens in #344 style.
- **Capability:** `scheduledBackups`.

## Tests

- **Unit tests:** `test/automated/backup-schedule.test.ts` (fake wall, monotonic and uptime clock in `test/harness/fakeScheduleClock.ts`; fixtures in `test/fixtures/backup-schedule/`). They run in `Europe/Brussels` for the DST cases.
- **Test clock offset:** `IDEA_TEST_CLOCK_OFFSET_MS` is honoured only when `NODE_ENV=test` (Q10). It shifts only the scheduler's and the clock-trust check's view of the time, never the system clock.
- **Wrong-clock cases are proven in unit tests only** (Steve, #346 call 3). Under pm2 the Engine never runs with `NODE_ENV=test`, so the offset is inert on a Pi. The on-Pi proof runs on the real clock: slot, catch-up after a pm2 restart and a reboot, locks, undock and `APP_DISK_NOT_DOCKED`.
