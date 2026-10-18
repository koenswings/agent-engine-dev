/**
 * BackupExclude.ts — content an app keeps out of its backups (agent-engine-dev#241).
 *
 * An app declares, in its compose.yaml:
 *
 *   x-app:
 *     backup:
 *       exclude:
 *         - data/kolibri/content/storage
 *         - data/*.zim
 *
 * Each entry is a path relative to the instance folder (/instances/<id> or
 * /disks/<dev>/instances/<id>), with borg shell-pattern globs (`*` within one path
 * segment, `**` across segments). backupInstance reads the list from the INSTANCE's
 * compose.yaml at backup time, checks every entry here and passes each one to the
 * root helper as `--exclude <rel>` (borgCreateArgs). The helper checks them again
 * (same rules) and turns each into borg `--exclude sh:<SRC>/<rel>`.
 *
 * Rules (the helper's RE_EXCLUDE and checks are the same): a string of 1 to
 * BACKUP_EXCLUDE_MAX_LEN characters from [A-Za-z0-9._*\/-]; not starting with '/' or
 * '-'; no empty, '.' or '..' segment; at most BACKUP_EXCLUDE_MAX entries. One bad
 * entry refuses the backup (nothing is silently dropped). No list: today's backup.
 *
 * Restore brings back what was backed up, so excluded content is NOT restored:
 * Kolibri then needs its channel content re-imported, Kiwix needs its ZIM put back.
 */
import { fs, YAML } from 'zx'

export const BACKUP_EXCLUDE_MAX = 32
export const BACKUP_EXCLUDE_MAX_LEN = 200
const EXCLUDE_CHARS = /^[A-Za-z0-9._*/-]+$/

/** Why one entry is not acceptable, or null when it is. */
export const backupExcludeProblem = (entry: unknown): string | null => {
    if (typeof entry !== 'string') return `entry ${JSON.stringify(entry)} is not a string`
    if (entry.length === 0) return 'an entry is empty'
    if (entry.length > BACKUP_EXCLUDE_MAX_LEN) return `entry '${entry.slice(0, 40)}…' is longer than ${BACKUP_EXCLUDE_MAX_LEN} characters`
    if (!EXCLUDE_CHARS.test(entry)) return `entry '${entry}' holds a character outside [A-Za-z0-9._*/-]`
    if (entry.startsWith('/')) return `entry '${entry}' is absolute; it must be relative to the instance folder`
    if (entry.startsWith('-')) return `entry '${entry}' starts with '-'`
    for (const seg of entry.split('/')) {
        if (seg === '') return `entry '${entry}' has an empty path segment (// or a trailing /)`
        if (seg === '.' || seg === '..') return `entry '${entry}' has a '${seg}' segment`
    }
    return null
}

/**
 * Check an x-app.backup.exclude value. Returns the list (possibly empty) or throws
 * one Error naming every bad entry. undefined/null mean "no list".
 */
export const validateBackupExclude = (raw: unknown): string[] => {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) throw new Error('x-app.backup.exclude must be a list of paths relative to the instance folder')
    if (raw.length > BACKUP_EXCLUDE_MAX) throw new Error(`x-app.backup.exclude has ${raw.length} entries; at most ${BACKUP_EXCLUDE_MAX} are allowed`)
    const problems = raw.map(backupExcludeProblem).filter((p): p is string => p !== null)
    if (problems.length) throw new Error(`x-app.backup.exclude is invalid: ${problems.join('; ')}`)
    return [...new Set(raw as string[])]
}

/** The list from a parsed compose document (its x-app.backup.exclude). Throws when invalid. */
export const backupExcludeOfCompose = (compose: any): string[] => {
    const backup = compose?.['x-app']?.backup
    if (backup === undefined || backup === null) return []
    if (typeof backup !== 'object' || Array.isArray(backup)) throw new Error('x-app.backup must be a mapping')
    return validateBackupExclude(backup.exclude)
}

/**
 * Read the list from an instance's compose.yaml. A missing compose.yaml means no list
 * (the backup then fails or succeeds as before); an unreadable or invalid one throws.
 */
export const readBackupExclude = async (composePath: string): Promise<string[]> => {
    if (!(await fs.pathExists(composePath))) return []
    let doc: any
    try {
        doc = YAML.parse(await fs.readFile(composePath, 'utf8'))
    } catch (e) {
        throw new Error(`could not read x-app.backup.exclude from ${composePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
        return backupExcludeOfCompose(doc)
    } catch (e) {
        throw new Error(`${composePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
}
