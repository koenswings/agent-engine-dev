/**
 * UI Intent driver contract — Phase 3 (idea#168).
 * ONE walker dispatches here; Pixel adapters live in agent-console-dev e2e/intents.
 *
 * Prefer real UI: `--live --ui` once Pixel Intents harden. Fake StubUiDriver is for
 * CI / missing-Intent dry-runs only — never silently force Stub for registered Intents
 * when `--ui` is set (deferred / unregistered soft-skip or clear-fail via failLoud).
 */
export interface UiIntentContext {
    action: string
    diskId?: string
    instanceId?: string
    engineId?: string
    /**
     * When set (--record-walk), PlaywrightUiDriver writes the step PNG from the
     * ACTIVE tab after the Intent (an App tab the Intent opened or brought to front,
     * else the Console page): bridge.captureAfterIntent(activeTab, { path, intent }),
     * else activeTab.screenshot({ path, fullPage: true }).
     */
    screenshotPath?: string
}

export interface UiIntentResult {
    ok: boolean
    /** stub | playwright | deferred | missing_fixture | error */
    mode: 'stub' | 'playwright' | 'deferred' | 'missing_fixture' | 'error' | 'skip'
    message?: string
}

/**
 * Pluggable browser / Intent session.
 * Fake/CI: StubUiDriver. Preferred verification: `--live --ui` → PlaywrightUiDriver.
 */
export interface UiDriver {
    readonly kind: 'stub' | 'playwright'
    runIntent(ctx: UiIntentContext): Promise<UiIntentResult>
    /**
     * Optional: capture the active tab to path (infra / non-Intent steps with a live page).
     * Stub omits this; Playwright implements when page is already open.
     */
    screenshot?(path: string): Promise<void>
    /**
     * Optional (Prefer A r21): select the NetworkTree row `[data-testid="disk-<diskId>"]`
     * (polling/reloading until it appears) and, when requireEmptyPanel, wait for
     * EmptyDiskPanel — so EmptyDiskPanel Intents act on that exact disk, never the
     * "first Empty Disk". Throws (fail loud) when the row/panel never shows.
     * Prefer A r22: requireAddFiles waits for a visible, enabled
     * `[data-testid="add-files"]` on that DiskView (app-only disk for add_files_role).
     */
    selectDisk?(
        diskId: string,
        opts?: { timeoutMs?: number; requireEmptyPanel?: boolean; requireAddFiles?: boolean },
    ): Promise<string>
    /**
     * Optional (r30 reboot_engine): wait until the Console NetworkTree shows the engine row
     * for `hostname` with an online status dot AND the status bar is connected. Throws
     * (fail loud) on timeout. No page reload unless opts.allowReload (one reload at half
     * budget) — a reload would mask a Console that never reconnects by itself.
     */
    waitEngineOnline?(
        hostname: string,
        opts?: { timeoutMs?: number; allowReload?: boolean },
    ): Promise<string>
    /** r55 (optional): sequence number of the newest tab the browser context opened. */
    tabSeq?(): number
    /**
     * r55 (optional): the Console page and every open tab — URL, whether it is the active tab, and
     * whether it was opened after `sinceSeq`. Used to prove a step's App tabs are on store URLs.
     */
    appTabs?(sinceSeq?: number): { url: string; active: boolean; fresh: boolean; console?: boolean }[]
    close?(): Promise<void>
}
