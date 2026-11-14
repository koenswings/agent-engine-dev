/**
 * setBackupMode <diskIdOrName> <immediate|on-demand|scheduled> [HH:MM] (idea#400 PR D).
 *
 * Switches a docked Backup Disk between backup modes and sets the daily time of a
 * scheduled disk. Runs on the Engine the disk is docked to (like addBackupLink).
 * BACKUP.yaml is edited as a document (BackupYamlDoc writer, atomic): only `mode`
 * and `schedule` change, so links, lastBackup values, lastRun, the uptime counter,
 * comments and unknown keys stay. The store backupConfig is edited in place.
 *
 * Schedule rules:
 *   - `scheduled HH:MM`         → schedule: { daily: HH:MM }
 *   - `scheduled` (no time)     → keep a valid schedule; none or invalid → 02:30
 *                                 (the same rule as createBackupDisk)
 *   - `immediate` / `on-demand` → the schedule stays in the file (switching back keeps
 *                                 the time); a time argument is refused (BAD_TIME)
 * Refusals are leading tokens (#344 style): NOT_DOCKED, AMBIGUOUS, SYSTEM_DISK,
 * NOT_A_BACKUP_DISK, BAD_BACKUP_YAML, BAD_MODE, BAD_TIME, BUSY. A refusal writes nothing.
 */
import { chalk } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { log, print } from '../utils/utils.js'
import { Store } from './Store.js'
import { setBackupOrphanLinks } from './Disk.js'
import { BackupMode } from './CommonTypes.js'
import { attachTraceResult } from './SummariseDisk.js'
import { resourceLock, diskKey } from '../utils/ResourceLock.js'
import { writeBackupDocumentAtomic } from './BackupYamlDoc.js'
import { resolveBackupLinkDisk, takeDiskLock, readBackupDocument } from './BackupLinks.js'
import {
    BackupSchedule, BackupScheduleError, DEFAULT_BACKUP_TIME, formatDailyTime, parseBackupSchedule, parseDailyTime,
} from '../utils/backupSchedule.js'

export const BACKUP_MODES: readonly BackupMode[] = ['immediate', 'on-demand', 'scheduled']

export type SetBackupModeRefusal =
    | 'NOT_DOCKED' | 'AMBIGUOUS' | 'SYSTEM_DISK' | 'NOT_A_BACKUP_DISK' | 'BAD_BACKUP_YAML'
    | 'BAD_MODE' | 'BAD_TIME' | 'BUSY'

const COMMAND = 'setBackupMode'

const refuse = (code: SetBackupModeRefusal, why: string): Error => new Error(`${code}: ${COMMAND}: ${why}`)

export interface SetBackupModeResult {
    backupDiskId: string
    previousMode: BackupMode
    mode: BackupMode
    /** The schedule in BACKUP.yaml after the change (kept for non-scheduled modes); null when none or invalid. */
    schedule: BackupSchedule | null
    /** The schedule error that is still in the file (only for a non-scheduled mode left with an invalid schedule). */
    scheduleError: string | null
    /** false when BACKUP.yaml already had this mode and schedule (nothing written). */
    changed: boolean
    note: string
}

/** What the next backup will be, for the operator (no promise about the exact minute). */
const noteFor = (mode: BackupMode, schedule: BackupSchedule | null): string => {
    if (mode === 'scheduled') return `daily at ${schedule?.daily ?? DEFAULT_BACKUP_TIME} (Engine local time); a disk that never ran, or that missed its last slot, runs within a minute`
    if (mode === 'immediate') return 'backs up on the next dock'
    return 'backs up only on backupApp'
}

