/**
 * idea-local-publisher.test.ts — idea#203 §3: every Engine competes for idea.local,
 * one holder, the others retry every 2-5 s and take over when the holder leaves.
 *
 * A FakeLan stands in for avahi + the network: a committed group goes REGISTERING,
 * then on the next state read ESTABLISHED if no other group holds the name, else
 * COLLISION (what avahi does on the pool, tested 2026-10-15).
 */
import { describe, it, expect } from 'vitest'
import {
    isEntryGroupGone, IdeaLocalPublisher, AvahiClient, AvahiEntryGroup, EntryGroupState, lanAddresses,
    isLanInterfaceName, AVAHI_PUBLISH_NO_REVERSE, AVAHI_PROTO_INET, LanAddress, MdnsResponder,
    foreignHolders, conflictWinner, encodeMdnsQuery, parseMdnsAnswers, queryIdeaLocalResponders,
} from '../../src/monitors/ideaLocal.js'

class FakeLan {
    groups = new Set<FakeGroup>()
    /** hosts cut off the LAN (netcut): they and the rest cannot see each other's mDNS. */
    cut = new Set<FakeHost>()
    sees(a: FakeHost, b: FakeHost) { return a === b || (!this.cut.has(a) && !this.cut.has(b)) }
    holder(name: string, from?: FakeHost) {
        return [...this.groups].find(g => g.name === name && g.state === EntryGroupState.ESTABLISHED && !g.host.frozen && (!from || this.sees(from, g.host)))
    }
    holders(name: string) { return [...this.groups].filter(g => g.name === name && g.state === EntryGroupState.ESTABLISHED) }
    /** A raw mDNS query from `from`: every visible host with an established record answers (avahi never re-probes). */
    probe(from: FakeHost): MdnsResponder[] {
        return [...this.groups].filter(g => g.state === EntryGroupState.ESTABLISHED && !g.host.frozen && this.sees(from, g.host))
            .map(g => ({ from: g.records[0].address, addresses: g.records.map(r => r.address) }))
    }
}
class FakeGroup implements AvahiEntryGroup {
    state = EntryGroupState.UNCOMMITED
    name = ''
    records: { ifIndex: number, proto: number, flags: number, address: string }[] = []
    freed = false
    /** avahi-daemon restarted: the object path is gone, libdbus answers UnknownMethod. */
    gone = false
    constructor(public lan: FakeLan, public host: FakeHost) { lan.groups.add(this) }
    async addAddress(ifIndex: number, proto: number, flags: number, name: string, address: string) {
        if (this.host.frozen) return this.host.hang()
        if (this.host.down) throw new Error('org.freedesktop.DBus.Error.ServiceUnknown')
        if (!(flags & AVAHI_PUBLISH_NO_REVERSE)) throw new Error('org.freedesktop.Avahi.CollisionError: Local name collision')
        this.name = name; this.records.push({ ifIndex, proto, flags, address })
    }
    async commit() { if (this.host.frozen) return this.host.hang(); this.state = EntryGroupState.REGISTERING }
    async getState() {
        if (this.gone) { const e: any = new Error('Method "GetState" with signature "" on interface "org.freedesktop.Avahi.EntryGroup" doesn\'t exist'); e.type = 'org.freedesktop.DBus.Error.UnknownMethod'; throw e }
        if (this.host.down) throw new Error('org.freedesktop.DBus.Error.ServiceUnknown')
        if (this.host.frozen) return this.host.hang()
        if (this.state === EntryGroupState.REGISTERING) {
            this.state = this.lan.holder(this.name, this.host) ? EntryGroupState.COLLISION : EntryGroupState.ESTABLISHED
        }
        return this.state
    }
    async free() { if (this.host.frozen) { this.host.queuedFree.add(this); return this.host.hang() } if (this.gone) throw new Error('UnknownMethod'); this.freed = true; this.lan.groups.delete(this) }
}
class FakeHost {
    down = false
    connects = 0
    constructor(public lan: FakeLan) {}
    /** avahi-daemon SIGSTOPped: D-Bus calls never answer, it neither answers nor defends on the wire. */
    frozen = false
    queuedFree = new Set<FakeGroup>()
    queuedDisconnect = false
    hang(): Promise<never> { return new Promise<never>(() => {}) }
    connect = async (): Promise<AvahiClient> => {
        if (this.down) throw new Error('avahi not running')
        if (this.frozen) return this.hang()
        this.connects++
        return {
            entryGroupNew: async () => { if (this.down) throw new Error('gone'); if (this.frozen) return this.hang(); return new FakeGroup(this.lan, this) },
            // avahi frees every group of a client whose D-Bus connection closed (queued while frozen)
            close: () => { if (this.frozen) this.queuedDisconnect = true; else for (const g of [...this.lan.groups]) if (g.host === this) this.lan.groups.delete(g) },
        }
    }
    freeze() { this.frozen = true }
    /** SIGCONT: avahi handles the queued Free / client disconnect (goodbye); records not freed come back as they were. */
    thaw() {
        this.frozen = false
        for (const g of this.queuedFree) { g.freed = true; this.lan.groups.delete(g) }
        this.queuedFree.clear()
        if (this.queuedDisconnect) for (const g of [...this.lan.groups]) if (g.host === this) this.lan.groups.delete(g)
        this.queuedDisconnect = false
    }
    /** avahi-daemon restart (e.g. after an avahi-daemon.conf change): all its groups vanish, the bus stays. */
    avahiRestart() { for (const g of [...this.lan.groups]) if (g.host === this) { g.gone = true; this.lan.groups.delete(g) } }
    /** Power cut: the host vanishes without a goodbye; its records stop answering probes. */
    powerCut() { this.down = true; for (const g of [...this.lan.groups]) if (g.host === this) this.lan.groups.delete(g) }
}

