/**
 * appDataSandbox.ts — run script/build_image_assets/idea-app-data without root (idea#168)
 *
 * Like idea-erase-disk-script.test.ts, the helper is COPIED into a temp folder and
 * its fixed constants are rewritten there: absolute binaries that would touch the
 * system (rsync, rrsync, borg, findmnt, logger, getent) point at fakes, the fixed
 * locations (/disks, /instances, /etc/idea/app-data-roots, /run/lock/idea-app-data,
 * /root) point into the temp folder, and ROOT_UID/ROOT_GID are the test user's. The
 * script itself has no test hooks. Coreutils (realpath, stat, du, rm, mkdir, mv,
 * find, mktemp, flock) stay real.
 *
 * Fakes record their calls in <tmp>/calls/<name>.log as JSON lines
 * {argv, cwd, env} so tests can check the exact argv.
 *
 * Per-Pi Engine keys: df (free space, FAKE_DF_AVAIL_KB) and runuser (drops
 * `-u <user> --`) are fakes too; the peer files (/etc/ssh/idea_authorized_keys,
 * /etc/idea/peer_known_hosts), the ledger folder and the Engine user point into the
 * temp folder. script/build_image_assets/idea-peer-gate is copied the same way
 * (runGate): its sudo is a fake that runs the sandboxed helper, so gate → helper
 * runs end to end.
 */

import { fs, path } from 'zx'
import os from 'os'
import { spawn } from 'child_process'

export const HELPER_SOURCE = path.resolve('script/build_image_assets/idea-app-data')
export const GATE_SOURCE = path.resolve('script/build_image_assets/idea-peer-gate')

export interface RunResult { exitCode: number | null, signal: string | null, stdout: string, stderr: string }

export interface AppDataSandbox {
    tmp: string
    bin: string
    script: string
    disks: string
    sys: string
    rootsFile: string
    lockDir: string
    /** findmnt table: lines "<mountpoint> <source> <fstype>" (the root filesystem is '/') */
    mounts: string
    /** getent ahostsv4 table: lines "<host> <address>" */
    hosts: string
    journal: string
    /** /etc/ssh/idea_authorized_keys (the folder) and its pi file */
    peerAuthDir: string
    peerAuthFile: string
    /** /etc/idea/peer_known_hosts */
    peerKnownHosts: string
    /** /var/lib/idea-app-data (the receive ledger folder) */
    ledgerDir: string
    gateScript: string
    run: (args: string[], env?: Record<string, string>) => Promise<RunResult>
    /** the gate as sshd runs it: argv [peerEngineId], SSH_ORIGINAL_COMMAND = cmd */
    runGate: (gateArgs: string[], cmd: string | undefined, env?: Record<string, string>) => Promise<RunResult>
    calls: (name: string) => Promise<{ argv: string[], cwd: string, env: Record<string, string> }[]>
    fake: (name: string, body: string) => Promise<void>
    /** an Engine disk /disks/<dev> mounted from /dev/<dev> (ext4) with META.yaml and instances/ */
    addDisk: (dev: string, opts?: { backup?: boolean, fstype?: string, source?: string }) => Promise<string>
    /** an instance folder with a few files */
    addInstance: (root: string, id: string) => Promise<string>
    journalText: () => Promise<string>
}

export interface SandboxOptions {
    /** use the real /usr/bin/borg (when installed) instead of the fake */
    realBorg?: boolean
    /** the uid/gid the rewritten script treats as root (default: the test user) */
    rootUid?: number
    rootGid?: number
    /** keep the default bridge file location but do not create anything there */
    rootsFile?: string
}

const RECORD = (name: string, calls: string) => `
${process.execPath} -e 'const fs=require("fs");fs.appendFileSync(process.argv[1], JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),env:{BORG_RELOCATED_REPO_ACCESS_IS_OK:process.env.BORG_RELOCATED_REPO_ACCESS_IS_OK,BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK:process.env.BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK,SSH_ORIGINAL_COMMAND:process.env.SSH_ORIGINAL_COMMAND,LC_ALL:process.env.LC_ALL,HOME:process.env.HOME,PATH:process.env.PATH}})+"\\n")' ${calls}/${name}.log "$@"
`

