/**
 * engine-image.test.ts: build-engine image modes (idea#322 Option A), all on a temp-dir rootfs.
 * Arg parsing, the lock, sanitise, verify, the build step plan with a stubbed runner,
 * and first start from an image /META.yaml without a diskId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path } from 'zx'
import os from 'os'
import crypto from 'crypto'
import {
    parseImageArgs, UsageError, validateLock, serialiseLock, writeLock, readLock, LOCK_SCHEMA, EngineLock,
    sanitiseRootfs, verifyRootfs, IDENTITY_PATHS, GENERIC_HOSTNAME, IMAGE_ENABLED_UNITS, PM2_UNIT, SSH_REGEN_UNIT,
    pm2UnitText, preloadManifest, imageIdFromManifest, imageTarName, readDpkgStatus, unitEnabled, unitLinks, unitInstallTargets, verifyRootfsChecks, VERIFY_CHECKS, PRELOAD_DOCKER_DIR, IMAGE_LOCK_PATH, IMAGE_VERSION_PATH,
} from '../../src/install/engineImage.js'
import { rootfsSteps, runRootfsBuild, Runner, Installers, SHIMS, quoteTemplate } from '../../src/install/engineRootfs.js'
import { pinNpmTools, writeReport } from '../../src/install/engineImageCli.js'
import { diskIdWithoutHardware, hasDiskId, ensureSystemMeta } from '../../src/data/Meta.js'

const ENGINE = '/home/pi/idea/agents/agent-engine-dev'
const COMMIT = 'a'.repeat(40)
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const DIGEST = 'b'.repeat(64)

const LR_SHA = crypto.createHash('sha256').update('lr').digest('hex')
const lock = (over: Partial<EngineLock> = {}): EngineLock => ({
    schema: LOCK_SCHEMA, engineCommit: COMMIT, engineVersion: '1.0', arch: 'arm64',
    nodeVersion: '22.20.0', pnpmVersion: '10.33.0', pm2Version: '7.1.1', pm2LogrotateVersion: '3.0.0',
    tailscaleVersion: '1.104.2', tailscaleSha256: 'c'.repeat(64), debianSnapshot: '20261026T000000Z',
    aptPins: [], dockerDebs: [], dockerImages: [], pm2Env: 'production', files: [], enabledUnits: [...IMAGE_ENABLED_UNITS].sort(),
    npmTools: [
        { name: 'pm2', version: '7.1.1', install: 'global', lockfileSha256: 'd'.repeat(64), tgz: 'pm2-7.1.1.tgz', sha256: 'e'.repeat(64) },
        { name: 'pm2-logrotate', version: '3.0.0', install: 'preload', lockfileSha256: 'd'.repeat(64), tgz: 'pm2-logrotate-3.0.0.tgz', sha256: LR_SHA },
        { name: 'pnpm', version: '10.33.0', install: 'global', lockfileSha256: 'd'.repeat(64), tgz: 'pnpm-10.33.0.tgz', sha256: '1'.repeat(64) },
    ],
    ...over,
})

describe('parseImageArgs', () => {
    it('returns null without an image flag (live/SSH path unchanged)', () => {
        expect(parseImageArgs({ m: 'idea04' })).toBeNull()
        expect(parseImageArgs({})).toBeNull()
    })
    it('accepts the INTERFACE.md invocation (--root --boot --report), lock optional', () => {
        const a = parseImageArgs({ root: '/mnt/r', boot: '/mnt/r/boot/firmware', report: '/out/engine-build.json' })!
        expect(a).toMatchObject({ mode: 'rootfs', rootfs: '/mnt/r', boot: '/mnt/r/boot/firmware', report: '/out/engine-build.json', pm2Env: 'production', dryRun: false })
        expect(a.lock).toBeUndefined()
    })
    it('refuses device or remote options with a UsageError', () => {
        for (const bad of [{ m: 'x' }, { u: 'pi' }, { hostname: 'h' }, { personalize: true }, { peer: 'p' }])
            expect(() => parseImageArgs({ root: '/mnt/r', ...bad })).toThrow(UsageError)
    })
    it('refuses /, relative paths, two modes, undigested images, bad pm2 env', () => {
        expect(() => parseImageArgs({ root: '/' })).toThrow(/refusing/)
        expect(() => parseImageArgs({ root: 'mnt' })).toThrow(/absolute/)
        expect(() => parseImageArgs({ root: '/a', 'verify-rootfs': '/a', lock: '/l' })).toThrow(/only one/)
        expect(() => parseImageArgs({ root: '/a', image: 'nginx:1.27' })).toThrow(/digest/)
        expect(() => parseImageArgs({ root: '/a', 'pm2-env': 'staging' })).toThrow(/pm2-env/)
        expect(() => parseImageArgs({ root: '/a', report: 'x.json' })).toThrow(/absolute/)
        expect(parseImageArgs({ root: '/a', image: `nginx:1.27@sha256:${DIGEST}` })!.images).toHaveLength(1)
    })
    it('verify and write-lock need --lock', () => {
        expect(() => parseImageArgs({ 'verify-rootfs': '/a' })).toThrow(/--lock/)
        expect(parseImageArgs({ 'write-lock': true, lock: '/x/engine.lock' })!.mode).toBe('write-lock')
    })
})

describe('lock', () => {
    it('validates and round-trips sorted, stable JSON', async () => {
        expect(validateLock(lock())).toEqual([])
        expect(validateLock(lock({ engineCommit: 'abc' }))).toContain('engineCommit must be a full 40-hex git SHA')
        expect(validateLock(lock({ dockerImages: [{ ref: 'nginx:1', imageId: 'x', tar: '../t', tarSha256: 'z' } as any] })).length).toBe(4)
        const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-'))
        await writeLock(path.join(d, 'l.json'), lock())
        expect(await readLock(path.join(d, 'l.json'))).toEqual(JSON.parse(serialiseLock(lock())))
        expect(serialiseLock(lock())).toBe(serialiseLock(JSON.parse(serialiseLock(lock()))))
        await fs.remove(d)
    })
    it('names preload tarballs like archive-engine-inputs.sh and reads the image id', () => {
        expect(imageTarName(`ghcr.io/a/b:1@sha256:${DIGEST}`)).toBe(`ghcr.io_a_b_1_sha256_${DIGEST}.tar`)
        expect(imageIdFromManifest(JSON.stringify([{ Config: `blobs/sha256/${DIGEST}` }]))).toBe(`sha256:${DIGEST}`)
        expect(() => imageIdFromManifest('[]')).toThrow()
        expect(preloadManifest([])).toBe('')
    })
})

/** A rootfs that passes verify (built by hand), with the store-identity files of the "commit". */
const STORE = { 'store-template.json': '{"t":1}\n', 'store-url.txt': 'automerge:x\n', 'command-log-url.txt': 'automerge:y\n' }
const storeShas = Object.fromEntries(Object.entries(STORE).map(([k, v]) => [k, sha(v)]))
const goodRootfs = async (root: string) => {
    const R = (p: string) => path.join(root, p)
    const eng = R(ENGINE)
    await fs.ensureDir(path.join(eng, '.git')); await fs.writeFile(path.join(eng, '.git/HEAD'), COMMIT + '\n')
    await fs.ensureDir(path.join(eng, 'dist/src')); await fs.writeFile(path.join(eng, 'dist/src/index.js'), '')
    await fs.ensureDir(path.join(eng, 'node_modules')); await fs.writeFile(path.join(eng, 'pm2.config.cjs'), '')
    for (const [n, ver] of [['pm2', '7.1.1'], ['pnpm', '10.33.0']]) {
        const dir = R(`usr/local/lib/node_modules/${n}`)
        await fs.ensureDir(path.join(dir, 'node_modules/dep'))
        await fs.writeJson(path.join(dir, 'node_modules/dep/package.json'), { name: 'dep' })
        await fs.writeJson(path.join(dir, 'package.json'), { name: n, version: ver, bin: { [n]: `bin/${n}` }, dependencies: { dep: '1' }, bundleDependencies: ['dep'] })
        await fs.ensureDir(R('usr/local/bin')); await fs.writeFile(R(`usr/local/bin/${n}`), '')
    }
    await fs.ensureDir(R('var/lib/idea/preload/npm')); await fs.writeFile(R('var/lib/idea/preload/npm/pm2-logrotate-3.0.0.tgz'), 'lr')
    await fs.ensureDir(path.join(eng, 'store-identity'))
    for (const [k, v] of Object.entries(STORE)) await fs.writeFile(path.join(eng, 'store-identity', k), v)
    await fs.ensureDir(R('etc/systemd/system/multi-user.target.wants'))
    await fs.writeFile(R(`etc/systemd/system/${PM2_UNIT}`), pm2UnitText())
    for (const u of IMAGE_ENABLED_UNITS) await fs.writeFile(R(`etc/systemd/system/multi-user.target.wants/${u}`), '')
    await fs.writeFile(R('etc/machine-id'), ''); await fs.writeFile(R('etc/hostname'), GENERIC_HOSTNAME + '\n')
    await fs.writeFile(R('etc/hosts'), '127.0.0.1\tlocalhost\n127.0.1.1\traspberrypi\n')
    await fs.ensureDir(R('etc/idea')); await fs.writeFile(R(IMAGE_LOCK_PATH.slice(1)), serialiseLock(lock())); await fs.writeFile(R(IMAGE_VERSION_PATH.slice(1)), '1.0\n')
}
const addIdentity = async (root: string) => {
    const R = (p: string) => path.join(root, p)
    await fs.writeFile(R('META.yaml'), 'diskId: ABC\nisHardwareId: true\n')
    await fs.ensureDir(R('etc/ssh')); await fs.writeFile(R('etc/ssh/ssh_host_ed25519_key'), 'k')
    await fs.ensureDir(R('var/lib/tailscale')); await fs.writeFile(R('var/lib/tailscale/tailscaled.state'), '{}')
    await fs.ensureDir(R('etc/tailscale')); await fs.chmod(R('etc/tailscale'), 0o700); await fs.writeFile(R('etc/tailscale/debug-authkey'), 'tskey-auth-FAKE')
    await fs.writeFile(R('etc/machine-id'), '0123456789abcdef0123456789abcdef\n'); await fs.writeFile(R('etc/hostname'), 'brave-otter\n')
    await fs.writeFile(R('etc/hosts'), '127.0.0.1\tlocalhost\n127.0.1.1\tbrave-otter\n')
    await fs.ensureDir(R('home/pi/.pm2')); await fs.writeFile(R('home/pi/.pm2/dump.pm2'), '[]')
    await fs.ensureDir(R(`${ENGINE}/store-data`)); await fs.writeFile(R(`${ENGINE}/store-identity/extra-store.txt`), 'x')
    await fs.ensureDir(R('root/.idea-build/shims')); await fs.ensureDir(R('usr/sbin')); await fs.writeFile(R('usr/sbin/policy-rc.d'), 'exit 101')
}

