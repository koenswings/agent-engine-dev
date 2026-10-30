/**
 * instance-app-fallback.test.ts — App lookup when instanceOf ≠ App folder (idea#392)
 *
 * Disk B (idea#139 step 9): apps/nextcloud-1.0 with x-app.version 1.0-smoke, so
 * instanceOf is nextcloud-1.0-smoke and appDB['nextcloud-1.0-smoke'] misses.
 * The lookup falls back to the folder with a warning; a match is unchanged;
 * nothing by either id is a clean skip. Compose is injected — no real Docker.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { createOrUpdateDisk } from '../../src/data/Disk.js'
import { createOrUpdateApp } from '../../src/data/App.js'
import { appForInstance, resolveInstanceApp, resetInstanceAppAliasesForTests, instanceUsbSync } from '../../src/data/InstanceApp.js'
import {
    writeInstanceOverride, optedInInstances, remountInstance, ensureEngineStateDir,
    setFilesMountOpsForTests, resetFilesRemountScheduleForTests,
} from '../../src/data/FilesMount.js'
import { resourceLock } from '../../src/utils/ResourceLock.js'
import { AppID, DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Instance } from '../../src/data/Instance.js'
import { DISKS_ROOT, FIXTURES_DIR, uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const SAMPLE = path.join(FIXTURES_DIR, 'disk-files-app/apps/sample-files-1.0/compose.yaml')

describe('App lookup fallback by App folder (idea#392)', () => {
    let h: DocHandle<Store>
    let root = ''
    let disk: any
    let infoSpy: ReturnType<typeof vi.spyOn>
    let composeCalls: string[][]

    /** apps/<folder> with x-app name/version, plus an instance whose instanceOf is name-version. */
    const setup = async (folder: string, name: string, version: string) => {
        const c = YAML.parse(await fs.readFile(SAMPLE, 'utf8'))
        c['x-app'].name = name
        c['x-app'].version = version
        await fs.ensureDir(`${root}/apps/${folder}`)
        await fs.ensureDir(`${root}/instances/inst-1`)
        await fs.writeFile(`${root}/apps/${folder}/compose.yaml`, YAML.stringify(c))
        await fs.writeFile(`${root}/instances/inst-1/compose.yaml`, YAML.stringify(c))
        await createOrUpdateApp(h, folder as AppID, disk)
        const inst: Instance = {
            id: 'inst-1' as InstanceID, instanceOf: `${name}-${version}` as AppID, name: 'inst-1' as any,
            status: 'Running', statusCondition: null, port: 0 as any, serviceImages: [],
            created: 1 as Timestamp, lastBackup: null, lastStarted: 1 as Timestamp,
            storedOn: 'disk-b' as DiskID, currentStep: null, totalSteps: null, stepLabel: null,
            metrics: null, filesMounts: null,
        }
        h.change(doc => { doc.instanceDB[inst.id] = inst })
        return h.doc()!.instanceDB['inst-1' as InstanceID]
    }
    const warnings = () => infoSpy.mock.calls.map(a => String(a[0])).filter(m => m.includes('idea#392'))

    beforeEach(async () => {
        h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
        } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, LOCAL)
        resetInstanceAppAliasesForTests()
        resetFilesRemountScheduleForTests()
        composeCalls = []
        setFilesMountOpsForTests({
            composeUp: async (_d, _o, args) => { composeCalls.push(args) },
            nextcloudOccStatus: async () => ({ installed: true, maintenance: false, needsDbUpgrade: false }),
        })
        await ensureEngineStateDir()
        const device = uniqueTestDevice()
        root = `${DISKS_ROOT}/${device}`
        disk = createOrUpdateDisk(h, LOCAL, device as DeviceName, 'disk-b' as DiskID, 'Disk B' as DiskName, 1 as Timestamp)
        infoSpy = vi.spyOn(console, 'info')
    })
    afterEach(async () => {
        infoSpy.mockRestore()
        setFilesMountOpsForTests(null)
        resetFilesRemountScheduleForTests()
        resetInstanceAppAliasesForTests()
        resourceLock.releaseAll([...resourceLock.allLocks().keys()])
        await fs.remove(root)
    })

    it('mismatch: falls back to the App folder, warns naming both ids, filesMount paths use it', async () => {
        const inst = await setup('sample-files-1.0', 'sample-files', '1.0-smoke')
        expect(h.doc()!.appDB['sample-files-1.0-smoke' as AppID]).toBeUndefined()
        expect(appForInstance(h.doc()!, inst)).toBeUndefined()   // before resolving: plain miss

        const app = await resolveInstanceApp(h.doc()!, inst)
        expect(app?.id).toBe('sample-files-1.0')
        expect(app?.filesMount).toEqual({ path: '/mnt/idea-files', services: ['sample'] })
        const w = warnings()
        expect(w).toHaveLength(1)
        expect(w[0]).toContain("'sample-files-1.0-smoke'")
        expect(w[0]).toContain("'sample-files-1.0'")

        // remembered for sync callers, no second warning
        expect(appForInstance(h.doc()!, inst)?.id).toBe('sample-files-1.0')
        expect(optedInInstances(h.doc()!).map(i => i.id)).toEqual(['inst-1'])
        expect(await writeInstanceOverride(h.doc()!, inst)).not.toBeNull()
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('done')
        expect(composeCalls).toEqual([['up', '-d']])
        expect(warnings()).toHaveLength(1)
    })

    it('mismatch is found by remountInstance directly (no prior resolve)', async () => {
        await setup('sample-files-1.0', 'sample-files', '1.0-smoke')
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('done')
        expect(composeCalls).toHaveLength(1)
        expect(warnings()).toHaveLength(1)
    })

    it('match: same App as before, no warning', async () => {
        const inst = await setup('sample-files-1.0', 'sample-files', '1.0')
        expect(appForInstance(h.doc()!, inst)?.id).toBe('sample-files-1.0')
        expect((await resolveInstanceApp(h.doc()!, inst))?.id).toBe('sample-files-1.0')
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('done')
        expect(warnings()).toHaveLength(0)
    })

    it('runInstance USB sync lookup (instanceUsbSync) uses the folder App on a mismatch', async () => {
        const inst = await setup('sample-files-1.0', 'sample-files', '1.0-smoke')
        // give the folder App a usbMount with sync, as x-app.usbMount would
        h.change(doc => {
            (doc.appDB['sample-files-1.0' as AppID] as any).usbMount = {
                path: '/mnt/idea-usb', services: ['sample'], sync: { service: 'sample', user: null, command: '/idea/usb-sync.sh' },
            }
        })
        expect(h.doc()!.appDB['sample-files-1.0-smoke' as AppID]).toBeUndefined()
        expect(await instanceUsbSync(h.doc()!, inst)).toEqual({ service: 'sample', user: null, command: '/idea/usb-sync.sh' })
        expect(warnings()).toHaveLength(1)
        h.change(doc => { delete doc.appDB['sample-files-1.0' as AppID] })
        resetInstanceAppAliasesForTests()
        expect(await instanceUsbSync(h.doc()!, inst)).toBeNull()
    })

    it('nothing by either id: clean skip, no warning, no compose', async () => {
        const inst = await setup('sample-files-1.0', 'other-app', '2.0')
        // the folder's x-app gives other-app-2.0 = instanceOf, but drop the App record so neither id exists
        h.change(doc => { delete doc.appDB['sample-files-1.0' as AppID] })
        expect(await resolveInstanceApp(h.doc()!, inst)).toBeUndefined()
        expect(optedInInstances(h.doc()!)).toEqual([])
        expect(await writeInstanceOverride(h.doc()!, inst)).toBeNull()
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('skipped')
        expect(composeCalls).toHaveLength(0)
        expect(warnings()).toHaveLength(0)
    })
})

