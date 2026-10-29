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
    imageIdFromManifest, imageTarName, parseDockerPins, readLock, serialiseLock, sha256File, validateLock, verifyRootfsChecks, VERIFY_CHECKS,
} from './engineImage.js'
import { NpmTool, NPM_TOOL_INSTALL } from './engineImage.js'
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
    const npmTools: NpmTool[] = []
    const toolsDir = path.join(assets, 'npm-tools')
    for (const name of (await fs.pathExists(toolsDir)) ? (await fs.readdir(toolsDir)).sort() : []) {
        const install = NPM_TOOL_INSTALL[name]
        if (!install) throw new UsageError(`npm-tools/${name}: unknown tool (add it to NPM_TOOL_INSTALL)`)
        const version = String((await fs.readJson(path.join(toolsDir, name, 'package.json'))).dependencies?.[name] ?? '')
        const lockfile = await fs.readJson(path.join(toolsDir, name, 'package-lock.json'))
        if (lockfile.packages?.[`node_modules/${name}`]?.version !== version) throw new UsageError(`npm-tools/${name}: package-lock.json is not for ${name}@${version}`)
        npmTools.push({ name, version, install, lockfileSha256: await sha256File(path.join(toolsDir, name, 'package-lock.json')), tgz: `${name}-${version}.tgz` })
    }
    for (const [name, v] of [['pnpm', E.PNPM_VERSION], ['pm2', E.PM2_VERSION], ['pm2-logrotate', E.PM2_LOGROTATE_VERSION]])
        if (!npmTools.some(t => t.name === name && t.version === v)) throw new UsageError(`npm-tools/${name} must pin ${name}@${v} (Engine.ts)`)
    return {
        schema: LOCK_SCHEMA, engineCommit, engineVersion: String(pkg.version), arch: 'arm64',
        nodeVersion: E.NODE_VERSION, pnpmVersion: E.PNPM_VERSION, pm2Version: E.PM2_VERSION, pm2LogrotateVersion: E.PM2_LOGROTATE_VERSION,
        tailscaleVersion: E.TAILSCALE_VERSION, tailscaleSha256: E.TAILSCALE_ARM64_SHA256, debianSnapshot: E.DEBIAN_SNAPSHOT,
        aptPins: E.parseAptPins(await fs.readFile(path.join(assets, 'apt-rpi-pins.tsv'), 'utf8')),
        dockerDebs: parseDockerPins(await fs.readFile(path.join(assets, 'docker-pins.tsv'), 'utf8')),
        dockerImages, pm2Env, files, enabledUnits: [...IMAGE_ENABLED_UNITS].sort(), npmTools,
    }
}

