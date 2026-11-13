/**
 * backup-schedule.test.ts (idea#400, PR A)
 *
 * Pure schedule and clock-trust logic: schedule parsing, Pi-local slots (with DST),
 * due decision and once-only catch-up, missedRuns, the uptime fallback across
 * reboots, stale (future) lastRun, clock jumps, the skipped-run catch-up window
 * (Q3), clock trust reasons and the NODE_ENV=test-only clock offset (Q10).
 * Runs in Europe/Brussels so the DST cases are fixed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fs, path, YAML } from 'zx'
import {
    DEFAULT_BACKUP_TIME, UPTIME_RUN_INTERVAL_S, CLOCK_JUMP_THRESHOLD_MS, TEST_CLOCK_OFFSET_ENV, MISSED_RUNS_CAP,
    parseDailyTime, parseBackupSchedule, effectiveSchedule, BackupScheduleError,
    mostRecentSlot, nextSlotAfter, slotsBetween,
    resetUptimeCounter, advanceUptimeCounter, uptimeElapsedS, shouldPersistUptimeCounter,
    evaluateClockTrust, detectClockJump, decideBackupDue, skippedCatchUpDue, windowIdFor,
    testClockOffsetMs, scheduleNowMs,
    BackupLastRun, BackupUptimeCounter, ClockTrustInput,
} from '../../src/utils/backupSchedule.js'
import { BACKUP_HISTORY_LENGTH } from '../../src/data/CommonTypes.js'
import { fakeScheduleClock } from '../harness/fakeScheduleClock.js'

const HOUR = 3_600_000
const MIN = 60_000
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const S = { daily: '02:30' }
// Repo-root relative, like diskSim's FIXTURES_DIR (this pure test does not load diskSim).
const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures')
const fixture = (name: string) => YAML.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'backup-schedule', name), 'utf-8'))

let savedTz: string | undefined
beforeAll(() => { savedTz = process.env.TZ; process.env.TZ = 'Europe/Brussels' })
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz })

describe('schedule config (BACKUP.yaml schedule)', () => {
    it('parses daily HH:MM and normalises spaces', () => {
        expect(parseDailyTime('02:30')).toEqual({ hour: 2, minute: 30 })
        expect(parseDailyTime(' 23:59 ')).toEqual({ hour: 23, minute: 59 })
        expect(parseBackupSchedule({ daily: '00:00' })).toEqual({ daily: '00:00' })
        expect(parseBackupSchedule(undefined)).toBeNull()
        expect(parseBackupSchedule(null)).toBeNull()
    })

    it('refuses every invalid fixture case with BAD_TIME or BAD_SCHEDULE', () => {
        const { cases } = fixture('schedule-invalid.yaml')
        expect(cases.length).toBe(7)
        for (const c of cases) {
            let err: unknown
            try { parseBackupSchedule(c) } catch (e) { err = e }
            expect(err, JSON.stringify(c)).toBeInstanceOf(BackupScheduleError)
            expect((err as Error).message).toMatch(/^(BAD_TIME|BAD_SCHEDULE): /)
        }
    })

    it('a scheduled disk without a schedule runs at the 02:30 default', () => {
        const y = fixture('scheduled-default.yaml')
        expect(y.mode).toBe('scheduled')
        expect(parseBackupSchedule(y.schedule)).toBeNull()
        expect(effectiveSchedule(parseBackupSchedule(y.schedule))).toEqual({ daily: DEFAULT_BACKUP_TIME })
        expect(DEFAULT_BACKUP_TIME).toBe('02:30')
    })

    it('reads lastRun and uptimeCounter from the after-run fixture and keeps unknown keys in the parse', () => {
        const y = fixture('scheduled-ran.yaml')
        expect(parseBackupSchedule(y.schedule)).toEqual(S)
        expect(new Date(y.lastRun.time).toISOString()).toBe('2026-11-12T01:30:05.000Z')
        expect(uptimeElapsedS(y.uptimeCounter)).toBe(9000 + 7200)
        expect(y.futureKey).toEqual({ keep: true })
    })

    it('history length is 7 (proposal §3.6)', () => {
        expect(BACKUP_HISTORY_LENGTH).toBe(7)
    })
})

describe('slots in Pi-local time', () => {
    it('most recent slot is today after 02:30 and yesterday before it', () => {
        expect(mostRecentSlot(local(2026, 11, 13, 2, 30), S)).toBe(local(2026, 11, 13, 2, 30))
        expect(mostRecentSlot(local(2026, 11, 13, 14, 0), S)).toBe(local(2026, 11, 13, 2, 30))
        expect(mostRecentSlot(local(2026, 11, 13, 2, 29), S)).toBe(local(2026, 11, 12, 2, 30))
        expect(nextSlotAfter(local(2026, 11, 13, 2, 30), S)).toBe(local(2026, 11, 14, 2, 30))
    })

    it('DST spring forward (29 Mar 2026): the 02:30 gap resolves to one slot that day', () => {
        const slot = mostRecentSlot(local(2026, 3, 29, 12, 0), S)
        expect(new Date(slot).toISOString()).toBe('2026-03-29T01:30:00.000Z') // 03:30 CEST
        expect(slotsBetween(local(2026, 3, 28, 12, 0), local(2026, 3, 29, 12, 0), S)).toBe(1)
        expect(nextSlotAfter(slot, S)).toBe(local(2026, 3, 30, 2, 30))
    })

    it('DST fall back (25 Oct 2026): 02:30 happens twice but is one slot', () => {
        expect(slotsBetween(local(2026, 10, 24, 12, 0), local(2026, 10, 25, 12, 0), S)).toBe(1)
        const slot = mostRecentSlot(local(2026, 10, 25, 12, 0), S)
        expect(nextSlotAfter(slot, S)).toBe(local(2026, 10, 26, 2, 30))
    })

    it('slotsBetween counts slots in (after, now] and is capped', () => {
        expect(slotsBetween(local(2026, 11, 10, 3, 0), local(2026, 11, 13, 3, 0), S)).toBe(3)
        expect(slotsBetween(local(2026, 11, 13, 3, 0), local(2026, 11, 13, 3, 0), S)).toBe(0)
        expect(slotsBetween(local(2020, 1, 1), local(2026, 11, 13, 3, 0), S)).toBe(MISSED_RUNS_CAP + 1)
    })
})

describe('due decision, trusted clock', () => {
    const ran = (t: number): BackupLastRun => ({ time: t, uptimeS: 1000, bootId: 'b1' })

    it('due once at the slot, not again on the next ticks', () => {
        const c = fakeScheduleClock(local(2026, 11, 13, 2, 28))
        let lastRun: BackupLastRun | null = ran(local(2026, 11, 12, 2, 30))
        const fired: number[] = []
        for (let i = 0; i < 24 * 60; i++) {
            const d = decideBackupDue({ nowMs: c.wallMs, clockTrusted: true, schedule: S, lastRun, uptimeCounter: null })
            if (d.due) { fired.push(c.wallMs); lastRun = ran(c.wallMs) }
            c.advance(MIN)
        }
        expect(fired).toEqual([local(2026, 11, 13, 2, 30)])
    })

    it('missed days (Engine off, disk docked late) catch up exactly once and count missedRuns', () => {
        const now = local(2026, 11, 13, 9, 15)
        const d = decideBackupDue({ nowMs: now, clockTrusted: true, schedule: S, lastRun: ran(local(2026, 11, 10, 2, 31)), uptimeCounter: null })
        expect(d).toMatchObject({ due: true, basis: 'clock', slotMs: local(2026, 11, 13, 2, 30), missedRuns: 2, lastRunStale: false })
        const after = decideBackupDue({ nowMs: now + MIN, clockTrusted: true, schedule: S, lastRun: ran(now), uptimeCounter: null })
        expect(after.due).toBe(false)
        expect(after.missedRuns).toBe(0)
    })

    it('a disk that never ran is due at once (first-run)', () => {
        const d = decideBackupDue({ nowMs: local(2026, 11, 13, 14, 0), clockTrusted: true, schedule: S, lastRun: null, uptimeCounter: null })
        expect(d).toMatchObject({ due: true, basis: 'first-run', missedRuns: 0 })
    })

    it('Backup Disk undocked over the slot: the decision on re-dock catches up once', () => {
        const c = fakeScheduleClock(local(2026, 11, 13, 1, 0))
        const lastRun = ran(local(2026, 11, 12, 2, 30))
        // undocked 01:00–08:00: the tick does not evaluate this disk at all
        c.advance(7 * HOUR)
        const d = decideBackupDue({ nowMs: c.wallMs, clockTrusted: true, schedule: S, lastRun, uptimeCounter: null })
        expect(d.due).toBe(true)
        expect(d.missedRuns).toBe(0)
    })

    it('a lastRun in the future is stale and the uptime counter decides (backwards jump never runs twice)', () => {
        const c = fakeScheduleClock(local(2026, 11, 13, 2, 30))
        const lastRun = ran(c.wallMs)
        let counter: BackupUptimeCounter = resetUptimeCounter(c.bootId, c.uptimeS)
        c.advance(MIN)
        c.jumpWall(-6 * HOUR) // clock steps back to 20:31 the day before: yesterday's slot is "after" nothing
        counter = advanceUptimeCounter(counter, c.bootId, c.uptimeS)
        const d = decideBackupDue({ nowMs: c.wallMs, clockTrusted: true, schedule: S, lastRun, uptimeCounter: counter })
        expect(d).toMatchObject({ due: false, basis: 'uptime', lastRunStale: true })
        // 23 h later the stepped-back clock passes lastRun again: back on the clock basis,
        // and the 13 Nov slot is already done, so still no second run
        c.advance(23 * HOUR)
        counter = advanceUptimeCounter(counter, c.bootId, c.uptimeS)
        expect(decideBackupDue({ nowMs: c.wallMs, clockTrusted: true, schedule: S, lastRun, uptimeCounter: counter }))
            .toMatchObject({ due: false, basis: 'clock', lastRunStale: false })
        // the next slot (14 Nov 02:30 on the stepped clock) runs once
        c.advance(7 * HOUR)
        expect(decideBackupDue({ nowMs: c.wallMs, clockTrusted: true, schedule: S, lastRun, uptimeCounter: counter }))
            .toMatchObject({ due: true, basis: 'clock', slotMs: local(2026, 11, 14, 2, 30) })
    })

    it('a lastRun inside the skew tolerance is not stale', () => {
        const now = local(2026, 11, 13, 10, 0)
        const d = decideBackupDue({ nowMs: now, clockTrusted: true, schedule: S, lastRun: ran(now + 2 * MIN), uptimeCounter: null })
        expect(d.lastRunStale).toBe(false)
        expect(d.due).toBe(false)
    })
})

describe('uptime fallback (untrusted clock)', () => {
    it('one run per 24 h of uptime, counted across the 05:00 reboots', () => {
        const c = fakeScheduleClock(local(2026, 11, 13, 2, 30), 77_400)
        let counter = resetUptimeCounter(c.bootId, c.uptimeS)
        const lastRun: BackupLastRun = { time: c.wallMs, uptimeS: c.uptimeS, bootId: c.bootId }
        const runs: number[] = []
        let current: BackupLastRun = lastRun
        // three days with a 05:00 reboot each day, a tick per minute
        for (let i = 0; i < 3 * 24 * 60; i++) {
            c.advance(MIN)
            const t = new Date(c.wallMs)
            if (t.getHours() === 5 && t.getMinutes() === 0) c.reboot(2 * MIN)
            counter = advanceUptimeCounter(counter, c.bootId, c.uptimeS)
            const d = decideBackupDue({ nowMs: c.wallMs, clockTrusted: false, schedule: S, lastRun: current, uptimeCounter: counter })
            if (d.due) {
                expect(d.basis).toBe('uptime')
                runs.push(c.wallMs)
                current = { time: c.wallMs, uptimeS: c.uptimeS, bootId: c.bootId }
                counter = resetUptimeCounter(c.bootId, c.uptimeS)
            }
        }
        expect(runs.length).toBe(2) // 2 reboot gaps of 2 min each push the 3rd run past the window
        // each run is at least 24 h of uptime after the one before
        expect(runs[0] - lastRun.time).toBeGreaterThanOrEqual(UPTIME_RUN_INTERVAL_S * 1000)
    })

    it('without a counter (older BACKUP.yaml) an untrusted clock never runs blind', () => {
        const d = decideBackupDue({ nowMs: local(2026, 11, 13, 3, 0), clockTrusted: false, schedule: S, lastRun: { time: 1, uptimeS: 1, bootId: null }, uptimeCounter: null })
        expect(d).toMatchObject({ due: false, basis: 'uptime' })
    })

    it('reports missed runs from uptime', () => {
        const counter: BackupUptimeCounter = { bootId: 'b', baseUptimeS: 0, seenUptimeS: 10, carriedS: 3 * UPTIME_RUN_INTERVAL_S }
        const d = decideBackupDue({ nowMs: 0, clockTrusted: false, schedule: S, lastRun: { time: 0, uptimeS: 0, bootId: 'a' }, uptimeCounter: counter })
        expect(d).toMatchObject({ due: true, missedRuns: 2 })
    })

    it('a reboot carries the old segment; uptime going backwards on the same boot id is a new segment', () => {
        let k = resetUptimeCounter('b1', 1000)
        k = advanceUptimeCounter(k, 'b1', 5000)
        expect(uptimeElapsedS(k)).toBe(4000)
        k = advanceUptimeCounter(k, 'b2', 300)
        expect(k).toEqual({ bootId: 'b2', baseUptimeS: 0, seenUptimeS: 300, carriedS: 4000 })
        expect(uptimeElapsedS(k)).toBe(4300)
        k = advanceUptimeCounter(k, 'b2', 200) // never counts down
        expect(uptimeElapsedS(k)).toBe(4300)
        expect(uptimeElapsedS(advanceUptimeCounter(null, 'b3', 50))).toBe(50)
    })

    it('the counter is persisted on a new boot or hourly, not every tick', () => {
        const persisted = resetUptimeCounter('b1', 1000)
        expect(shouldPersistUptimeCounter(null, persisted)).toBe(true)
        expect(shouldPersistUptimeCounter(persisted, advanceUptimeCounter(persisted, 'b1', 1000 + 3599))).toBe(false)
        expect(shouldPersistUptimeCounter(persisted, advanceUptimeCounter(persisted, 'b1', 1000 + 3600))).toBe(true)
        expect(shouldPersistUptimeCounter(persisted, advanceUptimeCounter(persisted, 'b2', 10))).toBe(true)
    })
})

describe('skipped run catch-up (Q3)', () => {
    it('catches up once when the lock frees inside the same window, never after', () => {
        const slot = local(2026, 11, 13, 2, 30)
        const skipped = { windowId: slot, catchUpUsed: false }
        expect(skippedCatchUpDue(skipped, slot, false)).toBe(false) // lock still held
        expect(skippedCatchUpDue(skipped, slot, true)).toBe(true)
        expect(skippedCatchUpDue({ ...skipped, catchUpUsed: true }, slot, true)).toBe(false)
        expect(skippedCatchUpDue(skipped, nextSlotAfter(slot, S), true)).toBe(false) // next window: the regular run does it
        expect(skippedCatchUpDue(null, slot, true)).toBe(false)
    })

    it('windowIdFor uses the slot, or the run start on the uptime basis', () => {
        const due = decideBackupDue({ nowMs: local(2026, 11, 13, 3, 0), clockTrusted: true, schedule: S, lastRun: null, uptimeCounter: null })
        expect(windowIdFor(due, 123)).toBe(local(2026, 11, 13, 2, 30))
        expect(windowIdFor({ due: true, basis: 'uptime', slotMs: null, missedRuns: 0, lastRunStale: false }, 123)).toBe(123)
    })
})

describe('clock trust (proposal §3.2)', () => {
    const base: ClockTrustInput = {
        nowMs: local(2026, 11, 13, 10, 0), ntpSynced: true, peerSynced: false,
        buildTimeMs: local(2026, 11, 13, 9, 0), newestStoreTimeMs: local(2026, 11, 13, 9, 59), syncedPeerNowMs: null,
    }
    it('trusted when synced and consistent', () => {
        expect(evaluateClockTrust(base)).toEqual({ clockTrusted: true, clockReason: null })
        expect(evaluateClockTrust({ ...base, ntpSynced: false, peerSynced: true })).toEqual({ clockTrusted: true, clockReason: null })
        expect(evaluateClockTrust({ ...base, buildTimeMs: null, newestStoreTimeMs: null })).toEqual({ clockTrusted: true, clockReason: null })
    })
    it('gives each reason', () => {
        expect(evaluateClockTrust({ ...base, ntpSynced: false }).clockReason).toBe('NEVER_SYNCED')
        expect(evaluateClockTrust({ ...base, nowMs: base.buildTimeMs! - 1 }).clockReason).toBe('BEFORE_BUILD')
        expect(evaluateClockTrust({ ...base, newestStoreTimeMs: base.nowMs + 6 * MIN }).clockReason).toBe('BEFORE_STORE')
        expect(evaluateClockTrust({ ...base, newestStoreTimeMs: base.nowMs + 4 * MIN }).clockTrusted).toBe(true)
        expect(evaluateClockTrust({ ...base, syncedPeerNowMs: base.nowMs - 25 * HOUR }).clockReason).toBe('AHEAD_OF_PEER')
        expect(evaluateClockTrust({ ...base, syncedPeerNowMs: base.nowMs - 23 * HOUR }).clockTrusted).toBe(true)
        expect(evaluateClockTrust({ ...base, jumpSinceSync: true }).clockReason).toBe('CLOCK_JUMP')
    })
    it('a certainly-wrong clock is reported before "never synced"', () => {
        expect(evaluateClockTrust({ ...base, ntpSynced: false, nowMs: base.buildTimeMs! - HOUR }).clockReason).toBe('BEFORE_BUILD')
    })
})

describe('clock jumps', () => {
    it('detects forward and backward steps beyond 2 min, not normal drift', () => {
        const c = fakeScheduleClock(local(2026, 11, 13, 1, 0))
        let prev = c.sample()
        c.advance(MIN)
        expect(detectClockJump(prev, c.sample())).toBeNull()
        prev = c.sample()
        c.advance(MIN); c.jumpWall(CLOCK_JUMP_THRESHOLD_MS - 1)
        expect(detectClockJump(prev, c.sample())).toBeNull()
        prev = c.sample()
        c.advance(MIN); c.jumpWall(HOUR)
        expect(detectClockJump(prev, c.sample())).toBe('forward')
        prev = c.sample()
        c.advance(MIN); c.jumpWall(-HOUR)
        expect(detectClockJump(prev, c.sample())).toBe('backward')
    })
})

describe('test-only clock offset (Q10)', () => {
    it('is honoured only with NODE_ENV=test', () => {
        expect(testClockOffsetMs({ NODE_ENV: 'test', [TEST_CLOCK_OFFSET_ENV]: '-3600000' })).toBe(-3_600_000)
        expect(testClockOffsetMs({ NODE_ENV: 'production', [TEST_CLOCK_OFFSET_ENV]: '-3600000' })).toBe(0)
        expect(testClockOffsetMs({ NODE_ENV: 'development', [TEST_CLOCK_OFFSET_ENV]: '5' })).toBe(0)
        expect(testClockOffsetMs({ [TEST_CLOCK_OFFSET_ENV]: '5' })).toBe(0)
        expect(testClockOffsetMs({ NODE_ENV: 'test', [TEST_CLOCK_OFFSET_ENV]: 'soon' })).toBe(0)
        expect(testClockOffsetMs({ NODE_ENV: 'test', [TEST_CLOCK_OFFSET_ENV]: '1.5' })).toBe(0)
        expect(testClockOffsetMs({ NODE_ENV: 'test' })).toBe(0)
        expect(scheduleNowMs(1000, { NODE_ENV: 'test', [TEST_CLOCK_OFFSET_ENV]: '500' })).toBe(1500)
    })
})
