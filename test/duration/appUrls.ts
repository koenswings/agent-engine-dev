/**
 * Stage 2 (r54 FAIL@58 / r55): no "any-Pi" fallback for ANY app port.
 *
 * r54 steps 21–33 "passed" against idea166-nextcloud-live-app on idea01:18280 (Console default
 * Nextcloud port on the Console host, idea01's SD card) — never against the fixture Nextcloud
 * (nextcloud-grade5a-001, idea03:61820); step 34 used idea166-kiwix-live on idea01:18380 the same way.
 * The Console Intents (agent-console cda87d2 e2e/intents/sidecarUrls.ts) build every App URL as
 * DURATION_<APP>_URL, else <Console page host>:DURATION_<APP>_PORT, else a hard default
 * (kolibri 18080, nextcloud 18280, kiwix 18380). In Stage 2 the harness therefore:
 *   1. before every step that uses an App, sets DURATION_<APP>_URL from the STORE (the instance's own
 *      Pi + its published port) and refuses any value it did not set itself (manual URL/PORT);
 *   2. proves the port belongs to that instance's container on that Pi (verifySidecarOwner), and
 *      that Nextcloud accepts the host (trusted_domains);
 *   3. after the Intent, checks every App tab the step used (active tab, tabs it opened, the Console
 *      page if it navigated in-tab) points at one of those store URLs — a Path A popup or a reused
 *      tab on another host/port fails the step loudly.
 * A Console default port is never used silently: an App with no store instance fails the step.
 */

export type SidecarApp = 'kolibri' | 'nextcloud' | 'kiwix'
export const SIDECAR_APPS: readonly SidecarApp[] = ['kolibri', 'nextcloud', 'kiwix']

/** Console cda87d2 e2e/intents/sidecarUrls.ts SIDECAR_DEFAULT_PORTS — never allowed to apply in Stage 2. */
export const CONSOLE_DEFAULT_SIDECAR_PORTS: Readonly<Record<SidecarApp, number>> = { kolibri: 18080, nextcloud: 18280, kiwix: 18380 }
export const APP_URL_ENV: Readonly<Record<SidecarApp, string>> = {
    kolibri: 'DURATION_KOLIBRI_URL', nextcloud: 'DURATION_NEXTCLOUD_URL', kiwix: 'DURATION_KIWIX_URL',
}
export const APP_PORT_ENV: Readonly<Record<SidecarApp, string>> = {
    kolibri: 'DURATION_KOLIBRI_PORT', nextcloud: 'DURATION_NEXTCLOUD_PORT', kiwix: 'DURATION_KIWIX_PORT',
}
/** Console nextcloudDeep.ts resolveFileRequestUrl: full override of the NC file-drop URL. */
export const NC_FILE_REQUEST_ENV = 'DURATION_NC_FILE_REQUEST_URL'

/** Mirror of Console appKindForInstance (sidecarUrls.ts). */
export const appKindForInstanceId = (instanceId: string): SidecarApp =>
    /nextcloud/i.test(instanceId) ? 'nextcloud' : /kiwix/i.test(instanceId) ? 'kiwix' : 'kolibri'

/** Walk states that are "inside" an App tab (scenarios/unified.yaml). */
const STATE_APP: readonly [RegExp, SidecarApp][] = [[/^kolibri_/, 'kolibri'], [/^nc_/, 'nextcloud'], [/^wiki_/, 'kiwix']]

/**
 * Intents that open / poll an App by INSTANCE id (Console openAppInstance / waitForSidecarStable with
 * appKindForInstance): open_app, and the post-Confirm settle of copy/move/restore.
 */
export const INSTANCE_SIDECAR_ACTIONS: ReadonlySet<string> = new Set(['open_app', 'copy_app', 'move_app', 'restore_from_backup'])

