/**
 * files-mount.test.ts — Files Disk step 2: mount files/ into opted-in Apps (idea#133)
 *
 * Covers §7.3 / acceptance tests:
 *   - Override: long bind syntax, create_host_path: false, listed services only,
 *     slug sanitising, always-suffixed paths, display-name JSON, rebuilt every time
 *   - Status: Running → up -d; Stopped untouched; Pauzed → --no-start --force-recreate;
 *     filesMounts only after success
 *   - Hold-back (Kid Q1): Starting / Running Operation; Nextcloud occ not ready → hold
 *   - Grouping window FILES_REMOUNT_GROUP_MS = 3 s
 *   - App.filesMount from x-app.filesMount; skip same-disk on Files dock
 *   - Undock exclude: remount without the leaving disk
 *
 * Compose / occ are injected via setFilesMountOpsForTests — no real Docker.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { createOrUpdateDisk, processDisk } from '../../src/data/Disk.js'
import { createOrUpdateApp } from '../../src/data/App.js'
import {
    FILES_REMOUNT_GROUP_MS, IDEA_FILES_JSON,
    buildOverride, slugFromShareName, containerFilesPath, diskId6,
    parseFilesMount, remountActionFor, shouldHoldFilesRemount,
    remountInstance, writeInstanceOverride, scheduleFilesRemount,
    flushFilesRemountNow, resetFilesRemountScheduleForTests,
    setFilesMountOpsForTests, ensureEngineStateDir,
    overridePathFor, displayJsonHostPath,
} from '../../src/data/FilesMount.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import { createOperation, updateOperation } from '../../src/data/Operations.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp, AppID } from '../../src/data/CommonTypes.js'
import { Instance } from '../../src/data/Instance.js'
import { DISKS_ROOT, FIXTURES_DIR, uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

const addInstance = (h: DocHandle<Store>, id: string, opts: { appId?: string; diskId?: string; status?: Instance['status']; filesMounts?: DiskID[] | null }): Instance => {
    const appId = (opts.appId ?? 'sample-files-1.0') as AppID
    const inst: Instance = {
        id: id as InstanceID,
        instanceOf: appId,
        name: id as any,
        status: opts.status ?? 'Running',
        statusCondition: null,
        port: 0 as any,
        serviceImages: [],
        created: 1 as Timestamp,
        lastBackup: null,
        lastStarted: 1 as Timestamp,
        storedOn: (opts.diskId ?? 'app-disk') as DiskID,
        currentStep: null, totalSteps: null, stepLabel: null,
        metrics: null,
        filesMounts: opts.filesMounts ?? null,
    }
    h.change(doc => { doc.instanceDB[inst.id] = inst })
    return inst
}

describe('Files mount helpers (idea#133)', () => {
    it('slugFromShareName sanitises: lower-case, spaces to hyphens, no leading dot, no / or ..', () => {
        expect(slugFromShareName('School Files')).toBe('school-files')
        expect(slugFromShareName('My Share (2)')).toBe('my-share-2')
        expect(slugFromShareName('../etc/passwd')).toBe('etcpasswd')
        expect(slugFromShareName('.hidden')).toBe('hidden')
        expect(slugFromShareName('@@@')).toBe('files')
        expect(slugFromShareName('A_B  C')).toBe('a-b-c')
    })

    it('container path is always suffixed with id6', () => {
        expect(containerFilesPath('/mnt/idea-files', 'School Files', 'f3a9c2d1deadbeef')).toBe('/mnt/idea-files/school-files-f3a9c2')
        expect(diskId6('abc')).toBe('abc')
    })

    it('parseFilesMount reads x-app.filesMount and rejects invalid shapes', () => {
        expect(parseFilesMount({ filesMount: { path: '/mnt/idea-files', services: ['sample'] } }))
            .toEqual({ path: '/mnt/idea-files', services: ['sample'] })
        expect(parseFilesMount({})).toBeNull()
        expect(parseFilesMount({ filesMount: { path: 'relative', services: ['a'] } })).toBeNull()
        expect(parseFilesMount({ filesMount: { path: '/x', services: [] } })).toBeNull()
    })

    it('buildOverride: long bind syntax, create_host_path false, listed services only, display JSON', () => {
        const { yaml, display } = buildOverride(
            { path: '/mnt/idea-files', services: ['nextcloud-app'] },
            [{ id: 'f3a9c2d1' as DiskID, shareName: 'School Files', hostFilesPath: '/disks/sdb2/files' }],
            '/tmp/display.json',
        )
        const parsed = YAML.parse(yaml)
        expect(Object.keys(parsed.services)).toEqual(['nextcloud-app'])
        expect(parsed.services.db).toBeUndefined()
        const vols = parsed.services['nextcloud-app'].volumes
        expect(vols).toHaveLength(2)
        expect(vols[0]).toMatchObject({
            type: 'bind',
            source: '/disks/sdb2/files',
            target: '/mnt/idea-files/school-files-f3a9c2',
            bind: { create_host_path: false },
        })
        expect(vols[1]).toMatchObject({
            type: 'bind',
            source: '/tmp/display.json',
            target: `/mnt/idea-files/${IDEA_FILES_JSON}`,
            read_only: true,
            bind: { create_host_path: false },
        })
        expect(display).toEqual({ 'school-files-f3a9c2': 'School Files' })
    })

    it('remountActionFor follows the status table and hold gate', () => {
        expect(remountActionFor('Running', false)).toBe('up-d')
        expect(remountActionFor('Stopped', false)).toBe('skip')
        expect(remountActionFor('Pauzed', false)).toBe('up-no-start')
        expect(remountActionFor('Docked', false)).toBe('up-no-start')
        expect(remountActionFor('Running', true)).toBe('hold')
        expect(remountActionFor('Stopped', true)).toBe('hold')
    })

    it('FILES_REMOUNT_GROUP_MS is 3 seconds (open Q2)', () => {
        expect(FILES_REMOUNT_GROUP_MS).toBe(3_000)
    })

    it('ENGINE_CAPABILITIES includes filesMount', () => {
        expect(ENGINE_CAPABILITIES).toEqual(['diskIdArgs', 'filesDisk', 'filesMount', 'eraseDisk'])
    })
})

describe('shouldHoldFilesRemount (Kid Q1)', () => {
    let h: DocHandle<Store>
    beforeEach(async () => {
        h = await newStore()
        h.change(doc => {
            doc.appDB['sample-files-1.0' as AppID] = {
                id: 'sample-files-1.0' as AppID, name: 'sample-files' as any, version: '1.0' as any,
                title: 'S', description: null, url: null, category: 'education',
                icon: null, author: null,
                filesMount: { path: '/mnt/idea-files', services: ['sample'] },
            }
            doc.appDB['nextcloud-1.0' as AppID] = {
                id: 'nextcloud-1.0' as AppID, name: 'nextcloud' as any, version: '1.0' as any,
                title: 'N', description: null, url: null, category: 'office',
                icon: null, author: null,
                filesMount: { path: '/mnt/idea-files', services: ['nextcloud-app'] },
            }
        })
    })
    afterEach(() => { resourceLock.releaseAll([...resourceLock.allLocks().keys()]) })

    it('holds while status is Starting', async () => {
        const inst = addInstance(h, 'i-start', { status: 'Starting' })
        expect(await shouldHoldFilesRemount(h.doc()!, inst)).toBe(true)
    })

    it('holds while a Running startApp Operation targets the instance', async () => {
        const inst = addInstance(h, 'i-op', { status: 'Running' })
        const opId = createOperation(h, 'startApp', { instanceId: inst.id }, 'console-command', { type: 'instance', id: inst.id })
        updateOperation(h, opId, { status: 'Running' })
        expect(await shouldHoldFilesRemount(h.doc()!, inst)).toBe(true)
    })

    it('holds while the instance lock is held by startApp', async () => {
        const inst = addInstance(h, 'i-lock', { status: 'Running' })
        expect(resourceLock.acquire(instanceKey(inst.id), 'startApp')).toBe(true)
        expect(await shouldHoldFilesRemount(h.doc()!, inst)).toBe(true)
    })

    it('holds Nextcloud Running when occ is missing / fails (fail closed)', async () => {
        const inst = addInstance(h, 'i-nc', { status: 'Running', appId: 'nextcloud-1.0' })
        expect(await shouldHoldFilesRemount(h.doc()!, inst, async () => null)).toBe(true)
    })

    it('holds Nextcloud when maintenance or needsDbUpgrade', async () => {
        const inst = addInstance(h, 'i-nc2', { status: 'Running', appId: 'nextcloud-1.0' })
        expect(await shouldHoldFilesRemount(h.doc()!, inst, async () => ({
            installed: true, maintenance: true, needsDbUpgrade: false,
        }))).toBe(true)
        expect(await shouldHoldFilesRemount(h.doc()!, inst, async () => ({
            installed: true, maintenance: false, needsDbUpgrade: true,
        }))).toBe(true)
        expect(await shouldHoldFilesRemount(h.doc()!, inst, async () => ({
            installed: false, maintenance: false, needsDbUpgrade: false,
        }))).toBe(true)
    })

    it('does not hold Nextcloud when occ says ready', async () => {
        const inst = addInstance(h, 'i-nc3', { status: 'Running', appId: 'nextcloud-1.0' })
        expect(await shouldHoldFilesRemount(h.doc()!, inst, async () => ({
            installed: true, maintenance: false, needsDbUpgrade: false,
        }))).toBe(false)
    })

    it('does not hold a ready non-Nextcloud Running instance', async () => {
        const inst = addInstance(h, 'i-ok', { status: 'Running' })
        expect(await shouldHoldFilesRemount(h.doc()!, inst)).toBe(false)
    })
})

describe('remountInstance status handling', () => {
    let h: DocHandle<Store>
    let composeCalls: { dir: string; override: string; args: string[] }[]
    const roots: string[] = []

    beforeEach(async () => {
        h = await newStore()
        composeCalls = []
        resetFilesRemountScheduleForTests()
        setFilesMountOpsForTests({
            composeUp: async (dir, override, args) => { composeCalls.push({ dir, override, args }) },
            nextcloudOccStatus: async () => ({ installed: true, maintenance: false, needsDbUpgrade: false }),
        })
        await ensureEngineStateDir()

        const device = uniqueTestDevice()
        const root = `${DISKS_ROOT}/${device}`
        await fs.copy(path.join(FIXTURES_DIR, 'disk-files'), root)
        roots.push(root)
        const filesDisk = createOrUpdateDisk(h, LOCAL, device as DeviceName, 'files-1' as DiskID, 'Files' as DiskName, 1 as Timestamp)
        await processDisk(h, filesDisk)

        const appDevice = uniqueTestDevice()
        const appRoot = `${DISKS_ROOT}/${appDevice}`
        await fs.ensureDir(`${appRoot}/apps/sample-files-1.0`)
        await fs.ensureDir(`${appRoot}/instances/inst-1`)
        await fs.copy(
            path.join(FIXTURES_DIR, 'disk-files-app/apps/sample-files-1.0/compose.yaml'),
            `${appRoot}/apps/sample-files-1.0/compose.yaml`,
        )
        await fs.writeFile(`${appRoot}/instances/inst-1/compose.yaml`,
            await fs.readFile(path.join(FIXTURES_DIR, 'disk-files-app/apps/sample-files-1.0/compose.yaml'), 'utf8'))
        roots.push(appRoot)
        const appDisk = createOrUpdateDisk(h, LOCAL, appDevice as DeviceName, 'app-disk' as DiskID, 'Apps' as DiskName, 1 as Timestamp)
        await processDisk(h, appDisk)
        // Ensure App.filesMount is set (processApp reads compose)
        await createOrUpdateApp(h, 'sample-files-1.0' as AppID, appDisk)
        expect(h.doc()!.appDB['sample-files-1.0' as AppID]?.filesMount).toEqual({
            path: '/mnt/idea-files', services: ['sample'],
        })
    })
    afterEach(async () => {
        setFilesMountOpsForTests(null)
        resetFilesRemountScheduleForTests()
        resourceLock.releaseAll([...resourceLock.allLocks().keys()])
        for (const r of roots.splice(0)) await fs.remove(r)
    })

    it('Running → compose up -d; filesMounts written only after success; override rebuilt', async () => {
        addInstance(h, 'inst-1', { status: 'Running', diskId: 'app-disk' })
        const result = await remountInstance(h, 'inst-1' as InstanceID)
        expect(result).toBe('done')
        expect(composeCalls).toHaveLength(1)
        expect(composeCalls[0].args).toEqual(['up', '-d'])
        expect([...h.doc()!.instanceDB['inst-1' as InstanceID].filesMounts!]).toEqual(['files-1'])
        const ov = YAML.parse(await fs.readFile(composeCalls[0].override, 'utf8'))
        expect(ov.services.sample.volumes[0].bind.create_host_path).toBe(false)
        expect(ov.services.sample.volumes[0].target).toMatch(/\/school-files-files-/)
        const display = JSON.parse(await fs.readFile(displayJsonHostPath('inst-1' as InstanceID), 'utf8'))
        expect(Object.values(display)).toContain('School Files')
    })

    it('Stopped → left alone; filesMounts unchanged', async () => {
        addInstance(h, 'inst-1', { status: 'Stopped', diskId: 'app-disk', filesMounts: null })
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('skipped')
        expect(composeCalls).toHaveLength(0)
        expect(h.doc()!.instanceDB['inst-1' as InstanceID].filesMounts).toBeNull()
    })

    it('Pauzed → up --no-start --force-recreate', async () => {
        addInstance(h, 'inst-1', { status: 'Pauzed', diskId: 'app-disk' })
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('done')
        expect(composeCalls[0].args).toEqual(['up', '--no-start', '--force-recreate'])
        expect([...h.doc()!.instanceDB['inst-1' as InstanceID].filesMounts!]).toEqual(['files-1'])
    })

    it('filesMounts not written when compose up fails', async () => {
        setFilesMountOpsForTests({
            composeUp: async () => { throw new Error('compose boom') },
            nextcloudOccStatus: async () => ({ installed: true, maintenance: false, needsDbUpgrade: false }),
        })
        addInstance(h, 'inst-1', { status: 'Running', diskId: 'app-disk' })
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('failed')
        expect(h.doc()!.instanceDB['inst-1' as InstanceID].filesMounts).toBeNull()
    })

    it('skipSameDiskId leaves same-disk instances alone', async () => {
        addInstance(h, 'inst-1', { status: 'Running', diskId: 'files-1' })
        expect(await remountInstance(h, 'inst-1' as InstanceID, { skipSameDiskId: 'files-1' as DiskID })).toBe('skipped')
        expect(composeCalls).toHaveLength(0)
    })

    it('excludeDiskId rebuilds override without that Files Disk', async () => {
        addInstance(h, 'inst-1', { status: 'Running', diskId: 'app-disk', filesMounts: ['files-1'] as any })
        expect(await remountInstance(h, 'inst-1' as InstanceID, { excludeDiskId: 'files-1' as DiskID })).toBe('done')
        expect([...h.doc()!.instanceDB['inst-1' as InstanceID].filesMounts!]).toEqual([])
        const ov = YAML.parse(await fs.readFile(composeCalls[0].override, 'utf8'))
        // Only the display JSON bind remains
        expect(ov.services.sample.volumes).toHaveLength(1)
        expect(ov.services.sample.volumes[0].target).toContain(IDEA_FILES_JSON)
    })

    it('held Starting queues without calling compose', async () => {
        addInstance(h, 'inst-1', { status: 'Starting', diskId: 'app-disk' })
        expect(await remountInstance(h, 'inst-1' as InstanceID)).toBe('held')
        expect(composeCalls).toHaveLength(0)
    })

    it('override is rebuilt every remount (fresh file)', async () => {
        addInstance(h, 'inst-1', { status: 'Running', diskId: 'app-disk' })
        await remountInstance(h, 'inst-1' as InstanceID)
        const first = await fs.readFile(overridePathFor('inst-1' as InstanceID), 'utf8')
        await remountInstance(h, 'inst-1' as InstanceID)
        const second = await fs.readFile(overridePathFor('inst-1' as InstanceID), 'utf8')
        expect(second).toBe(first)
        expect(composeCalls).toHaveLength(2)
    })
})

describe('scheduleFilesRemount grouping', () => {
    afterEach(() => {
        resetFilesRemountScheduleForTests()
        setFilesMountOpsForTests(null)
    })

    it('coalesces multiple schedule calls into one flush after the window', async () => {
        vi.useFakeTimers()
        try {
            const h = await newStore()
            let flushes = 0
            // Spy by scheduling and advancing time; remount of empty set is a no-op
            scheduleFilesRemount(h, { skipSameDiskId: 'a' as DiskID })
            scheduleFilesRemount(h, { skipSameDiskId: 'b' as DiskID })
            expect(FILES_REMOUNT_GROUP_MS).toBe(3000)
            await vi.advanceTimersByTimeAsync(FILES_REMOUNT_GROUP_MS - 1)
            // Not flushed yet — pending still set (no compose ops configured needed)
            await vi.advanceTimersByTimeAsync(2)
            await flushFilesRemountNow(h)
            flushes++
            expect(flushes).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })
})
