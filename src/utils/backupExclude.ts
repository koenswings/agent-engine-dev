/**
 * backupExclude.ts — parse and validate x-app.backup.exclude (idea#443)
 *
 * Paths are relative to the instance folder (the borg source). A path with no
 * slash, other than `data` itself, is treated as `data/<name>`, so the
 * usage-dashboard list (`keys`, `tailscale`, `tailscale-run`) excludes
 * `./data/keys` and friends rather than a top-level `keys` folder.
 *
 * The helper re-validates the same rules. The Engine must not call borg-create
 * with a non-empty list unless idea-app-data is at least BACKUP_EXCLUDE_HELPER_MIN
 * (fail-closed: HELPER_OUTDATED, no silent packing of secrets).
 */

/** Helper protocol that honours trailing borg-create exclude arguments. */
export const BACKUP_EXCLUDE_HELPER_MIN = 8

/** Relative path token after normalisation: no slash-dot, no glob, no option dash. */
const EXCLUDE_TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/

export const backupExcludeError = (raw: string, why: string): Error =>
    new Error(`x-app.backup.exclude entry '${raw}' is not allowed: ${why}`)

/**
 * Normalise one declared exclude path to an instance-relative path
 * (`data/keys`). Throws if the path could escape the instance folder or
 * be passed through as a borg option or glob.
 */
export const normalizeBackupExclude = (raw: unknown): string => {
    if (typeof raw !== 'string') {
        throw new Error('x-app.backup.exclude entries must be strings')
    }
    if (raw.includes('\0')) throw backupExcludeError(raw, 'contains a NUL')
    let p = raw.trim()
    if (!p) throw backupExcludeError(raw, 'empty')
    if (p.startsWith('-')) throw backupExcludeError(raw, 'looks like an option')
    if (p.startsWith('/')) throw backupExcludeError(raw, 'absolute paths are not allowed')
    while (p.startsWith('./')) p = p.slice(2)
    p = p.replace(/\/+$/, '')
    if (!p) throw backupExcludeError(raw, 'empty')
    if (p.includes('//')) throw backupExcludeError(raw, "contains '//'")
    const parts = p.split('/')
    if (parts.some(c => c === '' || c === '.' || c === '..')) {
        throw backupExcludeError(raw, "has a '.' or '..' component")
    }
    if (/[*?[\]]/.test(p)) throw backupExcludeError(raw, 'globs are not allowed')
    if (!EXCLUDE_TOKEN.test(p)) throw backupExcludeError(raw, 'unsupported characters')
    if (!p.includes('/') && p !== 'data' && !p.startsWith('.')) p = `data/${p}`
    if (p.split('/').some(c => c === '..')) throw backupExcludeError(raw, "has a '..' component")
    return p
}

/**
 * Read `x-app.backup.exclude` from a parsed compose `x-app` object.
 * Missing or empty → `[]`. A present but malformed list throws (fail closed).
 * Duplicates (after normalisation) are dropped, first occurrence kept.
 */
export const parseBackupExcludeList = (xapp: unknown): string[] => {
    if (xapp === undefined || xapp === null) return []
    if (typeof xapp !== 'object' || Array.isArray(xapp)) {
        throw new Error('x-app is not a mapping')
    }
    const backup = (xapp as { backup?: unknown }).backup
    if (backup === undefined || backup === null) return []
    if (typeof backup !== 'object' || Array.isArray(backup)) {
        throw new Error('x-app.backup is not a mapping')
    }
    const ex = (backup as { exclude?: unknown }).exclude
    if (ex === undefined || ex === null) return []
    if (!Array.isArray(ex)) throw new Error('x-app.backup.exclude must be a list of paths')
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of ex) {
        const n = normalizeBackupExclude(item)
        if (!seen.has(n)) {
            seen.add(n)
            out.push(n)
        }
    }
    return out
}

/** True when `rel` (already normalised) stays lexically inside the instance root. */
export const excludeStaysInside = (instanceRoot: string, rel: string): boolean => {
    const root = instanceRoot.replace(/\/+$/, '') || '/'
    const joined = root === '/' ? `/${rel}` : `${root}/${rel}`
    // Lexical resolve of . / .. already refused; this is a prefix guard.
    return joined === root || joined.startsWith(`${root}/`)
}