const addr = (address: string, ifName = 'eth0', ifIndex = 2): LanAddress => ({ ifName, ifIndex, address })
let clock = 0
const mk = (host: FakeHost, a: () => LanAddress[], lines: string[] = []) =>
    new IdeaLocalPublisher({
        connect: host.connect, addresses: a, logger: (l) => lines.push(l), nextDelayMs: () => 1,
        probe: async () => host.down ? [] : host.lan.probe(host), now: () => clock,
    })

describe('idea.local publisher: one holder, retry, takeover (idea#203)', () => {
    it('publishes an IPv4 address record with NO_REVERSE (avahi-publish -a -R) per LAN interface', async () => {
        const lan = new FakeLan(); const h = new FakeHost(lan)
        const p = mk(h, () => [addr('10.42.0.2'), addr('10.42.0.20', 'wlan0', 3)])
        await p.tick(); expect(await p.tick()).toBe('holder')
        const g = [...lan.groups][0]
        expect(g.name).toBe('idea.local')
        expect(g.records).toEqual([
            { ifIndex: 2, proto: AVAHI_PROTO_INET, flags: AVAHI_PUBLISH_NO_REVERSE, address: '10.42.0.2' },
            { ifIndex: 3, proto: AVAHI_PROTO_INET, flags: AVAHI_PUBLISH_NO_REVERSE, address: '10.42.0.20' },
        ])
    })

    it('the first Engine holds the name, the second waits and keeps retrying', async () => {
        const lan = new FakeLan(); const h1 = new FakeHost(lan); const h2 = new FakeHost(lan)
        const p1 = mk(h1, () => [addr('10.42.0.2')]); const p2 = mk(h2, () => [addr('10.42.0.3')])
        await p1.tick(); await p1.tick()
        await p2.tick(); expect(await p2.tick()).toBe('waiting')
        for (let i = 0; i < 5; i++) { await p2.tick(); expect(lan.holder('idea.local')!.host).toBe(h1) }
        expect(p1.status).toBe('holder')
    })

    it('takes over after a clean stop of the holder (goodbye)', async () => {
        const lan = new FakeLan(); const h1 = new FakeHost(lan); const h2 = new FakeHost(lan)
        const p1 = mk(h1, () => [addr('10.42.0.2')]); const p2 = mk(h2, () => [addr('10.42.0.3')])
        await p1.tick(); await p1.tick(); await p2.tick(); await p2.tick()
        await p1.stop()
        await p2.tick(); expect(await p2.tick()).toBe('holder')
        expect(lan.holder('idea.local')!.records[0].address).toBe('10.42.0.3')
    })

    it('takes over after a power cut of the holder (no goodbye)', async () => {
        const lan = new FakeLan(); const h1 = new FakeHost(lan); const h2 = new FakeHost(lan)
        const p1 = mk(h1, () => [addr('10.42.0.2')]); const p2 = mk(h2, () => [addr('10.42.0.3')])
        await p1.tick(); await p1.tick(); await p2.tick(); await p2.tick()
        h1.powerCut()
        await p2.tick(); expect(await p2.tick()).toBe('holder')
    })

    it('re-publishes when the LAN address changes', async () => {
        const lan = new FakeLan(); const h = new FakeHost(lan)
        let a = [addr('10.42.0.2')]
        const p = mk(h, () => a)
        await p.tick(); await p.tick()
        a = [addr('10.42.0.9')]
        await p.tick(); expect(await p.tick()).toBe('holder')
        expect(lan.groups.size).toBe(1)
        expect(lan.holder('idea.local')!.records[0].address).toBe('10.42.0.9')
    })

    it('does not publish without a LAN address, and publishes once one appears', async () => {
        const lan = new FakeLan(); const h = new FakeHost(lan)
        let a: LanAddress[] = []
        const p = mk(h, () => a)
        expect(await p.tick()).toBe('idle'); expect(lan.groups.size).toBe(0)
        a = [addr('10.42.0.2')]
        await p.tick(); expect(await p.tick()).toBe('holder')
    })

    it('reconnects after avahi-daemon restarts, never throws', async () => {
        const lan = new FakeLan(); const h = new FakeHost(lan)
        const p = mk(h, () => [addr('10.42.0.2')])
        await p.tick(); await p.tick()
        h.powerCut() // avahi gone: calls fail
        expect(await p.tick()).toBe('error')
        expect(await p.tick()).toBe('error')
        h.down = false
        await p.tick(); expect(await p.tick()).toBe('holder')
        expect(h.connects).toBe(2)
    })

    it('logs a waiting Engine once, not every retry', async () => {
        const lan = new FakeLan(); const h1 = new FakeHost(lan); const h2 = new FakeHost(lan)
        const lines: string[] = []
        const p1 = mk(h1, () => [addr('10.42.0.2')]); const p2 = mk(h2, () => [addr('10.42.0.3')], lines)
        await p1.tick(); await p1.tick()
        for (let i = 0; i < 10; i++) await p2.tick()
        expect(lines.filter(l => l.includes('held by another Engine')).length).toBe(1)
    })

    it('start() retries on its own timer and stop() withdraws', async () => {
        const lan = new FakeLan(); const h = new FakeHost(lan)
        const p = mk(h, () => [addr('10.42.0.2')]).start()
        for (let i = 0; i < 50 && p.status !== 'holder'; i++) await new Promise(r => setTimeout(r, 5))
        expect(p.status).toBe('holder')
        await p.stop()
        expect(lan.groups.size).toBe(0)
    })

    it('default retry delay is 2-5 s', () => {
        const p: any = new IdeaLocalPublisher({ connect: async () => { throw new Error('x') } })
        for (let i = 0; i < 200; i++) { const d = p.nextDelayMs(); expect(d).toBeGreaterThanOrEqual(2000); expect(d).toBeLessThanOrEqual(5000) }
    })
})

