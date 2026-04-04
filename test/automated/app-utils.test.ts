import { describe, it, expect } from 'vitest'
import {
    createAppId,
    extractAppName,
    extractAppVersion,
    extractMajorVersion,
    isMajorUpgrade,
} from '../../src/data/App.js'
import type { AppID, AppName, Version } from '../../src/data/CommonTypes.js'

/**
 * Unit tests for App.ts utility functions.
 *
 * These are pure functions — no Docker, no store, no disk required.
 * Covers the bug where split('-')[0]/[1] broke hyphenated app names.
 */

const id = (s: string) => s as AppID
const name = (s: string) => s as AppName
const ver = (s: string) => s as Version

describe('createAppId', () => {
    it('joins name and version with a hyphen', () => {
        expect(createAppId(name('kolibri'), ver('1.0'))).toBe('kolibri-1.0')
    })

    it('works with a hyphenated app name', () => {
        expect(createAppId(name('kolibri-with-plugins'), ver('1.0'))).toBe('kolibri-with-plugins-1.0')
    })
})

describe('extractAppName', () => {
    it('extracts a simple name', () => {
        expect(extractAppName(id('kolibri-1.0'))).toBe('kolibri')
    })

    it('extracts a hyphenated name correctly (regression: split on first hyphen was wrong)', () => {
        expect(extractAppName(id('kolibri-with-plugins-1.0'))).toBe('kolibri-with-plugins')
    })

    it('handles a deeply hyphenated name', () => {
        expect(extractAppName(id('my-great-learning-app-2.3'))).toBe('my-great-learning-app')
    })

    it('is the inverse of createAppId (name round-trip)', () => {
        const appName = name('kolibri-with-plugins')
        const version = ver('1.0')
        expect(extractAppName(createAppId(appName, version))).toBe(appName)
    })
})

describe('extractAppVersion', () => {
    it('extracts a simple version', () => {
        expect(extractAppVersion(id('kolibri-1.0'))).toBe('1.0')
    })

    it('extracts version from a hyphenated app name correctly (regression: split on first hyphen was wrong)', () => {
        expect(extractAppVersion(id('kolibri-with-plugins-1.0'))).toBe('1.0')
    })

    it('extracts a multi-part version', () => {
        expect(extractAppVersion(id('sample-1.2.3'))).toBe('1.2.3')
    })

    it('is the inverse of createAppId (version round-trip)', () => {
        const appName = name('kolibri-with-plugins')
        const version = ver('2.1')
        expect(extractAppVersion(createAppId(appName, version))).toBe(version)
    })
})

describe('extractMajorVersion', () => {
    it('extracts major version from a simple id', () => {
        expect(extractMajorVersion(id('kolibri-1.0'))).toBe(1)
    })

    it('extracts major version from a hyphenated app name', () => {
        expect(extractMajorVersion(id('kolibri-with-plugins-2.5'))).toBe(2)
    })

    it('extracts major version 0', () => {
        expect(extractMajorVersion(id('sample-0.9'))).toBe(0)
    })
})

describe('isMajorUpgrade', () => {
    it('returns false for same major version', () => {
        expect(isMajorUpgrade(id('kolibri-1.0'), id('kolibri-1.1'))).toBe(false)
    })

    it('returns true when major version increases', () => {
        expect(isMajorUpgrade(id('kolibri-1.0'), id('kolibri-2.0'))).toBe(true)
    })

    it('returns true when major version decreases (downgrade also counts as major change)', () => {
        expect(isMajorUpgrade(id('kolibri-2.0'), id('kolibri-1.0'))).toBe(true)
    })

    it('works correctly with hyphenated app names', () => {
        expect(isMajorUpgrade(id('kolibri-with-plugins-1.0'), id('kolibri-with-plugins-2.0'))).toBe(true)
        expect(isMajorUpgrade(id('kolibri-with-plugins-1.0'), id('kolibri-with-plugins-1.1'))).toBe(false)
    })
})
