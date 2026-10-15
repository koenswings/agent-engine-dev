import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

import path from 'path'

// Runs from source and from dist-test/: resolve against the repo root (cwd).
const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')

describe('idea#184 install wiring', () => {
    it('Commands.ts buildEngine uses the checked resolver, not generateHostName()', () => {
        const s = read('src/data/Commands.ts')
        expect(s).not.toMatch(/generateHostName/)
        expect(s).toMatch(/buildArgs\.hostname = \(await resolveStickerName\(parsedArgs\.hostname, realStickerNameDeps\(exec\)\)\)\.name/)
        // resolved only after syncEngine reached the Pi
        expect(s.indexOf('await syncEngine(user, machine)')).toBeLessThan(s.indexOf('await resolveStickerName('))
    })
    it('provision-fleet gives each auto node its own log', () => {
        const s = read('script/provision-fleet.sh')
        const lines = s.split('\n').filter((l) => /^\s*(LOG=|\[\[ "\$NAME" == auto \]\] && LOG=)/.test(l)).map((l) => l.trim())
        expect(lines.length).toBe(2)
        const logFor = (name: string, ip: string) => execFileSync('bash', ['-c', `NAME='${name}'; IP='${ip}'; ${lines.join('; ')}; echo "$LOG"`]).toString().trim()
        const a = logFor('auto', '192.168.1.21'), b = logFor('auto', '192.168.1.22')
        expect(a).not.toBe(b)
        expect(a).toBe('/tmp/provision-auto-192.168.1.21.log')
        expect(logFor('idea03', '192.168.1.13')).toBe('/tmp/provision-idea03.log')
    })
    it('scripts and docs touched by #201 carry no per-school 10.N subnet assumption', () => {
        for (const p of ['script/provision-fleet.sh', 'script/check-fleet.sh', 'script/build-engine.ts', 'script/build_image_assets/boot.sh', 'docs/SCRIPTS.md', 'src/install/stickerName.ts']) {
            const s = read(p)
            expect(s, p).not.toMatch(/\b10\.(N|n|<|\$|\{|X\b)/)
            expect(s, p).not.toMatch(/school (number|nr)/i)
        }
    })
})

describe('idea#184 --no-rename tool and real deps', () => {
    it('sticker-name.ts never renames the system', () => {
        const s = read('script/sticker-name.ts')
        expect(s).toMatch(/no-rename/)
        expect(s).not.toMatch(/hostnamectl|setHostname|\/etc\/hosts|tailscale set/)
    })
    it('installAvahi installs avahi-utils (LAN check needs avahi-resolve-host-name)', () => {
        expect(read('src/data/Engine.ts')).toMatch(/apt install avahi-daemon avahi-utils libnss-mdns/)
    })
    it('real deps write a custom sticker file without sudo and warn when avahi-utils is missing', async () => {
        const { realStickerNameDeps } = await import('../../src/install/stickerName.js')
        const cmds: string[] = []
        const logs: string[] = []
        const exec = async (strings: TemplateStringsArray, ...vals: any[]) => {
            const c = strings.reduce((a, s, i) => a + s + (i < vals.length ? vals[i] : ''), '')
            cmds.push(c)
            return { stdout: c.includes('avahi-resolve-host-name') ? 'NO-AVAHI-UTILS\n' : '' }
        }
        const d = realStickerNameDeps(exec, { stickerFile: '/tmp/x/sticker-name', log: (m) => logs.push(m), peers: [] })
        await d.persist('brave-otter')
        expect(cmds.at(-1)).not.toMatch(/sudo/)
        expect(cmds.at(-1)).toMatch(/\/tmp\/x\/sticker-name/)
        expect(await d.lanTaken('brave-otter')).toBe(false)
        expect(await d.lanTaken('calm-otter')).toBe(false)
        expect(logs.filter((l) => /avahi-utils/.test(l)).length).toBe(1)
    })
})
