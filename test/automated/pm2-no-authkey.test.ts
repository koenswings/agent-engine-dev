/**
 * pm2-no-authkey.test.ts — TAILSCALE_AUTHKEY never reaches pm2 or dump.pm2 (idea#273)
 *
 * Runs the build-engine steps installTailscale → installPm2 → startEnginePM2 with
 * real zx and stub `pm2`, `sudo` and `npm` commands on PATH. The pm2 stub records
 * the environment of every call and, on `pm2 save`, writes a dump.pm2 holding its
 * environment (as real pm2 does for each saved process). The test asserts the key
 * is in none of them, and that `pm2 startup` runs through sudo as user pi.
 * A control case proves the stub would catch a leak.
 *
 * Nothing touches /etc, pm2 or any Pi: installTailscale goes through a recording shell.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { $, fs } from 'zx'
import { ssh } from '../../src/utils/ssh.js'
import { installTailscale, installPm2, startEnginePM2, PM2_LOGROTATE_VERSION } from '../../src/data/Engine.js'

const newKey = () => `tskey-auth-ideatest${crypto.randomBytes(12).toString('hex')}`

/** Records nothing and succeeds: stands in for the remote shell during installTailscale. */
const nullShell = (() => {
    const done = Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    return {
        stdin: { write: () => true, end: () => undefined },
        then: (res: any, rej: any) => done.then(res, rej),
        catch: (rej: any) => done.catch(rej),
    }
}) as unknown as typeof $

describe('build-engine keeps TAILSCALE_AUTHKEY out of pm2 and dump.pm2 (idea#273)', () => {
    let tmp: string
    let bin: string
    let pm2Home: string
    const saved = { path: process.env.PATH, key: process.env.TAILSCALE_AUTHKEY, pm2Home: process.env.PM2_HOME, stub: process.env.IDEA_TEST_PM2_LOG }

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-pm2env-'))
        bin = path.join(tmp, 'bin')
        pm2Home = path.join(tmp, 'pm2home')
        await fs.ensureDir(bin)
        await fs.ensureDir(pm2Home)
        // pm2 stub: logs argv + full env per call; `show` fails (engine not running yet);
        // `save` writes dump.pm2 with its env, like pm2 saving each process's env.
        await fs.writeFile(path.join(bin, 'pm2'), [
            '#!/usr/bin/env bash',
            'n=$(ls "$IDEA_TEST_PM2_LOG" 2>/dev/null | wc -l)',
            '{ printf "ARGV %s\\n" "$*"; env; } > "$IDEA_TEST_PM2_LOG/call-$n"',
            'case "$1" in',
            '  show) exit 1 ;;',
            '  save) env | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e={};for(const l of s.split("\\n")){const i=l.indexOf("=");if(i>0)e[l.slice(0,i)]=l.slice(i+1)};process.stdout.write(JSON.stringify([{name:"engine",env:e}]))})\' > "$PM2_HOME/dump.pm2" ;;',
            'esac',
            'exit 0',
        ].join('\n'), { mode: 0o755 })
        // sudo stub: records argv, skips `npm install -g pm2`, runs the rest as us.
        await fs.writeFile(path.join(bin, 'sudo'), [
            '#!/usr/bin/env bash',
            'printf "%s\\n" "$*" >> "$IDEA_TEST_PM2_LOG/../sudo.log"',
            'if [ "$1" = npm ]; then exit 0; fi',
            'exec "$@"',
        ].join('\n'), { mode: 0o755 })
        await fs.ensureDir(path.join(tmp, 'calls'))
        process.env.IDEA_TEST_PM2_LOG = path.join(tmp, 'calls')
        process.env.PM2_HOME = pm2Home
        process.env.PATH = `${bin}:${saved.path}`
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        for (const [k, v] of [['PATH', saved.path], ['TAILSCALE_AUTHKEY', saved.key], ['PM2_HOME', saved.pm2Home], ['IDEA_TEST_PM2_LOG', saved.stub]] as const) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
        await fs.remove(tmp)
    })

    const pm2Calls = async () => {
        const dir = path.join(tmp, 'calls')
        return Promise.all((await fs.readdir(dir)).sort().map(f => fs.readFile(path.join(dir, f), 'utf8')))
    }

    it('no pm2 call and no dump.pm2 contains the key; pm2 startup runs via sudo as pi', async () => {
        const key = newKey()
        process.env.TAILSCALE_AUTHKEY = key
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`) }) as any)
        const engine = path.join(tmp, 'engine')
        await fs.ensureDir(engine)

        await installTailscale(ssh('pi@idea-test-host.local', nullShell), engine)
        await installPm2($, engine)
        await startEnginePM2($, engine, engine, true)

        expect(exit).not.toHaveBeenCalled()
        expect(process.env.TAILSCALE_AUTHKEY, 'installTailscale drops the key from the env').toBeUndefined()
        const calls = await pm2Calls()
        const argvs = calls.map(c => c.split('\n')[0])
        expect(argvs).toEqual(expect.arrayContaining([
            `ARGV install pm2-logrotate@${PM2_LOGROTATE_VERSION}`, 'ARGV show engine', 'ARGV start pm2.config.cjs --env production', 'ARGV save',
            'ARGV startup systemd -u pi --hp /home/pi',
        ]))
        for (const c of calls) {
            expect(c, 'the key must not be in any pm2 environment').not.toContain(key)
            expect(c).not.toMatch(/^TAILSCALE_AUTHKEY=/m)
        }
        const dump = await fs.readFile(path.join(pm2Home, 'dump.pm2'), 'utf8')
        expect(dump).not.toContain(key)
        expect(dump).not.toContain('TAILSCALE_AUTHKEY')
        const sudoLog = await fs.readFile(path.join(tmp, 'sudo.log'), 'utf8')
        expect(sudoLog, 'pm2 startup runs with sudo').toMatch(/^env -u TAILSCALE_AUTHKEY PATH=\S+ \S*pm2 startup systemd -u pi --hp \/home\/pi$/m)
        expect(sudoLog, 'pm2 start/save never run as root').not.toMatch(/pm2 (start|save)\b/)
    })

    it('control: the stub does record a leaked key, so the test above can fail', async () => {
        const key = newKey()
        process.env.TAILSCALE_AUTHKEY = key
        await $`pm2 save`
        expect(await fs.readFile(path.join(pm2Home, 'dump.pm2'), 'utf8')).toContain(key)
    })
})
