/** idea#332 option (b): the ENVIRONMENT STALL detector (test/harness/stallGuard.ts). */
import { describe, expect, it } from 'vitest'
import { _freezeHeartbeat, markStall, runStallGuarded, STALL_MARKER, type Clock } from '../harness/stallGuard.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* busy */ } }

describe('idea#332: environment stall guard', () => {
    it('normal path: a passing body passes', async () => {
        await expect(runStallGuarded(async () => { await sleep(50) }, 5_000)).resolves.toBeUndefined()
    })

    it('a real timeout with no stall fails with the normal message, not the stall marker', async () => {
        const err = await runStallGuarded(() => sleep(10_000), 800).catch(e => e)
        expect(err.message).toBe('Test timed out in 800ms')
        expect(err.message).not.toContain(STALL_MARKER)
    })

    it('a main-thread-only block (our own bug) is a normal failure, not an environment stall', async () => {
        const err = await runStallGuarded(async () => { spin(6_000); throw new Error('assertion failed') }, 30_000).catch(e => e)
        expect(err.message).toBe('assertion failed')
    }, 30_000)

    it('whole-process freeze (heartbeat thread and main thread both stopped 6 s) → ENVIRONMENT STALL, fails', async () => {
        await sleep(300)
        const err = await runStallGuarded(async () => {
            _freezeHeartbeat(6_000)
            await sleep(50)
            spin(6_000)
            throw new Error('Test timed out in 60000ms')
        }, 30_000).catch(e => e)
        expect(err).toBeInstanceOf(Error)
        expect(err.message).toMatch(/^ENVIRONMENT STALL \(\d+s\): inconclusive/)
        expect(err.message).toContain('Test timed out in 60000ms')
    }, 30_000)

    it('paused VM (wall clock jumps 98 s, monotonic stops) → ENVIRONMENT STALL even on a deadline', async () => {
        let jump = 0
        const clock: Clock = { wall: () => Date.now() + jump, mono: () => performance.now() }
        const err = await runStallGuarded(async () => { jump = 98_000; await sleep(10_000) }, 500, clock).catch(e => e)
        expect(err.message).toMatch(/^ENVIRONMENT STALL \(98s\)/)
        expect(err.message).toContain('Test timed out in 500ms')
    })

    it('no stall reported for a quiet interval', async () => {
        const m = markStall()
        await sleep(500)
        expect(await m.stalledMs()).toBeLessThan(1_000)
    })
})
