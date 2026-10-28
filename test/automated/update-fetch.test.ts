/**
 * update-fetch.test.ts — cross-Engine Fetch for updateApp (agent-engine-dev#263): the target's
 * .idea-fetching/.idea-fetched markers, refusal of pushed .idea-* files, SHA256SUMS re-check,
 * partial folders moved aside; the source's rsync --partial with 3 retries and backoff, and
 * the thermal pause (fetchPaused). Peers, rsync and temperature are injected fakes.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { fs, path, os } from 'zx'
import {
    fetchBundle, FetchTargetDeps, handleAppFetchResult, isUnfinishedFetch, pushAppBundle, PushDeps,
    FETCH_RETRIES, THERMAL_PAUSE_C, FETCHED_MARKER, FETCHING_MARKER,
} from '../../src/data/UpdateFetch.js'
import { rsyncToPeerArgs } from '../../src/utils/rsync.js'
import type { UpdateProgress } from '../../src/data/UpdateApp.js'

let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fetch-')) })
afterEach(async () => { await fs.remove(tmp) })

const src = { id: 'r1', name: 'r1', device: 'sdb1', dockedTo: 'eng-b' } as any
const dst = { id: 'd1', name: 'd1', device: 'sda1', dockedTo: 'eng-a' } as any
const req = { localEngineId: 'eng-a', instanceId: 'i1', newAppId: 'kolibri-1.1', sourceDisk: src, targetDisk: dst }
const appsDir = () => path.join(tmp, 'apps')

/** A source that "pushes" `files` into the target folder, then answers `status`. */
const targetDeps = (files: Record<string, string>, status = 'ok', over: Partial<FetchTargetDeps> = {}) => {
    const sent: string[] = []
    const d: FetchTargetDeps = {
        mountRoot: async () => tmp, rootToken: async () => 'sda1',
        send: (_e, cmd) => {
            sent.push(cmd)
            const id = cmd.split(' ')[5]
            setTimeout(async () => {
                for (const [n, c] of Object.entries(files)) await fs.outputFile(path.join(appsDir(), 'kolibri-1.1', n), c)
                handleAppFetchResult(id, status, status === 'ok' ? [] : ['rsync', 'broke'])
            }, 1)
        },
        verifySums: async (dir) => (await fs.readFile(path.join(dir, 'compose.yaml'), 'utf8').catch(() => '')) === 'good',
        newId: () => 'req-1', now: () => Date.UTC(2026, 9, 28, 14), timeoutMs: 5000, ...over,
    }
    return { d, sent }
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }
const aside = async () => (await fs.readdir(appsDir())).filter(n => n.startsWith('.idea-aborted-kolibri-1.1-'))

