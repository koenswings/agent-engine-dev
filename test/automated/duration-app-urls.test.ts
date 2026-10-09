/**
 * r55 (r54 FAIL@58 analysis): no "any-Pi" fallback for ANY App port in Stage 2.
 * r54 steps 21–33 passed against idea166-nextcloud-live-app on idea01:18280 (Console default Nextcloud
 * port on the Console host) — never the fixture nextcloud-grade5a-001 on idea03:61820.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { dispatchAction, syncKolibriSidecarUrlForEngine, syncNextcloudSidecarUrlForEngine, waitNextcloudSidecarReadyForEngine } from '../duration/actions.js'
import {
    APP_PORT_ENV, APP_URL_ENV, CONSOLE_DEFAULT_SIDECAR_PORTS, appTabProblems, appsUsedByStep, idea166Target, isHarnessOwned, offPinRedirect, setHarnessEnv, urlHitsPin,
    type AppPin, type SidecarApp,
} from '../duration/appUrls.js'

const K = 'duration-kolibri-grade5a-001'
const NC = 'duration-nextcloud-grade5a-001'
const KX = 'duration-kiwix-ideaa-001'
const KI = 'kolibri-grade5a-001'
const NI = 'nextcloud-grade5a-001'
const XI = 'kiwix-ideaa-001'
const COPY = '0m5xkd8inx8otbl5xsv'
const HOSTS = { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' }

type Step = { from: string; to: string; action: string }
const loadWalk = (name: string): Step[] => {
    const url = new URL(`../duration/walks/${name}.yaml`, import.meta.url)
    const p = fs.existsSync(url) ? url : new URL(`../../../test/duration/walks/${name}.yaml`, import.meta.url)
    return (parseYaml(fs.readFileSync(p, 'utf8')) as { steps: Step[] }).steps
}
const COVER_ALL = loadWalk('cover-all')

type Inst = { diskId: string; port?: number; status: string }
/** READY Stage 2 store (r54 store-after): Kolibri idea01:18080, Nextcloud idea03:61820, the step-43 copy on the NC disk. */
const readyStore = (): { instances: Record<string, Inst>; disks: Record<string, string | null> } => ({
    instances: {
        [KI]: { diskId: K, port: 18080, status: 'Running' },
        [NI]: { diskId: NC, port: 61820, status: 'Running' },
        [COPY]: { diskId: NC, port: 58312, status: 'Running' },
    },
    disks: { [K]: 'idea01', [NC]: 'idea03', [KX]: null },
})

/** What actually serves each Pi:port (r54: idea01 also has idea166's NC :18280 and Kiwix :18380; idea04 native Kolibri :18080). */
type Served = Record<string, string> // `${engine}:${port}` → instance id
const READY_SERVED: Served = { 'idea01:18080': KI, 'idea03:61820': NI, 'idea03:58312': COPY }

const mkOps = (store = readyStore(), served: Served = READY_SERVED) => {
    const owner = vi.fn(async (engine: string, inst: string, port: number) => {
        if (served[`${engine}:${port}`] !== inst) throw new Error(`Stage 2: :${port} on ${engine} is not served by ${inst} (containers: none) — another service answers there`)
        return [`${inst}-app-1`]
    })
    const ops = {
        stage: 2,
        readStore: async () => ({
            instanceDB: Object.fromEntries(Object.entries(store.instances).map(([id, i]) => [id, { id, ...i }])),
            diskDB: Object.fromEntries(Object.entries(store.disks).map(([id, on]) => [id, { id, dockedTo: on }])),
            engineDB: {},
        }),
        findDockedEngine: async (d: string) => store.disks[d] ?? null,
        verifySidecarOwner: owner,
        getHostMap: () => HOSTS,
        getStoreMode: () => 'unique',
        waitReady: async () => ({ wsUp: true }),
    }
    return { ops, owner, store }
}

