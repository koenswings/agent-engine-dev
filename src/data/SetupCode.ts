/**
 * SetupCode.ts — one-time setup code for an Engine without operators (engine#582).
 *
 * When operators.json has no operators (and there was nothing to import), the
 * Engine makes a code of 8 Crockford base32 characters, shown as XXXX-XXXX:
 *   - in the Engine log at start and every 10 minutes while setup is open,
 *   - on the Pi console (/dev/tty1), best effort,
 *   - in <authFolder>/setup-code.txt (0600), for Ops over SSH.
 * POST /api/auth/setup with the code creates the first operator. The code is
 * single-use, expires after 24 h of Engine uptime (monotonic clock), and a restart
 * makes a new one. After 5 wrong codes, setup is locked for 15 minutes.
 * The code is generated at runtime and never stored in the shared store.
 */

import crypto from 'crypto'
import fs from 'fs'
import { authFile, writeAuthFileAtomic } from './AuthFolder.js'
import { authFolder } from './Config.js'
import { monoNow } from '../utils/monoClock.js'
import { log } from '../utils/utils.js'
import { listOperators } from './Operators.js'

export const SETUP_CODE_FILE = 'setup-code.txt'
export const SETUP_CODE_TTL_MS = 24 * 60 * 60_000
export const SETUP_LOG_EVERY_MS = 10 * 60_000
export const SETUP_MAX_WRONG = 5
export const SETUP_LOCK_MS = 15 * 60_000

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

interface State { code: string, expiresAt: number, wrong: number, lockedUntil: number, timer: NodeJS.Timeout | null, dir: string }
let state: State | null = null

export const newSetupCode = (): string => {
    let s = ''
    for (const b of crypto.randomBytes(8)) s += CROCKFORD[b & 31]
    return `${s.slice(0, 4)}-${s.slice(4)}`
}

/** Normalise what an operator typed: upper case, no dashes/spaces, Crockford look-alikes mapped. */
export const normaliseSetupCode = (s: unknown): string =>
    String(s ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')

const announce = (code: string, dir: string): void => {
    log(`[auth] This Engine has no operator yet. Setup code: ${code} (also in ${authFile(SETUP_CODE_FILE, dir)})`)
}

/** Open setup with a fresh code. `tty` writes it to the Pi console (not in tests). */
export const openSetup = (opts: { dir?: string, now?: number, tty?: boolean, repeatLog?: boolean } = {}): string => {
    closeSetup()
    const dir = opts.dir ?? authFolder()
    const code = newSetupCode()
    writeAuthFileAtomic(authFile(SETUP_CODE_FILE, dir), code + '\n')
    state = { code, expiresAt: (opts.now ?? monoNow()) + SETUP_CODE_TTL_MS, wrong: 0, lockedUntil: 0, timer: null, dir }
    announce(code, dir)
    if (opts.tty) {
        try { fs.appendFileSync('/dev/tty1', `\r\nIDEA Engine setup code: ${code}\r\n`) } catch { /* no console access */ }
    }
    if (opts.repeatLog !== false) {
        state.timer = setInterval(() => {
            if (!state) return
            if (listOperators(state.dir).length > 0) { closeSetup(); return }   // set by the local CLI meanwhile
            if (monoNow() < state.expiresAt) announce(state.code, state.dir)
        }, SETUP_LOG_EVERY_MS)
        state.timer.unref?.()
    }
    return code
}

/** Close setup: stop the reminder and remove the code file. */
export const closeSetup = (): void => {
    if (!state) return
    if (state.timer) clearInterval(state.timer)
    try { fs.renameSync(authFile(SETUP_CODE_FILE, state.dir), authFile(`${SETUP_CODE_FILE}.used`, state.dir)) } catch { /* gone */ }
    state = null
}

export const setupOpen = (): boolean => state !== null

export type SetupCheck = { ok: true } | { ok: false, code: 'SETUP_CODE_INVALID' | 'SETUP_LOCKED', retryAfterMs?: number }

/** Check a typed code. A correct code closes setup (single use). */
export const useSetupCode = (typed: unknown, now: number = monoNow()): SetupCheck => {
    if (!state) return { ok: false, code: 'SETUP_CODE_INVALID' }
    if (state.lockedUntil > now) return { ok: false, code: 'SETUP_LOCKED', retryAfterMs: state.lockedUntil - now }
    if (now >= state.expiresAt) return { ok: false, code: 'SETUP_CODE_INVALID' }
    const want = Buffer.from(normaliseSetupCode(state.code))
    const got = Buffer.from(normaliseSetupCode(typed).padEnd(want.length, '#').slice(0, 64))
    if (got.length === want.length && crypto.timingSafeEqual(want, got)) {
        closeSetup()
        return { ok: true }
    }
    state.wrong++
    if (state.wrong >= SETUP_MAX_WRONG) { state.wrong = 0; state.lockedUntil = now + SETUP_LOCK_MS }
    return { ok: false, code: 'SETUP_CODE_INVALID' }
}

/** Tests only. */
export const currentSetupCodeForTests = (): string | null => state?.code ?? null