describe('fetchBundle (target side, #263)', () => {
    it('asks the source Engine to push, re-checks SHA256SUMS, then renames .idea-fetching to .idea-fetched', async () => {
        const { d, sent } = targetDeps({ 'compose.yaml': 'good', SHA256SUMS: 'x' })
        const dir = await fetchBundle(req, d)
        expect(dir).toBe(path.join(appsDir(), 'kolibri-1.1'))
        expect(sent).toEqual(['pushAppBundle r1 kolibri-1.1 eng-a sda1 req-1 i1'])
        expect(await fs.pathExists(path.join(dir, FETCHED_MARKER))).toBe(true)
        expect(await fs.pathExists(path.join(dir, FETCHING_MARKER))).toBe(false)
        expect(await isUnfinishedFetch(dir)).toBe(false)
        // a finished, valid Fetch is reused without asking again
        const again = targetDeps({})
        expect(await fetchBundle(req, again.d)).toBe(dir)
        expect(again.sent).toEqual([])
    })
    it('while the push runs the folder is an unfinished Fetch (dock and listing skip it)', async () => {
        let during: boolean | null = null
        const { d } = targetDeps({ 'compose.yaml': 'good' })
        const send = d.send
        d.send = (e, c) => { void isUnfinishedFetch(path.join(appsDir(), 'kolibri-1.1')).then(v => { during = v }); send(e, c) }
        await fetchBundle(req, d)
        expect(during).toBe(true)
    })
    it('refuses pushed bundle-root .idea-* files: TRANSFER_FAILED, folder moved aside (never removed)', async () => {
        const { d } = targetDeps({ 'compose.yaml': 'good', '.idea-fetched': 'forged' })
        expect(await code(fetchBundle(req, d))).toMatch(/^TRANSFER_FAILED: the source pushed bundle-root \.idea-fetched; refused; the partial folder was moved aside to .*\.idea-aborted-kolibri-1\.1-/)
        expect(await fs.pathExists(path.join(appsDir(), 'kolibri-1.1'))).toBe(false)
        const [a] = await aside()
        expect(await fs.readFile(path.join(appsDir(), a, 'compose.yaml'), 'utf8')).toBe('good')
    })
    it('a changed .idea-fetching marker, a SHA256SUMS mismatch, or a source failure: TRANSFER_FAILED, moved aside', async () => {
        expect(await code(fetchBundle(req, targetDeps({ 'compose.yaml': 'good', [FETCHING_MARKER]: 'other' }).d))).toMatch(/^TRANSFER_FAILED: \.idea-fetching was changed/)
        expect(await code(fetchBundle(req, targetDeps({ 'compose.yaml': 'bad' }, 'ok', { now: () => 1 }).d))).toMatch(/^TRANSFER_FAILED: the fetched bundle does not match its SHA256SUMS/)
        expect(await code(fetchBundle(req, targetDeps({}, 'TRANSFER_FAILED', { now: () => 2 }).d))).toMatch(/^TRANSFER_FAILED: rsync broke; the partial folder was moved aside/)
        expect((await aside()).length).toBe(3)
    })
    it('no answer in time: TRANSFER_FAILED; a stale unfinished Fetch is moved aside first; a normal folder is never overwritten', async () => {
        const silent = targetDeps({}, 'ok', { send: () => {}, timeoutMs: 20 })
        expect(await code(fetchBundle(req, silent.d))).toMatch(/^TRANSFER_FAILED: no answer from Engine eng-b/)
        await fs.outputFile(path.join(appsDir(), 'kolibri-1.1', FETCHING_MARKER), 'old')
        await fs.outputFile(path.join(appsDir(), 'kolibri-1.1', 'half'), 'x')
        const { d } = targetDeps({ 'compose.yaml': 'good' }, 'ok', { now: () => 5 })
        await fetchBundle(req, d)
        expect(await fs.pathExists(path.join(appsDir(), 'kolibri-1.1', 'half'))).toBe(false)
        expect((await aside()).length).toBe(2)
        await fs.remove(path.join(appsDir(), 'kolibri-1.1', FETCHED_MARKER))
        expect(await code(fetchBundle(req, targetDeps({}).d))).toMatch(/^TRANSFER_FAILED: .* is not a finished Fetch; not overwriting it/)
        expect(await code(fetchBundle({ ...req, sourceDisk: { ...src, dockedTo: null } }, targetDeps({}).d))).toMatch(/^SOURCE_MISSING/)
        expect(await code(fetchBundle({ ...req, newAppId: 'x y' }, targetDeps({}).d))).toMatch(/^TRANSFER_FAILED: cannot ask/)
    })
})