describe('idea.local LAN-only addresses (idea#203)', () => {
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null } as any)
    it('skips lo, docker*, br-*, veth*, tailscale*, IPv6 and link-local', () => {
        const idx: Record<string, number> = { lo: 1, eth0: 2, wlan0: 3, docker0: 4, 'br-1a2b3c': 5, veth9f: 6, tailscale0: 7 }
        const got = lanAddresses({
            lo: [v4('127.0.0.1', true)],
            eth0: [v4('10.42.0.2'), { ...v4('fe80::1'), family: 'IPv6' }],
            wlan0: [v4('169.254.3.4')],
            docker0: [v4('172.17.0.1')],
            'br-1a2b3c': [v4('172.21.0.1')],
            veth9f: [v4('172.21.0.5')],
            tailscale0: [v4('100.64.0.3')],
        }, (n) => idx[n])
        expect(got).toEqual([{ ifName: 'eth0', ifIndex: 2, address: '10.42.0.2' }])
    })
    it('isLanInterfaceName', () => {
        for (const n of ['eth0', 'wlan0', 'end0', 'enp1s0']) expect(isLanInterfaceName(n)).toBe(true)
        for (const n of ['lo', 'docker0', 'br-abc', 'veth123', 'tailscale0', 'virbr0']) expect(isLanInterfaceName(n)).toBe(false)
    })

    describe('avahi-daemon restart (pool 2026-10-15: GetState UnknownMethod)', () => {
        it('classifies a vanished entry group, not other errors', () => {
            const e: any = new Error('Method "GetState" with signature "" on interface "org.freedesktop.Avahi.EntryGroup" doesn\'t exist')
            expect(isEntryGroupGone(e)).toBe(true)
            expect(isEntryGroupGone({ type: 'org.freedesktop.DBus.Error.UnknownObject', text: 'x' })).toBe(true)
            expect(isEntryGroupGone(new Error('org.freedesktop.DBus.Error.ServiceUnknown'))).toBe(false)
            expect(isEntryGroupGone(new Error('Connection closed'))).toBe(false)
        })

        it('the holder re-publishes in the same tick: no error line, no reconnect, still holder', async () => {
            const lan = new FakeLan(); const h = new FakeHost(lan); const lines: string[] = []
            const p = mk(h, () => [addr('10.99.0.13')], lines)
            await p.tick(); expect(await p.tick()).toBe('holder')
            h.avahiRestart()
            expect(await p.tick()).toBe('registering')
            expect(await p.tick()).toBe('holder')
            expect(h.connects).toBe(1)
            expect(lines.some(l => /D-Bus error/.test(l))).toBe(false)
            expect(lines.some(l => /daemon restarted/.test(l))).toBe(true)
            expect(lan.groups.size).toBe(1)
        })

        it('a waiting Engine whose avahi restarts keeps waiting; one holder throughout', async () => {
            const lan = new FakeLan(); const h1 = new FakeHost(lan); const h2 = new FakeHost(lan)
            const p1 = mk(h1, () => [addr('10.99.0.13')]); const p2 = mk(h2, () => [addr('10.99.0.14')])
            await p1.tick(); await p1.tick(); await p2.tick(); await p2.tick()
            h2.avahiRestart()
            for (let i = 0; i < 4; i++) { await p2.tick(); await p1.tick() }
            expect(p1.status).toBe('holder'); expect(p2.status).toBe('waiting')
            expect(lan.holder('idea.local')!.host).toBe(h1)
        })

        it('takeover after a holder power cut still works when the waiter just had an avahi restart', async () => {
            const lan = new FakeLan(); const h1 = new FakeHost(lan); const h2 = new FakeHost(lan)
            const p1 = mk(h1, () => [addr('10.99.0.13')]); const p2 = mk(h2, () => [addr('10.99.0.14')])
            await p1.tick(); await p1.tick(); await p2.tick(); await p2.tick()
            h2.avahiRestart(); h1.powerCut()
            // the waiter first lets a previous holder re-claim (reclaim grace), then takes over
            for (let i = 0; i < 6 && p2.status !== 'holder'; i++) { await p2.tick(); clock += 3000 }
            expect(p2.status).toBe('holder')
            expect(lan.holder('idea.local')!.host).toBe(h2)
        })
    })
})

