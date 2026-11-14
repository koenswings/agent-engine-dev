/**
 * idea#76 gap 1 (Lead option A): Disk.appBundles written by the docking Engine, read by the others
 * for the cross-Engine update hint. Two Engines (A = this Engine with the instance, B = the source)
 * in one shared store; no disks, no Docker.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os } from 'zx'
import { Store } from '../../src/data/Store.js'
import { refreshUpdateAvailable, publishAppBundles, bundleInfo, remoteBundles, patchTouchesBundles, TRANSFER_BYTES_PER_MIN } from '../../src/data/UpdateApp.js'

const A = 'engine-A', B = 'engine-B'
const SUM = 'a'.repeat(64) + '  compose.yaml\n'
let h: DocHandle<Store>
let tmp: string
const inst = () => h.doc().instanceDB['i1' as any] as any
// A's own disk has no newer bundle; only B's disk (store only) may offer one
const localDeps = { mountRoot: async () => tmp, listApps: async () => [] as string[], readSums: async () => null, readXApp: async () => ({}), dataBytes: async () => TRANSFER_BYTES_PER_MIN }
const bundleB = (over: Record<string, unknown> = {}) => ({ appId: 'kolibri-1.1', version: '1.1', sumsListed: true, sizeBytes: 2 * TRANSFER_BYTES_PER_MIN, ...over })
const setB = (bundles: unknown, caps: string[] = ['updateApp', 'updateAppFetch'], dockedTo: string | null = B) => h.change(d => {
    (d.engineDB as any)[B] = { id: B, capabilities: caps };
    (d.diskDB as any).dB = { id: 'dB', name: 'dB', device: dockedTo ? 'sdb' : null, dockedTo, diskTypes: ['app'], appBundles: bundles }
})

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hint-'))
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    h.change(d => {
        (d.engineDB as any)[A] = { id: A, capabilities: ['updateApp', 'updateAppFetch'] };
        (d.diskDB as any).dA = { id: 'dA', name: 'dA', device: 'sda', dockedTo: A, diskTypes: ['app'] };
        (d.instanceDB as any).i1 = { id: 'i1', name: 'Kolibri', storedOn: 'dA', instanceOf: 'kolibri-1.0', status: 'Running', port: 50001, lastBackup: null, statusCondition: null }
    })
})
afterEach(async () => { await fs.remove(tmp) })

describe('idea#76 gap 1: cross-Engine update hint from Disk.appBundles', () => {
    it('a bundle on a disk docked on B shows on A with sourceEngineId B, size and transfer in estimatedMinutes', async () => {
        setB([bundleB({ migrationNote: 'n', healthTimeout: 60 })])
        expect(await refreshUpdateAvailable(h, A, localDeps)).toBe(1)
        expect(inst().updateAvailable).toMatchObject({ appId: 'kolibri-1.1', sourceDiskId: 'dB', sourceEngineId: B, fromVersion: '1.0', toVersion: '1.1', major: false, sizeBytes: 2 * TRANSFER_BYTES_PER_MIN, migrationNote: 'n' })
        expect(inst().updateAvailable.estimatedMinutes).toBe(2 + 2)   // 1 GiB snapshot + 60 s health -> 2; 2 GiB transfer -> 2
    })
    it('no hint when B lacks updateAppFetch, when sumsListed is false, or when appBundles is unknown', async () => {
        setB([bundleB()], ['updateApp'])
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable ?? null).toBeNull()
        setB([bundleB({ sumsListed: false })])
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable ?? null).toBeNull()
        setB(null)
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable ?? null).toBeNull()
        expect(remoteBundles(h.doc(), A)).toEqual([])
    })
    it('undock on B (dockedTo null, appBundles cleared) clears the hint on the next refresh', async () => {
        setB([bundleB()])
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable.sourceEngineId).toBe(B)
        setB(null, ['updateApp', 'updateAppFetch'], null)
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable).toBeNull()
    })
    it('B never offers a hint for its own disk to itself via the store path; updatesFrom in appBundles is honoured', async () => {
        expect(remoteBundles({ ...h.doc(), diskDB: { dB: { id: 'dB', device: 'sdb', dockedTo: B, appBundles: [bundleB()] } } } as any, B)).toEqual([])
        setB([bundleB({ appId: 'kolibri-2.0', version: '2.0', updatesFrom: [7] })])
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable ?? null).toBeNull()
        setB([bundleB({ appId: 'kolibri-2.0', version: '2.0', updatesFrom: [1] })])
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable).toMatchObject({ appId: 'kolibri-2.0', major: true, sourceEngineId: B })
    })
    it('a local bundle wins a version tie over the same version on B', async () => {
        setB([bundleB()])
        await refreshUpdateAvailable(h, A, { ...localDeps, listApps: async () => ['kolibri-1.1'], readSums: async () => SUM })
        expect(inst().updateAvailable).toMatchObject({ sourceDiskId: 'dA', sourceEngineId: A })
        expect(inst().updateAvailable.sizeBytes).toBeUndefined()
    })
    it('an instance whose disk is docked nowhere loses its hint; one docked on B is left to B', async () => {
        h.change(d => { (d.instanceDB as any).i1.updateAvailable = { appId: 'kolibri-1.1', sourceEngineId: B }; (d.diskDB as any).dA.dockedTo = null; (d.diskDB as any).dA.device = null })
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable).toBeNull()
        h.change(d => { (d.instanceDB as any).i1.updateAvailable = { appId: 'kolibri-1.1', sourceEngineId: B }; (d.diskDB as any).dA.dockedTo = B; (d.diskDB as any).dA.device = 'sdc' })
        await refreshUpdateAvailable(h, A, localDeps); expect(inst().updateAvailable).toMatchObject({ sourceEngineId: B })
    })
})

describe('publishAppBundles (docking Engine only, on dock, only when changed)', () => {
    const deps = (apps: Record<string, { sums: string | null, x?: Record<string, unknown>, bundle?: boolean }>) => ({
        mountRoot: async () => tmp, listApps: async () => Object.keys(apps),
        readSums: async (dir: string) => apps[path.basename(dir)].sums,
        readXApp: async (dir: string) => apps[path.basename(dir)].x ?? {},
        dirBytes: async () => 4096, isBundle: async (dir: string) => apps[path.basename(dir)].bundle !== false,
    })
    it('writes the sorted list with version, sumsListed, size and x-app fields; skips unfinished fetches', async () => {
        const disk = h.doc().diskDB['dA' as any]
        const apps = { 'kolibri-1.1': { sums: SUM, x: { updatesFrom: [1], healthTimeout: 900, migrationNote: ' m ' } }, 'kiwix-3b6a8a8': { sums: null }, 'nextcloud-1.2-31.0.1': { sums: SUM, bundle: false } }
        expect(await publishAppBundles(h, disk, deps(apps))).toBe(true)
        expect(h.doc().diskDB['dA' as any].appBundles).toEqual([
            { appId: 'kiwix-3b6a8a8', version: '3b6a8a8', sumsListed: false, sizeBytes: 4096 },
            { appId: 'kolibri-1.1', version: '1.1', sumsListed: true, sizeBytes: 4096, updatesFrom: [1], healthTimeout: 900, migrationNote: 'm' },
        ])
    })
    it('no store write when the list is equal (no heartbeat growth)', async () => {
        const disk = h.doc().diskDB['dA' as any]
        const apps = { 'kolibri-1.1': { sums: SUM } }
        expect(await publishAppBundles(h, disk, deps(apps))).toBe(true)
        const heads = JSON.stringify(h.heads())
        expect(await publishAppBundles(h, disk, deps(apps))).toBe(false)
        expect(JSON.stringify(h.heads())).toBe(heads)
        expect(await publishAppBundles(h, disk, deps({ ...apps, 'kolibri-1.2': { sums: SUM } }))).toBe(true)
    })
    it('bundleInfo drops invalid optional fields; patchTouchesBundles matches dockedTo/appBundles/whole-disk patches only', () => {
        expect(bundleInfo('updtest-2.0', SUM, 1, { updatesFrom: 'x', healthTimeout: -1, migrationNote: '' })).toEqual({ appId: 'updtest-2.0', version: '2.0', sumsListed: true, sizeBytes: 1 })
        expect(patchTouchesBundles({ path: ['diskDB', 'dB', 'dockedTo'] })).toBe(true)
        expect(patchTouchesBundles({ path: ['diskDB', 'dB', 'appBundles', 0, 'sumsListed'] })).toBe(true)
        expect(patchTouchesBundles({ path: ['diskDB', 'dB'] })).toBe(true)
        expect(patchTouchesBundles({ path: ['diskDB', 'dB', 'freeBytes'] })).toBe(false)
        expect(patchTouchesBundles({ path: ['instanceDB', 'i1', 'updateAvailable'] })).toBe(false)
    })
})
