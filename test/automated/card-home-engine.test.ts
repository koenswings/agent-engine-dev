/**
 * card-home-engine.test.ts — idea-flash-card v4 --home (idea#203 §2): the flash helper
 * re-validates the home-Engine name as root, then (after the read-back matched, before
 * flush + power-off) runs idea-write-home-engine, which writes idea-home.txt =
 * "<name>.local\n" on FAT partition 1. The client image's idea-home-engine boot step
 * (koenswings/idea tools/client-image/files/idea-home-engine) reads the first line, drops
 * CR/tab/space, lower-cases, strips ".local" and accepts [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?.
 * The sandbox write of idea-home.txt itself is in idea-write-home-engine.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { fs, path } from 'zx'
import { HOME_ENGINE_NAME_RE } from '../../src/data/FlashCard.js'

const FLASH = path.join(process.cwd(), 'script/build_image_assets/idea-flash-card')
const WRITER = path.join(process.cwd(), 'script/build_image_assets/idea-write-home-engine')
const BAD = ['', 'Brave-Otter', 'brave otter', '-x', 'x-', 'a_b', '../x', 'x.local', 'a'.repeat(64), '$(id)', 'x;id']

describe('idea-flash-card --home (v4)', () => {
    const t = fs.readFileSync(FLASH, 'utf8')
    const block = t.slice(t.indexOf('# >>> home-check'), t.indexOf('# <<< home-check'))
    const check = (name: string | null) => spawnSync('bash', ['-c',
        `refuse() { echo "refused: $1: $2" >&2; exit 2; }; HOME_SET=${name === null ? 0 : 1}; HOMENAME="$1"\n${block}\necho PASSED`, 'x', name ?? ''],
        { encoding: 'utf8' })

    it('reports version 4; calls idea-write-home-engine after VERIFY and before flush; reports homeFile', () => {
        expect(spawnSync('bash', [FLASH, '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('idea-flash-card 4')
        expect(t).toMatch(/^HOME_WRITER=\/usr\/local\/sbin\/idea-write-home-engine$/m)
        const w = t.indexOf('"$HOME_WRITER" "$BYID" "$DEVPATH" "$SIZE" "$HOMENAME"')
        expect(w).toBeGreaterThan(t.indexOf('VERIFY_FAILED'))
        expect(w).toBeLessThan(t.indexOf('emit flushing'))
        expect(t).toContain('"homeFile":"%s"')
        expect(t).toContain('warning: HOME_FAILED:')
        expect(t).not.toMatch(/^\s*HOME=/m)   // never clobbers $HOME
    })
    it('valid names pass; no --home passes', () => {
        for (const n of ['brave-otter', 'idea04', 'a', 'a'.repeat(63)]) expect(check(n).stdout, n).toContain('PASSED')
        expect(check(null).stdout).toContain('PASSED')
    })
    it('bad names → BAD_ARGS (block and the real helper, before any device check)', () => {
        for (const n of BAD) {
            const r = check(n)
            expect(r.status, n).toBe(2)
            expect(r.stderr).toMatch(/^refused: BAD_ARGS: home/)
        }
        const base = ['--by-id', '/dev/disk/by-id/usb-Generic_X-0:0', '--expect-device', 'sdz', '--expect-size', '100',
            '--image', '/var/lib/idea/client-images/26.04-20261016-8be2435/idea-client-26.04-20261016-8be2435.img.xz', '--sha256', 'a'.repeat(64)]
        for (const n of ['Brave', '../x', '']) {
            const r = spawnSync('bash', [FLASH, ...base, '--home', n], { encoding: 'utf8' })
            expect(r.status, n).toBe(2)
            expect(r.stderr).toMatch(/^refused: BAD_ARGS: home/)
        }
    })
    it('Engine, flash helper and idea-write-home-engine use the same name rule', () => {
        const w = fs.readFileSync(WRITER, 'utf8')
        const rule = '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        expect(t).toContain(rule); expect(w).toContain(rule); expect(HOME_ENGINE_NAME_RE.source).toBe(rule.replace(/\//g, '\\/'))
        for (const n of BAD) expect(HOME_ENGINE_NAME_RE.test(n), n).toBe(false)
    })
    it('"<name>.local\\n" is what the client boot step accepts (its parse, reproduced)', () => {
        // tools/client-image/files/idea-home-engine: head -n1 | tr -d '\r\t ' | lower | ${N%.local} | grep -Eqx
        const r = spawnSync('sh', ['-c', `N=$(printf 'brave-otter.local\\n' | head -n 1 | tr -d '\\r\\t ' | tr 'A-Z' 'a-z'); N=\${N%.local}; printf '%s' "$N" | grep -Eqx '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?' && echo "$N"`], { encoding: 'utf8' })
        expect(r.stdout.trim()).toBe('brave-otter')
    })
})
