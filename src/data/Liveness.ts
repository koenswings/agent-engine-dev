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
import { currentLanSelection, lanChangeLines, LanSelection } from './LanAddress.js'

export const HB_INTERVAL_MS = 10_000
export const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000
/** Drop a peer clock sample after this much silence (Steve, engine#352 call 10). */
export const PEER_CLOCK_STALE_MS = 60_000
export const HB_TYPE = 'idea/hb'
export const METRICS_TYPE = 'idea/metrics'

export interface HbMessage {
    type: typeof HB_TYPE
    v: 1
    engineId: string
    now: number
    bootedAt: number | null
    /** engine#352; absent on old Engines (those are not a time source). */
    ntpSynced?: boolean
    clockTrusted?: boolean
}

/** A live peer's clock as the scheduler sees it (estimated now, not stored). */
export interface PeerClockView {
    engineId: string
    nowMs: number
    ntpSynced: boolean
    clockTrusted: boolean
    /** False when the hb omitted the #352 booleans (old Engine). */
    hasClockFields: boolean
}

/** engineId -> when we last received its hb or metrics (our clock). */
const pings = new Map<string, number>()
/** engineId -> last idea/hb clock payload (in memory only). */
const clocks = new Map<string, { engineId: string, hbNow: number, receivedAt: number, ntpSynced: boolean, clockTrusted: boolean, hasClockFields: boolean }>()

/** When we last heard a live message from `engineId` (our clock), or undefined. */
export const peerLiveSeen = (engineId: string): number | undefined => pings.get(engineId)
/** Tests only. */
export const clearPeerPings = (): void => { pings.clear(); clocks.clear() }

/** Record an incoming ephemeral message; returns true when it was one of ours. */
export const notePing = (message: unknown, receivedAt: number = Date.now()): boolean => {
    const m = message as { type?: unknown, engineId?: unknown, now?: unknown, ntpSynced?: unknown, clockTrusted?: unknown } | null
    if (!m || (m.type !== HB_TYPE && m.type !== METRICS_TYPE) || typeof m.engineId !== 'string' || !m.engineId) return false
    pings.set(m.engineId, receivedAt)
    if (m.type === HB_TYPE && typeof m.now === 'number' && Number.isFinite(m.now)) {
        const hasClockFields = typeof m.ntpSynced === 'boolean' && typeof m.clockTrusted === 'boolean'
        clocks.set(m.engineId, {
            engineId: m.engineId,
            hbNow: m.now,
            receivedAt,
            ntpSynced: m.ntpSynced === true,
            clockTrusted: m.clockTrusted === true,
            hasClockFields,
        })
    }
    return true
}

/** Peer `now` at `ourNow`: hb.now plus elapsed since receive (call 10). */
export const estimatePeerNow = (hbNow: number, receivedAt: number, ourNow: number): number =>
    hbNow + (ourNow - receivedAt)

/**
 * Live peer clock views for the scheduler. Drops peers silent longer than
 * `staleMs`, and this Engine if `localEngineId` is given. Never reads the store.
 */
export const peerClockViews = (
    ourNow: number,
    localEngineId?: string,
    staleMs = PEER_CLOCK_STALE_MS,
): PeerClockView[] => {
    const out: PeerClockView[] = []
    for (const s of clocks.values()) {
        if (localEngineId && s.engineId === String(localEngineId)) continue
        if (ourNow - s.receivedAt > staleMs) continue
        out.push({
            engineId: s.engineId,
            nowMs: estimatePeerNow(s.hbNow, s.receivedAt, ourNow),
            ntpSynced: s.ntpSynced,
            clockTrusted: s.clockTrusted,
            hasClockFields: s.hasClockFields,
        })
    }
    return out
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

/**
 * Engine.lanAddress / lanAddresses (agent-console-dev#138, #165): re-read the LAN IPv4s
 * on every beat and store them only when they changed (DHCP, cable out), so they add no
 * store history while the addresses are stable. Returns true when it wrote.
 */
export const writeLanAddress = (handle: DocHandle<Store>, engineId: string, sel: LanSelection = currentLanSelection()): boolean => {
    const eng: any = (handle.doc() as any)?.engineDB?.[engineId]
    if (!eng) return false
    const lines = lanChangeLines(eng, sel)
    if (!lines.length) return false
    for (const l of lines) log(l)
    const addrChanged = (eng.lanAddress ?? null) !== sel.address
    const listChanged = lines.length > (addrChanged ? 1 : 0)
    handle.change((d: any) => {
        const e = d.engineDB?.[engineId]
        if (!e) return
        if (addrChanged) e.lanAddress = sel.address
        if (listChanged) e.lanAddresses = sel.addresses ? [...sel.addresses] : null
    })
    return true
}

export const hbMessage = (
    handle: DocHandle<Store>,
    engineId: string,
    now: number,
    clock?: { ntpSynced: boolean, clockTrusted: boolean } | null,
): HbMessage => {
    const booted = Number((handle.doc() as any)?.engineDB?.[engineId]?.lastBooted)
    const msg: HbMessage = { type: HB_TYPE, v: 1, engineId, now, bootedAt: Number.isFinite(booted) ? booted : null }
    if (clock) {
        msg.ntpSynced = !!clock.ntpSynced
        msg.clockTrusted = !!clock.clockTrusted
    }
    return msg
}

export interface LivenessOptions {
    hbIntervalMs?: number
    lastSeenIntervalMs?: number
    now?: () => number
    /** engine#352: included on every hb so peers can use us as a time source. Defaults to both false. */
    clockStatus?: () => { ntpSynced: boolean, clockTrusted: boolean }
}

/** Start the hb broadcast, the hourly lastSeen write and the ping listener. Returns stop(). */
export const startLiveness = (handle: DocHandle<Store>, engineId: string, opts: LivenessOptions = {}): (() => void) => {
    const now = opts.now ?? Date.now
    const onEphemeral = (ev: any) => { notePing(ev?.message) }
    handle.on('ephemeral-message', onEphemeral)
    const beat = () => {
        try {
            const clock = opts.clockStatus ? opts.clockStatus() : { ntpSynced: false, clockTrusted: false }
            handle.broadcast(hbMessage(handle, engineId, now(), clock))
            writeLastSeen(handle, engineId, now(), opts.lastSeenIntervalMs ?? LAST_SEEN_INTERVAL_MS)
            writeLanAddress(handle, engineId)
        } catch (e) { log(`liveness: ${e}`) }
    }
    beat()
    const t = setInterval(beat, opts.hbIntervalMs ?? HB_INTERVAL_MS)
    return () => { clearInterval(t); handle.off('ephemeral-message', onEphemeral) }
}
