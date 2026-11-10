/**
 * Skip-flag writers for the Engine process (idea#411). idea-usage reads the
 * files via skip.ts and never opens operationDB.
 */
import fs from 'node:fs'
import { usageLog } from './log.js'
import { runDir, skipFlagPath } from './paths.js'

export type UsageSkipKind = 'backup' | 'update' | 'move'

const counts: Record<UsageSkipKind, number> = { backup: 0, update: 0, move: 0 }

export function beginUsageSkip(kind: UsageSkipKind): void {
    counts[kind] += 1
    try {
        const dir = runDir()
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
        fs.writeFileSync(skipFlagPath(kind), `${process.pid}\n`, { mode: 0o644 })
    } catch (e) {
        usageLog(`could not write ${kind}-running flag: ${e instanceof Error ? e.message : String(e)}`)
    }
}

export function endUsageSkip(kind: UsageSkipKind): void {
    counts[kind] = Math.max(0, counts[kind] - 1)
    if (counts[kind] > 0) return
    try {
        fs.unlinkSync(skipFlagPath(kind))
    } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err?.code !== 'ENOENT') {
            usageLog(`could not clear ${kind}-running flag: ${err?.message ?? String(e)}`)
        }
    }
}

/** Test helper: reset in-process refcounts (does not touch the filesystem). */
export function resetUsageSkipCountsForTests(): void {
    counts.backup = 0
    counts.update = 0
    counts.move = 0
}
