/**
 * StaticPeers.ts: an opt-in static peer list (idea#168 follow-up)
 *
 * The Engine links peers via mDNS discovery only (mdnsMonitor → manageDiscoveredPeers
 * → connectEngine). Where mDNS is off (the pool), Engines never sync. This module
 * dials a fixed list of peers through the SAME connectEngine path instead.
 *
 * Config: IDEA_STATIC_PEERS=host[:port],host[:port],...  (env var; wins), or
 *         settings.staticPeers in config.yaml (same string format).
 *   - host: an IPv4 address or a hostname (resolved to IPv4 before dialling).
 *   - port: optional; defaults to the Engine's own peer port (config settings.port,
 *     4321 in config.yaml, overridable with IDEA_ENGINE_PORT).
 *   - Whitespace around entries is ignored; empty entries are skipped.
 *   - Invalid entries (bad host characters, port not 1..65535) are SKIPPED with a
 *     warning; valid entries still run. Duplicate entries are dialled once.
 * Unset or empty: nothing runs (no timers, no logs); behaviour is unchanged.
 *
 * Per peer:
 *   - The host is resolved to IPv4; the connection key is `${ip}:${port}`, the
 *     same key the mDNS path uses, so a peer also found by mDNS is not dialled twice.
 *   - This Engine itself is skipped: host equal to os.hostname() (with or without
 *     .local), a loopback address, or an address of a local interface.
 *   - A failed attempt (DNS failure, connectEngine error) is retried with backoff:
 *     5 s, 10 s, 20 s, ... capped at 5 min; reset after a success.
 *   - A live connection is checked every 10 s. If it is gone (removed from
 *     network.connections, e.g. dropped by the mDNS path), it is dialled again,
 *     with the same backoff on failure. The check also resets the connection's
 *     missedDiscoveryCount, so a running mDNS monitor does not drop a static peer.
 *   - Socket-level reconnects of an existing connection are done by the Automerge
 *     WebSocketClientAdapter itself (fixed 5 s retry), as for mDNS peers.
 */

import os from 'os'
import { lookup } from 'dns/promises'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { EngineID, Hostname, IPAddress, PortNumber } from './CommonTypes.js'
import { Store } from './Store.js'
import { config } from './Config.js'
import { connectEngine, network } from './Network.js'
import { readStoreDocId } from './StoreIdentity.js'
import { log } from '../utils/utils.js'

export const STATIC_PEERS_ENV = 'IDEA_STATIC_PEERS'
export const STATIC_PEER_BASE_DELAY_MS = 5_000
export const STATIC_PEER_MAX_DELAY_MS = 300_000
export const STATIC_PEER_CHECK_INTERVAL_MS = 10_000

export interface StaticPeer { host: string, port: PortNumber }

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/

/** Parse `host[:port],...`. Invalid entries are skipped and reported in warnings. */
export const parseStaticPeers = (raw: string | undefined, defaultPort: number): { peers: StaticPeer[], warnings: string[] } => {
    const peers: StaticPeer[] = []
    const warnings: string[] = []
    for (const entry of (raw ?? '').split(',').map(e => e.trim()).filter(e => e.length > 0)) {
        const parts = entry.split(':')
        const host = parts[0]
        let port = defaultPort
        if (parts.length > 2 || !HOST_RE.test(host)) {
            warnings.push(`${STATIC_PEERS_ENV}: skipping invalid entry '${entry}' (expected host or host:port)`)
            continue
        }
        if (parts.length === 2) {
            port = /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : NaN
            if (!(port >= 1 && port <= 65535)) {
                warnings.push(`${STATIC_PEERS_ENV}: skipping invalid entry '${entry}' (port must be 1..65535)`)
                continue
            }
        }
        if (!peers.some(p => p.host.toLowerCase() === host.toLowerCase() && p.port === port)) {
            peers.push({ host, port: port as PortNumber })
        }
    }
    return { peers, warnings }
}

/** The raw setting: the env var wins over config.yaml settings.staticPeers. */
export const staticPeersSetting = (): string | undefined =>
    process.env[STATIC_PEERS_ENV] ?? config.settings.staticPeers

const shortName = (host: string): string => host.toLowerCase().replace(/\.local$/, '')

