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
