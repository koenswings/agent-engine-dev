/**
 * monoClock.ts — monotonic milliseconds (engine#582).
 *
 * Expiry of confirmations, sessions and grants uses this clock, never wall time:
 * an offline Pi's wall clock can jump (no RTC, NTP after boot), the monotonic
 * clock cannot. Values only make sense within one Engine process.
 */
export const monoNow = (): number => Number(process.hrtime.bigint() / 1_000_000n)
