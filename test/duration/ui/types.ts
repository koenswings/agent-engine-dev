/**
 * UI Intent driver contract — Phase 3 (idea#168).
 * ONE walker dispatches here; Pixel adapters live in agent-console-dev e2e/intents.
 */

export interface UiIntentContext {
    action: string
    diskId?: string
    instanceId?: string
    engineId?: string
}

export interface UiIntentResult {
    ok: boolean
    /** stub | playwright | deferred | missing_fixture | error */
    mode: 'stub' | 'playwright' | 'deferred' | 'missing_fixture' | 'error' | 'skip'
    message?: string
}

/**
 * Pluggable browser / Intent session. Fake CI uses StubUiDriver;
 * --ui / live uses PlaywrightUiDriver calling Pixel getIntent(name).
 */
export interface UiDriver {
    readonly kind: 'stub' | 'playwright'
    runIntent(ctx: UiIntentContext): Promise<UiIntentResult>
    close?(): Promise<void>
}
