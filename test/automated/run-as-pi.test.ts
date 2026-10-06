/**
 * run-as-pi.test.ts
 *
 * Verifies idea#80: the Engine runs as pi, and the only root commands it runs are
 * the ones listed in script/build_image_assets/10-engine.sudoers and
 * 11-engine-files.sudoers (idea#121).
 *
 *   1. META.yaml under a pi-owned (test) mount root is written as the Engine user,
 *      without sudo. Real /disks/sdXN roots go through sudo tee (idea#121, tested
 *      in meta-first-dock.test.ts)
 *   2. The sudoers asset is valid sudoers syntax (visudo -cf) and uses narrow patterns
 *   3. Every runtime `sudo` call in src/ is covered by the sudoers asset
 *   4. sync-engine / reset-engine / build-engine never use root's pm2 (`sudo pm2`)
 *      or a sudo build, and Nextcloud's docker exec runs without sudo
 */

import { describe, it, expect, afterEach } from 'vitest'
import path from 'path'
import { $, fs, YAML } from 'zx'
import { diskPath, uniqueTestDevice } from '../harness/diskSim.js'
import { createMeta } from '../../src/data/Meta.js'
import { DeviceName } from '../../src/data/CommonTypes.js'

const ROOT = process.cwd()
const SUDOERS = path.join(ROOT, 'script/build_image_assets/10-engine.sudoers')
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// Runtime files: code the Engine itself runs (as pi, under pm2). Provisioning code
// in Engine.ts (build-engine) runs interactively and is out of scope for the sudoers file.
const RUNTIME_FILES = [
    'src/monitors/usbDeviceMonitor.ts',
    'src/monitors/diskDetection.ts',
    'src/data/Instance.ts',
    'src/data/CopyMoveApp.ts',
    'src/monitors/mounts.ts',
    'src/data/CreateFilesDisk.ts',
    'src/data/EraseDisk.ts',
]

