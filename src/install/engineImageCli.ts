/**
 * engineImageCli.ts: the image modes of build-engine (idea#322 Option A) and
 * script/build-engine-offline, the entry point of idea tools/engine-image/INTERFACE.md:
 *
 *   build-engine-offline --root <MNT> --boot <MNT>/boot/firmware --report <OUT>/engine-build.json
 *
 * Exit codes: 0 ok, 1 build or verify failed, 2 usage error.
 * Engine.ts is imported dynamically with IDEA_IMAGE_BUILD=1 so its import-time
 * Engine id lookup (which would create /META.yaml on the BUILD HOST) never runs.
 */
import { $, fs, path } from 'zx'
import os from 'os'
import crypto from 'crypto'
import { config } from '../data/Config.js'
import {
    EngineLock, FIRSTBOOT_SCRIPT, IMAGE_ENABLED_UNITS, ImageArgs, LOCK_SCHEMA, LockedFile, LockedImage, UsageError,
    imageIdFromManifest, imageTarName, parseDockerPins, readLock, serialiseLock, sha256File, validateLock, verifyRootfs,
} from './engineImage.js'
import { Installers, Runner, realRunner, runRootfsBuild } from './engineRootfs.js'

export const STORE_IDENTITY_DIR = 'store-identity'

/** Root-owned files the build installs, checked by verify (asset -> installed path, mode). */
export const LOCKED_FILE_SPECS: { asset: string, path: string, mode: string }[] = [
    { asset: 'idea-erase-disk', path: '/usr/local/sbin/idea-erase-disk', mode: '0755' },
    { asset: 'idea-write-home-engine', path: '/usr/local/sbin/idea-write-home-engine', mode: '0755' },
    { asset: 'idea-write-card-timezone', path: '/usr/local/sbin/idea-write-card-timezone', mode: '0755' },
    { asset: 'idea-flash-card', path: '/usr/local/sbin/idea-flash-card', mode: '0755' },
    { asset: 'idea-app-data', path: '/usr/local/sbin/idea-app-data', mode: '0755' },
    { asset: 'idea-peer-gate', path: '/usr/local/sbin/idea-peer-gate', mode: '0755' },
    { asset: 'idea-dhcp-vendor-class', path: '/usr/local/sbin/idea-dhcp-vendor-class', mode: '0755' },
    { asset: 'idea-avahi-lan-only', path: '/usr/local/sbin/idea-avahi-lan-only', mode: '0755' },
    { asset: '10-idea-peer.conf', path: '/etc/ssh/sshd_config.d/10-idea-peer.conf', mode: '0644' },
    { asset: '10-engine.sudoers', path: '/etc/sudoers.d/10-engine', mode: '0440' },
    { asset: '11-engine-files.sudoers', path: '/etc/sudoers.d/11-engine-files', mode: '0440' },
    { asset: 'idea-engine-firstboot', path: FIRSTBOOT_SCRIPT, mode: '0755' },
]

const git = async (repo: string, args: string[]) => (await $({ cwd: repo })`git ${args}`).stdout.trim()

/** sha256 of each git-tracked store-identity file at <commit> (never read from, or written to, the work tree). */
export const trackedStoreIdentity = async (repo: string, commit: string): Promise<Record<string, string>> => {
    const names = (await git(repo, ['ls-tree', '--name-only', `${commit}:${STORE_IDENTITY_DIR}`])).split('\n').filter(Boolean)
    const out: Record<string, string> = {}
    for (const n of names) {
        const sum = (await $({ cwd: repo })`bash -c ${'git show "$0" | sha256sum'} ${`${commit}:${STORE_IDENTITY_DIR}/${n}`}`).stdout.trim().split(' ')[0]
        out[n] = sum
    }
    return out
}

