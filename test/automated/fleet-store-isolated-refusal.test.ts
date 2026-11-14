import { describe, it, expect } from 'vitest'
import {
    FLEET_STORE_URL,
    KNOWN_FLEET_STORE_IDS,
    isKnownFleetStoreId,
    refuseFleetStoreInIsolatedMode,
    storeDocIdFromUrl,
} from '../../src/data/StoreIdentity.js'
import { readFileSync } from 'fs'

/**
 * engine#362: a testMode or IDEA_WATCH_DIR Engine must not start on a known
 * fleet store (dev pool 2VroE, kit 3Vvv, production 6f8m, retired 4GQm).
 * Official tests set IDEA_WATCH_DIR, so every case here passes the flags
 * explicitly instead of reading the environment.
 *
 * 4GQm is the retired previous default, not the store-template.json document
 * ID (the template is a content snapshot imported under store-url.txt).
 */
const POOL = 'automerge:2VroEUvDkmYsDAwE5oG9YeFNadWH'
const KIT = 'automerge:3Vvvigx8bKcuwKALqMVz85GhDqrk'
const PROD = 'automerge:6f8m5KxzARv9xwv4Lw18LgVUJzu'
const RETIRED = 'automerge:4GQmEZehPDfryGDxkFo9XixbvmAC'
const SCRATCH = 'automerge:4VGDQ4gGcVf1eQ1U7e81P95BGf5J'

describe('refuseFleetStoreInIsolatedMode (engine#362)', () => {
    it('knows the four full fleet IDs, including FLEET_STORE_URL as the kit store', () => {
        expect(KNOWN_FLEET_STORE_IDS).toEqual([
            '2VroEUvDkmYsDAwE5oG9YeFNadWH',
            '3Vvvigx8bKcuwKALqMVz85GhDqrk',
            '6f8m5KxzARv9xwv4Lw18LgVUJzu',
            '4GQmEZehPDfryGDxkFo9XixbvmAC',
        ])
        expect(FLEET_STORE_URL).toBe(KIT)
        expect(isKnownFleetStoreId(POOL)).toBe(true)
        expect(isKnownFleetStoreId(storeDocIdFromUrl(KIT))).toBe(true)
        expect(isKnownFleetStoreId(PROD)).toBe(true)
        expect(isKnownFleetStoreId(RETIRED)).toBe(true)
        expect(isKnownFleetStoreId(SCRATCH)).toBe(false)
    })

    it('refuses each known fleet store when testMode is on, with a clear error', () => {
        for (const url of [POOL, KIT, PROD, RETIRED]) {
            expect(() => refuseFleetStoreInIsolatedMode(url, { testMode: true, watchDirSet: false }))
                .toThrow(/Refusing to start: testMode is on, but the configured store is a known fleet store automerge:/)
            expect(() => refuseFleetStoreInIsolatedMode(url, { testMode: true, watchDirSet: false }))
                .toThrow(/isolated store/)
            expect(() => refuseFleetStoreInIsolatedMode(url, { testMode: true, watchDirSet: false }))
                .toThrow(/engine#362/)
        }
    })

    it('refuses when IDEA_WATCH_DIR is set even if testMode is off', () => {
        expect(() => refuseFleetStoreInIsolatedMode(POOL, { testMode: false, watchDirSet: true }))
            .toThrow(/IDEA_WATCH_DIR is set/)
    })

    it('does not refuse an isolated store, or a fleet store when neither flag is set', () => {
        expect(() => refuseFleetStoreInIsolatedMode(SCRATCH, { testMode: true, watchDirSet: true })).not.toThrow()
        expect(() => refuseFleetStoreInIsolatedMode(POOL, { testMode: false, watchDirSet: false })).not.toThrow()
        expect(() => refuseFleetStoreInIsolatedMode(KIT, { testMode: false, watchDirSet: false })).not.toThrow()
    })

    it('start.ts calls the refusal after prepareStoreIdentity and before the Automerge server starts', () => {
        const start = readFileSync('src/start.ts', 'utf8')
        expect(start).toMatch(/prepareStoreIdentity\(storeIdentity\)[\s\S]*refuseFleetStoreInIsolatedMode\(storeDocId[\s\S]*await startAutomergeServer\(/)
    })
})
