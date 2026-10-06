/**
 * rsync.ts — rsync primitive for App copy/move operations
 *
 * Design: design/copy-move-app.md
 *
 * Phase 1: same-engine, local paths only.
 * Phase 2: cross-engine — pass remoteHost to rsync over SSH to pi@host.
 *
 * Helper mode (idea#168): instance DATA is copied by the root helper
 * /usr/local/sbin/idea-app-data (`sudo -n … copy|send`), which runs
 * `rsync -aHAX --numeric-ids -x` as root so owners and modes survive. App masters
 * (pi-owned) still use rsyncDirectory. Both share progress parsing and
 * cancellation (registerProcess → SIGTERM; sudo relays it to the helper, which
 * stops rsync and dies of the same signal).
 */

import { spawn } from 'child_process'
import { log } from './utils.js'
import { registerProcess, deregisterProcess } from '../data/Operations.js'
import { appDataSudoArgv, appDataErrorMessage, copyArgs, sendArgs } from './appDataHelper.js'

export interface RsyncProgress {
    progressPercent: number
}

export type RsyncProgressCallback = (progress: RsyncProgress) => void

/**
 * Spawn an rsync-like process, report `progress2` percentages, register it for
 * cancellation and reject with `formatError` on failure.
 */
const runRsyncProcess = (
    command: string,
    args: string[],
    formatError: (code: number | null, signal: string | null, stderr: string) => string,
    onProgress?: RsyncProgressCallback,
    opId?: string,
    detached = false,
): Promise<void> => {
    return new Promise((resolve, reject) => {
        log(`${command} ${args.join(' ')}`)

        // detached (helper mode): sudo gets its own process group, so the SIGTERM a
        // cancel sends is relayed to the helper (sudo ignores signals that come from
        // its own process group).
        const proc = spawn(command, args, { detached })
        if (opId) registerProcess(opId, proc)

        let stderr = ''

        proc.stdout?.on('data', (chunk: Buffer) => {
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

        proc.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
        })

        proc.on('close', (code, signal) => {
            if (opId) deregisterProcess(opId)
            if (code === 0) {
                if (onProgress) onProgress({ progressPercent: 100 })
                resolve()
            } else if (signal === 'SIGTERM' || code === 143) {
                reject(new Error(`rsync cancelled (SIGTERM)`))
            } else {
                reject(new Error(formatError(code, signal, stderr)))
            }
        })

        proc.on('error', (err) => {
            if (opId) deregisterProcess(opId)
            reject(new Error(`${command} spawn error: ${err.message}`))
        })
    })
}

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
 *
 * Runs as the Engine user (pi): use it for pi-owned trees (app masters, the
 * copy's prepared compose.yaml/.env), never for instance data (rsyncInstanceData).
 */
export const rsyncDirectory = (
    src: string,
    dest: string,
    onProgress?: RsyncProgressCallback,
    opId?: string,
    remoteHost?: string,
): Promise<void> => {
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

    return runRsyncProcess('rsync', args, (code, _signal, stderr) => `rsync exited with code ${code}: ${stderr.trim()}`, onProgress, opId)
}

/** One instance-data transfer through the root helper. Roots are helper root tokens. */
export type InstanceDataTransfer =
    | { kind: 'copy', srcRoot: string, srcId: string, dstRoot: string, dstId: string }
    | { kind: 'send', srcRoot: string, srcId: string, host: string, dstRoot: string, dstId: string }

/** The helper arguments for a transfer (subcommand first). */
export const instanceDataTransferArgs = (t: InstanceDataTransfer): string[] =>
    t.kind === 'copy'
        ? copyArgs(t.srcRoot, t.srcId, t.dstRoot, t.dstId)
        : sendArgs(t.srcRoot, t.srcId, t.host, t.dstRoot, t.dstId)

/**
 * Copy (same Engine) or send (to `pi@host`, received there by that Engine's helper
 * through rrsync) an instance folder as root, keeping owners, modes, hard links,
 * ACLs and xattrs: `sudo -n /usr/local/sbin/idea-app-data copy|send …`. The helper
 * creates the destination (it must not exist yet, or be empty) and refuses data
 * that links off the instance folder.
 */
export const rsyncInstanceData = (
    t: InstanceDataTransfer,
    onProgress?: RsyncProgressCallback,
    opId?: string,
): Promise<void> => {
    const args = instanceDataTransferArgs(t)
    return runRsyncProcess('sudo', appDataSudoArgv(args),
        (code, signal, stderr) => `rsync (${appDataErrorMessage(t.kind, code, signal, stderr)})`,
        onProgress, opId, true)
}
