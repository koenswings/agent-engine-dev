/**
 * idea#411 / idea#412: byte-identical export streams against the shared
 * usage-export-parity fixture (see test/fixtures/usage-export-parity/README.md).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT_DISABLED, EXIT_OK, runExport } from '../../src/usage/exportCmd.js'

const TREE = path.resolve('test/fixtures/usage-export-parity/tree')
const EXPECTED = path.resolve('test/fixtures/usage-export-parity/expected')

let tmp = ''
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-parity-'))
    fs.cpSync(TREE, tmp, { recursive: true })
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

async function run(argv: string[]) {
    let stdout = ''
    let stderr = ''
    const code = await runExport({
        argv,
        root: tmp,
        hostname: 'happy-zebra',
        stdout: { write: (s: string) => { stdout += s } },
        stderr: { write: (s: string) => { stderr += s } },
        now: () => new Date('2026-11-10T20:30:45Z'),
    })
    return { code, stdout, stderr }
}

describe('usage-export parity with idea#412 goldens', () => {
    it('since matches the golden NDJSON byte-for-byte', async () => {
        const r = await run(['since', '2026-11-11'])
        expect(r.code).toBe(EXIT_OK)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(fs.readFileSync(path.join(EXPECTED, 'since-2026-11-11.ndjson'), 'utf8'))
    })

    it('archive-and-clear matches the golden stdout and moves only strictly-before days', async () => {
        const settings = fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')
        const r = await run(['archive-and-clear', '--before', '2026-11-01'])
        expect(r.code).toBe(EXIT_OK)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(fs.readFileSync(path.join(EXPECTED, 'archive-before-2026-11-01.ndjson'), 'utf8'))
        expect(fs.existsSync(path.join(tmp, '2026-10-31'))).toBe(false)
        expect(fs.existsSync(path.join(tmp, '2026-11-01', 'boundary.json'))).toBe(true)
        expect(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')).toBe(settings)
        expect(fs.existsSync(path.join(tmp, '.archive', '2026-11-01-20261101T000000Z', '2026-11-20', 'hidden.json'))).toBe(true)
        // With the frozen `now` above the dest name is 2026-11-01-20261110T203045Z.
        expect(fs.existsSync(path.join(tmp, '.archive', '2026-11-01-20261110T203045Z', '2026-10-31', 'old.json'))).toBe(true)
    })

    it('disabled path: empty stdout, stderr disabled, no writes (off and missing settings)', async () => {
        const disabledErr = fs.readFileSync(path.join(EXPECTED, 'disabled.stderr.txt'), 'utf8')
        fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ usageMonitoring: 'off' }) + '\n')
        const before = snapshot(tmp)
        for (const argv of [['since', '2026-11-11'], ['archive-and-clear', '--before', '2026-11-01']]) {
            const r = await run(argv)
            expect(r).toEqual({ code: EXIT_DISABLED, stdout: '', stderr: disabledErr })
        }
        expect(snapshot(tmp)).toEqual(before)

        fs.rmSync(path.join(tmp, 'settings.json'))
        const missing = await run(['since', '2026-11-11'])
        expect(missing).toEqual({ code: EXIT_DISABLED, stdout: '', stderr: disabledErr })
        expect(fs.existsSync(path.join(tmp, '2026-10-31', 'old.json'))).toBe(true)
    })
})

function snapshot(dir: string): string[] {
    const out: string[] = []
    const walk = (d: string) => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name)
            const st = fs.lstatSync(p)
            out.push(`${path.relative(dir, p)} ${st.isDirectory() ? 'dir' : st.size}`)
            if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
        }
    }
    walk(dir)
    return out
}
