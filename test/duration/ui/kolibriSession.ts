/**
 * Kolibri role-session guards for the Playwright driver (Markov fd72ee8 FAIL@403, idea#168).
 *
 * The walker drives every step in ONE browser context, so Kolibri's session cookie survives a role switch:
 * open_kolibri_as_learner signs in learner01, return_to_start closes the App tab but not the cookie, and a later
 * open_kolibri_as_teacher opens a Kolibri tab that is already signed in as learner01. Pixel's attemptAppLogin then
 * returns 'already_in' for ANY signed-in user (it only checks the URL path), so no teacher login happens and
 * /en/coach/#/classes answers "You must be signed in as an admin or coach to view this page" (HTTP 200).
 *
 * The harness therefore, for the Kolibri role-entry Intents only:
 *   - before the Intent: closes every Kolibri App tab and clears the Kolibri cookies (name /^kolibri/), so the
 *     Intent always meets the Kolibri sign-in form and logs in as the requested role (Console and Nextcloud
 *     cookies are untouched);
 *   - after the Intent: reads Kolibri's own session API (/api/auth/session/current/) through the same context and
 *     fails with a clear 'wrong Kolibri session' message when the signed-in user is not the requested one;
 *   - when the Intent itself fails: appends the signed-in Kolibri user to the failure, so a wrong session is named.
 */

export type KolibriRole = 'teacher' | 'learner'

/** The Kolibri role-entry Intents and the role each must end up signed in as. */
export const KOLIBRI_ROLE_INTENTS: ReadonlyMap<string, KolibriRole> = new Map([
    ['open_kolibri_as_teacher', 'teacher'],
    ['open_kolibri_as_learner', 'learner'],
])

export const kolibriRoleFor = (action: string): KolibriRole | null => KOLIBRI_ROLE_INTENTS.get(action) ?? null

/** Kid fixture usernames (Pixel e2e/intents/fixtures.ts kolibri.auth); env overrides for another pack. */
export const expectedKolibriUser = (role: KolibriRole, env: NodeJS.ProcessEnv = process.env): string =>
    role === 'teacher'
        ? (env.DURATION_KOLIBRI_TEACHER_USER || 'teacher')
        : (env.DURATION_KOLIBRI_LEARNER_USER || 'learner01')

/** Kolibri's session and CSRF cookies ("kolibri", "kolibri_csrftoken"); the Console and Nextcloud use other names. */
export const KOLIBRI_COOKIE_RE = /^kolibri/

/** Kolibri sidecar ports (fixture 18080 on idea01, 18081 on idea03) plus DURATION_KOLIBRI_PORT. */
const kolibriPorts = (env: NodeJS.ProcessEnv = process.env): Set<string> => {
    const ports = new Set(['18080', '18081'])
    if (env.DURATION_KOLIBRI_PORT) ports.add(String(env.DURATION_KOLIBRI_PORT))
    return ports
}

/** True for a Kolibri App tab URL: a Kolibri sidecar port, or a Kolibri route (learn/coach/facility/device/auth). */
export const isKolibriUrl = (url: string, env: NodeJS.ProcessEnv = process.env): boolean => {
    let u: URL
    try { u = new URL(url) } catch { return false }
    if (!/^https?:$/.test(u.protocol)) return false
    if (kolibriPorts(env).has(u.port)) return true
    return /^\/([a-z]{2}(-[a-z]+)?\/)?(learn|coach|facility|device|auth)\/?$/i.test(u.pathname) && u.hash.startsWith('#/')
}

/** The slice of a Playwright Page these guards use (fakes in unit tests). */
export interface SessionPage {
    url(): string
    isClosed?(): boolean
    close(): Promise<unknown>
}

/** The slice of a Playwright APIResponse / APIRequestContext / BrowserContext these guards use. */
export interface SessionResponse {
    ok(): boolean
    status(): number
    json(): Promise<unknown>
}
export interface SessionRequest {
    get(url: string, o?: { timeout?: number; failOnStatusCode?: boolean; maxRedirects?: number }): Promise<SessionResponse>
}
export interface SessionContext {
    clearCookies(o?: { name?: string | RegExp }): Promise<unknown>
    request?: SessionRequest
}

const open = (p: SessionPage): boolean => {
    try { return p.isClosed?.() !== true } catch { return false }
}
const urlOf = (p: SessionPage): string => {
    try { return p.url() } catch { return '' }
}

/**
 * Before open_kolibri_as_*: close every Kolibri App tab (never `consolePage`) and clear the Kolibri cookies.
 * Returns a note for the step message ('' for other Intents). Throws only if clearing the cookies throws.
 */
