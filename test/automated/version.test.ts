import { describe, it, expect } from 'vitest'
import { isUnversioned, parseVersion, compareVersions, isUpgrade, isMajorChange } from '../../src/data/Version.js'
import { offerable, checkUpdate, CheckFacts } from '../../src/data/UpdateAppPolicy.js'
import { RE_TOKEN } from '../../src/data/UpdateFetch.js'
import { isMajorUpgrade, extractMajorVersion } from '../../src/data/App.js'

describe('Version (idea#76)', () => {
    it('treats SHA-shaped versions as unversioned', () => {
        for (const v of ['5d02788', 'ea91be1', '8f3c2a1b9d', '2b1cb1ed1dda1d626ac7dc0b4c23c04d575eeac6', 'g1a2b3c4', 'sha-abc1234', '5000123', '1.0-g5d02788'])
            expect(isUnversioned(v), v).toBe(true)
        expect(parseVersion('5d02788')).toBeNull()
        expect(parseVersion('8abcdef')).toBeNull()
    })
    it('treats date-shaped versions as unversioned', () => {
        for (const v of ['zimbabwe-2026-10-20', '2026.10.20', '2026-10-20', 'kit_2026_10_20', '2026.1', '1000.0'])
            expect(isUnversioned(v), v).toBe(true)
        expect(compareVersions('zimbabwe-2026-10-20', '1.9')).toBeNull()
    })
    it('reads proper tags, with v prefix, suffixes and tool output', () => {
        expect(parseVersion('1.0-smoke')).toEqual([1, 0])
        expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
        expect(parseVersion('1.1-0.19.5')).toEqual([1, 1])
        expect(parseVersion('kolibri, version 0.19.5')).toEqual([0, 19, 5])
        expect(isUnversioned('main')).toBe(true)
        expect(isUnversioned('')).toBe(true)
    })
    it('orders 1.x numerically', () => {
        expect(compareVersions('1.10', '1.9')! > 0).toBe(true)
        expect(compareVersions('1.0-smoke', '1.0')).toBe(0)
        expect(compareVersions('1.1', '1.0-smoke')! > 0).toBe(true)
        expect(compareVersions('2.0', '1.99')! > 0).toBe(true)
    })
    it('never offers an unversioned target; always upgrades unversioned -> tag', () => {
        expect(isUpgrade('1.0', 'zimbabwe-2026-10-20')).toBe(false)
        expect(isUpgrade('1.0', '5d02788')).toBe(false)
        expect(isUpgrade('5d02788', 'ea91be1')).toBe(false)
        expect(isUpgrade('5d02788', '1.0')).toBe(true)
        expect(isUpgrade('zimbabwe-2026-10-20', '1.0')).toBe(true)
        expect(isUpgrade('1.0', '1.1')).toBe(true)
        expect(isUpgrade('1.1', '1.0')).toBe(false)
        expect(isMajorChange('5d02788', '2.0')).toBe(false)
        expect(isMajorChange('1.4', '2.0')).toBe(true)
    })
    it('policy: offerable and checkUpdate follow the rule', () => {
        expect(offerable({ currentAppId: 'kolibri-1.0', newAppId: 'kolibri-zimbabwe-2026-10-20', sumsValid: true })).toBe(false)
        expect(offerable({ currentAppId: 'kolibri-5d02788', newAppId: 'kolibri-1.1', sumsValid: true })).toBe(true)
        expect(offerable({ currentAppId: 'kolibri@zimbabwe-2026-10-20', newAppId: 'kolibri-1.0', sumsValid: true })).toBe(true)
        // Known gap (idea#76, see PR body): splitAppId reads the folder form as name 'kolibri-zimbabwe', so it is DIFFERENT_APP
        expect(offerable({ currentAppId: 'kolibri-zimbabwe-2026-10-20', newAppId: 'kolibri-1.0', sumsValid: true })).toBe(false)
        const f: CheckFacts = { diskDocked: true, busy: false, currentAppId: 'kolibri-5d02788', newAppId: 'kolibri-1.1',
            sourcePresent: true, sumsValid: true, allowMajor: false, backupAgeMs: null, shortDisks: [] }
        expect(checkUpdate(f)).toBeNull()
        expect(checkUpdate({ ...f, currentAppId: 'kolibri-1.1', newAppId: 'kolibri-8abcdef' })?.code).toBe('NOT_NEWER')
    })
    it('App.ts major helpers use the same rule', () => {
        expect(isMajorUpgrade('sample-1.0' as any, 'sample-2.0' as any)).toBe(true)
        expect(isMajorUpgrade('sample-1.0' as any, 'sample-1.1' as any)).toBe(false)
        expect(isMajorUpgrade('sample-5d02788' as any, 'sample-1.0' as any)).toBe(false)
        expect(Number.isNaN(extractMajorVersion('sample-8abcdef' as any))).toBe(true)
    })
    it('kit App Disks on SHA versions are offered tagged releases (agent-app-dev#36)', () => {
        expect(parseVersion('5ab9f64')).toBeNull()
        expect(isUpgrade('5ab9f64', '1.1-0.19.5')).toBe(true)
        expect(offerable({ currentAppId: 'kolibri-5ab9f64', newAppId: 'kolibri-1.1-0.19.5', sumsValid: true })).toBe(true)
        expect(offerable({ currentAppId: 'nextcloud-b8ad438', newAppId: 'nextcloud-1.0-31.0.1', sumsValid: true })).toBe(true)
        expect(offerable({ currentAppId: 'kiwix-3b6a8a8', newAppId: 'kiwix-1.0', sumsValid: true })).toBe(true)
        expect(offerable({ currentAppId: 'kolibri-1.1-0.19.5', newAppId: 'kolibri-5ab9f64', sumsValid: true })).toBe(false)
        expect(isUpgrade('5ab9f64', '0.0')).toBe(false)
    })
    it('dev bundles 0.0-dev+<sha12> are never offered and are refused for cross-Engine fetch', () => {
        expect(isUnversioned('0.0-dev+5ab9f64c1d2e')).toBe(true)
        expect(offerable({ currentAppId: 'kolibri-5ab9f64', newAppId: 'kolibri-0.0-dev+5ab9f64c1d2e', sumsValid: true })).toBe(false)
        expect(RE_TOKEN.test('kolibri-0.0-dev+5ab9f64c1d2e')).toBe(false)
        expect(RE_TOKEN.test('kolibri-1.1-0.19.5')).toBe(true)
    })
})
