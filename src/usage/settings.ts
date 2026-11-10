/**
 * Local usageMonitoring switch (idea#411). Missing or unreadable file = off.
 * Lives under /var/lib/idea/usage/settings.json, never in Automerge.
 */
import fs from 'node:fs'
import { ensureUsageDirs, settingsPath, usageRoot } from './paths.js'
import type { UsageSwitch } from './types.js'

export function readUsageMonitoring(root = usageRoot()): UsageSwitch {
    try {
        const raw = fs.readFileSync(settingsPath(root), 'utf8')
        const parsed = JSON.parse(raw)
        return parsed && parsed.usageMonitoring === 'on' ? 'on' : 'off'
    } catch {
        return 'off'
    }
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
