/**
 * RealFleetOps — live fleet adapter for duration-tests (idea#166).
 *
 * Connects over Tailscale/SSH + Automerge WS. Prefer Engine ejectDisk over
 * physical USB yank. Kid fixture dock (testMode) =
 *   copy pack → private IDEA_DISKS_ROOT/idea-test-N/ + sentinel under IDEA_WATCH_DIR
 * Defaults (Atlas-approved): /home/pi/idea/duration-disks + duration-watch.
 * idea#168 r34@70: app-pack trees must carry their instance data before a dock with instances
 * started (LOUD otherwise), and moveDisk carries the source disk's real tree to the target.
 * idea#168 r35@62: a fixture slot whose paths resolve OUTSIDE the slot (symlinks) is refused
 * LOUDLY (dock + move), and moveDisk refuses while any foreign running container mounts data
 * inside the source slot (never stops it).
 * NEVER /disks, NEVER /dev/engine, NEVER idea03 sdb1, NEVER golden idea02.
 *
 * Connection helpers are inlined (adapted from test/cross-engine/remoteClient.ts)
 * so unique-store mode can open a distinct store URL per host without the shared
 * remoteClient cache.
 */

import { Repo, type DocHandle, type DocumentId, type PeerId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { $ } from 'zx'
import type { Store } from '../../src/data/Store.js'
import { runningInstanceExpectsLocalDocker } from './stability.js'
import { consoleDistProbeScript, parseConsoleDistProbe, type ConsoleDistProbe } from './consoleDeploy.js'
import type { DurationCommandTrace } from './actions.js'
import {
    abandonRepo,
    describeEngineLink,
    getEngineLink,
    noteEngineStoreReady,
    noteEngineWs,
    registerOwnDoc,
    reportEngineUnreachable,
    reportOwnStoreStall,
    trackRepo,
} from './automergeTimeoutGuard.js'
import type {
    FleetOps,
    SemanticStoreView,
    SettleReady,
    StoreMode,
} from './types.js'

$.verbose = false

const DEFAULT_SSH_USER = 'pi'
const DEFAULT_ENGINE_PORT = 4321
const GOLDEN_DEFAULT = 'idea02'

/** Atlas-approved private roots on pool Pis — never /disks or /dev/engine. */
export const DEFAULT_DURATION_DISKS_ROOT = '/home/pi/idea/duration-disks'
export const DEFAULT_DURATION_WATCH_DIR = '/home/pi/idea/duration-watch'
/** Kid packs on the Pi workspace (agent-app-dev#10). */
export const DEFAULT_DURATION_FIXTURE_SOURCE_ROOT =
    '/home/pi/idea/agents/agent-app-dev/tests/duration-tests/fixtures'

/**
 * After infra_reboot_engine --fast (pm2 restart), 60s was insufficient on overnight
 * smoke (~step 22): Automerge withTimeout while idea03 was still reconnecting after
 * rapid pm2 restarts. Duration-test-only bump (RealFleetOps), not production Engine.
 */
export const PM2_RECONNECT_TIMEOUT_MS = 150_000
/**
 * r32: wait for the automerge-repo WS handshake before repo.find(). Without it,
 * WebSocketClientAdapter force-marks itself ready after 1 s (dist/WebSocketClientAdapter.js
 * connect → setTimeout(#forceReady, 1000)); a find() with zero peers then turns the store
 * handle 'unavailable' at once ("Document … is unavailable"), which the probe reported as
 * "WS down" even when the Engine answered a moment later (idea04 handshake ≈0.6–0.7 s idle).
 */
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10_000
/** r32: pre-walk check that every pool Engine serves the store over WS (fail fast, exit 4). */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60_000
/**
 * r32: how long a fresh connection may take to deliver the full store doc after the WS
 * handshake. A fresh peer's full 3zoqd sync takes ~3.5–7 s on the Pi 5s and ~7–11 s on
 * idea04 (Pi 4) (path-a-ready-r33 IDEA04-WS.md), so never less than 15 s.
 * Override: DURATION_DOC_WAIT_MS (all hosts), DURATION_DOC_WAIT_MS_BY_HOST="idea04=30000,…",
 * DURATION_DOC_WAIT_MS_<HOST> (e.g. DURATION_DOC_WAIT_MS_IDEA04). Env values below 15 s are raised to 15 s.
 */
export const MIN_DOC_WAIT_MS = 15_000
export const DEFAULT_DOC_WAIT_MS = 15_000
export const DEFAULT_DOC_WAIT_MS_BY_HOST: Readonly<Record<string, number>> = { idea04: 30_000 } // Pi 4
/**
 * Upper bound for env doc waits: automerge-repo's DocSynchronizer arms a bare 60 s
 * whenReady() on the connecting Repo's handle; a connect attempt (handshake + doc wait)
 * must conclude (ready, or closed and judged) before that timer fires.
 */
export const MAX_DOC_WAIT_MS = 45_000

/** Thrown when the WS is up but the store doc never became ready within the per-host wait. */
export class StoreSyncStallError extends Error {
    constructor(readonly engine: string, readonly url: string, readonly detail: string) {
        super(`engine ${engine}: store sync stall (WS ${url} up): ${detail}`)
        this.name = 'StoreSyncStallError'
    }
}
export const FULL_REBOOT_RECONNECT_TIMEOUT_MS = 180_000

const FORBIDDEN_DISKS_ROOTS = ['/disks', '/disks/']
const FORBIDDEN_WATCH_DIRS = ['/dev/engine', '/dev/engine/']

const DISK_ID_TO_PACK: Record<string, string> = {
    'duration-kolibri-grade5a-001': 'kolibri',
    'duration-nextcloud-grade5a-001': 'nextcloud',
    'duration-empty-001': 'empty',
    /** Prefer A r17 second empty (Kid App#10 pack empty-002/). */
    'duration-empty-002': 'empty-002',
}

/** Prefer Atlas dock slot when allocating (empty → idea-test-3; empty2 → idea-test-4). */
const DISK_ID_PREFERRED_DEVICE: Record<string, string> = {
    'duration-empty-001': 'idea-test-3',
    'duration-empty-002': 'idea-test-4',
}

/** Known Path A instance ids (no duration- prefix on the container/instance). */
const DURATION_FIXTURE_INSTANCE_IDS = new Set([
    'kolibri-grade5a-001',
    'nextcloud-grade5a-001',
])

/**
 * True for Path A duration fixture disk/instance ids only.
 * Never idea166-* sidecars, Intenso, or unrelated containers.
 */
export const looksLikeDurationFixtureId = (id: string): boolean => {
    if (!id || id.includes('idea166-')) return false
    if (id in DISK_ID_TO_PACK) return true
    if (DURATION_FIXTURE_INSTANCE_IDS.has(id)) return true
    if (id.startsWith('duration-')) return true
    if (id.includes('kolibri-grade5a') || id.includes('nextcloud-grade5a')) return true
    return false
}

/** idea03 Intenso hw-roundtrip stick — NEVER eject/erase for duration tests. */
export const PROTECTED_DISK_MARKERS = [
    '26A1EE83197F',
    '3E50-902A',
    '3813430-532011020',
    'a0bf8374-274e-4bef-b32e-cfbfd09d2884',
    '378383c9-0612-4c82-9c07-8c34d15253ba',
] as const

const PROTECTED_LABELS = ['IDEA Disk'] as const

const SYSTEMISH_DISK_MARKERS = ['root', 'system', 'mmcblk0', 'nvme0n1', 'sda1'] as const

export const looksLikeProtectedHwDisk = (diskIdOrName: string, extra?: {
    name?: string | null
    label?: string | null
    device?: string | null
}): boolean => {
    const hay = [
        diskIdOrName,
        extra?.name ?? '',
        extra?.label ?? '',
        extra?.device ?? '',
    ].join(' ').toUpperCase()
    for (const m of PROTECTED_DISK_MARKERS) {
        if (hay.includes(m.toUpperCase())) return true
    }
    for (const lab of PROTECTED_LABELS) {
        // Exact-ish label match (avoid matching "duration-…-IDEA…" synthetic ids)
        const name = (extra?.name ?? diskIdOrName).trim()
        if (name === lab || (extra?.label ?? '').trim() === lab) return true
    }
    const device = (extra?.device ?? '').toLowerCase()
    for (const sys of SYSTEMISH_DISK_MARKERS) {
        if (device === sys || device.startsWith(`${sys}p`) || device === `/dev/${sys}`) return true
    }
    return false
}

export interface RealFleetOptions {
    poolEngines: string[]
    excludeEngines?: string[]
    /** engineId/hostname → Tailscale IP or host */
    hosts: Record<string, string>
    storeMode?: StoreMode
    fixtureInstances?: Record<string, string>
    sshUser?: string
    enginePort?: number
    /** Optional shell run before reboot; may include `{pis}` placeholder. */
    healthWrapBefore?: string
    /** Optional shell run after waitReady post-reboot; may include `{pis}`. */
    healthWrapAfter?: string
    /** Override store URL per logical engine (automerge:… or bare doc id). */
    storeUrls?: Record<string, string>
    /**
     * Private App Disk mount root on the Pi (testMode fixture trees).
     * Default: /home/pi/idea/duration-disks. NEVER /disks.
     */
    disksRoot?: string
    /**
     * Private chokidar watch dir for idea-test-N sentinels.
     * Default: /home/pi/idea/duration-watch. NEVER /dev/engine.
     */
    watchDir?: string
    /** Kid fixture pack root on the Pi. */
    fixtureSourceRoot?: string
    /**
     * When false (default for duration dock smoke), copy fixture without instances/
     * so Engine docks the disk but does not auto-start Kolibri/Nextcloud.
     * Image pull is not required for dock-only smoke.
     */
    startInstances?: boolean
    /** waitReady timeout after pm2 restart (default PM2_RECONNECT_TIMEOUT_MS). */
    pm2ReconnectTimeoutMs?: number
    /** Max wait for the WS handshake before find() (default DURATION_WS_HANDSHAKE_MS or 10 s). */
    wsHandshakeTimeoutMs?: number
    /** Per-host doc wait after the handshake (tests may go below MIN_DOC_WAIT_MS; env may not). */
    docWaitMs?: number
    docWaitMsByHost?: Record<string, number>
    /** Called on a real own-store stall (WS up, doc never ready). Default: reportOwnStoreStall → exit 2. */
    onOwnStoreStall?: (engine: string, docId: string, detail: string) => void
    /**
     * idea#168 r34@70: privilege for fixture-tree reads/moves on the Pi. 'auto' (default) uses
     * `sudo -n` when the host grants it (docker-owned instance data) and runs as the ssh user
     * otherwise (idea01 had no passwordless sudo at r30); 'never' always runs as the ssh user
     * (unit tests on a box that has sudo).
     */
    sudoMode?: SudoMode
}

/** Thrown when a pool Engine's WS never completes the automerge-repo handshake. */
export class EngineUnreachableError extends Error {
    constructor(readonly engine: string, readonly url: string, readonly detail: string) {
        super(`engine ${engine} unreachable (WS ${url}): ${detail}`)
        this.name = 'EngineUnreachableError'
    }
}

/**
 * WebSocketClientAdapter that reports raw socket errors (ECONNREFUSED, …) to the timeout
 * guard and can be closed for good: the library's onClose schedules a reconnect with a
 * bare setTimeout that disconnect() does not cancel, so a "closed" adapter could open a
 * new socket 2 s later (leak). After disconnect() this adapter never connects again.
 */
export class TrackedWebSocketClientAdapter extends WebSocketClientAdapter {
    #closedForGood = false
    #closed: Promise<void> = Promise.resolve()
    connect(peerId: PeerId, peerMetadata?: Parameters<WebSocketClientAdapter['connect']>[1]): void {
        if (this.#closedForGood) return
        super.connect(peerId, peerMetadata)
    }
    disconnect(): void {
        this.#closedForGood = true
        const socket = this.socket as unknown as {
            readyState: number
            on?(e: string, fn: (...a: unknown[]) => void): unknown
            once?(e: string, fn: () => void): unknown
        } | undefined
        if (!socket || !this.peerId) return // never connected: nothing to close
        // ws emits 'error' when a CONNECTING socket is aborted; the library removed its
        // listener first, which would make that an uncaught exception (exit 2).
        socket.on?.('error', () => {})
        if (socket.readyState !== 3 /* CLOSED */) {
            this.#closed = new Promise<void>(resolve => {
                const t = setTimeout(resolve, 1_500)
                socket.once?.('close', () => { clearTimeout(t); resolve() })
            })
        }
        super.disconnect()
    }
    /** Resolves once the socket closed by disconnect() is fully closed (max 1.5 s). */
    whenClosed(): Promise<void> {
        return this.#closed
    }
    constructor(url: string, retryInterval: number, via: string) {
        super(url, retryInterval)
        this.onError = event => {
            const err = (event as { error?: { code?: string; message?: string } }).error
            noteEngineWs(via, 'socket-error', `socket ${err?.code ?? err?.message ?? 'error'}`, url)
            // The library ignores only ECONNREFUSED and rethrows every other socket error
            // (EHOSTUNREACH, ETIMEDOUT, ECONNRESET…) from an event listener — an uncaught
            // exception that would kill the walker (exit 2) for a merely unreachable host.
            // Record it instead; the adapter keeps retrying and RealFleetOps judges reachability.
        }
    }
}

/** The adapter behind each walker Repo (closeRepo waits for its socket to close). */
const adapterOf = new WeakMap<Repo, TrackedWebSocketClientAdapter>()

/** Resolve once the Repo has a connected peer (handshake done), else reject after `ms`. */
const waitForHandshake = (repo: Repo, engine: string, url: string, ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
        if (repo.peers.length > 0) return resolve()
        const ns = repo.networkSubsystem as unknown as {
            on(e: 'peer', fn: () => void): unknown
            off(e: 'peer', fn: () => void): unknown
        }
        const onPeer = () => { clearTimeout(timer); ns.off('peer', onPeer); resolve() }
        const timer = setTimeout(() => {
            ns.off('peer', onPeer)
            const last = getEngineLink(engine)?.lastError
            reject(new EngineUnreachableError(engine, url, `no WS handshake within ${ms}ms${last ? ` (last ${last})` : ''}`))
        }, ms)
        ns.on('peer', onPeer)
    })

interface Conn {
    repo: Repo
    storeHandle: DocHandle<Store>
    host: string
    logicalId: string
    liveEngineId: string | null
    storeDocId: DocumentId
}

const sshOpts = [
    '-i', `${process.env.HOME}/.ssh/id_ed25519`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
]

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Close a connection for good: mark it abandoned for the timeout guard (its late
 * whenReady rejections are then tolerated), then shut the Repo down, which disconnects
 * the adapter and closes the socket (TrackedWebSocketClientAdapter never reconnects).
 */
const closeRepo = async (repo: Repo, reason: string, _stall = false): Promise<void> => {
    abandonRepo(repo as unknown as Parameters<typeof abandonRepo>[0], reason)
    try {
        await repo.shutdown()
    } catch {
        // ignore shutdown races (socket already gone)
    }
    // Close-before-retry: the old socket is fully closed before any new one is opened.
    await adapterOf.get(repo)?.whenClosed()
}

type StoreDocOutcome =
    | { kind: 'ready'; handle: DocHandle<Store> }
    | { kind: 'doc-unavailable' | 'ws-closed' | 'stall'; detail: string }

/**
 * Wait (polling, no extra withTimeout timers) until the store doc is ready on this Repo
 * or `deadline` passes. Peer drops are left to the adapter's own reconnect.
 */
const awaitStoreDoc = async (repo: Repo, docId: DocumentId, deadline: number): Promise<StoreDocOutcome> => {
    type Msg = { type?: string; documentId?: string }
    const ns = repo.networkSubsystem as unknown as {
        on(e: string, fn: (m: Msg) => void): unknown
        off(e: string, fn: (m: Msg) => void): unknown
    }
    let syncMsgs = 0
    let drops = 0
    let docUnavailable = false
    const onMsg = (m: Msg) => {
        if (m?.documentId !== docId) return
        if (m.type === 'doc-unavailable') docUnavailable = true
        else if (m.type === 'sync' || m.type === 'request') { syncMsgs++; docUnavailable = false }
    }
    const onPeer = () => { docUnavailable = false }
    const onDrop = () => { drops++ }
    ns.on('message', onMsg)
    ns.on('peer', onPeer)
    ns.on('peer-disconnected', onDrop)
    try {
        const handle = repo.findWithProgress<Store>(docId).handle
        const summary = () => `${syncMsgs} sync msg(s) for the doc, ${drops} WS drop(s), handle ${handle.state}`
        let unavailableSince: number | null = null
        while (Date.now() < deadline) {
            if (handle.isReady()) return { kind: 'ready', handle }
            if (repo.peers.length > 0 && docUnavailable && handle.state === 'unavailable') {
                unavailableSince ??= Date.now()
                if (Date.now() - unavailableSince >= 1_500) {
                    return { kind: 'doc-unavailable', detail: `engine answered doc-unavailable; ${summary()}` }
                }
            } else {
                unavailableSince = null
            }
            await sleep(100)
        }
        if (handle.isReady()) return { kind: 'ready', handle }
        if (repo.peers.length === 0) return { kind: 'ws-closed', detail: summary() }
        return { kind: 'stall', detail: docUnavailable ? `engine answered doc-unavailable; ${summary()}` : summary() }
    } finally {
        ns.off('message', onMsg)
        ns.off('peer', onPeer)
        ns.off('peer-disconnected', onDrop)
    }
}

export const assertPrivateDurationRoots = (disksRoot: string, watchDir: string): void => {
    const d = disksRoot.replace(/\/+$/, '') || disksRoot
    const w = watchDir.replace(/\/+$/, '') || watchDir
    if (d === '/disks' || FORBIDDEN_DISKS_ROOTS.includes(disksRoot) || d.startsWith('/disks/')) {
        throw new Error(
            `RealFleetOps: refuse IDEA_DISKS_ROOT='${disksRoot}' (never /disks; use ${DEFAULT_DURATION_DISKS_ROOT})`,
        )
    }
    if (w === '/dev/engine' || FORBIDDEN_WATCH_DIRS.includes(watchDir) || w.startsWith('/dev/engine/')) {
        throw new Error(
            `RealFleetOps: refuse IDEA_WATCH_DIR='${watchDir}' (never /dev/engine; use ${DEFAULT_DURATION_WATCH_DIR})`,
        )
    }
    if (d.includes('sdb') || w.includes('sdb')) {
        throw new Error(`RealFleetOps: refuse roots that mention sdb (never idea03 hw stick)`)
    }
}

