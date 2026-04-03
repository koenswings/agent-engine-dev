import { describe, it, expect, vi } from 'vitest'
import { ssh } from '../../src/utils/ssh.js'
import type { ProcessPromise } from 'zx'

/**
 * Unit tests for src/utils/ssh.ts
 *
 * ssh() is the local drop-in replacement for the zx v7 ssh() helper, which was
 * removed in zx v8. These tests use dependency injection (the optional `shell`
 * parameter) to avoid real SSH connections and module mocking.
 */

// Captures what the injected shell function was called with
function makeCapture() {
    let capturedArgs: unknown[] = []
    const shell = ((pieces: TemplateStringsArray, ...args: unknown[]): ProcessPromise => {
        capturedArgs = args
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) as unknown as ProcessPromise
    }) as typeof import('zx').$

    return { shell, args: () => capturedArgs }
}

describe('ssh() helper', () => {
    it('passes the host as the first interpolated argument', async () => {
        const { shell, args } = makeCapture()
        const exec = ssh('pi@192.168.1.1', shell)
        await exec`echo hello`
        expect(args()[0]).toBe('pi@192.168.1.1')
    })

    it('passes the remote command as the second interpolated argument', async () => {
        const { shell, args } = makeCapture()
        const exec = ssh('pi@host', shell)
        await exec`echo hello`
        expect(args()[1]).toBe('echo hello')
    })

    it('interpolates a single argument into the command', async () => {
        const { shell, args } = makeCapture()
        const exec = ssh('pi@host', shell)
        const path = '/home/pi/idea'
        await exec`cd ${path} && pnpm install`
        expect(args()[1]).toBe("cd '/home/pi/idea' && pnpm install")
    })

    it('interpolates multiple arguments into the command', async () => {
        const { shell, args } = makeCapture()
        const exec = ssh('pi@host', shell)
        const src = '/disks/sda1/instances/app-123'
        const dst = '/disks/sdb1/instances/app-123'
        await exec`rsync -a ${src} ${dst}`
        expect(args()[1]).toBe(
            "rsync -a '/disks/sda1/instances/app-123' '/disks/sdb1/instances/app-123'"
        )
    })

    it('escapes single quotes in interpolated arguments', async () => {
        const { shell, args } = makeCapture()
        const exec = ssh('pi@host', shell)
        const tricky = "it's a trap"
        await exec`echo ${tricky}`
        // Single quote inside the arg must be escaped as '\''
        expect(args()[1]).toBe("echo 'it'\\''s a trap'")
    })

    it('handles a command with no interpolated arguments', async () => {
        const { shell, args } = makeCapture()
        const exec = ssh('pi@host', shell)
        await exec`sudo apt-get update -y`
        expect(args()[1]).toBe('sudo apt-get update -y')
    })

    it('uses the default $ when no shell is injected (smoke — verifies no import error)', () => {
        // Just ensure the function is constructable without injection; do not await
        // (would attempt a real SSH connection)
        const exec = ssh('pi@unreachable-host-for-testing')
        expect(typeof exec).toBe('function')
    })
})
