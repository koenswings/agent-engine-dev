/**
 * random-c1cc4bb-875a10e-markov-20261119 FAIL@105: Console Intents act on the Console page only, so a leftover Nextcloud
 * tab (Text viewer open after open_collab_doc) stayed the active tab; steps 102/104 "passed" while the frame was that
 * viewer, and step 105's '#user-menu button' click was intercepted by #viewer. Fake pages model the Playwright calls.
 */
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { ActiveTabTracker, followContextTabs } from '../duration/ui/activeTab.js'
import {
    assertOnConsole,
    closeAppTabs,
    consoleElementsFor,
    dismissViewer,
    prepareConsoleSurface,
    prepareNextcloudSignIn,
    type SurfaceLocator,
    type SurfacePage,
} from '../duration/ui/consoleSurface.js'

class FakeLoc implements SurfaceLocator {
    constructor(private readonly page: FakePage, private readonly sels: string[]) {}
    first() { return this }
    or(o: SurfaceLocator) { return new FakeLoc(this.page, [...this.sels, ...(o as FakeLoc).sels]) }
    async isVisible() { return this.sels.some(s => this.page.visible.has(s)) }
    async click() {
        this.page.clicks.push(this.sels.join(','))
        if (this.page.closeDismisses && this.sels[0]!.includes('header-close')) this.page.visible.delete('#viewer')
    }
    async waitFor(o: { state: 'visible' | 'hidden' }) {
        const vis = this.sels.some(s => this.page.visible.has(s))
        if (o.state === 'visible' && !vis) throw new Error('timeout')
        if (o.state === 'hidden' && vis) throw new Error('timeout')
    }
}

class FakePage extends EventEmitter implements SurfacePage {
    closedFlag = false
    fronted = 0
    visible = new Set<string>()
    clicks: string[] = []
    presses: string[] = []
    closeDismisses = true
    keyboard = { press: async (k: string) => { this.presses.push(k); if (this.escDismisses) this.visible.delete('#viewer') } }
    escDismisses = true
    constructor(public u: string) { super() }
    url() { return this.u }
    isClosed() { return this.closedFlag }
    async bringToFront() { this.fronted++ }
    async close() { this.closedFlag = true; this.emit('close') }
    locator(s: string) { return new FakeLoc(this, s.split(/\s*,\s*/)) }
}

const VIEWER = '#viewer'
const CONSOLE_URL = 'http://idea01:8080/#/'
const NC_URL = 'http://idea03.local:61820/apps/files/?openfile=true'

const setup = () => {
    const tracker = new ActiveTabTracker<FakePage & never>() as unknown as ActiveTabTracker
    const consolePage = new FakePage(CONSOLE_URL)
    consolePage.visible.add('[data-testid="console-overview"]')
    const nc = new FakePage(NC_URL)
    nc.visible.add(VIEWER)
    nc.visible.add('#viewer .header-close')
    const ctx = new EventEmitter()
    followContextTabs(ctx as never, tracker as never)
    for (const p of [consolePage, nc]) { ctx.emit('page', p) }
    return { tracker, consolePage, nc }
}

describe('Console-surface Intents never leave an App tab in charge', () => {
    it('old behaviour: the leftover Nextcloud tab is the active tab and the Console intents ran behind it', () => {
        const { tracker, consolePage, nc } = setup()
        expect(tracker.active(consolePage as never)).toBe(nc)
    })

    it('return_to_start / open_console_as_* / stay_on_*_overview close the leftover tab and bring the Console to front', async () => {
        for (const action of ['return_to_start', 'open_console_as_teacher', 'stay_on_teacher_overview', 'stay_on_learner_overview', 'stay_on_overview']) {
            const { tracker, consolePage, nc } = setup()
            const note = await prepareConsoleSurface(action, consolePage, [consolePage, nc])
            expect(nc.closedFlag).toBe(true)
            expect(consolePage.fronted).toBe(1)
            expect(note).toContain(NC_URL)
            expect(tracker.active(consolePage as never)).toBe(consolePage)
        }
    })

    it('other Intents are not touched', async () => {
        const { consolePage, nc } = setup()
        expect(await prepareConsoleSurface('keep_editing', consolePage, [consolePage, nc])).toBe('')
        expect(nc.closedFlag).toBe(false)
    })

    it('closeAppTabs skips the Console page and tabs already closed', async () => {
        const { consolePage, nc } = setup()
        const gone = new FakePage('http://x/'); gone.closedFlag = true
        expect(await closeAppTabs(consolePage, [consolePage, gone, nc])).toEqual([NC_URL])
        expect(consolePage.closedFlag).toBe(false)
    })
})