/** Map Kid diskId → pack folder name under fixtureSourceRoot. */
export const resolveDurationFixturePack = (diskId: string): string => {
    const pack = DISK_ID_TO_PACK[diskId]
    if (!pack) {
        throw new Error(
            `RealFleetOps: unknown duration fixture diskId '${diskId}' ` +
            `(expected ${Object.keys(DISK_ID_TO_PACK).join(' | ')})`,
        )
    }
    return pack
}

/** Prefer A r21: empty / empty-002 packs (always fresh-copy, never redirected). */
export const isEmptyFixtureDisk = (diskId: string): boolean => {
    const pack = DISK_ID_TO_PACK[diskId]
    return pack === 'empty' || pack === 'empty-002'
}

export type SshDockCopyRemoteArgs = {
    diskId: string
    pack: string
    src: string
    dest: string
    sentinel: string
    disksRoot: string
    watchDir: string
    /** When true, keep instances/ (Path A --start-instances). */
    startInstances: boolean
}

/**
 * Build the remote bash for Kid dockFixture copy.
 * Empty packs (duration-empty-001 → pack empty/; duration-empty-002 → pack empty-002/):
 * never reuse Path A tree — always rm -rf + cp -a so prior install_app/make_backup
 * apps/ cannot leave isAppDisk / hide EmptyDiskPanel. Kolibri/Nextcloud Grade5A: reuse
 * matching META tree (docker-owned instances → no wipe) — dockFixture has already checked its
 * instance data (hasHealthyFixtureTree, idea#168 r34@70) before this script runs.
 */
export const buildSshDockCopyRemote = (args: SshDockCopyRemoteArgs): string => {
    const { diskId, pack, src, dest, sentinel, disksRoot, watchDir, startInstances } = args
    const stripInstances = startInstances ? ':' : `rm -rf '${dest}/instances'`
    const parts: string[] = [
        'set -euo pipefail',
        `mkdir -p '${disksRoot}' '${watchDir}'`,
    ]
    if (pack === 'empty' || pack === 'empty-002') {
        // Empty has no docker-owned instance files — wipe is safe. Refuse only when
        // dest META belongs to a different diskId (never steal kolibri/nextcloud slot).
        parts.push(
            `if test -f '${dest}/META.yaml' && ! grep -Fq 'diskId: ${diskId}' '${dest}/META.yaml'; then ` +
            `echo "RealFleetOps: refuse overwrite occupied ${dest} (no matching META for ${diskId})" >&2; exit 4; fi`,
            `echo "RealFleetOps: empty pack always fresh-copy into ${dest} (no Path A reuse)"`,
        )
    } else {
        // Reuse Atlas/Kid Path A tree when present — never rm -rf over live instance data
        // (docker-owned files → Permission denied). Parent: infra_dock may no-op/ok.
        // Reuse only when META.yaml diskId matches (never steal nextcloud slot for kolibri).
        // Atlas: chokidar needs unlink+create after eject, not mtime-only touch.
        parts.push(
            `if test -f '${dest}/META.yaml' && grep -Fq 'diskId: ${diskId}' '${dest}/META.yaml'; then ` +
            `echo "RealFleetOps: reuse existing Path A tree at ${dest}"; ` +
            `rm -f '${sentinel}'; sleep 5; touch '${sentinel}'; exit 0; fi`,
            `if test -d '${dest}'; then ` +
            `echo "RealFleetOps: refuse overwrite occupied ${dest} (no matching META for ${diskId})" >&2; exit 4; fi`,
        )
    }
    const isEmptyPack = pack === 'empty' || pack === 'empty-002'
    parts.push(
        `test -d '${src}' || { echo "missing fixture source ${src}" >&2; exit 2; }`,
    )
    if (isEmptyPack) {
        // Prefer A r21: Atlas Path A may back the empty slot with a real ext4 mount
        // (createFilesDisk on Eng 8d98718 requires `findmnt -no FSTYPE <root>` = ext4;
        // a plain dir under duration-disks reads as 'unknown'). Never rm -rf a
        // mount point (EBUSY under set -e + would drop the ext4 backing) — clear
        // its contents instead (keep lost+found).
        parts.push(
            `if mountpoint -q '${dest}' 2>/dev/null; then ` +
            `find '${dest}' -mindepth 1 -maxdepth 1 ! -name 'lost+found' -exec rm -rf {} +; ` +
            `echo "RealFleetOps: ${dest} is a mount point ($(findmnt -no FSTYPE '${dest}' || true)); cleared contents, kept mount"; ` +
            `else rm -rf '${dest}'; mkdir -p '${dest}'; fi`,
        )
    } else {
        parts.push(`rm -rf '${dest}'`, `mkdir -p '${dest}'`)
    }
    parts.push(
        `cp -a '${src}/.' '${dest}/'`,
        stripInstances,
    )
    if (isEmptyPack) {
        // createFilesDisk allows only META.yaml + lost+found on empty roots.
        // Kid pack ships README.md (humans); prior install leaves apps/instances/services.
        // Strip so Empty → Files does not false-refuse / Pixel soft-pass on dirty error.
        parts.push(
            `find '${dest}' -mindepth 1 -maxdepth 1 ! -name 'META.yaml' ! -name 'lost+found' -exec rm -rf {} +`,
            `echo "RealFleetOps: stripped non-META entries from empty pack at ${dest} (createFilesDisk-clean)"`,
        )
    }
    parts.push(
        `test -f '${dest}/META.yaml' || { echo "META.yaml missing after copy into ${dest}" >&2; exit 3; }`,
        // Atlas: chokidar needs unlink+create after eject, not mtime-only touch.
        `rm -f '${sentinel}'; sleep 5; touch '${sentinel}'`,
    )
    return parts.join('; ')
}

// ── idea#168 r34@70: instance-data precondition + real-tree disk move ──────────

export type SudoMode = 'auto' | 'never'

/** Fixture slots scanned on a host: idea-test-1..8 (Prefer A r26: Path A uses idea-test-5). */
export const FIXTURE_SLOT_COUNT = 8
export const fixtureSlotNames = (): string[] =>
    Array.from({ length: FIXTURE_SLOT_COUNT }, (_, i) => `idea-test-${i + 1}`)

/**
 * The Kolibri class the walk coaches — Kid CONTENT.live.json `class.name`, a classroom under
 * facility "Duration Tests Facility" (`open_kolibri_as_teacher` lands on /en/coach/#/classes and
 * the Console guard looks for "Grade 5A"). Morango ids are re-provision mutable; the name is not.
 */
export const KOLIBRI_GRADE5A_CLASS_NAME = 'Grade 5A'

/** Instance data an app pack needs before its tree may be docked with instances started. */
export type AppPackInstanceData = {
    pack: 'kolibri' | 'nextcloud'
    instanceId: string
    /** Primary instance-data file, relative to the slot root (hashed on move as evidence). */
    keyFile: string
    /** Human description of what lives there (error messages). */
    describe: string
    /**
     * idea#168 r35@62: slot-relative dirs whose CONTENTS are throwaway and are NOT carried by
     * moveDisk (left out of the slot tar and the digest on both sides);
     * each is recreated EMPTY on the target (source mode/owner when the source dir can be
     * stat'ed and chown'ed, else 1777). Kolibri: Django file sessions, root 0600 per login —
     * unreadable as pi without sudo -n; the walk logs in again after the move.
     */
    moveSkipDirs?: readonly string[]
}

export const APP_PACK_INSTANCE_DATA: Readonly<Record<string, AppPackInstanceData>> = {
    'duration-kolibri-grade5a-001': {
        pack: 'kolibri',
        instanceId: 'kolibri-grade5a-001',
        // compose: ./data/kolibri:/root/.kolibri (KOLIBRI_HOME) → db.sqlite3 is the Kolibri DB.
        keyFile: 'instances/kolibri-grade5a-001/data/kolibri/db.sqlite3',
        describe: `Kolibri home db.sqlite3 with facility + classroom '${KOLIBRI_GRADE5A_CLASS_NAME}'`,
        // KOLIBRI_HOME/sessions: Django SESSION_ENGINE=file, one root 0600 file per login. Must
        // exist (else ImproperlyConfigured) but its contents are disposable.
        moveSkipDirs: ['instances/kolibri-grade5a-001/data/kolibri/sessions'],
    },
    'duration-nextcloud-grade5a-001': {
        pack: 'nextcloud',
        instanceId: 'nextcloud-grade5a-001',
        // compose: ./data/nextcloud:/var/www/html, ./data/db:/var/lib/mysql
        keyFile: 'instances/nextcloud-grade5a-001/data/nextcloud/config/config.php',
        describe: "Nextcloud data/nextcloud (config.php 'installed' => true) + MariaDB datadir data/db",
    },
}

export const appPackInstanceData = (diskId: string): AppPackInstanceData | null =>
    APP_PACK_INSTANCE_DATA[diskId] ?? null

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`

/** Remote preamble: S='sudo -n' when allowed and granted, else '' (run as the ssh user). */
export const sudoPreamble = (mode: SudoMode): string =>
    mode === 'never'
        ? `S=''`
        : `if sudo -n true 2>/dev/null; then S='sudo -n'; else S=''; fi`

/** Read-only Kolibri DB probe (python3 sqlite3; no sqlite3 CLI on the Pis). No single quotes inside. */
const KOLIBRI_DB_PROBE_PY = [
    'import os, sqlite3, sys, urllib.parse',
    'p, cls = sys.argv[1], sys.argv[2]',
    'q = "SELECT f.name FROM kolibriauth_collection c JOIN kolibriauth_collection f ON c.parent_id = f.id WHERE c.kind = ? AND c.name = ? AND f.kind = ?"',
    'rows = None',
    'err = ""',
    'for opt in ("mode=ro", "immutable=1"):',
    '    try:',
    '        con = sqlite3.connect("file:" + urllib.parse.quote(p) + "?" + opt, uri=True)',
    '        rows = con.execute(q, ("classroom", cls, "facility")).fetchall()',
    '        con.close()',
    '        break',
    '    except Exception as e:',
    '        err = str(e)',
    'if rows is None:',
    '    print("INSTANCE_DATA_MISSING db.sqlite3 unreadable or not a Kolibri DB (" + err + ")")',
    'elif not rows:',
    '    print("INSTANCE_DATA_MISSING db.sqlite3 has no classroom " + repr(cls) + " under a facility (unprovisioned Kolibri: /en/setup)")',
    'else:',
    '    print("INSTANCE_DATA_OK facility=" + str(rows[0][0]) + " class=" + cls + " bytes=" + str(os.path.getsize(p)))',
].join('\n')

/**
 * Remote bash that checks an app pack's instance data under `root` (a slot or a seed pack).
 * Always exits 0 and prints exactly one line: `INSTANCE_DATA_OK <detail>` or
 * `INSTANCE_DATA_MISSING <what>`. Follows symlinks, but since idea#168 r35@62 a slot with a
 * symlink that resolves outside it is refused before this check runs (buildSlotLinkScanRemote).
 */
export const buildInstanceDataCheckRemote = (args: {
    root: string
    spec: AppPackInstanceData
    sudoMode: SudoMode
    classroomName?: string
}): string => {
    const { root, spec, sudoMode } = args
    const key = `${root}/${spec.keyFile}`
    const parts = [sudoPreamble(sudoMode)]
    if (spec.pack === 'kolibri') {
        const cls = args.classroomName ?? KOLIBRI_GRADE5A_CLASS_NAME
        parts.push(
            `if ! $S test -f ${shq(key)}; then echo ${shq(`INSTANCE_DATA_MISSING ${spec.keyFile} not found (Kolibri home of ${spec.instanceId}: compose ./data/kolibri → /root/.kolibri)`)}; ` +
            `elif ! command -v python3 >/dev/null 2>&1; then echo ${shq(`INSTANCE_DATA_MISSING python3 not available on host to read ${spec.keyFile}`)}; ` +
            `else $S python3 -c ${shq(KOLIBRI_DB_PROBE_PY)} ${shq(key)} ${shq(cls)} 2>&1 | tail -n 1; fi`,
        )
    } else {
        // Nextcloud data is www-data / mysql owned (config.php 0640). Without sudo -n (idea01 at
        // r30) the installed flag may be unreadable: then the data dirs must still exist and the
        // OK verdict says the flag was not verified. A seed copy or META-only tree has no data/.
        const d = `${root}/instances/${spec.instanceId}/data`
        const rel = `instances/${spec.instanceId}/data`
        const nonEmpty = (dir: string) => `{ ! $S test -r ${shq(dir)} || [ -n "$($S ls -A ${shq(dir)} 2>/dev/null)" ]; }`
        parts.push(
            `if ! $S test -d ${shq(`${d}/nextcloud`)} || ! ${nonEmpty(`${d}/nextcloud`)}; then echo ${shq(`INSTANCE_DATA_MISSING ${rel}/nextcloud (Nextcloud /var/www/html of ${spec.instanceId}) not found or empty`)}; ` +
            `elif ! $S test -d ${shq(`${d}/db`)} || ! ${nonEmpty(`${d}/db`)}; then echo ${shq(`INSTANCE_DATA_MISSING ${rel}/db (MariaDB datadir) not found or empty`)}; ` +
            `elif $S test -r ${shq(key)}; then ` +
            `if $S grep -Eq "'installed'[[:space:]]*=>[[:space:]]*true" ${shq(key)}; then echo ${shq('INSTANCE_DATA_OK nextcloud installed (config.php installed=true, data/db present)')}; ` +
            `else echo ${shq(`INSTANCE_DATA_MISSING ${spec.keyFile} has no 'installed' => true (Nextcloud never installed)`)}; fi; ` +
            `elif $S test -x ${shq(`${d}/nextcloud/config`)} && ! $S test -e ${shq(key)}; then echo ${shq(`INSTANCE_DATA_MISSING ${spec.keyFile} not found`)}; ` +
            `else echo ${shq('INSTANCE_DATA_OK nextcloud data dirs present; installed flag NOT verified (config.php not readable as the ssh user, no sudo -n)')}; fi`,
        )
    }
    return parts.join('; ')
}

export const parseInstanceDataCheck = (out: string): { ok: boolean; detail: string } => {
    const line = String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean)
        .find(l => /^INSTANCE_DATA_(OK|MISSING)\b/.test(l))
    if (!line) return { ok: false, detail: `instance-data check printed no verdict (${String(out ?? '').trim().slice(0, 200) || 'empty output'})` }
    const ok = line.startsWith('INSTANCE_DATA_OK')
    return { ok, detail: line.replace(/^INSTANCE_DATA_(OK|MISSING)\s*/, '') }
}

export type FixtureSlotState = 'MATCH' | 'OTHER' | 'NOMETA' | 'FREE'

/** One read-only pass over idea-test-1..8: META diskId match / other pack / no META / free. */
export const buildFixtureSlotScanRemote = (disksRoot: string, diskId: string): string =>
    `for d in ${fixtureSlotNames().join(' ')}; do p=${shq(disksRoot)}/$d; ` +
    `if test -f "$p/META.yaml"; then if grep -Fq ${shq(`diskId: ${diskId}`)} "$p/META.yaml"; then s=MATCH; else s=OTHER; fi; ` +
    `elif test -e "$p" || test -L "$p"; then s=NOMETA; else s=FREE; fi; ` +
    `m=; if mountpoint -q "$p" 2>/dev/null; then m=' mount'; fi; echo "SLOT $d $s$m"; done`

export const parseFixtureSlotScan = (out: string): { device: string; state: FixtureSlotState; mount: boolean }[] =>
    String(out ?? '').split('\n').map(l => l.trim())
        .map(l => /^SLOT (idea-test-[0-9]+) (MATCH|OTHER|NOMETA|FREE)( mount)?$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map(m => ({ device: m[1]!, state: m[2] as FixtureSlotState, mount: !!m[3] }))

/** `\( -path A -o -path B \) -prune -o ` (or '') for find. */
const findPruneExpr = (paths: readonly string[]): string =>
    paths.length ? `\\( ${paths.map(p => `-path ${shq(p)}`).join(' -o ')} \\) -prune -o ` : ''

/**
 * idea#168 r35@62 — read-only scan of a fixture slot for symlinks that resolve OUTSIDE the slot
 * (r35: Path A idea01 idea-test-1/instances/kolibri-grade5a-001/data/kolibri →
 * /home/pi/idea166-kolibri-live/data/kolibri). A real IDEA disk carries its data inside the disk:
 * no Engine product path (install, copy_app, move_app, app pack layout) creates a link out of
 * the disk, and the Engine's copy_app (rsync -a) copies such a link verbatim, so a copy would
 * share the original's live data (r35@62: the @43 copy wrote the shared Kolibri DB while @62
 * tarred it). Prints `LINK_OUT <rel>\t<raw link text>\t<resolved>` per offending link, then
 * `LINKS_END`; `LINKS_ERR <why>` when the slot cannot be scanned. Unreadable subdirs (root 0700)
 * are skipped by find (stderr dropped); skip dirs are pruned. readlink -m: a dangling link is
 * judged by where it points (inside → left to the move plan's dangling check; outside → refused).
 */
export const buildSlotLinkScanRemote = (slot: string, sudoMode: SudoMode, skipDirs: readonly string[] = []): string => [
    sudoPreamble(sudoMode),
    `s=${shq(slot)}`,
    `if ! test -d "$s"; then echo "LINKS_ERR slot $s missing"; exit 0; fi`,
    `sc=$(readlink -f -- "$s")`,
    `cd "$s" || { echo "LINKS_ERR cannot cd $s"; exit 0; }`,
    `$S find . ${findPruneExpr(skipDirs.map(r => `./${r}`))}-type l -print0 2>/dev/null | while IFS= read -r -d '' l; do rel=\${l#./}; ` +
    `raw=$($S readlink -- "$l" 2>/dev/null || true); r=$($S readlink -m -- "$l" 2>/dev/null || true); ` +
    `case "$r" in "$sc"|"$sc"/*) ;; *) printf 'LINK_OUT %s\\t%s\\t%s\\n' "$rel" "$raw" "\${r:-unresolvable}";; esac; done`,
    `echo LINKS_END`,
].join('; ')