// Every `sudo <cmd> ...` in a zx template literal ($`sudo ...`), with the command.
const sudoCalls = (text: string): string[] =>
    [...text.matchAll(/\$`sudo ([^`]*)`/g)]
        .filter(m => !text.slice(text.lastIndexOf('\n', m.index!) + 1, m.index!).trimStart().startsWith('//'))
        .map(m => m[1])

describe('META.yaml under a pi-owned mount root is written as pi (idea#80)', () => {
    const device = uniqueTestDevice()
    afterEach(async () => { await fs.remove(diskPath(device)) })

    it('createMeta writes META.yaml under the mount root without sudo, owned by the Engine user', async () => {
        await fs.ensureDir(diskPath(device))
        const meta = await createMeta(device as DeviceName, '1.0' as any)
        const file = `${diskPath(device)}/META.yaml`
        expect(fs.existsSync(file)).toBe(true)
        expect(fs.statSync(file).uid).toBe(process.getuid!())
        const written = YAML.parse(fs.readFileSync(file, 'utf8'))
        expect(written.diskId).toBe(meta.diskId)
        expect(written.version).toBe('1.0')
    })
})

describe('Engine sudoers asset (idea#80)', () => {
    const sudoers = fs.readFileSync(SUDOERS, 'utf8')
    // The rules only, without the explanatory # comments.
    const rulesText = sudoers.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')

    it('is valid sudoers syntax (visudo -cf)', async (ctx) => {
        const visudo = ['/usr/sbin/visudo', '/sbin/visudo'].find(p => fs.existsSync(p))
        if (!visudo) ctx.skip()
        const out = await $`${visudo} -cf ${SUDOERS}`.nothrow()
        expect(out.exitCode, out.stderr).toBe(0)
    })

    it('grants only pi, only as root, and uses no wide /disks/* or /dev/* patterns', () => {
        const rules = sudoers.split('\n').filter(l => /^\s*pi\s/.test(l))
        expect(rules).toEqual(['pi ALL=(root) NOPASSWD: ENGINE_MOUNT, ENGINE_DIRS, ENGINE_META, ENGINE_POWER, ENGINE_APPDIRS'])
        expect(rulesText).not.toMatch(/\/disks\/\*/)
        expect(rulesText).not.toMatch(/\/dev\/\*/)
        expect(rulesText).not.toMatch(/-t ext4/)
        // reboot via systemctl with pinned args only (/usr/sbin/reboot is a symlink to
        // systemctl on Pi OS and sudo matches by inode)
        expect(rulesText).not.toMatch(/\/s?bin\/reboot/)
        expect(rulesText).toMatch(/ENGINE_POWER = \/usr\/bin\/systemctl reboot\s*$/m)
        expect([...rulesText.matchAll(/systemctl/g)]).toHaveLength(1)
    })

    it('covers every runtime sudo call in src/', () => {
        const allowed = [
            // 11-engine-files (idea#134): typed ext4 mount
            '/usr/bin/mount -t ext4 /dev/${device} ${mp}',
            'mkdir -p ${disksRoot()}/${device}',
            'umount ${disksRoot()}/${device}',
            'mkdir -p ${disksRoot()}/old',
            'mv ${disksRoot()}/${device} ${disksRoot()}/old/${device}',
            'rm -fr ${disksRoot()}/${device}',
            'rm -fr ${disksRoot()}/old',
            // 11-engine-files (idea#126): removeMountPointFolder in mounts.ts
            '${SUDO_RMDIR} ${mountPoint}',
            // 11-engine-files (idea#131): createFilesDisk, disk root folder only
            '-n ${SUDO_CHOWN} -h pi:pi ${mountPoint}',
            // 11-engine-files (idea#134): eraseDisk script (no arg list in sudoers)
            '-n ${ERASE_SCRIPT} ${a.device} ${a.serial} ${String(a.sizeBytes)} ${a.label} ${a.stagingDir}',
        ]
        const calls = RUNTIME_FILES.flatMap(f => sudoCalls(src(f)))
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) expect(allowed, `sudo ${call} is not in 10-engine / 11-engine-files`).toContain(call)
        // Meta.ts and Engine.ts runtime calls
        const meta = src('src/data/Meta.ts')
        expect(meta).toContain('$`sudo cat ${path}`')
        expect(meta).toContain("$`sudo hdparm -I /dev/${device} | grep 'Serial\\ Number'`")
        expect(meta).toContain('$({ input: yamlContent })`sudo tee /META.yaml > /dev/null`')
        // App Disk META.yaml through 11-engine-files (idea#121)
        expect(meta).toContain('$({ input: content })`sudo ${SUDO_TEE} ${metaPath} > /dev/null`')
        expect(meta).toContain("export const SUDO_TEE = '/usr/bin/tee'")
        expect(meta).not.toMatch(/sudo mv/)
        expect(src('src/data/Engine.ts')).toContain('$`sudo /usr/bin/systemctl reboot`')
        expect(src('src/data/Engine.ts')).not.toMatch(/\$`sudo reboot now`/)
        // CopyMoveApp.ts: cross-engine copies run NO remote shell command any more
        // (per-Pi Engine keys): the peer's gate runs that Engine's helper (ensure-dirs …)
        const copyMove = src('src/data/CopyMoveApp.ts')
        expect(copyMove).not.toMatch(/mkdir -p|chown pi|StrictHostKeyChecking=no|rsync -a -e/)
        expect(copyMove).toContain('ensureRemoteDirs(peer.host, peer.engineId, targetRoot)')
        // ...and each of those binaries/arguments is in the sudoers file
        for (const rule of [
            '/usr/bin/umount /disks/sd[a-z][12]',
            '/usr/bin/mkdir -p /disks/sd[a-z][12]',
            '/usr/bin/mkdir -p /disks/old',
            '/usr/bin/mv /disks/sd[a-z][12] /disks/old/sd[a-z][12]',
            '/usr/bin/rm -fr /disks/sd[a-z][12]',
            '/usr/bin/rm -fr /disks/old',
            '/usr/bin/cat /META.yaml',
            '/usr/bin/tee /META.yaml',
            '/usr/sbin/hdparm -I /dev/sd[a-z][12]',
            '/usr/bin/systemctl reboot',
            '/usr/bin/mkdir -p /apps /instances /services',
            '/usr/bin/chown pi\\:pi /apps /instances /services',
        ]) expect(rulesText).toContain(rule)
    })

    it('11-engine-files is valid, grants only pi as root, and 10-engine has no /disks tee (idea#121)', async (ctx) => {
        const files = fs.readFileSync(path.join(ROOT, 'script/build_image_assets/11-engine-files.sudoers'), 'utf8')
        const rules = files.split('\n').filter(l => l.trim() && !l.trimStart().startsWith('#'))
        expect(rules).toEqual([
            'pi ALL=(root) NOPASSWD: /usr/bin/tee /disks/sd[a-z][12]/META.yaml',
            'pi ALL=(root) NOPASSWD: /usr/bin/rmdir /disks/sd[a-z][12]',
            // createFilesDisk: the disk root folder only, never recursive (idea#131)
            'pi ALL=(root) NOPASSWD: /usr/bin/chown -h pi\\:pi /disks/sd[a-z][12]',
            'pi ALL=(root) NOPASSWD: /usr/local/sbin/idea-erase-disk',
            // app data as root (idea#168): one helper, no argument list (the helper validates)
            'pi ALL=(root) NOPASSWD: /usr/local/sbin/idea-app-data',
            'pi ALL=(root) NOPASSWD: /usr/bin/mount -t ext4 /dev/sd[a-z][12] /disks/sd[a-z][12]',
        ])
        expect(rulesText).not.toMatch(/tee \/disks/)
        expect(rulesText).not.toMatch(/rmdir/)   // the rmdir entry lives in 11-engine-files (idea#126)
        expect(rulesText).not.toMatch(/chown -h/) // the chown -h entry lives in 11-engine-files (idea#131)
        expect(rulesText).not.toMatch(/idea-erase-disk/) // erase script lives in 11-engine-files (idea#134)
        expect(rulesText).not.toMatch(/idea-app-data/)   // app-data helper lives in 11-engine-files (idea#168)
        expect(src('src/data/CreateFilesDisk.ts')).toContain("export const SUDO_CHOWN = '/usr/bin/chown'")
        const visudo = ['/usr/sbin/visudo', '/sbin/visudo'].find(p => fs.existsSync(p))
        if (!visudo) ctx.skip()
        const out = await $`${visudo} -cf ${path.join(ROOT, 'script/build_image_assets/11-engine-files.sudoers')}`.nothrow()
        expect(out.exitCode, out.stderr).toBe(0)
    })

    it('app data runs as root only through the helper: every sudo spawn is `sudo -n /usr/local/sbin/idea-app-data …` (idea#168)', () => {
        const helper = src('src/utils/appDataHelper.ts')
        expect(helper).toContain("export const APP_DATA_HELPER = '/usr/local/sbin/idea-app-data'")
        expect(helper).toContain("export const appDataSudoArgv = (args: string[]): string[] => ['-n', APP_DATA_HELPER, ...args]")
        // remote helper calls (through the peer's gate) are built from checked tokens only
        expect(helper).toContain("export const remoteHelperCommand = (args: string[]): string[] => ['sudo', '-n', APP_DATA_HELPER, ...args]")
        expect(helper).toContain('peerSshArgv(host, peerEngineId, remoteHelperCommand(deleteArgs(root, id)))')
        for (const f of ['src/utils/appDataHelper.ts', 'src/utils/rsync.ts', 'src/monitors/backupMonitor.ts', 'src/data/CopyMoveApp.ts']) {
            const text = src(f)
            for (const m of text.matchAll(/spawn\('sudo', ([^,]+),/g)) expect(m[1], f).toBe('appDataSudoArgv(args)')
            for (const m of text.matchAll(/runRsyncProcess\('sudo', ([^,]+),/g)) expect(m[1], f).toBe('appDataSudoArgv(args)')
            expect(text, f).not.toMatch(/\$`sudo /)
            expect(text, f).not.toMatch(/\$`borg |spawn\('borg'/)
            expect(text, f).not.toMatch(/rm -rf --? \$\{/)
        }
        const engine = src('src/data/Engine.ts')
        expect(engine).toContain('sudo install -o root -g root -m 0755 ${enginePath}/script/build_image_assets/idea-app-data ${APP_DATA_HELPER}')
        expect(engine).toContain('sudo install -o root -g root -m 0755 ${enginePath}/script/build_image_assets/idea-peer-gate ${PEER_GATE}')
        expect(fs.statSync(path.join(ROOT, 'script/build_image_assets/idea-app-data')).mode & 0o111).not.toBe(0)
        expect(fs.statSync(path.join(ROOT, 'script/build_image_assets/idea-peer-gate')).mode & 0o111).not.toBe(0)
    })

    it('mount points are removed with rmdir, never rm -fr (idea#126)', () => {
        const mounts = src('src/monitors/mounts.ts')
        expect(mounts).toContain("export const SUDO_RMDIR = '/usr/bin/rmdir'")
        expect(mounts).toContain('$`sudo ${SUDO_RMDIR} ${mountPoint}`')
        for (const f of ['src/monitors/usbDeviceMonitor.ts', 'src/monitors/mounts.ts']) {
            expect(src(f), f).not.toMatch(/\$`sudo rm -fr \$\{disksRoot\(\)\}\/\$\{device\}`/)
            expect(src(f), f).not.toMatch(/\$`sudo mv /)
        }
    })

    it('runtime code no longer needs sudo for instance folders, old/* globs or docker', () => {
        for (const f of RUNTIME_FILES) {
            const text = src(f)
            expect(text).not.toMatch(/sudo rm -rf \$\{instanceSrc\}/)
            expect(text).not.toMatch(/sudo rm -fr \$\{disksRoot\(\)\}\/old\/\*/)
            expect(text).not.toMatch(/\$`sudo docker/)
        }
    })
})

describe('pm2 runs as pi in the sync/reset/build scripts (idea#80)', () => {
    it('sync-engine and reset-engine use pi\'s pm2 and a plain pnpm build', () => {
        for (const f of ['script/sync-engine.ts', 'script/reset-engine.ts']) {
            const text = src(f)
            expect(text, f).not.toMatch(/sudo pm2/)
            expect(text, f).not.toMatch(/sudo pnpm build/)
            expect(text, f).toMatch(/pm2 start pm2\.config\.cjs/)
        }
    })

    it('build-engine installs pm2-logrotate into pi\'s pm2 and installs the sudoers file', () => {
        const engine = src('src/data/Engine.ts')
        expect(engine).not.toMatch(/sudo pm2/)
        expect(engine).toContain('pm2 install pm2-logrotate')
        expect(engine).toMatch(/installEngineSudoers\(exec, enginePath\)/)
        expect(engine).toContain("'10-engine.sudoers'")
        expect(engine).toContain("'/etc/sudoers.d/10-engine'")
        expect(engine).toContain("'11-engine-files.sudoers'")
        expect(engine).toContain("'/etc/sudoers.d/11-engine-files'")
    })

    it('the cross-engine helper checks pi\'s pm2', () => {
        expect(src('test/cross-engine/remoteSSH.ts')).not.toMatch(/`sudo pm2/)
    })
})
