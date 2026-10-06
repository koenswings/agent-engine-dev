/**
 * idea#168 r38 store preflight (Koen's standing rule): the live pool idea01/03/04 is an exact
 * production replica — ONE shared dev store (doc 3zoqd…), mDNS discovery ON, NO static peers.
 * Before step 1 of EVERY live run (any scenario / walk), each pool Pi must show exactly that, or
 * the run exits EXIT_STORE_PREFLIGHT naming the Pi, the field and expected vs actual.
 * idea02 is never probed (refused before any ssh).
 *
 * Values are read the way the Engine (f65183a on the pool) resolves them — READ-ONLY ssh as
 * pi (cat / grep / pgrep / sudo -n cat of /proc/<pid>/environ when granted; nothing written):
 *   - store id: <engineDir>/<settings.storeIdentityFolder>/store-url.txt (StoreIdentity.ts
 *     readStoreDocId) AND the running Engine's own report GET http://<pi>:<settings.httpPort>
 *     /api/store-url (httpMonitor.ts) AND, when the harness holds a WS connection, the doc it
 *     syncs from that Engine plus the Engine's own engineDB row in it.
 *   - mDNS: start.ts runs the mDNS monitor iff `config.settings.mdns === true` and
 *     IDEA_MDNS_DISABLE !== 'true' (Config.ts env override).
 *   - static peers: StaticPeers.ts staticPeersSetting() = process.env.IDEA_STATIC_PEERS ??
 *     config.settings.staticPeers; any non-blank value dials static peers.
 *   - env overrides: the running Engine's /proc/<pid>/environ when readable (root-owned pm2:
 *     needs sudo -n), else what pm2.config.cjs in the Engine dir declares (the source pm2
 *     starts the Engine with). The source used is logged.
 */

import { parse as parseYaml } from 'yaml'

/** Exit code of a failed store preflight (1 walk failures, 2 fatal, 4 engine unreachable, 5 Console pin). */
export const EXIT_STORE_PREFLIGHT = 6

export const DEFAULT_EXPECTED_STORE_ID = '3zoqd'
export const DEFAULT_ENGINE_DIR = '/home/pi/idea/agents/agent-engine-dev'
const NEVER = 'idea02'

/** DURATION_EXPECTED_STORE_ID (id or automerge: URL, full or ≥5-char prefix), default 3zoqd. */
export const expectedStoreId = (env: NodeJS.ProcessEnv = process.env): string => {
    const v = (env.DURATION_EXPECTED_STORE_ID ?? '').trim().replace(/^automerge:/, '')
    if (!v) return DEFAULT_EXPECTED_STORE_ID
    if (v.length < 5 || !/^[A-Za-z0-9]+$/.test(v)) {
        throw new Error(`DURATION_EXPECTED_STORE_ID='${env.DURATION_EXPECTED_STORE_ID}' must be a store doc id (≥5 base58 chars)`)
    }
    return v
}

/** Store doc id (bare or automerge:URL) matches the expected full id or prefix. */
export const storeIdMatches = (actual: string | null | undefined, expected: string): boolean => {
    const a = (actual ?? '').trim().replace(/^automerge:/, '')
    return !!a && (a === expected || a.startsWith(expected))
}

const MARK = '@@DSP@@'

/** Read-only remote script: config.yaml, store-url.txt, pm2.config.cjs, running Engine env (2 keys). */
export const storeProbeScript = (engineDir = DEFAULT_ENGINE_DIR): string => [
    `d='${engineDir}'`,
    `echo '${MARK} config'; cat "$d/config.yaml" 2>/dev/null || echo '${MARK}_MISSING'`,
    `f=$(sed -n 's/^[[:space:]]*storeIdentityFolder:[[:space:]]*\\([^[:space:]#]*\\).*/\\1/p' "$d/config.yaml" 2>/dev/null | head -1 | tr -d "\\"'")`,
    `echo '${MARK} storeurl'; cat "$d/\${f:-store-identity}/store-url.txt" 2>/dev/null || echo '${MARK}_MISSING'; echo`,
    `echo '${MARK} pm2config'; cat "$d/pm2.config.cjs" 2>/dev/null || echo '${MARK}_MISSING'`,
    `echo '${MARK} proc'`,
    `pid=$(pgrep -f "$d/dist/src/index.js" | head -1); echo "pid=\${pid:-none}"`,
    `if [ -n "$pid" ]; then if sudo -n true 2>/dev/null; then S='sudo -n'; else S=''; fi; ` +
        `if $S cat /proc/$pid/environ >/dev/null 2>&1; then echo "environ=readable"; ` +
        `$S cat /proc/$pid/environ 2>/dev/null | tr '\\0' '\\n' | grep -E '^(IDEA_MDNS_DISABLE|IDEA_STATIC_PEERS)=' | sed 's/^/env:/'; ` +
        `else echo "environ=unreadable"; fi; fi`,
    `echo '${MARK} end'`,
].join('; ')

