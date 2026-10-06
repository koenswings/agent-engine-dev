/**
 * PlaywrightUiDriver — Phase 3 real browser dispatch (idea#168).
 *
 * Prefers Pixel package `idea-console/duration-intents`:
 *   runDurationIntent({ action, page, diskId?, instanceId?, screenshotPath? })
 *   hasDurationIntent(action)
 *   captureAfterIntent?(page, { path, intent?, settleMs? })  — Pixel locked name
 *
 * Fallback: sibling checkout path import of e2e/intents (same exports).
 * Does NOT re-implement selectors — ONE contract, Pixel owns adapters.
 *
 * Base URL: DURATION_CONSOLE_URL or http://idea01 (Engine :80 — never Vite 5173).
 *
 * Live production Console (non-localhost): context.addInitScript sets
 * localStorage.demoMode='false' before first goto — sticky demo must not mask Kid fixtures.
 * Do not remap Intents to demo disk IDs; no DURATION_ALLOW_DEMO.
 *
 * --record-walk soft-detect (Pixel Console#134 @ ba0cfa1):
 *   1) pass screenshotPath into runDurationIntent (Pixel may write PNG once)
 *   2) soft-detect bridge.captureAfterIntent — skip if PNG already exists
 *   3) else page.screenshot({ path, fullPage: true })
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
    DEFERRED_UI_INTENTS,
    defaultIdsForIntent,
    isDeferredUiIntent,
} from './fixtures.js'
import type { UiDriver, UiIntentContext, UiIntentResult } from './types.js'

export interface PlaywrightUiOptions {
    baseUrl?: string
    /** Absolute path to agent-console-dev/e2e/intents (optional fallback). */
    intentsDir?: string
    headless?: boolean
    /**
     * When true (default), missing Pixel adapter or missing DOM fixture →
     * ok:false (open_video/open_exercise fail-loud).
     */
    failLoud?: boolean
}

type DurationIntentResult = {
    ok: boolean
    message?: string
    registered: boolean
}

type RunDurationIntent = (opts: {
    page: unknown
    action: string
    diskId?: string
    engineId?: string
    instanceId?: string
    /** Pixel opt-in: write PNG after Intent when supported. */
    screenshotPath?: string
}) => Promise<DurationIntentResult>

type HasDurationIntent = (action: string) => boolean

type CaptureAfterIntent = (
    page: unknown,
    opts: { path: string; intent?: string; settleMs?: number },
) => Promise<void>

type PlaywrightModule = {
    chromium: {
        launch: (opts?: { headless?: boolean }) => Promise<{
            newContext: (opts?: { baseURL?: string }) => Promise<{
                newPage: () => Promise<unknown>
                addInitScript: (script: () => void) => Promise<void>
                close: () => Promise<void>
            }>
            close: () => Promise<void>
        }>
    }
}

type PwLocator = {
    first: () => PwLocator
    isVisible: () => Promise<boolean>
    click: () => Promise<void>
    waitFor: (o: { state: 'visible'; timeout: number }) => Promise<void>
    isDisabled: () => Promise<boolean>
    getAttribute: (name: string) => Promise<string | null>
}
type PwPage = {
    locator: (sel: string) => PwLocator
    reload: () => Promise<unknown>
    waitForTimeout: (ms: number) => Promise<void>
    evaluate?: <T>(fn: () => T) => Promise<T>
}

/** r30 reboot_engine: one Console NetworkTree engine row as seen in the DOM. */
export type ConsoleEngineRow = { testId: string; label: string; online: boolean }

/**
 * r30: is `hostname` shown online? Console 0760c01/c981361 NetworkTree renders
 * `[data-testid="engine-<storeId>"]` with `.tree-item__label` = hostname and
 * `.tree-item__status-dot--online` (lastRun within 90s); the status bar shows
 * `.status-bar__dot--connected` while the Console's own WS is up.
 */
