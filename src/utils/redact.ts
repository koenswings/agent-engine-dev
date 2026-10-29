/**
 * Redaction of operator password hashes from every dump/log path (idea#113 option b).
 *
 * The hashes stay in the synced store unchanged (Console logins verify against them);
 * this only changes what the Engine prints or records in logs/traces.
 */

export const REDACTED = '<redacted>'

/** Keys whose values are always secrets, wherever they appear. */
const SECRET_KEYS = new Set(['passwordHash'])

/** bcrypt hash: $2a$/$2b$/$2x$/$2y$, cost, 53 chars of salt+hash. Also catches truncated/odd forms. */
const BCRYPT_RE = /\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{0,53}/g

/** Replace any bcrypt hash inside a string with "<redacted>". */
export const redactString = (s: string): string =>
    s.includes('$2') ? s.replace(BCRYPT_RE, REDACTED) : s

/**
 * Return a redacted copy of `value`: every `passwordHash` field becomes "<redacted>" and any
 * bcrypt-looking string is replaced. All other fields are kept. Never mutates the input
 * (safe on Automerge docs). Cycles are preserved.
 */
export const redactSecrets = <T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T => {
    if (typeof value === 'string') return redactString(value) as unknown as T
    if (value === null || typeof value !== 'object') return value
    if (value instanceof Date || value instanceof Uint8Array || value instanceof RegExp) return value
    if (seen.has(value as object)) return seen.get(value as object) as T
    if (Array.isArray(value)) {
        const out: unknown[] = []
        seen.set(value, out)
        for (const v of value) out.push(redactSecrets(v, seen))
        return out as unknown as T
    }
    if (value instanceof Map) {
        const out = new Map()
        seen.set(value, out)
        for (const [k, v] of value) out.set(k, SECRET_KEYS.has(String(k)) ? REDACTED : redactSecrets(v, seen))
        return out as unknown as T
    }
    if (value instanceof Error) {
        const e = new (value.constructor as ErrorConstructor)(redactString(value.message))
        e.stack = value.stack ? redactString(value.stack) : value.stack
        seen.set(value, e)
        for (const k of Object.keys(value)) (e as any)[k] = SECRET_KEYS.has(k) ? REDACTED : redactSecrets((value as any)[k], seen)
        return e as unknown as T
    }
    const out: Record<string, unknown> = {}
    seen.set(value as object, out)
    for (const k of Object.keys(value as object)) {
        out[k] = SECRET_KEYS.has(k) ? REDACTED : redactSecrets((value as any)[k], seen)
    }
    return out as T
}

/** JSON.stringify with redaction applied. */
export const redactedJson = (value: unknown, space?: number): string =>
    JSON.stringify(redactSecrets(value), null, space)
