/**
 * appDataHelper.ts — the Engine side of the app-data root helper (idea#168)
 *
 * App containers write their instance data as root (Kolibri sessions, 0600),
 * 999 (MariaDB, 0700 folders) and www-data (Nextcloud). The Engine runs as pi, so
 * it cannot read that data, and a copy made by pi loses the owners. Instance data
 * is therefore sized, copied, sent, deleted, backed up and restored by
 * /usr/local/sbin/idea-app-data (script/build_image_assets/idea-app-data), run with
 * `sudo -n`. One sudoers line with no argument list allows it (11-engine-files);
 * the helper validates every argument itself and builds every path from tokens:
 *
 *   root  'system' (the system disk), 'sdX1'/'sdX2' (a mounted Engine disk), or a
 *         pool slot name such as 'idea-test-1' (only through the helper's TEST-ONLY
 *         root bridge file /etc/idea/app-data-roots, which production never has)
 *   id    an instance id (^[a-z0-9][a-z0-9-]{0,63}$)
 *
 * App masters and service tars are Engine-written and pi-owned, so locally they stay
 * plain pi operations. Every call is an argv array (never a shell string). Commands
 * for a PEER Engine (ensure-dirs, receive-app/-service/-files, delete) go over ssh
 * with this Engine's own key (utils/peerSsh.ts) as one remote command built from
 * checked tokens; on the peer the forced command idea-peer-gate parses it and runs
 * that Engine's helper (helper version 2, per-Pi Engine keys).
 */

import { spawn } from 'child_process'
import { $ } from 'zx'
import { log } from './utils.js'
import { config } from '../data/Config.js'
import { peerSshArgv, checkEngineId } from './peerSsh.js'

/** Installed path of the helper (a root-owned copy, 0755; build-engine installUdev). */
export const APP_DATA_HELPER = '/usr/local/sbin/idea-app-data'

/**
 * The helper version this Engine speaks. Must equal IDEA_APP_DATA_VERSION in
 * script/build_image_assets/idea-app-data (a test checks this). Bump both when the
 * subcommands or their arguments change.
 */
export const APP_DATA_HELPER_VERSION = '3'

export const APP_DATA_HELPER_UPDATE =
    'ask Ops to update the Engine\'s root helper: build-engine installs /usr/local/sbin/idea-app-data ' +
    'and its line in /etc/sudoers.d/11-engine-files (idea#168)'

const ROOT_TOKEN = /^(system|sd[a-z][12]|[a-z0-9][a-z0-9-]{0,63})$/
const ID_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/
const ARCHIVE_TOKEN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]{8,16}Z$/
const APP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const checkRoot = (root: string): string => {
    if (!ROOT_TOKEN.test(root)) throw new Error(`'${root}' is not a disk root the app-data helper accepts (system, sdX1/sdX2 or a test slot name)`)
    return root
}
const checkId = (id: string): string => {
    if (!ID_TOKEN.test(id)) throw new Error(`'${id}' is not an instance id the app-data helper accepts`)
    return id
}
const checkApp = (appId: string): string => {
    if (!APP_TOKEN.test(appId) || appId.includes('..')) throw new Error(`'${appId}' is not an app id the app-data helper accepts`)
    return appId
}
const checkArchive = (archive: string): string => {
    if (!ARCHIVE_TOKEN.test(archive)) throw new Error(`'${archive}' is not a backup archive name the app-data helper accepts`)
    return archive
}

// ── Helper arguments (subcommand first) ──────────────────────────────────────

export const sizeArgs = (root: string, id: string): string[] => ['size', checkRoot(root), checkId(id)]
export const copyArgs = (srcRoot: string, srcId: string, dstRoot: string, dstId: string): string[] =>
    ['copy', checkRoot(srcRoot), checkId(srcId), checkRoot(dstRoot), checkId(dstId)]
/** send: the peer's address AND its Engine id (the helper pins the peer's host key by Engine id). */
export const sendArgs = (srcRoot: string, srcId: string, host: string, peerEngineId: string, dstRoot: string, dstId: string): string[] => {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) throw new Error(`'${host}' is not a host the app-data helper accepts`)
    return ['send', checkRoot(srcRoot), checkId(srcId), host, checkEngineId(peerEngineId), checkRoot(dstRoot), checkId(dstId)]
}
/** On a peer (through its gate): create apps/, instances/, services/ on <root>, owned by pi. */
export const ensureDirsArgs = (root: string): string[] => ['ensure-dirs', checkRoot(root)]
/**
 * TEST-ONLY: erase a loop-backed duration slot (idea-test-N) to an empty IDEA disk.
 * umount + mkfs.ext4 + remount via the helper; production USB erase stays on idea-erase-disk.
 */
