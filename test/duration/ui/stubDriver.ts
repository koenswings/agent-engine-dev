/**
 * StubUiDriver — FakeFleetOps / CI default (no browser).
 * Records Intent names so unit tests can assert dispatch wiring.
 */
import {
    isDeferredUiIntent,
    isPixelIntent,
    isPixelMissingUiIntent,
} from './fixtures.js'
import type { UiDriver, UiIntentContext, UiIntentResult } from './types.js'

export class StubUiDriver implements UiDriver {
    readonly kind = 'stub' as const
    readonly calls: string[] = []
    /** Full Intent contexts (diskId/instanceId) for fixture-remap unit asserts. */
    readonly callContexts: UiIntentContext[] = []

    async runIntent(ctx: UiIntentContext): Promise<UiIntentResult> {
        this.calls.push(ctx.action)
        this.callContexts.push(ctx)
        if (isDeferredUiIntent(ctx.action)) {
            return {
                ok: true,
                mode: 'deferred',
                message: `UI deferred (not in Pixel registry): ${ctx.action}`,
            }
        }
        if (isPixelMissingUiIntent(ctx.action)) {
            return {
                ok: true,
                mode: 'stub',
                message: `UI stub (Pixel-missing Fake no-op): ${ctx.action}`,
            }
        }
        if (isPixelIntent(ctx.action)) {
            return {
                ok: true,
                mode: 'stub',
                message: `UI stub (Fake/CI): ${ctx.action}`,
            }
        }
        return {
            ok: true,
            mode: 'stub',
            message: `UI stub (unknown Intent): ${ctx.action}`,
        }
    }
}