describe('idea.local second holder after a partition heals (idea#203 takeover run 2026-10-15)', () => {
    /** One "round" = every publisher ticks once and 3 s pass (ticks are every 2-5 s). */
    const round = async (...ps: IdeaLocalPublisher[]) => { for (const p of ps) await p.tick(); clock += 3000 }
    const setup = () => {
        clock = 0
        const lan = new FakeLan(); const h3 = new FakeHost(lan); const h4 = new FakeHost(lan)
        const l3: string[] = []; const l4: string[] = []
        const p3 = mk(h3, () => [addr('10.99.0.13')], l3); const p4 = mk(h4, () => [addr('10.99.0.14')], l4)
        return { lan, h3, h4, p3, p4, l3, l4 }
    }
    /** idea03 holds, gets cut off, idea04 takes over, the cut is lifted: two established holders. */
    const splitBrain = async () => {
        const s = setup()
        await round(s.p3, s.p4); await round(s.p3, s.p4)
        expect(s.p3.status).toBe('holder'); expect(s.p4.status).toBe('waiting')
        s.lan.cut.add(s.h3)
        for (let i = 0; i < 3; i++) await round(s.p3, s.p4)
        expect(s.p4.status).toBe('holder'); expect(s.p3.status).toBe('holder')
        s.lan.cut.delete(s.h3)
        expect(s.lan.holders('idea.local').length).toBe(2)
        return s
    }

    it('reproduces the pool failure without the check: both stay holders forever', async () => {
        const s = setup()
        const n3 = new IdeaLocalPublisher({ connect: s.h3.connect, addresses: () => [addr('10.99.0.13')], logger: () => {}, probe: undefined })
        const n4 = new IdeaLocalPublisher({ connect: s.h4.connect, addresses: () => [addr('10.99.0.14')], logger: () => {}, probe: undefined })
        await n3.tick(); await n3.tick(); await n4.tick(); await n4.tick()
        s.lan.cut.add(s.h3); await n4.tick(); await n4.tick(); s.lan.cut.delete(s.h3)
        for (let i = 0; i < 20; i++) { await n3.tick(); await n4.tick() }
        expect(s.lan.holders('idea.local').length).toBe(2)
    })

    it('after the partition heals exactly one holder remains, the lowest IPv4 (idea03 .13)', async () => {
        const s = await splitBrain()
        let rounds = 0
        while (s.lan.holders('idea.local').length > 1 && rounds < 10) { await round(s.p3, s.p4); rounds++ }
        expect(s.lan.holders('idea.local').map(g => g.records[0].address)).toEqual(['10.99.0.13'])
        expect(s.p3.status).toBe('holder'); expect(s.p4.status).toBe('waiting')
        expect(rounds).toBe(2) // 2 confirmations = 2 probes, ~4-10 s with 2-5 s ticks
        expect(s.l4.some(l => /second holder of idea.local: 10.99.0.13.*withdrawing/.test(l))).toBe(true)
        expect(s.l3.some(l => /10.99.0.14 also answers: we keep it/.test(l))).toBe(true)
    })

    it('is symmetric: when the lower IP took over during the cut, it keeps it', async () => {
        clock = 0
        const lan = new FakeLan(); const hA = new FakeHost(lan); const hB = new FakeHost(lan)
        const pA = mk(hA, () => [addr('10.99.0.14')]); const pB = mk(hB, () => [addr('10.99.0.13')])
        await round(pA, pB); await round(pA, pB)
        expect(pA.status).toBe('holder')
        lan.cut.add(hA); for (let i = 0; i < 3; i++) await round(pA, pB); lan.cut.delete(hA)
        for (let i = 0; i < 4; i++) await round(pA, pB)
        expect(lan.holders('idea.local').map(g => g.records[0].address)).toEqual(['10.99.0.13'])
        expect(pA.status).toBe('waiting'); expect(pB.status).toBe('holder')
    })

    it('does not flap: the loser stays withdrawn and only one holder exists for a long time after', async () => {
        const s = await splitBrain()
        const holderCounts: number[] = []
        for (let i = 0; i < 60; i++) { await round(s.p3, s.p4); holderCounts.push(s.lan.holders('idea.local').length) }
        expect(holderCounts.slice(2).every(n => n === 1)).toBe(true)
        expect(s.lan.holder('idea.local')!.host).toBe(s.h3)
        expect(s.l4.filter(l => /withdrawing/.test(l)).length).toBe(1)
        expect(s.l3.filter(l => /we keep it/.test(l)).length).toBe(1)
    })

    it('a single conflicting probe (e.g. a stale answer) does not make the holder withdraw', async () => {
        clock = 0
        const lan = new FakeLan(); const h = new FakeHost(lan)
        let answers: MdnsResponder[] = [{ from: '10.99.0.11', addresses: ['10.99.0.11'] }]
        const p = new IdeaLocalPublisher({ connect: h.connect, addresses: () => [addr('10.99.0.14')], logger: () => {}, probe: async () => answers, now: () => clock })
        await p.tick(); expect(await p.tick()).toBe('holder') // 1st conflict seen
        answers = [{ from: '10.99.0.14', addresses: ['10.99.0.14'] }]
        expect(await p.tick()).toBe('holder') // gone: counter reset
        answers = [{ from: '10.99.0.11', addresses: ['10.99.0.11'] }]
        expect(await p.tick()).toBe('holder')
        expect(await p.tick()).toBe('waiting') // 2 in a row
        expect(lan.groups.size).toBe(0)
    })

    it('after withdrawing it waits the hold-off, then takes over if the winner has gone', async () => {
        const s = await splitBrain()
        await round(s.p3, s.p4); await round(s.p3, s.p4)
        expect(s.p4.status).toBe('waiting')
        await s.p3.stop()
        await s.p4.tick(); expect(s.lan.groups.size).toBe(0) // still in the 15 s hold-off
        clock += 15000
        await s.p4.tick(); expect(await s.p4.tick()).toBe('holder')
    })

    it('a probe that throws is logged and never drops the name', async () => {
        clock = 0
        const lan = new FakeLan(); const h = new FakeHost(lan); const lines: string[] = []
        const p = new IdeaLocalPublisher({ connect: h.connect, addresses: () => [addr('10.99.0.14')], logger: l => lines.push(l), probe: async () => { throw new Error('EADDRNOTAVAIL') }, now: () => clock })
        await p.tick(); for (let i = 0; i < 4; i++) expect(await p.tick()).toBe('holder')
        expect(lines.some(l => /probe failed: EADDRNOTAVAIL/.test(l))).toBe(true)
    })

    it('rule helpers: own addresses are ignored, lowest IPv4 wins numerically', () => {
        expect(foreignHolders([{ from: '10.99.0.14', addresses: ['10.99.0.14'] }, { from: '10.99.0.13', addresses: ['10.99.0.13'] }], ['10.99.0.14'])).toEqual(['10.99.0.13'])
        expect(conflictWinner(['10.99.0.9'], ['10.99.0.13'])).toBe('us') // numeric, not string compare
        expect(conflictWinner(['10.99.0.14'], ['10.99.0.13'])).toBe('them')
        expect(conflictWinner(['10.99.0.14'], [])).toBe('us')
    })
})