describe('sanitise + verify', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    const ctx = () => ({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas })

    it('a clean rootfs verifies', async () => { expect(await verifyRootfs(ctx())).toEqual([]) })
    it('verify fails on every kind of identity, sanitise removes it, then verify passes', async () => {
        await addIdentity(root)
        const p = await verifyRootfs(ctx())
        for (const s of ['/META.yaml', 'ssh_host_ed25519_key', 'tailscaled.state', 'debug-authkey', 'machine-id is not empty', 'hostname', 'dump.pm2', 'store-data', 'extra-store.txt', 'policy-rc.d', '.idea-build'])
            expect(p.join('\n')).toContain(s)
        const done = await sanitiseRootfs({ root, enginePath: ENGINE, trackedStoreIdentity: Object.keys(STORE) })
        expect(done.length).toBeGreaterThan(5)
        expect(await verifyRootfs(ctx())).toEqual([])
        expect(await fs.readFile(path.join(root, 'etc/machine-id'), 'utf8')).toBe('')
        expect(await fs.readlink(path.join(root, 'var/lib/dbus/machine-id'))).toBe('/etc/machine-id')
        expect(await sanitiseRootfs({ root, enginePath: ENGINE, trackedStoreIdentity: Object.keys(STORE) })).toEqual([]) // idempotent
    })
    it('sanitise never touches store-template.json; verify fails if it changed', async () => {
        const f = path.join(root, ENGINE, 'store-identity/store-template.json')
        await sanitiseRootfs({ root, enginePath: ENGINE, trackedStoreIdentity: Object.keys(STORE) })
        expect(await fs.readFile(f, 'utf8')).toBe(STORE['store-template.json'])
        await fs.writeFile(f, '{"t":2}\n')
        expect((await verifyRootfs(ctx())).join()).toContain('store-template.json must never change')
    })
    it('verify fails on a wrong commit, missing build, pm2 as root, unit not enabled, locked file drift, preload drift', async () => {
        await fs.writeFile(path.join(root, ENGINE, '.git/HEAD'), 'ref: refs/heads/main\n')
        await fs.remove(path.join(root, ENGINE, 'dist'))
        await fs.writeFile(path.join(root, `etc/systemd/system/${PM2_UNIT}`), '[Service]\nUser=root\n')
        await fs.writeFile(path.join(root, 'etc/systemd/system/pm2-root.service'), '')
        await fs.remove(path.join(root, `etc/systemd/system/multi-user.target.wants/${SSH_REGEN_UNIT}`))
        await fs.ensureDir(path.join(root, 'usr/local/sbin')); await fs.writeFile(path.join(root, 'usr/local/sbin/idea-app-data'), 'v5')
        await fs.chmod(path.join(root, 'usr/local/sbin/idea-app-data'), 0o755)
        const l = lock({
            files: [{ path: '/usr/local/sbin/idea-app-data', sha256: sha('v4'), mode: '0700', owner: 'root' }],
            dockerImages: [{ ref: `nginx:1@sha256:${DIGEST}`, imageId: `sha256:${DIGEST}`, tar: 'n.tar', tarSha256: DIGEST } as any],
        })
        const p = (await verifyRootfs({ ...ctx(), lock: l })).join('\n')
        for (const s of ['not detached', 'dist/src/index.js missing', 'User=pi', 'pm2-root', SSH_REGEN_UNIT, 'content differs', 'mode 0755', 'preload nginx', 'images.lock missing'])
            expect(p).toContain(s)
    })
})

