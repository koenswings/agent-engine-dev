/**
 * RealFleetOps — live fleet adapter for duration-tests (idea#166).
 *
 * Connects over Tailscale/SSH + Automerge WS. Prefer Engine ejectDisk over
 * physical USB yank. Kid fixture dock (testMode) =
 *   copy pack → private IDEA_DISKS_ROOT/idea-test-N/ + sentinel under IDEA_WATCH_DIR
 * Defaults (Atlas-approved): /home/pi/idea/duration-disks + duration-watch.
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
}

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
 * matching META tree (docker-owned instances → no wipe).
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
    parts.push(
        `test -d '${src}' || { echo "missing fixture source ${src}" >&2; exit 2; }`,
        `rm -rf '${dest}'`,
        `mkdir -p '${dest}'`,
        `cp -a '${src}/.' '${dest}/'`,
        stripInstances,
        `test -f '${dest}/META.yaml' || { echo "META.yaml missing after copy into ${dest}" >&2; exit 3; }`,
        // Atlas: chokidar needs unlink+create after eject, not mtime-only touch.
        `rm -f '${sentinel}'; sleep 5; touch '${sentinel}'`,
    )
    return parts.join('; ')
}

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
    private readonly healthWrapBefore?: string
    private readonly healthWrapAfter?: string
    private readonly storeUrls: Record<string, string>
    private readonly disksRoot: string
    private readonly watchDir: string
    private readonly fixtureSourceRoot: string
    private readonly startInstances: boolean
    private readonly pm2ReconnectTimeoutMs: number
    private readonly conns = new Map<string, Conn>()
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
        this.pm2ReconnectTimeoutMs = opts.pm2ReconnectTimeoutMs ?? PM2_RECONNECT_TIMEOUT_MS
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

    private async ssh(host: string, remoteCmd: string): Promise<string> {
        const result = await $`ssh ${sshOpts} ${`${this.sshUser}@${host}`} ${remoteCmd}`
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

    private async disconnect(logicalId: string): Promise<void> {
        const c = this.conns.get(logicalId)
        if (!c) return
        this.conns.delete(logicalId)
        try {
            await c.repo.shutdown()
        } catch {
            // ignore shutdown races after reboot
        }
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

    private async connect(logicalId: string, forceNew = false): Promise<Conn> {
        if (!forceNew) {
            const existing = this.conns.get(logicalId)
            if (existing) {
                try {
                    const doc = existing.storeHandle.doc()
                    if (doc) return existing
                } catch {
                    await this.disconnect(logicalId)
                }
            }
        } else {
            await this.disconnect(logicalId)
        }

        const host = this.hostOf(logicalId)
        const docId = await this.fetchStoreDocId(logicalId)
        const url = `ws://${host}:${this.enginePort}`
        console.log(`[RealFleetOps] Connecting ${logicalId} at ${url} (doc ${docId})`)

        const adapter = new WebSocketClientAdapter(url, 2000)
        const repo = new Repo({
            network: [adapter],
            peerId: `duration-${logicalId}-${Date.now()}` as PeerId,
        })
        const storeHandle = await repo.find<Store>(docId)
        await storeHandle.whenReady()

        const store = storeHandle.doc()
        const liveEngineId = store ? this.discoverLiveEngineId(store, logicalId) : null
        this.rememberMapping(logicalId, liveEngineId)
        console.log(
            `[RealFleetOps] Connected ${logicalId} → liveEngineId=${liveEngineId ?? 'unknown'} ` +
            `hostname=${liveEngineId && store?.engineDB[liveEngineId as keyof typeof store.engineDB]
                ? (store.engineDB[liveEngineId as keyof typeof store.engineDB] as { hostname?: string }).hostname
                : '?'}`,
        )

        const conn: Conn = { repo, storeHandle, host, logicalId, liveEngineId, storeDocId: docId }
        this.conns.set(logicalId, conn)
        return conn
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
                const ready = await this.waitReady(id, 3_000)
                wsUp = ready.wsUp
            } catch {
                wsUp = false
            }
            let dockerOk: boolean | undefined
            let statusAnomaly: string | undefined
            if (wsUp) {
                try {
                    const view = await this.readStore(id)
                    const running = Object.values(view.instanceDB).filter(i => i.status === 'Running')
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
                details.push(`${id}: WS down`)
            }
            engines.push({ id, wsUp, dockerOk, statusAnomaly })
        }
        return {
            ok,
            detail: ok ? 'stability ok' : details.join('; '),
            engines,
        }
    }

    async waitReady(engineId: string, timeoutMs: number): Promise<SettleReady> {
        const start = Date.now()
        let wsUp = false
        let storeSynced = false
        let attempt = 0
        while (Date.now() - start < timeoutMs) {
            attempt++
            try {
                // First try reuse; on later attempts force reconnect (post-reboot).
                const force = attempt > 1 && !this.conns.has(engineId)
                await this.connect(engineId, force)
                let doc = this.conns.get(engineId)?.storeHandle.doc()
                if (!doc) {
                    await this.connect(engineId, true)
                    doc = this.conns.get(engineId)?.storeHandle.doc()
                }
                wsUp = !!doc
                if (doc) {
                    const live = this.discoverLiveEngineId(doc, engineId)
                    this.rememberMapping(engineId, live)
                    storeSynced = live != null && !!doc.engineDB[live as keyof typeof doc.engineDB]
                    // Unique-mode settle: WS up is the hard gate; storeSynced is best-effort.
                    return { wsUp: true, storeSynced }
                }
            } catch {
                wsUp = false
                storeSynced = false
                await this.disconnect(engineId)
            }
            await sleep(500)
        }
        return { wsUp, storeSynced }
    }

    async readStore(engineId: string): Promise<SemanticStoreView> {
        const conn = await this.connect(engineId)
        const doc = conn.storeHandle.doc()
        if (!doc) {
            throw new Error(`RealFleetOps: store doc not ready for ${engineId}`)
        }
        return structuredClone(this.toSemanticView(engineId, doc))
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
        await this.disconnect(engineId)

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

        // Docker containers can survive pm2 restart; Automerge may reconnect with
        // Running instances whose disks are Undocked → no_zombie_instances. Clear
        // Path A duration fixtures only (never idea166-* / Intenso).
        await this.reconcileDurationZombies(engineId)

        await this.runHealthWrap(this.healthWrapAfter)
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


    /** SSH: idea-test-N whose META.yaml diskId matches (not merely META present). */
    private async hasHealthyFixtureTree(engineId: string, diskId: string): Promise<string | null> {
        const map = this.deviceMap(engineId)
        const preferred = map.get(diskId)
        const host = this.hostOf(engineId)
        const candidates = preferred
            ? [preferred]
            : ['idea-test-1', 'idea-test-2', 'idea-test-3', 'idea-test-4']
        for (const device of candidates) {
            if (!/^idea-test-[0-9]+$/.test(device)) continue
            const meta = `${this.disksRoot}/${device}/META.yaml`
            // Quote diskId for grep -F; refuse mismatched packs (e.g. nextcloud slot for kolibri).
            try {
                await this.ssh(
                    host,
                    `test -f '${meta}' && grep -Fq 'diskId: ${diskId}' '${meta}'`,
                )
                map.set(diskId, device)
                this.usedSet(engineId).add(device)
                return device
            } catch {
                /* try next */
            }
        }
        return null
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
     * Unique-store: ejectDisk is async via engine commands — dockFixture must not
     * treat a stale dockedTo as "already docked" and no-op a move.
     */
    private async waitDiskUndocked(diskId: string, timeoutMs = 60_000): Promise<void> {
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

        // Prefer an engine that already has a healthy Path A META.yaml tree
        let target = engineId
        let device = await this.hasHealthyFixtureTree(engineId, diskId)
        if (!device) {
            for (const id of this.pool) {
                if (this.exclude.includes(id) || id === engineId) continue
                device = await this.hasHealthyFixtureTree(id, diskId)
                if (device) {
                    target = id
                    console.log(`[RealFleetOps] dockFixture: prefer ${target} (healthy tree ${device})`)
                    break
                }
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
        await this.undockFixtures([fromEngine], diskId)
        // Eject is async (engine command + Automerge); wait before dock or
        // dockFixture may see stale dockedTo and skip the target host (r25).
        await this.waitDiskUndocked(diskId, 60_000)
        await this.dockFixture(toEngine, diskId)
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
        const ids = [...this.conns.keys()]
        for (const id of ids) await this.disconnect(id)
    }

    getDisksRoot(): string { return this.disksRoot }
    getWatchDir(): string { return this.watchDir }
}