/** Fake Playwright driver: records the App env each Intent saw; the Console "opens" `tabUrl(step)`. */
const mkDriver = (tabUrl: (action: string, env: NodeJS.ProcessEnv) => string | null) => {
    let seq = 0
    const tabs: { url: string; seq: number }[] = []
    const seen: { action: string; nc?: string; ko?: string; kx?: string }[] = []
    const driver = {
        kind: 'playwright' as const,
        runIntent: vi.fn(async (c: { action: string }) => {
            seen.push({ action: c.action, nc: process.env.DURATION_NEXTCLOUD_URL, ko: process.env.DURATION_KOLIBRI_URL, kx: process.env.DURATION_KIWIX_URL })
            const u = tabUrl(c.action, process.env)
            if (u) tabs.push({ url: u, seq: ++seq })
            return { ok: true, mode: 'playwright' as const, message: `runDurationIntent ok: ${c.action}` }
        }),
        tabSeq: () => seq,
        appTabs: (since = Infinity) => [
            { url: 'http://idea01:8080/', active: tabs.length === 0, fresh: false, console: true },
            ...tabs.map((t, i) => ({ url: t.url, active: i === tabs.length - 1, fresh: t.seq > since })),
        ],
    }
    return { driver, seen }
}

/** Console sidecarUrls.ts resolveSidecarUrl: env URL, else Console host + default port. */
const consoleResolve = (app: SidecarApp, env: NodeJS.ProcessEnv): string =>
    env[APP_URL_ENV[app]]?.trim() || `http://idea01:${env[APP_PORT_ENV[app]] ?? CONSOLE_DEFAULT_SIDECAR_PORTS[app]}`
const appOf = (action: string, to: string): SidecarApp | null => appsUsedByStep({ action, to })[0] ?? null

const ctxFor = (ops: unknown, driver: unknown, s: Step, n: number) => ({
    action: s.action, from: s.from, to: s.to,
    opts: { ops, uiDriver: driver, fast: true, settleTimeoutMs: 50, rng: () => 0 },
    walker: { dockedEngine: 'idea01', step: n - 1, layer: 'usage' },
    poolEngines: ['idea01', 'idea03', 'idea04'], excludeEngines: ['idea02'],
    fixtureDisk: K, fixtureInstance: KI,
    fixtureDisks: [K, NC, 'duration-empty-001', 'duration-empty-002'],
    fixtureInstances: { [K]: KI, [NC]: NI },
}) as never

const ENV_KEYS = [
    ...Object.values(APP_URL_ENV), ...Object.values(APP_PORT_ENV), 'DURATION_NC_FILE_REQUEST_URL', 'DURATION_START_INSTANCE_ID', 'DURATION_STAGE',
]
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"installed":true}', { status: 200 })))
})
afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    vi.restoreAllMocks(); vi.unstubAllGlobals()
})

const STEPS_21_33 = COVER_ALL.slice(20, 33).map((s, i) => ({ ...s, n: 21 + i }))
const NC_STEPS = [21, 22, 23, 27, 28, 29, 30, 31, 32]

