/**
 * engineImage.ts: the offline Engine image builder's pure parts (idea#322, Option A).
 *
 * `build-engine --rootfs <dir>` installs the Engine into a mounted Raspberry Pi OS
 * Lite (arm64) root filesystem from a chroot on an arm64 host. Nothing is started at
 * build time, services are only enabled, and the image carries no device identity.
 * This module holds what can be tested without a chroot: argument parsing, the
 * Engine lock (engine.lock.json), the sanitise list, the verify checks and the
 * first-boot unit texts. The chroot orchestration is in engineRootfs.ts.
 */
import { fs, path } from 'zx'
import crypto from 'crypto'

// ── Arguments ───────────────────────────────────────────────────────────────

export type ImageMode = 'rootfs' | 'verify' | 'write-lock'

export interface ImageArgs {
    mode: ImageMode
    /** Mounted target root filesystem (absolute, never '/') */
    rootfs?: string
    /** engine.lock.json path */
    lock?: string
    /** Offline input cache (script/archive-engine-inputs.sh output) */
    cache?: string
    /** Docker images for the lock, each name[:tag]@sha256:<64 hex> */
    images: string[]
    /** pm2 environment the first boot starts the Engine with */
    pm2Env: 'production' | 'development'
    /** Skip the arm64 host check (tests / dry runs only) */
    dryRun: boolean
    /** Mounted boot partition (default <rootfs>/boot/firmware) */
    boot?: string
    /** engine-build.json report (idea tools/engine-image/INTERFACE.md) */
    report?: string
}

/** Options of the live/SSH path that make no sense for an image (identity or remote). */
const LIVE_ONLY = ['m', 'machine', 'u', 'user', 'hostname', 'personalize', 'peer']

export const IMAGE_DIGEST_RE = /^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/

/**
 * Image modes: --rootfs <dir> (build), --verify-rootfs <dir> (check only),
 * --write-lock (write engine.lock.json). Returns null when no image flag is given
 * (the live/SSH path, unchanged). Throws on a bad combination.
 */
/** Thrown for usage errors: exit code 2 (INTERFACE.md) */
export class UsageError extends Error {}

export const parseImageArgs = (argv: Record<string, any>): ImageArgs | null => {
    const build = argv.rootfs ?? argv.root, verify = argv['verify-rootfs'], write = argv['write-lock']
    const modes = [build !== undefined, verify !== undefined, !!write].filter(Boolean).length
    if (modes === 0) return null
    if (modes > 1) throw new UsageError('give only one of --rootfs, --verify-rootfs, --write-lock')
    const bad = LIVE_ONLY.filter(k => argv[k] !== undefined && argv[k] !== false)
    if (bad.length) throw new UsageError(`image builds take no device or remote options: ${bad.map(b => (b.length === 1 ? '-' : '--') + b).join(', ')} (no SSH, no identity in an image)`)
    const mode: ImageMode = build !== undefined ? 'rootfs' : verify !== undefined ? 'verify' : 'write-lock'
    const rootfs = mode === 'write-lock' ? undefined : String(build ?? verify)
    if (rootfs !== undefined) {
        if (!rootfs || rootfs === 'true' || !path.isAbsolute(rootfs)) throw new UsageError('--rootfs/--verify-rootfs needs an absolute path')
        if (path.resolve(rootfs) === '/') throw new UsageError('refusing / as the target root filesystem')
    }
    const lock = argv.lock ?? (typeof write === 'string' ? write : undefined)
    // rootfs: without --lock the lock is generated from the checkout at build time (INTERFACE.md has no lock input)
    if (mode !== 'rootfs' && (!lock || typeof lock !== 'string')) throw new UsageError('--lock <engine.lock.json> is required')
    if (lock !== undefined && typeof lock !== 'string') throw new UsageError('--lock needs a path')
    const images = ([] as any[]).concat(argv.image ?? []).map(String)
    for (const i of images) if (!IMAGE_DIGEST_RE.test(i)) throw new UsageError(`--image ${i}: must be name[:tag]@sha256:<digest> (pinned by digest)`)
    const env = String(argv['pm2-env'] ?? 'production')
    if (env !== 'production' && env !== 'development') throw new UsageError('--pm2-env must be production or development')
    for (const k of ['boot', 'report', 'cache']) if (argv[k] !== undefined && (typeof argv[k] !== 'string' || !path.isAbsolute(argv[k]))) throw new UsageError(`--${k} needs an absolute path`)
    return { mode, rootfs, lock, boot: argv.boot, report: argv.report, cache: argv.cache ? String(argv.cache) : undefined, images, pm2Env: env as ImageArgs['pm2Env'], dryRun: !!argv['dry-run'] }
}

