/**
 * BackupYamlDoc.ts — document-preserving BACKUP.yaml edits (idea#451 writer, idea#400 PR B)
 *
 * Every Engine write to an existing BACKUP.yaml goes through here: the file is
 * parsed as a YAML document, only the named keys change, and every other key
 * (other links with their lastBackup, comments, keys a later Engine adds) passes
 * through. The write is atomic: a temp file in the same folder, fsync, rename.
 *
 * Scheduled-backup state kept on the disk (docs/BACKUP_SCHEDULE.md):
 *   schedule { daily }, lastRun { time, uptimeS, bootId }, lastAttempt,
 *   missedRuns, uptimeCounter { bootId, baseUptimeS, seenUptimeS, carriedS }.
 * The disk is the source of truth; the store only mirrors schedule, missedRuns
 * and lastAttempt. The uptime counter is never mirrored (Steve, idea#400 Q9).
 */

import { YAML, fs } from 'zx'
import { promises as fsp } from 'fs'
import { disksRoot } from './Config.js'
import { BackupMode } from './CommonTypes.js'
import {
    BackupSchedule, BackupLastRun, BackupUptimeCounter, parseBackupSchedule,
} from '../utils/backupSchedule.js'

/** File operations of the atomic write. Tests replace `rename` to simulate a failure. */
export const backupYamlIo = {
    rename: (from: string, to: string): Promise<void> => fsp.rename(from, to),
}

export const backupYamlPath = (device: string): string => `${disksRoot()}/${device}/BACKUP.yaml`

/** Temp file in the same folder, fsync, rename over BACKUP.yaml. A failure leaves the old file. */
export const writeBackupDocumentAtomic = async (device: string, text: string): Promise<void> => {
    const target = backupYamlPath(device)
    const tmp = `${disksRoot()}/${device}/.BACKUP.yaml.tmp-${process.pid}-${Date.now()}`
    const fh = await fsp.open(tmp, 'w')
    try {
        await fh.writeFile(text, 'utf-8')
        await fh.sync()
    } finally {
        await fh.close()
    }
    try {
        await backupYamlIo.rename(tmp, target)
    } catch (e) {
        // Our own temp file only; BACKUP.yaml itself is untouched.
        await fs.remove(tmp).catch(() => { /* best effort */ })
        throw e
    }
}

type BackupDocument = ReturnType<typeof YAML.parseDocument>

/** Parse BACKUP.yaml as a document; null when the file is missing. Throws when it does not parse as a mapping. */
export const readBackupDocumentLoose = async (device: string): Promise<BackupDocument | null> => {
    const path = backupYamlPath(device)
    let raw: string
    try {
        raw = await fs.readFile(path, 'utf-8')
    } catch (e: any) {
        if (e?.code === 'ENOENT') return null
        throw e
    }
    const doc = YAML.parseDocument(raw)
    if (doc.errors.length) throw new Error(`BAD_BACKUP_YAML: ${path} does not parse: ${doc.errors[0].message}`)
    if (!YAML.isMap(doc.contents)) throw new Error(`BAD_BACKUP_YAML: ${path} is not a mapping`)
    return doc
}

/**
 * Edit an existing BACKUP.yaml in place. `mutate` changes the document; the file is
 * written only when the text changed. Returns false when there is no BACKUP.yaml.
 */
export const editBackupYaml = async (device: string, mutate: (doc: BackupDocument) => void): Promise<boolean> => {
    const doc = await readBackupDocumentLoose(device)
    if (!doc) return false
    const before = doc.toString()
    mutate(doc)
    const after = doc.toString()
    if (after !== before) await writeBackupDocumentAtomic(device, after)
    return true
}

/** Set a top-level key, or delete it for null/undefined. Plain values are converted to YAML nodes. */
const setOrDelete = (doc: BackupDocument, key: string, value: unknown): void => {
    if (value === null || value === undefined) {
        if (doc.has(key)) doc.delete(key)
    } else {
        doc.set(key, doc.createNode(value))
    }
}

