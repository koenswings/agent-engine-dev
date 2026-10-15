/**
 * dns-sd-lan-only.test.ts — peer discovery (node-dns-sd) only queries on LAN interfaces.
 * Pool 2026-10-15: idea03 logged `send EPERM 224.0.0.251:5353` (tailscale0) and idea04
 * `send ENODEV` (docker bridge br-a12736f0adec) every discovery round.
 */
import { describe, it, expect } from 'vitest'
import mDnsSd from 'node-dns-sd'
import { restrictDnsSdToLan } from '../../src/monitors/mdnsMonitor.js'
import { lanAddresses } from '../../src/monitors/ideaLocal.js'

const ifaces: any = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth0: [{ family: 'IPv4', address: '10.99.0.14', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.126.117.80', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'br-a12736f0adec': [{ family: 'IPv4', address: '172.30.0.1', internal: false }],
    veth1a2b: [{ family: 'IPv4', address: '169.254.3.3', internal: false }],
}

describe('node-dns-sd peer discovery is LAN-only (idea#203 pool run 2e64e77)', () => {
    it('restricted: only the LAN addresses idea.local uses', () => {
        const sd: any = { _netif_address_list: ['172.30.0.1'], _getNetifAddressList: () => ['x'] }
        const lan = () => lanAddresses(ifaces, () => 2).map(a => a.address)
        restrictDnsSdToLan(sd, lan)
        expect(sd._getNetifAddressList()).toEqual(['10.99.0.14'])
        expect(sd._netif_address_list).toEqual(['10.99.0.14'])
    })
    it('applies to the real singleton (method node-dns-sd calls at start)', () => {
        const before = (mDnsSd as any)._getNetifAddressList
        try {
            restrictDnsSdToLan(mDnsSd, () => ['10.99.0.14'])
            expect((mDnsSd as any)._getNetifAddressList()).toEqual(['10.99.0.14'])
        } finally { (mDnsSd as any)._getNetifAddressList = before }
    })
})