describe('pushAppBundle (source side, #263)', () => {
    const store = { diskDB: { r1: src } } as any
    const preq = { sourceDiskId: 'r1', appId: 'kolibri-1.1', targetEngineId: 'eng-a', targetRoot: 'sda1', requestId: 'req-1', instanceId: 'i1' }
    let temps: number[], replies: string[], msgs: UpdateProgress[], sleeps: number[], pushes: number
    const pushDeps = (push: PushDeps['push'], over: Partial<PushDeps> = {}): PushDeps => ({
        mountRoot: async () => tmp, address: async () => '10.0.0.2', push,
        stop: () => { stopped = true; return true }, dirBytes: async () => 1000,
        temperatureC: async () => temps.length > 1 ? temps.shift()! : (temps[0] ?? 50),
        reply: (_e, c) => replies.push(c), broadcast: (m) => msgs.push(m),
        now: () => 1000, sleep: async (ms) => { sleeps.push(ms) }, backoffMs: [5, 20, 60], thermalPollMs: 7, ...over,
    })
    let stopped = false
    beforeEach(async () => {
        temps = [50]; replies = []; msgs = []; sleeps = []; pushes = 0; stopped = false
        await fs.outputFile(path.join(tmp, 'apps', 'kolibri-1.1', 'compose.yaml'), 'c')
        await fs.outputFile(path.join(tmp, 'apps', 'kolibri-1.1', 'SHA256SUMS'), 's')
    })
    it('pushes through receive-app with --partial and answers ok; progress is idea/updateProgress Fetch bytes', async () => {
        const a = await pushAppBundle(store, 'eng-b', preq, pushDeps(async (s, peer, args, onP) => { pushes++; expect(s.endsWith('/apps/kolibri-1.1/')).toBe(true); expect(peer).toEqual({ host: '10.0.0.2', engineId: 'eng-a' }); expect(args).toEqual(['receive-app', 'sda1', 'kolibri-1.1']); onP({ progressPercent: 50 }) }))
        expect(a).toEqual({ ok: true })
        expect(replies).toEqual(['appFetchResult req-1 ok'])
        expect(msgs.some(m => m.type === 'idea/updateProgress' && m.step === 'Fetch' && m.bytesDone === 500 && m.bytesTotal === 1000 && m.instanceId === 'i1')).toBe(true)
        expect(rsyncToPeerArgs('/x/', { host: 'h', engineId: 'e' }, ['receive-app', 'sda1', 'a'], ['--partial'])).toContain('--partial')
    })
    it('3 retries with backoff, then TRANSFER_FAILED; a later success stops retrying', async () => {
        const a = await pushAppBundle(store, 'eng-b', preq, pushDeps(async () => { pushes++; throw new Error('rsync exited with code 12') }))
        expect(pushes).toBe(FETCH_RETRIES + 1)
        expect(sleeps.filter(s => s !== 7)).toEqual([5, 20, 60])
        expect(a.ok).toBe(false)
        expect(replies).toEqual(['appFetchResult req-1 TRANSFER_FAILED rsync failed after 3 retries: rsync exited with code 12'])
        pushes = 0; replies = []
        await pushAppBundle(store, 'eng-b', preq, pushDeps(async () => { if (++pushes < 3) throw new Error('flaky') }))
        expect(pushes).toBe(3); expect(replies).toEqual(['appFetchResult req-1 ok'])
    })
    it(`thermal pause at ${THERMAL_PAUSE_C} °C before and during the push: fetchPaused {reason, bytesDone, bytesTotal, since}; not counted as a retry`, async () => {
        temps = [80, 70, 64, 50, 78, 60, 50]
        const a = await pushAppBundle(store, 'eng-b', preq, pushDeps(async (_s, _p, _a, onP) => {
            pushes++
            if (pushes === 1) {
                onP({ progressPercent: 30 })
                await new Promise<void>((resolve, reject) => { const t = setInterval(() => { if (stopped) { clearInterval(t); reject(new Error('rsync cancelled (SIGTERM)')) } }, 1) ; void resolve })
            }
        }))
        expect(a).toEqual({ ok: true })
        expect(pushes).toBe(2)
        const paused = msgs.filter(m => m.fetchPaused)
        expect(paused.length).toBeGreaterThan(1)
        expect(paused[0].fetchPaused).toEqual({ reason: 'thermal', bytesDone: 0, bytesTotal: 1000, since: 1000 })
        expect(paused.some(m => m.fetchPaused!.bytesDone === 300)).toBe(true)
        expect(msgs.filter(m => !m.fetchPaused).every(m => !('fetchPaused' in m))).toBe(true)
    })
    it('refuses before pushing: source not docked here, no SHA256SUMS, bundle-root .idea-* files, target not connected', async () => {
        const never = async () => { pushes++ }
        expect((await pushAppBundle(store, 'eng-x', preq, pushDeps(never))).ok).toBe(false)
        expect((await pushAppBundle(store, 'eng-b', preq, pushDeps(never, { address: async () => undefined }))).ok).toBe(false)
        await fs.outputFile(path.join(tmp, 'apps', 'kolibri-1.1', '.idea-fetched'), 'x')
        expect(await pushAppBundle(store, 'eng-b', preq, pushDeps(never))).toMatchObject({ ok: false, why: expect.stringMatching(/bundle-root \.idea-\* files/) })
        await fs.remove(path.join(tmp, 'apps', 'kolibri-1.1', '.idea-fetched')); await fs.remove(path.join(tmp, 'apps', 'kolibri-1.1', 'SHA256SUMS'))
        expect((await pushAppBundle(store, 'eng-b', preq, pushDeps(never))).ok).toBe(false)
        expect(pushes).toBe(0)
        expect(replies.every(r => r.startsWith('appFetchResult req-1 TRANSFER_FAILED '))).toBe(true)
        expect(replies).toHaveLength(4)
    })
})