describe('r55: steps 21–33 cannot pass on idea01:18280', () => {
    it('cover-all steps 21–33: exactly the in-Nextcloud steps use Nextcloud (24/33 leave, 25 return_to_start, 26 Console only)', () => {
        expect(STEPS_21_33.filter(s => appsUsedByStep(s).includes('nextcloud')).map(s => s.n)).toEqual(NC_STEPS)
        expect(STEPS_21_33.find(s => s.n === 21)!.action).toBe('open_nextcloud_as_teacher')
    })

    it('READY store: the Nextcloud URL is pinned to idea03:61820 BEFORE step 21 and every NC step, never the Console default', async () => {
        const { ops, owner } = mkOps()
        const { driver, seen } = mkDriver((a, env) => (appOf(a, '') === 'nextcloud' ? consoleResolve('nextcloud', env) : null))
        for (const s of STEPS_21_33.filter(x => x.action !== 'return_to_start')) {
            const r = await dispatchAction(ctxFor(ops, driver, s, s.n))
            expect(r.ok, `${s.n} ${s.action}: ${r.message}`).toBe(true)
        }
        const ncSeen = seen.filter(x => NC_STEPS.includes(STEPS_21_33.find(s => s.action === x.action)!.n))
        expect(ncSeen.length).toBeGreaterThan(0)
        for (const x of seen) if (x.nc) expect(x.nc).toBe('http://idea03:61820')
        expect(seen[0]!.action).toBe('open_nextcloud_as_teacher')
        expect(seen[0]!.nc).toBe('http://idea03:61820')
        expect(owner).toHaveBeenCalledWith('idea03', NI, 61820)
        expect(owner.mock.calls.some(c => c[0] === 'idea01' && c[2] === 18280)).toBe(false)
    })

    it('only idea01:18280 answers (fixture NC not served on idea03:61820) → every NC step 21–33 fails before its Intent', async () => {
        const { ops } = mkOps(readyStore(), { 'idea01:18080': KI, 'idea01:18280': 'idea166-nextcloud-live' })
        const { driver } = mkDriver(() => 'http://idea01:18280/apps/files/')
        for (const s of STEPS_21_33.filter(x => NC_STEPS.includes(x.n))) {
            const r = await dispatchAction(ctxFor(ops, driver, s, s.n))
            expect(r.ok, `${s.n} ${s.action}`).toBe(false)
            expect(r.message).toMatch(/aborted before Intent: Stage 2: :61820 on idea03 is not served by nextcloud-grade5a-001/)
        }
        expect(driver.runIntent).not.toHaveBeenCalled()
    })

    it('only idea01:18280 answers (no Nextcloud instance in the store) → loud failure naming the refused default :18280', async () => {
        const st = readyStore()
        delete st.instances[NI]; delete st.instances[COPY]; st.disks[NC] = null
        const { ops } = mkOps(st, { 'idea01:18080': KI, 'idea01:18280': 'idea166-nextcloud-live' })
        const { driver } = mkDriver(() => 'http://idea01:18280/apps/files/')
        for (const s of STEPS_21_33.filter(x => NC_STEPS.includes(x.n))) {
            const r = await dispatchAction(ctxFor(ops, driver, s, s.n))
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/nextcloud nextcloud-grade5a-001 has no live instance .* Console default :18280 .* No any-Pi fallback/)
        }
        expect(driver.runIntent).not.toHaveBeenCalled()
        expect(process.env.DURATION_NEXTCLOUD_URL).toBeUndefined()
    })

    it('owner OK, but the Console tab lands on idea01:18280 (Path A link / reused tab) → the step fails after the Intent', async () => {
        const { ops } = mkOps()
        const { driver } = mkDriver(a => (a === 'open_nextcloud_as_teacher' ? 'http://idea01:18280/apps/files/' : null))
        const s = STEPS_21_33[0]!
        const r = await dispatchAction(ctxFor(ops, driver, s, 21))
        expect(driver.runIntent).toHaveBeenCalledTimes(1)
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/active tab http:\/\/idea01:18280 is idea166-nextcloud-live \(idea01:18280\) — never a Stage 2 fixture.*Console Intent reported ok/)
    })

    it('r54 itself: fixture NC served on idea03:61820 but answers 400 "untrusted domain" → step 21 fails before the Intent, naming trusted_domains', async () => {
        const { ops } = mkOps()
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<h2>Access through untrusted domain</h2>', { status: 400 })))
        const { driver } = mkDriver(() => null)
        const r = await dispatchAction(ctxFor(ops, driver, STEPS_21_33[0]!, 21))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/http:\/\/idea03:61820 answers HTTP 400 "Access through untrusted domain" — its trusted_domains does not list idea03:61820/)
        expect(driver.runIntent).not.toHaveBeenCalled()
    })

    it('step 58 wait: untrusted-domain answers fail fast with the cause (r54 burned 420 s on "last=HTTP 400")', async () => {
        const env: NodeJS.ProcessEnv = {}
        setHarnessEnv(env, 'DURATION_NEXTCLOUD_URL', 'http://idea03:61820')
        const fetchImpl = vi.fn(async () => new Response('Access through untrusted domain', { status: 400 }))
        await expect(waitNextcloudSidecarReadyForEngine('idea03', { env, fetchImpl: fetchImpl as never, sleepImpl: async () => {}, stage2: true, untrustedFailAfter: 3 }))
            .rejects.toThrow(/refuses host 'idea03:61820': HTTP 400 "Access through untrusted domain" 3× in a row — its config.php trusted_domains/)
        expect(fetchImpl).toHaveBeenCalledTimes(3)
    })
})

