/**
 * backupSchedule.ts — pure schedule and clock-trust logic for scheduled Backup Disks (idea#400, PR A)
 *
 * Design: docs/BACKUP_SCHEDULE.md, proposals/scheduled-backup-disk.md §3.1–3.3 (idea repo).
 *
 * Nothing here touches the store, the disk, timers or the system clock: every
 * input (wall time, uptime, boot id, NTP state, peer clock) is passed in, so the
 * tick in PR C and the unit tests share one implementation.
 *
 *  - The schedule is per Backup Disk, in BACKUP.yaml: `schedule: { daily: "HH:MM" }`,
 *    Pi-local time, daily only (no cron syntax).
 *  - Trusted clock: due when the most recent past slot is after lastRun.time. An
 *    overdue run happens once, however many slots were missed (missedRuns counts them).
 *  - Untrusted clock: one run per 24 h of uptime accumulated since the last run. The
 *    counter survives reboots (the Pis reboot at 05:00, so one boot never reaches 24 h);
 *    it lives in BACKUP.yaml, never in the store (Steve, idea#400 Q9).
 *  - A lastRun in the future is stale: the decision falls back to the uptime counter,
 *    so a backwards clock jump never causes a second run.
 *  - A run skipped because a lock was held catches up once, inside the same window,
 *    as soon as the lock frees (Steve, idea#400 Q3).
 */

/** Default daily time for a new scheduled Backup Disk (proposal §9). */
export const DEFAULT_BACKUP_TIME = '02:30'
/** One scheduled run per this much uptime when the clock is not trusted. */
export const UPTIME_RUN_INTERVAL_S = 24 * 60 * 60
/** A wall-clock step larger than this between two ticks (vs monotonic time) is a jump. */
export const CLOCK_JUMP_THRESHOLD_MS = 2 * 60 * 1000
/** Slack for "earlier than the newest store timestamp" and "in the future" checks. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000
/** "More than a day ahead of a synced peer" (proposal §3.2). */
export const PEER_AHEAD_LIMIT_MS = 24 * 60 * 60 * 1000
/** The uptime counter is written to BACKUP.yaml at most this often (disk file, not the store). */
export const UPTIME_COUNTER_PERSIST_S = 60 * 60
/** Upper bound for the missed-slot count (a disk shelved for years still reports a number). */
export const MISSED_RUNS_CAP = 999
/** Env var for the test-only clock offset (Steve, idea#400 Q10). Honoured only when NODE_ENV=test. */
export const TEST_CLOCK_OFFSET_ENV = 'IDEA_TEST_CLOCK_OFFSET_MS'

const DAILY_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/

// ── Schedule config ──────────────────────────────────────────────────────────

/** `schedule:` in BACKUP.yaml, mirrored into Disk.backupConfig.schedule. */
export interface BackupSchedule {
    daily: string
}

export class BackupScheduleError extends Error {
    constructor(readonly code: 'BAD_TIME' | 'BAD_SCHEDULE', message: string) {
        super(`${code}: ${message}`)
        this.name = 'BackupScheduleError'
    }
}

/** Parse "HH:MM" (24 h, two digits each). Throws BAD_TIME. */
export const parseDailyTime = (raw: unknown): { hour: number, minute: number } => {
    if (typeof raw !== 'string') throw new BackupScheduleError('BAD_TIME', `daily time must be a string "HH:MM", got ${JSON.stringify(raw)}`)
    const m = DAILY_TIME.exec(raw.trim())
    if (!m) throw new BackupScheduleError('BAD_TIME', `'${raw}' is not a 24-hour time "HH:MM" (00:00–23:59)`)
    return { hour: Number(m[1]), minute: Number(m[2]) }
}

/**
 * Parse BACKUP.yaml `schedule:`. Absent or null gives null (no schedule set:
 * a scheduled disk then uses DEFAULT_BACKUP_TIME, see effectiveSchedule).
 * Anything else that is not `{ daily: "HH:MM" }` throws BAD_SCHEDULE / BAD_TIME.
 */
export const parseBackupSchedule = (raw: unknown): BackupSchedule | null => {
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BackupScheduleError('BAD_SCHEDULE', `schedule must be a mapping like { daily: "${DEFAULT_BACKUP_TIME}" }`)
    }
    const keys = Object.keys(raw as Record<string, unknown>)
    const extra = keys.filter(k => k !== 'daily')
    if (extra.length > 0) {
        throw new BackupScheduleError('BAD_SCHEDULE', `only 'daily' is supported (daily only, no cron syntax); found ${extra.map(k => `'${k}'`).join(', ')}`)
    }
    const daily = (raw as Record<string, unknown>).daily
    const { hour, minute } = parseDailyTime(daily)
    return { daily: formatDailyTime(hour, minute) }
}

