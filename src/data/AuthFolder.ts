/**
 * AuthFolder.ts — the Engine-local auth folder (engine#582).
 *
 * Holds what must never sync: operator accounts, the command key, the command
 * sequence files and the command audit log. Mode 0700, files 0600, owned by the
 * user the Engine runs as (pi on a Pi). The path comes from Config.authFolder().
 */

import fs from 'fs'
import path from 'path'
import { authFolder } from './Config.js'

/** Create the auth folder when missing and make sure it is 0700. Returns its path. */
export const ensureAuthFolder = (dir: string = authFolder()): string => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(dir, 0o700) } catch { /* not ours to change (shared temp dir in tests) */ }
    return dir
}

/** Path of a file inside the auth folder. */
export const authFile = (name: string, dir: string = authFolder()): string => path.join(dir, name)

/**
 * Write a file in the auth folder atomically (temp file + rename) with mode 0600,
 * so a crash never leaves half a file and the content is never world-readable.
 */
export const writeAuthFileAtomic = (file: string, data: string | Buffer): void => {
    ensureAuthFolder(path.dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
        fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
}
