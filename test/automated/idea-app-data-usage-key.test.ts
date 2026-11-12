/**
 * idea-app-data-usage-key.test.ts — helper v7 install-usage-key (idea#412)
 *
 *   - the verb accepts only a Tailscale IPv4 (100.64/10) and an ssh-ed25519
 *     public key; options are constructed here, never taken from the caller
 *   - the written key line is restrict,from="<ip>",command="…/idea-usage-export"
 *   - the existing AuthorizedKeysFile entries are kept and the usage-keys
 *     token is appended (Debian first-wins; a later drop-in would replace peers)
 *   - sshd -t failure rolls the drop-in and key file back
 *   - the export binary is installed (sandbox copies from the asset)
 *
 * Same sandbox as idea-app-data-peers.test.ts. Test keys are fixtures, never real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'
import { testKey } from '../harness/peerKeys.js'
import { installUsageKeyArgs, checkUsageFromIpv4 } from '../../src/utils/appDataHelper.js'

let sb: AppDataSandbox
beforeEach(async () => { sb = await makeAppDataSandbox() })
afterEach(async () => { await fs.remove(sb.tmp) })

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/^refused: /m)
    expect(r.stderr).toMatch(re)
}

const keyB64 = (seed: string) => testKey(seed).split(' ')[1]
const install = (ip: string, seed = 'usage-sidecar', extra: string[] = [], env: Record<string, string> = {}) =>
    sb.run(['install-usage-key', ip, 'ssh-ed25519', keyB64(seed), ...extra], env)

const akfLine = async () => {
    const conf = await fs.readFile(sb.peerSshdDropin, 'utf8')
    return conf.split('\n').find(l => l.startsWith('AuthorizedKeysFile ')) ?? ''
}

describe('installUsageKeyArgs (Engine argv builder)', () => {
    it('builds the helper argv from a Tailscale IPv4 and a fixture ed25519 key', () => {
        const pub = testKey('usage-sidecar')
        expect(installUsageKeyArgs('100.64.1.2', pub)).toEqual(['install-usage-key', '100.64.1.2', 'ssh-ed25519', keyB64('usage-sidecar')])
        expect(installUsageKeyArgs('100.99.1.2', keyB64('usage-sidecar'))).toEqual(['install-usage-key', '100.99.1.2', 'ssh-ed25519', keyB64('usage-sidecar')])
    })

    it('refuses non-Tailscale addresses, options and non-ed25519 keys', () => {
        const pub = testKey('usage-sidecar')
        for (const ip of ['127.0.0.1', '10.0.0.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '256.1.1.1', 'not-an-ip', '']) {
            expect(() => checkUsageFromIpv4(ip)).toThrow(/not an IPv4 address|not a Tailscale/)
            expect(() => installUsageKeyArgs(ip, pub)).toThrow(/not an IPv4 address|not a Tailscale/)
        }
        expect(() => installUsageKeyArgs('100.64.1.2', 'ssh-rsa ' + keyB64('usage-sidecar'))).toThrow(/not an ed25519 public key/)
        expect(() => installUsageKeyArgs('100.64.1.2', `restrict,from="1.2.3.4",command="/bin/sh" ${pub}`)).toThrow(/not an ed25519 public key/)
        expect(() => installUsageKeyArgs('100.64.1.2', 'ssh-ed25519 SHORT')).toThrow(/not an ed25519 public key/)
    })
})

describe('idea-app-data install-usage-key', () => {
    it('writes the constructed key line, appends the usage-keys token and installs the export binary', async () => {
        const r = await install('100.64.1.2')
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout).toMatch(/install-usage-key: key updated; drop-in updated; export /)
        expect(await fs.readFile(sb.usageAuthFile, 'utf8')).toBe(
            `restrict,from="100.64.1.2",command="/usr/local/sbin/idea-usage-export" ssh-ed25519 ${keyB64('usage-sidecar')} idea-usage\n`,
        )
        expect((await fs.stat(sb.usageAuthFile)).mode & 0o777).toBe(0o644)
        expect(await akfLine()).toBe(
            'AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/idea_authorized_keys/%u /etc/ssh/idea_usage_keys/%u',
        )
        expect(await fs.pathExists(sb.usageExport)).toBe(true)
        expect((await fs.stat(sb.usageExport)).mode & 0o111).not.toBe(0)
        expect((await sb.calls('sshd')).map(c => c.argv)).toEqual([['-t']])
        expect((await sb.calls('systemctl')).map(c => c.argv)).toEqual([['reload', 'ssh']])
    })

    it('keeps extra AuthorizedKeysFile entries and is idempotent (no duplicate token, no extra reload)', async () => {
        await fs.writeFile(sb.peerSshdDropin, 'AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/idea_authorized_keys/%u /opt/extra/%u\n')
        expect((await install('100.99.8.8')).exitCode).toBe(0)
        expect(await akfLine()).toBe(
            'AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/idea_authorized_keys/%u /opt/extra/%u /etc/ssh/idea_usage_keys/%u',
        )
        await fs.remove(path.join(sb.tmp, 'calls', 'systemctl.log'))
        await fs.remove(path.join(sb.tmp, 'calls', 'sshd.log'))
        const again = await install('100.99.8.8')
        expect(again.exitCode, again.stderr).toBe(0)
        expect(again.stdout).toMatch(/key unchanged; drop-in unchanged/)
        expect(await akfLine()).toBe(
            'AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/idea_authorized_keys/%u /opt/extra/%u /etc/ssh/idea_usage_keys/%u',
        )
        expect((await sb.calls('systemctl'))).toEqual([])
        expect((await sb.calls('sshd')).map(c => c.argv)).toEqual([['-t']])
    })

    it('refuses invalid input and leaves the drop-in and usage key file alone', async () => {
        const beforeDropin = await fs.readFile(sb.peerSshdDropin, 'utf8')
        refused(await sb.run(['install-usage-key', '127.0.0.1', 'ssh-ed25519', keyB64('x')]), /not a Tailscale IPv4 address/)
        refused(await sb.run(['install-usage-key', '10.0.0.1', 'ssh-ed25519', keyB64('x')]), /not a Tailscale IPv4 address/)
        refused(await sb.run(['install-usage-key', '100.64.1.2', 'ssh-rsa', keyB64('x')]), /must be ssh-ed25519 \(options are not accepted/)
        refused(await sb.run(['install-usage-key', '100.64.1.2', 'restrict,from="100.64.1.2",command="/bin/sh"', keyB64('x')]), /must be ssh-ed25519/)
        refused(await sb.run(['install-usage-key', '100.64.1.2', 'ssh-ed25519', keyB64('x').slice(0, -1)]), /not a well-formed ssh-ed25519 public key/)
        refused(await sb.run(['install-usage-key', '100.64.1.2', 'ssh-ed25519', keyB64('x'), 'extra']), /takes exactly 3 argument/)
        refused(await sb.run(['install-usage-key']), /takes exactly 3 argument/)
        expect(await fs.readFile(sb.peerSshdDropin, 'utf8')).toBe(beforeDropin)
        expect(await fs.pathExists(sb.usageAuthFile)).toBe(false)
    })

    it('sshd -t failure rolls the drop-in and key file back', async () => {
        const beforeDropin = await fs.readFile(sb.peerSshdDropin, 'utf8')
        const r = await install('100.64.1.2', 'usage-sidecar', [], { FAKE_SSHD_T_EXIT: '1' })
        expect(r.exitCode, r.stderr).toBe(2)
        expect(r.stderr).toMatch(/sshd -t rejected the configuration after install-usage-key/)
        expect(await fs.readFile(sb.peerSshdDropin, 'utf8')).toBe(beforeDropin)
        expect(await fs.pathExists(sb.usageAuthFile)).toBe(false)
    })

    it('refuses a drop-in with no AuthorizedKeysFile line instead of inventing one', async () => {
        await fs.writeFile(sb.peerSshdDropin, '# no AuthorizedKeysFile here\n')
        refused(await install('100.64.1.2'), /has no AuthorizedKeysFile line; refusing to invent one/)
        expect(await fs.readFile(sb.peerSshdDropin, 'utf8')).toBe('# no AuthorizedKeysFile here\n')
    })
})