describe('raw mDNS query encoding (idea#203)', () => {
    it('encodes an A/IN query with the QU bit', () => {
        const q = encodeMdnsQuery('idea.local', 0x1234)
        expect([...q]).toEqual([0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, ...Buffer.from('idea'), 5, ...Buffer.from('local'), 0, 0, 1, 0x80, 1])
    })
    it('parses A answers with name compression, ignores goodbyes (TTL 0) and other names', () => {
        const hdr = Buffer.from([0x12, 0x34, 0x84, 0, 0, 1, 0, 3, 0, 0, 0, 0])
        const qn = Buffer.from([4, ...Buffer.from('idea'), 5, ...Buffer.from('local'), 0, 0, 1, 0, 1])
        const rr = (ttl: number, ip: number[], name = [0xc0, 12]) => Buffer.from([...name, 0, 1, 0x80, 1, ttl >> 24 & 255, ttl >> 16 & 255, ttl >> 8 & 255, ttl & 255, 0, 4, ...ip])
        const other = [5, ...Buffer.from('other'), 0xc0, 17]
        const msg = Buffer.concat([hdr, qn, rr(120, [10, 99, 0, 13]), rr(0, [10, 99, 0, 14]), rr(120, [10, 99, 0, 15], other)])
        expect(parseMdnsAnswers(msg, 'idea.local')).toEqual(['10.99.0.13'])
        expect(parseMdnsAnswers(Buffer.from([0, 0, 0, 0]), 'idea.local')).toEqual([])
        expect(parseMdnsAnswers(msg.subarray(0, 40), 'idea.local')).toEqual([])
    })
})