describe('r55: no fallback for any App (Kolibri, Nextcloud, Kiwix, copies)', () => {
    const appStep = (app: SidecarApp): Step =>
        app === 'kolibri' ? { from: 'console_teacher', to: 'kolibri_manage', action: 'open_kolibri_as_teacher' }
        : app === 'nextcloud' ? { from: 'console_teacher', to: 'nc_browse', action: 'open_nextcloud_as_teacher' }
        : { from: 'console_learner', to: 'wiki_browse', action: 'open_wikipedia_as_learner' }
    const instOf: Record<SidecarApp, string> = { kolibri: KI, nextcloud: NI, kiwix: XI }

    for (const app of ['kolibri', 'nextcloud', 'kiwix'] as const) {
        it(`${app}: no live store instance → step fails before its Intent, Console default :${CONSOLE_DEFAULT_SIDECAR_PORTS[app]} refused`, async () => {
            const st = readyStore()
            delete st.instances[instOf[app]]
            if (app === 'nextcloud') delete st.instances[COPY]
            const { ops } = mkOps(st)
            const { driver } = mkDriver(() => null)
            const r = await dispatchAction(ctxFor(ops, driver, appStep(app), 2))
            expect(r.ok).toBe(false)
            expect(r.message).toContain(`${app} ${instOf[app]} has no live instance`)
            expect(r.message).toContain(`Console default :${CONSOLE_DEFAULT_SIDECAR_PORTS[app]}`)
            expect(driver.runIntent).not.toHaveBeenCalled()
        })
        it(`${app}: a manual ${APP_PORT_ENV[app]} / ${APP_URL_ENV[app]} that is not the store's is refused`, async () => {
            const st = readyStore()
            if (app === 'kiwix') { st.instances[XI] = { diskId: KX, port: 61380, status: 'Running' }; st.disks[KX] = 'idea04' }
            const served = { ...READY_SERVED, 'idea04:61380': XI }
            const { driver } = mkDriver(() => null)
            process.env[APP_PORT_ENV[app]] = String(CONSOLE_DEFAULT_SIDECAR_PORTS[app] + 1)
            let r = await dispatchAction(ctxFor(mkOps(st, served).ops, driver, appStep(app), 2))
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(new RegExp(`${APP_PORT_ENV[app]}=\\d+ was set outside the harness`))
            delete process.env[APP_PORT_ENV[app]]
            process.env[APP_URL_ENV[app]] = `http://idea04:${CONSOLE_DEFAULT_SIDECAR_PORTS[app] + 2}` // another Pi / port than the store's
            r = await dispatchAction(ctxFor(mkOps(st, served).ops, driver, appStep(app), 2))
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(new RegExp(`${APP_URL_ENV[app]}=http://idea04:${CONSOLE_DEFAULT_SIDECAR_PORTS[app] + 2} was set outside the harness`))
            expect(driver.runIntent).not.toHaveBeenCalled()
        })
        it(`${app}: store instance whose port is served by something else (idea04 native Kolibri, idea166 sidecars) → owner check fails`, async () => {
            const st = readyStore()
            st.instances[XI] = { diskId: KX, port: 18380, status: 'Running' }; st.disks[KX] = 'idea01'
            if (app === 'kolibri') st.disks[K] = 'idea04' // moved, but idea04:18080 is the native kolibri-0.15.5
            const { ops } = mkOps(st, { 'idea03:61820': NI, 'idea04:18080': 'native-kolibri', 'idea01:18380': 'idea166-kiwix-live' })
            if (app === 'nextcloud') st.instances[NI]!.port = 18280
            const { driver } = mkDriver(() => null)
            const r = await dispatchAction(ctxFor(ops, driver, appStep(app), 2))
            expect(r.ok).toBe(false)
            // kiwix on idea01:18380 is caught even earlier: it IS idea166-kiwix-live.
            expect(r.message).toMatch(app === 'kiwix' ? /idea166-kiwix-live \(idea01:18380\) — never a Stage 2 fixture/ : new RegExp(`is not served by ${instOf[app]}`))
            expect(driver.runIntent).not.toHaveBeenCalled()
        })
    }

    it('Kiwix in the real Stage 2 store (no kiwix-ideaa-001 instance) → open_wikipedia_* fails loud instead of using idea166-kiwix-live :18380', async () => {
        const { ops } = mkOps()
        const { driver } = mkDriver(() => 'http://idea01:18380/viewer#wikipedia')
        const s = COVER_ALL[33]!
        expect(s.action).toBe('open_wikipedia_as_learner')
        const r = await dispatchAction(ctxFor(ops, driver, s, 34))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/kiwix kiwix-ideaa-001 has no live instance .* Console default :18380/)
    })

    it('a copy (open_app on the step-43 copy) is pinned to ITS Pi + port from the store and owner-checked there', async () => {
        const { ops, owner } = mkOps()
        process.env.DURATION_START_INSTANCE_ID = COPY
        const { driver, seen } = mkDriver((_a, env) => consoleResolve('kolibri', env))
        const r = await dispatchAction(ctxFor(ops, driver, { from: 'op_instance', to: 'op_instance', action: 'open_app' }, 111))
        expect(r.ok, r.message).toBe(true)
        expect(seen[0]!.ko).toBe('http://10.0.0.3:58312')
        expect(owner).toHaveBeenCalledWith('idea03', COPY, 58312)
    })

    it('Kolibri tab on idea04:18080 (native Kolibri) while the store has the fixture on idea01 → fails after the Intent', async () => {
        const { ops } = mkOps()
        const { driver } = mkDriver(() => 'http://idea04:18080/en/coach/')
        const r = await dispatchAction(ctxFor(ops, driver, { from: 'console_teacher', to: 'kolibri_manage', action: 'open_kolibri_as_teacher' }, 2))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/active tab http:\/\/idea04:18080 is not the store URL .*kolibri kolibri-grade5a-001 → http:\/\/10.0.0.1:18080/)
    })

    it('a Kolibri tab via the logical hostname (Path A) is the same Pi + port → accepted', async () => {
        const { ops } = mkOps()
        const { driver } = mkDriver(() => 'http://idea01:18080/en/coach/')
        const r = await dispatchAction(ctxFor(ops, driver, { from: 'console_teacher', to: 'kolibri_manage', action: 'open_kolibri_as_teacher' }, 2))
        expect(r.ok, r.message).toBe(true)
        expect(r.message).toMatch(/app tabs on store URLs \(http:\/\/10.0.0.1:18080\)/)
    })

    it('an instance that is not Running after the step fails (the App used was not this instance)', async () => {
        const { ops, store } = mkOps()
        const { driver } = mkDriver(() => { store.instances[KI]!.status = 'Stopped'; return 'http://idea01:18080/' })
        const r = await dispatchAction(ctxFor(ops, driver, { from: 'kolibri_manage', to: 'kolibri_manage', action: 'create_class' }, 3))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/kolibri-grade5a-001 is Stopped on idea01 after the step/)
    })

    it('NC file-drop override must be on the store host', async () => {
        const { ops } = mkOps()
        process.env.DURATION_NC_FILE_REQUEST_URL = 'http://idea01:18280/s/grade5adropzone'
        const { driver } = mkDriver(() => null)
        const r = await dispatchAction(ctxFor(ops, driver, { from: 'nc_browse', to: 'nc_drop', action: 'open_file_drop' }, 28))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/DURATION_NC_FILE_REQUEST_URL=http:\/\/idea01:18280\/s\/grade5adropzone is not on nextcloud-grade5a-001's store host idea03:61820/)
    })

    it('Stage 2 sync helpers never fall back to a default port; a harness-set URL is honoured, a manual one refused', () => {
        const env: NodeJS.ProcessEnv = {}
        expect(() => syncKolibriSidecarUrlForEngine('idea01', HOSTS, env, undefined, { stage2: true })).toThrow(/refusing the Console default :18080/)
        expect(() => syncNextcloudSidecarUrlForEngine('idea03', undefined, env, undefined, { stage2: true })).toThrow(/refusing the Console default :18280/)
        expect(syncNextcloudSidecarUrlForEngine('idea03', undefined, env, 61820, { stage2: true })).toBe('http://idea03:61820')
        expect(isHarnessOwned(env, 'DURATION_NEXTCLOUD_URL')).toBe(true)
        expect(syncNextcloudSidecarUrlForEngine('idea03', undefined, env, undefined, { stage2: true })).toBe('http://idea03:61820')
        const manual: NodeJS.ProcessEnv = { DURATION_NEXTCLOUD_URL: 'http://idea01:18280' }
        expect(() => syncNextcloudSidecarUrlForEngine('idea03', undefined, manual, 61820, { stage2: true })).toThrow(/set outside the harness/)
        // Stage 1 unchanged.
        expect(syncNextcloudSidecarUrlForEngine('idea01', undefined, {})).toBe('http://idea01:18280')
        expect(syncKolibriSidecarUrlForEngine('idea01', undefined, {})).toBe('http://idea01:18080')
    })

    it('tab check: Console tabs and about: pages pass; any other host/port fails; aliases of the pinned Pi pass', () => {
        const pin: AppPin = { app: 'nextcloud', instanceId: NI, engine: 'idea03', port: 61820, url: 'http://idea03:61820', hosts: ['idea03', 'idea03.local', '10.0.0.3'] }
        expect(urlHitsPin('http://10.0.0.3:61820/login', pin)).toBe(true)
        expect(urlHitsPin('http://idea03:18280/', pin)).toBe(false)
        const consoleHosts = ['idea01', '10.0.0.1', 'idea03']
        expect(appTabProblems([{ url: 'http://idea01:8080/', active: true, fresh: false, console: true }, { url: 'about:blank', active: false, fresh: true }], [pin], consoleHosts)).toEqual([])
        expect(appTabProblems([{ url: 'http://idea03.local:61820/apps/files', active: true, fresh: true }], [pin], consoleHosts)).toEqual([])
        expect(appTabProblems([{ url: 'http://idea01:18280/', active: false, fresh: true }], [pin], consoleHosts)[0]).toMatch(/new tab http:\/\/idea01:18280/)
        // an old background tab that the step neither opened nor is on is not this step's
        expect(appTabProblems([{ url: 'http://idea01:18280/', active: false, fresh: false }], [pin], consoleHosts)).toEqual([])
    })
})

