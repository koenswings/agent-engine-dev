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
import fs from 'fs'
import { $ } from 'zx'
import { log } from './utils.js'
import { config } from '../data/Config.js'
import { peerSshArgv, checkEngineId, normaliseEd25519 } from './peerSsh.js'
import { normalizeBackupExclude } from './backupExclude.js'
import { isStrictInstanceId, isLegacyDottedInstanceId } from './instanceIds.js'

/** Installed path of the helper (a root-owned copy, 0755; build-engine installUdev). */
export const APP_DATA_HELPER = '/usr/local/sbin/idea-app-data'

/**
 * The helper version this Engine speaks. Must equal IDEA_APP_DATA_VERSION in
 * script/build_image_assets/idea-app-data (a test checks this). Bump both when the
 * subcommands or their arguments change.
 */
export const APP_DATA_HELPER_VERSION = '23'

export const APP_DATA_HELPER_UPDATE =
    'ask Ops to update the Engine\'s root helper: run ./install-root-helpers in the Engine checkout (it installs borgbackup, rsync, ' +
    '/usr/local/sbin/idea-app-data and its line in /etc/sudoers.d/11-engine-files; build-engine does the same) (idea#168)'

/** The borg binary idea-app-data runs by absolute path (BORG= in the helper; Debian package borgbackup). */
export const BORG_PATH = '/usr/bin/borg'

const ROOT_TOKEN = /^(system|sd[a-z][1-9]|[a-z0-9][a-z0-9-]{0,63})$/
const ID_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** engine#401 (helper v16): an optional -hook / -stop / -cold mode suffix. */
const ARCHIVE_TOKEN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]{8,16}Z(-(hook|stop|cold))?$/
/** engine#401: the helper version that accepts a mode suffix on archive names. */
export const ARCHIVE_MODE_HELPER_MIN = 16
/** UTC stamp for .idea-verify/<id>-<stamp>/ (idea#446). No path separators. */
const STAMP_TOKEN = /^[0-9]{8}T[0-9]{6,15}Z$/
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
export const checkStamp = (stamp: string): string => {
    if (stamp.startsWith('-') || stamp.includes('/') || stamp.includes('..') || !STAMP_TOKEN.test(stamp)) {
        throw new Error(`'${stamp}' is not a UTC stamp the app-data helper accepts`)
    }
    return stamp
}

/** Compact UTC stamp for .idea-verify/<id>-<stamp>/ (idea#446). Matches helper RE_STAMP. */
export const verifyStampNow = (at: Date = new Date()): string => {
    const s = at.toISOString().replace(/[-:]/g, '').replace('.', '')
    return checkStamp(s.endsWith('Z') ? s : `${s}Z`)
}

// ── Helper arguments (subcommand first) ──────────────────────────────────────

export const sizeArgs = (root: string, id: string): string[] => ['size', checkRoot(root), checkId(id)]
export const copyArgs = (srcRoot: string, srcId: string, dstRoot: string, dstId: string, opId?: string): string[] =>
    ['copy', checkRoot(srcRoot), checkId(srcId), checkRoot(dstRoot), checkId(dstId), ...(opId ? [checkOpId(opId)] : [])]

// ── engine#497 (helper v20): resumable local copies ──────────────────────────
/** Local copy/move resume (in-flight marker, copy into its own half-written folder, verify-copy, borg-break-lock). */
export const RESUME_HELPER_MIN = 20
const OPID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const checkOpId = (opId: string): string => {
    if (!OPID_TOKEN.test(opId)) throw new Error(`'${opId}' is not an operation id the app-data helper accepts`)
    return opId
}
export const markInFlightArgs = (root: string, id: string, opId: string, engineId: string): string[] =>
    ['mark-in-flight', checkRoot(root), checkId(id), checkOpId(opId), checkEngineId(engineId)]
export const clearInFlightArgs = (root: string, id: string, opId: string): string[] =>
    ['clear-in-flight', checkRoot(root), checkId(id), checkOpId(opId)]
export const verifyCopyArgs = (srcRoot: string, srcId: string, dstRoot: string, dstId: string): string[] =>
    ['verify-copy', checkRoot(srcRoot), checkId(srcId), checkRoot(dstRoot), checkId(dstId)]