export interface StoreProbeRaw {
    config: string | null
    storeUrl: string | null
    pm2Config: string | null
    pid: string | null
    environReadable: boolean
    procEnv: Record<string, string>
}

export const parseStoreProbe = (out: string): StoreProbeRaw => {
    const sections: Record<string, string[]> = {}
    let cur: string | null = null
    for (const line of String(out ?? '').split('\n')) {
        const m = new RegExp(`^${MARK} (\\w+)$`).exec(line.trim())
        if (m) { cur = m[1]!; sections[cur] = []; continue }
        if (cur) sections[cur]!.push(line)
    }
    const body = (k: string): string | null => {
        const s = sections[k]
        if (!s) return null
        const t = s.join('\n')
        return t.includes(`${MARK}_MISSING`) ? null : t
    }
    const proc = sections.proc ?? []
    const procEnv: Record<string, string> = {}
    for (const l of proc) {
        const m = /^env:(IDEA_MDNS_DISABLE|IDEA_STATIC_PEERS)=(.*)$/.exec(l)
        if (m) procEnv[m[1]!] = m[2]!
    }
    const pid = proc.map(l => /^pid=(.*)$/.exec(l.trim())?.[1]).find(Boolean) ?? null
    return {
        config: body('config'),
        storeUrl: body('storeurl')?.trim() || null,
        pm2Config: body('pm2config'),
        pid: pid === 'none' ? null : pid,
        environReadable: proc.some(l => l.trim() === 'environ=readable'),
        procEnv,
    }
}

/** IDEA_* declared in pm2.config.cjs (string/boolean literal). undefined = not declared; 'UNPARSABLE' = mentioned but unreadable. */
export const pm2DeclaredEnv = (text: string | null, key: string): string | undefined | 'UNPARSABLE' => {
    if (!text || !text.includes(key)) return undefined
    const m = new RegExp(`["']?${key}["']?\\s*:\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`|(true|false|\\d+))`).exec(text)
    if (!m) return 'UNPARSABLE'
    return m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
}

export interface StorePreflightPi {
    pi: string
    host: string
    ok: boolean
    storeUrlFile: string | null
    apiStoreUrl: string | null
    wsStoreDocId: string | null
    wsEngineRow: boolean | null
    configMdns: unknown
    mdnsDisableEnv: string | null
    mdns: boolean | null
    configStaticPeers: unknown
    staticPeersEnv: string | null
    staticPeers: string | null
    envSource: 'process' | 'pm2.config.cjs'
    enginePid: string | null
    httpPort: number | null
}

export interface StoreMismatch { pi: string; field: string; expected: string; actual: string }

export interface StorePreflightInput {
    pi: string
    host: string
    probe: StoreProbeRaw | null
    probeError?: string | null
    apiStoreUrl: string | null
    apiError?: string | null
    /** Harness WS connection to this Engine (null = none open). */
    ws?: { docId: string; engineRow: boolean } | null
}

/** Pure verdict for one Pi. */
export const storePreflightPi = (i: StorePreflightInput, expected: string): { pi: StorePreflightPi; mismatches: StoreMismatch[] } => {
    const mm: StoreMismatch[] = []
    const bad = (field: string, exp: string, actual: string) => mm.push({ pi: i.pi, field, expected: exp, actual })
    const base: StorePreflightPi = {
        pi: i.pi, host: i.host, ok: false, storeUrlFile: null, apiStoreUrl: i.apiStoreUrl, wsStoreDocId: i.ws?.docId ?? null,
        wsEngineRow: i.ws ? i.ws.engineRow : null, configMdns: null, mdnsDisableEnv: null, mdns: null, configStaticPeers: null,
        staticPeersEnv: null, staticPeers: null, envSource: 'pm2.config.cjs', enginePid: null, httpPort: null,
    }
    if (i.pi === NEVER) {
        bad('pool', 'never idea02', 'idea02 in pool')
        return { pi: base, mismatches: mm }
    }
    if (!i.probe) {
        bad('ssh', `read-only ssh pi@${i.host} answers`, `unreachable: ${i.probeError ?? 'no output'}`)
        return { pi: base, mismatches: mm }
    }
    const p = i.probe
    base.storeUrlFile = p.storeUrl
    base.enginePid = p.pid
    let settings: Record<string, unknown> = {}
    if (p.config == null) {
        bad('config.yaml', 'readable', 'missing')
    } else {
        try {
            const y = parseYaml(p.config) as Record<string, unknown> | null
            settings = (y && typeof y.settings === 'object' && y.settings) ? y.settings as Record<string, unknown> : {}
            if (!y || typeof y.settings !== 'object') bad('config.yaml settings', 'present', 'missing')
        } catch (e) {
            bad('config.yaml', 'valid YAML', `parse error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        }
    }
    base.httpPort = typeof settings.httpPort === 'number' ? settings.httpPort : null
    // env overrides: running process when readable, else pm2.config.cjs
    const envOf = (key: string): string | null => {
        if (p.environReadable) return key in p.procEnv ? p.procEnv[key]! : null
        const v = pm2DeclaredEnv(p.pm2Config, key)
        if (v === 'UNPARSABLE') { bad(`pm2.config.cjs ${key}`, 'a literal value', 'mentioned but not readable'); return null }
        return v === undefined ? null : v
    }
    base.envSource = p.environReadable ? 'process' : 'pm2.config.cjs'
    // (a) store id
    if (!storeIdMatches(p.storeUrl, expected)) bad('store-url.txt', `automerge:${expected}…`, p.storeUrl ?? 'missing')
    if (!storeIdMatches(i.apiStoreUrl, expected)) {
        bad('running Engine /api/store-url', `automerge:${expected}…`, i.apiStoreUrl ?? `no answer${i.apiError ? ` (${i.apiError})` : ''}`)
    }
    if (i.ws) {
        if (!storeIdMatches(i.ws.docId, expected)) bad('harness WS store doc', expected, i.ws.docId)
        else if (!i.ws.engineRow) bad('harness WS store doc', `${i.pi}'s own engineDB row in ${expected}`, 'no row for this Engine')
    }
    // (b) mDNS: settings.mdns === true && IDEA_MDNS_DISABLE !== 'true'
    base.configMdns = settings.mdns ?? null
    base.mdnsDisableEnv = envOf('IDEA_MDNS_DISABLE')
    base.mdns = settings.mdns === true && base.mdnsDisableEnv !== 'true'
    if (settings.mdns !== true) bad('mdns (config.yaml settings.mdns)', 'true', JSON.stringify(settings.mdns ?? null))
    if (base.mdnsDisableEnv === 'true') bad(`mdns (IDEA_MDNS_DISABLE via ${base.envSource})`, 'unset / not true', 'true')
    // (c) static peers: IDEA_STATIC_PEERS ?? settings.staticPeers, non-blank = on
    base.configStaticPeers = settings.staticPeers ?? null
    base.staticPeersEnv = envOf('IDEA_STATIC_PEERS')
    const eff = base.staticPeersEnv ?? (typeof settings.staticPeers === 'string' ? settings.staticPeers : settings.staticPeers == null ? null : String(settings.staticPeers))
    base.staticPeers = eff
    if (eff != null && eff.trim()) {
        const src = base.staticPeersEnv != null ? `IDEA_STATIC_PEERS via ${base.envSource}` : 'config.yaml settings.staticPeers'
        bad(`static peers (${src})`, 'none', JSON.stringify(eff))
    }
    if (!p.pid) bad('engine process', `node ${DEFAULT_ENGINE_DIR}/dist/src/index.js running`, 'not found')
    base.ok = mm.length === 0
    return { pi: base, mismatches: mm }
}