describe('idea.local simultaneous avahi-daemon restart (pool cron `0 * * * * systemctl restart avahi-daemon`, 17:00:01)', () => {
    const setup = (grace?: () => number) => {
        clock = 0
        const lan = new FakeLan(); const h3 = new FakeHost(lan); const h4 = new FakeHost(lan)
        const l3: string[] = []; const l4: string[] = []
        const opts = (h: FakeHost, ip: string, lines: string[]) => new IdeaLocalPublisher({
            connect: h.connect, addresses: () => [addr(ip)], logger: l => lines.push(l), nextDelayMs: () => 1,
            probe: async () => h.lan.probe(h), now: () => clock, ...(grace ? { reclaimGraceMs: grace } : {}),
        })
        return { lan, h3, h4, l3, l4, p3: opts(h3, '10.99.0.13', l3), p4: opts(h4, '10.99.0.14', l4) }
    }
    /** both daemons restart at the same second; the waiter's tick happens to come first (what happened on the pool) */
    const restartBoth = async (s: ReturnType<typeof setup>, first: IdeaLocalPublisher, second: IdeaLocalPublisher) => {
        s.h3.avahiRestart(); s.h4.avahiRestart()
        await first.tick(); clock += 1000; await second.tick()
        for (let i = 0; i < 20; i++) { await first.tick(); await second.tick(); clock += 3000 }
    }

    it('reproduces 17:00:01 without the reclaim grace: the waiter (idea04) ticks first and takes the name', async () => {
        const s = setup(() => 0)
        await s.p3.tick(); await s.p3.tick(); await s.p4.tick(); await s.p4.tick()
        expect(s.p3.status).toBe('holder'); expect(s.p4.status).toBe('waiting')
        await restartBoth(s, s.p4, s.p3)
        expect(s.lan.holders('idea.local').map(g => g.host)).toEqual([s.h4])
        expect(s.p3.status).toBe('waiting')
    })

    it('with the grace the previous holder keeps the name even when the waiter ticks first', async () => {
        const s = setup()
        await s.p3.tick(); await s.p3.tick(); await s.p4.tick(); await s.p4.tick()
        await restartBoth(s, s.p4, s.p3)
        expect(s.lan.holders('idea.local').map(g => g.host)).toEqual([s.h3])
        expect(s.p3.status).toBe('holder'); expect(s.p4.status).toBe('waiting')
        expect(s.l4.some(l => /letting the previous holder re-claim/.test(l))).toBe(true)
    })

    it('a single holder with the higher IP (idea04) keeps it: no step-down, no flap, over many hourly restarts', async () => {
        const s = setup()
        await s.p4.tick(); await s.p4.tick(); await s.p3.tick(); await s.p3.tick()
        expect(s.p4.status).toBe('holder'); expect(s.p3.status).toBe('waiting')
        const holderLog: string[] = []
        for (let hour = 0; hour < 5; hour++) {
            await restartBoth(s, hour % 2 ? s.p3 : s.p4, hour % 2 ? s.p4 : s.p3)
            for (let i = 0; i < 10; i++) {
                await s.p3.tick(); await s.p4.tick(); clock += 3000
                const hs = s.lan.holders('idea.local')
                expect(hs.length).toBeLessThanOrEqual(1)
                holderLog.push(hs.map(g => g.records[0].address).join())
            }
        }
        expect(new Set(holderLog)).toEqual(new Set(['10.99.0.14']))
        expect(s.l4.some(l => /withdrawing/.test(l))).toBe(false)
    })

    it('when neither held the name, one of them gets it after the grace', async () => {
        const s = setup()
        await s.p3.tick(); await s.p4.tick() // both registering, nobody established yet
        s.h3.avahiRestart(); s.h4.avahiRestart()
        for (let i = 0; i < 10; i++) { await s.p3.tick(); await s.p4.tick(); clock += 3000 }
        expect(s.lan.holders('idea.local').length).toBe(1)
    })
})

