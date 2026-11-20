/**
 * record-walk-console-screen.test.ts (idea#168, kc10 step 133)
 *
 * kc10 failed at reboot_engine with "op-overview or network-tree not visible within 15 s",
 * but every --record-walk frame from step 112 on showed a leftover Kolibri tab, so there was
 * no picture of the Console page the Intent drove. On an Intent failure the driver now names
 * the visible Console screens and writes `<frame>-console.png`. These tests pin that summary.
 */

import { describe, it, expect } from 'vitest'
import {
    CONSOLE_SCREEN_PROBES,
    consoleFramePath,
    formatConsoleScreen,
    readConsoleScreen,
} from '../duration/ui/consoleScreen.js'

const fakePage = (visible: Set<string>, status: string | null, url = 'http://idea01:8080/') => ({
    url: () => url,
    locator: (sel: string) => ({
        first: () => ({
            isVisible: async () => visible.has(sel),
            textContent: async () => (sel === '[data-testid="status-bar-hostname"]' ? status : null),
        }),
    }),
})

describe('kc10 step 133: Console screen on Intent failure', () => {
    it('names the frame next to the active-tab frame', () => {
        expect(consoleFramePath('/e/walk/step-0133-reboot_engine.png')).toBe('/e/walk/step-0133-reboot_engine-console.png')
        expect(consoleFramePath('/e/walk/frame')).toBe('/e/walk/frame-console.png')
    })

    it('reports Settings still open over the overview (the reboot_engine pre-click wait case)', async () => {
        const page = fakePage(new Set(['[data-testid="settings-panel"]', '.status-bar__dot--connected']), ' idea01 ')
        const snap = await readConsoleScreen(page)
        expect(snap.visible).toEqual(['settings-panel', 'status-connected'])
        expect(formatConsoleScreen(snap)).toBe('console page http://idea01:8080/ visible=[settings-panel, status-connected] status="idea01"')
    })

    it('reports the operator overview when it is up', async () => {
        const page = fakePage(new Set(['[data-testid="op-overview"]', '[data-testid="network-tree"]']), 'idea01')
        expect((await readConsoleScreen(page)).visible).toEqual(['op-overview', 'network-tree'])
    })

    it('never throws on a broken or missing page', async () => {
        expect(await readConsoleScreen(null)).toEqual({ url: '', visible: [], status: '' })
        const broken = {
            url: () => { throw new Error('closed') },
            locator: () => ({ first: () => ({ isVisible: async () => { throw new Error('closed') } }) }),
        }
        const snap = await readConsoleScreen(broken)
        expect(snap.visible).toEqual([])
        expect(formatConsoleScreen(snap)).toBe('console page <no url> visible=[none] status=""')
    })

    it('probes every Console screen the operator Intents can leave up', () => {
        expect(CONSOLE_SCREEN_PROBES.map(p => p.name)).toEqual([
            'op-overview', 'network-tree', 'network-loading', 'settings-panel',
            'connection-management', 'op-entry', 'login-form', 'status-connected',
        ])
    })
})
