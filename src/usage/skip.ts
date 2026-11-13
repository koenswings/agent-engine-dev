/**
 * Hook skip conditions (idea#411 contract §4.5): filesystem flags written by
 * the Engine process, plus Pi temperature.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { TEMP_SKIP_C, runDir, skipFlagPath } from './paths.js'
import type { SkipReason } from './types.js'

export function defaultReadTempC(): number | null {
    const vg = spawnSync('vcgencmd', ['measure_temp'], { encoding: 'utf8', timeout: 2000 })
    if (vg.status === 0 && vg.stdout) {
        const m = vg.stdout.match(/temp=([0-9.]+)/)
        if (m) return Number(m[1])
    }
    try {
        const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim()
        const n = Number(raw)
        if (Number.isFinite(n)) return n / 1000
    } catch { /* no thermal sysfs */ }
    return null
}

function flagIsActive(kind: 'backup' | 'update' | 'move', dir: string): boolean {
    const p = skipFlagPath(kind, dir)
    if (!fs.existsSync(p)) return false
    let raw = ''
    try { raw = fs.readFileSync(p, 'utf8').trim() } catch { return true }
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) return true
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

export function currentSkipReason(opts?: {
    runDir?: string
    readTempC?: () => number | null
}): SkipReason | null {
    const dir = opts?.runDir ?? runDir()
    if (flagIsActive('backup', dir)) return 'backup'
    if (flagIsActive('update', dir)) return 'update'
    if (flagIsActive('move', dir)) return 'move'
    const t = (opts?.readTempC ?? defaultReadTempC)()
    if (t != null && t > TEMP_SKIP_C) return 'temperature'
    return null
}