/** Build the lock from a CLEAN checkout (its HEAD) plus the docker-save tarballs in <cache>/docker. */
export const buildLock = async (repo: string, E: any, images: string[], cache: string | undefined, pm2Env: EngineLock['pm2Env']): Promise<EngineLock> => {
    if (await git(repo, ['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error(`${repo} has uncommitted changes: a lock is for a commit`)
    const engineCommit = await git(repo, ['rev-parse', 'HEAD'])
    const pkg = await fs.readJson(path.join(repo, 'package.json'))
    const assets = path.join(repo, 'script/build_image_assets')
    const dockerImages: LockedImage[] = []
    for (const ref of [...images].sort()) {
        if (!cache) throw new UsageError('--image needs --cache (docker-save tarballs in <cache>/docker)')
        const tar = imageTarName(ref)
        const f = path.join(cache, 'docker', tar)
        const manifest = (await $`tar -xOf ${f} manifest.json`).stdout
        dockerImages.push({ ref, imageId: imageIdFromManifest(manifest), tar, tarSha256: await sha256File(f) } as LockedImage)
    }
    const files: LockedFile[] = []
    for (const s of LOCKED_FILE_SPECS) {
        const a = path.join(assets, s.asset)
        if (await fs.pathExists(a)) files.push({ path: s.path, sha256: await sha256File(a), mode: s.mode, owner: 'root' })
    }
    return {
        schema: LOCK_SCHEMA, engineCommit, engineVersion: String(pkg.version), arch: 'arm64',
        nodeVersion: E.NODE_VERSION, pnpmVersion: E.PNPM_VERSION, pm2Version: E.PM2_VERSION, pm2LogrotateVersion: E.PM2_LOGROTATE_VERSION,
        tailscaleVersion: E.TAILSCALE_VERSION, tailscaleSha256: E.TAILSCALE_ARM64_SHA256, debianSnapshot: E.DEBIAN_SNAPSHOT,
        aptPins: E.parseAptPins(await fs.readFile(path.join(assets, 'apt-rpi-pins.tsv'), 'utf8')),
        dockerDebs: parseDockerPins(await fs.readFile(path.join(assets, 'docker-pins.tsv'), 'utf8')),
        dockerImages, pm2Env, files, enabledUnits: [...IMAGE_ENABLED_UNITS].sort(),
    }
}

export const piUidOf = async (root: string): Promise<number | undefined> => {
    const pw = path.join(root, 'etc/passwd')
    if (!(await fs.pathExists(pw))) return undefined
    const l = (await fs.readFile(pw, 'utf8')).split('\n').find(x => x.startsWith('pi:'))
    return l ? Number(l.split(':')[2]) : undefined
}

export interface Report { engine_commit: string, engine_version: string, lock_sha256: string, verify: { passed: number, failed: string[] } }
export const VERIFY_CHECK_COUNT = 9

export const writeReport = async (file: string | undefined, lock: EngineLock | undefined, lockText: string, problems: string[]) => {
    if (!file) return
    const r: Report = {
        engine_commit: lock?.engineCommit ?? '', engine_version: lock?.engineVersion ?? '',
        lock_sha256: lockText ? crypto.createHash('sha256').update(lockText).digest('hex') : '',
        verify: { passed: problems.length ? 0 : VERIFY_CHECK_COUNT, failed: problems },
    }
    await fs.ensureDir(path.dirname(file)); await fs.writeFile(file, JSON.stringify(r, null, 2) + '\n')
}

/** A runner that only logs (dry run on any host): canned answers for the installers' self-checks. */
export const dryRunner = (lock: EngineLock, log: string[], appDataVersion: string): Runner => {
    const answer = (cmd: string): string => {
        if (cmd.includes('dpkg-query')) return 'install ok installed'
        if (cmd.includes('idea-app-data') && cmd.includes('version')) return `idea-app-data ${appDataVersion}`
        if (cmd.includes('sshd -T')) return 'authorizedkeysfile .ssh/authorized_keys /etc/ssh/idea_authorized_keys/%u'
        if (cmd.includes('pnpm --version')) return lock.pnpmVersion
        return ''
    }
    return {
        host: async (cmd) => { log.push(`host: ${cmd}`); return { stdout: answer(cmd) } },
        chroot: async (cmd) => { log.push(`chroot: ${cmd}`); return { stdout: answer(cmd) } },
    }
}

/** Run an image mode. Returns the exit code (0 ok, 1 failed, 2 usage). */
export const runImageMode = async (a: ImageArgs, repo: string): Promise<number> => {
    process.env.IDEA_IMAGE_BUILD = '1'
    const E: any = await import('../data/Engine.js')
    const { APP_DATA_HELPER_VERSION } = await import('../utils/appDataHelper.js')
    const enginePath = config.defaults.enginePath ?? '/home/pi/idea/agents/agent-engine-dev'
    if (a.mode === 'write-lock') {
        const lock = await buildLock(repo, E, a.images, a.cache, a.pm2Env)
        await fs.writeFile(a.lock!, serialiseLock(lock))
        console.log(`lock written: ${a.lock} (${lock.engineCommit})`)
        return 0
    }
    const root = a.rootfs!
    if (!(await fs.pathExists(path.join(root, 'etc/os-release')))) throw new UsageError(`${root} is not a mounted root filesystem (no etc/os-release)`)
    if (a.mode === 'verify') {
        const lock = await readLock(a.lock!)
        const commit = lock.engineCommit
        const problems = await verifyRootfs({ root, enginePath, lock, storeIdentity: await trackedStoreIdentity(repo, commit), piUid: await piUidOf(root) })
        problems.forEach(p => console.error(`verify: ${p}`))
        await writeReport(a.report, lock, await fs.readFile(a.lock!, 'utf8'), problems)
        console.log(problems.length ? `verify FAILED (${problems.length})` : 'verify OK')
        return problems.length ? 1 : 0
    }
    // rootfs build
    if (!a.dryRun) {
        if (os.arch() !== 'arm64') throw new UsageError(`--root builds run on an arm64 host (this is ${os.arch()}); use --dry-run elsewhere`)
        if (process.getuid?.() !== 0) throw new UsageError('--root builds run as root')
    }
    if ((await piUidOf(root)) === undefined) throw new UsageError(`${root}/etc/passwd has no pi user`)
    const lock = a.lock ? await readLock(a.lock) : await buildLock(repo, E, a.images, a.cache, a.pm2Env)
    const bad = validateLock(lock); if (bad.length) throw new UsageError(`lock: ${bad.join('; ')}`)
    const lockText = serialiseLock(lock)
    let cache = a.cache
    if (!cache && !a.dryRun) {
        cache = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-engine-inputs-'))
        console.log(`no --cache: fetching the pinned inputs for ${lock.engineCommit} into ${cache} (archive-engine-inputs.sh, checksummed)`)
        await $({ cwd: repo, stdio: 'inherit' })`bash script/archive-engine-inputs.sh ${lock.engineCommit} ${cache} ${lock.dockerImages.map(i => i.ref)}`
    }
    const storeIdentity = await trackedStoreIdentity(repo, lock.engineCommit)
    const opts = {
        rootfs: root, lock, cache: cache ?? '/nonexistent-cache', repo, enginePath,
        language: config.defaults.language, keyboard: config.defaults.keyboard, timezone: config.defaults.timezone,
        trackedStoreIdentity: Object.keys(storeIdentity), storeIdentity,
    }
    const log: string[] = []
    const runner = a.dryRun ? dryRunner(lock, log, APP_DATA_HELPER_VERSION) : realRunner(root)
    const inst = E as Installers
    let problems: string[]
    try {
        problems = await runRootfsBuild(opts, runner, inst, lockText, await piUidOf(root))
    } catch (e) {
        problems = [`build step failed: ${e instanceof Error ? e.message : e}`]
    }
    if (a.dryRun) log.forEach(l => console.log(l))
    problems.forEach(p => console.error(`verify: ${p}`))
    await writeReport(a.report, lock, lockText, problems)
    console.log(problems.length ? `engine offline build FAILED (${problems.length})` : `engine offline build OK (${lock.engineCommit})`)
    return problems.length ? 1 : 0
}
