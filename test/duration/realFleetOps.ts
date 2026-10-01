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

    async rebootEngine(engineId: string, fast: boolean): Promise<void> {
        this.assertNotExcluded(engineId, 'rebootEngine')
        const host = this.hostOf(engineId)
        await this.runHealthWrap(this.healthWrapBefore)
        await this.disconnect(engineId)

        if (fast) {
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

    /** Allocate idea-test-N on this engine for diskId (stable if already assigned). */
    private allocateTestDevice(engineId: string, diskId: string): string {
        const map = this.deviceMap(engineId)
        const existing = map.get(diskId)
        if (existing) return existing
        const used = this.usedSet(engineId)
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
        const stripInstances = this.startInstances ? ':' : `rm -rf '${dest}/instances'`
        // Reuse Atlas/Kid Path A tree when present — never rm -rf over live instance data
        // (docker-owned files → Permission denied). Parent: infra_dock may no-op/ok.
        const remote = [
            'set -euo pipefail',
            `mkdir -p '${this.disksRoot}' '${this.watchDir}'`,
            `if test -f '${dest}/META.yaml'; then`,
            `  echo "RealFleetOps: reuse existing Path A tree at ${dest}"`,
            `  touch '${sentinel}'`,
            `  exit 0`,
            `fi`,
            `test -d '${src}' || { echo "missing fixture source ${src}" >&2; exit 2; }`,
            `rm -rf '${dest}'`,
            `mkdir -p '${dest}'`,
            `cp -a '${src}/.' '${dest}/'`,
            stripInstances,
            `test -f '${dest}/META.yaml' || { echo "META.yaml missing after copy into ${dest}" >&2; exit 3; }`,
            `touch '${sentinel}'`,
        ].join('; ')
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
     * If diskId is already docked on any pool engine, return that logical id.
     * Used so infra_dock_fixture can no-op when Atlas/Kid Path A pre-docked.
     */
    async findDockedEngine(diskId: string): Promise<string | null> {
        for (const id of this.pool) {
            if (this.exclude.includes(id)) continue
            try {
                const view = await this.readStore(id)
                const disk = view.diskDB[diskId]
                if (!disk?.dockedTo) continue
                const live = this.liveIds.get(id)
                if (disk.dockedTo === id || (live && disk.dockedTo === live)) return id
                // unique-store: dockedTo may be live uuid — still counts as docked on this view
                if (disk.dockedTo) return id
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

        // Pool-wide no-op when Atlas/Kid already Path A docked.
        const already = await this.findDockedEngine(diskId)
        if (already) {
            console.log(`[RealFleetOps] dockFixture: ${diskId} already docked on ${already} (no-op)`)
            return
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

        const device = this.allocateTestDevice(engineId, diskId)
        await this.sshDockCopy(engineId, diskId, device)
        await this.waitDiskDocked(engineId, diskId, 60_000)
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
        await this.dockFixture(toEngine, diskId)
    }

    /** Drop all open WS connections (tests / process exit). */
    async close(): Promise<void> {
        const ids = [...this.conns.keys()]
        for (const id of ids) await this.disconnect(id)
    }

    getDisksRoot(): string { return this.disksRoot }
    getWatchDir(): string { return this.watchDir }
}