export type SlotLinkScan = { error: string | null; outside: { rel: string; raw: string; target: string }[] }

export const parseSlotLinkScan = (out: string): SlotLinkScan => {
    const scan: SlotLinkScan = { error: null, outside: [] }
    let ended = false
    for (const raw of String(out ?? '').split('\n')) {
        const l = raw.replace(/\r$/, '')
        if (l.startsWith('LINKS_ERR ')) scan.error = l.slice(10).trim()
        else if (l.startsWith('LINK_OUT ')) {
            const [rel, link, target] = l.slice(9).split('\t')
            if (rel) scan.outside.push({ rel, raw: link ?? '', target: target ?? 'unresolvable' })
        } else if (l === 'LINKS_END') ended = true
    }
    if (!scan.error && !ended) scan.error = `link scan incomplete (${String(out ?? '').trim().slice(-200) || 'no output'})`
    return scan
}

/**
 * idea#168 r35@62 — read-only: every running container on the host whose bind/volume mount
 * source lies inside one of `roots` (taken literally AND after readlink -f, on both sides, so a
 * mount through a symlink that lands in the slot is caught, e.g. a zombie copy whose
 * data/kolibri links into the source's data). Prints
 * `MOUNT_HIT <container>\t<mount source>\t<resolved>` per hit, then `MOUNT_SCAN_END`;
 * `MOUNT_SCAN_ERR <why>` when docker cannot be asked (then nobody can vouch the data is quiet).
 * Only `docker ps -q` and `docker inspect` — never stops, kills or removes anything.
 */
export const buildMountScanRemote = (roots: readonly string[]): string => [
    `roots=()`,
    ...roots.map(r => `roots+=(${shq(r)}); x=$(readlink -f -- ${shq(r)} 2>/dev/null || true); if [ -n "$x" ]; then roots+=("$x"); fi`),
    `if ! ids=$(docker ps -q 2>&1); then echo "MOUNT_SCAN_ERR docker ps failed: $(printf %s "$ids" | tr '\\n' ' ' | cut -c1-200)"; exit 0; fi`,
    `if [ -n "$ids" ]; then printf '%s\\n' $ids | xargs -r docker inspect --format '{{$n := .Name}}{{range .Mounts}}{{$n}}{{"\\t"}}{{.Source}}{{println}}{{end}}' 2>/dev/null | ` +
    `while IFS=$'\\t' read -r n src; do if [ -z "$src" ]; then continue; fi; r=$(readlink -f -- "$src" 2>/dev/null || true); if [ -z "$r" ]; then r="$src"; fi; ` +
    `for root in "\${roots[@]}"; do hit=; case "$src" in "$root"|"$root"/*) hit=1;; esac; case "$r" in "$root"|"$root"/*) hit=1;; esac; ` +
    `if [ -n "$hit" ]; then printf 'MOUNT_HIT %s\\t%s\\t%s\\n' "\${n#/}" "$src" "$r"; break; fi; done; done; fi`,
    `echo MOUNT_SCAN_END`,
].join('; ')

export type MountHit = { container: string; source: string; resolved: string }

export const parseMountScan = (out: string): { error: string | null; hits: MountHit[] } => {
    const res: { error: string | null; hits: MountHit[] } = { error: null, hits: [] }
    let ended = false
    for (const raw of String(out ?? '').split('\n')) {
        const l = raw.replace(/\r$/, '')
        if (l.startsWith('MOUNT_SCAN_ERR')) res.error = l.slice(14).trim() || 'docker unavailable'
        else if (l.startsWith('MOUNT_HIT ')) {
            const [container, source, resolved] = l.slice(10).split('\t')
            if (container && source) {
                if (!res.hits.some(h => h.container === container && h.source === source)) {
                    res.hits.push({ container, source, resolved: resolved || source })
                }
            }
        } else if (l === 'MOUNT_SCAN_END') ended = true
    }
    if (!res.error && !ended) res.error = `mount scan incomplete (${String(out ?? '').trim().slice(-200) || 'no output'})`
    return res
}

/** A container belongs to one of the disk's own instances when its compose name is `<instanceId>-…`. */
export const isOwnInstanceContainer = (container: string, instanceIds: readonly string[]): boolean =>
    instanceIds.some(id => container.startsWith(`${id}-`))

export const describeMountHits = (hits: readonly MountHit[]): string =>
    hits.map(h => `${h.container} mounts ${h.source}${h.resolved !== h.source ? ` (→ ${h.resolved})` : ''}`).join('; ')

/**
 * idea#168 r35@62 — target: remove the staging dir of a failed move and SAY whether it is gone
 * (`STAGING_GONE` / `STAGING_LEFT <ls>`), instead of assuming the rm worked.
 */
export const buildStagingCleanupRemote = (staging: string, sudoMode: SudoMode): string =>
    `${sudoPreamble(sudoMode)}; $S rm -rf ${shq(staging)} 2>/dev/null; ` +
    `if test -e ${shq(staging)} || test -L ${shq(staging)}; then echo "STAGING_LEFT $($S ls -ld ${shq(staging)} 2>&1 | head -c 200)"; else echo STAGING_GONE; fi`

/**
 * Source-side move plan (read-only): mount point?, instance ids, dangling links, and every
 * symlink in the tree that resolves OUTSIDE the slot. idea#168 r35@62: such links are REFUSED
 * (never materialized — b40b8a0's materialization is gone); hasHealthyFixtureTree refuses them
 * first, the plan re-checks right before the eject.
 */
export const buildMovePlanRemote = (slot: string, sudoMode: SudoMode, skipDirs: readonly string[] = []): string => [
    sudoPreamble(sudoMode),
    `s=${shq(slot)}`,
    `if ! test -d "$s"; then echo "PLAN_ERR source slot $s missing"; exit 0; fi`,
    `if mountpoint -q "$s" 2>/dev/null; then echo "PLAN_MOUNT $(findmnt -no FSTYPE "$s" 2>/dev/null || true)"; fi`,
    `sc=$(readlink -f -- "$s")`,
    `cd "$s" || { echo "PLAN_ERR cannot cd $s"; exit 0; }`,
    `$S find . ${findPruneExpr(skipDirs.map(r => `./${r}`))}-type l -print0 | while IFS= read -r -d '' l; do rel=\${l#./}; r=$($S readlink -f -- "$l" 2>/dev/null || true); ` +
    `if [ -z "$r" ] || ! $S test -e "$r"; then echo "PLAN_DANGLING $rel"; continue; fi; ` +
    `case "$r" in "$sc"|"$sc"/*) ;; *) printf 'PLAN_EXTLINK %s\\t%s\\n' "$rel" "$r";; esac; done`,
    `for i in instances/*/; do if [ -d "$i" ]; then echo "PLAN_INST $(basename "$i")"; fi; done`,
    // Skipped dirs: mode/owner of the source dir (stat -L follows data/kolibri → live; needs
    // only search on the parent, so works for a root 0700 dir) or '-' when absent/unreadable.
    ...skipDirs.map(r =>
        `if st=$($S stat -L -c '%a %u %g' -- ${shq(r)} 2>/dev/null); then printf 'PLAN_SKIPDIR %s\\t%s\\n' ${shq(r)} "$st"; ` +
        `else printf 'PLAN_SKIPDIR %s\\t-\\n' ${shq(r)}; fi`),
    `echo PLAN_END`,
].join('; ')

export type MovePlan = {
    error: string | null
    mountFsType: string | null
    dangling: string[]
    extLinks: { rel: string; target: string }[]
    instances: string[]
    /** idea#168 r35@62: source mode/owner of each pack skip dir that could be stat'ed (absent ones omitted). */
    skipDirs: { rel: string; mode: string; uid: number; gid: number }[]
}

export const parseMovePlan = (out: string): MovePlan => {
    const plan: MovePlan = { error: null, mountFsType: null, dangling: [], extLinks: [], instances: [], skipDirs: [] }
    let ended = false
    for (const raw of String(out ?? '').split('\n')) {
        const l = raw.replace(/\r$/, '')
        if (l.startsWith('PLAN_ERR ')) plan.error = l.slice(9).trim()
        else if (l.startsWith('PLAN_MOUNT')) plan.mountFsType = l.slice(10).trim() || 'unknown'
        else if (l.startsWith('PLAN_DANGLING ')) plan.dangling.push(l.slice(14))
        else if (l.startsWith('PLAN_EXTLINK ')) {
            const [rel, target] = l.slice(13).split('\t')
            if (rel && target) plan.extLinks.push({ rel, target })
        } else if (l.startsWith('PLAN_SKIPDIR ')) {
            const [rel, st] = l.slice(13).split('\t')
            const m = /^([0-7]{3,4}) (\d+) (\d+)$/.exec(String(st ?? '').trim())
            if (rel && m) plan.skipDirs.push({ rel, mode: m[1]!, uid: Number(m[2]), gid: Number(m[3]) })
        } else if (l.startsWith('PLAN_INST ')) plan.instances.push(l.slice(10).trim())
        else if (l === 'PLAN_END') ended = true
    }
    if (!plan.error && !ended) plan.error = `move plan incomplete (${String(out ?? '').trim().slice(-200) || 'no output'})`
    return plan
}

/** Paths we splice into tar/mv commands: plain relative/absolute paths only (no globs, no ..). */
const SAFE_REL = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/
export const isSafeRelPath = (rel: string): boolean =>
    SAFE_REL.test(rel) && !rel.split('/').some(seg => seg === '..' || seg === '.')
export const isSafeAbsPath = (p: string): boolean => p.startsWith('/') && isSafeRelPath(p.slice(1))

/**
 * idea#168 r35@62: unanchored tar pattern for a skip dir — its last two path segments
 * ('instances/…/data/kolibri/sessions' → 'kolibri/sessions'). GNU tar --exclude is unanchored
 * by default (matches after any '/'), so it hits ./instances/…/data/kolibri/sessions in the
 * slot stream. Excluding the dir entry means tar never opens it (works for a root 0700 dir with
 * root 0600 files as pi).
 */
export const skipDirTarPattern = (rel: string): string => rel.split('/').slice(-2).join('/')

/** Source: stream the slot tree (tar, owners/modes kept) minus `excludeRels` and the skip dirs. */
export const buildTreeSendRemote = (slot: string, excludeRels: string[], sudoMode: SudoMode, skipPatterns: readonly string[] = []): string =>
    `${sudoPreamble(sudoMode)}; cd ${shq(slot)} && $S tar --numeric-owner -cpf - ` +
    excludeRels.map(r => `--exclude=${shq(`./${r}`)} `).join('') +
    skipPatterns.map(p => `--exclude=${shq(p)} `).join('') + '.'

/** Target: unpack the stream into a fresh staging dir (never a live slot). */
export const buildTreeReceiveRemote = (staging: string, sudoMode: SudoMode): string =>
    `set -euo pipefail; ${sudoPreamble(sudoMode)}; $S rm -rf ${shq(staging)}; mkdir -p ${shq(staging)}; ` +
    `$S tar --numeric-owner -xpf - -C ${shq(staging)}`

/**
 * Content digest of a tree (find -L: in-slot links are followed the same way on both sides;
 * links out of the slot are refused before a move): file count, sha256 over the sorted per-file
 * sha256 list, and the sha256 of the pack's key instance file (db.sqlite3).
 */
export const buildTreeDigestRemote = (root: string, keyFile: string | null, sudoMode: SudoMode, skipPatterns: readonly string[] = []): string => {
    // idea#168 r35@62: skip dirs (Kolibri sessions) pruned on BOTH sides — never descended.
    const prune = findPruneExpr(skipPatterns.map(p => `*/${p}`))
    return `set -uo pipefail; ${sudoPreamble(sudoMode)}; cd ${shq(root)} || { echo ${shq(`DIGEST_ERR cannot cd ${root}`)}; exit 0; }; ` +
    `n=$($S find -L . ${prune}-type f -print0 | tr -cd '\\0' | wc -c); ` +
    `h=$($S find -L . ${prune}-type f -print0 | LC_ALL=C sort -z | $S xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1) || { echo DIGEST_ERR hashing failed; exit 0; }; ` +
    (keyFile
        ? `k=$($S sha256sum -- ${shq(keyFile)} 2>/dev/null | cut -d' ' -f1); `
        : `k=; `) +
    `echo "DIGEST files=$n tree=$h key=\${k:-none}"`
}

/**
 * idea#168 r35@62 — target staging: recreate each skip dir EMPTY where its parent landed
 * (Django's file session backend raises ImproperlyConfigured if KOLIBRI_HOME/sessions is
 * missing). Source mode + owner when known and chown succeeds; otherwise 1777 so the Kolibri
 * container (root, or any uid) can create its session files. Parent missing (dock-only, no
 * instance data) → skipped. Prints one `SKIPDIR <rel> <detail>` line per dir.
 */
export const buildRecreateSkipDirsRemote = (
    staging: string,
    dirs: readonly { rel: string; src: { mode: string; uid: number; gid: number } | null }[],
    sudoMode: SudoMode,
): string => [
    `set -euo pipefail`,
    sudoPreamble(sudoMode),
    ...dirs.map(({ rel, src }) => {
        const d = `${staging}/${rel}`
        const parent = d.slice(0, d.lastIndexOf('/'))
        const ok = src !== null && /^[0-7]{3,4}$/.test(src.mode) && Number.isInteger(src.uid) && Number.isInteger(src.gid)
        const set = ok
            ? `$S chmod ${src!.mode} ${shq(d)}; if $S chown ${src!.uid}:${src!.gid} ${shq(d)} 2>/dev/null; then ` +
              `echo ${shq(`SKIPDIR ${rel} recreated empty mode=${src!.mode} owner=${src!.uid}:${src!.gid} (as source)`)}; ` +
              `else $S chmod 1777 ${shq(d)}; echo ${shq(`SKIPDIR ${rel} recreated empty mode=1777 (could not chown to source owner ${src!.uid}:${src!.gid})`)}; fi`
            : `$S chmod 1777 ${shq(d)}; echo ${shq(`SKIPDIR ${rel} recreated empty mode=1777 (source dir absent or not stat-able)`)}`
        return `if $S test -d ${shq(parent)}; then $S rm -rf ${shq(d)}; $S mkdir ${shq(d)}; ${set}; ` +
            `else echo ${shq(`SKIPDIR ${rel} not recreated (parent not in the moved tree)`)}; fi`
    }),
].join('; ')

export const parseTreeDigest = (out: string): { files: number; tree: string; key: string } | { error: string } => {
    const text = String(out ?? '')
    const m = /DIGEST files=(\d+) tree=([0-9a-f]{64}) key=([0-9a-f]{64}|none)/.exec(text)
    if (!m) return { error: (/DIGEST_ERR.*/.exec(text)?.[0] ?? text.trim().slice(-200)) || 'no digest output' }
    return { files: Number(m[1]), tree: m[2]!, key: m[3]! }
}

/** Target: atomically turn the verified staging dir into the slot (refuse if the slot appeared). */
export const buildCommitMovedTreeRemote = (staging: string, dest: string, sudoMode: SudoMode): string =>
    `set -euo pipefail; ${sudoPreamble(sudoMode)}; ` +
    `if test -e ${shq(dest)} || test -L ${shq(dest)}; then echo ${shq(`RealFleetOps: refuse commit — ${dest} appeared during the move`)} >&2; exit 4; fi; ` +
    `$S mv ${shq(staging)} ${shq(dest)}`

/**
 * Source: the disk has left this host. Rename the slot out of the idea-test-N namespace into
 * <disksRoot>/.moved-away/ (a rename: works as the ssh user even over docker-owned files; the
 * Engine and the slot scan never look there).
 */
export const buildQuarantineSourceRemote = (slot: string, quarantine: string): string => {
    const qroot = quarantine.slice(0, quarantine.lastIndexOf('/'))
    return `set -euo pipefail; mkdir -p ${shq(qroot)}; ` +
        `if mountpoint -q ${shq(slot)} 2>/dev/null; then echo ${shq(`RealFleetOps: refuse quarantine of mount point ${slot}`)} >&2; exit 4; fi; ` +
        `mv ${shq(slot)} ${shq(quarantine)}; echo ${shq(`QUARANTINED ${quarantine}`)}`
}

/** Target: fire the testMode sentinel (chokidar needs unlink + create, not an mtime touch). */
export const buildFireSentinelRemote = (watchDir: string, sentinel: string): string =>
    `mkdir -p ${shq(watchDir)}; rm -f ${shq(sentinel)}; sleep 5; touch ${shq(sentinel)}`

export const parseHostsFlag = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
        const eq = part.indexOf('=')
        if (eq <= 0) {
            throw new Error(`Invalid --hosts entry '${part}' (expected name=host)`)
        }
        const name = part.slice(0, eq).trim()
        const host = part.slice(eq + 1).trim()
        if (!name || !host) throw new Error(`Invalid --hosts entry '${part}'`)
        out[name] = host
    }
    if (Object.keys(out).length === 0) {
        throw new Error('--hosts / DURATION_FLEET_HOSTS must list at least one name=host')
    }
    return out
}

const expandTemplate = (tpl: string, pis: string[]): string =>
    tpl.replaceAll('{pis}', pis.join(' '))

const hostnameMatches = (hostname: string | undefined, logicalId: string): boolean => {
    if (!hostname) return false
    const h = hostname.toLowerCase().replace(/\.local$/, '')
    const want = logicalId.toLowerCase().replace(/\.local$/, '')
    return h === want || h.startsWith(`${want}.`) || hostname.toLowerCase() === logicalId.toLowerCase()
}

const toDocId = (urlOrId: string): DocumentId =>
    urlOrId.trim().replace(/^automerge:/, '') as DocumentId

