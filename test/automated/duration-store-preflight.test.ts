/**
 * idea#168 r38: live store preflight (one shared dev store 3zoqd, mDNS ON, no static peers),
 * META.yaml identity by parsed diskId + created (never bytes / sha), and the Console pin
 * telling d637b83 from 1a46f20 by git HEAD even when the bundle name is identical.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    DEFAULT_EXPECTED_STORE_ID,
    EXIT_STORE_PREFLIGHT,
    expectedStoreId,
    formatStoreMismatch,
    parseStoreProbe,
    pm2DeclaredEnv,
    runStorePreflight,
    storeIdMatches,
    storeProbeScript,
} from '../duration/storePreflight.js'
import { EXIT_CONSOLE_PIN_MISMATCH, consoleDeployVerdict } from '../duration/consoleDeploy.js'
import { EXIT_ENGINE_UNREACHABLE } from '../duration/automergeTimeoutGuard.js'
import {
    assertSameMetaIdentity,
    metaDiskIdIsShell,
    metaDiskIdShell,
    metaIdentityMismatch,
    parseMetaIdentity,
} from '../duration/metaYaml.js'
import { buildFixtureSlotScanRemote, buildMetaCatRemote, buildTreeDigestRemote, META_DIGEST_EXCLUDE, parseFixtureSlotScan, parseMetaCat, parseTreeDigest } from '../duration/realFleetOps.js'

const HOSTS = { idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }
const POOL = ['idea01', 'idea03', 'idea04']
const URL3Z = 'automerge:3zoqdSVsEtj4ygNJPNcDyKWvdxo6'

// Values as read on the pool 2026-10-06 (Engine f65183a).
const CONFIG = (o: { mdns?: string; staticPeers?: string } = {}) => `settings:
  mdns: ${o.mdns ?? 'true'}      # atlas: test pool mirrors production idea02
  isDev: false
  testMode: true
  port: 4321
  httpPort: 8080
  consolePath: /home/pi/idea/agents/agent-console-dev/dist
  storeDataFolder: store-data
  storeIdentityFolder: store-identity
${o.staticPeers !== undefined ? `  staticPeers: ${o.staticPeers}\n` : ''}defaults:
  user: pi
`
const PM2 = `module.exports = { apps: [{ name: "engine", script: "./dist/src/index.js", env: { NODE_ENV: "development", VERBOSITY: "3" } }] }`

const probeOut = (o: { config?: string; storeUrl?: string; pm2?: string; environ?: 'readable' | 'unreadable'; env?: string[]; pid?: string } = {}) => [
    '@@DSP@@ config', o.config ?? CONFIG(),
    '@@DSP@@ storeurl', o.storeUrl ?? URL3Z, '',
    '@@DSP@@ pm2config', o.pm2 ?? PM2,
    '@@DSP@@ proc', `pid=${o.pid ?? '54874'}`, `environ=${o.environ ?? 'unreadable'}`, ...(o.env ?? []).map(e => `env:${e}`),
    '@@DSP@@ end',
].join('\n')

const deps = (over: Partial<Record<string, string | Error>> = {}, api: Record<string, string | Error> = {}, ws?: Record<string, { docId: string; engineRow: boolean }>) => {
    const probed: string[] = []
    return {
        probed,
        d: {
            probe: async (pi: string) => {
                probed.push(pi)
                const v = over[pi]
                if (v instanceof Error) throw v
                return v ?? probeOut()
            },
            fetchStoreUrl: async (host: string, port: number) => {
                const pi = Object.entries(HOSTS).find(([, h]) => h === host)?.[0] ?? host
                const v = api[pi]
                if (v instanceof Error) throw v
                expect(port).toBe(8080)
                return v ?? JSON.stringify({ url: URL3Z, wsPort: 4321 })
            },
            ws: ws ? (pi: string) => ws[pi] ?? null : undefined,
        },
    }
}

describe('idea#168 r38 store preflight (live pool = shared 3zoqd, mDNS ON, no static peers)', () => {
    it('exit code 6 is distinct from 4 (engine unreachable) and 5 (Console pin); expected id from env, default 3zoqd', () => {
        expect(EXIT_STORE_PREFLIGHT).toBe(6)
        expect(new Set([1, 2, EXIT_ENGINE_UNREACHABLE, EXIT_CONSOLE_PIN_MISMATCH, EXIT_STORE_PREFLIGHT]).size).toBe(5)
        expect(DEFAULT_EXPECTED_STORE_ID).toBe('3zoqd')
        expect(expectedStoreId({})).toBe('3zoqd')
        expect(expectedStoreId({ DURATION_EXPECTED_STORE_ID: 'automerge:4GQmEZehPD' })).toBe('4GQmEZehPD')
        expect(() => expectedStoreId({ DURATION_EXPECTED_STORE_ID: 'ab' })).toThrow(/≥5/)
        expect(storeIdMatches(URL3Z, '3zoqd')).toBe(true)
        expect(storeIdMatches('automerge:4GQmEZehPDfryGDxkFo9XixbvmAC', '3zoqd')).toBe(false)
        expect(storeIdMatches(null, '3zoqd')).toBe(false)
    })

    it('probe script is read-only (cat / sed / pgrep / grep; no writes) and parses', () => {
        const s = storeProbeScript()
        expect(s).toContain("cat \"$d/config.yaml\"")
        expect(s).toContain('store-url.txt')
        expect(s).toContain('pm2.config.cjs')
        expect(s).not.toMatch(/\b(rm|mv|cp|tee|touch|pm2 (restart|start|stop|delete)|systemctl|reboot)\b|>\s*[^&/]/)
        const p = parseStoreProbe(probeOut({ environ: 'readable', env: ['IDEA_STATIC_PEERS='] }))
        expect(p.storeUrl).toBe(URL3Z)
        expect(p.pid).toBe('54874')
        expect(p.environReadable).toBe(true)
        expect(p.procEnv).toEqual({ IDEA_STATIC_PEERS: '' })
        expect(pm2DeclaredEnv(PM2, 'IDEA_MDNS_DISABLE')).toBeUndefined()
        expect(pm2DeclaredEnv('env: { IDEA_MDNS_DISABLE: "true" }', 'IDEA_MDNS_DISABLE')).toBe('true')
        expect(pm2DeclaredEnv("env: { IDEA_STATIC_PEERS: 'idea03,idea04' }", 'IDEA_STATIC_PEERS')).toBe('idea03,idea04')
        expect(pm2DeclaredEnv('env: { IDEA_STATIC_PEERS: process.env.X }', 'IDEA_STATIC_PEERS')).toBe('UNPARSABLE')
    })

    it('PASS: all three Pis on 3zoqd (file + running Engine /api/store-url + harness WS row), mDNS on, no static peers', async () => {
        const { d, probed } = deps({}, {}, { idea01: { docId: '3zoqdSVsEtj4ygNJPNcDyKWvdxo6', engineRow: true } })
        const r = await runStorePreflight(POOL, HOSTS, d, {})
        expect(r.ok).toBe(true)
        expect(r.mismatches).toEqual([])
        expect(r.expected).toBe('3zoqd')
        expect(probed.sort()).toEqual(POOL)
        expect(r.pis.map(p => [p.pi, p.ok, p.mdns, p.staticPeers, p.storeUrlFile, p.apiStoreUrl, p.envSource])).toEqual(
            POOL.map(pi => [pi, true, true, null, URL3Z, URL3Z, 'pm2.config.cjs']),
        )
        expect(r.pis[0]!.wsStoreDocId).toBe('3zoqdSVsEtj4ygNJPNcDyKWvdxo6')
        expect(r.pis[0]!.wsEngineRow).toBe(true)
    })

    it('FAIL: wrong store id in store-url.txt, in the running Engine, or in the harness WS doc — names Pi / field / expected vs actual', async () => {
        const other = 'automerge:4GQmEZehPDfryGDxkFo9XixbvmAC'
        const a = await runStorePreflight(POOL, HOSTS, deps({ idea03: probeOut({ storeUrl: other }) }, { idea03: JSON.stringify({ url: other }) }).d, {})
        expect(a.ok).toBe(false)
        expect(a.mismatches.map(formatStoreMismatch)).toEqual([
            `store_preflight: idea03: store-url.txt: expected automerge:3zoqd…, actual ${other}`,
            `store_preflight: idea03: running Engine /api/store-url: expected automerge:3zoqd…, actual ${other}`,
        ])
        // file says 3zoqd but the running Engine still serves another store (restart pending)
        const b = await runStorePreflight(POOL, HOSTS, deps({}, { idea04: JSON.stringify({ url: other }) }).d, {})
        expect(b.mismatches).toEqual([{ pi: 'idea04', field: 'running Engine /api/store-url', expected: 'automerge:3zoqd…', actual: other }])
        const c = await runStorePreflight(POOL, HOSTS, deps({}, {}, { idea01: { docId: URL3Z.slice(10), engineRow: false } }).d, {})
        expect(c.mismatches).toEqual([{ pi: 'idea01', field: 'harness WS store doc', expected: "idea01's own engineDB row in 3zoqd", actual: 'no row for this Engine' }])
        // DURATION_EXPECTED_STORE_ID override
        const e = await runStorePreflight(POOL, HOSTS, deps().d, { DURATION_EXPECTED_STORE_ID: '4GQmE' })
        expect(e.ok).toBe(false)
        expect(e.mismatches.filter(m => m.field === 'store-url.txt').map(m => m.pi)).toEqual(POOL)
    })

    it('FAIL: mDNS off (config.yaml settings.mdns false, or IDEA_MDNS_DISABLE=true in the Engine env / pm2.config.cjs)', async () => {
        const r = await runStorePreflight(POOL, HOSTS, deps({
            idea01: probeOut({ config: CONFIG({ mdns: 'false' }) }),
            idea03: probeOut({ environ: 'readable', env: ['IDEA_MDNS_DISABLE=true'] }),
            idea04: probeOut({ pm2: 'module.exports = { apps: [{ env: { IDEA_MDNS_DISABLE: "true" } }] }' }),
        }).d, {})
        expect(r.ok).toBe(false)
        expect(r.mismatches.map(formatStoreMismatch)).toEqual([
            'store_preflight: idea01: mdns (config.yaml settings.mdns): expected true, actual false',
            'store_preflight: idea03: mdns (IDEA_MDNS_DISABLE via process): expected unset / not true, actual true',
            'store_preflight: idea04: mdns (IDEA_MDNS_DISABLE via pm2.config.cjs): expected unset / not true, actual true',
        ])
        expect(r.pis.map(p => p.mdns)).toEqual([false, false, false])
        // missing key = Engine Config.ts rejects / not true → fail
        const miss = await runStorePreflight(['idea01'], HOSTS, deps({ idea01: probeOut({ config: 'settings:\n  port: 4321\n  httpPort: 8080\n' }) }).d, {})
        expect(miss.mismatches.map(m => m.field)).toContain('mdns (config.yaml settings.mdns)')
    })

    it('FAIL: static peers present (config.yaml settings.staticPeers, or IDEA_STATIC_PEERS which wins)', async () => {
        const r = await runStorePreflight(POOL, HOSTS, deps({
            idea01: probeOut({ config: CONFIG({ staticPeers: 'idea03,idea04' }) }),
            idea03: probeOut({ environ: 'readable', env: ['IDEA_STATIC_PEERS=100.99.231.94:4321'] }),
            idea04: probeOut({ pm2: "module.exports = { apps: [{ env: { IDEA_STATIC_PEERS: 'idea01' } }] }" }),
        }).d, {})
        expect(r.mismatches.map(formatStoreMismatch)).toEqual([
            'store_preflight: idea01: static peers (config.yaml settings.staticPeers): expected none, actual "idea03,idea04"',
            'store_preflight: idea03: static peers (IDEA_STATIC_PEERS via process): expected none, actual "100.99.231.94:4321"',
            'store_preflight: idea04: static peers (IDEA_STATIC_PEERS via pm2.config.cjs): expected none, actual "idea01"',
        ])
        // env empty string wins over config (staticPeersSetting = env ?? config) → none
        const ok = await runStorePreflight(['idea01'], HOSTS, deps({ idea01: probeOut({ config: CONFIG({ staticPeers: 'idea03' }), environ: 'readable', env: ['IDEA_STATIC_PEERS='] }) }).d, {})
        expect(ok.ok).toBe(true)
        // blank config value = off (start.ts: staticPeersSetting()?.trim())
        const blank = await runStorePreflight(['idea01'], HOSTS, deps({ idea01: probeOut({ config: CONFIG({ staticPeers: "'  '" }) }) }).d, {})
        expect(blank.ok).toBe(true)
    })

    it('FAIL loud (not skipped): an unreachable Pi, an unreachable /api/store-url, no Engine process', async () => {
        const r = await runStorePreflight(POOL, HOSTS, deps(
            { idea04: new Error('ssh: connect to host 100.108.39.45 port 22: Connection timed out') },
            { idea03: new Error('fetch failed') },
        ).d, {})
        expect(r.ok).toBe(false)
        expect(r.mismatches).toEqual([
            { pi: 'idea03', field: 'running Engine /api/store-url', expected: 'automerge:3zoqd…', actual: 'no answer (fetch failed)' },
            { pi: 'idea04', field: 'ssh', expected: 'read-only ssh pi@100.108.39.45 answers', actual: 'unreachable: ssh: connect to host 100.108.39.45 port 22: Connection timed out' },
        ])
        const np = await runStorePreflight(['idea01'], HOSTS, deps({ idea01: probeOut({ pid: 'none' }) }).d, {})
        expect(np.mismatches.map(m => m.field)).toEqual(['engine process'])
    })

    it('idea02 in the pool is refused WITHOUT probing it', async () => {
        const { d, probed } = deps()
        const r = await runStorePreflight(['idea01', 'idea02', 'idea03'], { ...HOSTS, idea02: '100.0.0.2' }, d, {})
        expect(r.ok).toBe(false)
        expect(r.mismatches).toEqual([{ pi: 'idea02', field: 'pool', expected: 'never idea02', actual: 'idea02 in pool' }])
        expect(probed).not.toContain('idea02')
        expect((await runStorePreflight([], HOSTS, d, {})).ok).toBe(false)
    })
})

describe('idea#168 r38 META.yaml identity: parsed diskId + created only (Engine rewrites META on dock)', () => {
    const PACK = `diskId: duration-kolibri-grade5a-001\ndiskName: 'Duration Tests — Kolibri Grade 5A'\ncreated: 1780000000000\nlastDocked: 1780000000000\n`
    const DOCKED = `diskId: duration-kolibri-grade5a-001\ndiskName: Duration Tests — Kolibri Grade 5A\ncreated: 1780000000000\nlastDocked: 1791282082411\n`

    it('rewritten lastDocked passes; unquoted diskName passes; reordered keys / comments pass', () => {
        expect(parseMetaIdentity(DOCKED)).toEqual({ diskId: 'duration-kolibri-grade5a-001', created: '1780000000000' })
        expect(metaIdentityMismatch(parseMetaIdentity(PACK), parseMetaIdentity(DOCKED))).toBeNull()
        expect(assertSameMetaIdentity(PACK, DOCKED, 'x').diskId).toBe('duration-kolibri-grade5a-001')
        expect(() => assertSameMetaIdentity(PACK, `lastDocked: 1\ncreated: "1780000000000"  # c\ndiskName: x\ndiskId: "duration-kolibri-grade5a-001"\n`, 'x')).not.toThrow()
    })

    it('a different diskId or created FAILS loud', () => {
        expect(() => assertSameMetaIdentity(PACK, DOCKED.replace('grade5a-001', 'grade5a-002'), 'moveDisk k'))
            .toThrow(/moveDisk k: META\.yaml identity mismatch — diskId expected duration-kolibri-grade5a-001, actual duration-kolibri-grade5a-002/)
        expect(() => assertSameMetaIdentity(PACK, DOCKED.replace('created: 1780000000000', 'created: 1780000000001'), 'k'))
            .toThrow(/created expected 1780000000000, actual 1780000000001/)
        expect(() => assertSameMetaIdentity(PACK, 'diskName: x\n', 'k')).toThrow(/diskId expected duration-kolibri-grade5a-001, actual missing; created expected 1780000000000, actual missing/)
        expect(() => parseMetaIdentity('diskId: [unclosed', 'k')).toThrow(/k: not valid YAML/)
    })

    const dir = mkdtempSync(join(tmpdir(), 'dur-meta-'))
    const bash = (cmd: string) => execFileSync('bash', ['-c', cmd], { stdio: 'pipe' }).toString()
    const meta = (name: string, text: string) => {
        mkdirSync(join(dir, name), { recursive: true })
        writeFileSync(join(dir, name, 'META.yaml'), text)
        return join(dir, name, 'META.yaml')
    }

    it('on-Pi bash diskId extractor: plain / quoted / commented / CRLF all match exactly; prefixes and other ids do not', () => {
        const cases: [string, string, boolean][] = [
            ['plain', DOCKED, true],
            ['single', `diskId: 'duration-kolibri-grade5a-001'\ncreated: 1\n`, true],
            ['double', `created: 1\ndiskId: "duration-kolibri-grade5a-001"   # pack\n`, true],
            ['crlf', `diskId: duration-kolibri-grade5a-001\r\ncreated: 1\r\n`, true],
            ['comment', `diskId: duration-kolibri-grade5a-001 # x\n`, true],
            ['longer', `diskId: duration-kolibri-grade5a-0012\n`, false],
            ['other', `diskId: duration-nextcloud-grade5a-001\n`, false],
            ['nested', `x:\n  diskId: duration-kolibri-grade5a-001\n`, false],
        ]
        for (const [name, text, want] of cases) {
            const f = meta(name, text)
            const ok = bash(`if ${metaDiskIdIsShell(`'${f}'`, 'duration-kolibri-grade5a-001')}; then echo Y; else echo N; fi`).trim()
            expect(ok, name).toBe(want ? 'Y' : 'N')
        }
        expect(bash(metaDiskIdShell(`'${meta('q2', `diskId: 'duration-empty-002'\n`)}'`)).trim()).toBe('duration-empty-002')
        expect(bash(`if ${metaDiskIdIsShell(`'${join(dir, 'none', 'META.yaml')}'`, 'x')}; then echo Y; else echo N; fi`).trim()).toBe('N')
    })

    it('fixture slot scan uses the parsed diskId (rewritten META still MATCH)', () => {
        const root = join(dir, 'disks')
        mkdirSync(join(root, 'idea-test-1'), { recursive: true })
        writeFileSync(join(root, 'idea-test-1', 'META.yaml'), DOCKED)
        mkdirSync(join(root, 'idea-test-2'), { recursive: true })
        writeFileSync(join(root, 'idea-test-2', 'META.yaml'), `diskId: "duration-kolibri-grade5a-001x"\n`)
        const slots = parseFixtureSlotScan(bash(buildFixtureSlotScanRemote(root, 'duration-kolibri-grade5a-001')))
        expect(slots.find(s => s.device === 'idea-test-1')?.state).toBe('MATCH')
        expect(slots.find(s => s.device === 'idea-test-2')?.state).toBe('OTHER')
    })

    it('move tree digest leaves META.yaml out (same digest after a lastDocked rewrite); META read for the parsed compare', () => {
        const a = join(dir, 'treeA')
        const b = join(dir, 'treeB')
        for (const [r, m] of [[a, PACK], [b, DOCKED]] as const) {
            mkdirSync(join(r, 'apps'), { recursive: true })
            writeFileSync(join(r, 'apps', 'x.yaml'), 'same\n')
            writeFileSync(join(r, 'META.yaml'), m)
        }
        expect(META_DIGEST_EXCLUDE).toEqual(['META.yaml'])
        const dig = (r: string) => parseTreeDigest(bash(buildTreeDigestRemote(r, null, 'never', [], [...META_DIGEST_EXCLUDE])))
        expect(dig(a)).toEqual(dig(b))
        writeFileSync(join(b, 'apps', 'x.yaml'), 'changed\n')
        expect(dig(a)).not.toEqual(dig(b)) // real content is still byte-verified
        expect(parseMetaCat(bash(buildMetaCatRemote(b, 'never')))).toBe(DOCKED)
        expect(parseMetaCat(bash(buildMetaCatRemote(join(dir, 'nope'), 'never')))).toBeNull()
        rmSync(dir, { recursive: true, force: true })
    })
})

describe('idea#168 r38 Console pin: git HEAD over ssh, not the bundle name', () => {
    const base = {
        consoleUrl: 'http://idea01:8080',
        consoleHost: 'idea01',
        pin: 'd637b8346240e05ca1b5c92dd9f082ce68a26d14',
        pinSource: 'DURATION_EXPECTED_CONSOLE_SHA',
        boxHead: 'd637b8346240e05ca1b5c92dd9f082ce68a26d14',
        servedAsset: 'assets/index-Cpd-srqg.js',
        stamp: null,
    }
    const probe = (head: string, distMtime: number) => ({
        consolePath: '/home/pi/idea/agents/agent-console-dev/dist', head, dirty: 0, headTime: 1_791_000_000, distMtime, distAsset: 'assets/index-Cpd-srqg.js',
    })
    it('same index-Cpd-srqg.js: served checkout 1a46f20 → refused; d637b83 with a dist built after it → ok; stale dist → refused', () => {
        const old = consoleDeployVerdict({ ...base, probe: probe('1a46f20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1_791_000_100) })
        expect(old.ok).toBe(false)
        expect(old.method).toBe('ssh-checkout')
        expect(old.note).toMatch(/serves the dist of Console 1a46f20 .* not the pin/)
        const ok = consoleDeployVerdict({ ...base, probe: probe(base.pin, 1_791_000_100) })
        expect(ok.ok).toBe(true)
        expect(ok.servedSha).toBe(base.pin)
        const stale = consoleDeployVerdict({ ...base, probe: probe(base.pin, 1_790_999_000) })
        expect(stale.ok).toBe(false)
        expect(stale.note).toMatch(/stale dist, rebuild/)
    })
})
