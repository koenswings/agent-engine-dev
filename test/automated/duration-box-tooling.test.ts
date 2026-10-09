/** r51 FAIL@1: box-tooling preflight (exit 11) — node_modules, Playwright on the driver paths, Intents deps, Chromium. */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BoxToolingDeps, EXIT_BOX_TOOLING, HARNESS_PACKAGES, checkBoxTooling, playwrightCandidates, realBoxToolingDeps } from '../duration/boxTooling.js'

const ROOT = '/h'
const DRIVER = '/h/test/duration/ui'
const INTENTS = '/c/e2e/intents'
const CHROME = '/home/box/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const PW = '/workspace/agent-console-dev/node_modules/playwright/index.js'

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
    }
}
const healthy = () => box({
    files: [`${ROOT}/node_modules`, PW, '/c/node_modules', CHROME, ...HARNESS_PACKAGES.map(p => `${ROOT}/node_modules/${p}/package.json`)],
    resolvable: {
        [`${INTENTS}|@playwright/test`]: '/c/node_modules/@playwright/test/index.js',
    },
})
const input = { harnessRoot: ROOT, driverDir: DRIVER, intentsDir: INTENTS }

describe('box tooling preflight', () => {
    it('exit code 11, distinct from the other preflights (4-10)', () => {
        expect(EXIT_BOX_TOOLING).toBe(11)
    })
    it('candidate list is the driver order; the driver uses this exact list', () => {
        expect(playwrightCandidates(DRIVER)).toEqual(['playwright', '@playwright/test', '/workspace/agent-console-dev/node_modules/playwright', '/agent-console-dev/node_modules/playwright'])
        const drv = readFileSync(fileURLToPath(new URL('../duration/ui/playwrightDriver.ts', import.meta.url)).replace('/dist-test/', '/'), 'utf8')
        expect(drv).toMatch(/const tries = playwrightCandidates\(here\)/)
    })
    it('healthy box → ok, reports the Playwright spec/version and Chromium path', () => {
        const r = checkBoxTooling(input, healthy())
        expect(r.problems).toEqual([])
        expect(r.ok).toBe(true)
        expect(r.playwright).toEqual({ spec: '/workspace/agent-console-dev/node_modules/playwright', file: PW, version: '1.58.2' })
        expect(r.chromium).toBe(CHROME)
        expect(r.message).toMatch(/box tooling OK: playwright 1\.58\.2/)
    })
    it('r51 box (everything cleaned) → every problem named, no Chromium probe', () => {
        const r = checkBoxTooling(input, box())
        expect(r.ok).toBe(false)
        const p = r.problems.join('\n')
        expect(p).toMatch(/harness node_modules missing at \/h\/node_modules/)
        expect(p).toMatch(/Playwright not resolvable from the harness driver paths/)
        expect(p).toMatch(/Console Intents checkout has no node_modules \(\/c\)/)
        expect(p).toMatch(/@playwright\/test not resolvable from the Console Intents/)
        expect(r.chromium).toBeNull()
    })
    it('Playwright installed but no browser → Chromium missing with the install hint', () => {
        const d = healthy()
        const r = checkBoxTooling(input, { ...d, exists: p => p !== CHROME && d.exists(p) })
        expect(r.ok).toBe(false)
        expect(r.problems).toEqual([`Chromium binary missing at ${CHROME} — npx playwright install --with-deps chromium (Playwright 1.58.2)`])
    })
    it('Playwright cannot name its Chromium → problem', () => {
        expect(checkBoxTooling(input, { ...healthy(), chromiumPath: () => { throw new Error('boom') } }).problems.join(' ')).toMatch(/cannot name its Chromium \(boom\)/)
    })
    it('a missing harness package and a missing Intents dir are reported', () => {
        const d = healthy()
        const r1 = checkBoxTooling(input, { ...d, exists: p => p !== `${ROOT}/node_modules/yaml/package.json` && d.exists(p) })
        expect(r1.problems).toEqual([`harness package 'yaml' missing from ${ROOT}/node_modules`])
        expect(checkBoxTooling({ ...input, intentsDir: null }, d).problems).toEqual(['Console Intents dir not found (DURATION_CONSOLE_INTENTS / sibling agent-console-dev/e2e/intents)'])
    })
    it('first resolvable candidate wins (harness-local playwright before the Console checkout)', () => {
        const d = healthy()
        const r = checkBoxTooling(input, { ...d, resolveFrom: (f, s) => (s === 'playwright' && f === DRIVER ? '/h/node_modules/playwright/index.js' : d.resolveFrom(f, s)) })
        expect(r.playwright?.spec).toBe('playwright')
    })
    it('real deps: resolve + exists work on this checkout (no browser launch)', () => {
        const d = realBoxToolingDeps()
        const here = fileURLToPath(new URL('.', import.meta.url))
        expect(d.exists(here)).toBe(true)
        expect(existsSync(d.resolveFrom(here, 'vitest/package.json'))).toBe(true)
        expect(() => d.resolveFrom(here, 'no-such-module-r51')).toThrow()
    })
})