const writeDpkg = async (root: string, pkgs: [string, string][]) => {
    await fs.ensureDir(path.join(root, 'var/lib/dpkg'))
    await fs.writeFile(path.join(root, 'var/lib/dpkg/status'), pkgs.map(([p, v]) => `Package: ${p}\nStatus: install ok installed\nArchitecture: arm64\nVersion: ${v}\n`).join('\n') +
        '\nPackage: gone\nStatus: deinstall ok config-files\nArchitecture: arm64\nVersion: 1\n')
}

describe('verify: held packages, units enabled via [Install], per-check count', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    const R = (p: string) => path.join(root, p)
    it('dpkg: install/hold ok installed count; half-installed, config-files, unpacked do not', async () => {
        await fs.ensureDir(R('var/lib/dpkg'))
        const st = (pkg: string, status: string) => `Package: ${pkg}\nStatus: ${status}\nArchitecture: arm64\nVersion: 1\n`
        await fs.writeFile(R('var/lib/dpkg/status'), [st('a', 'install ok installed'), st('docker-ce', 'hold ok installed'), st('b', 'install ok half-installed'),
            st('c', 'deinstall ok config-files'), st('d', 'install ok unpacked'), st('e', 'hold ok half-configured'), st('f', 'purge ok not-installed')].join('\n'))
        expect((await readDpkgStatus(root)).map(x => x.pkg)).toEqual(['a', 'docker-ce'])
        const p = (await verifyRootfs({ root, enginePath: ENGINE, lock: lock({ dockerDebs: [{ pkg: 'docker-ce', version: '1', sha256: 'a'.repeat(64) }, { pkg: 'b', version: '1', sha256: 'a'.repeat(64) }] }), storeIdentity: storeShas })).join('\n')
        expect(p).not.toContain('docker-ce'); expect(p).toContain('package b not installed')
    })
    it('a unit is enabled by a link in its WantedBy/RequiredBy dir, from /etc, /usr/lib or /lib unit files', async () => {
        const W = 'etc/systemd/system'
        await fs.ensureDir(R('lib/systemd/system')); await fs.ensureDir(R('usr/lib/systemd/system'))
        await fs.writeFile(R('lib/systemd/system/regenerate_ssh_host_keys.service'), '[Unit]\nDescription=x\n[Install]\nWantedBy=sysinit.target\n')
        await fs.writeFile(R('usr/lib/systemd/system/req.service'), '[Install]\nRequiredBy=foo.target\nWantedBy=a.target b.target\n')
        await fs.writeFile(R(`${W}/own.service`), '[Service]\nExecStart=/bin/true\n# WantedBy=fake.target\n[Install]\nWantedBy=multi-user.target\n')
        // sysinit.target.wants: enabled; multi-user only: not (its [Install] says sysinit)
        await fs.remove(R(`${W}/multi-user.target.wants/regenerate_ssh_host_keys.service`))
        await fs.ensureDir(R(`${W}/sysinit.target.wants`)); await fs.symlink('/lib/systemd/system/regenerate_ssh_host_keys.service', R(`${W}/sysinit.target.wants/regenerate_ssh_host_keys.service`))
        expect(await unitEnabled(root, 'regenerate_ssh_host_keys.service')).toBe(true)
        expect(await verifyRootfs({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas })).toEqual([])
        await fs.remove(R(`${W}/sysinit.target.wants/regenerate_ssh_host_keys.service`))
        await fs.writeFile(R(`${W}/multi-user.target.wants/regenerate_ssh_host_keys.service`), '')
        expect(await unitEnabled(root, 'regenerate_ssh_host_keys.service')).toBe(false)
        expect((await verifyRootfs({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas })).join('\n')).toContain('unit regenerate_ssh_host_keys.service is not enabled')
        // RequiredBy -> .requires; second WantedBy target; /etc unit file wins; nothing linked -> not enabled
        expect(await unitEnabled(root, 'req.service')).toBe(false)
        await fs.ensureDir(R(`${W}/foo.target.requires`)); await fs.writeFile(R(`${W}/foo.target.requires/req.service`), '')
        expect(await unitEnabled(root, 'req.service')).toBe(true)
        await fs.remove(R(`${W}/foo.target.requires`)); await fs.ensureDir(R(`${W}/b.target.wants`)); await fs.writeFile(R(`${W}/b.target.wants/req.service`), '')
        expect(await unitEnabled(root, 'req.service')).toBe(true)
        expect(await unitInstallTargets(root, 'own.service')).toEqual({ found: true, wants: ['multi-user.target'], requires: [] })
        expect(await unitEnabled(root, 'own.service')).toBe(false)
        // no unit file in the rootfs: any .wants/.requires link counts
        expect(await unitEnabled(root, 'nofile.service')).toBe(false)
        await fs.ensureDir(R(`${W}/graphical.target.wants`)); await fs.writeFile(R(`${W}/graphical.target.wants/nofile.service`), '')
        expect(await unitEnabled(root, 'nofile.service')).toBe(true)
        expect(await unitLinks(root, 'nofile.service')).toEqual(['/etc/systemd/system/graphical.target.wants/nofile.service'])
    })
    it('the report counts passed checks out of VERIFY_CHECKS; a clean rootfs passes all', async () => {
        const all = await verifyRootfsChecks({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas })
        expect(all.map(x => x.name)).toEqual([...VERIFY_CHECKS])
        expect(all.every(x => !x.problems.length)).toBe(true)
        await fs.writeFile(R('etc/machine-id'), 'abc\n')
        await fs.remove(R(`etc/systemd/system/multi-user.target.wants/${PM2_UNIT}`))
        const bad = await verifyRootfsChecks({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas })
        expect(bad.filter(x => x.problems.length).map(x => x.name)).toEqual(['identity', 'enabled-units'])
        const rep = path.join(root, 'r.json')
        await writeReport(rep, lock(), 'x', bad.flatMap(x => x.problems), bad.filter(x => !x.problems.length).length)
        expect((await fs.readJson(rep)).verify.passed).toBe(VERIFY_CHECKS.length - 2)
    })
})

