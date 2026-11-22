/**
 * pm2-crash-backoff.test.ts — engine#567 (c): a crash loop backs off and never gives up.
 *
 * kind-panda restarted 817 times, about every 1.7 s, hot, because pm2.config.cjs had
 * no backoff and each failed run outlived pm2's default min_uptime (1 s).
 *   1. engine and idea-usage: exp_backoff_restart_delay set, NO max_restarts
 *   2. a replay of pm2's restart logic (lib/God.js handleExit, unstable_restarts /
 *      overlimit, exp backoff x1.5 capped at 15 s) with these values: over one hour of
 *      failed starts (runs of 0.1 s, 1.7 s, 4.9 s) pm2 never marks the Engine ERRORED
 *      (it keeps retrying, offline), and after the ramp it starts at most ~4x a minute
 *   3. the same replay shows why min_uptime must stay small: from ~10 s on it trips
 *      pm2's default max_restarts (16) and stops the Engine for good
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import { createRequire } from 'module'

const cfg = createRequire(import.meta.url)(path.join(process.cwd(), 'pm2.config.cjs'))
const app = (name: string) => cfg.apps.find((a: any) => a.name === name)

/** pm2 handleExit (lib/God.js) for an app that fails every start after `runMs`. */
const replay = (o: { minUptime: number, maxRestarts?: number, expBackoff: number, runMs: number, horizonMs: number }) => {
    const maxRestarts = o.maxRestarts ?? 16
    let t = 0, createdAt = 0, unstable = 0, prevDelay = 0, starts = 0
    const startTimes: number[] = []
    while (t < o.horizonMs) {
        const pmUptime = t                 // process started
        startTimes.push(t); starts++
        t += o.runMs                       // ... and exits (failed start)
        if (t - createdAt < o.minUptime * maxRestarts && t - pmUptime < o.minUptime) unstable++
        if (unstable >= maxRestarts) return { errored: true, at: t, starts, startTimes, lastDelay: prevDelay }
        prevDelay = prevDelay ? Math.floor(Math.min(15000, prevDelay * 1.5)) : o.expBackoff
        t += prevDelay
    }
    return { errored: false, at: t, starts, startTimes, lastDelay: prevDelay }
}

describe('pm2 crash-loop backoff (engine#567 c)', () => {
    it('engine and idea-usage: exponential backoff, min_uptime, and NO max_restarts', () => {
        for (const name of ['engine', 'idea-usage']) {
            const a = app(name)
            expect(a.exp_backoff_restart_delay, name).toBe(1000)
            expect(a.min_uptime, name).toBe(5000)
            expect(a.max_restarts, `${name}: no hard stop (offline kits must keep retrying)`).toBeUndefined()
            expect(a.autorestart, name).not.toBe(false)
        }
    })

    for (const runMs of [100, 1700, 4900]) {
        it(`failed starts of ${runMs} ms for an hour: never ERRORED, backoff reaches 15 s, <= 4.5 starts a minute after the ramp`, () => {
            const e = app('engine')
            const r = replay({ minUptime: e.min_uptime, expBackoff: e.exp_backoff_restart_delay, runMs, horizonMs: 3_600_000 })
            expect(r.errored).toBe(false)
            expect(r.lastDelay).toBe(15000)
            const lateStarts = r.startTimes.filter(s => s >= 600_000).length
            expect(lateStarts / 50).toBeLessThanOrEqual(4.5)
            // kind-panda without backoff: one start every ~1.7 s = ~35 a minute
            expect(r.starts).toBeLessThan(3_600_000 / 1700 / 5)
        })
    }

    it('why min_uptime stays small: 15 s with the same backoff would trip pm2\'s default max_restarts and stop the Engine', () => {
        for (const runMs of [100, 1700, 4900]) {
            expect(replay({ minUptime: 15_000, expBackoff: 1000, runMs, horizonMs: 3_600_000 }).errored, `${runMs} ms runs`).toBe(true)
        }
        // the configured 5 s has a 2x margin: the shortest failing runs trip only from 10 s
        expect(replay({ minUptime: 9_500, expBackoff: 1000, runMs: 100, horizonMs: 3_600_000 }).errored).toBe(false)
    })
})
