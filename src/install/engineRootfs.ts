/**
 * engineRootfs.ts: build-engine --rootfs, the chroot orchestration (idea#322, Option A).
 *
 * Runs on an arm64 host as root. The caller (idea release.sh --type engine) has
 * mounted the image's root partition at <rootfs>, its boot partition at
 * <rootfs>/boot/firmware, bind-mounted /dev /dev/pts /proc /sys /run and provided
 * /etc/resolv.conf. This module never mounts, never uses SSH and starts nothing:
 *  - apt postinst service starts are refused by usr/sbin/policy-rc.d (exit 101)
 *  - systemctl inside a chroot only enables (it ignores start/restart/reload)
 *  - shims in /root/.idea-build/shims (first on PATH) turn udevadm, systemd-tmpfiles,
 *    reboot and hostnamectl into no-ops/refusals and refuse every pm2/docker daemon
 *    command, so the existing installers in Engine.ts can be reused unchanged
 *  - SSH host keys are made only so `sshd -t` can check the peer drop-in, then removed
 * After the install: sanitiseRootfs + verifyRootfs (engineImage.ts). Exit non-zero on any problem.
 */
import { $, fs, path } from 'zx'
import { shellQuote } from '../utils/ssh.js'
import { print } from '../utils/utils.js'
import {
    EngineLock, FIRSTBOOT_SCRIPT, FIRSTBOOT_UNIT, IMAGE_LOCK_PATH, IMAGE_VERSION_PATH, PM2_UNIT, PRELOAD_DOCKER_DIR, PRELOAD_NPM_DIR, SSH_REGEN_UNIT,
    firstbootUnitText, pm2UnitText, preloadManifest, sanitiseRootfs, verifyRootfs,
} from './engineImage.js'

export interface Out { stdout: string }
/** Where commands go: the host (cp/git/chown on <rootfs> paths) or the chroot. Swappable for a dry run. */
export interface Runner {
    host: (cmd: string) => Promise<Out>
    chroot: (cmd: string) => Promise<Out>
}

export const SHIM_DIR = '/root/.idea-build/shims'
export const CHROOT_PATH = `${SHIM_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`

/** Quote a template literal the way ssh() does, but arrays become one word per element (zx semantics). */
export const quoteTemplate = (pieces: TemplateStringsArray | string[], args: unknown[]): string =>
    pieces.reduce((acc: string, piece: string, i: number) => {
        if (i >= args.length) return acc + piece
        const a = args[i]
        const q = Array.isArray(a) ? a.map(x => shellQuote(String(x))).join(' ') : shellQuote(String(a))
        return acc + piece + q
    }, '')

/** A tagged-template exec for the Engine.ts installers that runs inside the chroot. */
export const chrootExec = (r: Runner) => (pieces: TemplateStringsArray, ...args: unknown[]) => r.chroot(quoteTemplate(pieces, args))

export const realRunner = (rootfs: string): Runner => ({
    host: async (cmd) => ({ stdout: (await $`bash -c ${cmd}`).stdout }),
    chroot: async (cmd) => ({
        stdout: (await $`chroot ${rootfs} /usr/bin/env -i PATH=${CHROOT_PATH} HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive IDEA_IMAGE_BUILD=1 /bin/bash -c ${cmd}`).stdout,
    }),
})