export const makeAppDataSandbox = async (opts: SandboxOptions = {}): Promise<AppDataSandbox> => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-app-data-'))
    const bin = path.join(tmp, 'bin')
    const callsDir = path.join(tmp, 'calls')
    const disks = path.join(tmp, 'disks')
    const sys = path.join(tmp, 'sys')
    const etc = path.join(tmp, 'etc')
    const lockParent = path.join(tmp, 'lock')
    const home = path.join(tmp, 'home')
    const mounts = path.join(tmp, 'mounts.txt')
    const hosts = path.join(tmp, 'hosts.txt')
    const journal = path.join(tmp, 'journal.log')
    for (const d of [bin, callsDir, disks, path.join(sys, 'instances'), etc, lockParent, home]) await fs.ensureDir(d)
    await fs.writeFile(mounts, '/ /dev/sda2 ext4\n')
    await fs.writeFile(hosts, '')
    const rootsFile = opts.rootsFile ?? path.join(etc, 'app-data-roots')

    const fake = async (name: string, body: string) => {
        await fs.writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    }

    await fake('logger', `echo "$*" >> ${journal}`)
    // findmnt -n -r -o <cols> --mountpoint <mp>
    await fake('findmnt', `
mp=""; cols=""
while [[ $# -gt 0 ]]; do case "$1" in --mountpoint) mp="$2"; shift 2;; -o) cols="$2"; shift 2;; *) shift;; esac; done
while read -r m s f; do
  if [[ "$m" == "$mp" ]]; then
    if [[ "$cols" == SOURCE ]]; then echo "$s"; else echo "$s $f"; fi
    exit 0
  fi
done < ${mounts}
exit 1`)
    // getent ahostsv4 <host>
    await fake('getent', `
[[ "$1" == ahostsv4 ]] || exit 1
found=1
while read -r h a; do
  if [[ "$h" == "$2" ]]; then echo "$a      STREAM $2"; echo "$a      DGRAM"; found=0; fi
done < ${hosts}
if [[ $found -ne 0 && "$2" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then echo "$2      STREAM $2"; found=0; fi
exit $(( found ? 2 : 0 ))`)
    // rsync: record; a local copy (dest /proc/self/fd/N/) really copies with cp -a
    await fake('rsync', `${RECORD('rsync', callsDir)}
[[ -n "\${FAKE_RSYNC_SLEEP:-}" ]] && exec /bin/sleep "$FAKE_RSYNC_SLEEP"
echo "      1,024 100%   1.00MB/s    0:00:00 (xfr#1, to-chk=0/1)"
last="\${@: -1}"
if [[ "$last" == /proc/self/fd/* ]]; then cp -a ./. "$last" || exit 23; fi
exit \${FAKE_RSYNC_EXIT:-0}`)
    // df -Pk -- <dir>: header + one line, Available = FAKE_DF_AVAIL_KB (default: plenty)
    await fake('df', `${RECORD('df', callsDir)}
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 99999999 1 \${FAKE_DF_AVAIL_KB:-99999998} 1% /"`)
    // runuser -u <user> -- <cmd…>: record, then run <cmd…> as the test user
    await fake('runuser', `${RECORD('runuser', callsDir)}
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done
shift
exec "$@"`)
    await fake('rrsync', `${RECORD('rrsync', callsDir)}
cat > ${path.join(callsDir, 'rrsync.stdin')}
exit \${FAKE_RRSYNC_EXIT:-0}`)
    // borg: init writes <repo>/config; info prints one archive; extract creates <id>/data.txt in cwd
    await fake('borg', `${RECORD('borg', callsDir)}
case "$1" in
  init) mkdir -p "\${@: -1}" && echo '[repository]' > "\${@: -1}/config" ;;
  info) if [[ -n "\${FAKE_BORG_INFO:-}" ]]; then echo "$FAKE_BORG_INFO"; else echo '{"archives":[]}'; fi ;;
  extract) for e in \${FAKE_BORG_EXTRACT:-}; do mkdir -p "$e" && echo restored > "$e/data.txt"; done ;;
esac
exit \${FAKE_BORG_EXIT:-0}`)

    // erase-slot: record umount/mount/mkfs/losetup
    await fake('umount', `${RECORD('umount', callsDir)}
exit \${FAKE_UMOUNT_EXIT:-0}`)
    await fake('mount', `${RECORD('mount', callsDir)}
target="\${@: -1}"
metafile="${callsDir}/erase-meta.path"
if [[ -f "$metafile" && -d "$target" ]]; then cp -f "$(cat "$metafile")" "$target/META.yaml"; fi
exit \${FAKE_MOUNT_EXIT:-0}`)
    await fake('mkfs.ext4', `${RECORD('mkfs.ext4', callsDir)}
staging=""
while [[ $# -gt 0 ]]; do case "$1" in -d) staging="$2"; shift 2;; *) shift;; esac; done
if [[ -n "$staging" && -f "$staging/META.yaml" ]]; then
  echo "$staging/META.yaml" > ${callsDir}/erase-meta.path
fi
exit \${FAKE_MKFS_EXIT:-0}`)
    await fake('losetup', `${RECORD('losetup', callsDir)}
if [[ -n "\${FAKE_LOSETUP_BACKING:-}" ]]; then echo "\${FAKE_LOSETUP_BACKING}"; exit 0; fi
exit 1`)

    const uid = opts.rootUid ?? process.getuid!()
    const gid = opts.rootGid ?? process.getgid!()
    let text = await fs.readFile(HELPER_SOURCE, 'utf8')
    const setConst = (name: string, value: string) => {
        const re = new RegExp(`^${name}=.*$`, 'm')
        if (!re.test(text)) throw new Error(`idea-app-data has no ${name}= line`)
        text = text.replace(re, `${name}=${value}`)
    }
    for (const tool of ['rsync', 'rrsync', 'findmnt', 'logger', 'getent', 'df', 'runuser', 'umount', 'mount', 'losetup']) setConst(tool.toUpperCase(), path.join(bin, tool))
    setConst('MKFS', path.join(bin, 'mkfs.ext4'))
    if (!opts.realBorg) setConst('BORG', path.join(bin, 'borg'))
    setConst('DISKS_DIR', disks)
    setConst('SYSTEM_ROOT', sys)
    setConst('ROOTS_FILE', rootsFile)
    setConst('LOCK_DIR', path.join(lockParent, 'idea-app-data'))
    setConst('ROOT_HOME', home)
    setConst('ROOT_UID', String(uid))
    setConst('ROOT_GID', String(gid))
    setConst('LOCK_WAIT_SECONDS', '2')
    const peerAuthDir = path.join(etc, 'ssh-idea_authorized_keys')
    const peerKnownHosts = path.join(etc, 'idea', 'peer_known_hosts')
    const ledgerDir = path.join(tmp, 'var-lib-idea-app-data')
    setConst('PEER_AUTH_DIR', peerAuthDir)
    setConst('PEER_KNOWN_HOSTS', peerKnownHosts)
    setConst('LEDGER_DIR', ledgerDir)
    setConst('ENGINE_USER', os.userInfo().username)
    // erase-slot: allow staging under <tmp>/erase-staging/<id> instead of /home/pi/...
    const stagingRootEscaped = path.join(tmp, 'erase-staging').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(
        '[[ "$STAGING" =~ ^/home/pi/\\.local/state/idea-engine/erase-staging/[A-Za-z0-9_-]+$ ]]',
        `[[ "$STAGING" =~ ^${stagingRootEscaped}/[A-Za-z0-9_-]+$ ]]`,
    )
    const script = path.join(tmp, 'idea-app-data')
    await fs.writeFile(script, text, { mode: 0o755 })

    // The gate: its sudo runs the sandboxed helper (sudo -n <HELPER_PATH> <args…>)
    await fake('sudo', `${RECORD('sudo', callsDir)}
[[ "$1" == -n && "$2" == /usr/local/sbin/idea-app-data ]] || { echo "fake sudo: unexpected argv $*" >&2; exit 99; }
shift 2
[[ -n "\${FAKE_SUDO_EXIT:-}" ]] && exit "$FAKE_SUDO_EXIT"
SUDO_USER=pi exec ${script} "$@"`)
    let gateText = await fs.readFile(GATE_SOURCE, 'utf8')
    for (const [name, value] of [['SUDO', path.join(bin, 'sudo')], ['LOGGER', path.join(bin, 'logger')]]) {
        const re = new RegExp(`^${name}=.*$`, 'm')
        if (!re.test(gateText)) throw new Error(`idea-peer-gate has no ${name}= line`)
        gateText = gateText.replace(re, `${name}=${value}`)
    }
    const gateScript = path.join(tmp, 'idea-peer-gate')
    await fs.writeFile(gateScript, gateText, { mode: 0o755 })

    const run = async (args: string[], env: Record<string, string> = {}): Promise<RunResult> => {
        // stdin is /dev/null (as for a Engine call); rrsync's stdin passthrough is checked with a pipe separately
        const input = env.FAKE_STDIN
        return new Promise<RunResult>((resolve, reject) => {
            const proc = spawn(script, args, {
                env: { ...process.env, SUDO_USER: 'pi', ...env },
                stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            })
            let stdout = ''
            let stderr = ''
            proc.stdout!.on('data', d => { stdout += d })
            proc.stderr!.on('data', d => { stderr += d })
            proc.on('error', reject)
            proc.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }))
            if (input !== undefined) proc.stdin!.end(input)
        })
    }
    const runGate = async (gateArgs: string[], cmd: string | undefined, env: Record<string, string> = {}): Promise<RunResult> => {
        const input = env.FAKE_STDIN
        const e: Record<string, string> = { ...process.env as Record<string, string>, SSH_CLIENT: '10.0.0.9 50000 22', ...env }
        if (cmd === undefined) delete e.SSH_ORIGINAL_COMMAND
        else e.SSH_ORIGINAL_COMMAND = cmd
        return new Promise<RunResult>((resolve, reject) => {
            const proc = spawn(gateScript, gateArgs, { env: e, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
            let stdout = ''
            let stderr = ''
            proc.stdout!.on('data', d => { stdout += d })
            proc.stderr!.on('data', d => { stderr += d })
            proc.on('error', reject)
            proc.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }))
            if (input !== undefined) proc.stdin!.end(input)
        })
    }
    const calls = async (name: string) => {
        const f = path.join(callsDir, `${name}.log`)
        if (!await fs.pathExists(f)) return []
        return (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
    }
    const addDisk = async (dev: string, o: { backup?: boolean, fstype?: string, source?: string } = {}) => {
        const root = path.join(disks, dev)
        await fs.ensureDir(path.join(root, 'instances'))
        await fs.writeFile(path.join(root, 'META.yaml'), `diskId: disk-${dev}\n`)
        if (o.backup) {
            await fs.writeFile(path.join(root, 'BACKUP.yaml'), 'mode: on-demand\nlinks: []\n')
            await fs.ensureDir(path.join(root, 'backups'))
        }
        await fs.appendFile(mounts, `${root} ${o.source ?? `/dev/${dev}`} ${o.fstype ?? 'ext4'}\n`)
        return root
    }
    const addInstance = async (root: string, id: string) => {
        const inst = path.join(root, 'instances', id)
        await fs.ensureDir(path.join(inst, 'data', 'sessions'))
        await fs.writeFile(path.join(inst, 'compose.yaml'), 'services: {}\n')
        await fs.writeFile(path.join(inst, '.env'), 'port=1234\n')
        await fs.writeFile(path.join(inst, 'data', 'sessions', 's1'), 'session\n', { mode: 0o600 })
        await fs.symlink('sessions/s1', path.join(inst, 'data', 'link-inside'))
        return inst
    }
    const journalText = async () => (await fs.pathExists(journal)) ? fs.readFile(journal, 'utf8') : ''
    return {
        tmp, bin, script, disks, sys, rootsFile, lockDir: path.join(lockParent, 'idea-app-data'), mounts, hosts, journal,
        peerAuthDir, peerAuthFile: path.join(peerAuthDir, 'pi'), peerKnownHosts, ledgerDir, gateScript,
        run, runGate, calls, fake, addDisk, addInstance, journalText,
    }
}
