/**
 * r51 FAIL@1 (2026-10-09): the box had been cleaned — no node_modules in the Console checkouts, no
 * Playwright, no Chromium — and the walk only found out at step 1 ("playwright not installed").
 * Box-tooling preflight: before any pool contact, a live --ui walk needs
 *   1. node_modules in the harness checkout (tsx/yaml/automerge),
 *   2. Playwright resolvable from the SAME candidate paths PlaywrightUiDriver uses,
 *   3. the Console Intents checkout's own node_modules (the Intents import @playwright/test from there),
 *   4. the Chromium binary that Playwright will launch,
 *   5. (r52 FAIL@1) an actual headless Chromium launch + close through the harness's OWN loader
 *      (playwrightLoader.loadPlaywright, the function PlaywrightUiDriver uses). Resolving Playwright is not
 *      enough: r52 resolved it fine and still died on `pw.chromium.launch` (CJS module imported as ESM).
 * Fails with EXIT_BOX_TOOLING (11). Box-local only (fs, module resolution, one local headless browser); no pool contact.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadPlaywright, playwrightCandidates } from './ui/playwrightLoader.js'

export { playwrightCandidates }

export const EXIT_BOX_TOOLING = 11

/** Max time for the headless launch + close probe. */
export const BOX_TOOLING_LAUNCH_TIMEOUT_MS = 60_000

export interface LaunchProbeResult { spec: string; browserVersion: string | null; ms: number }

/** Packages the harness itself needs at runtime from its own node_modules. */
export const HARNESS_PACKAGES = ['tsx', 'yaml', '@automerge/automerge-repo'] as const

export interface BoxToolingDeps {
    exists: (p: string) => boolean
    /** Resolve `spec` as seen from directory `fromDir`; returns the resolved file or throws. */
    resolveFrom: (fromDir: string, spec: string) => string
    /** Playwright chromium.executablePath() for the module at resolved file `pwFile` (throws if unknown). */
    chromiumPath: (pwFile: string) => string
    /** package.json version next to a resolved module file, or null. */
    versionOf: (pwFile: string) => string | null
    /** Load Playwright through the harness's own loader, launch headless Chromium, close it. Throws on any failure. */
    launchProbe: () => Promise<LaunchProbeResult>
}

export interface BoxToolingInput { harnessRoot: string; driverDir: string; intentsDir: string | null }

export interface BoxToolingResult {
    ok: boolean
    problems: string[]
    playwright: { spec: string; file: string; version: string | null } | null
    chromium: string | null
    intentsPlaywright: string | null
    /** Result of the real launch probe; null when it did not run or failed. */
    launch: LaunchProbeResult | null
    message: string
}

const tryResolve = (deps: BoxToolingDeps, fromDir: string, spec: string): string | null => {
    try {
        if (spec.startsWith('/')) {
            const f = join(spec, 'index.js')
            return deps.exists(f) ? f : null
        }
        return deps.resolveFrom(fromDir, spec)
    } catch { return null }
}