// ── Lock ────────────────────────────────────────────────────────────────────

export const LOCK_SCHEMA = 'idea-engine-lock/1'

export interface LockedImage {
    /** name[:tag]@sha256:<manifest or index digest> */
    ref: string
    /** sha256:<config digest> = the image id `docker image inspect` shows after `docker load` */
    imageId: string
    /** docker-save tarball, relative to the preload dir */
    tar: string
    tarSha256: string
}

export interface LockedFile { path: string, sha256: string, mode: string, owner: string }

export interface EngineLock {
    schema: typeof LOCK_SCHEMA
    engineCommit: string
    engineVersion: string
    arch: 'arm64'
    nodeVersion: string
    pnpmVersion: string
    pm2Version: string
    pm2LogrotateVersion: string
    tailscaleVersion: string
    tailscaleSha256: string
    debianSnapshot: string
    /** script/build_image_assets/apt-rpi-pins.tsv (package = version) */
    aptPins: { pkg: string, version: string }[]
    /** script/build_image_assets/docker-pins.tsv */
    dockerDebs: { pkg: string, version: string, sha256: string }[]
    dockerImages: LockedImage[]
    pm2Env: 'production' | 'development'
    /** Files the build installs, checked by verify (content, mode, owner) */
    files: LockedFile[]
    /** systemd units that must be enabled in the image */
    enabledUnits: string[]
    /** Every installed package at its exact version (recorded after the build, from dpkg status) */
    packages?: { pkg: string, version: string, arch: string }[]
    /** The installed packages that come from archive.raspberrypi.com (it has no snapshots); a rebuild with --lock installs exactly these */
    rpiPackages?: { pkg: string, version: string }[]
}

const HEX40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

export const validateLock = (l: any): string[] => {
    const e: string[] = []
    if (!l || typeof l !== 'object') return ['lock is not an object']
    if (l.schema !== LOCK_SCHEMA) e.push(`schema must be ${LOCK_SCHEMA}`)
    if (!HEX40.test(l.engineCommit ?? '')) e.push('engineCommit must be a full 40-hex git SHA')
    if (l.arch !== 'arm64') e.push('arch must be arm64')
    for (const k of ['engineVersion', 'nodeVersion', 'pnpmVersion', 'pm2Version', 'pm2LogrotateVersion', 'tailscaleVersion', 'debianSnapshot'])
        if (typeof l[k] !== 'string' || !l[k]) e.push(`${k} missing`)
    if (!SHA256.test(l.tailscaleSha256 ?? '')) e.push('tailscaleSha256 must be 64 hex')
    for (const d of l.dockerDebs ?? []) if (!SHA256.test(d.sha256 ?? '')) e.push(`dockerDebs ${d.pkg}: bad sha256`)
    for (const i of l.dockerImages ?? []) {
        if (!IMAGE_DIGEST_RE.test(i.ref ?? '')) e.push(`dockerImages ${i.ref}: not pinned by digest`)
        if (!/^sha256:[0-9a-f]{64}$/.test(i.imageId ?? '')) e.push(`dockerImages ${i.ref}: bad imageId`)
        if (!SHA256.test(i.tarSha256 ?? '')) e.push(`dockerImages ${i.ref}: bad tarSha256`)
        if (!i.tar || i.tar.includes('..') || path.isAbsolute(i.tar)) e.push(`dockerImages ${i.ref}: bad tar path`)
    }
    for (const f of l.files ?? []) {
        if (!path.isAbsolute(f.path ?? '')) e.push(`files ${f.path}: must be absolute`)
        if (!SHA256.test(f.sha256 ?? '')) e.push(`files ${f.path}: bad sha256`)
        if (!/^0[0-7]{3}$/.test(f.mode ?? '')) e.push(`files ${f.path}: bad mode`)
    }
    if (!Array.isArray(l.enabledUnits)) e.push('enabledUnits must be a list')
    if (l.pm2Env !== 'production' && l.pm2Env !== 'development') e.push('pm2Env must be production or development')
    return e
}

