/**
 * Local usageMonitoring switch (idea#411). Missing file = off.
 * Unreadable or unparsable file: readUsageMonitoring returns off (the
 * idea-usage process fail-opens); export treats that as exit 1 via
 * inspectUsageMonitoring. Lives under /var/lib/idea/usage/settings.json,
 * never in Automerge.
 */
import fs from 'node:fs'
import { ensureUsageDirs, settingsPath, usageRoot } from './paths.js'
import type { UsageSwitch } from './types.js'

export type UsageSettingsRead =
    | { status: 'on' }
    | { status: 'off' }
    | { status: 'unreadable' }

export function inspectUsageMonitoring(root = usageRoot()): UsageSettingsRead {
    const dest = settingsPath(root)
    let raw: string
    try {
        raw = fs.readFileSync(dest, 'utf8')
    } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err?.code === 'ENOENT') return { status: 'off' }
        return { status: 'unreadable' }
    }
    try {
        const parsed = JSON.parse(raw)
        return { status: parsed && parsed.usageMonitoring === 'on' ? 'on' : 'off' }
    } catch {
        return { status: 'unreadable' }
    }
}

export function readUsageMonitoring(root = usageRoot()): UsageSwitch {
    return inspectUsageMonitoring(root).status === 'on' ? 'on' : 'off'
}

/** Write only this file. Never restarts the Engine or any App. */
export function writeUsageMonitoring(value: UsageSwitch, root = usageRoot()): void {
    if (value !== 'on' && value !== 'off') {
        throw new Error(`usageMonitoring must be 'on' or 'off'`)
    }
    ensureUsageDirs(root)
    const dest = settingsPath(root)
    const tmp = `${dest}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ usageMonitoring: value })}\n`, { mode: 0o640 })
    fs.renameSync(tmp, dest)
}
