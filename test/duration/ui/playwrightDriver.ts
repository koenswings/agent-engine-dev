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
 * --record-walk soft-detect order (after Intent):
 *   1) pass screenshotPath into runDurationIntent (Pixel may write PNG)
 *   2) else typeof bridge.captureAfterIntent === 'function'
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
                close: () => Promise<void>
            }>
            close: () => Promise<void>
        }>
    }
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
                this.page = await this.context.newPage()
            })()
        }
        await this.initPromise
    }

    /**
     * Soft-detect capture after Intent (or for bare page screenshot).
     * Order: runDurationIntent already wrote file → captureAfterIntent → page.screenshot.
     */
    private async captureFrame(path: string, intent?: string): Promise<void> {
        mkdirSync(dirname(path), { recursive: true })
        // 1) If Pixel runDurationIntent already wrote via screenshotPath, done.
        if (existsSync(path)) return

        const bridge = this.bridge
        // 2) Pixel locked export: captureAfterIntent(page, { path, intent?, settleMs? })
        if (bridge && typeof bridge.captureAfterIntent === 'function') {
            await bridge.captureAfterIntent(this.page, { path, intent })
            return
        }

        // 3) Fallback: Playwright page.screenshot
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
