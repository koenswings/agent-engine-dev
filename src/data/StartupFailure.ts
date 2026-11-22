/**
 * engine#567: persistent startup-failure marker.
 *
 * When startEngine throws, index.ts records the failure in
 * logs/engine-startup-failure.json (next to store-data in the Engine folder, never
 * inside it): count, first and last time, and the error. It is written atomically
 * (temp file, fsync, rename, folder fsync) and synchronously, because the process
 * exits right after. pm2 restarts the Engine with an exponential backoff
 * (pm2.config.cjs), so a crash loop counts up in this one file.
 *
 * At the next good start (end of startEngine) the marker is taken: renamed to
 * logs/engine-startup-failure-<stamp>.json (kept, never deleted) and published once as
 * Engine.lastStartupFailure on this Engine's entry in the store, where the Console
 * can show it. The field stays until the next crash loop replaces it.
 */
import fs from 'fs'
import path from 'path'
import type { DocHandle } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { redactString } from '../utils/redact.js'
import { quarantineStamp } from './StoreQuarantine.js'

export interface StartupFailureRecord {
    /** Failed starts in a row */
    count: number
    /** First and last failed start (ms since epoch) */
    firstAt: number
    lastAt: number
    /** The last error message (redacted, at most 500 characters) */
    error: string
    /** Set when published: the start that came up again */
    recoveredAt?: number
}

export const STARTUP_FAILURE_FILE = 'engine-startup-failure.json'
export const defaultStartupFailureFile = (): string => path.resolve('logs', STARTUP_FAILURE_FILE)

const MAX_ERROR = 500

const readRecord = (file: string): StartupFailureRecord | null => {
    try {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (r && typeof r.count === 'number' && typeof r.firstAt === 'number' && typeof r.lastAt === 'number') {
            return { count: r.count, firstAt: r.firstAt, lastAt: r.lastAt, error: String(r.error ?? '') }
        }
    } catch { /* missing or unreadable: start a new record */ }
    return null
}

const fsyncDirSync = (dir: string): void => {
    let fd: number | undefined
    try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd) } catch { /* best effort */ } finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** Count this failed start. Never throws (the Engine is already failing). */
export const recordStartupFailure = (err: unknown, opts: { file?: string, now?: number } = {}): StartupFailureRecord | null => {
    const file = opts.file ?? defaultStartupFailureFile()
    const now = opts.now ?? Date.now()
    try {
        const prev = readRecord(file)
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        const rec: StartupFailureRecord = {
            count: (prev?.count ?? 0) + 1,
            firstAt: prev?.firstAt ?? now,
            lastAt: now,
            error: redactString(message).slice(0, MAX_ERROR),
        }
        const dir = path.dirname(file)
        fs.mkdirSync(dir, { recursive: true })
        const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`)
        const fd = fs.openSync(tmp, 'w')
        try { fs.writeSync(fd, JSON.stringify(rec, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(tmp, file)
        fsyncDirSync(dir)
        return rec
    } catch (e) {
        log(`[startup-failure] could not write ${file}: ${e instanceof Error ? e.message : e}`)
        return null
    }
}

/**
 * At a good start: read the marker and archive it (rename, never delete).
 * Returns the record with recoveredAt, or null when there was no marker.
 */
export const takeStartupFailure = (opts: { file?: string, now?: number } = {}): StartupFailureRecord | null => {
    const file = opts.file ?? defaultStartupFailureFile()
    if (!fs.existsSync(file)) return null
    const rec = readRecord(file)
    const now = opts.now ?? Date.now()
    const archived = path.join(path.dirname(file), `${path.basename(file, '.json')}-${quarantineStamp(new Date(now))}.json`)
    try {
        fs.renameSync(file, archived)
        fsyncDirSync(path.dirname(file))
    } catch (e) {
        log(`[startup-failure] could not archive ${file}: ${e instanceof Error ? e.message : e}`)
    }
    if (!rec) return null
    return { ...rec, recoveredAt: now }
}

/** Write the record on this Engine's own entry; never creates engineDB or the entry. */
export const publishStartupFailure = (storeHandle: DocHandle<any>, engineId: string, rec: StartupFailureRecord): boolean => {
    let done = false
    storeHandle.change((doc: any) => {
        const eng = doc?.engineDB?.[engineId]
        if (!eng) return
        eng.lastStartupFailure = { ...rec }
        done = true
    })
    if (done) log(`[startup-failure] the Engine failed to start ${rec.count} time(s) between ${new Date(rec.firstAt).toISOString()} and ${new Date(rec.lastAt).toISOString()} (last error: ${rec.error}); published as lastStartupFailure (engine#567)`)
    return done
}
