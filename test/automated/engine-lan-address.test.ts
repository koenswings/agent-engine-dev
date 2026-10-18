/**
 * engine-lan-address.test.ts: Engine.lanAddress (agent-console-dev#138).
 * The Engine publishes its LAN IPv4 in the store at start and on every liveness beat
 * (Liveness.ts, 10 s; written only when it changed),
 * so the Console can open apps without mDNS.
 *
 * LanAddress.ts is loaded with a dynamic import (path built at run time), so this
 * file also compiles on main, where it fails: no module and no field.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { writeLanAddress } from '../../src/data/Liveness.js'

const modPath = '../../src/data/' + 'LanAddress.js'
let M: any

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null })
const v6 = (address: string) => ({ address, family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 })
const ROUTE_HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT'
/** /proc/net/route text: [iface, metric] default routes plus their subnet routes. */
const routes = (...defaults: [string, number][]) => [
    ROUTE_HEADER,
    ...defaults.map(([i, m]) => `${i}\t00000000\t0100A8C0\t0003\t0\t0\t${m}\t00000000\t0\t0\t0`),
    ...defaults.map(([i, m]) => `${i}\t0000A8C0\t00000000\t0001\t0\t0\t${m}\t00FFFFFF\t0\t0\t0`),
].join('\n') + '\n'
const NO_ROUTE = `${ROUTE_HEADER}\neth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n`

const lo = { lo: [v4('127.0.0.1', true)] }
const noise = {
    docker0: [v4('172.17.0.1')],
    'br-5c1d': [v4('172.18.0.1')],
    veth12ab: [v4('169.254.10.1')],
    tailscale0: [v4('100.96.190.30'), v6('fd7a:115c::1')],
}

beforeAll(async () => { M = await import(/* @vite-ignore */ modPath) })
afterAll(() => M?.setLanAddressOpsForTests?.(null))

describe('pickLanAddress: default-route interface', () => {
    it('eth0 only', () => {
        expect(M.pickLanAddress({ ...lo, eth0: [v4('192.168.0.139')] }, routes(['eth0', 100]))).toBe('192.168.0.139')
    })
    it('wlan0 only (Pi on Wi-Fi)', () => {
        expect(M.pickLanAddress({ ...lo, wlan0: [v4('10.0.0.42')] }, routes(['wlan0', 600]))).toBe('10.0.0.42')
    })
    it('both: the lower-metric default route wins, whatever the order', () => {
        const both = { ...lo, wlan0: [v4('10.0.0.42')], eth0: [v4('192.168.0.139')] }
        expect(M.pickLanAddress(both, routes(['wlan0', 600], ['eth0', 100]))).toBe('192.168.0.139')
        expect(M.pickLanAddress(both, routes(['eth0', 700], ['wlan0', 50]))).toBe('10.0.0.42')
    })
    it('Docker bridges and Tailscale present: never chosen, even as default route', () => {
        const ifs = { ...lo, ...noise, eth0: [v6('fe80::1'), v4('169.254.3.3'), v4('192.168.0.139')] }
        expect(M.pickLanAddress(ifs, routes(['eth0', 100]))).toBe('192.168.0.139')
        // Tailscale exit node as default route: skip it, fall back to the LAN address
        expect(M.pickLanAddress(ifs, routes(['tailscale0', 0]))).toBe('192.168.0.139')
        // Only virtual / Tailscale / link-local addresses: null
        expect(M.pickLanAddress({ ...lo, ...noise, eth0: [v4('169.254.3.3')] }, routes(['docker0', 0]))).toBeNull()
        // A CGNAT address on a real interface is not a LAN address either
        expect(M.pickLanAddress({ ...lo, eth0: [v4('100.100.1.1')] }, routes(['eth0', 100]))).toBeNull()
    })
    it('no default route: first eligible wired, then Wi-Fi; nothing eligible → null', () => {
        expect(M.pickLanAddress({ ...lo, ...noise, wlan0: [v4('10.0.0.42')], eth0: [v4('192.168.0.139')] }, NO_ROUTE)).toBe('192.168.0.139')
        expect(M.pickLanAddress({ ...lo, ...noise, wlan0: [v4('10.0.0.42')] }, '')).toBe('10.0.0.42')
        expect(M.pickLanAddress({ ...lo, ...noise }, NO_ROUTE)).toBeNull()
        expect(M.pickLanAddress({}, '')).toBeNull()
    })
    it('ignores down default routes', () => {
        const down = `${ROUTE_HEADER}\neth0\t00000000\t0100A8C0\t0002\t0\t0\t100\t00000000\t0\t0\t0\n` + routes(['wlan0', 600]).split('\n').slice(1).join('\n')
        expect(M.pickLanAddress({ eth0: [v4('192.168.0.139')], wlan0: [v4('10.0.0.42')] }, down)).toBe('10.0.0.42')
    })
})

