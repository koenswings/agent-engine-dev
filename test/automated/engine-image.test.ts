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
    sanitiseRootfs, verifyRootfs, IDENTITY_PATHS, GENERIC_HOSTNAME, IMAGE_ENABLED_UNITS, PM2_UNIT, SSH_REGEN_UNIT, SSH_HOSTKEYS_UNIT,
    pm2UnitText, sshHostKeysUnitText, sshHostKeyUnitIsUnconditional, DEFAULT_CONSOLE_PATH, preloadManifest, imageIdFromManifest, imageTarName, readDpkgStatus, unitEnabled, unitLinks, unitInstallTargets, verifyRootfsChecks, VERIFY_CHECKS, IMAGE_SPARSE_PATTERNS, filesWithAuthKeyShape, PRELOAD_DOCKER_DIR, IMAGE_LOCK_PATH, IMAGE_VERSION_PATH, rootfsHostProblem,
    OPERATOR_KEYS_DIR, OPERATOR_KEYS_FILE, OPERATOR_KEYS_ASSET, LOGIN_SSHD_DROPIN, LOGIN_SSHD_ASSET, PEER_SSHD_DROPIN_PATH, REQUIRED_OPERATOR_KEY_FPS,
    publicKeyFingerprint, operatorKeysProblems, sshdEffectiveConfig,
} from '../../src/install/engineImage.js'
import { rootfsSteps, runRootfsBuild, engineCloneCommand, consoleCloneCommand, Runner, Installers, SHIMS, quoteTemplate } from '../../src/install/engineRootfs.js'
import { pinNpmTools, writeReport, LOCKED_FILE_SPECS } from '../../src/install/engineImageCli.js'
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
        expect(parseImageArgs({ root: '/mnt/r', 'console-repo': '/src/agent-console-dev' })!.consoleRepo).toBe('/src/agent-console-dev')
        expect(() => parseImageArgs({ root: '/mnt/r', 'console-repo': 'relative' })).toThrow(/absolute/)
    })
    it('a real --root build allows arm64, or another arch with qemu-user-static', () => {
        expect(rootfsHostProblem('arm64', false)).toBeUndefined()
        expect(rootfsHostProblem('arm64', true)).toBeUndefined()
        expect(rootfsHostProblem('x64', true)).toBeUndefined()
        expect(rootfsHostProblem('x64', false)).toMatch(/qemu-user-static/)
        expect(rootfsHostProblem('x64', false)).toMatch(/x64/)
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
        expect(validateLock(lock({ consoleCommit: 'abc' }))).toContain('consoleCommit must be a full 40-hex git SHA')
        expect(validateLock(lock({ consoleCommit: 'b'.repeat(40) }))).toEqual([])
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
    await fs.ensureDir(R('usr/local/sbin')); await fs.writeFile(R('usr/local/sbin/idea-engine-identity'), '#!/bin/bash\n'); await fs.chmod(R('usr/local/sbin/idea-engine-identity'), 0o755)
    await fs.ensureDir(R('usr/local/bin')); await fs.writeFile(R('usr/local/bin/boot.sh'), 'if [[ -x /usr/local/sbin/idea-engine-identity ]]; then /usr/local/sbin/idea-engine-identity; fi\n'); await fs.chmod(R('usr/local/bin/boot.sh'), 0o755)
    await fs.ensureDir(R('var/spool/cron/crontabs')); await fs.writeFile(R('var/spool/cron/crontabs/root'), '0 * * * * systemctl restart avahi-daemon\n@reboot /usr/local/bin/boot.sh\n')
    await fs.ensureDir(R('etc/systemd/system/multi-user.target.wants')); await fs.writeFile(R('etc/systemd/system/multi-user.target.wants/cron.service'), '')
    await fs.ensureDir(R('usr/bin')); await fs.writeFile(R('usr/bin/tailscale'), ''); await fs.ensureDir(R('usr/sbin')); await fs.writeFile(R('usr/sbin/tailscaled'), '')
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
    await fs.ensureDir(R('etc/systemd/system/sysinit.target.wants'))
    await fs.writeFile(R(`etc/systemd/system/${PM2_UNIT}`), pm2UnitText())
    await fs.writeFile(R(`etc/systemd/system/${SSH_HOSTKEYS_UNIT}`), sshHostKeysUnitText())
    for (const u of IMAGE_ENABLED_UNITS) {
        const dir = u === SSH_HOSTKEYS_UNIT || u === SSH_REGEN_UNIT ? 'sysinit.target.wants' : 'multi-user.target.wants'
        await fs.ensureDir(R(`etc/systemd/system/${dir}`))
        await fs.writeFile(R(`etc/systemd/system/${dir}/${u}`), '')
    }
    await fs.ensureDir(R('boot/firmware')); await fs.writeFile(R('boot/firmware/ssh'), '')
    await fs.ensureDir(R(DEFAULT_CONSOLE_PATH.slice(1))); await fs.writeFile(R(`${DEFAULT_CONSOLE_PATH.slice(1)}/index.html`), '<!doctype html>')
    await fs.writeFile(R('etc/machine-id'), ''); await fs.writeFile(R('etc/hostname'), GENERIC_HOSTNAME + '\n')
    await fs.writeFile(R('etc/hosts'), '127.0.0.1\tlocalhost\n127.0.1.1\traspberrypi\n')
    await fs.ensureDir(R('etc/idea')); await fs.writeFile(R(IMAGE_LOCK_PATH.slice(1)), serialiseLock(lock())); await fs.writeFile(R(IMAGE_VERSION_PATH.slice(1)), '1.0\n')
    await addSshLogin(root)
}
/** The repo's sshd assets as the build installs them (idea#453): Debian sshd_config, login + peer drop-ins, operator keys. */
const ASSETS = path.resolve('script/build_image_assets') // cwd = repo root (vitest and the dist-test gate)
const DEBIAN_SSHD_CONFIG = 'Include /etc/ssh/sshd_config.d/*.conf\n#PasswordAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM yes\nSubsystem sftp /usr/lib/openssh/sftp-server\n'
const addSshLogin = async (root: string) => {
    const R = (p: string) => path.join(root, p)
    await fs.ensureDir(R('etc/ssh/sshd_config.d'))
    await fs.writeFile(R('etc/ssh/sshd_config'), DEBIAN_SSHD_CONFIG)
    await fs.copy(path.join(ASSETS, LOGIN_SSHD_ASSET), R(LOGIN_SSHD_DROPIN.slice(1)))
    await fs.copy(path.join(ASSETS, '10-idea-peer.conf'), R(PEER_SSHD_DROPIN_PATH.slice(1)))
    await fs.ensureDir(R(OPERATOR_KEYS_DIR.slice(1))); await fs.chmod(R(OPERATOR_KEYS_DIR.slice(1)), 0o755)
    await fs.copy(path.join(ASSETS, OPERATOR_KEYS_ASSET), R(OPERATOR_KEYS_FILE.slice(1))); await fs.chmod(R(OPERATOR_KEYS_FILE.slice(1)), 0o644)
}
const addIdentity = async (root: string) => {
    const R = (p: string) => path.join(root, p)
    await fs.writeFile(R('META.yaml'), 'diskId: ABC\nisHardwareId: true\n')
    await fs.ensureDir(R('etc/ssh')); await fs.writeFile(R('etc/ssh/ssh_host_ed25519_key'), 'k')
    await fs.ensureDir(R('var/lib/tailscale')); await fs.writeFile(R('var/lib/tailscale/tailscaled.state'), '{}')
    await fs.ensureDir(R('etc/tailscale')); await fs.chmod(R('etc/tailscale'), 0o700); await fs.writeFile(R('etc/tailscale/debug-authkey'), 'tskey-' + 'auth-' + 'FAKE')
    await fs.writeFile(R('etc/machine-id'), '0123456789abcdef0123456789abcdef\n'); await fs.writeFile(R('etc/hostname'), 'brave-otter\n')
    await fs.writeFile(R('etc/hosts'), '127.0.0.1\tlocalhost\n127.0.1.1\tbrave-otter\n')
    await fs.ensureDir(R('home/pi/.pm2')); await fs.writeFile(R('home/pi/.pm2/dump.pm2'), '[]')
    await fs.ensureDir(R(`${ENGINE}/store-data`)); await fs.writeFile(R(`${ENGINE}/store-identity/extra-store.txt`), 'x')
    await fs.ensureDir(R('root/.idea-build/shims')); await fs.ensureDir(R('usr/sbin')); await fs.writeFile(R('usr/sbin/policy-rc.d'), 'exit 101')
    // login keys a build host or a used Pi would leave behind (idea#453: sanitise strips them, not the operator list)
    await fs.ensureDir(R('etc/ssh/idea_authorized_keys')); await fs.writeFile(R('etc/ssh/idea_authorized_keys/pi'), 'restrict,command="/usr/local/sbin/idea-peer-gate" ssh-ed25519 AAAA peer\n')
    await fs.ensureDir(R('home/pi/.ssh'))
    for (const n of ['id_ed25519', 'id_ed25519.pub', 'authorized_keys']) await fs.writeFile(R(`home/pi/.ssh/${n}`), 'x\n')
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
        for (const s of ['/META.yaml', 'ssh_host_ed25519_key', 'tailscaled.state', 'debug-authkey', 'machine-id is not empty', 'hostname', 'dump.pm2', 'store-data', 'extra-store.txt', 'policy-rc.d', '.idea-build',
            '/etc/ssh/idea_authorized_keys/pi', '/home/pi/.ssh/id_ed25519', '/home/pi/.ssh/id_ed25519.pub', '/home/pi/.ssh/authorized_keys'])
            expect(p.join('\n')).toContain(s)
        const done = await sanitiseRootfs({ root, enginePath: ENGINE, trackedStoreIdentity: Object.keys(STORE) })
        expect(done.length).toBeGreaterThan(5)
        expect(await verifyRootfs(ctx())).toEqual([])
        expect(await fs.readFile(path.join(root, 'etc/machine-id'), 'utf8')).toBe('')
        expect(await fs.readlink(path.join(root, 'var/lib/dbus/machine-id'))).toBe('/etc/machine-id')
        expect(await sanitiseRootfs({ root, enginePath: ENGINE, trackedStoreIdentity: Object.keys(STORE) })).toEqual([]) // idempotent
        // idea#453: the baked operator list survives sanitise; per-device login keys do not
        expect(await fs.readFile(path.join(root, OPERATOR_KEYS_FILE.slice(1)), 'utf8')).toBe(await fs.readFile(path.join(ASSETS, OPERATOR_KEYS_ASSET), 'utf8'))
        for (const n of ['etc/ssh/idea_authorized_keys/pi', 'home/pi/.ssh/id_ed25519', 'home/pi/.ssh/id_ed25519.pub', 'home/pi/.ssh/authorized_keys']) expect(await fs.pathExists(path.join(root, n))).toBe(false)
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
        await fs.remove(path.join(root, `etc/systemd/system/sysinit.target.wants/${SSH_REGEN_UNIT}`))
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

const ATLAS_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP5pJ426w/HVTUBn4wIfxv4XGnRjoQnihRAavat+ww/p atlas-box@grok-bot'
const KOEN_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMlIyR5gN9KVEOeQl4cAsJOho/2ZprcyXhxTof8BKBQ2 koenswings@Macbook-Air-15.local'
const WALKER_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIIyC4cm+Pt+aOqYtDpgwBZ30O5LIUlbvZfshpa/WoE4 walker@idea02'
const KOEN_FP = 'SHA256:yPqCMHCaXih7uMHxpXd469dAmgkDChOntKkQQVMF90I'
const ATLAS_FP = 'SHA256:L+pEPj+XrDyBzbKiA9CdsXK9cTuos9EHUSTWKUDfNkg'
const REQUIRED_LINES = `${KOEN_LINE}\n${ATLAS_LINE}\n`
const OTHER_LINE = `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString('base64')} other@x`

describe('operator SSH login (idea#453, option B)', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    const R = (p: string) => path.join(root, p)
    const ctx = (over: object = {}) => ({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas, ...over })
    const problemsOf = async (name: string, over: object = {}) => (await verifyRootfsChecks(ctx(over))).find(x => x.name === name)!.problems.join('\n')

    it('the committed list is public keys only: Koen, Atlas box, idea02 walker (in that order); Koen + Atlas required', async () => {
        const text = await fs.readFile(path.join(ASSETS, OPERATOR_KEYS_ASSET), 'utf8')
        expect(text).not.toMatch(/PRIVATE KEY/)
        const keys = text.split('\n').filter(l => l.trim() && !l.startsWith('#'))
        expect(keys).toEqual([KOEN_LINE, ATLAS_LINE, WALKER_LINE])
        expect(keys.map(publicKeyFingerprint)).toEqual([KOEN_FP, ATLAS_FP, 'SHA256:d0DTf5fVFugD9vBG5DyZxSd+6YQy91Sv3/TLfavbcig'])
        expect([...REQUIRED_OPERATOR_KEY_FPS]).toEqual([KOEN_FP, ATLAS_FP])
        expect(operatorKeysProblems(text)).toEqual([])
        // the walker key is allowed, not required
        expect(operatorKeysProblems(REQUIRED_LINES)).toEqual([])
    })
    it('fingerprints like ssh-keygen -lf; options, junk and a type/blob mismatch are not plain keys', () => {
        expect(publicKeyFingerprint(ATLAS_LINE)).toBe(ATLAS_FP)
        expect(publicKeyFingerprint(KOEN_LINE)).toBe(KOEN_FP)
        expect(publicKeyFingerprint(`restrict ${ATLAS_LINE}`)).toBeUndefined()
        expect(publicKeyFingerprint(ATLAS_LINE.replace('ssh-ed25519', 'ssh-rsa'))).toBeUndefined()
        expect(publicKeyFingerprint('ssh-ed25519 not*base64')).toBeUndefined()
        expect(operatorKeysProblems(OTHER_LINE).join()).toContain('lacks the required operator key')
        expect(operatorKeysProblems('# only a comment\n').join()).toContain('has no operator key')
        expect(operatorKeysProblems(`${ATLAS_LINE}\n`).join()).toContain(`lacks the required operator key ${KOEN_FP}`)
        expect(operatorKeysProblems(`${KOEN_LINE}\n${WALKER_LINE}\n`).join()).toContain(`lacks the required operator key ${ATLAS_FP}`)
        expect(operatorKeysProblems(`${REQUIRED_LINES}command="x" ${OTHER_LINE}`).join()).toContain('line 3 is not a plain public key')
        expect(operatorKeysProblems(`${REQUIRED_LINES}-----BEGIN OPENSSH PRIVATE KEY-----`).join()).toContain('private key material')
    })
    it('several operator keys: all required ones must be present, each key once, comments and blank lines allowed', async () => {
        const fpOther = publicKeyFingerprint(OTHER_LINE)!
        const two = `# fleet\n${ATLAS_LINE}\n\n${OTHER_LINE}\n`
        expect(operatorKeysProblems(two, [ATLAS_FP, fpOther])).toEqual([])
        expect(operatorKeysProblems(`${ATLAS_LINE}\n`, [ATLAS_FP, fpOther]).join()).toContain(`lacks the required operator key ${fpOther}`)
        expect(operatorKeysProblems(`${OTHER_LINE}\n`, [ATLAS_FP, fpOther]).join()).toContain('lacks the required operator key SHA256:L+pE')
        expect(operatorKeysProblems(`${ATLAS_LINE}\n${ATLAS_LINE.replace('atlas-box@grok-bot', 'copy')}\n`).join()).toContain('line 2 repeats key')
        // the installed file may carry more keys than the required set
        await fs.writeFile(R(OPERATOR_KEYS_FILE.slice(1)), `${REQUIRED_LINES}${WALKER_LINE}\n${OTHER_LINE}\n`)
        expect(await problemsOf('operator-keys')).toBe('')
    })
    it('every required fingerprint is in the committed list', async () => {
        const text = await fs.readFile(path.join(ASSETS, OPERATOR_KEYS_ASSET), 'utf8')
        const fps = text.split('\n').map(publicKeyFingerprint).filter(Boolean)
        for (const fp of REQUIRED_OPERATOR_KEY_FPS) expect(fps).toContain(fp)
    })
    it('a clean rootfs passes operator-keys and ssh-no-password', async () => {
        expect(await problemsOf('operator-keys')).toBe('')
        expect(await problemsOf('ssh-no-password')).toBe('')
        const e = await sshdEffectiveConfig(root)
        expect(e.first.get('passwordauthentication')).toEqual({ value: 'no', file: LOGIN_SSHD_DROPIN })
        expect(e.first.get('authorizedkeysfile')!.file).toBe(PEER_SSHD_DROPIN_PATH)
    })
    it('the sshd assets and the operator list are locked files; sanitise never lists the operator keys', () => {
        expect(LOCKED_FILE_SPECS).toContainEqual({ asset: OPERATOR_KEYS_ASSET, path: OPERATOR_KEYS_FILE, mode: '0644' })
        expect(LOCKED_FILE_SPECS).toContainEqual({ asset: LOGIN_SSHD_ASSET, path: LOGIN_SSHD_DROPIN, mode: '0644' })
        expect(IDENTITY_PATHS.some(p => p.includes('idea_operator_keys'))).toBe(false)
    })
    it('operator-keys fails when the file is missing, empty, a symlink, the wrong mode, not root (real rootfs) or lacks the Atlas key', async () => {
        const f = R(OPERATOR_KEYS_FILE.slice(1))
        await fs.remove(f)
        expect(await problemsOf('operator-keys')).toContain(`${OPERATOR_KEYS_FILE} missing`)
        await fs.writeFile(f, ''); await fs.chmod(f, 0o644)
        expect(await problemsOf('operator-keys')).toContain('has no operator key')
        await fs.writeFile(f, OTHER_LINE + '\n')
        expect(await problemsOf('operator-keys')).toContain('lacks the required operator key SHA256:L+pE')
        await fs.writeFile(f, REQUIRED_LINES); await fs.chmod(f, 0o664)
        expect(await problemsOf('operator-keys')).toContain('mode 0664, must be 0644')
        await fs.chmod(f, 0o644); await fs.chmod(R(OPERATOR_KEYS_DIR.slice(1)), 0o775)
        expect(await problemsOf('operator-keys')).toContain(`${OPERATOR_KEYS_DIR} mode 0775`)
        await fs.chmod(R(OPERATOR_KEYS_DIR.slice(1)), 0o755)
        expect(await problemsOf('operator-keys')).toBe('')
        if (process.getuid?.() !== 0) expect(await problemsOf('operator-keys', { piUid: 1000 })).toContain(`${OPERATOR_KEYS_FILE} must be owned by root:root`)
        await fs.remove(f); await fs.symlink('/home/pi/keys', f)
        expect(await problemsOf('operator-keys')).toContain('must be a regular file')
        await fs.remove(R(OPERATOR_KEYS_DIR.slice(1)))
        expect(await problemsOf('operator-keys')).toContain(`${OPERATOR_KEYS_DIR} missing`)
    })
    it('operator-keys fails when AuthorizedKeysFile lacks the operator, peer or user path, or another file sets it first', async () => {
        const peer = R(PEER_SSHD_DROPIN_PATH.slice(1))
        const orig = await fs.readFile(peer, 'utf8')
        await fs.writeFile(peer, orig.replace(' /etc/ssh/idea_operator_keys/%u', ''))
        expect(await problemsOf('operator-keys')).toContain('lacks /etc/ssh/idea_operator_keys/%u')
        await fs.writeFile(peer, orig.replace(' /etc/ssh/idea_authorized_keys/%u', ''))
        expect(await problemsOf('operator-keys')).toContain('lacks /etc/ssh/idea_authorized_keys/%u')
        await fs.writeFile(peer, orig.replace('AuthorizedKeysFile .ssh/authorized_keys ', 'AuthorizedKeysFile '))
        expect(await problemsOf('operator-keys')).toContain('lacks .ssh/authorized_keys')
        await fs.writeFile(peer, orig)
        await fs.writeFile(R('etc/ssh/sshd_config.d/05-other.conf'), 'AuthorizedKeysFile .ssh/authorized_keys\n')
        expect(await problemsOf('operator-keys')).toContain('AuthorizedKeysFile is set first by /etc/ssh/sshd_config.d/05-other.conf')
        await fs.remove(R('etc/ssh/sshd_config.d/05-other.conf')); await fs.remove(peer)
        expect(await problemsOf('operator-keys')).toContain(`${PEER_SSHD_DROPIN_PATH} missing`)
    })
    it('ssh-no-password fails when the drop-in is missing, says yes, or loses to an earlier file or a Match block', async () => {
        const login = R(LOGIN_SSHD_DROPIN.slice(1))
        const orig = await fs.readFile(login, 'utf8')
        await fs.remove(login)
        let p = await problemsOf('ssh-no-password')
        expect(p).toContain(`${LOGIN_SSHD_DROPIN} missing`)
        expect(p).toContain('PasswordAuthentication is unset (sshd default yes)')
        await fs.writeFile(login, orig.replace('PasswordAuthentication no', 'PasswordAuthentication yes'))
        expect(await problemsOf('ssh-no-password')).toContain(`PasswordAuthentication is yes (${LOGIN_SSHD_DROPIN})`)
        await fs.writeFile(login, orig)
        await fs.writeFile(R('etc/ssh/sshd_config.d/01-cloud.conf'), 'PasswordAuthentication yes\nChallengeResponseAuthentication yes\n')
        p = await problemsOf('ssh-no-password')
        expect(p).toContain('PasswordAuthentication is yes (/etc/ssh/sshd_config.d/01-cloud.conf)')
        expect(p).toContain('yes (/etc/ssh/sshd_config.d/01-cloud.conf); must be no')
        await fs.remove(R('etc/ssh/sshd_config.d/01-cloud.conf'))
        // a value in sshd_config BEFORE the Include wins over every drop-in
        await fs.writeFile(R('etc/ssh/sshd_config'), 'PasswordAuthentication yes\n' + DEBIAN_SSHD_CONFIG)
        expect(await problemsOf('ssh-no-password')).toContain('PasswordAuthentication is yes (/etc/ssh/sshd_config)')
        await fs.writeFile(R('etc/ssh/sshd_config'), DEBIAN_SSHD_CONFIG + 'Match User pi\n  PasswordAuthentication yes\n')
        expect(await problemsOf('ssh-no-password')).toContain('a Match block sets passwordauthentication yes')
        await fs.writeFile(R('etc/ssh/sshd_config'), DEBIAN_SSHD_CONFIG)
        expect(await problemsOf('ssh-no-password')).toBe('')
        await fs.remove(R('etc/ssh/sshd_config'))
        expect(await problemsOf('ssh-no-password')).toContain('/etc/ssh/sshd_config missing')
    })
    it('the build installs the list and the drop-in root-owned after peer access, then checks sshd -t', async () => {
        const log: string[] = []
        const r: Runner = { host: async c => { log.push(`host: ${c}`); return { stdout: '' } }, chroot: async c => { log.push(`chroot: ${c}`); return { stdout: '' } } }
        const inst = new Proxy({}, { get: (_t, k) => async (exec: any) => { await exec`echo ${String(k)}` } }) as Installers
        const steps = rootfsSteps({ rootfs: root, lock: lock(), cache: '/c', repo: '/r', enginePath: ENGINE, language: 'en_GB.UTF-8', keyboard: 'gb', timezone: 'Europe/Brussels', trackedStoreIdentity: [], storeIdentity: storeShas, boot: R('boot/firmware') } as any, r, inst)
        const i = steps.findIndex(s => /idea#453/.test(s.name))
        expect(i).toBeGreaterThan(steps.findIndex(s => /peer access/.test(s.name)))
        await steps[i].run()
        expect(log).toEqual([
            `chroot: install -d -o root -g root -m 0755 '${OPERATOR_KEYS_DIR}'`,
            `chroot: install -o root -g root -m 0644 '${ENGINE}/script/build_image_assets/${OPERATOR_KEYS_ASSET}' '${OPERATOR_KEYS_FILE}'`,
            `chroot: install -o root -g root -m 0644 '${ENGINE}/script/build_image_assets/${LOGIN_SSHD_ASSET}' '${LOGIN_SSHD_DROPIN}'`,
            'chroot: sshd -t',
        ])
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
        await fs.remove(R(`${W}/sysinit.target.wants/regenerate_ssh_host_keys.service`))
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

describe('ssh first-boot and Console verify (build 6 failures)', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    const ctx = () => ({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas })
    it('fails if the Console dist index.html is missing', async () => {
        await fs.remove(path.join(root, DEFAULT_CONSOLE_PATH.slice(1), 'index.html'))
        expect((await verifyRootfs(ctx())).join('\n')).toContain('Console dist index.html missing')
    })
    it('fails if idea-ssh-host-keys.service is missing, has ConditionFirstBoot, or is not enabled', async () => {
        await fs.remove(path.join(root, `etc/systemd/system/${SSH_HOSTKEYS_UNIT}`))
        expect((await verifyRootfs(ctx())).join('\n')).toMatch(/idea-ssh-host-keys\.service is missing/)
        await goodRootfs(root)
        await fs.writeFile(path.join(root, `etc/systemd/system/${SSH_HOSTKEYS_UNIT}`), '[Unit]\nConditionFirstBoot=yes\n[Service]\nExecStart=/usr/bin/ssh-keygen -A\n[Install]\nWantedBy=sysinit.target\n')
        expect((await verifyRootfs(ctx())).join('\n')).toMatch(/without ConditionFirstBoot=yes/)
        await fs.writeFile(path.join(root, `etc/systemd/system/${SSH_HOSTKEYS_UNIT}`), sshHostKeysUnitText())
        await fs.remove(path.join(root, `etc/systemd/system/sysinit.target.wants/${SSH_HOSTKEYS_UNIT}`))
        expect((await verifyRootfs(ctx())).join('\n')).toContain(`unit ${SSH_HOSTKEYS_UNIT} is not enabled`)
    })
    it('fails if the bootfs ssh trigger is missing when a boot dir is present', async () => {
        await fs.remove(path.join(root, 'boot/firmware/ssh'))
        expect((await verifyRootfs(ctx())).join('\n')).toMatch(/bootfs has no ssh/)
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

describe('idea-engine-identity on every boot, tailscaled not enabled (#291 combined)', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    const v = async () => (await verifyRootfs({ root, enginePath: ENGINE, lock: lock(), storeIdentity: storeShas })).join('\n')
    it('fails without the helper, boot.sh call, @reboot cron or cron enabled', async () => {
        const R = (p: string) => path.join(root, p)
        await fs.chmod(R('usr/local/sbin/idea-engine-identity'), 0o644)
        await fs.writeFile(R('usr/local/bin/boot.sh'), 'echo hi\n')
        await fs.writeFile(R('var/spool/cron/crontabs/root'), '#@reboot /usr/local/bin/boot.sh\n')
        await fs.remove(R('etc/systemd/system/multi-user.target.wants/cron.service'))
        const p = await v()
        expect(p).toContain('idea-engine-identity must be mode 0755'); expect(p).toContain('boot.sh does not run')
        expect(p).toContain('no @reboot'); expect(p).toContain('cron.service is not enabled')
        await fs.remove(R('usr/local/sbin/idea-engine-identity'))
        expect(await v()).toContain('/usr/local/sbin/idea-engine-identity missing')
    })
    it('fails when tailscaled is enabled or tailscale is missing', async () => {
        await fs.writeFile(path.join(root, 'etc/systemd/system/multi-user.target.wants/tailscaled.service'), '')
        await fs.remove(path.join(root, 'usr/bin/tailscale'))
        const p = await v()
        expect(p).toContain('tailscaled.service is enabled'); expect(p).toContain('tailscale not installed')
    })
    it('tailscaled linked in ANY .wants/.requires dir fails; cron enabled through its own [Install] target passes', async () => {
        const W = path.join(root, 'etc/systemd/system')
        await fs.ensureDir(path.join(W, 'network-online.target.requires')); await fs.writeFile(path.join(W, 'network-online.target.requires/tailscaled.service'), '')
        expect(await v()).toContain('tailscaled.service is enabled (/etc/systemd/system/network-online.target.requires/tailscaled.service)')
        await fs.remove(path.join(W, 'network-online.target.requires'))
        await fs.ensureDir(path.join(root, 'lib/systemd/system')); await fs.writeFile(path.join(root, 'lib/systemd/system/cron.service'), '[Install]\nWantedBy=graphical.target\n')
        expect(await v()).toContain('cron.service is not enabled')
        await fs.ensureDir(path.join(W, 'graphical.target.wants')); await fs.writeFile(path.join(W, 'graphical.target.wants/cron.service'), '')
        expect(await v()).toBe('')
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
    const CONSOLE = 'b'.repeat(40)
    const opts = () => ({ rootfs: root, lock: lock({ consoleCommit: CONSOLE }), cache: '/cache', repo: '/repo', enginePath: ENGINE, language: 'en_GB.UTF-8', keyboard: 'gb', timezone: 'Europe/Brussels', trackedStoreIdentity: Object.keys(STORE), storeIdentity: storeShas, boot: path.join(root, 'boot/firmware'), consoleRepo: '/console-repo' })

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
        expect(log.findIndex(l => l.includes("install -d -m 0755") && l.includes('/run/sshd'))).toBeLessThan(log.findIndex(l => l.includes('ssh-keygen -A')))
        expect(log.findIndex(l => l.includes('/run/sshd'))).toBeLessThan(log.findIndex(l => l.includes("echo 'installUdev'")))
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
        expect(all).toContain(`fetch -q --depth 1 'file:///console-repo' '${CONSOLE}'`)
        expect(all).toContain('cd /home/pi/idea/agents/agent-console-dev && pnpm install --frozen-lockfile && pnpm build')
        expect(all).toContain(`etc/systemd/system/${SSH_HOSTKEYS_UNIT}`)
        expect(sshHostKeyUnitIsUnconditional(sshHostKeysUnitText())).toBe(true)
        expect(sshHostKeyUnitIsUnconditional('[Unit]\nConditionFirstBoot=yes\n[Service]\nExecStart=/usr/bin/ssh-keygen -A\n')).toBe(false)
        expect(consoleCloneCommand('/console-repo', '/mnt/agent-console-dev', CONSOLE)).toContain("remote add origin https://github.com/koenswings/agent-console-dev.git")
        expect(calls).toEqual(['pinAptSnapshot', 'updateSystem', 'installRpiPins', 'installAvahi', 'localiseSystem', 'installCrontabs', 'installUdev', 'installVarious', 'installVarious2', 'buildAppsInfrastructure', 'grantNetBindCapability'])
        expect(await fs.readFile(path.join(root, IMAGE_LOCK_PATH.slice(1)), 'utf8')).toBe(serialiseLock({ ...lock({ consoleCommit: CONSOLE }), packages: [], rpiPackages: [] }))
        expect(await fs.readFile(path.join(root, IMAGE_VERSION_PATH.slice(1)), 'utf8')).toBe(`1.0 ${COMMIT}\n`)
    })
    it('guards create /run/sshd before ssh-keygen and before installUdev (sshd -t)', async () => {
        const { log, r, inst } = record()
        await runRootfsBuild(opts(), r, inst, serialiseLock(lock()))
        const mkdirSshd = log.findIndex(l => l.includes("install -d -m 0755") && l.includes('/run/sshd'))
        const keygen = log.findIndex(l => l.includes('ssh-keygen -A'))
        const udev = log.findIndex(l => l.includes("echo 'installUdev'"))
        expect(mkdirSshd).toBeGreaterThanOrEqual(0)
        expect(mkdirSshd).toBeLessThan(keygen)
        expect(keygen).toBeLessThan(udev)
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
        await runRootfsBuild({ ...opts(), lock: lock({ consoleCommit: CONSOLE, rpiPackages: [{ pkg: 'raspi-config', version: '20261001' }] }) }, again.r, again.inst, '')
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

describe('no dev files in the image (sparse Engine clone, secret scan)', () => {
    let root: string
    const R = (rel: string) => path.join(root, rel)
    const KEY = 'tskey-' + 'auth-' + 'k1x'
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'rootfs-')); await goodRootfs(root) })
    afterEach(async () => { await fs.remove(root) })
    const devProblems = async (l = lock()) =>
        (await verifyRootfsChecks({ root, enginePath: ENGINE, lock: l, storeIdentity: storeShas })).find(x => x.name === 'no-dev-files')!.problems
    it('a clean rootfs passes; test/, dist/test/ and other dev trees fail', async () => {
        expect(await devProblems()).toEqual([])
        for (const d of ['test/automated', 'dist/test', 'script/idea02-walker']) {
            await fs.ensureDir(R(`${ENGINE}/${d}`))
            expect((await devProblems()).join('\n')).toContain(`${ENGINE}/${d.split('/automated')[0]} present`)
            await fs.remove(R(`${ENGINE}/${d.split('/')[0] === 'script' ? d : d.split('/')[0] === 'dist' ? d : 'test'}`))
        }
        expect(await devProblems()).toEqual([])
    })
    it('any Tailscale auth/client key prefix under the Engine tree fails (node_modules included, .git skipped)', async () => {
        await fs.outputFile(R(`${ENGINE}/node_modules/x/a.js`), `const k = "${KEY}"`)
        await fs.outputFile(R(`${ENGINE}/dist/src/b.js`), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(KEY)]))
        await fs.outputFile(R(`${ENGINE}/src/ok.ts`), "/tskey[-](auth|client)[-]x/ or 'tskey-' + 'auth-' + x, tskey-other-1")
        await fs.outputFile(R(`${ENGINE}/.git/objects/x`), KEY)
        await fs.outputFile(R(`${ENGINE}/script/c.sh`), 'K=' + 'tskey-' + 'client-' + 'Q9z')
        expect(await filesWithAuthKeyShape(R(ENGINE))).toEqual(['dist/src/b.js', 'node_modules/x/a.js', 'script/c.sh'])
        expect((await devProblems()).length).toBe(3)
        expect((await devProblems()).join()).toContain('Tailscale auth-key prefix')
    })
    it('the sparse patterns in .git/info/sparse-checkout must match the lock', async () => {
        const l = lock({ sparseCheckout: IMAGE_SPARSE_PATTERNS })
        await fs.outputFile(R(`${ENGINE}/.git/info/sparse-checkout`), IMAGE_SPARSE_PATTERNS.join('\n') + '\n')
        expect(await devProblems(l)).toEqual([])
        await fs.outputFile(R(`${ENGINE}/.git/info/sparse-checkout`), '/*\n')
        expect((await devProblems(l)).join()).toContain('does not match')
        expect(validateLock({ ...l, sparseCheckout: [''] })).toContain('sparseCheckout must be a list of patterns')
    })
    it('the clone step: real git, sparse, clean status, and an update (fetch + checkout -B, pull) stays sparse', async () => {
        const $ = (cmd: string, cwd = root) => require('child_process').execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }) as string
        const repo = R('repo')
        for (const f of ['src/a.ts', 'script/s.sh', 'script/idea02-walker/w.ts', 'test/automated/x.test.ts', 'proposals/p.md', 'store-identity/store-template.json', 'pm2.config.cjs'])
            await fs.outputFile(path.join(repo, f), f)
        await fs.outputFile(path.join(repo, '.gitignore'), 'dist\nnode_modules/\n')
        $('git init -q -b main && git add -A && git commit -qm one', repo)
        const sha1 = $('git rev-parse HEAD', repo).trim()
        const dest = R('rootfs/home/pi/idea')
        $(engineCloneCommand(repo, dest, sha1, IMAGE_SPARSE_PATTERNS))
        expect((await fs.readdir(dest)).sort()).toEqual(['.git', '.gitignore', 'pm2.config.cjs', 'script', 'src', 'store-identity'])
        expect(await fs.readdir(path.join(dest, 'script'))).toEqual(['s.sh'])
        expect(await fs.readFile(path.join(dest, 'store-identity/store-template.json'), 'utf8')).toBe('store-identity/store-template.json')
        await fs.outputFile(path.join(dest, 'dist/src/a.js'), ''); await fs.ensureDir(path.join(dest, 'node_modules/m'))
        expect($('git status --porcelain', dest)).toBe('')
        expect($('git rev-parse --is-shallow-repository', dest).trim()).toBe('true')
        // update path (provision-fleet.sh: fetch + checkout -B <branch> origin/<branch>; or git pull)
        await fs.outputFile(path.join(repo, 'test/automated/y.test.ts'), 'y'); await fs.outputFile(path.join(repo, 'src/b.ts'), 'b')
        $('git add -A && git commit -qm two', repo)
        $(`git remote set-url origin file://${repo} && git fetch -q origin && git checkout -q -B main origin/main`, dest)
        expect(await fs.pathExists(path.join(dest, 'src/b.ts'))).toBe(true)
        expect(await fs.pathExists(path.join(dest, 'test'))).toBe(false)
        expect($('git status --porcelain', dest)).toBe('')
        await fs.outputFile(path.join(repo, 'src/c.ts'), 'c'); $('git add -A && git commit -qm three', repo)
        $('git pull -q --ff-only origin main', dest)
        expect(await fs.pathExists(path.join(dest, 'src/c.ts'))).toBe(true)
        expect(await fs.pathExists(path.join(dest, 'test'))).toBe(false)
        expect($('git status --porcelain', dest)).toBe('')
    })
})
