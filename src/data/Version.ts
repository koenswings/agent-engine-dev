/**
 * Version.ts — the one rule for reading and ordering App versions (koenswings/idea#76).
 *
 * A version is a proper tag when it reads as `<major>.<minor>[.<patch>]`, optionally with a
 * `v` prefix and a suffix (`1.0-smoke`, `1.1-0.19.5`), or tool output such as
 * `kolibri, version 0.19.5`. Anything else is UNVERSIONED:
 *  - no number at all (`main`, '')
 *  - SHA-shaped: a 7-40 char hex token with a letter, optionally `g`-prefixed (`git describe`),
 *    or an all-digit token of 7+ chars (a SHA that happens to be digits)
 *  - date-shaped: `YYYY-MM-DD` / `YYYY.MM.DD` anywhere (`zimbabwe-2026-10-20`), or a leading
 *    numeric component >= 1000
 * An unversioned version is a non-release that sorts as 0.0: it is never offered as an update
 * target, and an instance on one is upgradable to any proper tag above 0.0, so kit Engines
 * built from a SHA (Kolibri 5ab9f64…, Nextcloud b8ad438…, agent-app-dev#36) are offered releases.
 * Dev bundles `0.0-dev+<sha12>` are unversioned too (the SHA token), so never offered.
 */

const DATE_RE = /(^|[^0-9])\d{4}[-._]\d{1,2}[-._]\d{1,2}([^0-9]|$)/
const SHA_TOKEN_RE = /^g?[0-9a-f]{7,40}$/i

/** True when `raw` is not a proper version tag (see file header). */
export const isUnversioned = (raw: string | null | undefined): boolean => {
    const s = String(raw ?? '').trim()
    const m = s.match(/(\d+(?:\.\d+)*)/)
    if (!m) return true
    if (DATE_RE.test(s)) return true
    for (const tok of s.split(/[^0-9A-Za-z]+/)) {
        if (!tok) continue
        if (SHA_TOKEN_RE.test(tok) && /[a-f]/i.test(tok.replace(/^g/i, ''))) return true
        if (/^\d{7,}$/.test(tok)) return true
    }
    return Number(m[1].split('.')[0]) >= 1000
}

/** Numeric version parts of a proper tag; null when the version is unversioned. */
export const parseVersion = (raw: string | null | undefined): number[] | null => {
    if (isUnversioned(raw)) return null
    const m = String(raw ?? '').match(/(\d+(?:\.\d+)*)/)!
    return m[1].split('.').map(n => Number(n))
}

/** <0, 0, >0 like a comparator between two proper tags; null when either side is unversioned. */
export const compareVersions = (a: string, b: string): number | null => {
    const x = parseVersion(a), y = parseVersion(b)
    if (!x || !y) return null
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0)
        if (d !== 0) return d
    }
    return 0
}

/**
 * True when `to` is a valid update target for an instance on `from`: `to` must be a proper tag,
 * newer than `from`, where an unversioned `from` sorts as 0.0.
 */
export const isUpgrade = (from: string, to: string): boolean => {
    if (!parseVersion(to)) return false
    const c = compareVersions(to, isUnversioned(from) ? '0.0' : from)
    return c !== null && c > 0
}

/** True when from -> to crosses a major version. Unversioned -> a proper tag is always major (idea#76): --allow-major and a fresh backup. */
export const isMajorChange = (from: string, to: string): boolean => {
    const x = parseVersion(from), y = parseVersion(to)
    if (!y) return false
    if (!x) return true
    return (x[0] ?? 0) !== (y[0] ?? 0)
}