export const borgBreakLockArgs = (bdev: string, id: string): string[] => ['borg-break-lock', checkRoot(bdev), checkId(id)]
/** verify-copy output: differences=<n> and up to 10 diff=<item> <path> lines. */
export const parseVerifyCopy = (out: string): { differences: number, diffs: string[] } => {
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
    const n = Number(lines.find(l => l.startsWith('differences='))?.slice('differences='.length))
    if (!Number.isInteger(n) || n < 0) throw new Error(`idea-app-data verify-copy: no differences=<n> line in its output`)
    return { differences: n, diffs: lines.filter(l => l.startsWith('diff=')).map(l => l.slice(5)) }
}
// ── engine#503 (helper v21): Kolibri morango rebind as root ─────────────────
/**
 * Starting a Kolibri copy rebinds its morango instance id. The container owns
 * data/kolibri/db.sqlite3 (root:root 0644), so the Engine (pi) cannot write it:
 * the helper does it as root (kolibri-rebind, v21). Below v21 the start refuses
 * with HELPER_OUTDATED.
 */
export const KOLIBRI_REBIND_HELPER_MIN = 21
export const kolibriRebindArgs = (root: string, id: string): string[] => ['kolibri-rebind', checkRoot(root), checkId(id)]
export interface KolibriRebindResult {
    /** false when the instance has no data/kolibri/db.sqlite3 (nothing to rebind) */
    dbPresent: boolean
    /** the current row's id before the update; null when there was no current row */
    previousId: string | null
    /** the fresh id; null when there was no current row (nothing changed) */
    morangoId: string | null
    /** what the helper moved to .idea-quarantine (stale pid/cache, consumed markers) */
    quarantined: string[]
}
/** kolibri-rebind output: kolibriDb=absent, or previousId= and morangoId= lines; quarantined=<path> lines. */
export const parseKolibriRebind = (out: string): KolibriRebindResult => {
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
    const value = (key: string): string | undefined => lines.find(l => l.startsWith(`${key}=`))?.slice(key.length + 1)
    const quarantined = lines.filter(l => l.startsWith('quarantined=')).map(l => l.slice('quarantined='.length))
    if (value('kolibriDb') === 'absent') return { dbPresent: false, previousId: null, morangoId: null, quarantined }
    const next = value('morangoId')
    if (next === undefined || !/^([0-9a-f]{32}|none)$/.test(next)) {
        throw new Error(`idea-app-data kolibri-rebind: no morangoId=<32 hex>|none line in its output`)
    }
    const prev = value('previousId')
    return {
        dbPresent: true,
        previousId: prev && prev !== 'none' ? prev : null,
        morangoId: next === 'none' ? null : next,
        quarantined,
    }
}
/** send: the peer's address AND its Engine id (the helper pins the peer's host key by Engine id). */
export const sendArgs = (srcRoot: string, srcId: string, host: string, peerEngineId: string, dstRoot: string, dstId: string, opId?: string): string[] => {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) throw new Error(`'${host}' is not a host the app-data helper accepts`)
    return ['send', checkRoot(srcRoot), checkId(srcId), host, checkEngineId(peerEngineId), checkRoot(dstRoot), checkId(dstId), ...(opId ? [checkOpId(opId)] : [])]
}

// ── engine#497 stage 3 (a) (helper v23): cross-Engine resume ─────────────────
/**
 * Koen 2026-11-17, Q1 option A: the SOURCE Engine owns the resume and pushes again into the
 * same folder and id on the peer, under an in-flight marker the peer's gate writes with the
 * gate's own peer id. v22 is engine#506 (swap quarantine); this feature takes v23.
 */
export const CROSS_RESUME_HELPER_MIN = 23
/** verify-send: the content check of a cross-Engine copy against its source (dry run both sides). */
export const verifySendArgs = (srcRoot: string, srcId: string, host: string, peerEngineId: string, dstRoot: string, dstId: string, opId: string): string[] => {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) throw new Error(`'${host}' is not a host the app-data helper accepts`)
    return ['verify-send', checkRoot(srcRoot), checkId(srcId), host, checkEngineId(peerEngineId), checkRoot(dstRoot), checkId(dstId), checkOpId(opId)]
}
/** On a peer (through its gate → peer-mark-in-flight <this Engine>): mark a NEW id for this op. */
export const remoteMarkInFlightArgs = (root: string, id: string, opId: string): string[] =>
    ['mark-in-flight', checkRoot(root), checkId(id), checkOpId(opId)]
