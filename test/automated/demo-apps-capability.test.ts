/**
 * demo-apps-capability.test.ts — the demoApps capability (engine#369).
 * Advertised only when python3 is on PATH; minEngine / Engine.version stay '1.0'.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
    ENGINE_CAPABILITIES, FLASH_CARD_CAPABILITY, DEMO_APPS_CAPABILITY,
    engineCapabilities, checkDemoAppsCapability, resetDemoAppsCapabilityForTests,
} from '../../src/data/Engine.js'

afterEach(() => resetDemoAppsCapabilityForTests())

describe('demoApps capability (engine#369)', () => {
    it('is not in the always-on ENGINE_CAPABILITIES list', () => {
        expect(ENGINE_CAPABILITIES).not.toContain(DEMO_APPS_CAPABILITY)
        expect(engineCapabilities(false, false, false)).not.toContain(DEMO_APPS_CAPABILITY)
        expect(DEMO_APPS_CAPABILITY).toBe('demoApps')
    })

    it('is advertised when python3 is on PATH', () => {
        expect(checkDemoAppsCapability(() => true)).toBe(true)
        expect(engineCapabilities(false, false)).toContain(DEMO_APPS_CAPABILITY)
    })

    it('is omitted when python3 is missing, and the check does not throw', () => {
        expect(checkDemoAppsCapability(() => { throw new Error('ENOENT') })).toBe(false)
        expect(engineCapabilities(true, true)).not.toContain(DEMO_APPS_CAPABILITY)
        expect(engineCapabilities(true, true)).toContain(FLASH_CARD_CAPABILITY)
    })

    it('is omitted when the checker returns false', () => {
        expect(checkDemoAppsCapability(() => false)).toBe(false)
        expect(engineCapabilities(false, false)).not.toContain(DEMO_APPS_CAPABILITY)
    })
})
