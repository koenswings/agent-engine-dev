/**
 * app-clone-ref.test.ts: installing an App from a branch whose name contains '/'
 * (Atlas). The ref reaches git unchanged as one argument (after --branch, before
 * `--`), and the App master folder <appName>-<version> uses a folder-safe form.
 * A real git clone of a local repo (url insteadOf) proves the argv end to end.
 */
import { describe, it, expect } from 'vitest'
import os from 'os'
import { $, fs, path } from 'zx'
import { appCloneArgs, assertGitRef, versionDirName } from '../../src/data/Instance.js'

describe('App clone by branch name', () => {
    it('versionDirName: one safe path component, ref kept readable', () => {
        expect(versionDirName('feat/usb-sticks')).toBe('feat-usb-sticks')
        expect(versionDirName('kid/193/usb')).toBe('kid-193-usb')
        expect(versionDirName('1.0')).toBe('1.0')
        expect(versionDirName('v1.2+build')).toBe('v1.2+build')
        expect(versionDirName('a b')).toBe('a-b')
        for (const v of ['feat/x', 'a/../b', 'x/y/z']) expect(versionDirName(v)).not.toContain('/')
        expect(versionDirName('..')).toBe('ref')
    })
    it('assertGitRef accepts branch names with / and refuses option-like or invalid refs', () => {
        for (const ok of ['main', '1.0', 'feat/usb-sticks', 'kid/193/usb']) expect(() => assertGitRef(ok)).not.toThrow()
        for (const bad of ['', '-b', '--upload-pack=x', '/x', 'x/', 'a..b', 'a//b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'x.lock', 'a/.hidden', 'a@{1}', 'x.'])
            expect(() => assertGitRef(bad), bad).toThrow(/Invalid app version/)
    })
    it('appCloneArgs passes the ref intact, then -- before the URL', () => {
        expect(appCloneArgs('koenswings', 'nextcloud', 'feat/usb', '/tmp/apps/nextcloud'))
            .toEqual(['clone', '--branch', 'feat/usb', '--', 'https://github.com/koenswings/app-nextcloud', '/tmp/apps/nextcloud'])
    })
    it('a real git clone of a branch named feat/x works with these argv', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-clone-'))
        try {
            const src = path.join(tmp, 'src')
            await fs.ensureDir(src)
            const g = $({ cwd: src, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
            await g`git init -q -b main`
            await fs.writeFile(path.join(src, 'compose.yaml'), 'x-app: {}\n')
            await g`git add . && git commit -qm init`
            await g`git checkout -q -b feat/x`
            await fs.writeFile(path.join(src, 'branch.txt'), 'feat/x\n')
            await g`git add . && git commit -qm branch`
            const dest = path.join(tmp, 'apps', 'demo')
            const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${src}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/acct/app-demo' }
            await $({ env })`git ${appCloneArgs('acct', 'demo', 'feat/x', dest)}`.quiet()
            expect(await fs.readFile(path.join(dest, 'branch.txt'), 'utf-8')).toBe('feat/x\n')
            // the App master folder derived from the ref is a single component
            const master = path.join(tmp, 'apps', `demo-${versionDirName('feat/x')}`)
            await $`cp -fr ${dest}/. ${master}/`
            expect(await fs.pathExists(path.join(master, 'compose.yaml'))).toBe(true)
            expect(path.dirname(master)).toBe(path.join(tmp, 'apps'))
        } finally { await fs.remove(tmp) }
    })
})
