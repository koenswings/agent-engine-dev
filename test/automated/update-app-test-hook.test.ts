/**
 * update-app-test-hook.test.ts (engine#449)
 *
 * Unit coverage for IDEA_TEST_FAIL_UPDATE_RESTART: the testMode gate, per-call
 * env reads, the boot warning, and the guarantee that install / image / pm2
 * files never set the hook.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import { fs } from 'zx'
import {
    TEST_FAIL_UPDATE_RESTART_ENV,
    TEST_FAIL_UPDATE_RESTART_MESSAGE,
    testFailUpdateRestartId,
    shouldFailUpdateRestart,
    warnIfTestFailUpdateRestartIgnored,
} from '../../src/data/UpdateAppTestHook.js'

const ROOT = process.cwd()
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('IDEA_TEST_FAIL_UPDATE_RESTART hook (engine#449)', () => {
    it('is honoured only when testMode is on, for the named instance id, and is read per call', () => {
        const env: NodeJS.ProcessEnv = { [TEST_FAIL_UPDATE_RESTART_ENV]: 'inst-a' }
        expect(testFailUpdateRestartId(env, true)).toBe('inst-a')
        expect(shouldFailUpdateRestart('inst-a', env, true)).toBe(true)
        expect(shouldFailUpdateRestart('inst-b', env, true)).toBe(false)
        expect(testFailUpdateRestartId(env, false)).toBeNull()
        expect(shouldFailUpdateRestart('inst-a', env, false)).toBe(false)
        expect(testFailUpdateRestartId({ [TEST_FAIL_UPDATE_RESTART_ENV]: '  inst-a  ' }, true)).toBe('inst-a')
        expect(testFailUpdateRestartId({ [TEST_FAIL_UPDATE_RESTART_ENV]: '' }, true)).toBeNull()
        expect(testFailUpdateRestartId({ [TEST_FAIL_UPDATE_RESTART_ENV]: '   ' }, true)).toBeNull()
        expect(testFailUpdateRestartId({}, true)).toBeNull()
        // Per call, not at import: changing the env is seen immediately.
        const live: NodeJS.ProcessEnv = {}
        expect(shouldFailUpdateRestart('inst-a', live, true)).toBe(false)
        live[TEST_FAIL_UPDATE_RESTART_ENV] = 'inst-a'
        expect(shouldFailUpdateRestart('inst-a', live, true)).toBe(true)
        delete live[TEST_FAIL_UPDATE_RESTART_ENV]
        expect(shouldFailUpdateRestart('inst-a', live, true)).toBe(false)
    })

    it('the forced restart message is the one updateApp records on the instance', () => {
        expect(TEST_FAIL_UPDATE_RESTART_MESSAGE).toBe('test hook: forced restart failure')
        expect(TEST_FAIL_UPDATE_RESTART_ENV).toBe('IDEA_TEST_FAIL_UPDATE_RESTART')
    })

    it('logs a warning once-style at boot when the env is set and testMode is off; silent otherwise', () => {
        const lines: string[] = []
        const logLine = (m: string) => { lines.push(m) }
        warnIfTestFailUpdateRestartIgnored(logLine, {}, false)
        warnIfTestFailUpdateRestartIgnored(logLine, { [TEST_FAIL_UPDATE_RESTART_ENV]: 'inst-a' }, true)
        warnIfTestFailUpdateRestartIgnored(logLine, { [TEST_FAIL_UPDATE_RESTART_ENV]: '' }, false)
        expect(lines).toEqual([])
        warnIfTestFailUpdateRestartIgnored(logLine, { [TEST_FAIL_UPDATE_RESTART_ENV]: 'inst-a' }, false)
        expect(lines).toEqual(['IDEA_TEST_FAIL_UPDATE_RESTART is set but testMode is off; the hook is ignored'])
    })

    it('is not set by any install script, image or pm2 ecosystem file', () => {
        const files = [
            'pm2.config.cjs',
            'script/build_image_assets/idea-engine-firstboot',
            'src/install/engineImage.ts',
            'src/install/engineRootfs.ts',
            'src/install/engineImageCli.ts',
        ]
        for (const f of files) {
            const body = src(f)
            expect(body, f).not.toMatch(/IDEA_TEST_FAIL_UPDATE_RESTART/)
        }
    })
})