export class RealFleetOps implements FleetOps {
    private mode: StoreMode
    private readonly pool: string[]
    private readonly exclude: string[]
    private readonly hosts: Record<string, string>
    private readonly sshUser: string
    private readonly enginePort: number
    private readonly commandLogUrls = new Map<string, string>()
    private readonly healthWrapBefore?: string
    private readonly healthWrapAfter?: string
    private readonly storeUrls: Record<string, string>
    private readonly disksRoot: string
    private readonly watchDir: string
    private readonly fixtureSourceRoot: string
    private readonly startInstances: boolean
    private readonly sudoMode: SudoMode
    private readonly pm2ReconnectTimeoutMs: number
    private readonly conns = new Map<string, Conn>()
    /** In-flight connects per logical engine, so concurrent callers share one Repo. */
    private readonly connecting = new Map<string, Promise<Conn>>()
    private readonly wsHandshakeTimeoutMs: number
    private readonly docWaitOpt?: number
    private readonly docWaitByHostOpt: Record<string, number>
    private readonly onOwnStoreStall: (engine: string, docId: string, detail: string) => void
    /** Engines inside rebootEngine / reconnectEngine: a stall there is retried, not fatal. */
    private readonly rebootWindow = new Set<string>()
    /** Repos opened per engine (one per connection; tests assert reuse). */
    private readonly reposOpened = new Map<string, number>()
    /** logical pool id → live engineDB key */
    private readonly liveIds = new Map<string, string>()
    /** live engineDB key → logical pool id */
    private readonly logicalIds = new Map<string, string>()
    /** logicalEngine → diskId → idea-test-N device slot */
    private readonly deviceByEngineDisk = new Map<string, Map<string, string>>()
    /** logicalEngine → set of idea-test-N in use */
    private readonly usedDevices = new Map<string, Set<string>>()

    constructor(opts: RealFleetOptions) {
        this.pool = [...opts.poolEngines]
        this.exclude = [...(opts.excludeEngines ?? [GOLDEN_DEFAULT])]
        if (!this.exclude.includes(GOLDEN_DEFAULT)) this.exclude.push(GOLDEN_DEFAULT)
        this.hosts = { ...opts.hosts }
        this.mode = opts.storeMode ?? 'unique'
        this.sshUser = opts.sshUser ?? DEFAULT_SSH_USER
        this.enginePort = opts.enginePort ?? DEFAULT_ENGINE_PORT
        this.healthWrapBefore = opts.healthWrapBefore
        this.healthWrapAfter = opts.healthWrapAfter
        this.storeUrls = { ...(opts.storeUrls ?? {}) }
        this.disksRoot = (opts.disksRoot
            ?? process.env.IDEA_DISKS_ROOT
            ?? DEFAULT_DURATION_DISKS_ROOT).replace(/\/+$/, '')
        this.watchDir = (opts.watchDir
            ?? process.env.IDEA_WATCH_DIR
            ?? DEFAULT_DURATION_WATCH_DIR).replace(/\/+$/, '')
        this.fixtureSourceRoot = (opts.fixtureSourceRoot
            ?? process.env.DURATION_FIXTURE_SOURCE_ROOT
            ?? DEFAULT_DURATION_FIXTURE_SOURCE_ROOT).replace(/\/+$/, '')
        this.startInstances = opts.startInstances === true
        this.sudoMode = opts.sudoMode ?? 'auto'
        this.pm2ReconnectTimeoutMs = opts.pm2ReconnectTimeoutMs ?? PM2_RECONNECT_TIMEOUT_MS
        this.wsHandshakeTimeoutMs = opts.wsHandshakeTimeoutMs
            ?? Math.min(15_000, Number(process.env.DURATION_WS_HANDSHAKE_MS ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS) || DEFAULT_WS_HANDSHAKE_TIMEOUT_MS)
        this.docWaitOpt = opts.docWaitMs
        this.docWaitByHostOpt = { ...(opts.docWaitMsByHost ?? {}) }
        this.onOwnStoreStall = opts.onOwnStoreStall
            ?? ((engine, docId, detail) => reportOwnStoreStall(engine, docId, detail))
        assertPrivateDurationRoots(this.disksRoot, this.watchDir)

        for (const id of this.pool) {
            if (this.exclude.includes(id)) {
                throw new Error(`RealFleetOps: pool engine '${id}' is also excluded (golden)`)
            }
            if (!this.hosts[id]) {
                throw new Error(`RealFleetOps: missing host mapping for pool engine '${id}' (--hosts)`)
            }
        }
        if (this.pool.includes(GOLDEN_DEFAULT) || this.pool.some(e => this.exclude.includes(e))) {
            throw new Error(`RealFleetOps: refuse to include golden/excluded engines in pool`)
        }
        if (Object.keys(this.hosts).includes(GOLDEN_DEFAULT) && this.pool.includes(GOLDEN_DEFAULT)) {
            throw new Error(`RealFleetOps: refuse idea02 in pool`)
        }
    }

    listPoolEngines(): string[] {
        return this.pool.filter(e => !this.exclude.includes(e))
    }

    getStoreMode(): StoreMode {
        return this.mode
    }

    async applyStoreMode(mode: StoreMode): Promise<void> {
        if (mode === 'shared') {
            throw new Error(
                'RealFleetOps: applyStoreMode(shared) requires Ops to provision a shared Automerge ' +
                'store + mDNS across pool engines. Pis currently run unique stores with mdns:false ' +
                '(idea01/idea03). Do not silently fake shared across unique stores — ask Atlas/Ops.',
            )
        }
        // unique: no-op when Pis already unique+mdns off
        this.mode = 'unique'
    }

    private hostOf(engineId: string): string {
        const host = this.hosts[engineId]
        if (!host) throw new Error(`RealFleetOps: no host for '${engineId}'`)
        return host
    }

    private assertNotExcluded(engineId: string, what: string): void {
        if (this.exclude.includes(engineId) || engineId === GOLDEN_DEFAULT) {
            throw new Error(`RealFleetOps: ${what} refused for excluded/golden '${engineId}'`)
        }
    }

    protected async ssh(host: string, remoteCmd: string): Promise<string> {
        const result = await $`ssh ${sshOpts} ${`${this.sshUser}@${host}`} ${remoteCmd}`
        return result.stdout
    }

