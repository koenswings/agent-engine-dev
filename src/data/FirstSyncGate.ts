/**
 * FirstSyncGate.ts (engine#543): let the first peer's store sync be served before the
 * Engine's own instance bring-up (the dock pass: status writes, image loads, compose
 * starts) blocks the event loop.
 *
 * Why: on a big store doc the Engine's loop is blocked for tens of seconds after a pm2
 * restart (engine#512 [loop-stall] lines: ~28 s store load, then 3 + 2.5 + 7.7 + 21 s
 * during bring-up). Peers (the walker, other Engines, the Console) that reconnect meanwhile
 * get no sync answer, time out and restart their own full sync from zero. Bring-up work
 * that can wait is held until the first remote peer is caught up with the store doc.
 *
 * Bounded, never a new way to hang startup:
 *   - no peer connected (and none syncing) after `noPeerGraceMs`: go on ('no-peer');
 *   - nobody caught up after `maxWaitMs`: go on ('timeout');
 *   - `maxWaitMs` 0 (testMode, IDEA_WATCH_DIR, IDEA_FIRST_SYNC_WAIT_MS=0): no wait at all ('skipped').
 * "Served" = a remote peer's sync state for the store doc shares exactly the heads this
 * Engine has (the peer has everything we have and we have everything the peer has).
 * Observes only; never writes to a doc.
 */
import { log } from '../utils/utils.js'

export const FIRST_SYNC_MAX_WAIT_MS = 45_000
export const FIRST_SYNC_NO_PEER_GRACE_MS = 5_000

export type FirstSyncResult = 'served' | 'no-peer' | 'timeout' | 'skipped'

export interface FirstSyncOutcome {
    result: FirstSyncResult
    waitedMs: number
    /** the peer whose sync state matched our heads ('served' only) */
    peerId?: string
}

/** The slice of automerge-repo's Repo the gate needs (a fake in tests). */
export interface FirstSyncRepo {
    peerId?: string
    peers: readonly string[]
    synchronizer: {
        on(event: 'sync-state', fn: (p: { peerId: string; documentId: string; syncState: { sharedHeads?: readonly string[] } }) => void): unknown
        off(event: 'sync-state', fn: (p: { peerId: string; documentId: string; syncState: { sharedHeads?: readonly string[] } }) => void): unknown
    }
}

export interface FirstSyncGateOptions {
    storeDocId: string
    /** current heads of the store doc; [] until bound */
    heads: () => readonly string[]
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (t: unknown) => void
}

export interface FirstSyncWaitOptions {
    maxWaitMs?: number
    noPeerGraceMs?: number
}

export interface FirstSyncGate {
    whenServed(opts?: FirstSyncWaitOptions): Promise<FirstSyncOutcome>
    stop(): void
}

const sameHeads = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length === 0 || a.length !== b.length) return false
    const s = new Set(a)
    return b.every(h => s.has(h))
}

export const startFirstSyncGate = (repo: FirstSyncRepo, opts: FirstSyncGateOptions): FirstSyncGate => {
    const now = opts.now ?? Date.now
    const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    // last shared heads per remote peer for the store doc (recorded from the start, so a sync that
    // finished before whenServed was called still counts)
    const shared = new Map<string, readonly string[]>()
    let listeners: Array<() => void> = []
    const onState = (p: { peerId: string; documentId: string; syncState: { sharedHeads?: readonly string[] } }) => {
        if (String(p.documentId) !== String(opts.storeDocId)) return
        if (repo.peerId && String(p.peerId) === String(repo.peerId)) return
        shared.set(String(p.peerId), [...(p.syncState?.sharedHeads ?? [])])
        for (const l of [...listeners]) l()
    }
    repo.synchronizer.on('sync-state', onState)

    const servedPeer = (): string | undefined => {
        const mine = opts.heads()
        for (const [peer, heads] of shared) if (sameHeads(heads, mine)) return peer
        return undefined
    }

    return {
        stop: () => { repo.synchronizer.off('sync-state', onState); listeners = [] },
        whenServed: (w = {}) => new Promise<FirstSyncOutcome>((resolve) => {
            const maxWaitMs = w.maxWaitMs ?? FIRST_SYNC_MAX_WAIT_MS
            const noPeerGraceMs = w.noPeerGraceMs ?? FIRST_SYNC_NO_PEER_GRACE_MS
            const t0 = now()
            if (maxWaitMs <= 0) return resolve({ result: 'skipped', waitedMs: 0 })
            let done = false
            const timers: unknown[] = []
            const finish = (o: Omit<FirstSyncOutcome, 'waitedMs'>) => {
                if (done) return
                done = true
                timers.forEach(clearTimer)
                listeners = listeners.filter(l => l !== check)
                resolve({ ...o, waitedMs: now() - t0 })
            }
            const check = () => {
                const peerId = servedPeer()
                if (peerId !== undefined) finish({ result: 'served', peerId })
            }
            listeners.push(check)
            check()
            if (done) return
            timers.push(setTimer(() => {
                // a peer that is connected or already syncing keeps us waiting up to maxWaitMs
                if (repo.peers.length === 0 && shared.size === 0) finish({ result: 'no-peer' })
            }, Math.min(noPeerGraceMs, maxWaitMs)))
            timers.push(setTimer(() => finish({ result: 'timeout' }), maxWaitMs))
        }),
    }
}

/** Env/config → wait settings. testMode and IDEA_WATCH_DIR never wait (no peers, tests stay as they were). */
export const firstSyncWaitSettings = (
    env: Record<string, string | undefined>,
    ctx: { testMode?: boolean; watchDirSet?: boolean },
): { maxWaitMs: number; noPeerGraceMs: number } => {
    const num = (v: string | undefined, d: number) => {
        if (v === undefined || v.trim() === '') return d
        const n = Number(v)
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d
    }
    if (ctx.testMode || ctx.watchDirSet) return { maxWaitMs: 0, noPeerGraceMs: 0 }
    return {
        maxWaitMs: num(env.IDEA_FIRST_SYNC_WAIT_MS, FIRST_SYNC_MAX_WAIT_MS),
        noPeerGraceMs: num(env.IDEA_FIRST_SYNC_NO_PEER_GRACE_MS, FIRST_SYNC_NO_PEER_GRACE_MS),
    }
}

/** One turn of the event loop: queued socket reads / timers (sync answers) run before the next heavy step. */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

export const logFirstSyncOutcome = (o: FirstSyncOutcome, line: (m: string) => void = log): void => {
    const why: Record<FirstSyncResult, string> = {
        served: `first store sync served to ${o.peerId ?? 'a peer'}`,
        'no-peer': 'no peer connected within the grace period',
        timeout: 'no peer caught up within the wait budget',
        skipped: 'disabled (testMode / IDEA_WATCH_DIR / IDEA_FIRST_SYNC_WAIT_MS=0)',
    }
    line(`[first-sync] ${o.result} after ${o.waitedMs} ms: ${why[o.result]}; instance bring-up continues (engine#543)`)
}