/** Update one link's lastBackup (backupInstance step 7). No-op when the instance is not linked. */
export const setLinkLastBackup = async (device: string, instanceId: string, lastBackup: number): Promise<boolean> => {
    let found = false
    const exists = await editBackupYaml(device, doc => {
        const links = doc.get('links')
        if (!YAML.isSeq(links)) return
        for (const item of links.items) {
            if (YAML.isMap(item) && String(item.get('instanceId')) === String(instanceId)) {
                item.set('lastBackup', lastBackup)
                found = true
            }
        }
    })
    return exists && found
}

/** The scheduled-run keys the scheduler (PR C) writes after a run or an hourly counter update. */
export interface BackupScheduleStatePatch {
    schedule?: BackupSchedule | null
    lastRun?: BackupLastRun | null
    lastAttempt?: number | null
    missedRuns?: number | null
    uptimeCounter?: BackupUptimeCounter | null
}

/** Write only the keys present in `patch` (null deletes). Returns false when there is no BACKUP.yaml. */
export const writeBackupScheduleState = async (device: string, patch: BackupScheduleStatePatch): Promise<boolean> =>
    editBackupYaml(device, doc => {
        for (const key of ['schedule', 'lastRun', 'lastAttempt', 'missedRuns', 'uptimeCounter'] as const) {
            if (key in patch) setOrDelete(doc, key, patch[key])
        }
    })

/** BACKUP.yaml as the Engine reads it at dock (processBackupDisk). */
export interface BackupYamlState {
    mode: BackupMode
    links: Array<{ instanceId: string, lastBackup: number }>
    /** Parsed schedule, or null when absent or invalid (see scheduleError). */
    schedule: BackupSchedule | null
    /** Set when `schedule` is present but invalid (BAD_TIME / BAD_SCHEDULE text). */
    scheduleError: string | null
    lastRun: BackupLastRun | null
    lastAttempt: number | null
    missedRuns: number | null
    uptimeCounter: BackupUptimeCounter | null
}

const finiteOrNull = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
    return Number.isFinite(n) ? n : null
}

const parseLastRun = (raw: any): BackupLastRun | null => {
    const time = finiteOrNull(raw?.time)
    if (time == null) return null
    return { time, uptimeS: finiteOrNull(raw?.uptimeS) ?? 0, bootId: typeof raw?.bootId === 'string' ? raw.bootId : null }
}

const parseUptimeCounter = (raw: any): BackupUptimeCounter | null => {
    if (typeof raw?.bootId !== 'string' || !raw.bootId) return null
    const baseUptimeS = finiteOrNull(raw.baseUptimeS)
    const seenUptimeS = finiteOrNull(raw.seenUptimeS)
    const carriedS = finiteOrNull(raw.carriedS)
    if (baseUptimeS == null || seenUptimeS == null || carriedS == null || carriedS < 0) return null
    return { bootId: raw.bootId, baseUptimeS, seenUptimeS, carriedS }
}

/**
 * Lenient read: `{ mode, links }` as before (a file without them gives null, as
 * readBackupYaml did), plus the schedule state. A malformed state key reads as
 * null rather than failing the dock.
 */
export const parseBackupYamlState = (raw: unknown): BackupYamlState | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const y = raw as Record<string, any>
    if (typeof y.mode !== 'string' || !Array.isArray(y.links)) return null
    let schedule: BackupSchedule | null = null
    let scheduleError: string | null = null
    try {
        schedule = parseBackupSchedule(y.schedule)
    } catch (e: any) {
        scheduleError = e?.message ?? String(e)
    }
    const missed = finiteOrNull(y.missedRuns)
    return {
        mode: y.mode as BackupMode,
        links: y.links
            .filter((l: any) => l && l.instanceId != null && String(l.instanceId) !== '')
            .map((l: any) => ({ instanceId: String(l.instanceId), lastBackup: finiteOrNull(l.lastBackup) ?? 0 })),
        schedule,
        scheduleError,
        lastRun: parseLastRun(y.lastRun),
        lastAttempt: finiteOrNull(y.lastAttempt),
        missedRuns: missed != null && missed >= 0 ? Math.floor(missed) : null,
        uptimeCounter: parseUptimeCounter(y.uptimeCounter),
    }
}

export const readBackupYamlState = async (device: string): Promise<BackupYamlState | null> => {
    try {
        return parseBackupYamlState(YAML.parse(await fs.readFile(backupYamlPath(device), 'utf-8')))
    } catch {
        return null
    }
}