export const formatDailyTime = (hour: number, minute: number): string =>
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

/** The schedule a scheduled-mode disk runs: its own, or the 02:30 default. */
export const effectiveSchedule = (schedule: BackupSchedule | null | undefined): BackupSchedule =>
    schedule ? schedule : { daily: DEFAULT_BACKUP_TIME }

// ── Slots (Pi-local time) ────────────────────────────────────────────────────

/**
 * The local-time slot of `daily` on the calendar day of `dayRef` (local).
 * A slot inside a DST spring-forward gap resolves the way Date does (02:30 → 03:30);
 * in a fall-back overlap it is the first occurrence. Either way there is one slot per day.
 */
const slotOnDay = (dayRef: Date, hour: number, minute: number): number =>
    new Date(dayRef.getFullYear(), dayRef.getMonth(), dayRef.getDate(), hour, minute, 0, 0).getTime()

/** The most recent slot at or before `nowMs` (Pi-local time). */
export const mostRecentSlot = (nowMs: number, schedule: BackupSchedule): number => {
    const { hour, minute } = parseDailyTime(schedule.daily)
    const now = new Date(nowMs)
    const today = slotOnDay(now, hour, minute)
    if (today <= nowMs) return today
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0, 0)
    return slotOnDay(yesterday, hour, minute)
}

/** The first slot strictly after `slotMs` (the end of that slot's window). */
export const nextSlotAfter = (slotMs: number, schedule: BackupSchedule): number => {
    const { hour, minute } = parseDailyTime(schedule.daily)
    const d = new Date(slotMs)
    return slotOnDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12, 0, 0, 0), hour, minute)
}

/** Number of slots in (afterMs, nowMs], capped at MISSED_RUNS_CAP + 1. */
export const slotsBetween = (afterMs: number, nowMs: number, schedule: BackupSchedule): number => {
    if (!(nowMs > afterMs)) return 0
    let count = 0
    let slot = mostRecentSlot(nowMs, schedule)
    while (slot > afterMs && count <= MISSED_RUNS_CAP) {
        count++
        slot = mostRecentSlot(slot - 1, schedule)
    }
    return count
}

// ── BACKUP.yaml run state ────────────────────────────────────────────────────

/** BACKUP.yaml `lastRun`: wall time, uptime and boot of the last scheduled run (proposal §3.2, Q9). */
export interface BackupLastRun {
    time: number
    uptimeS: number
    bootId: string | null
}

/**
 * BACKUP.yaml `uptimeCounter`: uptime accumulated since the last scheduled run,
 * across reboots. elapsed = carriedS + (seenUptimeS - baseUptimeS).
 *  - bootId: the boot this segment belongs to (/proc/sys/kernel/random/boot_id)
 *  - baseUptimeS: uptime at which this boot's segment started (the run, or 0 after a reboot)
 *  - seenUptimeS: the newest uptime seen in this boot (persisted at most hourly)
 *  - carriedS: uptime counted in earlier boots since the run
 * A lost hour (the Engine stopped between two writes) only makes the next run later,
 * never earlier, so a counter can never cause a double run.
 */
export interface BackupUptimeCounter {
    bootId: string
    baseUptimeS: number
    seenUptimeS: number
    carriedS: number
}

/** Counter right after a run (or for a new disk) on this boot. */
export const resetUptimeCounter = (bootId: string, uptimeS: number): BackupUptimeCounter =>
    ({ bootId, baseUptimeS: uptimeS, seenUptimeS: uptimeS, carriedS: 0 })

/** Advance the counter to the current boot and uptime. A new boot carries the old segment over. */
export const advanceUptimeCounter = (counter: BackupUptimeCounter | null | undefined, bootId: string, uptimeS: number): BackupUptimeCounter => {
    if (!counter) return { bootId, baseUptimeS: 0, seenUptimeS: uptimeS, carriedS: 0 }
    if (counter.bootId === bootId && uptimeS >= counter.baseUptimeS) {
        return { ...counter, seenUptimeS: Math.max(counter.seenUptimeS, uptimeS) }
    }
    const segment = Math.max(0, counter.seenUptimeS - counter.baseUptimeS)
    return { bootId, baseUptimeS: 0, seenUptimeS: uptimeS, carriedS: counter.carriedS + segment }
}

