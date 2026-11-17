/**
 * update-interim-456.test.ts (engine#456 interim slice)
 *
 * (A) Since the #456 runner (update-runner-456.test.ts) Check no longer refuses a declared
 *     stage: it validates the step shape (UPDATE_CONTRACT_INVALID) and keeps
 *     UPDATE_STAGES_UNSUPPORTED only for an unknown stage key, before Snapshot or Swap.
 *     `update: null` is absent; `update: {}` has no stages.
 * (B) An unversioned instance (SHA / date) may be offered and allowed only the
 *     first tagged major (1.x, including Nextcloud 1.7-31.0.1 / idea#374), and
 *     is never offered or allowed 2.0+. SHA → 1.7 stays classified as a major.
 *
 * The runner itself is tested in update-runner-456.test.ts.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { updateApp, UpdateDeps, UpdateProgress, refreshUpdateAvailable, bundleInfo } from '../../src/data/UpdateApp.js'
import {
    checkUpdate, offerable, majorAllowedByUpdatesFrom, declaredUpdateStages,
    unversionedMayTakeTarget, backupIsDue, CheckFacts,
} from '../../src/data/UpdateAppPolicy.js'
import { isMajorChange } from '../../src/data/Version.js'

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

describe('x-app.update at Check (engine#456 A, runner)', () => {
    it('a well-formed prepare / verify / work / settle is no longer refused', () => {
        expect(checkUpdate(facts({ xAppUpdate: { prepare } }))).toBeNull()
        expect(checkUpdate(facts({ xAppUpdate: { prepare, verify, work, settle } }))).toBeNull()
    })

    it('an unknown stage key is still UPDATE_STAGES_UNSUPPORTED', () => {
        const err = checkUpdate(facts({ xAppUpdate: { prepare, migrate: { service: 'nextcloud-app', command: '/x', timeout: 5 } } }))
        expect(err?.code).toBe('UPDATE_STAGES_UNSUPPORTED')
        expect(err?.message).toBe('UPDATE_STAGES_UNSUPPORTED: this Engine does not run x-app.update stage migrate (it runs prepare, verify, work, settle); nothing was stopped or changed')
    })

    it('a wrong shape is UPDATE_CONTRACT_INVALID, before MAJOR_NOT_ALLOWED, even without --allow-major', () => {
        const err = checkUpdate(facts({ allowMajor: false, xAppUpdate: { prepare: { ...prepare, timeout: undefined } } }))
        expect(err?.code).toBe('UPDATE_CONTRACT_INVALID')
    })

    it('does not refuse update: null or update: {}', () => {
        expect(checkUpdate(facts({ xAppUpdate: null }))).toBeNull()
        expect(checkUpdate(facts({ xAppUpdate: {} }))).toBeNull()
        expect(checkUpdate(facts({}))).toBeNull()
    })

    it('is offered: offerable no longer looks at declared stages', () => {
        expect(offerable({ currentAppId: 'nextcloud-1.8-31.0.14', newAppId: 'nextcloud-2.0-32.0.15', sumsValid: true, xAppUpdate: { prepare } })).toBe(true)
        expect(offerable({ currentAppId: 'nextcloud-1.0', newAppId: 'nextcloud-1.1', sumsValid: true, xAppUpdate: { settle } })).toBe(true)
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
    const sha17 = { currentAppId: 'nextcloud-b8ad438', newAppId: 'nextcloud-1.7-31.0.1' }
    const sha20 = { currentAppId: 'nextcloud-b8ad438', newAppId: 'nextcloud-2.0-32.0.15' }

    it('SHA → 1.7-31.0.1 is offered and allowed (idea#374); SHA → 2.0 is refused', () => {
        expect(unversionedMayTakeTarget('b8ad438', '1.7-31.0.1')).toBe(true)
        expect(unversionedMayTakeTarget('5ab9f64', '1.7-31.0.1')).toBe(true)
        expect(unversionedMayTakeTarget('b8ad438', '2.0-32.0.15')).toBe(false)
        expect(unversionedMayTakeTarget('1.0-2024.12.03', '2.0')).toBe(false)
        expect(unversionedMayTakeTarget('1.8-31.0.14', '2.0-32.0.15')).toBe(true) // versioned source unchanged

        // omitted updatesFrom
        expect(offerable({ ...sha17, sumsValid: true })).toBe(true)
        expect(checkUpdate(facts({ ...sha17, allowMajor: true, backupAgeMs: 1000 }))).toBeNull()
        // real 1.7 shape: updatesFrom: [] (an empty list, not absent)
        expect(majorAllowedByUpdatesFrom('b8ad438', [])).toBe(true)
        expect(offerable({ ...sha17, sumsValid: true, updatesFrom: [] })).toBe(true)
        expect(checkUpdate(facts({ ...sha17, allowMajor: true, updatesFrom: [], backupAgeMs: 1000 }))).toBeNull()
        expect(offerable({ ...sha17, sumsValid: true, updatesFrom: [1] })).toBe(true)
        expect(checkUpdate(facts({ ...sha17, allowMajor: true, updatesFrom: [1], backupAgeMs: 1000 }))).toBeNull()

        expect(offerable({ ...sha20, sumsValid: true })).toBe(false)
        expect(offerable({ ...sha20, sumsValid: true, updatesFrom: [1] })).toBe(false)
        const err = checkUpdate(facts({ ...sha20, allowMajor: true, updatesFrom: [1] }))
        expect(err?.code).toBe('MAJOR_NOT_ALLOWED')
        expect(err?.message).toBe('MAJOR_NOT_ALLOWED: unversioned b8ad438 can only update to the first tagged major (1.x), not 2.0-32.0.15')
        expect(checkUpdate(facts({ ...sha20, allowMajor: true }))?.code).toBe('MAJOR_NOT_ALLOWED')
    })

    it('SHA → 1.7 is allowed with the real 1.7 updatesFrom: [] and when updatesFrom is omitted', () => {
        // 7365d02 treated any array (including []) as a listed major the SHA could not satisfy.
        expect(majorAllowedByUpdatesFrom('b8ad438', [])).toBe(true)
        expect(majorAllowedByUpdatesFrom('b8ad438', undefined)).toBe(true)
        expect(majorAllowedByUpdatesFrom('5ab9f64', [])).toBe(true)

        expect(offerable({ ...sha17, sumsValid: true, updatesFrom: [] })).toBe(true)
        expect(offerable({ ...sha17, sumsValid: true })).toBe(true)
        expect(checkUpdate(facts({ ...sha17, allowMajor: true, updatesFrom: [], backupAgeMs: 1000 }))).toBeNull()
        expect(checkUpdate(facts({ ...sha17, allowMajor: true, backupAgeMs: 1000 }))).toBeNull()

        // empty updatesFrom must not open a 2.0+ hop
        expect(offerable({ ...sha20, sumsValid: true, updatesFrom: [] })).toBe(false)
        expect(checkUpdate(facts({ ...sha20, allowMajor: true, updatesFrom: [] }))?.code).toBe('MAJOR_NOT_ALLOWED')
    })

    it('SHA → 1.7 stays classified as a major (NEEDS_BACKUP path); classification is unchanged', () => {
        expect(isMajorChange('b8ad438', '1.7-31.0.1')).toBe(true)
        expect(backupIsDue('nextcloud-b8ad438', 'nextcloud-1.7-31.0.1', null)).toBe(true)
        expect(backupIsDue('nextcloud-b8ad438', 'nextcloud-1.7-31.0.1', 60_000)).toBe(false)
        expect(checkUpdate(facts({ ...sha17, allowMajor: false }))?.message).toMatch(/pass --allow-major$/)
        expect(checkUpdate(facts({ ...sha17, allowMajor: true, backupAgeMs: null }))?.code).toBe('NEEDS_BACKUP')
        expect(checkUpdate(facts({ ...sha17, allowMajor: true, backupPlanned: true, backupAgeMs: null }))).toBeNull()
    })

    it('offer and execute: SHA is never offered or allowed 2.0–5.0, even without updatesFrom', () => {
        for (const to of ['nextcloud-2.0', 'nextcloud-3.0', 'nextcloud-4.0', 'nextcloud-5.0']) {
            expect(offerable({ currentAppId: 'nextcloud-5ab9f64', newAppId: to, sumsValid: true })).toBe(false)
            expect(offerable({ currentAppId: 'nextcloud-5ab9f64', newAppId: to, sumsValid: true, updatesFrom: [] })).toBe(false)
            expect(offerable({ currentAppId: 'nextcloud-5ab9f64', newAppId: to, sumsValid: true, updatesFrom: [1] })).toBe(false)
            expect(checkUpdate(facts({ currentAppId: 'nextcloud-5ab9f64', newAppId: to, allowMajor: true }))?.code).toBe('MAJOR_NOT_ALLOWED')
            expect(checkUpdate(facts({ currentAppId: 'nextcloud-5ab9f64', newAppId: to, allowMajor: true, updatesFrom: [] }))?.code).toBe('MAJOR_NOT_ALLOWED')
        }
        expect(offerable({ currentAppId: 'nextcloud-1.8-31.0.14', newAppId: 'nextcloud-2.0', sumsValid: true, updatesFrom: [1] })).toBe(true)
        expect(majorAllowedByUpdatesFrom('5ab9f64', [1])).toBe(true) // idea#76: SHA is not restricted by updatesFrom; 2.0+ is refused by unversionedMayTakeTarget
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

    it('a bundle with an invalid x-app.update is refused at Check; no stop, snapshot, or swap; compose is unchanged', async () => {
        await fs.outputFile(`${tmp}/apps/kolibri-1.1/compose.yaml`, compose('1.1',
            '  update:\n    prepare:\n      service: web\n      command: /idea/hooks/prep.sh\n'))
        await fs.outputFile(`${tmp}/apps/kolibri-1.1/.env`, 'port=1\n')
        const before = await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps()))
        expect(m).toBe('UPDATE_CONTRACT_INVALID: x-app.update prepare.timeout is required (seconds, 1 s – 6 h); nothing was stopped or changed')
        expect(calls).toEqual([])
        expect(await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')).toBe(before)
        expect((h.doc().instanceDB['i1' as any] as any).instanceOf).toBe('kolibri-1.0')
        expect(Object.values(h.doc().operationDB)).toEqual([])
    })

    it('a step whose service is not in the new compose is refused at Check', async () => {
        await fs.outputFile(`${tmp}/apps/kolibri-1.1/compose.yaml`, compose('1.1',
            '  update:\n    prepare:\n      service: kolibri\n      command: /idea/hooks/prep.sh\n      timeout: 60\n'))
        const m = await codeOf(updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps()))
        expect(m).toBe('UPDATE_CONTRACT_INVALID: x-app.update prepare.service kolibri is not a service of the new compose; nothing was stopped or changed')
        expect(calls).toEqual([])
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