/** Shims (name -> script). Each logs what it skipped to /root/.idea-build/shims.log. */
export const SHIMS: Record<string, string> = {
    // The installers prefix commands with sudo; the build already runs as root, and real sudo's
    // secure_path would bypass the shims below. -n/-E/-H are dropped; -u <user> becomes runuser.
    'sudo': `#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -n|-E|-H) shift;; -u) u="$2"; shift 2;; --) shift; break;; *) break;; esac; done\nif [ -n "\${u:-}" ] && [ "$u" != root ]; then exec runuser -u "$u" -- "$@"; fi\nif [ $# -gt 0 ] && [[ "$1" == *=* ]]; then exec env "$@"; fi\nexec "$@"\n`,
    'udevadm': `#!/bin/sh\necho "udevadm $* (skipped: image build)" >> /root/.idea-build/shims.log\nexit 0\n`,
    'systemd-tmpfiles': `#!/bin/sh\necho "systemd-tmpfiles $* (skipped: applied at boot)" >> /root/.idea-build/shims.log\nexit 0\n`,
    'reboot': `#!/bin/sh\necho "reboot (skipped: image build)" >> /root/.idea-build/shims.log\nexit 0\n`,
    'hostnamectl': `#!/bin/sh\necho "hostnamectl refused: an image has no hostname (idea#322)" >&2\nexit 1\n`,
    'timedatectl': `#!/bin/sh\n# set-timezone in a chroot: /etc/localtime + /etc/timezone, like timedatectl\nif [ "$1" = set-timezone ] && [ -f "/usr/share/zoneinfo/$2" ]; then ln -sf "/usr/share/zoneinfo/$2" /etc/localtime; echo "$2" > /etc/timezone; exit 0; fi\necho "timedatectl $* (skipped: image build)" >> /root/.idea-build/shims.log\nexit 0\n`,
    'pm2': `#!/bin/sh\ncase "$1" in --version|-v) exec /usr/local/bin/pm2 "$@";; esac\necho "pm2 $* refused: nothing is started at image build time (idea#322)" >&2\nexit 1\n`,
    'docker': `#!/bin/sh\ncase "$1" in --version) exec /usr/bin/docker "$@";; esac\necho "docker $* refused: no Docker daemon in an image build (idea#322)" >&2\nexit 1\n`,
}

export interface RootfsBuildOptions {
    rootfs: string
    lock: EngineLock
    /** script/archive-engine-inputs.sh output for lock.engineCommit */
    cache: string
    /** local agent-engine-dev checkout holding lock.engineCommit */
    repo: string
    enginePath: string
    language: string
    keyboard: string
    timezone: string
    /** git-tracked store-identity file names */
    trackedStoreIdentity: string[]
    storeIdentity: Record<string, string>
}

/** The Engine.ts installers this build reuses (passed in: Engine.ts must not be imported at module load). */
export interface Installers {
    pinAptSnapshot: (exec: any) => Promise<void>
    updateSystem: (exec: any) => Promise<void>
    installRpiPins: (exec: any, enginePath: string) => Promise<void>
    installAvahi: (exec: any, enginePath: string) => Promise<void>
    localiseSystem: (exec: any, enginePath: string, language: string, keyboard: string, timezone: string) => Promise<void>
    installCrontabs: (exec: any, enginePath: string) => Promise<void>
    installUdev: (exec: any, enginePath: string) => Promise<void>
    installVarious: (exec: any) => Promise<void>
    installVarious2: (exec: any) => Promise<void>
    buildAppsInfrastructure: (exec: any) => Promise<void>
    grantNetBindCapability: (exec: any) => Promise<void>
}

export interface Step { name: string, run: () => Promise<void> }

const q = shellQuote

/**
 * The ordered build steps. Host steps touch only paths under <rootfs>; chroot steps
 * run inside it. Nothing here connects to a device or starts a service.
 */
