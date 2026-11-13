/**
 * idea-usage-settings.test.ts — operator toggle for usageMonitoring (idea#411)
 *
 * The script is invoked directly (operators and tools/fleet run it as pi).
 * IDEA_USAGE_ROOT points at a temp tree so tests never touch /var/lib/idea/usage.
 * It must never call pm2, docker or compose.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path, os } from 'zx'
import { spawn } from 'child_process'

const SCRIPT = path.resolve('script/build_image_assets/idea-usage-settings')

interface RunResult { exitCode: number | null, stdout: string, stderr: string }

const run = (opts: {
    args?: string[]
    env?: Record<string, string | undefined>
    root: string
    extraPath?: string
}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, IDEA_USAGE_ROOT: opts.root }
        if (opts.extraPath) env.PATH = `${opts.extraPath}${path.delimiter}${env.PATH ?? ''}`
        if (opts.env) {
            for (const [k, v] of Object.entries(opts.env)) {
                if (v === undefined) delete env[k]
                else env[k] = v
            }
        }
        const proc = spawn(SCRIPT, opts.args ?? [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', d => { stdout += d })
        proc.stderr.on('data', d => { stderr += d })
        proc.on('error', reject)
        proc.on('close', exitCode => resolve({ exitCode, stdout, stderr }))
    })

let root = ''
let trapDir = ''
let trapLog = ''
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-usage-settings-'))
    trapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-usage-settings-path-'))
    trapLog = path.join(trapDir, 'called.log')
    for (const name of ['pm2', 'docker', 'systemctl', 'docker-compose']) {
        const dest = path.join(trapDir, name)
        await fs.writeFile(dest, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "${trapLog}"\nexit 99\n`)
        await fs.chmod(dest, 0o755)
    }
})
afterEach(async () => {
    await fs.remove(root)
    await fs.remove(trapDir)
})

const settingsFile = () => path.join(root, 'settings.json')

describe('idea-usage-settings: argument checks', () => {
    it('rejects anything but on, off and status', async () => {
        const bad = [
            [],
            ['ON'],
            ['enable'],
            ['disable'],
            ['since'],
            ['since', '2026-11-01'],
            ['on', 'extra'],
            ['off', '--force'],
            ['status', 'now'],
            ['archive-and-clear'],
        ]
        for (const args of bad) {
            const r = await run({ root, args, extraPath: trapDir })
            expect(r.exitCode, JSON.stringify(args) + r.stderr).toBe(2)
            expect(r.stdout).toBe('')
            expect(r.stderr).toBe('invalid arguments\n')
        }
        expect(await fs.pathExists(settingsFile())).toBe(false)
        expect(await fs.pathExists(trapLog)).toBe(false)
    })

    it('rejects shell metacharacters and empty SSH_ORIGINAL_COMMAND with no argv', async () => {
        for (const cmd of ['on; rm -rf /', 'off && id', '$(id)', '`id`', 'status | cat', 'on\nstatus']) {
            const r = await run({ root, args: [], env: { SSH_ORIGINAL_COMMAND: cmd }, extraPath: trapDir })
            expect(r.exitCode, cmd).toBe(2)
            expect(r.stdout).toBe('')
            expect(r.stderr).toBe('invalid arguments\n')
        }
        const empty = await run({ root, args: [], env: { SSH_ORIGINAL_COMMAND: '' }, extraPath: trapDir })
        expect(empty.exitCode).toBe(2)
        expect(empty.stdout).toBe('')
        expect(empty.stderr).toBe('invalid arguments\n')
        expect(await fs.pathExists(settingsFile())).toBe(false)
        expect(await fs.pathExists(trapLog)).toBe(false)
    })

    it('accepts the three verbs via argv and via SSH_ORIGINAL_COMMAND', async () => {
        const viaArgv = await run({ root, args: ['status'], extraPath: trapDir })
        expect(viaArgv.exitCode, viaArgv.stderr).toBe(0)
        expect(viaArgv.stdout).toBe('off\n')
        const viaEnv = await run({ root, args: ['ignored'], env: { SSH_ORIGINAL_COMMAND: 'on' }, extraPath: trapDir })
        expect(viaEnv.exitCode, viaEnv.stderr).toBe(0)
        expect(viaEnv.stdout).toBe('on\n')
        expect(await fs.readFile(settingsFile(), 'utf8')).toBe('{"usageMonitoring":"on"}\n')
        const viaOff = await run({ root, args: [], env: { SSH_ORIGINAL_COMMAND: 'off' }, extraPath: trapDir })
        expect(viaOff.exitCode, viaOff.stderr).toBe(0)
        expect(viaOff.stdout).toBe('off\n')
        expect(await fs.readFile(settingsFile(), 'utf8')).toBe('{"usageMonitoring":"off"}\n')
    })
})

describe('idea-usage-settings: default off and idempotency', () => {
    it('missing file is off and off does not create it', async () => {
        const status = await run({ root, args: ['status'], extraPath: trapDir })
        expect(status.exitCode).toBe(0)
        expect(status.stdout).toBe('off\n')
        expect(status.stderr).toBe('')
        const off = await run({ root, args: ['off'], extraPath: trapDir })
        expect(off.exitCode).toBe(0)
        expect(off.stdout).toBe('off\n')
        expect(await fs.pathExists(settingsFile())).toBe(false)
        expect(await fs.readdir(root)).toEqual([])
    })

    it('on twice and off twice exit 0 without rewriting', async () => {
        const firstOn = await run({ root, args: ['on'], extraPath: trapDir })
        expect(firstOn.exitCode).toBe(0)
        expect(firstOn.stdout).toBe('on\n')
        const beforeOn = await fs.stat(settingsFile())
        await new Promise(r => setTimeout(r, 20))
        const secondOn = await run({ root, args: ['on'], extraPath: trapDir })
        expect(secondOn.exitCode).toBe(0)
        expect(secondOn.stdout).toBe('on\n')
        const afterOn = await fs.stat(settingsFile())
        expect(afterOn.ino).toBe(beforeOn.ino)
        expect(afterOn.mtimeMs).toBe(beforeOn.mtimeMs)
        expect(await fs.readFile(settingsFile(), 'utf8')).toBe('{"usageMonitoring":"on"}\n')

        const firstOff = await run({ root, args: ['off'], extraPath: trapDir })
        expect(firstOff.exitCode).toBe(0)
        expect(firstOff.stdout).toBe('off\n')
        const beforeOff = await fs.stat(settingsFile())
        await new Promise(r => setTimeout(r, 20))
        const secondOff = await run({ root, args: ['off'], extraPath: trapDir })
        expect(secondOff.exitCode).toBe(0)
        expect(secondOff.stdout).toBe('off\n')
        const afterOff = await fs.stat(settingsFile())
        expect(afterOff.ino).toBe(beforeOff.ino)
        expect(afterOff.mtimeMs).toBe(beforeOff.mtimeMs)
        expect(await fs.readFile(settingsFile(), 'utf8')).toBe('{"usageMonitoring":"off"}\n')
    })
})

describe('idea-usage-settings: no process restarts', () => {
    it('never mentions or invokes a pm2/docker restart command', async () => {
        const src = await fs.readFile(SCRIPT, 'utf8')
        expect(src).not.toMatch(/pm2 (restart|stop|delete|start)|stopInstance|startInstance|compose (restart|down)|docker compose (restart|down)/)
        expect(src).not.toMatch(/subprocess|os\.system|Popen|systemctl/)
        await run({ root, args: ['on'], extraPath: trapDir })
        await run({ root, args: ['off'], extraPath: trapDir })
        await run({ root, args: ['status'], extraPath: trapDir })
        expect(await fs.pathExists(trapLog)).toBe(false)
        const names = (await fs.readdir(root)).sort()
        expect(names).toEqual(['settings.json'])
    })
})
