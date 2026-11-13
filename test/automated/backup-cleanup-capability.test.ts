/**
 * backup-cleanup-capability.test.ts (idea#400 §3.1)
 *
 * `backupCleanup` is advertised only when the app-data root helper is at
 * BACKUP_CLEANUP_HELPER_MIN (v10, idea#450) or newer, checked once at startup.
 * An older, missing, failing or timed-out helper leaves it out.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
    ENGINE_CAPABILITIES,
    FLASH_CARD_CAPABILITY,
    BACKUP_CLEANUP_CAPABILITY,
    engineCapabilities,
    checkBackupCleanupCapability,
    resetBackupCleanupCapabilityForTests,
} from '../../src/data/Engine.js'
import { BACKUP_CLEANUP_HELPER_MIN } from '../../src/utils/backupCleanup.js'

afterEach(() => resetBackupCleanupCapabilityForTests())

describe('backupCleanup capability (idea#400 §3.1)', () => {
    it('is not in the always-on ENGINE_CAPABILITIES list', () => {
        expect(ENGINE_CAPABILITIES).not.toContain(BACKUP_CLEANUP_CAPABILITY)
        expect(engineCapabilities(false)).not.toContain(BACKUP_CLEANUP_CAPABILITY)
    })

    it('a present helper at the minimum version is advertised', async () => {
        const ok = await checkBackupCleanupCapability(async () => `idea-app-data ${BACKUP_CLEANUP_HELPER_MIN}`)
        expect(ok).toBe(true)
        expect(engineCapabilities(false)).toContain(BACKUP_CLEANUP_CAPABILITY)
    })

    it('a newer-than-minimum helper is advertised', async () => {
        const ok = await checkBackupCleanupCapability(async () => `idea-app-data ${BACKUP_CLEANUP_HELPER_MIN + 1}`)
        expect(ok).toBe(true)
        expect(engineCapabilities(false)).toContain(BACKUP_CLEANUP_CAPABILITY)
    })

    it('an older helper is not advertised', async () => {
        const ok = await checkBackupCleanupCapability(async () => `idea-app-data ${BACKUP_CLEANUP_HELPER_MIN - 1}`)
        expect(ok).toBe(false)
        expect(engineCapabilities(true)).not.toContain(BACKUP_CLEANUP_CAPABILITY)
        expect(engineCapabilities(true)).toContain(FLASH_CARD_CAPABILITY)
    })

    it('a missing or unparseable version is not advertised', async () => {
        expect(await checkBackupCleanupCapability(async () => '')).toBe(false)
        expect(engineCapabilities()).not.toContain(BACKUP_CLEANUP_CAPABILITY)
        expect(await checkBackupCleanupCapability(async () => 'not-a-version')).toBe(false)
        expect(engineCapabilities()).not.toContain(BACKUP_CLEANUP_CAPABILITY)
    })

    it('an error running the helper is not advertised and does not throw', async () => {
        const ok = await checkBackupCleanupCapability(async () => { throw new Error('sudo: a password is required') })
        expect(ok).toBe(false)
        expect(engineCapabilities()).not.toContain(BACKUP_CLEANUP_CAPABILITY)
    })

    it('a timed-out helper check is not advertised and does not throw', async () => {
        const started = Date.now()
        const ok = await checkBackupCleanupCapability(
            () => new Promise(() => { /* never settles */ }),
            50,
        )
        expect(ok).toBe(false)
        expect(Date.now() - started).toBeLessThan(2000)
        expect(engineCapabilities()).not.toContain(BACKUP_CLEANUP_CAPABILITY)
    })
})
