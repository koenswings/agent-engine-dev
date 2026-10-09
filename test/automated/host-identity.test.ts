/**
 * host-identity.test.ts: unit tests for src/data/HostIdentity.ts (agent-engine-dev#163):
 * which addresses count as this Pi's, the .env writer, Nextcloud detection, and
 * the post-start trusted_domains bridge against an in-memory fake occ (same
 * semantics as app-nextcloud's tests/fake-occ.mjs).
 */
import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { fs } from 'zx'
import {
    hostIPv4s, bareHostname, primaryIPv4, setEnvLines, writeHostIdentityEnv, isNextcloudInstance,
    planTrustedDomains, nextcloudTrustedDomainsBridge, MANAGED_KEY, OccRunner,
} from '../../src/data/HostIdentity.js'

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as any
const v6 = (address: string) => ({ address, family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 }) as any

/** In-memory occ: config:system get/set/delete on arrays, config:app:set, status. */
const fakeOcc = (system: Record<string, string[]> = {}, opts: { failSet?: boolean; down?: boolean } = {}) => {
    const calls: string[] = []
    const run: OccRunner = async (args) => {
        calls.push(args.join(' '))
        if (opts.down) throw new Error('Error response from daemon: container not running')
        const [cmd, key, idx, val] = args
        if (cmd === 'config:app:set') return ''
        if (cmd === 'config:system:get') {
            if (!system[key]) throw new Error('exit 1')
            return system[key].join('\n') + '\n'
        }
        if (cmd === 'config:system:set') {
            if (opts.failSet) throw new Error('occ set failed')
            const i = Number(idx); const arr = system[key] ?? (system[key] = [])
            if (i > arr.length) throw new Error(`index gap ${i}`)
            arr[i] = val.replace(/^--value=/, '')
            return ''
        }
        if (cmd === 'config:system:delete') {
            const arr = system[key] ?? []
            if (Number(idx) !== arr.length - 1) throw new Error('delete not at tail')
            arr.pop()
            return ''
        }
        throw new Error(`unknown ${cmd}`)
    }
    return { run, system, calls, writes: () => calls.filter(c => /:(set|delete) /.test(c) && !/config:app:set/.test(c)) }
}

describe('hostIPv4s / bareHostname / primaryIPv4', () => {
    const ifaces = {
        lo: [v4('127.0.0.1', true)],
        tailscale0: [v4('100.64.0.13'), v6('fd7a::1')],
        docker0: [v4('172.17.0.1')],
        'br-0f1e': [v4('172.18.0.1')],
        vethab12: [v4('169.254.1.1')],
        wlan0: [v4('10.0.0.13')],
        eth0: [v4('192.168.0.13'), v6('fe80::1')],
    }
    it('wired, wireless, others, Tailscale; no loopback, IPv6 or container bridges', () => {
        expect(hostIPv4s(ifaces)).toEqual(['192.168.0.13', '10.0.0.13', '100.64.0.13'])
    })
    it('deduplicates and tolerates no interfaces', () => {
        expect(hostIPv4s({ eth0: [v4('1.2.3.4')], eth1: [v4('1.2.3.4')] })).toEqual(['1.2.3.4'])
        expect(hostIPv4s({})).toEqual([])
    })
    it('primaryIPv4: eth0, else the first IPv4', () => {
        expect(primaryIPv4(ifaces)).toBe('192.168.0.13')
        expect(primaryIPv4({ wlan0: [v4('10.0.0.5')], tailscale0: [v4('100.64.0.5')] })).toBe('10.0.0.5')
        expect(primaryIPv4({})).toBeUndefined()
    })
    it('bareHostname drops .local and domains', () => {
        expect(bareHostname('idea03.local')).toBe('idea03')
        expect(bareHostname(' IDEA03 ')).toBe('idea03')
        expect(bareHostname('idea03.lan')).toBe('idea03')
        expect(bareHostname(undefined)).toBe('')
    })
})

describe('.env writer and Nextcloud detection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-hostid-'))
    it('setEnvLines replaces in place, appends, removes duplicates, keeps other lines and mode', async () => {
        const p = path.join(dir, '.env')
        await fs.writeFile(p, 'port=1\nIDEA_HOSTNAME=old\npass=a,b\nIDEA_HOSTNAME=dup', { mode: 0o600 })
        await writeHostIdentityEnv(p, { hostname: 'idea03', ips: ['192.168.0.13', '100.64.0.13'] })
        expect(await fs.readFile(p, 'utf8')).toBe('port=1\nIDEA_HOSTNAME=idea03\npass=a,b\nIDEA_HOST_IPS=192.168.0.13,100.64.0.13\n')
        expect((await fs.stat(p)).mode & 0o777).toBe(0o600)
        await setEnvLines(p, { IDEA_HOST_IPS: '' })
        expect(await fs.readFile(p, 'utf8')).toMatch(/^IDEA_HOST_IPS=$/m)
    })
    it('writes a missing .env', async () => {
        const p = path.join(dir, 'new.env')
        await writeHostIdentityEnv(p, { hostname: 'idea01', ips: [] })
        expect(await fs.readFile(p, 'utf8')).toBe('IDEA_HOSTNAME=idea01\nIDEA_HOST_IPS=\n')
    })
    it('isNextcloudInstance: x-app.name or a nextcloud-app service; not other apps', async () => {
        const mk = async (n: string, y: string) => { await fs.mkdirp(path.join(dir, n)); await fs.writeFile(path.join(dir, n, 'compose.yaml'), y); return path.join(dir, n) }
        expect(await isNextcloudInstance(await mk('a', 'x-app:\n  name: nextcloud\n  version: 1.0-duration\nservices: {}\n'))).toBe(true)
        expect(await isNextcloudInstance(await mk('b', 'x-app:\n  name: school-cloud\nservices:\n  nextcloud-app: {image: x}\n'))).toBe(true)
        expect(await isNextcloudInstance(await mk('c', 'x-app:\n  name: kolibri\nservices:\n  kolibri: {image: x}\n'))).toBe(false)
        expect(await isNextcloudInstance(path.join(dir, 'missing'))).toBe(false)
    })
})