/** On a peer (through its gate → peer-clear-in-flight <this Engine>): clear this op's marker. */
export const remoteClearInFlightArgs = (root: string, id: string, opId: string): string[] =>
    ['clear-in-flight', checkRoot(root), checkId(id), checkOpId(opId)]
/** On a peer (through its gate): create apps/, instances/, services/ on <root>, owned by pi. */
export const ensureDirsArgs = (root: string): string[] => ['ensure-dirs', checkRoot(root)]
/**
 * TEST-ONLY: erase a loop-backed duration slot (idea-test-N) to an empty IDEA disk.
 * umount + mkfs.ext4 + remount via the helper; production USB erase stays on idea-erase-disk.
 */
export const eraseSlotArgs = (slot: string, stagingDir: string): string[] => {
    checkRoot(slot)
    if (slot === 'system' || /^sd[a-z][1-9]$/.test(slot)) {
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

/**
 * Tailscale CGNAT (100.64.0.0/10): the sidecar node's own Tailscale IPv4
 * (idea#412). The helper constructs from= itself; callers must not pass options.
 */
export const checkUsageFromIpv4 = (ip: string): string => {
    const m = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(ip)
    if (!m) throw new Error(`'${ip}' is not an IPv4 address the usage-key helper accepts`)
    const o1 = Number(m[1]), o2 = Number(m[2]), o3 = Number(m[3]), o4 = Number(m[4])
    if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) {
        throw new Error(`'${ip}' is not an IPv4 address the usage-key helper accepts`)
    }
    if (!(o1 === 100 && o2 >= 64 && o2 <= 127)) {
        throw new Error(`'${ip}' is not a Tailscale IPv4 address (100.64/10) the usage-key helper accepts`)
    }
    return ip
}

/**
 * idea#412: argv for `idea-app-data install-usage-key`. The helper writes
 * restrict,from="<ipv4>",command="/usr/local/sbin/idea-usage-export" itself.
 * `pubKey` is `ssh-ed25519 <base64>` or just the base64 blob (test fixtures;
 * never a real usage-pull key).
 */
export const installUsageKeyArgs = (ipv4: string, pubKey: string): string[] => {
    const ip = checkUsageFromIpv4(ipv4)
    const trimmed = pubKey.trim()
    const line = trimmed.startsWith('ssh-ed25519 ') ? trimmed : `ssh-ed25519 ${trimmed}`
    const normalised = normaliseEd25519(line)
    if (!normalised) throw new Error(`'${pubKey}' is not an ed25519 public key the usage-key helper accepts`)
    return ['install-usage-key', ip, 'ssh-ed25519', normalised.split(' ')[1]]
}

/** idea#347: rename instances/<id> to <disk>/.idea-quarantine/<id>-<UTC stamp>; prints the new path. */
export const quarantineArgs = (root: string, id: string): string[] => ['quarantine', checkRoot(root), checkId(id)]
/**
 * removeInstance only (idea#479, helper v13): `quarantine` with a strict id or a
 * legacy dotted id (`RE_LEGACY_ID` in the helper). Every other subcommand stays strict.
 */
export const removalQuarantineArgs = (root: string, id: string): string[] => {
    if (!isStrictInstanceId(id) && !isLegacyDottedInstanceId(id)) throw new Error(`'${id}' is not an instance id the app-data helper accepts for removal`)
    return ['quarantine', checkRoot(root), id]
}
export const deleteArgs = (root: string, id: string): string[] => ['delete', checkRoot(root), checkId(id)]
export const borgInitArgs = (bdev: string, id: string): string[] => ['borg-init', checkRoot(bdev), checkId(id)]
export const borgInfoArgs = (bdev: string, id: string): string[] => ['borg-info', checkRoot(bdev), checkId(id)]
export const borgCreateArgs = (bdev: string, id: string, archive: string, srcRoot: string, excludes: string[] = []): string[] => {
    const args = ['borg-create', checkRoot(bdev), checkId(id), checkArchive(archive), checkRoot(srcRoot)]
    const seen = new Set<string>()
    for (const raw of excludes) {
        const n = normalizeBackupExclude(raw)
        if (seen.has(n)) continue
        seen.add(n)
        args.push(n)
    }
    return args
}
export const borgExtractArgs = (bdev: string, id: string, archive: string, strip: number, dstRoot: string): string[] => {
    if (!Number.isInteger(strip) || strip < 1 || strip > 9) throw new Error(`strip ${strip} is out of range (1-9)`)
    return ['borg-extract', checkRoot(bdev), checkId(id), checkArchive(archive), String(strip), checkRoot(dstRoot)]
}
/**
 * engine#468 / helper v19: borg-extract moves the instance folder it replaces into
 * <target>/.idea-quarantine/<id>-replaced-<UTC stamp> (every copy is kept; cleanup via #273) instead
 * of deleting it. An older helper deletes it, so an in-place restore refuses below v19.
 */
export const RESTORE_REPLACED_QUARANTINE_HELPER_MIN = 19

export interface BorgExtractResult {
    /** where the replaced instance folder went (helper v19), or null */
    replacedQuarantine: string | null
    /** the replaced folder could not be quarantined and is still at this staging path */
    replacedKept: string | null
}

/** Parse borg-extract's v19 stdout (key=value lines; anything else is ignored). */
export const parseBorgExtract = (stdout: string): BorgExtractResult => {
    const out: BorgExtractResult = { replacedQuarantine: null, replacedKept: null }
    for (const line of String(stdout ?? '').split('\n')) {
        const m = line.trim().match(/^(replacedQuarantine|replacedKept)=(\/.+)$/)
        if (!m) continue
        if (m[1] === 'replacedQuarantine') out.replacedQuarantine = m[2]
        else out.replacedKept = m[2]
    }
    return out
}

/** idea#401 / helper v9, fixed in v10 (idea#450): JSON of every archive (borg info --json --glob-archives '*') so the Engine can pick.
 *  idea#446: pass `archive` for a member list of that one archive (`borg list --short`). */
export const borgListArgs = (bdev: string, id: string, archive?: string): string[] => {
    const args = ['borg-list', checkRoot(bdev), checkId(id)]
    if (archive !== undefined) args.push(checkArchive(archive))
    return args
}
/** idea#446 / helper v9: extract into <backup disk>/.idea-verify/<id>-<stamp>/; never instances/<id>. */
export const borgExtractVerifyArgs = (bdev: string, id: string, archive: string, stamp: string): string[] =>
    ['borg-extract-verify', checkRoot(bdev), checkId(id), checkArchive(archive), checkStamp(stamp)]
/** idea#446 / helper v9: move <disk>/backups/ to <disk>/.idea-quarantine/backups-<UTC stamp>/. */
export const quarantineBackupsArgs = (bdev: string): string[] => ['quarantine-backups', checkRoot(bdev)]
/**
 * engine#415 / helper v17 (Koen's decision (b), keep-latest): keep the verify copy
 * <id>-<stamp> just checked and remove the instance's OTHER complete verify copies under
 * <backup disk>/.idea-verify/. Copies without the v17 complete-extract marker (a failed
 * extract) are never touched. Prints `removed <path>` per copy and `kept <path>`.
 */
export const cleanVerifyArgs = (bdev: string, id: string, stamp: string): string[] =>
    ['clean-verify', checkRoot(bdev), checkId(id), checkStamp(stamp)]
/** engine#415: first helper with clean-verify and the complete-extract marker. */
export const CLEAN_VERIFY_HELPER_MIN = 17
/** idea#401: delete one archive. Omit keepMin to use the helper default (3). */
export const borgDeleteArgs = (bdev: string, id: string, archive: string, keepMin?: number): string[] => {
    const args = ['borg-delete', checkRoot(bdev), checkId(id), checkArchive(archive)]
    if (keepMin !== undefined) {
        if (!Number.isInteger(keepMin) || keepMin < 1 || keepMin > 9999) {
            throw new Error(`keepMin ${keepMin} is not a positive integer`)
        }
        args.push(String(keepMin))
    }
    return args
}
export const borgCompactArgs = (bdev: string, id: string): string[] => ['borg-compact', checkRoot(bdev), checkId(id)]

/** Helper protocol that adds borg-list / borg-delete / borg-compact (idea#401) and the idea#446 verbs.
 *  v10 (idea#450): the v9 2-arg borg-list printed repository info without an archives list on real borg,
 *  so cleanup requires v10 and a v9 helper gets HELPER_OUTDATED. */
export const BACKUP_CLEANUP_HELPER_MIN = 10

/**
 * Helper protocol whose sync-peers takes the caller's Engine id and store document id,
 * keeps an owner stamp and never empties the host-wide peer files (engine#376). An older
 * helper would rewrite (or empty) the files from any caller, so the Engine does not call
 * sync-peers at all below this version and logs HELPER_OUTDATED.
 */
export const PEER_FILES_HELPER_MIN = 15

/** Store document ids as the helper accepts them (bare base58 Automerge id; helper RE_STORE_DOC). */
export const STORE_DOC_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{16,64}$/

/** v15 (engine#376): `sync-peers <engineId> <storeDocId>`; the peer set goes on stdin. */
export const syncPeersArgs = (engineId: string, storeDocId: string): string[] => {
    const doc = storeDocId.trim().replace(/^automerge:/, '')
    if (!STORE_DOC_ID_RE.test(doc)) throw new Error(`'${storeDocId}' is not a store document id the app-data helper accepts (${STORE_DOC_ID_RE})`)
    return ['sync-peers', checkEngineId(engineId), doc]
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

export const remoteSizeSshArgs = (host: string, peerEngineId: string, root: string, id: string): string[] =>
    peerSshArgv(host, peerEngineId, remoteHelperCommand(sizeArgs(root, id)))

/** The ssh argv that creates apps/, instances/ and services/ on the peer's target disk (idea#80). */
export const remoteEnsureDirsSshArgs = (host: string, peerEngineId: string, root: string): string[] =>
    peerSshArgv(host, peerEngineId, remoteHelperCommand(ensureDirsArgs(root)))
/** engine#497 (a): mark / clear this op's in-flight marker on a peer (v23 gate verbs). */
export const remoteMarkInFlightSshArgs = (host: string, peerEngineId: string, root: string, id: string, opId: string): string[] =>
    peerSshArgv(host, peerEngineId, remoteHelperCommand(remoteMarkInFlightArgs(root, id, opId)))
export const remoteClearInFlightSshArgs = (host: string, peerEngineId: string, root: string, id: string, opId: string): string[] =>
    peerSshArgv(host, peerEngineId, remoteHelperCommand(remoteClearInFlightArgs(root, id, opId)))

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

/**
 * engine#430: the argv for `nice` in a low-priority helper run: nice -n 19 ionice -c3 sudo -n
 * /usr/local/sbin/idea-app-data <args…>. nice and ionice wrap sudo from the outside and
 * the helper inherits both, so the words sudo receives (and the sudoers match on the
 * helper path) are exactly those of runAppData. The helper and sudoers stay unchanged.
 */
export const lowPriorityAppDataArgv = (args: string[]): string[] =>
    ['-n', '19', 'ionice', '-c3', 'sudo', ...appDataSudoArgv(args)]

const spawnAppData = (cmd: string, argv: string[], args: string[]): Promise<string> => new Promise((resolve, reject) => {
    log(`${cmd} ${argv.join(' ')}`)
    const proc = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    proc.on('error', (err) => reject(new Error(`idea-app-data ${args[0]}: could not start ${cmd}: ${err.message}`)))
    proc.on('close', (code, signal) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(appDataErrorMessage(args[0], code, signal, stderr)))
    })
})

