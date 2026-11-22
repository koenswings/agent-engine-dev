/**
 * engine#567: quarantine for unusable Automerge chunk files.
 *
 * A bad chunk file is moved (never deleted) to a timestamped folder NEXT TO the
 * store folder: <store-data>-quarantine/<YYYYMMDDTHHMMSS>-<pid>/<path inside store-data>.
 * One folder per Engine process, so all files quarantined during one start sit
 * together. A cross-device move (EXDEV) falls back to copy + unlink of the source.
 */
import fs from 'fs'
import path from 'path'
import { error } from '../utils/utils.js'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local time as YYYYMMDDTHHMMSS. */
export const quarantineStamp = (d: Date = new Date()): string =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/** <store-data>-quarantine, a sibling of the store folder. */
export const quarantineRootFor = (dataDir: string): string =>
    path.resolve(dataDir) + '-quarantine'

const runDirs = new Map<string, string>()

/** This process's quarantine folder for `dataDir` (not created here). */
export const quarantineDirFor = (dataDir: string): string => {
    const root = quarantineRootFor(dataDir)
    let dir = runDirs.get(root)
    if (!dir) {
        dir = path.join(root, `${quarantineStamp()}-${process.pid}`)
        runDirs.set(root, dir)
    }
    return dir
}

/** Tests only: forget the per-process folders. */
export const resetQuarantineDirsForTest = (): void => { runDirs.clear() }

export interface QuarantinedFile {
    from: string
    to: string
    reason: string
}

/**
 * Move `file` (inside `dataDir`) into the quarantine folder, keeping its relative
 * path. Returns the record, or null when the move failed (logged; never throws).
 */
export const quarantineFile = async (dataDir: string, file: string, reason: string): Promise<QuarantinedFile | null> => {
    const rel = path.relative(path.resolve(dataDir), path.resolve(file))
    const safeRel = rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(file) : rel
    const to = path.join(quarantineDirFor(dataDir), safeRel)
    try {
        await fs.promises.mkdir(path.dirname(to), { recursive: true })
        try {
            await fs.promises.rename(file, to)
        } catch (e: any) {
            if (e?.code !== 'EXDEV') throw e
            await fs.promises.copyFile(file, to)
            await fs.promises.unlink(file)
        }
        error(`[store-health] quarantined ${file} -> ${to} (${reason}) (engine#567)`)
        return { from: file, to, reason }
    } catch (e) {
        error(`[store-health] could not quarantine ${file} (${reason}): ${e instanceof Error ? e.message : e}`)
        return null
    }
}
