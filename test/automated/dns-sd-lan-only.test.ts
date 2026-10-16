/**
 * dns-sd-lan-only.test.ts — peer discovery (node-dns-sd) only queries on LAN interfaces.
 * Pool 2026-10-15: idea03 logged `send EPERM 224.0.0.251:5353` (tailscale0) and idea04
 * `send ENODEV` (docker bridge br-a12736f0adec) every discovery round.
 */
import { describe, it, expect } from 'vitest'
import mDnsSd from 'node-dns-sd'
import { restrictDnsSdToLan, catchDnsSdSendErrors, discoverySendError, engineAdvertiseInterfaces } from '../../src/monitors/mdnsMonitor.js'
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

/** A node-dns-sd instance using the library's own query loop, with a socket whose sends fail. */
const failingSd = (code = 'EPERM') => {
    const sd: any = Object.create(Object.getPrototypeOf(mDnsSd))
    const sent: string[] = []
    sd._netif_address_list = ['10.99.0.13', '10.99.0.99']
    sd._is_discovering = false
    sd._UDP_PORT = 5353; sd._MULTICAST_ADDR = '224.0.0.251'
    sd._wait = () => Promise.resolve()
    let iface = ''
    sd._udp = {
        setMulticastInterface: (a: string) => { iface = a },
        send: (_b: any, _o: number, _l: number, port: number, addr: string, cb: (e?: any) => void) => {
            sent.push(iface)
            const e: any = new Error(`send ${code} ${addr}:${port}`); e.code = code; cb(e)
        },
    }
    return { sd, sent }
}

describe('node-dns-sd send errors are caught (idea#203 takeover run 18:08, idea03 unhandledRejection send EPERM)', () => {
    it('reproduces: the library query loop rejects on the first failing send (discover() never awaits it)', async () => {
        const { sd, sent } = failingSd()
        await expect(sd._sendQueryPacket(Buffer.from([0]))).rejects.toThrow(/send EPERM 224.0.0.251:5353/)
        expect(sent).toEqual(['10.99.0.13'])
    })
    it('caught: never rejects, reports each error, still tries every interface', async () => {
        const { sd, sent } = failingSd()
        const seen: string[] = []
        catchDnsSdSendErrors(sd, (e) => seen.push(e.code))
        await expect(sd._sendQueryPacket(Buffer.from([0]))).resolves.toBeUndefined()
        expect(new Set(sent)).toEqual(new Set(['10.99.0.13', '10.99.0.99']))
        expect(seen.length).toBe(sent.length)
        expect(seen.every(c => c === 'EPERM')).toBe(true)
    })
    it('a throwing setMulticastInterface is caught too', async () => {
        const { sd } = failingSd()
        sd._udp.setMulticastInterface = () => { const e: any = new Error('setMulticastInterface EADDRNOTAVAIL'); e.code = 'EADDRNOTAVAIL'; throw e }
        const seen: string[] = []
        catchDnsSdSendErrors(sd, (e) => seen.push(e.code))
        await expect(sd._sendQueryPacket(Buffer.from([0]))).resolves.toBeUndefined()
        expect(seen).toEqual(['EADDRNOTAVAIL'])
    })
    it('the real discover() produces no unhandledRejection when every send fails', async () => {
        const { sd } = failingSd()
        catchDnsSdSendErrors(sd, () => {})
        const unhandled: any[] = []
        const on = (e: any) => unhandled.push(e)
        process.on('unhandledRejection', on)
        try {
            sd._is_discovering = false
            sd._discovered_devices = {}
            sd._startListening = async () => {}
            sd._stopListening = async () => {}
            sd._onreceive = () => {}
            const done = sd._sendQueryPacket(Buffer.from([0])) // what discover() does, un-awaited
            void done
            await new Promise(r => setTimeout(r, 20))
        } finally { process.off('unhandledRejection', on) }
        expect(unhandled).toEqual([])
    })
    it('is idempotent and logs a repeated error once', () => {
        const { sd } = failingSd()
        catchDnsSdSendErrors(sd, () => {}); const w = sd._udpSend; catchDnsSdSendErrors(sd, () => {})
        expect(sd._udpSend).toBe(w)
        const lines: string[] = []
        const e: any = new Error('send EPERM 224.0.0.251:5353'); e.code = 'EPERM'
        for (let i = 0; i < 10; i++) discoverySendError(e, (l) => lines.push(l))
        const e2: any = new Error('send ENODEV 224.0.0.251:5353'); e2.code = 'ENODEV'
        discoverySendError(e2, (l) => lines.push(l))
        expect(lines.length).toBe(2)
        expect(lines[0]).toMatch(/EPERM.*logged once until it changes; discovery keeps running/)
    })
})

describe('the Engine service record is advertised on LAN interfaces only (idea03 advertised 172.21.0.1/172.22.0.1)', () => {
    it('keeps eth0/wlan0, drops docker0, br-*, veth*, tailscale0, lo', () => {
        expect(engineAdvertiseInterfaces(() => ['lo', 'eth0', 'wlan0', 'docker0', 'br-a12736f0adec', 'br-77', 'veth9', 'tailscale0']))
            .toEqual(['eth0', 'wlan0'])
    })
    it('falls back to all interfaces (discovery stays on) when no LAN interface exists or /sys is unreadable', () => {
        expect(engineAdvertiseInterfaces(() => ['lo', 'docker0'])).toBeUndefined()
        expect(engineAdvertiseInterfaces(() => { throw new Error('ENOENT') })).toBeUndefined()
    })
    it('ciao honours the allowlist: no docker/bridge address in its interface map', async () => {
        const { NetworkManager } = await import('@homebridge/ciao/lib/NetworkManager.js' as any) as any
        const fake: any = {
            lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
            eth0: [{ address: '10.99.0.13', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:01', internal: false, cidr: '10.99.0.13/24' }],
            docker0: [{ address: '172.21.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:02', internal: false, cidr: '172.21.0.1/16' }],
            'br-a12736f0adec': [{ address: '172.22.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:03', internal: false, cidr: '172.22.0.1/16' }],
        }
        const os = await import('os')
        const spy = (await import('vitest')).vi.spyOn(os.default, 'networkInterfaces').mockReturnValue(fake)
        try {
            const nm = new NetworkManager({ interface: engineAdvertiseInterfaces(() => Object.keys(fake)) })
            await nm.waitForInit?.()
            const addrs = [...nm.getInterfaceMap().values()].map((i: any) => i.ipv4)
            nm.shutdown?.()
            expect(addrs).toContain('10.99.0.13')
            expect(addrs.filter((a: string) => a.startsWith('172.'))).toEqual([]) // ciao always keeps lo as well
        } finally { spy.mockRestore() }
    })
})