/** Parse the optional time argument. Accepts "H:MM" too and normalises to "HH:MM". */
const parseTimeArg = (raw: string): BackupSchedule => {
    const t = raw.trim()
    const padded = /^[0-9]:[0-5][0-9]$/.test(t) ? `0${t}` : t
    try {
        const { hour, minute } = parseDailyTime(padded)
        return { daily: formatDailyTime(hour, minute) }
    } catch (e: any) {
        throw refuse('BAD_TIME', e instanceof BackupScheduleError ? e.message.replace(/^BAD_TIME: /, '') : String(e?.message ?? e))
    }
}

export const setBackupMode = async (
    storeHandle: DocHandle<Store>,
    diskArg: string,
    modeArg: string,
    timeArg?: string,
): Promise<SetBackupModeResult> => {
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')

    // Argument checks first: they need no disk and write nothing.
    const mode = String(modeArg ?? '').trim() as BackupMode
    if (!BACKUP_MODES.includes(mode)) {
        throw refuse('BAD_MODE', `'${modeArg}' is not a backup mode; use one of ${BACKUP_MODES.join(', ')}`)
    }
    const hasTime = timeArg !== undefined && timeArg !== null && String(timeArg).trim() !== ''
    if (hasTime && mode !== 'scheduled') {
        throw refuse('BAD_TIME', `a time is valid only with 'scheduled' (got '${timeArg}' with '${mode}')`)
    }
    const requested = hasTime ? parseTimeArg(String(timeArg)) : null

    const store = storeHandle.doc()
    const disk = await resolveBackupLinkDisk(store, String(diskArg), COMMAND)

    takeDiskLock(store, disk.id, COMMAND)
    try {
        const parsed = await readBackupDocument(disk.device, COMMAND)
        const previousMode = parsed.mode

        let existing: BackupSchedule | null = null
        let existingError: string | null = null
        try {
            existing = parseBackupSchedule(parsed.doc.toJS()?.schedule)
        } catch (e: any) {
            existingError = String(e?.message ?? e)
        }

        let schedule: BackupSchedule | null = existing
        let scheduleError: string | null = existingError
        if (mode === 'scheduled') {
            schedule = requested ?? existing ?? { daily: DEFAULT_BACKUP_TIME }
            scheduleError = null
        }

        const before = parsed.doc.toString()
        parsed.doc.set('mode', mode)
        if (mode === 'scheduled' && (requested || !existing)) {
            parsed.doc.set('schedule', parsed.doc.createNode(schedule))
        }
        const after = parsed.doc.toString()
        const changed = after !== before
        if (changed) await writeBackupDocumentAtomic(disk.device, after)

        storeHandle.change(doc => {
            const d = doc.diskDB[disk.id]
            if (!d) return
            if (!d.backupConfig) {
                d.backupConfig = { mode, links: [...parsed.ids] as any, schedule: schedule ? { daily: schedule.daily } : null, scheduleError }
            } else {
                if (d.backupConfig.mode !== mode) d.backupConfig.mode = mode
                const daily = schedule?.daily ?? null
                // undefined (a record from before idea#400) counts as different, so both keys are always present after
                if (d.backupConfig.schedule === undefined || (d.backupConfig.schedule?.daily ?? null) !== daily) d.backupConfig.schedule = daily ? { daily } : null
                if (d.backupConfig.scheduleError !== scheduleError) d.backupConfig.scheduleError = scheduleError
            }
            setBackupOrphanLinks(doc, d.backupConfig)
        })

        const result: SetBackupModeResult = {
            backupDiskId: disk.id, previousMode, mode, schedule, scheduleError, changed, note: noteFor(mode, schedule),
        }
        attachTraceResult(result)
        const what = `${mode}${mode === 'scheduled' ? ` at ${schedule?.daily}` : ''}`
        log(`setBackupMode: Backup Disk ${disk.id}: ${previousMode} → ${what}${changed ? '' : ' (unchanged)'}`)
        print(chalk.green(`setBackupMode: Backup Disk ${disk.id} is now ${what}; ${result.note}`))
        return result
    } finally {
        resourceLock.releaseAll([diskKey(disk.id)])
    }
}
