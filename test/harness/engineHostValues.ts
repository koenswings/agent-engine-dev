/**
 * engineHostValues — which .env values are the Engine's OWN host identity (public, not secrets).
 *
 * The Engine writes its host identity into every instance .env (hostname/ip via
 * writeEngineHostEnv; IDEA_HOSTNAME / IDEA_HOST_IPS via HostIdentity, agent-engine-dev#163).
 * Those are logged on purpose, so no-env-values-in-logs must not treat them as secrets. On a
 * pool Pi they are real (idea04, LAN + Tailscale IPs; PR #248 re-runs 2026-10-25).
 *
 * A value is exempt ONLY when it is this Engine's own: a hostname equal to os.hostname() or the
 * Engine's configured hostname, an IP present in os.networkInterfaces() or equal to the Engine's
 * configured ip. A comma list (IDEA_HOST_IPS) is exempt only when EVERY item is own.
 */
import os from 'os'

export interface EngineHost {
    hostnames: Set<string>
    ips: Set<string>
}

export const engineHost = (
    configured: { hostname?: string, ip?: string } = {},
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
    hostname: string = os.hostname(),
): EngineHost => ({
    hostnames: new Set([hostname, configured.hostname].filter((v): v is string => !!v)),
    ips: new Set([
        ...Object.values(interfaces).flatMap(l => (l ?? []).map(i => i.address)),
        ...(configured.ip ? [configured.ip] : []),
    ]),
})

/** Is `value` (a single name/IP, or a comma-joined list of them) entirely this Engine's own? */
export const isOwnHostValue = (value: string, host: EngineHost): boolean => {
    const items = value.split(',').map(s => s.trim())
    return items.length > 0 && items.every(v => v !== '' && (host.hostnames.has(v) || host.ips.has(v)))
}

/** The individual own values inside `value` (for checking each one separately). */
export const ownHostItems = (value: string, host: EngineHost): string[] =>
    isOwnHostValue(value, host) ? value.split(',').map(s => s.trim()) : []
