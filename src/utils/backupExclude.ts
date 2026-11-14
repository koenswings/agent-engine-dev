/**
 * backupExclude.ts — parse and validate x-app.backup.exclude (idea#443)
 *
 * Paths are relative to the instance folder (the borg source). A path with no
 * slash, other than `data` itself, is treated as `data/<name>`, so the
 * usage-dashboard list (`keys`, `tailscale`, `tailscale-run`) excludes
 * `./data/keys` and friends rather than a top-level `keys` folder. A path that
 * already contains a slash (for example `data/backup/daily`) is instance-relative
 * and is not auto-prefixed; multi-segment directory paths are allowed and become
 * borg path-prefix excludes (the directory and everything under it).
 *
 * `hookExclude` (idea#444) uses the same path rules. It is applied only when a
 * preHook succeeded (live files the dump replaces). On HOOK_FALLBACK / method
 * `stop` it is dropped so the now-stopped live files are packed. `exclude` is
 * always applied (secrets and other never-packed paths).
 *
 * The helper re-validates the same rules. The Engine must not call borg-create
 * with a non-empty list unless idea-app-data is at least BACKUP_EXCLUDE_HELPER_MIN
 * (fail-closed: HELPER_OUTDATED, no silent packing of secrets).
 */

/** Helper protocol that honours trailing borg-create exclude arguments. */
export const BACKUP_EXCLUDE_HELPER_MIN = 8

/** Relative path token after normalisation: no slash-dot, no glob, no option dash. */
const EXCLUDE_TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/

export const backupExcludeError = (raw: string, why: string, field = 'exclude'): Error =>
    new Error(`x-app.backup.${field} entry '${raw}' is not allowed: ${why}`)

/**
 * Normalise one declared exclude path to an instance-relative path
 * (`data/keys`). Throws if the path could escape the instance folder or
 * be passed through as a borg option or glob.
 */
export const normalizeBackupExclude = (raw: unknown, field = 'exclude'): string => {
    if (typeof raw !== 'string') {
        throw new Error(`x-app.backup.${field} entries must be strings`)
    }
    if (raw.includes('\0')) throw backupExcludeError(raw, 'contains a NUL', field)
    let p = raw.trim()
    if (!p) throw backupExcludeError(raw, 'empty', field)
    if (p.startsWith('-')) throw backupExcludeError(raw, 'looks like an option', field)
    if (p.startsWith('/')) throw backupExcludeError(raw, 'absolute paths are not allowed', field)
    while (p.startsWith('./')) p = p.slice(2)
    p = p.replace(/\/+$/, '')
    if (!p) throw backupExcludeError(raw, 'empty', field)
    if (p.includes('//')) throw backupExcludeError(raw, "contains '//'", field)
    const parts = p.split('/')
    if (parts.some(c => c === '' || c === '.' || c === '..')) {
        throw backupExcludeError(raw, "has a '.' or '..' component", field)
    }
    if (/[*?[\]]/.test(p)) throw backupExcludeError(raw, 'globs are not allowed', field)
    if (!EXCLUDE_TOKEN.test(p)) throw backupExcludeError(raw, 'unsupported characters', field)
    if (!p.includes('/') && p !== 'data' && !p.startsWith('.')) p = `data/${p}`
    if (p.split('/').some(c => c === '..')) throw backupExcludeError(raw, "has a '..' component", field)
    return p
}

/**
 * Read `x-app.backup.exclude` from a parsed compose `x-app` object.
 * Missing or empty → `[]`. A present but malformed list throws (fail closed).
 * Duplicates (after normalisation) are dropped, first occurrence kept.
 */
const backupMapping = (xapp: unknown): Record<string, unknown> | null => {
    if (xapp === undefined || xapp === null) return null
    if (typeof xapp !== 'object' || Array.isArray(xapp)) {
        throw new Error('x-app is not a mapping')
    }
    const backup = (xapp as { backup?: unknown }).backup
    if (backup === undefined || backup === null) return null
    if (typeof backup !== 'object' || Array.isArray(backup)) {
        throw new Error('x-app.backup is not a mapping')
    }
    return backup as Record<string, unknown>
}

const parsePathListField = (xapp: unknown, field: 'exclude' | 'hookExclude'): string[] => {
    const backup = backupMapping(xapp)
    if (!backup) return []
    const ex = backup[field]
    if (ex === undefined || ex === null) return []
    if (!Array.isArray(ex)) throw new Error(`x-app.backup.${field} must be a list of paths`)
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of ex) {
        const n = normalizeBackupExclude(item, field)
        if (!seen.has(n)) {
            seen.add(n)
            out.push(n)
        }
    }
    return out
}

/** Read `x-app.backup.exclude` (always applied). Missing or empty → `[]`. */
export const parseBackupExcludeList = (xapp: unknown): string[] =>
    parsePathListField(xapp, 'exclude')

/**
 * Read `x-app.backup.hookExclude` (idea#444): live files the hook dump replaces.
 * Applied only after a successful preHook. Missing or empty → `[]`.
 */
export const parseBackupHookExcludeList = (xapp: unknown): string[] =>
    parsePathListField(xapp, 'hookExclude')