describe('r55 (Atlas reset-r54): never idea166-*-live on idea01; never follow overwrite.cli.url', () => {
    const WIKI = COVER_ALL.slice(33, 36).map((st, i) => ({ ...st, n: 34 + i }))
    it('idea166Target recognises both sidecars by every idea01 alias; fixtures are not idea166', () => {
        for (const h of ['idea01', 'idea01.local', '100.99.231.94', '10.99.0.11']) {
            expect(idea166Target(`http://${h}:18280/login`)).toMatch(/idea166-nextcloud-live/)
            expect(idea166Target(`http://${h}:18380/viewer`)).toMatch(/idea166-kiwix-live/)
        }
        expect(idea166Target('http://10.0.0.1:18280/', ['10.0.0.1'])).toMatch(/idea166-nextcloud-live/)
        expect(idea166Target('http://idea03:61820/')).toBeNull()
        expect(idea166Target('http://idea01:18080/')).toBeNull()
    })
    it('Wikipedia steps 34–36: Console would hit idea01:18380 (idea166-kiwix-live) → every Kiwix step fails, Intent never runs', async () => {
        expect(WIKI.map(w => w.action)).toEqual(['open_wikipedia_as_learner', 'search_browse_wikipedia', 'leave_wikipedia_as_learner'])
        const { ops } = mkOps()
        const { driver } = mkDriver((_a, env) => consoleResolve('kiwix', env))
        for (const w of WIKI.filter(x => appsUsedByStep(x).includes('kiwix'))) {
            const r = await dispatchAction(ctxFor(ops, driver, w, w.n))
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/kiwix kiwix-ideaa-001 has no live instance/)
        }
        expect(driver.runIntent).not.toHaveBeenCalled()
    })
    it('a store row that points Kiwix / Nextcloud at idea01:18380 / :18280 is refused as idea166 even if "owned"', async () => {
        const st = readyStore()
        st.instances[XI] = { diskId: KX, port: 18380, status: 'Running' }; st.disks[KX] = 'idea01'
        const { ops } = mkOps(st, { ...READY_SERVED, 'idea01:18380': XI })
        const { driver } = mkDriver(() => null)
        const r = await dispatchAction(ctxFor(ops, driver, WIKI[0]!, 34))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/idea166-kiwix-live \(idea01:18380\) — never a Stage 2 fixture/)
    })
    it('Kiwix pinned correctly but the tab lands on idea01:18380 → fails after the Intent naming idea166-kiwix-live', async () => {
        const st = readyStore()
        st.instances[XI] = { diskId: KX, port: 61380, status: 'Running' }; st.disks[KX] = 'idea04'
        const { ops } = mkOps(st, { ...READY_SERVED, 'idea04:61380': XI })
        const { driver } = mkDriver(() => 'http://idea01:18380/viewer#wikipedia/A/Main_Page')
        const r = await dispatchAction(ctxFor(ops, driver, WIKI[0]!, 34))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/tab http:\/\/idea01:18380 is idea166-kiwix-live/)
    })
    it('Nextcloud steps: a tab on idea01:18280 is named idea166-nextcloud-live and fails', async () => {
        const { ops } = mkOps()
        const { driver } = mkDriver(() => 'http://100.99.231.94:18280/apps/files/')
        const r = await dispatchAction(ctxFor(ops, driver, STEPS_21_33[0]!, 21))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/tab http:\/\/100.99.231.94:18280 is idea166-nextcloud-live/)
    })
    it('offPinRedirect: on-pin redirect ok; overwrite.cli.url redirect to idea01:18280 is a problem', () => {
        const pin = { hosts: ['idea03'], port: 61820 }
        expect(offPinRedirect(302, '/login?redirect_url=x', 'http://idea03:61820/', pin)).toBeNull()
        expect(offPinRedirect(200, null, 'http://idea03:61820/', pin)).toBeNull()
        expect(offPinRedirect(302, 'http://idea01:18280/login', 'http://idea03:61820/', pin)).toMatch(/redirect to http:\/\/idea01:18280\/login = idea166-nextcloud-live .* not followed/)
    })
    it('step 21 pre-check: status.php redirecting to idea01:18280 fails loud before the Intent', async () => {
        const { ops } = mkOps()
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://idea01:18280/status.php' } })))
        const { driver } = mkDriver(() => null)
        const r = await dispatchAction(ctxFor(ops, driver, STEPS_21_33[0]!, 21))
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/redirect to http:\/\/idea01:18280\/status.php = idea166-nextcloud-live/)
        expect(driver.runIntent).not.toHaveBeenCalled()
    })
    it('step 58 wait: never follows the overwrite.cli.url redirect (fails at once); follows on-pin redirects by hand', async () => {
        const env: NodeJS.ProcessEnv = {}
        setHarnessEnv(env, 'DURATION_NEXTCLOUD_URL', 'http://idea03:61820')
        const off = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://idea01:18280/login' } }))
        await expect(waitNextcloudSidecarReadyForEngine('idea03', { env, fetchImpl: off as never, sleepImpl: async () => {}, stage2: true }))
            .rejects.toThrow(/redirect to http:\/\/idea01:18280\/login = idea166-nextcloud-live .* not followed/)
        expect(off).toHaveBeenCalledTimes(1)
        expect((off.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' })
        const LOGIN = '<form><input name="user"><input name="password"><button type="submit">Log in</button></form>'
        const on = vi.fn(async (u: string) => (u === 'http://idea03:61820/login'
            ? new Response(null, { status: 303, headers: { location: '/index.php/login' } })
            : new Response(LOGIN, { status: 200 })))
        expect(await waitNextcloudSidecarReadyForEngine('idea03', { env, fetchImpl: on as never, sleepImpl: async () => {}, stage2: true })).toMatch(/login form ready/)
        expect(on.mock.calls.map(c => c[0])).toEqual(['http://idea03:61820/login', 'http://idea03:61820/index.php/login'])
    })
})