export const consoleEngineOnline = (
    rows: ConsoleEngineRow[],
    statusConnected: boolean,
    hostname: string,
): { ok: boolean; detail: string } => {
    const want = hostname.trim().replace(/\.local$/i, '').toLowerCase()
    const row = rows.find(r => r.label.trim().replace(/\.local$/i, '').toLowerCase() === want)
    const seen = rows.map(r => `${r.label || '?'}=${r.online ? 'online' : 'offline'}`).join(', ') || 'none'
    if (!statusConnected) return { ok: false, detail: `status bar not connected; rows=[${seen}]` }
    if (!row) return { ok: false, detail: `no engine row labelled ${hostname}; rows=[${seen}]` }
    if (!row.online) return { ok: false, detail: `engine row ${row.testId} (${row.label}) offline; rows=[${seen}]` }
    return { ok: true, detail: `engine row ${row.testId} (${row.label}) online; status bar connected` }
}

/** Prefer A r21: Console NetworkTree disk row testid (Pixel sel.disk). */
export const diskRowSelector = (diskId: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(diskId)) {
        throw new Error(`diskRowSelector: refuse unsafe diskId '${diskId}'`)
    }
    return `[data-testid="disk-${diskId}"]`
}

const here = dirname(fileURLToPath(import.meta.url))

const candidateIntentDirs = (explicit?: string): string[] => {
    const out: string[] = []
    if (explicit) out.push(explicit)
    if (process.env.DURATION_CONSOLE_INTENTS) out.push(process.env.DURATION_CONSOLE_INTENTS)
    out.push(resolve(here, '../../../../agent-console-dev/e2e/intents'))
    out.push(resolve(here, '../../../agent-console-dev/e2e/intents'))
    out.push('/workspace/agent-console-dev/e2e/intents')
    return out
}

export const resolveConsoleIntentsDir = (explicit?: string): string | null => {
    for (const d of candidateIntentDirs(explicit)) {
        if (
            existsSync(join(d, 'durationBridge.ts')) ||
            existsSync(join(d, 'index.ts')) ||
            existsSync(join(d, 'registry.ts'))
        ) {
            return d
        }
    }
    return null
}

const loadPlaywright = async (): Promise<PlaywrightModule> => {
    const require = createRequire(import.meta.url)
    const tries = [
        'playwright',
        '@playwright/test',
        '/workspace/agent-console-dev/node_modules/playwright',
        resolve(here, '../../../../agent-console-dev/node_modules/playwright'),
    ]
    for (const spec of tries) {
        try {
            if (spec.startsWith('/')) {
                const mod = await import(pathToFileURL(join(spec, 'index.js')).href).catch(() => null)
                if (mod) return mod as PlaywrightModule
            }
            return require(spec) as PlaywrightModule
        } catch {
            /* try next */
        }
    }
    throw new Error(
        'PlaywrightUiDriver: playwright not installed. ' +
        'Install in Engine (pnpm add -D playwright) or use agent-console-dev node_modules.',
    )
}

type PixelBridge = {
    runDurationIntent: RunDurationIntent
    hasDurationIntent: HasDurationIntent
    captureAfterIntent?: CaptureAfterIntent
}

/**
 * Prefer `idea-console/duration-intents` (package exports); fall back to sibling path.
 */
const loadPixelBridge = async (intentsDir: string | null): Promise<PixelBridge> => {
    const require = createRequire(import.meta.url)
    // 1) Package export when linked (idea-console/duration-intents).
    // Spec is a variable so tsc does not typecheck Console Playwright sources.
    const pkgSpec = ['idea-console', 'duration-intents'].join('/')
    try {
        const mod = await import(pkgSpec) as PixelBridge & Record<string, unknown>
        if (typeof mod.runDurationIntent === 'function' && typeof mod.hasDurationIntent === 'function') {
            return {
                runDurationIntent: mod.runDurationIntent,
                hasDurationIntent: mod.hasDurationIntent,
                captureAfterIntent: typeof mod.captureAfterIntent === 'function'
                    ? (mod.captureAfterIntent as CaptureAfterIntent)
                    : undefined,
            }
        }
    } catch {
        /* fall through */
    }
    try {
        const mod = require(pkgSpec) as PixelBridge & Record<string, unknown>
        if (typeof mod.runDurationIntent === 'function') {
            return {
                runDurationIntent: mod.runDurationIntent,
                hasDurationIntent: mod.hasDurationIntent,
                captureAfterIntent: typeof mod.captureAfterIntent === 'function'
                    ? (mod.captureAfterIntent as CaptureAfterIntent)
                    : undefined,
            }
        }
    } catch {
        /* fall through */
    }

    // 2) Sibling checkout
    if (!intentsDir) {
        throw new Error(
            'PlaywrightUiDriver: cannot load idea-console/duration-intents. ' +
            'Link package or set DURATION_CONSOLE_INTENTS to e2e/intents.',
        )
    }
    const bridgeTs = join(intentsDir, 'durationBridge.ts')
    const indexTs = join(intentsDir, 'index.ts')
    const entry = existsSync(bridgeTs) ? bridgeTs : existsSync(indexTs) ? indexTs : null
    if (!entry) {
        throw new Error(`PlaywrightUiDriver: no durationBridge/index in ${intentsDir}`)
    }
    const mod = await import(pathToFileURL(entry).href) as Record<string, unknown>
    const runDurationIntent = mod.runDurationIntent as RunDurationIntent | undefined
    const hasDurationIntent = mod.hasDurationIntent as HasDurationIntent | undefined
    if (typeof runDurationIntent !== 'function' || typeof hasDurationIntent !== 'function') {
        throw new Error(`PlaywrightUiDriver: runDurationIntent/hasDurationIntent missing from ${entry}`)
    }
    return {
        runDurationIntent,
        hasDurationIntent,
        captureAfterIntent: typeof mod.captureAfterIntent === 'function'
            ? (mod.captureAfterIntent as CaptureAfterIntent)
            : undefined,
    }
}


