/**
 * The ONE Playwright loader: PlaywrightUiDriver and the box-tooling preflight (exit 11) both use it.
 *
 * r52 FAIL@1 (2026-10-09): 'playwright' was not resolvable from the harness checkout, so the loader fell
 * back to /workspace/agent-console-dev/node_modules/playwright via ESM import(). playwright/index.js is CJS
 * (`module.exports = require('playwright-core')`), so the import namespace only had `default` and
 * `pw.chromium.launch` blew up with "Cannot read properties of undefined (reading 'launch')".
 * Fix: unwrap `mod.default ?? mod` and assert `.chromium.launch` exists, with a clear error otherwise.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TrackablePage } from './activeTab.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Candidate specs, in load order (the preflight's static check walks the same list). */
export const playwrightCandidates = (driverDir: string): string[] => [
    'playwright',
    '@playwright/test',
    '/workspace/agent-console-dev/node_modules/playwright',
    resolve(driverDir, '../../../../agent-console-dev/node_modules/playwright'),
]

export type PlaywrightBrowser = {
    newContext: (opts?: { baseURL?: string }) => Promise<{
        newPage: () => Promise<unknown>
        on: (event: 'page', listener: (page: TrackablePage) => void) => unknown
        addInitScript: (script: () => void) => Promise<void>
        close: () => Promise<void>
    }>
    close: () => Promise<void>
    version?: () => string
}

export type PlaywrightModule = {
    chromium: {
        launch: (opts?: { headless?: boolean }) => Promise<PlaywrightBrowser>
        executablePath?: () => string
    }
}

export interface PlaywrightLoaderIo {
    /** ESM import of a file URL; resolves null when it cannot be imported. */
    importUrl: (url: string) => Promise<unknown>
    /** CJS require of a bare spec or absolute dir; throws when not found. */
    requireSpec: (spec: string) => unknown
}

const hasLaunch = (m: unknown): boolean =>
    !!m && typeof m === 'object' && typeof (m as { chromium?: { launch?: unknown } }).chromium?.launch === 'function'

/**
 * `mod.default ?? mod`, then require `.chromium.launch`. A CJS module imported via ESM exposes its
 * exports only as `default`; a namespace that carries chromium itself is accepted too.
 */
export const normalizePlaywrightModule = (mod: unknown, spec: string): PlaywrightModule => {
    if (mod == null || (typeof mod !== 'object' && typeof mod !== 'function')) {
        throw new Error(`PlaywrightUiDriver: module loaded from '${spec}' is ${mod === null ? 'null' : typeof mod}, not Playwright`)
    }
    const unwrapped = (mod as { default?: unknown }).default ?? mod
    if (hasLaunch(unwrapped)) return unwrapped as PlaywrightModule
    if (hasLaunch(mod)) return mod as PlaywrightModule
    const keys = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 12).join(',') || '(none)' : typeof o)
    throw new Error(
        `PlaywrightUiDriver: module loaded from '${spec}' has no chromium.launch ` +
            `(keys: ${keys(mod)}; default keys: ${keys((mod as { default?: unknown }).default)}) — not a usable Playwright`,
    )
}

export const realPlaywrightLoaderIo = (fromUrl: string = import.meta.url): PlaywrightLoaderIo => {
    const req = createRequire(fromUrl)
    return {
        importUrl: url => import(url).catch(() => null),
        requireSpec: spec => req(spec),
    }
}

export interface LoadedPlaywright { mod: PlaywrightModule; spec: string }

/**
 * First candidate that loads wins; a candidate that loads but is not a usable Playwright throws
 * (clear error, no silent fall-through to a different install).
 */
export const loadPlaywright = async (
    io: PlaywrightLoaderIo = realPlaywrightLoaderIo(),
    driverDir: string = here,
): Promise<LoadedPlaywright> => {
    const tries = playwrightCandidates(driverDir)
    for (const spec of tries) {
        let mod: unknown = null
        if (spec.startsWith('/')) mod = await io.importUrl(pathToFileURL(join(spec, 'index.js')).href)
        if (mod == null) {
            try {
                mod = io.requireSpec(spec)
            } catch {
                continue
            }
        }
        return { mod: normalizePlaywrightModule(mod, spec), spec }
    }
    throw new Error(
        `PlaywrightUiDriver: playwright not installed (tried ${tries.join(', ')}). ` +
            'Install in Engine (pnpm add -D playwright) or use agent-console-dev node_modules.',
    )
}
