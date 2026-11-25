/**
 * PeerGrants.ts — permission for another Engine to queue follow-up commands here (engine#582).
 *
 * A grant is `v1.<issuer>.<toEngine>.<grantId>.<mac>`,
 *   mac = base64url(HMAC-SHA256(commandKey, "idea-grant-v1\n" + issuer + "\n" + toEngine + "\n" + grantId)).
 * The issuer keeps it in memory for GRANT_TTL_MS (6 h, monotonic clock). It is valid
 * only for requests that say they come from `toEngine`, and only for the fixed set
 * PEER_FOLLOW_UP_COMMANDS. A restart forgets every grant: a grant the issuer signed
 * but no longer knows is GRANT_EXPIRED.
 *
 * Every grant failure names the issuer as `issuerEngineId`.
 *
 * Grants this Engine RECEIVED (from the Console for a copy/move/update, or as a reply
 * grant from a peer) are kept per issuer, so follow-ups to that Engine can use them.
 */

import crypto from 'crypto'
import { commandKey } from './CommandKey.js'
import { authFolder } from './Config.js'
import { monoNow } from '../utils/monoClock.js'

export const GRANT_TTL_MS = 6 * 60 * 60_000
const MAX_GRANTS = 1000

/** Commands another Engine may queue here with a grant. */
export const PEER_FOLLOW_UP_COMMANDS: readonly string[] = ['startInstance', 'verifyMoveTarget', 'cleanupMoveTarget', 'pushAppBundle', 'appFetchResult']

export type GrantCode = 'GRANT_INVALID' | 'GRANT_EXPIRED'
export class GrantError extends Error {
    constructor(public code: GrantCode | 'GRANT_REQUIRED', message: string, public issuerEngineId: string) { super(message) }
}

export interface ParsedGrant { issuer: string, to: string, grantId: string, mac: string }
const ID = '[A-Za-z0-9_-]{1,80}'
const GRANT_RE = new RegExp(`^v1\\.(${ID})\\.(${ID})\\.([A-Za-z0-9_-]{16})\\.([A-Za-z0-9_-]{43})$`)

export const parseGrant = (g: unknown): ParsedGrant | null => {
    const m = typeof g === 'string' ? GRANT_RE.exec(g) : null
    return m ? { issuer: m[1], to: m[2], grantId: m[3], mac: m[4] } : null
}

const grantMac = (key: Buffer, issuer: string, to: string, grantId: string): string =>
    crypto.createHmac('sha256', key).update(`idea-grant-v1\n${issuer}\n${to}\n${grantId}`).digest('base64url')

interface Issued { to: string, expiresAt: number, by?: string }
const issued = new Map<string, Issued>()

/** Issue a grant from `self` for Engine `to`. */
export const issueGrant = (self: string, to: string, by?: string, now: number = monoNow(), dir: string = authFolder()): { grant: string, expiresInMs: number } => {
    for (const [id, g] of issued) if (g.expiresAt <= now) issued.delete(id)
    if (issued.size >= MAX_GRANTS) issued.delete(issued.keys().next().value as string)
    const grantId = crypto.randomBytes(12).toString('base64url')
    issued.set(grantId, { to, expiresAt: now + GRANT_TTL_MS, by })
    return { grant: `v1.${self}.${to}.${grantId}.${grantMac(commandKey(dir), self, to, grantId)}`, expiresInMs: GRANT_TTL_MS }
}

/** Check a grant presented to `self` by Engine `from`. Throws GrantError (issuerEngineId = self). */
export const checkGrant = (grant: unknown, self: string, from: string, now: number = monoNow(), dir: string = authFolder()): ParsedGrant => {
    const p = parseGrant(grant)
    if (!p || p.issuer !== self) throw new GrantError('GRANT_INVALID', 'This permission was not issued by this Engine.', self)
    const want = Buffer.from(grantMac(commandKey(dir), p.issuer, p.to, p.grantId))
    if (!crypto.timingSafeEqual(want, Buffer.from(p.mac))) throw new GrantError('GRANT_INVALID', 'This permission is not valid.', self)
    if (p.to !== from) throw new GrantError('GRANT_INVALID', `This permission is for Engine ${p.to}, not ${from}.`, self)
    const g = issued.get(p.grantId)
    if (!g || g.expiresAt <= now) {
        if (g) issued.delete(p.grantId)
        throw new GrantError('GRANT_EXPIRED', 'This permission expired (or this Engine restarted). Start again.', self)
    }
    return p
}

/** Is `command` one a peer may queue with a grant? */
export const isPeerFollowUp = (command: string): boolean => PEER_FOLLOW_UP_COMMANDS.includes(String(command).trim().split(/\s+/)[0])

// ── grants this Engine received ─────────────────────────────────────────────
interface Received { grant: string, expiresAt: number }
const received = new Map<string, Received>()

/** Keep a grant issued by `issuer` for this Engine (from the Console or a peer's reply grant). */
export const rememberGrant = (grant: string, self: string, now: number = monoNow()): ParsedGrant => {
    const p = parseGrant(grant)
    if (!p) throw new GrantError('GRANT_INVALID', 'Malformed permission.', 'unknown')
    if (p.to !== self) throw new GrantError('GRANT_INVALID', `This permission is for Engine ${p.to}, not this Engine.`, p.issuer)
    received.set(p.issuer, { grant, expiresAt: now + GRANT_TTL_MS })
    return p
}

/** A grant from `issuer` this Engine can still use, or null. */
export const grantFrom = (issuer: string, now: number = monoNow()): string | null => {
    const r = received.get(issuer)
    if (!r) return null
    if (r.expiresAt <= now) { received.delete(issuer); return null }
    return r.grant
}

/** Drop a received grant the issuer refused. */
export const forgetGrant = (issuer: string): void => { received.delete(issuer) }

/** Tests only. */
export const clearGrantsForTests = (): void => { issued.clear(); received.clear() }
