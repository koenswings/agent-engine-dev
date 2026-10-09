/**
 * Box-tooling preflight (exit 11).
 * r51 FAIL@1: no node_modules / Playwright / Chromium on the box.
 * r52 FAIL@1: Playwright resolved, but the driver's loader ESM-imported CJS playwright/index.js → namespace
 * with only `default` → "Cannot read properties of undefined (reading 'launch')". The preflight now launches
 * headless Chromium through the driver's own loader.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
    BoxToolingDeps,
    EXIT_BOX_TOOLING,
    HARNESS_PACKAGES,
    boxToolingExitCode,
    checkBoxTooling,
    playwrightCandidates,
    realBoxToolingDeps,
    realLaunchProbe,
} from '../duration/boxTooling.js'
import { loadPlaywright, normalizePlaywrightModule, type PlaywrightLoaderIo } from '../duration/ui/playwrightLoader.js'

const ROOT = '/h'
const DRIVER = '/h/test/duration/ui'
const INTENTS = '/c/e2e/intents'
const CHROME = '/home/box/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const PW = '/workspace/agent-console-dev/node_modules/playwright/index.js'
const PW_DIR = '/workspace/agent-console-dev/node_modules/playwright'
const PROBE_OK = { spec: PW_DIR, browserVersion: '145.0.7632.6', ms: 420 }

const srcOf = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)).replace('/dist-test/', '/'), 'utf8')

/** Fake box: a set of existing paths + resolvable (fromDir, spec) pairs. */
const box = (o: { files?: string[]; resolvable?: Record<string, string>; chromium?: string | Error } = {}): BoxToolingDeps => {
    const files = new Set(o.files ?? [])
    return {
        exists: p => files.has(p),
        resolveFrom: (from, spec) => {
            const hit = o.resolvable?.[`${from}|${spec}`]
            if (!hit) throw new Error(`Cannot find module '${spec}'`)
            return hit
        },
        chromiumPath: () => { if (o.chromium instanceof Error) throw o.chromium; return o.chromium ?? CHROME },
        versionOf: () => '1.58.2',
        launchProbe: async () => PROBE_OK,
    }
}
const healthy = () => box({
    files: [`${ROOT}/node_modules`, PW, '/c/node_modules', CHROME, ...HARNESS_PACKAGES.map(p => `${ROOT}/node_modules/${p}/package.json`)],
    resolvable: { [`${INTENTS}|@playwright/test`]: '/c/node_modules/@playwright/test/index.js' },
})
const input = { harnessRoot: ROOT, driverDir: DRIVER, intentsDir: INTENTS }

/** A fake Playwright whose chromium.launch records calls. */
const fakePw = (log: string[] = []) => ({
    chromium: {
        launch: async (o?: { headless?: boolean }) => {
            log.push(`launch headless=${o?.headless}`)
            return { newContext: async () => { throw new Error('unused') }, close: async () => { log.push('close') }, version: () => '145.0.7632.6' }
        },
    },
})
/** Loader io: only the Console checkout's abs path is importable, as an ESM namespace of `ns`. */
const consoleOnlyIo = (ns: unknown, reqLog: string[] = []): PlaywrightLoaderIo => ({
    importUrl: async url => (url === `file://${PW}` ? ns : null),
    requireSpec: spec => { reqLog.push(spec); throw new Error(`Cannot find module '${spec}'`) },
})

