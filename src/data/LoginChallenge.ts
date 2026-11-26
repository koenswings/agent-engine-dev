/**
 * LoginChallenge.ts — challenge sign-in (engine#582).
 *
 *   1. challenge(username) → { challengeId, salt, nonce, expiresInMs: 60000 }
 *      salt = the 29-character bcrypt salt prefix of the operator's hash; for an
 *      unknown username a stable fake salt in the same format and cost.
 *   2. The Console computes h = bcrypt(password, salt) and
 *      proof = hex(HMAC-SHA256(utf8(h), "idea-login-v1|" + engineId + "|" + challengeId + "|" + nonce)).
 *   3. verifyProof recomputes it with the stored hash, compares in constant time,
 *      and uses the challenge up (single-use, whatever the outcome).
 *
 * The password never reaches the Engine; a proof only works for one Engine and one
 * challenge. The Engine runs no bcrypt here.
 */

import crypto from 'crypto'
import { authSecret } from './AuthSecret.js'
import { costOf, findOperatorByUsername, listOperators, saltOf, OperatorRecord } from './Operators.js'
import { monoNow } from '../utils/monoClock.js'

export const CHALLENGE_TTL_MS = 60_000
const MAX_CHALLENGES = 1000

const BCRYPT_B64 = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** bcrypt's own base64 of 16 bytes: 22 characters (as in bcrypt's encode_base64). */
export const bcryptBase64 = (b: Buffer): string => {
    let out = ''
    let off = 0
    const len = 16
    while (off < len) {
        let c1 = b[off++] & 0xff
        out += BCRYPT_B64[(c1 >> 2) & 0x3f]
        c1 = (c1 & 0x03) << 4
        if (off >= len) { out += BCRYPT_B64[c1 & 0x3f]; break }
        let c2 = b[off++] & 0xff
        c1 |= (c2 >> 4) & 0x0f
        out += BCRYPT_B64[c1 & 0x3f]
        c1 = (c2 & 0x0f) << 2
        if (off >= len) { out += BCRYPT_B64[c1 & 0x3f]; break }
        c2 = b[off++] & 0xff
        c1 |= (c2 >> 6) & 0x03
        out += BCRYPT_B64[c1 & 0x3f]
        out += BCRYPT_B64[c2 & 0x3f]
    }
    return out
}

/** Cost for fake salts: that of the most recently created operator hash, default 10. */
const fakeCost = (dir?: string): number => {
    const ops = listOperators(dir)
    if (!ops.length) return 10
    const newest = [...ops].sort((a, b) => b.created - a.created)[0]
    const c = costOf(newest.passwordHash)
    return Number.isFinite(c) && c >= 4 && c <= 31 ? c : 10
}

/** Stable fake salt for `username`: same $2b$ format and cost as real hashes. */
export const fakeSalt = (username: string, dir?: string): string => {
    const mac = crypto.createHmac('sha256', authSecret(dir)).update(`idea-fake-salt-v1|${username}`).digest()
    return `$2b$${String(fakeCost(dir)).padStart(2, '0')}$${bcryptBase64(mac.subarray(0, 16))}`
}

/** The proof the Console sends (exported for tests and the reference vector). */
export const loginProof = (bcryptHash: string, engineId: string, challengeId: string, nonce: string): string =>
    crypto.createHmac('sha256', Buffer.from(bcryptHash, 'utf8')).update(`idea-login-v1|${engineId}|${challengeId}|${nonce}`).digest('hex')

interface Pending { username: string, nonce: string, expiresAt: number }
const pending = new Map<string, Pending>()

export interface Challenge { challengeId: string, salt: string, nonce: string, expiresInMs: number }

export const createChallenge = (username: string, dir?: string, now: number = monoNow()): Challenge => {
    for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id)
    if (pending.size >= MAX_CHALLENGES) pending.delete(pending.keys().next().value as string)
    const op = findOperatorByUsername(username, dir)
    const challengeId = crypto.randomBytes(16).toString('base64url')
    const nonce = crypto.randomBytes(16).toString('base64url')
    pending.set(challengeId, { username, nonce, expiresAt: now + CHALLENGE_TTL_MS })
    return { challengeId, salt: op ? saltOf(op.passwordHash) : fakeSalt(username, dir), nonce, expiresInMs: CHALLENGE_TTL_MS }
}

/**
 * Check a proof and use the challenge up. Returns the operator, or null for any
 * failure (unknown/expired challenge, other username, unknown user, wrong proof).
 */
export const verifyProof = (
    challengeId: string, username: string, proof: string, engineId: string, dir?: string, now: number = monoNow(),
): OperatorRecord | null => {
    const p = pending.get(String(challengeId))
    pending.delete(String(challengeId))
    if (!p || p.expiresAt <= now || p.username !== username) return null
    const op = findOperatorByUsername(username, dir)
    if (!op) return null
    const want = Buffer.from(loginProof(op.passwordHash, engineId, String(challengeId), p.nonce), 'hex')
    const got = /^[0-9a-f]{64}$/.test(String(proof)) ? Buffer.from(String(proof), 'hex') : Buffer.alloc(32)
    return crypto.timingSafeEqual(want, got) ? op : null
}

/** Tests only. */
export const clearChallengesForTests = (): void => pending.clear()
