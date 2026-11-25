/**
 * originCheck.ts — the Engine's own Console origins, as pure functions (engine#582).
 *
 * No Config import, so the WebSocket server thread can use it too (the main
 * thread passes it the Console ports and the development origins). See
 * monitors/consoleOrigins.ts for the HTTP side.
 */

import os from 'os'

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
    devOrigins: readonly string[] = [],
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

/**
 * Whether a WebSocket upgrade with this Origin may reach the store server.
 * Non-browser peers (Engines, the CLI) send no Origin and go on to the
 * store-scoped peering check. Browser extensions (chrome-extension://, the
 * Console side panel) are let through: a web page cannot send that origin.
 * Any other browser origin must be one of the Engine's own Console origins.
 */
export const isWsOriginAllowed = (
    origin: string | undefined | null,
    consolePorts: readonly (number | undefined | null)[],
    devOrigins: readonly string[] = [],
    hosts: Set<string> = ownConsoleHosts(),
): boolean => {
    if (origin === undefined || origin === null || origin === '') return true
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true
    return isOwnConsoleOrigin(origin, consolePorts, hosts, devOrigins)
}