describe('idea.local second-holder check send errors (pool idea03: send EPERM 224.0.0.251:5353)', () => {
    const holder = (probe: () => Promise<any>, lines: string[]) => {
        clock = 0
        const lan = new FakeLan(); const h = new FakeHost(lan)
        return new IdeaLocalPublisher({ connect: h.connect, addresses: () => [addr('10.99.0.13')], logger: l => lines.push(l), nextDelayMs: () => 1, probe, now: () => clock })
    }

    it('logs a send error once per change, names the interface, never withdraws', async () => {
        const lines: string[] = []
        let errors = ['send on eth0 10.99.0.13: EPERM']
        const p = holder(async () => ({ responders: [], errors }), lines)
        await p.tick()
        for (let i = 0; i < 20; i++) expect(await p.tick()).toBe('holder')
        expect(lines.filter(l => /EPERM/.test(l)).length).toBe(1)
        expect(lines.find(l => /EPERM/.test(l))).toMatch(/eth0 10\.99\.0\.13/)
        errors = []
        for (let i = 0; i < 5; i++) await p.tick()
        expect(lines.filter(l => /working again/.test(l)).length).toBe(1)
        errors = ['send on eth0 10.99.0.13: ENETUNREACH']
        await p.tick(); await p.tick()
        expect(lines.filter(l => /ENETUNREACH/.test(l)).length).toBe(1)
        expect(p.status).toBe('holder')
    })

    it('a check that throws on every tick is logged once and never drops the name', async () => {
        const lines: string[] = []
        const seq: any[] = [new Error('EPERM'), new Error('EPERM'), new Error('EPERM')]
        const p = holder(async () => { const x = seq.shift(); if (x) throw x; return [] }, lines)
        await p.tick()
        for (let i = 0; i < 6; i++) expect(await p.tick()).toBe('holder')
        expect(lines.filter(l => /probe failed: EPERM/.test(l)).length).toBe(1)
    })

    it('the real query skips non-LAN interfaces and returns (never throws) bind/send errors per interface', async () => {
        const r = await queryIdeaLocalResponders('idea.local', [
            { ifName: 'br-a12736f0adec', ifIndex: 9, address: '172.30.0.1' },
            { ifName: 'docker0', ifIndex: 4, address: '172.17.0.1' },
            { ifName: 'tailscale0', ifIndex: 5, address: '100.126.117.80' },
            { ifName: 'eth0', ifIndex: 2, address: '192.0.2.123' }, // not ours: bind fails with EADDRNOTAVAIL
        ], 200)
        expect(r.responders).toEqual([])
        expect(r.errors.length).toBe(1)
        expect(r.errors[0]).toMatch(/eth0 192\.0\.2\.123: EADDRNOTAVAIL/)
    })
})