describe('package pins against dpkg status', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    it('reads installed packages only', async () => {
        await writeDpkg(root, [['raspi-config', '20261001']])
        expect(await readDpkgStatus(root)).toEqual([{ pkg: 'raspi-config', version: '20261001', arch: 'arm64' }])
    })
    it('verify fails on a Raspberry Pi pin, Docker deb, RPi archive or recorded package at another version or missing', async () => {
        await writeDpkg(root, [['raspi-config', '20261001'], ['docker-ce', '5:28.0.0-1'], ['libc6', '2.41-12']])
        const ok = lock({ aptPins: [{ pkg: 'raspi-config', version: '20261001' }] as any, dockerDebs: [{ pkg: 'docker-ce', version: '5:28.0.0-1' }] as any,
            rpiPackages: [{ pkg: 'raspi-config', version: '20261001' }], packages: [{ pkg: 'libc6', version: '2.41-12', arch: 'arm64' }] })
        expect(await verifyRootfs({ root, enginePath: ENGINE, lock: ok, storeIdentity: storeShas })).toEqual([])
        const bad = lock({ aptPins: [{ pkg: 'raspi-config', version: '20260901' }] as any, dockerDebs: [{ pkg: 'docker-ce', version: '5:27.0.0-1' }] as any,
            rpiPackages: [{ pkg: 'rpi-eeprom', version: '1' }], packages: [{ pkg: 'libc6', version: '2.41-11', arch: 'arm64' }] })
        const p = (await verifyRootfs({ root, enginePath: ENGINE, lock: bad, storeIdentity: storeShas })).join('\n')
        expect(p).toContain('raspi-config 20261001, lock says 20260901'); expect(p).toContain('docker-ce 5:28.0.0-1, lock says 5:27.0.0-1')
        expect(p).toContain('rpi-eeprom not installed'); expect(p).toContain('libc6 2.41-12, lock says 2.41-11')
    })
})

