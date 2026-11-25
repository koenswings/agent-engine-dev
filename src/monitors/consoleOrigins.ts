/**
 * consoleOrigins.ts — CORS limited to the Engine's own Console origins (engine#582).
 *
 * The Console is served by the Engine itself, so its API calls are same-origin.
 * A cross-origin answer is only given to the Engine's own Console origins:
 *
 *   hosts: <hostname>, <hostname>.local, idea.local, localhost, 127.0.0.1 and every
 *          non-internal IPv4 address of this Pi (LAN, Tailscale)
 *   ports: the port the request came in on and the Engine's Console ports
 *          (httpPort, ideaLocalHttpPort); port 80 is written without a port
 *
 * plus the exact origins in settings.devConsoleOrigins (Console development).
 * A request without an Origin header gets no CORS header at all. Answers that
 * carry Access-Control-Allow-Origin also carry Vary: Origin.
 */

import os from 'os'
import type http from 'http'
import { devConsoleOrigins } from '../data/Config.js'

/** Hosts this Engine's Console is served under (lowercase). */
export const ownConsoleHosts = (
    hostname: string = os.hostname(),
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): Set<string> => {
    const h = hostname.toLowerCase().replace(/\.local$/, '')
    const hosts = new Set<string>(['idea.local', 'localhost', '127.0.0.1'])
    if (h) { hosts.add(h); hosts.add(`${h}.local`) }
    for (const list of Object.values(interfaces)) {
        for (const a of list ?? []) {
            if (!a.internal && (a.family === 'IPv4' || (a.family as unknown) === 4)) hosts.add(a.address)
        }
    }
    return hosts
}

/**
 * Whether `origin` is one of this Engine's own Console origins (or a configured
 * development origin). `ports` are the Console ports to accept.
 */
export const isOwnConsoleOrigin = (
    origin: string | undefined | null,
    ports: readonly (number | undefined | null)[],
    hosts: Set<string> = ownConsoleHosts(),
    devOrigins: readonly string[] = devConsoleOrigins(),
): boolean => {
    if (!origin || origin === 'null') return false
    if (devOrigins.includes(origin)) return true
    let u: URL
    try { u = new URL(origin) } catch { return false }
    if (u.protocol !== 'http:') return false
    if (u.origin !== origin.toLowerCase()) return false   // no path, user info or trailing parts
    const port = u.port === '' ? 80 : Number(u.port)
    if (!ports.some(p => typeof p === 'number' && p > 0 && p === port)) return false
    return hosts.has(u.hostname.toLowerCase())
}

/** CORS headers for a response to `req`: empty unless the origin is allowed. */
export const corsHeadersFor = (
    req: http.IncomingMessage,
    ports: readonly (number | undefined | null)[],
): Record<string, string> => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    const all = [...ports, req.socket?.localPort]
    if (!isOwnConsoleOrigin(origin, all)) return origin ? { 'Vary': 'Origin' } : {}
    return { 'Access-Control-Allow-Origin': origin!, 'Vary': 'Origin' }
}

/** Extra headers on an allowed preflight (OPTIONS) answer. */
export const CORS_PREFLIGHT_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
}