/** Default runner: `sudo -n /usr/local/sbin/idea-app-data <args…>` (no shell). */
export const runAppData: AppDataRunner = (args) => spawnAppData('sudo', appDataSudoArgv(args), args)

/**
 * engine#430: the same helper run at the lowest CPU and idle I/O priority
 * (`nice -n 19 ionice -c3 sudo -n …`), for background measurements that must never
 * slow the Apps down. copyApp/moveApp space checks keep runAppData.
 */
export const runAppDataLowPriority: AppDataRunner = (args) => spawnAppData('nice', lowPriorityAppDataArgv(args), args)

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

/** True when `idea-app-data size` on the peer succeeds (the instance folder exists). */
export const remoteInstanceFolderExists = async (host: string, peerEngineId: string, root: string, id: string): Promise<boolean> => {
    try {
        const out = String((await $`${remoteSizeSshArgs(host, peerEngineId, root, id)}`).stdout ?? '').trim()
        const last = out.split('\n').pop() ?? out
        return /^[0-9]+$/.test(last)
    } catch {
        return false
    }
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

/**
 * What is wrong with borg for the helper, or null. The helper runs /usr/bin/borg
 * by absolute path; without it backup and restore fail with exit 127 (wh, 2026-10-13).
 */
/** How borgProblem looks for the binary; tests that fake the helper replace `exists`. */
export const borgPresence: { exists: (p: string) => boolean } = { exists: (p) => fs.existsSync(p) }

export const borgProblem = (exists: (p: string) => boolean = borgPresence.exists): string | null =>
    exists(BORG_PATH) ? null :
        `${BORG_PATH} is not installed, so Backup Disk backups and restores cannot run (the app-data helper calls it by absolute path); ${APP_DATA_HELPER_UPDATE}.`

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
 * Startup check (softened, Steve 2026-10-28): the Engine ALWAYS starts. A missing,
 * unrunnable or different helper is logged loudly and returned; each command that
 * needs a newer helper refuses on its own with HELPER_OUTDATED (helperAtLeast):
 * removeInstance needs v4, updateApp v14, peer-file sync v15 (engine#376). isDev machines skip the check.
 */
export const assertAppDataHelper = async (run: AppDataRunner = runAppData): Promise<string | null> => {
    if (config.settings.isDev) {
        log('isDev: not checking the app-data root helper (idea-app-data)')
        return null
    }
    const problem = await appDataHelperProblem(run)
    if (problem) {
        log(`WARNING: ${problem} The Engine starts anyway; commands that need a newer helper refuse with HELPER_OUTDATED.`)
        return problem
    }
    log(`app-data root helper ${APP_DATA_HELPER} version ${APP_DATA_HELPER_VERSION} is installed`)
    return null
}

/** null when the installed helper is at least `min`; else a clear message for HELPER_OUTDATED. */
export const helperAtLeast = async (min: number, what: string, run: AppDataRunner = runAppData): Promise<string | null> => {
    let got = ''
    try { got = (await run(['version'])).trim() } catch (e: any) {
        return `${what} needs the app-data root helper ${APP_DATA_HELPER} v${min} or later, but it cannot be run with sudo -n (${e?.message ?? e}); ${APP_DATA_HELPER_UPDATE}.`
    }
    const v = Number(got.match(/^idea-app-data (\d+)$/)?.[1])
    if (Number.isFinite(v) && v >= min) return null
    return `${what} needs the app-data root helper ${APP_DATA_HELPER} v${min} or later, but the installed one reports '${got || 'nothing'}'; ${APP_DATA_HELPER_UPDATE}.`
}

/**
 * Startup preflight for borg. Not fatal (an Engine without a Backup Disk works),
 * but loud at start, and backupMonitor refuses a backup with the same message
 * instead of running into exit 127.
 */
export const reportBorgAtStartup = (exists: (p: string) => boolean = borgPresence.exists): string | null => {
    if (config.settings.isDev) return null
    const problem = borgProblem(exists)
    if (problem) console.error(`ERROR (preflight): ${problem}`)
    else log(`${BORG_PATH} is installed`)
    return problem
}

// ── updateApp snapshots (helper v5, agent-engine-dev#230) ────────────────────
/** Normalised, de-duplicated exclude tokens (same rules as the helper; throws on a bad one). */
const excludeTokens = (excludes: string[]): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of excludes) {
        const n = normalizeBackupExclude(raw)
        if (seen.has(n)) continue
        seen.add(n)
        out.push(n)
    }
    return out
}
/** v9 (idea#448): trailing excludes are left out of the snapshot and recorded in its EXCLUDE file. */
export const snapshotArgs = (root: string, id: string, excludes: string[] = []): string[] =>
    ['snapshot', checkRoot(root), checkId(id), ...excludeTokens(excludes)]