describe('open_nextcloud_as_* dismisses an open Viewer first (FAIL@105)', () => {
    it('clicks the Viewer close button and waits for #viewer to be gone', async () => {
        const { consolePage, nc } = setup()
        await prepareNextcloudSignIn('open_nextcloud_as_teacher', consolePage, [consolePage, nc])
        expect(nc.visible.has(VIEWER)).toBe(false)
        expect(nc.clicks[0]).toContain('header-close')
    })
    it('falls back to Escape when there is no close button', async () => {
        const { consolePage, nc } = setup()
        nc.visible.delete('#viewer .header-close')
        expect(await dismissViewer(nc, 't')).toBe(true)
        expect(nc.presses).toEqual(['Escape'])
        expect(nc.visible.has(VIEWER)).toBe(false)
        void consolePage
    })
    it('fails loud when #viewer stays', async () => {
        const { nc } = setup()
        nc.closeDismisses = false
        await expect(dismissViewer(nc, 't', 50)).rejects.toThrow(/#viewer\) still open on http:\/\/idea03\.local:61820/)
    })
    it('does nothing for a tab with no viewer, and for other Intents', async () => {
        const { consolePage, nc } = setup()
        nc.visible.delete(VIEWER)
        expect(await dismissViewer(nc, 't')).toBe(false)
        nc.visible.add(VIEWER)
        await prepareNextcloudSignIn('open_kolibri_as_teacher', consolePage, [consolePage, nc])
        expect(nc.visible.has(VIEWER)).toBe(true)
    })
})

describe('Console intents verify they are really on the Console', () => {
    it('passes on the Console page with its element visible', async () => {
        const { consolePage } = setup()
        await expect(assertOnConsole('open_console_as_teacher', consolePage, consolePage, 'http://idea01', 50)).resolves.toBeUndefined()
    })
    it('fails when the active tab is an App tab (the old false pass: frame was the Nextcloud viewer)', async () => {
        const { consolePage, nc } = setup()
        await expect(assertOnConsole('stay_on_teacher_overview', consolePage, nc, 'http://idea01', 50))
            .rejects.toThrow(/not on the Console: the active tab is http:\/\/idea03\.local:61820/)
    })
    it('fails when the Console page is on another host', async () => {
        const { consolePage } = setup()
        consolePage.u = 'http://idea03.local:61820/apps/files/'
        await expect(assertOnConsole('open_console_as_learner', consolePage, consolePage, 'http://idea01', 50))
            .rejects.toThrow(/not on the Console host name idea01/)
        consolePage.u = 'about:blank'
        await expect(assertOnConsole('open_console_as_learner', consolePage, consolePage, 'http://idea01', 50))
            .rejects.toThrow(/about:blank/)
    })
    it('fails when no Console element is visible', async () => {
        const { consolePage } = setup()
        consolePage.visible.clear()
        await expect(assertOnConsole('open_console_as_teacher', consolePage, consolePage, 'http://idea01', 50))
            .rejects.toThrow(/console-overview\] is not visible|none of .*console-overview.* is visible/)
    })
    it('role overviews need console-overview; operator Intents accept the operator surfaces', async () => {
        expect(consoleElementsFor('stay_on_learner_overview')).toEqual(['[data-testid="console-overview"]'])
        expect(consoleElementsFor('stay_on_overview')).toContain('[data-testid="network-tree"]')
        const { consolePage } = setup()
        consolePage.visible.clear()
        consolePage.visible.add('[data-testid="op-entry"]')
        await expect(assertOnConsole('open_console_as_operator', consolePage, consolePage, 'http://idea01', 50)).resolves.toBeUndefined()
        await expect(assertOnConsole('stay_on_teacher_overview', consolePage, consolePage, 'http://idea01', 50)).rejects.toThrow(/not on the Console/)
    })
    it('other Intents are not checked', async () => {
        const { consolePage, nc } = setup()
        await expect(assertOnConsole('open_collab_doc', consolePage, nc, 'http://idea01', 50)).resolves.toBeUndefined()
    })
})
