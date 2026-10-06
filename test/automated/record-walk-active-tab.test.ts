/**
 * record-walk-active-tab.test.ts (idea#168)
 *
 * --record-walk must capture the tab the walker is on: an App tab (Kolibri,
 * Nextcloud, Wikipedia) after an in-app step, the Console after the walker
 * returns. Fake pages model the Playwright calls Pixel's Intents make: a new
 * tab via the context 'page' event, page.bringToFront(), page.close().
 */

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { ActiveTabTracker, captureFrameFrom, followContextTabs } from '../duration/ui/activeTab.js'

class FakePage extends EventEmitter {
    closedFlag = false
    fronted = 0
    shots: string[] = []
    constructor(readonly name: string) { super() }
    isClosed(): boolean { return this.closedFlag }
    async bringToFront(): Promise<void> { this.fronted++ }
    async screenshot(o: { path: string; fullPage?: boolean }): Promise<void> { this.shots.push(o.path) }
    async close(): Promise<void> {
        this.closedFlag = true
        this.emit('close')
    }
}

class FakeContext extends EventEmitter {
    pages: FakePage[] = []
    async newPage(name: string): Promise<FakePage> {
        const p = new FakePage(name)
        this.pages.push(p)
        this.emit('page', p)
        return p
    }
}

const setup = async () => {
    const tracker = new ActiveTabTracker<FakePage>()
    const context = new FakeContext()
    followContextTabs(context, tracker)
    const consolePage = await context.newPage('console')
    tracker.track(consolePage)
    return { tracker, context, consolePage }
}

describe('--record-walk active tab (idea#168)', () => {
    it('the Console page is the active tab until an App tab opens', async () => {
        const { tracker, consolePage } = await setup()
        expect(tracker.active(consolePage).name).toBe('console')
    })

    it('a newly opened App tab (open_video → Kolibri) becomes the active tab', async () => {
        const { tracker, context, consolePage } = await setup()
        await context.newPage('kolibri')
        expect(tracker.active(consolePage).name).toBe('kolibri')
    })

    it('leaving the App (close tab + consolePage.bringToFront) returns to the Console', async () => {
        const { tracker, context, consolePage } = await setup()
        const kolibri = await context.newPage('kolibri')
        await kolibri.close()
        await consolePage.bringToFront()
        expect(consolePage.fronted).toBe(1) // the original bringToFront still runs
        expect(tracker.active(consolePage).name).toBe('console')
    })

    it('bringToFront on the Console with the App tab still open makes the Console active', async () => {
        const { tracker, context, consolePage } = await setup()
        await context.newPage('nextcloud')
        await consolePage.bringToFront()
        expect(tracker.active(consolePage).name).toBe('console')
    })

    it('closing a helper tab falls back to the tab that was active before it (File Drop → Files)', async () => {
        const { tracker, context, consolePage } = await setup()
        const files = await context.newPage('nextcloud-files')
        const drop = await context.newPage('nextcloud-drop')
        expect(tracker.active(consolePage).name).toBe('nextcloud-drop')
        await drop.close()
        expect(tracker.active(consolePage).name).toBe('nextcloud-files')
        await files.bringToFront()
        expect(tracker.active(consolePage).name).toBe('nextcloud-files')
    })

    it('a page closed without a close event (isClosed true) is never returned', async () => {
        const { tracker, context, consolePage } = await setup()
        const wiki = await context.newPage('kiwix')
        wiki.closedFlag = true
        expect(tracker.active(consolePage).name).toBe('console')
    })

    it('tracking the same page twice wraps bringToFront once', async () => {
        const { tracker, consolePage } = await setup()
        tracker.track(consolePage)
        tracker.track(consolePage)
        await consolePage.bringToFront()
        expect(consolePage.fronted).toBe(1)
    })

    it('captureFrameFrom screenshots the active App tab, not the Console', async () => {
        const { tracker, context, consolePage } = await setup()
        const kolibri = await context.newPage('kolibri')
        await captureFrameFrom(tracker.active(consolePage), '/tmp/step-0007-open_video.png', 'open_video')
        expect(kolibri.shots).toEqual(['/tmp/step-0007-open_video.png'])
        expect(consolePage.shots).toEqual([])
    })

    it('captureFrameFrom hands the active tab to Pixel captureAfterIntent when the bridge has it', async () => {
        const { tracker, context, consolePage } = await setup()
        await context.newPage('wikipedia')
        const seen: Array<{ page: string; path: string; intent?: string }> = []
        await captureFrameFrom(
            tracker.active(consolePage),
            '/tmp/step-0042-search_browse_wikipedia.png',
            'search_browse_wikipedia',
            async (page, opts) => { seen.push({ page: (page as FakePage).name, ...opts }) },
        )
        expect(seen).toEqual([{ page: 'wikipedia', path: '/tmp/step-0042-search_browse_wikipedia.png', intent: 'search_browse_wikipedia' }])
    })

    it('captureFrameFrom is a no-op without a page', async () => {
        await expect(captureFrameFrom(null, '/tmp/x.png')).resolves.toBeUndefined()
    })
})