/** v9 (idea#448): in place; the snapshot's EXCLUDE plus these excludes are never written, deleted or moved. */
export const restoreSnapshotArgs = (root: string, id: string, excludes: string[] = []): string[] =>
    ['restore-snapshot', checkRoot(root), checkId(id), ...excludeTokens(excludes)]
export const snapshotsArgs = (root: string): string[] => ['snapshots', checkRoot(root)]
export const estimateArgs = (root: string, id: string, excludes: string[] = []): string[] =>
    ['estimate', checkRoot(root), checkId(id), ...excludeTokens(excludes)]
/**
 * idea#396 / helper v14: move `.pre-update/<id>` to
 * `.idea-quarantine/pre-update-<id>-<stamp>/`. Strict ids only. A missing
 * snapshot is success with empty stdout (nothing to quarantine).
 */
export const quarantineSnapshotArgs = (root: string, id: string): string[] =>
    ['quarantine-snapshot', checkRoot(root), checkId(id)]
/** `estimate` result: "<folder kb> <volumes kb> <free kb>" (read-only; nothing is stopped). */
export const parseEstimate = (out: string): { folderBytes: number, volumeBytes: number, freeBytes: number } => {
    const m = lastLine(out).match(/^(\d+) (\d+) (\d+)$/)
    if (!m) throw new Error(`idea-app-data estimate gave no result line: ${lastLine(out) || '(empty)'}`)
    return { folderBytes: Number(m[1]) * 1024, volumeBytes: Number(m[2]) * 1024, freeBytes: Number(m[3]) * 1024 }
}