export const isSelfPeer = (host: string, address: string): boolean => {
    if (shortName(host) === shortName(os.hostname())) return true
    if (address.startsWith('127.') || address === '::1' || address === 'localhost') return true
    return Object.values(os.networkInterfaces()).some(list => (list ?? []).some(i => i.address === address))
}

export interface StaticPeerDeps {
    resolve: (host: string) => Promise<string>
    connect: (address: IPAddress, hostname: Hostname, engineId: EngineID, port: PortNumber) => Promise<unknown>
    isSelf: (host: string, address: string) => boolean
    log: (msg: string) => void
}

export interface StaticPeerOptions {
    raw?: string
    defaultPort?: number
    deps?: Partial<StaticPeerDeps>
    baseDelayMs?: number
    maxDelayMs?: number
    checkIntervalMs?: number
}

/**
 * Start dialling the static peers. Returns undefined (and does nothing) when
 * the setting is unset, empty or has no valid entry; otherwise a stop handle.
 */
export const startStaticPeers = (repo: Repo, storeHandle: DocHandle<Store>, opts: StaticPeerOptions = {}): { stop: () => void, peers: StaticPeer[] } | undefined => {
    const raw = opts.raw ?? staticPeersSetting()
    if (!raw || raw.trim() === '') return undefined
    const deps: StaticPeerDeps = {
        resolve: async (host) => HOST_IS_IPV4(host) ? host : (await lookup(host, { family: 4 })).address,
        connect: (address, hostname, engineId, port) => connectEngine(repo, address, hostname, engineId, readStoreDocId(), port),
        isSelf: isSelfPeer,
        log,
        ...opts.deps,
    }
    const defaultPort = opts.defaultPort ?? (config.settings.port || 1234)
    const base = opts.baseDelayMs ?? STATIC_PEER_BASE_DELAY_MS
    const max = opts.maxDelayMs ?? STATIC_PEER_MAX_DELAY_MS
    const check = opts.checkIntervalMs ?? STATIC_PEER_CHECK_INTERVAL_MS

    const { peers, warnings } = parseStaticPeers(raw, defaultPort)
    warnings.forEach(w => deps.log(w))
    if (peers.length === 0) return undefined
    deps.log(`Static peers (${STATIC_PEERS_ENV}): ${peers.map(p => `${p.host}:${p.port}`).join(', ')}`)

    let stopped = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const schedule = (fn: () => void, ms: number) => {
        const t = setTimeout(() => { timers.delete(t); if (!stopped) fn() }, ms)
        t.unref?.()
        timers.add(t)
    }

    const engineIdFor = (host: string): EngineID => {
        const engine = Object.values(storeHandle.doc()?.engineDB ?? {}).find(e => shortName(String(e.hostname)) === shortName(host))
        return (engine?.id ?? `static:${host}`) as EngineID
    }

    const supervise = (peer: StaticPeer) => {
        let failures = 0
        const attempt = async () => {
            try {
                const address = await deps.resolve(peer.host)
                if (deps.isSelf(peer.host, address)) {
                    deps.log(`Static peer ${peer.host}:${peer.port} is this Engine — skipped`)
                    return
                }
                const key = `${address}:${peer.port}`
                const existing = network.connections[key as IPAddress]
                if (existing) {
                    existing.missedDiscoveryCount = 0
                    if (String(existing.engineId).startsWith('static:')) existing.engineId = engineIdFor(peer.host)
                } else {
                    deps.log(`Static peer ${peer.host}:${peer.port}: connecting to ${key}`)
                    await deps.connect(address as IPAddress, shortName(peer.host) as Hostname, engineIdFor(peer.host), peer.port)
                }
                failures = 0
                schedule(attempt, check)
            } catch (e: any) {
                failures++
                const delay = Math.min(base * 2 ** (failures - 1), max)
                deps.log(`Static peer ${peer.host}:${peer.port}: attempt ${failures} failed (${e?.message ?? e}); retrying in ${Math.round(delay / 1000)}s`)
                schedule(attempt, delay)
            }
        }
        schedule(attempt, 0)
    }
    peers.forEach(supervise)

    return {
        peers,
        stop: () => { stopped = true; timers.forEach(t => clearTimeout(t)); timers.clear() },
    }
}

const HOST_IS_IPV4 = (s: string): boolean => /^(\d{1,3}\.){3}\d{1,3}$/.test(s)