describe('#297 recreate on a mismatched instanceOf/folder disk (idea#139 + idea#392)', () => {
    it('reconcileFilesMounts recreates once via the folder App, then is unchanged', async () => {
        const { reconcileFilesMounts } = await import('../../src/data/FilesMount.js')
        const h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
        } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, LOCAL)
        resetInstanceAppAliasesForTests()
        resetFilesRemountScheduleForTests()
        const calls: string[][] = []
        setFilesMountOpsForTests({
            composeUp: async (_d, _o, args) => { calls.push(args) },
            nextcloudOccStatus: async () => ({ installed: true, maintenance: false, needsDbUpgrade: false }),
        })
        await ensureEngineStateDir()
        const device = uniqueTestDevice()
        const root = `${DISKS_ROOT}/${device}`
        try {
            // Disk B shape: one disk, App + Files, apps/sample-files-1.0 with x-app.version 1.0-smoke
            const disk = createOrUpdateDisk(h, LOCAL, device as DeviceName, 'disk-b' as DiskID, 'Disk B' as DiskName, 1 as Timestamp)
            const c = YAML.parse(await fs.readFile(SAMPLE, 'utf8'))
            c['x-app'].name = 'sample-files'; c['x-app'].version = '1.0-smoke'
            await fs.ensureDir(`${root}/apps/sample-files-1.0`); await fs.ensureDir(`${root}/instances/inst-1`)
            await fs.writeFile(`${root}/apps/sample-files-1.0/compose.yaml`, YAML.stringify(c))
            await fs.writeFile(`${root}/instances/inst-1/compose.yaml`, YAML.stringify(c))
            await createOrUpdateApp(h, 'sample-files-1.0' as AppID, disk)
            await fs.copy(path.join(FIXTURES_DIR, 'disk-files'), root, { overwrite: false })
            h.change(doc => {
                const d = doc.diskDB['disk-b' as DiskID]
                d.filesConfig = { shareName: 'School Files', readOnly: false, passwordProtected: false, error: null }
                d.diskTypes = ['app', 'files']
                doc.instanceDB['inst-1' as InstanceID] = {
                    id: 'inst-1', instanceOf: 'sample-files-1.0-smoke', name: 'inst-1', status: 'Running',
                    statusCondition: null, port: 0, serviceImages: [], created: 1, lastBackup: null, lastStarted: 1,
                    storedOn: 'disk-b', currentStep: null, totalSteps: null, stepLabel: null, metrics: null, filesMounts: null,
                } as any
            })
            expect(h.doc()!.appDB['sample-files-1.0-smoke' as AppID]).toBeUndefined()
            expect(await reconcileFilesMounts(h, 'inst-1' as InstanceID)).toBe('done')
            expect(calls).toEqual([['up', '-d']])
            expect([...h.doc()!.instanceDB['inst-1' as InstanceID].filesMounts!]).toEqual(['disk-b'])
            expect(await reconcileFilesMounts(h, 'inst-1' as InstanceID)).toBe('unchanged')
            expect(calls).toHaveLength(1)
        } finally {
            setFilesMountOpsForTests(null)
            resetFilesRemountScheduleForTests()
            resetInstanceAppAliasesForTests()
            await fs.remove(root)
        }
    })
})
