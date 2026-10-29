# Engine image: offline build into a mounted root filesystem (idea#322, Option A)

The Engine side of the idea repo's Engine image builder (`tools/engine-image/build.sh`,
`release.sh --type engine`). The interface is the idea repo's `tools/engine-image/INTERFACE.md`
(koenswings/idea#384); this page says what the Engine side does.

## Invocation

    sudo <engine-src>/script/build-engine-offline --root <MNT> --boot <MNT>/boot/firmware --report <OUT>/engine-build.json \
         [--cache <dir>] [--lock <engine.lock>] [--image name[:tag]@sha256:<digest> ...] [--pm2-env production|development] [--dry-run]

- `<engine-src>`: clean checkout of agent-engine-dev at the commit to build. `build-engine-offline` installs the
  checkout's own dev dependencies (`pnpm install --frozen-lockfile`) when missing, then runs
  `tsx script/build-engine.ts --root ...`. The host needs node 22 + pnpm.
- `<MNT>`: the mounted root of the image, with /dev /dev/pts /proc /sys /run bind-mounted, /etc/resolv.conf working
  and the boot partition at `<MNT>/boot/firmware`. The host is arm64 and the command runs as root
  (`--dry-run` lifts both checks and runs nothing).
- `--cache`: `script/archive-engine-inputs.sh <commit> <dir> [image ...]` output. Without it the inputs are fetched
  into a temp dir first with that script (network; every input checksummed).
- `--lock`: an `engine.lock` written by `build-engine --write-lock --lock <file>`. Without it the lock is generated
  from the (clean) checkout.
- Exit codes: 0 ok, 1 build or verify failed, 2 usage error.

## What it does (src/install/engineRootfs.ts)

No SSH, nothing started, no device identity. Inside `chroot <MNT>`:

1. Guards: `usr/sbin/policy-rc.d` (exit 101: apt never starts a service), shims first on PATH
   (`/root/.idea-build/shims`: `sudo` without secure_path, `udevadm`/`systemd-tmpfiles`/`reboot` no-ops,
   `hostnamectl` refused, `timedatectl set-timezone` as a symlink, `pm2` and `docker` refuse anything but `--version`),
   temporary SSH host keys so `sshd -t` can check the peer drop-in. `systemctl` in a chroot only enables.
2. The Engine at the locked commit: `git clone` of `<engine-src>` into `/home/pi/idea/agents/agent-engine-dev`,
   detached at the commit, origin set to the GitHub URL.
3. The existing installers from `src/data/Engine.ts`, unchanged: apt snapshot + Raspberry Pi pins, avahi, locale,
   crontabs, udev + root helpers + sudoers + peer access, packages, apps folders.
4. Docker from the pinned debs, enabled, not started; pi in the docker group; `daemon.json`.
5. Tailscale binaries + unit from the pinned tarball, NOT enabled, no key, no state
   (idea-engine-identity enables it on first boot when the card carries a key, engine#291).
6. Node, pnpm, pm2 from the cache (pinned, checked); `pnpm install --frozen-lockfile --offline` + `pnpm build` as pi.
7. Docker images (pinned by digest) copied as docker-save tarballs to `/var/lib/idea/preload/docker/` with `images.lock`.
8. Units: `pm2-pi.service` (User=pi, `pm2 resurrect`; written, not `pm2 startup`), `idea-engine-firstboot.service`,
   and Raspberry Pi OS's `regenerate_ssh_host_keys.service`, all enabled with docker, avahi-daemon and ssh.
9. Sanitise: no /META.yaml, no SSH host keys, empty machine-id, generic hostname `raspberrypi`, no Tailscale state or
   key, no pm2 dump, no Engine store state, store-identity/ exactly the git-tracked files (store-template.json is
   never written), build guards removed.
10. `/etc/idea/engine.lock`, `/etc/idea/engine-version`, then verify (`verifyRootfs`): any identity, a store-identity
    file that differs from git, a wrong commit, a missing build, pm2 as root, a unit not enabled, a locked file whose
    content/mode/owner differs, a preload tarball whose sha256 differs: exit 1.

`engine-build.json`: `{engine_commit, engine_version, lock_sha256, verify: {passed, failed}}` (failed = the problems).

## First boot

`regenerate_ssh_host_keys.service` makes the host keys. systemd makes machine-id. `idea-engine-firstboot`
(`script/build_image_assets/idea-engine-firstboot`) loads the preloaded images (sha256 and image id checked), creates
the docker networks, installs pm2-logrotate from the preloaded tarball and, as pi, starts the Engine with
`pm2.config.cjs` and `pm2 save`; `pm2-pi.service` resurrects it on later boots. The Engine creates `/META.yaml` itself
at its first start (`ensureSystemMeta`: root drive serial, else a UUID); a `/META.yaml` without a diskId also gets a
UUID (`diskIdWithoutHardware`), never `ENGINE_undefined`.

## Other modes

- `build-engine --verify-rootfs <MNT> --lock <file> [--report <file>]`: verify only.
- `build-engine --write-lock --lock <file> [--image ...] [--cache <dir>]`: write the lock for a clean checkout.

Tests: `test/automated/engine-image.test.ts` (temp-dir rootfs, stubbed runner).
