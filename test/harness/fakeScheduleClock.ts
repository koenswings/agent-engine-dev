/**
 * fakeScheduleClock.ts — a fake wall clock, monotonic clock, uptime and boot id for
 * the scheduled-backup tests (idea#400). Nothing touches the system clock.
 *
 *   const c = fakeScheduleClock(new Date(2026, 10, 13, 2, 0).getTime())
 *   c.advance(60_000)      // all clocks move together
 *   c.jumpWall(-3_600_000) // only the wall clock steps (an NTP or manual jump)
 *   c.reboot()             // new boot id, uptime back to 0, wall clock goes on
 */
import { ClockSample } from '../../src/utils/backupSchedule.js'

export interface FakeScheduleClock {
    wallMs: number
    monoMs: number
    uptimeS: number
    bootId: string
    boots: number
    advance(ms: number): void
    jumpWall(ms: number): void
    reboot(downMs?: number): void
    sample(): ClockSample
}

export const fakeScheduleClock = (startWallMs: number, startUptimeS = 600): FakeScheduleClock => {
    const bootIdFor = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const c: FakeScheduleClock = {
        wallMs: startWallMs,
        monoMs: startUptimeS * 1000,
        uptimeS: startUptimeS,
        bootId: bootIdFor(1),
        boots: 1,
        advance(ms: number) {
            c.wallMs += ms
            c.monoMs += ms
            c.uptimeS += Math.floor(ms / 1000)
        },
        jumpWall(ms: number) {
            c.wallMs += ms
        },
        reboot(downMs = 60_000) {
            c.wallMs += downMs
            c.boots += 1
            c.bootId = bootIdFor(c.boots)
            c.monoMs = 0
            c.uptimeS = 0
        },
        sample: () => ({ wallMs: c.wallMs, monoMs: c.monoMs }),
    }
    return c
}
