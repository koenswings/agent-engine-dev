/**
 * rsync.ts — rsync primitive for App copy/move operations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine, local paths only.
 * Phase 2: cross-engine — pass remoteHost to rsync over SSH to pi@host.
 */

import { chalk } from 'zx'
import { spawn, ChildProcess } from 'child_process'
import { log } from './utils.js'
import { registerProcess, deregisterProcess } from '../data/Operations.js'

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
 * src must be a local absolute path.
 * dest must be an absolute path. If remoteHost is provided, rsync runs over
 * SSH to `pi@<remoteHost>:<dest>` (cross-engine Phase 2).
 * Trailing slash is appended to src so rsync copies the *contents*.
 */
export const rsyncDirectory = (
    src: string,
    dest: string,
    onProgress?: RsyncProgressCallback,
    opId?: string,
    remoteHost?: string,
): Promise<void> => {
    return new Promise((resolve, reject) => {
        // Ensure src has trailing slash so rsync copies contents, not the directory itself
        const srcArg = src.endsWith('/') ? src : src + '/'
        const destArg = remoteHost ? `pi@${remoteHost}:${dest}` : dest

        const args = [
            '-a',
            '--info=progress2',
            '--no-inc-recursive',  // required for accurate total-progress reporting
        ]

        if (remoteHost) {
            args.push('-e', 'ssh -o StrictHostKeyChecking=no')
        }

        args.push(srcArg, destArg)

        log(`rsync ${args.join(' ')}`)

        const proc = spawn('rsync', args)
        if (opId) registerProcess(opId, proc)

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

        proc.on('close', (code, signal) => {
            if (opId) deregisterProcess(opId)
            if (code === 0) {
                if (onProgress) onProgress({ progressPercent: 100 })
                resolve()
            } else if (signal === 'SIGTERM') {
                reject(new Error(`rsync cancelled (SIGTERM)`))
            } else {
                reject(new Error(`rsync exited with code ${code}: ${stderr.trim()}`))
            }
        })

        proc.on('error', (err) => {
            if (opId) deregisterProcess(opId)
            reject(new Error(`rsync spawn error: ${err.message}`))
        })
    })
}