/** Stable JSON: keys in insertion order, lists sorted where order carries no meaning. */
export const serialiseLock = (l: EngineLock): string => JSON.stringify({
    ...l,
    aptPins: [...l.aptPins].sort((a, b) => a.pkg.localeCompare(b.pkg)),
    dockerImages: [...l.dockerImages].sort((a, b) => a.ref.localeCompare(b.ref)),
    files: [...l.files].sort((a, b) => a.path.localeCompare(b.path)),
    ...(l.packages ? { packages: [...l.packages].sort((a, b) => a.pkg.localeCompare(b.pkg) || a.arch.localeCompare(b.arch)) } : {}),
    ...(l.rpiPackages ? { rpiPackages: [...l.rpiPackages].sort((a, b) => a.pkg.localeCompare(b.pkg)) } : {}),
    enabledUnits: [...l.enabledUnits].sort(),
}, null, 2) + '\n'

export const writeLock = async (file: string, l: EngineLock): Promise<void> => {
    const errs = validateLock(l)
    if (errs.length) throw new Error(`invalid lock: ${errs.join('; ')}`)
    await fs.writeFile(file, serialiseLock(l))
}

export const readLock = async (file: string): Promise<EngineLock> => {
    const l = JSON.parse(await fs.readFile(file, 'utf8'))
    const errs = validateLock(l)
    if (errs.length) throw new Error(`invalid lock ${file}: ${errs.join('; ')}`)
    return l as EngineLock
}

export const parseDockerPins = (text: string) => text.split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => { const [pkg, version, , sha256] = l.split('\t'); return { pkg, version, sha256 } })

export const sha256File = async (p: string): Promise<string> =>
    crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex')

/** Preload layout inside the image */
export const PRELOAD_DIR = '/var/lib/idea/preload'
export const PRELOAD_DOCKER_DIR = `${PRELOAD_DIR}/docker`
export const PRELOAD_NPM_DIR = `${PRELOAD_DIR}/npm`

/** Tarball name of a pinned image ref in the cache's docker/ dir (archive-engine-inputs.sh naming). */
export const imageTarName = (ref: string) => ref.replace(/[\/:@]/g, '_') + '.tar'

// ── First boot ──────────────────────────────────────────────────────────────

export const FIRSTBOOT_UNIT = 'idea-engine-firstboot.service'
export const PM2_UNIT = 'pm2-pi.service'
export const FIRSTBOOT_SCRIPT = '/usr/local/sbin/idea-engine-firstboot'
export const FIRSTBOOT_DONE = '/var/lib/idea/firstboot-done'

/** Units an image must have enabled (multi-user.target.wants). tailscaled is enabled by idea-engine-identity when a key is on the card (#291). */
/** Raspberry Pi OS's own first-boot host-key unit (idea tools/engine-image/verify-sanitised.sh checks it is enabled) */
export const SSH_REGEN_UNIT = 'regenerate_ssh_host_keys.service'
export const IMAGE_ENABLED_UNITS = ['docker.service', 'avahi-daemon.service', 'ssh.service', PM2_UNIT, SSH_REGEN_UNIT, FIRSTBOOT_UNIT]
/** In the image (idea tools/engine-image/INTERFACE.md) */
export const IMAGE_LOCK_PATH = '/etc/idea/engine.lock'
export const IMAGE_VERSION_PATH = '/etc/idea/engine-version'

