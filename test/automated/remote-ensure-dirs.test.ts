/**
 * remote-ensure-dirs.test.ts
 *
 * idea#80: the cross-engine copyApp step that creates apps/, instances/ and services/
 * on the remote target disk.
 *   - system disk: sudo with the exact commands from 10-engine.sudoers
 *   - App Disk: no sudo, paths safely single-quoted
 *   - the whole remote command is one ssh argument (nothing runs in the local shell)
 */

import { describe, it, expect, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { $, fs } from 'zx'
import {
    remoteEnsureDirsCommand, remoteEnsureDirsSshArgs, SYSTEM_DISK_ENSURE_DIRS,
} from '../../src/data/CopyMoveApp.js'
import { shellQuote } from '../../src/utils/ssh.js'

describe('remoteEnsureDirsCommand (idea#80)', () => {
    let tmp: string | undefined
    afterEach(async () => { if (tmp) await fs.remove(tmp); tmp = undefined })

    it('system disk: sudo mkdir + non-recursive chown to pi on /apps, /instances, /services', () => {
        for (const root of ['', '/']) {
            const cmd = remoteEnsureDirsCommand(root)
            expect(cmd).toBe(SYSTEM_DISK_ENSURE_DIRS)
            expect(cmd).toBe(
                'sudo /usr/bin/mkdir -p /apps /instances /services && ' +
                'sudo /usr/bin/chown pi:pi /apps /instances /services'
            )
            expect(cmd).not.toMatch(/-R/)
        }
    })

    it('App Disk: plain mkdir -p as pi, no sudo, no chown', () => {
        const cmd = remoteEnsureDirsCommand('/disks/sda1')
        expect(cmd).toBe("mkdir -p '/disks/sda1/apps' '/disks/sda1/instances' '/disks/sda1/services'")
        expect(cmd).not.toMatch(/sudo|chown|&&/)
    })

    it('quotes paths with spaces, quotes and $ so each stays one shell word', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-ensure-'))
        tmp = dir
        const root = path.join(dir, `it's a "disk" $HOME; touch pwned`)
        const cmd = remoteEnsureDirsCommand(root)
        expect(cmd).toBe(`mkdir -p ${shellQuote(root + '/apps')} ${shellQuote(root + '/instances')} ${shellQuote(root + '/services')}`)
        // Run it through a real POSIX shell (locally, in a temp folder) to prove the quoting.
        await $`sh -c ${cmd}`
        for (const d of ['apps', 'instances', 'services']) {
            expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true)
        }
        expect(fs.readdirSync(dir)).toEqual([`it's a "disk" $HOME; touch pwned`])
        expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false)
    })
})

describe('remoteEnsureDirsSshArgs (idea#80)', () => {
    it('passes the whole remote command as ONE ssh argument', () => {
        for (const root of ['', '/disks/sda1']) {
            const args = remoteEnsureDirsSshArgs('10.0.0.2', root)
            expect(args).toEqual(['ssh', '-o', 'StrictHostKeyChecking=no', 'pi@10.0.0.2', '--', remoteEnsureDirsCommand(root)])
        }
    })

    it('zx keeps the remote command (incl. &&) as a single argv entry, as copyApp calls it', async () => {
        const args = remoteEnsureDirsSshArgs('10.0.0.2', '')
        // Same interpolation form as copyApp ($`${argv}`), with ssh swapped for a probe
        // that prints the argv it receives, so nothing is chained in the local shell.
        const probe = ['node', '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args.slice(1)]
        const out = await $`${probe}`
        expect(JSON.parse(out.stdout)).toEqual(args.slice(1))
        expect(JSON.parse(out.stdout).at(-1)).toBe(SYSTEM_DISK_ENSURE_DIRS)
    })
})