/**
 * Apps a walk step uses through a sidecar URL: the step lands in an App state (kolibri_*, nc_*,
 * wiki_*), or its Intent names the App (open_kolibri_as_*, open_nextcloud_as_*, open_wikipedia_as_*,
 * search_browse_wikipedia). leave_* Intents only close the tab (no URL is resolved).
 */
export const appsUsedByStep = (step: { action: string; to?: string }): SidecarApp[] => {
    const out = new Set<SidecarApp>()
    for (const [re, app] of STATE_APP) if (step.to && re.test(step.to)) out.add(app)
    if (!/^leave_/.test(step.action)) {
        if (/kolibri/.test(step.action)) out.add('kolibri')
        if (/nextcloud/.test(step.action)) out.add('nextcloud')
        if (/wikipedia|kiwix/.test(step.action)) out.add('kiwix')
    }
    return SIDECAR_APPS.filter(a => out.has(a))
}

/** A store-derived App URL: the instance's Pi + published port, with every hostname that Pi answers to. */
export interface AppPin {
    app: SidecarApp
    instanceId: string
    engine: string
    port: number
    url: string
    /** Hostnames that address `engine` (logical id, Tailscale/LAN IP from --hosts, <id>.local). */
    hosts: string[]
    status?: string
}

// ── Harness-owned env: values the harness set itself (anything else in Stage 2 is a manual override) ──
const owned = new WeakMap<object, Map<string, string>>()
export const setHarnessEnv = (env: NodeJS.ProcessEnv, key: string, value: string): void => {
    env[key] = value
    let m = owned.get(env)
    if (!m) owned.set(env, (m = new Map()))
    m.set(key, value)
}
export const isHarnessOwned = (env: NodeJS.ProcessEnv, key: string): boolean =>
    env[key] !== undefined && owned.get(env)?.get(key) === env[key]

const portOf = (u: URL): number => Number(u.port || (u.protocol === 'https:' ? 443 : 80))

/** True when `url` addresses exactly this pin (one of the Pi's hostnames AND the store port). */
export const urlHitsPin = (url: string, pin: Pick<AppPin, 'hosts' | 'port'>): boolean => {
    try {
        const u = new URL(url)
        return pin.hosts.includes(u.hostname) && portOf(u) === pin.port
    } catch {
        return false
    }
}

/**
 * Refuse any App URL/port the harness did not derive from the store (Stage 2). A manual
 * DURATION_<APP>_PORT equal to the store port is harmless and allowed; anything else throws.
 */
export const assertNoManualAppOverride = (env: NodeJS.ProcessEnv, pin: AppPin): void => {
    const pk = APP_PORT_ENV[pin.app]
    const pv = env[pk]?.trim()
    if (pv && !isHarnessOwned(env, pk) && Number(pv) !== pin.port) {
        throw new Error(
            `Stage 2: ${pk}=${pv} was set outside the harness but ${pin.instanceId} publishes :${pin.port} on ${pin.engine} (store) — ` +
                `refused (no manual / default port; no any-Pi fallback)`,
        )
    }
    const uk = APP_URL_ENV[pin.app]
    const uv = env[uk]?.trim()
    if (uv && !isHarnessOwned(env, uk) && !urlHitsPin(uv, pin)) {
        throw new Error(
            `Stage 2: ${uk}=${uv} was set outside the harness and is not ${pin.instanceId}'s store URL ${pin.url} — ` +
                `refused (no manual / any-Pi URL)`,
        )
    }
    if (pin.app === 'nextcloud') {
        const fr = env[NC_FILE_REQUEST_ENV]?.trim()
        if (fr && !urlHitsPin(fr, pin)) {
            throw new Error(
                `Stage 2: ${NC_FILE_REQUEST_ENV}=${fr} is not on ${pin.instanceId}'s store host ${pin.engine}:${pin.port} — refused (no any-Pi file drop)`,
            )
        }
    }
}

export interface AppTab { url: string; active: boolean; fresh: boolean; console?: boolean }