describe('npm tools (bundled trees)', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    const v = async (l = lock()) => (await verifyRootfs({ root, enginePath: ENGINE, lock: l, storeIdentity: storeShas })).join('\n')
    it('verify fails on a wrong version, an unbundled or missing dependency, a missing bin and a preload sha256 drift', async () => {
        const pm2 = path.join(root, 'usr/local/lib/node_modules/pm2')
        await fs.writeJson(path.join(pm2, 'package.json'), { name: 'pm2', version: '7.1.0', bin: { pm2: 'bin/pm2' }, dependencies: { a: '1', b: '1' }, bundleDependencies: ['a', 'c'] })
        await fs.remove(path.join(root, 'usr/local/bin/pm2'))
        await fs.writeFile(path.join(root, 'var/lib/idea/preload/npm/pm2-logrotate-3.0.0.tgz'), 'other')
        const p = await v()
        expect(p).toContain('npm tool pm2 7.1.0, lock says 7.1.1'); expect(p).toContain('dependency b not bundled')
        expect(p).toContain('bundled c missing'); expect(p).toContain('/usr/local/bin/pm2 missing')
        expect(p).toContain('pm2-logrotate-3.0.0.tgz sha256 differs')
    })
    it('the lock rejects a bad npm tool entry; pinNpmTools records the cache sha256 and refuses drift', async () => {
        expect(validateLock({ ...lock(), npmTools: [{ name: 'pm2', version: '1', install: 'x', lockfileSha256: 'no', tgz: 'pm2-1.tgz' }] })).toEqual(expect.arrayContaining(['npmTools pm2: bad lockfileSha256', 'npmTools pm2: install must be global or preload']))
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-'))
        await fs.ensureDir(path.join(cache, 'npm-global'))
        const rows: string[] = []
        for (const t of lock().npmTools!) { await fs.writeFile(path.join(cache, 'npm-global', t.tgz), t.name); rows.push([t.name, t.version, t.tgz, sha(t.name), t.lockfileSha256].join('\t')) }
        await fs.writeFile(path.join(cache, 'npm-global/NPM-TOOLS.tsv'), '# header\n' + rows.join('\n') + '\n')
        const fresh = lock({ npmTools: lock().npmTools!.map(({ sha256, ...t }) => t) })
        expect((await pinNpmTools(fresh, cache)).npmTools!.map(t => t.sha256)).toEqual(lock().npmTools!.map(t => sha(t.name)))
        await expect(pinNpmTools(lock(), cache)).rejects.toThrow('the lock says')
        await expect(pinNpmTools(lock({ npmTools: [{ ...fresh.npmTools![0], lockfileSha256: '9'.repeat(64) }] }), cache)).rejects.toThrow('another package-lock.json')
        await fs.remove(cache)
    })
})

