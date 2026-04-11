/**
 * rsync.ts — rsync primitive for App copy/move operations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine, local paths only.
 * Phase 2 (future): pass a remote path like 'pi@host:/disks/...' for cross-engine.
 */

import { chalk } from 'zx'
import { spawn } from 'child_process'
import { log } from './utils.js'

export interface RsyncProgress {
    progressPercent: number
}

export type RsyncProgressCallback = (progress: RsyncProgress) => void

/**
 * Copy src/ to dest/ using rsync.
 *
 * - Preserves permissions, symlinks, timestamps (-a / archive mode)
 * - Reports per-transfer progress via onProgress callback (0-100)
 * - Idempotent: re-running after interruption transfers only the delta
 * - Throws on non-zero exit
 *
 * src and dest must be absolute paths (phase 1: both local).
 * Trailing slash is appended to src so rsync copies the *contents*.
 */
export const rsyncDirectory = (
    src: string,
    dest: string,
    onProgress?: RsyncProgressCallback
): Promise<void> => {
    return new Promise((resolve, reject) => {
        // Ensure src has trailing slash so rsync copies contents, not the directory itself
        const srcArg = src.endsWith('/') ? src : src + '/'

        const args = [
            '-a',
            '--info=progress2',
            '--no-inc-recursive',  // required for accurate total-progress reporting
            srcArg,
            dest,
        ]

        log(`rsync ${args.join(' ')}`)

        const proc = spawn('rsync', args)

        let stderr = ''

        proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            // progress2 lines look like: "  1,234,567  42%    1.23MB/s    0:00:05"
            // We scan for the percentage value.
            const matches = text.match(/\s(\d{1,3})%/)
            if (matches && onProgress) {
                const pct = parseInt(matches[1], 10)
                if (!isNaN(pct)) {
                    onProgress({ progressPercent: pct })
                }
            }
        })

        proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
        })

        proc.on('close', (code) => {
            if (code === 0) {
                if (onProgress) onProgress({ progressPercent: 100 })
                resolve()
            } else {
                reject(new Error(`rsync exited with code ${code}: ${stderr.trim()}`))
            }
        })

        proc.on('error', (err) => {
            reject(new Error(`rsync spawn error: ${err.message}`))
        })
    })
}