export const checkBoxTooling = async (input: BoxToolingInput, deps: BoxToolingDeps): Promise<BoxToolingResult> => {
    const problems: string[] = []
    const nm = join(input.harnessRoot, 'node_modules')
    if (!deps.exists(nm)) problems.push(`harness node_modules missing at ${nm} — run pnpm install --frozen-lockfile in ${input.harnessRoot}`)
    else {
        for (const p of HARNESS_PACKAGES) {
            // Directory check: some packages (automerge-repo) do not export ./package.json.
            if (!deps.exists(join(nm, p, 'package.json'))) problems.push(`harness package '${p}' missing from ${nm}`)
        }
    }
    let playwright: BoxToolingResult['playwright'] = null
    for (const spec of playwrightCandidates(input.driverDir)) {
        const file = tryResolve(deps, input.driverDir, spec)
        if (file) { playwright = { spec, file, version: deps.versionOf(file) }; break }
    }
    if (!playwright) {
        problems.push(
            `Playwright not resolvable from the harness driver paths (${playwrightCandidates(input.driverDir).join(', ')}) — ` +
                'pnpm install --frozen-lockfile in /workspace/agent-console-dev',
        )
    }
    let intentsPlaywright: string | null = null
    if (!input.intentsDir) problems.push('Console Intents dir not found (DURATION_CONSOLE_INTENTS / sibling agent-console-dev/e2e/intents)')
    else {
        const repoRoot = resolve(input.intentsDir, '../..')
        if (!deps.exists(join(repoRoot, 'node_modules'))) problems.push(`Console Intents checkout has no node_modules (${repoRoot}) — pnpm install --frozen-lockfile there`)
        intentsPlaywright = tryResolve(deps, input.intentsDir, '@playwright/test')
        if (!intentsPlaywright) problems.push(`@playwright/test not resolvable from the Console Intents (${input.intentsDir})`)
    }
    let chromium: string | null = null
    if (playwright) {
        try { chromium = deps.chromiumPath(playwright.file) } catch (e) {
            problems.push(`Playwright ${playwright.version ?? '?'} cannot name its Chromium (${e instanceof Error ? e.message : String(e)})`)
        }
        if (chromium && !deps.exists(chromium)) {
            problems.push(`Chromium binary missing at ${chromium} — npx playwright install --with-deps chromium (Playwright ${playwright.version ?? '?'})`)
            chromium = null
        }
    }
    // The real thing: the driver's own loader + chromium.launch({ headless: true }) + close.
    // Runs whenever Playwright resolved (even with other problems) so its error is reported too.
    let launch: LaunchProbeResult | null = null
    if (playwright) {
        try {
            launch = await deps.launchProbe()
        } catch (e) {
            problems.push(`headless Chromium launch through the harness loader failed: ${e instanceof Error ? e.message : String(e)}`)
        }
    }
    const ok = problems.length === 0
    const message = ok
        ? `box tooling OK: playwright ${playwright!.version ?? '?'} (${playwright!.spec}), chromium ${chromium}, ` +
          `launch probe OK via loader '${launch!.spec}' (browser ${launch!.browserVersion ?? '?'}, ${launch!.ms} ms), ` +
          `intents @playwright/test ${intentsPlaywright}`
        : `box tooling FAILED: ${problems.join(' | ')}`
    return { ok, problems, playwright, chromium, intentsPlaywright, launch, message }
}

/** Process exit code for a box-tooling verdict: 0 or EXIT_BOX_TOOLING (11). */
export const boxToolingExitCode = (r: Pick<BoxToolingResult, 'ok'>): number => (r.ok ? 0 : EXIT_BOX_TOOLING)

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    new Promise<T>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)
        p.then(v => { clearTimeout(t); res(v) }, e => { clearTimeout(t); rej(e) })
    })

/** Real launch probe: exactly the driver's loader, then launch/close headless Chromium. */
export const realLaunchProbe = async (
    load: typeof loadPlaywright = loadPlaywright,
    timeoutMs = BOX_TOOLING_LAUNCH_TIMEOUT_MS,
): Promise<LaunchProbeResult> => {
    const t0 = Date.now()
    const { mod, spec } = await load()
    const browser = await withTimeout(mod.chromium.launch({ headless: true }), timeoutMs, 'chromium.launch')
    let browserVersion: string | null = null
    try {
        browserVersion = typeof browser.version === 'function' ? browser.version() : null
    } finally {
        await withTimeout(browser.close(), timeoutMs, 'browser.close')
    }
    return { spec, browserVersion, ms: Date.now() - t0 }
}

/** Real fs / module-resolution deps. */
export const realBoxToolingDeps = (): BoxToolingDeps => ({
    exists: existsSync,
    resolveFrom: (fromDir, spec) => createRequire(join(fromDir, '__box_tooling__.js')).resolve(spec),
    chromiumPath: pwFile => {
        const mod = createRequire(pwFile)(pwFile) as { chromium?: { executablePath(): string } }
        if (!mod.chromium) throw new Error('module has no chromium')
        return mod.chromium.executablePath()
    },
    versionOf: pwFile => {
        let d = dirname(pwFile)
        for (let i = 0; i < 6; i++) {
            const pj = join(d, 'package.json')
            if (existsSync(pj)) {
                try {
                    const j = createRequire(pj)(pj) as { name?: string; version?: string }
                    if (j.name === 'playwright' || j.name === '@playwright/test' || j.name === 'playwright-core') return j.version ?? null
                } catch { /* keep walking up */ }
            }
            d = dirname(d)
        }
        return null
    },
    launchProbe: () => realLaunchProbe(),
})
