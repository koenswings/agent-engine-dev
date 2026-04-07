import { $ } from 'zx'
import { log } from './utils.js'

export interface RsyncProgress {
    progressPercent: number
}

export type RsyncProgressCallback = (progress: RsyncProgress) => void

/**
 * Copies a directory from src to dest using rsync.
 *
 * - Preserves permissions, symlinks, and timestamps (-a / archive mode).
 * - Reports progress via onProgress callback (0-100).
 * - Idempotent: safe to re-run after interruption (rsync diffs before copying).
 * - Phase 1: local-to-local only. Phase 2: pass a remote dest path (user@host:path)
 *   with sshKey to enable cross-engine transfer using the same API.
 *
 * @param src    Source directory path (trailing slash added internally — copies contents, not the dir itself)
 * @param dest   Destination directory path (created if absent)
 * @param onProgress  Optional callback called as rsync reports progress
 * @param sshKey Optional path to SSH private key for remote destinations (phase 2)
 */
export const rsyncDirectory = async (
    src: string,
    dest: string,
    onProgress?: RsyncProgressCallback,
    sshKey?: string
): Promise<void> => {
    // Ensure dest exists
    await $`mkdir -p ${dest}`

    // Build rsync args
    // --info=progress2  machine-readable total progress (one line, no per-file noise)
    // --no-inc-recursive  required for accurate total progress with --info=progress2
    // -a                archive: recursive + preserve perms/symlinks/timestamps
    const rsyncArgs = ['-a', '--info=progress2', '--no-inc-recursive']

    if (sshKey) {
        rsyncArgs.push(`--rsh=ssh -i ${sshKey} -o StrictHostKeyChecking=no`)
    }

    // src/ (trailing slash) copies contents into dest, not src dir itself
    const srcPath = src.endsWith('/') ? src : src + '/'

    log(`rsync: ${srcPath} → ${dest}`)

    const proc = $`rsync ${rsyncArgs} ${srcPath} ${dest}`

    // Parse stdout for progress2 output: "  1,234,567  42%   1.23MB/s    0:00:03"
    proc.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\r')
        for (const line of lines) {
            const match = line.match(/(\d+)%/)
            if (match && onProgress) {
                onProgress({ progressPercent: parseInt(match[1], 10) })
            }
        }
    })

    await proc
    log(`rsync complete: ${srcPath} → ${dest}`)
}