/** Concatenate exclude lists, dropping later duplicates. */
export const mergeBackupExcludeLists = (...lists: string[][]): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const list of lists) {
        for (const item of list) {
            if (!seen.has(item)) {
                seen.add(item)
                out.push(item)
            }
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

/**
 * Read optional `x-app.backup.verify.present` / `verify.absent` (idea#446).
 * Same path rules as `exclude`. Missing verify block or missing lists → empty.
 * A present but malformed list or a non-mapping `verify` throws (fail closed).
 */
export const parseBackupVerifyLists = (xapp: unknown): { present: string[]; absent: string[] } => {
    const backup = backupMapping(xapp)
    if (!backup) return { present: [], absent: [] }
    const raw = backup.verify
    if (raw === undefined || raw === null) return { present: [], absent: [] }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('x-app.backup.verify is not a mapping')
    }
    const v = raw as Record<string, unknown>
    const parse = (field: 'present' | 'absent'): string[] => {
        const ex = v[field]
        if (ex === undefined || ex === null) return []
        if (!Array.isArray(ex)) throw new Error(`x-app.backup.verify.${field} must be a list of paths`)
        const out: string[] = []
        const seen = new Set<string>()
        for (const item of ex) {
            const n = normalizeBackupExclude(item, `verify.${field}`)
            if (!seen.has(n)) {
                seen.add(n)
                out.push(n)
            }
        }
        return out
    }
    return { present: parse('present'), absent: parse('absent') }
}



// ── idea#396: snapshot / estimate excludes (helper v14) ──────────────────────

/** Helper v14: at most this many snapshot/estimate excludes after de-duplication. */
export const SNAPSHOT_EXCLUDE_MAX = 32
/** Helper v14: at most this many characters per token after trimming. */
export const SNAPSHOT_EXCLUDE_MAX_LEN = 256

export const snapshotExcludeError = (raw: string, why: string, source = 'exclude'): Error =>
    new Error(`${raw}: ${why}`)

/** True when a normalised token is legal for helper v14 snapshot / estimate. */
export const isSnapshotExcludePath = (rel: string): boolean =>
    rel === 'data' || rel.startsWith('data/')

/**
 * Validate one raw token for snapshot / estimate: trim-length, v8 normalisation,
 * and `data` / `data/<rel>` only. Does not follow symlinks (the helper does that
 * at call time). Throws with an INVALID_EXCLUDE: prefix.
 */
export const normalizeSnapshotExclude = (raw: unknown, source = 'exclude'): string => {
    if (typeof raw !== 'string') throw new Error(`${source} entries must be strings`)
    const trimmed = raw.trim()
    if (trimmed.length > SNAPSHOT_EXCLUDE_MAX_LEN) {
        throw snapshotExcludeError(trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed, `longer than ${SNAPSHOT_EXCLUDE_MAX_LEN} characters`, source)
    }
    let rel: string
    try {
        rel = normalizeBackupExclude(raw, 'exclude')
    } catch (e) {
        const msg = (e as Error).message.replace(/^x-app\.backup\.exclude entry '.*?' is not allowed: /, '')
        throw snapshotExcludeError(String(raw), msg.replace(/^x-app\.backup\.exclude entries must be strings$/, 'must be a string'), source)
    }
    if (!isSnapshotExcludePath(rel)) {
        throw snapshotExcludeError(String(raw), 'must be data or a path under data/', source)
    }
    return rel
}

/**
 * Normalise, de-duplicate (first occurrence kept) and bound a list of snapshot /
 * estimate exclude tokens. Throws INVALID_EXCLUDE when any token is illegal or
 * the list has more than SNAPSHOT_EXCLUDE_MAX unique entries.
 */
export const parseSnapshotExcludeTokens = (tokens: unknown[], source = 'exclude'): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of tokens) {
        const n = normalizeSnapshotExclude(item, source)
        if (seen.has(n)) continue
        seen.add(n)
        out.push(n)
        if (out.length > SNAPSHOT_EXCLUDE_MAX) {
            throw snapshotExcludeError(String(item), `list has more than ${SNAPSHOT_EXCLUDE_MAX} entries`, source)
        }
    }
    return out
}

/**
 * Read top-level `x-app.snapshotExclude` (idea#396). Missing or empty → `[]`.
 * A present but malformed list throws (fail closed). Independent of
 * `x-app.backup.exclude`; Borg path rules are unchanged.
 */
export const parseSnapshotExcludeList = (xapp: unknown): string[] => {
    if (xapp === undefined || xapp === null) return []
    if (typeof xapp !== 'object' || Array.isArray(xapp)) {
        throw new Error('x-app is not a mapping')
    }
    const ex = (xapp as { snapshotExclude?: unknown }).snapshotExclude
    if (ex === undefined || ex === null) return []
    if (!Array.isArray(ex)) throw new Error('x-app.snapshotExclude must be a list of paths')
    return parseSnapshotExcludeTokens(ex, 'x-app.snapshotExclude')
}

/**
 * Re-check an already-normalised list against v14 snapshot rules (data / data/…,
 * at most 32 unique entries). Used after merging live.backup.exclude ∪
 * new.backup.exclude ∪ live.snapshotExclude, because backup.exclude may still
 * contain Borg-legal paths that v14 snapshot / estimate refuse.
 */
export const assertSnapshotExcludeList = (tokens: string[], source = 'exclude'): string[] =>
    parseSnapshotExcludeTokens(tokens, source)
