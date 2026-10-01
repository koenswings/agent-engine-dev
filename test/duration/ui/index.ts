export {
    DURATION_UI_FIXTURES,
    PIXEL_REGISTERED_INTENTS,
    DEFERRED_UI_INTENTS,
    PIXEL_MISSING_INTENTS,
    isPixelIntent,
    isDeferredUiIntent,
    isPixelMissingUiIntent,
    defaultIdsForIntent,
} from './fixtures.js'
export type { PixelIntentName } from './fixtures.js'
export type { UiDriver, UiIntentContext, UiIntentResult } from './types.js'
export { StubUiDriver } from './stubDriver.js'
export {
    PlaywrightUiDriver,
    resolveConsoleIntentsDir,
    type PlaywrightUiOptions,
} from './playwrightDriver.js'

import { PlaywrightUiDriver, resolveConsoleIntentsDir } from './playwrightDriver.js'
import { StubUiDriver } from './stubDriver.js'
import type { UiDriver } from './types.js'

export interface CreateUiDriverOpts {
    /** When true, use StubUiDriver (Fake CI). When false, try Playwright. */
    stub: boolean
    baseUrl?: string
    intentsDir?: string
    headless?: boolean
    failLoud?: boolean
}

/** Factory used by cli / runner — stub for Fake; Playwright when --ui. */
export const createUiDriver = (opts: CreateUiDriverOpts): UiDriver => {
    if (opts.stub) return new StubUiDriver()
    // Prefer package idea-console/duration-intents; sibling e2e/intents is fallback.
    const dir = resolveConsoleIntentsDir(opts.intentsDir)
    return new PlaywrightUiDriver({
        baseUrl: opts.baseUrl,
        intentsDir: dir ?? opts.intentsDir,
        headless: opts.headless,
        failLoud: opts.failLoud,
    })
}
