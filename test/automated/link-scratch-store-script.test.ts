/**
 * link-scratch-store-script.test.ts (engine#321)
 *
 * script/link-scratch-store.sh uses `ln -sfnT` and refuses when the
 * destination already exists as a non-symlink directory, so a scratch
 * checkout cannot nest store-identity (or store-data) inside itself.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = [path.resolve(here, '../../..'), path.resolve(here, '../..')].find(r =>
    fs.existsSync(path.join(r, 'script', 'link-scratch-store.sh')))!
const SCRIPT = path.join(repoRoot, 'script', 'link-scratch-store.sh')

const dirs: string[] = []
afterEach(() => {
    while (dirs.length) {
        const d = dirs.pop()
        if (d) fs.rmSync(d, { recursive: true, force: true })
    }
})

const tmp = (label: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `idea-321-${label}-`))
    dirs.push(d)
    return d
}

const run = (args: string[]): { code: number | null, out: string } => {
    const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const isSymlinkTo = (dest: string, src: string): void => {
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(src)
}

describe('script/link-scratch-store.sh (engine#321)', () => {
    it('creates a symlink with ln -sfnT when the destination is missing', () => {
        const srcDir = tmp('src')
        const destDir = tmp('dest')
        const src = path.join(srcDir, 'config.yaml')
        const dest = path.join(destDir, 'config.yaml')
        fs.writeFileSync(src, 'live: true\n')
        const r = run([src, dest])
        expect(r.code).toBe(0)
        isSymlinkTo(dest, src)
        expect(fs.readFileSync(dest, 'utf8')).toBe('live: true\n')
    })

    it('replaces an existing symlink, including one that points at a directory', () => {
        const srcDir = tmp('src')
        const otherDir = tmp('other')
        const destDir = tmp('dest')
        const src = path.join(srcDir, 'store-data')
        const other = path.join(otherDir, 'store-data')
        const dest = path.join(destDir, 'store-data')
        fs.mkdirSync(src)
        fs.mkdirSync(other)
        fs.writeFileSync(path.join(src, 'marker'), 'new')
        fs.writeFileSync(path.join(other, 'marker'), 'old')
        fs.symlinkSync(other, dest)
        const r = run([src, dest])
        expect(r.code).toBe(0)
        isSymlinkTo(dest, src)
        expect(fs.readFileSync(path.join(dest, 'marker'), 'utf8')).toBe('new')
        // The previous target is left alone
        expect(fs.existsSync(path.join(other, 'marker'))).toBe(true)
    })

    it('refuses when the destination exists as a non-symlink directory and does not nest a link', () => {
        const live = tmp('live')
        const scratch = tmp('scratch')
        const liveId = path.join(live, 'store-identity')
        const scratchId = path.join(scratch, 'store-identity')
        fs.mkdirSync(liveId)
        fs.writeFileSync(path.join(liveId, 'store-url.txt'), 'automerge:live\n')
        fs.mkdirSync(scratchId)
        fs.writeFileSync(path.join(scratchId, 'store-url.txt'), 'automerge:local\n')

        const r = run([liveId, scratchId])
        expect(r.code).toBe(2)
        expect(r.out).toMatch(/refuse: destination exists as a non-symlink directory/)
        expect(r.out).toMatch(/engine#321/)

        const st = fs.lstatSync(scratchId)
        expect(st.isDirectory()).toBe(true)
        expect(st.isSymbolicLink()).toBe(false)
        expect(fs.existsSync(path.join(scratchId, 'store-identity'))).toBe(false)
        expect(fs.readFileSync(path.join(scratchId, 'store-url.txt'), 'utf8')).toBe('automerge:local\n')
    })

    it('replaces a regular file destination (config.yaml)', () => {
        const src = path.join(tmp('src'), 'config.yaml')
        const dest = path.join(tmp('dest'), 'config.yaml')
        fs.writeFileSync(src, 'live: true\n')
        fs.writeFileSync(dest, 'scratch: true\n')
        const r = run([src, dest])
        expect(r.code).toBe(0)
        isSymlinkTo(dest, src)
        expect(fs.readFileSync(dest, 'utf8')).toBe('live: true\n')
    })

    it('--from/--to links the default names and still refuses a real store-identity directory', () => {
        const live = tmp('live')
        const scratch = tmp('scratch')
        fs.writeFileSync(path.join(live, 'config.yaml'), 'live: true\n')
        fs.mkdirSync(path.join(live, 'store-identity'))
        fs.writeFileSync(path.join(live, 'store-identity', 'store-url.txt'), 'automerge:live\n')
        fs.mkdirSync(path.join(live, 'store-data'))
        fs.writeFileSync(path.join(live, 'store-data', 'doc'), 'data')
        fs.writeFileSync(path.join(scratch, 'config.yaml'), 'scratch: true\n')
        fs.mkdirSync(path.join(scratch, 'store-identity'))
        fs.writeFileSync(path.join(scratch, 'store-identity', 'store-url.txt'), 'automerge:local\n')

        const r = run(['--from', live, '--to', scratch])
        expect(r.code).toBe(2)
        expect(r.out).toMatch(/refuse: destination exists as a non-symlink directory/)
        // Preflight refuses before any link is created, so config.yaml stays a regular file
        expect(fs.lstatSync(path.join(scratch, 'config.yaml')).isSymbolicLink()).toBe(false)
        expect(fs.readFileSync(path.join(scratch, 'config.yaml'), 'utf8')).toBe('scratch: true\n')
        const id = path.join(scratch, 'store-identity')
        expect(fs.lstatSync(id).isSymbolicLink()).toBe(false)
        expect(fs.readFileSync(path.join(id, 'store-url.txt'), 'utf8')).toBe('automerge:local\n')
        expect(fs.existsSync(path.join(id, 'store-identity'))).toBe(false)
        expect(fs.existsSync(path.join(scratch, 'store-data'))).toBe(false)
    })

    it('--from/--to links default names when the scratch tree has no store-identity directory', () => {
        const live = tmp('live')
        const scratch = tmp('scratch')
        fs.writeFileSync(path.join(live, 'config.yaml'), 'live: true\n')
        fs.mkdirSync(path.join(live, 'store-identity'))
        fs.writeFileSync(path.join(live, 'store-identity', 'store-url.txt'), 'automerge:live\n')
        fs.mkdirSync(path.join(live, 'store-data'))
        const r = run(['--from', live, '--to', scratch])
        expect(r.code).toBe(0)
        isSymlinkTo(path.join(scratch, 'config.yaml'), path.join(live, 'config.yaml'))
        isSymlinkTo(path.join(scratch, 'store-identity'), path.join(live, 'store-identity'))
        isSymlinkTo(path.join(scratch, 'store-data'), path.join(live, 'store-data'))
        expect(fs.readFileSync(path.join(scratch, 'store-identity', 'store-url.txt'), 'utf8')).toBe('automerge:live\n')
    })
})