describe('Engine.lanAddress in the store', () => {
    let handle: DocHandle<Store>
    const lan = () => (handle.doc()!.engineDB as any)[localEngineId].lanAddress
    const setHost = (ifs: any, rt: string) => M.setLanAddressOpsForTests({ networkInterfaces: () => ifs, routeTable: () => rt })

    beforeAll(async () => {
        const repo = new Repo({ network: [], storage: undefined })
        handle = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await handle.whenReady()
    })

    it('published at start (new record and existing record)', async () => {
        setHost({ ...lo, ...noise, eth0: [v4('192.168.0.139')] }, routes(['eth0', 100]))
        await createOrUpdateEngine(handle, localEngineId)
        expect(lan()).toBe('192.168.0.139')
        // restart on another network (existing record)
        setHost({ ...lo, wlan0: [v4('10.0.0.42')] }, routes(['wlan0', 600]))
        await createOrUpdateEngine(handle, localEngineId)
        expect(lan()).toBe('10.0.0.42')
    })

    it('heartbeat: updated when the IP changes (DHCP), not written when unchanged', async () => {
        setHost({ ...lo, eth0: [v4('192.168.0.139')] }, routes(['eth0', 100]))
        writeLanAddress(handle, localEngineId)
        expect(lan()).toBe('192.168.0.139')

        const touched: string[][] = []
        const onChange = ({ patches }: any) => { for (const p of patches) touched.push(p.path.map(String)) }
        handle.on('change', onChange)
        try {
            writeLanAddress(handle, localEngineId)       // same address
            expect(touched.filter(p => p.includes('lanAddress')), 'no lanAddress write when unchanged').toEqual([])

            setHost({ ...lo, eth0: [v4('192.168.0.177')] }, routes(['eth0', 100]))   // DHCP gave a new lease
            writeLanAddress(handle, localEngineId)
            expect(lan()).toBe('192.168.0.177')
            expect(touched.some(p => p.includes('lanAddress'))).toBe(true)

            setHost({ ...lo, ...noise }, '')   // cable out, Wi-Fi off
            writeLanAddress(handle, localEngineId)
            expect(lan()).toBeNull()
        } finally {
            handle.off('change', onChange)
        }
    })
})

