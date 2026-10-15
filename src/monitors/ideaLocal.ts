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
import dgram from 'dgram'
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

/**
 * True when a D-Bus error means our entry group object no longer exists in avahi-daemon.
 * avahi keeps groups only in memory: when avahi-daemon restarts (e.g. after an
 * avahi-daemon.conf change, PR #215) the new daemon owns org.freedesktop.Avahi but has no
 * /ClientN/EntryGroupM objects, and libdbus answers any call on the old path with
 * UnknownMethod 'Method "GetState" with signature "" on interface ... doesn't exist'.
 * That is not a bus failure: the right reaction is to publish a fresh group.
 */
export const isEntryGroupGone = (e: any): boolean => {
    const name = String(e?.type ?? e?.name ?? '')
    const msg = String(e?.text ?? e?.message ?? e ?? '')
    return /org\.freedesktop\.DBus\.Error\.(UnknownMethod|UnknownObject|UnknownInterface)/.test(name)
        || /org\.freedesktop\.DBus\.Error\.(UnknownMethod|UnknownObject|UnknownInterface)/.test(msg)
        || /on interface "org\.freedesktop\.Avahi\.EntryGroup" doesn't exist/.test(msg)
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

// ── second-holder detection (raw mDNS) ──────────────────────────────────────

export interface MdnsResponder { from: string, addresses: string[] }

const ipNum = (ip: string): number => ip.split('.').reduce((n, o) => n * 256 + (parseInt(o, 10) & 255), 0)

/** Addresses other hosts give for the name (our own addresses excluded), sorted lowest first. */
export const foreignHolders = (responders: MdnsResponder[], own: string[]): string[] => {
    const out = new Set<string>()
    for (const r of responders) {
        for (const a of r.addresses) if (!own.includes(a)) out.add(a)
    }
    return [...out].sort((a, b) => ipNum(a) - ipNum(b))
}

/**
 * The fixed rule for two holders after a partition heals: the Engine with the numerically
 * lowest LAN IPv4 keeps idea.local, the other withdraws. Both sides compute the same answer
 * from what is on the wire, with no shared state.
 */
export const conflictWinner = (own: string[], foreign: string[]): 'us' | 'them' => {
    if (foreign.length === 0) return 'us'
    const lowOwn = Math.min(...own.map(ipNum))
    const lowForeign = Math.min(...foreign.map(ipNum))
    return lowOwn < lowForeign ? 'us' : 'them'
}

/** DNS query for `name` type A, class IN with the QU (unicast response) bit. */
export const encodeMdnsQuery = (name: string, id: number): Buffer => {
    const labels = name.replace(/\.$/, '').split('.')
    const parts: Buffer[] = [Buffer.from([id >> 8 & 255, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])]
    for (const l of labels) { const b = Buffer.from(l, 'utf8'); parts.push(Buffer.from([b.length]), b) }
    parts.push(Buffer.from([0, 0, 1, 0x80, 1]))
    return Buffer.concat(parts)
}

const readName = (buf: Buffer, off: number): [string, number] => {
    const labels: string[] = []
    let end = -1; let jumps = 0
    for (;;) {
        if (off >= buf.length) throw new Error('truncated name')
        const len = buf[off]
        if (len === 0) { off++; break }
        if ((len & 0xc0) === 0xc0) {
            if (++jumps > 20) throw new Error('pointer loop')
            if (end < 0) end = off + 2
            off = ((len & 0x3f) << 8) | buf[off + 1]
            continue
        }
        labels.push(buf.toString('utf8', off + 1, off + 1 + len)); off += 1 + len
    }
    return [labels.join('.'), end < 0 ? off : end]
}

/** IPv4 addresses in A records for `name` in a DNS response (answers + additionals); [] if not a response. */
export const parseMdnsAnswers = (buf: Buffer, name: string): string[] => {
    try {
        if (buf.length < 12 || !(buf[2] & 0x80)) return []
        const qd = buf.readUInt16BE(4); const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10)
        let off = 12
        for (let i = 0; i < qd; i++) { off = readName(buf, off)[1] + 4 }
        const want = name.replace(/\.$/, '').toLowerCase()
        const out: string[] = []
        for (let i = 0; i < rr; i++) {
            const [n, o] = readName(buf, off); off = o
            const type = buf.readUInt16BE(off); const ttl = buf.readUInt32BE(off + 4); const len = buf.readUInt16BE(off + 8)
            off += 10
            if (type === 1 && len === 4 && ttl > 0 && n.toLowerCase() === want) out.push([...buf.subarray(off, off + 4)].join('.'))
            off += len
        }
        return out
    } catch { return [] }
}

