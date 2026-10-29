/**
 * engine-identity.test.ts — idea#322 Stage 2, Engine side: idea-engine-identity applies
 * the flash-time identity (idea-flash.sh, koenswings/idea#380) from the boot partition.
 * The script runs in a sandbox copy with a temp boot dir, temp /etc and fake binaries;
 * never root, never the real system.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { fs, path } from 'zx'
import os from 'os'

const SRC = path.join(process.cwd(), 'script/build_image_assets/idea-engine-identity')
const BOOT_SH = path.join(process.cwd(), 'script/build_image_assets/boot.sh')
const KEY = 'tskey-auth-kTESTFAKE0123-abcdefABCDEF0123456789'

interface Sb { tmp: string, boot: string, etc: string, state: string, zi: string, calls: string, script: string, bin: string }
let sb: Sb

const fake = (bin: string, name: string, body = '') => {
    const p = path.join(bin, name)
    fs.writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "$CALLS"\n${body}\n`, { mode: 0o755 })
    return p
}

const mk = (opts: { tailscaleRc?: number, tailscaleEcho?: boolean, noTailscale?: boolean } = {}): Sb => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-test-identity-'))
    const s: Sb = { tmp, boot: path.join(tmp, 'boot'), etc: path.join(tmp, 'etc'), state: path.join(tmp, 'state'),
        zi: path.join(tmp, 'zoneinfo'), calls: path.join(tmp, 'calls'), script: path.join(tmp, 'idea-engine-identity'), bin: path.join(tmp, 'bin') }
    for (const d of [s.boot, s.etc, s.zi, s.bin]) fs.ensureDirSync(d)
    for (const z of ['UTC', 'Africa/Harare']) { fs.ensureDirSync(path.dirname(path.join(s.zi, z))); fs.writeFileSync(path.join(s.zi, z), 'TZif2') }
    fs.writeFileSync(path.join(s.etc, 'hostname'), 'idea-default\n')
    fs.writeFileSync(path.join(s.etc, 'hosts'), '127.0.0.1\tlocalhost\n127.0.1.1\tidea-default\n')
    fs.writeFileSync(path.join(s.etc, 'timezone'), 'UTC\n')
    fs.writeFileSync(s.calls, '')
    const tsBody = `${opts.tailscaleEcho ? 'echo "using key $(cat \${2#--auth-key=file:})"; echo "key file \${2}"' : ''}\nexit ${opts.tailscaleRc ?? 0}`
    const bins = {
        HOSTNAMECTL: fake(s.bin, 'hostnamectl'),
        TIMEDATECTL: fake(s.bin, 'timedatectl', `printf '%s\\n' "$2" > "${s.etc}/timezone"`),
        SYSTEMCTL: fake(s.bin, 'systemctl'),
        TAILSCALE: opts.noTailscale ? path.join(s.bin, 'missing-tailscale') : fake(s.bin, 'tailscale', tsBody),
        SHRED: fake(s.bin, 'shred', 'for a; do f=$a; done; : > "$f"; rm -f -- "$f"'),
        SYNC: fake(s.bin, 'sync'),
    }
    let t = fs.readFileSync(SRC, 'utf8')
    const set = (k: string, v: string) => {
        const re = new RegExp(`^${k}=.*$`, 'm'); expect(t).toMatch(re); t = t.replace(re, `${k}=${v}`)
    }
    set('BOOT_DIR', s.boot); set('ETC_DIR', s.etc); set('STATE_DIR', s.state); set('ZONEINFO', s.zi)
    for (const [k, v] of Object.entries(bins)) set(k, v)
    fs.writeFileSync(s.script, t, { mode: 0o755 })
    return s
}

const run = (env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [sb.script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', CALLS: sb.calls, ...env } })
    return { ...r, out: r.stdout + r.stderr, calls: fs.readFileSync(sb.calls, 'utf8') }
}
const b = (f: string) => path.join(sb.boot, f)
const e = (f: string) => path.join(sb.etc, f)
const writeKey = (k = KEY) => { fs.ensureDirSync(b('idea-secrets')); fs.writeFileSync(b('idea-secrets/tailscale-authkey'), k + '\n') }

describe('idea-engine-identity (idea#322)', () => {
    afterEach(() => { fs.rmSync(sb.tmp, { recursive: true, force: true }) })

    describe('basic', () => {
        beforeEach(() => { sb = mk() })
        it('prints its version', () => {
            expect(spawnSync('bash', [SRC, '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('idea-engine-identity 1')
        })
        it('does nothing when no identity files are present', () => {
            const r = run()
            expect(r.status).toBe(0)
            expect(r.calls).toBe('')
            expect(r.stdout).toBe('')
            expect(fs.readFileSync(e('hostname'), 'utf8')).toBe('idea-default\n')
            expect(fs.existsSync(sb.state)).toBe(false)
        })
        it('applies a valid name, writes sticker-name and /etc/hosts, deletes the file', () => {
            fs.writeFileSync(b('idea-hostname.txt'), ' Brave-Otter\r\nignored\n')
            const r = run()
            expect(r.status).toBe(0)
            expect(r.out).toMatch(/hostname set to brave-otter/)
            expect(fs.readFileSync(e('hostname'), 'utf8')).toBe('brave-otter\n')
            expect(fs.readFileSync(e('idea/sticker-name'), 'utf8')).toBe('brave-otter\n')
            expect(fs.readFileSync(e('hosts'), 'utf8')).toMatch(/^127\.0\.1\.1\tbrave-otter$/m)
            expect(r.calls).toMatch(/^hostnamectl set-hostname brave-otter$/m)
            expect(fs.existsSync(b('idea-hostname.txt'))).toBe(false)
            // idempotent: second run does nothing
            fs.writeFileSync(sb.calls, '')
            const r2 = run()
            expect(r2.calls).toBe('')
            expect(fs.readFileSync(e('hostname'), 'utf8')).toBe('brave-otter\n')
        })
        it('honours IDEA_HOSTNAME_SRC', () => {
            const alt = path.join(sb.tmp, 'alt-name')
            fs.writeFileSync(alt, 'idea-pc-5b4c\n')
            run({ IDEA_HOSTNAME_SRC: alt })
            expect(fs.readFileSync(e('hostname'), 'utf8')).toBe('idea-pc-5b4c\n')
            expect(fs.existsSync(alt)).toBe(false)
        })
        for (const bad of ['-bad', 'bad-', 'a_b', 'x'.repeat(64), 'a.local', '$(id)', 'a;b', '']) {
            it(`refuses invalid name ${JSON.stringify(bad)}, keeps the default, deletes the file`, () => {
                fs.writeFileSync(b('idea-hostname.txt'), bad + '\n')
                const r = run()
                expect(r.status).toBe(0)
                expect(r.out).toMatch(/refused: BAD_NAME: .*keeping 'idea-default'/)
                expect(fs.readFileSync(e('hostname'), 'utf8')).toBe('idea-default\n')
                expect(fs.existsSync(e('idea/sticker-name'))).toBe(false)
                expect(r.calls).not.toMatch(/hostnamectl/)
                expect(fs.existsSync(b('idea-hostname.txt'))).toBe(false)
            })
        }
        it('applies a valid time zone on every boot when it differs, keeps the file', () => {
            fs.writeFileSync(b('idea-timezone.txt'), 'Africa/Harare\n')
            const r = run()
            expect(r.calls).toMatch(/^timedatectl set-timezone Africa\/Harare$/m)
            expect(r.out).toMatch(/time zone set to Africa\/Harare \(was UTC\)/)
            expect(fs.existsSync(b('idea-timezone.txt'))).toBe(true)
            fs.writeFileSync(sb.calls, '')
            expect(run().calls).toBe('')
        })
        for (const bad of ['Europe/Nowhere', '../etc/passwd', 'Africa/../UTC', '/UTC', '$(id)', '']) {
            it(`refuses time zone ${JSON.stringify(bad)}`, () => {
                fs.writeFileSync(b('idea-timezone.txt'), bad + '\n')
                const r = run()
                expect(r.out).toMatch(/refused: BAD_TIMEZONE/)
                expect(r.calls).not.toMatch(/timedatectl/)
                expect(fs.readFileSync(e('timezone'), 'utf8')).toBe('UTC\n')
            })
        }
        it('home file: checked and logged only, never changed', () => {
            fs.writeFileSync(b('idea-home.txt'), 'brave-otter.local\n')
            const r = run()
            expect(r.out).toMatch(/names brave-otter; an Engine has no home Engine/)
            expect(fs.readFileSync(b('idea-home.txt'), 'utf8')).toBe('brave-otter.local\n')
            fs.writeFileSync(b('idea-home.txt'), '')
            expect(run().out).toBe('')
            fs.writeFileSync(b('idea-home.txt'), 'bad_name\n')
            expect(run().out).toMatch(/refused: BAD_HOME/)
        })
    })

    describe('Tailscale key', () => {
        it('moves the key to /etc/tailscale (0600), wipes it from the card, joins, never logs it', () => {
            sb = mk({ tailscaleEcho: true })
            writeKey()
            const r = run()
            expect(r.status).toBe(0)
            expect(r.out).not.toContain(KEY)
            expect(r.calls).not.toContain(KEY)
            expect(r.out).toMatch(/joined the tailnet/)
            expect(fs.existsSync(b('idea-secrets/tailscale-authkey'))).toBe(false)
            expect(fs.existsSync(b('idea-secrets'))).toBe(false)
            expect(r.calls).toMatch(/^shred -u -z -n 1 -- .*tailscale-authkey$/m)
            const dst = e('tailscale/debug-authkey')
            expect(fs.readFileSync(dst, 'utf8')).toBe(KEY + '\n')
            expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
            expect(fs.statSync(e('tailscale')).mode & 0o777).toBe(0o700)
            expect(r.calls).toMatch(/^systemctl enable --now tailscaled$/m)
            expect(r.calls).toMatch(new RegExp(`^tailscale up --auth-key=file:${dst} --advertise-tags=tag:idea --hostname=idea-default --timeout=60s$`, 'm'))
            expect(fs.existsSync(path.join(sb.state, 'tailscale-pending'))).toBe(false)
            fs.writeFileSync(sb.calls, '')
            expect(run().calls).toBe('')
        })
        it('never passes --ephemeral (Koen 2026-10-13: always on)', () => {
            sb = mk()
            writeKey()
            const r = run()
            expect(r.calls).toMatch(/^tailscale up /m)
            expect(r.calls).not.toMatch(/ephemeral/)
            expect(fs.readFileSync(SRC, 'utf8')).not.toMatch(/--ephemeral/)
        })
        it('offline: key wiped from the card at once, join retried next boot', () => {
            sb = mk({ tailscaleRc: 1 })
            writeKey()
            const r = run()
            expect(r.out).toMatch(/tailscale up failed \(exit 1; offline\?\); will retry next boot/)
            expect(fs.existsSync(b('idea-secrets/tailscale-authkey'))).toBe(false)
            expect(fs.existsSync(path.join(sb.state, 'tailscale-pending'))).toBe(true)
            fs.writeFileSync(sb.calls, '')
            expect(run().calls).toMatch(/^tailscale up /m)
        })
        it('no tailscale installed: refused, retried later', () => {
            sb = mk({ noTailscale: true })
            writeKey()
            expect(run().out).toMatch(/refused: NO_TAILSCALE/)
            expect(fs.existsSync(path.join(sb.state, 'tailscale-pending'))).toBe(true)
        })
        it('an invalid key is wiped and not used', () => {
            sb = mk()
            writeKey('not-a-key $(id)')
            const r = run()
            expect(r.out).toMatch(/refused: BAD_KEY/)
            expect(r.out).not.toContain('not-a-key')
            expect(fs.existsSync(b('idea-secrets/tailscale-authkey'))).toBe(false)
            expect(fs.existsSync(e('tailscale/debug-authkey'))).toBe(false)
            expect(r.calls).not.toMatch(/^tailscale /m)
        })
        it('wipes by overwrite + rm when shred is missing', () => {
            sb = mk()
            let t = fs.readFileSync(sb.script, 'utf8').replace(/^SHRED=.*$/m, `SHRED=${path.join(sb.bin, 'no-shred')}`)
            fs.writeFileSync(sb.script, t)
            writeKey()
            run()
            expect(fs.existsSync(b('idea-secrets/tailscale-authkey'))).toBe(false)
        })
    })

    describe('wiring', () => {
        beforeEach(() => { sb = mk() })
        it('boot.sh runs the helper before the MASTER personalisation, after dropping the master sticker name', () => {
            const t = fs.readFileSync(BOOT_SH, 'utf8')
            const rm = t.indexOf('rm -f /etc/idea/sticker-name')
            const call = t.indexOf('/usr/local/sbin/idea-engine-identity >>')
            const pers = t.indexOf('build-engine.ts --personalize')
            expect(rm).toBeGreaterThan(0)
            expect(call).toBeGreaterThan(rm)
            expect(pers).toBeGreaterThan(call)
            expect(t.split('rm -f /etc/idea/sticker-name').length).toBe(2)
        })
        it('installRootHelpers installs it as a root-owned copy', () => {
            const t = fs.readFileSync(path.join(process.cwd(), 'src/data/Engine.ts'), 'utf8')
            expect(t).toContain("ENGINE_IDENTITY_HELPER = '/usr/local/sbin/idea-engine-identity'")
            expect(t).toMatch(/sudo install -o root -g root -m 0755 \$\{enginePath\}\/script\/build_image_assets\/idea-engine-identity \$\{ENGINE_IDENTITY_HELPER\}/)
        })
        it('never touches store identity', () => {
            const t = fs.readFileSync(SRC, 'utf8')
            expect(t).not.toMatch(/store-identity|store-template|store-url/)
        })
    })
})
