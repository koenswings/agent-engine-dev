/**
 * idea#412 / idea#411 export parity: this branch's idea-usage-export must
 * match the committed goldens in test/fixtures/usage-export-parity/.
 *
 * src/usage/ from feat/idea-usage-411 (agent-engine-dev#308) is not on this
 * branch. What #308 should add to assert the same goldens is written down in
 * test/fixtures/usage-export-parity/README.md.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fs, path, os } from 'zx'
import { spawn } from 'child_process'

const SCRIPT = path.resolve('script/build_image_assets/idea-usage-export')
const TREE = path.resolve('test/fixtures/usage-export-parity/tree')
const EXPECTED = path.resolve('test/fixtures/usage-export-parity/expected')

interface RunResult { exitCode: number | null, stdout: string, stderr: string }

const run = (root: string, args: string[]): Promise<RunResult> =>
    new Promise((resolve, reject) => {
        const proc = spawn(SCRIPT, args, {
            env: { ...process.env, IDEA_USAGE_ROOT: root, IDEA_USAGE_ENGINE: 'happy-zebra' },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', d => { stdout += d })
        proc.stderr.on('data', d => { stderr += d })
        proc.on('error', reject)
        proc.on('close', exitCode => resolve({ exitCode, stdout, stderr }))
    })

const snapshot = async (dir: string): Promise<string[]> => {
    const out: string[] = []
    const walk = async (d: string) => {
        const names = (await fs.readdir(d)).sort()
        for (const name of names) {
            const p = path.join(d, name)
            const st = await fs.lstat(p)
            out.push(`${path.relative(dir, p)} ${st.isDirectory() ? 'dir' : st.size}`)
            if (st.isDirectory() && !st.isSymbolicLink()) await walk(p)
        }
    }
    await walk(dir)
    return out
}

let root = ''
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-parity-'))
    await fs.copy(TREE, root)
})
afterEach(async () => { await fs.remove(root) })

describe('idea-usage-export parity goldens', () => {
    it('since matches the golden NDJSON byte-for-byte', async () => {
        const r = await run(root, ['since', '2026-11-11'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(await fs.readFile(path.join(EXPECTED, 'since-2026-11-11.ndjson'), 'utf8'))
        expect(r.stdout).not.toContain('2026-11-10')
        expect(r.stdout).not.toContain('2026-11-20')
        expect(r.stdout).toContain('"documentIds":["0123456789abcdef","fedcba9876543210"]')
        expect(r.stdout).not.toMatch(/"documents"/)
    })

    it('archive-and-clear matches the golden stdout and moves only strictly-before days', async () => {
        const settings = await fs.readFile(path.join(root, 'settings.json'), 'utf8')
        const r = await run(root, ['archive-and-clear', '--before', '2026-11-01'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(await fs.readFile(path.join(EXPECTED, 'archive-before-2026-11-01.ndjson'), 'utf8'))
        expect(await fs.pathExists(path.join(root, '2026-10-31'))).toBe(false)
        expect(await fs.pathExists(path.join(root, '2026-11-01', 'boundary.json'))).toBe(true)
        expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).toBe(settings)
        expect(await fs.pathExists(path.join(root, '.archive', '2026-11-01-20261101T000000Z', '2026-11-20', 'hidden.json'))).toBe(true)
        const stamps = (await fs.readdir(path.join(root, '.archive'))).filter(n => /^2026-11-01-\d{8}T\d{6}Z$/.test(n) && n !== '2026-11-01-20261101T000000Z')
        expect(stamps).toHaveLength(1)
        expect(await fs.pathExists(path.join(root, '.archive', stamps[0], '2026-10-31', 'old.json'))).toBe(true)
    })

    it('disabled path: empty stdout, stderr disabled, no writes (off and missing settings)', async () => {
        const disabledErr = await fs.readFile(path.join(EXPECTED, 'disabled.stderr.txt'), 'utf8')
        await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ usageMonitoring: 'off' }) + '\n')
        const before = await snapshot(root)
        for (const args of [['since', '2026-11-11'], ['archive-and-clear', '--before', '2026-11-01']]) {
            const r = await run(root, args)
            expect(r, args.join(' ')).toEqual({ exitCode: 10, stdout: '', stderr: disabledErr })
        }
        expect(await snapshot(root)).toEqual(before)

        await fs.remove(path.join(root, 'settings.json'))
        const missing = await run(root, ['since', '2026-11-11'])
        expect(missing).toEqual({ exitCode: 10, stdout: '', stderr: disabledErr })
        expect(await fs.pathExists(path.join(root, '2026-10-31', 'old.json'))).toBe(true)
        expect((await fs.readdir(path.join(root, '.archive'))).sort()).toEqual(['2026-11-01-20261101T000000Z'])
    })
})
