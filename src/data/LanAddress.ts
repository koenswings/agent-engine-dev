/**
 * LanAddress: the LAN IPv4 address this Engine publishes as Engine.lanAddress
 * (agent-console-dev#138: Open works without mDNS). The Console can link apps
 * to http://<lanAddress>:<port> when `<hostname>.local` doesn't resolve.
 *
 * Choice, in order:
 *   0. Preferred LAN (settings.lanPreferCidrs, default ['10.42.0.0/16'], the school/kit
 *      LAN range): an eligible address inside one of those CIDRs wins over everything
 *      below, even when another interface (home Wi-Fi, a USB tether) holds the default
 *      route. Several: the default-route interface first, then wired over wireless,
 *      then the lowest address. An empty list switches this step off.
 *   1. The default-route interface (lowest metric among the up default routes in
 *      /proc/net/route) when it has an eligible address. This is eth0 on a wired
 *      Pi, wlan0 on a Wi-Fi-only Pi, and the lower-metric one when both are up.
 *   2. No usable default route (offline school LAN, or the default route goes via
 *      Tailscale or a container bridge): the first eligible address, wired (eth*, en*)
 *      before wireless (wlan*, wl*) before others.
 *   3. Nothing eligible: null.
 * Eligible: IPv4, not internal, not link-local 169.254.0.0/16, not Tailscale/CGNAT
 * 100.64.0.0/10, and not on a virtual interface (docker*, br-*, veth*, virbr*,
 * cni*, flannel*, lxc*, tailscale*, wg*, zt*).
 *
 * Engine.lanAddresses lists every eligible address in this same order (lanAddress is
 * its first entry), so a Console can fall back or match its own subnet.
 *
 * Written at start (createOrUpdateEngine) and checked on every heartbeat; the
 * store is written only when the value changes (e.g. a DHCP renewal).
 */
import os from 'os'
import { readFileSync } from 'fs'
import { lanPreferCidrs } from './Config.js'

type Ifaces = ReturnType<typeof os.networkInterfaces>

/** Injectable for tests: the interfaces and the /proc/net/route text this host reports. */
const realOps = {
    networkInterfaces: (): Ifaces => os.networkInterfaces(),
    routeTable: (): string => { try { return readFileSync('/proc/net/route', 'utf8') } catch { return '' } },
}
let ops = { ...realOps }
/** Tests only: replace the interface / route source (null: the real host). */
export const setLanAddressOpsForTests = (o: Partial<typeof realOps> | null): void => {
    ops = { ...realOps, ...(o ?? {}) }
}

export const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|cni|flannel|lxc|lxd|tailscale|wg|zt|tun|tap)/

const ipv4ToInt = (ip: string): number => ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0)

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** 'a.b.c.d/n' → { base, bits }, or null when it is not an IPv4 CIDR. */
export const parseCidr = (cidr: string): { base: string; bits: number } | null => {
    if (typeof cidr !== 'string') return null
    const m = /^([0-9.]+)\/(\d{1,2})$/.exec(cidr.trim())
    if (!m || !IPV4.test(m[1])) return null
    const bits = Number(m[2])
    return bits >= 0 && bits <= 32 ? { base: m[1], bits } : null
}
const inCidr = (ip: string, base: string, bits: number): boolean => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)
}

/** An address the Console on the school LAN could reach. */
export const isEligibleLanIPv4 = (iface: string, a: { address: string; family: string | number; internal: boolean }): boolean =>
    (a.family === 'IPv4' || a.family === 4)
    && !a.internal
    && !VIRTUAL_IFACE.test(iface)
    && !inCidr(a.address, '169.254.0.0', 16)
    && !inCidr(a.address, '100.64.0.0', 10)
    && !inCidr(a.address, '127.0.0.0', 8)

/** Interfaces carrying an up default route, lowest metric first (from /proc/net/route text). */
export const defaultRouteIfaces = (routeText: string): string[] => {
    const rows: { iface: string; metric: number }[] = []
    for (const line of routeText.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/)
        if (f.length < 8) continue
        const [iface, dest, , flags, , , metric, mask] = f
        const up = (parseInt(flags, 16) & 0x1) === 0x1
        if (dest === '00000000' && mask === '00000000' && up) rows.push({ iface, metric: Number(metric) || 0 })
    }
    rows.sort((a, b) => a.metric - b.metric)
    return [...new Set(rows.map(r => r.iface))]
}

