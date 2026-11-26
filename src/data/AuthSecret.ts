/**
 * AuthSecret.ts — per-Engine random secret for sign-in helpers (engine#582).
 *
 * 32 random bytes in <authFolder>/auth-secret (0600), created on first use and never
 * synced or logged. Used to derive the stable fake bcrypt salt for unknown usernames
 * (LoginChallenge.ts). Not the command key (that one signs queue entries).
 */

import crypto from 'crypto'
import fs from 'fs'
import { authFile, writeAuthFileAtomic } from './AuthFolder.js'
import { authFolder } from './Config.js'

export const AUTH_SECRET_FILE = 'auth-secret'

const cache = new Map<string, Buffer>()

/** The secret of the auth folder `dir`, created when missing. */
export const authSecret = (dir: string = authFolder()): Buffer => {
    const hit = cache.get(dir)
    if (hit) return hit
    const file = authFile(AUTH_SECRET_FILE, dir)
    let buf: Buffer | null = null
    try {
        const b = fs.readFileSync(file)
        if (b.length === 32) buf = b
    } catch { /* missing */ }
    if (!buf) {
        buf = crypto.randomBytes(32)
        writeAuthFileAtomic(file, buf)
    }
    cache.set(dir, buf)
    return buf
}

/** Tests only. */
export const clearAuthSecretCacheForTests = (): void => cache.clear()
