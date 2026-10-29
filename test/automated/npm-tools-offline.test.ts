/**
 * npm-tools-offline.test.ts (idea#322): archive-npm-tools.sh bundles pnpm, pm2 and pm2-logrotate with their
 * whole dependency trees from the committed lockfiles; then, with NO registry (unreachable registry, --offline,
 * empty cache), `npm install -g` into a temp prefix and `pm2 install` of pm2-logrotate must both work, and the
 * installed trees must be exactly the lockfiles. Pure JS, so any host works. Needs registry.npmjs.org for the
 * archive step; skipped when it is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { $, fs, path } from 'zx'
import os from 'os'
import { execSync } from 'child_process'

const REPO = path.resolve(__dirname, '../..')
const TOOLS = path.join(REPO, 'script/build_image_assets/npm-tools')
const online = (() => { try { execSync('npm view pm2@7.1.1 version --fetch-timeout=8000 --fetch-retries=0', { stdio: 'pipe', timeout: 15000 }); return true } catch { return false } })()

describe.skipIf(!online)('npm tools: archive, then install with no network', () => {
    let tmp: string, out: string, prefix: string, nodeBin: string, env: Record<string, string>
    beforeAll(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-tools-'))
        out = path.join(tmp, 'out'); prefix = path.join(tmp, 'prefix')
        await $({ quiet: true })`bash ${REPO}/script/archive-npm-tools.sh ${TOOLS} ${out}`
        // node + npm only on PATH (pm2 prefers bun when it finds one)
        nodeBin = path.join(tmp, 'nodebin'); await fs.ensureDir(nodeBin)
        await fs.symlink(process.execPath, path.join(nodeBin, 'node'))
        const npmCli = (await $({ quiet: true })`bash -c ${'readlink -f "$(command -v npm)"'}`).stdout.trim()
        await fs.symlink(npmCli, path.join(nodeBin, 'npm'))
        env = {
            PATH: `${prefix}/bin:${nodeBin}:/usr/bin:/bin`, HOME: tmp, PM2_HOME: path.join(tmp, 'pm2home'),
            npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: path.join(tmp, 'empty-cache'),
            npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
        }
    }, 300_000)
    afterAll(async () => {
        if (env) await $({ env, nothrow: true, quiet: true })`pm2 kill`
        if (tmp) await fs.remove(tmp)
    })

    it('archives byte-identical tarballs listed in NPM-TOOLS.tsv', async () => {
        const rows = (await fs.readFile(path.join(out, 'NPM-TOOLS.tsv'), 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'))
        expect(rows.map(r => r[0]).sort()).toEqual(['pm2', 'pm2-logrotate', 'pnpm'])
        for (const [, , tgz, sha] of rows) expect((await $({ quiet: true })`sha256sum ${path.join(out, tgz)}`).stdout.split(' ')[0]).toBe(sha)
        const again = path.join(tmp, 'again')
        await $({ quiet: true })`bash ${REPO}/script/archive-npm-tools.sh ${TOOLS} ${again}`
        expect(await fs.readFile(path.join(again, 'NPM-TOOLS.tsv'), 'utf8')).toBe(await fs.readFile(path.join(out, 'NPM-TOOLS.tsv'), 'utf8'))
    }, 300_000)

    it('npm install -g pnpm + pm2 offline; the installed trees are exactly the lockfiles', async () => {
        await $({ env, cwd: out, quiet: true })`npm install -g --prefix ${prefix} ./pnpm-10.33.0.tgz ./pm2-7.1.1.tgz`
        expect((await $({ env, quiet: true })`pnpm --version`).stdout.trim()).toBe('10.33.0')
        for (const name of ['pm2', 'pnpm']) {
            const lock = await fs.readJson(path.join(TOOLS, name, 'package-lock.json'))
            const want = Object.entries<any>(lock.packages).filter(([k, v]) => k && !v.optional && !v.dev)
            for (const [k, v] of want) {
                const pj = path.join(prefix, 'lib', k, 'package.json')
                expect(await fs.pathExists(pj), k).toBe(true)
                expect((await fs.readJson(pj)).version, k).toBe(v.version)
            }
            expect(want.length).toBeGreaterThan(0)
        }
        expect((await fs.readJson(path.join(prefix, 'lib/node_modules/pm2/package.json'))).version).toBe('7.1.1')
        expect(await fs.readdir(path.join(tmp, 'empty-cache', '_cacache')).catch(() => [])).not.toContain('index-v5-from-network')
    }, 180_000)

    it('pm2 install of the pm2-logrotate tarball works offline and the module comes online', async () => {
        await $({ env, quiet: true })`pm2 install ${path.join(out, 'pm2-logrotate-3.0.0.tgz')}`
        const list = JSON.parse((await $({ env, quiet: true })`pm2 jlist`).stdout)
        expect(list.map((p: any) => `${p.name}:${p.pm2_env.status}`)).toContain('pm2-logrotate:online')
    }, 180_000)
})
