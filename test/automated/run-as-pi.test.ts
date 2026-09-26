/**
 * run-as-pi.test.ts
 *
 * Verifies idea#80: the Engine runs as pi, and the only root commands it runs are
 * the ones listed in script/build_image_assets/10-engine.sudoers.
 *
 *   1. App Disk META.yaml files are written as the Engine user, without sudo
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
import { SYSTEM_DISK_ENSURE_DIRS, remoteEnsureDirsCommand } from '../../src/data/CopyMoveApp.js'
import { DeviceName } from '../../src/data/CommonTypes.js'

const ROOT = process.cwd()
const SUDOERS = path.join(ROOT, 'script/build_image_assets/10-engine.sudoers')
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// Runtime files: code the Engine itself runs (as pi, under pm2). Provisioning code
// in Engine.ts (build-engine) runs interactively and is out of scope for the sudoers file.
const RUNTIME_FILES = [
    'src/monitors/usbDeviceMonitor.ts',
    'src/data/Instance.ts',
    'src/data/CopyMoveApp.ts',
]

// Every `sudo <cmd> ...` in a zx template literal ($`sudo ...`), with the command.
const sudoCalls = (text: string): string[] =>
    [...text.matchAll(/\$`sudo ([^`]*)`/g)]
        .filter(m => !text.slice(text.lastIndexOf('\n', m.index!) + 1, m.index!).trimStart().startsWith('//'))
        .map(m => m[1])

describe('App Disk META.yaml is written as pi (idea#80)', () => {
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
    })

    it('covers every runtime sudo call in src/', () => {
        const allowed = [
            'mount /dev/${device} ${disksRoot()}/${device}',
            'mkdir -p ${disksRoot()}/${device}',
            'umount ${disksRoot()}/${device}',
            'mkdir -p ${disksRoot()}/old',
            'mv ${disksRoot()}/${device} ${disksRoot()}/old/${device}',
            'rm -fr ${disksRoot()}/${device}',
            'rm -fr ${disksRoot()}/old',
        ]
        const calls = RUNTIME_FILES.flatMap(f => sudoCalls(src(f)))
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) expect(allowed, `sudo ${call} is not in 10-engine.sudoers`).toContain(call)
        // Meta.ts and Engine.ts runtime calls
        const meta = src('src/data/Meta.ts')
        expect(meta).toContain('$`sudo cat ${path}`')
        expect(meta).toContain("$`sudo hdparm -I /dev/${device} | grep 'Serial\\ Number'`")
        expect(meta).toContain('$({ input: yamlContent })`sudo tee /META.yaml > /dev/null`')
        expect(meta).not.toMatch(/sudo mv/)
        expect(src('src/data/Engine.ts')).toContain('$`sudo reboot now`')
        // CopyMoveApp.ts: cross-engine copy onto a remote system disk (the only remote sudo)
        const appDirs = SYSTEM_DISK_ENSURE_DIRS.split(' && ')
        expect(appDirs.every(c => c.startsWith('sudo /usr/bin/'))).toBe(true)
        for (const c of appDirs) expect(rulesText).toContain(c.replace(/^sudo /, '').replace(/:/g, '\\:'))
        expect(remoteEnsureDirsCommand('/disks/sda1')).not.toMatch(/sudo/)
        // ...and each of those binaries/arguments is in the sudoers file
        for (const rule of [
            '/usr/bin/mount /dev/sd[a-z][12] /disks/sd[a-z][12]',
            '/usr/bin/umount /disks/sd[a-z][12]',
            '/usr/bin/mkdir -p /disks/sd[a-z][12]',
            '/usr/bin/mkdir -p /disks/old',
            '/usr/bin/mv /disks/sd[a-z][12] /disks/old/sd[a-z][12]',
            '/usr/bin/rm -fr /disks/sd[a-z][12]',
            '/usr/bin/rm -fr /disks/old',
            '/usr/bin/cat /META.yaml',
            '/usr/bin/tee /META.yaml',
            '/usr/sbin/hdparm -I /dev/sd[a-z][12]',
            '/usr/sbin/reboot now',
            '/usr/bin/mkdir -p /apps /instances /services',
            '/usr/bin/chown pi\\:pi /apps /instances /services',
        ]) expect(rulesText).toContain(rule)
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
    })

    it('the cross-engine helper checks pi\'s pm2', () => {
        expect(src('test/cross-engine/remoteSSH.ts')).not.toMatch(/`sudo pm2/)
    })
})