const rank = (n: string) => /^(eth|en)/.test(n) ? 0 : /^(wlan|wl)/.test(n) ? 1 : 2

export interface LanCandidate { iface: string; address: string }

/**
 * Every eligible address, in selection order (see the module comment): first the ones
 * inside a preferred CIDR (default-route interface, then wired, then lowest address),
 * then the rest in the #166 order (default-route interfaces by metric, then wired before
 * wireless before others, by name; an interface's own address order kept). preferCidrs
 * defaults to [] here (pure #166 order); currentLanSelection passes the setting.
 */
export const lanCandidates = (ifaces: Ifaces, routeText: string, preferCidrs: string[] = []): LanCandidate[] => {
    const routeOrder = defaultRouteIfaces(routeText)
    const routeIdx = (n: string) => { const i = routeOrder.indexOf(n); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
    const prefer = (preferCidrs ?? []).map(parseCidr).filter((c): c is { base: string; bits: number } => c !== null)
    const preferred = (ip: string) => prefer.some(c => inCidr(ip, c.base, c.bits))
    const all: (LanCandidate & { pos: number })[] = []
    for (const [iface, addrs] of Object.entries(ifaces ?? {})) {
        (addrs ?? []).forEach((a, pos) => { if (isEligibleLanIPv4(iface, a as any)) all.push({ iface, address: a.address, pos }) })
    }
    const seen = new Set<string>()
    const unique = (l: typeof all) => l.filter(c => !seen.has(c.address) && (seen.add(c.address), true))
    const tierA = all.filter(c => preferred(c.address)).sort((a, b) =>
        routeIdx(a.iface) - routeIdx(b.iface) || rank(a.iface) - rank(b.iface) || ipv4ToInt(a.address) - ipv4ToInt(b.address))
    const tierB = all.filter(c => !preferred(c.address)).sort((a, b) =>
        routeIdx(a.iface) - routeIdx(b.iface) || rank(a.iface) - rank(b.iface) || a.iface.localeCompare(b.iface) || a.pos - b.pos)
    return [...unique(tierA), ...unique(tierB)].map(({ iface, address }) => ({ iface, address }))
}

/** Pick the LAN IPv4 (see the module comment), or null. */
export const pickLanAddress = (ifaces: Ifaces, routeText: string, preferCidrs: string[] = []): string | null =>
    lanCandidates(ifaces, routeText, preferCidrs)[0]?.address ?? null

/** What the Engine publishes: lanAddress (+ its interface, for the log) and lanAddresses. */
export interface LanSelection { address: string | null; iface: string | null; addresses: string[] | null }

/** This host's LAN selection now, with settings.lanPreferCidrs. */
export const currentLanSelection = (): LanSelection => {
    try {
        const c = lanCandidates(ops.networkInterfaces(), ops.routeTable(), lanPreferCidrs())
        return c.length ? { address: c[0].address, iface: c[0].iface, addresses: c.map(x => x.address) } : { address: null, iface: null, addresses: null }
    } catch {
        return { address: null, iface: null, addresses: null }
    }
}

/** This host's LAN IPv4 now. */
export const currentLanAddress = (): string | null => currentLanSelection().address

const sameList = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean =>
    (a ?? null) === null || (b ?? null) === null ? (a ?? null) === (b ?? null) : a!.length === b!.length && a!.every((x, i) => x === b![i])

/**
 * The log lines for a change from the stored values to sel (empty: nothing changed).
 *   Engine lanAddress <old|unset> → <new|null> (<iface>)       (no "(iface)" when null)
 *   Engine lanAddresses [<old, ...>|unset] → [<new, ...>|null]  (only when the list changed)
 */
export const lanChangeLines = (stored: { lanAddress?: string | null; lanAddresses?: readonly string[] | null }, sel: LanSelection): string[] => {
    const out: string[] = []
    if ((stored.lanAddress ?? null) !== sel.address) {
        out.push(`Engine lanAddress ${stored.lanAddress ?? 'unset'} → ${sel.address ?? 'null'}${sel.address && sel.iface ? ` (${sel.iface})` : ''}`)
    }
    if (!sameList(stored.lanAddresses, sel.addresses)) {
        const fmt = (l: readonly string[] | null | undefined, none: string) => l ? `[${l.join(', ')}]` : none
        out.push(`Engine lanAddresses ${fmt(stored.lanAddresses, stored.lanAddresses === null ? 'null' : 'unset')} → ${fmt(sel.addresses, 'null')}`)
    }
    return out
}
