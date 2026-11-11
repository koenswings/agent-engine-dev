/**
 * On-disk store under /var/lib/idea/usage (idea#411 contract §6).
 * Atomic writes; a good (hookStatus=ok) day file is never overwritten by a
 * worse result.
 */
import fs from 'node:fs'
import path from 'node:path'
import { usageLog } from './log.js'
import {
    DAY_FILE_CAP,
    LIVE_DAY_DIR_WARN,
    PRESENCE_RING_DAYS,
    SAMPLES_FILE_CAP,
    addDays,
    dayDir,
    dayFile,
    isValidDate,
    presenceFile,
    samplesFile,
    usageRoot,
} from './paths.js'
import type { DayFile, PresenceRecord, SampleRecord } from './types.js'

export function writeAtomic(dest: string, contents: string, mode = 0o640): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o750 })
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp`)
    fs.writeFileSync(tmp, contents, { mode })
    fs.renameSync(tmp, dest)
}

export function readJsonFile(file: string): unknown | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

export function readDayFile(day: string, instanceId: string, root = usageRoot()): DayFile | null {
    const raw = readJsonFile(dayFile(day, instanceId, root))
    if (!raw || typeof raw !== 'object') return null
    return raw as DayFile
}

export function hasGoodDayFile(day: string, instanceId: string, root = usageRoot()): boolean {
    const rec = readDayFile(day, instanceId, root)
    return rec?.hookStatus === 'ok'
}

export function listLiveDays(root = usageRoot()): string[] {
    try {
        return fs.readdirSync(root, { withFileTypes: true })
            .filter(e => e.isDirectory() && e.name !== '.archive' && isValidDate(e.name))
            .map(e => e.name)
            .sort()
    } catch {
        return []
    }
}

export function warnIfTooManyDayDirs(root = usageRoot()): void {
    const n = listLiveDays(root).length
    if (n > LIVE_DAY_DIR_WARN) {
        usageLog(`warning: ${n} live day directories (cap warning is ${LIVE_DAY_DIR_WARN}); not auto-deleting`)
    }
}

export type WriteDayResult = { written: boolean; reason?: string }

export function writeDayFile(record: DayFile, root = usageRoot(), opts?: { overwriteOk?: boolean }): WriteDayResult {
    const dest = dayFile(record.day, record.instance, root)
    const existing = readDayFile(record.day, record.instance, root)
    if (existing?.hookStatus === 'ok' && (record.hookStatus !== 'ok' || opts?.overwriteOk === false)) {
        return { written: false, reason: 'keep-good' }
    }
    const text = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(text, 'utf8') > DAY_FILE_CAP) {
        usageLog(`day file for ${record.instance} ${record.day} exceeds ${DAY_FILE_CAP} bytes; not written`)
        return { written: false, reason: 'oversize' }
    }
    writeAtomic(dest, text)
    warnIfTooManyDayDirs(root)
    return { written: true }
}

function appendNdjsonLine(file: string, obj: unknown, capBytes?: number): void {
    const line = `${JSON.stringify(obj)}\n`
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 })
    fs.appendFileSync(file, line, { mode: 0o640 })
    if (capBytes === undefined) return
    let stat: fs.Stats
    try { stat = fs.statSync(file) } catch { return }
    if (stat.size <= capBytes) return
    const raw = fs.readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter(l => l.length > 0)
    while (lines.length > 1 && Buffer.byteLength(lines.join('\n') + '\n', 'utf8') > capBytes) {
        lines.shift()
    }
    writeAtomic(file, lines.join('\n') + '\n')
}

export function appendSample(day: string, instanceId: string, record: SampleRecord, root = usageRoot()): void {
    appendNdjsonLine(samplesFile(day, instanceId, root), record, SAMPLES_FILE_CAP)
}

export function readSamples(day: string, instanceId: string, root = usageRoot()): SampleRecord[] {
    return readNdjson(samplesFile(day, instanceId, root)) as SampleRecord[]
}

export function appendPresence(record: PresenceRecord, day: string, root = usageRoot()): void {
    appendNdjsonLine(presenceFile(day, root), record)
}

export function readPresence(day: string, root = usageRoot()): PresenceRecord[] {
    return readNdjson(presenceFile(day, root)) as PresenceRecord[]
}

export function readNdjson(file: string): unknown[] {
    try {
        return fs.readFileSync(file, 'utf8')
            .split('\n')
            .filter(l => l.trim().length > 0)
            .map(l => {
                try { return JSON.parse(l) } catch { return null }
            })
            .filter(x => x !== null)
    } catch {
        return []
    }
}

export function trimPresenceRing(today: string, root = usageRoot()): void {
    const cutoff = addDays(today, -PRESENCE_RING_DAYS)
    for (const day of listLiveDays(root)) {
        if (day >= cutoff) continue
        const file = presenceFile(day, root)
        try { fs.unlinkSync(file) } catch { /* no file is fine */ }
    }
}

export function readPresenceSince(fromDay: string, toDay: string, root = usageRoot()): PresenceRecord[] {
    const out: PresenceRecord[] = []
    for (const day of listLiveDays(root)) {
        if (day < fromDay || day > toDay) continue
        out.push(...readPresence(day, root))
    }
    return out
}

export function correctedBootsSinceLastSync(samples: PresenceRecord[]): number {
    let lastSynced = -1
    for (let i = samples.length - 1; i >= 0; i--) {
        if (samples[i].ntpSynced) { lastSynced = i; break }
    }
    if (lastSynced < 0) return 0
    const boots = new Set<string>()
    for (let i = lastSynced + 1; i < samples.length; i++) {
        if (!samples[i].ntpSynced) boots.add(samples[i].bootId)
    }
    return boots.size
}

export function instanceFilesForDay(day: string, root = usageRoot()): string[] {
    const dir = dayDir(day, root)
    try {
        return fs.readdirSync(dir)
            .filter(name => name.endsWith('.json') && !name.endsWith('.samples.ndjson'))
            .sort()
    } catch {
        return []
    }
}

export function sampleFilesForDay(day: string, root = usageRoot()): string[] {
    const dir = dayDir(day, root)
    try {
        return fs.readdirSync(dir)
            .filter(name => name.endsWith('.samples.ndjson'))
            .sort()
    } catch {
        return []
    }
}

export function instanceIdFromDayFileName(name: string): string {
    return name.replace(/\.json$/, '')
}

export function instanceIdFromSamplesFileName(name: string): string {
    return name.replace(/\.samples\.ndjson$/, '')
}

