/**
 * Console-surface guards for the Playwright driver (run random-c1cc4bb-875a10e-markov-20261119 FAIL@105).
 *
 * Pixel's Console Intents (return_to_start, open_console_as_*, stay_on_*overview) act on the Console page only.
 * They never touch an App tab: the Nextcloud tab (with its Text viewer open after open_collab_doc) stayed open
 * and stayed the recorder's "active" tab, so
 *   - steps 102 / 104 passed on the Console page while the recorded frame was still the Nextcloud viewer, and
 *   - step 105 open_nextcloud_as_teacher re-used that tab and its '#user-menu button' click hit the modal.
 *
 * The harness therefore (narrowly, with proper waits and no sleeps):
 *   - before a Console-surface Intent: closes every App tab and brings the Console to front;
 *   - before open_nextcloud_as_*: dismisses an open #viewer in a re-used Nextcloud tab (close button, else Escape,
 *     then waits for #viewer to be gone; fails loud if it stays);
 *   - after a Console-surface Intent: asserts the active tab IS the Console page, on the Console host, showing a
 *     Console-specific element, and fails clearly otherwise.
 */

/** The slice of a Playwright Locator these guards use. */
export interface SurfaceLocator {
    first(): SurfaceLocator
    or?(other: SurfaceLocator): SurfaceLocator
    isVisible(): Promise<boolean>
    click(o?: { timeout?: number }): Promise<unknown>
    waitFor(o: { state: 'visible' | 'hidden'; timeout?: number }): Promise<unknown>
}

/** The slice of a Playwright Page these guards use (fakes in unit tests). */
export interface SurfacePage {
    url(): string
    isClosed?(): boolean
    close(): Promise<unknown>
    bringToFront?(): Promise<unknown>
    locator(selector: string): SurfaceLocator
    keyboard?: { press(key: string): Promise<unknown> }
}

/** Intents that act on the Console page only: leftover App tabs must be gone before and not be what is shown after. */
export const CONSOLE_SURFACE_INTENTS: ReadonlySet<string> = new Set([
    'return_to_start',
    'open_console_as_teacher',
    'open_console_as_learner',
    'open_console_as_operator',
    'stay_on_overview',
    'stay_on_teacher_overview',
    'stay_on_learner_overview',
])

export const NC_VIEWER = '#viewer'
const NC_VIEWER_CLOSE = '#viewer .header-close, #viewer button[aria-label="Close"]'

/** Console-specific testids (Pixel selectors.ts): no App tab renders any of these. */
const CONSOLE_TESTIDS = {
    consoleOverview: '[data-testid="console-overview"]',
    opOverview: '[data-testid="op-overview"]',
    networkTree: '[data-testid="network-tree"]',
    opEntry: '[data-testid="op-entry"]',
} as const

/** Which Console element(s) each Console-surface Intent must leave visible. */
export const consoleElementsFor = (action: string): string[] => {
    switch (action) {
        case 'open_console_as_teacher':
        case 'open_console_as_learner':
        case 'stay_on_teacher_overview':
        case 'stay_on_learner_overview':
            return [CONSOLE_TESTIDS.consoleOverview]
        case 'stay_on_overview':
            return [CONSOLE_TESTIDS.opOverview, CONSOLE_TESTIDS.networkTree]
        case 'open_console_as_operator':
            return [CONSOLE_TESTIDS.opEntry, CONSOLE_TESTIDS.opOverview, CONSOLE_TESTIDS.networkTree]
        default:
            return [CONSOLE_TESTIDS.consoleOverview, CONSOLE_TESTIDS.opOverview, CONSOLE_TESTIDS.networkTree]
    }
}

const open = (p: SurfacePage): boolean => {
    try { return p.isClosed?.() !== true } catch { return false }
}

const urlOf = (p: SurfacePage): string => {
    try { return p.url() } catch { return '' }
}

/** Dismiss an open Nextcloud Viewer modal on `page`: close button, else Escape; throws if #viewer stays. */
export const dismissViewer = async (page: SurfacePage, tag: string, timeoutMs = 5_000): Promise<boolean> => {
    const viewer = page.locator(NC_VIEWER).first()
    if (!(await viewer.isVisible().catch(() => false))) return false
    const close = page.locator(NC_VIEWER_CLOSE).first()
    if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: timeoutMs }).catch(() => undefined)
    } else {
        await page.keyboard?.press('Escape').catch(() => undefined)
    }
    try {
        await viewer.waitFor({ state: 'hidden', timeout: timeoutMs })
    } catch {
        throw new Error(`${tag}: Nextcloud Viewer (#viewer) still open on ${urlOf(page)} after dismiss (close button / Escape).`)
    }
    return true
}

/** Close every tab except the Console page and bring the Console to front. Returns the closed tab URLs. */
export const closeAppTabs = async (consolePage: SurfacePage, all: readonly SurfacePage[]): Promise<string[]> => {
    const closed: string[] = []
    for (const p of all) {
        if (p === consolePage || !open(p)) continue
        const u = urlOf(p)
        await p.close().catch(() => undefined)
        closed.push(u || 'about:blank')
    }
    await consolePage.bringToFront?.()
    return closed
}

/** Before a Console-surface Intent. Returns a note for the step message ('' when nothing was left over). */
export const prepareConsoleSurface = async (
    action: string,
    consolePage: SurfacePage,
    all: readonly SurfacePage[],
): Promise<string> => {
    if (!CONSOLE_SURFACE_INTENTS.has(action)) return ''
    const closed = await closeAppTabs(consolePage, all)
    return closed.length ? `closed leftover App tab(s) ${closed.join(', ')}` : ''
}

/** Before open_nextcloud_as_*: a re-used Nextcloud tab must not have a Viewer modal over the header. */
export const prepareNextcloudSignIn = async (
    action: string,
    consolePage: SurfacePage,
    all: readonly SurfacePage[],
): Promise<void> => {
    if (!/^open_nextcloud_as_/.test(action)) return
    for (const p of all) {
        if (p === consolePage || !open(p)) continue
        await dismissViewer(p, `${action}: leftover Nextcloud tab`)
    }
}

const hostOf = (u: string): string => {
    try { return new URL(u).hostname } catch { return '' }
}

/**
 * After a Console-surface Intent: prove the walker really is on the Console. Throws a clear error otherwise.
 * `active` is the recorder's active tab; it must be the Console page (so the step frame shows the Console).
 */
export const assertOnConsole = async (
    action: string,
    consolePage: SurfacePage,
    active: SurfacePage | null | undefined,
    baseUrl: string,
    timeoutMs = 10_000,
): Promise<void> => {
    if (!CONSOLE_SURFACE_INTENTS.has(action)) return
    const url = urlOf(consolePage)
    if (active && active !== consolePage) {
        throw new Error(`${action}: not on the Console: the active tab is ${urlOf(active) || 'about:blank'}, not the Console page (${url}).`)
    }
    const want = hostOf(baseUrl)
    const got = hostOf(url)
    if (!got || (want && got !== want)) {
        throw new Error(`${action}: not on the Console: page URL ${url || 'about:blank'} is not on the Console host name ${want || baseUrl}.`)
    }
    const wanted = consoleElementsFor(action)
    let loc = consolePage.locator(wanted[0]!)
    for (const sel of wanted.slice(1)) loc = loc.or ? loc.or(consolePage.locator(sel)) : loc
    try {
        await loc.first().waitFor({ state: 'visible', timeout: timeoutMs })
    } catch {
        throw new Error(`${action}: not on the Console: none of ${wanted.join(' | ')} is visible on ${url}.`)
    }
}