/** The helper prints rsync progress first; its result is the last non-empty line. */
export const lastLine = (out: string): string => out.trim().split('\n').map(s => s.trim()).filter(Boolean).pop() ?? ''

/** Destination path from quarantine-snapshot stdout, or '' when there was nothing to move. */
export const parseQuarantineSnapshot = (out: string): string => lastLine(out)

export interface SnapshotVolume { name: string, bytes: number, exportMs: number }
export interface SnapshotResult {
    path: string, sizeBytes: number
    /** where the previous snapshot of this instance was renamed to (.idea-quarantine), or null */
    previousQuarantinedAt: string | null
    volumes: SnapshotVolume[]
}

/** `snapshot` result: "VOLUME <name> <bytes> <ms>" lines, then "<dir> <kb> <old|none>" last. */
export const parseSnapshotResult = (out: string): SnapshotResult => {
    const m = lastLine(out).match(/^(\/\S+) (\d+)(?: (\S+))?$/)
    if (!m) throw new Error(`idea-app-data snapshot gave no result line: ${lastLine(out) || '(empty)'}`)
    const volumes = [...out.matchAll(/^VOLUME (\S+) (\d+) (\d+)$/gm)].map(v => ({ name: v[1], bytes: Number(v[2]), exportMs: Number(v[3]) }))
    return { path: m[1], sizeBytes: Number(m[2]) * 1024, previousQuarantinedAt: m[3] && m[3] !== 'none' ? m[3] : null, volumes }
}