describe('rootfs build plan (stubbed runner and installers)', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })

    const record = () => {
        const log: string[] = []
        const r: Runner = { host: async c => { log.push(`host: ${c}`); return { stdout: '' } }, chroot: async c => { log.push(`chroot: ${c}`); return { stdout: '' } } }
        const calls: string[] = []
        const inst = new Proxy({}, { get: (_t, k) => async (exec: any) => { calls.push(String(k)); await exec`echo ${String(k)}` } }) as Installers
        return { log, r, inst, calls }
    }
    const opts = () => ({ rootfs: root, lock: lock(), cache: '/cache', repo: '/repo', enginePath: ENGINE, language: 'en_GB.UTF-8', keyboard: 'gb', timezone: 'Europe/Brussels', trackedStoreIdentity: Object.keys(STORE), storeIdentity: storeShas })

    it('quotes template args like zx (arrays one word each)', () => {
        const t = (p: TemplateStringsArray, ...a: unknown[]) => quoteTemplate(p, a)
        expect(t`systemctl enable ${['a.service', "b c"]}`).toBe(`systemctl enable 'a.service' 'b c'`)
        expect(t`echo ${"it's"}`).toBe(`echo 'it'\\''s'`)
    })
    it('guards come first, no SSH, nothing started, units enabled; sanitise last; verify passes', async () => {
        const { log, r, inst, calls } = record()
        const { problems } = await runRootfsBuild(opts(), r, inst, serialiseLock(lock()))
        expect(problems).toEqual([])
        const all = log.join('\n')
        expect(log[0]).toContain('/root/.idea-build')
        const firstInstaller = log.findIndex(l => l.includes("echo 'pinAptSnapshot'"))
        expect(log.findIndex(l => l.includes('policy-rc.d'))).toBeLessThan(firstInstaller)
        expect(log.findIndex(l => l.includes('ssh-keygen -A'))).toBeLessThan(log.findIndex(l => l.includes("echo 'installUdev'")))
        expect(all).not.toMatch(/\bssh\s+\S+@/)
        // commands only, not file contents written (shim bodies, unit files)
        const cmds = log.filter(l => !l.startsWith('host: printf %s')).join('\n')
        expect(cmds).not.toMatch(/systemctl (start|restart)|pm2 (start|startup|save|resurrect)|docker (load|run|network create)|udevadm trigger|tailscale up/)
        expect(all).toContain(`systemctl enable ${[...IMAGE_ENABLED_UNITS].sort().map(u => `'${u}'`).join(' ')}`)
        expect(all).toContain('--frozen-lockfile --offline')
        expect(all).toContain(`fetch -q --depth 1 'file:///repo' '${COMMIT}'`)
        expect(all).toContain('checkout -q --detach FETCH_HEAD')
        expect(all).not.toContain('git clone')
        expect(all).toMatch(/-C \/usr\/bin 'tailscale_1\.104\.2_arm64\/tailscale'/)
        expect(all).toMatch(/-C \/usr\/sbin 'tailscale_1\.104\.2_arm64\/tailscaled'/)
        expect(all).not.toMatch(/install-tailscale|TAILSCALE_AUTHKEY|tskey/)
        // npm tools: sha256 checked, installed with no registry, pm2 never run in the chroot
        expect(all).toContain(`echo '${'e'.repeat(64)}  /root/.idea-build/npm/pm2-7.1.1.tgz' | sha256sum -c -`)
        expect(all).toMatch(/env 'npm_config_offline=true' 'npm_config_registry=http:\/\/127\.0\.0\.1:9\/' .* npm install -g '\.\/pm2-7\.1\.1\.tgz' '\.\/pnpm-10\.33\.0\.tgz'/)
        expect(all).toContain(`install -m 0644 '/root/.idea-build/npm/pm2-logrotate-3.0.0.tgz' '/var/lib/idea/preload/npm/pm2-logrotate-3.0.0.tgz'`)
        expect(log.filter(l => l.startsWith("chroot:")).join("\n")).not.toMatch(/pm2 (--version|install|start|ls)|(^|[^p])npm (install|i) (?!-g)/m)
        expect(all).toContain('pnpm install --frozen-lockfile --offline')
        expect(all).toContain('npm_config_manage_package_manager_versions=false')
        expect(calls).toEqual(['pinAptSnapshot', 'updateSystem', 'installRpiPins', 'installAvahi', 'localiseSystem', 'installCrontabs', 'installUdev', 'installVarious', 'installVarious2', 'buildAppsInfrastructure', 'grantNetBindCapability'])
        expect(await fs.readFile(path.join(root, IMAGE_LOCK_PATH.slice(1)), 'utf8')).toBe(serialiseLock({ ...lock(), packages: [], rpiPackages: [] }))
        expect(await fs.readFile(path.join(root, IMAGE_VERSION_PATH.slice(1)), 'utf8')).toBe(`1.0 ${COMMIT}\n`)
    })
    it('records every package version and the Raspberry Pi archive set in the lock; a lock with rpiPackages installs exactly those', async () => {
        await writeDpkg(root, [['raspi-config', '20261001'], ['libc6', '2.41-12']])
        await fs.ensureDir(path.join(root, 'var/lib/apt/lists'))
        await fs.writeFile(path.join(root, 'var/lib/apt/lists/archive.raspberrypi.com_debian_dists_trixie_main_binary-arm64_Packages'), 'Package: raspi-config\nVersion: 20261001\n\n')
        const { r, inst } = record()
        const res = await runRootfsBuild(opts(), r, inst, serialiseLock(lock()))
        expect(res.problems).toEqual([])
        const written = JSON.parse(await fs.readFile(path.join(root, IMAGE_LOCK_PATH.slice(1)), 'utf8'))
        expect(written.packages).toEqual([{ pkg: 'libc6', version: '2.41-12', arch: 'arm64' }, { pkg: 'raspi-config', version: '20261001', arch: 'arm64' }])
        expect(written.rpiPackages).toEqual([{ pkg: 'raspi-config', version: '20261001' }])
        expect(res.lockText).toBe(await fs.readFile(path.join(root, IMAGE_LOCK_PATH.slice(1)), 'utf8'))
        const again = record()
        await runRootfsBuild({ ...opts(), lock: lock({ rpiPackages: [{ pkg: 'raspi-config', version: '20261001' }] }) }, again.r, again.inst, '')
        expect(again.log.join('\n')).toContain(`apt-get install -y --allow-downgrades 'raspi-config=20261001'`)
    })
    it('the build stops at the first failing step', async () => {
        const { r, inst } = record()
        const bad: Runner = { host: r.host, chroot: async c => { if (c.includes('ssh-keygen')) throw new Error('boom'); return { stdout: '' } } }
        await expect(runRootfsBuild(opts(), bad, inst, '')).rejects.toThrow('boom')
    })
    it('shims refuse daemon work and an image hostname; sudo shim keeps the shims on PATH', () => {
        expect(SHIMS.pm2).toMatch(/refused/); expect(SHIMS.docker).toMatch(/refused/); expect(SHIMS.hostnamectl).toMatch(/exit 1/)
        expect(SHIMS.udevadm).toMatch(/exit 0/); expect(SHIMS.sudo).toMatch(/exec "\$@"/)
        expect(rootfsSteps(opts(), record().r, record().inst).at(-1)!.name).toMatch(/sanitise/)
    })
    it('identity list covers the INTERFACE.md items', () => {
        for (const p of ['META.yaml', 'etc/ssh/ssh_host_*', 'var/lib/tailscale/*', 'etc/tailscale/debug-authkey']) expect(IDENTITY_PATHS).toContain(p)
        expect(PRELOAD_DOCKER_DIR).toBe('/var/lib/idea/preload/docker')
    })
})

