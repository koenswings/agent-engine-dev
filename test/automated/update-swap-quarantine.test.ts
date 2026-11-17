/**
 * update-swap-quarantine.test.ts — engine#506 (Steve's decision: Important, a separate small PR
 * after #505): updateApp's Swap moves the files the old bundle had and the new one dropped out of
 * the instance folder (helper v24 swap-quarantine, mv into .idea-quarantine, never rm) and
 * refreshes the instance's top-level SHA256SUMS from the new bundle.
 *
 *  (A) the pieces: sumsPaths, bundleTreeEntries, swapDroppedPaths, refreshInstanceSums, and the
 *      Engine's argv / stdin / output parsing for the helper (swapPathProblem mirrors its rules)
 *  (B) updateApp with injected deps (fake exec): v24 moves the dropped files before the copy;
 *      below v24 it warns and goes on; a helper failure rolls back; no SHA256SUMS = nothing moved
 *  (C) updateApp → the real helper in the sandbox (test/harness/appDataSandbox.ts)
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import {
    updateApp, UpdateDeps, copyBundle, sumsPaths, bundleTreeEntries, swapDroppedPaths, refreshInstanceSums,
} from '../../src/data/UpdateApp.js'
import {
    SWAP_QUARANTINE_HELPER_MIN, SWAP_PATHS_MAX, swapPathProblem, swapQuarantineArgs, swapQuarantineInput, parseSwapQuarantine,
    appDataErrorMessage, SwapQuarantineResult,
} from '../../src/utils/appDataHelper.js'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

const ME = String(localEngineId)
const H = (c: string) => c.repeat(64)
const OLD_TGZ = 'bundled-apps/richdocuments-v8.8.3.tar.gz'
const NEW_TGZ = 'bundled-apps/richdocuments-v9.2.3.tar.gz'
const USAGE_TGZ = 'bundled-apps/idea_usage-v1.0.0.tar.gz'
const sums = (paths: string[]) => paths.map((p, i) => `${H('0123456789abcdef'[i % 16])}  ${p}\n`).join('')

describe('(A) the pieces', () => {
    let tmp: string
    beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'swapq-a-')) })
    afterEach(async () => { await fs.remove(tmp) })

    it('sumsPaths reads text and binary lines, drops ./, skips escaped and malformed lines', () => {
        const text = [
            `${H('a')}  compose.yaml`,
            `${H('b')} *bundled-apps/x.tar.gz`,
            `${H('c')}  ./hooks/a.sh`,
            `${H('d')}  demo/content/Teacher Notes/About this demo.md`,
            `\\${H('e')}  weird\\nname`,
            'not a line',
            `${H('f')}  docs/crlf.md\r`,
            '',
        ].join('\n')
        expect(sumsPaths(text)).toEqual(['compose.yaml', 'bundled-apps/x.tar.gz', 'hooks/a.sh', 'demo/content/Teacher Notes/About this demo.md', 'docs/crlf.md'])
    })

    it('bundleTreeEntries lists files and links (never followed), not folders', async () => {
        await fs.outputFile(path.join(tmp, 'b', 'compose.yaml'), 'x')
        await fs.outputFile(path.join(tmp, 'b', 'hooks', 'a.sh'), 'x')
        await fs.ensureDir(path.join(tmp, 'b', 'empty'))
        await fs.symlink('hooks', path.join(tmp, 'b', 'link'))
        expect((await bundleTreeEntries(path.join(tmp, 'b'))).sort()).toEqual(['compose.yaml', 'hooks/a.sh', 'link'])
    })

    it('swapDroppedPaths: old SHA256SUMS minus the new bundle (its SHA256SUMS and its tree); data/, markers and odd names are skipped, never moved', async () => {
        const inst = path.join(tmp, 'inst'), bundle = path.join(tmp, 'bundle')
        await fs.outputFile(path.join(inst, 'SHA256SUMS'), sums(['compose.yaml', OLD_TGZ, USAGE_TGZ, 'data/seed.txt', '.idea-x', 'hooks/old.sh', 'hooks/kept-unlisted.sh', 'docs/a\\b.md', OLD_TGZ]))
        await fs.outputFile(path.join(bundle, 'SHA256SUMS'), sums(['compose.yaml', NEW_TGZ, USAGE_TGZ]))
        for (const p of ['compose.yaml', NEW_TGZ, USAGE_TGZ, 'hooks/kept-unlisted.sh']) await fs.outputFile(path.join(bundle, p), 'x')
        const r = await swapDroppedPaths(inst, bundle)
        expect(r.oldSums).toBe(true)
        expect(r.paths).toEqual([OLD_TGZ, 'hooks/old.sh'])
        expect(r.skipped.map(s => s.path).sort()).toEqual(['.idea-x', 'data/seed.txt', 'docs/a\\b.md'])
        expect(r.skipped.find(s => s.path === 'data/seed.txt')?.why).toBe('instance data (data/)')
    })

    it('swapDroppedPaths: no instance SHA256SUMS → nothing to compare', async () => {
        await fs.ensureDir(path.join(tmp, 'inst'))
        await fs.outputFile(path.join(tmp, 'bundle', 'compose.yaml'), 'x')
        expect(await swapDroppedPaths(path.join(tmp, 'inst'), path.join(tmp, 'bundle'))).toEqual({ oldSums: false, paths: [], skipped: [] })
    })

    it('refreshInstanceSums replaces the instance SHA256SUMS by rename; a bundle without one or a failed write is a reason, not a throw', async () => {
        const inst = path.join(tmp, 'inst'), bundle = path.join(tmp, 'bundle')
        await fs.outputFile(path.join(inst, 'SHA256SUMS'), 'old\n')
        await fs.ensureDir(bundle)
        expect(await refreshInstanceSums(bundle, inst)).toMatch(/has no SHA256SUMS/)
        expect(await fs.readFile(path.join(inst, 'SHA256SUMS'), 'utf8')).toBe('old\n')
        await fs.writeFile(path.join(bundle, 'SHA256SUMS'), 'new\n')
        expect(await refreshInstanceSums(bundle, inst)).toBeNull()
        expect(await fs.readFile(path.join(inst, 'SHA256SUMS'), 'utf8')).toBe('new\n')
        expect((await fs.readdir(inst)).sort()).toEqual(['SHA256SUMS'])
        expect(await refreshInstanceSums(bundle, path.join(tmp, 'missing'))).toMatch(/ENOENT/)
    })

    it('helper argv, stdin and output: exactly `swap-quarantine <root> <id>`, one path per line, v24', () => {
        expect(SWAP_QUARANTINE_HELPER_MIN).toBe(24)
        expect(swapQuarantineArgs('sdb2', 'nc1')).toEqual(['swap-quarantine', 'sdb2', 'nc1'])
        expect(() => swapQuarantineArgs('/disks/sdb2', 'nc1')).toThrow(/not a disk root/)
        expect(() => swapQuarantineArgs('sdb2', '../x')).toThrow(/not an instance id/)
        expect(swapQuarantineInput([OLD_TGZ, 'demo/a b.md'])).toBe(`${OLD_TGZ}\ndemo/a b.md\n`)
        expect(() => swapQuarantineInput(['data/x'])).toThrow(/instance data/)
        expect(() => swapQuarantineInput(Array(SWAP_PATHS_MAX + 1).fill('a'))).toThrow(/at most 4096/)
        for (const [p, why] of [['', 'empty'], ['/etc/x', 'absolute'], ['a/../b', "'..'"], ['./a', "'.'"], ['a//b', "'//'"], ['a/', "'/'"],
            ['a\nb', 'control'], ['a\\b', 'backslash'], ['.env', '.env'], ['SHA256SUMS', 'SHA256SUMS'], ['compose.yaml', 'compose.yaml'],
            ['.idea-update-in-flight', 'marker'], ['x'.repeat(1025), '1024']] as const) {
            expect(swapPathProblem(p), JSON.stringify(p)).toContain(why)
        }
        for (const p of [OLD_TGZ, 'hooks/compose.yaml', 'docs/.env', 'demo/content/Teacher Notes/About this demo.md', '-x']) expect(swapPathProblem(p), p).toBeNull()
        expect(parseSwapQuarantine('absent=docs/a.md\nquarantine=/disks/sdb2/.idea-quarantine/nc1-swap-dropped-20261117T140000Z\nmoved=a b/c.md\n'))
            .toEqual({ quarantine: '/disks/sdb2/.idea-quarantine/nc1-swap-dropped-20261117T140000Z', moved: ['a b/c.md'], absent: ['docs/a.md'] })
        expect(parseSwapQuarantine('quarantine=none\n')).toEqual({ quarantine: null, moved: [], absent: [] })
        expect(() => parseSwapQuarantine('moved=x\n')).toThrow(/no quarantine=/)
    })
})

// ── (B)/(C) updateApp ────────────────────────────────────────────────────────────────────
const composeYaml = (version: string) => YAML.stringify({
    services: { app: { image: 'nginx:1' } },
    'x-app': { name: 'demoapp', version, instanceName: 'Old', ...(version.startsWith('1.1') ? { updatesFrom: [1] } : {}) },
})
const OLD_APP = 'demoapp-1.0', NEW_APP = 'demoapp-1.1'

describe('(B)/(C) updateApp Swap with the dropped files', () => {
    let h: DocHandle<Store>, tmp: string, calls: string[], sb: AppDataSandbox | null
    const inst = () => h.doc().instanceDB['nc1' as any] as any
    const op = () => Object.values(h.doc().operationDB).filter(o => o.kind === 'updateApp').sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0]!
    const instDir = () => `${tmp}/instances/nc1`
    const bundleDir = () => `${tmp}/apps/${NEW_APP}`
    const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }
    let quarantined: string[][]

    /** a fake helper that moves like swap-quarantine does (rename into tmp/.idea-quarantine) */
    const fakeSwap = async (_disk: unknown, id: unknown, paths: string[]): Promise<SwapQuarantineResult> => {
        calls.push('swapQuarantine')
        quarantined.push(paths)
        const q = `${tmp}/.idea-quarantine/${id}-swap-dropped-20261117T140000Z`
        const moved: string[] = [], absent: string[] = []
        for (const p of paths) {
            if (!await fs.pathExists(`${instDir()}/${p}`)) { absent.push(p); continue }
            await fs.move(`${instDir()}/${p}`, `${q}/${p}`)
            moved.push(p)
        }
        return { quarantine: moved.length ? q : null, moved, absent }
    }

    const deps = (over: Partial<UpdateDeps> = {}): Partial<UpdateDeps> => ({
        helperProblem: async () => null,
        mountRoot: async () => tmp,
        verifySums: async () => true,
        fetch: async () => { throw new Error('no fetch expected') },
        estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * 1024 ** 3 }),
        dirBytes: async () => 10,
        copyBundle: async (src, dst) => { calls.push(`copyBundle:${path.basename(dst)}`); await copyBundle(src, dst) },
        swapQuarantineProblem: async () => null,
        swapQuarantine: fakeSwap,
        stop: async () => { calls.push('stop'); h.change(d => { (d.instanceDB['nc1' as any] as any).status = 'Stopped' }) },
        containerIds: async () => [],
        composeDown: async () => { calls.push('down') },
        snapshot: async () => { calls.push('snapshot'); return { path: `${tmp}/.pre-update/nc1`, sizeBytes: 4096, previousQuarantinedAt: null, volumes: [] } },
        restoreSnapshot: async () => { calls.push('restore'); await fs.writeFile(`${instDir()}/compose.yaml`, composeYaml('1.0')); return `${tmp}/.idea-quarantine/nc1-before-restore-x` },
        backup: async () => { calls.push('backup') },
        listSnapshots: async () => ({ snapshots: [], preUpdateBytes: 0, quarantineBytes: 0 }),
        reread: async () => {
            calls.push('reread')
            const v = YAML.parse(await fs.readFile(`${instDir()}/compose.yaml`, 'utf8'))['x-app'].version
            h.change(d => { (d.instanceDB['nc1' as any] as any).instanceOf = `demoapp-${v}` })
        },
        start: async () => { calls.push('start'); h.change(d => { (d.instanceDB['nc1' as any] as any).status = 'Running' }) },
        health: async () => ({ state: 'healthy', restartCount: 0 }),
        probe: async () => ({ status: 200, body: 'ok' }),
        broadcast: () => undefined,
        now: () => 1_700_000_000_000,
        sleep: async () => undefined,
        stopWaitMs: 1000, pollMs: 1,
        tempBackupProblem: async () => null,
        loadImages: async () => { calls.push('loadImages') },
        stepComposeFiles: async () => [],
        ...over,
    })

    const setup = async (root: string) => {
        tmp = root
        // the instance as the 1.0 install left it: the whole bundle with its SHA256SUMS, plus data/
        const oldFiles = ['compose.yaml', OLD_TGZ, USAGE_TGZ, 'hooks/old.sh', 'demo/Teacher Notes/old.md']
        await fs.outputFile(`${instDir()}/compose.yaml`, composeYaml('1.0'))
        for (const p of oldFiles.slice(1)) await fs.outputFile(`${instDir()}/${p}`, `old ${p}`)
        await fs.outputFile(`${instDir()}/SHA256SUMS`, sums(oldFiles))
        await fs.outputFile(`${instDir()}/.env`, 'port=50001\n')
        await fs.outputFile(`${instDir()}/data/seed.txt`, 'mine')
        // the 1.1 bundle dropped OLD_TGZ, hooks/old.sh and the demo note; ships NEW_TGZ
        const newFiles = ['compose.yaml', NEW_TGZ, USAGE_TGZ]
        await fs.outputFile(`${bundleDir()}/compose.yaml`, composeYaml('1.1'))
        for (const p of newFiles.slice(1)) await fs.outputFile(`${bundleDir()}/${p}`, `new ${p}`)
        await fs.outputFile(`${bundleDir()}/SHA256SUMS`, sums(newFiles))
        h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        h.change(doc => {
            doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'sdb2', dockedTo: ME, diskTypes: ['app'] } as any
            doc.instanceDB['nc1' as any] = {
                id: 'nc1', name: 'Old', storedOn: 'd1', instanceOf: OLD_APP, status: 'Running',
                port: 50001, lastBackup: 1_700_000_000_000, statusCondition: null,
            } as any
        })
    }
    beforeEach(() => { calls = []; quarantined = []; sb = null })
    afterEach(async () => { if (sb) await fs.remove(sb.tmp); else await fs.remove(tmp) })
    const update = (over: Partial<UpdateDeps> = {}) => updateApp(h, 'nc1', NEW_APP, ME, {}, deps(over))

    it('(B) v24: the dropped files leave before the copy, data/ and .env stay, SHA256SUMS becomes the new bundle\'s, the op records it', async () => {
        await setup(await fs.mkdtemp(path.join(os.tmpdir(), 'swapq-b-')))
        const r = await update()
        expect(r.steps).toContain('Swap')
        expect(quarantined).toEqual([[OLD_TGZ, 'demo/Teacher Notes/old.md', 'hooks/old.sh']])
        expect(calls.indexOf('swapQuarantine')).toBeLessThan(calls.indexOf('copyBundle:nc1'))
        expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('swapQuarantine'))
        for (const p of [OLD_TGZ, 'hooks/old.sh', 'demo/Teacher Notes/old.md']) expect(await fs.pathExists(`${instDir()}/${p}`), p).toBe(false)
        expect(await fs.readFile(`${instDir()}/${NEW_TGZ}`, 'utf8')).toBe(`new ${NEW_TGZ}`)
        expect(await fs.readFile(`${instDir()}/data/seed.txt`, 'utf8')).toBe('mine')
        expect(await fs.readFile(`${instDir()}/.env`, 'utf8')).toBe('port=50001\n')
        expect(await fs.readFile(`${instDir()}/SHA256SUMS`, 'utf8')).toBe(await fs.readFile(`${bundleDir()}/SHA256SUMS`, 'utf8'))
        expect(inst().instanceOf).toBe(NEW_APP)
        expect(op().status).toBe('Done')
        expect(op().args).toMatchObject({ swapDropped: '3', swapQuarantine: `${tmp}/.idea-quarantine/nc1-swap-dropped-20261117T140000Z` })
        // the next update compares against 1.1's list: nothing more to drop
        expect((await swapDroppedPaths(instDir(), bundleDir())).paths).toEqual([])
    })

    it('(B) below v24: warns, moves nothing, the update still passes and SHA256SUMS is still refreshed', async () => {
        await setup(await fs.mkdtemp(path.join(os.tmpdir(), 'swapq-b-')))
        let called = false
        const r = await update({ swapQuarantineProblem: async () => "... needs ... v24 or later, but the installed one reports 'idea-app-data 21'", swapQuarantine: async () => { called = true; throw new Error('must not run') } })
        expect(called).toBe(false)
        expect(r.steps).toContain('Health')
        expect(op().status).toBe('Done')
        expect(await fs.pathExists(`${instDir()}/${OLD_TGZ}`)).toBe(true)
        expect(await fs.readFile(`${instDir()}/SHA256SUMS`, 'utf8')).toBe(await fs.readFile(`${bundleDir()}/SHA256SUMS`, 'utf8'))
        expect(op().args).toMatchObject({ swapDropped: '3', swapQuarantine: 'skipped: HELPER_OUTDATED' })
    })

    it('(B) v24 and the helper fails: ROLLED BACK inside Swap, before the new bundle is copied, old version restarted', async () => {
        await setup(await fs.mkdtemp(path.join(os.tmpdir(), 'swapq-b-')))
        const m = await codeOf(update({ swapQuarantine: async () => { calls.push('swapQuarantine'); throw new Error('idea-app-data swap-quarantine refused: quarantine folder /disks/sdb2/.idea-quarantine must be owned by root (got uid 1000)') } }))
        expect(m).toMatch(/^ROLLED BACK: Swap failed: the 3 file\(s\) the new bundle dropped could not be moved to quarantine \(engine#506\): idea-app-data swap-quarantine refused: quarantine folder .* must be owned by root/)
        expect(calls).not.toContain('copyBundle:nc1')
        expect(calls.slice(-4)).toEqual(['down', 'restore', 'reread', 'start'])
        expect(inst().instanceOf).toBe(OLD_APP)
        expect(op().args.committed).toBeUndefined()
    })

    it('(B) an instance without SHA256SUMS: no helper call, the copy still happens and SHA256SUMS is written', async () => {
        await setup(await fs.mkdtemp(path.join(os.tmpdir(), 'swapq-b-')))
        await fs.remove(`${instDir()}/SHA256SUMS`)
        let called = false
        await update({ swapQuarantineProblem: async () => { called = true; return null }, swapQuarantine: async () => { called = true; throw new Error('must not run') } })
        expect(called).toBe(false)
        expect(await fs.pathExists(`${instDir()}/${OLD_TGZ}`)).toBe(true)
        expect(await fs.readFile(`${instDir()}/SHA256SUMS`, 'utf8')).toBe(await fs.readFile(`${bundleDir()}/SHA256SUMS`, 'utf8'))
        expect(op().args.swapQuarantine).toBeUndefined()
    })

    it('(C) updateApp → the real helper (sandbox): the dropped files land in <root>/.idea-quarantine/nc1-swap-dropped-<stamp>/', async () => {
        sb = await makeAppDataSandbox()
        const root = await sb.addDisk('sdb2')
        await setup(root)
        const s = sb
        await update({
            swapQuarantine: async (_disk, id, paths) => {
                calls.push('swapQuarantine')
                const r = await s.run(swapQuarantineArgs('sdb2', String(id)), { FAKE_STDIN: swapQuarantineInput(paths) })
                if (r.exitCode !== 0) throw new Error(appDataErrorMessage('swap-quarantine', r.exitCode, null, r.stderr))
                return parseSwapQuarantine(r.stdout)
            },
        })
        const q = op().args.swapQuarantine as string
        expect(q).toMatch(new RegExp(`/\\.idea-quarantine/nc1-swap-dropped-\\d{8}T\\d{6}Z$`))
        expect(await fs.readFile(path.join(q, OLD_TGZ), 'utf8')).toBe(`old ${OLD_TGZ}`)
        expect(await fs.readFile(path.join(q, 'demo/Teacher Notes/old.md'), 'utf8')).toBe('old demo/Teacher Notes/old.md')
        expect(await fs.pathExists(`${instDir()}/${OLD_TGZ}`)).toBe(false)
        expect(await fs.readFile(`${instDir()}/data/seed.txt`, 'utf8')).toBe('mine')
        expect((await fs.readdir(`${instDir()}/bundled-apps`)).sort()).toEqual(['idea_usage-v1.0.0.tar.gz', 'richdocuments-v9.2.3.tar.gz'])
        expect(await sb.journalText()).toMatch(/swap-quarantine: 3 file\(s\) the new bundle dropped/)
    })
})
