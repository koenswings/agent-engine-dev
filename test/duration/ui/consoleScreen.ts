/**
 * kc10 step 133 (idea#168): which Console screen is up when an Intent fails.
 *
 * --record-walk frames come from the ACTIVE tab (activeTab.ts). An App tab that an
 * Intent opened and never closed stays active, so in kc10 every frame from step 112
 * to 133 showed the Kolibri tab, and the reboot_engine failure ("op-overview or
 * network-tree not visible within 15 s") left no picture of the Console page the
 * Intent was driving. On an Intent failure the driver now also writes the Console
 * page itself (`<frame>-console.png`) and adds a one-line screen summary to the
 * step message. Read-only: nothing is clicked.
 */

/** Console screens, by the data-testid the Console renders for each (agent-console-dev src). */
export const CONSOLE_SCREEN_PROBES: readonly { name: string; selector: string }[] = [
    { name: 'op-overview', selector: '[data-testid="op-overview"]' },
    { name: 'network-tree', selector: '[data-testid="network-tree"]' },
    { name: 'network-loading', selector: '[data-testid="network-loading"]' },
    { name: 'settings-panel', selector: '[data-testid="settings-panel"]' },
    { name: 'connection-management', selector: '[data-testid="connection-management"]' },
    { name: 'op-entry', selector: '[data-testid="op-entry"]' },
    { name: 'login-form', selector: '[data-testid="login-form"]' },
    { name: 'status-connected', selector: '.status-bar__dot--connected' },
]

/** `/x/step-0133-reboot_engine.png` → `/x/step-0133-reboot_engine-console.png`. */
export const consoleFramePath = (framePath: string): string =>
    /\.png$/i.test(framePath) ? framePath.replace(/\.png$/i, '-console.png') : `${framePath}-console.png`

export interface ConsoleScreenSnapshot {
    url: string
    visible: string[]
    status: string
}

/** One line for the step message, e.g. `console page http://idea01:8080/ visible=[settings-panel] status="idea01"`. */
export const formatConsoleScreen = (s: ConsoleScreenSnapshot): string =>
    `console page ${s.url || '<no url>'} visible=[${s.visible.join(', ') || 'none'}] status=${JSON.stringify(s.status)}`

type ProbePage = {
    url?: () => string
    locator: (sel: string) => {
        first: () => { isVisible: () => Promise<boolean>; textContent?: () => Promise<string | null> }
    }
}

/** Read which Console screens are visible (never throws; a broken page reads as none). */
export const readConsoleScreen = async (page: unknown): Promise<ConsoleScreenSnapshot> => {
    const p = page as ProbePage | null
    let url = ''
    try { url = p?.url?.() ?? '' } catch { url = '' }
    const visible: string[] = []
    let status = ''
    if (!p || typeof p.locator !== 'function') return { url, visible, status }
    for (const probe of CONSOLE_SCREEN_PROBES) {
        const on = await p.locator(probe.selector).first().isVisible().catch(() => false)
        if (on) visible.push(probe.name)
    }
    try {
        const loc = p.locator('[data-testid="status-bar-hostname"]').first()
        status = ((await loc.textContent?.()) ?? '').replace(/\s+/g, ' ').trim()
    } catch { status = '' }
    return { url, visible, status }
}
