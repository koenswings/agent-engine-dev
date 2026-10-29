/** update-app-policy.test.ts — pure rules for updateApp v1 (agent-engine-dev#230). */
import { describe, it, expect } from 'vitest'
import { compareVersions, parseVersion, healthTimeoutSeconds, checkUpdate, offerable, healthGate, rollbackPlan, CheckFacts, BACKUP_MAX_AGE_MS } from '../../src/data/UpdateAppPolicy.js'

const ok: CheckFacts = { diskDocked: true, busy: false, currentAppId: 'kolibri-0.15.5', newAppId: 'kolibri-0.19.5', sourcePresent: true, sumsValid: true, allowMajor: false, backupAgeMs: null, shortDisks: [] }
const code = (f: Partial<CheckFacts>) => checkUpdate({ ...ok, ...f })?.code ?? null

describe('versions', () => {
    it('parses tool output and plain versions', () => {
        expect(parseVersion('kolibri, version 0.19.5')).toEqual([0, 19, 5])
        expect(compareVersions('0.19.5', 'kolibri, version 0.19.5')).toBe(0)
        expect(compareVersions('0.19.5', '0.15.5')! > 0).toBe(true)
        expect(compareVersions('1.10', '1.9')! > 0).toBe(true)
        expect(compareVersions('x', '1.0')).toBeNull()
    })
})

describe('healthTimeout', () => {
    it('per-App defaults and declared override', () => {
        expect(healthTimeoutSeconds('kolibri')).toBe(900)
        expect(healthTimeoutSeconds('nextcloud')).toBe(300)
        expect(healthTimeoutSeconds('kiwix')).toBe(600)
        expect(healthTimeoutSeconds('milkwise')).toBe(600)
        expect(healthTimeoutSeconds('kiwix', 120)).toBe(120)
        expect(healthTimeoutSeconds('kiwix', 'junk')).toBe(600)
    })
})

describe('checkUpdate refusals', () => {
    it('passes a valid minor update', () => expect(code({})).toBeNull())
    it('NOT_DOCKED', () => expect(code({ diskDocked: false })).toBe('NOT_DOCKED'))
    it('BUSY', () => expect(code({ busy: true })).toBe('BUSY'))
    it('SOURCE_MISSING', () => expect(code({ sourcePresent: false })).toBe('SOURCE_MISSING'))
    it('NO_SUMS', () => expect(code({ sumsValid: false })).toBe('NO_SUMS'))
    it('DIFFERENT_APP', () => expect(code({ newAppId: 'kiwix-3.0' })).toBe('DIFFERENT_APP'))
    it('NOT_NEWER', () => { expect(code({ newAppId: 'kolibri-0.15.5' })).toBe('NOT_NEWER'); expect(code({ newAppId: 'kolibri-0.14.0' })).toBe('NOT_NEWER') })
    it('MAJOR_NOT_ALLOWED', () => expect(code({ newAppId: 'kolibri-1.0.0' })).toBe('MAJOR_NOT_ALLOWED'))
    it('NEEDS_BACKUP', () => {
        expect(code({ newAppId: 'kolibri-1.0.0', allowMajor: true })).toBe('NEEDS_BACKUP')
        expect(code({ newAppId: 'kolibri-1.0.0', allowMajor: true, backupAgeMs: BACKUP_MAX_AGE_MS + 1 })).toBe('NEEDS_BACKUP')
        expect(code({ newAppId: 'kolibri-1.0.0', allowMajor: true, backupAgeMs: 1000 })).toBeNull()
    })
    it('NO_SPACE names the disk', () => expect(checkUpdate({ ...ok, shortDisks: ['apps-1'] })?.message).toMatch(/NO_SPACE: .*apps-1/))
    it('never offers an App without valid sums (Milkwise today)', () => {
        expect(offerable({ currentAppId: 'milkwise-1.0', newAppId: 'milkwise-1.1', sumsValid: false })).toBe(false)
        expect(offerable({ currentAppId: 'milkwise-1.0', newAppId: 'milkwise-1.1', sumsValid: true })).toBe(true)
    })
})

describe('health gate', () => {
    it('starting and unhealthy are not ready yet within the timeout', () => {
        expect(healthGate({ state: 'starting', restartCount: 0, elapsedMs: 1000 }, 900).verdict).toBe('wait')
        expect(healthGate({ state: 'unhealthy', restartCount: 0, elapsedMs: 800_000 }, 900).verdict).toBe('wait')
    })
    it('fails on exit, crash-loop, timeout', () => {
        expect(healthGate({ state: 'exited', restartCount: 0, elapsedMs: 1 }, 900).verdict).toBe('fail')
        expect(healthGate({ state: 'restarting', restartCount: 3, elapsedMs: 1 }, 900).verdict).toBe('fail')
        expect(healthGate({ state: 'unhealthy', restartCount: 0, elapsedMs: 900_000 }, 900).verdict).toBe('fail')
    })
    it('passes healthy with a good body; waits on bad body', () => {
        expect(healthGate({ state: 'healthy', restartCount: 0, elapsedMs: 1, bodyOk: true }, 900).verdict).toBe('pass')
        expect(healthGate({ state: 'healthy', restartCount: 0, elapsedMs: 1, bodyOk: false }, 900).verdict).toBe('wait')
    })
})

describe('rollback always restores the data snapshot', () => {
    it.each(['Snapshot', 'Swap', 'Start', 'Health'] as const)('after %s', step => {
        expect(rollbackPlan(step).restoreData).toBe(true)
        expect(rollbackPlan(step).startOld).toBe(true)
    })
    it('nothing to restore before Snapshot', () => {
        expect(rollbackPlan('Check')).toEqual({ restoreBundle: false, restoreData: false, startOld: false })
    })
})
