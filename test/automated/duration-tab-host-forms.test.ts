/**
 * r58 (r57 FAIL@35): the harness hands the Console intents every host form of an App's engine
 * (DURATION_<APP>_HOSTS = bare, .local, --hosts IP, LAN IP) so they match the Console-Open tab
 * (`idea03.local:18480`, or the LAN IP after Console #139) by port + host form, not exact origin.
 * The Open-proof stays strict: a fallback tab (bare remote name / Tailscale IP) still fails.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { appHostForms, appTabProblems, consoleOpenProblem, lanHostsFromEnv, lanHostsFromStore, type AppPin } from '../duration/appUrls.js'
import { stage2LanHosts, stage2PinFor } from '../duration/actions.js'

const HOSTS = { idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }
const LAN = 'idea01=10.99.0.11,idea03=10.99.0.13,idea04=10.99.0.14'
const consoleTab = { url: 'http://idea01:8080/', active: false, fresh: false, console: true }
afterEach(() => { delete process.env.DURATION_LAN_HOSTS })

describe('r58: DURATION_<APP>_HOSTS for the Console intents', () => {
    it('parses DURATION_LAN_HOSTS; junk ignored', () => {
        expect(lanHostsFromEnv({ DURATION_LAN_HOSTS: LAN })).toEqual({ idea01: '10.99.0.11', idea03: '10.99.0.13', idea04: '10.99.0.14' })
        expect(lanHostsFromEnv({ DURATION_LAN_HOSTS: 'x, idea01 = nope' })).toEqual({})
    })
    it('Kiwix pin on idea03 → bare, .local, Tailscale and LAN host forms (r57 step 35 tab idea03.local:18480 is covered)', () => {
        const pin = stage2PinFor('kiwix', 'kiwix-ideaa-001', 'idea03', 18480, HOSTS, 'Running')
        expect(pin.url).toBe('http://idea03:18480')
        expect(appHostForms(pin, lanHostsFromEnv({ DURATION_LAN_HOSTS: LAN })).split(',')).toEqual(['idea03', 'idea03.local', '100.126.117.80', '10.99.0.13'])
    })
    it('moved Kolibri on idea04 (after step 62) and a copy keep their own engine forms', () => {
        const lan = lanHostsFromEnv({ DURATION_LAN_HOSTS: LAN })
        expect(appHostForms(stage2PinFor('kolibri', 'kolibri-grade5a-001', 'idea04', 18080, HOSTS), lan)).toBe('idea04,idea04.local,100.108.39.45,10.99.0.14')
        expect(appHostForms(stage2PinFor('kolibri', 'copy-x', 'idea03', 58312, HOSTS), lan)).toContain('10.99.0.13')
    })
    it('Engine #166: store engineDB[].lanAddress is used (over DURATION_LAN_HOSTS); non-IPv4 ignored', async () => {
        expect(lanHostsFromStore({ idea03: { lanAddress: '10.99.0.23' }, idea04: { lanAddress: null }, idea01: { lanAddress: 'idea01.local' } }, { idea03: '10.99.0.13', idea04: '10.99.0.14' }))
            .toEqual({ idea03: '10.99.0.23', idea04: '10.99.0.14' })
        const ctx = {
            poolEngines: ['idea01', 'idea03'], excludeEngines: ['idea02'],
            opts: { ops: { readStore: async () => ({ engineDB: { idea03: { id: 'idea03', lanAddress: '10.99.0.13' } } }) } },
        }
        expect(await stage2LanHosts(ctx as never, {})).toEqual({ idea03: '10.99.0.13' })
    })
})

describe('r58: Open-proof accepts the Console #139 LAN-IP tab and stays strict', () => {
    const lan = lanHostsFromEnv({ DURATION_LAN_HOSTS: LAN })
    const kx: AppPin = { app: 'kiwix', instanceId: 'kiwix-ideaa-001', engine: 'idea03', port: 18480, url: 'http://idea03:18480', hosts: ['idea03', 'idea03.local', '100.126.117.80', '10.99.0.13'] }
    it('LAN IP tab (Open via engine.lanAddress) → Console Open, and on a store URL', () => {
        const tabs = [consoleTab, { url: 'http://10.99.0.13:18480/', active: true, fresh: true }]
        expect(consoleOpenProblem('open_wikipedia_as_learner', tabs, [kx], lan)).toBeNull()
        expect(appTabProblems(tabs, [kx], ['idea01', 'idea01.local', '100.99.231.94'])).toEqual([])
    })
    it('fallback tabs still fail: bare remote name, Tailscale IP, or another engine\'s LAN IP', () => {
        for (const url of ['http://idea03:18480/', 'http://100.126.117.80:18480/', 'http://10.99.0.14:18480/']) {
            expect(consoleOpenProblem('open_wikipedia_as_learner', [consoleTab, { url, active: true, fresh: true }], [kx], lan), url).not.toBeNull()
        }
    })
})
