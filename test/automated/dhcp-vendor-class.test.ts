/**
 * dhcp-vendor-class.test.ts — idea#209 D8: build-engine makes each Engine send DHCP
 * option 60 "idea-engine" (NetworkManager connection default and/or dhcpcd
 * vendorclassid), idempotently and with a backup, without touching any link.
 * Runs the real helper script against temp copies of the config files.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync, execSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { installDhcpVendorClass, dhcpVendorClassNmChanged, DHCP_VENDOR_CLASS_HELPER, DHCP_VENDOR_CLASS } from '../../src/data/Engine.js'

const HELPER = resolve(process.cwd(), 'script/build_image_assets/idea-dhcp-vendor-class')
// Raspberry Pi OS stock /etc/dhcpcd.conf (abridged; same shape as idea04's copy)
const DHCPCD_STOCK = `# A sample configuration for dhcpcd.
hostname
clientid
persistent
option rapid_commit
option domain_name_servers, domain_name, domain_search, host_name
option classless_static_routes
option interface_mtu
require dhcp_server_identifier
slaac private

# Example static IP configuration:
#interface eth0
#static ip_address=192.168.0.10/24
denyinterfaces usb0
`
let dir: string
const nmDir = () => join(dir, 'conf.d')
const nmFile = () => join(nmDir(), '90-idea-dhcp-vendor-class.conf')
const dhcpcd = () => join(dir, 'dhcpcd.conf')
const run = (env: Record<string, string> = {}) =>
    execFileSync('bash', [HELPER, '--nm-conf-dir', nmDir(), '--dhcpcd-conf', dhcpcd()],
        { encoding: 'utf8', env: { ...process.env, ...env } }).trim().split('\n')
const backups = (d = dir) => readdirSync(d).filter(f => f.includes('.idea-bak-'))
const activeVendor = (text: string) => text.split('\n').filter(l => /^\s*vendorclassid\b/.test(l))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dhcp-vc-')) })

describe('idea-dhcp-vendor-class: NetworkManager (Bookworm/Trixie image)', () => {
    it('writes a conf.d connection default for eth0 and wlan0, touching no profile', () => {
        mkdirSync(nmDir())
        expect(run()).toEqual(['nm changed', 'dhcpcd absent'])
        const text = readFileSync(nmFile(), 'utf8')
        expect(text).toMatch(/^\[connection-idea-dhcp-vendor-class\]$/m)
        expect(text).toMatch(/^match-device=interface-name:eth0,interface-name:wlan0$/m)
        expect(text).toMatch(/^ipv4\.dhcp-vendor-class-identifier=idea-engine$/m)
        expect(statSync(nmFile()).mode & 0o777).toBe(0o644)
        expect(readdirSync(nmDir())).toEqual(['90-idea-dhcp-vendor-class.conf'])
    })

    it('second run is a no-op: "unchanged", file byte-identical, no backup', () => {
        mkdirSync(nmDir())
        run()
        const first = readFileSync(nmFile(), 'utf8')
        expect(run()).toEqual(['nm unchanged', 'dhcpcd absent'])
        expect(readFileSync(nmFile(), 'utf8')).toBe(first)
        expect(backups(nmDir())).toHaveLength(0)
    })

    it('a hand-edited drop-in is backed up and restored to the managed content', () => {
        mkdirSync(nmDir())
        run()
        const good = readFileSync(nmFile(), 'utf8')
        writeFileSync(nmFile(), '[connection]\nipv4.dhcp-vendor-class-identifier=other\n')
        const out = run()
        expect(out[0]).toMatch(/^nm changed backup=.*\.idea-bak-\d{8}T\d{6}Z$/)
        expect(readFileSync(nmFile(), 'utf8')).toBe(good)
        const b = backups(nmDir())
        expect(b).toHaveLength(1)
        expect(readFileSync(join(nmDir(), b[0]), 'utf8')).toContain('=other')
    })

    it('no NetworkManager conf.d: reports absent and creates nothing', () => {
        expect(run()).toEqual(['nm absent', 'dhcpcd absent'])
        expect(existsSync(nmDir())).toBe(false)
    })
})

describe('idea-dhcp-vendor-class: dhcpcd', () => {
    it('stock conf: adds one global vendorclassid line, backs up the original, keeps every other line', () => {
        writeFileSync(dhcpcd(), DHCPCD_STOCK); chmodSync(dhcpcd(), 0o664)
        const out = run()
        expect(out[1]).toMatch(/^dhcpcd changed backup=.*\.idea-bak-\d{8}T\d{6}Z$/)
        const text = readFileSync(dhcpcd(), 'utf8')
        expect(activeVendor(text)).toEqual(['vendorclassid idea-engine'])
        for (const l of DHCPCD_STOCK.split('\n')) expect(text.split('\n')).toContain(l)
        expect(readFileSync(join(dir, backups()[0]), 'utf8')).toBe(DHCPCD_STOCK)
        expect(statSync(dhcpcd()).mode & 0o777).toBe(0o664)
    })

    it('second run is a no-op', () => {
        writeFileSync(dhcpcd(), DHCPCD_STOCK)
        run()
        const after1 = readFileSync(dhcpcd(), 'utf8')
        expect(run()[1]).toBe('dhcpcd unchanged')
        expect(readFileSync(dhcpcd(), 'utf8')).toBe(after1)
        expect(backups()).toHaveLength(1)
    })

    it('replaces a different global vendorclassid, and puts ours before the first interface block', () => {
        writeFileSync(dhcpcd(), 'vendorclassid dhcpcd-raspi\nhostname\ninterface eth0\nvendorclassid per-if\n')
        run()
        expect(readFileSync(dhcpcd(), 'utf8')).toBe(
            'hostname\n# idea#209 D8: DHCP option 60 for the school router\nvendorclassid idea-engine\n\ninterface eth0\nvendorclassid per-if\n')
    })

    it('commented-out vendorclassid lines are left alone', () => {
        writeFileSync(dhcpcd(), '#vendorclassid foo\nhostname\n')
        run()
        const text = readFileSync(dhcpcd(), 'utf8')
        expect(text).toContain('#vendorclassid foo')
        expect(activeVendor(text)).toEqual(['vendorclassid idea-engine'])
    })
})

describe('idea-dhcp-vendor-class: both clients present (idea04 has NM active plus a stock dhcpcd.conf)', () => {
    it('sets both, then both unchanged', () => {
        mkdirSync(nmDir()); writeFileSync(dhcpcd(), DHCPCD_STOCK)
        const out = run()
        expect(out[0]).toBe('nm changed')
        expect(out[1]).toMatch(/^dhcpcd changed/)
        expect(run()).toEqual(['nm unchanged', 'dhcpcd unchanged'])
    })

    it('a bad vendor class fails without writing anything', () => {
        mkdirSync(nmDir()); writeFileSync(dhcpcd(), DHCPCD_STOCK)
        expect(() => run({ IDEA_DHCP_VENDOR_CLASS: 'x;rm -rf /' })).toThrow()
        expect(readdirSync(nmDir())).toHaveLength(0)
        expect(readFileSync(dhcpcd(), 'utf8')).toBe(DHCPCD_STOCK)
        expect(backups()).toHaveLength(0)
    })
})

describe('installDhcpVendorClass (build-engine step)', () => {
    const INSTALL = `if ! cmp -s /home/pi/engine/script/build_image_assets/idea-dhcp-vendor-class ${DHCP_VENDOR_CLASS_HELPER}; then sudo install -o root -g root -m 0755 /home/pi/engine/script/build_image_assets/idea-dhcp-vendor-class ${DHCP_VENDOR_CLASS_HELPER}; fi`
    const RELOAD = 'if systemctl is-active --quiet NetworkManager; then sudo nmcli general reload conf; fi'
    const recording = (helperOut: string) => {
        const cmds: string[] = []
        const exec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
            const cmd = strings.reduce((a, s, i) => a + s + (i < vals.length ? String(vals[i]) : ''), '')
            cmds.push(cmd)
            return { stdout: cmd === `sudo ${DHCP_VENDOR_CLASS_HELPER}` ? helperOut : '' }
        }
        return { cmds, exec }
    }
    it('installs the helper only when it differs, runs it, then only reloads NM config when the drop-in changed (no restart, no link change)', async () => {
        const { cmds, exec } = recording('nm changed\ndhcpcd absent\n')
        await installDhcpVendorClass(exec, '/home/pi/engine')
        expect(DHCP_VENDOR_CLASS).toBe('idea-engine')
        expect(cmds).toEqual([INSTALL, `sudo ${DHCP_VENDOR_CLASS_HELPER}`, RELOAD])
        for (const c of cmds) expect(c).not.toMatch(/restart|connection (up|down)|device (disconnect|reapply)|dhcpcd -[nk]/)
    })
    it('idea#284: nothing differs (nm unchanged): no NetworkManager reload', async () => {
        for (const out of ['nm unchanged\ndhcpcd unchanged\n', 'nm absent\ndhcpcd changed backup=/etc/dhcpcd.conf.idea-bak-x\n', '']) {
            const { cmds, exec } = recording(out)
            await installDhcpVendorClass(exec, '/home/pi/engine')
            expect(cmds).toEqual([INSTALL, `sudo ${DHCP_VENDOR_CLASS_HELPER}`])
        }
    })
    it('idea#284: a changed NM drop-in with a backup still reloads', () => {
        expect(dhcpVendorClassNmChanged('nm changed backup=/etc/NetworkManager/conf.d/90-idea-dhcp-vendor-class.conf.idea-bak-x\ndhcpcd absent\n')).toBe(true)
        expect(dhcpVendorClassNmChanged('nm unchanged\ndhcpcd changed backup=x\n')).toBe(false)
        expect(dhcpVendorClassNmChanged('nm absent\n')).toBe(false)
    })
    it('idea#284: the install step copies the helper only when its content differs (cmp -s, real files)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dhcp-cmp-'))
        try {
            const src = join(dir, 'src'), dst = join(dir, 'dst')
            writeFileSync(src, 'v2\n'); writeFileSync(dst, 'v2\n')
            const cmd = (s: string, d: string) => `if ! cmp -s ${s} ${d}; then cp ${s} ${d}; echo copied; fi`
            expect(execSync(cmd(src, dst), { encoding: 'utf8' })).toBe('')
            writeFileSync(src, 'v3\n')
            expect(execSync(cmd(src, dst), { encoding: 'utf8' })).toBe('copied\n')
            expect(execSync(cmd(src, join(dir, 'missing')), { encoding: 'utf8' })).toBe('copied\n')
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
})
