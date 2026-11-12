/**
 * Paths and kit-local date helpers for idea-usage (idea#411).
 * Override roots with IDEA_USAGE_ROOT / IDEA_USAGE_RUN_DIR so tests never
 * touch /var/lib/idea/usage or /run/idea.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const USAGE_SCHEMA_DAY = 'idea-usage-day/1'
export const USAGE_SCHEMA_SAMPLE = 'idea-usage-sample/1'
export const USAGE_SCHEMA_PRESENCE = 'idea-usage-presence/1'
export const USAGE_SCHEMA_EXPORT = 'idea-usage-export/1'

export const DEFAULT_USAGE_ROOT = '/var/lib/idea/usage'
export const DEFAULT_RUN_DIR = '/run/idea'
export const DEFAULT_SYSTEM_INSTANCES = '/instances'
export const DEFAULT_SYSTEM_APPS = '/apps'
export const DEFAULT_DISKS_ROOT = '/disks'

export const DAY_FILE_CAP = 256 * 1024
export const SAMPLE_STDOUT_CAP = 64 * 1024
export const STDERR_CAP = 16 * 1024
export const SAMPLES_FILE_CAP = 1024 * 1024
export const MAX_TIMEOUT_S = 120
export const PRESENCE_RING_DAYS = 90
export const CATCH_UP_DAYS = 14
export const LIVE_DAY_DIR_WARN = 400
export const ARCHIVE_RETENTION_DAYS = 14
export const SAMPLE_INTERVAL_MS = 15 * 60 * 1000
export const PRESENCE_INTERVAL_MS = 5 * 60 * 1000
export const SETTINGS_POLL_MS = 60 * 1000
export const TEMP_SKIP_C = 75
export const TOP_ARTICLES_MAX = 50
export const NIGHT_START_MIN = 2 * 60
export const NIGHT_END_MIN = 3 * 60 + 30

export const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
export const APP_NAME_RE = /^[a-z][a-z0-9-]*$/

export function usageRoot(): string {
    return process.env.IDEA_USAGE_ROOT || DEFAULT_USAGE_ROOT
}

export function runDir(): string {
    return process.env.IDEA_USAGE_RUN_DIR || DEFAULT_RUN_DIR
}

export function disksRootPath(): string {
    return process.env.IDEA_DISKS_ROOT || DEFAULT_DISKS_ROOT
}

/** Null when tests set IDEA_SYSTEM_DISK_SKIP and did not point at a fixture. */
export function systemInstancesRoot(): string | null {
    if (process.env.IDEA_SYSTEM_INSTANCES) return process.env.IDEA_SYSTEM_INSTANCES
    if (process.env.IDEA_SYSTEM_DISK_SKIP === 'true') return null
    return DEFAULT_SYSTEM_INSTANCES
}

export function systemAppsRoot(): string | null {
    if (process.env.IDEA_SYSTEM_APPS) return process.env.IDEA_SYSTEM_APPS
    if (process.env.IDEA_SYSTEM_DISK_SKIP === 'true') return null
    return DEFAULT_SYSTEM_APPS
}

export function engineHostname(): string {
    const h = process.env.IDEA_USAGE_ENGINE || os.hostname()
    return h.split('.')[0] || h
}

export function settingsPath(root = usageRoot()): string {
    return path.join(root, 'settings.json')
}

export function dayDir(day: string, root = usageRoot()): string {
    return path.join(root, day)
}

export function dayFile(day: string, instanceId: string, root = usageRoot()): string {
    return path.join(root, day, `${instanceId}.json`)
}

export function samplesFile(day: string, instanceId: string, root = usageRoot()): string {
    return path.join(root, day, `${instanceId}.samples.ndjson`)
}

export function presenceFile(day: string, root = usageRoot()): string {
    return path.join(root, day, 'presence.ndjson')
}

export function archiveRoot(root = usageRoot()): string {
    return path.join(root, '.archive')
}

export function skipFlagPath(kind: 'backup' | 'update' | 'move', dir = runDir()): string {
    return path.join(dir, `${kind}-running`)
}

export function ensureUsageDirs(root = usageRoot()): void {
    fs.mkdirSync(root, { recursive: true, mode: 0o750 })
}

export function isValidDate(s: string): boolean {
    if (!DATE_RE.test(s)) return false
    const [y, m, d] = s.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function kitLocalDay(d: Date): string {
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${day}`
}

/** True when `createdAt` falls on or before the end of kit-local `day`. Unknown or invalid → false. */
export function instanceExistedOnDay(createdAt: string | Date | undefined | null, day: string): boolean {
    if (createdAt == null || createdAt === '') return false
    const d = createdAt instanceof Date ? createdAt : new Date(createdAt)
    if (Number.isNaN(d.getTime())) return false
    if (!isValidDate(day)) return false
    return kitLocalDay(d) <= day
}

export function minutesOfDay(d: Date): number {
    return d.getHours() * 60 + d.getMinutes()
}

export function inNightWindow(d: Date): boolean {
    const m = minutesOfDay(d)
    return m >= NIGHT_START_MIN && m < NIGHT_END_MIN
}

export function addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number)
    const dt = new Date(y, m - 1, d + n)
    return kitLocalDay(dt)
}

export function yesterdayLocal(d: Date): string {
    const y = new Date(d.getTime())
    y.setDate(y.getDate() - 1)
    return kitLocalDay(y)
}

export function daysBetweenInclusive(from: string, to: string): string[] {
    const out: string[] = []
    let cur = from
    for (let i = 0; i < 400 && cur <= to; i++) {
        out.push(cur)
        cur = addDays(cur, 1)
    }
    return out
}

export function formatRfc3339(d: Date): string {
    const tzMin = -d.getTimezoneOffset()
    const sign = tzMin >= 0 ? '+' : '-'
    const abs = Math.abs(tzMin)
    const hh = String(Math.floor(abs / 60)).padStart(2, '0')
    const mm = String(abs % 60).padStart(2, '0')
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`
}

export function utcStamp(d = new Date()): string {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export function pathIsInside(target: string, root: string): boolean {
    try {
        const rr = fs.realpathSync(root)
        const rp = fs.realpathSync(target)
        return rp === rr || rp.startsWith(rr + path.sep)
    } catch {
        return false
    }
}