// ── Preferred school/kit LAN (settings.lanPreferCidrs, default ['10.42.0.0/16']) ──
// kind-panda (kit): eth0 on the kit LAN 10.42.0.0/16, a second uplink (home Wi-Fi or a
// USB tether) holding the default route. The kit address must win.
describe('lanPreferCidrs: the school/kit LAN wins over the default route', () => {
    const KIT = ['10.42.0.0/16']
    const kindPanda = { ...lo, ...noise, eth0: [v4('10.42.0.127')], wlan0: [v4('192.168.1.23')] }

    it('default setting is 10.42.0.0/16', async () => {
        const { lanPreferCidrs, LAN_PREFER_CIDRS_DEFAULT } = await import('../../src/data/Config.js')
        expect(LAN_PREFER_CIDRS_DEFAULT).toEqual(['10.42.0.0/16'])
        expect(lanPreferCidrs()).toEqual(['10.42.0.0/16'])
    })

    it('a preferred-CIDR address beats the default route on another interface (wlan, USB tether)', () => {
        expect(M.pickLanAddress(kindPanda, routes(['wlan0', 600]), KIT)).toBe('10.42.0.127')
        const tether = { ...lo, eth0: [v4('10.42.0.127')], usb0: [v4('172.20.10.2')] }
        expect(M.pickLanAddress(tether, routes(['usb0', 100]), KIT)).toBe('10.42.0.127')
        // without the preference (#166): the default route wins, the reported bug
        expect(M.pickLanAddress(kindPanda, routes(['wlan0', 600]))).toBe('192.168.1.23')
    })

    it('several preferred addresses: default-route interface, then wired over Wi-Fi, then lowest address', () => {
        const two = { ...lo, eth0: [v4('10.42.0.127')], wlan0: [v4('10.42.3.9')] }
        expect(M.pickLanAddress(two, routes(['wlan0', 600]), KIT)).toBe('10.42.3.9')        // default route first
        expect(M.pickLanAddress(two, NO_ROUTE.replace('eth0', 'usb9'), KIT)).toBe('10.42.0.127') // no default: wired first
        expect(M.pickLanAddress({ ...lo, eth0: [v4('10.42.9.1'), v4('10.42.0.200')] }, '', KIT)).toBe('10.42.0.200') // lowest
        expect(M.pickLanAddress({ ...lo, eth1: [v4('10.42.9.1')], eth0: [v4('10.42.0.200')] }, '', KIT)).toBe('10.42.0.200')
    })

    it('no preferred match: the #166 order (default route, wired over Wi-Fi, first)', () => {
        const home = { ...lo, ...noise, wlan0: [v4('10.0.0.42')], eth0: [v4('192.168.0.139')] }
        expect(M.pickLanAddress(home, routes(['wlan0', 50], ['eth0', 700]), KIT)).toBe('10.0.0.42')
        expect(M.pickLanAddress(home, NO_ROUTE, KIT)).toBe('192.168.0.139')
        expect(M.pickLanAddress({ ...lo, ...noise }, NO_ROUTE, KIT)).toBeNull()
    })

    it('empty list (or only invalid CIDRs): exactly the #166 behaviour', () => {
        for (const p of [[], ['nonsense', '10.42.0.0/33', '300.1.1.1/8']]) {
            expect(M.pickLanAddress(kindPanda, routes(['wlan0', 600]), p)).toBe('192.168.1.23')
            expect(M.lanCandidates(kindPanda, routes(['wlan0', 600]), p)).toEqual(M.lanCandidates(kindPanda, routes(['wlan0', 600])))
        }
    })

    it('#166 exclusions still apply inside a preferred CIDR (docker / Tailscale / link-local never chosen)', () => {
        const ifs = { ...lo, docker0: [v4('10.42.0.1')], tailscale0: [v4('10.42.7.7')], veth1: [v4('10.42.8.8')], eth0: [v4('192.168.0.5')] }
        expect(M.pickLanAddress(ifs, routes(['eth0', 100]), KIT)).toBe('192.168.0.5')
        expect(M.pickLanAddress(ifs, routes(['eth0', 100]), ['169.254.0.0/16', '100.64.0.0/10'])).toBe('192.168.0.5')
    })

    it('lanCandidates: every eligible address in selection order, preferred first; no duplicates', () => {
        const ifs = { ...lo, ...noise, wlan0: [v4('192.168.1.23')], eth0: [v4('10.42.0.127'), v4('192.168.50.2')], usb0: [v4('172.20.10.2')] }
        expect(M.lanCandidates(ifs, routes(['wlan0', 600]), KIT)).toEqual([
            { iface: 'eth0', address: '10.42.0.127' },
            { iface: 'wlan0', address: '192.168.1.23' },   // default route
            { iface: 'eth0', address: '192.168.50.2' },    // wired
            { iface: 'usb0', address: '172.20.10.2' },     // other
        ])
        expect(M.lanCandidates({ ...lo, ...noise }, '', KIT)).toEqual([])
    })

    it('parseCidr accepts IPv4 CIDRs only', () => {
        expect(M.parseCidr('10.42.0.0/16')).toEqual({ base: '10.42.0.0', bits: 16 })
        for (const bad of ['10.42.0.0', '10.42.0.0/33', '10.42.0/16', '256.0.0.0/8', 'fd00::/8', ' /16', '']) expect(M.parseCidr(bad), bad).toBeNull()
    })

    it('config validation: lanPreferCidrs must be a list of IPv4 CIDRs', async () => {
        const { validateSettings } = await import('../../src/data/Config.js')
        const base = { mdns: false, isDev: false, testMode: true, port: 1, storeDataFolder: 'a', storeIdentityFolder: 'b', httpPort: 2, consolePath: 'c' }
        const errs = (s: any) => validateSettings(s, 'settings.').join('\n')
        expect(errs({ ...base, lanPreferCidrs: ['10.42.0.0/16'] })).not.toMatch(/lanPreferCidrs/)
        expect(errs({ ...base, lanPreferCidrs: [] })).not.toMatch(/lanPreferCidrs/)
        expect(errs({ ...base, lanPreferCidrs: '10.42.0.0/16' })).toMatch(/lanPreferCidrs/)
        expect(errs({ ...base, lanPreferCidrs: ['10.42.0.0'] })).toMatch(/lanPreferCidrs/)
    })
})

