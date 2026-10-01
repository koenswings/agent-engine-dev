/**
 * RealFleetOps — live fleet adapter for duration-tests (idea#166).
 *
 * Connects over Tailscale/SSH + Automerge WS. Prefer Engine eject commands over
 * physical USB. Physical dock/move requires Kid fixture disks (not on Pis yet).
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
    private readonly conns = new Map<string, Conn>()
    /** logical pool id → live engineDB key */
    private readonly liveIds = new Map<string, string>()
    /** live engineDB key → logical pool id */
    private readonly logicalIds = new Map<string, string>()

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
            // Brief pause then wait for WS
            await sleep(2000)
            const ready = await this.waitReady(engineId, 60_000)
            if (!ready.wsUp) {
                throw new Error(`RealFleetOps: ${engineId} WS not up after pm2 restart`)
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
            const ready = await this.waitReady(engineId, 180_000)
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
            } catch (e) {
                if (e instanceof Error && /refuse to eject/.test(e.message)) throw e
                console.warn(`[RealFleetOps] undockFixtures ${logicalId}/${diskId}: ${e}`)
            }
        }
    }

    async dockFixture(engineId: string, diskId: string): Promise<void> {
        this.assertNotExcluded(engineId, 'dockFixture')
        throw new Error(
            `RealFleetOps: dockFixture requires physical Kid fixture disk ${diskId} on ${engineId}; ` +
            `not present (duration-kolibri-grade5a-001 / duration-nextcloud-grade5a-001). ` +
            `Use scenario minimal-live for reboot-only smoke.`,
        )
    }

    async moveDisk(fromEngine: string, toEngine: string, diskId: string): Promise<void> {
        this.assertNotExcluded(fromEngine, 'moveDisk(from)')
        this.assertNotExcluded(toEngine, 'moveDisk(to)')
        throw new Error(
            `RealFleetOps: moveDisk requires physical Kid fixture disk ${diskId} ` +
            `(${fromEngine}→${toEngine}); not present. Use scenario minimal-live for reboot-only smoke.`,
        )
    }

    /** Drop all open WS connections (tests / process exit). */
    async close(): Promise<void> {
        const ids = [...this.conns.keys()]
        for (const id of ids) await this.disconnect(id)
    }
}