export const resetKolibriSession = async (
    action: string,
    context: SessionContext | null,
    consolePage: SessionPage | null,
    all: readonly SessionPage[],
): Promise<string> => {
    if (!kolibriRoleFor(action)) return ''
    const closed: string[] = []
    for (const p of all) {
        if (p === consolePage || !open(p)) continue
        const u = urlOf(p)
        if (!isKolibriUrl(u)) continue
        await p.close().catch(() => undefined)
        closed.push(u)
    }
    if (context) {
        try {
            await context.clearCookies({ name: KOLIBRI_COOKIE_RE })
        } catch (err) {
            throw new Error(`${action}: could not clear the Kolibri session cookies before the role switch: ${(err as Error).message}`)
        }
    }
    return `fresh Kolibri session (cookies cleared${closed.length ? `, closed ${closed.join(', ')}` : ''})`
}

/** Kolibri origin of the tab the Intent left: the active tab if it is Kolibri, else the newest open Kolibri tab. */
export const kolibriOriginOf = (active: SessionPage | null, all: readonly SessionPage[]): string | null => {
    const pick = [active, ...[...all].reverse()].find(p => p && open(p) && isKolibriUrl(urlOf(p)))
    if (!pick) return null
    try { return new URL(urlOf(pick)).origin } catch { return null }
}

export type KolibriSessionRead =
    | { state: 'read'; username: string | null; kind: string[] }
    | { state: 'unread'; reason: string }

/** GET <origin>/api/auth/session/current/ through the walker's context (same cookies as the tab). */
export const readKolibriSession = async (
    request: SessionRequest | undefined,
    origin: string,
    timeoutMs = 10_000,
): Promise<KolibriSessionRead> => {
    if (!request) return { state: 'unread', reason: 'context has no request API' }
    try {
        const resp = await request.get(`${origin}/api/auth/session/current/`, {
            timeout: timeoutMs,
            failOnStatusCode: false,
            maxRedirects: 0,
        })
        if (!resp.ok()) return { state: 'unread', reason: `HTTP ${resp.status()}` }
        const body = (await resp.json()) as { username?: unknown; kind?: unknown }
        const username = typeof body?.username === 'string' && body.username ? body.username : null
        const kind = Array.isArray(body?.kind) ? body.kind.map(String) : []
        return { state: 'read', username, kind }
    } catch (err) {
        return { state: 'unread', reason: (err as Error).message.split('\n')[0] ?? 'request failed' }
    }
}

const describeRead = (r: KolibriSessionRead): string =>
    r.state === 'read'
        ? `${r.username ?? '(anonymous)'} (kind=${r.kind.join('/') || 'none'})`
        : `unknown (${r.reason})`

/**
 * After a successful open_kolibri_as_*: the Kolibri session must be the requested user.
 * Throws 'wrong Kolibri session' on a mismatch (another user, or anonymous = the login did not take).
 * Returns a note when the session could not be read (no Kolibri tab / API unreachable): never a silent pass.
 */
export const assertKolibriSession = async (
    action: string,
    request: SessionRequest | undefined,
    active: SessionPage | null,
    all: readonly SessionPage[],
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
    const role = kolibriRoleFor(action)
    if (!role) return ''
    const want = expectedKolibriUser(role, env)
    const origin = kolibriOriginOf(active, all)
    if (!origin) return `Kolibri session unverified: no open Kolibri tab after ${action}`
    const r = await readKolibriSession(request, origin)
    if (r.state === 'unread') return `Kolibri session unverified at ${origin}: ${r.reason}`
    if (r.username !== want) {
        throw new Error(
            `${action}: wrong Kolibri session at ${origin}: expected ${role} '${want}', ` +
                `signed in as ${describeRead(r)} — the role login did not take (stale session or silent login failure)`,
        )
    }
    return `Kolibri session ${want} verified`
}

/** On an Intent failure: name the signed-in Kolibri user so a wrong session is visible in the step message. */
export const kolibriSessionHint = async (
    action: string,
    request: SessionRequest | undefined,
    active: SessionPage | null,
    all: readonly SessionPage[],
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
    const role = kolibriRoleFor(action)
    if (!role) return ''
    const origin = kolibriOriginOf(active, all)
    if (!origin) return ''
    const r = await readKolibriSession(request, origin, 5_000)
    const want = expectedKolibriUser(role, env)
    if (r.state === 'read' && r.username !== want) {
        return ` [wrong Kolibri session: expected ${role} '${want}', signed in as ${describeRead(r)}]`
    }
    return ` [Kolibri session: ${describeRead(r)}]`
}