export const eraseSlotArgs = (slot: string, stagingDir: string): string[] => {
    checkRoot(slot)
    if (slot === 'system' || /^sd[a-z][12]$/.test(slot)) {
        throw new Error(`'${slot}' is not a test slot name erase-slot accepts`)
    }
    if (!stagingDir || stagingDir.includes('\0')) throw new Error('stagingDir is required for erase-slot')
    return ['erase-slot', slot, stagingDir]
}
/** On a peer: the rsync server for an app master, <root>/apps/<appId> (written as pi). */
export const receiveAppArgs = (root: string, appId: string): string[] => ['receive-app', checkRoot(root), checkApp(appId)]
/** On a peer: the rsync server for service image tars, <root>/services (written as pi). */
export const receiveServiceArgs = (root: string): string[] => ['receive-service', checkRoot(root)]
/** On a peer: the rsync server for compose.yaml/.env into an instance folder this Engine's receive created. */
export const receiveFilesArgs = (root: string, id: string): string[] => ['receive-files', checkRoot(root), checkId(id)]
/**
 * Local Engine: copy basenames from a /tmp staging dir into an existing instance
 * folder as root (idea-app-data put-files). Peers use receive-files through the gate.
 */
export const putFilesArgs = (root: string, id: string, stagingDir: string): string[] => {
    if (!stagingDir || stagingDir.includes('\0')) throw new Error('stagingDir is required for put-files')
    if (!stagingDir.startsWith('/tmp/')) throw new Error('stagingDir for put-files must be under /tmp')
    return ['put-files', checkRoot(root), checkId(id), stagingDir]
}
export const deleteArgs = (root: string, id: string): string[] => ['delete', checkRoot(root), checkId(id)]
export const borgInitArgs = (bdev: string, id: string): string[] => ['borg-init', checkRoot(bdev), checkId(id)]
export const borgInfoArgs = (bdev: string, id: string): string[] => ['borg-info', checkRoot(bdev), checkId(id)]
export const borgCreateArgs = (bdev: string, id: string, archive: string, srcRoot: string): string[] =>
    ['borg-create', checkRoot(bdev), checkId(id), checkArchive(archive), checkRoot(srcRoot)]
export const borgExtractArgs = (bdev: string, id: string, archive: string, strip: number, dstRoot: string): string[] => {
    if (!Number.isInteger(strip) || strip < 1 || strip > 9) throw new Error(`strip ${strip} is out of range (1-9)`)
    return ['borg-extract', checkRoot(bdev), checkId(id), checkArchive(archive), String(strip), checkRoot(dstRoot)]
}

/** The argv for `sudo`: sudo -n /usr/local/sbin/idea-app-data <args…> */
export const appDataSudoArgv = (args: string[]): string[] => ['-n', APP_DATA_HELPER, ...args]

/** A helper call as the words of a remote command: sudo -n /usr/local/sbin/idea-app-data <args…> */
export const remoteHelperCommand = (args: string[]): string[] => ['sudo', '-n', APP_DATA_HELPER, ...args]

/** The same as one string, for `rsync --rsync-path=` (tokens are checked, no quoting needed). */
export const remoteHelperRsyncPath = (args: string[]): string => remoteHelperCommand(args).join(' ')

/**
 * The ssh argv that deletes a partial copy on a peer Engine with that Engine's
 * helper (its gate allows it only for a folder this Engine's receive created). The
 * remote command is ONE argument built from checked tokens only.
 */
export const remoteDeleteSshArgs = (host: string, peerEngineId: string, root: string, id: string): string[] =>
    peerSshArgv(host, peerEngineId, remoteHelperCommand(deleteArgs(root, id)))

/** The ssh argv that creates apps/, instances/ and services/ on the peer's target disk (idea#80). */
export const remoteEnsureDirsSshArgs = (host: string, peerEngineId: string, root: string): string[] =>
    peerSshArgv(host, peerEngineId, remoteHelperCommand(ensureDirsArgs(root)))

// ── Running the helper ───────────────────────────────────────────────────────

/** Runs the helper with these arguments (subcommand first) and returns stdout. */
export type AppDataRunner = (args: string[]) => Promise<string>

/**
 * The error text for a failed helper run: the helper's own "refused: …" line when
 * there is one, else its stderr; plus the update hint when sudo could not run it.
 */
export const appDataErrorMessage = (sub: string, code: number | null, signal: string | null, stderr: string): string => {
    const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
    const refusal = lines.find(l => l.startsWith('refused: '))
    const missing = /a password is required|command not found|No such file or directory|not allowed to execute|may not run sudo/.test(stderr)
    const what = refusal ?? (signal ? `stopped by ${signal}` : `exited with code ${code}`) + (lines.length ? `: ${lines.filter(l => !l.startsWith('idea-app-data: test-only root bridge:')).join(' | ')}` : '')
    return `idea-app-data ${sub} ${what}${missing ? ` — ${APP_DATA_HELPER_UPDATE}` : ''}`
}

