/**
 * idea#335 (Engine half): the suite must never bind the ports a live Engine holds
 * (httpPort 80 / pool 8080, Automerge WS 4321). Tests use ephemeral ports
 * (listen(0) / freePort) so a port clash can never be why tests cannot run beside
 * a live Engine; where they may run is the idea#105 pre-flight's call (AGENTS.md).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

const ENGINE_PORTS = ['80', '4321', '8080']
const roots = ['test/automated', 'test/harness']

const files = (dir: string): string[] => readdirSync(dir).flatMap(n => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mts|mjs|js)$/.test(n) ? [p] : []
})

describe('idea#335 tests never bind a live Engine port', () => {
    it('no listen()/startAutomergeServer() on 80, 4321 or 8080 in test code', () => {
        const hits: string[] = []
        const portAlt = ENGINE_PORTS.join('|')
        const bind = new RegExp(`(\\.listen\\(\\s*(${portAlt})\\b|startAutomergeServer\\([^)]*,\\s*(${portAlt})\\b|port:\\s*(${portAlt})\\s*,\\s*host)`)
        for (const f of roots.flatMap(r => files(path.join(process.cwd(), r)))) {
            readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (bind.test(l)) hits.push(`${path.relative(process.cwd(), f)}:${i + 1}: ${l.trim()}`) })
        }
        expect(hits).toEqual([])
    })
    it('the pre-flight refusal says where Engine tests may run', () => {
        const s = readFileSync(path.join(process.cwd(), 'script/test-preflight.sh'), 'utf8')
        expect(s).toMatch(/Grok Bot box/)
        expect(s).toMatch(/pm2 stop engine/)
    })
})
