/**
 * Liveness.ts: this Engine's heartbeat without store history (store-design
 * PROPOSAL, Koen decision 2026-10-13).
 *
 * Before: every 30 s each Engine wrote engineDB[self].lastRun into the shared
 * store doc (8.6k changes/day for 3 Pis, kept forever). Now:
 *   - every HB_INTERVAL_MS (10 s) an automerge-repo ephemeral message on the
 *     store handle: { type: 'idea/hb', v: 1, engineId, now, bootedAt }. Engines
 *     relay it to every peer of the doc (test/automated/ephemeral-relay.test.ts),
 *     so a Console on any Pi sees every Pi. It is never stored.
 *   - engineDB[self].lastRun is still the stored "last seen" (written at boot and
 *     at most once per LAST_SEEN_INTERVAL_MS, 1 h): 24 changes/day per Pi. The
 *     field name is kept so old Engines and Consoles keep reading it.
 *   - peers' hb pings are remembered in memory (receive time on OUR clock);
 *     PeerAccess's stale rule uses max(stored lastRun, last ping), so the
 *     7-day expiry (and peer-verify's short test threshold) still works.
 */
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { Timestamp } from './CommonTypes.js'
import { log } from '../utils/utils.js'

export const HB_INTERVAL_MS = 10_000
export const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000
export const HB_TYPE = 'idea/hb'
export const METRICS_TYPE = 'idea/metrics'

export interface HbMessage { type: typeof HB_TYPE, v: 1, engineId: string, now: number, bootedAt: number | null }

/** engineId -> when we last received its hb or metrics (our clock). */
const pings = new Map<string, number>()

/** When we last heard a live message from `engineId` (our clock), or undefined. */
export const peerLiveSeen = (engineId: string): number | undefined => pings.get(engineId)
/** Tests only. */
export const clearPeerPings = (): void => { pings.clear() }

/** Record an incoming ephemeral message; returns true when it was one of ours. */
export const notePing = (message: unknown, receivedAt: number = Date.now()): boolean => {
    const m = message as { type?: unknown, engineId?: unknown } | null
    if (!m || (m.type !== HB_TYPE && m.type !== METRICS_TYPE) || typeof m.engineId !== 'string' || !m.engineId) return false
    pings.set(m.engineId, receivedAt)
    return true
}

/**
 * Write engineDB[self].lastRun when it is missing or at least `intervalMs` old
 * (or `force`). Returns true when it wrote.
 */
export const writeLastSeen = (handle: DocHandle<Store>, engineId: string, now: number, intervalMs = LAST_SEEN_INTERVAL_MS, force = false): boolean => {
    const eng: any = (handle.doc() as any)?.engineDB?.[engineId]
    if (!eng) return false
    const last = Number(eng.lastRun)
    if (!force && Number.isFinite(last) && last > 0 && now - last < intervalMs && now >= last) return false
    handle.change((d: any) => { const e = d.engineDB?.[engineId]; if (e) e.lastRun = now as Timestamp })
    log(`last seen (lastRun) stored: ${now}`)
    return true
}

export const hbMessage = (handle: DocHandle<Store>, engineId: string, now: number): HbMessage => {
    const booted = Number((handle.doc() as any)?.engineDB?.[engineId]?.lastBooted)
    return { type: HB_TYPE, v: 1, engineId, now, bootedAt: Number.isFinite(booted) ? booted : null }
}

export interface LivenessOptions {
    hbIntervalMs?: number
    lastSeenIntervalMs?: number
    now?: () => number
}

/** Start the hb broadcast, the hourly lastSeen write and the ping listener. Returns stop(). */
export const startLiveness = (handle: DocHandle<Store>, engineId: string, opts: LivenessOptions = {}): (() => void) => {
    const now = opts.now ?? Date.now
    const onEphemeral = (ev: any) => { notePing(ev?.message) }
    handle.on('ephemeral-message', onEphemeral)
    const beat = () => {
        try {
            handle.broadcast(hbMessage(handle, engineId, now()))
            writeLastSeen(handle, engineId, now(), opts.lastSeenIntervalMs ?? LAST_SEEN_INTERVAL_MS)
        } catch (e) { log(`liveness: ${e}`) }
    }
    beat()
    const t = setInterval(beat, opts.hbIntervalMs ?? HB_INTERVAL_MS)
    return () => { clearInterval(t); handle.off('ephemeral-message', onEphemeral) }
}
