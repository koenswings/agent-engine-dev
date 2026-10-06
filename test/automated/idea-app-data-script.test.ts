/**
 * idea-app-data-script.test.ts — the app-data root helper's refusals and argv (idea#168)
 *
 * Runs a copy of script/build_image_assets/idea-app-data with its constants
 * rewritten (test/harness/appDataSandbox.ts): fake rsync/rrsync/borg/findmnt/
 * getent/logger, temp folders for /disks, /instances, /etc/idea/app-data-roots and
 * /run/lock, and the test user as "root". Never runs as root, never touches /disks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox, HELPER_SOURCE } from '../harness/appDataSandbox.js'
import { APP_DATA_HELPER, APP_DATA_HELPER_VERSION } from '../../src/utils/appDataHelper.js'
import { peerSshOptions, PEER_KNOWN_HOSTS } from '../../src/utils/peerSsh.js'

let sb: AppDataSandbox
const created: AppDataSandbox[] = []
const sandbox = async (o: Parameters<typeof makeAppDataSandbox>[0] = {}) => {
    const s = await makeAppDataSandbox(o)
    created.push(s)
    return s
}

beforeEach(async () => { sb = await sandbox() })
afterEach(async () => {
    for (const s of created.splice(0)) await fs.remove(s.tmp)
})

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/^refused: /m)
    expect(r.stderr).toMatch(re)
}

/** A bridge layout: <tmp>/pool (owned by the test user = "root", 0755) /<slot> */
const addBridge = async (s: AppDataSandbox, slots: string[], extraLines: string[] = []) => {
    const pool = path.join(s.tmp, 'pool')
    await fs.ensureDir(pool)
    await fs.chmod(pool, 0o755)
    const roots: Record<string, string> = {}
    for (const slot of slots) {
        const root = path.join(pool, slot)
        await fs.ensureDir(path.join(root, 'instances'))
        await fs.writeFile(path.join(root, 'META.yaml'), `diskId: ${slot}\n`)
        roots[slot] = root
    }
    await fs.writeFile(s.rootsFile, ['# TEST-ONLY root bridge (idea#168)', ...Object.values(roots), ...extraLines].join('\n') + '\n')
    await fs.chmod(s.rootsFile, 0o644)
    return roots
}

