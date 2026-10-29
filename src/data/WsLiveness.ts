/**
 * WsLiveness.ts (#168): dead-socket detection for the Engine's outgoing WS links.
 *
 * A half-open TCP/WS connection (relay blip, VM pause) never fires `close`, so the
 * stock client never redials and the Repo keeps serving a frozen view. The watchdog
 * counts every inbound message, ping and pong as "heard", pings every `pingMs`, and
 * terminates the socket when nothing was heard for `deadMs`; the adapter's own
 * close handling then redials and the Repo re-syncs.
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

export interface LivenessOptions { pingMs: number; deadMs: number; label: string; onDead?: () => void; now?: () => number }

const OPEN = 1

const envMs = (name: string, dflt: number): number => {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? n : dflt
}
export const wsPingMs = (): number => envMs('IDEA_WS_PING_MS', 5_000)
export const wsDeadMs = (): number => envMs('IDEA_WS_DEAD_MS', 15_000)

export class WsLiveness {
    lastHeard: number
    #timer?: ReturnType<typeof setInterval>
    #socket?: LivenessSocket
    #now: () => number
    #heard = () => { this.lastHeard = this.#now() }

    constructor(private opts: LivenessOptions) {
        this.#now = opts.now ?? Date.now
        this.lastHeard = this.#now()
    }

    /** Watch a (new) socket; replaces any previous one. */
    attach(socket: LivenessSocket): void {
        this.detach()
        this.#socket = socket
        this.lastHeard = this.#now()
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
        if (!s || s.readyState !== OPEN) { this.lastHeard = this.#now(); return }   // connecting: the redial owns it
        const age = this.#now() - this.lastHeard
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
