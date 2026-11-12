/**
 * provision-fleet-authkey.test.ts — default fleet key file and preflight
 *
 * Exercises script/provision-fleet.sh with a fake key and a temp HOME.
 * Never reads or prints a real key, never SSHes to a Pi, never runs the
 * provisioner against a host.
 */

import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { fs, $ } from 'zx'

const ROOT = process.cwd()
const SCRIPT = path.join(ROOT, 'script/provision-fleet.sh')
const FAKE_DEFAULT = 'tskey-auth-FAKE-FAKE-DEFAULT'
const FAKE_OVERRIDE = 'tskey-auth-FAKE-FAKE-OVERRIDE'

interface ResolveResult {
    exitCode: number
    stdout: string
    stderr: string
    resolved: string | null
}

const resolveOnce = async (home: string, args: string[]): Promise<ResolveResult> => {
    const result = await $({
        cwd: ROOT,
        nothrow: true,
        quiet: true,
        env: { ...process.env, HOME: home },
    })`bash -c ${`
        set -euo pipefail
        source ${JSON.stringify(SCRIPT)}
        parse_provision_fleet_args "$@"
        resolve_fleet_authkey
        printf 'RESOLVED=%s\\n' "$AUTHKEY_FILE"
    `} bash ${args}`
    const stdout = result.stdout
    const match = stdout.match(/^RESOLVED=(.*)$/m)
    return {
        exitCode: result.exitCode ?? 0,
        stdout,
        stderr: result.stderr,
        resolved: match ? match[1] : null,
    }
}

const writeKey = async (file: string, contents: string, mode = 0o600) => {
    await fs.ensureDir(path.dirname(file))
    await fs.writeFile(file, contents, { mode })
    // writeFile mode is umask-affected on some systems; force the exact mode.
    await fs.chmod(file, mode)
}

describe('provision-fleet.sh fleet auth key default and preflight', () => {
    it('uses $HOME/.config/idea/fleet-authkey when present and valid', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-fleetkey-'))
        try {
            const def = path.join(home, '.config/idea/fleet-authkey')
            await writeKey(def, FAKE_DEFAULT + '\n')
            const r = await resolveOnce(home, ['dummy=127.0.0.1'])
            expect(r.stderr, r.stderr).toBe('')
            expect(r.exitCode).toBe(0)
            expect(r.resolved).toBe(def)
            expect(r.stdout + r.stderr).not.toContain(FAKE_DEFAULT)
        } finally {
            await fs.remove(home)
        }
    })

    it('--authkey-file overrides the default file', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-fleetkey-'))
        try {
            const def = path.join(home, '.config/idea/fleet-authkey')
            const override = path.join(home, 'override-key')
            await writeKey(def, FAKE_DEFAULT + '\n')
            await writeKey(override, FAKE_OVERRIDE + '\n')
            const r = await resolveOnce(home, ['--authkey-file', override, 'dummy=127.0.0.1'])
            expect(r.exitCode).toBe(0)
            expect(r.resolved).toBe(override)
            expect(r.stdout + r.stderr).not.toContain(FAKE_DEFAULT)
            expect(r.stdout + r.stderr).not.toContain(FAKE_OVERRIDE)
        } finally {
            await fs.remove(home)
        }
    })

    it('refuses a default file with mode 644', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-fleetkey-'))
        try {
            const def = path.join(home, '.config/idea/fleet-authkey')
            await writeKey(def, FAKE_DEFAULT + '\n', 0o644)
            const r = await resolveOnce(home, ['dummy=127.0.0.1'])
            expect(r.exitCode).toBe(2)
            expect(r.stderr).toMatch(/has mode 644, must be 600/)
            expect(r.resolved).toBeNull()
            expect(r.stdout + r.stderr).not.toContain(FAKE_DEFAULT)
        } finally {
            await fs.remove(home)
        }
    })

    it('refuses an empty key file', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-fleetkey-'))
        try {
            const def = path.join(home, '.config/idea/fleet-authkey')
            await writeKey(def, '')
            const r = await resolveOnce(home, ['dummy=127.0.0.1'])
            expect(r.exitCode).toBe(2)
            expect(r.stderr).toMatch(/is empty/)
            expect(r.resolved).toBeNull()
        } finally {
            await fs.remove(home)
        }
    })

    it('refuses a missing explicit --authkey-file', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-fleetkey-'))
        try {
            const missing = path.join(home, 'does-not-exist')
            const r = await resolveOnce(home, ['--authkey-file', missing, 'dummy=127.0.0.1'])
            expect(r.exitCode).toBe(2)
            expect(r.stderr).toMatch(/missing or not a regular file/)
            expect(r.resolved).toBeNull()
        } finally {
            await fs.remove(home)
        }
    })

    it('a missing default file falls through (not fatal)', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-fleetkey-'))
        try {
            const r = await resolveOnce(home, ['dummy=127.0.0.1'])
            expect(r.exitCode).toBe(0)
            expect(r.resolved).toBe('')
            expect(r.stderr).toBe('')
        } finally {
            await fs.remove(home)
        }
    })

    it('refuses a symlink key file (stat -c %a without -L sees 777)', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-fleetkey-'))
        try {
            const target = path.join(home, 'real-key')
            const def = path.join(home, '.config/idea/fleet-authkey')
            await writeKey(target, FAKE_DEFAULT + '\n')
            await fs.ensureDir(path.dirname(def))
            await fs.symlink(target, def)
            const r = await resolveOnce(home, ['dummy=127.0.0.1'])
            expect(r.exitCode).toBe(2)
            expect(r.stderr).toMatch(/has mode 777, must be 600/)
            expect(r.stdout + r.stderr).not.toContain(FAKE_DEFAULT)
        } finally {
            await fs.remove(home)
        }
    })
})