describe('idea.local holder whose avahi-daemon freezes (pool takeover run3 avahi-freeze 18:17, SIGSTOP/SIGCONT)', () => {
    const round = async (...ps: IdeaLocalPublisher[]) => { for (const p of ps) await p.tick(); clock += 3000 }
    const setup = (dbusTimeoutMs: number) => {
        clock = 0
        const lan = new FakeLan(); const h3 = new FakeHost(lan); const h4 = new FakeHost(lan)
        const l3: string[] = []
        const opts = (h: FakeHost, ip: string, lines: string[] = []) => new IdeaLocalPublisher({
            connect: h.connect, addresses: () => [addr(ip)], logger: (l) => lines.push(l), nextDelayMs: () => 1,
            probe: async () => h.lan.probe(h), now: () => clock, dbusTimeoutMs,
        })
        return { lan, h3, h4, l3, p3: opts(h3, '10.99.0.13', l3), p4: opts(h4, '10.99.0.14') }
    }
    const tickWithin = async (p: IdeaLocalPublisher, ms: number) =>
        Promise.race([p.tick().then(() => 'done'), new Promise(r => setTimeout(() => r('hung'), ms))])

    it('reproduces run3 without a D-Bus timeout: the frozen holder\'s tick hangs, and after SIGCONT its old record is back next to the new holder', async () => {
        const s = setup(0)
        await round(s.p3, s.p4); await round(s.p3, s.p4)
        expect(s.p3.status).toBe('holder')
        s.h3.freeze()
        expect(await tickWithin(s.p3, 50)).toBe('hung')
        for (let i = 0; i < 3; i++) await round(s.p4)
        expect(s.p4.status).toBe('holder')
        s.h3.thaw()
        expect(s.lan.holders('idea.local').map(g => g.records[0].address).sort()).toEqual(['10.99.0.13', '10.99.0.14'])
    })

    it('with the timeout the holder frees its group and closes D-Bus while avahi is frozen: after SIGCONT only the new holder has the name', async () => {
        const s = setup(20)
        await round(s.p3, s.p4); await round(s.p3, s.p4)
        s.h3.freeze()
        expect(await tickWithin(s.p3, 500)).toBe('done')
        expect(s.p3.status).toBe('error')
        expect(s.l3.some(l => /did not answer EntryGroup.GetState within 0.0 s; giving up idea.local: freed our entry group and closed the D-Bus connection/.test(l))).toBe(true)
        expect(s.h3.queuedDisconnect).toBe(true)
        for (let i = 0; i < 3; i++) { await round(s.p4); expect(await tickWithin(s.p3, 500)).toBe('done') }
        expect(s.p4.status).toBe('holder')
        s.h3.thaw()
        expect(s.lan.holders('idea.local').map(g => g.records[0].address)).toEqual(['10.99.0.14'])
        // idea03 reconnects and competes again: idea04 keeps the name, no flap
        for (let i = 0; i < 20; i++) { await round(s.p3, s.p4); expect(s.lan.holders('idea.local').length).toBe(1) }
        expect(s.lan.holder('idea.local')!.host).toBe(s.h4)
        expect(s.p3.status).toBe('waiting')
    })

    it('a connect that only completes after the timeout is closed, not leaked', async () => {
        let closed = 0; let release!: (c: AvahiClient) => void
        const p = new IdeaLocalPublisher({
            connect: () => new Promise<AvahiClient>(r => { release = r }), addresses: () => [addr('10.99.0.13')],
            logger: () => {}, nextDelayMs: () => 1, probe: undefined, dbusTimeoutMs: 10,
        })
        expect(await p.tick()).toBe('error')
        release({ entryGroupNew: async () => { throw new Error('x') }, close: () => { closed++ } })
        await new Promise(r => setTimeout(r, 10))
        expect(closed).toBe(1)
    })
})