describe('first start from an image /META.yaml (idea#322)', () => {
    it('no diskId (missing, empty, "undefined") -> a generated id, never ENGINE_undefined', () => {
        for (const m of [{}, { diskId: '' }, { diskId: 'undefined' }, { diskId: null }] as any[]) {
            expect(hasDiskId(m)).toBe(false)
            const r = diskIdWithoutHardware(m, () => 'gen-1')
            expect(r).toMatchObject({ diskId: 'gen-1', generated: true })
        }
    })
    it('keeps a user-assigned id; regenerates a cloned hardware id', () => {
        expect(diskIdWithoutHardware({ diskId: 'mine' as any, isHardwareId: false }, () => 'g')).toMatchObject({ diskId: 'mine', generated: false })
        expect(diskIdWithoutHardware({ diskId: 'SER1' as any, isHardwareId: true }, () => 'g')).toMatchObject({ diskId: 'g', generated: true })
    })
    it('a missing /META.yaml is created with the hardware serial, else a UUID', async () => {
        let written: any
        const deps = { exists: () => false, write: async (m: any) => { written = m }, now: () => 1 }
        const a = await ensureSystemMeta('sda2' as any, { path: '/tmp/x/META.yaml', allowCreate: true, deps: { ...deps, readHardwareId: async () => 'SERIAL9' as any } })
        expect(a).toMatchObject({ diskId: 'SERIAL9', isHardwareId: true }); expect(written.diskId).toBe('SERIAL9')
        const b = await ensureSystemMeta('sda2' as any, { path: '/tmp/x/META.yaml', allowCreate: true, deps: { ...deps, readHardwareId: async () => undefined } })
        expect(b!.isHardwareId).toBe(false); expect(String(b!.diskId)).toMatch(/^[0-9a-z-]{10,}$/)
    })
})