/** pm2's own systemd template (pm2 startup systemd -u pi --hp /home/pi), written instead of running pm2 in the chroot. */
export const pm2UnitText = () => `[Unit]
Description=PM2 process manager (IDEA Engine, user pi)
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=pi
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
Environment=PM2_HOME=/home/pi/.pm2
PIDFile=/home/pi/.pm2/pm2.pid
Restart=on-failure
ExecStart=/usr/local/bin/pm2 resurrect
ExecReload=/usr/local/bin/pm2 reload all
ExecStop=/usr/local/bin/pm2 kill

[Install]
WantedBy=multi-user.target
`

export const firstbootUnitText = () => `[Unit]
Description=IDEA Engine first boot: load preloaded Docker images, docker networks, start the Engine under pm2 as pi (idea#322)
Wants=docker.service
After=docker.service ${PM2_UNIT} ${SSH_REGEN_UNIT}
ConditionPathExists=!${FIRSTBOOT_DONE}

[Service]
Type=oneshot
ExecStart=${FIRSTBOOT_SCRIPT}
RemainAfterExit=yes
StandardOutput=append:/var/log/idea-engine-firstboot.log
StandardError=append:/var/log/idea-engine-firstboot.log

[Install]
WantedBy=multi-user.target
`

// ── Sanitise + verify ───────────────────────────────────────────────────────

/** The generic hostname an image keeps until idea-engine-identity sets the device name (Raspberry Pi OS default). */
export const GENERIC_HOSTNAME = 'raspberrypi'

/** Paths (relative to the rootfs) that hold device identity or runtime state and never ship in an image. */
export const IDENTITY_PATHS = [
    'META.yaml',
    'etc/ssh/ssh_host_*',
    'var/lib/tailscale/*',
    'etc/tailscale/debug-authkey',
    'var/lib/idea/identity',
    'etc/idea/sticker-name',
    'home/pi/STICKER.txt',
    'home/pi/boot.out',
    'home/pi/.pm2/dump.pm2',
    'home/pi/.pm2/dump.pm2.bak',
    'home/pi/.pm2/logs',
    'home/pi/.pm2/pids',
    'var/lib/docker',
    'var/lib/containerd',
    'var/lib/systemd/random-seed',
    'root/.bash_history',
    'home/pi/.bash_history',
    'etc/ssh/idea_authorized_keys/pi',
    'etc/idea/peer_known_hosts',
    'home/pi/.ssh/id_ed25519',
    'home/pi/.ssh/id_ed25519.pub',
    'home/pi/.ssh/authorized_keys',
    'root/.idea-build',
    'usr/sbin/policy-rc.d',
]

/** Under the Engine tree: runtime store state. store-identity/ keeps exactly the git-tracked files. */
export const ENGINE_RUNTIME_PATHS = ['store-data', 'yjs-db', 'logs', 'test/testresults']

