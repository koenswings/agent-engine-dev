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

import type http from 'http'
import { devConsoleOrigins } from '../data/Config.js'
import { ownConsoleHosts, isOwnConsoleOrigin as isOwnOriginPure } from '../utils/originCheck.js'

export { ownConsoleHosts }

/**
 * Whether `origin` is one of this Engine's own Console origins (or a configured
 * development origin). `ports` are the Console ports to accept.
 */
export const isOwnConsoleOrigin = (
    origin: string | undefined | null,
    ports: readonly (number | undefined | null)[],
    hosts: Set<string> = ownConsoleHosts(),
    devOrigins: readonly string[] = devConsoleOrigins(),
): boolean => isOwnOriginPure(origin, ports, hosts, devOrigins)

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