describe('planTrustedDomains', () => {
    it('desired first, then entries the Engine/hook did not write; localhost never managed', () => {
        const p = planTrustedDomains(['idea01:18280', 'localhost'], [], { hostname: 'idea03', ips: ['192.168.0.13'] })
        expect(p.final).toEqual(['localhost', 'idea03', 'idea03.local', '192.168.0.13', 'idea01:18280'])
        expect(p.own).toEqual(['idea03', 'idea03.local', '192.168.0.13'])
        expect(p.changed).toBe(true)
    })
})

describe('nextcloudTrustedDomainsBridge (TODO-remove, #163)', () => {
    const idea01 = { hostname: 'idea01', ips: ['192.168.0.11', '100.64.0.11'] }
    const idea03 = { hostname: 'idea03', ips: ['192.168.0.13'] }

    it('first run on a copied instance: full list, old host kept as unmanaged, wopi_url set', async () => {
        const occ = fakeOcc({ trusted_domains: ['idea01:18280'] })
        const r = await nextcloudTrustedDomainsBridge('nc1', idea03, occ.run, '192.168.0.13')
        expect(r).toMatchObject({ ok: true, changed: true })
        expect(occ.system.trusted_domains).toEqual(['localhost', 'idea03', 'idea03.local', '192.168.0.13', 'idea01:18280'])
        expect(occ.system[MANAGED_KEY]).toEqual(['idea03', 'idea03.local', '192.168.0.13'])
        expect(occ.calls[0]).toBe('config:app:set --value=http://192.168.0.13:9980 richdocuments wopi_url')
    })
    it('idempotent: a second run writes nothing', async () => {
        const occ = fakeOcc({ trusted_domains: ['idea01:18280'] })
        await nextcloudTrustedDomainsBridge('nc1', idea03, occ.run)
        const n = occ.writes().length
        expect(await nextcloudTrustedDomainsBridge('nc1', idea03, occ.run)).toMatchObject({ ok: true, changed: false })
        expect(occ.writes().length).toBe(n)
    })
    it('re-dock on another Pi: own entries replaced, admin entry kept, list shrinks at the tail', async () => {
        const occ = fakeOcc({ trusted_domains: ['localhost'] })
        await nextcloudTrustedDomainsBridge('nc1', idea01, occ.run)
        occ.system.trusted_domains.push('cloud.school.example')   // added by the school's admin
        await nextcloudTrustedDomainsBridge('nc1', idea03, occ.run)
        expect(occ.system.trusted_domains).toEqual(['localhost', 'idea03', 'idea03.local', '192.168.0.13', 'cloud.school.example'])
        expect(occ.system[MANAGED_KEY]).toEqual(['idea03', 'idea03.local', '192.168.0.13'])
        expect(occ.system.trusted_domains).not.toContain('idea01')
    })
    it('agrees with the hook: after the hook wrote the same list, the bridge is a no-op', async () => {
        const occ = fakeOcc({
            trusted_domains: ['localhost', 'idea03', 'idea03.local', '192.168.0.13'],
            [MANAGED_KEY]: ['idea03', 'idea03.local', '192.168.0.13'],
        })
        expect(await nextcloudTrustedDomainsBridge('nc1', idea03, occ.run)).toMatchObject({ ok: true, changed: false })
        expect(occ.writes()).toEqual([])
    })
    it('never throws: container down or a failing set → ok:false, list never emptied', async () => {
        const down = fakeOcc({}, { down: true })
        await expect(nextcloudTrustedDomainsBridge('nc1', idea03, down.run, '192.168.0.13')).resolves.toMatchObject({ ok: false })
        const failing = fakeOcc({ trusted_domains: ['idea01:18280'] }, { failSet: true })
        await expect(nextcloudTrustedDomainsBridge('nc1', idea03, failing.run)).resolves.toMatchObject({ ok: false })
        expect(failing.system.trusted_domains).toEqual(['idea01:18280'])
    })
    it('no hostname and no IPs: config untouched', async () => {
        const occ = fakeOcc({ trusted_domains: ['x'] })
        expect(await nextcloudTrustedDomainsBridge('nc1', { hostname: '', ips: [] }, occ.run)).toMatchObject({ ok: true, changed: false })
        expect(occ.calls).toEqual([])
    })
})
