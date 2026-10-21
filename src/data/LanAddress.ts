/**
 * LanAddress: the LAN IPv4 address this Engine publishes as Engine.lanAddress
 * (agent-console-dev#138: Open works without mDNS). The Console can link apps
 * to http://<lanAddress>:<port> when `<hostname>.local` doesn't resolve.
 *
 * Choice, in order:
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
 * Written at start (createOrUpdateEngine) and checked on every heartbeat; the
 * store is written only when the value changes (e.g. a DHCP renewal).
 */
import os from 'os'
import { readFileSync } from 'fs'

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

/** Pick the LAN IPv4 (see the module comment), or null. */
export const pickLanAddress = (ifaces: Ifaces, routeText: string): string | null => {
    const firstEligible = (name: string): string | null =>
        (ifaces[name] ?? []).find(a => isEligibleLanIPv4(name, a as any))?.address ?? null
    for (const name of defaultRouteIfaces(routeText)) {
        const ip = firstEligible(name)
        if (ip) return ip
    }
    const names = Object.keys(ifaces ?? {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    for (const name of names) {
        const ip = firstEligible(name)
        if (ip) return ip
    }
    return null
}

/** This host's LAN IPv4 now. */
export const currentLanAddress = (): string | null => {
    try { return pickLanAddress(ops.networkInterfaces(), ops.routeTable()) } catch { return null }
}
