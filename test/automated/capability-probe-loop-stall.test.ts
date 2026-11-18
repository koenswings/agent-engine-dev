/**
 * capability-probe-loop-stall.test.ts (engine#521)
 *
 * The startup helper probes (backupCleanup, preUpdateQuarantine, crossEngineResume) must not
 * read a blocked event loop as a silent helper. idea03 booted with a 7 s stall while the
 * crossEngineResume check (5 s budget) was in flight, the timer won the race, and the
 * capability stayed out for the whole boot: every cross-Engine copy to it was refused
 * TARGET_OUTDATED. A hung helper must still time out.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
    CROSS_ENGINE_RESUME_CAPABILITY,
    engineCapabilities,
    checkCrossEngineResumeCapability,
    checkBackupCleanupCapability,
    resetCrossEngineResumeCapabilityForTests,
    resetBackupCleanupCapabilityForTests,
    withTimeout,
} from '../../src/data/Engine.js'
import { CROSS_RESUME_HELPER_MIN } from '../../src/utils/appDataHelper.js'

afterEach(() => {
    resetCrossEngineResumeCapabilityForTests()
    resetBackupCleanupCapabilityForTests()
})

/** Block the event loop for `ms` (a long synchronous task, as the Automerge store work is at boot). */
const blockLoop = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }

/**
 * A helper that answers 150 ms after it starts, inside the 100 ms-budget probes below. A
 * 400 ms stall expires both timers together; the probe's own timer (earlier expiry) used to
 * run first and win the race, like a child process exit that is only read after the timers.
 */
const answersAfterStall = (answer: string) => () => new Promise<string>((resolve) => { setTimeout(() => resolve(answer), 150) })

describe('startup capability probes and event-loop stalls (engine#521)', () => {
    it('a loop stall longer than the budget while the helper check is in flight still advertises crossEngineResume', async () => {
        const pending = checkCrossEngineResumeCapability(answersAfterStall(`idea-app-data ${CROSS_RESUME_HELPER_MIN + 2}`), 100)
        blockLoop(400)
        expect(await pending).toBe(true)
        expect(engineCapabilities(false)).toContain(CROSS_ENGINE_RESUME_CAPABILITY)
    })

    it('the same stall does not drop backupCleanup either', async () => {
        const pending = checkBackupCleanupCapability(answersAfterStall('idea-app-data 25'), 100)
        blockLoop(400)
        expect(await pending).toBe(true)
    })

    it('an old helper is still not advertised after a stall', async () => {
        const pending = checkCrossEngineResumeCapability(answersAfterStall(`idea-app-data ${CROSS_RESUME_HELPER_MIN - 1}`), 100)
        blockLoop(400)
        expect(await pending).toBe(false)
        expect(engineCapabilities(false)).not.toContain(CROSS_ENGINE_RESUME_CAPABILITY)
    })

    it('a hung helper still times out without a stall', async () => {
        const started = Date.now()
        const ok = await checkCrossEngineResumeCapability(() => new Promise(() => { /* never settles */ }), 50)
        expect(ok).toBe(false)
        expect(Date.now() - started).toBeLessThan(2000)
    })

    it('a hung helper times out at the wall-clock cap even when only stalled ticks pass', async () => {
        const started = Date.now()
        await expect(withTimeout(new Promise<string>(() => { /* never settles */ }), 40, 3)).rejects.toThrow('timeout')
        expect(Date.now() - started).toBeLessThan(1500)
    })
})