/** `snapshots` lines: "<id> <kb> complete|incomplete", then "TOTAL pre-update <kb>" and "TOTAL quarantine <kb>". */
export const parseSnapshotsList = (out: string): { snapshots: { instanceId: string, sizeBytes: number, complete: boolean }[], preUpdateBytes: number | null, quarantineBytes: number | null } => {
    const total = (what: string) => { const m = out.match(new RegExp(`^TOTAL ${what} (\\d+)$`, 'm')); return m ? Number(m[1]) * 1024 : null }
    return {
        snapshots: out.split('\n').map(l => l.trim().match(/^([a-z0-9][a-z0-9-]{0,63}) (\d+) (complete|incomplete)$/))
            .filter((m): m is RegExpMatchArray => !!m)
            .map(m => ({ instanceId: m[1], sizeBytes: Number(m[2]) * 1024, complete: m[3] === 'complete' })),
        preUpdateBytes: total('pre-update'), quarantineBytes: total('quarantine'),
    }
}


// ── Temporary pre-update backups on the system disk (helper v18, engine#469) ──
/** engine#469: first helper with the temp-backup-* verbs. Feature min stays 18; the helper itself is v19 after engine#468. */
export const TEMP_BACKUP_HELPER_MIN = 18
/** Folder name under the system disk root (the helper's TEMP_BACKUPS_NAME). */
export const TEMP_BACKUPS_DIR = '/.idea-temp-backups'