/** Record (or, for a --lock rebuild, check) the bundled tarballs in <cache>/npm-global/NPM-TOOLS.tsv against the lock. */
export const pinNpmTools = async (lock: EngineLock, cache: string): Promise<EngineLock> => {
    const tsv = path.join(cache, 'npm-global', 'NPM-TOOLS.tsv')
    if (!(await fs.pathExists(tsv))) throw new Error(`${tsv} missing: the cache predates bundled npm tools (re-run archive-engine-inputs.sh)`)
    const rows = new Map<string, string[]>((await fs.readFile(tsv, 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split("\t")).map(c => [c[0], c] as [string, string[]]))
    const tools: NpmTool[] = []
    for (const t of lock.npmTools ?? []) {
        const c = rows.get(t.name)
        if (!c) throw new Error(`${tsv}: no ${t.name}`)
        const [, version, tgz, sha256, lockfileSha256] = c
        if (version !== t.version || tgz !== t.tgz) throw new Error(`${tsv}: ${t.name} ${version} (${tgz}), lock says ${t.version} (${t.tgz})`)
        if (lockfileSha256 !== t.lockfileSha256) throw new Error(`${tsv}: ${t.name} was archived from another package-lock.json`)
        const actual = await sha256File(path.join(cache, 'npm-global', tgz))
        if (actual !== sha256) throw new Error(`${tgz}: sha256 ${actual}, NPM-TOOLS.tsv says ${sha256}`)
        if (t.sha256 && t.sha256 !== actual) throw new Error(`${tgz}: sha256 ${actual}, the lock says ${t.sha256}`)
        tools.push({ ...t, sha256: actual })
    }
    return { ...lock, npmTools: tools }
}

export const piUidOf = async (root: string): Promise<number | undefined> => {
    const pw = path.join(root, 'etc/passwd')
    if (!(await fs.pathExists(pw))) return undefined
    const l = (await fs.readFile(pw, 'utf8')).split('\n').find(x => x.startsWith('pi:'))
    return l ? Number(l.split(':')[2]) : undefined
}

export interface Report { engine_commit: string, engine_version: string, lock_sha256: string, verify: { passed: number, failed: string[] } }

export const writeReport = async (file: string | undefined, lock: EngineLock | undefined, lockText: string, problems: string[], passed = 0) => {
    if (!file) return
    const r: Report = {
        engine_commit: lock?.engineCommit ?? '', engine_version: lock?.engineVersion ?? '',
        lock_sha256: lockText ? crypto.createHash('sha256').update(lockText).digest('hex') : '',
        verify: { passed, failed: problems },
    }
    await fs.ensureDir(path.dirname(file)); await fs.writeFile(file, JSON.stringify(r, null, 2) + '\n')
}

/** A runner that only logs (dry run on any host): canned answers for the installers' self-checks. */
export const dryRunner = (lock: EngineLock, log: string[], appDataVersion: string): Runner => {
    const answer = (cmd: string): string => {
        if (cmd.includes('VERSION_CODENAME')) return 'trixie'
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
        const checks = await verifyRootfsChecks({ root, enginePath, lock, storeIdentity: await trackedStoreIdentity(repo, commit), piUid: await piUidOf(root) })
        const problems = checks.flatMap(x => x.problems)
        problems.forEach(p => console.error(`verify: ${p}`))
        await writeReport(a.report, lock, await fs.readFile(a.lock!, 'utf8'), problems, checks.filter(x => !x.problems.length).length)
        console.log(problems.length ? `verify FAILED (${problems.length})` : 'verify OK')
        return problems.length ? 1 : 0
    }
    // rootfs build
    if (!a.dryRun) {
        if (os.arch() !== 'arm64') throw new UsageError(`--root builds run on an arm64 host (this is ${os.arch()}); use --dry-run elsewhere`)
        if (process.getuid?.() !== 0) throw new UsageError('--root builds run as root')
    }
    if ((await piUidOf(root)) === undefined) throw new UsageError(`${root}/etc/passwd has no pi user`)
    let lock = a.lock ? await readLock(a.lock) : await buildLock(repo, E, a.images, a.cache, a.pm2Env)
    const bad = validateLock(lock); if (bad.length) throw new UsageError(`lock: ${bad.join('; ')}`)
    let cache = a.cache
    if (!cache && !a.dryRun) {
        cache = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-engine-inputs-'))
        console.log(`no --cache: fetching the pinned inputs for ${lock.engineCommit} into ${cache} (archive-engine-inputs.sh, checksummed)`)
        await $({ cwd: repo, stdio: 'inherit' })`bash script/archive-engine-inputs.sh ${lock.engineCommit} ${cache} ${lock.dockerImages.map(i => i.ref)}`
    }
    if (cache) lock = await pinNpmTools(lock, cache)
    else lock = { ...lock, npmTools: (lock.npmTools ?? []).map(t => ({ ...t, sha256: t.sha256 ?? '0'.repeat(64) })) } // dry run without a cache
    const lockText = serialiseLock(lock)
    const storeIdentity = await trackedStoreIdentity(repo, lock.engineCommit)
    const opts = {
        rootfs: root, lock, cache: cache ?? '/nonexistent-cache', repo, enginePath,
        language: config.defaults.language, keyboard: config.defaults.keyboard, timezone: config.defaults.timezone,
        trackedStoreIdentity: Object.keys(storeIdentity), storeIdentity,
    }
    const log: string[] = []
    const runner = a.dryRun ? dryRunner(lock, log, APP_DATA_HELPER_VERSION) : realRunner(root)
    const inst = E as Installers
    // An installer that fails calls process.exit(1): leave a failed report behind first
    await writeReport(a.report, lock, lockText, ['build did not finish (see the log)'])
    let problems: string[]
    let finalLock = lockText
    let passed = 0
    try {
        const res = await runRootfsBuild(opts, runner, inst, lockText, await piUidOf(root))
        problems = res.problems; passed = res.passed; finalLock = res.lockText
    } catch (e) {
        problems = [`build step failed: ${e instanceof Error ? e.message : e}`]
    }
    if (a.dryRun) log.forEach(l => console.log(l))
    problems.forEach(p => console.error(`verify: ${p}`))
    await writeReport(a.report, lock, finalLock, problems, passed)
    console.log(`verify: ${passed}/${VERIFY_CHECKS.length} checks passed`)
    console.log(problems.length ? `engine offline build FAILED (${problems.length})` : `engine offline build OK (${lock.engineCommit})`)
    return problems.length ? 1 : 0
}
