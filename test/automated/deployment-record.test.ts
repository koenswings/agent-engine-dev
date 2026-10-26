/**
 * deployment-record.test.ts — reproducible Engine installs (idea#322).
 *
 * Unit level, runs on the box (no Pi): record parsing and comparison, the
 * secret check, the build-engine source gate, the pins in Engine.ts, the
 * read-only capture script and the committed kit retro records.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import os from 'os'
import { fs, $ } from 'zx'
import {
    compareRecords, findSecrets, judgeSource, parseApt, parseKeyValues, parseSha256, formatDifferences, UNKNOWN,
    validateRecord, setKeys, isEngineTag, REQUIRED_KEYS,
} from '../../src/install/deploymentRecord.js'
import {
    N_VERSION, PM2_VERSION, PM2_LOGROTATE_VERSION, TAILSCALE_VERSION, TAILSCALE_ARM64_SHA256, tailscaleDownloadScript,
    DEBIAN_SNAPSHOT, DEBIAN_SNAPSHOT_SOURCES, parseAptPins,
} from '../../src/data/Engine.js'

const ROOT = process.cwd()
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64)
const C = '0123456789abcdef0123456789abcdef01234567'

const base = () => ({
    'record.txt': `schema=idea-deployment-record/1\ncapturedUtc=2026-10-26T10:00:00Z\nhostname=one\nengineCommit=${C}\nnodeVersion=v22.20.0\n`,
    'packages.tsv': 'avahi-daemon\t0.8-16\tarm64\ngit\t1:2.47.3-0+deb13u1\tarm64\n',
    'images.tsv': 'koenswings/kolibri:1.0\tsha256:1\tkoenswings/kolibri@sha256:2\n',
    'files.sha256': `${SHA_A}  src/index.ts\n${SHA_B}  package.json\n`,
    'dist.sha256': `${SHA_A}  src/index.js\n`,
})

describe('record parsing (idea#322)', () => {
    it('parses key=value, apt and sha256 lines and ignores comments', () => {
        expect(parseKeyValues('# c\na=1\nb = x=y\n').get('b')).toBe('x=y')
        expect(parseApt('git\t1:2.47\tarm64\n').get('git:arm64')).toBe('1:2.47')
        expect(parseSha256(`${SHA_A}  a b.txt\n`).get('a b.txt')).toBe(SHA_A)
    })
})

describe('compareRecords (idea#322)', () => {
    it('treats two installs with only volatile differences as content-identical', () => {
        const b = base(); b['record.txt'] = b['record.txt'].replace('hostname=one', 'hostname=two').replace('10:00:00', '11:11:11')
        b['packages.tsv'] = b['packages.tsv'].split('\n').reverse().join('\n')
        expect(compareRecords(base(), b)).toEqual([])
        expect(formatDifferences([])).toContain('IDENTICAL')
    })
    it('reports a changed package version, file hash, image digest and commit', () => {
        const b = base()
        b['packages.tsv'] = b['packages.tsv'].replace('0.8-16', '0.8-17')
        b['files.sha256'] = b['files.sha256'].replace(`${SHA_A}  src/index.ts`, `${SHA_B}  src/index.ts`)
        b['images.tsv'] = b['images.tsv'].replace('sha256:2', 'sha256:3')
        b['record.txt'] = b['record.txt'].replace(C, C.replace('0', 'f'))
        const keys = compareRecords(base(), b).map(d => `${d.file}:${d.key}`).sort()
        expect(keys).toEqual(['files.sha256:src/index.ts', 'images.tsv:koenswings/kolibri:1.0', 'packages.tsv:avahi-daemon:arm64', 'record.txt:engineCommit'])
    })
    it('reports added and missing files and a missing record file', () => {
        const b = base(); b['files.sha256'] += `${SHA_A}  extra.ts\n`; delete (b as any)['dist.sha256']
        const d = compareRecords(base(), b)
        expect(d.find(x => x.key === 'extra.ts')?.expected).toBeUndefined()
        expect(d.find(x => x.file === 'dist.sha256')?.key).toBe('<file>')
    })
    it('never counts UNKNOWN (retro) values and honours ignore options', () => {
        const a = base(); a['record.txt'] = a['record.txt'].replace('nodeVersion=v22.20.0', `nodeVersion=${UNKNOWN}`)
        const b = base(); b['record.txt'] = b['record.txt'].replace('v22.20.0', 'v22.21.0'); b['files.sha256'] += `${SHA_A}  store-identity/x\n`
        expect(compareRecords(a, b, { ignorePaths: ['store-identity/'] })).toEqual([])
    })
})

describe('findSecrets (idea#322: records carry no secrets)', () => {
    it('is clean for a normal record and flags auth keys, private keys and passwords', () => {
        expect(findSecrets(base())).toEqual([])
        expect(findSecrets({ 'record.txt': 'x=tskey-auth-abc123' })).toHaveLength(1)
        expect(findSecrets({ 'record.txt': '-----BEGIN OPENSSH PRIVATE KEY-----' })).toHaveLength(1)
        expect(findSecrets({ 'record.txt': 'password=raspberry' })).toHaveLength(1)
    })
})

describe('judgeSource (idea#322 build gate)', () => {
    it('accepts a clean tagged commit on main and names the tag', () => {
        expect(judgeSource({ commit: C, tags: ['engine-v2026.10.27', 'engine-v2026.10.27-2', 'other'], dirty: false, onMain: true }))
            .toEqual({ ok: true, tag: 'engine-v2026.10.27-2', reasons: [] })
    })
    it('only engine-vYYYY.MM.DD[-N] tags count', () => {
        for (const t of ['engine-v2026.10.27', 'engine-v2026.01.01-1', 'engine-v2026.12.31-12']) expect(isEngineTag(t)).toBe(true)
        for (const t of ['v1.0', 'engine-v2026.13.01', 'engine-v2026.10.1', 'engine-v2026.10.27-0', 'kit-adfd9d3-archive', 'engine-v2026.10.27-rc1'])
            expect(isEngineTag(t)).toBe(false)
        const v = judgeSource({ commit: C, tags: ['kit-adfd9d3-archive'], dirty: false, onMain: true })
        expect(v.ok).toBe(false)
        expect(v.reasons[0]).toContain('engine-vYYYY.MM.DD')
    })
    it('refuses untagged, dirty or off-main trees unless allowed, and always lists why', () => {
        const s = { commit: C, tags: [], dirty: true, onMain: false }
        const v = judgeSource(s)
        expect(v.ok).toBe(false)
        expect(v.reasons).toHaveLength(3)
        expect(judgeSource(s, true)).toMatchObject({ ok: true, reasons: v.reasons })
    })
})

describe('build-engine pins (idea#322)', () => {
    const engine = fs.readFileSync(path.join(ROOT, 'src/data/Engine.ts'), 'utf8')
    it('installs the Engine from the frozen lockfile and pins global npm tools', () => {
        expect(engine).toContain('pnpm install --frozen-lockfile')
        expect(engine).toMatch(/npm install -g -y n@\$\{N_VERSION\}/)
        expect(engine).toMatch(/npm install -g pm2@\$\{PM2_VERSION\}/)
        expect(engine).toMatch(/pm2-logrotate@\$\{PM2_LOGROTATE_VERSION\}/)
        for (const v of [N_VERSION, PM2_VERSION, PM2_LOGROTATE_VERSION]) expect(v).toMatch(/^\d+\.\d+\.\d+$/)
    })
    it('build-engine gates on the source and writes a deployment record', () => {
        const be = fs.readFileSync(path.join(ROOT, 'script/build-engine.ts'), 'utf8')
        expect(be).toContain('judgeSource(')
        expect(be).toContain('--allow-untagged')
        expect(be).toContain('capture-engine-record.sh')
        expect(be).toContain('deployments/engines/')
        expect(be).not.toMatch(/records\/engines/)
    })
    it('pins Tailscale to a version and sha256 checked before install', () => {
        expect(TAILSCALE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
        expect(TAILSCALE_ARM64_SHA256).toMatch(/^[0-9a-f]{64}$/)
        const sh = tailscaleDownloadScript()
        expect(sh).toContain(`tailscale_${TAILSCALE_VERSION}_arm64.tgz`)
        expect(sh.indexOf('sha256sum -c')).toBeLessThan(sh.indexOf('sudo tar'))
        expect(sh).not.toContain('grep -oP')
        expect(engine).toContain('tailscaleDownloadScript()')
    })
    it('points Debian apt at a dated snapshot and reads the Raspberry Pi pins', () => {
        expect(DEBIAN_SNAPSHOT).toMatch(/^\d{8}T\d{6}Z$/)
        const src = DEBIAN_SNAPSHOT_SOURCES('trixie')
        expect(src).toContain(`https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/`)
        expect(src).toContain(`https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/`)
        expect(src).toContain('Suites: trixie-security')
        expect(src).not.toContain('deb.debian.org')
        expect(parseAptPins('# c\nchromium\t1:155-1+rpt1\n\nbad\n')).toEqual([{ pkg: 'chromium', version: '1:155-1+rpt1' }])
        expect(engine.indexOf('await pinAptSnapshot(exec)')).toBeLessThan(engine.indexOf('await updateSystem(exec)'))
        expect(fs.existsSync(path.join(ROOT, 'script/build_image_assets/apt-rpi-pins.tsv'))).toBe(true)
    })
    it('has one install path: install.sh only wraps build-engine; install_packages is frozen', () => {
        const inst = fs.readFileSync(path.join(ROOT, 'script/install.sh'), 'utf8')
        expect(inst).toMatch(/exec \.\/build-engine "\$@"/)
        expect(inst).not.toMatch(/apt-get|npm install -g|\bn 20\b|git clone https:\/\/github.com\/koenswings\/engine/m)
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
        expect(pkg.scripts.install_packages).toBe('pnpm install --frozen-lockfile')
    })
})

describe('capture-engine-record.sh (read-only)', () => {
    const script = path.join(ROOT, 'script/capture-engine-record.sh')
    it('refuses an output folder outside /tmp and has no write/install/restart commands', async () => {
        const r = await $({ nothrow: true })`bash ${script} --out ${path.join(ROOT, 'x-record')}`
        expect(r.exitCode).toBe(2)
        expect(fs.existsSync(path.join(ROOT, 'x-record'))).toBe(false)
        const body = fs.readFileSync(script, 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
        expect(body).not.toMatch(/\bsudo\b|apt(-get)? install|npm install|pm2 (restart|start|stop|save)|systemctl|docker (pull|run|rm|load)|\/etc\/tailscale|\.ssh/)
    })
    it('captures a record of this checkout whose two captures are content-identical and secret-free', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-rec'))
        try {
            for (const l of ['a', 'b']) await $`bash ${script} --engine-dir ${ROOT} --out ${tmp}/${l} --label ${l}`
            const read = (d: string) => Object.fromEntries(['record.txt', 'packages.tsv', 'images.tsv', 'files.sha256', 'dist.sha256'].map(f => [f, fs.readFileSync(`${d}/${f}`, 'utf8')]))
            const a = read(`${tmp}/a`), b = read(`${tmp}/b`)
            expect(parseKeyValues(a['record.txt']).get('schema')).toBe('idea-deployment-record/1')
            expect(parseSha256(a['files.sha256']).has('package.json')).toBe(true)
            expect(compareRecords(a, b)).toEqual([])
            expect(findSecrets(a)).toEqual([])
            expect(validateRecord(a['record.txt'])).toEqual([])
        } finally { await fs.remove(tmp) }
    })
})

describe('idea deployments/ schema (idea#323)', () => {
    const full = REQUIRED_KEYS.map(k => `${k}=${k === 'schema' ? 'idea-deployment-record/1' : k === 'deviceType' ? 'engine' : 'x'}`).join('\n') + '\nhostname=h\n'
    it('accepts a complete Engine record and names what is missing or wrong', () => {
        expect(validateRecord(full)).toEqual([])
        expect(validateRecord(full.replace(/^batch=.*$/m, ''))).toEqual(['missing batch'])
        expect(validateRecord(full.replace('hostname=h', ''))).toContain('missing hostname/stickerName/cardId')
        expect(validateRecord(full.replace('deviceType=engine', 'deviceType=router'))).toContain('deviceType is router, expected engine')
    })
    it('setKeys replaces keys in place and appends new ones', () => {
        expect(setKeys('a=1\nb=2\n', ['b=3', 'c=4'])).toBe('a=1\nb=3\nc=4\n')
    })
})

describe('release-archive.sh (prep only, never publishes)', () => {
    it('splits an archive into parts that restore to the original and writes unrun gh commands', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-rel'))
        try {
            await fs.mkdirp(`${tmp}/arc/sub`)
            await fs.writeFile(`${tmp}/arc/sub/blob`, Buffer.alloc(300_000, 7))
            await $({ env: { ...process.env, PART_SIZE: '100k' } })`bash ${path.join(ROOT, 'script/release-archive.sh')} t-1 ${C} ${tmp}/arc ${tmp}/rel`
            const parts = (await fs.readdir(`${tmp}/rel`)).filter(f => f.startsWith('t-1.tar.part-'))
            expect(parts.length).toBeGreaterThan(2)
            await $({ cwd: `${tmp}/rel` })`sha256sum -c --ignore-missing SHA256SUMS`
            await $({ cwd: `${tmp}/rel` })`bash -c ${'cat t-1.tar.part-* > t-1.tar && grep " t-1.tar$" SHA256SUMS | sha256sum -c - && mkdir x && tar -xf t-1.tar -C x'}`
            expect((await fs.readFile(`${tmp}/rel/x/arc/sub/blob`)).length).toBe(300_000)
            const gh = await fs.readFile(`${tmp}/rel/gh-commands.sh`, 'utf8')
            expect(gh).toContain('NOT RUN')
            expect(gh).toContain(`tag -a t-1 ${C}`)
            expect(gh).toContain('gh release create t-1 --repo koenswings/agent-engine-dev --verify-tag')
        } finally { await fs.remove(tmp) }
    })
})