/** True when Console base URL is Engine-hosted (not localhost / 127.0.0.1). */
export const shouldForceDemoModeOff = (baseUrl: string): boolean => {
    try {
        const u = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`)
        const host = u.hostname.toLowerCase()
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
        return true
    } catch {
        return !/localhost|127\.0\.0\.1/i.test(baseUrl)
    }
}

export class PlaywrightUiDriver implements UiDriver {
    readonly kind = 'playwright' as const
    private readonly opts: {
        baseUrl: string
        headless: boolean
        failLoud: boolean
        intentsDir: string | null
    }
    private browser: Awaited<ReturnType<PlaywrightModule['chromium']['launch']>> | null = null
    private context: Awaited<ReturnType<Awaited<ReturnType<PlaywrightModule['chromium']['launch']>>['newContext']>> | null = null
    private page: unknown = null
    private bridge: PixelBridge | null = null
    private initPromise: Promise<void> | null = null

    constructor(opts: PlaywrightUiOptions = {}) {
        this.opts = {
            baseUrl: opts.baseUrl
                ?? process.env.DURATION_CONSOLE_URL
                ?? 'http://idea01',
            headless: opts.headless !== false,
            failLoud: opts.failLoud !== false,
            intentsDir: resolveConsoleIntentsDir(opts.intentsDir),
        }
        // Allow construct without sibling if package resolves at runIntent time;
        // createUiDriver still prefers resolveConsoleIntentsDir for fail-fast.
    }

    private async ensureReady(): Promise<void> {
        if (this.page && this.bridge) return
        if (!this.initPromise) {
            this.initPromise = (async () => {
                this.bridge = await loadPixelBridge(this.opts.intentsDir)
                const pw = await loadPlaywright()
                this.browser = await pw.chromium.launch({ headless: this.opts.headless })
                this.context = await this.browser.newContext({ baseURL: this.opts.baseUrl })
                // Force demoMode OFF before first Console goto (idea01:8080 / not localhost).
                // Sticky localStorage.demoMode==='true' (Pixel bootDemo) must not override
                // production Engine-hosted Console. No Intent remap to demo disk IDs;
                // no DURATION_ALLOW_DEMO. Pixel#134 @cdcfdb1 also ignores stored demo in prod web.
                if (shouldForceDemoModeOff(this.opts.baseUrl)) {
                    await this.context.addInitScript(() => {
                        localStorage.setItem('demoMode', 'false')
                    })
                }
                this.page = await this.context.newPage()
            })()
        }
        await this.initPromise
    }

    /**
     * Soft-detect capture after Intent (or for bare page screenshot).
     * Prefer captureAfterIntent; skip second capture if screenshotPath already wrote PNG.
     */
    private async captureFrame(path: string, intent?: string): Promise<void> {
        mkdirSync(dirname(path), { recursive: true })
        // Skip second capture when runDurationIntent already wrote via screenshotPath.
        if (existsSync(path)) return

        const bridge = this.bridge
        // Soft-detect Pixel locked export first: captureAfterIntent(page, { path, intent?, settleMs? })
        if (bridge && typeof bridge.captureAfterIntent === 'function') {
            await bridge.captureAfterIntent(this.page, { path, intent })
            return
        }

        // Fallback: Playwright page.screenshot (fullPage ok)
        const page = this.page as {
            screenshot?: (o: { path: string; fullPage?: boolean }) => Promise<Buffer | void>
        } | null
        if (page && typeof page.screenshot === 'function') {
            await page.screenshot({ path, fullPage: true })
        }
    }

    async runIntent(ctx: UiIntentContext): Promise<UiIntentResult> {
        if (isDeferredUiIntent(ctx.action)) {
            const msg = `UI deferred (Pixel not registered): ${ctx.action} — one of [${DEFERRED_UI_INTENTS.join(', ')}]`
            return {
                ok: !this.opts.failLoud,
                mode: 'deferred',
                message: msg,
            }
        }

        try {
            await this.ensureReady()
            const bridge = this.bridge!
            if (!bridge.hasDurationIntent(ctx.action)) {
                const msg = `hasDurationIntent('${ctx.action}')=false (not in Pixel registry)`
                return {
                    ok: !this.opts.failLoud,
                    mode: 'missing_fixture',
                    message: msg,
                }
            }
            const defaults = defaultIdsForIntent(ctx.action)
            const runOpts: Parameters<RunDurationIntent>[0] = {
                action: ctx.action,
                page: this.page,
                diskId: ctx.diskId ?? defaults.diskId,
                instanceId: ctx.instanceId ?? defaults.instanceId,
                engineId: ctx.engineId,
            }
            // 1) Prefer Pixel screenshotPath on runDurationIntent when recording.
            if (ctx.screenshotPath) {
                runOpts.screenshotPath = ctx.screenshotPath
            }
            const result = await bridge.runDurationIntent(runOpts)

            // Soft-detect post-Intent capture (success or fail — useful for debugging).
            if (ctx.screenshotPath) {
                try {
                    await this.captureFrame(ctx.screenshotPath, ctx.action)
                } catch (capErr) {
                    // Do not override Intent result on capture failure; frame finalize will skip.
                    void capErr
                }
            }

            if (!result.ok) {
                const missing = /not found|timeout|missing|blocker|not landed|visible|not registered/i
                    .test(result.message ?? '')
                return {
                    ok: false,
                    mode: !result.registered || missing ? 'missing_fixture' : 'error',
                    message: `runDurationIntent('${ctx.action}'): ${result.message ?? 'failed'}`,
                }
            }
            return {
                ok: true,
                mode: 'playwright',
                message: `runDurationIntent ok: ${ctx.action}`,
            }
        } catch (err) {
            const raw = err instanceof Error ? err.message : String(err)
            const missing = /not found|timeout|missing|blocker|not landed|visible/i.test(raw)
            return {
                ok: false,
                mode: missing ? 'missing_fixture' : 'error',
                message: `Playwright Intent '${ctx.action}' failed: ${raw}`,
            }
        }
    }

    /**
     * Prefer A r21: pin an EmptyDiskPanel Intent to `disk-<diskId>` by testid.
     * Polls the NetworkTree (reloading every ~10s so a fresh re-dock appears), clicks
     * the row, and optionally waits for `empty-disk-panel`. Throws if never visible —
     * do not let Pixel discovery fall through to another Empty Disk (r21: Empty Disk 002).
     */
    async selectDisk(
        diskId: string,
        opts: { timeoutMs?: number; requireEmptyPanel?: boolean; requireAddFiles?: boolean } = {},
    ): Promise<string> {
        await this.ensureReady()
        const page = this.page as PwPage
        const rowSel = diskRowSelector(diskId)
        const panelSel = '[data-testid="empty-disk-panel"]'
        // Prefer A r22 FAIL@93: add_files_role needs Add Files on the app-only DiskView.
        const addFilesSel = '[data-testid="add-files"]'
        let addFilesState = 'not visible'
        const budget = opts.timeoutMs ?? 60_000
        const deadline = Date.now() + budget
        let lastReload = Date.now()
        let clicked = false
        while (Date.now() < deadline) {
            const row = page.locator(rowSel).first()
            if (await row.isVisible().catch(() => false)) {
                await row.click()
                clicked = true
                if (opts.requireAddFiles) {
                    const btn = page.locator(addFilesSel).first()
                    try {
                        await btn.waitFor({ state: 'visible', timeout: 5_000 })
                        if (!(await btn.isDisabled().catch(() => false))) {
                            return `selected ${rowSel} (Add Files visible)`
                        }
                        addFilesState = `disabled (title="${((await btn.getAttribute('title').catch(() => null)) ?? '').trim()}")`
                    } catch {
                        /* store may still be converging (app role / dock) — retry */
                    }
                    if (Date.now() - lastReload > 10_000) {
                        lastReload = Date.now()
                        await page.reload().catch(() => undefined)
                    }
                    await page.waitForTimeout(500)
                    continue
                }
                if (!opts.requireEmptyPanel) return `selected ${rowSel}`
                try {
                    await page.locator(panelSel).first().waitFor({ state: 'visible', timeout: 5_000 })
                    return `selected ${rowSel} (EmptyDiskPanel visible)`
                } catch {
                    /* store may still be converging — retry */
                }
            }
            if (Date.now() - lastReload > 10_000) {
                lastReload = Date.now()
                await page.reload().catch(() => undefined)
            }
            await page.waitForTimeout(500)
        }
        if (opts.requireAddFiles) {
            throw new Error(
                `selectDisk: ${rowSel} ${clicked ? `clicked but ${addFilesSel} ${addFilesState}` : 'never visible in NetworkTree'} ` +
                    `within ${budget}ms. Prefer A r22 — add_files_role needs Add Files on an app-only disk; ` +
                    `no soft-pass / no remap onto the make_files_disk Files Disk.`,
            )
        }
        throw new Error(
            `selectDisk: ${rowSel} ${clicked ? 'clicked but EmptyDiskPanel never visible' : 'never visible in NetworkTree'} ` +
                `within ${budget}ms. Prefer A — refuse to act on another Empty Disk.`,
        )
    }

    /** r30 reboot_engine: see UiDriver.waitEngineOnline. */
    async waitEngineOnline(
        hostname: string,
        opts: { timeoutMs?: number; allowReload?: boolean } = {},
    ): Promise<string> {
        await this.ensureReady()
        const page = this.page as PwPage
        if (typeof page.evaluate !== 'function') {
            throw new Error('waitEngineOnline: Playwright page has no evaluate()')
        }
        const budget = opts.timeoutMs ?? 180_000
        const start = Date.now()
        let reloaded = false
        let last = 'not sampled'
        while (Date.now() - start < budget) {
            const snap = await page
                .evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('.tree-item--engine')).map(el => ({
                        testId: el.getAttribute('data-testid') ?? '',
                        label: (el.querySelector('.tree-item__label')?.textContent ?? '').trim(),
                        online: !!el.querySelector('.tree-item__status-dot--online'),
                    }))
                    const statusConnected = !!document.querySelector('.status-bar__dot--connected')
                    return { rows, statusConnected }
                })
                .catch((e: unknown) => ({ rows: [] as ConsoleEngineRow[], statusConnected: false, err: String(e) }))
            const verdict = consoleEngineOnline(snap.rows, snap.statusConnected, hostname)
            if (verdict.ok) {
                return `${verdict.detail} after ${Date.now() - start}ms${reloaded ? ' (after one allowed reload)' : ''}`
            }
            last = verdict.detail
            if (opts.allowReload && !reloaded && Date.now() - start > budget / 2) {
                reloaded = true
                await page.reload().catch(() => undefined)
            }
            await page.waitForTimeout(1_000)
        }
        throw new Error(
            `Console did not show ${hostname} online within ${budget}ms (${last})` +
                `${opts.allowReload ? '' : '; no reload attempted (DURATION_REBOOT_ALLOW_RELOAD=1 allows one)'}`,
        )
    }

    /**
     * Capture current page when already open (infra / non-Intent steps under --record-walk --ui).
     * No-op if browser/page not started yet.
     */
    async screenshot(path: string): Promise<void> {
        if (!this.page) return
        await this.captureFrame(path)
    }

    async close(): Promise<void> {
        try { await this.context?.close() } catch { /* ignore */ }
        try { await this.browser?.close() } catch { /* ignore */ }
        this.page = null
        this.context = null
        this.browser = null
        this.bridge = null
        this.initPromise = null
    }
}
