/**
 * avahi-lan-only.test.ts — idea#203: build-engine's avahi step sets
 * allow-interfaces=eth0,wlan0 under [server], idempotently and with a backup,
 * so <host>.local never resolves to a docker bridge (idea03.local -> 172.21.0.1).
 * Runs the real helper script against temp copies of avahi-daemon.conf.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { installAvahi, AVAHI_LAN_ONLY_HELPER, AVAHI_CONF } from '../../src/data/Engine.js'

const HELPER = resolve(process.cwd(), 'script/build_image_assets/idea-avahi-lan-only')
const STOCK = `[server]
#host-name=foo
#domain-name=local
#browse-domains=0pointer.de, zeroconf.org
use-ipv4=yes
use-ipv6=yes
#allow-interfaces=eth0
#deny-interfaces=eth1
ratelimit-interval-usec=1000000

[wide-area]
enable-wide-area=yes

[publish]
#allow-interfaces=eth9
publish-hinfo=no
`
let dir: string
const conf = () => join(dir, 'avahi-daemon.conf')
const run = (env: Record<string, string> = {}) =>
    execFileSync('bash', [HELPER, conf()], { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
const backups = () => readdirSync(dir).filter(f => f.includes('.idea-bak-'))
const serverLines = (text: string) => text.split('[wide-area]')[0].split('\n')

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'avahi-lan-')) })

describe('idea-avahi-lan-only (idea#203)', () => {
    it('stock conf: sets allow-interfaces=eth0,wlan0 under [server], backs up the original, keeps every other line', () => {
        writeFileSync(conf(), STOCK); chmodSync(conf(), 0o644)
        const out = run()
        expect(out).toMatch(/^changed backup=.*\.idea-bak-\d{8}T\d{6}Z$/)
        const text = readFileSync(conf(), 'utf8')
        expect(serverLines(text)).toContain('allow-interfaces=eth0,wlan0')
        expect(serverLines(text)).not.toContain('#allow-interfaces=eth0')
        expect(text.match(/^allow-interfaces=/gm)).toHaveLength(1)
        // other sections untouched (the commented [publish] line is not ours to remove)
        expect(text).toContain('[publish]\n#allow-interfaces=eth9\npublish-hinfo=no')
        expect(text).toContain('#deny-interfaces=eth1')
        expect(text).toContain('use-ipv6=yes')
        expect(backups()).toHaveLength(1)
        expect(readFileSync(join(dir, backups()[0]), 'utf8')).toBe(STOCK)
        expect(statSync(conf()).mode & 0o777).toBe(0o644)
    })

    it('second run is a no-op: "unchanged", no new backup, file byte-identical', () => {
        writeFileSync(conf(), STOCK)
        run()
        const after1 = readFileSync(conf(), 'utf8')
        expect(run()).toBe('unchanged')
        expect(readFileSync(conf(), 'utf8')).toBe(after1)
        expect(backups()).toHaveLength(1)
    })

    it('replaces a different active value (allow-interfaces=docker0,eth0) instead of adding a second line', () => {
        writeFileSync(conf(), STOCK.replace('#allow-interfaces=eth0', 'allow-interfaces = docker0,eth0'))
        expect(run()).toMatch(/^changed/)
        const text = readFileSync(conf(), 'utf8')
        expect(text.match(/^\s*allow-interfaces\s*=/gm)).toEqual(['allow-interfaces='])
        expect(text).not.toContain('docker0')
    })

    it('no [server] section: appends one', () => {
        writeFileSync(conf(), '[publish]\npublish-hinfo=no\n')
        run()
        expect(readFileSync(conf(), 'utf8')).toBe('[publish]\npublish-hinfo=no\n\n[server]\nallow-interfaces=eth0,wlan0\n')
    })

    it('missing conf or a bad interface list fails without writing anything', () => {
        expect(() => run()).toThrow()
        writeFileSync(conf(), STOCK)
        expect(() => run({ IDEA_AVAHI_INTERFACES: 'eth0;rm -rf /' })).toThrow()
        expect(readFileSync(conf(), 'utf8')).toBe(STOCK)
        expect(backups()).toHaveLength(0)
    })
})

describe('installAvahi (build-engine step)', () => {
    it('installs the helper, runs it on the avahi conf, then enables and restarts avahi', async () => {
        const cmds: string[] = []
        const exec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
            cmds.push(strings.reduce((a, s, i) => a + s + (i < vals.length ? String(vals[i]) : ''), ''))
            return { stdout: '' }
        }
        await installAvahi(exec, '/home/pi/engine')
        expect(cmds).toEqual([
            'sudo apt install avahi-daemon avahi-utils libnss-mdns -y',
            `sudo install -o root -g root -m 0755 /home/pi/engine/script/build_image_assets/idea-avahi-lan-only ${AVAHI_LAN_ONLY_HELPER}`,
            `sudo ${AVAHI_LAN_ONLY_HELPER} ${AVAHI_CONF}`,
            'sudo systemctl enable avahi-daemon',
            'sudo systemctl restart avahi-daemon',
        ])
    })
})
