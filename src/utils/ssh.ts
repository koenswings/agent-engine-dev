import { $ } from 'zx'
import type { ProcessPromise } from 'zx'

/**
 * Minimal ssh() helper — replaces zx v7's built-in ssh() which was removed in v8.
 *
 * Creates a tagged-template executor that runs commands on a remote host via SSH.
 * Each interpolated argument is single-quote shell-escaped before being sent.
 *
 * Usage (identical to zx v7 ssh):
 *   const exec = ssh('pi@192.168.1.1')
 *   await exec`sudo apt-get update`
 *   await exec`cd ${path} && pnpm install`
 */
export function ssh(host: string) {
    return (pieces: TemplateStringsArray, ...args: unknown[]): ProcessPromise => {
        const cmd = pieces.reduce((acc: string, piece: string, i: number) => {
            if (i >= args.length) return acc + piece
            // Single-quote escape — args are developer-controlled paths/values, not user input
            const escaped = "'" + String(args[i]).replace(/'/g, "'\\''") + "'"
            return acc + piece + escaped
        }, '')
        return $`ssh -o StrictHostKeyChecking=no ${host} -- ${cmd}`
    }
}