describe('idea-app-data: the source script (idea#168)', () => {
    it('is executable bash with fixed PATH/umask/LC_ALL, absolute binaries, borg settings and the TEST-ONLY bridge label', async () => {
        const text = await fs.readFile(HELPER_SOURCE, 'utf8')
        expect((await fs.stat(HELPER_SOURCE)).mode & 0o111).not.toBe(0)
        expect(text.split('\n')[0]).toBe('#!/bin/bash')
        expect(text).toMatch(/^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m)
        expect(text).toMatch(/^umask 022$/m)
        expect(text).toMatch(/^export LC_ALL=C$/m)
        expect(text).toContain('export BORG_RELOCATED_REPO_ACCESS_IS_OK=yes')
        expect(text).toContain('export BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=yes')
        expect(text).toMatch(/RSYNC_OPTS=\(-aHAX --numeric-ids -x --info=progress2 --no-inc-recursive\)/)
        expect(text).toMatch(/\$BORG create --numeric-ids -- /)
        expect(text).toMatch(/\$BORG extract --numeric-ids --strip-components/)
        expect(text).toMatch(/\$RRSYNC -wo /)
        expect(text).toMatch(/LOGGER -t idea-app-data -p auth\.notice/)
        expect(text).toMatch(/TEST-ONLY root bridge/)
        expect(text).toMatch(/test-only root bridge: \$tok -> \$b/)
        expect(text).toMatch(/^ROOTS_FILE=\/etc\/idea\/app-data-roots$/m)
        expect(text).toMatch(/^HELPER_PATH=\/usr\/local\/sbin\/idea-app-data$/m)
        expect(text).not.toMatch(/\beval\b/)
        expect(text).not.toMatch(/bash -c|sh -c/)
        // Every external command is a $VAR set to an absolute path
        for (const m of text.matchAll(/^([A-Z_]+)=(\/\S+)$/gm)) {
            if (['PATH', 'DISKS_DIR', 'ROOTS_FILE', 'LOCK_DIR', 'ROOT_HOME', 'HELPER_PATH',
                'PEER_KEY', 'PEER_KNOWN_HOSTS', 'PEER_AUTH_DIR', 'PEER_GATE', 'LEDGER_DIR'].includes(m[1])) continue
            expect(m[2], m[1]).toMatch(/^\/usr\/(s?bin)\/[a-z.]+$/)
        }
    })

    it('version prints the version the Engine expects', async () => {
        const text = await fs.readFile(HELPER_SOURCE, 'utf8')
        expect(text).toMatch(new RegExp(`^readonly IDEA_APP_DATA_VERSION=${APP_DATA_HELPER_VERSION}$`, 'm'))
        const r = await sb.run(['version'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe(`idea-app-data ${APP_DATA_HELPER_VERSION}`)
        expect(APP_DATA_HELPER).toBe('/usr/local/sbin/idea-app-data')
    })

    it('refuses to run when it is not root', async () => {
        const s = await sandbox({ rootUid: process.getuid!() + 1 })
        refused(await s.run(['version']), /must run as root/)
    })
})

describe('idea-app-data: argument checks', () => {
    it('refuses a missing or unknown subcommand', async () => {
        refused(await sb.run([]), /no subcommand/)
        refused(await sb.run(['exec']), /unknown subcommand 'exec'/)
        refused(await sb.run(['--help']), /unknown subcommand/)
    })

    it('refuses the wrong argument count for every subcommand', async () => {
        const cases: [string, number][] = [
            ['version', 0], ['size', 2], ['copy', 4], ['send', 6], ['delete', 2],
            ['borg-init', 2], ['borg-info', 2], ['borg-create', 4], ['borg-extract', 5],
            ['ensure-dirs', 1], ['peer-delete', 3], ['sync-peers', 0],
        ]
        for (const [sub, n] of cases) {
            for (const count of [n - 1, n + 1]) {
                if (count < 0) continue
                const r = await sb.run([sub, ...Array(count).fill('x')])
                refused(r, new RegExp(`${sub} takes exactly ${n} argument`))
            }
        }
        refused(await sb.run(['receive', 'sdb1', 'id1', '--server']), /receive takes <dstRoot> <dstId> and the rsync server arguments/)
    })

    it('refuses bad roots, ids, archives, strips and hosts (.., leading -, /, case, length)', async () => {
        await sb.addDisk('sdb1')
        for (const root of ['..', '-x', '/disks/sdb1', 'sdb1/../..', 'SDB1', 'a b', '', '-rf']) {
            refused(await sb.run(['size', root, 'inst1']), /root '.*' is not sd\[a-z\]\[12\]|unknown root/)
        }
        for (const id of ['..', '-rf', 'a/b', 'Inst', 'a..b', 'x'.repeat(65), '', '.hidden']) {
            refused(await sb.run(['size', 'sdb1', id]), /instance id '.*' does not match/)
        }
        await sb.addDisk('sdc1', { backup: true })
        for (const archive of ['latest', '2026-10-06', '../2026-10-06T10-00-00-000Z', '-2026-10-06T10-00-00Z', '2026-10-06T10:00:00Z']) {
            refused(await sb.run(['borg-create', 'sdc1', 'inst1', archive, 'sdb1']), /archive name '.*' does not match/)
        }
        for (const strip of ['0', '10', '-1', 'a', '']) {
            refused(await sb.run(['borg-extract', 'sdc1', 'inst1', '2026-10-06T10-00-00-000Z', strip, 'sdb1']), /strip '.*' does not match/)
        }
        await sb.addInstance(path.join(sb.disks, 'sdb1'), 'inst1')
        for (const host of ['-oProxyCommand=touch /tmp/pwned', '-oProxyCommand=x', 'a/b', 'idea04..local', 'host name', '']) {
            refused(await sb.run(['send', 'sdb1', 'inst1', host, 'ENGINE_peer4', 'sdc1', 'new1']), /host '.*' is not an IPv4 address or host name/)
        }
        expect(await sb.calls('rsync')).toEqual([])
    })
})

describe('idea-app-data: Engine disk checks', () => {
    it('refuses a disk that is not mounted, mounted from another device, not ext4, or the system disk', async () => {
        await fs.ensureDir(path.join(sb.disks, 'sdb1', 'instances', 'inst1'))   // a folder, no mount
        refused(await sb.run(['size', 'sdb1', 'inst1']), /is not a mount point/)

        const s2 = await sandbox()
        await s2.addDisk('sdb1', { source: '/dev/sdc1' })
        refused(await s2.run(['size', 'sdb1', 'inst1']), /mounted from \/dev\/sdc1, not \/dev\/sdb1/)

        const s3 = await sandbox()
        await s3.addDisk('sdb1', { fstype: 'vfat' })
        refused(await s3.run(['size', 'sdb1', 'inst1']), /not ext4 \(got vfat\)/)

        const s4 = await sandbox()
        await fs.writeFile(s4.mounts, '/ /dev/sdb2 ext4\n')
        await s4.addDisk('sdb2')
        refused(await s4.run(['size', 'sdb2', 'inst1']), /holds the root filesystem/)

        const s5 = await sandbox()   // root on sda2: sda1 is on the system drive
        await s5.addDisk('sda1')
        refused(await s5.run(['size', 'sda1', 'inst1']), /is on the system drive/)
    })

    it('refuses a disk without META.yaml, and borg verbs on a disk without BACKUP.yaml', async () => {
        const root = await sb.addDisk('sdb1')
        await sb.addInstance(root, 'inst1')
        await fs.remove(path.join(root, 'META.yaml'))
        refused(await sb.run(['size', 'sdb1', 'inst1']), /no META\.yaml at the root/)
        await sb.addDisk('sdc1')
        refused(await sb.run(['borg-init', 'sdc1', 'inst1']), /no BACKUP\.yaml at the root/)
        refused(await sb.run(['borg-info', 'system', 'inst1']), /a Backup Disk is never the system disk/)
    })

    it('refuses a symlinked disk root and a symlinked instances/ folder', async () => {
        const real = path.join(sb.tmp, 'elsewhere')
        await fs.ensureDir(path.join(real, 'instances', 'inst1'))
        await fs.writeFile(path.join(real, 'META.yaml'), 'diskId: x\n')
        await fs.symlink(real, path.join(sb.disks, 'sdb1'))
        await fs.appendFile(sb.mounts, `${path.join(sb.disks, 'sdb1')} /dev/sdb1 ext4\n`)
        refused(await sb.run(['size', 'sdb1', 'inst1']), /is not a folder \(missing, or a symlink in its path\)/)

        const root = await sb.addDisk('sdc1')
        await fs.remove(path.join(root, 'instances'))
        await fs.symlink(path.join(real, 'instances'), path.join(root, 'instances'))
        refused(await sb.run(['size', 'sdc1', 'inst1']), /a symlink in its path/)
        refused(await sb.run(['delete', 'sdc1', 'inst1']), /a symlink in its path/)
        expect(await fs.pathExists(path.join(real, 'instances', 'inst1'))).toBe(true)
    })

    it('size: du -sk -x of the instance as KB on stdout; system means /instances/<id>', async () => {
        const root = await sb.addDisk('sdb1')
        await sb.addInstance(root, 'inst1')
        const r = await sb.run(['size', 'sdb1', 'inst1'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toMatch(/^[0-9]+$/)
        await sb.addInstance(sb.sys, 'sysinst')
        const s = await sb.run(['size', 'system', 'sysinst'])
        expect(s.exitCode, s.stderr).toBe(0)
        expect(parseInt(s.stdout, 10)).toBeGreaterThan(0)
    })
})

describe('idea-app-data: copy', () => {
    it('runs rsync -aHAX --numeric-ids -x in the source folder into the created destination', async () => {
        const src = await sb.addDisk('sdb1')
        const dst = await sb.addDisk('sdc1')
        await sb.addInstance(src, 'kolibri-grade5a-001')
        const r = await sb.run(['copy', 'sdb1', 'kolibri-grade5a-001', 'sdc1', 'vqex2m781czu104tzkp'])
        expect(r.exitCode, r.stderr).toBe(0)
        const [call] = await sb.calls('rsync')
        expect(call.argv.slice(0, -1)).toEqual(['-aHAX', '--numeric-ids', '-x', '--info=progress2', '--no-inc-recursive', '--', './'])
        expect(call.argv.at(-1)).toMatch(/^\/proc\/self\/fd\/\d+\/$/)
        expect(call.cwd).toBe(path.join(src, 'instances', 'kolibri-grade5a-001'))
        expect(call.env.LC_ALL).toBe('C')
        expect(call.env.PATH).toBe('/usr/sbin:/usr/bin:/sbin:/bin')
        expect(await fs.readFile(path.join(dst, 'instances', 'vqex2m781czu104tzkp', 'compose.yaml'), 'utf8')).toBe('services: {}\n')
        expect(r.stdout).toMatch(/100%/)   // progress passes through
    })

    it('refuses a destination that already exists and is not empty; accepts an empty one', async () => {
        const src = await sb.addDisk('sdb1')
        const dst = await sb.addDisk('sdc1')
        await sb.addInstance(src, 'inst1')
        await fs.ensureDir(path.join(dst, 'instances', 'new1'))
        await fs.writeFile(path.join(dst, 'instances', 'new1', 'x'), 'x')
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1']), /already exists and is not empty/)
        await fs.ensureDir(path.join(dst, 'instances', 'new2'))
        expect((await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new2'])).exitCode).toBe(0)
        await fs.symlink(path.join(sb.tmp), path.join(dst, 'instances', 'new3'))
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new3']), /destination .* is a symlink/)
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdb1', 'inst1']), /source and destination are the same folder/)
        expect((await sb.calls('rsync')).length).toBe(1)
    })

    it('refuses source data with a link out of the slot (absolute, relative escape, chained), before creating anything', async () => {
        const src = await sb.addDisk('sdb1')
        const dst = await sb.addDisk('sdc1')
        const inst = await sb.addInstance(src, 'inst1')
        await fs.symlink('/etc/passwd', path.join(inst, 'data', 'abs'))
        let r = await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1'])
        refused(r, /links off the slot: 'data\/abs' -> '\/etc\/passwd'/)
        await fs.remove(path.join(inst, 'data', 'abs'))
        await fs.symlink('../../../other/db', path.join(inst, 'data', 'rel'))
        refused(await sb.run(['copy', 'sdb1', 'inst1', 'sdc1', 'new1']), /'data\/rel' ->/)
        await fs.remove(path.join(inst, 'data', 'rel'))
        // chain: a link inside the slot that points at a link leaving it
        await fs.symlink('/tmp', path.join(inst, 'data', 'hop2'))
        await fs.symlink('hop2', path.join(inst, 'data', 'hop1'))
        refused(await sb.run(['send', 'sdb1', 'inst1', '10.0.0.4', 'ENGINE_peer4', 'sdc1', 'new1']), /'data\/hop1' -> '\/tmp'.*'data\/hop2'|'data\/hop2'.*'data\/hop1'/)
        expect(await fs.pathExists(path.join(dst, 'instances', 'new1'))).toBe(false)
        expect(await sb.calls('rsync')).toEqual([])
    })
})

describe('idea-app-data: send and receive', () => {
    beforeEach(async () => {
        await sb.addInstance(await sb.addDisk('sdb1'), 'inst1')
    })

    it('sends to a private address: runuser -u pi ssh with the Engine key and the pinned host key (HostKeyAlias=<peer>), the remote helper receive as --rsync-path, pi@<ip>:.', async () => {
        const r = await sb.run(['send', 'sdb1', 'inst1', '10.0.0.4', 'ENGINE_peer4', 'sdc1', 'new1'])
        expect(r.exitCode, r.stderr).toBe(0)
        const [call] = await sb.calls('rsync')
        expect(call.argv).toEqual([
            '-aHAX', '--numeric-ids', '-x', '--info=progress2', '--no-inc-recursive',
            '-e', `${sb.bin}/runuser -u pi -- /usr/bin/ssh ${peerSshOptions('ENGINE_peer4').join(' ').replace(PEER_KNOWN_HOSTS, sb.peerKnownHosts)}`,
            '--rsync-path=/usr/bin/sudo -n /usr/local/sbin/idea-app-data receive sdc1 new1',
            '--', './', 'pi@10.0.0.4:.',
        ])
        expect(call.cwd).toBe(path.join(sb.disks, 'sdb1', 'instances', 'inst1'))
    })

    it('accepts 10/8, 172.16/12, 192.168/16, 100.64/10 and a host name that resolves only to those (connects to the resolved address)', async () => {
        for (const ip of ['10.255.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20', '100.64.0.1', '100.127.255.254']) {
            const r = await sb.run(['send', 'sdb1', 'inst1', ip, 'ENGINE_peer4', 'sdc1', 'new1'])
            expect(r.exitCode, `${ip}: ${r.stderr}`).toBe(0)
        }
        await fs.writeFile(sb.hosts, 'idea04.local 192.168.1.44\nidea04.tail.ts.net 100.101.102.103\n')
        expect((await sb.run(['send', 'sdb1', 'inst1', 'idea04.local', 'ENGINE_peer4', 'sdc1', 'new1'])).exitCode).toBe(0)
        expect((await sb.calls('rsync')).at(-1)!.argv.at(-1)).toBe('pi@192.168.1.44:.')
        expect((await sb.run(['send', 'sdb1', 'inst1', 'idea04.tail.ts.net', 'ENGINE_peer4', 'sdc1', 'new1'])).exitCode).toBe(0)
        expect((await sb.calls('rsync')).at(-1)!.argv.at(-1)).toBe('pi@100.101.102.103:.')
    })

    it('refuses a public IP, loopback, near-miss ranges and an unresolvable host', async () => {
        refused(await sb.run(['send', 'sdb1', 'inst1', '8.8.8.8', 'ENGINE_peer4', 'sdc1', 'new1']), /resolves to 8\.8\.8\.8, which is not a private LAN .* or Tailscale/)
        refused(await sb.run(['send', 'sdb1', 'inst1', '127.0.0.1', 'ENGINE_peer4', 'sdc1', 'new1']), /resolves to loopback 127\.0\.0\.1/)
        for (const ip of ['172.32.0.1', '172.15.255.255', '192.169.0.1', '100.128.0.1', '100.63.255.255', '11.0.0.1', '0.0.0.0']) {
            refused(await sb.run(['send', 'sdb1', 'inst1', ip, 'ENGINE_peer4', 'sdc1', 'new1']), /not a private LAN/)
        }
        refused(await sb.run(['send', 'sdb1', 'inst1', 'nowhere.invalid', 'ENGINE_peer4', 'sdc1', 'new1']), /does not resolve/)
        expect(await sb.calls('rsync')).toEqual([])
    })

    it('refuses a host name that resolves to a public address, even when another address is private', async () => {
        await fs.writeFile(sb.hosts, 'evil.example 93.184.216.34\nmixed.example 192.168.1.5\nmixed.example 1.1.1.1\nlo.example 127.0.1.1\n')
        refused(await sb.run(['send', 'sdb1', 'inst1', 'evil.example', 'ENGINE_peer4', 'sdc1', 'new1']), /'evil\.example' resolves to 93\.184\.216\.34, which is not a private/)
        refused(await sb.run(['send', 'sdb1', 'inst1', 'mixed.example', 'ENGINE_peer4', 'sdc1', 'new1']), /resolves to 1\.1\.1\.1/)
        refused(await sb.run(['send', 'sdb1', 'inst1', 'lo.example', 'ENGINE_peer4', 'sdc1', 'new1']), /loopback/)
        expect(await sb.calls('rsync')).toEqual([])
    })

    it('receive hands the rsync server arguments to rrsync -wo <dst> (SSH_ORIGINAL_COMMAND) after creating dst', async () => {
        const dst = await sb.addDisk('sdc1')
        const r = await sb.run(['receive', 'sdc1', 'new1', '--server', '-logDtpreHAXxe.iLsfxCIvu', '--numeric-ids', '.', '.'], { FAKE_STDIN: 'rsync protocol bytes' })
        expect(r.exitCode, r.stderr).toBe(0)
        // the rsync stream on stdin reaches rrsync (a bash background job would otherwise get /dev/null)
        expect(await fs.readFile(path.join(sb.tmp, 'calls', 'rrsync.stdin'), 'utf8')).toBe('rsync protocol bytes')
        const [call] = await sb.calls('rrsync')
        expect(call.argv).toEqual(['-wo', path.join(dst, 'instances', 'new1')])
        expect(call.env.SSH_ORIGINAL_COMMAND).toBe('rsync --server -logDtpreHAXxe.iLsfxCIvu --numeric-ids . .')
        expect((await fs.stat(path.join(dst, 'instances', 'new1'))).isDirectory()).toBe(true)
    })

    it('receive refuses --sender, a non --server first argument, unsafe arguments and a non-empty destination', async () => {
        const dst = await sb.addDisk('sdc1')
        refused(await sb.run(['receive', 'sdc1', 'new1', '--server', '--sender', '-logDtpre.iLsfxCIvu', '.', '.']), /write-only: --sender is not allowed/)
        refused(await sb.run(['receive', 'sdc1', 'new1', '-e', 'sh', '.', '.']), /first server argument must be --server/)
        refused(await sb.run(['receive', 'sdc1', 'new1', '--server', '--rsync-path=sh;id', '.', '.']), /unsafe rsync server argument/)
        refused(await sb.run(['receive', 'sdc1', 'new1', '--server', '-logDtpre', '.', '/etc/x y']), /unsafe rsync server argument/)
        await fs.ensureDir(path.join(dst, 'instances', 'busy'))
        await fs.writeFile(path.join(dst, 'instances', 'busy', 'f'), 'x')
        refused(await sb.run(['receive', 'sdc1', 'busy', '--server', '-logDtpre', '.', '.']), /already exists and is not empty/)
        expect(await sb.calls('rrsync')).toEqual([])
    })
})

describe('idea-app-data: delete', () => {
    it('removes the instance folder (rm -rf --one-file-system), a missing one is fine, a symlink is refused', async () => {
        const root = await sb.addDisk('sdb1')
        const inst = await sb.addInstance(root, 'inst1')
        const r = await sb.run(['delete', 'sdb1', 'inst1'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(await fs.pathExists(inst)).toBe(false)
        expect(await fs.pathExists(path.join(root, 'instances'))).toBe(true)
        const again = await sb.run(['delete', 'sdb1', 'inst1'])
        expect(again.exitCode).toBe(0)
        expect(again.stderr).toMatch(/nothing to delete/)
        const victim = path.join(sb.tmp, 'victim')
        await fs.ensureDir(victim)
        await fs.writeFile(path.join(victim, 'keep'), 'x')
        await fs.symlink(victim, path.join(root, 'instances', 'inst2'))
        refused(await sb.run(['delete', 'sdb1', 'inst2']), /is a symlink/)
        expect(await fs.pathExists(path.join(victim, 'keep'))).toBe(true)
        await sb.addInstance(sb.sys, 'sysinst')
        expect((await sb.run(['delete', 'system', 'sysinst'])).exitCode).toBe(0)
        expect(await fs.pathExists(path.join(sb.sys, 'instances', 'sysinst'))).toBe(false)
    })

    it('waits for the per-instance lock and refuses when it stays busy', async () => {
        const root = await sb.addDisk('sdb1')
        await sb.addInstance(root, 'inst1')
        await fs.ensureDir(sb.lockDir)
        await fs.chmod(sb.lockDir, 0o700)
        const holder = spawn('flock', [path.join(sb.lockDir, 'inst.sdb1.inst1.lock'), 'sleep', '5'])
        await new Promise(r => setTimeout(r, 300))
        try {
            refused(await sb.run(['delete', 'sdb1', 'inst1']), /busy: another idea-app-data run still holds inst\.sdb1\.inst1/)
        } finally {
            holder.kill('SIGKILL')
        }
        expect(await fs.pathExists(path.join(root, 'instances', 'inst1'))).toBe(true)
    })

    it('refuses an unsafe lock folder', async () => {
        const root = await sb.addDisk('sdb1')
        await sb.addInstance(root, 'inst1')
        await fs.ensureDir(sb.lockDir)
        await fs.chmod(sb.lockDir, 0o777)
        refused(await sb.run(['delete', 'sdb1', 'inst1']), /lock folder .* must be owned by root with mode 0700/)
    })
})

describe('idea-app-data: borg', () => {
    const ARCHIVE = '2026-10-06T10-18-00-123Z'
    let app: string
    let bk: string
    beforeEach(async () => {
        app = await sb.addDisk('sdb1')
        bk = await sb.addDisk('sdc1', { backup: true })
        await sb.addInstance(app, 'inst1')
    })

    it('borg-init / borg-info / borg-create run borg with -- before paths, --numeric-ids and both BORG_*_IS_OK=yes', async () => {
        const repo = path.join(bk, 'backups', 'inst1')
        await fs.ensureDir(repo)   // the Engine creates the (empty) repo folder as pi
        expect((await sb.run(['borg-init', 'sdc1', 'inst1'])).exitCode).toBe(0)
        expect((await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1'])).exitCode).toBe(0)
        const info = await sb.run(['borg-info', 'sdc1', 'inst1'], { FAKE_BORG_INFO: '{"archives":[{"name":"x"}]}' })
        expect(info.exitCode).toBe(0)
        expect(info.stdout.trim()).toBe('{"archives":[{"name":"x"}]}')
        const calls = await sb.calls('borg')
        expect(calls.map(c => c.argv)).toEqual([
            ['init', '--encryption=none', '--', repo],
            ['create', '--numeric-ids', '--', `${repo}::${ARCHIVE}`, path.join(app, 'instances', 'inst1')],
            ['info', '--json', '--last', '1', '--', repo],
        ])
        for (const c of calls) {
            expect(c.env.BORG_RELOCATED_REPO_ACCESS_IS_OK).toBe('yes')
            expect(c.env.BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK).toBe('yes')
        }
        refused(await sb.run(['borg-init', 'sdc1', 'inst1']), /already a Borg repository/)
    })

    it('borg-create/info refuse a missing repo; borg-create refuses a missing source', async () => {
        refused(await sb.run(['borg-info', 'sdc1', 'inst1']), /repository folder .* is not a folder/)
        await fs.ensureDir(path.join(bk, 'backups', 'inst1'))
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdb1']), /is not a Borg repository/)
        await fs.writeFile(path.join(bk, 'backups', 'inst1', 'config'), '[repository]\n')
        refused(await sb.run(['borg-create', 'sdc1', 'inst1', ARCHIVE, 'sdc1']), /source instance folder .* is not a folder/)
    })

    it('borg-extract extracts into a fresh staging folder on the target, checks only <id> came out, then moves it into place (replacing)', async () => {
        const repo = path.join(bk, 'backups', 'inst1')
        await fs.ensureDir(repo)
        await fs.writeFile(path.join(repo, 'config'), '[repository]\n')
        const target = await sb.addDisk('sdd1')
        await fs.ensureDir(path.join(target, 'instances', 'inst1'))
        await fs.writeFile(path.join(target, 'instances', 'inst1', 'stale'), 'old')
        const r = await sb.run(['borg-extract', 'sdc1', 'inst1', ARCHIVE, '3', 'sdd1'], { FAKE_BORG_EXTRACT: 'inst1' })
        expect(r.exitCode, r.stderr).toBe(0)
        const [call] = await sb.calls('borg')
        expect(call.argv).toEqual(['extract', '--numeric-ids', '--strip-components', '3', '--', `${repo}::${ARCHIVE}`])
        expect(call.cwd.startsWith(path.join(target, '.idea-app-data-staging', 'restore-inst1.'))).toBe(true)
        expect(await fs.readFile(path.join(target, 'instances', 'inst1', 'data.txt'), 'utf8')).toBe('restored\n')
        expect(await fs.pathExists(path.join(target, 'instances', 'inst1', 'stale'))).toBe(false)
        expect(await fs.pathExists(path.join(target, '.idea-app-data-staging'))).toBe(false)
    })

    it('borg-extract refuses an archive that does not hold exactly instances/<id> and leaves the target untouched', async () => {
        const repo = path.join(bk, 'backups', 'inst1')
        await fs.ensureDir(repo)
        await fs.writeFile(path.join(repo, 'config'), '[repository]\n')
        const target = await sb.addDisk('sdd1')
        refused(await sb.run(['borg-extract', 'sdc1', 'inst1', ARCHIVE, '2', 'sdd1'], { FAKE_BORG_EXTRACT: 'instances other' }),
            /did not hold exactly instances\/inst1 at strip 2 \(got: instances other \)/)
        expect(await fs.readdir(path.join(target, 'instances'))).toEqual([])
        expect(await fs.pathExists(path.join(target, '.idea-app-data-staging'))).toBe(false)
        refused(await sb.run(['borg-extract', 'sdc1', 'inst1', ARCHIVE, '2', 'sdd1'], { FAKE_BORG_EXTRACT: '' }), /got: nothing/)
    })
})

describe('idea-app-data: the TEST-ONLY root bridge (/etc/idea/app-data-roots)', () => {
    it('without the file a slot name is an unknown root', async () => {
        refused(await sb.run(['size', 'idea-test-1', 'inst1']), /unknown root 'idea-test-1'.*test-only root bridge/)
    })

    it('a valid root:root 0644 file maps a slot name to its fixture root; every use is logged as test-only root bridge', async () => {
        const roots = await addBridge(sb, ['idea-test-1', 'idea-test-2'])
        await sb.addInstance(roots['idea-test-1'], 'kolibri-1')
        const r = await sb.run(['copy', 'idea-test-1', 'kolibri-1', 'idea-test-2', 'copy1'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stderr).toContain(`test-only root bridge: idea-test-1 -> ${roots['idea-test-1']}`)
        expect(await fs.pathExists(path.join(roots['idea-test-2'], 'instances', 'copy1', 'compose.yaml'))).toBe(true)
        const journal = await sb.journalText()
        expect(journal).toContain('-t idea-app-data -p auth.notice')
        expect(journal).toContain(`test-only root bridge: idea-test-1 -> ${roots['idea-test-1']}`)
        expect(journal).toMatch(/sub=copy .* exit=0 .*test-only-root-bridge=\[idea-test-1=/)
        // sdX tokens never go through the bridge
        refused(await sb.run(['size', 'sdb1', 'kolibri-1']), /is not a folder|not a mount point/)
    })

    it('ignores a bridge file with the wrong owner (and logs why)', async () => {
        if (process.getuid!() === 0) return
        const s = await sandbox({ rootsFile: '/etc/passwd' })   // root-owned: not the sandbox's "root"
        const r = await s.run(['size', 'idea-test-1', 'inst1'])
        refused(r, /unknown root 'idea-test-1'/)
        expect(r.stderr).toMatch(/ignoring the test-only root bridge file \/etc\/passwd: owner is 0:\d+, not root:root/)
        expect(await s.journalText()).toMatch(/test-only root bridge: ignoring \/etc\/passwd: owner is/)
    })

    it('ignores a bridge file with the wrong group', async () => {
        const s = await sandbox({ rootGid: process.getgid!() + 1 })
        await addBridge(s, ['idea-test-1'])
        const r = await s.run(['size', 'idea-test-1', 'inst1'])
        refused(r, /unknown root/)
        expect(r.stderr).toMatch(/owner is \d+:\d+, not root:root/)
    })

    it('ignores a group-writable, other-writable or 0600 bridge file', async () => {
        await addBridge(sb, ['idea-test-1'])
        for (const [mode, why] of [[0o664, /mode 0664 lets group or others write it/], [0o646, /mode 0646 lets group or others write it/], [0o600, /mode is 0600, not 0644/]] as const) {
            await fs.chmod(sb.rootsFile, mode)
            const r = await sb.run(['size', 'idea-test-1', 'inst1'])
            refused(r, /unknown root/)
            expect(r.stderr).toMatch(why)
        }
    })

    it('ignores a bridge file that is a symlink (even to a valid file)', async () => {
        await addBridge(sb, ['idea-test-1'])
        const realFile = sb.rootsFile + '.real'
        await fs.move(sb.rootsFile, realFile)
        await fs.symlink(realFile, sb.rootsFile)
        const r = await sb.run(['size', 'idea-test-1', 'inst1'])
        refused(r, /unknown root/)
        expect(r.stderr).toMatch(/ignoring the test-only root bridge file .*: it is a symlink/)
    })

    it('ignores entries that are relative, hold .., shadow sdX/system, are symlinks, or sit in a parent that is not root-owned or is group/other writable', async () => {
        const pool = path.join(sb.tmp, 'pool')
        await fs.ensureDir(path.join(pool, 'idea-test-9', 'instances'))
        await fs.writeFile(path.join(pool, 'idea-test-9', 'META.yaml'), 'x')
        await fs.ensureDir(path.join(pool, 'sdb1'))
        await fs.symlink(path.join(pool, 'idea-test-9'), path.join(pool, 'idea-test-8'))
        const shared = path.join(sb.tmp, 'shared')
        await fs.ensureDir(path.join(shared, 'idea-test-7'))
        await fs.chmod(shared, 0o777)
        await addBridge(sb, [], [
            'idea-test-1',
            `${pool}/../pool/idea-test-9`,
            `${pool}/sdb1`,
            `${pool}/idea-test-8`,
            `${shared}/idea-test-7`,
            '/etc',
            `${pool}/idea-test-9/`,
        ])
        const r = await sb.run(['size', 'idea-test-9', 'inst1'])
        refused(r, /unknown root 'idea-test-9'/)
        expect(r.stderr).toMatch(/ignoring entry 'idea-test-1' .*not an absolute path/)
        expect(r.stderr).toMatch(/ignoring entry '.*\/\.\.\/pool\/idea-test-9' .*'\.' or '\.\.' component/)
        expect(r.stderr).toMatch(/ignoring entry '.*\/sdb1' .*not a slot name/)
        expect(r.stderr).toMatch(/ignoring entry '.*\/idea-test-8' .*without symlinks/)
        expect(r.stderr).toMatch(/ignoring entry '.*\/idea-test-7' .*group or other writable/)
        expect(r.stderr).toMatch(/ignoring entry '\/etc' .*its parent \/ is owned by uid 0, not root|ignoring entry '\/etc'/)
        expect(r.stderr).toMatch(/ignoring entry '.*idea-test-9\/' .*trailing/)
    })

    it('refuses a slot listed twice', async () => {
        const roots = await addBridge(sb, ['idea-test-1'])
        await fs.appendFile(sb.rootsFile, `${roots['idea-test-1']}\n`)
        refused(await sb.run(['size', 'idea-test-1', 'inst1']), /lists 'idea-test-1' more than once/)
    })
})

describe('idea-app-data: logging and cancellation', () => {
    it('logs every call to auth.notice with the caller, arguments, exit code and duration, refusals included', async () => {
        await sb.run(['version'])
        await sb.run(['size', '../x', 'y'])
        const lines = (await sb.journalText()).split('\n').filter(l => l.includes('sub='))
        expect(lines[0]).toMatch(/^-t idea-app-data -p auth\.notice -- user=pi sub=version args=version exit=0 ms=\d+$/)
        expect(lines[1]).toMatch(/user=pi sub=size args=size \.\.\/x y exit=2 ms=\d+ refused=/)
    })

    it('a TERM stops rsync and the helper dies of SIGTERM (so sudo and the Engine see the signal)', async () => {
        const src = await sb.addDisk('sdb1')
        await sb.addDisk('sdc1')
        await sb.addInstance(src, 'inst1')
        const proc = spawn(sb.script, ['copy', 'sdb1', 'inst1', 'sdc1', 'new1'], { env: { ...process.env, FAKE_RSYNC_SLEEP: '30' } })
        const t0 = Date.now()
        // wait for rsync to start
        for (let i = 0; i < 50 && (await sb.calls('rsync')).length === 0; i++) await new Promise(r => setTimeout(r, 100))
        proc.kill('SIGTERM')
        const result = await new Promise<{ code: number | null, signal: string | null }>(res => proc.on('close', (code, signal) => res({ code, signal })))
        expect(result.signal).toBe('SIGTERM')
        expect(Date.now() - t0).toBeLessThan(10_000)
        expect(await sb.journalText()).toMatch(/sub=copy \(cancelled by SIGTERM\) .* exit=143 /)
    }, 20_000)
})
