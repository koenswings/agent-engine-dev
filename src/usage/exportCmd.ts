/**
 * idea-usage-export verbs (idea#411 contract §7): since, archive-and-clear.
 * Reads SSH_ORIGINAL_COMMAND when set (forced command) and also accepts argv.
 */
import fs from 'node:fs'
import path from 'node:path'
import { usageLog } from './log.js'
import {
    USAGE_SCHEMA_DAY,
    USAGE_SCHEMA_EXPORT,
    USAGE_SCHEMA_PRESENCE,
    USAGE_SCHEMA_SAMPLE,
    archiveRoot,
    dayDir,
    engineHostname,
    isValidDate,
    pathIsInside,
    usageRoot,
    utcStamp,
} from './paths.js'
import { inspectUsageMonitoring } from './settings.js'
import {
    instanceIdFromDayFileName,
    instanceIdFromSamplesFileName,
    listLiveDays,
} from './store.js'

export const EXIT_OK = 0
export const EXIT_RUNTIME = 1
export const EXIT_INVALID = 2
export const EXIT_DISABLED = 10

const SHELL_META = /[;|&$`<>(){}\\*\n\r?!#]/

export type ExportVerb =
    | { ok: true; verb: 'since'; date: string }
    | { ok: true; verb: 'archive'; before: string }
    | { ok: false; error: string }

export function tokenize(s: string): string[] {
    return s.trim().split(/\s+/).filter(Boolean)
}

export function stripBinary(tokens: string[]): string[] {
    if (tokens[0] && /(^|\/)idea-usage-export$/.test(tokens[0])) return tokens.slice(1)
    return tokens
}

export function parseExportArgs(argv: string[], sshOriginal?: string): ExportVerb {
    const raw = (sshOriginal && sshOriginal.trim().length > 0) ? tokenize(sshOriginal) : argv
    const tokens = stripBinary(raw)
    if (tokens.some(t => SHELL_META.test(t))) return { ok: false, error: 'invalid arguments' }
    if (tokens.length === 2 && tokens[0] === 'since') {
        if (!isValidDate(tokens[1])) return { ok: false, error: 'invalid arguments' }
        return { ok: true, verb: 'since', date: tokens[1] }
    }
    if (tokens.length === 2 && tokens[0] === 'archive-and-clear' && tokens[1].startsWith('--before=')) {
        const date = tokens[1].slice('--before='.length)
        if (!isValidDate(date)) return { ok: false, error: 'invalid arguments' }
        return { ok: true, verb: 'archive', before: date }
    }
    if (tokens.length === 3 && tokens[0] === 'archive-and-clear' && tokens[1] === '--before') {
        if (!isValidDate(tokens[2])) return { ok: false, error: 'invalid arguments' }
        return { ok: true, verb: 'archive', before: tokens[2] }
    }
    return { ok: false, error: 'invalid arguments' }
}

export interface ExportIO {
    argv: string[]
    sshOriginal?: string
    root?: string
    hostname?: string
    stdout: { write: (s: string) => unknown }
    stderr: { write: (s: string) => unknown }
    now?: () => Date
}

function writeln(io: { write: (s: string) => unknown }, obj: unknown): void {
    io.write(`${JSON.stringify(obj)}\n`)
}

export async function runExport(opts: ExportIO): Promise<number> {
    const root = opts.root ?? usageRoot()
    const parsed = parseExportArgs(opts.argv, opts.sshOriginal)
    if (!parsed.ok) {
        opts.stderr.write('invalid arguments\n')
        return EXIT_INVALID
    }
    const sw = inspectUsageMonitoring(root)
    if (sw.status === 'unreadable') {
        opts.stderr.write('unreadable settings\n')
        return EXIT_RUNTIME
    }
    if (sw.status !== 'on') {
        opts.stderr.write('disabled\n')
        return EXIT_DISABLED
    }
    try {
        if (parsed.verb === 'since') return exportSince(parsed.date, root, opts)
        return archiveAndClear(parsed.before, root, opts)
    } catch (e) {
        usageLog(`export failed: ${e instanceof Error ? e.message : String(e)}`)
        opts.stderr.write('export failed\n')
        return EXIT_RUNTIME
    }
}

function exportSince(since: string, root: string, opts: ExportIO): number {
    const hostname = opts.hostname ?? engineHostname()
    const counts = { day: 0, sample: 0, presence: 0 }
    let errors = 0
    for (const day of listLiveDays(root)) {
        if (day < since) continue
        const dir = dayDir(day, root)
        if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) continue
        if (!pathIsInside(dir, root)) continue

        const presencePath = path.join(dir, 'presence.ndjson')
        if (fs.existsSync(presencePath)) {
            let raw = ''
            try { raw = fs.readFileSync(presencePath, 'utf8') } catch {
                errors += 1
                raw = ''
            }
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue
                try {
                    const payload = JSON.parse(line)
                    writeln(opts.stdout, { type: 'presence', schema: USAGE_SCHEMA_PRESENCE, day, payload })
                    counts.presence += 1
                } catch {
                    errors += 1
                }
            }
        }

        let names: string[] = []
        try { names = fs.readdirSync(dir).sort() } catch {
            errors += 1
            continue
        }
        const dayRows: { instance: string; payload: unknown }[] = []
        for (const name of names) {
            if (!name.endsWith('.json') || name.endsWith('.samples.ndjson')) continue
            const file = path.join(dir, name)
            if (fs.lstatSync(file).isSymbolicLink()) { errors += 1; continue }
            try {
                const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
                const instance = typeof payload?.instance === 'string' ? payload.instance : instanceIdFromDayFileName(name)
                dayRows.push({ instance, payload })
            } catch {
                errors += 1
            }
        }
        dayRows.sort((a, b) => a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0)
        for (const row of dayRows) {
            writeln(opts.stdout, { type: 'day', schema: USAGE_SCHEMA_DAY, day, instance: row.instance, payload: row.payload })
            counts.day += 1
        }
        for (const name of names) {
            if (!name.endsWith('.samples.ndjson')) continue
            const file = path.join(dir, name)
            if (fs.lstatSync(file).isSymbolicLink()) { errors += 1; continue }
            const instance = instanceIdFromSamplesFileName(name)
            let raw = ''
            try { raw = fs.readFileSync(file, 'utf8') } catch {
                errors += 1
                continue
            }
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue
                try {
                    const payload = JSON.parse(line)
                    writeln(opts.stdout, { type: 'sample', schema: USAGE_SCHEMA_SAMPLE, day, instance, payload })
                    counts.sample += 1
                } catch {
                    errors += 1
                }
            }
        }
    }
    writeln(opts.stdout, {
        type: 'end',
        schema: USAGE_SCHEMA_EXPORT,
        since,
        engine: hostname,
        usageMonitoring: 'on',
        counts,
        errors,
    })
    return EXIT_OK
}

function countFilesRecursive(dir: string): number {
    let n = 0
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory() && !ent.isSymbolicLink()) n += countFilesRecursive(p)
        else if (ent.isFile()) n += 1
    }
    return n
}

function archiveAndClear(before: string, root: string, opts: ExportIO): number {
    const stamp = utcStamp((opts.now ?? (() => new Date()))())
    const destParent = archiveRoot(root)
    const dest = path.join(destParent, `${before}-${stamp}`)
    const toMove: string[] = []
    for (const day of listLiveDays(root)) {
        if (day >= before) continue
        const src = dayDir(day, root)
        if (fs.lstatSync(src).isSymbolicLink()) continue
        if (!pathIsInside(src, root)) continue
        toMove.push(day)
    }
    let days = 0
    let files = 0
    if (toMove.length > 0) {
        fs.mkdirSync(dest, { recursive: true, mode: 0o750 })
        for (const day of toMove) {
            const src = dayDir(day, root)
            files += countFilesRecursive(src)
            fs.renameSync(src, path.join(dest, day))
            days += 1
        }
    }
    writeln(opts.stdout, {
        type: 'archived',
        schema: USAGE_SCHEMA_EXPORT,
        before,
        days,
        files,
    })
    return EXIT_OK
}

/** Best-effort cleanup of archives older than 14 days (idea#411 §6). */
export function purgeOldArchives(root = usageRoot(), now = new Date(), maxAgeDays = 14): number {
    const archive = archiveRoot(root)
    if (!fs.existsSync(archive)) return 0
    let removed = 0
    const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000
    for (const ent of fs.readdirSync(archive, { withFileTypes: true })) {
        const p = path.join(archive, ent.name)
        if (ent.isSymbolicLink()) continue
        if (!ent.isDirectory()) continue
        try {
            if (!pathIsInside(p, root)) continue
            const st = fs.statSync(p)
            if (st.mtimeMs < cutoff) {
                fs.rmSync(p, { recursive: true, force: true })
                removed += 1
            }
        } catch { /* leave it */ }
    }
    return removed
}

