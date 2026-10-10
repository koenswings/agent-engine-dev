/**
 * engine-lan-address.test.ts: Engine.lanAddress (agent-console-dev#138).
 * The Engine publishes its LAN IPv4 in the store at start and on every heartbeat,
 * so the Console can open apps without mDNS.
 *
 * LanAddress.ts is loaded with a dynamic import (path built at run time), so this
 * file also compiles on main, where it fails: no module and no field.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { generateHeartBeat } from '../../src/monitors/timeMonitor.js'

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
        generateHeartBeat(handle)
        expect(lan()).toBe('192.168.0.139')

        const touched: string[][] = []
        const onChange = ({ patches }: any) => { for (const p of patches) touched.push(p.path.map(String)) }
        handle.on('change', onChange)
        try {
            generateHeartBeat(handle)       // same address
            expect(touched.some(p => p.includes('lastRun')), 'heartbeat ran').toBe(true)
            expect(touched.filter(p => p.includes('lanAddress')), 'no lanAddress write when unchanged').toEqual([])

            setHost({ ...lo, eth0: [v4('192.168.0.177')] }, routes(['eth0', 100]))   // DHCP gave a new lease
            generateHeartBeat(handle)
            expect(lan()).toBe('192.168.0.177')
            expect(touched.some(p => p.includes('lanAddress'))).toBe(true)

            setHost({ ...lo, ...noise }, '')   // cable out, Wi-Fi off
            generateHeartBeat(handle)
            expect(lan()).toBeNull()
        } finally {
            handle.off('change', onChange)
        }
    })
})