const globRel = async (root: string, pattern: string): Promise<string[]> => {
    const dir = path.join(root, path.dirname(pattern))
    const base = path.basename(pattern)
    if (!base.includes('*')) return (await fs.pathExists(path.join(root, pattern)) || await isSymlink(path.join(root, pattern))) ? [path.join(root, pattern)] : []
    if (!(await fs.pathExists(dir))) return []
    const re = new RegExp('^' + base.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    return (await fs.readdir(dir)).filter(n => re.test(n)).map(n => path.join(dir, n))
}
const isSymlink = async (p: string) => { try { return (await fs.lstat(p)).isSymbolicLink() } catch { return false } }

export interface SanitiseOptions {
    root: string
    enginePath: string
    /** git-tracked files under <engine>/store-identity/ (relative names); everything else there is removed */
    trackedStoreIdentity: string[]
}

/**
 * Remove every device identity from a built rootfs (idea#322). Idempotent.
 * machine-id is left EMPTY (systemd generates it at first boot); /var/lib/dbus/machine-id
 * becomes a symlink to it. /etc/hostname gets GENERIC_HOSTNAME. Returns what changed.
 */
export const sanitiseRootfs = async (o: SanitiseOptions): Promise<string[]> => {
    const done: string[] = []
    const rm = async (p: string) => { await fs.remove(p); done.push(`removed ${path.relative(o.root, p)}`) }
    for (const pat of IDENTITY_PATHS) for (const p of await globRel(o.root, pat)) await rm(p)
    const eng = path.join(o.root, o.enginePath)
    for (const rel of ENGINE_RUNTIME_PATHS) if (await fs.pathExists(path.join(eng, rel))) await rm(path.join(eng, rel))
    const sid = path.join(eng, 'store-identity')
    if (await fs.pathExists(sid)) {
        for (const n of await fs.readdir(sid)) if (!o.trackedStoreIdentity.includes(n)) await rm(path.join(sid, n))
    }
    const mid = path.join(o.root, 'etc/machine-id')
    await fs.ensureDir(path.dirname(mid))
    if (!(await fs.pathExists(mid)) || (await fs.readFile(mid, 'utf8')) !== '') { await fs.writeFile(mid, ''); done.push('emptied etc/machine-id') }
    await fs.chmod(mid, 0o444)
    const dbus = path.join(o.root, 'var/lib/dbus/machine-id')
    if (!(await isSymlink(dbus)) || (await fs.readlink(dbus)) !== '/etc/machine-id') {
        await fs.remove(dbus); await fs.ensureDir(path.dirname(dbus)); await fs.symlink('/etc/machine-id', dbus); done.push('var/lib/dbus/machine-id -> /etc/machine-id')
    }
    const hn = path.join(o.root, 'etc/hostname')
    if (!(await fs.pathExists(hn)) || (await fs.readFile(hn, 'utf8')).trim() !== GENERIC_HOSTNAME) { await fs.writeFile(hn, GENERIC_HOSTNAME + '\n'); done.push(`etc/hostname = ${GENERIC_HOSTNAME}`) }
    const hosts = path.join(o.root, 'etc/hosts')
    if (await fs.pathExists(hosts)) {
        const t = await fs.readFile(hosts, 'utf8')
        const n = t.replace(/^127\.0\.1\.1\s.*$/m, `127.0.1.1\t${GENERIC_HOSTNAME}`).replace(/^127\.0\.0\.1\s.*$/m, '127.0.0.1\tlocalhost')
        if (n !== t) { await fs.writeFile(hosts, n); done.push('etc/hosts reset') }
    }
    return done
}

export interface VerifyContext {
    root: string
    enginePath: string
    lock: EngineLock
    /** sha256 of each git-tracked store-identity file at lock.engineCommit (name -> sha256) */
    storeIdentity: Record<string, string>
    /** uid of pi in the rootfs (from its /etc/passwd) */
    piUid?: number
}

const modeOf = (st: { mode: number }) => '0' + (st.mode & 0o777).toString(8).padStart(3, '0')

/** Every check a built rootfs must pass. Returns problems; empty = OK. Read-only. */
export const verifyRootfs = async (c: VerifyContext): Promise<string[]> => {
    const p: string[] = []
    const R = (rel: string) => path.join(c.root, rel)
    const eng = R(c.enginePath)
    // 1. no identity
    for (const pat of IDENTITY_PATHS) for (const f of await globRel(c.root, pat)) p.push(`identity/runtime state present: /${path.relative(c.root, f)}`)
    for (const rel of ENGINE_RUNTIME_PATHS) if (await fs.pathExists(path.join(eng, rel))) p.push(`Engine runtime state present: ${c.enginePath}/${rel}`)
    const mid = R('etc/machine-id')
    if (!(await fs.pathExists(mid))) p.push('/etc/machine-id missing (must exist and be empty)')
    else if ((await fs.readFile(mid, 'utf8')).trim() !== '' ) p.push('/etc/machine-id is not empty')
    const hn = R('etc/hostname')
    if (!(await fs.pathExists(hn)) || (await fs.readFile(hn, 'utf8')).trim() !== GENERIC_HOSTNAME) p.push(`/etc/hostname must be the generic ${GENERIC_HOSTNAME}`)
    // 2. store identity: exactly the tracked files, byte-identical (store-template.json never modified)
    const sid = path.join(eng, 'store-identity')
    const have = (await fs.pathExists(sid)) ? await fs.readdir(sid) : []
    for (const n of have) {
        if (!(n in c.storeIdentity)) p.push(`store-identity/${n} is not a git-tracked file`)
        else if (await sha256File(path.join(sid, n)) !== c.storeIdentity[n]) p.push(`store-identity/${n} differs from git (${n === 'store-template.json' ? 'store-template.json must never change' : 'modified'})`)
    }
    for (const n of Object.keys(c.storeIdentity)) if (!have.includes(n)) p.push(`store-identity/${n} missing`)
    // 3. Engine tree at the locked commit, built, owned by pi
    const head = path.join(eng, '.git/HEAD')
    if (!(await fs.pathExists(head))) p.push(`${c.enginePath}/.git/HEAD missing`)
    else if ((await fs.readFile(head, 'utf8')).trim() !== c.lock.engineCommit) p.push(`Engine checkout is not detached at ${c.lock.engineCommit}`)
    for (const rel of ['dist/src/index.js', 'node_modules', 'pm2.config.cjs'])
        if (!(await fs.pathExists(path.join(eng, rel)))) p.push(`${c.enginePath}/${rel} missing`)
    if (c.piUid !== undefined && await fs.pathExists(eng)) {
        for (const rel of ['', 'dist', 'node_modules', 'pm2.config.cjs']) {
            const f = path.join(eng, rel)
            if (await fs.pathExists(f) && (await fs.lstat(f)).uid !== c.piUid) p.push(`${c.enginePath}/${rel} is not owned by pi`)
        }
    }
    // 4. pm2 as pi, never root
    const pm2 = R(`etc/systemd/system/${PM2_UNIT}`)
    if (!(await fs.pathExists(pm2))) p.push(`${PM2_UNIT} missing`)
    else if (!/^User=pi$/m.test(await fs.readFile(pm2, 'utf8'))) p.push(`${PM2_UNIT} must run as User=pi`)
    if (await fs.pathExists(R('etc/systemd/system/pm2-root.service'))) p.push('pm2-root.service present: pm2 must never run as root')
    // 5. enabled units
    for (const u of c.lock.enabledUnits) {
        const wants = R(`etc/systemd/system/multi-user.target.wants/${u}`)
        if (!(await isSymlink(wants)) && !(await fs.pathExists(wants))) p.push(`unit ${u} is not enabled`)
    }
    // 6. locked files: content, mode, owner
    for (const f of c.lock.files) {
        const fp = R(f.path.slice(1))
        if (!(await fs.pathExists(fp))) { p.push(`${f.path} missing`); continue }
        const st = await fs.stat(fp)
        if (await sha256File(fp) !== f.sha256) p.push(`${f.path} content differs from the lock`)
        if (modeOf(st) !== f.mode) p.push(`${f.path} mode ${modeOf(st)}, lock says ${f.mode}`)
        if (f.owner === 'root' && st.uid !== 0) p.push(`${f.path} must be owned by root`)
        if (f.owner === 'pi' && c.piUid !== undefined && st.uid !== c.piUid) p.push(`${f.path} must be owned by pi`)
    }
    // 7. permissions that must hold whatever the lock says
    for (const [rel, want] of [['var/lib/idea-app-data', '0700'], ['etc/tailscale', '0700']] as const) {
        if (await fs.pathExists(R(rel))) { const m = modeOf(await fs.stat(R(rel))); if (m !== want) p.push(`/${rel} mode ${m}, must be ${want}`) }
    }
    if (await fs.pathExists(R('etc/sudoers.d'))) for (const n of await fs.readdir(R('etc/sudoers.d'))) {
        const st = await fs.stat(R(`etc/sudoers.d/${n}`)); if (modeOf(st) !== '0440' || st.uid !== 0) p.push(`/etc/sudoers.d/${n} must be root 0440`)
    }
    // 8. preloaded Docker images
    for (const i of c.lock.dockerImages) {
        const t = R(path.join(PRELOAD_DOCKER_DIR, i.tar).slice(1))
        if (!(await fs.pathExists(t))) p.push(`preload ${i.ref} missing (${PRELOAD_DOCKER_DIR}/${i.tar})`)
        else if (await sha256File(t) !== i.tarSha256) p.push(`preload ${i.ref}: tarball sha256 differs from the lock`)
    }
    const manifest = R(path.join(PRELOAD_DOCKER_DIR, 'images.lock').slice(1))
    if (c.lock.dockerImages.length && !(await fs.pathExists(manifest))) p.push(`${PRELOAD_DOCKER_DIR}/images.lock missing`)
    // 9. packages at their pinned versions: Raspberry Pi pins, Docker debs, the recorded RPi archive set and all packages
    const status = new Map((await readDpkgStatus(c.root)).map(x => [x.pkg, x.version]))
    if (status.size) {
        const want = [...c.lock.aptPins, ...c.lock.dockerDebs, ...(c.lock.rpiPackages ?? []), ...(c.lock.packages ?? [])]
        for (const w of want) {
            const got = status.get(w.pkg)
            if (got === undefined) p.push(`package ${w.pkg} not installed (lock: ${w.version})`)
            else if (got !== w.version) p.push(`package ${w.pkg} ${got}, lock says ${w.version}`)
        }
    } else if (c.lock.aptPins.length || c.lock.dockerDebs.length) p.push('no dpkg status in the rootfs: pinned packages cannot be checked')
    // 10. the lock itself is in the image
    if (!(await fs.pathExists(R(IMAGE_LOCK_PATH.slice(1))))) p.push(`${IMAGE_LOCK_PATH} missing`)
    if (!(await fs.pathExists(R(IMAGE_VERSION_PATH.slice(1))))) p.push(`${IMAGE_VERSION_PATH} missing`)
    return p
}

/** Installed packages from <root>/var/lib/dpkg/status (Status: install ok installed). Multi-arch names keep the bare name. */
export const readDpkgStatus = async (root: string): Promise<{ pkg: string, version: string, arch: string }[]> => {
    const f = path.join(root, 'var/lib/dpkg/status')
    if (!(await fs.pathExists(f))) return []
    const out: { pkg: string, version: string, arch: string }[] = []
    for (const block of (await fs.readFile(f, 'utf8')).split(/\n\n+/)) {
        const field = (k: string) => block.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]?.trim()
        if (field('Status') !== 'install ok installed') continue
        const pkg = field('Package'), version = field('Version')
        if (pkg && version) out.push({ pkg, version, arch: field('Architecture') ?? '' })
    }
    return out.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.arch.localeCompare(b.arch))
}