/**
 * Send a one-shot (legacy unicast, RFC 6762 §6.7) mDNS query for `name` from an ephemeral
 * port on each LAN address and collect every answer for `waitMs`. Every responder (our own
 * avahi included, via multicast loopback) answers straight to our socket, so a second holder
 * is seen even though avahi itself only reports one answer. Sent twice for loss.
 */
export const queryIdeaLocalResponders = async (name: string, addrs: LanAddress[], waitMs = 1200): Promise<MdnsResponder[]> => {
    const byFrom = new Map<string, Set<string>>()
    await Promise.all(addrs.map(a => new Promise<void>((resolve) => {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
        const id = Math.floor(Math.random() * 65535) + 1
        const q = encodeMdnsQuery(name, id)
        let t2: NodeJS.Timeout | undefined
        const done = () => { if (t2) clearTimeout(t2); try { sock.close() } catch { /* closed */ } resolve() }
        sock.on('error', done)
        sock.on('message', (msg, rinfo) => {
            if (msg.length < 2 || msg.readUInt16BE(0) !== id) return
            const found = parseMdnsAnswers(msg, name)
            if (found.length === 0) return
            const s = byFrom.get(rinfo.address) ?? new Set<string>()
            found.forEach(x => s.add(x)); byFrom.set(rinfo.address, s)
        })
        sock.bind(0, a.address, () => {
            try { sock.setMulticastInterface(a.address); sock.setMulticastLoopback(true); sock.setMulticastTTL(255) } catch { /* best effort */ }
            const send = () => sock.send(q, 5353, '224.0.0.251', () => {})
            send(); t2 = setTimeout(send, 300)
            setTimeout(done, waitMs)
        })
    })))
    return [...byFrom].map(([from, s]) => ({ from, addresses: [...s].sort() }))
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
    /**
     * Raw mDNS query for the name on our LAN addresses: every host that answers, with the
     * A addresses it gave. Used by the holder on every tick to find a second holder (after a
     * partition heals avahi does not re-probe). Default: queryIdeaLocalResponders (raw socket).
     */
    probe?: (name: string, addrs: LanAddress[]) => Promise<MdnsResponder[]>
    /** consecutive probes that must see a lower-ranked holder before we withdraw (default 2) */
    conflictConfirmations?: number
    /** after withdrawing for a conflict, do not re-register for this long, ms (default 15000) */
    conflictHoldoffMs?: number
    now?: () => number
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
    private readonly probe?: (name: string, addrs: LanAddress[]) => Promise<MdnsResponder[]>
    private readonly conflictConfirmations: number
    private readonly conflictHoldoffMs: number
    private readonly now: () => number
    private conflictSeen = 0
    private holdoffUntil = 0

    constructor(o: IdeaLocalPublisherOptions) {
        this.name = o.name ?? IDEA_LOCAL_NAME
        this.connect = o.connect
        this.addresses = o.addresses ?? (() => lanAddresses())
        this.logger = o.logger ?? log
        this.nextDelayMs = o.nextDelayMs ?? (() => 2000 + Math.floor(Math.random() * 3001))
        this.probe = 'probe' in o ? o.probe : queryIdeaLocalResponders
        this.conflictConfirmations = Math.max(1, o.conflictConfirmations ?? 2)
        this.conflictHoldoffMs = o.conflictHoldoffMs ?? 15000
        this.now = o.now ?? Date.now
    }

    /**
     * Holder only: is another host also answering for the name? Returns true when we must
     * withdraw (the other holder wins the fixed rule, seen on enough consecutive probes).
     */
    private async checkSecondHolder(addrs: LanAddress[]): Promise<boolean> {
        if (!this.probe) return false
        let responders: MdnsResponder[]
        try { responders = await this.probe(this.name, addrs) } catch (e: any) {
            this.logger(`[idea.local] second-holder probe failed: ${e?.message ?? e}`)
            return false
        }
        const own = addrs.map(a => a.address)
        const foreign = foreignHolders(responders, own)
        if (foreign.length === 0) { this.conflictSeen = 0; return false }
        const verdict = conflictWinner(own, foreign)
        if (verdict === 'us') {
            this.conflictSeen = 0
            this.note('holder', `holding ${this.name}; ${foreign.join(', ')} also answers: we keep it (lowest IPv4 keeps the name), the other Engine withdraws`)
            return false
        }
        this.conflictSeen++
        if (this.conflictSeen < this.conflictConfirmations) {
            this.logger(`[idea.local] ${foreign.join(', ')} also answers for ${this.name} and wins (lowest IPv4); confirming (${this.conflictSeen}/${this.conflictConfirmations})`)
            return false
        }
        this.conflictSeen = 0
        this.holdoffUntil = this.now() + this.conflictHoldoffMs
        this.note('waiting', `second holder of ${this.name}: ${foreign.join(', ')} (lower IPv4 keeps it); withdrawing, retrying in ${Math.round(this.conflictHoldoffMs / 1000)} s`)
        return true
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

    /** The group's state, or undefined when avahi no longer has the group (daemon restarted). */
    private async readGroupState(g: AvahiEntryGroup): Promise<number | undefined> {
        try { return await g.getState() } catch (e: any) {
            if (isEntryGroupGone(e)) return undefined
            throw e
        }
    }

    /** One step of the retry/takeover loop. Never throws. */
    async tick(): Promise<PublisherStatus> {
        if (this.stopped) return this.status
        try {
            const addrs = this.addresses()
            const key = addrKey(addrs)

            if (this.group) {
                const st = await this.readGroupState(this.group)
                if (st === undefined) {
                    // avahi-daemon restarted and our group went with it. The bus connection is
                    // fine; publish a fresh group in this same tick (no reconnect, no error line).
                    this.group = undefined
                    this.publishedKey = ''
                    this.note('registering', `avahi-daemon lost our ${this.name} entry group (daemon restarted); re-publishing`)
                } else if (key === this.publishedKey && st === EntryGroupState.ESTABLISHED) {
                    if (this.status !== 'holder') {
                        this.conflictSeen = 0
                        this.note('holder', `holding ${this.name} on ${addrs.map(a => `${a.ifName} ${a.address}`).join(', ')}`)
                    }
                    if (!(await this.checkSecondHolder(addrs))) return this.status
                    await this.dropGroup()
                    return this.status
                } else if (key === this.publishedKey && (st === EntryGroupState.REGISTERING || st === EntryGroupState.UNCOMMITED)) {
                    this.status = 'registering'
                    return this.status
                } else {
                    if (st === EntryGroupState.COLLISION) {
                        this.note('waiting', `${this.name} is held by another Engine; retrying every 2-5 s`)
                    } else if (key !== this.publishedKey) {
                        this.note('registering', `LAN addresses changed (${key || 'none'}); re-publishing ${this.name}`)
                    } else {
                        this.note('waiting', `${this.name} registration ended in state ${EntryGroupState[st] ?? st}; retrying`)
                    }
                    await this.dropGroup()
                }
            }

            if (this.now() < this.holdoffUntil) return this.status

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