/**
 * After an Intent: every App tab the step used (the active tab, tabs opened during the step, the
 * Console page if it navigated in-tab) must address one of this step's store pins. A tab on a Console
 * host at the Console port (or on about:/chrome: pages) is not an App tab. Returns problems (empty = ok).
 */
export const appTabProblems = (
    tabs: AppTab[],
    pins: AppPin[],
    consoleHosts: string[],
    consolePorts: number[] = [8080, 80],
): string[] => {
    const problems: string[] = []
    for (const t of tabs) {
        if (!(t.active || t.fresh || t.console)) continue
        let u: URL
        try {
            u = new URL(t.url)
        } catch {
            continue
        }
        if (!/^https?:$/.test(u.protocol)) continue
        const i166 = idea166Target(t.url, consoleHosts.filter(h => /^idea01|^100\.99\.231\.94$|^10\.99\.0\.11$/.test(h)))
        if (i166) {
            problems.push(`${t.active ? 'active' : t.fresh ? 'new' : 'Console'} tab ${u.origin} is ${i166} — never a Stage 2 fixture. No any-Pi fallback`)
            continue
        }
        if (consoleHosts.includes(u.hostname) && consolePorts.includes(portOf(u))) continue
        if (pins.some(p => urlHitsPin(t.url, p))) continue
        const want = pins.map(p => `${p.app} ${p.instanceId} → ${p.url}`).join(', ') || 'none (this step uses no App)'
        problems.push(
            `${t.active ? 'active' : t.fresh ? 'new' : 'Console'} tab ${u.origin} is not the store URL of the App this step uses (${want}) — ` +
                `a default port / another Pi answered. No any-Pi fallback`,
        )
    }
    return problems
}

/** Nextcloud's own refusal of the host it is reached by (HTTP 400 "Access through untrusted domain"). */
export const nextcloudUntrustedDomain = (status: number, body: string): boolean =>
    status === 400 && /untrusted domain/i.test(body)

/**
 * Atlas reset-r54 §2: non-fixture idea166 sidecars on idea01 — idea166-nextcloud-live :18280 and
 * idea166-kiwix-live :18380. No Stage 2 step may ever use them (pin, tab or redirect target).
 */
export const IDEA166_FORBIDDEN: readonly { name: string; port: number }[] = [
    { name: 'idea166-nextcloud-live', port: 18280 },
    { name: 'idea166-kiwix-live', port: 18380 },
]
export const IDEA01_ALIASES: readonly string[] = ['idea01', 'idea01.local', '100.99.231.94', '10.99.0.11']

/** The idea166 sidecar `url` addresses, or null. `idea01Hosts` adds --hosts aliases of idea01. */
export const idea166Target = (url: string, idea01Hosts: readonly string[] = []): string | null => {
    try {
        const u = new URL(url)
        if (![...IDEA01_ALIASES, ...idea01Hosts].includes(u.hostname)) return null
        const hit = IDEA166_FORBIDDEN.find(f => f.port === portOf(u))
        return hit ? `${hit.name} (idea01:${hit.port})` : null
    } catch {
        return null
    }
}

/**
 * A redirect (Location) from a pinned App to anywhere but that pin — e.g. Nextcloud's
 * overwrite.cli.url = http://idea01:18280 — is never followed: returns the problem, or null.
 */
export const offPinRedirect = (status: number, location: string | null, base: string, pin: Pick<AppPin, 'hosts' | 'port'>): string | null => {
    if (status < 300 || status >= 400 || !location) return null
    let target: string
    try {
        target = new URL(location, base).href
    } catch {
        return `redirect to unparsable Location '${location}'`
    }
    if (urlHitsPin(target, pin)) return null
    const i = idea166Target(target)
    return `HTTP ${status} redirect to ${target}${i ? ` = ${i}, not a fixture` : ''} — off the store URL; not followed (Nextcloud overwrite.cli.url?). No any-Pi fallback`
}