export const uptimeElapsedS = (counter: BackupUptimeCounter | null | undefined): number | null =>
    counter ? counter.carriedS + Math.max(0, counter.seenUptimeS - counter.baseUptimeS) : null

/** True when the advanced counter should be written to BACKUP.yaml (new boot, or an hour since the last write). */
export const shouldPersistUptimeCounter = (persisted: BackupUptimeCounter | null | undefined, current: BackupUptimeCounter): boolean =>
    !persisted ||
    persisted.bootId !== current.bootId ||
    current.seenUptimeS - persisted.seenUptimeS >= UPTIME_COUNTER_PERSIST_S

// ── Clock trust ──────────────────────────────────────────────────────────────

export type ClockReason = 'NEVER_SYNCED' | 'BEFORE_BUILD' | 'BEFORE_STORE' | 'AHEAD_OF_PEER' | 'CLOCK_JUMP'

export interface ClockTrustInput {
    nowMs: number
    /** NTP synchronised at some point since boot (timedatectl NTPSynchronized). */
    ntpSynced: boolean
    /** A synced peer's clock agreed with ours (within tolerance) since boot. */
    peerSynced: boolean
    /** Engine build time: the git commit time baked in at build (Q12); null when unknown. */
    buildTimeMs: number | null
    /** Newest timestamp found in the store; null when none. */
    newestStoreTimeMs: number | null
    /** A synced peer's current time estimate (hb `now`), or null when no synced peer. */
    syncedPeerNowMs: number | null
    /** An outstanding jump (advanceClockJumpState returned non-null): untrusted until sync or 24 h. */
    jumpSinceSync?: boolean
}

export interface ClockTrust {
    clockTrusted: boolean
    clockReason: ClockReason | null
}

/**
 * Proposal §3.2. Checks run from "certainly wrong" to "not confirmed":
 * before build, before the store, ahead of a synced peer, a jump since sync, never synced.
 */
export const evaluateClockTrust = (i: ClockTrustInput): ClockTrust => {
    const untrusted = (clockReason: ClockReason): ClockTrust => ({ clockTrusted: false, clockReason })
    if (i.buildTimeMs != null && i.nowMs < i.buildTimeMs) return untrusted('BEFORE_BUILD')
    if (i.newestStoreTimeMs != null && i.nowMs < i.newestStoreTimeMs - CLOCK_SKEW_TOLERANCE_MS) return untrusted('BEFORE_STORE')
    if (i.syncedPeerNowMs != null && i.nowMs > i.syncedPeerNowMs + PEER_AHEAD_LIMIT_MS) return untrusted('AHEAD_OF_PEER')
    if (i.jumpSinceSync) return untrusted('CLOCK_JUMP')
    if (!i.ntpSynced && !i.peerSynced) return untrusted('NEVER_SYNCED')
    return { clockTrusted: true, clockReason: null }
}

/**
 * After a clock jump the clock is untrusted (CLOCK_JUMP) until the next sync OR
 * 24 h of uptime with no further jump, whichever comes first (Steve, #346 call 2):
 * a lone school Engine may never sync, and its trust must not stay lost forever.
 * A further jump restarts the 24 h. null = no outstanding jump. Kept in memory by
 * the tick (PR C); uptime is counted with the same counter rules as the schedule.
 */
export interface ClockJumpState {
    counter: BackupUptimeCounter
}

/** Uptime with no further jump after which trust returns without a sync. */
export const JUMP_TRUST_RECOVERY_S = 24 * 60 * 60

/** A jump was detected now: (re)start the recovery window. */
export const noteClockJump = (bootId: string, uptimeS: number): ClockJumpState =>
    ({ counter: resetUptimeCounter(bootId, uptimeS) })

/**
 * Advance an outstanding jump. `syncedSinceJump`: an NTP sync or a peer agreement
 * observed after the jump. Returns null once trust is back.
 */
export const advanceClockJumpState = (
    state: ClockJumpState | null | undefined, bootId: string, uptimeS: number, syncedSinceJump: boolean,
): ClockJumpState | null => {
    if (!state) return null
    if (syncedSinceJump) return null
    const counter = advanceUptimeCounter(state.counter, bootId, uptimeS)
    return (uptimeElapsedS(counter) ?? 0) >= JUMP_TRUST_RECOVERY_S ? null : { counter }
}

/** One tick's reading: wall clock and a monotonic clock (performance.now()). */
export interface ClockSample {
    wallMs: number
    monoMs: number
}