    /**
     * idea#168 r34@70: stream bytes host→host through the walker (`ssh src cmd | ssh dst cmd`,
     * pipefail). Uses only the walker's existing SSH access to each Pi — no Pi→Pi keys needed.
     */
    protected async relayPipe(srcHost: string, srcCmd: string, dstHost: string, dstCmd: string): Promise<string> {
        const relayOpts = [...sshOpts, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8']
        const script = 'ssh -n "${@:5}" "$1" "$2" | ssh "${@:5}" "$3" "$4"'
        const result = await $`bash -o pipefail -c ${script} relay ${`${this.sshUser}@${srcHost}`} ${srcCmd} ${`${this.sshUser}@${dstHost}`} ${dstCmd} ${relayOpts}`
        return result.stdout
    }

    private async fetchStoreDocId(logicalId: string): Promise<DocumentId> {
        if (this.storeUrls[logicalId]) return toDocId(this.storeUrls[logicalId]!)
        const host = this.hostOf(logicalId)
        try {
            const out = await this.ssh(
                host,
                'cat /home/pi/idea/agents/agent-engine-dev/store-identity/store-url.txt',
            )
            const url = out.trim()
            if (url.startsWith('automerge:')) return toDocId(url)
        } catch (e) {
            console.warn(`[RealFleetOps] store-url SSH failed for ${logicalId}: ${e}`)
        }
        throw new Error(
            `RealFleetOps: could not resolve store URL for ${logicalId} (${host}). ` +
            `Pass storeUrls or ensure store-identity/store-url.txt exists on the Pi.`,
        )
    }

    /** Close this engine's connection (adapter + socket) for good; the next connect opens a fresh one. */
    private async disconnect(logicalId: string, reason = 'closed by walker'): Promise<void> {
        const c = this.conns.get(logicalId)
        if (!c) return
        this.conns.delete(logicalId)
        await closeRepo(c.repo, reason)
    }

    /**
     * Per-host doc wait after the WS handshake (see MIN_DOC_WAIT_MS). Precedence:
     * DURATION_DOC_WAIT_MS_<HOST> > DURATION_DOC_WAIT_MS_BY_HOST > opts.docWaitMsByHost >
     * DEFAULT_DOC_WAIT_MS_BY_HOST > DURATION_DOC_WAIT_MS > opts.docWaitMs > DEFAULT_DOC_WAIT_MS.
     */
    docWaitMsFor(logicalId: string): number {
        const env = (v: string | undefined): number | null => {
            const n = v === undefined || v === '' ? NaN : Number(v)
            return Number.isFinite(n) && n > 0 ? Math.min(MAX_DOC_WAIT_MS, Math.max(MIN_DOC_WAIT_MS, n)) : null
        }
        const perHostEnv = env(process.env[`DURATION_DOC_WAIT_MS_${logicalId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`])
        if (perHostEnv !== null) return perHostEnv
        const map = process.env.DURATION_DOC_WAIT_MS_BY_HOST
        if (map) {
            for (const part of map.split(',')) {
                const [k, v] = part.split('=').map(x => x?.trim())
                if (k === logicalId) {
                    const n = env(v)
                    if (n !== null) return n
                }
            }
        }
        if (this.docWaitByHostOpt[logicalId] !== undefined) return this.docWaitByHostOpt[logicalId]!
        if (this.docWaitOpt === undefined && DEFAULT_DOC_WAIT_MS_BY_HOST[logicalId] !== undefined) {
            return DEFAULT_DOC_WAIT_MS_BY_HOST[logicalId]!
        }
        return env(process.env.DURATION_DOC_WAIT_MS) ?? this.docWaitOpt ?? DEFAULT_DOC_WAIT_MS
    }

    /** Test / report hook: how many Repos (WS connections) were opened to this engine. */
    getConnectionCount(logicalId: string): number {
        return this.reposOpened.get(logicalId) ?? 0
    }

    /** True when this engine's reused connection currently has an open WS handshake. */
    isWsOpen(logicalId: string): boolean {
        const c = this.conns.get(logicalId)
        return !!c && c.repo.peers.length > 0
    }

    private discoverLiveEngineId(store: Store, logicalId: string): string | null {
        // Exact key match first (hostname-as-id fleets)
        if (store.engineDB[logicalId as keyof typeof store.engineDB]) {
            return logicalId
        }
        for (const [id, eng] of Object.entries(store.engineDB)) {
            if (hostnameMatches(eng?.hostname, logicalId) || id === logicalId) {
                return id
            }
        }
        // Single-engine unique store: take the only entry
        const keys = Object.keys(store.engineDB)
        if (keys.length === 1) return keys[0]!
        return null
    }

    private rememberMapping(logicalId: string, liveId: string | null): void {
        if (!liveId) return
        this.liveIds.set(logicalId, liveId)
        this.logicalIds.set(liveId, logicalId)
    }

    /**
     * r32 connection model: ONE Repo / WS per engine for the whole walk, like a Console tab.
     * Reused by every probe, step and read; the adapter reconnects its own socket after a
     * drop. A new connection is opened only when none exists (first use, after
     * reconnectEngine / rebootEngine, or after a failed attempt — which closes its Repo
     * first). Concurrent callers share one in-flight attempt.
     */
    private async connect(logicalId: string, forceNew = false): Promise<Conn> {
        if (forceNew) await this.disconnect(logicalId, 'forced reconnect')
        const existing = this.conns.get(logicalId)
        if (existing) {
            try {
                if (existing.storeHandle.doc()) return existing
            } catch { /* fall through: replace it */ }
            await this.disconnect(logicalId, 'store handle no longer ready')
        }
        const inFlight = this.connecting.get(logicalId)
        if (inFlight) return inFlight
        const p = this.openConn(logicalId).finally(() => this.connecting.delete(logicalId))
        this.connecting.set(logicalId, p)
        return p
    }

    /**
     * Open a connection and wait for the store doc: handshake (wsHandshakeTimeoutMs), then
     * up to docWaitMsFor(engine) for the full sync. If the peer drops mid-sync the same Repo's
     * adapter reconnects itself and the sync resumes (no new Repo). If the Engine explicitly
     * answers doc-unavailable, the Repo is CLOSED and a fresh one opened (sequentially).
     * Outcomes: ready → cached Conn; no usable WS → EngineUnreachableError; WS up but doc
     * never ready → StoreSyncStallError (fatal via onOwnStoreStall outside a reboot window).
     */
    private async openConn(logicalId: string): Promise<Conn> {
        const host = this.hostOf(logicalId)
        const docId = await this.fetchStoreDocId(logicalId)
        const url = `ws://${host}:${this.enginePort}`
        const docWaitMs = this.docWaitMsFor(logicalId)
        const started = Date.now()
        const deadline = started + this.wsHandshakeTimeoutMs + docWaitMs
        for (;;) {
            this.reposOpened.set(logicalId, (this.reposOpened.get(logicalId) ?? 0) + 1)
            console.log(`[RealFleetOps] Connecting ${logicalId} at ${url} (doc ${docId}, doc wait ${docWaitMs}ms)`)
            const adapter = new TrackedWebSocketClientAdapter(url, 2000, logicalId)
            const repo = new Repo({
                network: [adapter],
                peerId: `duration-${logicalId}-${Date.now()}` as PeerId,
            })
            adapterOf.set(repo, adapter)
            const tracked = repo as unknown as Parameters<typeof trackRepo>[0]
            // r30 automergeTimeoutGuard: the store doc is OWN; track peers/docs per engine.
            registerOwnDoc(docId, 'store', logicalId)
            trackRepo(tracked, logicalId, url)
            void this.registerOwnCommandLog(logicalId, host)
            let outcome: Awaited<ReturnType<typeof awaitStoreDoc>>
            try {
                const hsMs = Math.max(1, Math.min(this.wsHandshakeTimeoutMs, deadline - Date.now()))
                await waitForHandshake(repo, logicalId, url, hsMs)
                outcome = await awaitStoreDoc(repo, docId, deadline)
            } catch (e) {
                const reason = e instanceof EngineUnreachableError ? e.detail : (e instanceof Error ? e.message : String(e))
                await closeRepo(repo, reason)
                if (!this.rebootWindow.has(logicalId)) reportEngineUnreachable(logicalId) // expected while rebooting
                console.log(`[RealFleetOps] Connect ${logicalId} failed: ${reason} [${describeEngineLink(logicalId)}]`)
                throw e
            }
            if (outcome.kind === 'ready') {
                noteEngineStoreReady(tracked, logicalId)
                return this.registerConn(logicalId, repo, outcome.handle, host, docId, Date.now() - started)
            }
            if (outcome.kind === 'doc-unavailable' && Date.now() + 1_000 < deadline) {
                // Close before retry: never two connections to one engine at once.
                await closeRepo(repo, `engine answered doc-unavailable for ${docId}; reopening`)
                await sleep(1_000)
                continue
            }
            const secs = Math.round((Date.now() - started) / 1000)
            if (outcome.kind === 'ws-closed') {
                const detail = `WS dropped during store sync and did not come back within ${secs}s ` +
                    `(${outcome.detail}; last ${getEngineLink(logicalId)?.lastError ?? 'error none'})`
                await closeRepo(repo, detail)
                const msg = this.rebootWindow.has(logicalId) ? detail : reportEngineUnreachable(logicalId)
                console.log(`[RealFleetOps] Connect ${logicalId} failed: ${msg}`)
                throw new EngineUnreachableError(logicalId, url, detail)
            }
            // WS up, doc not ready: a real own-store stall.
            const detail = `store ${docId} not ready ${secs}s after connect (doc wait ${docWaitMs}ms, WS open; ${outcome.detail})`
            await closeRepo(repo, `sync stall: ${detail}`, true)
            console.log(`[RealFleetOps] Connect ${logicalId} failed: sync stall: ${detail} [${describeEngineLink(logicalId)}]`)
            if (!this.rebootWindow.has(logicalId)) this.onOwnStoreStall(logicalId, docId, detail)
            throw new StoreSyncStallError(logicalId, url, detail)
        }
    }

    private registerConn(
        logicalId: string, repo: Repo, storeHandle: DocHandle<Store>, host: string, docId: DocumentId, tookMs: number,
    ): Conn {
        const store = storeHandle.doc()
        const liveEngineId = store ? this.discoverLiveEngineId(store, logicalId) : null
        this.rememberMapping(logicalId, liveEngineId)
        console.log(
            `[RealFleetOps] Connected ${logicalId} → liveEngineId=${liveEngineId ?? 'unknown'} ` +
            `hostname=${liveEngineId && store?.engineDB[liveEngineId as keyof typeof store.engineDB]
                ? (store.engineDB[liveEngineId as keyof typeof store.engineDB] as { hostname?: string }).hostname
                : '?'} (store ready in ${tookMs}ms)`,
        )
        const conn: Conn = { repo, storeHandle, host, logicalId, liveEngineId, storeDocId: docId }
        this.conns.set(logicalId, conn)
        return conn
    }

    /**
     * Best-effort: learn this pool Engine's own CommandLog doc id from its read-only
     * GET /api/command-log-url (Engine httpMonitor), so the timeout guard can class a
     * relayed CommandLog as 'own' instead of 'foreign'. Never throws, never blocks connect.
     */
    private async registerOwnCommandLog(logicalId: string, host: string): Promise<void> {
        const port = Number(process.env.DURATION_ENGINE_HTTP_PORT ?? 8080)
        try {
            const res = await fetch(`http://${host}:${port}/api/command-log-url`, { signal: AbortSignal.timeout(5_000) })
            if (!res.ok) return
            const body = await res.json() as { url?: unknown }
            if (typeof body.url === 'string' && body.url.startsWith('automerge:')) {
                registerOwnDoc(body.url, 'commandLog', logicalId)
            }
        } catch {
            // unknown CommandLog id → its timeouts are classed 'foreign' (still tolerated)
        }
    }

    private toSemanticView(logicalId: string, store: Store): SemanticStoreView {
        const liveId = this.liveIds.get(logicalId)
            ?? this.discoverLiveEngineId(store, logicalId)
        if (liveId) this.rememberMapping(logicalId, liveId)

        const resolveLogical = (engineKey: string | null | undefined): string | null => {
            if (!engineKey) return null
            return this.logicalIds.get(engineKey)
                ?? (this.pool.includes(engineKey) || this.exclude.includes(engineKey) ? engineKey : engineKey)
        }

        const instanceDB: SemanticStoreView['instanceDB'] = {}
        for (const [id, inst] of Object.entries(store.instanceDB ?? {})) {
            if (!inst) continue
            instanceDB[id] = {
                id: String(inst.id ?? id),
                status: String(inst.status ?? ''),
                diskId: inst.storedOn != null ? String(inst.storedOn) : null,
                name: inst.name != null ? String(inst.name) : undefined,
            }
        }

        const diskDB: SemanticStoreView['diskDB'] = {}
        for (const [id, disk] of Object.entries(store.diskDB ?? {})) {
            if (!disk) continue
            diskDB[id] = {
                id: String(disk.id ?? id),
                name: disk.name != null ? String(disk.name) : undefined,
                dockedTo: resolveLogical(disk.dockedTo != null ? String(disk.dockedTo) : null),
                device: disk.device != null ? String(disk.device) : null,
                diskTypes: Array.isArray(disk.diskTypes)
                    ? disk.diskTypes.map(String)
                    : undefined,
                backupLinks: Array.isArray(disk.backupConfig?.links)
                    ? disk.backupConfig!.links.map(String)
                    : undefined,
            }
        }

        const engineDB: SemanticStoreView['engineDB'] = {}
        for (const [id, eng] of Object.entries(store.engineDB ?? {})) {
            if (!eng) continue
            const logical = resolveLogical(id) ?? id
            engineDB[logical] = {
                id: logical,
                hostname: eng.hostname != null ? String(eng.hostname) : undefined,
            }
        }
        // Ensure the queried logical engine appears even if live key differed
        if (!engineDB[logicalId] && liveId && store.engineDB[liveId as keyof typeof store.engineDB]) {
            const eng = store.engineDB[liveId as keyof typeof store.engineDB] as { hostname?: string }
            engineDB[logicalId] = { id: logicalId, hostname: eng.hostname ? String(eng.hostname) : logicalId }
        }

        return { engineId: logicalId, instanceDB, diskDB, engineDB }
    }


    /**
     * Phase 4 dwell probe: WS ping + docker ps for Running instances (SSH).
     * Unexpected container absence → ok:false for that engine.
     */
    async probeStability(engineIds: string[]): Promise<import('./types.js').FleetStabilityProbe> {
        const engines: import('./types.js').FleetStabilityProbe['engines'] = []
        let ok = true
        const details: string[] = []
        for (const id of engineIds) {
            if (this.exclude.includes(id)) continue
            let wsUp = false
            try {
                // waitReady never declares WS down during a normal initial sync: with no
                // connection it makes one full attempt (handshake + per-host doc wait).
                const ready = await this.waitReady(id, this.wsHandshakeTimeoutMs)
                wsUp = ready.wsUp
            } catch {
                wsUp = false
            }
            let dockerOk: boolean | undefined
            let statusAnomaly: string | undefined
            if (wsUp) {
                try {
                    const view = await this.readStore(id)
                    // Undocked or foreign-docked disks do not need a local container.
                    // Null diskId or a missing disk row still expects docker.
                    const running = Object.values(view.instanceDB).filter(i =>
                        i.status === 'Running'
                        && runningInstanceExpectsLocalDocker(i, view.diskDB, id))
                    if (running.length === 0) {
                        dockerOk = true // nothing expected running
                    } else {
                        const host = this.hosts[id]
                        if (!host) {
                            dockerOk = undefined
                        } else {
                            // docker ps — names often contain instance id
                            const result = await this.ssh(host, 'docker ps --format "{{.Names}}" 2>/dev/null || true')
                            const names = (result ?? '').toLowerCase()
                            const missing = running.filter(i => !names.includes(i.id.toLowerCase())
                                && !names.includes((i.name ?? '').toLowerCase()))
                            if (missing.length) {
                                dockerOk = false
                                statusAnomaly = `docker missing for ${missing.map(m => m.id).join(',')}`
                                ok = false
                                details.push(`${id}: ${statusAnomaly}`)
                            } else {
                                dockerOk = true
                            }
                        }
                    }
                } catch (e) {
                    dockerOk = false
                    statusAnomaly = e instanceof Error ? e.message : String(e)
                    ok = false
                    details.push(`${id}: ${statusAnomaly}`)
                }
            } else {
                ok = false
                details.push(`${id}: WS down — ${reportEngineUnreachable(id)}`)
            }
            engines.push({ id, wsUp, dockerOk, statusAnomaly })
        }
        return {
            ok,
            detail: ok ? 'stability ok' : details.join('; '),
            engines,
        }
    }

    /**
     * r32 preflight: before step 1, every pool Engine must complete the WS handshake and
     * serve the store doc. Retries until `timeoutMs`; never writes anything.
     */
    async preflightEngines(timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS): Promise<{
        ok: boolean
        engines: Array<{ id: string; ok: boolean; url: string; detail: string; message?: string }>
    }> {
        const ids = this.listPoolEngines()
        const engines = await Promise.all(ids.map(async id => {
            const url = `ws://${this.hostOf(id)}:${this.enginePort}`
            const deadline = Date.now() + timeoutMs
            let lastErr: Error | null = null
            do {
                try {
                    await this.connect(id) // sequential: each failed attempt closed its Repo
                    return { id, ok: true, url, detail: describeEngineLink(id) }
                } catch (e) {
                    lastErr = e instanceof Error ? e : new Error(String(e))
                    if (lastErr instanceof StoreSyncStallError) break // WS up, doc never ready: not a reach problem
                    if (Date.now() + 1_000 < deadline) await sleep(1_000)
                }
            } while (Date.now() < deadline)
            const stalled = lastErr instanceof StoreSyncStallError
            return {
                id, ok: false, url, detail: describeEngineLink(id),
                message: stalled ? lastErr!.message : reportEngineUnreachable(id),
            }
        }))
        return { ok: engines.every(e => e.ok), engines }
    }

    /**
     * Reuse model: with a cached connection, wait (≥ handshake timeout) for its WS to be
     * open — the adapter reconnects itself after a drop; only if it stays down is the old
     * connection CLOSED and a fresh one opened. With no connection, make at least one full
     * attempt (handshake + per-host doc wait), retrying sequentially until `timeoutMs`.
     */
    async waitReady(engineId: string, timeoutMs: number): Promise<SettleReady> {
        const start = Date.now()
        let first = true
        let freshAfterDrop = false
        while (first || Date.now() - start < timeoutMs) {
            first = false
            const cached = this.conns.get(engineId)
            if (cached) {
                const wsWait = Math.max(this.wsHandshakeTimeoutMs, timeoutMs - (Date.now() - start))
                if (await this.waitWsOpen(cached, wsWait)) {
                    const doc = cached.storeHandle.doc()
                    if (doc) {
                        const live = this.discoverLiveEngineId(doc, engineId)
                        this.rememberMapping(engineId, live)
                        const storeSynced = live != null && !!doc.engineDB[live as keyof typeof doc.engineDB]
                        // Unique-mode settle: WS up is the hard gate; storeSynced is best-effort.
                        return { wsUp: true, storeSynced }
                    }
                }
                // Real disconnect (WS stayed down): close the old connection before any retry.
                noteEngineWs(engineId, 'error', `WS down on the reused connection for ${wsWait}ms`)
                await this.disconnect(engineId, `WS down for ${wsWait}ms; reconnecting`)
                if (!freshAfterDrop) { freshAfterDrop = true; first = true } // one fresh connection after a real disconnect
                continue
            }
            try {
                await this.connect(engineId)
                first = true // always validate the fresh connection, even past timeoutMs
                continue
            } catch (e) {
                if (e instanceof StoreSyncStallError && !this.rebootWindow.has(engineId)) break
                if (Date.now() - start + 1_000 < timeoutMs) await sleep(1_000)
            }
        }
        return { wsUp: false, storeSynced: false }
    }

    /** Resolve true once this connection's Repo has an open WS peer, false after `ms`. */
    private async waitWsOpen(conn: Conn, ms: number): Promise<boolean> {
        if (conn.repo.peers.length > 0) return true
        try {
            await waitForHandshake(conn.repo, conn.logicalId, `ws://${conn.host}:${this.enginePort}`, ms)
            return true
        } catch {
            return false
        }
    }

    async readStore(engineId: string): Promise<SemanticStoreView> {
        const conn = await this.connect(engineId)
        const doc = conn.storeHandle.doc()
        if (!doc) {
            throw new Error(`RealFleetOps: store doc not ready for ${engineId}`)
        }
        return structuredClone(this.toSemanticView(engineId, doc))
    }

    /**
     * r29 FAIL@97: read-only list of operationDB rows (restore/copy/move evidence).
     * Never calls storeHandle.change().
     */
    async listOperations(engineId: string): Promise<
        { id: string; kind: string; status: string; startedAt: number | null; completedAt: number | null; error: string | null; args: Record<string, string> }[]
    > {
        this.assertNotExcluded(engineId, 'listOperations')
        const conn = await this.connect(engineId)
        const doc = conn.storeHandle.doc() as (Store & { operationDB?: Record<string, unknown> }) | undefined
        if (!doc) {
            throw new Error(`RealFleetOps: store doc not ready for ${engineId}`)
        }
        return Object.entries(doc.operationDB ?? {}).map(([id, raw]) => {
            const o = (raw ?? {}) as unknown as Record<string, unknown>
            return {
                id: String(o.id ?? id),
                kind: String(o.kind ?? ''),
                status: String(o.status ?? ''),
                startedAt: typeof o.startedAt === 'number' ? o.startedAt : null,
                completedAt: typeof o.completedAt === 'number' ? o.completedAt : null,
                error: o.error == null ? null : String(o.error),
                args: Object.fromEntries(
                    Object.entries((o.args ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
                ),
            }
        })
    }

    /**
     * r36@98: read-only list of this pool Engine's own CommandLog traces (doc url from the
     * Engine's GET /api/command-log-url, synced over the existing WS Repo). Never changes
     * the doc. Eng handleCommand traces every queued command, refusals included.
     */
    async listCommandTraces(engineId: string): Promise<DurationCommandTrace[]> {
        this.assertNotExcluded(engineId, 'listCommandTraces')
        const conn = await this.connect(engineId)
        let url = this.commandLogUrls.get(engineId)
        if (!url) {
            const port = Number(process.env.DURATION_ENGINE_HTTP_PORT ?? 8080)
            const res = await fetch(`http://${conn.host}:${port}/api/command-log-url`, { signal: AbortSignal.timeout(5_000) })
            const body = res.ok ? ((await res.json()) as { url?: unknown }) : {}
            if (typeof body.url !== 'string' || !body.url.startsWith('automerge:')) {
                throw new Error(`no CommandLog url from ${engineId} /api/command-log-url (HTTP ${res.status})`)
            }
            url = body.url
            this.commandLogUrls.set(engineId, url)
            registerOwnDoc(url, 'commandLog', engineId)
        }
        const handle = conn.repo.findWithProgress<{ traces?: Record<string, unknown> }>(toDocId(url)).handle
        const deadline = Date.now() + 5_000
        while (!handle.isReady() && Date.now() < deadline) await sleep(100)
        if (!handle.isReady()) throw new Error(`CommandLog ${url} of ${engineId} not ready within 5000ms`)
        const doc = handle.doc()
        return Object.entries(doc?.traces ?? {}).map(([id, raw]) => {
            const t = (raw ?? {}) as Record<string, unknown>
            return {
                traceId: String(t.traceId ?? id),
                command: String(t.command ?? ''),
                args: typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? null),
                status: String(t.status ?? ''),
                startedAt: typeof t.startedAt === 'number' ? t.startedAt : null,
                completedAt: typeof t.completedAt === 'number' ? t.completedAt : null,
                errorMessage: t.errorMessage == null ? null : String(t.errorMessage),
            }
        })
    }

    /**
     * r36@98: READ-ONLY probe of the Console dist a pool Engine serves (consolePath from its
     * config.yaml, the git HEAD of that checkout, tracked changes, commit time, dist mtime and
     * main asset). Only cat/sed/grep/stat/git rev-parse|log|status — nothing is written.
     */
    async probeConsoleDist(engineId: string): Promise<ConsoleDistProbe> {
        this.assertNotExcluded(engineId, 'probeConsoleDist')
        const out = await this.ssh(this.hostOf(engineId), consoleDistProbeScript())
        return parseConsoleDistProbe(out)
    }

    /**
     * r29: read-only `docker ps` names for an instance id on a pool engine
     * (restore_from_backup must leave a running container on the store host).
     */
    async listInstanceContainers(engineId: string, instanceId: string): Promise<string[]> {
        this.assertNotExcluded(engineId, 'listInstanceContainers')
        if (!/^[A-Za-z0-9_.-]+$/.test(instanceId)) {
            throw new Error(`RealFleetOps: refuse docker filter for odd instance id '${instanceId}'`)
        }
        const out = await this.ssh(
            this.hostOf(engineId),
            `docker ps --filter name='^${instanceId}-' --format '{{.Names}}' 2>/dev/null || true`,
        )
        return out.split('\n').map(l => l.trim()).filter(Boolean)
    }

    /**
     * r30 backup_instance: read-only look at a docked Backup Disk slot on engineId —
     * `cat BACKUP.yaml` and `ls -1A backups/<instanceId>` (Eng backupMonitor writes the
     * Borg repo there and bumps BACKUP.yaml links[].lastBackup only after borg create).
     * Device comes from the store row (fallback: harness device map). Never writes.
     * Returns null when no idea-test-N slot is known for the disk on that engine.
     */
    async probeBackupDisk(
        engineId: string,
        diskId: string,
        instanceId: string,
    ): Promise<{ dest: string; backupYaml: string | null; repoEntries: string[] | null } | null> {
        this.assertNotExcluded(engineId, 'probeBackupDisk')
        if (!/^[A-Za-z0-9_.-]+$/.test(instanceId)) {
            throw new Error(`RealFleetOps: refuse backup probe for odd instance id '${instanceId}'`)
        }
        let device: string | null = null
        try {
            const view = await this.readStore(engineId)
            const d = view.diskDB[diskId]
            if (d?.device && /^idea-test-[0-9]+$/.test(d.device)) device = d.device
        } catch {
            /* fall back to the harness device map */
        }
        device ??= this.deviceMap(engineId).get(diskId) ?? null
        if (!device || !/^idea-test-[0-9]+$/.test(device)) return null
        const dest = `${this.disksRoot}/${device}`
        const repo = `${dest}/backups/${instanceId}`
        const out = await this.ssh(
            this.hostOf(engineId),
            `if [ -f '${dest}/BACKUP.yaml' ]; then cat '${dest}/BACKUP.yaml'; else echo '@@NO_BACKUP_YAML@@'; fi; ` +
                `echo '@@REPO@@'; if [ -d '${repo}' ]; then ls -1A '${repo}'; else echo '@@NO_REPO@@'; fi`,
        )
        const text = String(out ?? '')
        const [yamlPart, repoPart = ''] = text.split('@@REPO@@')
        const backupYaml = /@@NO_BACKUP_YAML@@/.test(yamlPart ?? '') ? null : (yamlPart ?? '').trim()
        const repoEntries = /@@NO_REPO@@/.test(repoPart)
            ? null
            : repoPart.split('\n').map(l => l.trim()).filter(Boolean)
        return { dest, backupYaml, repoEntries }
    }

    /**
     * r30 reboot_engine: read-only engine record of `targetEngine` as seen through the
     * store of `viaEngine` (shared store: any pool engine; unique: the target itself).
     * Returns lastBooted / lastRun / commands queue, or null when the record is absent.
     */
    async readEngineState(
        viaEngine: string,
        targetEngine: string,
    ): Promise<{ liveId: string; lastBooted: number | null; lastRun: number | null; commands: string[] } | null> {
        this.assertNotExcluded(viaEngine, 'readEngineState(via)')
        const conn = await this.connect(viaEngine)
        const doc = conn.storeHandle.doc()
        if (!doc) throw new Error(`RealFleetOps: store doc not ready for ${viaEngine}`)
        const liveId = this.liveIds.get(targetEngine) ?? this.discoverLiveEngineId(doc, targetEngine)
        const eng = liveId
            ? (doc.engineDB[liveId as keyof typeof doc.engineDB] as unknown as Record<string, unknown> | undefined)
            : undefined
        if (!liveId || !eng) return null
        const num = (v: unknown) => (typeof v === 'number' ? v : null)
        const cmds = Array.isArray(eng.commands) ? Array.from(eng.commands as unknown[]).map(String) : []
        return { liveId, lastBooted: num(eng.lastBooted), lastRun: num(eng.lastRun), commands: cmds }
    }

    /**
     * r30 reboot_engine: drop any cached connection and prove a FRESH WS + store sync to
     * engineId (a cached Automerge doc survives a dead socket, so waitReady alone could
     * report wsUp from cache right after a reboot).
     */
    async reconnectEngine(engineId: string, timeoutMs: number): Promise<SettleReady> {
        this.assertNotExcluded(engineId, 'reconnectEngine')
        // Reuse model exception: a reboot needs a FRESH socket. Close the old one first.
        await this.disconnect(engineId, 'reconnectEngine: fresh WS required')
        this.rebootWindow.add(engineId)
        try {
            // Every attempt is bounded (handshake + doc wait), so no outer race timer.
            return await this.waitReady(engineId, timeoutMs)
        } finally {
            this.rebootWindow.delete(engineId)
        }
    }

    /** Exposed for tests / smoke reporting. */
    getLiveEngineId(logicalId: string): string | null {
        return this.liveIds.get(logicalId) ?? null
    }

    getHostMap(): Record<string, string> {
        return { ...this.hosts }
    }

    private async runHealthWrap(tpl: string | undefined): Promise<void> {
        if (!tpl) return
        const pis = this.listPoolEngines().map(id => this.hostOf(id))
        const cmd = expandTemplate(tpl, pis)
        console.log(`[RealFleetOps] health-wrap: ${cmd}`)
        await $`bash -lc ${cmd}`
    }

    /**
     * Best-effort: stop Path A duration fixture containers on host by safe name list.
     * Names must contain kolibri-grade5a / nextcloud-grade5a / duration-; never idea166-*.
     * Used before pm2 restart so containers do not survive as orphans.
     */
    private async stopDurationFixtureContainers(host: string): Promise<string[]> {
        // List names first (audit), then stop+rm only safe duration fixtures.
        const listRemote = [
            'docker ps -a --format "{{.Names}}" 2>/dev/null || true',
        ].join('; ')
        try {
            const listed = (await this.ssh(host, listRemote)).trim()
            const names = listed.split(/\s+/).map(n => n.replace(/^\//, '')).filter(Boolean)
            const targets = names.filter(n =>
                !n.includes('idea166-') &&
                (n.includes('kolibri-grade5a') || n.includes('nextcloud-grade5a') || n.includes('duration-')),
            )
            if (!targets.length) return []
            // Stop by exact container name (docker --filter name is substring; use name=exact).
            for (const name of targets) {
                const safe = name.replace(/'/g, '')
                await this.ssh(
                    host,
                    `docker ps -aq --filter name='${safe}' 2>/dev/null | xargs -r docker stop; ` +
                    `docker ps -aq --filter name='${safe}' 2>/dev/null | xargs -r docker rm`,
                ).catch(e => {
                    console.warn(`[RealFleetOps] docker stop/rm ${safe} on ${host}: ${e}`)
                })
            }
            console.log(
                `[RealFleetOps] stopped duration fixture containers on ${host}: ${targets.join(', ')}`,
            )
            return targets
        } catch (e) {
            console.warn(`[RealFleetOps] stopDurationFixtureContainers on ${host} failed (best-effort): ${e}`)
            return []
        }
    }

    /**
     * After Engine reconnect: clear Path A Running/Starting instances whose disk is
     * missing or Undocked (no_zombie_instances). Stops docker by exact instance id only.
     */
    private async reconcileDurationZombies(engineId: string): Promise<void> {
        const host = this.hostOf(engineId)
        let view: SemanticStoreView
        try {
            view = await this.readStore(engineId)
        } catch (e) {
            console.warn(`[RealFleetOps] reconcileDurationZombies: readStore failed on ${engineId}: ${e}`)
            return
        }
        const stopped: string[] = []
        for (const inst of Object.values(view.instanceDB)) {
            if (inst.status !== 'Running' && inst.status !== 'Starting') continue
            const disk = inst.diskId ? view.diskDB[inst.diskId] : undefined
            if (disk && disk.dockedTo !== null) continue
            const idHits =
                looksLikeDurationFixtureId(inst.id) ||
                (inst.diskId != null && looksLikeDurationFixtureId(inst.diskId))
            if (!idHits) continue
            // Exact instance id filter only — never broad docker ps.
            const needle = inst.id.replace(/'/g, '')
            if (!needle || needle.includes('idea166-')) continue
            try {
                const remote =
                    `ids=$(docker ps -aq --filter name='${needle}' 2>/dev/null); ` +
                    `if test -n "$ids"; then echo "$ids" | xargs -r docker stop; ` +
                    `echo "$ids" | xargs -r docker rm; echo '${needle}'; ` +
                    `else echo ""; fi`
                const out = (await this.ssh(host, remote)).trim()
                if (out) {
                    stopped.push(needle)
                } else {
                    console.log(
                        `[RealFleetOps] reconcileDurationZombies: ${inst.id} is ${inst.status} ` +
                        `but disk ${inst.diskId ?? '?'} Undocked/missing — no docker match on ${host}`,
                    )
                }
            } catch (e) {
                console.warn(
                    `[RealFleetOps] reconcileDurationZombies: docker stop ${inst.id} on ${host} failed: ${e}`,
                )
            }
        }
        if (stopped.length) {
            console.log(
                `[RealFleetOps] reconcileDurationZombies on ${engineId}: stopped ${stopped.join(', ')}`,
            )
        }
        await sleep(2500)
        try {
            await this.readStore(engineId)
        } catch {
            // best-effort — invariant runs after action returns
        }
    }

    async rebootEngine(engineId: string, fast: boolean): Promise<void> {
        this.assertNotExcluded(engineId, 'rebootEngine')
        const host = this.hostOf(engineId)
        await this.runHealthWrap(this.healthWrapBefore)
        // Close (not just forget) the connection before the reboot; reopen fresh after.
        await this.disconnect(engineId, 'rebootEngine: closing before reboot')
        this.rebootWindow.add(engineId)
        try {
            await this.rebootAndReconnect(engineId, host, fast)
        } finally {
            this.rebootWindow.delete(engineId)
        }

        // Docker containers can survive pm2 restart; Automerge may reconnect with
        // Running instances whose disks are Undocked → no_zombie_instances. Clear
        // Path A duration fixtures only (never idea166-* / Intenso).
        await this.reconcileDurationZombies(engineId)

        await this.runHealthWrap(this.healthWrapAfter)
    }

    private async rebootAndReconnect(engineId: string, host: string, fast: boolean): Promise<void> {
        if (fast) {
            // Clear Path A duration containers before pm2 so they do not survive as orphans.
            await this.stopDurationFixtureContainers(host)
            console.log(`[RealFleetOps] pm2 restart engine on ${engineId} (${host})`)
            await this.ssh(host, 'pm2 restart engine')
            // Brief pause then wait for WS.
            // Overnight smoke (idea#166): 60s withTimeout was too short after rapid
            // pm2 restarts on idea03 — Automerge reconnect lagged. Use 150s
            // (PM2_RECONNECT_TIMEOUT_MS) for duration-test RealFleetOps only.
            await sleep(2000)
            const ready = await this.waitReady(engineId, this.pm2ReconnectTimeoutMs)
            if (!ready.wsUp) {
                throw new Error(
                    `RealFleetOps: ${engineId} WS not up after pm2 restart ` +
                    `(waited ${this.pm2ReconnectTimeoutMs}ms)`,
                )
            }
        } else {
            console.log(`[RealFleetOps] sudo reboot on ${engineId} (${host})`)
            try {
                await this.ssh(host, 'sudo reboot')
            } catch {
                // reboot often kills SSH mid-flight
            }
            // Wait until SSH comes back, then WS
            const deadline = Date.now() + 300_000
            let sshUp = false
            while (Date.now() < deadline) {
                await sleep(3000)
                try {
                    await this.ssh(host, 'true')
                    sshUp = true
                    break
                } catch {
                    // still down
                }
            }
            if (!sshUp) throw new Error(`RealFleetOps: SSH to ${engineId} did not return after reboot`)
            const ready = await this.waitReady(engineId, FULL_REBOOT_RECONNECT_TIMEOUT_MS)
            if (!ready.wsUp) {
                throw new Error(`RealFleetOps: ${engineId} WS not up after reboot`)
            }
        }
    }

    async undockFixtures(engineIds: string[], diskId: string): Promise<void> {
        if (looksLikeProtectedHwDisk(diskId)) {
            throw new Error(
                `RealFleetOps: refuse to eject protected hw-roundtrip / system disk '${diskId}'`,
            )
        }
        for (const logicalId of engineIds) {
            if (this.exclude.includes(logicalId)) continue
            try {
                const conn = await this.connect(logicalId)
                const doc = conn.storeHandle.doc()
                if (!doc) continue

                const disk = doc.diskDB[diskId as keyof typeof doc.diskDB] as
                    | { id?: string; name?: string; dockedTo?: string | null; device?: string | null }
                    | undefined

                // Also scan by name/label for protected sticks if caller used a fixture id that
                // happens to collide — and refuse ejecting anything that looks like the Intenso.
                for (const d of Object.values(doc.diskDB ?? {})) {
                    if (!d) continue
                    if (looksLikeProtectedHwDisk(String(d.id), {
                        name: d.name != null ? String(d.name) : null,
                        device: d.device != null ? String(d.device) : null,
                    }) && (String(d.id) === diskId || String(d.name) === diskId)) {
                        throw new Error(
                            `RealFleetOps: refuse to eject idea03 Intenso / protected disk ` +
                            `'${d.id}' (name=${d.name})`,
                        )
                    }
                }

                if (!disk) {
                    // Fixture not present — already undocked
                    continue
                }
                if (looksLikeProtectedHwDisk(String(disk.id ?? diskId), {
                    name: disk.name != null ? String(disk.name) : null,
                    device: disk.device != null ? String(disk.device) : null,
                })) {
                    throw new Error(
                        `RealFleetOps: refuse to eject protected disk '${disk.id ?? diskId}'`,
                    )
                }
                if (!disk.dockedTo) continue // already undocked

                const liveTarget = this.liveIds.get(logicalId)
                    ?? this.discoverLiveEngineId(doc, logicalId)
                if (!liveTarget) {
                    console.warn(`[RealFleetOps] undock: no live engine id for ${logicalId}; skip`)
                    continue
                }
                // Prefer eject by id
                console.log(`[RealFleetOps] ejectDisk ${diskId} on ${logicalId} (live=${liveTarget})`)
                conn.storeHandle.change(s => {
                    const eng = s.engineDB[liveTarget as keyof typeof s.engineDB] as
                        | { commands: string[] }
                        | undefined
                    if (eng) eng.commands.push(`ejectDisk ${diskId}` as never)
                })
                // Drop Kid sentinel so chokidar does not re-add; keep fixture tree.
                const device = this.deviceMap(logicalId).get(diskId)
                    ?? (disk.device && /^idea-test-[0-9]+$/.test(String(disk.device))
                        ? String(disk.device)
                        : null)
                if (device) {
                    await this.sshRemoveSentinel(logicalId, device)
                    this.releaseTestDevice(logicalId, diskId)
                }
            } catch (e) {
                if (e instanceof Error && /refuse to eject/.test(e.message)) throw e
                console.warn(`[RealFleetOps] undockFixtures ${logicalId}/${diskId}: ${e}`)
            }
        }
    }

    private deviceMap(engineId: string): Map<string, string> {
        let m = this.deviceByEngineDisk.get(engineId)
        if (!m) {
            m = new Map()
            this.deviceByEngineDisk.set(engineId, m)
        }
        return m
    }

    private usedSet(engineId: string): Set<string> {
        let s = this.usedDevices.get(engineId)
        if (!s) {
            s = new Set()
            this.usedDevices.set(engineId, s)
        }
        return s
    }


    /** Read-only scan of idea-test-1..8 on engineId (one SSH round-trip). */
    private async scanFixtureSlots(engineId: string, diskId: string) {
        return parseFixtureSlotScan(await this.ssh(this.hostOf(engineId), buildFixtureSlotScanRemote(this.disksRoot, diskId)))
    }

    /** Run the app-pack instance-data check for `root` on engineId. */
    private async checkInstanceData(engineId: string, root: string, spec: AppPackInstanceData): Promise<{ ok: boolean; detail: string }> {
        try {
            return parseInstanceDataCheck(await this.ssh(
                this.hostOf(engineId),
                buildInstanceDataCheckRemote({ root, spec, sudoMode: this.sudoMode }),
            ))
        } catch (e) {
            return { ok: false, detail: `instance-data check failed over SSH: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    /**
     * SSH: the idea-test-N (1..8) on engineId whose META.yaml diskId matches, or null.
     *
     * idea#168 r34@70 — LOUD precondition, not a heuristic: a META.yaml with the right diskId is
     * not a disk. For app packs (Kolibri / Nextcloud Grade5A) docked with instances started, the
     * tree must also carry the instance's data (Kolibri: db.sqlite3 with facility + classroom
     * 'Grade 5A'; Nextcloud: installed config.php + MariaDB schema). A matching tree without it
     * throws, naming host, path, diskId and what is missing — never silently reused, never
     * silently refreshed from the seed pack. Two slots with the same diskId also throw.
     * `requireInstanceData: false` (read-only probes, dock-only smoke) checks META only.
     *
     * idea#168 r35@62 — LOUD: a slot with any path (app data or anything else) that is a symlink
     * resolving OUTSIDE the slot is refused, naming host, link, target and diskId. A real IDEA
     * disk carries its data inside the disk; Engine copy_app copies such a link verbatim and the
     * copy then shares the original's live data (r35: copy y3zvlf9ug1t8wgod3uu wrote the Grade5A
     * DB during @62's tar). This REPLACES b40b8a0's "materialize external links on move".
     * `refuseExternalLinks: false` only for the read-only probes (they change nothing, and a slot
     * they look at was link-checked when it was docked).
     */
    private async hasHealthyFixtureTree(
        engineId: string,
        diskId: string,
        opts: { requireInstanceData?: boolean; refuseExternalLinks?: boolean } = {},
    ): Promise<string | null> {
        const host = this.hostOf(engineId)
        const slots = await this.scanFixtureSlots(engineId, diskId)
        const matches = slots.filter(sl => sl.state === 'MATCH').map(sl => sl.device)
        if (matches.length === 0) return null
        if (matches.length > 1) {
            throw new Error(
                `RealFleetOps: ${engineId} (${host}) holds ${matches.length} trees for ${diskId}: ` +
                    matches.map(d => `${this.disksRoot}/${d}`).join(', ') +
                    ` — one disk cannot be in two slots. Refusing to pick one; purge the stale tree(s) (Path A).`,
            )
        }
        const device = matches[0]!
        const spec = appPackInstanceData(diskId)
        if (opts.refuseExternalLinks ?? true) {
            await this.assertNoExternalLinks(engineId, `${this.disksRoot}/${device}`, diskId, spec?.moveSkipDirs ?? [])
        }
        const require = opts.requireInstanceData ?? (this.startInstances && spec !== null)
        if (require && spec) {
            const dest = `${this.disksRoot}/${device}`
            const verdict = await this.checkInstanceData(engineId, dest, spec)
            if (!verdict.ok) {
                throw new Error(
                    `RealFleetOps: refuse stale fixture tree ${engineId}:${dest} (host ${host}) for ${diskId}: ` +
                        `META.yaml diskId matches but the instance data is missing — ${verdict.detail}. ` +
                        `Needed: ${spec.keyFile} (${spec.describe}). No silent reuse and no silent ` +
                        `refresh-from-seed (either would start ${spec.instanceId} without its data). ` +
                        `Purge/quarantine this tree or put the disk's real tree back (Path A), then re-run.`,
                )
            }
            console.log(`[RealFleetOps] fixture tree ${engineId}:${dest} for ${diskId}: instance data OK (${verdict.detail})`)
        }
        this.deviceMap(engineId).set(diskId, device)
        this.usedSet(engineId).add(device)
        return device
    }

    /**
     * idea#168 r35@62: LOUD refusal of a slot holding symlinks that resolve outside it (see
     * hasHealthyFixtureTree). Also refuses when the slot cannot be scanned (no silent pass).
     */
    private async assertNoExternalLinks(engineId: string, slot: string, diskId: string, skipDirs: readonly string[]): Promise<void> {
        const host = this.hostOf(engineId)
        let scan: SlotLinkScan
        try {
            scan = parseSlotLinkScan(await this.ssh(host, buildSlotLinkScanRemote(slot, this.sudoMode, skipDirs)))
        } catch (e) {
            scan = { error: `link scan failed over SSH: ${e instanceof Error ? e.message : String(e)}`, outside: [] }
        }
        if (scan.error) {
            throw new Error(
                `RealFleetOps: refuse fixture tree ${engineId}:${slot} (host ${host}) for ${diskId}: cannot verify that ` +
                    `no symlink in the slot resolves outside it — ${scan.error}. No silent pass.`,
            )
        }
        if (scan.outside.length) {
            throw new Error(
                `RealFleetOps: refuse fixture tree ${engineId}:${slot} (host ${host}) for ${diskId}: ` +
                    `${scan.outside.length} symlink(s) resolve OUTSIDE the slot — ` +
                    scan.outside.map(l => `${slot}/${l.rel} → ${l.target}${l.raw && l.raw !== l.target ? ` (link text '${l.raw}')` : ''}`).join('; ') +
                    `. A real IDEA disk carries its data inside the disk (no Engine install/copy_app/move_app path ` +
                    `creates such a link); Engine copy_app would copy the link and the copy would share this live data ` +
                    `(idea#168 r35@62). Replace each link with the real data inside the slot (Path A), then re-run. ` +
                    `Not materialized, not followed.`,
            )
        }
    }

    /**
     * idea#168 r35@62: running containers on engineId with a mount inside `roots` that are NOT
     * one of `ownInstances` (compose `<instanceId>-…`). Read-only; throws when docker cannot be
     * asked (nobody can vouch the data is quiet).
     */
    private async foreignMountHits(engineId: string, roots: readonly string[], ownInstances: readonly string[]): Promise<{ foreign: MountHit[]; own: MountHit[] }> {
        const host = this.hostOf(engineId)
        let res: { error: string | null; hits: MountHit[] }
        try {
            res = parseMountScan(await this.ssh(host, buildMountScanRemote(roots)))
        } catch (e) {
            res = { error: `mount scan failed over SSH: ${e instanceof Error ? e.message : String(e)}`, hits: [] }
        }
        if (res.error) {
            throw new Error(
                `cannot list the running containers' mounts on ${engineId} (${host}) — ${res.error}. Cannot verify that ` +
                    `no other container uses ${roots.join(', ')}; refusing (no silent pass).`,
            )
        }
        return {
            foreign: res.hits.filter(h => !isOwnInstanceContainer(h.container, ownInstances)),
            own: res.hits.filter(h => isOwnInstanceContainer(h.container, ownInstances)),
        }
    }

    /** Allocate idea-test-N on this engine for diskId (stable if already assigned). */
    private allocateTestDevice(engineId: string, diskId: string): string {
        const map = this.deviceMap(engineId)
        const existing = map.get(diskId)
        if (existing) return existing
        const used = this.usedSet(engineId)
        const preferred = DISK_ID_PREFERRED_DEVICE[diskId]
        if (preferred && !used.has(preferred)) {
            used.add(preferred)
            map.set(diskId, preferred)
            return preferred
        }
        let n = 1
        while (used.has(`idea-test-${n}`)) n++
        if (n > 64) {
            throw new Error(`RealFleetOps: no free idea-test-N slots on ${engineId}`)
        }
        const device = `idea-test-${n}`
        used.add(device)
        map.set(diskId, device)
        return device
    }

    private releaseTestDevice(engineId: string, diskId: string): void {
        const map = this.deviceMap(engineId)
        const device = map.get(diskId)
        if (!device) return
        map.delete(diskId)
        this.usedSet(engineId).delete(device)
    }

    private fixtureSourcePath(diskId: string): string {
        const pack = resolveDurationFixturePack(diskId)
        return `${this.fixtureSourceRoot}/${pack}`
    }

    /**
     * Kid dock (testMode): copy pack tree → IDEA_DISKS_ROOT/idea-test-N/ + touch
     * sentinel under IDEA_WATCH_DIR. Excludes instances/ unless startInstances.
     * Does not start Kolibri/Nextcloud — image not required for dock-only smoke.
     */
    private async sshDockCopy(engineId: string, diskId: string, device: string): Promise<void> {
        if (!/^idea-test-[0-9]+$/.test(device)) {
            throw new Error(`RealFleetOps: refuse non-test device '${device}' (must be idea-test-N)`)
        }
        if (device.includes('sdb') || diskId.includes('sdb')) {
            throw new Error('RealFleetOps: refuse sdb device/diskId')
        }
        assertPrivateDurationRoots(this.disksRoot, this.watchDir)
        const host = this.hostOf(engineId)
        const src = this.fixtureSourcePath(diskId)
        const dest = `${this.disksRoot}/${device}`
        const sentinel = `${this.watchDir}/${device}`
        // Single remote bash: copy tree + sentinel. Never touches /disks or sdb.
        // Prefer cp -a (always on Pi). Drop instances/ unless startInstances so
        // Engine docks without auto-starting Kolibri/Nextcloud (image not required).
        const pack = resolveDurationFixturePack(diskId)
        const remote = buildSshDockCopyRemote({
            diskId,
            pack,
            src,
            dest,
            sentinel,
            disksRoot: this.disksRoot,
            watchDir: this.watchDir,
            startInstances: this.startInstances,
        })
        console.log(
            `[RealFleetOps] dock copy ${diskId} → ${engineId}:${dest} ` +
            `(sentinel ${sentinel}, startInstances=${this.startInstances})`,
        )
        await this.ssh(host, remote)
    }

    /**
     * Prefer A r21: report how the docked fixture slot is backed on engineId —
     * `findmnt -no FSTYPE <dest>` exactly as Engine createFilesDisk checks it
     * ('' for a plain dir under duration-disks → createFilesDisk "filesystem: unknown").
     * Read-only (ssh findmnt). Returns null when no slot for diskId is found.
     */
    async probeFixtureFsType(
        engineId: string,
        diskId: string,
    ): Promise<{ device: string; dest: string; fsType: string } | null> {
        this.assertNotExcluded(engineId, 'probeFixtureFsType')
        const device = this.deviceMap(engineId).get(diskId)
            ?? (await this.hasHealthyFixtureTree(engineId, diskId, { requireInstanceData: false, refuseExternalLinks: false }))
        if (!device || !/^idea-test-[0-9]+$/.test(device)) return null
        const dest = `${this.disksRoot}/${device}`
        const out = await this.ssh(this.hostOf(engineId), `findmnt -no FSTYPE '${dest}' || true`)
        return { device, dest, fsType: String(out ?? '').trim() }
    }

    /**
     * Prefer A r22 FAIL@93: read-only listing of a docked fixture slot root (ls -1A).
     * add_files_role preflight — Eng 8d98718 createFilesDisk refuses an Apps disk
     * whose root holds anything beyond META.yaml/lost+found/apps/services/instances.
     */
    async probeFixtureRootEntries(
        engineId: string,
        diskId: string,
    ): Promise<{ dest: string; entries: string[] } | null> {
        this.assertNotExcluded(engineId, 'probeFixtureRootEntries')
        const device = this.deviceMap(engineId).get(diskId)
            ?? (await this.hasHealthyFixtureTree(engineId, diskId, { requireInstanceData: false, refuseExternalLinks: false }))
        if (!device || !/^idea-test-[0-9]+$/.test(device)) return null
        const dest = `${this.disksRoot}/${device}`
        const out = await this.ssh(this.hostOf(engineId), `ls -1A '${dest}' 2>/dev/null || true`)
        const entries = String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean)
        return { dest, entries }
    }

    private async sshRemoveSentinel(engineId: string, device: string): Promise<void> {
        if (!/^idea-test-[0-9]+$/.test(device)) return
        assertPrivateDurationRoots(this.disksRoot, this.watchDir)
        const host = this.hostOf(engineId)
        const sentinel = `${this.watchDir}/${device}`
        await this.ssh(host, `rm -f '${sentinel}'`).catch(e => {
            console.warn(`[RealFleetOps] sentinel rm ${engineId}:${sentinel}: ${e}`)
        })
    }

    private async waitDiskDocked(
        engineId: string,
        diskId: string,
        timeoutMs = 60_000,
    ): Promise<void> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            try {
                const view = await this.readStore(engineId)
                const disk = view.diskDB[diskId]
                if (disk && disk.dockedTo === engineId) return
                // Also accept dockedTo = live engine id mapped to this logical
                if (disk?.dockedTo) {
                    const live = this.liveIds.get(engineId)
                    if (disk.dockedTo === live || disk.dockedTo === engineId) return
                }
            } catch (e) {
                console.warn(`[RealFleetOps] waitDiskDocked ${engineId}/${diskId}: ${e}`)
            }
            await sleep(500)
        }
        throw new Error(
            `RealFleetOps: disk ${diskId} not docked on ${engineId} within ${timeoutMs}ms ` +
            `(check Engine testMode + IDEA_DISKS_ROOT/IDEA_WATCH_DIR on the Pi)`,
        )
    }

    /**
     * Wait until diskId is not docked on any pool engine (post-eject Automerge settle).
     * Unique-store: ejectDisk is async via engine commands — dockFixture / redockEmptyFresh
     * must not treat a stale dockedTo as "already docked" and no-op a same-engine redock
     * (Prefer A cover-all-6b96ee2-r23 FAIL@91: empty-001 eject→dockFixture no-op on idea01).
     * Public so redockEmptyFresh can wait after undock before dockFixture.
     */
    async waitDiskUndocked(diskId: string, timeoutMs = 60_000): Promise<void> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            try {
                const already = await this.findDockedEngine(diskId)
                if (!already) return
            } catch (e) {
                console.warn(`[RealFleetOps] waitDiskUndocked ${diskId}: ${e}`)
            }
            await sleep(500)
        }
        throw new Error(
            `RealFleetOps: disk ${diskId} still docked after eject within ${timeoutMs}ms`,
        )
    }