describe('Engine.lanAddresses and the change log line in the store', () => {
    let handle: DocHandle<Store>
    const eng = () => (handle.doc()!.engineDB as any)[localEngineId]
    const setHost = (ifs: any, rt: string) => M.setLanAddressOpsForTests({ networkInterfaces: () => ifs, routeTable: () => rt })
    let logs: string[]

    beforeAll(async () => {
        const repo = new Repo({ network: [], storage: undefined })
        handle = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await handle.whenReady()
    })

    const captureLogs = async (fn: () => unknown) => {
        const { setVerbosity } = await import('../../src/utils/utils.js')
        logs = []
        const spy = vi.spyOn(console, 'info').mockImplementation((...a: any[]) => { logs.push(a.join(' ').replace(/\u001b\[[0-9;]*m/g, '')) })
        setVerbosity(2)
        try { await fn() } finally { spy.mockRestore() }
    }

    it('start: lanAddress (kit LAN) and lanAddresses in selection order; log names the interface', async () => {
        setHost({ ...lo, ...noise, eth0: [v4('10.42.0.127')], wlan0: [v4('192.168.1.23')] }, routes(['wlan0', 600]))
        await captureLogs(() => createOrUpdateEngine(handle, localEngineId))
        expect(eng().lanAddress).toBe('10.42.0.127')
        expect(eng().lanAddresses).toEqual(['10.42.0.127', '192.168.1.23'])
        expect(logs).toContain('Engine lanAddress unset → 10.42.0.127 (eth0)')
        expect(logs).toContain('Engine lanAddresses unset → [10.42.0.127, 192.168.1.23]')
    })

    it('heartbeat: no write when unchanged; list-only change writes only lanAddresses; address change logs old → new (iface)', async () => {
        setHost({ ...lo, eth0: [v4('10.42.0.127')], wlan0: [v4('192.168.1.23')] }, routes(['wlan0', 600]))
        const touched: string[][] = []
        const onChange = ({ patches }: any) => { for (const p of patches) touched.push(p.path.map(String)) }
        handle.on('change', onChange)
        try {
            await captureLogs(() => expect(writeLanAddress(handle, localEngineId)).toBe(false))
            expect(touched).toEqual([])
            expect(logs.filter(l => l.includes('lanAddress'))).toEqual([])

            // Wi-Fi gets a new lease: list changes, lanAddress stays
            setHost({ ...lo, eth0: [v4('10.42.0.127')], wlan0: [v4('192.168.1.99')] }, routes(['wlan0', 600]))
            await captureLogs(() => expect(writeLanAddress(handle, localEngineId)).toBe(true))
            expect(eng().lanAddress).toBe('10.42.0.127')
            expect(eng().lanAddresses).toEqual(['10.42.0.127', '192.168.1.99'])
            expect(touched.some(p => p.includes('lanAddresses'))).toBe(true)
            expect(touched.some(p => p[p.length - 1] === 'lanAddress')).toBe(false)
            expect(logs).toEqual(['Engine lanAddresses [10.42.0.127, 192.168.1.23] → [10.42.0.127, 192.168.1.99]'])

            // kit cable out: falls back to Wi-Fi
            touched.length = 0
            setHost({ ...lo, wlan0: [v4('192.168.1.99')] }, routes(['wlan0', 600]))
            await captureLogs(() => writeLanAddress(handle, localEngineId))
            expect(eng().lanAddress).toBe('192.168.1.99')
            expect(eng().lanAddresses).toEqual(['192.168.1.99'])
            expect(logs).toContain('Engine lanAddress 10.42.0.127 → 192.168.1.99 (wlan0)')

            // nothing eligible: both null, no interface in the line
            setHost({ ...lo, ...noise }, '')
            await captureLogs(() => writeLanAddress(handle, localEngineId))
            expect(eng().lanAddress).toBeNull()
            expect(eng().lanAddresses).toBeNull()
            expect(logs).toEqual(['Engine lanAddress 192.168.1.99 → null', 'Engine lanAddresses [192.168.1.99] → null'])
        } finally {
            handle.off('change', onChange)
        }
    })

    it('empty lanPreferCidrs setting: the default route wins again (#166 behaviour)', async () => {
        const { config } = await import('../../src/data/Config.js')
        const saved = config.settings.lanPreferCidrs
        try {
            config.settings.lanPreferCidrs = []
            setHost({ ...lo, eth0: [v4('10.42.0.127')], wlan0: [v4('192.168.1.23')] }, routes(['wlan0', 600]))
            writeLanAddress(handle, localEngineId)
            expect(eng().lanAddress).toBe('192.168.1.23')
            expect(eng().lanAddresses).toEqual(['192.168.1.23', '10.42.0.127'])
        } finally {
            config.settings.lanPreferCidrs = saved
        }
    })
})
