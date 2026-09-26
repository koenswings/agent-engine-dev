/**
 * tailscale-authkey.test.ts — the Tailscale auth key never becomes a command
 * argument, a log line or History (idea#115)
 *
 *   1. installTailscale through the real ssh() helper (with a recording shell
 *      instead of running ssh): the key is in no built command or argument, it is
 *      sent exactly once, over stdin, and it is in no console output and no
 *      command log (History) entry
 *   2. storeTailscaleAuthKey with real zx, tee and install: the key arrives in a
 *      0600 file via stdin; a `sudo` shim records the real argv of every command
 *      and none contains the key
 *   3. The activation script hands the key to `tailscale up` as a file
 *      (`--auth-key=file:`), never as an argument
 *
 * Nothing touches /etc/tailscale or any Pi: paths are redirected into a temp folder.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { $, fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { CommandLogStore, addTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { initCommandLogger, runWithTrace, flushTrace } from '../../src/utils/CommandLogger.js'
import { ssh } from '../../src/utils/ssh.js'
import { installTailscale, storeTailscaleAuthKey, TAILSCALE_AUTHKEY_PATH } from '../../src/data/Engine.js'

const ROOT = process.cwd()
const newKey = () => `tskey-auth-ideatest${crypto.randomBytes(12).toString('hex')}`

interface Recorded { command: string, stdin: string }

/** A stand-in for zx's $ that records each command line and what is written to its stdin. */
const recordingShell = (recorded: Recorded[]) => ((pieces: TemplateStringsArray, ...args: unknown[]) => {
    const entry: Recorded = {
        command: pieces.reduce((acc, p, i) => acc + p + (i < args.length ? ` ${JSON.stringify(args[i])} ` : ''), ''),
        stdin: '',
    }
    recorded.push(entry)
    const done = Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    return {
        stdin: { write: (s: string) => { entry.stdin += s; return true }, end: (s?: string) => { if (s) entry.stdin += s } },
        then: (res: any, rej: any) => done.then(res, rej),
        catch: (rej: any) => done.catch(rej),
    }
}) as unknown as typeof $

describe('installTailscale keeps the auth key out of arguments, logs and History (idea#115)', () => {
    const savedEnv = process.env.TAILSCALE_AUTHKEY
    afterEach(() => {
        vi.restoreAllMocks()
        if (savedEnv === undefined) delete process.env.TAILSCALE_AUTHKEY
        else process.env.TAILSCALE_AUTHKEY = savedEnv
        setCommandLogHandle(null)
    })

    it('sends the key only over stdin, never in a command, log line or History entry', async () => {
        const key = newKey()
        process.env.TAILSCALE_AUTHKEY = key
        const recorded: Recorded[] = []
        const exec = ssh('pi@idea-test-host.local', recordingShell(recorded))

        const logHandle = new Repo({ network: [], storage: undefined })
            .create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        initCommandLogger(logHandle)
        setCommandLogHandle(logHandle)
        const printed: string[] = []
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            const original = console[level]
            vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
                printed.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
                original(...a)
            })
        }
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`) }) as any)

        const traceId = crypto.randomUUID()
        addTrace(logHandle, { traceId, command: 'installTailscale', args: '{}', startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
        await runWithTrace({ traceId, command: 'installTailscale', args: '{}' }, () => installTailscale(exec, '/home/pi/idea/agents/agent-engine-dev'))
        await flushTrace(traceId)

        expect(exit).not.toHaveBeenCalled()
        expect(recorded.length).to.be.greaterThan(3)
        for (const r of recorded) {
            expect(r.command, 'the key must not be in any command or argument').to.not.include(key)
            expect(r.command.startsWith('ssh '), 'every command goes through ssh').to.be.true
        }
        const withKey = recorded.filter(r => r.stdin.includes(key))
        expect(withKey, 'the key is sent exactly once').to.have.length(1)
        expect(withKey[0].stdin).to.equal(key + '\n')
        expect(withKey[0].command).to.match(/umask 077 && sudo tee .*debug-authkey.* > \/dev\/null/)
        expect(recorded.map(r => r.command).join('\n')).to.match(/install -d -m 700 -o root -g root/)

        expect(printed.length, 'installTailscale printed progress').to.be.greaterThan(0)
        expect(printed.join('\n'), 'the key must not be in console output').to.not.include(key)
        expect(JSON.stringify(logHandle.doc()), 'the key must not be in History').to.not.include(key)
        expect(logHandle.doc()!.traces[traceId].logs.length, 'the trace captured the progress lines').to.be.greaterThan(0)
    })
})

describe('storeTailscaleAuthKey with real zx, tee and install (idea#115)', () => {
    let tmp: string
    let savedPath: string | undefined
    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-tskey-'))
        savedPath = process.env.PATH
    })
    afterEach(async () => {
        process.env.PATH = savedPath
        await fs.remove(tmp)
    })

    it('writes the key into a 0600 file via stdin; no process argv holds it', async () => {
        const key = newKey()
        const bin = path.join(tmp, 'bin')
        const argvLog = path.join(tmp, 'argv.log')
        await fs.ensureDir(bin)
        // sudo shim: records its real argv, skips chown and drops "-o root -g root" (we are not root), runs the rest.
        await fs.writeFile(path.join(bin, 'sudo'), [
            '#!/usr/bin/env bash',
            `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
            'args=()',
            'if [ "$1" = chown ]; then exit 0; fi',
            'while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done',
            'exec "${args[@]}"',
        ].join('\n'), { mode: 0o755 })
        process.env.PATH = `${bin}:${savedPath}`

        const dir = path.join(tmp, 'etc-tailscale')
        const file = path.join(dir, 'debug-authkey')
        // Redirect the fixed /etc paths into the temp folder; everything else is the real zx $.
        const exec = (pieces: TemplateStringsArray, ...args: unknown[]) =>
            $(pieces, ...args.map(a => (a === TAILSCALE_AUTHKEY_PATH ? file : a === '/etc/tailscale' ? dir : a)))
        await storeTailscaleAuthKey(exec, key)

        expect(await fs.readFile(file, 'utf8')).to.equal(key + '\n')
        expect((await fs.stat(file)).mode & 0o777).to.equal(0o600)
        expect((await fs.stat(dir)).mode & 0o777).to.equal(0o700)
        const argv = await fs.readFile(argvLog, 'utf8')
        expect(argv).to.match(/^tee .*debug-authkey$/m)
        expect(argv, 'the key is in no sudo argv').to.not.include(key)
    })
})

describe('tailscale-debug-activate.sh (idea#115)', () => {
    it('passes the key to tailscale up as a file, not as an argument', () => {
        const script = fs.readFileSync(path.join(ROOT, 'script/build_image_assets/tailscale-debug-activate.sh'), 'utf8')
        expect(script).to.include('--auth-key="file:$AUTH_KEY_FILE"')
        expect(script).to.not.match(/\$\(cat "\$AUTH_KEY_FILE"\)/)
        expect(script).to.not.match(/--authkey /)
    })

    it('installTailscale no longer builds an echo <key> | tee command', () => {
        const engine = fs.readFileSync(path.join(ROOT, 'src/data/Engine.ts'), 'utf8')
        expect(engine).to.not.match(/echo \$\{authKey\}/)
    })
})
