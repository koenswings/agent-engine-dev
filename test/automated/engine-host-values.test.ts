/** engineHostValues: only the Engine's OWN host identity is exempt in no-env-values-in-logs (PR #248). */
import { describe, it, expect } from 'vitest'
import type os from 'os'
import { engineHost, isOwnHostValue, ownHostItems } from '../harness/engineHostValues.js'

const nic = (address: string): os.NetworkInterfaceInfo =>
    ({ address, family: 'IPv4', netmask: '255.255.255.0', mac: '00:00:00:00:00:00', internal: false, cidr: null })
// idea04-like: eth0 LAN + tailscale0
const host = engineHost({ hostname: 'idea04', ip: '192.168.0.104' },
    { lo: [nic('127.0.0.1')], eth0: [nic('192.168.0.104')], tailscale0: [nic('100.108.39.45')] }, 'idea04')

describe('engineHostValues', () => {
    it('IDEA_HOST_IPS (comma-joined LAN + Tailscale) of this Engine is exempt, and each IP in it', () => {
        const v = '192.168.0.104,100.108.39.45'
        expect(isOwnHostValue(v, host)).toBe(true)
        expect(ownHostItems(v, host)).toEqual(['192.168.0.104', '100.108.39.45'])
        for (const ip of v.split(',')) expect(isOwnHostValue(ip, host)).toBe(true)
    })
    it('a list with any IP that is not this Engine\'s is NOT exempt', () => {
        expect(isOwnHostValue('192.168.0.104,10.9.9.9', host)).toBe(false)
        expect(ownHostItems('192.168.0.104,10.9.9.9', host)).toEqual([])
        expect(isOwnHostValue('192.168.0.104,', host)).toBe(false)
    })
    it('own hostname is exempt; other names, empty values and secrets are not', () => {
        expect(isOwnHostValue('idea04', host)).toBe(true)
        expect(isOwnHostValue('idea03', host)).toBe(false)
        expect(isOwnHostValue('', host)).toBe(false)
        expect(isOwnHostValue('idea-test-pass-0123456789abcdef', host)).toBe(false)
    })
})
