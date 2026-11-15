/**
 * update-interim-456.test.ts (engine#456 interim slice)
 *
 * (A) Fetch→Check refuses a bundle that declares any x-app.update stage
 *     (prepare, verify, work, settle) with UPDATE_STAGES_UNSUPPORTED, before
 *     Snapshot or Swap. `update: null` is absent; `update: {}` has no stages.
 * (B) An unversioned instance (SHA / date) is never offered or allowed a major
 *     whose updatesFrom lists a major the source cannot satisfy. SHA → 1.x
 *     without updatesFrom keeps today's behaviour.
 *
 * This slice does not run the stages, add a reboot wrapper, clean images, or
 * treat 1.7 as step 0.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { updateApp, UpdateDeps, UpdateProgress, refreshUpdateAvailable, bundleInfo } from '../../src/data/UpdateApp.js'
import {
    checkUpdate, offerable, majorAllowedByUpdatesFrom, declaredUpdateStages,
    CheckFacts,
} from '../../src/data/UpdateAppPolicy.js'

const ME = String(localEngineId)
const facts = (over: Partial<CheckFacts> = {}): CheckFacts => ({
    diskDocked: true, busy: false, currentAppId: 'nextcloud-1.8-31.0.14', newAppId: 'nextcloud-2.0-32.0.15',
    sourcePresent: true, sumsValid: true, allowMajor: true, backupAgeMs: 1000, shortDisks: [],
    ...over,
})

const prepare = { service: 'nextcloud-app', user: '0', command: '/idea/hooks/prep-custom-apps-for-upgrade.sh', timeout: 600 }
const verify = { service: 'nextcloud-app', user: '33', command: '/idea/hooks/verify-update.sh', timeout: 120 }
const work = { service: 'nextcloud-app', user: '33', command: '/idea/hooks/run-cron.sh', timeout: 3600 }
const settle = { service: 'nextcloud-app', user: '33', command: '/idea/hooks/settle-update.sh', interval: 60, timeout: 3600 }

describe('declaredUpdateStages (engine#456 A)', () => {
    it('treats missing, null, and {} as no stages', () => {
        expect(declaredUpdateStages(undefined)).toEqual([])
        expect(declaredUpdateStages(null)).toEqual([])
        expect(declaredUpdateStages({})).toEqual([])
        expect(declaredUpdateStages({ prepare: null, verify: null })).toEqual([])
    })

    it('names only the known stages that are actually declared', () => {
        expect(declaredUpdateStages({ prepare })).toEqual(['prepare'])
        expect(declaredUpdateStages({ prepare, verify, work, settle })).toEqual(['prepare', 'verify', 'work', 'settle'])
        expect(declaredUpdateStages({ settle, other: { command: '/x' } })).toEqual(['settle'])
        expect(declaredUpdateStages({ foo: {}, prepare: {} })).toEqual(['prepare'])
    })
})

describe('UPDATE_STAGES_UNSUPPORTED at Check (engine#456 A)', () => {
    it('refuses a bundle that declares prepare, and names the stage', () => {
        const err = checkUpdate(facts({ xAppUpdate: { prepare } }))
        expect(err?.code).toBe('UPDATE_STAGES_UNSUPPORTED')
        expect(err?.message).toBe('UPDATE_STAGES_UNSUPPORTED: this Engine does not yet run x-app.update stages: prepare (nothing was changed)')
    })

    it('names every declared stage (prepare, verify, work, settle)', () => {
        const err = checkUpdate(facts({ xAppUpdate: { prepare, verify, work, settle } }))
        expect(err?.code).toBe('UPDATE_STAGES_UNSUPPORTED')
        expect(err?.message).toContain('prepare, verify, work, settle')
    })

    it('does not refuse update: null or update: {}', () => {
        expect(checkUpdate(facts({ xAppUpdate: null }))).toBeNull()
        expect(checkUpdate(facts({ xAppUpdate: {} }))).toBeNull()
        expect(checkUpdate(facts({}))).toBeNull()
    })

    it('refuses before MAJOR_NOT_ALLOWED, even without --allow-major', () => {
        const err = checkUpdate(facts({ allowMajor: false, xAppUpdate: { prepare } }))
        expect(err?.code).toBe('UPDATE_STAGES_UNSUPPORTED')
    })

    it('is not offered: offerable is false when any stage is declared, true for null/{}', () => {
        expect(offerable({ currentAppId: 'nextcloud-1.8-31.0.14', newAppId: 'nextcloud-2.0-32.0.15', sumsValid: true, xAppUpdate: { prepare } })).toBe(false)
        expect(offerable({ currentAppId: 'nextcloud-1.0', newAppId: 'nextcloud-1.1', sumsValid: true, xAppUpdate: { settle } })).toBe(false)
        expect(offerable({ currentAppId: 'nextcloud-1.0', newAppId: 'nextcloud-1.1', sumsValid: true, xAppUpdate: null })).toBe(true)
        expect(offerable({ currentAppId: 'nextcloud-1.0', newAppId: 'nextcloud-1.1', sumsValid: true, xAppUpdate: {} })).toBe(true)
    })

    it('bundleInfo records declared stages and drops a bare update: {}', () => {
        const SUM = 'a'.repeat(64) + '  compose.yaml\n'
        expect(bundleInfo('nextcloud-2.0', SUM, 1, { update: { prepare, verify } }).updateStages).toEqual(['prepare', 'verify'])
        expect(bundleInfo('nextcloud-2.0', SUM, 1, { update: {} }).updateStages).toBeUndefined()
        expect(bundleInfo('nextcloud-2.0', SUM, 1, { update: null }).updateStages).toBeUndefined()
    })
})

describe('SHA-source majors (engine#456 B)', () => {
    it('majorAllowedByUpdatesFrom: a SHA or date source cannot satisfy a listed major', () => {
        expect(majorAllowedByUpdatesFrom('5ab9f64', [1])).toBe(false)
        expect(majorAllowedByUpdatesFrom('b8ad438', [1])).toBe(false)
        expect(majorAllowedByUpdatesFrom('1.0-2024.12.03', [1])).toBe(false)
        expect(majorAllowedByUpdatesFrom('5ab9f64', undefined)).toBe(true)
        expect(majorAllowedByUpdatesFrom('1.0', [1])).toBe(true)
    })

    it('execute: SHA → 2.0 with updatesFrom: [1] is MAJOR_NOT_ALLOWED even with --allow-major', () => {
        const err = checkUpdate(facts({
            currentAppId: 'nextcloud-5ab9f64', newAppId: 'nextcloud-2.0-32.0.15',
            updatesFrom: [1], allowMajor: true,
        }))
        expect(err?.code).toBe('MAJOR_NOT_ALLOWED')
        expect(err?.message).toBe('MAJOR_NOT_ALLOWED: version 2.0-32.0.15 cannot update directly from unversioned 5ab9f64; supported: 1')
    })

    it('execute: SHA → 1.x without updatesFrom keeps today’s path (major, so --allow-major + backup)', () => {
        const sha = { currentAppId: 'nextcloud-b8ad438', newAppId: 'nextcloud-1.0-31.0.1' }
        expect(checkUpdate(facts({ ...sha, allowMajor: false }))?.code).toBe('MAJOR_NOT_ALLOWED')
        expect(checkUpdate(facts({ ...sha, allowMajor: true, backupAgeMs: 1000 }))).toBeNull()
        expect(offerable({ ...sha, sumsValid: true })).toBe(true)
    })

    it('offer: SHA is not offered 2.0–5.0 when those bundles list updatesFrom', () => {
        for (const [to, from] of [['nextcloud-2.0', [1]], ['nextcloud-3.0', [2]], ['nextcloud-4.0', [3]], ['nextcloud-5.0', [4]]] as const) {
            expect(offerable({ currentAppId: 'nextcloud-5ab9f64', newAppId: to, sumsValid: true, updatesFrom: from })).toBe(false)
            expect(checkUpdate(facts({ currentAppId: 'nextcloud-5ab9f64', newAppId: to, updatesFrom: from, allowMajor: true }))?.code).toBe('MAJOR_NOT_ALLOWED')
        }
        expect(offerable({ currentAppId: 'nextcloud-1.8-31.0.14', newAppId: 'nextcloud-2.0', sumsValid: true, updatesFrom: [1] })).toBe(true)
    })
})

describe('updateApp refuses declared stages before Snapshot (engine#456 A)', () => {
    let h: DocHandle<Store>, tmp: string, calls: string[]
    const compose = (version: string, extra = '') =>
        `services:\n  web:\n    image: x\nx-app:\n  name: kolibri\n  version: "${version}"\n  instanceName: Old\n${extra}`
    const deps = (over: Partial<UpdateDeps> = {}): Partial<UpdateDeps> => ({
        helperProblem: async () => null,
        mountRoot: async () => tmp,
        verifySums: async () => true,
        fetch: async () => { calls.push('fetch'); throw new Error('no fetch expected') },
        estimate: async () => { calls.push('estimate'); return { folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * 1024 ** 3 } },
        dirBytes: async () => 10,
        stop: async () => { calls.push('stop') },
        containerIds: async () => [],
        composeDown: async () => { calls.push('down') },
        snapshot: async () => { calls.push('snapshot'); return { path: `${tmp}/.pre-update/i1`, sizeBytes: 4096, previousQuarantinedAt: null, volumes: [] } },
        restoreSnapshot: async () => { calls.push('restore'); return '' },
        listSnapshots: async () => ({ snapshots: [], preUpdateBytes: 0, quarantineBytes: 0 }),
        reread: async () => { calls.push('reread') },
        start: async () => { calls.push('start') },
        health: async () => ({ state: 'healthy' as const, restartCount: 0 }),
        probe: async () => ({ status: 200, body: 'ok' }),
        broadcast: (_m: UpdateProgress) => {},
        now: () => Date.now(),
        sleep: async () => {},
        stopWaitMs: 1000, pollMs: 1,
        ...over,
    })
    const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }

    beforeEach(async () => {
        calls = []
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-456-'))
        await fs.outputFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0'))
        await fs.outputFile(`${tmp}/instances/i1/.env`, 'port=50001\n')
        h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
        } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        h.change(doc => {
            doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
            doc.instanceDB['i1' as any] = {
                id: 'i1', name: 'Old', storedOn: 'd1', instanceOf: 'kolibri-1.0', status: 'Running',
                port: 50001, lastBackup: Date.now(), statusCondition: null,
            } as any
        })
    })
    afterEach(async () => { await fs.remove(tmp) })

    it('a bundle that declares prepare is refused at Check; no stop, snapshot, or swap; compose is unchanged', async () => {
        await fs.outputFile(`${tmp}/apps/kolibri-1.1/compose.yaml`, compose('1.1',
            '  update:\n    prepare:\n      service: web\n      command: /idea/hooks/prep.sh\n      timeout: 60\n'))
        await fs.outputFile(`${tmp}/apps/kolibri-1.1/.env`, 'port=1\n')
        const before = await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps()))
        expect(m).toBe('UPDATE_STAGES_UNSUPPORTED: this Engine does not yet run x-app.update stages: prepare (nothing was changed)')
        expect(calls).toEqual([])
        expect(await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')).toBe(before)
        expect((h.doc().instanceDB['i1' as any] as any).instanceOf).toBe('kolibri-1.0')
        expect(Object.values(h.doc().operationDB)).toEqual([])
    })

    it('update: {} is not refused and the hop can proceed', async () => {
        await fs.outputFile(`${tmp}/apps/kolibri-1.1/compose.yaml`, compose('1.1', '  update: {}\n'))
        await fs.outputFile(`${tmp}/apps/kolibri-1.1/.env`, 'port=1\n')
        expect(await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps()))).toBe('ok')
        expect(calls).toContain('snapshot')
        expect(calls).toContain('start')
    })

    it('dock-time offer skips a staged 2.0 and a SHA→2.0 with updatesFrom, but still offers SHA→1.x', async () => {
        const SUM = 'a'.repeat(64) + '  compose.yaml\n'
        const xapps: Record<string, Record<string, unknown>> = {
            'kolibri-1.1': {},
            'kolibri-2.0': { updatesFrom: [1], update: { prepare } },
        }
        h.change(doc => { (doc.instanceDB['i1' as any] as any).instanceOf = 'kolibri-5ab9f64' })
        const avail = {
            mountRoot: async () => tmp,
            listApps: async () => Object.keys(xapps),
            readSums: async () => SUM,
            readXApp: async (bundleDir: string) => xapps[path.basename(bundleDir)] ?? {},
        }
        expect(await refreshUpdateAvailable(h, ME, avail)).toBe(1)
        expect((h.doc().instanceDB['i1' as any] as any).updateAvailable).toMatchObject({
            appId: 'kolibri-1.1', fromVersion: '5ab9f64', toVersion: '1.1', major: true,
        })
    })
})
