/**
 * ideaLocal.ts — publish the shared mDNS name `idea.local` (idea#203 §3).
 *
 * Every Engine runs this publisher. avahi lets only one host hold an address
 * name: the first Engine to register `idea.local` wins and the others get a
 * COLLISION (no `idea-2.local` is created; tested on the pool 2026-10-15). So
 * every Engine keeps retrying every 2-5 s; when the holder leaves (clean
 * withdraw, or gone without a goodbye and no longer answering probes), the next
 * retry's probe succeeds and that Engine becomes the holder. No election through
 * the store.
 *
 * The name is registered through the Pi's own avahi-daemon over D-Bus
 * (avahi-utils is not installed on the Pis), as an address record with
 * AVAHI_PUBLISH_NO_REVERSE: the equivalent of `avahi-publish -a -R idea.local
 * <ip>`. Without NO_REVERSE avahi refuses with "Local name collision", because
 * the reverse (PTR) record of our IP already belongs to our own hostname.
 * No second mDNS responder is started (compatible with the avahi-hostname-clash
 * proposal of 2026-10-13).
 *
 * LAN only: the record is added once per LAN interface, with that interface's
 * own IPv4 address and interface index, never on lo, docker*, br-*, veth* and
 * other virtual interfaces (idea03.local currently resolves to the docker bridge
 * 172.21.0.1 because avahi's own hostname record is on every interface; that is
 * avahi-daemon.conf, not this file — see the PR description).
 *
 * The logic (IdeaLocalPublisher.tick) is independent of D-Bus so it can be unit
 * tested with a fake avahi; createDbusAvahi() is the real D-Bus binding.
 */

import os from 'os'
import { readFileSync } from 'fs'
import { log } from '../utils/utils.js'

export const IDEA_LOCAL_NAME = 'idea.local'

/** avahi constants (avahi-common/defs.h) */
export const AVAHI_IF_UNSPEC = -1
export const AVAHI_PROTO_INET = 0
export const AVAHI_PUBLISH_NO_REVERSE = 16
export enum EntryGroupState { UNCOMMITED = 0, REGISTERING = 1, ESTABLISHED = 2, COLLISION = 3, FAILURE = 4 }

/** Interface name prefixes that are never the school LAN. */
export const NON_LAN_IF_PREFIXES = ['lo', 'docker', 'br-', 'veth', 'virbr', 'tailscale', 'zt', 'wg', 'cni', 'flannel', 'vxlan', 'tun', 'tap']

export interface LanAddress { ifName: string, ifIndex: number, address: string }

export const isLanInterfaceName = (name: string): boolean =>
    !NON_LAN_IF_PREFIXES.some(p => name === p || name.startsWith(p))

/**
 * The IPv4 addresses this Engine should publish idea.local on: one per LAN
 * interface (non-internal IPv4, interface name not virtual). Link-local
 * 169.254/16 is skipped. Sorted for stable comparison.
 */
export const lanAddresses = (
    ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
    ifIndexOf: (name: string) => number | undefined = sysIfIndex,
): LanAddress[] => {
    const out: LanAddress[] = []
    for (const [ifName, infos] of Object.entries(ifaces)) {
        if (!infos || !isLanInterfaceName(ifName)) continue
        const ifIndex = ifIndexOf(ifName)
        if (ifIndex === undefined) continue
        for (const i of infos) {
            if (i.family !== 'IPv4' || i.internal) continue
            if (i.address.startsWith('169.254.')) continue
            out.push({ ifName, ifIndex, address: i.address })
        }
    }
    return out.sort((a, b) => (a.ifName + a.address).localeCompare(b.ifName + b.address))
}

const sysIfIndex = (name: string): number | undefined => {
    try {
        const n = parseInt(readFileSync(`/sys/class/net/${name}/ifindex`, 'utf-8').trim(), 10)
        return Number.isFinite(n) ? n : undefined
    } catch { return undefined }
}

const addrKey = (a: LanAddress[]) => a.map(x => `${x.ifIndex}/${x.address}`).join(',')

// ── avahi abstraction ────────────────────────────────────────────────────────

export interface AvahiEntryGroup {
    addAddress(ifIndex: number, proto: number, flags: number, name: string, address: string): Promise<void>
    commit(): Promise<void>
    getState(): Promise<number>
    free(): Promise<void>
}

export interface AvahiClient {
    entryGroupNew(): Promise<AvahiEntryGroup>
    close(): void
}

// ── publisher ────────────────────────────────────────────────────────────────

export type PublisherStatus = 'idle' | 'registering' | 'holder' | 'waiting' | 'error'

export interface IdeaLocalPublisherOptions {
    name?: string
    connect: () => Promise<AvahiClient>
    addresses?: () => LanAddress[]
    logger?: (line: string) => void
    /** delay before the next tick, ms; default uniform 2000-5000 */
    nextDelayMs?: () => number
}

export class IdeaLocalPublisher {
    readonly name: string
    status: PublisherStatus = 'idle'
    private client?: AvahiClient
    private group?: AvahiEntryGroup
    private publishedKey = ''
    private timer?: NodeJS.Timeout
    private stopped = false
    private lastLogged = ''
    private readonly connect: () => Promise<AvahiClient>
    private readonly addresses: () => LanAddress[]
    private readonly logger: (line: string) => void
    private readonly nextDelayMs: () => number

