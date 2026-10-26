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
} from '../../src/install/deploymentRecord.js'
import { N_VERSION, PM2_VERSION, PM2_LOGROTATE_VERSION } from '../../src/data/Engine.js'

const ROOT = process.cwd()
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64)
const C = '0123456789abcdef0123456789abcdef01234567'

const base = () => ({
    'record.txt': `schema=idea-deployment-record/1\ncapturedUtc=2026-10-26T10:00:00Z\nhostname=one\nengineCommit=${C}\nnodeVersion=v22.20.0\n`,
    'apt.txt': 'avahi-daemon\t0.8-16\tarm64\ngit\t1:2.47.3-0+deb13u1\tarm64\n',
    'images.txt': 'koenswings/kolibri:1.0\tsha256:1\tkoenswings/kolibri@sha256:2\n',
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
        b['apt.txt'] = b['apt.txt'].split('\n').reverse().join('\n')
        expect(compareRecords(base(), b)).toEqual([])
        expect(formatDifferences([])).toContain('IDENTICAL')
    })
    it('reports a changed package version, file hash, image digest and commit', () => {
        const b = base()
        b['apt.txt'] = b['apt.txt'].replace('0.8-16', '0.8-17')
        b['files.sha256'] = b['files.sha256'].replace(`${SHA_A}  src/index.ts`, `${SHA_B}  src/index.ts`)
        b['images.txt'] = b['images.txt'].replace('sha256:2', 'sha256:3')
        b['record.txt'] = b['record.txt'].replace(C, C.replace('0', 'f'))
        const keys = compareRecords(base(), b).map(d => `${d.file}:${d.key}`).sort()
        expect(keys).toEqual(['apt.txt:avahi-daemon:arm64', 'files.sha256:src/index.ts', 'images.txt:koenswings/kolibri:1.0', 'record.txt:engineCommit'])
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
        expect(judgeSource({ commit: C, tags: ['v1.2', 'v1.1'], dirty: false, onMain: true })).toEqual({ ok: true, tag: 'v1.1', reasons: [] })
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
            const read = (d: string) => Object.fromEntries(['record.txt', 'apt.txt', 'images.txt', 'files.sha256', 'dist.sha256'].map(f => [f, fs.readFileSync(`${d}/${f}`, 'utf8')]))
            const a = read(`${tmp}/a`), b = read(`${tmp}/b`)
            expect(parseKeyValues(a['record.txt']).get('schema')).toBe('idea-deployment-record/1')
            expect(parseSha256(a['files.sha256']).has('package.json')).toBe(true)
            expect(compareRecords(a, b)).toEqual([])
            expect(findSecrets(a)).toEqual([])
        } finally { await fs.remove(tmp) }
    })
})

describe('kit Engine retro records (idea#322)', () => {
    for (const h of ['sunny-robin', 'happy-zebra', 'kind-panda']) {
        it(`${h}: adfd9d3, MORANGO edit recorded, unknowns marked, no secrets`, () => {
            const dir = path.join(ROOT, 'records/engines', h, 'retro-2026-10-18')
            const rec = fs.readFileSync(`${dir}/record.txt`, 'utf8')
            const kv = parseKeyValues(rec)
            expect(kv.get('engineCommit')).toBe('adfd9d354ffd83c5ecc0a9eea64a474eae08de8f')
            expect(kv.get('manualEdit.morango')).toContain('MORANGO_SYSTEM_ID')
            expect(rec).toContain(UNKNOWN)
            expect(findSecrets({ 'record.txt': rec })).toEqual([])
        })
    }
})
