/**
 * r86j (cover-all-stage2-a350976-r86j): steps 1–115 PASS, then step 116 copy_app hung in the post-op
 * settle at "Connecting idea04 (doc wait 120000ms)". idea03's connect before it had returned 'ready'
 * after 632963 ms on a 45 s doc wait: the walker's event loop was blocked by a synchronous store sync,
 * so no timer could fire (doc wait, 150 s per-Pi post-op timeout). The process later died (idea02
 * rebooted 00:17 CEST) with no PASS/FAIL/RESULT. These tests pin the fix:
 *  - an out-of-thread watchdog writes FAIL + reason when the main loop is blocked past the limit;
 *  - every verdict path writes RESULT.txt and a duration_verdict line exactly once;
 *  - a connect that finishes past its bound is a fail-loud stall, not a slow 'ready'.
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
    _resetVerdictState, blockMainThread, setCurrentStep, startLoopWatchdog, writeVerdict,
} from '../duration/verdict.js'
import { CONNECT_OVERRUN_GRACE_MS, RealFleetOps } from '../duration/realFleetOps.js'

const here = fileURLToPath(new URL('.', import.meta.url))
// Tests run from dist-test/test/automated; .ts sources live in the source tree (test/automated).
const srcHere = here.replace(/([\\/])dist-test[\\/]/, '$1')
const tmp = () => mkdtempSync(join(tmpdir(), 'r86j-'))

afterEach(() => _resetVerdictState())

describe('r86j: verdict is always written', () => {
    it('writes RESULT.txt + duration_verdict line once; a later PASS never overwrites a FAIL', () => {
        const d = tmp()
        writeFileSync(join(d, 'run.log'), 'x\n')
        setCurrentStep(116)
        expect(writeVerdict({ status: 'FAIL', reason: 'walker received SIGTERM', source: 'signal' }, d)).toBe(true)
        expect(writeVerdict({ status: 'PASS', reason: 'late', source: 'walk-end' }, d)).toBe(false)
        const res = readFileSync(join(d, 'RESULT.txt'), 'utf8')
        expect(res).toMatch(/^FAIL step=116 source=signal\nwalker received SIGTERM/)
        const lines = readFileSync(join(d, 'run.log'), 'utf8').trim().split('\n')
        expect(lines).toHaveLength(2)
        const v = JSON.parse(lines[1]!)
        expect(v).toMatchObject({ event: 'duration_verdict', status: 'FAIL', step: 116, source: 'signal' })
    })
})

describe('r86j: loop watchdog bounds a blocked event loop', () => {
    it('main thread blocked past the limit → FAIL with step and memory, written by the worker', async () => {
        const d = tmp()
        writeFileSync(join(d, 'run.log'), '')
        setCurrentStep(116)
        const wd = startLoopWatchdog({ dir: d, stallMs: 600, lagLogMs: 200, beatMs: 50, noKill: true })
        const stalled = new Promise<{ reason: string }>(r => wd.worker.on('message', m => r(m)))
        await new Promise(r => setTimeout(r, 200)) // worker up, heartbeat running
        blockMainThread(1_500) // like a multi-minute synchronous Automerge apply
        const m = await stalled
        await wd.stop()
        expect(m.reason).toMatch(/event loop blocked \d+s .* at step 116/)
        expect(readFileSync(join(d, 'RESULT.txt'), 'utf8')).toMatch(/^FAIL step=116 source=loop-watchdog/)
        expect(readFileSync(join(d, 'run.log'), 'utf8')).toMatch(/"source":"loop-watchdog"/)
        expect(readFileSync(join(d, 'LOOPLAG.jsonl'), 'utf8')).toMatch(/"lagMs":\d+.*"step":116/)
        // and the main thread can no longer overwrite it with a PASS
        expect(writeVerdict({ status: 'PASS', reason: 'x', source: 'walk-end' }, d)).toBe(false)
    }, 15_000)

    it('short lags are logged, not fatal', async () => {
        const d = tmp()
        const wd = startLoopWatchdog({ dir: d, stallMs: 5_000, lagLogMs: 200, beatMs: 50, noKill: true })
        let stalled = false
        wd.worker.on('message', () => { stalled = true })
        await new Promise(r => setTimeout(r, 200))
        blockMainThread(700)
        await new Promise(r => setTimeout(r, 400))
        await wd.stop()
        expect(stalled).toBe(false)
        expect(existsSync(join(d, 'RESULT.txt'))).toBe(false)
        expect(existsSync(join(d, 'LOOPLAG.jsonl'))).toBe(true)
    }, 15_000)

    it('real process: SIGKILLed by the watchdog still leaves FAIL; SIGTERM leaves FAIL', () => {
        const d = tmp()
        const mod = pathToFileURL(join(srcHere, '../duration/verdict.ts')).href
        const run = (code: string) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import * as v from ${JSON.stringify(mod)};\n${code}`], { timeout: 20_000 })
        const blocked = run(`v.setVerdictDir(${JSON.stringify(d)}); v.installVerdictGuards();
            v.setCurrentStep(116); v.startLoopWatchdog({ dir: ${JSON.stringify(d)}, stallMs: 800, lagLogMs: 300, beatMs: 50 });
            setTimeout(() => v.blockMainThread(60000), 300)`)
        expect(blocked.signal).toBe('SIGKILL')
        expect(readFileSync(join(d, 'RESULT.txt'), 'utf8')).toMatch(/^FAIL step=116 source=loop-watchdog/)

        const d2 = tmp()
        const termed = run(`v.setVerdictDir(${JSON.stringify(d2)}); v.installVerdictGuards();
            v.setCurrentStep(42); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); setInterval(() => {}, 1000)`)
        expect(termed.status).toBe(2)
        expect(readFileSync(join(d2, 'RESULT.txt'), 'utf8')).toMatch(/^FAIL step=42 source=signal\nwalker received SIGTERM/)

        const d3 = tmp()
        run(`v.setVerdictDir(${JSON.stringify(d3)}); v.installVerdictGuards(); process.exit(7)`)
        expect(readFileSync(join(d3, 'RESULT.txt'), 'utf8')).toMatch(/exited with code 7 without a verdict/)
    }, 60_000)
})

describe('r86j: a connect that overran its bound is a stall, not a slow ready', () => {
    it('ready 632 s into a 45 s doc wait → StoreSyncStallError (fail loud)', async () => {
        const ops = new RealFleetOps({ poolEngines: ['idea03'], hosts: { idea03: '127.0.0.1' }, storeUrls: { idea03: 'automerge:3zoqdSVsEtj4ygNJPNcDyKWvdxo6' } } as any) as any
        expect(CONNECT_OVERRUN_GRACE_MS).toBe(5_000)
        expect(typeof ops.openConn).toBe('function')
        // Source check: the overrun guard turns a late 'ready' into a stall before registerConn.
        const src = readFileSync(join(srcHere, '../duration/realFleetOps.ts'), 'utf8')
        const i = src.indexOf('overrunMs > CONNECT_OVERRUN_GRACE_MS')
        expect(i).toBeGreaterThan(0)
        expect(src.indexOf("kind: 'stall'", i)).toBeGreaterThan(i)
        expect(src.indexOf('store_sync_measured')).toBeGreaterThan(0)
    })
})
