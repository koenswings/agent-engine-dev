/**
 * WsLiveness.ts (#168): dead-socket detection for the Engine's outgoing WS links.
 *
 * A half-open TCP/WS connection (relay blip, VM pause) never fires `close`, so the
 * stock client never redials and the Repo keeps serving a frozen view. The watchdog
 * counts every inbound message, ping and pong as "heard", pings every `pingMs`, and
 * terminates the socket when nothing was heard for `deadMs`; the adapter's own
 * close handling then redials and the Repo re-syncs.
 *
 * engine#512: silence while OUR event loop was stalled is not the peer's fault. When the
 * main thread is blocked (synchronous Automerge work on the large store doc and the
 * dock pass at Engine start, seconds to a minute on a Pi), the peer's messages and pongs
 * wait in the kernel. When the loop resumes, Node runs the timers phase BEFORE the I/O
 * poll phase, so this tick ran first, saw nothing heard for 65 s and dropped two healthy
 * links (idea04 16:54:30, the trigger of the outdated-document crash). A tick that comes
 * late therefore credits the part of its gap beyond one ping interval back to the link:
 * only time the loop ran normally counts as silence. A stall longer than `stallMs`
 * (default 2 x pingMs) is logged. A truly dead socket is still dropped once `deadMs` of
 * normal running passed without a sound.
 */

import { log } from '../utils/utils.js'

export interface LivenessSocket {
    readyState: number
    ping?: () => void
    terminate?: () => void
    close: () => void
    on?: (ev: string, fn: (...a: any[]) => void) => void
    off?: (ev: string, fn: (...a: any[]) => void) => void
    addEventListener?: (ev: string, fn: (...a: any[]) => void) => void
    removeEventListener?: (ev: string, fn: (...a: any[]) => void) => void
}

export interface LivenessOptions {
    pingMs: number; deadMs: number; label: string; onDead?: () => void; now?: () => number
    /** engine#512: a tick later than this after the previous one = our loop was stalled (default 2 x pingMs). */
    stallMs?: number
}

const OPEN = 1

const envMs = (name: string, dflt: number): number => {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? n : dflt
}
export const wsPingMs = (): number => envMs('IDEA_WS_PING_MS', 5_000)
export const wsDeadMs = (): number => envMs('IDEA_WS_DEAD_MS', 15_000)

export class WsLiveness {
    lastHeard: number
    /** engine#512: ticks skipped because our own event loop had stalled. */
    stalls = 0
    #lastTick: number
    #timer?: ReturnType<typeof setInterval>
    #socket?: LivenessSocket
    #now: () => number
    #heard = () => { this.lastHeard = this.#now() }

    constructor(private opts: LivenessOptions) {
        this.#now = opts.now ?? Date.now
        this.lastHeard = this.#now()
        this.#lastTick = this.lastHeard
    }

    /** Watch a (new) socket; replaces any previous one. */
    attach(socket: LivenessSocket): void {
        this.detach()
        this.#socket = socket
        this.lastHeard = this.#now()
        this.#lastTick = this.lastHeard
        socket.addEventListener?.('message', this.#heard)
        socket.addEventListener?.('open', this.#heard)
        socket.on?.('ping', this.#heard)
        socket.on?.('pong', this.#heard)
        this.#timer = setInterval(() => this.tick(), this.opts.pingMs)
        ;(this.#timer as any).unref?.()
    }

    /** One watchdog step (exported for tests). */
    tick(): void {
        const s = this.#socket
        const now = this.#now()
        const gap = now - this.#lastTick
        this.#lastTick = now
        if (!s || s.readyState !== OPEN) { this.lastHeard = now; return }   // connecting: the redial owns it
        // engine#512: a late tick means our loop was blocked and the peer's queued messages are
        // read only after this tick. Count only the time the loop ran normally as silence: the
        // part of the gap beyond one ping interval is credited back to the link.
        const excess = gap - this.opts.pingMs
        if (excess > 0) this.lastHeard = Math.min(now, this.lastHeard + excess)
        if (gap > (this.opts.stallMs ?? 2 * this.opts.pingMs)) {
            this.stalls++
            log(`WS ${this.opts.label}: watchdog tick ${gap} ms late (this Engine's event loop was stalled); the stall is not counted as silence (engine#512)`)
        }
        const age = now - this.lastHeard
        if (age >= this.opts.deadMs) {
            log(`WS ${this.opts.label}: nothing heard for ${age} ms, dropping the dead socket to reconnect (#168)`)
            this.detach()
            try { s.terminate ? s.terminate() : s.close() } catch { /* already gone */ }
            this.opts.onDead?.()
            return
        }
        try { s.ping?.() } catch { /* closing */ }
    }

    get lastHeardAgeMs(): number { return this.#now() - this.lastHeard }

    detach(): void {
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = undefined
        const s = this.#socket
        if (s) {
            s.removeEventListener?.('message', this.#heard)
            s.removeEventListener?.('open', this.#heard)
            s.off?.('ping', this.#heard)
            s.off?.('pong', this.#heard)
        }
        this.#socket = undefined
    }
}