/** Package names in the apt lists of archive.raspberrypi.com in <root> (the Raspberry Pi archive). */
export const rpiArchivePackageNames = async (root: string): Promise<Set<string>> => {
    const dir = path.join(root, 'var/lib/apt/lists')
    const names = new Set<string>()
    if (!(await fs.pathExists(dir))) return names
    for (const n of await fs.readdir(dir)) {
        if (!/^archive\.raspberrypi\.(com|org)_.*_Packages$/.test(n)) continue
        for (const m of (await fs.readFile(path.join(dir, n), 'utf8')).matchAll(/^Package: (\S+)$/gm)) names.add(m[1])
    }
    return names
}

/** images.lock lines the first-boot loader checks: <tar>\t<tarSha256>\t<imageId>\t<ref> */
export const preloadManifest = (imgs: LockedImage[]) =>
    [...imgs].sort((a, b) => a.ref.localeCompare(b.ref)).map(i => `${i.tar}\t${i.tarSha256}\t${i.imageId}\t${i.ref}`).join('\n') + (imgs.length ? '\n' : '')

/** Image id (config digest) of a docker-save tarball, from its manifest.json. */
export const imageIdFromManifest = (manifestJson: string): string => {
    const m = JSON.parse(manifestJson)
    if (!Array.isArray(m) || m.length !== 1 || typeof m[0].Config !== 'string') throw new Error('docker-save tarball must hold exactly one image')
    const hex = m[0].Config.replace(/^blobs\/sha256\//, '').replace(/\.json$/, '')
    if (!SHA256.test(hex)) throw new Error(`unexpected Config entry ${m[0].Config}`)
    return `sha256:${hex}`
}
