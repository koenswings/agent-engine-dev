/**
 * backupArchiveName.ts — Borg archive names of backupInstance (engine#401)
 *
 * `<ISO timestamp with : and . replaced by ->` (before engine#401, untagged) or
 * `<timestamp>-<mode>` where mode is how the archive was taken:
 *   hook  the preHook steps succeeded; borg ran while the App kept running
 *   stop  the App was stopped for the copy (method stop, a HOOK_FALLBACK, or the
 *         pre-update backup inside updateApp's Snapshot stop)
 *   cold  method hook, but the instance was not running: hooks skipped, no stop
 * `borg list` then shows the mode without reading any files. Tagged names need
 * app-data helper v16 (ARCHIVE_MODE_HELPER_MIN); with an older helper the Engine
 * still writes untagged names.
 */

export type ArchiveMode = 'hook' | 'stop' | 'cold'
export const ARCHIVE_MODES: readonly ArchiveMode[] = ['hook', 'stop', 'cold']

const ARCHIVE_NAME_RE = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]{8,16}Z)(?:-(hook|stop|cold))?$/

/** The archive name for a backup taken at `at` in `mode`; untagged when mode is null. */
export const backupArchiveName = (at: Date, mode: ArchiveMode | null): string => {
    const stamp = at.toISOString().replace(/[:.]/g, '-')
    return mode ? `${stamp}-${mode}` : stamp
}

/**
 * Split an archive name into its timestamp part and mode. Untagged (older) names
 * have mode null. A name that is not an Engine archive name returns
 * { timestamp: name, mode: null } so callers never refuse it.
 */
export const parseArchiveName = (name: string): { timestamp: string, mode: ArchiveMode | null } => {
    const m = ARCHIVE_NAME_RE.exec(name)
    if (!m) return { timestamp: name, mode: null }
    return { timestamp: m[1], mode: (m[2] as ArchiveMode | undefined) ?? null }
}
