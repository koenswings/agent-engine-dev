/**
 * remote-ensure-dirs.test.ts
 *
 * idea#80: the cross-engine copyApp step that creates apps/, instances/ and services/
 * on the remote target disk. With per-Pi Engine keys this is no longer a plain
 * `ssh pi@peer mkdir …` (or sudo mkdir/chown on the system disk): the peer's gate
 * runs that Engine's helper, `idea-app-data ensure-dirs <root>`, which builds the
 * paths from the root token and gives the folders to pi.
 *   - the ssh argv: this Engine's key, the peer's host key pinned by Engine id, ONE
 *     remote command (nothing runs in the local shell)
 *   - the helper: system disk, App Disk and a test slot; existing folders kept;
 *     a symlinked folder refused; through the gate end to end
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import { $, fs } from 'zx'
import { remoteEnsureDirsSshArgs } from '../../src/utils/appDataHelper.js'
import { peerSshOptions } from '../../src/utils/peerSsh.js'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

describe('remoteEnsureDirsSshArgs (idea#80, per-Pi Engine keys)', () => {
    it('passes the whole remote command as ONE ssh argument, with the peer options', () => {
        for (const root of ['system', 'sdb1', 'idea-test-3']) {
            const args = remoteEnsureDirsSshArgs('10.0.0.2', 'ENGINE_peer2', root)
            expect(args).toEqual(['ssh', ...peerSshOptions('ENGINE_peer2'), 'pi@10.0.0.2', '--', `sudo -n /usr/local/sbin/idea-app-data ensure-dirs ${root}`])
        }
        expect(() => remoteEnsureDirsSshArgs('10.0.0.2', 'ENGINE_peer2', "/disks/it's")).toThrow(/not a disk root/)
    })

    it('zx keeps the remote command as a single argv entry, as copyApp calls it', async () => {
        const args = remoteEnsureDirsSshArgs('10.0.0.2', 'ENGINE_peer2', 'system')
        const probe = ['node', '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args.slice(1)]
        const out = await $`${probe}`
        expect(JSON.parse(out.stdout)).toEqual(args.slice(1))
        expect(JSON.parse(out.stdout).at(-1)).toBe('sudo -n /usr/local/sbin/idea-app-data ensure-dirs system')
    })
})

describe('idea-app-data ensure-dirs (idea#80)', () => {
    let sb: AppDataSandbox
    beforeEach(async () => { sb = await makeAppDataSandbox() })
    afterEach(async () => { await fs.remove(sb.tmp) })

    const owner = (p: string) => fs.statSync(p).uid

    it('system disk: /apps, /instances, /services, owned by the Engine user', async () => {
        const r = await sb.run(['ensure-dirs', 'system'])
        expect(r.exitCode, r.stderr).toBe(0)
        for (const d of ['apps', 'instances', 'services']) {
            expect(fs.statSync(path.join(sb.sys, d)).isDirectory()).toBe(true)
            expect(owner(path.join(sb.sys, d))).toBe(os.userInfo().uid)
        }
    })

    it('App Disk: the folders on /disks/<dev>; existing ones and their content are kept', async () => {
        const root = await sb.addDisk('sdb1')
        await fs.ensureDir(path.join(root, 'apps', 'kolibri-1.0'))
        const r = await sb.run(['ensure-dirs', 'sdb1'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(await fs.readdir(root)).toEqual(expect.arrayContaining(['apps', 'instances', 'services', 'META.yaml']))
        expect(await fs.pathExists(path.join(root, 'apps', 'kolibri-1.0'))).toBe(true)
    })

    it('refuses a symlinked folder, a path for a root, and extra arguments', async () => {
        const root = await sb.addDisk('sdb1')
        await fs.symlink('/tmp', path.join(root, 'services'))
        const r = await sb.run(['ensure-dirs', 'sdb1'])
        expect(r.exitCode).toBe(2)
        expect(r.stderr).toMatch(/refused: services folder .* is a symlink/)
        const r2 = await sb.run(['ensure-dirs', '/disks/sdb1'])
        expect(r2.exitCode).toBe(2)
        const r3 = await sb.run(['ensure-dirs', 'sdb1', 'x'])
        expect(r3.stderr).toMatch(/ensure-dirs takes exactly 1 argument/)
    })

    it('through the gate: a peer key may run ensure-dirs (and nothing like mkdir)', async () => {
        await sb.addDisk('sdc1')
        const ok = await sb.runGate(['ENGINE_peer2'], 'sudo -n /usr/local/sbin/idea-app-data ensure-dirs sdc1')
        expect(ok.exitCode, ok.stderr).toBe(0)
        expect(await fs.pathExists(path.join(sb.disks, 'sdc1', 'services'))).toBe(true)
        const no = await sb.runGate(['ENGINE_peer2'], `mkdir -p ${path.join(sb.disks, 'sdc1', 'x')}`)
        expect(no.exitCode).toBe(2)
        expect(await fs.pathExists(path.join(sb.disks, 'sdc1', 'x'))).toBe(false)
    })
})