/** Compare wall and monotonic deltas between two ticks. */
export const detectClockJump = (prev: ClockSample, cur: ClockSample, thresholdMs = CLOCK_JUMP_THRESHOLD_MS): 'forward' | 'backward' | null => {
    const drift = (cur.wallMs - prev.wallMs) - (cur.monoMs - prev.monoMs)
    if (drift > thresholdMs) return 'forward'
    if (drift < -thresholdMs) return 'backward'
    return null
}

// ── Due decision ─────────────────────────────────────────────────────────────

export interface BackupDueInput {
    nowMs: number
    clockTrusted: boolean
    schedule: BackupSchedule
    lastRun: BackupLastRun | null | undefined
    /** The counter already advanced to this boot and uptime (advanceUptimeCounter). */
    uptimeCounter: BackupUptimeCounter | null | undefined
}

export interface BackupDue {
    due: boolean
    basis: 'clock' | 'uptime' | 'first-run'
    /** The slot (clock basis) this run belongs to; null on the uptime basis. */
    slotMs: number | null
    /** Slots missed before this run (0 when on time or not due). */
    missedRuns: number
    /** lastRun lies in the future (beyond tolerance): stale, uptime decides instead. */
    lastRunStale: boolean
}

/**
 * Is a scheduled run due now? Never depends on the wall-clock date when the clock
 * is untrusted or lastRun is stale. A disk that never ran is due at once (first-run).
 */
export const decideBackupDue = (i: BackupDueInput): BackupDue => {
    const last = i.lastRun ?? null
    const lastRunStale = last != null && last.time > i.nowMs + CLOCK_SKEW_TOLERANCE_MS
    if (last == null) {
        return { due: true, basis: 'first-run', slotMs: i.clockTrusted ? mostRecentSlot(i.nowMs, i.schedule) : null, missedRuns: 0, lastRunStale: false }
    }
    if (i.clockTrusted && !lastRunStale) {
        const slotMs = mostRecentSlot(i.nowMs, i.schedule)
        const due = last.time < slotMs
        const missedRuns = due ? Math.min(MISSED_RUNS_CAP, Math.max(0, slotsBetween(last.time, i.nowMs, i.schedule) - 1)) : 0
        return { due, basis: 'clock', slotMs, missedRuns, lastRunStale }
    }
    const elapsed = uptimeElapsedS(i.uptimeCounter)
    // No counter (an older BACKUP.yaml) on an untrusted clock: start counting now, never run blind.
    if (elapsed == null) return { due: false, basis: 'uptime', slotMs: null, missedRuns: 0, lastRunStale }
    const due = elapsed >= UPTIME_RUN_INTERVAL_S
    const missedRuns = due ? Math.min(MISSED_RUNS_CAP, Math.floor(elapsed / UPTIME_RUN_INTERVAL_S) - 1) : 0
    return { due, basis: 'uptime', slotMs: null, missedRuns, lastRunStale }
}

/**
 * Q3: an instance skipped with SKIPPED_LOCKED catches up once, as soon as the lock
 * frees, while still inside the window it was skipped in. `windowId` is the slot
 * (clock basis) or the run's start (uptime basis); the caller keeps it in memory.
 */
export interface SkippedRun {
    windowId: number
    catchUpUsed: boolean
}

export const skippedCatchUpDue = (skipped: SkippedRun | null | undefined, currentWindowId: number, lockFree: boolean): boolean =>
    !!skipped && !skipped.catchUpUsed && skipped.windowId === currentWindowId && lockFree

/** The window an uptime-basis run belongs to ends when the next run is due again. */
export const windowIdFor = (due: BackupDue, runStartedMs: number): number =>
    due.slotMs ?? runStartedMs

// ── Test-only clock offset (Q10) ─────────────────────────────────────────────

/**
 * Offset added to the scheduler's and the clock-trust check's wall time. Only when
 * NODE_ENV=test; otherwise 0 whatever the env var says. Never the system clock.
 */
export const testClockOffsetMs = (env: NodeJS.ProcessEnv = process.env): number => {
    if (env.NODE_ENV !== 'test') return 0
    const raw = env[TEST_CLOCK_OFFSET_ENV]
    if (raw === undefined || raw.trim() === '') return 0
    const n = Number(raw)
    return Number.isSafeInteger(n) ? n : 0
}

/** Wall time as the scheduler sees it. */
export const scheduleNowMs = (nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): number =>
    nowMs + testClockOffsetMs(env)
