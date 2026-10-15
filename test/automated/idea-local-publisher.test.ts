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
    IdeaLocalPublisher, AvahiClient, AvahiEntryGroup, EntryGroupState, lanAddresses,
    isLanInterfaceName, AVAHI_PUBLISH_NO_REVERSE, AVAHI_PROTO_INET, LanAddress,
} from '../../src/monitors/ideaLocal.js'

class FakeLan {
    groups = new Set<FakeGroup>()
    holder(name: string) { return [...this.groups].find(g => g.name === name && g.state === EntryGroupState.ESTABLISHED) }
}
class FakeGroup implements AvahiEntryGroup {
    state = EntryGroupState.UNCOMMITED
    name = ''
    records: { ifIndex: number, proto: number, flags: number, address: string }[] = []
    freed = false
    constructor(public lan: FakeLan, public host: FakeHost) { lan.groups.add(this) }
    async addAddress(ifIndex: number, proto: number, flags: number, name: string, address: string) {
        if (this.host.down) throw new Error('org.freedesktop.DBus.Error.ServiceUnknown')
        if (!(flags & AVAHI_PUBLISH_NO_REVERSE)) throw new Error('org.freedesktop.Avahi.CollisionError: Local name collision')
        this.name = name; this.records.push({ ifIndex, proto, flags, address })
    }
    async commit() { this.state = EntryGroupState.REGISTERING }
    async getState() {
        if (this.host.down) throw new Error('org.freedesktop.DBus.Error.ServiceUnknown')
        if (this.state === EntryGroupState.REGISTERING) {
            this.state = this.lan.holder(this.name) ? EntryGroupState.COLLISION : EntryGroupState.ESTABLISHED
        }
        return this.state
    }
    async free() { this.freed = true; this.lan.groups.delete(this) }
}
class FakeHost {
    down = false
    connects = 0
    constructor(public lan: FakeLan) {}
    connect = async (): Promise<AvahiClient> => {
        if (this.down) throw new Error('avahi not running')
        this.connects++
        return { entryGroupNew: async () => { if (this.down) throw new Error('gone'); return new FakeGroup(this.lan, this) }, close: () => {} }
    }
    /** Power cut: the host vanishes without a goodbye; its records stop answering probes. */
    powerCut() { this.down = true; for (const g of [...this.lan.groups]) if (g.host === this) this.lan.groups.delete(g) }
}

const addr = (address: string, ifName = 'eth0', ifIndex = 2): LanAddress => ({ ifName, ifIndex, address })
const mk = (host: FakeHost, a: () => LanAddress[], lines: string[] = []) =>
    new IdeaLocalPublisher({ connect: host.connect, addresses: a, logger: (l) => lines.push(l), nextDelayMs: () => 1 })

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
})
