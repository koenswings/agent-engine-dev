/**
 * idea#411: src/usage/ must not import Automerge or store modules.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const USAGE_SRC = path.join(process.cwd(), 'src/usage')
const FORBIDDEN = [
    /@automerge/,
    /automerge-repo/,
    /\/data\/Store(\.js)?['"]/,
    /\/data\/Engine(\.js)?['"]/,
    /\/data\/CommandLog/,
    /\/data\/StoreIdentity/,
    /\/repo(\.js)?['"]/,
    /from ['"]\.\.\/data\//,
    /from ['"]\.\.\/repo/,
]

function walk(dir: string): string[] {
    const out: string[] = []
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) out.push(...walk(p))
        else if (ent.name.endsWith('.ts')) out.push(p)
    }
    return out
}

describe('src/usage isolation (idea#411)', () => {
    it('exists and contains TypeScript modules', () => {
        expect(fs.existsSync(USAGE_SRC)).toBe(true)
        expect(walk(USAGE_SRC).length).toBeGreaterThan(5)
    })
    it('does not import Automerge or store modules', () => {
        const hits: string[] = []
        for (const file of walk(USAGE_SRC)) {
            const text = fs.readFileSync(file, 'utf8')
            for (const re of FORBIDDEN) {
                if (re.test(text)) hits.push(`${path.relative(USAGE_SRC, file)} matches ${re}`)
            }
        }
        expect(hits).toEqual([])
    })
    it('does not call console.log', () => {
        const hits: string[] = []
        for (const file of walk(USAGE_SRC)) {
            const text = fs.readFileSync(file, 'utf8')
            if (/\bconsole\.log\s*\(/.test(text)) hits.push(path.relative(USAGE_SRC, file))
        }
        expect(hits).toEqual([])
    })
})
