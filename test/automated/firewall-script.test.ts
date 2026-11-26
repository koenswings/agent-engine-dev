/**
 * firewall-script.test.ts — script/ops/idea-engine-firewall.sh (engine#582 step 5).
 * Only --dry-run and argument checks run here: apply/confirm/remove need root and nft
 * and are never run by tests.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SCRIPT = path.resolve('script/ops/idea-engine-firewall.sh')
let etc = ''
const run = (...args: string[]) => {
    const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, IDEA_FW_ETC: etc, IDEA_FW_NFT_DIR: path.join(etc, 'nft'), IDEA_FW_RUN: path.join(etc, 'run'), IDEA_FW_UNIT_DIR: path.join(etc, 'unit') } })
    return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('idea-engine-firewall.sh --dry-run', () => {
    beforeEach(() => { etc = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-fw-')) })

    it('default ruleset: own table, only the Engine ports, the accept list, then drop', () => {
        const r = run('--dry-run')
        expect(r.code).toBe(0)
        expect(r.out).toContain('table inet idea_engine_fw {')
        expect(r.out).toContain('type filter hook input priority 0; policy accept;')
        expect(r.out).toContain('tcp dport { 80, 8080, 4321 } jump engine_ports')
        expect(r.out).toContain('set allow4 { type ipv4_addr; flags interval; elements = { 10.42.0.0/16 } }')
        expect(r.out).toContain('set allow6 { type ipv6_addr; flags interval; elements = { fe80::/10 } }')
        const chain = r.out.slice(r.out.indexOf('chain engine_ports'))
        const order = ['iif "lo" accept', 'ct state established,related accept', 'iifname "docker0" accept', 'iifname "br-*" accept',
            'iifname "tailscale0" accept', 'ip saddr @allow4 accept', 'ip6 saddr @allow6 accept', 'counter drop']
        const at = order.map(l => chain.indexOf(l))
        expect(at.every(i => i >= 0)).toBe(true)
        expect([...at].sort((x, y) => x - y)).toEqual(at)
        // nothing outside the Engine ports is filtered
        expect(r.out).not.toMatch(/chain input \{[^}]*drop/)
        expect(fs.readdirSync(etc)).toEqual([])   // dry run writes nothing
    })

    it('allow file (comments, blanks, IPv6) and --allow are merged; --allow is not saved on a dry run', () => {
        fs.writeFileSync(path.join(etc, 'firewall-allow'), '# pool LAN\n192.168.1.0/24\n\nfd7a:115c:a1e0::/48  # tailnet v6\n')
        const r = run('--dry-run', '--allow', '172.16.5.0/24', '--allow', '10.0.0.7')
        expect(r.code).toBe(0)
        expect(r.out).toContain('elements = { 10.42.0.0/16, 192.168.1.0/24, 172.16.5.0/24, 10.0.0.7 }')
        expect(r.out).toContain('elements = { fe80::/10, fd7a:115c:a1e0::/48 }')
        expect(fs.readFileSync(path.join(etc, 'firewall-allow'), 'utf8')).not.toContain('172.16.5.0/24')
    })

    it('admins file: tailscale0 only from those ranges', () => {
        fs.writeFileSync(path.join(etc, 'firewall-admins'), '100.101.102.103/32\nfd7a:115c:a1e0::1/128\n')
        const r = run('--dry-run')
        expect(r.out).toContain('set admins4 { type ipv4_addr; flags interval; elements = { 100.101.102.103/32 } }')
        expect(r.out).toContain('set admins6 { type ipv6_addr; flags interval; elements = { fd7a:115c:a1e0::1/128 } }')
        expect(r.out).toContain('iifname "tailscale0" ip saddr @admins4 accept')
        expect(r.out).toContain('iifname "tailscale0" ip6 saddr @admins6 accept')
        expect(r.out).not.toContain('iifname "tailscale0" accept')
    })

    it('--ports changes the filtered ports', () => {
        expect(run('--dry-run', '--ports', '80,4321').out).toContain('tcp dport { 80, 4321 } jump engine_ports')
    })

    it('bad input exits 2 with a message, nothing printed', () => {
        for (const args of [['--dry-run', '--allow', '300.1.1.1/8'], ['--dry-run', '--allow', '10.0.0.0/33'], ['--dry-run', '--allow', 'evil; rm'],
            ['--dry-run', '--ports', '80;22'], ['--dry-run', '--rollback-seconds', '5'], ['--bogus'], []]) {
            const r = run(...args)
            expect(r.code).toBe(2)
            expect(r.out).toBe('')
        }
        fs.writeFileSync(path.join(etc, 'firewall-allow'), 'not-a-range\n')
        const f = run('--dry-run')
        expect(f.code).toBe(2)
        expect(f.err).toContain('firewall-allow')
    })

    it.skipIf(process.getuid?.() === 0)('apply, confirm and remove refuse without root', () => {
        for (const c of ['confirm', 'remove']) {
            const r = run(c)
            expect(r.code).toBe(1)
            expect(r.err).toContain('needs root')
        }
        const r = run('apply')
        // apply checks eth0 before root: a box whose eth0 LAN is not allowed exits 2
        // asking for --allow; otherwise it still refuses without root.
        if (r.code === 2) expect(r.err).toContain('--allow')
        else {
            expect(r.code).toBe(1)
            expect(r.err).toContain('needs root')
        }
    })

    it('eth0 LAN outside 10.42: dry-run warns, apply refuses, --allow clears it', () => {
        const ip = path.join(etc, 'ip-addr')
        fs.writeFileSync(ip, '2: eth0    inet 192.168.0.113/24 brd 192.168.0.255 scope global eth0\n')
        const envRun = (...args: string[]) => {
            const r = spawnSync('bash', [SCRIPT, ...args], {
                encoding: 'utf8',
                env: { ...process.env, IDEA_FW_ETC: etc, IDEA_FW_NFT_DIR: path.join(etc, 'nft'), IDEA_FW_RUN: path.join(etc, 'run'), IDEA_FW_UNIT_DIR: path.join(etc, 'unit'), IDEA_FW_IP_ADDR_FILE: ip },
            })
            return { code: r.status, out: r.stdout, err: r.stderr }
        }
        const dry = envRun('--dry-run')
        expect(dry.code).toBe(0)
        expect(dry.out).toContain('elements = { 10.42.0.0/16 }')
        expect(dry.out).not.toContain('192.168.0.0/24')
        expect(dry.err).toMatch(/WARNING:.*eth0 is 192\.168\.0\.0\/24.*--allow 192\.168\.0\.0\/24/)
        const apply = envRun('apply')
        expect(apply.code).toBe(2)
        expect(apply.err).toContain('eth0 is 192.168.0.0/24')
        expect(apply.err).toContain('--allow 192.168.0.0/24')
        expect(apply.out).toBe('')
        const allowed = envRun('--dry-run', '--allow', '192.168.0.0/24')
        expect(allowed.code).toBe(0)
        expect(allowed.out).toContain('192.168.0.0/24')
        expect(allowed.err).not.toMatch(/WARNING:.*eth0/)
        const applyAllowed = envRun('apply', '--allow', '192.168.0.0/24')
        // LAN is allowed; without root we stop at need_root (or skip if we are root)
        if (process.getuid?.() !== 0) {
            expect(applyAllowed.code).toBe(1)
            expect(applyAllowed.err).toContain('needs root')
        }
    })

    it('eth0 already in 10.42: no warning', () => {
        const ip = path.join(etc, 'ip-addr')
        fs.writeFileSync(ip, '2: eth0    inet 10.42.0.1/16 brd 10.42.255.255 scope global eth0\n')
        const r = spawnSync('bash', [SCRIPT, '--dry-run'], {
            encoding: 'utf8',
            env: { ...process.env, IDEA_FW_ETC: etc, IDEA_FW_NFT_DIR: path.join(etc, 'nft'), IDEA_FW_RUN: path.join(etc, 'run'), IDEA_FW_UNIT_DIR: path.join(etc, 'unit'), IDEA_FW_IP_ADDR_FILE: ip },
        })
        expect(r.status).toBe(0)
        expect(r.stderr).not.toMatch(/WARNING:.*eth0/)
    })
})