    /**
     * If diskId is already docked on any pool engine, return that logical id.
     * Used so infra_dock_fixture can no-op when Atlas/Kid Path A pre-docked.
     * Resolves live uuid → logical; never attributes an unknown dockedTo to pool[0].
     */
    async findDockedEngine(diskId: string): Promise<string | null> {
        for (const id of this.pool) {
            if (this.exclude.includes(id)) continue
            try {
                const view = await this.readStore(id)
                const disk = view.diskDB[diskId]
                if (!disk?.dockedTo) continue
                const docked = disk.dockedTo
                // toSemanticView usually already mapped live→logical
                if (this.pool.includes(docked) || this.exclude.includes(docked)) return docked
                const live = this.liveIds.get(id)
                if (docked === id || (live && docked === live)) return id
                const mapped = this.logicalIds.get(docked)
                if (mapped) return mapped
                for (const pid of this.pool) {
                    if (this.exclude.includes(pid)) continue
                    const plive = this.liveIds.get(pid)
                    if (plive && docked === plive) return pid
                }
            } catch {
                /* try next */
            }
        }
        return null
    }

    async dockFixture(engineId: string, diskId: string): Promise<void> {
        this.assertNotExcluded(engineId, 'dockFixture')
        if (looksLikeProtectedHwDisk(diskId)) {
            throw new Error(`RealFleetOps: refuse to dock protected disk '${diskId}'`)
        }
        resolveDurationFixturePack(diskId) // validate known Kid id
        assertPrivateDurationRoots(this.disksRoot, this.watchDir)

        // No-op only when already on the *requested* host. A pool-wide no-op
        // breaks infra_move_disk: after eject, unique-store may still show
        // dockedTo=from briefly — treat that as "move in progress", not done.
        const already = await this.findDockedEngine(diskId)
        if (already === engineId) {
            console.log(`[RealFleetOps] dockFixture: ${diskId} already docked on ${already} (no-op)`)
            return
        }
        if (already && already !== engineId) {
            if (appPackInstanceData(diskId)) {
                // idea#168 r34@70: an app disk docked elsewhere is carried, not re-seeded.
                console.log(
                    `[RealFleetOps] dockFixture: ${diskId} docked on ${already}; carrying its real tree to ${engineId} (moveDisk)`,
                )
                await this.moveDisk(already, engineId, diskId)
                return
            }
            console.log(
                `[RealFleetOps] dockFixture: ${diskId} on ${already}; ejecting before dock on ${engineId}`,
            )
            await this.undockFixtures([already], diskId)
            await this.waitDiskUndocked(diskId, 60_000)
        }

        // If already docked here, treat as success (idempotent).
        try {
            const view = await this.readStore(engineId)
            const disk = view.diskDB[diskId]
            const live = this.liveIds.get(engineId)
            if (disk?.dockedTo === engineId || (live && disk?.dockedTo === live)) {
                console.log(`[RealFleetOps] dockFixture: ${diskId} already on ${engineId}`)
                return
            }
            // Docked elsewhere in this unique-store view — eject first on this engine only.
            if (disk?.dockedTo) {
                await this.undockFixtures([engineId], diskId)
            }
        } catch {
            // store not ready yet — proceed with copy
        }

        // cover-all-980e735-r29 FAIL@97: dock ONLY on the requested engine. The old
        // "prefer another pool engine with a healthy META tree" fallback silently
        // redirected infra_move_disk@62 (idea01→idea03) back onto idea01 while the
        // caller recorded idea03. Reuse a healthy tree on the requested engine, else
        // fresh-copy into a free idea-test-1..8 slot there; never another engine.
        const target = engineId
        // idea#168 r34@70: throws LOUD on a META-only (stale) app tree — no silent reuse.
        let device = await this.hasHealthyFixtureTree(engineId, diskId)
        const spec = appPackInstanceData(diskId)
        if (!device && spec && this.startInstances) {
            // No tree here. The Kid seed pack ships compose/.env but no instance data, so a
            // fresh copy would start the app unprovisioned (Kolibri → /en/setup). Refuse unless
            // the seed itself carries the data.
            const src = this.fixtureSourcePath(diskId)
            const seed = await this.checkInstanceData(target, src, spec)
            if (!seed.ok) {
                throw new Error(
                    `RealFleetOps: no ${diskId} tree on ${target} (${this.hostOf(target)}:${this.disksRoot}/idea-test-1..${FIXTURE_SLOT_COUNT}) ` +
                        `and the seed pack ${src} has no instance data — ${seed.detail}. Refusing a silent ` +
                        `refresh-from-seed (it would start ${spec.instanceId} without ${spec.keyFile}). ` +
                        `Move the disk's real tree here (infra_move_disk / moveDisk from the host that holds it) or restore it (Path A).`,
                )
            }
        }
        if (!device) {
            // Try idea-test-N slots until copy accepts (skip occupied/mismatched trees).
            // Prefer Atlas slot for empty (idea-test-3) when free.
            let lastErr: unknown
            const preferred = DISK_ID_PREFERRED_DEVICE[diskId]
            const slotOrder = preferred
                ? [preferred, ...Array.from({ length: 8 }, (_, i) => `idea-test-${i + 1}`).filter(s => s !== preferred)]
                : Array.from({ length: 8 }, (_, i) => `idea-test-${i + 1}`)
            for (const candidate of slotOrder) {
                if (this.usedSet(target).has(candidate) && this.deviceMap(target).get(diskId) !== candidate) {
                    continue
                }
                this.usedSet(target).add(candidate)
                this.deviceMap(target).set(diskId, candidate)
                try {
                    await this.sshDockCopy(target, diskId, candidate)
                    device = candidate
                    lastErr = null
                    break
                } catch (e) {
                    lastErr = e
                    this.deviceMap(target).delete(diskId)
                    this.usedSet(target).delete(candidate)
                    const msg = e instanceof Error ? e.message : String(e)
                    if (!/refuse overwrite occupied|exit code: 4/.test(msg)) throw e
                }
            }
            if (!device) {
                throw lastErr instanceof Error
                    ? lastErr
                    : new Error(`RealFleetOps: no free idea-test-N for ${diskId} on ${target}`)
            }
        } else {
            await this.sshDockCopy(target, diskId, device)
        }
        // Path A after UI eject: chokidar can lag; allow 120s and one sentinel re-fire.
        try {
            await this.waitDiskDocked(target, diskId, 120_000)
        } catch (e) {
            console.warn(
                `[RealFleetOps] dockFixture: waitDiskDocked failed once on ${target}/${diskId}; ` +
                `re-firing sentinel (unlink+sleep+touch) and retrying: ${e}`,
            )
            await this.sshDockCopy(target, diskId, device)
            await this.waitDiskDocked(target, diskId, 120_000)
        }
    }

