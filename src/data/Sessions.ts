/**
 * Sessions.ts — operator sessions, in memory only (engine#582).
 *
 * A token is 32 random bytes (base64url), sent as `Authorization: Bearer <token>`.
 * Only SHA-256(token) is kept, with { operatorId, username, createdAt, lastUsed,
 * expiresAt }. Nothing is written to disk or the store; a restart ends every session.
 *
 *   idle TTL   15 min, renewed by every accepted call and by renew()
 *   hard cap    8 h from sign-in
 *   max        32 sessions; the least recently used is dropped
 *
 * Times use the monotonic clock (monoClock.ts).
 */

import crypto from 'crypto'
import { monoNow } from '../utils/monoClock.js'

export const SESSION_IDLE_MS = 15 * 60_000
export const SESSION_MAX_MS = 8 * 60 * 60_000
export const MAX_SESSIONS = 32

export interface Session {
    key: string           // SHA-256(token), hex
    operatorId: string
    username: string
    createdAt: number
    lastUsed: number
    expiresAt: number
}

export type SessionCheck = { ok: true, session: Session } | { ok: false, code: 'AUTH_REQUIRED' | 'TOKEN_INVALID' | 'TOKEN_EXPIRED' }

const sessions = new Map<string, Session>()

const keyOf = (token: string): string => crypto.createHash('sha256').update(token).digest('hex')
const expiryOf = (s: Pick<Session, 'createdAt'>, now: number): number => Math.min(now + SESSION_IDLE_MS, s.createdAt + SESSION_MAX_MS)

/** Short id of a session for logs and traces: first 8 hex of its key. */
export const sessionShortId = (s: Session): string => s.key.slice(0, 8)

export const createSession = (operator: { id: string, username: string }, now: number = monoNow()): { token: string, session: Session, expiresInMs: number } => {
    for (const [k, s] of sessions) if (s.expiresAt <= now) sessions.delete(k)
    while (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]
        sessions.delete(oldest.key)
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const session: Session = { key: keyOf(token), operatorId: operator.id, username: operator.username, createdAt: now, lastUsed: now, expiresAt: 0 }
    session.expiresAt = expiryOf(session, now)
    sessions.set(session.key, session)
    return { token, session, expiresInMs: session.expiresAt - now }
}

/** Token from an Authorization header value ("Bearer <token>"), or null. */
export const bearerToken = (header: string | string[] | undefined): string | null => {
    const h = Array.isArray(header) ? header[0] : header
    const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h.trim()) : null
    return m ? m[1] : null
}

/** Check a token; on success the session is renewed (idle TTL, within the cap). */
export const checkToken = (token: string | null, now: number = monoNow(), renew: boolean = true): SessionCheck => {
    if (!token) return { ok: false, code: 'AUTH_REQUIRED' }
    const s = sessions.get(keyOf(token))
    if (!s) return { ok: false, code: 'TOKEN_INVALID' }
    if (s.expiresAt <= now) { sessions.delete(s.key); return { ok: false, code: 'TOKEN_EXPIRED' } }
    if (renew) { s.lastUsed = now; s.expiresAt = expiryOf(s, now) }
    return { ok: true, session: s }
}

export const endSession = (token: string | null): boolean => !!token && sessions.delete(keyOf(token))

/** End every session of an operator (removed, or password changed elsewhere). */
export const endSessionsOf = (operatorId: string, exceptKey?: string): void => {
    for (const [k, s] of sessions) if (s.operatorId === operatorId && k !== exceptKey) sessions.delete(k)
}

/** Tests only. */
export const clearSessionsForTests = (): void => sessions.clear()
export const sessionCountForTests = (): number => sessions.size