    constructor(o: IdeaLocalPublisherOptions) {
        this.name = o.name ?? IDEA_LOCAL_NAME
        this.connect = o.connect
        this.addresses = o.addresses ?? (() => lanAddresses())
        this.logger = o.logger ?? log
        this.nextDelayMs = o.nextDelayMs ?? (() => 2000 + Math.floor(Math.random() * 3001))
    }

    /** Log a status line only when it changes (a waiting Engine retries every few seconds). */
    private note(status: PublisherStatus, line: string) {
        this.status = status
        if (line !== this.lastLogged) { this.logger(`[idea.local] ${line}`); this.lastLogged = line }
    }

    private async dropGroup() {
        const g = this.group
        this.group = undefined
        this.publishedKey = ''
        if (g) { try { await g.free() } catch { /* group already gone with the connection */ } }
    }

    private async dropClient() {
        await this.dropGroup()
        const c = this.client
        this.client = undefined
        if (c) { try { c.close() } catch { /* ignore */ } }
    }

    /** One step of the retry/takeover loop. Never throws. */
    async tick(): Promise<PublisherStatus> {
        if (this.stopped) return this.status
        try {
            const addrs = this.addresses()
            const key = addrKey(addrs)

            if (this.group) {
                const st = await this.group.getState()
                if (key === this.publishedKey && st === EntryGroupState.ESTABLISHED) {
                    this.note('holder', `holding ${this.name} on ${addrs.map(a => `${a.ifName} ${a.address}`).join(', ')}`)
                    return this.status
                }
                if (key === this.publishedKey && (st === EntryGroupState.REGISTERING || st === EntryGroupState.UNCOMMITED)) {
                    this.status = 'registering'
                    return this.status
                }
                if (st === EntryGroupState.COLLISION) {
                    this.note('waiting', `${this.name} is held by another Engine; retrying every 2-5 s`)
                } else if (key !== this.publishedKey) {
                    this.note('registering', `LAN addresses changed (${key || 'none'}); re-publishing ${this.name}`)
                } else {
                    this.note('waiting', `${this.name} registration ended in state ${EntryGroupState[st] ?? st}; retrying`)
                }
                await this.dropGroup()
            }

            if (addrs.length === 0) {
                this.note('idle', `no LAN IPv4 address; not publishing ${this.name}`)
                return this.status
            }

            if (!this.client) this.client = await this.connect()
            const g = await this.client.entryGroupNew()
            this.group = g
            try {
                for (const a of addrs) {
                    await g.addAddress(a.ifIndex, AVAHI_PROTO_INET, AVAHI_PUBLISH_NO_REVERSE, this.name, a.address)
                }
                await g.commit()
            } catch (e: any) {
                // A local collision (e.g. this host already publishes the name) is not fatal: retry later.
                await this.dropGroup()
                this.note('waiting', `could not register ${this.name}: ${e?.message ?? e}; retrying`)
                return this.status
            }
            this.publishedKey = key
            if (this.status !== 'waiting') this.status = 'registering'
            return this.status
        } catch (e: any) {
            // avahi-daemon or D-Bus gone: reconnect on the next tick.
            await this.dropClient()
            this.note('error', `avahi D-Bus error: ${e?.message ?? e}; reconnecting`)
            return this.status
        }
    }

    start(): this {
        const loop = async () => {
            await this.tick()
            if (!this.stopped) this.timer = setTimeout(loop, this.nextDelayMs())
        }
        void loop()
        return this
    }

    /** Withdraw the name (avahi sends a goodbye, so another Engine takes over within seconds). */
    async stop(): Promise<void> {
        this.stopped = true
        if (this.timer) clearTimeout(this.timer)
        await this.dropClient()
        this.note('idle', `withdrew ${this.name}`)
    }
}

// ── D-Bus binding ────────────────────────────────────────────────────────────

/** Connect to avahi-daemon on the system bus (org.freedesktop.Avahi). */
export const createDbusAvahi = async (): Promise<AvahiClient> => {
    const dbus: any = await import('dbus-next')
    const bus = (dbus.default ?? dbus).systemBus()
    let dead: Error | undefined
    // A lost bus connection is reported as an event; turn it into a failed call so tick() reconnects.
    bus.on('error', (e: Error) => { dead = e })
    const alive = () => { if (dead) throw dead }
    const server = await bus.getProxyObject('org.freedesktop.Avahi', '/')
    const srv = server.getInterface('org.freedesktop.Avahi.Server')
    return {
        entryGroupNew: async () => {
            alive()
            const path: string = await srv.EntryGroupNew()
            const obj = await bus.getProxyObject('org.freedesktop.Avahi', path)
            const eg = obj.getInterface('org.freedesktop.Avahi.EntryGroup')
            return {
                addAddress: (ifIndex, proto, flags, name, address) => eg.AddAddress(ifIndex, proto, flags, name, address),
                commit: () => eg.Commit(),
                getState: async () => { alive(); return Number(await eg.GetState()) },
                free: () => eg.Free(),
            }
        },
        close: () => bus.disconnect(),
    }
}

/** Start the idea.local publisher (start.ts, when mDNS is on). */
export const enableIdeaLocalPublisher = (): IdeaLocalPublisher =>
    new IdeaLocalPublisher({ connect: createDbusAvahi }).start()
