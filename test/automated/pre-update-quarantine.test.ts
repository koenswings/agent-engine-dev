/**
 * pre-update-quarantine.test.ts — idea#396 24 h cleanup of a pre-update snapshot.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import {
    isPreUpdateQuarantineDue, trustedAtPatch, scanPreUpdateQuarantine, resetPreUpdateQuarantineForTests,
    PRE_UPDATE_QUARANTINE_HELPER_MIN, PRE_UPDATE_QUARANTINE_TICK_MS,
} from '../../src/monitors/preUpdateQuarantine.js'
import { quarantineAfterMs, QUARANTINE_AFTER_MS_DEFAULT, config } from '../../src/data/Config.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import type { QuarantineScannerDeps } from '../../src/monitors/preUpdateQuarantine.js'

const ME = String(localEngineId)
const AFTER = 86_400_000
let h: DocHandle<Store>

beforeEach(async () => {
    resetPreUpdateQuarantineForTests()
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
        doc.instanceDB['i1' as any] = {
            id: 'i1', name: 'Old', storedOn: 'd1', instanceOf: 'kolibri-1.1', status: 'Running',
            preUpdateGate: { at: 1_000, bootId: 'boot-a', uptimeS: 10 },
        } as any
    })
})
afterEach(() => {
    resetPreUpdateQuarantineForTests()
    resourceLock.release(instanceKey('i1' as any))
})

describe('isPreUpdateQuarantineDue / trustedAtPatch', () => {
    const gate = { at: 1_000, bootId: 'boot-a', uptimeS: 10 }
    it('is due when the trusted wall clock reaches at + 24 h', () => {
        expect(isPreUpdateQuarantineDue(gate, 1_000 + AFTER - 1, 'boot-b', 1, true, AFTER)).toBe(false)
        expect(isPreUpdateQuarantineDue(gate, 1_000 + AFTER, 'boot-b', 1, true, AFTER)).toBe(true)
        expect(isPreUpdateQuarantineDue(gate, 1_000 + AFTER, 'boot-b', 1, false, AFTER)).toBe(false)
    })
    it('is due on the same boot when uptime has advanced 24 h, even if the clock is untrusted', () => {
        expect(isPreUpdateQuarantineDue({ at: null, bootId: 'boot-a', uptimeS: 10 }, 0, 'boot-a', 10 + AFTER / 1000, false, AFTER)).toBe(true)
        expect(isPreUpdateQuarantineDue({ at: null, bootId: 'boot-a', uptimeS: 10 }, 0, 'boot-b', 10 + AFTER / 1000, false, AFTER)).toBe(false)
        expect(isPreUpdateQuarantineDue(null, 1_000 + AFTER, 'boot-a', 99999, true, AFTER)).toBe(false)
    })
    it('same boot, clock becomes trusted: at is back-dated to the health gate', () => {
        const p = trustedAtPatch({ at: null, bootId: 'boot-a', uptimeS: 10 }, 5_000, 'boot-a', 14, true)
        expect(p).toEqual({ at: 5_000 - 4_000, bootId: 'boot-a', uptimeS: 10 })
        expect(trustedAtPatch({ at: null, bootId: 'boot-a', uptimeS: 10 }, 5_000, 'boot-a', 14, false)).toBeNull()
        expect(trustedAtPatch(gate, 9_000, 'boot-a', 20, true)).toBeNull()
    })
    it('a new boot writes at at the first trusted moment (the 24 h starts then)', () => {
        expect(trustedAtPatch({ at: null, bootId: 'boot-old', uptimeS: 99 }, 50_000, 'boot-new', 3, true))
            .toEqual({ at: 50_000, bootId: 'boot-new', uptimeS: 3 })
    })
    it('quarantineAfterMs is 24 h in production and honours the config only in isDev or testMode', () => {
        expect(PRE_UPDATE_QUARANTINE_HELPER_MIN).toBe(14)
        expect(PRE_UPDATE_QUARANTINE_TICK_MS).toBe(60 * 60 * 1000)
        expect(QUARANTINE_AFTER_MS_DEFAULT).toBe(86_400_000)
        const saved = { isDev: config.settings.isDev, testMode: config.settings.testMode, n: config.settings.quarantineAfterMs }
        try {
            config.settings.isDev = false
            config.settings.testMode = false
            config.settings.quarantineAfterMs = 1000
            expect(quarantineAfterMs()).toBe(QUARANTINE_AFTER_MS_DEFAULT)
            config.settings.testMode = true
            expect(quarantineAfterMs()).toBe(1000)
            config.settings.testMode = false
            config.settings.isDev = true
            expect(quarantineAfterMs()).toBe(1000)
        } finally {
            config.settings.isDev = saved.isDev
            config.settings.testMode = saved.testMode
            config.settings.quarantineAfterMs = saved.n
        }
    })
})

describe('scanPreUpdateQuarantine', () => {
    const logs: string[] = []
    const dests: string[] = []
    const deps = (over: Partial<QuarantineScannerDeps> = {}): Partial<QuarantineScannerDeps> => ({
        wallMs: () => 1_000 + AFTER,
        uptimeS: () => 10,
        bootId: () => 'boot-b',
        clockTrusted: () => true,
        afterMs: () => AFTER,
        helperProblem: async () => null,
        quarantineSnapshot: async () => { dests.push('ok'); return '/disks/x/.idea-quarantine/pre-update-i1-s' },
        refreshSnapshots: async () => { dests.push('refresh') },
        acquire: () => true,
        release: () => {},
        log: (m) => { logs.push(m) },
        ...over,
    })
    beforeEach(() => { logs.length = 0; dests.length = 0 })

    it('fires when due, clears the gate, and refreshes disk snapshot info', async () => {
        expect(await scanPreUpdateQuarantine(h, deps())).toBe(1)
        expect(dests).toEqual(['ok', 'refresh'])
        expect((h.doc().instanceDB['i1' as any] as any).preUpdateGate).toBeNull()
        expect(logs.some(l => /snapshot moved to/.test(l))).toBe(true)
    })

    it('a missing snapshot (empty dest) is a successful no-op and still clears the gate', async () => {
        await scanPreUpdateQuarantine(h, deps({ quarantineSnapshot: async () => '' }))
        expect((h.doc().instanceDB['i1' as any] as any).preUpdateGate).toBeNull()
        expect(logs.some(l => /nothing to quarantine/.test(l))).toBe(true)
    })

    it('skips when the instance lock is held and keeps the field', async () => {
        expect(await scanPreUpdateQuarantine(h, deps({ acquire: () => false }))).toBe(0)
        expect((h.doc().instanceDB['i1' as any] as any).preUpdateGate).toEqual({ at: 1_000, bootId: 'boot-a', uptimeS: 10 })
        expect(logs.some(l => /is busy/.test(l))).toBe(true)
        // the same busy reason is not logged twice in one boot
        logs.length = 0
        await scanPreUpdateQuarantine(h, deps({ acquire: () => false }))
        expect(logs).toEqual([])
    })

    it('keeps the field and logs once when the helper fails', async () => {
        const fail = async () => { throw new Error('QUARANTINE_FAILED: disk error') }
        expect(await scanPreUpdateQuarantine(h, deps({ quarantineSnapshot: fail }))).toBe(0)
        expect((h.doc().instanceDB['i1' as any] as any).preUpdateGate.at).toBe(1_000)
        expect(logs.filter(l => /QUARANTINE_FAILED/.test(l))).toHaveLength(1)
        logs.length = 0
        await scanPreUpdateQuarantine(h, deps({ quarantineSnapshot: fail }))
        expect(logs.filter(l => /QUARANTINE_FAILED/.test(l))).toHaveLength(0)
    })

    it('does not fire when the disk is undocked', async () => {
        h.change(d => { const x = d.diskDB['d1' as any] as any; x.device = null; x.dockedTo = null })
        expect(await scanPreUpdateQuarantine(h, deps())).toBe(0)
        expect((h.doc().instanceDB['i1' as any] as any).preUpdateGate.at).toBe(1_000)
    })

    it('logs once and keeps the field when the helper is older than v14', async () => {
        expect(await scanPreUpdateQuarantine(h, deps({ helperProblem: async () => 'needs v14' }))).toBe(0)
        expect((h.doc().instanceDB['i1' as any] as any).preUpdateGate.at).toBe(1_000)
        expect(logs.some(l => /needs v14/.test(l))).toBe(true)
    })

    it('on a new boot, the first trusted moment writes at and does not fire yet', async () => {
        h.change(d => { (d.instanceDB['i1' as any] as any).preUpdateGate = { at: null, bootId: 'boot-old', uptimeS: 80 } })
        expect(await scanPreUpdateQuarantine(h, deps({
            wallMs: () => 9_000, bootId: () => 'boot-new', uptimeS: () => 2, clockTrusted: () => true,
        }))).toBe(0)
        expect((h.doc().instanceDB['i1' as any] as any).preUpdateGate).toEqual({ at: 9_000, bootId: 'boot-new', uptimeS: 2 })
    })
})
