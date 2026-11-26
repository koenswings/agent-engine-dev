/**
 * LoginRateLimit.ts — sign-in rate limits (engine#582).
 *
 *   per client  5 failures in 5 min → locked 60 s, doubling with each further
 *               lock up to 15 min; a success clears that client's record
 *   per account 20 failures for one username in 15 min (all clients) → that
 *               username locked for 15 min
 *   global      30 failures in 1 min → every sign-in locked until the minute passes
 *
 * The client key is the original client address: the socket address, or the
 * address a relaying Engine vouches for (relay step). Monotonic clock.
 */

import { monoNow } from '../utils/monoClock.js'

export const CLIENT_MAX_FAILS = 5
export const CLIENT_WINDOW_MS = 5 * 60_000
export const CLIENT_LOCK_BASE_MS = 60_000
export const CLIENT_LOCK_MAX_MS = 15 * 60_000
export const ACCOUNT_MAX_FAILS = 20
export const ACCOUNT_WINDOW_MS = 15 * 60_000
export const ACCOUNT_LOCK_MS = 15 * 60_000
export const GLOBAL_MAX_FAILS = 30
export const GLOBAL_WINDOW_MS = 60_000

interface Rec { fails: number[], lockedUntil: number, locks: number }
const clients = new Map<string, Rec>()
const accounts = new Map<string, Rec>()
let globalFails: number[] = []

const rec = (m: Map<string, Rec>, k: string): Rec => {
    let r = m.get(k)
    if (!r) { r = { fails: [], lockedUntil: 0, locks: 0 }; m.set(k, r) }
    if (m.size > 5000) m.delete(m.keys().next().value as string)
    return r
}

/** Milliseconds to wait before a sign-in by `client` for `username` is allowed; 0 = allowed. */
export const loginWaitMs = (client: string, username: string, now: number = monoNow()): number => {
    const c = clients.get(client)
    const a = accounts.get(username)
    globalFails = globalFails.filter(t => now - t < GLOBAL_WINDOW_MS)
    const g = globalFails.length >= GLOBAL_MAX_FAILS ? globalFails[0] + GLOBAL_WINDOW_MS - now : 0
    return Math.max(0, (c?.lockedUntil ?? 0) - now, (a?.lockedUntil ?? 0) - now, g)
}

export const recordLoginFailure = (client: string, username: string, now: number = monoNow()): void => {
    globalFails.push(now)
    const c = rec(clients, client)
    c.fails = c.fails.filter(t => now - t < CLIENT_WINDOW_MS)
    c.fails.push(now)
    if (c.fails.length >= CLIENT_MAX_FAILS) {
        c.lockedUntil = now + Math.min(CLIENT_LOCK_MAX_MS, CLIENT_LOCK_BASE_MS * 2 ** c.locks)
        c.locks++
        c.fails = []
    }
    const a = rec(accounts, username)
    a.fails = a.fails.filter(t => now - t < ACCOUNT_WINDOW_MS)
    a.fails.push(now)
    if (a.fails.length >= ACCOUNT_MAX_FAILS) { a.lockedUntil = now + ACCOUNT_LOCK_MS; a.fails = [] }
}

export const recordLoginSuccess = (client: string): void => { clients.delete(client) }

/** Tests only. */
export const clearRateLimitsForTests = (): void => { clients.clear(); accounts.clear(); globalFails = [] }