export const formatStoreMismatch = (m: StoreMismatch): string =>
    `store_preflight: ${m.pi}: ${m.field}: expected ${m.expected}, actual ${m.actual}`

export interface StorePreflightDeps {
    probe: (pi: string, host: string) => Promise<string>
    fetchStoreUrl: (host: string, httpPort: number) => Promise<string>
    ws?: (pi: string) => { docId: string; engineRow: boolean } | null
}

/** Run the store preflight over the pool. idea02 is refused before any probe. */
export const runStorePreflight = async (
    pool: string[],
    hosts: Record<string, string>,
    deps: StorePreflightDeps,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; expected: string; pis: StorePreflightPi[]; mismatches: StoreMismatch[] }> => {
    const expected = expectedStoreId(env)
    const results = await Promise.all(pool.map(async pi => {
        const host = hosts[pi] ?? pi
        if (pi === NEVER) return storePreflightPi({ pi, host, probe: null, apiStoreUrl: null }, expected)
        let probe: StoreProbeRaw | null = null
        let probeError: string | null = null
        try {
            probe = parseStoreProbe(await deps.probe(pi, host))
        } catch (e) {
            probeError = (e instanceof Error ? e.message : String(e)).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
        }
        let apiStoreUrl: string | null = null
        let apiError: string | null = null
        if (probe) {
            let port = 80
            try {
                const y = probe.config ? parseYaml(probe.config) as { settings?: { httpPort?: unknown } } : null
                if (typeof y?.settings?.httpPort === 'number') port = y.settings.httpPort
            } catch { /* reported by the verdict */ }
            try {
                const body = await deps.fetchStoreUrl(host, port)
                const j = JSON.parse(body) as { url?: unknown }
                apiStoreUrl = typeof j.url === 'string' ? j.url : null
                if (!apiStoreUrl) apiError = `no url in ${body.slice(0, 120)}`
            } catch (e) {
                apiError = e instanceof Error ? e.message : String(e)
            }
        }
        return storePreflightPi({ pi, host, probe, probeError, apiStoreUrl, apiError, ws: deps.ws?.(pi) ?? null }, expected)
    }))
    const mismatches = results.flatMap(r => r.mismatches)
    if (pool.length === 0) mismatches.push({ pi: '(pool)', field: 'pool', expected: 'idea01, idea03, idea04', actual: 'empty' })
    return { ok: mismatches.length === 0, expected, pis: results.map(r => r.pi), mismatches }
}
