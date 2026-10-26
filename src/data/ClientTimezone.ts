/**
 * ClientTimezone.ts — idea#208: the client time zone is a flash-time parameter.
 *
 * The client image defaults to UTC (koenswings/idea#319). When the Engine flashes a client
 * card it passes its OWN time zone to the root helper (idea-flash-card --timezone), which
 * writes idea-timezone.txt = "<zone>\n" on the card's FAT partition 1, next to idea-home.txt.
 * The zone is read here as pi (`timedatectl show -p Timezone --value`) and validated; the
 * helper validates it again as root. An empty or invalid zone means: no file, log it, and
 * the flash still goes ahead (the client stays on UTC).
 */
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'

export const CLIENT_TIMEZONE_FILE = 'idea-timezone.txt'
export const ZONEINFO_DIR = '/usr/share/zoneinfo'
/** Same regex as idea#319 set-card-timezone.sh and the root helpers */
export const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/

export type TimezoneCheck = { ok: true; zone: string } | { ok: false; reason: string }

/** Validate a tz name: regex, no '.'/'..' component, and <zoneinfoDir>/<zone> is a regular file. */
export const validateClientTimezone = (raw: string | null | undefined, zoneinfoDir: string = ZONEINFO_DIR): TimezoneCheck => {
    const zone = (raw ?? '').trim()
    if (!zone) return { ok: false, reason: 'the Engine has no time zone (empty)' }
    if (!TIMEZONE_RE.test(zone)) return { ok: false, reason: `'${zone}' is not a tz database name` }
    if (zone.split('/').some(c => c === '..' || c === '.')) return { ok: false, reason: `'${zone}' has a . or .. component` }
    try {
        if (!fs.statSync(path.join(zoneinfoDir, zone)).isFile()) return { ok: false, reason: `'${zone}' is not a file in ${zoneinfoDir}` }
    } catch {
        return { ok: false, reason: `'${zone}' is not in ${zoneinfoDir}` }
    }
    return { ok: true, zone }
}

/** The exact bytes of idea-timezone.txt for a validated zone: one line with a trailing newline. */
export const clientTimezoneFileContent = (zone: string): string => `${zone}\n`

/** The Engine's own zone, as pi: `timedatectl show -p Timezone --value` ('' when it fails). */
export const readEngineTimezone = (): Promise<string> => new Promise((resolve) => {
    execFile('timedatectl', ['show', '-p', 'Timezone', '--value'], { timeout: 5000 }, (err, stdout) => {
        resolve(err ? '' : String(stdout).trim())
    })
})
