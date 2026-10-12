import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertNotIdea02Target, idea02InHostMap, isIdea02Target, storeCheckVerdict, type StoreCheckDoc } from '../duration/walkHost.js'

describe('idea02 target guard', () => {
    it('refuses idea02 by hostname, LAN IP, Tailscale IP and listed store engine id', () => {
        for (const n of ['idea02', 'IDEA02', 'idea02.local', '10.99.0.12', '100.85.108.118']) expect(isIdea02Target(n, {}), n).toBe(true)
        expect(isIdea02Target('eng-xyz', { DURATION_IDEA02_ENGINE_IDS: 'abc, eng-xyz' })).toBe(true)
        for (const n of ['idea01', 'idea03', 'idea04', '10.99.0.11', '10.99.0.120', 'idea020', '', null]) expect(isIdea02Target(n, {}), String(n)).toBe(false)
        expect(() => assertNotIdea02Target('10.99.0.12', 'dock', {})).toThrow(/walk host, never a walk target/)
        expect(idea02InHostMap({ idea01: '10.99.0.11', idea03: '10.99.0.12' }, {})).toEqual(['idea03=10.99.0.12'])
    })
})

const ok = (): StoreCheckDoc => ({
    engineDB: { e1: { hostname: 'idea01', commands: [] }, e3: { hostname: 'idea03', commands: [] }, e4: { hostname: 'idea04', commands: [] } },
    diskDB: { k: { dockedTo: 'e1' }, n: { dockedTo: 'e3' }, w: { dockedTo: 'e3' } },
    instanceDB: {
        a: { id: 'kolibri-grade5a-001', storedOn: 'k' }, b: { id: 'nextcloud-grade5a-001', storedOn: 'n' }, c: { id: 'kiwix-ideaa-001', storedOn: 'w' },
    },
})
describe('store=3 / queues=0 / idea02 absent preflight', () => {
    it('READY state passes', () => expect(storeCheckVerdict('idea01', ok(), {})).toEqual([]))
    it('the r75 stale kolibri-2 record fails the count', () => {
        const d = ok(); d.instanceDB!.x = { id: '78q6hc9nf0qr6h08pyx', storedOn: 'gone' }
        expect(storeCheckVerdict('idea01', d, {}).join('\n')).toMatch(/instance count 4/)
    })
    it('a pending command, a missing engine, a wrong home, idea02 in the list all fail', () => {
        const d = ok(); d.engineDB!.e4!.commands = [{}]; expect(storeCheckVerdict('v', d, {})).toEqual(['v: idea04 queue=1'])
        const m = ok(); delete m.engineDB!.e4; expect(storeCheckVerdict('v', m, {})).toEqual(['v: no engine idea04'])
        const w = ok(); w.diskDB!.k!.dockedTo = 'e4'; expect(storeCheckVerdict('v', w, {})).toEqual(['v: missing kolibri-grade5a-001@idea01'])
        const i = ok(); i.engineDB!.e2 = { hostname: 'idea02', commands: [] }; expect(storeCheckVerdict('v', i, {})).toEqual(['v: idea02 IN engine list (e2)'])
    })
})

describe('idea02 launcher contract (script/idea02-walker/launch.sh)', () => {
    const sh = readFileSync('script/idea02-walker/launch.sh', 'utf8')
    it('refuses off idea02, dirty or unpushed trees, and a running run', () => {
        expect(sh).toMatch(/hostname\)" = idea02/)
        expect(sh).toMatch(/REFUSE: dirty harness tree/)
        expect(sh).toMatch(/not pushed/)
        expect(sh).toMatch(/already running/)
    })
    it('detaches with an ABSOLUTE run.sh path, then verifies the pid and step 1', () => {
        expect(sh).toMatch(/setsid nohup "\$EVID\/run\.sh"/)
        expect(sh).toMatch(/^EVID=\/home\/walker\//m)
        expect(sh).toMatch(/kill -0 "\$PID"/)
        expect(sh).toMatch(/step-0001/)
    })
    it('looks for step 1 in walk/ (record-walk dir), not anywhere in the run dir', () => {
        expect(sh).toContain('"$EVID/walk/step-0001-*"')
        expect(sh).not.toMatch(/find "\$EVID" -name '\*step-0001\*'/)
    })
    it('pins the console intents checkout and passes the idea04 doc wait', () => {
        expect(sh).toMatch(/REFUSE: console intents checkout is not/)
        expect(sh).toContain('DURATION_DOC_WAIT_MS_IDEA04')
    })
    it('runs the store-check gate before launching and keeps the declared pins + deviation', () => {
        expect(sh).toMatch(/store-check\.ts/)
        for (const v of ['DURATION_STAGE=2', '1f97528849e49a4cd75d2e26478618dc90a67be0', 'index-Bnq0hP4N.js', 'e4d525ad92d28b95555b0e4ac542287d', 'b540743daf6b90de162391cc937e942691141dd4', 'DURATION_DOC_WAIT_MS', '--start-instances', '--console-url http://idea01:8080']) expect(sh).toContain(v)
    })
})
