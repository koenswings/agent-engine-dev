/**
 * Active-tab model for --record-walk (idea#168).
 *
 * The walk recorder used to screenshot the Console page for every step, so an
 * in-app step (Kolibri lesson, Nextcloud share, Wikipedia search) showed the
 * Console behind the App instead of the App itself. Pixel's Intents open each
 * App in its own tab of the same browser context (openApp.ts openInstancePathB,
 * Console window.open popups, wikipedia.ts, nextcloudDeep.ts) and return to the
 * Console by closing the App tab and calling consolePage.bringToFront()
 * (operatorDeepActions.ts leaveAppToConsole).
 *
 * Headless Playwright treats every page as focused, so "which tab is active"
 * cannot be read from the browser. This tracker models it the way a real
 * browser behaves:
 *   - a newly opened tab or popup becomes the active tab;
 *   - page.bringToFront() makes that page the active tab;
 *   - closing the active tab falls back to the tab that was active before it.
 * The recorder then captures the active tab for each step.
 */

/** The slice of a Playwright Page the tracker needs (fakes in unit tests). */
export interface TrackablePage {
    isClosed?: () => boolean
    on?: (event: 'close', listener: () => void) => unknown
    bringToFront?: () => Promise<void>
}

export class ActiveTabTracker<P extends TrackablePage = TrackablePage> {
    /** Activation order: the last entry is the active tab. */
    private order: P[] = []
    private readonly wired = new WeakSet<object>()
    private readonly closed = new WeakSet<object>()

    /**
     * Start following a page (context 'page' event, or the Console page itself).
     * Idempotent per page. A newly tracked page becomes the active tab.
     */
    track(page: P): void {
        if (!this.wired.has(page)) {
            this.wired.add(page)
            page.on?.('close', () => this.markClosed(page))
            const orig = page.bringToFront
            if (typeof orig === 'function') {
                page.bringToFront = async () => {
                    await orig.call(page)
                    this.activate(page)
                }
            }
        }
        this.activate(page)
    }

    /** Make `page` the active tab. */
    activate(page: P): void {
        if (this.isGone(page)) return
        this.order = this.order.filter(p => p !== page)
        this.order.push(page)
    }

    /** Forget a closed page; the previously active tab becomes active again. */
    markClosed(page: P): void {
        this.closed.add(page)
        this.order = this.order.filter(p => p !== page)
    }

    /** The active tab, or `fallback` when no tracked tab is still open. */
    active(fallback: P): P
    active(): P | undefined
    active(fallback?: P): P | undefined {
        for (let i = this.order.length - 1; i >= 0; i--) {
            const p = this.order[i]!
            if (!this.isGone(p)) return p
        }
        return fallback
    }

    private isGone(page: P): boolean {
        if (this.closed.has(page)) return true
        try {
            return page.isClosed?.() === true
        } catch {
            return true
        }
    }
}

type ScreenshotPage = {
    screenshot?: (o: { path: string; fullPage?: boolean }) => Promise<unknown>
}

/**
 * Write one recorder frame from `page` (the active tab). Prefers Pixel's
 * captureAfterIntent (settle + viewport PNG) when the bridge exports it, else
 * Playwright page.screenshot. Resolves without writing when `page` cannot
 * take screenshots.
 */
export const captureFrameFrom = async (
    page: unknown,
    path: string,
    intent?: string,
    captureAfterIntent?: (page: unknown, opts: { path: string; intent?: string }) => Promise<void>,
): Promise<void> => {
    if (!page) return
    if (typeof captureAfterIntent === 'function') {
        await captureAfterIntent(page, { path, intent })
        return
    }
    const p = page as ScreenshotPage
    if (typeof p.screenshot === 'function') {
        await p.screenshot({ path, fullPage: true })
    }
}

/**
 * Follow every tab the browser context opens (Pixel newPage() calls and
 * Console window.open popups both raise the context 'page' event).
 */
export const followContextTabs = <P extends TrackablePage>(
    context: { on?: (event: 'page', listener: (page: P) => void) => unknown },
    tracker: ActiveTabTracker<P>,
): void => {
    context.on?.('page', page => tracker.track(page))
}