/** Default runner: `sudo -n /usr/local/sbin/idea-app-data <args…>` (no shell). */
export const runAppData: AppDataRunner = (args) => new Promise((resolve, reject) => {
    log(`sudo -n ${APP_DATA_HELPER} ${args.join(' ')}`)
    const proc = spawn('sudo', appDataSudoArgv(args), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    proc.on('error', (err) => reject(new Error(`idea-app-data ${args[0]}: could not start sudo: ${err.message}`)))
    proc.on('close', (code, signal) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(appDataErrorMessage(args[0], code, signal, stderr)))
    })
})

/** Bytes used by an instance folder (du -sk -x as root). */
export const instanceDataBytes = async (root: string, id: string, run: AppDataRunner = runAppData): Promise<number> => {
    const out = (await run(sizeArgs(root, id))).trim()
    const kb = parseInt(out, 10)
    if (!/^[0-9]+$/.test(out) || isNaN(kb)) throw new Error(`idea-app-data size gave no size: '${out}'`)
    return kb * 1024
}

/** Removes an instance folder as root (rm -rf --one-file-system). A missing folder is fine. */
export const deleteInstanceData = async (root: string, id: string, run: AppDataRunner = runAppData): Promise<void> => {
    await run(deleteArgs(root, id))
}

/** Place basename files from staging into an instance folder as root (local Engine). */
export const putInstanceFiles = async (
    root: string,
    id: string,
    stagingDir: string,
    run: AppDataRunner = runAppData,
): Promise<void> => {
    await run(putFilesArgs(root, id, stagingDir))
}

/** Removes an instance folder on a peer Engine: ssh pi@host sudo -n idea-app-data delete <root> <id> (through its gate). */
export const deleteRemoteInstanceData = async (host: string, peerEngineId: string, root: string, id: string): Promise<void> => {
    await $`${remoteDeleteSshArgs(host, peerEngineId, root, id)}`
}

/** Creates apps/, instances/ and services/ on a peer's disk (through its gate). */
export const ensureRemoteDirs = async (host: string, peerEngineId: string, root: string): Promise<void> => {
    await $`${remoteEnsureDirsSshArgs(host, peerEngineId, root)}`
}

/**
 * `sudo -n idea-app-data sync-peers` with the FULL peer set on stdin (one line per
 * peer: `<engineId> ssh-ed25519 <key> ssh-ed25519 <hostkey>`). Returns stdout.
 */
export type AppDataInputRunner = (args: string[], input: string) => Promise<string>

export const runAppDataWithInput: AppDataInputRunner = (args, input) => new Promise((resolve, reject) => {
    log(`sudo -n ${APP_DATA_HELPER} ${args.join(' ')} (${input.split('\n').filter(Boolean).length} line(s) on stdin)`)
    const proc = spawn('sudo', appDataSudoArgv(args), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    proc.on('error', (err) => reject(new Error(`idea-app-data ${args[0]}: could not start sudo: ${err.message}`)))
    proc.on('close', (code, signal) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(appDataErrorMessage(args[0], code, signal, stderr)))
    })
    proc.stdin.on('error', () => undefined)
    proc.stdin.end(input)
})

// ── Version check at startup ─────────────────────────────────────────────────

/** What is wrong with the installed helper, or null when it is the version this Engine needs. */
export const appDataHelperProblem = async (run: AppDataRunner = runAppData): Promise<string | null> => {
    const want = `idea-app-data ${APP_DATA_HELPER_VERSION}`
    let got: string
    try {
        got = (await run(['version'])).trim()
    } catch (e: any) {
        return `This Engine needs the app-data root helper ${APP_DATA_HELPER} (version ${APP_DATA_HELPER_VERSION}), ` +
            `but it cannot be run with sudo -n (${e?.message ?? e}). Copy, move, backup and restore of app data need it; ${APP_DATA_HELPER_UPDATE}.`
    }
    if (got !== want) {
        return `This Engine needs the app-data root helper ${APP_DATA_HELPER} version ${APP_DATA_HELPER_VERSION}, ` +
            `but the installed one reports '${got}'; ${APP_DATA_HELPER_UPDATE}.`
    }
    return null
}

/**
 * Refuses to start the Engine when the helper is missing, not allowed by sudoers,
 * or the wrong version (like CreateFilesDisk's "ask Ops to install the new
 * 11-engine-files" message, but at startup). isDev machines (the dev containers)
 * have no helper and skip the check, as they skip the other root-only startup steps.
 */
export const assertAppDataHelper = async (run: AppDataRunner = runAppData): Promise<void> => {
    if (config.settings.isDev) {
        log('isDev: not checking the app-data root helper (idea-app-data)')
        return
    }
    const problem = await appDataHelperProblem(run)
    if (problem) throw new Error(problem)
    log(`app-data root helper ${APP_DATA_HELPER} version ${APP_DATA_HELPER_VERSION} is installed`)
}
