/**
 * peer-clock.test.ts (engine#352): ephemeral peer clocks as a clock-trust source.
 *
 * A peer is a time source only if its hb carries ntpSynced / clockTrusted and
 * at least one of those is true. Two never-synced Pis must not vouch for each
 * other. No store writes. The system clock is not touched.
 */
import { describe, it, beforeEach, expect } from 'vitest'
import {
    notePing, peerClockViews, estimatePeerNow, clearPeerPings, hbMessage, startLiveness,
    HB_TYPE, PEER_CLOCK_STALE_MS,
} from '../../src/data/Liveness.js'
import { peerClockInputs, CLOCK_SKEW_TOLERANCE_MS } from '../../src/utils/backupSchedule.js'
import { Repo } from '@automerge/automerge-repo'

const T0 = 1_700_000_000_000
const MIN = 60_000
const view = (o: { nowMs?: number, ntpSynced?: boolean, clockTrusted?: boolean, hasClockFields?: boolean }) => ({
    nowMs: o.nowMs ?? T0,
    ntpSynced: o.ntpSynced ?? false,
    clockTrusted: o.clockTrusted ?? false,
    hasClockFields: o.hasClockFields ?? true,
})

beforeEach(() => clearPeerPings())

describe('peerClockInputs (engine#352 calls 2, 6, 7)', () => {
    it('two never-synced peers (no ntp, no clockTrusted) are not sources and do not set peerSynced', () => {
        const r = peerClockInputs(T0, [
            view({ ntpSynced: false, clockTrusted: false }),
            view({ ntpSynced: false, clockTrusted: false, nowMs: T0 + 1_000 }),
        ])
        expect(r).toEqual({ peerSynced: false, peerNtpAgreed: false, syncedPeerNowMs: null, ignoredForDisagreement: false })
    })

    it('a clockTrusted non-NTP peer that agrees sets peerSynced but not peerNtpAgreed or syncedPeerNowMs', () => {
        const r = peerClockInputs(T0, [view({ ntpSynced: false, clockTrusted: true })])
        expect(r.peerSynced).toBe(true)
        expect(r.peerNtpAgreed).toBe(false)
        expect(r.syncedPeerNowMs).toBeNull()
    })

    it('an ntpSynced peer that agrees sets peerSynced, peerNtpAgreed and syncedPeerNowMs', () => {
        const r = peerClockInputs(T0, [view({ ntpSynced: true, clockTrusted: true, nowMs: T0 + 2_000 })])
        expect(r.peerSynced).toBe(true)
        expect(r.peerNtpAgreed).toBe(true)
        expect(r.syncedPeerNowMs).toBe(T0 + 2_000)
    })

    it('an ntpSynced peer more than 5 min away is still used for AHEAD_OF_PEER but does not agree', () => {
        const r = peerClockInputs(T0, [view({ ntpSynced: true, clockTrusted: true, nowMs: T0 - 6 * MIN })])
        expect(r.peerSynced).toBe(false)
        expect(r.peerNtpAgreed).toBe(false)
        expect(r.syncedPeerNowMs).toBe(T0 - 6 * MIN)
        expect(Math.abs((T0 - 6 * MIN) - T0)).toBeGreaterThan(CLOCK_SKEW_TOLERANCE_MS)
    })

    it('usable peers that disagree by more than 5 min cause all peer input to be ignored', () => {
        const r = peerClockInputs(T0, [
            view({ ntpSynced: true, clockTrusted: true, nowMs: T0 }),
            view({ ntpSynced: true, clockTrusted: true, nowMs: T0 + 6 * MIN }),
        ])
        expect(r).toEqual({ peerSynced: false, peerNtpAgreed: false, syncedPeerNowMs: null, ignoredForDisagreement: true })
    })

    it('an old Engine (no clock fields) is not a source, even if its now agrees', () => {
        const r = peerClockInputs(T0, [view({ hasClockFields: false, nowMs: T0, ntpSynced: false, clockTrusted: false })])
        expect(r.peerSynced).toBe(false)
        expect(r.ignoredForDisagreement).toBe(false)
    })
})

describe('Liveness peer clock memory (calls 1, 10; old hb)', () => {
    const hb = (id: string, extra: Record<string, unknown> = {}) =>
        ({ type: HB_TYPE, v: 1, engineId: id, now: T0, bootedAt: T0, ...extra })

    it('estimatePeerNow is hb.now plus elapsed since receive', () => {
        expect(estimatePeerNow(T0, T0, T0 + 15_000)).toBe(T0 + 15_000)
    })

    it('records ntpSynced and clockTrusted from a new hb and estimates now', () => {
        expect(notePing(hb('ENGINE_a', { ntpSynced: true, clockTrusted: true }), T0)).toBe(true)
        const v = peerClockViews(T0 + 5_000)
        expect(v).toHaveLength(1)
        expect(v[0]).toMatchObject({ engineId: 'ENGINE_a', ntpSynced: true, clockTrusted: true, hasClockFields: true, nowMs: T0 + 5_000 })
    })

    it('an old hb without the new fields is kept but hasClockFields is false', () => {
        notePing(hb('ENGINE_old'), T0)
        const v = peerClockViews(T0)
        expect(v[0]).toMatchObject({ engineId: 'ENGINE_old', hasClockFields: false, ntpSynced: false, clockTrusted: false })
        expect(peerClockInputs(T0, v).peerSynced).toBe(false)
    })

    it('drops a peer silent for more than 60 s and keeps one that is just inside', () => {
        notePing(hb('ENGINE_stale', { ntpSynced: true, clockTrusted: true }), T0)
        notePing(hb('ENGINE_fresh', { ntpSynced: true, clockTrusted: true, now: T0 + 1 }), T0 + 1)
        expect(peerClockViews(T0 + PEER_CLOCK_STALE_MS).map(p => p.engineId)).toEqual(['ENGINE_stale', 'ENGINE_fresh'])
        expect(peerClockViews(T0 + PEER_CLOCK_STALE_MS + 1).map(p => p.engineId)).toEqual(['ENGINE_fresh'])
    })

    it('hbMessage includes the clock fields only when they are passed (old shape otherwise)', () => {
        const h = new Repo({ network: [] }).create<any>({ engineDB: { ENGINE_me: { lastBooted: T0 } } })
        expect(hbMessage(h, 'ENGINE_me', 42)).toEqual({ type: HB_TYPE, v: 1, engineId: 'ENGINE_me', now: 42, bootedAt: T0 })
        expect(hbMessage(h, 'ENGINE_me', 42, { ntpSynced: true, clockTrusted: false })).toEqual({
            type: HB_TYPE, v: 1, engineId: 'ENGINE_me', now: 42, bootedAt: T0, ntpSynced: true, clockTrusted: false,
        })
    })

    it('startLiveness always sends ntpSynced and clockTrusted (defaults false) and does not write the store for them', async () => {
        const h = new Repo({ network: [] }).create<any>({
            engineDB: { ENGINE_me: { id: 'ENGINE_me', lastBooted: T0, lastRun: T0 } },
        })
        const sent: any[] = []
        const orig = h.broadcast.bind(h)
        ;(h as any).broadcast = (m: any) => { sent.push(m); orig(m) }
        const stop = startLiveness(h, 'ENGINE_me', { hbIntervalMs: 10_000, now: () => T0 })
        stop()
        expect(sent[0]).toMatchObject({ type: HB_TYPE, ntpSynced: false, clockTrusted: false })
        expect(h.doc().engineDB.ENGINE_me.lastRun).toBe(T0)
    })
})