const backupExcludeTokens = (excludes: string[]): string[] => {
    const out: string[] = []
    for (const raw of excludes) {
        const n = normalizeBackupExclude(raw)
        if (!out.includes(n)) out.push(n)
    }
    return out
}
/** Read-only: "<net kb> <free kb> <same fs 0|1>" (net of the x-app.backup.exclude paths). */
export const tempBackupEstimateArgs = (root: string, id: string, excludes: string[] = []): string[] =>
    ['temp-backup-estimate', checkRoot(root), checkId(id), ...backupExcludeTokens(excludes)]
/** Borg repo at <system>/.idea-temp-backups/<id>/<stamp>/repo; containers must be stopped. */
export const tempBackupCreateArgs = (root: string, id: string, stamp: string, archive: string, excludes: string[] = []): string[] =>
    ['temp-backup-create', checkRoot(root), checkId(id), checkStamp(stamp), checkArchive(archive), ...backupExcludeTokens(excludes)]
/** rm -rf of <system>/.idea-temp-backups/<id>/<stamp> only (Koen's exception, engine#469). */
export const tempBackupDeleteArgs = (id: string, stamp: string): string[] => ['temp-backup-delete', checkId(id), checkStamp(stamp)]
/** Restore instances/<id> on <root> from a COMPLETE temporary backup; the replaced folder is quarantined. */
export const tempBackupRestoreArgs = (root: string, id: string, stamp: string): string[] =>
    ['temp-backup-restore', checkRoot(root), checkId(id), checkStamp(stamp)]
export const tempBackupsArgs = (): string[] => ['temp-backups']

/** The folder of one temporary backup (what the helper prints and builds). */
export const tempBackupPath = (id: string, stamp: string): string => `${TEMP_BACKUPS_DIR}/${checkId(id)}/${checkStamp(stamp)}`

export interface TempBackupEstimate { netBytes: number, freeBytes: number, sameFilesystem: boolean }
export const parseTempBackupEstimate = (out: string): TempBackupEstimate => {
    const m = lastLine(out).match(/^(\d+) (\d+) ([01])$/)
    if (!m) throw new Error(`idea-app-data temp-backup-estimate gave no result line: ${lastLine(out) || '(empty)'}`)
    return { netBytes: Number(m[1]) * 1024, freeBytes: Number(m[2]) * 1024, sameFilesystem: m[3] === '1' }
}
/** `temp-backup-create` result: "<folder> <kb>" last. */
export const parseTempBackupCreate = (out: string): { path: string, sizeBytes: number } => {
    const m = lastLine(out).match(/^(\/\S+) (\d+)$/)
    if (!m) throw new Error(`idea-app-data temp-backup-create gave no result line: ${lastLine(out) || '(empty)'}`)
    return { path: m[1], sizeBytes: Number(m[2]) * 1024 }
}
export interface TempBackupEntry { instanceId: string, stamp: string, sizeBytes: number, complete: boolean }
/** `temp-backups`: "<id> <stamp> <kb> complete|incomplete" lines, then "TOTAL <kb>". */
export const parseTempBackups = (out: string): { backups: TempBackupEntry[], totalBytes: number | null } => {
    const t = out.match(/^TOTAL (\d+)$/m)
    return {
        backups: out.split('\n').map(l => l.trim().match(/^([a-z0-9][a-z0-9-]{0,63}) ([0-9]{8}T[0-9]{6,15}Z) (\d+) (complete|incomplete)$/))
            .filter((m): m is RegExpMatchArray => !!m)
            .map(m => ({ instanceId: m[1], stamp: m[2], sizeBytes: Number(m[3]) * 1024, complete: m[4] === 'complete' })),
        totalBytes: t ? Number(t[1]) * 1024 : null,
    }
}
