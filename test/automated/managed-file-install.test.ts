/**
 * managed-file-install.test.ts — idea#284 part 2: installManagedFile / managedFileCurrent
 * against real files. The exec strips `sudo ` and installs as the current user, so the
 * real `cmp -s` + `stat -c '%a %U:%G'` check and `install -o -g -m` run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, statSync, chmodSync, rmSync, readFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { installManagedFile, managedFileCurrent } from '../../src/data/Engine.js'

const q = (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`
const cmds: string[] = []
const exec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const cmd = strings.reduce((a, s, i) => a + s + (i < vals.length ? q(vals[i]) : ''), '').replace(/\bsudo /g, '')
    cmds.push(cmd)
    return { stdout: execFileSync('bash', ['-c', cmd], { encoding: 'utf8' }) }
}
const user = userInfo().username
const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim()
let dir: string, src: string, dst: string
beforeEach(() => {
    cmds.length = 0
    dir = mkdtempSync(join(tmpdir(), 'managed-file-'))
    src = join(dir, 'asset'); dst = join(dir, 'installed')
    writeFileSync(src, 'v1\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('installManagedFile (idea#284 part 2)', () => {
    it('installs a missing file, then leaves it alone (same content, mode, owner): mtime does not move', async () => {
        expect(await installManagedFile(exec, src, dst, '0644', user, group)).toBe(true)
        expect(readFileSync(dst, 'utf8')).toBe('v1\n')
        expect((statSync(dst).mode & 0o777).toString(8)).toBe('644')
        const before = statSync(dst).mtimeMs
        await new Promise(r => setTimeout(r, 20))
        cmds.length = 0
        expect(await installManagedFile(exec, src, dst, '0644', user, group)).toBe(false)
        expect(statSync(dst).mtimeMs).toBe(before)
        expect(cmds.filter(c => /^install /.test(c))).toEqual([])
    })
    it('reinstalls when the content, the mode or the owner differs', async () => {
        await installManagedFile(exec, src, dst, '0755', user, group)
        expect(await managedFileCurrent(exec, src, dst, '0755', `${user}:${group}`)).toBe(true)
        writeFileSync(src, 'v2\n')
        expect(await managedFileCurrent(exec, src, dst, '0755', `${user}:${group}`)).toBe(false)
        expect(await installManagedFile(exec, src, dst, '0755', user, group)).toBe(true)
        expect(readFileSync(dst, 'utf8')).toBe('v2\n')
        chmodSync(dst, 0o700)
        expect(await managedFileCurrent(exec, src, dst, '0755', `${user}:${group}`)).toBe(false)
        expect(await installManagedFile(exec, src, dst, '0755', user, group)).toBe(true)
        expect((statSync(dst).mode & 0o777).toString(8)).toBe('755')
        expect(await managedFileCurrent(exec, src, dst, '0755', `nobody-x:${group}`)).toBe(false)
    })
    it('0440 (sudoers) compares as 440', async () => {
        await installManagedFile(exec, src, dst, '0440', user, group)
        expect((statSync(dst).mode & 0o777).toString(8)).toBe('440')
        expect(await managedFileCurrent(exec, src, dst, '0440', `${user}:${group}`)).toBe(true)
    })
})
