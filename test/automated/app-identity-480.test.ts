/**
 * engine#480: an App is identified by the compose x-app that built its id, not by splitting
 * the id. A kit Kiwix on x-app kiwix@release-1.0 (instanceOf kiwix-release-1.0) must update to
 * kiwix 1.3-3.8.2; splitting read it as kiwix-release@1.0 and refused DIFFERENT_APP.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { appIdentity, explicitAppId, splitAppId } from '../../src/data/AppIdParse.js'
import { appIdentityOfDir, appIdentityOfFolder, parseAppId } from '../../src/data/App.js'
import { appIdentityProblems, backupIsDue, checkUpdate, offerable, CheckFacts } from '../../src/data/UpdateAppPolicy.js'
import { updateApp, UpdateDeps, refreshUpdateAvailable, remoteBundleIdentity, bundleInfo } from '../../src/data/UpdateApp.js'
import { appNameOfInstance } from '../../src/data/DemoApps.js'
import { readPortReadyTimeoutMs } from '../../src/data/Instance.js'

const KIWIX_KIT = { name: 'kiwix', version: 'release-1.0' }
const KIWIX_NEW = { name: 'kiwix', version: '1.3-3.8.2' }

const facts = (over: Partial<CheckFacts> = {}): CheckFacts => ({
    diskDocked: true, busy: false, currentAppId: 'kiwix-release-1.0', newAppId: 'kiwix-1.3-3.8.2',
    sourcePresent: true, sumsValid: true, allowMajor: false, backupAgeMs: null, shortDisks: [],
    currentXApp: KIWIX_KIT, newXApp: KIWIX_NEW, ...over,
})

describe('appIdentity (engine#480)', () => {
    it('the x-app that built the id names the App: dashes and dots in name or version', () => {
        expect(splitAppId('kiwix-release-1.0')).toEqual({ name: 'kiwix-release', version: '1.0' })   // the bug
        expect(appIdentity('kiwix-release-1.0', KIWIX_KIT)).toEqual(KIWIX_KIT)
        expect(appIdentity('kiwix-1.3-3.8.2', KIWIX_NEW)).toEqual(KIWIX_NEW)
        expect(appIdentity('my-app-1.3-3.8.2', { name: 'my-app', version: '1.3-3.8.2' })).toEqual({ name: 'my-app', version: '1.3-3.8.2' })
        expect(appIdentity('my-app-release-2.0-rc.1', { name: 'my-app', version: 'release-2.0-rc.1' })).toEqual({ name: 'my-app', version: 'release-2.0-rc.1' })
        expect(appIdentity('kiwix-release-1.0', { name: 'kiwix-release', version: '1.0' })).toEqual({ name: 'kiwix-release', version: '1.0' })
        // YAML number versions stringify the same way createAppId did
        expect(appIdentity('my-app-2', { name: 'my-app', version: 2 })).toEqual({ name: 'my-app', version: '2' })
    })
    it('falls back to splitting the id when there is no matching x-app', () => {
        expect(appIdentity('my-app-1.3-3.8.2')).toEqual({ name: 'my-app', version: '1.3-3.8.2' })
        expect(appIdentity('kiwix-release-1.0', {})).toEqual({ name: 'kiwix-release', version: '1.0' })
        expect(appIdentity('kiwix-release-1.0', { name: 'kiwix' })).toEqual({ name: 'kiwix-release', version: '1.0' })
        expect(appIdentity('kiwix-release-1.0', { name: 'nextcloud', version: '1.0-31.0.1' })).toEqual({ name: 'kiwix-release', version: '1.0' })
        expect(appIdentity('undefined-undefined', {})).toEqual({ name: 'undefined', version: 'undefined' })
    })
    it('explicitAppId gives <name>@<version> only when the split was wrong, and splitAppId reads it back', () => {
        expect(explicitAppId('kiwix-release-1.0', KIWIX_KIT)).toBe('kiwix@release-1.0')
        expect(parseAppId(explicitAppId('kiwix-release-1.0', KIWIX_KIT))).toEqual(KIWIX_KIT)
        expect(explicitAppId('kiwix-1.3-3.8.2', KIWIX_NEW)).toBe('kiwix-1.3-3.8.2')
        expect(explicitAppId('kiwix-release-1.0')).toBe('kiwix-release-1.0')
    })
    it('remote bundles: name from the published appId and version', () => {
        expect(remoteBundleIdentity('kiwix-release-1.1', 'release-1.1')).toEqual({ name: 'kiwix', version: 'release-1.1' })
        expect(remoteBundleIdentity('kiwix-1.3-3.8.2', '1.3-3.8.2')).toEqual(KIWIX_NEW)
        expect(remoteBundleIdentity('kiwix-1.3', '9.9')).toEqual({})
        expect(remoteBundleIdentity('kiwix-1.3', undefined)).toEqual({})
        expect(bundleInfo('kiwix-release-1.1', null, 1, { name: 'kiwix', version: 'release-1.1' }).version).toBe('release-1.1')
    })
})

describe('updateApp Check with the x-app identity (engine#480)', () => {
    it('kiwix-release-1.0 (x-app kiwix@release-1.0) -> kiwix 1.3-3.8.2 is accepted as a minor update', () => {
        expect(appIdentityProblems('kiwix-release-1.0', 'kiwix-1.3-3.8.2', KIWIX_KIT, KIWIX_NEW)).toBeNull()
        expect(checkUpdate(facts())).toBeNull()
        expect(offerable(facts())).toBe(true)
        expect(backupIsDue('kiwix-release-1.0', 'kiwix-1.3-3.8.2', null, KIWIX_KIT, KIWIX_NEW)).toBe(false)   // 1.0 -> 1.3: same major
    })
    it('without the x-app it still falls back to the id split (the old refusal)', () => {
        expect(checkUpdate(facts({ currentXApp: undefined }))?.message).toBe('DIFFERENT_APP: x-app.name mismatch (actual: kiwix-release, expected: kiwix); x-app.version mismatch (actual: 1.0, expected: 1.3-3.8.2)')
    })
    it('a genuinely different App is still refused DIFFERENT_APP, with the real names', () => {
        const nc = { name: 'nextcloud', version: '1.8-31.0.1' }
        const e = checkUpdate(facts({ newAppId: 'nextcloud-1.8-31.0.1', newXApp: nc }))
        expect(e?.code).toBe('DIFFERENT_APP')
        expect(e?.message).toBe('DIFFERENT_APP: x-app.name mismatch (actual: kiwix, expected: nextcloud); x-app.version mismatch (actual: release-1.0, expected: 1.8-31.0.1)')
        expect(offerable(facts({ newAppId: 'nextcloud-1.8-31.0.1', newXApp: nc }))).toBe(false)
        // a hyphenated name that only shares a prefix is a different App too
        const e2 = checkUpdate(facts({ newAppId: 'kiwix-tools-1.3-3.8.2', newXApp: { name: 'kiwix-tools', version: '1.3-3.8.2' } }))
        expect(e2?.message).toMatch(/^DIFFERENT_APP: x-app.name mismatch \(actual: kiwix, expected: kiwix-tools\)/)
    })
    it('hyphenated names and versions: my-app 1.3-3.8.2 -> 1.4-3.9.0 (minor), -> 2.0-4.0.0 major', () => {
        const cur = { name: 'my-app', version: '1.3-3.8.2' }
        const f = (v: string) => facts({ currentAppId: 'my-app-1.3-3.8.2', currentXApp: cur, newAppId: `my-app-${v}`, newXApp: { name: 'my-app', version: v } })
        expect(checkUpdate(f('1.4-3.9.0'))).toBeNull()
        expect(checkUpdate(f('1.3-3.8.2'))?.code).toBe('NOT_NEWER')
        expect(checkUpdate(f('2.0-4.0.0'))?.code).toBe('MAJOR_NOT_ALLOWED')
    })
})

describe('updateApp end to end on a kit-shaped Kiwix (engine#480)', () => {
    const ME = String(localEngineId)
    let h: DocHandle<Store>, tmp: string, calls: string[]
    const compose = (version: string) => `services:\n  web:\n    image: x\nx-app:\n  name: kiwix\n  version: "${version}"\n  instanceName: Kiwix\n  backup:\n    method: none\n`
    const deps = (): Partial<UpdateDeps> => ({
        helperProblem: async () => null,
        mountRoot: async () => tmp,
        verifySums: async () => true,
        fetch: async () => { throw new Error('no fetch expected') },
        estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * 1024 ** 3 }),
        dirBytes: async () => 10,
        stop: async () => { calls.push('stop'); h.change(d => { (d.instanceDB['k1' as any] as any).status = 'Stopped' }) },
        containerIds: async () => [],
        composeDown: async () => { calls.push('down') },
        snapshot: async () => { calls.push('snapshot'); return { path: `${tmp}/.pre-update/k1`, sizeBytes: 1, previousQuarantinedAt: null, volumes: [] } },
        restoreSnapshot: async () => `${tmp}/.idea-quarantine/x`,
        listSnapshots: async () => ({ snapshots: [], preUpdateBytes: 0, quarantineBytes: 0 }),
        reread: async () => {
            calls.push('reread')
            const v = (await fs.readFile(`${tmp}/instances/k1/compose.yaml`, 'utf8')).match(/version: "([^"]+)"/)![1]
            h.change(d => { (d.instanceDB['k1' as any] as any).instanceOf = `kiwix-${v}` })
        },
        start: async () => { calls.push('start'); h.change(d => { (d.instanceDB['k1' as any] as any).status = 'Running' }) },
        health: async () => ({ state: 'healthy' as any, restartCount: 0 }),
        probe: async () => ({ status: 200, body: 'ok' }),
        broadcast: () => {},
        now: () => Date.now(),
        sleep: async () => {},
        stopWaitMs: 1000, pollMs: 1,
    })
    beforeEach(async () => {
        calls = []
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kiwix480-'))
        await fs.outputFile(`${tmp}/instances/k1/compose.yaml`, compose('release-1.0'))
        await fs.outputFile(`${tmp}/instances/k1/.env`, 'port=50002\n')
        await fs.outputFile(`${tmp}/apps/kiwix-release-1.0/compose.yaml`, compose('release-1.0'))
        await fs.outputFile(`${tmp}/apps/kiwix-1.3-3.8.2/compose.yaml`, compose('1.3-3.8.2'))
        h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        h.change(doc => {
            doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
            doc.instanceDB['k1' as any] = { id: 'k1', name: 'Kiwix', storedOn: 'd1', instanceOf: 'kiwix-release-1.0', status: 'Running', port: 50002, lastBackup: null, statusCondition: null } as any
        })
    })
    afterEach(async () => { await fs.remove(tmp) })

    it('kiwix-release-1.0 -> kiwix-1.3-3.8.2 runs every step (no DIFFERENT_APP, no --allow-major)', async () => {
        const r = await updateApp(h, 'k1', 'kiwix-1.3-3.8.2', ME, {}, deps())
        expect(r).toMatchObject({ fromAppId: 'kiwix-release-1.0', toAppId: 'kiwix-1.3-3.8.2' })
        expect(calls).toEqual(['stop', 'snapshot', 'reread', 'start'])
        expect((h.doc().instanceDB['k1' as any] as any).instanceOf).toBe('kiwix-1.3-3.8.2')
    })
    it('updateAvailable offers kiwix 1.3-3.8.2 to the release-1.0 instance as a minor update', async () => {
        const SUM = 'a'.repeat(64) + '  compose.yaml\n'
        await refreshUpdateAvailable(h, ME, { mountRoot: async () => tmp, listApps: async () => ['kiwix-release-1.0', 'kiwix-1.3-3.8.2'], readSums: async () => SUM })
        expect((h.doc().instanceDB['k1' as any] as any).updateAvailable).toMatchObject({ appId: 'kiwix-1.3-3.8.2', fromVersion: 'release-1.0', toVersion: '1.3-3.8.2', major: false })
    })
})

describe('other places that named an App by splitting its id (engine#480)', () => {
    let tmp: string
    beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'appid480-')) })
    afterEach(async () => { await fs.remove(tmp) })

    it('apps/ folder and App record: name and version from the folder compose x-app', async () => {
        const compose = { 'x-app': KIWIX_KIT }
        expect(appIdentityOfFolder('kiwix-release-1.0', compose)).toEqual(KIWIX_KIT)
        expect(appIdentityOfFolder('kiwix-release-1.0', {})).toEqual({ name: 'kiwix-release', version: '1.0' })
        await fs.outputFile(path.join(tmp, 'kiwix-release-1.0', 'compose.yaml'), 'services: {}\nx-app:\n  name: kiwix\n  version: release-1.0\n')
        expect(await appIdentityOfDir(path.join(tmp, 'kiwix-release-1.0'), 'kiwix-release-1.0')).toEqual(KIWIX_KIT)
        expect(await appIdentityOfDir(path.join(tmp, 'missing'), 'my-app-1.3-3.8.2')).toEqual({ name: 'my-app', version: '1.3-3.8.2' })
    })
    it('Demo App name of an instance: the App record wins when it built instanceOf', () => {
        const inst = { instanceOf: 'kiwix-release-1.0' } as any
        expect(appNameOfInstance(inst)).toBe('kiwix-release')   // no store: old split
        expect(appNameOfInstance(inst, { appDB: { 'kiwix-release-1.0': { name: 'kiwix', version: 'release-1.0' } } } as any)).toBe('kiwix')
        expect(appNameOfInstance(inst, { appDB: { 'kiwix-release-1.0': { name: 'other', version: '9' } } } as any)).toBe('kiwix-release')
    })
    it('port-ready timeout: the per-App default follows the compose x-app name', async () => {
        const p = path.join(tmp, 'compose.yaml')
        await fs.writeFile(p, 'services: {}\nx-app:\n  name: kolibri\n  version: release-1.0\n')
        expect(await readPortReadyTimeoutMs(p, 'kolibri-release', 'kolibri-release-1.0')).toBe(900_000)
        expect(await readPortReadyTimeoutMs(p, 'kolibri')).toBe(900_000)
    })
})
