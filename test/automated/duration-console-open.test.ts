/**
 * r57 (r56 FAIL@34): the Console's Open for kiwix-ideaa-001 opened `http://idea03.local:18480`; the box
 * resolves `.local` to a sink (198.18.0.1) and Chromium opened no tab. NC/Kolibri "passed" only through
 * the intents' Path B (goto the pinned store URL), which hid the same dead Open.
 * Fix: the browser maps `<engine>.local` → the --hosts address, and an open_<app>_as_* step must show a
 * tab that came from the Console Open (`<engine>.local:<port>`); a Path B tab alone fails.
 */
import { describe, expect, it } from 'vitest'
import { consoleOpenProblem, type AppPin } from '../duration/appUrls.js'
import { hostResolverRulesFor } from '../duration/ui/playwrightDriver.js'

const pin = (app: AppPin['app'], instanceId: string, engine: string, port: number, url: string): AppPin =>
    ({ app, instanceId, engine, port, url, hosts: [engine, `${engine}.local`, '10.0.0.3'] })
const KX = pin('kiwix', 'kiwix-ideaa-001', 'idea03', 18480, 'http://idea03:18480')
const NC = pin('nextcloud', 'nextcloud-grade5a-001', 'idea03', 61820, 'http://idea03:61820')
const KO = pin('kolibri', 'kolibri-grade5a-001', 'idea01', 18080, 'http://10.0.0.1:18080')
const consoleTab = { url: 'http://idea01:8080/', active: false, fresh: false, console: true }

describe('r57: Console Open must produce the App tab (no Path B masking)', () => {
    it('r56 step 34 replay: no new tab at all → fails', () => {
        expect(consoleOpenProblem('open_wikipedia_as_learner', [consoleTab], [KX])).toMatch(/did not produce a tab on http:\/\/idea03\.local:18480.*no new tab/)
    })
    it('r56 steps 21/27 replay: only a Path B tab on the store URL → fails', () => {
        const tabs = [consoleTab, { url: 'http://idea03:61820/login', active: true, fresh: true }]
        expect(consoleOpenProblem('open_nextcloud_as_teacher', tabs, [NC])).toMatch(/Path B tab on the store URL does not count/)
        const k = [consoleTab, { url: 'http://10.0.0.1:18080/en/learn', active: true, fresh: true }]
        expect(consoleOpenProblem('open_kolibri_as_learner', k, [KO])).toMatch(/idea01\.local:18080/)
    })
    it('a tab from the Console Open (<engine>.local:<port>) passes, incl. after in-origin redirects', () => {
        expect(consoleOpenProblem('open_wikipedia_as_teacher', [consoleTab, { url: 'http://idea03.local:18480/viewer#duration_wikipedia_en_grade5a_stub_2026-10/Main_Page', active: true, fresh: true }], [KX])).toBeNull()
        expect(consoleOpenProblem('open_nextcloud_as_learner', [consoleTab, { url: 'http://idea03.local:61820/login', active: true, fresh: true }], [NC])).toBeNull()
        expect(consoleOpenProblem('open_kolibri_as_teacher', [consoleTab, { url: 'http://idea01.local:18080/en/facility/', active: true, fresh: true }], [KO])).toBeNull()
    })
    it('the Console host engine keeps its page hostname (Kolibri on idea01 → idea01:18080), but an IP tab is Path B', () => {
        const ko = pin('kolibri', 'kolibri-grade5a-001', 'idea01', 18080, 'http://100.99.231.94:18080')
        expect(consoleOpenProblem('open_kolibri_as_teacher', [consoleTab, { url: 'http://idea01:18080/en/auth/', active: true, fresh: true }], [ko])).toBeNull()
        expect(consoleOpenProblem('open_kolibri_as_teacher', [consoleTab, { url: 'http://100.99.231.94:18080/en/auth/', active: true, fresh: true }], [ko])).not.toBeNull()
        // a remote engine never gets the bare name from the Console Open: bare idea03 = Path B
        expect(consoleOpenProblem('open_wikipedia_as_learner', [consoleTab, { url: 'http://idea03:18480/', active: true, fresh: true }], [KX])).not.toBeNull()
    })
    it('Open tab on the wrong port (another instance) fails', () => {
        expect(consoleOpenProblem('open_wikipedia_as_learner', [{ url: 'http://idea03.local:61820/', active: true, fresh: true }], [KX])).not.toBeNull()
    })
    it('reusing an earlier Console-Open tab (no new tab) passes; reusing a Path B tab does not', () => {
        expect(consoleOpenProblem('open_nextcloud_as_teacher', [consoleTab, { url: 'http://idea03.local:61820/apps/files', active: true, fresh: false }], [NC])).toBeNull()
        expect(consoleOpenProblem('open_nextcloud_as_teacher', [consoleTab, { url: 'http://idea03:61820/apps/files', active: true, fresh: false }], [NC])).not.toBeNull()
    })
    it('non-open steps are not affected', () => {
        expect(consoleOpenProblem('search_browse_wikipedia', [consoleTab], [KX])).toBeNull()
        expect(consoleOpenProblem('share_to_class', [consoleTab], [NC])).toBeNull()
    })
})

describe('r57: browser resolves <engine>.local via --hosts', () => {
    it('maps each pool engine .local name to its --hosts address', () => {
        expect(hostResolverRulesFor({ idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }))
            .toBe('MAP idea01.local 100.99.231.94, MAP idea03.local 100.126.117.80, MAP idea04.local 100.108.39.45')
    })
    it('no hosts → no rules; junk entries are skipped', () => {
        expect(hostResolverRulesFor(undefined)).toBeNull()
        expect(hostResolverRulesFor({ 'idea01': 'not an ip', 'bad name': '1.2.3.4' })).toBeNull()
    })
})