    /**
     * Move a fixture disk fromEngine → toEngine like a real USB disk move.
     *
     * idea#168 r34@70: app packs (Kolibri / Nextcloud Grade5A) carry the SOURCE disk's real
     * tree — the walk's earlier instance state (Kolibri db.sqlite3 with Grade 5A, lessons,
     * progress) — to the target (moveDiskTree). Never a seed copy, never a reuse of whatever
     * tree the target happens to hold. Empty packs keep their documented always-fresh-copy dock.
     * Either way the landing is store-verified (r29).
     */
    async moveDisk(fromEngine: string, toEngine: string, diskId: string): Promise<void> {
        this.assertNotExcluded(fromEngine, 'moveDisk(from)')
        this.assertNotExcluded(toEngine, 'moveDisk(to)')
        if (fromEngine === toEngine) {
            await this.dockFixture(toEngine, diskId)
            return
        }
        if (looksLikeProtectedHwDisk(diskId)) {
            throw new Error(`RealFleetOps: refuse to move protected disk '${diskId}'`)
        }
        if (appPackInstanceData(diskId)) {
            try {
                await this.moveDiskTree(fromEngine, toEngine, diskId)
            } catch (e) {
                const err = e instanceof Error ? e.message : String(e)
                throw new Error(
                    `RealFleetOps.moveDisk ${fromEngine}→${toEngine}: target ${toEngine} could not take ${diskId}: ${err}`,
                )
            }
        } else {
            await this.undockFixtures([fromEngine], diskId)
            // Eject is async (engine command + Automerge); wait before dock or
            // dockFixture may see stale dockedTo and skip the target host (r25).
            await this.waitDiskUndocked(diskId, 60_000)
            try {
                await this.dockFixture(toEngine, diskId)
            } catch (e) {
                const err = e instanceof Error ? e.message : String(e)
                throw new Error(
                    `RealFleetOps.moveDisk: target ${toEngine} could not take ${diskId}: ${err}`,
                )
            }
        }
        // r29: verify the landing in the store — never trust the request.
        const landed = await this.findDockedEngine(diskId)
        if (landed !== toEngine) {
            throw new Error(
                `RealFleetOps.moveDisk: ${diskId} requested on ${toEngine} but store shows ` +
                    `${landed ?? 'not docked anywhere'} (r29 FAIL@97 class). No soft-pass.`,
            )
        }
    }