export const rootfsSteps = (o: RootfsBuildOptions, r: Runner, inst: Installers): Step[] => {
    const R = (p: string) => path.posix.join(o.rootfs, p)
    const exec = chrootExec(r)
    const E = o.enginePath
    const L = o.lock
    return [
        { name: 'guards: policy-rc.d, shims, temporary ssh host keys', run: async () => {
            await r.host(`install -d -m 0700 ${q(R('/root/.idea-build'))} && install -d -m 0755 ${q(R(SHIM_DIR))}`)
            for (const [n, body] of Object.entries(SHIMS)) await r.host(`printf %s ${q(body)} > ${q(R(`${SHIM_DIR}/${n}`))} && chmod 0755 ${q(R(`${SHIM_DIR}/${n}`))}`)
            await r.host(`printf '#!/bin/sh\\nexit 101\\n' > ${q(R('/usr/sbin/policy-rc.d'))} && chmod 0755 ${q(R('/usr/sbin/policy-rc.d'))}`)
            await r.chroot('ssh-keygen -A >/dev/null')
        } },
        { name: 'Engine source at the locked commit + offline caches', run: async () => {
            await r.host(`test "$(git -C ${q(o.repo)} rev-parse ${q(L.engineCommit)}^{commit})" = ${q(L.engineCommit)}`)
            await r.host(`rm -rf ${q(R(E))} && install -d ${q(path.posix.dirname(R(E)))} && git clone -q --no-hardlinks ${q(o.repo)} ${q(R(E))}` +
                ` && git -C ${q(R(E))} checkout -q --detach ${q(L.engineCommit)}` +
                ` && git -C ${q(R(E))} remote set-url origin https://github.com/koenswings/agent-engine-dev.git`)
            // install-docker-pinned.sh and installRpiPins read <engine>/deb-cache/ first
            await r.host(`install -d ${q(R(`${E}/deb-cache/docker`))} && { cp -a ${q(o.cache)}/debs/docker/*.deb ${q(R(`${E}/deb-cache/docker/`))} 2>/dev/null || true; }`)
            await r.host(`{ cp -a ${q(o.cache)}/debs/*.deb ${q(R(`${E}/deb-cache/`))} 2>/dev/null || true; }`)
        } },
        { name: 'apt: Debian snapshot + Raspberry Pi pins', run: async () => {
            await inst.pinAptSnapshot(exec); await inst.updateSystem(exec); await inst.installRpiPins(exec, E)
        } },
        { name: 'system: avahi, locale, crontabs, udev + root helpers + sudoers + peer access, packages', run: async () => {
            await inst.installAvahi(exec, E)
            await inst.localiseSystem(exec, E, o.language, o.keyboard, o.timezone)
            await inst.installCrontabs(exec, E)
            await inst.installUdev(exec, E)
            await inst.installVarious(exec)
            await inst.installVarious2(exec)
        } },
        { name: 'Docker (pinned debs, enabled, not started)', run: async () => {
            await exec`bash ${E}/script/build_image_assets/install-docker-pinned.sh ${E}`
            await exec`getent group docker >/dev/null || groupadd docker`
            await exec`usermod -aG docker pi`
            await exec`install -d -m 0755 /etc/docker && install -o root -g root -m 0644 ${E}/script/build_image_assets/daemon.json /etc/docker/daemon.json`
            await exec`systemctl enable docker.service containerd.service`
            await inst.buildAppsInfrastructure(exec)
        } },
        { name: 'Tailscale binaries + unit (no key, no state; idea-engine-identity enables it)', run: async () => {
            const f = `tailscale_${L.tailscaleVersion}_arm64.tgz`
            await r.host(`install -d ${q(R('/root/.idea-build/tailscale'))} && cp -a ${q(`${o.cache}/tailscale/${f}`)} ${q(R(`/root/.idea-build/tailscale/${f}`))}`)
            await exec`echo ${`${L.tailscaleSha256}  /root/.idea-build/tailscale/${f}`} | sha256sum -c -`
            await exec`tar -xzf ${`/root/.idea-build/tailscale/${f}`} --strip-components=1 -C /usr/sbin ${`tailscale_${L.tailscaleVersion}_arm64/tailscale`} ${`tailscale_${L.tailscaleVersion}_arm64/tailscaled`}`
            await exec`install -o root -g root -m 0644 ${E}/script/build_image_assets/tailscaled.service /etc/systemd/system/tailscaled.service`
            await exec`install -o root -g root -m 0755 ${E}/script/build_image_assets/tailscale-debug-activate.sh /usr/local/bin/tailscale-debug-activate.sh`
        } },
        { name: 'Node, pnpm, pm2 from the cache (pinned)', run: async () => {
            const node = `node-v${L.nodeVersion}-linux-arm64.tar.xz`
            await r.host(`install -d ${q(R('/root/.idea-build/node'))} && cp -a ${q(`${o.cache}/node/${node}`)} ${q(`${o.cache}/node/SHASUMS256.txt`)} ${q(R('/root/.idea-build/node/'))}`)
            await exec`cd /root/.idea-build/node && grep ${` ${node}$`} SHASUMS256.txt | sha256sum -c -`
            await exec`tar -xJf ${`/root/.idea-build/node/${node}`} -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md`
            await r.host(`install -d ${q(R('/root/.idea-build/npm'))} ${q(R(PRELOAD_NPM_DIR))} && cp -a ${q(o.cache)}/npm-global/*.tgz ${q(R('/root/.idea-build/npm/'))}`)
            await exec`cd /root/.idea-build/npm && npm install -g --offline ${`pnpm-${L.pnpmVersion}.tgz`} ${`pm2-${L.pm2Version}.tgz`}`
            await exec`test "$(pnpm --version)" = ${L.pnpmVersion} && test "$(node --version)" = ${`v${L.nodeVersion}`} && test "$(/usr/local/bin/pm2 --version)" = ${L.pm2Version}`
            await exec`cp /root/.idea-build/npm/${`pm2-logrotate-${L.pm2LogrotateVersion}.tgz`} ${PRELOAD_NPM_DIR}/`
        } },
        { name: 'Engine install + build as pi (frozen lockfile, offline store)', run: async () => {
            await r.host(`rm -rf ${q(R('/home/pi/.idea-pnpm-store'))} && cp -a ${q(`${o.cache}/pnpm-store`)} ${q(R('/home/pi/.idea-pnpm-store'))}`)
            await exec`chown -R pi:pi /home/pi/.idea-pnpm-store /home/pi/idea`
            await exec`runuser -u pi -- env HOME=/home/pi bash -c ${`cd ${E} && pnpm install --frozen-lockfile --offline --store-dir /home/pi/.idea-pnpm-store && pnpm build`}`
            await exec`rm -rf /home/pi/.idea-pnpm-store`
            await inst.grantNetBindCapability(exec)
        } },
        { name: 'Docker image preload (tarballs + images.lock; loaded at first boot)', run: async () => {
            await r.host(`install -d -m 0755 ${q(R(PRELOAD_DOCKER_DIR))}`)
            for (const i of L.dockerImages) await r.host(`cp -a ${q(`${o.cache}/docker/${i.tar}`)} ${q(R(`${PRELOAD_DOCKER_DIR}/${i.tar}`))}`)
            await r.host(`printf %s ${q(preloadManifest(L.dockerImages))} > ${q(R(`${PRELOAD_DOCKER_DIR}/images.lock`))}`)
        } },
        { name: 'pm2-pi + first-boot units (enabled, not started)', run: async () => {
            await r.host(`printf %s ${q(pm2UnitText())} > ${q(R(`/etc/systemd/system/${PM2_UNIT}`))}`)
            await r.host(`printf %s ${q(firstbootUnitText())} > ${q(R(`/etc/systemd/system/${FIRSTBOOT_UNIT}`))}`)
            await exec`install -o root -g root -m 0755 ${E}/script/build_image_assets/idea-engine-firstboot ${FIRSTBOOT_SCRIPT}`
            await exec`install -d -m 0755 /etc/idea && chmod 0644 /etc/systemd/system/${PM2_UNIT} /etc/systemd/system/${FIRSTBOOT_UNIT}`
            await exec`test -f /lib/systemd/system/${SSH_REGEN_UNIT} || test -f /usr/lib/systemd/system/${SSH_REGEN_UNIT}`
            await exec`systemctl enable ${L.enabledUnits}`
        } },
        { name: 'ownership: the Engine tree belongs to pi', run: async () => {
            await exec`chown -R pi:pi /home/pi/idea`
        } },
        { name: 'sanitise (no device identity)', run: async () => {
            await r.host(`rm -rf ${q(R(`${E}/deb-cache`))}`)
            const changed = await sanitiseRootfs({ root: o.rootfs, enginePath: E, trackedStoreIdentity: o.trackedStoreIdentity })
            print(`sanitise: ${changed.length ? changed.join(', ') : 'nothing to do'}`)
        } },
    ]
}

/** Writes the lock to /etc/idea/engine.lock and the version to /etc/idea/engine-version, then verifies. */
export const runRootfsBuild = async (o: RootfsBuildOptions, r: Runner, inst: Installers, lockText: string, piUid?: number): Promise<string[]> => {
    for (const s of rootfsSteps(o, r, inst)) {
        print(`==> ${s.name}`)
        await s.run()
    }
    await fs.ensureDir(path.join(o.rootfs, 'etc/idea'))
    await fs.writeFile(path.join(o.rootfs, IMAGE_LOCK_PATH.slice(1)), lockText)
    await fs.writeFile(path.join(o.rootfs, IMAGE_VERSION_PATH.slice(1)), `${o.lock.engineVersion} ${o.lock.engineCommit}\n`)
    return verifyRootfs({ root: o.rootfs, enginePath: o.enginePath, lock: o.lock, storeIdentity: o.storeIdentity, piUid })
}
