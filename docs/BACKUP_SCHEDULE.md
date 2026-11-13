# Scheduled Backup Disk (idea#400)

**Status:** Draft. It describes the design as agreed and grows with each PR (A to D). Only the parts marked *landed* exist in the code (A, B and C on this branch; D is planned).

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
| C | `src/monitors/backupScheduler.ts`: the tick, sequential runs per disk, locks, retry and catch-up, a one-change-per-run store summary (`freePct`, `clockTrusted` / `clockReason`, `cleaning` / `cleaningStartedAt`), `backupConfig.scheduleError`, and the build timestamp baked in at build (`script/write-build-info.mjs`, `src/utils/buildInfo.ts`). Tests: `test/automated/backup-scheduler.test.ts`. | *landed with PR C* |
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

## The tick (PR C)

`startBackupScheduler` (from `start.ts`) runs one `BackupScheduler.tick()` every 60 s. A tick:

1. Reads the wall clock (plus the test offset, only under `NODE_ENV=test`), the monotonic clock, uptime and the boot id, and checks for a jump.
2. Takes every disk with `dockedTo === localEngineId`, a device, disk type `backup` and `backupConfig.mode === 'scheduled'`. A disk with a run already in progress is left alone.
3. Works out clock trust for the disk and writes `clockTrusted` / `clockReason` only when the value changes.
4. Reads BACKUP.yaml (the source of truth). If `schedule` or `scheduleError` changed while the disk was docked, it mirrors them. **An invalid schedule runs at the 02:30 default** (a missed nightly backup is worse than the default time, Steve #351 call 1). The store shows `backupConfig.scheduleError` (the `BAD_TIME` / `BAD_SCHEDULE` text, `schedule: null`) and the log says so once, until BACKUP.yaml is fixed (Steve, #347 call 5).
5. Decides if a run is due (PR A). If it is not, the tick writes the uptime counter to BACKUP.yaml when it should (hourly, or on a new boot), checks the `SKIPPED_LOCKED` catch-ups, and writes nothing to the store.

**A run:**
- It first claims the window on the disk, in one BACKUP.yaml edit: `lastRun { time, uptimeS, bootId }` (the run's start), `lastAttempt`, `missedRuns` and a reset uptime counter. A crash or a restart in the middle of a run therefore never starts the same window again.
- Each link then goes through `backupInstance` in turn, with cause `scheduled-backup`. `backupInstance` records the result.
- After the links, one store change (only the values that changed): `lastAttempt`, `missedRuns`, and `freePct` (statfs of the disk, rounded).

**Skipped instances:**
- An instance with a stale `.backup-in-progress` (on disk or in `backupStaleLocks`) is not run, and its `INTERRUPTED` result stands.
- An instance whose own backup is still running records `SKIPPED_LOCKED` without a second backup.
- An instance that left the store, or a disk that was undocked during the run, is skipped with a log line.

**Store changes:** at most one change per run per disk, plus one result change per attempt (`lastResult` / `backupHistory`). A tick with nothing to do changes nothing.

**After a restart** (Steve, #351 call 8): every tick decides from the `lastRun` / uptime counter stored in BACKUP.yaml, not from memory. A window missed while the Engine was down is caught up **once** at the first tick after the restart. A window that was already run (or claimed by a run the crash interrupted) is not run again.

**`lastAttempt` and `lastRun.time`** hold the same value (the run start) on purpose (PR B contract, #351 call 7). `lastAttempt` is the plain timestamp the store mirrors for the Console. `lastRun` stays on the disk only, with the uptime and boot id that the untrusted-clock path needs.

**Retry and catch-up after a lock** (Q2, Q3), both kept in memory only, so a restart drops them (#351 call 8: OK, because the window itself is worked out again from `lastRun`):
- **FAILED:** retried once, 60 s after the pass over the links. A second failure waits for the next slot. `BACKUP_DISK_FULL`, `HELPER_OUTDATED`, `APP_DISK_NOT_DOCKED`, `INTERRUPTED` and `SKIPPED_LOCKED` are never retried.
- **SKIPPED_LOCKED:** the instance is remembered with the run's window, which is the slot on the clock basis and the run start on the uptime basis. At the first tick where the instance lock, the Backup Disk lock and the in-memory mutex are all free, inside the same window, it runs once more. That catch-up is used even if it is skipped again. A new window drops the entry.

**Crash recovery:** `recoverInterruptedOperations` never retries a `backupApp` operation with cause `scheduled-backup`. It marks it `Failed` with `INTERRUPTED: …`. The lock file stays and is recorded as `INTERRUPTED` at dock, for the idea#446 flow (`clearBackupLock`, then `backupApp`).

**Cleaning** (`Disk.cleaning` / `cleaningStartedAt`): set when fullness cleanup starts deleting archives, and cleared when it ends. This holds for any backup, manual or scheduled. Two store changes, and only when cleanup deletes something. `cleaningStartedAt` stays as the time of the last cleanup.

**Clock inputs:**
- `ntpSynced` latches once `timedatectl NTPSynchronized` has said `yes` since the Engine started. After a jump, a reading of `yes` counts as the sync that brings trust back.
- The build floor is `dist/build-info.json`, written by `pnpm build` (`script/write-build-info.mjs`): the git commit time, Q12. A missing file skips the check.
- The "newest store timestamp" is the newest of the disk's `lastAttempt` and its linked instances' `lastBackup` / `lastResult.time`.
- There is no peer clock source in the store yet, so `AHEAD_OF_PEER` and the peer sync get no input (open call).

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

- `Disk.backupConfig.schedule`: `{ daily }` or null; `Disk.backupConfig.scheduleError`: the error text for an invalid schedule, else null (PR C).
- `Disk.freePct`, `clockTrusted`, `clockReason`, `missedRuns`, `lastAttempt`, `cleaning`, `cleaningStartedAt` (all optional and null-safe), plus the existing `backupStaleLocks`.
- `Instance.lastResult`: `{ time, method, result }`.
- `Instance.backupHistory`: the newest 7 results, oldest first. `Instance.lastBackup` stays as the last success.
- `result` is one of `OK`, `HOOK_POST_WARNING` (success with a warning), `SKIPPED_LOCKED`, `HOOK_FALLBACK`, `INTERRUPTED`, `BACKUP_DISK_FULL`, `HELPER_OUTDATED`, `APP_DISK_NOT_DOCKED`, or `FAILED` for any other failure (Steve, #347 call 1).
- One code per attempt, by precedence (Steve, #347 call 2): `FAILED`, `SKIPPED_LOCKED`, `HOOK_FALLBACK`, `HOOK_POST_WARNING`, `HELPER_OUTDATED` (cleanup skipped), `OK`.
- A held lock: only a direct command with a waiting caller (Console, CLI) is refused with `BUSY` and records nothing. Everything without a caller, including an `immediate`-mode backup on dock, records `SKIPPED_LOCKED` (#347 call 4).
- An invalid `schedule` in BACKUP.yaml is logged and mirrored as `schedule: null`, with `backupConfig.scheduleError` set to the error text (PR C, #347 call 5). The Console shows it; the disk runs at the 02:30 default until it is fixed (#351 call 1).
- `method` is one of `stop`, `hook`, `live`, `none`.

## `setBackupMode` (draft; lands in PR D, then moves to COMMANDS.md)

- **Usage:** `setBackupMode <diskIdOrName> <immediate|on-demand|scheduled> [HH:MM]`. It runs on the Engine the disk is docked to. Only `mode` and `schedule` in BACKUP.yaml change, and the time is valid only with `scheduled`.
- **Planned refusal codes:** `NOT_DOCKED`, `NOT_A_BACKUP_DISK`, `BAD_BACKUP_YAML`, `BAD_MODE`, `BAD_TIME`, `BUSY`, as leading tokens in #344 style.
- **Capability:** `scheduledBackups`.

## Tests

- **Tick tests (PR C):** `test/automated/backup-scheduler.test.ts`, with a fake clock and a fake `runBackup`, plus one run through the real `backupInstance` with borg skipped. They cover:
  - the slot firing once, with no store write on an idle tick and one summary change per run;
  - missed days, other Engines, and an invalid schedule;
  - the `SKIPPED_LOCKED` catch-up, retry once, stale locks, and `BUSY` naming the scheduled run;
  - `NEVER_SYNCED` and the uptime path across a reboot, `BEFORE_BUILD`, `BEFORE_STORE`, and forward and backward jumps;
  - crash recovery, `Disk.cleaning`, and the build info.
- **Unit tests:** `test/automated/backup-schedule.test.ts` (fake wall, monotonic and uptime clock in `test/harness/fakeScheduleClock.ts`; fixtures in `test/fixtures/backup-schedule/`). They run in `Europe/Brussels` for the DST cases.
- **Test clock offset:** `IDEA_TEST_CLOCK_OFFSET_MS` is honoured only when `NODE_ENV=test` (Q10). It shifts only the scheduler's and the clock-trust check's view of the time, never the system clock.
- **Wrong-clock cases are proven in unit tests only** (Steve, #346 call 3). Under pm2 the Engine never runs with `NODE_ENV=test`, so the offset is inert on a Pi. The on-Pi proof runs on the real clock: slot, catch-up after a pm2 restart and a reboot, locks, undock and `APP_DISK_NOT_DOCKED`.