    /** Poll `docker ps` on engineId until no container of these instances runs (compose name `<id>-…`). */
    private async waitInstanceContainersGone(engineId: string, instanceIds: string[], timeoutMs: number): Promise<string[]> {
        const ids = instanceIds.filter(id => /^[A-Za-z0-9_.-]+$/.test(id))
        if (!ids.length) return []
        const host = this.hostOf(engineId)
        const deadline = Date.now() + timeoutMs
        let running: string[] = []
        for (;;) {
            const out = await this.ssh(
                host,
                ids.map(id => `docker ps --filter name='^${id}-' --format '{{.Names}}' 2>/dev/null || true`).join('; '),
            ).catch(() => '')
            running = String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean)
            if (!running.length || Date.now() >= deadline) return running
            await sleep(2_000)
        }
    }

    /**
     * idea#168 r34@70: the real-disk move for app packs. Order (every check that can refuse
     * runs before anything changes):
     *  1. source tree: the one idea-test-N on fromEngine with this diskId AND its instance data
     *     (hasHealthyFixtureTree — loud if stale); no symlink resolving outside the slot
     *     (idea#168 r35@62: refused, never materialized); not a mount point; no dangling links.
     *  2. target: no tree with this diskId already (a stale duplicate is refused, never reused);
     *     a free idea-test-1..8 slot.
     *  2b. idea#168 r35@62 preflight: no running container on fromEngine OTHER than the disk's own
     *     instances (which the eject stops) has a mount that resolves inside the source slot
     *     (docker inspect). Else refuse BEFORE the eject, naming container(s) and path(s). Never
     *     stops a foreign container.
     *  3. eject on fromEngine (ejectDisk + sentinel removed), wait until undocked AND the
     *     instance containers are gone (the Engine stops them after clearing dockedTo; never copy
     *     a live DB).
     *  3b. idea#168 r35@62 quiescence: re-scan after the eject — NO running container may mount
     *     anything inside the slot any more; else refuse before the tar (source left ejected).
     *  4. stream the slot source → target staging through the walker (tar, owners/modes kept).
     *     tar "file changed as we read it" (exit 1) stays a failure.
     *  5. verify: per-file content digest of source == staging, incl. sha256 of the key file
     *     (Kolibri db.sqlite3). Mismatch → staging removed, source left intact, loud.
     *     idea#168 r35@62: the pack's moveSkipDirs (Kolibri data/kolibri/sessions: root 0600
     *     Django session files, unreadable as pi) are left out of the tar and both digests,
     *     then recreated EMPTY in staging (source mode/owner, else 1777).
     *  6. commit staging → slot on the target; re-check instance data there.
     *  7. quarantine the source slot to <disksRoot>/.moved-away/ (the disk left that host).
     *  8. fire the target sentinel; wait until the store shows it docked on toEngine.
     * Failure after the eject (3b–6): the target staging is removed AND verified gone (or the
     * message says it is still there); the source is left EJECTED (undocked, sentinel removed)
     * with its tree intact and is NOT re-docked by the harness (a re-dock would restart its
     * instances and hide the state the failure must be diagnosed from); the message says so.
     * The move duration (total + phases) is logged on success and carried in the error.
     */
    private async moveDiskTree(fromEngine: string, toEngine: string, diskId: string): Promise<void> {
        const t0 = Date.now()
        const phases: string[] = []
        let tPhase = t0
        const phase = (name: string) => {
            const now = Date.now()
            phases.push(`${name} ${now - tPhase}ms`)
            tPhase = now
        }
        const timing = () => `${Date.now() - t0}ms${phases.length ? ` (${phases.join(', ')})` : ''}`
        try {
            await this.moveDiskTreeSteps(fromEngine, toEngine, diskId, phase)
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            console.log(`[RealFleetOps] moveDisk ${diskId} ${fromEngine}→${toEngine}: FAILED after ${timing()}`)
            throw new Error(`${err} [move_duration_ms=${Date.now() - t0}; failed after ${timing()}]`)
        }
        console.log(`[RealFleetOps] moveDisk ${diskId} ${fromEngine}→${toEngine}: done in ${timing()}`)
    }

    private async moveDiskTreeSteps(fromEngine: string, toEngine: string, diskId: string, phase: (name: string) => void): Promise<void> {
        const spec = appPackInstanceData(diskId)!
        resolveDurationFixturePack(diskId)
        assertPrivateDurationRoots(this.disksRoot, this.watchDir)
        const srcHost = this.hostOf(fromEngine)
        const dstHost = this.hostOf(toEngine)

        // Instance data is required whenever instances run (Path A --start-instances); dock-only
        // smoke strips instances/, so there the tree is carried without a data precondition.
        const requireData = this.startInstances

        // 1. Source tree (loud if META-only / duplicated / links out of the slot).
        const srcDevice = await this.hasHealthyFixtureTree(fromEngine, diskId, { requireInstanceData: requireData })
        if (!srcDevice) {
            throw new Error(
                `source ${fromEngine} (${srcHost}) has no tree for ${diskId} under ${this.disksRoot}/idea-test-1..${FIXTURE_SLOT_COUNT} ` +
                    `— nothing real to move. No refresh-from-seed.`,
            )
        }
        const srcSlot = `${this.disksRoot}/${srcDevice}`
        const skipDirs = spec.moveSkipDirs ?? []
        const skipPatterns = skipDirs.map(skipDirTarPattern)
        const plan = parseMovePlan(await this.ssh(srcHost, buildMovePlanRemote(srcSlot, this.sudoMode, skipDirs)))
        if (plan.error) throw new Error(`source ${fromEngine}:${srcSlot}: ${plan.error}`)
        if (plan.mountFsType) {
            throw new Error(
                `source ${fromEngine}:${srcSlot} is a mount point (${plan.mountFsType}; loop image?). Moving a ` +
                    `loop-backed slot needs losetup/mount (root) on ${toEngine}; app slots are plain dirs in Path A. Refusing.`,
            )
        }
        if (plan.dangling.length) {
            throw new Error(
                `source ${fromEngine}:${srcSlot} has dangling symlink(s) ${plan.dangling.join(', ')} — data missing on the source; refusing to move.`,
            )
        }
        if (plan.extLinks.length) {
            // hasHealthyFixtureTree refused these already; a link that appeared since is refused too.
            throw new Error(
                `refuse to move ${diskId}: source ${fromEngine} (${srcHost}) slot ${srcSlot} has symlink(s) resolving OUTSIDE the slot — ` +
                    plan.extLinks.map(l => `${srcSlot}/${l.rel} → ${l.target}`).join('; ') +
                    `. A real disk carries its data inside the disk; not materialized (idea#168 r35@62). Replace the link(s) ` +
                    `with the real data in the slot (Path A). Nothing changed: ${diskId} still docked on ${fromEngine}.`,
            )
        }

        // 2. Target: no duplicate, a free slot.
        const dstSlots = await this.scanFixtureSlots(toEngine, diskId)
        const dup = dstSlots.filter(sl => sl.state === 'MATCH')
        if (dup.length) {
            throw new Error(
                `target ${toEngine} (${dstHost}) already holds a tree for ${diskId} at ` +
                    dup.map(d => `${this.disksRoot}/${d.device}`).join(', ') +
                    ` (stale duplicate). A disk cannot be on two hosts; refusing to reuse or overwrite it — purge it (Path A).`,
            )
        }
        const used = this.usedSet(toEngine)
        const free = dstSlots.find(sl => sl.state === 'FREE' && !used.has(sl.device))
        if (!free) {
            throw new Error(
                `target ${toEngine} (${dstHost}): no free idea-test-1..${FIXTURE_SLOT_COUNT} slot for ${diskId} ` +
                    `(${dstSlots.map(sl => `${sl.device}=${sl.state}`).join(' ')})`,
            )
        }
        const dstDevice = free.device
        const dstSlot = `${this.disksRoot}/${dstDevice}`
        const staging = `${this.disksRoot}/.incoming-${dstDevice}-${diskId}`

        // 2b. idea#168 r35@62: no foreign container may use the source slot's data. Own instances
        // are stopped by the eject; anything else would keep writing while we tar.
        const mountRoots = [srcSlot]
        const pre = await this.foreignMountHits(fromEngine, mountRoots, plan.instances)
        if (pre.foreign.length) {
            throw new Error(
                `refuse to eject/move ${diskId}: on ${fromEngine} (${srcHost}) running container(s) that are not instances of ` +
                    `${diskId} (${plan.instances.join(', ') || 'none'}) use data inside its slot ${srcSlot} — ${describeMountHits(pre.foreign)}. ` +
                    `Ejecting ${diskId} does not stop them, so the move would tar data they are writing (r35@62 "file changed as we read it"). ` +
                    `NOT stopping them (the harness never stops foreign containers): stop/remove them through their owner (Engine/Console) ` +
                    `or Path A, then re-run. Nothing changed: ${diskId} still docked on ${fromEngine}, tree intact.`,
            )
        }
        phase('preflight')

        // 3. Eject on the source; wait for undock + containers gone.
        console.log(
            `[RealFleetOps] moveDisk ${diskId}: ejecting on ${fromEngine} (${srcSlot}) before carrying it to ${toEngine}:${dstSlot}`,
        )
        await this.undockFixtures([fromEngine], diskId)
        await this.waitDiskUndocked(diskId, 60_000)
        this.releaseTestDevice(fromEngine, diskId)
        const ejectedState =
            `${diskId} left EJECTED on ${fromEngine} (undocked, sentinel ${this.watchDir}/${srcDevice} removed), tree intact at ` +
            `${fromEngine}:${srcSlot}; NOT re-docked by the harness (a re-dock would restart its instances and hide this state) — ` +
            `re-dock or repair it (Path A) before the next run`
        const stillRunning = await this.waitInstanceContainersGone(fromEngine, plan.instances, 90_000)
        if (stillRunning.length) {
            throw new Error(
                `source ${fromEngine}: container(s) ${stillRunning.join(', ')} still running 90s after ejecting ${diskId}; ` +
                    `refusing to copy live instance data. Source tree left intact (undocked) at ${srcSlot}. Source: ${ejectedState}.`,
            )
        }
        // 3b. idea#168 r35@62 quiescence: after the eject NOTHING running may mount the slot.
        const post = await this.foreignMountHits(fromEngine, mountRoots, []).catch(e => {
            throw new Error(`${e instanceof Error ? e.message : String(e)} (after the eject). Source: ${ejectedState}. No staging created on ${toEngine}.`)
        })
        if (post.foreign.length) {
            throw new Error(
                `refuse to stream ${diskId}: after the eject on ${fromEngine} (${srcHost}) running container(s) still use data inside ` +
                    `${srcSlot} — ${describeMountHits(post.foreign)}. The source is not quiescent; NOT stopping them. ` +
                    `Source: ${ejectedState}. No staging created on ${toEngine}.`,
            )
        }
        phase('eject')

        // 4. Stream source → target staging.
        const srcDigestRoot = srcSlot
        try {
            console.log(`[RealFleetOps] moveDisk ${diskId}: streaming ${fromEngine}:${srcSlot} → ${toEngine}:${staging}`)
            await this.relayPipe(
                srcHost, buildTreeSendRemote(srcSlot, [], this.sudoMode, skipPatterns),
                dstHost, buildTreeReceiveRemote(staging, this.sudoMode),
            )
            phase('stream')
            // 5. Verify content.
            const [a, b] = await Promise.all([
                this.ssh(srcHost, buildTreeDigestRemote(srcDigestRoot, spec.keyFile, this.sudoMode, skipPatterns)),
                this.ssh(dstHost, buildTreeDigestRemote(staging, spec.keyFile, this.sudoMode, skipPatterns)),
            ])
            const da = parseTreeDigest(a)
            const db = parseTreeDigest(b)
            if ('error' in da) throw new Error(`source digest failed on ${fromEngine}:${srcSlot}: ${da.error}`)
            if ('error' in db) throw new Error(`target digest failed on ${toEngine}:${staging}: ${db.error}`)
            if (da.files !== db.files || da.tree !== db.tree || da.key !== db.key) {
                throw new Error(
                    `content mismatch after transfer: source ${da.files} files tree ${da.tree.slice(0, 12)} key ${da.key.slice(0, 12)} ` +
                        `vs target ${db.files} files tree ${db.tree.slice(0, 12)} key ${db.key.slice(0, 12)}`,
                )
            }
            if (requireData && da.key === 'none') throw new Error(`key instance file ${spec.keyFile} missing in the source tree`)
            // 5b. idea#168 r35@62: skip dirs (Kolibri sessions) were not carried — recreate them
            // EMPTY in staging so the committed slot has them (Django file sessions need the dir).
            if (skipDirs.length) {
                const out = await this.ssh(dstHost, buildRecreateSkipDirsRemote(
                    staging,
                    skipDirs.map(rel => {
                        const st = plan.skipDirs.find(d => d.rel === rel)
                        return { rel, src: st ? { mode: st.mode, uid: st.uid, gid: st.gid } : null }
                    }),
                    this.sudoMode,
                ))
                for (const line of String(out ?? '').split('\n').map(x => x.trim()).filter(x => x.startsWith('SKIPDIR '))) {
                    console.log(`[RealFleetOps] moveDisk ${diskId}: ${toEngine}: ${line.slice(8)} (contents not carried: throwaway)`)
                }
            }
            // 6. Commit on the target and re-check its instance data there.
            await this.ssh(dstHost, buildCommitMovedTreeRemote(staging, dstSlot, this.sudoMode))
            used.add(dstDevice)
            this.deviceMap(toEngine).set(diskId, dstDevice)
            console.log(
                `[RealFleetOps] moveDisk ${diskId}: carried ${da.files} files ${fromEngine}:${srcSlot} → ${toEngine}:${dstSlot} ` +
                    `(tree sha256 ${da.tree}, ${spec.keyFile} sha256 ${da.key})`,
            )
            phase('verify+commit')
        } catch (e) {
            // idea#168 r35@62: verify the staging is really gone instead of assuming the rm worked.
            const cleanup = await this.ssh(dstHost, buildStagingCleanupRemote(staging, this.sudoMode))
                .catch(err => `STAGING_UNKNOWN ${err instanceof Error ? err.message : String(err)}`)
            const left = /STAGING_LEFT\s*(.*)/.exec(cleanup)
            const stagingState = /STAGING_GONE/.test(cleanup)
                ? `Staging ${toEngine}:${staging} removed (verified absent)`
                : left
                    ? `Staging ${toEngine}:${staging} NOT removed (still there: ${left[1]!.trim()}) — remove it before the next run`
                    : `Staging ${toEngine}:${staging} state UNKNOWN (cleanup did not report: ${cleanup.trim().slice(0, 200)}) — check and remove it before the next run`
            const err = e instanceof Error ? e.message : String(e)
            console.log(`[RealFleetOps] moveDisk ${diskId}: stream/verify failed — ${stagingState}; source ${ejectedState}`)
            throw new Error(`${err}. ${stagingState}; source tree left intact (undocked) at ${fromEngine}:${srcSlot}. Source: ${ejectedState}.`)
        }
        const landedData = requireData ? await this.checkInstanceData(toEngine, dstSlot, spec) : { ok: true, detail: 'dock-only' }
        if (!landedData.ok) {
            throw new Error(
                `moved tree ${toEngine}:${dstSlot} fails the instance-data check after commit — ${landedData.detail}. ` +
                    `Source tree left intact (undocked) at ${fromEngine}:${srcSlot}.`,
            )
        }

        // 7. The disk has left the source host.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const quarantine = `${this.disksRoot}/.moved-away/${srcDevice}-${diskId}-${stamp}`
        await this.ssh(srcHost, buildQuarantineSourceRemote(srcSlot, quarantine))
        console.log(`[RealFleetOps] moveDisk ${diskId}: source slot ${fromEngine}:${srcSlot} → ${quarantine} (disk left ${fromEngine})`)

        // 8. Dock on the target (sentinel), wait for the store; one re-fire like dockFixture.
        const sentinel = `${this.watchDir}/${dstDevice}`
        await this.ssh(dstHost, buildFireSentinelRemote(this.watchDir, sentinel))
        try {
            await this.waitDiskDocked(toEngine, diskId, 120_000)
        } catch (e) {
            console.warn(`[RealFleetOps] moveDisk: waitDiskDocked failed once on ${toEngine}/${diskId}; re-firing sentinel: ${e}`)
            await this.ssh(dstHost, buildFireSentinelRemote(this.watchDir, sentinel))
            await this.waitDiskDocked(toEngine, diskId, 120_000)
        }
        phase('dock')
    }

    /**
     * Prefer A r36: Automerge instanceDB rows with storedOn=diskId survive FS wipe
     * (dockFixture empty always-fresh-copy). Console hasInstancesOn keys off store
     * → still shows app / no EmptyDiskPanel after redock alone. Delete matching
     * keys; stop Running/Starting duration docker by exact instance id (same
     * careful filter as reconcileDurationZombies — duration fixtures only, never
     * idea166-*). Set disk.diskTypes=['empty'] when the disk row is present.
     */
    async purgeInstancesStoredOn(engineId: string, diskId: string): Promise<void> {
        this.assertNotExcluded(engineId, 'purgeInstancesStoredOn')
        if (looksLikeProtectedHwDisk(diskId)) {
            throw new Error(`RealFleetOps: refuse to purge instances on protected disk '${diskId}'`)
        }
        if (!looksLikeDurationFixtureId(diskId)) {
            throw new Error(
                `RealFleetOps: refuse to purge instances on non-duration disk '${diskId}'`,
            )
        }
        const conn = await this.connect(engineId)
        const doc = conn.storeHandle.doc()
        if (!doc) {
            throw new Error(`RealFleetOps: store doc not ready for ${engineId}`)
        }
        const host = this.hostOf(engineId)
        const toPurge: { id: string; status: string }[] = []
        for (const [id, inst] of Object.entries(doc.instanceDB ?? {})) {
            if (!inst) continue
            if (String((inst as { storedOn?: unknown }).storedOn) !== String(diskId)) continue
            toPurge.push({
                id: String((inst as { id?: unknown }).id ?? id),
                status: String((inst as { status?: unknown }).status ?? ''),
            })
        }
        const stopped: string[] = []
        for (const inst of toPurge) {
            if (inst.status !== 'Running' && inst.status !== 'Starting') continue
            const idHits =
                looksLikeDurationFixtureId(inst.id) || looksLikeDurationFixtureId(diskId)
            if (!idHits) continue
            const needle = inst.id.replace(/'/g, '')
            if (!needle || needle.includes('idea166-')) continue
            try {
                const remote =
                    `ids=$(docker ps -aq --filter name='${needle}' 2>/dev/null); ` +
                    `if test -n "$ids"; then echo "$ids" | xargs -r docker stop; ` +
                    `echo "$ids" | xargs -r docker rm; echo '${needle}'; ` +
                    `else echo ""; fi`
                const out = (await this.ssh(host, remote)).trim()
                if (out) stopped.push(needle)
            } catch (e) {
                console.warn(
                    `[RealFleetOps] purgeInstancesStoredOn: docker stop ${inst.id} ` +
                    `on ${host} failed: ${e}`,
                )
            }
        }
        if (stopped.length) {
            console.log(
                `[RealFleetOps] purgeInstancesStoredOn: stopped docker ` +
                `${stopped.join(', ')} on ${host}`,
            )
            await sleep(1500)
        }
        const purgeIds = toPurge.map(i => i.id)
        conn.storeHandle.change(s => {
            for (const id of purgeIds) {
                if (s.instanceDB[id as keyof typeof s.instanceDB]) {
                    delete s.instanceDB[id as keyof typeof s.instanceDB]
                }
            }
            const disk = s.diskDB[diskId as keyof typeof s.diskDB] as
                | { diskTypes?: string[] }
                | undefined
            if (disk) {
                disk.diskTypes = ['empty']
            }
        })
        console.log(
            `[RealFleetOps] purgeInstancesStoredOn: deleted ${purgeIds.length} instance(s) ` +
            `storedOn=${diskId} on ${engineId}` +
            (purgeIds.length ? ` (${purgeIds.join(', ')})` : ''),
        )
    }

    /** Drop all open WS connections (tests / process exit). */
    async close(): Promise<void> {
        await Promise.allSettled([...this.connecting.values()])
        const ids = [...this.conns.keys()]
        for (const id of ids) await this.disconnect(id, 'walker closing')
    }

    getDisksRoot(): string { return this.disksRoot }
    getWatchDir(): string { return this.watchDir }
}