describe('playwright loader (shared by the driver and the preflight)', () => {
    it('the driver uses the shared loader, not a private copy', () => {
        const drv = srcOf('../duration/ui/playwrightDriver.ts')
        expect(drv).toMatch(/import \{ loadPlaywright, type PlaywrightModule \} from '\.\/playwrightLoader\.js'/)
        expect(drv).toMatch(/const \{ mod: pw \} = await loadPlaywright\(\)/)
        expect(drv).not.toMatch(/const loadPlaywright =/)
        expect(srcOf('../duration/boxTooling.ts')).toMatch(/launchProbe: \(\) => realLaunchProbe\(\)/)
    })
    it('candidate list order is unchanged', () => {
        expect(playwrightCandidates(DRIVER)).toEqual(['playwright', '@playwright/test', PW_DIR, '/agent-console-dev/node_modules/playwright'])
    })
    it('r52: CJS-shaped module imported as ESM (namespace exposes only `default`) is unwrapped', async () => {
        const pw = fakePw()
        const ns = { default: pw } // what import('…/playwright/index.js') returns for module.exports = require('playwright-core')
        expect(Object.keys(ns)).toEqual(['default'])
        expect(normalizePlaywrightModule(ns, PW_DIR)).toBe(pw)
        const r = await loadPlaywright(consoleOnlyIo(ns), DRIVER)
        expect(r.spec).toBe(PW_DIR)
        expect(r.mod).toBe(pw)
        expect(typeof r.mod.chromium.launch).toBe('function')
    })
    it('a plain CJS require result (no default) and an ESM namespace carrying chromium both pass', () => {
        const pw = fakePw()
        expect(normalizePlaywrightModule(pw, 'playwright')).toBe(pw)
        const ns = { default: { notPlaywright: true }, chromium: pw.chromium }
        expect(normalizePlaywrightModule(ns, 'x').chromium).toBe(pw.chromium)
    })
    it('missing .chromium → clear error naming the spec and the keys (no "reading launch" TypeError)', async () => {
        expect(() => normalizePlaywrightModule({ default: { firefox: {} } }, PW_DIR)).toThrow(
            /module loaded from '\/workspace\/agent-console-dev\/node_modules\/playwright' has no chromium\.launch \(keys: default; default keys: firefox\)/,
        )
        expect(() => normalizePlaywrightModule({ chromium: {} }, 'playwright')).toThrow(/has no chromium\.launch/)
        expect(() => normalizePlaywrightModule(null, 'playwright')).toThrow(/is null, not Playwright/)
        await expect(loadPlaywright(consoleOnlyIo({ default: {} }), DRIVER)).rejects.toThrow(/has no chromium\.launch/)
    })
    it('first loadable candidate wins; nothing loadable → "playwright not installed" listing all candidates', async () => {
        const pw = fakePw()
        const io: PlaywrightLoaderIo = { importUrl: async () => { throw new Error('should not import') }, requireSpec: s => { if (s === 'playwright') return pw; throw new Error('nf') } }
        expect((await loadPlaywright(io, DRIVER)).spec).toBe('playwright')
        const tried: string[] = []
        await expect(loadPlaywright({ importUrl: async () => null, requireSpec: s => { tried.push(s); throw new Error('nf') } }, DRIVER)).rejects.toThrow(
            /playwright not installed \(tried playwright, @playwright\/test, \/workspace\/agent-console-dev\/node_modules\/playwright/,
        )
        expect(tried).toEqual(playwrightCandidates(DRIVER))
    })
})

describe('launch probe', () => {
    it('loads via the given loader, launches headless, closes', async () => {
        const log: string[] = []
        const r = await realLaunchProbe(async () => ({ mod: fakePw(log), spec: PW_DIR }))
        expect(log).toEqual(['launch headless=true', 'close'])
        expect(r.spec).toBe(PW_DIR)
        expect(r.browserVersion).toBe('145.0.7632.6')
    })
    it('the r52 failure through the real loader path: CJS namespace → probe succeeds after the fix', async () => {
        const log: string[] = []
        const r = await realLaunchProbe(() => loadPlaywright(consoleOnlyIo({ default: fakePw(log) }), DRIVER))
        expect(r.spec).toBe(PW_DIR)
        expect(log).toEqual(['launch headless=true', 'close'])
    })
    it('a hung launch times out', async () => {
        const hung = { chromium: { launch: () => new Promise<never>(() => {}) } }
        await expect(realLaunchProbe(async () => ({ mod: hung as never, spec: 'playwright' }), 20)).rejects.toThrow(/chromium\.launch timed out after 20 ms/)
    })
})

describe('box tooling preflight', () => {
    it('exit code 11, distinct from the other preflights (4-10)', () => {
        expect(EXIT_BOX_TOOLING).toBe(11)
        expect(boxToolingExitCode({ ok: true })).toBe(0)
        expect(boxToolingExitCode({ ok: false })).toBe(11)
        expect(srcOf('../duration/cli.ts')).toMatch(/process\.exit\(boxToolingExitCode\(bt\)\)/)
    })
    it('healthy box → ok, reports Playwright, Chromium and the launch probe', async () => {
        const r = await checkBoxTooling(input, healthy())
        expect(r.problems).toEqual([])
        expect(r.ok).toBe(true)
        expect(r.playwright).toEqual({ spec: PW_DIR, file: PW, version: '1.58.2' })
        expect(r.chromium).toBe(CHROME)
        expect(r.launch).toEqual(PROBE_OK)
        expect(r.message).toMatch(/box tooling OK: playwright 1\.58\.2 .*launch probe OK via loader '\/workspace\/agent-console-dev\/node_modules\/playwright' \(browser 145\.0\.7632\.6/)
        expect(boxToolingExitCode(r)).toBe(0)
    })
    it('r52: everything resolves but the launch probe fails → exit 11 with the loader error', async () => {
        const r = await checkBoxTooling(input, { ...healthy(), launchProbe: async () => { throw new TypeError("Cannot read properties of undefined (reading 'launch')") } })
        expect(r.ok).toBe(false)
        expect(r.launch).toBeNull()
        expect(r.problems).toEqual(["headless Chromium launch through the harness loader failed: Cannot read properties of undefined (reading 'launch')"])
        expect(boxToolingExitCode(r)).toBe(EXIT_BOX_TOOLING)
    })
    it('probe fed by the loader with a module lacking chromium → exit 11, clear message', async () => {
        const r = await checkBoxTooling(input, { ...healthy(), launchProbe: () => realLaunchProbe(() => loadPlaywright(consoleOnlyIo({ default: {} }), DRIVER)) })
        expect(boxToolingExitCode(r)).toBe(11)
        expect(r.problems[0]).toMatch(/launch through the harness loader failed: PlaywrightUiDriver: module loaded from '\/workspace\/agent-console-dev\/node_modules\/playwright' has no chromium\.launch/)
    })
    it('r51 box (everything cleaned) → every problem named, no Chromium / launch probe', async () => {
        let probed = false
        const r = await checkBoxTooling(input, { ...box(), launchProbe: async () => { probed = true; return PROBE_OK } })
        expect(r.ok).toBe(false)
        const p = r.problems.join('\n')
        expect(p).toMatch(/harness node_modules missing at \/h\/node_modules/)
        expect(p).toMatch(/Playwright not resolvable from the harness driver paths/)
        expect(p).toMatch(/Console Intents checkout has no node_modules \(\/c\)/)
        expect(p).toMatch(/@playwright\/test not resolvable from the Console Intents/)
        expect(r.chromium).toBeNull()
        expect(probed).toBe(false)
        expect(boxToolingExitCode(r)).toBe(11)
    })
    it('Playwright installed but no browser → Chromium missing with the install hint (probe error reported too)', async () => {
        const d = healthy()
        const r = await checkBoxTooling(input, { ...d, exists: p => p !== CHROME && d.exists(p), launchProbe: async () => { throw new Error("Executable doesn't exist") } })
        expect(r.ok).toBe(false)
        expect(r.problems).toEqual([
            `Chromium binary missing at ${CHROME} — npx playwright install --with-deps chromium (Playwright 1.58.2)`,
            "headless Chromium launch through the harness loader failed: Executable doesn't exist",
        ])
    })
    it('Playwright cannot name its Chromium → problem', async () => {
        expect((await checkBoxTooling(input, { ...healthy(), chromiumPath: () => { throw new Error('boom') } })).problems.join(' ')).toMatch(/cannot name its Chromium \(boom\)/)
    })
    it('a missing harness package and a missing Intents dir are reported', async () => {
        const d = healthy()
        const r1 = await checkBoxTooling(input, { ...d, exists: p => p !== `${ROOT}/node_modules/yaml/package.json` && d.exists(p) })
        expect(r1.problems).toEqual([`harness package 'yaml' missing from ${ROOT}/node_modules`])
        expect((await checkBoxTooling({ ...input, intentsDir: null }, d)).problems).toEqual(['Console Intents dir not found (DURATION_CONSOLE_INTENTS / sibling agent-console-dev/e2e/intents)'])
    })
    it('first resolvable candidate wins (harness-local playwright before the Console checkout)', async () => {
        const d = healthy()
        const r = await checkBoxTooling(input, { ...d, resolveFrom: (f, s) => (s === 'playwright' && f === DRIVER ? '/h/node_modules/playwright/index.js' : d.resolveFrom(f, s)) })
        expect(r.playwright?.spec).toBe('playwright')
    })
    it('real deps: resolve + exists work on this checkout (no browser launch here)', () => {
        const d = realBoxToolingDeps()
        const here = fileURLToPath(new URL('.', import.meta.url))
        expect(d.exists(here)).toBe(true)
        expect(existsSync(d.resolveFrom(here, 'vitest/package.json'))).toBe(true)
        expect(() => d.resolveFrom(here, 'no-such-module-r51')).toThrow()
        expect(typeof d.launchProbe).toBe('function')
    })
})
